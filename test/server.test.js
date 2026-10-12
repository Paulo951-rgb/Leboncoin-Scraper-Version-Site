'use strict';

/**
 * Suite de tests du serveur Web — Leboncoin Scraper Pro.
 *
 * Exécuter : node test/server.test.js
 *
 * Utilise des données FICTIVES contrôlées (moteur de scraping factice) pour ne
 * PAS dépendre du site externe. Couvre les 17 scénarios exigés :
 *  1. création d'une tâche            10. historique après redémarrage
 *  2. suivi de progression            11. isolation des utilisateurs
 *  3. récupération des logs           12. accès à une tâche d'autrui (404)
 *  4. annulation                      13. erreurs réseau/Chromium
 *  5. résultats complets              14. reconnexion (rejeu des logs)
 *  6. résultats partiels (403/429)    15. limite de concurrence
 *  7. trois profils de données        16. nettoyage (rétention)
 *  8. désactivation données vendeur   17. (interface : vérifs statiques)
 *  9. exports (génération + download)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}`); }
}

const ROOT = path.join(__dirname, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-server-'));

// Isolation : variables d'environnement AVANT de charger le serveur.
process.env.LBC_BASE_OUT_DIR = tmpRoot;
process.env.LBC_DB_PATH = path.join(tmpRoot, 'app.db');
process.env.LBC_AUTH_DISABLED = '0';
process.env.LBC_SESSION_SECRET = 'test-secret';
process.env.LBC_MAX_JOBS_PER_USER = '2';
process.env.LBC_GLOBAL_CONCURRENCY = '1';
process.env.LBC_HAR_RETENTION_DAYS = '2';

const { buildApp } = require('../src/server/app');
const { runMaintenance } = require('../src/server/maintenance');
const { validateJobConfig, sanitizeSettingsPatch } = require('../src/server/security');
const { openDatabase, Repository, hashPassword, verifyPassword } = require('../src/server/db');

// ─── Moteur de scraping FACTICE (données contrôlées) ─────────────────────────
function makeFakeEngine(script) {
  // script: { ads, mode: 'ok'|'partial403'|'partial429'|'failed'|'captcha'|'empty', delayMs }
  const captureFactory = (opts) => {
    const em = new EventEmitter();
    em._opts = opts;
    em.getUserAgent = () => 'FakeUA/1.0';
    em.stop = () => { em._stopped = true; };
    em.capture = async ({ outputHarPath }) => {
      em.emit('log', { level: 'info', message: '[fake] capture démarrée' });
      em.emit('progress', { percent: 100, status: 'fake capture' });
      if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
      if (em._stopped) throw Object.assign(new Error('capture annulée'), { _cancelled: true });
      if (script.mode === 'captcha') throw new Error('Session non validée (captcha_required) : capture annulée');
      fs.mkdirSync(path.dirname(outputHarPath), { recursive: true });
      fs.writeFileSync(outputHarPath, JSON.stringify({ log: { entries: [] } }));
      return outputHarPath;
    };
    return em;
  };
  const runnerFactory = () => {
    const em = new EventEmitter();
    em.stop = () => { em._stopped = true; };
    em.run = async ({ outDir }) => {
      em.emit('log', { level: 'info', message: '[fake] pipeline démarré' });
      if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
      em.emit('progress', { percent: 50, status: 'fake pipeline 50%' });
      if (em._stopped) return 130;
      fs.mkdirSync(outDir, { recursive: true });
      const ads = script.ads || [];
      const { writeWithChecksum } = require('../src/main/utils/integrity');
      writeWithChecksum(path.join(outDir, 'annonces.json'), ads, null, 2);
      fs.writeFileSync(path.join(outDir, 'annonces.txt'), ads.map((a) => `===== ANNONCE =====\n${a.title}`).join('\n'));
      writeWithChecksum(path.join(outDir, 'export-meta.json'), { version: 2, profileId: 'default', fields: null }, null, 2);
      em.emit('progress', { percent: 100, status: 'fake pipeline 100%' });
      if (script.mode === 'failed') throw new Error('[BROWSER_CRASHED] Le pipeline s\'est terminé avec un code : 1');
      if (script.mode === 'partial403') return 3;
      if (script.mode === 'partial429') return 4;
      if (script.mode === 'empty') return 0; // 0 annonces → partial
      return 0;
    };
    return em;
  };
  return { captureFactory, runnerFactory };
}

function fakeAds(n, opts = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: String(1000 + i),
      title: `Annonce ${i}`,
      prix: 100 + i * 10,
      url: `https://www.leboncoin.fr/ad/${1000 + i}.htm`,
      city: i % 2 ? 'Lyon' : 'Paris',
      zipcode: i % 2 ? '69000' : '75000',
      deliveryType: ['livraison', 'main_propre', 'les_deux', 'aucun', 'inconnu'][i % 5],
      vendeurNom: `Vendeur ${i}`,
      vendeurType: i % 2 ? 'pro' : 'particulier',
      vendeurNote: 4.5,
      nombreAvis: 12,
      vendeurAncienneteJours: 500,
      photosCount: 2,
      photosUrls: ['https://img.leboncoin.fr/a.jpg'],
      description: `Description ${i}`,
      dateScraping: new Date().toISOString(),
      ...(opts.extra || {}),
    });
  }
  return out;
}

// ─── Serveur de test ─────────────────────────────────────────────────────────
async function startServer(engineScript) {
  const engine = makeFakeEngine(engineScript);
  const built = buildApp();
  // Remplace le moteur réel par le moteur factice.
  built.manager.captureFactory = engine.captureFactory;
  built.manager.runnerFactory = engine.runnerFactory;
  const server = await new Promise((resolve) => {
    const s = built.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  return { server, port, built };
}

function req(port, method, urlPath, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) headers['Cookie'] = cookie;
    const r = http.request({ port, host: '127.0.0.1', path: urlPath, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch { /* texte */ }
        const setCookie = res.headers['set-cookie'];
        resolve({ status: res.statusCode, body: json, text: d, setCookie, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function cookieFrom(res) {
  const sc = res.setCookie && res.setCookie[0];
  if (!sc) return null;
  return sc.split(';')[0];
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitStatus(port, cookie, jobId, targets, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await req(port, 'GET', `/api/jobs/${jobId}`, { cookie });
    if (r.status === 200 && targets.includes(r.body.job.status)) return r.body.job;
    await sleep(60);
  }
  const last = await req(port, 'GET', `/api/jobs/${jobId}`, { cookie });
  return last.body && last.body.job;
}

async function main() {
  console.log('\n[A] Santé + authentification');
  const { server, port, built } = await startServer({ mode: 'ok', ads: fakeAds(5) });

  // Health (public)
  const health = await req(port, 'GET', '/api/health');
  assert(health.status === 200 && health.body.ok === true, 'GET /api/health → ok');
  assert(typeof health.body.activeJobs === 'number', 'health expose activeJobs');

  // Protection : /api/jobs sans auth → 401
  const noAuth = await req(port, 'GET', '/api/jobs');
  assert(noAuth.status === 401, 'GET /api/jobs sans session → 401 (auth requise)');

  // Inscription + cookie
  const reg = await req(port, 'POST', '/api/auth/register', { body: { email: 'alice@test.fr', password: 'motdepasse1' } });
  assert(reg.status === 201 && reg.body.user.email === 'alice@test.fr', 'inscription → 201 + utilisateur');
  const aliceCookie = cookieFrom(reg);
  assert(!!aliceCookie, 'inscription pose un cookie de session');

  const me = await req(port, 'GET', '/api/auth/me', { cookie: aliceCookie });
  assert(me.status === 200 && me.body.user.email === 'alice@test.fr', 'GET /api/auth/me avec session → utilisateur');

  // Second utilisateur (pour l'isolation)
  const reg2 = await req(port, 'POST', '/api/auth/register', { body: { email: 'bob@test.fr', password: 'motdepasse2' } });
  const bobCookie = cookieFrom(reg2);
  assert(reg2.status === 201 && !!bobCookie, 'second utilisateur créé (bob)');

  console.log('\n[1] Création d\'une tâche + validation');
  const badUrl = await req(port, 'POST', '/api/jobs', { cookie: aliceCookie, body: { searchUrl: 'http://127.0.0.1/admin', pages: 1 } });
  assert(badUrl.status === 400, 'URL interne refusée (400)');
  const badHost = await req(port, 'POST', '/api/jobs', { cookie: aliceCookie, body: { searchUrl: 'https://exemple.com/recherche', pages: 1 } });
  assert(badHost.status === 400, 'domaine hors allowlist refusé (400)');
  const badPages = await req(port, 'POST', '/api/jobs', { cookie: aliceCookie, body: { searchUrl: 'https://www.leboncoin.fr/recherche?text=velo', pages: 99999 } });
  assert(badPages.status === 201 && badPages.body.job.pages <= 50, 'pages bornées au maximum serveur (≤50)');

  const created = await req(port, 'POST', '/api/jobs', { cookie: aliceCookie, body: { searchUrl: 'https://www.leboncoin.fr/recherche?text=velo', pages: 2, profileId: 'default' } });
  assert(created.status === 201 && created.body.job.id, 'POST /api/jobs → 201 + id de tâche');
  const jobId = created.body.job.id;

  console.log('\n[2] Suivi de progression + [3] logs + [5] résultats complets');
  const done = await waitStatus(port, aliceCookie, jobId, ['completed', 'partial', 'failed']);
  assert(done && done.status === 'completed', `tâche terminée (status=${done && done.status})`);
  assert(done.adsCount === 5, `résultats complets : 5 annonces (obtenu ${done.adsCount})`);
  assert(done.progress === 100, 'progression à 100 % en succès complet');

  const logs = await req(port, 'GET', `/api/jobs/${jobId}/logs`, { cookie: aliceCookie });
  assert(logs.status === 200 && Array.isArray(logs.body.logs) && logs.body.logs.length > 0, 'GET logs → lignes présentes');

  const results = await req(port, 'GET', `/api/jobs/${jobId}/results`, { cookie: aliceCookie });
  assert(results.status === 200 && results.body.ads.length === 5, 'GET results → 5 annonces');
  assert(results.body.stats && results.body.stats.totalAds === 5, 'GET results → statistiques calculées');
  assert(!('raw' in results.body.ads[0]) && !('livraison' in results.body.ads[0]) && !('mainPropre' in results.body.ads[0]),
    'champs internes (raw/livraison/mainPropre) absents des résultats API');
  assert(results.body.ads[0].vendeurNom === 'Vendeur 0', 'données vendeur présentes (activé)');

  console.log('\n[9] Exports (téléchargement)');
  const dlJson = await req(port, 'GET', `/api/jobs/${jobId}/export/json`, { cookie: aliceCookie });
  assert(dlJson.status === 200 && /application\/json/.test(dlJson.headers['content-type']), 'export JSON → type application/json');
  assert(/attachment/.test(dlJson.headers['content-disposition'] || ''), 'export JSON → Content-Disposition attachment');
  const dlTxt = await req(port, 'GET', `/api/jobs/${jobId}/export/txt`, { cookie: aliceCookie });
  assert(dlTxt.status === 200 && /text\/plain/.test(dlTxt.headers['content-type']), 'export TXT → type text/plain');
  const dlBad = await req(port, 'GET', `/api/jobs/${jobId}/export/xml`, { cookie: aliceCookie });
  assert(dlBad.status === 400, 'format d\'export inconnu refusé (400)');

  console.log('\n[11] Isolation des utilisateurs + [12] accès à une tâche d\'autrui');
  const bobJobs = await req(port, 'GET', '/api/jobs', { cookie: bobCookie });
  assert(bobJobs.status === 200 && bobJobs.body.total === 0, 'bob ne voit aucune tâche d\'alice');
  const bobGetAlice = await req(port, 'GET', `/api/jobs/${jobId}`, { cookie: bobCookie });
  assert(bobGetAlice.status === 404, 'bob accède à la tâche d\'alice → 404 (jamais 200)');
  const bobResultsAlice = await req(port, 'GET', `/api/jobs/${jobId}/results`, { cookie: bobCookie });
  assert(bobResultsAlice.status === 404, 'bob accède aux résultats d\'alice → 404');
  const bobDeleteAlice = await req(port, 'DELETE', `/api/jobs/${jobId}`, { cookie: bobCookie });
  assert(bobDeleteAlice.status === 404, 'bob supprime la tâche d\'alice → 404');

  console.log('\n[7] Trois profils de données');
  const profiles = await req(port, 'GET', '/api/profiles', { cookie: aliceCookie });
  const ids = (profiles.body.profiles || []).map((p) => p.id);
  assert(profiles.status === 200 && ids.includes('default') && ids.includes('maximum') && ids.includes('custom'),
    'GET /api/profiles → défaut / maximum / personnalisé');

  console.log('\n[8] Désactivation des données vendeur');
  const noSeller = await req(port, 'POST', '/api/jobs', { cookie: aliceCookie, body: { searchUrl: 'https://www.leboncoin.fr/recherche?text=velo', pages: 1, includeSellerData: false } });
  assert(noSeller.status === 201, 'création tâche sans données vendeur');
  const nsDone = await waitStatus(port, aliceCookie, noSeller.body.job.id, ['completed', 'partial']);
  const nsResults = await req(port, 'GET', `/api/jobs/${noSeller.body.job.id}/results`, { cookie: aliceCookie });
  assert(nsResults.status === 200 && nsResults.body.ads.length > 0, 'résultats sans vendeur récupérés');
  const ad0 = nsResults.body.ads[0] || {};
  assert(!('vendeurNom' in ad0) && !('nombreAvis' in ad0) && !('vendeurAncienneteJours' in ad0),
    'données vendeur EXCLUES des résultats API (réglage désactivé)');
  // L'export JSON doit aussi exclure les données vendeur.
  const nsDl = await req(port, 'GET', `/api/jobs/${noSeller.body.job.id}/export/json`, { cookie: aliceCookie });
  assert(!/vendeurNom/.test(nsDl.text), 'export JSON sans vendeur (réglage désactivé)');

  console.log('\n[6] Résultats partiels (403/429)');
  // Nouveau serveur pour le scénario 403.
  await new Promise((r) => server.close(r));
  const s403 = await startServer({ mode: 'partial403', ads: fakeAds(3) });
  const c403 = cookieFrom(await req(s403.port, 'POST', '/api/auth/register', { body: { email: 'p403@test.fr', password: 'motdepasse1' } }));
  const j403 = await req(s403.port, 'POST', '/api/jobs', { cookie: c403, body: { searchUrl: 'https://www.leboncoin.fr/recherche?text=velo', pages: 1 } });
  const d403 = await waitStatus(s403.port, c403, j403.body.job.id, ['partial', 'completed', 'failed']);
  assert(d403.status === 'partial', `403 → statut partial (obtenu ${d403.status})`);
  assert(d403.adsCount === 3, '403 → annonces conservées (résultats partiels)');
  const r403 = await req(s403.port, 'GET', `/api/jobs/${j403.body.job.id}/results`, { cookie: c403 });
  assert(r403.status === 200 && r403.body.ads.length === 3, '403 → résultats partiels téléchargeables');
  await new Promise((r) => s403.server.close(r));

  const s429 = await startServer({ mode: 'partial429', ads: fakeAds(2) });
  const c429 = cookieFrom(await req(s429.port, 'POST', '/api/auth/register', { body: { email: 'p429@test.fr', password: 'motdepasse1' } }));
  const j429 = await req(s429.port, 'POST', '/api/jobs', { cookie: c429, body: { searchUrl: 'https://www.leboncoin.fr/recherche?text=velo', pages: 1 } });
  const d429 = await waitStatus(s429.port, c429, j429.body.job.id, ['partial', 'completed', 'failed']);
  assert(d429.status === 'partial', `429 → statut partial (obtenu ${d429.status})`);
  await new Promise((r) => s429.server.close(r));

  console.log('\n[13] Erreurs réseau / Chromium (échec)');
  const sFail = await startServer({ mode: 'failed', ads: [] });
  const cFail = cookieFrom(await req(sFail.port, 'POST', '/api/auth/register', { body: { email: 'fail@test.fr', password: 'motdepasse1' } }));
  const jFail = await req(sFail.port, 'POST', '/api/jobs', { cookie: cFail, body: { searchUrl: 'https://www.leboncoin.fr/recherche?text=velo', pages: 1 } });
  const dFail = await waitStatus(sFail.port, cFail, jFail.body.job.id, ['failed', 'partial']);
  assert(dFail.status === 'failed', `crash pipeline → statut failed (obtenu ${dFail.status})`);
  assert(dFail.errorCode === 'PIPELINE_ERROR' || dFail.errorCode === 'BROWSER_CRASHED', 'code d\'erreur structuré présent');
  await new Promise((r) => sFail.server.close(r));

  console.log('\n[CAPTCHA] état action_required (headless)');
  const sCap = await startServer({ mode: 'captcha', ads: [] });
  const cCap = cookieFrom(await req(sCap.port, 'POST', '/api/auth/register', { body: { email: 'cap@test.fr', password: 'motdepasse1' } }));
  const jCap = await req(sCap.port, 'POST', '/api/jobs', { cookie: cCap, body: { searchUrl: 'https://www.leboncoin.fr/recherche?text=velo', pages: 1 } });
  const dCap = await waitStatus(sCap.port, cCap, jCap.body.job.id, ['action_required', 'failed']);
  assert(dCap.status === 'action_required', `CAPTCHA → action_required (obtenu ${dCap.status})`);
  await new Promise((r) => sCap.server.close(r));

  console.log('\n[4] Annulation');
  const sSlow = await startServer({ mode: 'ok', ads: fakeAds(1), delayMs: 1500 });
  const cSlow = cookieFrom(await req(sSlow.port, 'POST', '/api/auth/register', { body: { email: 'slow@test.fr', password: 'motdepasse1' } }));
  const jSlow = await req(sSlow.port, 'POST', '/api/jobs', { cookie: cSlow, body: { searchUrl: 'https://www.leboncoin.fr/recherche?text=velo', pages: 1 } });
  await sleep(150);
  const cancelRes = await req(sSlow.port, 'POST', `/api/jobs/${jSlow.body.job.id}/cancel`, { cookie: cSlow });
  assert(cancelRes.status === 200 && cancelRes.body.ok === true, 'POST cancel → ok');
  const dSlow = await waitStatus(sSlow.port, cSlow, jSlow.body.job.id, ['cancelled', 'completed']);
  assert(dSlow.status === 'cancelled', `annulation → statut cancelled (obtenu ${dSlow.status})`);
  assert(dSlow.progress !== 100, 'annulation → progression NON forcée à 100 %');
  await new Promise((r) => sSlow.server.close(r));

  console.log('\n[15] Limite de concurrence');
  const sConc = await startServer({ mode: 'ok', ads: fakeAds(1), delayMs: 400 });
  const cConc = cookieFrom(await req(sConc.port, 'POST', '/api/auth/register', { body: { email: 'conc@test.fr', password: 'motdepasse1' } }));
  // Concurrence globale = 1 : la 3e tâche active doit être refusée (limite/user=2).
  const c1 = await req(sConc.port, 'POST', '/api/jobs', { cookie: cConc, body: { searchUrl: 'https://www.leboncoin.fr/recherche?text=a', pages: 1 } });
  const c2 = await req(sConc.port, 'POST', '/api/jobs', { cookie: cConc, body: { searchUrl: 'https://www.leboncoin.fr/recherche?text=b', pages: 1 } });
  const c3 = await req(sConc.port, 'POST', '/api/jobs', { cookie: cConc, body: { searchUrl: 'https://www.leboncoin.fr/recherche?text=c', pages: 1 } });
  assert(c1.status === 201 && c2.status === 201, '2 tâches actives acceptées');
  assert(c3.status === 429, `3e tâche active refusée (429, limite par utilisateur) — obtenu ${c3.status}`);
  await new Promise((r) => sConc.server.close(r));

  console.log('\n[14] Reconnexion (rejeu des logs via SSE/HTTP)');
  const sRecon = await startServer({ mode: 'ok', ads: fakeAds(2) });
  const cRecon = cookieFrom(await req(sRecon.port, 'POST', '/api/auth/register', { body: { email: 'recon@test.fr', password: 'motdepasse1' } }));
  const jRecon = await req(sRecon.port, 'POST', '/api/jobs', { cookie: cRecon, body: { searchUrl: 'https://www.leboncoin.fr/recherche?text=velo', pages: 1 } });
  await waitStatus(sRecon.port, cRecon, jRecon.body.job.id, ['completed', 'partial']);
  // Un client qui se reconnecte après coup retrouve les logs et le statut.
  const replayLogs = await req(sRecon.port, 'GET', `/api/jobs/${jRecon.body.job.id}/logs`, { cookie: cRecon });
  assert(replayLogs.body.logs.length > 0, 'reconnexion → logs rejouables');
  const replayJob = await req(sRecon.port, 'GET', `/api/jobs/${jRecon.body.job.id}`, { cookie: cRecon });
  assert(replayJob.body.job.status === 'completed', 'reconnexion → état de la tâche retrouvé');
  await new Promise((r) => sRecon.server.close(r));

  console.log('\n[10] Historique + persistance après « redémarrage »');
  // « Redémarrage » = nouvelle instance partageant la MÊME base.
  const dbPath = path.join(tmpRoot, 'persist.db');
  const db1 = openDatabase(dbPath);
  const repo1 = new Repository(db1);
  const u = repo1.createUser('persist@test.fr', 'motdepasse1');
  repo1.createJob({ id: 'job-persist-1', user_id: u.id, status: 'completed', search_url: 'https://www.leboncoin.fr/recherche?text=x', pages: 1, profile_id: 'default' });
  db1.close();
  const db2 = openDatabase(dbPath);
  const repo2 = new Repository(db2);
  const u2 = repo2.getUserByEmail('persist@test.fr');
  const jobs2 = repo2.listJobsForUser(u2.id, 10, 0);
  assert(jobs2.length === 1 && jobs2[0].id === 'job-persist-1', 'historique conservé après redémarrage (SQLite)');
  assert(repo2.verifyUser('persist@test.fr', 'motdepasse1') !== null, 'identifiants conservés après redémarrage');
  db2.close();

  console.log('\n[16] Nettoyage (rétention) + maintenance');
  const db3 = openDatabase(path.join(tmpRoot, 'maint.db'));
  const repo3 = new Repository(db3);
  const um = repo3.createUser('maint@test.fr', 'motdepasse1');
  repo3.createJob({ id: 'job-old', user_id: um.id, status: 'completed', search_url: 'https://www.leboncoin.fr/r', pages: 1 });
  // Force une date ancienne.
  db3.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 60 * 86400000).toISOString(), 'job-old');
  repo3.createJob({ id: 'job-new', user_id: um.id, status: 'completed', search_url: 'https://www.leboncoin.fr/r', pages: 1 });
  const before = repo3.listJobsForUser(um.id, 10, 0).length;
  const mstats = runMaintenance(repo3, { jobRetentionDays: 30, harRetentionDays: 2, jobsRootDir: tmpRoot, baseOutDir: tmpRoot }, () => {});
  const after = repo3.listJobsForUser(um.id, 10, 0).length;
  assert(before === 2 && after === 1, `rétention : tâche ancienne purgée (${before}→${after})`);
  assert(mstats.jobs === 1, 'maintenance : 1 tâche purgée comptée');
  db3.close();

  console.log('\n[B] Sécurité : validation + settings');
  const v = validateJobConfig({ searchUrl: 'https://www.leboncoin.fr/recherche?text=x', pages: 5, profileId: 'maximum' }, { allowedHosts: ['leboncoin.fr'], maxPages: 50, maxAds: 5000 });
  assert(v.ok && v.value.pages === 5 && v.value.profileId === 'maximum', 'validateJobConfig : config valide acceptée');
  const vBad = validateJobConfig({ searchUrl: 'file:///etc/passwd' }, { allowedHosts: ['leboncoin.fr'] });
  assert(!vBad.ok, 'validateJobConfig : schéma file:// refusé');
  const vSpoof = validateJobConfig({ searchUrl: 'https://leboncoin.fr.attaquant.com/x' }, { allowedHosts: ['leboncoin.fr'] });
  assert(!vSpoof.ok, 'validateJobConfig : suffixe trompeur refusé (leboncoin.fr.attaquant.com)');
  const clean = sanitizeSettingsPatch({ scrapeSpeed: 'rapide', __evil: 1, pageDelayMs: 999999 });
  assert(clean.scrapeSpeed === 'rapide' && !('__evil' in clean) && clean.pageDelayMs === 60000, 'sanitizeSettingsPatch : clés inconnues rejetées, plages bornées');

  console.log('\n[C] Mots de passe (scrypt)');
  const { hash, salt } = hashPassword('mon-mot-de-passe');
  assert(verifyPassword('mon-mot-de-passe', salt, hash) === true, 'verifyPassword : bon mot de passe accepté');
  assert(verifyPassword('mauvais', salt, hash) === false, 'verifyPassword : mauvais mot de passe refusé');

  console.log('\n[17] Interface Web (vérifications statiques)');
  const indexHtml = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  assert(/api\.js/.test(indexHtml), 'index.html charge le client API web (api.js)');
  assert(/authModule\.js/.test(indexHtml), 'index.html charge authModule.js');
  assert(/id="loginOverlay"/.test(indexHtml), 'index.html contient l\'écran de connexion');
  const apiJs = fs.readFileSync(path.join(ROOT, 'src/renderer/api.js'), 'utf8');
  assert(/EventSource/.test(apiJs), 'api.js utilise SSE (EventSource)');
  assert(/__isWeb/.test(apiJs), 'api.js marque l\'API comme Web');
  const css = fs.readFileSync(path.join(ROOT, 'src/renderer/styles.css'), 'utf8');
  assert(/@media \(max-width: 560px\)/.test(css), 'styles.css : responsive téléphone');
  const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert(/mcr\.microsoft\.com\/playwright:v1\.41\.2-jammy/.test(docker), 'Dockerfile : image Playwright 1.41.2 (version du projet)');
  assert(fs.existsSync(path.join(ROOT, 'render.yaml')), 'render.yaml présent');
  assert(fs.existsSync(path.join(ROOT, '.dockerignore')), '.dockerignore présent');

  await new Promise((r) => server.close(r));

  console.log(`\n=== RÉSULTAT SERVEUR : ${pass} réussis, ${fail} échoués ===`);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Erreur de test :', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
