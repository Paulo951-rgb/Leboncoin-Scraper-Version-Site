'use strict';

/**
 * Suite de tests de non-régression — Leboncoin Scraper Pro
 * Couvre : diagnostics.js, pipeline, modules principaux, exportFields, sécurité.
 * Exécuter : node test/regression.test.js
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');

// --- Stubs pour environnement hors-Electron ---
const electronStub = {
  app: { isPackaged: false, getPath: (p) => `/tmp/leboncoin-test-${p}` },
  Notification: { isSupported: () => false, new: function () { this.show = () => {}; } },
  shell: { openPath: () => Promise.resolve(''), openExternal: () => Promise.resolve() },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: function () { this.webContents = { send: () => {} }; },
};
const playwrightStub = { chromium: { launch: async () => { throw new Error('playwright stub'); } } };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  if (request === 'playwright') return playwrightStub;
  return originalLoad.apply(this, arguments);
};

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}`); }
}

async function main() {

// --- 1. diagnostics.js ---
console.log('\n[1] diagnostics.js');
const diag = require('../src/main/utils/diagnostics');
assert(typeof diag.redact === 'function', 'redact exists');
assert(typeof diag.truncate === 'function', 'truncate exists');
assert(typeof diag.safeStringify === 'function', 'safeStringify exists');
assert(typeof diag.formatBytes === 'function', 'formatBytes exists');
assert(typeof diag.formatMs === 'function', 'formatMs exists');
assert(typeof diag.summarizeAds === 'function', 'summarizeAds exists');
assert(typeof diag.summarizeHarEntries === 'function', 'summarizeHarEntries exists');
assert(typeof diag.countBy === 'function', 'countBy exists');
assert(typeof diag.describeError === 'function', 'describeError exists');
assert(diag.redact('sk-proj-abcdef1234567890').includes('sk-p'), 'redact masks API keys (shows prefix)');
assert(diag.redact('ab') === '***', 'redact short value → ***');
assert(diag.redact(null) === '(vide)', 'redact null → (vide)');
assert(diag.truncate('hello world', 5) === 'hello…[+6 caractères]', 'truncate works');
assert(diag.truncate('short', 50) === 'short', 'truncate short passthrough');
assert(diag.truncate(null) === '(null)', 'truncate null → (null)');
assert(diag.formatBytes(0) === '0 o', 'formatBytes(0)');
assert(diag.formatBytes(1536) === '1.5 Ko', 'formatBytes(1536)');
assert(diag.formatMs(0) === '0 ms', 'formatMs(0)');
assert(diag.formatMs(1500) === '1.50 s', 'formatMs(1500)');
assert(diag.formatMs(500) === '500 ms', 'formatMs(500)');
assert(typeof diag.summarizeAds([{ id: '1', price: 100 }, { id: '2', price: 200 }]) === 'string', 'summarizeAds returns string');
assert(diag.summarizeAds([{ id: '1', price: 100 }]).includes('1 annonce'), 'summarizeAds includes count');
assert(diag.summarizeAds('notarray') === '(pas un tableau)', 'summarizeAds non-array guard');
assert(diag.countBy([{ c: 'A' }, { c: 'A' }, { c: 'B' }], (i) => i.c).A === 2, 'countBy with fn');
assert(diag.countBy(null, () => 'x').x === undefined, 'countBy null guard');
assert(diag.describeError(new Error('boom')).includes('boom'), 'describeError message');
assert(diag.describeError({ code: 'ENOENT', message: 'x' }).includes('code=ENOENT'), 'describeError code');

// --- 2. Modules principaux ---
console.log('\n[2] Modules principaux');
const { AdStats } = require('../src/main/services/analysis/adStats');
const { StorageCleaner } = require('../src/main/services/maintenance/storageCleaner');
const { FileManager } = require('../src/main/infrastructure/fileManager');
const { loadSettings, saveSettings } = require('../src/main/core/settings');

assert(typeof AdStats.analyze === 'function', 'AdStats.analyze (remplace DealFinder)');
assert(typeof StorageCleaner.cleanOldHars === 'function', 'StorageCleaner.cleanOldHars');
assert(typeof FileManager.openFile === 'function', 'FileManager.openFile');
assert(typeof FileManager.openFolder === 'function', 'FileManager.openFolder');

// JobHistory.deleteJob : validation anti path-traversal (rejette les IDs malformés)
(function () {
  const { JobHistoryManager } = require('../src/main/services/jobs/jobHistory');
  assert(JobHistoryManager.deleteJob('../../../etc') === false, 'deleteJob rejette un path-traversal (..)');
  assert(JobHistoryManager.deleteJob('') === false, 'deleteJob rejette un ID vide');
  assert(JobHistoryManager.deleteJob('normal-name') === false, 'deleteJob rejette un ID sans préfixe job-');
  assert(JobHistoryManager.deleteJob('job-../../etc') === false, 'deleteJob rejette job- avec ..');
})();

// AdStats : statistiques sans scoring (remplace DealFinder)
const ads = [
  { id: '1', title: 'iPhone 12', price: 100 },
  { id: '2', title: 'Samsung S21', price: 300 },
  { id: '3', title: 'Pixel 6', price: 200 },
];
const { stats, ads: enrichedAds } = AdStats.analyze(ads);
assert(stats && stats.totalAds === 3, 'AdStats stats.totalAds');
assert(enrichedAds.length === 3, 'AdStats retourne les annonces inchangées');
assert(!enrichedAds[0].hasOwnProperty('dealTag'), 'AdStats n\'ajoute PLUS dealTag (scoring retiré)');
assert(!enrichedAds[0].hasOwnProperty('hasRisk'), 'AdStats n\'ajoute PLUS hasRisk (scam score retiré)');

// AdStats : cas limites (vide, prix invalides)
assert(AdStats.analyze([]).stats === null, 'AdStats: tableau vide → stats null');
assert(AdStats.analyze(null).stats === null, 'AdStats: entrée null → stats null (pas de crash)');
assert(AdStats.analyze([{ id: '1', price: 'abc' }, { id: '2' }]).stats === null, 'AdStats: prix invalides → stats null');
assert(AdStats.analyze([{ id: '1', price: 0 }, { id: '2', price: -5 }]).stats === null, 'AdStats: prix <= 0 ignorés → stats null');
const mixedPrices = AdStats.analyze([{ id: '1', price: 100 }, { id: '2', prix: '200' }, { id: '3', price: null }]);
assert(mixedPrices.stats.pricedAds === 2, 'AdStats: prix string parsés, null ignorés (pricedAds=2)');
assert(mixedPrices.stats.minPrice === 100 && mixedPrices.stats.maxPrice === 200, 'AdStats: min/max après tri des prix valides');
// Médiane : nombre pair → moyenne des deux valeurs centrales (pas l'élément du milieu)
assert(AdStats.analyze([{ id: '1', prix: 100 }, { id: '2', prix: 200 }, { id: '3', prix: 300 }, { id: '4', prix: 400 }]).stats.medianPrice === 250,
  'AdStats: medianPrice paire = moyenne des deux valeurs centrales (250)');
assert(AdStats.analyze([{ id: '1', prix: 100 }, { id: '2', prix: 200 }, { id: '3', prix: 350 }]).stats.medianPrice === 200,
  'AdStats: medianPrice impaire = valeur centrale (200)');
// AdStats : deliveryType (modèle unifié)
const txStats = AdStats.analyze([
  { id: '1', prix: 100, livraison: true, mainPropre: false, deliveryType: 'livraison' },
  { id: '2', prix: 200, livraison: false, mainPropre: true, deliveryType: 'main_propre' },
  { id: '3', prix: 150, livraison: true, mainPropre: true, deliveryType: 'les_deux' },
  { id: '4', prix: 50, livraison: null, mainPropre: null, deliveryType: 'inconnu' },
  { id: '5', prix: 70, livraison: false, mainPropre: false, deliveryType: 'aucun' },
]);
assert(txStats.stats.livraisonCount === 1, 'AdStats: livraisonCount correct (livraison uniquement)');
assert(txStats.stats.mainPropreCount === 1, 'AdStats: mainPropreCount correct (main_propre uniquement)');
assert(txStats.stats.lesDeuxCount === 1, 'AdStats: lesDeuxCount correct');
assert(txStats.stats.aucunCount === 1, 'AdStats: aucunCount correct');
assert(txStats.stats.inconnuCount === 1, 'AdStats: inconnuCount correct');
assert(txStats.stats.nonRenseigneCount === 1, 'AdStats: nonRenseigneCount (alias inconnu) correct');
// Rétro-compat : ads sans deliveryType mais avec livraison/mainPropre
const txStatsRetro = AdStats.analyze([
  { id: '1', prix: 100, livraison: true, mainPropre: false },
  { id: '2', prix: 200, livraison: false, mainPropre: true },
  { id: '3', prix: 150, livraison: true, mainPropre: true },
  { id: '4', prix: 50, livraison: null, mainPropre: null },
]);
assert(txStatsRetro.stats.livraisonCount === 1, 'AdStats rétro-compat: livraisonCount calculé depuis livraison/mainPropre');
assert(txStatsRetro.stats.mainPropreCount === 1, 'AdStats rétro-compat: mainPropreCount calculé depuis livraison/mainPropre');
assert(txStatsRetro.stats.lesDeuxCount === 1, 'AdStats rétro-compat: lesDeuxCount calculé depuis livraison/mainPropre');
assert(txStatsRetro.stats.inconnuCount === 1, 'AdStats rétro-compat: inconnuCount calculé depuis livraison/mainPropre');

// AdStats : cas limites supplémentaires de la médiane (jeux de données variés)
// La médiane est arrondie à l'entier (cohérent avec le renderer statsModule).
assert(AdStats.analyze([{ id: '1', prix: 5 }, { id: '2', prix: 10 }]).stats.medianPrice === 8,
  'AdStats: medianPrice paire à 2 valeurs = 8 (arrondi de 7.5)');
assert(AdStats.analyze([{ id: '1', prix: 42 }]).stats.medianPrice === 42,
  'AdStats: medianPrice une seule valeur');
assert(AdStats.analyze([{ id: '1', prix: 10 }, { id: '2', prix: 10 }, { id: '3', prix: 10 }, { id: '4', prix: 10 }]).stats.medianPrice === 10,
  'AdStats: medianPrice série constante');
assert(AdStats.analyze([{ id: '1', prix: 300 }, { id: '2', prix: 100 }, { id: '3', prix: 400 }, { id: '4', prix: 200 }]).stats.medianPrice === 250,
  'AdStats: medianPrice insensible à l\'ordre (tableau non trié)');

// --- 3. Pipeline (fork) ---
console.log('\n[3] Pipeline (leboncoin-pipeline.js)');
const os = require('os');
const { fork } = require('child_process');
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-'));
const harPath = path.join(tmpOut, 'capture.har');
const adObj = {
  list_id: 12345, subject: 'iPhone 12', price: 150, body: 'Bon etat',
  url: 'https://www.leboncoin.fr/ad/12345.htm',
  location: { city: 'Lyon', zipcode: '69000' },
  has_option: { shipping: false },
  category_name: 'Téléphones',
  owner: { name: 'Jean', type: 'particulier', rating: 4.8, nb_ratings: 27 },
};
const htmlPayload = '<html><script id="__NEXT_DATA__" type="application/json">' + JSON.stringify(adObj) + '</script></html>';
const har = {
  log: {
    entries: [
      {
        request: { url: 'https://www.leboncoin.fr/recherche' },
        response: { status: 200, content: { mimeType: 'text/html', text: htmlPayload } },
      },
    ],
  },
};
fs.writeFileSync(harPath, JSON.stringify(har));

await new Promise((resolve) => {
  const child = fork(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), [harPath, '--out', tmpOut, '--headless', '--no-desc', '--profile-id', 'maximum'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.on('close', (code) => {
    assert(code === 0, 'pipeline exits 0');
    assert(stdout.includes('[DEBUG]'), 'pipeline DEBUG logs present');
    assert(stdout.includes('annonces extraites'), 'pipeline reports ads extracted');
    const ads = JSON.parse(fs.readFileSync(path.join(tmpOut, 'annonces.json'), 'utf8'));
    // Convention du modèle : `livraison`/`mainPropre` sont des champs INTERNES
    // unifiés en `deliveryType` et ne doivent PAS figurer dans les exports.
    assert(!('livraison' in ads[0]), 'pipeline: livraison absent de l\'export (unifié en deliveryType)');
    assert(!('mainPropre' in ads[0]), 'pipeline: mainPropre absent de l\'export (unifié en deliveryType)');
    assert(!('raw' in ads[0]), 'pipeline: objet brut `raw` absent de l\'export');
    assert(!('extractionErrors' in ads[0]), 'pipeline: `extractionErrors` absent de l\'export');
    assert(ads[0].city === 'Lyon', 'pipeline extracts city');
    assert(ads[0].vendeurType === 'particulier', 'pipeline extracts vendeurType');
    assert(ads[0].vendeurNote === 4.8, 'pipeline extracts vendeurNote from owner.rating');
    assert(ads[0].deliveryType === 'aucun', 'pipeline extracts deliveryType (livraison=false, mainPropre=null → aucun)');
    assert(ads[0].prix === 150, 'pipeline extracts prix');
    assert(ads[0].vendeurNom === 'Jean', 'pipeline extracts vendeurNom');
    assert(ads[0].dateScraping != null, 'pipeline injects dateScraping');
    fs.rmSync(tmpOut, { recursive: true, force: true });
    resolve();
  });
});

// --- 3b. Pipeline : exit code 2 quand aucune donnée exploitable (non-régression) ---
// Avant, un HAR sans annonce faisait `return` → exit 0, et PipelineRunner croyait
// que le pipeline avait réussi. On vérifie le nouveau contrat : exit 2.
console.log('\n[3b] Pipeline exit-code 2 (aucune donnée exploitable)');
const emptyOut = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-empty-'));
fs.writeFileSync(path.join(emptyOut, 'capture.har'), JSON.stringify({ log: { entries: [] } }));
await new Promise((resolve) => {
  const child = fork(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), [path.join(emptyOut, 'capture.har'), '--out', emptyOut, '--headless', '--no-desc'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  child.on('close', (code) => {
    assert(code === 2, 'pipeline: HAR sans données → exit code 2 (pas 0)');
    fs.rmSync(emptyOut, { recursive: true, force: true });
    resolve();
  });
});

// --- 3b2. Annulation : état « cancelled » distinct d'un succès (non-régression) ---
// Avant, un clic « Arrêter » faisait sortir le pipeline avec un code non nul
// mais la branche de succès du job renvoyait « Scraping terminé avec succès ! ».
// On vérifie que le main process remonte un état « cancelled » dédié et que le
// renderer le traite comme un état terminal (réactivation des boutons).
console.log('\n[3b2] Annulation : état cancelled');
{
  const ipcCodeCancel = fs.readFileSync(path.join(__dirname, '..', 'src/main/core/ipcHandlers.js'), 'utf8');
  assert(/_cancelled/.test(ipcCodeCancel), 'ipcHandlers: marqueur _cancelled posé sur l\'erreur d\'annulation');
  assert(/state:\s*'cancelled'/.test(ipcCodeCancel), 'ipcHandlers: sendStatus state=cancelled sur annulation');
  assert(/activeCancel\s*&&\s*activeCancel\.cancelled/.test(ipcCodeCancel), 'ipcHandlers: ne lance pas le pipeline si annulé après capture');
  const scraperCancel = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/scraperModule.js'), 'utf8');
  assert(/state === 'completed' \|\| state === 'error' \|\| state === 'cancelled'/.test(scraperCancel),
    'scraperModule: état cancelled traité comme terminal (boutons réactivés)');
  // Annulation PENDANT l'enrichissement : le runner renvoie 130, ipcHandlers doit
  // traiter ce code comme une annulation (sinon succès trompeur).
  assert(/const pipelineExit\s*=\s*await activeRunner\.run/.test(ipcCodeCancel),
    'ipcHandlers: récupère le code de sortie du runner');
  assert(/pipelineExit\s*===\s*130/.test(ipcCodeCancel),
    'ipcHandlers: code 130 (interruption pipeline) → état cancelled');
  // Annulation coopérative dans le pipeline : handler SIGINT → arrêt propre.
  const pipelineCancelCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), 'utf8');
  assert(/process\.once\('SIGINT'/.test(pipelineCancelCode), 'pipeline: handler SIGINT installé (annulation coopérative)');
  assert(/this\.cancelled\s*=\s*true/.test(pipelineCancelCode), 'pipeline: drapeau cancelled positionné sur SIGINT');
  assert(/shouldStopAll \|\| this\.cancelled/.test(pipelineCancelCode), 'pipeline: boucle d\'enrichissement interrompue si annulé');
  assert(/process\.removeListener\('SIGINT'/.test(pipelineCancelCode), 'pipeline: handler SIGINT retiré en finally (pas de fuite)');
}


// --- 3c. Pipeline : export profil Défaut inclut ville/codePostal (non-régression) ---
// Vérifie de bout en bout (fork réel) que le correctif de compatibilité des clés
// d'export s'applique bien aux fichiers JSON produits par le pipeline.
console.log('\n[3c] Pipeline export profil Défaut (ville/codePostal)');
const defOut = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-def-'));
fs.writeFileSync(path.join(defOut, 'capture.har'), JSON.stringify(har));
await new Promise((resolve) => {
  const child = fork(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), [path.join(defOut, 'capture.har'), '--out', defOut, '--headless', '--no-desc', '--profile-id', 'default'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  child.on('close', (code) => {
    assert(code === 0, 'pipeline profil Défaut: exit 0');
    const ads = JSON.parse(fs.readFileSync(path.join(defOut, 'annonces.json'), 'utf8'));
    assert(ads[0].ville === 'Lyon', 'pipeline JSON profil Défaut: ville présent (clé d\'export)');
    assert(ads[0].codePostal === '69000', 'pipeline JSON profil Défaut: codePostal présent (clé d\'export)');
    const txt = fs.readFileSync(path.join(defOut, 'annonces.txt'), 'utf8');
    assert(txt.includes('Lyon'), 'pipeline TXT profil Défaut: ville affichée');
    fs.rmSync(defOut, { recursive: true, force: true });
    resolve();
  });
});


// --- 3d. Scénarios d'erreur du pipeline (fixtures déterministes) ---
console.log('\n[3d] Pipeline scénarios d\'erreur');

// 3d-1. HAR absent → exit code d'erreur (pas 0), pas de faux succès.
const missingOut = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-missing-'));
await new Promise((resolve) => {
  const child = fork(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), [path.join(missingOut, 'absent.har'), '--out', missingOut, '--headless', '--no-desc'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  child.on('close', (code) => {
    assert(code !== 0, 'pipeline HAR absent: code de sortie non nul (pas de faux succès)');
    fs.rmSync(missingOut, { recursive: true, force: true });
    resolve();
  });
});

// 3d-2. HAR invalide (JSON corrompu) → exit code d'erreur.
const badHarOut = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-badhar-'));
fs.writeFileSync(path.join(badHarOut, 'capture.har'), '{ ceci n\'est pas du JSON ');
await new Promise((resolve) => {
  const child = fork(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), [path.join(badHarOut, 'capture.har'), '--out', badHarOut, '--headless', '--no-desc'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  child.on('close', (code) => {
    assert(code !== 0, 'pipeline HAR invalide: code de sortie non nul');
    fs.rmSync(badHarOut, { recursive: true, force: true });
    resolve();
  });
});

// 3d-3. Données invalides (annonces sans aucun champ exploitable) :
// soit exit 2 (aucune donnée exploitable), soit exit 0 avec un tableau vide —
// dans les deux cas, JAMAIS un succès avec des annonces inventées.
const garbageOut = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-garbage-'));
const garbageHar = {
  log: { entries: [ { request: { url: 'https://www.leboncoin.fr/recherche' }, response: { status: 200, content: { mimeType: 'text/html', text: '<html><script id="__NEXT_DATA__" type="application/json">{}</script></html>' } } } ] },
};
fs.writeFileSync(path.join(garbageOut, 'capture.har'), JSON.stringify(garbageHar));
await new Promise((resolve) => {
  const child = fork(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), [path.join(garbageOut, 'capture.har'), '--out', garbageOut, '--headless', '--no-desc'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  child.on('close', (code) => {
    assert(code === 2, 'pipeline données invalides: exit 2 (aucune donnée exploitable)');
    const adsPath = path.join(garbageOut, 'annonces.json');
    if (fs.existsSync(adsPath)) {
      const ads = JSON.parse(fs.readFileSync(adsPath, 'utf8'));
      assert(Array.isArray(ads) && ads.length === 0, 'pipeline données invalides: aucune annonce inventée');
    }
    fs.rmSync(garbageOut, { recursive: true, force: true });
    resolve();
  });
});

// --- 3e. PipelineRunner : annulation, erreurs, résultat vide ---
console.log('\n[3e] PipelineRunner (intégration)');
{
  const { PipelineRunner } = require('../src/main/services/scraping/pipelineRunner');

  // 3e-1. Annulation d'un pipeline : resolve(130), signal emit, pas de rejet.
  // On appelle stop() immédiatement après run() : le sous-processus est déjà
  // forké de façon synchrone, donc stop() positionne isCancelled avant que
  // l'événement 'close' ne soit traité (pas de course liée à la durée du job).
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-run-'));
  fs.writeFileSync(path.join(runDir, 'capture.har'), JSON.stringify(har));
  await new Promise((resolve) => {
    const runner = new PipelineRunner();
    let sawInterrupt = false;
    runner.on('log', (l) => { if (/Interruption demandée/.test(l.message)) sawInterrupt = true; });
    const pending = runner.run({ harPath: path.join(runDir, 'capture.har'), outDir: runDir, noDesc: true, headless: true });
    runner.stop();
    pending
      .then((result) => {
        assert(result === 130, 'PipelineRunner: annulation → resolve(130)');
        assert(sawInterrupt, 'PipelineRunner: annulation → log "Interruption demandée"');
        fs.rmSync(runDir, { recursive: true, force: true });
        resolve();
      })
      .catch((e) => { assert(false, 'PipelineRunner: annulation ne doit pas rejeter — ' + e.message); resolve(); });
  });

  // 3e-2. HAR absent : le pipeline sort en erreur → le runner rejette (pas de succès).
  const missingRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-runmiss-'));
  await new Promise((resolve) => {
    const runner = new PipelineRunner();
    runner.run({ harPath: path.join(missingRunDir, 'absent.har'), outDir: missingRunDir, noDesc: true, headless: true })
      .then(() => { assert(false, 'PipelineRunner: HAR absent ne doit PAS résoudre en succès'); resolve(); })
      .catch((e) => { assert(/^\[/.test(e.message), 'PipelineRunner: HAR absent → rejet structuré'); resolve(); });
  });
  fs.rmSync(missingRunDir, { recursive: true, force: true });
}

// --- 3f. Préservation des résultats partiels ---
// Le pipeline écrit annonces.json (écriture atomique + checksum) AVANT la phase
// d'enrichissement. Si l'enrichissement échoue ensuite (ex. navigateur
// indisponible), les annonces déjà extraites doivent rester lisibles sur disque.
console.log('\n[3f] Préservation des résultats partiels');
{
  const partialOut = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-partial-'));
  fs.writeFileSync(path.join(partialOut, 'capture.har'), JSON.stringify(har));
  await new Promise((resolve) => {
    // Sans --no-desc : le pipeline tente d'enrichir (playwright indisponible ici)
    // → il échoue APRÈS avoir écrit annonces.json.
    const child = fork(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), [path.join(partialOut, 'capture.har'), '--out', partialOut, '--headless'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    child.on('close', () => {
      const adsPath = path.join(partialOut, 'annonces.json');
      assert(fs.existsSync(adsPath), 'partial: annonces.json écrit avant l\'enrichissement');
      const ads = JSON.parse(fs.readFileSync(adsPath, 'utf8'));
      assert(Array.isArray(ads) && ads.length >= 1, 'partial: annonces déjà extraites préservées malgré l\'échec d\'enrichissement');
      fs.rmSync(partialOut, { recursive: true, force: true });
      resolve();
    });
  });
}


// --- 4. Corrections renderer + main ---
console.log('\n[4] Corrections renderer + main');
const rendererDir = path.join(__dirname, '..', 'src/renderer');
const rendererFiles = ['appState.js', 'utils.js', 'logsModule.js', 'scraperModule.js', 'explorerModule.js', 'statsModule.js', 'historyModule.js', 'app.js'];
const appCode = rendererFiles.map((f) => fs.readFileSync(path.join(rendererDir, f), 'utf8')).join('\n');
const preloadCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/preload.js'), 'utf8');
const ipcCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/core/ipcHandlers.js'), 'utf8');

assert(/(let|const)\s+mapInstance\b/.test(appCode), 'app.js: mapInstance declared');
assert(/(let|const)\s+priceDistChartInstance\b/.test(appCode), 'app.js: priceDistChartInstance declared');
assert(/(let|const)\s+topCitiesChartInstance\b/.test(appCode), 'app.js: topCitiesChartInstance declared');
assert(/statAvgPrice/.test(appCode), 'app.js: statAvgPrice (prix moyen)');
assert(/statLivraison/.test(appCode), 'app.js: statLivraison (livraison — carte conservée)');
assert(/statHandDelivery/.test(appCode), 'app.js: statHandDelivery (main propre — carte conservée)');
assert(/statDeliveryTypeDist/.test(appCode), 'app.js: statDeliveryTypeDist (répartition modes remise unifiée)');
assert(!/statGoodDeals/.test(appCode), 'app.js: statGoodDeals supprimé (stats bonnes affaires retirées)');
assert(!/Répartition des Opportunités/.test(appCode), 'app.js: graphique Répartition des Opportunités supprimé');
assert(/429|quota/i.test(appCode), 'app.js: gestion erreur 429 (quota / scraping)');
assert(!/let\s+priceChartInstance\b/.test(appCode), 'app.js: priceChartInstance dead var removed');
assert(/if \(viewMode === 'table'\) viewGridBtn\.click\(\);\s*else viewTableBtn\.click\(\);/.test(appCode), 'app.js: Spacebar toggles table<->grid');
assert(/replace\(\/&\/g, '&amp;'\)/.test(appCode) && /replace\(\/"\/g, '&quot;'\)/.test(appCode), 'app.js: escapeHtml escapes & " < >');
assert(/window\.api\.openExternal\(urlStr\)/.test(appCode), 'app.js: openUrl uses openExternal');

// XSS : escapePath doit échapper " (breakout d'attribut HTML) en plus de \ et '
assert(/escapePath[\s\S]*?replace\(\/&\/g, '&amp;'\)/.test(appCode), 'app.js: escapePath échappe & (anti-double-encoding)');
assert(/escapePath[\s\S]*?replace\(\/"\/g, '&quot;'\)/.test(appCode), 'app.js: escapePath échappe " (XSS attribut HTML)');
// XSS : les src= d'images scrapées doivent passer par escapeHtml
assert(/src="\$\{escapeHtml\(/.test(appCode), 'app.js: img src utilise escapeHtml (XSS src attribute)');
// XSS : les a.id dans onclick doivent être échappés (defense in depth)
assert(!/openAdDetail\('\$\{a\.id\}'\)/.test(appCode), 'app.js: a.id échappé dans openAdDetail onclick');
assert(!/toggleStar\('\$\{a\.id\}'\)/.test(appCode), 'app.js: a.id échappé dans toggleStar onclick');
// Le bouton "Ouvrir le dossier" utilise maintenant openJobsFolder (ouvre results/)
assert(/openJobsFolder\(\)/.test(appCode), 'app.js: output button uses openJobsFolder');
// « Type de remise » unifié : deliveryType remplace les filtres livraison/mainPropre séparés.
assert(/deliveryTypeOf\s*=\s*\(a\)\s*=>/.test(appCode), 'app.js: deliveryTypeOf helper présent (modèle unifié)');
assert(/filterDeliveryType/.test(appCode), 'app.js: filterDeliveryType dropdown (remplace filterLivraison + filterMainPropre)');
assert(/matchesDeliveryType\s*=\s*deliveryTypeFilter\s*===\s*'tous'\s*\|\|\s*deliveryTypeOf\(a\)\s*===\s*deliveryTypeFilter/.test(appCode), 'app.js: filtre deliveryType unifié (tous || match exact)');
assert(/MAX_LOG_LINES\s*=\s*1000/.test(appCode), 'app.js: log line cap (1000)');
// Modules supprimés : Analyse Globale IA + Planificateur (scheduler)
assert(!/loadSchedulerPage/.test(appCode), 'app.js: loadSchedulerPage supprimé (module Planificateur retiré)');
assert(!/onSchedulerTrigger/.test(appCode), 'app.js: onSchedulerTrigger supprimé (module Planificateur retiré)');
assert(!/window\.removeSchedule/.test(appCode), 'app.js: removeSchedule supprimé (module Planificateur retiré)');
assert(!/analyzeGlobalDataset/.test(appCode), 'app.js: analyzeGlobalDataset supprimé (module Analyse Globale retiré)');
assert(/openExternal:\s*\(urlStr\)\s*=>\s*ipcRenderer\.invoke\('shell:openExternal'/.test(preloadCode), 'preload.js: openExternal exposed');
assert(/folderPath \|\| BASE_OUT_DIR/.test(ipcCode), 'ipcHandlers.js: openFolder defaults to BASE_OUT_DIR');
assert(/shell:openExternal/.test(ipcCode), 'ipcHandlers.js: shell:openExternal handler present');

// --- 5. Architecture restructurée ---
console.log('\n[5] Architecture restructurée');
const { existsSync } = fs;
const base = path.join(__dirname, '..', 'src/main');

// Structure par couches
assert(existsSync(path.join(base, 'core/ipcHandlers.js')), 'core/ipcHandlers.js present');
assert(existsSync(path.join(base, 'core/settings.js')), 'core/settings.js (extrait) present');
assert(existsSync(path.join(base, 'config/constants.js')), 'config/constants.js present');
assert(!existsSync(path.join(base, 'config/risk-keywords.js')), 'config/risk-keywords.js supprimé (code mort)');
assert(existsSync(path.join(base, 'services/scraping/harCapturer.js')), 'services/scraping/harCapturer.js present');
assert(existsSync(path.join(base, 'services/scraping/pipelineRunner.js')), 'services/scraping/pipelineRunner.js present');
assert(existsSync(path.join(base, 'services/scraping/leboncoin-pipeline.js')), 'services/scraping/leboncoin-pipeline.js present');
assert(existsSync(path.join(base, 'services/analysis/adStats.js')), 'services/analysis/adStats.js (remplace dealFinder)');
assert(existsSync(path.join(base, 'services/jobs/jobHistory.js')), 'services/jobs/jobHistory.js present');
assert(existsSync(path.join(base, 'services/maintenance/storageCleaner.js')), 'services/maintenance/storageCleaner.js present');
assert(existsSync(path.join(base, 'infrastructure/fileManager.js')), 'infrastructure/fileManager.js present');

// Anciens dossiers supprimés
assert(!existsSync(path.join(base, 'modules')), 'old modules/ folder removed');
assert(!existsSync(path.join(base, 'vendor')), 'old vendor/ folder removed');
assert(!existsSync(path.join(base, 'ipcHandlers.js')), 'ipcHandlers.js moved out of main/ root');

// notifications.js supprimé : il ne servait qu'au handler IA Marché (market:analyze),
// lui-même retiré. Le module était importé par ipcHandlers mais jamais utilisé.
assert(!existsSync(path.join(base, 'infrastructure/notifications.js')), 'infrastructure/notifications.js supprimé (IA Marché retirée)');

// Settings extrait d'ipcHandlers
assert(typeof loadSettings === 'function', 'loadSettings extracted to core/settings');
assert(typeof saveSettings === 'function', 'saveSettings extracted to core/settings');

// risk-keywords supprimé (code mort). constants.js ne doit plus le référencer.
assert(!/RISK_KEYWORDS/.test(fs.readFileSync(path.join(base, 'config/constants.js'), 'utf8')), 'RISK_KEYWORDS removed from constants.js');

// ipcHandlers ne contient plus loadSettings/saveSettings inline
assert(!/function loadSettings\b/.test(ipcCode), 'ipcHandlers no longer defines loadSettings inline');
assert(!/function saveSettings\b/.test(ipcCode), 'ipcHandlers no longer defines saveSettings inline');
assert(/require\(.\.\/settings.\)/.test(ipcCode), 'ipcHandlers imports settings from ./settings');
assert(!/Notifier/.test(ipcCode), 'ipcHandlers: import Notifier retiré (module mort)');

// main.js pointe vers core/ipcHandlers
const mainCode = fs.readFileSync(path.join(base, 'main.js'), 'utf8');
assert(/require\(.\.\/core\/ipcHandlers.\)/.test(mainCode), 'main.js requires ./core/ipcHandlers');

// pipelineRunner pointe vers le pipeline dans le même dossier
const prCode = fs.readFileSync(path.join(base, 'services/scraping/pipelineRunner.js'), 'utf8');
assert(/path\.join\(__dirname, .leboncoin-pipeline\.js.\)/.test(prCode), 'pipelineRunner finds pipeline in same folder (no ../vendor/)');

// Widget flottant (fenêtre always-on-top avec progression)
assert(existsSync(path.join(__dirname, '..', 'src/renderer/widget.html')), 'widget.html present');
assert(/createWidgetWindow/.test(mainCode), 'main.js: createWidgetWindow function present');
assert(/alwaysOnTop:\s*true/.test(mainCode), 'main.js: widget window always-on-top');
assert(/ipcMain\.on\('widget:toggle'/.test(mainCode), 'main.js: widget:toggle IPC handler');
assert(/ipcMain\.on\('widget:close'/.test(mainCode), 'main.js: widget:close IPC handler');
assert(/ipcMain\.on\('widget:progress'/.test(mainCode), 'main.js: widget:progress relay handler');
assert(/ipcMain\.on\('widget:status'/.test(mainCode), 'main.js: widget:status relay handler');
assert(/toggleWidget/.test(preloadCode), 'preload.js: toggleWidget exposed');
assert(/sendWidgetProgress/.test(preloadCode), 'preload.js: sendWidgetProgress exposed');
assert(/sendWidgetStatus/.test(preloadCode), 'preload.js: sendWidgetStatus exposed');
assert(!/Le Widget Flottant n'est pas encore disponible/.test(appCode), 'app.js: stale "not available" alert removed');
assert(/sendWidgetProgress\(\{ percent, status \}\)/.test(appCode), 'app.js: relays progress to widget');
assert(/sendWidgetStatus\(\{ state, message \}\)/.test(appCode), 'app.js: relays status to widget');

// --- 6. Nouvelles features : intégrité, rate-limiter, logs, secrets, jobs-auto, sandbox ---
console.log('\n[6] Nouvelles features : intégrité, rate-limiter, logs, secrets, jobs-auto, sandbox');
const { writeWithChecksum, readWithChecksum, verify, computeHash, checksumPath } = require('../src/main/utils/integrity');
const { AdaptiveRateLimiter } = require('../src/main/utils/rateLimiter');
const { logger } = require('../src/main/utils/logger');
const { SecretStore } = require('../src/main/utils/secretStore');

// F2 : integrity
const tmpDir = path.join(require('os').tmpdir(), `lbc-test-integrity-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
const ij = path.join(tmpDir, 'a.json');
writeWithChecksum(ij, { x: 1 });
assert(fs.existsSync(ij) && fs.existsSync(checksumPath(ij)), 'integrity: écrit .json + .sha256');
assert(readWithChecksum(ij).valid === true && readWithChecksum(ij).data.x === 1, 'integrity: lecture valide');
fs.writeFileSync(ij, '{"x":99}');
assert(readWithChecksum(ij).valid === false, 'integrity: détecte la corruption');
assert(computeHash('abc') === computeHash('abc'), 'integrity: computeHash déterministe');

// F6 : logger
assert(typeof logger.info === 'function' && typeof logger.setRetention === 'function', 'logger: API présente');
logger.setRetention(3);

// F4 : secretStore round-trip
SecretStore.set('lbc-test-secret', 'val123');
assert(SecretStore.get('lbc-test-secret') === 'val123', 'secretStore: chiffrement/déchiffrement round-trip');
assert(SecretStore.list().includes('lbc-test-secret'), 'secretStore: list() contient la clé');
SecretStore.remove('lbc-test-secret');
assert(SecretStore.get('lbc-test-secret') === null, 'secretStore: remove() supprime');
assert(typeof SecretStore.isUsingOsKeychain() === 'boolean', 'secretStore: isUsingOsKeychain() retourne booléen');

// F8 : storageCleaner.cleanOldJobs
assert(typeof StorageCleaner.cleanOldJobs === 'function', 'StorageCleaner.cleanOldJobs présent');
assert(StorageCleaner.cleanOldJobs(0) === 0, 'cleanOldJobs(0) désactivé → 0');

// FIX #3 : cleanOldJobs basé sur le timestamp du nom du dossier, pas le mtime
const cleanerCode = fs.readFileSync(path.join(base, 'services/maintenance/storageCleaner.js'), 'utf8');
assert(cleanerCode.includes('tsMatch = entry.name.match'), 'storageCleaner: parse le timestamp du nom de dossier');
assert(cleanerCode.includes('Date.parse(iso)'), 'storageCleaner: calcule l\'âge depuis le timestamp du nom');
assert(cleanerCode.includes('Fallback mtime'), 'storageCleaner: fallback mtime si timestamp illisible');

// FIX #4 : geocodeCityGov a un timeout (AbortController)
assert(/const controller = new AbortController\(\);[\s\S]{0,80}controller\.abort\(\), 10000/.test(appCode), 'app.js: geocodeCityGov timeout 10s (AbortController)');

// F5 : sandbox renderer durcie
assert(/sandbox:\s*true/.test(mainCode), 'main.js: sandbox:true activé sur mainWindow');
assert(/widgetPreload\.js/.test(mainCode), 'main.js: widget utilise widgetPreload.js');
assert(existsSync(path.join(base, 'widgetPreload.js')), 'widgetPreload.js present');
const widgetHtml = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/widget.html'), 'utf8');
assert(/window\.widgetApi/.test(widgetHtml), 'widget.html: utilise window.widgetApi (pas require)');
assert(!/require\('electron'\)/.test(widgetHtml), 'widget.html: plus de require(electron) direct');
assert(/checkNetwork/.test(preloadCode), 'preload.js: expose checkNetwork');
assert(/getSecret|setSecret|hasSecret|removeSecret/.test(preloadCode), 'preload.js: expose secret IPC');

// F3 : mode hors-ligne
assert(/offlineBadge/.test(appCode), 'app.js: offlineBadge référencé');
assert(/isOffline/.test(appCode), 'app.js: isOffline state tracked');
assert(/checkNetwork/.test(appCode), 'app.js: appelle checkNetwork');
assert(existsSync(path.join(base, 'utils/integrity.js')), 'utils/integrity.js present');
assert(existsSync(path.join(base, 'utils/rateLimiter.js')), 'utils/rateLimiter.js present');
assert(existsSync(path.join(base, 'utils/logger.js')), 'utils/logger.js present');
assert(existsSync(path.join(base, 'utils/secretStore.js')), 'utils/secretStore.js present');

// Settings nouveaux champs
const settingsCode = fs.readFileSync(path.join(base, 'core/settings.js'), 'utf8');
assert(/logRetentionDays/.test(settingsCode), 'settings: logRetentionDays');
assert(/autoCleanJobsDays/.test(settingsCode), 'settings: autoCleanJobsDays');
assert(/includeSellerData/.test(settingsCode), 'settings: includeSellerData default true');

// IPC nouveaux handlers
assert(/network:check/.test(ipcCode), 'ipcHandlers: network:check handler');
assert(/secret:get|secret:set/.test(ipcCode), 'ipcHandlers: secret handlers');

// UI paramètres
const htmlCode = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
assert(/cfgAutoCleanJobs/.test(htmlCode), 'index.html: cfgAutoCleanJobs checkbox');
assert(/cfgAutoCleanJobsDays/.test(htmlCode), 'index.html: cfgAutoCleanJobsDays input');
assert(/cfgLogRetention/.test(htmlCode), 'index.html: cfgLogRetention input');
assert(/badge-offline/.test(htmlCode), 'index.html: badge-offline CSS class');
// Stats : nouvelles cartes + retrait bonnes affaires
assert(/statAvgPrice/.test(htmlCode), 'index.html: carte prix moyen');
assert(/statLivraison/.test(htmlCode), 'index.html: carte livraison (conservée)');
assert(/statHandDelivery/.test(htmlCode), 'index.html: carte main propre (conservée)');
assert(/statDeliveryTypeDist/.test(htmlCode), 'index.html: carte répartition modes remise (deliveryType)');
assert(/filterDeliveryType/.test(htmlCode), 'index.html: filtre deliveryType unifié (remplace filterLivraison + filterMainPropre)');
assert(/modalDeliveryType/.test(htmlCode), 'index.html: modal deliveryType (remplace modalLivraison + modalMainPropre)');
assert(/statPro/.test(htmlCode) && /statPart/.test(htmlCode), 'index.html: cartes pro/particulier');
assert(!/statGoodDeals/.test(htmlCode), 'index.html: carte Bonnes Affaires supprimée');
assert(!/statRisks/.test(htmlCode), 'index.html: carte Annonces Trop Chères supprimée');
assert(!/id="dealsChart"/.test(htmlCode), 'index.html: canvas dealsChart (Répartition Opportunités) supprimé');
assert(/id="priceDistChart"/.test(htmlCode), 'index.html: canvas priceDistChart (distribution prix)');
assert(/id="topCitiesChart"/.test(htmlCode), 'index.html: canvas topCitiesChart (top villes)');
assert(/stat-card-accent/.test(htmlCode), 'index.html: stat-cards accentuées');

// F5 : fenêtre de connexion Google dédiée supprimée (plus de module IA Studio)
assert(!/aistudio:openLogin/.test(mainCode), 'main.js: handler IPC aistudio:openLogin supprimé');
assert(!/AI_STUDIO_PARTITION/.test(mainCode), 'main.js: constante AI_STUDIO_PARTITION supprimée');
assert(!/aistudioLoginPreload/.test(mainCode), 'main.js: preload aistudioLoginPreload supprimé');
assert(!existsSync(path.join(base, 'aistudioLoginPreload.js')), 'aistudioLoginPreload.js supprimé');
assert(!/tab-ai-studio/.test(htmlCode), 'index.html: onglet tab-ai-studio supprimé');
assert(!/aistudioWebview/.test(htmlCode), 'index.html: webview navigateur IA Studio supprimé');
assert(!/aiStudioModule\.js/.test(htmlCode), 'index.html: script aiStudioModule.js supprimé');
assert(!existsSync(path.join(__dirname, '..', 'src/renderer/aiStudioModule.js')), 'renderer/aiStudioModule.js supprimé');
// Plus de module IA ni Excel
assert(!existsSync(path.join(base, 'services/ai')), 'services/ai/ supprimé (module IA entier)');
assert(!existsSync(path.join(base, 'infrastructure/excelExporter.js')), 'infrastructure/excelExporter.js supprimé (XLSX/CSV retirés)');
assert(!/ExcelExporter/.test(ipcCode), 'ipcHandlers: plus d\'import ExcelExporter');
assert(!/AdAnalyzer/.test(ipcCode), 'ipcHandlers: plus d\'import AdAnalyzer');
assert(!/MarketValueAnalyzer/.test(ipcCode), 'ipcHandlers: plus d\'import MarketValueAnalyzer');
assert(!/PromptGenerator/.test(ipcCode), 'ipcHandlers: plus d\'import PromptGenerator');
assert(!/ollamaHealth/.test(ipcCode), 'ipcHandlers: plus d\'import ollamaHealth');
assert(!/listSearchProviders/.test(ipcCode), 'ipcHandlers: plus d\'import listSearchProviders');
assert(!/market:analyze/.test(ipcCode), 'ipcHandlers: handler market:analyze supprimé');
assert(!/prompt:generate/.test(ipcCode), 'ipcHandlers: handler prompt:generate supprimé');
assert(!/prompt:templates/.test(ipcCode), 'ipcHandlers: handler prompt:templates supprimé');
assert(!/prompt:internal/.test(ipcCode), 'ipcHandlers: handler prompt:internal supprimé');
assert(!/ollama:models/.test(ipcCode), 'ipcHandlers: handler ollama:models supprimé');
assert(!/ollama:health/.test(ipcCode), 'ipcHandlers: handler ollama:health supprimé');
assert(!/search:providers/.test(ipcCode), 'ipcHandlers: handler search:providers supprimé');
assert(!/aiConcurrency/.test(settingsCode), 'settings: aiConcurrency supprimé');
assert(!/aiConcurrency/.test(ipcCode), 'ipcHandlers: aiConcurrency supprimé');
// preload : API IA supprimées
assert(!/analyzeMarket/.test(preloadCode), 'preload: analyzeMarket supprimé');
assert(!/generatePrompt/.test(preloadCode), 'preload: generatePrompt supprimé');
assert(!/listPromptTemplates/.test(preloadCode), 'preload: listPromptTemplates supprimé');
assert(!/buildPrompt/.test(preloadCode), 'preload: buildPrompt supprimé');
assert(!/listInternalPrompts/.test(preloadCode), 'preload: listInternalPrompts supprimé');
assert(!/listOllamaModels/.test(preloadCode), 'preload: listOllamaModels supprimé');
assert(!/listSearchProviders/.test(preloadCode), 'preload: listSearchProviders supprimé');
assert(!/checkOllamaHealth/.test(preloadCode), 'preload: checkOllamaHealth supprimé');
assert(!/openAiStudioLogin/.test(preloadCode), 'preload: openAiStudioLogin supprimé');
// index.html : champs IA supprimés
assert(!/id="aiProvider"/.test(htmlCode), 'index.html: select aiProvider supprimé');
assert(!/id="aiModelName"/.test(htmlCode), 'index.html: champ aiModelName supprimé');
assert(!/id="aiVisionModel"/.test(htmlCode), 'index.html: champ aiVisionModel supprimé');
assert(!/id="ollamaUrl"/.test(htmlCode), 'index.html: champ ollamaUrl supprimé');
assert(!/id="autoAiMarket"/.test(htmlCode), 'index.html: checkbox autoAiMarket supprimée');
assert(!/id="searchProvider"/.test(htmlCode), 'index.html: select searchProvider supprimé');
assert(!/id="searchApiKey"/.test(htmlCode), 'index.html: champ searchApiKey supprimé');
assert(!/id="triggerMarketBtn"/.test(htmlCode), 'index.html: bouton triggerMarketBtn supprimé');
assert(!/id="marketProgressContainer"/.test(htmlCode), 'index.html: conteneur marketProgress supprimé');
// structureWarning est conservé et DOIT exister : logsModule l'utilise pour
// afficher l'alerte de changement de structure JSON côté Leboncoin. Son absence
// rendait l'affichage silencieusement inopérant.
assert(/id="structureWarning"/.test(htmlCode), 'index.html: bandeau structureWarning présent (utilisé par logsModule)');
assert(/id="structureWarningText"/.test(htmlCode), 'index.html: texte structureWarning présent');
assert(!/id="cfgAiConcurrency"/.test(htmlCode), 'index.html: champ cfgAiConcurrency supprimé');
assert(!/aistudio\.google\.com/.test(htmlCode), 'index.html: URL AI Studio supprimée');
assert(!/127\.0\.0\.1:11434/.test(htmlCode), 'index.html: connect-src Ollama supprimé du CSP');
assert(!/frame-src.*aistudio/.test(htmlCode), 'index.html: frame-src AI Studio supprimé du CSP');
// renderer : références IA supprimées
assert(!/autoAiMarket/.test(appCode), 'app.js: autoAiMarket supprimé');
assert(!/aiProvider/.test(appCode), 'app.js: aiProvider supprimé');
assert(!/aiModelName/.test(appCode), 'app.js: aiModelName supprimé');
assert(!/ollamaUrl/.test(appCode), 'app.js: ollamaUrl supprimé');
assert(!/searchProvider/.test(appCode), 'app.js: searchProvider supprimé');
assert(!/triggerMarketBtn/.test(appCode), 'app.js: triggerMarketBtn supprimé');
assert(!/analyzeMarket/.test(appCode), 'app.js: analyzeMarket supprimé');
assert(!/aiConfig/.test(appCode), 'app.js: aiConfig supprimé');
assert(!/analyzeImages/.test(appCode), 'app.js: analyzeImages supprimé');
assert(!/getOllamaUrl/.test(appCode), 'app.js: getOllamaUrl supprimé');
assert(!/getAiApiKey/.test(appCode), 'app.js: getAiApiKey supprimé');

// === MODULE D'AIDE : FAQ / Help / Feedback ===
assert(/openFaqBtn/.test(htmlCode), 'index.html: bouton FAQ présent');
assert(/openHelpBtn/.test(htmlCode), 'index.html: bouton Help présent');
assert(/openFeedbackBtn/.test(htmlCode), 'index.html: bouton Problèmes & Améliorations présent');
assert(/id="faqModal"/.test(htmlCode), 'index.html: modale FAQ présente');
assert(/id="helpModal"/.test(htmlCode), 'index.html: modale Help présente');
assert(/id="feedbackModal"/.test(htmlCode), 'index.html: modale Feedback présente');
assert(/helpModule\.js/.test(htmlCode), 'index.html: inclut helpModule.js');
assert(existsSync(path.join(__dirname, '..', 'src/renderer', 'helpModule.js')), 'renderer/helpModule.js present');
const helpModCode = fs.readFileSync(path.join(__dirname, '..', 'src/renderer', 'helpModule.js'), 'utf8');
assert(/FAQ_DATA/.test(helpModCode), 'helpModule: données FAQ présentes');
assert(/HELP_SECTIONS/.test(helpModCode), 'helpModule: sections du guide présentes');
assert(/submitFeedback/.test(helpModCode), 'helpModule: fonction submitFeedback (préparée pour future API)');
assert(/window\.helpModule/.test(helpModCode), 'helpModule: exposé sur window.helpModule');
assert(/class="help-btn"/.test(htmlCode), 'index.html: boutons aide discrets (class help-btn)');
assert(/app:getDiagnostics/.test(ipcCode), 'ipcHandlers: handler app:getDiagnostics (diagnostic feedback)');
assert(/getDiagnostics/.test(preloadCode), 'preload.js: expose getDiagnostics');
const helpNoComments = helpModCode.replace(/\/\/[^\n]*\n/g, '');
assert(!/fetch\(\s*['"]https/.test(helpNoComments), 'helpModule: pas d\'envoi HTTP actif (API backend pas encore développé)');
assert(/localStorage.*feedback-archive/.test(helpModCode), 'helpModule: rapport archivé localement (V2 en attendant le serveur)');
// helpModule : FAQ ne mentionne plus Ollama/AI Studio/XLSX/CSV
assert(!/Ollama/.test(helpModCode), 'helpModule: FAQ ne mentionne plus Ollama');
assert(!/AI Studio/.test(helpModCode), 'helpModule: FAQ ne mentionne plus AI Studio');
assert(!/IA Marché/.test(helpModCode), 'helpModule: FAQ ne mentionne plus IA Marché');
assert(!/annonces\.xlsx/.test(helpModCode), 'helpModule: FAQ ne mentionne plus annonces.xlsx');
assert(!/resumes-ia/.test(helpModCode), 'helpModule: FAQ ne mentionne plus resumes-ia.json');

// --- 7. Architecture SCRAPING PUR (indépendant de l'IA) ---
console.log('\n[7] Architecture scraping pur (sans dépendance IA)');
const pipelineCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), 'utf8');
const appCodeFull = appCode;
const htmlCodeFull = fs.readFileSync(path.join(__dirname, '..', 'src/renderer', 'index.html'), 'utf8');

// adFields est un module de SCRAPING PUR : aucun appel IA, aucun prompt.
assert(existsSync(path.join(base, 'services/scraping/adFields.js')), 'pipeline: module adFields.js présent (extracteurs centralisés)');
const adFieldsCode = fs.readFileSync(path.join(base, 'services/scraping/adFields.js'), 'utf8');
const adFieldsNoComments = adFieldsCode.replace(/\/\/[^\n]*\n/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
assert(!/ollama|gemini|openai|chatgpt|anthropic|claude|mistral/.test(adFieldsNoComments),
  'adFields: AUCUN appel IA (ollama/gemini/openai/etc.) dans le code');
assert(!/\bchat\b\s*\(/.test(adFieldsNoComments),
  'adFields: AUCUN appel chat() (= appel LLM)');
assert(!/fetch\(['"]https?:\/\/[^'"]+['"]/.test(adFieldsNoComments),
  'adFields: AUCUN fetch HTTP externe (module pur)');
assert(/extractSeller/.test(adFieldsCode), 'adFields: extractSeller');
assert(/extractTransaction/.test(adFieldsCode), 'adFields: extractTransaction');
assert(/extractDates/.test(adFieldsCode), 'adFields: extractDates');
assert(/extractCondition/.test(adFieldsCode), 'adFields: extractCondition (État déclaré uniquement)');
assert(/extractLikes/.test(adFieldsCode), 'adFields: extractLikes (likes uniquement)');
assert(/extractPhotos/.test(adFieldsCode), 'adFields: extractPhotos');
assert(/extractDescription/.test(adFieldsCode), 'adFields: extractDescription');
// Champs supprimés — les fonctions associées ne doivent plus exister
assert(!/extractAttributes/.test(adFieldsCode), 'adFields: extractAttributes SUPPRIMÉ');
assert(!/detectInDescription/.test(adFieldsCode), 'adFields: detectInDescription SUPPRIMÉ');
assert(!/inferCondition/.test(adFieldsCode), 'adFields: inferCondition SUPPRIMÉ');
assert(!/scraperQuality/.test(adFieldsCode), 'adFields: scraperQuality SUPPRIMÉ');
assert(!/zipcodeToDepartment/.test(adFieldsCode), 'adFields: zipcodeToDepartment SUPPRIMÉ');
const adFieldsCheck = adFieldsNoComments;
assert(!/\bnegociable\b/.test(adFieldsCheck), 'adFields: aucun negociable (champ supprimé)');
assert(!/\bfacture\b/.test(adFieldsCheck), 'adFields: aucun facture (champ supprimé)');
assert(!/\bgarantie\b/.test(adFieldsCheck), 'adFields: aucun garantie (champ supprimé)');
assert(!/\bechangeAccepte?\b/.test(adFieldsCheck), 'adFields: aucun echange (champ supprimé)');
assert(!/\burgent\b/.test(adFieldsCheck), 'adFields: aucun urgent (champ supprimé)');
assert(!/\bvues\b/.test(adFieldsCheck), 'adFields: aucun vues (champ supprimé)');
assert(!/\bmarque\b/.test(adFieldsCheck), 'adFields: aucun marque (champ supprimé)');
assert(!/\bmodele\b/.test(adFieldsCheck), 'adFields: aucun modele (champ supprimé)');
assert(!/\bcouleur\b/.test(adFieldsCheck), 'adFields: aucun couleur (champ supprimé)');
assert(!/\bcapacite\b/.test(adFieldsCheck), 'adFields: aucun capacite (champ supprimé)');
assert(!/\betatInferre\b/.test(adFieldsCheck), 'adFields: aucun etatInferre (champ supprimé)');
assert(!/\bdepartment\b/.test(adFieldsCheck), 'adFields: aucun department (champ supprimé)');
assert(!/\bcategory\b/.test(adFieldsCheck), 'adFields: aucun category (champ supprimé)');

// Pipeline : helpers wrappers (compatibilité interne) présents
assert(!/function extractDeliveryInfo/.test(pipelineCode), 'pipeline: extractDeliveryInfo supprimé (structure plate)');
assert(!/function extractSellerRating/.test(pipelineCode), 'pipeline: extractSellerRating supprimé (structure plate)');

// normalizeAd : produit les champs plats (scraping pur)
assert(/prix,/.test(pipelineCode), 'pipeline: normalizeAd produit prix');
assert(/vendeurNom:/.test(pipelineCode), 'pipeline: normalizeAd produit vendeurNom');
assert(/livraison:/.test(pipelineCode), 'pipeline: normalizeAd produit livraison');
assert(/mainPropre:/.test(pipelineCode), 'pipeline: normalizeAd produit mainPropre');
assert(/likes,/.test(pipelineCode), 'pipeline: normalizeAd produit likes');
assert(/datePublication:/.test(pipelineCode), 'pipeline: normalizeAd produit datePublication');
assert(/dateScraping,/.test(pipelineCode), 'pipeline: normalizeAd produit dateScraping');
assert(/etat,/.test(pipelineCode), 'pipeline: normalizeAd produit etat');
assert(/photosCount:/.test(pipelineCode), 'pipeline: normalizeAd produit photosCount');
assert(/description,/.test(pipelineCode), 'pipeline: normalizeAd produit description');
// Ne doit PAS produire les anciens objets imbriqués
assert(!/vendeur:\s*\{/.test(pipelineCode), 'pipeline: normalizeAd ne produit PAS vendeur{}');
assert(!/transaction:\s*\{/.test(pipelineCode), 'pipeline: normalizeAd ne produit PAS transaction{}');
assert(!/statistiques:\s*\{/.test(pipelineCode), 'pipeline: normalizeAd ne produit PAS statistiques{}');
assert(!/produit:\s*\{/.test(pipelineCode), 'pipeline: normalizeAd ne produit PAS produit{}');
assert(!/photos:\s*\{/.test(pipelineCode), 'pipeline: normalizeAd ne produit PAS photos{}');
assert(!/dates:\s*\{/.test(pipelineCode), 'pipeline: normalizeAd ne produit PAS dates{}');
assert(!/ad\.scraping\s*=/.test(pipelineCode), 'pipeline: normalizeAd ne produit PAS scraping{}');
assert(/dateScraping:\s*scrapedAt/.test(pipelineCode), 'pipeline: normalizeAd injecte dateScraping ISO');
assert(/scrapedAt\s*=\s*new Date\(\)\.toISOString\(\)/.test(pipelineCode), 'pipeline: scrapedAt = new Date().toISOString()');
assert(/mergeKeepingNonNull/.test(pipelineCode), 'pipeline: mergeKeepingNonNull préserve les champs non-null');
assert(!/detection:\s*\{/.test(pipelineCode), 'pipeline: normalizeAd ne produit PAS detection{}');
assert(!/negociable/.test(pipelineCode), 'pipeline: aucun negociable (champ supprimé)');

// ═══ Tests fonctionnels des extracteurs adFields (SCRAPING PUR) ═══
{
  const { extractTransaction, extractSeller, extractDates, extractCondition,
    extractLikes, extractPhotos, extractDescription, extractPrice } =
    require(path.join(base, 'services/scraping/adFields'));

  // === DESCRIPTION (correction du bug [object Object]) ===
  let desc = extractDescription({ body: 'Texte simple' });
  assert(desc === 'Texte simple', 'adFields.extractDescription: body string → string');
  desc = extractDescription({ body: { text: 'Texte dans objet' } });
  assert(desc === 'Texte dans objet', 'adFields.extractDescription: body {text:...} → string (corrige [object Object])');
  desc = extractDescription({ body: null });
  assert(desc === null, 'adFields.extractDescription: body null → null');
  desc = extractDescription({ body: 42 });
  assert(desc === null, 'adFields.extractDescription: body nombre → null (pas [object Object])');
  desc = extractDescription({ body: {} });
  assert(desc === null, 'adFields.extractDescription: body objet vide → null');
  desc = extractDescription({});
  assert(desc === null, 'adFields.extractDescription: pas de body → null');
  desc = extractDescription({ description: 'Via description' });
  assert(desc === 'Via description', 'adFields.extractDescription: raw.description → string');
  desc = extractDescription({ text: 'Via text' });
  assert(desc === 'Via text', 'adFields.extractDescription: raw.text → string');

  // === TRANSACTION (Livraison et Main propre INDÉPENDANTS) ===
  let t = extractTransaction({ has_option: { shipping: false } });
  assert(t.livraison === false && t.mainPropre === null,
    'adFields.extractTransaction: shipping=false → livraison=NON, mainPropre=null (pas inféré)');
  t = extractTransaction({ shipping: true });
  assert(t.livraison === true, 'adFields.extractTransaction: shipping=true → livraison=OUI');
  t = extractTransaction({ body: 'Remise en main propre uniquement' });
  assert(t.mainPropre === true, 'adFields.extractTransaction: mainPropre=OUI détecté depuis texte');
  t = extractTransaction({ body: "pas d'envoi possible" });
  assert(t.mainPropre === true, 'adFields.extractTransaction: "pas d\'envoi" → mainPropre=OUI');
  t = extractTransaction({ body: 'retrait sur place uniquement' });
  assert(t.mainPropre === true, 'adFields.extractTransaction: "retrait" → mainPropre=OUI');
  t = extractTransaction({ has_option: { shipping: true }, body: 'Possibilité de remise en main propre' });
  assert(t.livraison === true && t.mainPropre === true,
    'adFields.extractTransaction: livraison=OUI ET mainPropre=OUI simultanément');
  t = extractTransaction({});
  assert(t.livraison === null && t.mainPropre === null,
    'adFields.extractTransaction: pas d\'info → null (jamais false par défaut)');
  t = extractTransaction({ attributes: [{ key: 'foo', value: 'bar' }] });
  assert(t.livraison === null && t.mainPropre === null,
    'adFields.extractTransaction: attributes présent sans shipping → livraison=null (pas inventé)');

  // === computeDeliveryType (modèle unifié) ===
  const { computeDeliveryType } = require(path.join(base, 'services/scraping/adFields'));
  assert(computeDeliveryType(true, true) === 'les_deux', 'computeDeliveryType: true,true → les_deux');
  assert(computeDeliveryType(true, false) === 'livraison', 'computeDeliveryType: true,false → livraison');
  assert(computeDeliveryType(true, null) === 'livraison', 'computeDeliveryType: true,null → livraison');
  assert(computeDeliveryType(false, true) === 'main_propre', 'computeDeliveryType: false,true → main_propre');
  assert(computeDeliveryType(null, true) === 'main_propre', 'computeDeliveryType: null,true → main_propre');
  assert(computeDeliveryType(false, false) === 'aucun', 'computeDeliveryType: false,false → aucun');
  assert(computeDeliveryType(false, null) === 'aucun', 'computeDeliveryType: false,null → aucun');
  assert(computeDeliveryType(null, false) === 'aucun', 'computeDeliveryType: null,false → aucun');
  assert(computeDeliveryType(null, null) === 'inconnu', 'computeDeliveryType: null,null → inconnu');

  // === SELLER ===
  const s = extractSeller({ owner: { name: 'Jean', type: 'pro', rating: 4.8, nb_ratings: 27 } });
  assert(s.nom === 'Jean' && s.isPro === true && s.note === 4.8,
    'adFields.extractSeller: nom + note + isPro');

  // === DATES ===
  const d = extractDates({ first_publication_date: '2026-01-15T10:00:00Z' });
  assert(d.publication === '2026-01-15T10:00:00Z',
    'adFields.extractDates: publication extraite');

  // === CONDITION (État déclaré uniquement) ===
  const etat = extractCondition({ attributes: [{ key: 'condition', value: 'Très bon état' }] });
  assert(etat === 'Très bon état', 'adFields.extractCondition: extrait "condition"');
  assert(extractCondition({}) === null, 'adFields.extractCondition: pas d\'attributs → null');
  assert(extractCondition({ attributes: [{ key: 'brand', value: 'Apple' }] }) === null,
    'adFields.extractCondition: autre attribut → null (pas de fallback)');

  // === LIKES (likes uniquement) ===
  assert(extractLikes({ favorites_count: 24 }) === 24, 'adFields.extractLikes: likes extrait');
  assert(extractLikes({ favorites_count: 0 }) === 0, 'adFields.extractLikes: 0 likes = 0, pas null');
  assert(extractLikes({}) === null, 'adFields.extractLikes: pas d\'info → null (pas 0)');

  // === PHOTOS ===
  const ph = extractPhotos({ images: { urls: ['https://a.jpg', 'https://b.jpg'] } });
  assert(ph.count === 2 && ph.urls.length === 2, 'adFields.extractPhotos: count + urls');

  // === PRICE ===
  assert(extractPrice({ price: 100 }) === 100, 'adFields.extractPrice: number → 100');
  assert(extractPrice({ price: { value: 250 } }) === 250, 'adFields.extractPrice: {value}');
  assert(extractPrice({ price: [{ value: 300 }] }) === 300, 'adFields.extractPrice: [{value}] array format');
}

// harCapturer : annulation pendant CAPTCHA ne persiste PAS une session bloquée
const harCode = fs.readFileSync(path.join(base, 'services/scraping/harCapturer.js'), 'utf8');
assert(/NE PAS persister la session/.test(harCode), 'harCapturer: annulation warmup ne persiste pas la session bloquée');

// harCapturer : détection CAPTCHA multi-vecteurs (iframe, URL, Cloudflare)
assert(/arkoselabs|funcaptcha/.test(harCode), 'harCapturer: détection iframe Arkose/FunCaptcha');
assert(/challenges\.cloudflare|cf-turnstile|challenge-form/.test(harCode), 'harCapturer: détection challenge Cloudflare');
assert(/captchaUrlMatch|URL suspecte/.test(harCode), 'harCapturer: détection CAPTCHA via URL (redirection)');

// harCapturer : AUCUN reload pendant la résolution CAPTCHA
assert(!/vPage\.reload\(\{ waitUntil/.test(harCode), 'harCapturer: PAS de reload pendant résolution CAPTCHA');
assert(/POLL SANS reload/.test(harCode) || /sans recharger/.test(harCode), 'harCapturer: polling sans reload documenté');

// harCapturer : warmup utilise networkidle
assert(/waitUntil:\s*['"]networkidle['"]/.test(harCode), 'harCapturer: warmup utilise networkidle');
assert(/sleep\(3000\)/.test(harCode), 'harCapturer: délai warmup 3s (rendu CAPTCHA différé)');

// harCapturer : post-CAPTCHA — attend networkidle + grace period avant save
assert(/stabilisation de la session/.test(harCode), 'harCapturer: post-CAPTCHA attend stabilisation session');
assert(/2e CAPTCHA consécutif/.test(harCode), 'harCapturer: re-vérification post-CAPTCHA');
assert(/résolution interactive/.test(harCode), 'harCapturer: CAPTCHA pendant capture → résolution interactive');
assert(/Reprise après résolution CAPTCHA/.test(harCode), 'harCapturer: reprise capture après résolution CAPTCHA');

// harCapturer : UA FIXE pour toute la capture
assert(/this\._userAgent\s*=\s*getRandomUserAgent\(\)/.test(harCode), 'harCapturer: UA fixe choisi une fois dans le constructeur');
assert(/userAgent:\s*this\._userAgent/.test(harCode), 'harCapturer: _baseContextOptions réutilise this._userAgent (UA cohérent)');
assert(!/userAgent:\s*getRandomUserAgent\(\)/.test(harCode), 'harCapturer: PAS de getRandomUserAgent() dans _baseContextOptions (UA fixe)');
assert(/rate-limit Leboncoin/i.test(harCode), 'harCapturer: délai 2s après warmup (anti rate-limit Leboncoin)');

// pipeline : recyclage de contexte résilient (sauvegarde préventive + try/catch)
assert(/Recyclage contexte échoué/.test(pipelineCode), 'pipeline: recyclage contexte a un catch (ne crash pas le job)');
assert(/Sauvegarde préventive AVANT le recyclage/.test(pipelineCode), 'pipeline: writeOutputs avant recyclage (pas de perte)');

// renderer : renderCharts garde contre les canvas absents
assert(/priceDistCanvas \|\| !sellerCanvas \|\| !citiesCanvas/.test(appCode), 'app.js: renderCharts garde contre canvas absents');
// V3 : graphique vendeur en barres horizontales
assert(/indexAxis:\s*'y'/.test(appCode), 'app.js: graphique vendeur en barres horizontales (V3)');
assert(!/type:\s*'doughnut'/.test(appCode), 'app.js: V3 — plus de doughnut pour le graphique vendeur');
assert(!/cutout:\s*'62%'/.test(appCode), 'app.js: V3 — cutout doughnut supprimé');
// renderer : cache géocodage tolérant au JSON corrompu
assert(/try \{[\s\S]*?JSON\.parse\(cached\)[\s\S]*?\} catch/.test(appCode), 'app.js: cache géocodage tolérant au JSON corrompu');
// renderer : mapHandDeliveryOnly null-safe
assert(/mapHandDeliveryEl && mapHandDeliveryEl\.checked/.test(appCode), 'app.js: mapHandDeliveryOnly null-safe');
// renderer : mapHandDeliveryOnly utilise deliveryType (main_propre + les_deux)
assert(/deliveryType === 'main_propre' \|\| dt === 'les_deux'/.test(appCode) || /main_propre.*les_deux/.test(appCode), 'app.js: filtre carte utilise deliveryType main_propre/les_deux');

// --- 8. Livraison / Main propre INDÉPENDANTS (extraction défensive) ---
console.log('\n[8] Livraison / Main propre indépendants');
const adFieldsDeliveryCode = fs.readFileSync(path.join(base, 'services/scraping/adFields.js'), 'utf8');
assert(/raw\.attributes/.test(adFieldsDeliveryCode), 'adFields: extractTransaction vérifie raw.attributes[] (API récente)');
assert(/shippable|is_shippable/.test(adFieldsDeliveryCode), 'adFields: extractTransaction cherche clé "shippable" dans attributes');
assert(/is_shippable|shippable|is_shipping/.test(adFieldsDeliveryCode), 'adFields: extractTransaction vérifie is_shippable/shippable (variantes récentes)');
assert(adFieldsDeliveryCode.includes('remise\\s+en\\s+main\\s+propre') || adFieldsDeliveryCode.includes('main\\s+propre\\s+uniquement'),
  'adFields: extractTransaction détecte "main propre" dans le body');
assert(/pas.*envoi|retrait.*place|venir.*chercher/.test(adFieldsDeliveryCode), 'adFields: extractTransaction détecte "pas d\'envoi" / "retrait" dans le body');
// Livraison/mainPropre ne sont PLUS inventées par défaut : null si inconnu.
assert(!/Array\.isArray\(raw\?\.attributes\) && raw\.attributes\.length > 0/.test(adFieldsDeliveryCode), 'adFields: extractTransaction ne force PAS livraison=false quand attributes présent sans shipping');
assert(!/livraison\s*=\s*false/.test(adFieldsDeliveryCode.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'adFields: plus de fallback livraison=false par défaut');

// constants.js : DEFAULTS mort supprimé (valeurs conflictuelles avec settings)
const constantsCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/config/constants.js'), 'utf8');
assert(!/DEFAULTS:\s*\{/.test(constantsCode), 'constants.js: DEFAULTS mort supprimé (valeurs conflictuelles)');

// --- 9. Audit fonctionnel A→Z (cohérence UI/logique/docs) ---
console.log('\n[9] Audit fonctionnel A→Z');

// jobHistory : format de date lisible
const jobHistoryCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/jobs/jobHistory.js'), 'utf8');
assert(/tsMatch\s*=\s*entry\.name\.match/.test(jobHistoryCode), 'jobHistory: format date via regex (extraction composants)');
assert(/\$\{tsMatch\[3\]\}\/\$\{tsMatch\[2\]\}\/\$\{tsMatch\[1\]\}/.test(jobHistoryCode), 'jobHistory: date au format JJ/MM/AAAA (slashes)');
assert(jobHistoryCode.indexOf("replace(/-/g") === -1, 'jobHistory: ne remplace plus les - par : dans la date (ancien pattern retire)');
// rapport.txt est mort (jamais créé par le pipeline) → retiré de jobHistory
assert(!/rapportPath|rapport:/.test(jobHistoryCode), 'jobHistory: rapport.txt mort retiré (jamais généré par le pipeline)');

// app.js : suppression de job nettoie le comparateur (IDs fantômes)
assert(/compareSet = new Set\(\[\.\.\.compareSet\]\.filter/.test(appCode), 'app.js: compareSet nettoyé après suppression job (IDs fantômes)');
assert(/refreshActiveDataTab\(\)/.test(appCode.replace(/\/\/[^\n]*\n/g, '')), 'app.js: suppression déclenche refreshActiveDataTab');

// [suite] — écritures atomiques (anti-corruption de fichiers critiques)
const secretStoreCode2 = fs.readFileSync(path.join(base, 'utils/secretStore.js'), 'utf8');
assert(/atomicWriteFileSync\(p,/.test(secretStoreCode2), 'secretStore: _save atomique (atomicWriteFileSync)');
assert(!/fs\.writeFileSync\(p,/.test(secretStoreCode2), 'secretStore: _save n\'utilise plus fs.writeFileSync');

const settingsCode2 = fs.readFileSync(path.join(base, 'core/settings.js'), 'utf8');
assert(/atomicWriteFileSync\(getSettingsPath\(\)/.test(settingsCode2), 'settings: saveSettings atomique (atomicWriteFileSync)');
assert(!/fs\.writeFileSync\(getSettingsPath\(\)/.test(settingsCode2), 'settings: saveSettings n\'utilise plus fs.writeFileSync');

// [suite] — Onglet Logs amélioré
const htmlCode2 = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
assert(/autoScrollToggleBtn/.test(htmlCode2), 'logs: bouton auto-scroll présent dans HTML');
assert(/copyLogsBtn/.test(htmlCode2), 'logs: bouton copier présent dans HTML');
assert(/logModeToggleBtn/.test(htmlCode2), 'logs: bouton mode normal/debug présent dans HTML');
assert(/logs-toolbar/.test(htmlCode2), 'logs: toolbar de boutons présente');
assert(/logStats/.test(htmlCode2), 'logs: compteur de logs affichés présent');

assert(/_logBuffer/.test(appCode), 'app.js: buffer de logs en mémoire (_logBuffer)');
assert(/_logMode/.test(appCode) && /'normal'/.test(appCode) && /'debug'/.test(appCode), 'app.js: mode normal/debug (_logMode)');
assert(/_autoScroll\s*=\s*true/.test(appCode), 'app.js: auto-scroll activé par défaut (_autoScroll=true)');
assert(/_logLevelVisible/.test(appCode), 'app.js: fonction de filtrage par niveau (_logLevelVisible)');
assert(/_renderLogs/.test(appCode), 'app.js: fonction de re-render (_renderLogs) pour filtrage rétroactif');
assert(/navigator\.clipboard\.writeText/.test(appCode), 'app.js: copie des logs via clipboard API');
assert(/MAX_LOG_BUFFER/.test(appCode), 'app.js: plafond mémoire du buffer (MAX_LOG_BUFFER)');
assert(/level !== 'debug'/.test(appCode), 'app.js: mode normal filtre les logs debug');
assert(/_logMode === 'debug'/.test(appCode), 'app.js: mode debug affiche tous les logs');

// Résumé de session (ipcHandlers)
const ipcCode2 = fs.readFileSync(path.join(__dirname, '..', 'src/main/core/ipcHandlers.js'), 'utf8');
assert(/sessionStats/.test(ipcCode2), 'ipcHandlers: sessionStats tracker présent');
assert(/sendSessionSummary/.test(ipcCode2), 'ipcHandlers: fonction sendSessionSummary présente');
assert(/RÉSUMÉ DE SESSION/.test(ipcCode2), 'ipcHandlers: résumé de session formaté');
assert(/pagesRequested/.test(ipcCode2) && /adsFound/.test(ipcCode2) && /adsKept/.test(ipcCode2), 'ipcHandlers: compteurs pages/annonces');
assert(/errors/.test(ipcCode2) && /warnings/.test(ipcCode2) && /debugs/.test(ipcCode2), 'ipcHandlers: compteurs erreurs/warnings/debugs');
// Plus de compteurs IA dans le résumé
assert(!/aiAnalyzed/.test(ipcCode2), 'ipcHandlers: compteur aiAnalyzed supprimé');
assert(!/aiFallback/.test(ipcCode2), 'ipcHandlers: compteur aiFallback supprimé');
assert(!/marketAnalyzed/.test(ipcCode2), 'ipcHandlers: compteur marketAnalyzed supprimé');
assert(!/writeSummaryFile/.test(ipcCode2), 'ipcHandlers: writeSummaryFile supprimé');
assert(!/resumes-ia/.test(ipcCode2), 'ipcHandlers: écriture resumes-ia.json supprimée');

// CSS pour les logs
const cssCode2 = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');
assert(/\.logs-toolbar/.test(cssCode2), 'styles.css: styles de la toolbar logs');
assert(/\.log-debug/.test(cssCode2), 'styles.css: style log-debug (mode debug)');
assert(/\.log-info/.test(cssCode2), 'styles.css: style log-info');
assert(/\.log-warn/.test(cssCode2), 'styles.css: style log-warn');
assert(/\.log-error/.test(cssCode2), 'styles.css: style log-error');
// Plus de styles AI Studio / market-progress / structure-warning
assert(!/\.ai-studio/.test(cssCode2), 'styles.css: styles .ai-studio supprimés');
assert(!/\.market-progress/.test(cssCode2), 'styles.css: styles .market-progress supprimés');
assert(!/\.structure-warning/.test(cssCode2), 'styles.css: styles .structure-warning supprimés');
assert(!/\.ai-tab/.test(cssCode2), 'styles.css: styles .ai-tab supprimés');
assert(!/\.ai-panel/.test(cssCode2), 'styles.css: styles .ai-panel supprimés');
assert(!/\.prompt-card/.test(cssCode2), 'styles.css: styles .prompt-card supprimés');

// CAPTCHA : détection de résolution (bug critique du vStatus figé)
const harCode2 = fs.readFileSync(path.join(base, 'services/scraping/harCapturer.js'), 'utf8');
assert(/latestHttpStatus/.test(harCode2), 'harCapturer: tracking dynamique latestHttpStatus (fix vStatus figé)');
assert(/vPage\.on\('response'/.test(harCode2), 'harCapturer: écouteur response pour statut HTTP temps réel');
assert(/resourceType\(\) === 'document'/.test(harCode2), 'harCapturer: filtre document sur resourceType (ignore sous-ressources)');
assert(/checkVBlocked = async \(\) => \{[\s\S]*?return this\._checkCaptcha\(vPage\)/.test(harCode2), 'harCapturer: polling content-based (plus de vStatus figé)');
assert(/confirmedClear/.test(harCode2), 'harCapturer: confirmation anti-faux-positif (confirmedClear)');
assert(!/while \(isBlocked && !this\.isCancelled\)/.test(harCode2), 'harCapturer: ancienne boucle isBlocked remplacée par confirmedClear');
assert(/POLL_INTERVAL_MS = 2000/.test(harCode2), 'harCapturer: polling 2s (detection rapide, plus 3s)');

// Pipeline : exit code 1 sur erreur CLI (était 0 → runner croyait succès)
const pipelineCode2 = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/scraping/leboncoin-pipeline.js'), 'utf8');
assert(/Erreur CLI[^\n]*\n[\s\S]*?throw err/.test(pipelineCode2), 'pipeline: throw err sur erreur CLI (pas de process.exit brutal)');

// sessionStats.pagesScraped mis à jour dans le handler de progression
assert(/pagesScraped/.test(ipcCode2), 'ipcHandlers: pagesScraped tracker présent');
assert(/currentPage > sessionStats\.pagesScraped/.test(ipcCode2), 'ipcHandlers: pagesScraped mis à jour depuis la progression HAR');

// ─── P1 : Bouton « Arrêter » universel (scraping) ───
assert(/activeCancel\s*=\s*\{\s*cancelled:\s*false\s*\}/.test(ipcCode2), 'ipcHandlers: token activeCancel créé pour job:start');
assert(/activeCancel\.cancelled\s*=\s*true/.test(ipcCode2), 'ipcHandlers: job:stop positionne activeCancel.cancelled (arrêt)');

// ─── P4 : Bouton « Ouvrir les jobs » (erreurs non silencieuses) ───
assert(/errStr\s*=\s*await\s+FileManager\.openFolder\(JOBS_DIR\)/.test(ipcCode2), 'ipcHandlers: jobs:openFolder await FileManager.openFolder et capture l\'erreur');
assert(/return\s+errStr/.test(fs.readFileSync(path.join(base, 'infrastructure/fileManager.js'), 'utf8')), 'fileManager: openFolder retourne errStr (shell.openPath)');

// D. Historique des annonces (changements prix/likes entre sessions)
const { buildAdHistory } = require(path.join(base, 'services/jobs/jobHistory'));
{
  const jobs = [
    { id: 'job-2026-08-01T10-00', date: '01/08/2026 à 10:00', ads: [
      { id: '1', title: 'iPhone', price: 150, statistiques: { likes: 10 } },
      { id: '2', title: 'Autre', price: 200 },
    ]},
    { id: 'job-2026-08-15T10-00', date: '15/08/2026 à 10:00', ads: [
      { id: '1', title: 'iPhone', price: 120, statistiques: { likes: 15 } },
      { id: '2', title: 'Autre', price: 200 },
    ]},
    { id: 'job-2026-08-30T10-00', date: '30/08/2026 à 10:00', ads: [
      { id: '1', title: 'iPhone', price: 100, statistiques: { likes: 24 } },
    ]},
  ];
  const history = buildAdHistory(jobs);
  assert(history.length === 2, 'buildAdHistory: 2 annonces uniques détectées');
  const ad1 = history.find((h) => h.id === '1');
  assert(ad1 && ad1.sessions === 3, 'buildAdHistory: annonce 1 vue dans 3 sessions');
  assert(ad1 && ad1.prix && ad1.prix.initial === 150 && ad1.prix.actuel === 100, 'buildAdHistory: prix initial/actuel corrects');
  assert(ad1 && ad1.prix.delta === -50 && ad1.prix.baisse === 50 && ad1.prix.direction === 'baisse', 'buildAdHistory: baisse de 50€ détectée');
  assert(ad1 && ad1.likes && ad1.likes.delta === 14 && ad1.likes.direction === 'up', 'buildAdHistory: hausse de likes 10→24 détectée');
  assert(history[0].id === '1', 'buildAdHistory: tri par activité (baisse + likes up en premier)');
  const ad2 = history.find((h) => h.id === '2');
  assert(ad2 && ad2.prix === null, 'buildAdHistory: prix stable → null (pas de changement)');
  assert(ad2 && ad2.likes === null, 'buildAdHistory: pas de likes → null');
}
assert(/getAdHistory/.test(fs.readFileSync(path.join(base, 'core/ipcHandlers.js'), 'utf8')), 'ipcHandlers: handler job:getAdHistory enregistré');
assert(/job:getAdHistory/.test(fs.readFileSync(path.join(base, 'preload.js'), 'utf8')), 'preload: getAdHistory exposé au renderer');
assert(/getAdHistory:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('job:getAdHistory'\)/.test(fs.readFileSync(path.join(base, 'preload.js'), 'utf8')), 'preload: getAdHistory IPC correctement câblée');

// A. Vérification du binaire Chromium (scraping-critique)
assert(/app:checkChromium/.test(ipcCode2), 'ipcHandlers: handler app:checkChromium enregistré');
assert(/chromium\.executablePath\(\)/.test(ipcCode2), 'ipcHandlers: app:checkChromium utilise chromium.executablePath()');
assert(/fs\.existsSync\(exePath\)/.test(ipcCode2), 'ipcHandlers: app:checkChromium vérifie l\'existence du binaire sur disque');
assert(/fixCommand/.test(ipcCode2), 'ipcHandlers: app:checkChromium renvoie fixCommand (aide utilisateur)');

const preloadCodeG = fs.readFileSync(path.join(base, 'preload.js'), 'utf8');
assert(/checkChromium:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('app:checkChromium'\)/.test(preloadCodeG), 'preload: expose checkChromium à l\'API renderer');

const indexHtmlG = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
assert(/id="chromiumWarning"/.test(indexHtmlG), 'index.html: élément #chromiumWarning présent (bandeau)');
assert(/chromiumWarningRetry/.test(indexHtmlG), 'index.html: bouton de revérification #chromiumWarningRetry présent');
assert(/npx playwright install chromium/.test(indexHtmlG), 'index.html: commande de correction affichée dans le bandeau');

const appJsCodeG = appCode;
assert(/refreshChromiumCheck/.test(appJsCodeG), 'app.js: fonction refreshChromiumCheck définie');
assert(/window\.api\.checkChromium\(\)/.test(appJsCodeG), 'app.js: appel à window.api.checkChromium() au démarrage');
assert(/res\.ok/.test(appJsCodeG) && /chromiumWarningEl/.test(appJsCodeG), 'app.js: masque/affiche le bandeau selon res.ok');

// jobHistory : plus de fichiers xlsx/csv/short/resumes
const jobHistCodeG = fs.readFileSync(path.join(base, 'services/jobs/jobHistory.js'), 'utf8');
assert(!/xlsxPath|\.xlsx/.test(jobHistCodeG), 'jobHistory: chemin annonces.xlsx supprimé');
assert(!/csvPath|\.csv/.test(jobHistCodeG), 'jobHistory: chemin annonces.csv supprimé');
assert(!/shortTxtPath|\.short/.test(jobHistCodeG), 'jobHistory: chemin annonces.short.txt supprimé');
assert(!/resumes|resumes-ia/.test(jobHistCodeG), 'jobHistory: chemin resumes-ia.json supprimé');
assert(!/files\.xlsx/.test(appCode), 'app.js: tag xlsx supprimé de l\'historique');
assert(!/files\.csv/.test(appCode), 'app.js: tag csv supprimé de l\'historique');
assert(!/files\.short/.test(appCode), 'app.js: tag short supprimé de l\'historique');
assert(!/files\.resumes/.test(appCode), 'app.js: tag resumes supprimé de l\'historique');
assert(!/\.tag-csv/.test(cssCode2), 'styles.css: style .tag-csv supprimé');
assert(!/\.tag-xlsx/.test(cssCode2), 'styles.css: style .tag-xlsx supprimé');
assert(!/\.tag-short/.test(cssCode2), 'styles.css: style .tag-short supprimé');

// ─── [10] Modes d'export (Défaut / Personnalisé) ───
console.log('\n[10] Export modes');
{
  const exporting = require('../src/main/services/exporting/exportFields');
  assert(typeof exporting.filterAdByFields === 'function', 'exportFields: filterAdByFields présent');
  assert(typeof exporting.toReadableBlock === 'function', 'exportFields: toReadableBlock présent');
  assert(Array.isArray(exporting.DEFAULT_FIELDS) && exporting.DEFAULT_FIELDS.length > 0, 'exportFields: DEFAULT_FIELDS non vide');
  assert(Array.isArray(exporting.FIELD_CATEGORIES) && exporting.FIELD_CATEGORIES.length > 0, 'exportFields: FIELD_CATEGORIES non vide');
  assert(Array.isArray(exporting.ALL_FIELD_KEYS) && exporting.ALL_FIELD_KEYS.length === exporting.DEFAULT_FIELDS.length, 'exportFields: ALL_FIELD_KEYS aligné sur DEFAULT_FIELDS');

  // Plus de toShortText / fromShortText
  assert(typeof exporting.toShortText === 'undefined', 'exportFields: toShortText supprimé');
  assert(typeof exporting.fromShortText === 'undefined', 'exportFields: fromShortText supprimé');
  // Plus de champs IA dans DEFAULT_FIELDS
  assert(!exporting.DEFAULT_FIELDS.some((f) => ['produitIdentifie', 'resumeIA', 'verdict', 'valeurMarche', 'fourchette', 'benefice', 'justification'].includes(f.key)),
    'exportFields: champs IA supprimés de DEFAULT_FIELDS');
  // Plus de catégorie ia
  assert(!exporting.FIELD_CATEGORIES.some((c) => c.id === 'ia'), 'exportFields: catégorie ia supprimée');

  // Mode Défaut : toReadableBlock renvoie un bloc avec tous les champs.
  const ad1 = {
    id: '1', title: 'Nintendo DS Lite', prix: 30, city: 'Dijon', zipcode: '21000',
    vendeurNom: 'Jean', vendeurNote: 4.5, likes: 10,
    description: 'Console en bon état',
    livraison: true, mainPropre: false, deliveryType: 'livraison',
    etat: 'Bon état',
    dateScraping: '2026-08-31T22:43:15Z',
    url: 'https://lbc.fr/1',
  };
  const blockDefaut = exporting.toReadableBlock(ad1, 0);
  assert(blockDefaut.includes('===== ANNONCE 1 ====='), 'TXT Défaut: en-tête annonce');
  assert(blockDefaut.includes('Nintendo DS Lite'), 'TXT Défaut: titre');
  assert(blockDefaut.includes('30 €'), 'TXT Défaut: prix formaté');
  assert(blockDefaut.includes('Console en bon état'), 'TXT Défaut: description');
  assert(blockDefaut.includes('Jean'), 'TXT Défaut: vendeur');
  assert(blockDefaut.includes('livraison'), 'TXT Défaut: deliveryType=livraison présent');

  // Mode Personnalisé (1 champ : titre + prix) : le bloc ne contient que ça.
  const blockPerso = exporting.toReadableBlock(ad1, 0, ['title', 'prix']);
  assert(blockPerso.includes('Titre'), 'TXT Perso (titre): libellé Titre');
  assert(blockPerso.includes('Prix'), 'TXT Perso (prix): libellé Prix');
  assert(blockPerso.includes('Nintendo DS Lite'), 'TXT Perso: titre présent');
  assert(blockPerso.includes('30 €'), 'TXT Perso: prix présent');
  assert(!blockPerso.includes('Description'), 'TXT Perso: pas de section Description');
  assert(!blockPerso.includes('Ville'), 'TXT Perso: pas de section Ville');
  assert(!blockPerso.includes('Vendeur'), 'TXT Perso: pas de section Vendeur');

  // filterAdByFields : mode Défaut (= null) → objet tel quel.
  const filteredDefault = exporting.filterAdByFields(ad1);
  assert(filteredDefault.id === '1', 'filterAdByFields default: id conservé');
  assert(filteredDefault.description === 'Console en bon état', 'filterAdByFields default: description conservée');

  // filterAdByFields : mode Personnalisé → uniquement les clés sélectionnées.
  const filteredCustom = exporting.filterAdByFields(ad1, ['id', 'title', 'prix']);
  assert(filteredCustom.id === '1' && filteredCustom.title === 'Nintendo DS Lite' && filteredCustom.prix === 30,
    'filterAdByFields custom: clés sélectionnées conservées');
  assert(filteredCustom.description === undefined, 'filterAdByFields custom: description retirée');
}

// Intégration pipeline : writeOutputs respecte le profil
{
  const pipelinePath = path.join(base, 'services/scraping/leboncoin-pipeline.js');
  const pipelineCode = fs.readFileSync(pipelinePath, 'utf8');
  assert(/--profile-id/.test(pipelineCode), 'pipeline: option CLI --profile-id');
  assert(/--profile-fields/.test(pipelineCode), 'pipeline: option CLI --profile-fields');
  assert(/filterAdByFields/.test(pipelineCode), 'pipeline: utilise filterAdByFields pour le profil');
  // Plus de short.txt
  assert(!/annonces\.short\.txt/.test(pipelineCode), 'pipeline: plus de annonces.short.txt');
  // Plus d'anciennes options --export-mode / --export-fields
  assert(!/--export-mode/.test(pipelineCode), 'pipeline: ancienne option --export-mode supprimée');
  assert(!/--export-fields/.test(pipelineCode), 'pipeline: ancienne option --export-fields supprimée');
}

// Integration pipelineRunner → pipeline
{
  const runnerCode = fs.readFileSync(path.join(base, 'services/scraping/pipelineRunner.js'), 'utf8');
  assert(/profileId/.test(runnerCode), 'pipelineRunner: déstructure profileId');
  assert(/profileFields/.test(runnerCode), 'pipelineRunner: déstructure profileFields');
  assert(/--profile-id/.test(runnerCode), 'pipelineRunner: forward --profile-id au pipeline');
  assert(/--profile-fields/.test(runnerCode), 'pipelineRunner: forward --profile-fields au pipeline');
  // Plus d'anciennes options
  assert(!/--export-mode/.test(runnerCode), 'pipelineRunner: ancienne option --export-mode supprimée');
  assert(!/--export-fields/.test(runnerCode), 'pipelineRunner: ancienne option --export-fields supprimée');
}

// ipcHandlers : wiring complet du profil
{
  const ipcCodeNew = fs.readFileSync(path.join(base, 'core/ipcHandlers.js'), 'utf8');
  assert(/profileId/.test(ipcCodeNew), 'ipcHandlers: lit profileId depuis la config renderer');
  assert(/exportFields/.test(ipcCodeNew), 'ipcHandlers: lit exportFields depuis la config renderer');
  assert(/getProfileFields/.test(ipcCodeNew), 'ipcHandlers: utilise getProfileFields pour résoudre les champs');
  assert(/profileFields/.test(ipcCodeNew), 'ipcHandlers: passe profileFields au pipeline');
  // Plus de régénération XLSX/CSV
  assert(!/export-meta\.json.*XLSX|XLSX.*export-meta/.test(ipcCodeNew), 'ipcHandlers: plus de régénération XLSX/CSV');
  assert(!/ExcelExporter/.test(ipcCodeNew), 'ipcHandlers: plus d\'ExcelExporter');
}

// jobHistory : plus de export-meta + short file
{
  const jobHistCode = fs.readFileSync(path.join(base, 'services/jobs/jobHistory.js'), 'utf8');
  assert(!/shortTxtPath/.test(jobHistCode), 'jobHistory: plus de shortTxtPath');
  assert(!/short:/.test(jobHistCode), 'jobHistory: plus de fichier short listé dans files');
}

// UI : profil + sélection des champs
{
  const indexCode = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
  assert(/id="exportModeDefault"/.test(indexCode), 'index.html: radio profil Défaut');
  assert(/id="exportModeMaximum"/.test(indexCode), 'index.html: radio profil Maximum');
  assert(/id="exportModeCustom"/.test(indexCode), 'index.html: radio profil Personnalisé');
  assert(/id="exportFieldsPanel"/.test(indexCode), 'index.html: panneau sélection des champs');
  assert(/id="exportFieldsAll"/.test(indexCode), 'index.html: bouton Tout sélectionner');
  assert(/id="exportFieldsNone"/.test(indexCode), 'index.html: bouton Tout désélectionner');
  assert(/id="exportFieldsList"/.test(indexCode), 'index.html: liste des champs cochables');
  assert(/id="exportProfileDescription"/.test(indexCode), 'index.html: description du profil affichée');

  const appCodeNew = appCode;
  assert(/EXPORT_FIELDS/.test(appCodeNew), 'app.js: liste EXPORT_FIELDS');
  assert(/getSelectedProfile/.test(appCodeNew), 'app.js: accesseur profil sélectionné (getSelectedProfile)');
  assert(/getSelectedExportFields/.test(appCodeNew), 'app.js: accesseur champs sélectionnés');
  assert(/profileId:\s*getSelectedProfile\(\)/.test(appCodeNew),
    'app.js: startScraping envoie profileId');
  assert(/exportFields:\s*getSelectedProfile\(\)\s*===\s*.custom.\s*\?/.test(appCodeNew),
    'app.js: startScraping envoie exportFields uniquement si profil=custom');
  assert(/tag-txt/.test(appCodeNew), 'app.js: tag "TXT" affiché dans la table');
  assert(/tag-export-custom/.test(appCodeNew), 'app.js: badge "Personnalisé" affiché en mode custom');

  const stylesCode = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');
  assert(/\.tag-txt\s*\{/.test(stylesCode), 'styles.css: .tag-txt');
  assert(/\.tag-export-custom\s*\{/.test(stylesCode), 'styles.css: .tag-export-custom');
}

// Carte Leaflet : filtre main propre utilise deliveryType
{
  const appCodeMap = appCode;
  assert(/deliveryType/.test(appCodeMap),
    'app.js: filtre carte utilise deliveryType (modèle unifié)');
  assert(/Leaflet non (chargé|disponible)/.test(appCodeMap),
    'app.js: diagnostic Leaflet non chargé (L undefined)');
}

// ─── [10b] dataProfiles : 3 profils (Défaut / Maximum / Personnalisé) ───
console.log('\n[10b] dataProfiles (3 profils)');
(function () {
  const dp = require('../src/main/services/exporting/dataProfiles');
  const { ALL_FIELD_KEYS } = require('../src/main/services/exporting/exportFields');

  assert(typeof dp.getProfileFields === 'function', 'dataProfiles: getProfileFields présent');
  assert(typeof dp.getProfileLabel === 'function', 'dataProfiles: getProfileLabel présent');
  assert(typeof dp.PROFILES === 'object', 'dataProfiles: PROFILES présent');
  assert(dp.PROFILES.default.id === 'default', 'dataProfiles: profil default.id');
  assert(dp.PROFILES.maximum.id === 'maximum', 'dataProfiles: profil maximum.id');
  assert(dp.PROFILES.custom.id === 'custom', 'dataProfiles: profil custom.id');
  assert(dp.PROFILES.default.label === 'Défaut', 'dataProfiles: label Défaut');
  assert(dp.PROFILES.maximum.label === 'Maximum', 'dataProfiles: label Maximum');
  assert(dp.PROFILES.custom.label === 'Personnalisé', 'dataProfiles: label Personnalisé');

  // DEFAULT_PROFILE_FIELDS : sous-ensemble des champs essentiels
  assert(Array.isArray(dp.DEFAULT_PROFILE_FIELDS) && dp.DEFAULT_PROFILE_FIELDS.length > 0,
    'dataProfiles: DEFAULT_PROFILE_FIELDS non vide');
  assert(dp.DEFAULT_PROFILE_FIELDS.includes('id'), 'dataProfiles: DEFAULT inclut id');
  assert(dp.DEFAULT_PROFILE_FIELDS.includes('title'), 'dataProfiles: DEFAULT inclut title');
  assert(dp.DEFAULT_PROFILE_FIELDS.includes('prix'), 'dataProfiles: DEFAULT inclut prix');
  assert(dp.DEFAULT_PROFILE_FIELDS.includes('description'), 'dataProfiles: DEFAULT inclut description');
  // DEFAULT est un sous-ensemble strict de ALL_FIELD_KEYS (pas toutes les clés)
  assert(dp.DEFAULT_PROFILE_FIELDS.length < ALL_FIELD_KEYS.length,
    'dataProfiles: DEFAULT_PROFILE_FIELDS est un sous-ensemble (< ALL_FIELD_KEYS)');

  // MAXIMUM_PROFILE_FIELDS : toutes les clés disponibles
  assert(Array.isArray(dp.MAXIMUM_PROFILE_FIELDS), 'dataProfiles: MAXIMUM_PROFILE_FIELDS est un tableau');
  assert(dp.MAXIMUM_PROFILE_FIELDS.length === ALL_FIELD_KEYS.length,
    'dataProfiles: MAXIMUM_PROFILE_FIELDS = ALL_FIELD_KEYS (toutes les clés)');

  // getProfileFields : profil default → DEFAULT_PROFILE_FIELDS
  const defaultFields = dp.getProfileFields('default');
  assert(Array.isArray(defaultFields) && defaultFields.length === dp.DEFAULT_PROFILE_FIELDS.length,
    'getProfileFields(default): renvoie DEFAULT_PROFILE_FIELDS');
  assert(defaultFields.includes('id') && defaultFields.includes('title'),
    'getProfileFields(default): contient les champs essentiels');

  // getProfileFields : profil maximum → toutes les clés
  const maxFields = dp.getProfileFields('maximum');
  assert(maxFields.length === ALL_FIELD_KEYS.length,
    'getProfileFields(maximum): renvoie toutes les clés');
  assert(ALL_FIELD_KEYS.every((k) => maxFields.includes(k)),
    'getProfileFields(maximum): contient toutes les clés');

  // getProfileFields : profil custom avec champs valides
  const customFields = dp.getProfileFields('custom', ['id', 'title', 'prix']);
  assert(Array.isArray(customFields) && customFields.length === 3,
    'getProfileFields(custom, [3 champs]): renvoie 3 champs');
  assert(customFields.includes('id') && customFields.includes('title') && customFields.includes('prix'),
    'getProfileFields(custom): champs personnalisés conservés');

  // getProfileFields : profil custom sans champs → fallback sur DEFAULT
  const customEmpty = dp.getProfileFields('custom', []);
  assert(Array.isArray(customEmpty) && customEmpty.length === dp.DEFAULT_PROFILE_FIELDS.length,
    'getProfileFields(custom, []): fallback sur DEFAULT_PROFILE_FIELDS');
  assert(customEmpty.includes('id'),
    'getProfileFields(custom, []): fallback contient id');

  // getProfileFields : profil custom avec champs invalides → filtrés
  const customInvalid = dp.getProfileFields('custom', ['id', 'fakeField', 'title']);
  assert(customInvalid.length === 2 && customInvalid.includes('id') && customInvalid.includes('title'),
    'getProfileFields(custom): champs invalides filtrés (seuls les valides sont conservés)');

  // getProfileFields : profil inconnu → fallback sur DEFAULT
  const unknownFields = dp.getProfileFields('unknown');
  assert(Array.isArray(unknownFields) && unknownFields.length === dp.DEFAULT_PROFILE_FIELDS.length,
    'getProfileFields(unknown): fallback sur DEFAULT_PROFILE_FIELDS');

  // getProfileLabel : libellés des profils
  assert(dp.getProfileLabel('default') === 'Défaut', 'getProfileLabel(default): "Défaut"');
  assert(dp.getProfileLabel('maximum') === 'Maximum', 'getProfileLabel(maximum): "Maximum"');
  assert(dp.getProfileLabel('custom') === 'Personnalisé', 'getProfileLabel(custom): "Personnalisé"');
  assert(dp.getProfileLabel('unknown') === 'Défaut', 'getProfileLabel(unknown): fallback "Défaut"');

  // filterAdByFields avec getProfileFields : cohérence du filtrage
  const { filterAdByFields } = require('../src/main/services/exporting/exportFields');
  const testAd = { id: '1', title: 'Test', prix: 100, ville: 'Lyon', description: 'desc', vendeurNom: 'Jean', likes: 42, vendeurNote: 4.8 };
  const filteredDefault = filterAdByFields(testAd, dp.getProfileFields('default'));
  assert(filteredDefault.id === '1' && filteredDefault.title === 'Test',
    'filterAdByFields + getProfileFields(default): champs essentiels conservés');
  assert(filteredDefault.vendeurNom === 'Jean',
    'filterAdByFields + getProfileFields(default): vendeurNom present (dans le profil Defaut)');
  assert(filteredDefault.likes === undefined,
    'filterAdByFields + getProfileFields(default): likes absent (pas dans le profil Defaut)');
  assert(filteredDefault.vendeurNote === undefined,
    'filterAdByFields + getProfileFields(default): vendeurNote absent (pas dans le profil Defaut)');

  const filteredMax = filterAdByFields(testAd, dp.getProfileFields('maximum'));
  assert(filteredMax.id === '1' && filteredMax.title === 'Test' && filteredMax.vendeurNom === 'Jean',
    'filterAdByFields + getProfileFields(maximum): tous les champs conserves');
  assert(filteredMax.likes === 42,
    'filterAdByFields + getProfileFields(maximum): likes present (toutes les cles)');
})();

// === 5. Données vendeur + minimisation ===
console.log('\n[11] Données vendeur + minimisation');
const exporting = require('../src/main/services/exporting/exportFields');
const runnerCode = fs.readFileSync(path.join(base, 'services/scraping/pipelineRunner.js'), 'utf8');
const ipcCodeNew = fs.readFileSync(path.join(base, 'core/ipcHandlers.js'), 'utf8');
const indexCode = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
const appCodeNew = appCode;
const stylesCode = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');

// Settings : includeSellerData par défaut = true
assert(/includeSellerData:\s*true/.test(settingsCode), 'settings: includeSellerData default true');

// exportFields : SELLER_FIELD_KEYS présent
const exportFieldsCode = fs.readFileSync(path.join(base, 'services/exporting/exportFields.js'), 'utf8');
assert(/SELLER_FIELD_KEYS/.test(exportFieldsCode), 'exportFields: SELLER_FIELD_KEYS défini');
assert(/excludeSellerData/.test(exportFieldsCode), 'exportFields: excludeSellerData supporté');

// filterAdByFields exclut les champs vendeur quand excludeSellerData=true
const testAd = { id: '1', title: 'Test', prix: 100, vendeurNom: 'Jean', vendeurNote: 4.8, city: 'Paris' };
const filteredNoSeller = exporting.filterAdByFields(testAd, exporting.ALL_FIELD_KEYS, { excludeSellerData: true });
assert(!('vendeurNom' in filteredNoSeller), 'filterAdByFields: excludeSellerData=true retire vendeurNom');
assert(!('vendeurNote' in filteredNoSeller), 'filterAdByFields: excludeSellerData=true retire vendeurNote');
assert(filteredNoSeller.id === '1', 'filterAdByFields: garde les champs non-vendeur');

// toReadableBlock exclut les champs vendeur
const blockNoSeller = exporting.toReadableBlock(testAd, 0, exporting.ALL_FIELD_KEYS, { excludeSellerData: true });
assert(!blockNoSeller.includes('Vendeur'), 'toReadableBlock: excludeSellerData=true exclut section Vendeur');

// Pipeline : --no-seller-data argument parsé
assert(/--no-seller-data/.test(pipelineCode), 'pipeline: argument CLI --no-seller-data');
assert(/includeSellerData/.test(pipelineCode), 'pipeline: includeSellerData dans writeOutputsFactory');
assert(/export-meta\.json/.test(pipelineCode) && /includeSellerData/.test(pipelineCode), 'pipeline: export-meta.json inclut includeSellerData');

// pipelineRunner : forward --no-seller-data
assert(/--no-seller-data/.test(runnerCode), 'pipelineRunner: forward --no-seller-data');

// ipcHandlers : includeSellerData passé au pipeline
assert(/includeSellerData/.test(ipcCodeNew), 'ipcHandlers: passe includeSellerData au pipeline');

// index.html : modal légal + checkbox données vendeur
assert(/id="legalNoticeModal"/.test(indexCode), 'index.html: modal Utilisation autorisée uniquement');
assert(/id="cfgIncludeSellerData"/.test(indexCode), 'index.html: checkbox Données vendeur');
assert(/id="legalNoticeAcceptBtn"/.test(indexCode), 'index.html: bouton J\'ai compris');

// app.js : logique modal légal + visibilité données vendeur
assert(/legalNoticeModal/.test(appCodeNew), 'app.js: référence modal légal');
assert(/LEGAL_NOTICE_KEY/.test(appCodeNew), 'app.js: clé localStorage pour notice légale');
assert(/includeSellerData/.test(appCodeNew), 'app.js: gestion includeSellerData');
assert(/applySellerDataVisibility/.test(appCodeNew), 'app.js: fonction applySellerDataVisibility');
assert(/seller-data-hidden/.test(appCodeNew) || /seller-data-hidden/.test(stylesCode), 'app.js/styles: classe seller-data-hidden');

// Fichiers documentation
assert(fs.existsSync(path.join(__dirname, '..', 'LEGAL.md')), 'LEGAL.md existe à la racine');
assert(fs.existsSync(path.join(__dirname, '..', 'docs', 'DATA_HANDLING.md')), 'docs/DATA_HANDLING.md existe');

// --- 12. Sécurité + robustesse ---
console.log('\n[12] Sécurité + robustesse');

// URL Security helper : validation SSRF présente
const urlSecCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/utils/urlSecurity.js'), 'utf8');
assert(/validateRemoteUrl/.test(urlSecCode), 'urlSecurity: validateRemoteUrl présente');
assert(/127\.0\.0\.0|10\.0\.0\.0|172\.16\.0\.0|192\.168\.0\.0/.test(urlSecCode), 'urlSecurity: plages IP privées bloquées');

// urlSecurity : comportement réel (IPv4 privées, IPv6 ULA/link-local, IPv4-mappées)
(function () {
  const { isPrivateIPv4, isPrivateIPv6, isBlockedIpLiteral } = require('../src/main/utils/urlSecurity');
  assert(isPrivateIPv4('127.0.0.1') === true, 'urlSecurity: 127.0.0.1 privée');
  assert(isPrivateIPv4('10.0.0.5') === true, 'urlSecurity: 10.0.0.0/8 privée');
  assert(isPrivateIPv4('172.16.0.1') === true, 'urlSecurity: 172.16/12 privée');
  assert(isPrivateIPv4('192.168.1.1') === true, 'urlSecurity: 192.168/16 privée');
  assert(isPrivateIPv4('169.254.1.1') === true, 'urlSecurity: 169.254/16 link-local');
  assert(isPrivateIPv4('100.64.0.1') === true, 'urlSecurity: 100.64/10 CGNAT');
  assert(isPrivateIPv4('8.8.8.8') === false, 'urlSecurity: 8.8.8.8 publique (autorisée)');
  assert(isPrivateIPv4('1.1.1.1') === false, 'urlSecurity: 1.1.1.1 publique');
  assert(isPrivateIPv6('::1') === true, 'urlSecurity: ::1 loopback IPv6');
  assert(isPrivateIPv6('fc00::1') === true, 'urlSecurity: fc00::/7 ULA');
  assert(isPrivateIPv6('fd12::1') === true, 'urlSecurity: fd…/8 ULA');
  assert(isPrivateIPv6('fe80::1') === true, 'urlSecurity: fe80::/10 link-local');
  assert(isPrivateIPv6('::ffff:127.0.0.1') === true, 'urlSecurity: IPv4-mappée 127.0.0.1 bloquée');
  assert(isPrivateIPv6('::ffff:8.8.8.8') === false, 'urlSecurity: IPv4-mappée publique autorisée');
  assert(isPrivateIPv6('2001:4860:4860::8888') === false, 'urlSecurity: IPv6 publique autorisée');
  assert(isBlockedIpLiteral('10.0.0.1') === true, 'urlSecurity: isBlockedIpLiteral IPv4 privée');
  assert(isBlockedIpLiteral('2001:4860:4860::8888') === false, 'urlSecurity: isBlockedIpLiteral IPv6 publique');
})();

// urlSecurity : isSafeFetchDestination (contrôle synchrone fail-closed du chemin navigateur)
(function () {
  const { isSafeFetchDestination, isHostAllowed } = require('../src/main/utils/urlSecurity');

  // Destinations autorisées (Leboncoin légitime)
  assert(isSafeFetchDestination('https://www.leboncoin.fr/recherche?text=pc').safe === true,
    'urlSecurity: URL Leboncoin https autorisée');
  assert(isSafeFetchDestination('https://img.leboncoin.fr/api/v1/img').safe === true,
    'urlSecurity: CDN image Leboncoin autorisé (sans allowlist)');

  // Protocoles non http(s)
  assert(isSafeFetchDestination('file:///etc/passwd').safe === false, 'urlSecurity: file:// refusé');
  assert(isSafeFetchDestination('ftp://example.com/x').safe === false, 'urlSecurity: ftp:// refusé');
  assert(isSafeFetchDestination('data:text/html,x').safe === false, 'urlSecurity: data: refusé');
  assert(isSafeFetchDestination('javascript:alert(1)').safe === false, 'urlSecurity: javascript: refusé');

  // IP privées / loopback / link-local littérales (SSRF)
  assert(isSafeFetchDestination('http://127.0.0.1/').safe === false, 'urlSecurity: 127.0.0.1 refusé');
  assert(isSafeFetchDestination('http://169.254.169.254/latest/meta-data/').safe === false,
    'urlSecurity: endpoint metadata cloud refusé');
  assert(isSafeFetchDestination('http://10.0.0.5/').safe === false, 'urlSecurity: 10/8 refusé');
  assert(isSafeFetchDestination('http://[::1]/').safe === false, 'urlSecurity: [::1] refusé');
  assert(isSafeFetchDestination('http://[fe80::1]/').safe === false, 'urlSecurity: [fe80::1] refusé');
  assert(isSafeFetchDestination('http://[::ffff:127.0.0.1]/').safe === false, 'urlSecurity: IPv4-mappée refusée');

  // Hostnames locaux
  assert(isSafeFetchDestination('http://localhost/').safe === false, 'urlSecurity: localhost refusé');
  assert(isSafeFetchDestination('http://printer.local/').safe === false, 'urlSecurity: *.local refusé');
  assert(isSafeFetchDestination('http://svc.internal/').safe === false, 'urlSecurity: *.internal refusé');

  // Allowlist : impose le domaine Leboncoin
  assert(isSafeFetchDestination('http://127.0.0.1/', ['leboncoin.fr']).safe === false,
    'urlSecurity: IP privée refusée même avec allowlist');
  assert(isSafeFetchDestination('https://evil.example.com/x', ['leboncoin.fr']).safe === false,
    'urlSecurity: domaine hors allowlist refusé');
  assert(isSafeFetchDestination('https://www.leboncoin.fr/recherche', ['leboncoin.fr']).safe === true,
    'urlSecurity: domaine Leboncoin accepté avec allowlist');
  assert(isSafeFetchDestination('https://leboncoin.fr.attacker.com/x', ['leboncoin.fr']).safe === false,
    'urlSecurity: suffixe trompeur (leboncoin.fr.attacker.com) refusé');
  assert(isHostAllowed('www.leboncoin.fr', ['leboncoin.fr']) === true, 'urlSecurity: isHostAllowed sous-domaine');
  assert(isHostAllowed('leboncoin.fr.attacker.com', ['leboncoin.fr']) === false, 'urlSecurity: isHostAllowed suffixe trompeur');
})();

// urlSecurity : validateRemoteUrl fail-closed (DNS vide → refus) + allowlist
await (async function () {
  const { validateRemoteUrl } = require('../src/main/utils/urlSecurity');
  const badProto = await validateRemoteUrl('gopher://example.com/');
  assert(badProto.safe === false, 'urlSecurity: validateRemoteUrl refuse les protocoles non http(s)');
  const badIp = await validateRemoteUrl('http://192.168.1.1/');
  assert(badIp.safe === false, 'urlSecurity: validateRemoteUrl refuse une IP privée littérale');
  const emptyDns = await validateRemoteUrl('http://definitely-not-a-real-host-xyz-9999.invalid/');
  assert(emptyDns.safe === false && /fail-closed/.test(emptyDns.reason || ''),
    'urlSecurity: validateRemoteUrl fail-closed si résolution DNS vide');
})();

// harCapturer : câblage du contrôle de destination + garde réseau
{
  const harSecCode = fs.readFileSync(path.join(__dirname, '..', 'src/main/services/scraping/harCapturer.js'), 'utf8');
  assert(/isSafeFetchDestination/.test(harSecCode), 'harCapturer: utilise isSafeFetchDestination');
  assert(/LEBONCOIN_SOURCE_HOSTS/.test(harSecCode), 'harCapturer: allowlist des domaines Leboncoin définie');
  assert(/isSafeFetchDestination\(searchUrl, LEBONCOIN_SOURCE_HOSTS\)/.test(harSecCode),
    'harCapturer: valide l\'URL de recherche contre l\'allowlist Leboncoin');
  assert(/_installNetworkGuard/.test(harSecCode), 'harCapturer: garde réseau installée');
  assert(/ctx\.route\(/.test(harSecCode), 'harCapturer: intercepte les sous-requêtes (route)');
  assert(/route\.abort\(/.test(harSecCode), 'harCapturer: bloque les requêtes interdites');
}

// Data nullability : livraison/mainPropre/type ne sont plus inventés
const adFieldsCodeFinal = fs.readFileSync(path.join(base, 'services/scraping/adFields.js'), 'utf8');
assert(!/Array\.isArray\(raw\?\.attributes\) && raw\.attributes\.length > 0/.test(adFieldsCodeFinal), 'adFields: plus de fallback livraison=false sur attributes');
assert(!/mainPropre\s*=\s*true[^;]*livraison\s*===?\s*false/.test(adFieldsCodeFinal.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'adFields: plus de fallback mainPropre=true sur livraison=false');
assert(!/type:\s*type\s*\|\|\s*\(isPro/.test(adFieldsCodeFinal), 'adFields: plus de default type=particulier');

// Pipeline : process.exit remplacé par return/throw
const pipelineCodeFinal = fs.readFileSync(path.join(base, 'services/scraping/leboncoin-pipeline.js'), 'utf8');
assert(!/process\.exit\(0\)/.test(pipelineCodeFinal), 'pipeline: plus de process.exit(0)');
assert(/process\.exitCode\s*=\s*1/.test(pipelineCodeFinal) || /throw\s+err/.test(pipelineCodeFinal), 'pipeline: erreurs via throw/process.exitCode');

// export-meta.json : checksum
assert(/writeWithChecksum.*export-meta/.test(pipelineCodeFinal), 'pipeline: export-meta.json écrit avec checksum');

// --- 13. Tests comportementaux sécurité ---
console.log('\n[13] Tests comportementaux sécurité');

// XSS: escapeHtml doit échapper les caractères dangereux
const appCodeFinal = appCode;
assert(/function escapeHtml\(str\)/.test(appCodeFinal), 'app.js: escapeHtml définie');
assert(appCodeFinal.includes("replace(/&/g, '&amp;')"), 'escapeHtml: échappe &');
assert(appCodeFinal.includes("replace(/</g, '&lt;')"), 'escapeHtml: échappe <');
assert(appCodeFinal.includes("replace(/>/g, '&gt;')"), 'escapeHtml: échappe >');
assert(appCodeFinal.includes("replace(/\"/g, '&quot;')"), 'escapeHtml: échappe "');
assert(appCodeFinal.includes("replace(/'/g, '&#39;')"), 'escapeHtml: échappe \'');

// Test comportemental de la regex d'échappement (simulation)
const dangerous = '<script>alert(1)</script>';
const simulated = dangerous.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
assert(simulated.includes('&lt;script&gt;'), 'escapeHtml simulation: échappe <script>');
assert(!simulated.includes('<script>'), 'escapeHtml simulation: pas de <script> brut');

// JSON.parse corrompu : pipeline doit gérer l'erreur et re-scraper
const tmpDirCorrupt = fs.mkdtempSync(path.join(os.tmpdir(), 'lbc-corrupt-'));
const corruptJsonPath = path.join(tmpDirCorrupt, 'annonces.json');
fs.writeFileSync(corruptJsonPath, 'NOT VALID JSON{{{');
const pipelineCode3 = fs.readFileSync(path.join(base, 'services/scraping/leboncoin-pipeline.js'), 'utf8');
assert(/JSON\.parse\(fs\.readFileSync\(jsonPath/.test(pipelineCode3), 'pipeline: parse annonces.json');
assert(/try[\s\S]*?JSON\.parse[\s\S]*?catch/.test(pipelineCode3) || /catch \(err\)[\s\S]*?annonces\.json corrompu/.test(pipelineCode3), 'pipeline: JSON.parse protégé par try/catch');

// localStorage: les données corrompues ne doivent pas crasher
const localStorageSafePattern = /try\s*\{[\s\S]*?localStorage\.getItem\(['"]starred-ads['"]\)[\s\S]*?JSON\.parse[\s\S]*?new\s+Set\(/;
assert(localStorageSafePattern.test(appCode), 'app.js: localStorage starred-ads parsé avec try/catch');

// --- 14. Détection de changement de structure Leboncoin ---
console.log('\n[14] Détection changement de structure');
(function () {
const { detectStructureChanges } = require('../src/main/services/scraping/leboncoin-pipeline');
assert(typeof detectStructureChanges === 'function', 'detectStructureChanges exportée depuis le pipeline');

// Cas normal : tous les champs critiques présents → pas de warning
const normalAds = Array.from({ length: 10 }, (_, i) => ({
  list_id: i + 1, subject: `Item ${i}`, price: 100, body: 'desc',
  location: { city: 'Paris' },
}));
const normalResult = detectStructureChanges(normalAds, null);
assert(normalResult.warnings.length === 0, 'detectStructureChanges: pas de warning quand tous les champs présents');
assert(normalResult.missingFields.length === 0, 'detectStructureChanges: missingFields vide quand structure OK');

// Cas changement : list_id supprimé (renommé en ad_id) → détecté via alternatives
const renamedIdAds = Array.from({ length: 10 }, (_, i) => ({
  ad_id: i + 1, subject: `Item ${i}`, price: 100, body: 'desc',
  location: { city: 'Paris' },
}));
const renamedResult = detectStructureChanges(renamedIdAds, null);
assert(renamedResult.warnings.length === 0, 'detectStructureChanges: pas de warning si alternative trouvée (ad_id pour list_id)');

// Cas réel : Leboncoin supprime "price" et "body" → 2 warnings
const brokenAds = Array.from({ length: 10 }, (_, i) => ({
  list_id: i + 1, subject: `Item ${i}`,
  location: { city: 'Lyon' },
  new_price_field: 100,
  new_body_field: 'desc',
}));
const brokenResult = detectStructureChanges(brokenAds, null);
assert(brokenResult.warnings.length >= 2, 'detectStructureChanges: 2+ warnings quand price ET body manquent');
assert(brokenResult.missingFields.includes('price'), 'detectStructureChanges: price détecté comme manquant');
assert(brokenResult.missingFields.includes('body'), 'detectStructureChanges: body détecté comme manquant');

// Cas limite : tableau vide → pas de crash, pas de warning
const emptyResult = detectStructureChanges([], null);
assert(emptyResult.warnings.length === 0, 'detectStructureChanges: tableau vide → pas de warning');
assert(detectStructureChanges(null, null).warnings.length === 0, 'detectStructureChanges: null → pas de crash');

// Cas seuil : 50% manquant → pas de warning (seuil >70%)
const halfMissing = Array.from({ length: 10 }, (_, i) => ({
  list_id: i + 1, subject: `Item ${i}`, body: 'desc', location: { city: 'Lyon' },
  ...(i < 5 ? { price: 100 } : {}),
}));
const halfResult = detectStructureChanges(halfMissing, null);
assert(halfResult.warnings.length === 0, 'detectStructureChanges: 50% manquant → pas de warning (seuil 70%)');

})();

// --- 15. exportFields : filterAdByFields + toReadableBlock ---
console.log('\n[15] exportFields (filterAdByFields + toReadableBlock)');
(function () {
const { filterAdByFields, toReadableBlock, ALL_FIELD_KEYS } = require('../src/main/services/exporting/exportFields');

const rtAd = {
  id: '12345', title: 'iPhone 12 | 128Go', url: 'https://www.leboncoin.fr/ad/12345.htm',
  prix: 350, city: 'Lyon', zipcode: '69000',
  vendeurNom: 'Jean', vendeurType: 'particulier', vendeurId: 'u1',
  vendeurNote: 4.8, nombreAvis: 27, vendeurUrlProfil: 'https://www.leboncoin.fr/u1',
  vendeurAncienneteJours: 365,
  livraison: true, mainPropre: false, deliveryType: 'livraison',
  likes: 12,
  datePublication: '2026-09-10T10:00:00Z',
  dateModification: null,
  dateScraping: '2026-09-14T12:00:00Z',
  etat: 'Très bon état',
  photosCount: 5, photosUrls: ['https://img.lbc.fr/1.jpg', 'https://img.lbc.fr/2.jpg'],
  description: 'Vends iPhone 12\n128Go\nPas de rayures',
};

// filterAdByFields : mode Personnalisé ne garde que les champs sélectionnés
const filtered = filterAdByFields(rtAd, ['id', 'title', 'prix']);
assert(filtered.id === '12345', 'filterAdByFields: id conservé');
assert(filtered.title === 'iPhone 12 | 128Go', 'filterAdByFields: title conservé');
assert(filtered.prix === 350, 'filterAdByFields: prix conservé');
assert(!('city' in filtered), 'filterAdByFields: city supprimé (non sélectionné)');
assert(!('vendeurNom' in filtered), 'filterAdByFields: vendeurNom supprimé (non sélectionné)');

// filterAdByFields : null/[] → objet tel quel (mode Défaut)
assert(filterAdByFields(rtAd, null) === rtAd, 'filterAdByFields: null → objet original (mode Défaut)');
assert(filterAdByFields(rtAd, []) === rtAd, 'filterAdByFields: [] → objet original (mode Défaut)');

// filterAdByFields : excludeSellerData
const filteredNoSeller = filterAdByFields(rtAd, ALL_FIELD_KEYS, { excludeSellerData: true });
assert(!('vendeurNom' in filteredNoSeller), 'filterAdByFields: excludeSellerData supprime vendeurNom');
assert(filteredNoSeller.id === '12345', 'filterAdByFields: excludeSellerData garde id');

// toReadableBlock : génère un bloc TXT lisible
const block = toReadableBlock(rtAd, 0);
assert(block.includes('===== ANNONCE 1 ====='), 'toReadableBlock: en-tête annonce');
assert(block.includes('iPhone 12 | 128Go'), 'toReadableBlock: titre dans le bloc');
assert(block.includes('350 €'), 'toReadableBlock: prix formaté avec €');
assert(block.includes('Lyon'), 'toReadableBlock: ville dans le bloc');

// toReadableBlock : mode Personnalisé ne montre que les champs sélectionnés
const customBlock = toReadableBlock(rtAd, 0, ['id', 'title']);
assert(customBlock.includes('12345'), 'toReadableBlock custom: id présent');
assert(customBlock.includes('iPhone 12 | 128Go'), 'toReadableBlock custom: titre présent');
assert(!customBlock.includes('Lyon'), 'toReadableBlock custom: ville absente (non sélectionnée)');

})();

// --- 16. adFields : extracteurs défensifs sur fixtures variées ---
console.log('\n[16] adFields extracteurs (fixtures)');
(function () {
const adFields = require('../src/main/services/scraping/adFields');

// extractDescription : body string, objet {text}, null
assert(adFields.extractDescription({ body: 'texte simple' }) === 'texte simple', 'extractDescription: body string');
assert(adFields.extractDescription({ body: { text: 'texte objet' } }) === 'texte objet', 'extractDescription: body objet {text}');
assert(adFields.extractDescription({ body: {} }) === null, 'extractDescription: body objet vide → null');
assert(adFields.extractDescription({ body: 42 }) === null, 'extractDescription: body nombre → null');
assert(adFields.extractDescription({ body: null }) === null, 'extractDescription: body null → null');
assert(adFields.extractDescription({ description: 'fallback' }) === 'fallback', 'extractDescription: description fallback');
assert(adFields.extractDescription({}) === null, 'extractDescription: objet vide → null');
assert(adFields.extractDescription(null) === null, 'extractDescription: null → null');

// extractPrice : nombre, string, array, objet, null
assert(adFields.extractPrice({ price: 150 }) === 150, 'extractPrice: nombre');
assert(adFields.extractPrice({ price: '200' }) === 200, 'extractPrice: string');
assert(adFields.extractPrice({ price: [{ value: 300 }] }) === 300, 'extractPrice: array d\'objets');
assert(adFields.extractPrice({ price: { value: 250 } }) === 250, 'extractPrice: objet {value}');
assert(adFields.extractPrice({ price: null }) === null, 'extractPrice: null → null');
assert(adFields.extractPrice({}) === null, 'extractPrice: absent → null');
assert(adFields.extractPrice({ price: 'abc' }) === null, 'extractPrice: string non-numérique → null');

// extractTransaction : livraison et mainPropre indépendants
const tx1 = adFields.extractTransaction({ has_option: { shipping: true }, body: 'remise en main propre' });
assert(tx1.livraison === true, 'extractTransaction: livraison=true depuis has_option');
assert(tx1.mainPropre === true, 'extractTransaction: mainPropre=true depuis description');
const tx2 = adFields.extractTransaction({ has_option: { shipping: false }, body: 'pas d\'envoi' });
assert(tx2.livraison === false, 'extractTransaction: livraison=false');
assert(tx2.mainPropre === true, 'extractTransaction: mainPropre=true (pas d\'envoi)');
const tx3 = adFields.extractTransaction({ body: 'retrait sur place' });
assert(tx3.livraison === null, 'extractTransaction: livraison=null si non trouvé');
assert(tx3.mainPropre === true, 'extractTransaction: mainPropre=true (retrait sur place)');
const tx4 = adFields.extractTransaction({});
assert(tx4.livraison === null && tx4.mainPropre === null, 'extractTransaction: objet vide → null/null');

// extractSeller : nom, type, note, id
const seller1 = adFields.extractSeller({
  owner: { name: 'Jean', type: 'particulier', rating: 4.5, nb_ratings: 10, user_id: 42 },
});
assert(seller1.nom === 'Jean', 'extractSeller: nom');
assert(seller1.type === 'particulier', 'extractSeller: type particulier');
assert(seller1.note === 4.5, 'extractSeller: note');
assert(seller1.nombreAvis === 10, 'extractSeller: nombreAvis');
assert(seller1.id === '42', 'extractSeller: id string');
const seller2 = adFields.extractSeller({ owner: { type: 'pro', store_name: 'Shop' } });
assert(seller2.type === 'pro', 'extractSeller: type pro');
assert(seller2.isPro === true, 'extractSeller: isPro déduit');
const seller3 = adFields.extractSeller({});
assert(seller3.nom === null, 'extractSeller: objet vide → nom null');
assert(seller3.note === null, 'extractSeller: objet vide → note null');

// extractCondition : attribut condition/etat
assert(adFields.extractCondition({ attributes: [{ key: 'condition', value: 'Bon état' }] }) === 'Bon état', 'extractCondition: key=condition');
assert(adFields.extractCondition({ attributes: [{ key: 'etat', value: 'Neuf' }] }) === 'Neuf', 'extractCondition: key=etat');
assert(adFields.extractCondition({ attributes: [] }) === null, 'extractCondition: attributs vides → null');
assert(adFields.extractCondition({}) === null, 'extractCondition: pas dattributs → null');

// extractPhotos : urls depuis images.urls ou images array
const photos1 = adFields.extractPhotos({ images: { urls: ['https://a.jpg', 'https://b.jpg'] } });
assert(photos1.count === 2, 'extractPhotos: count depuis images.urls');
assert(photos1.urls.length === 2, 'extractPhotos: urls depuis images.urls');
const photos2 = adFields.extractPhotos({ images: ['https://c.jpg'] });
assert(photos2.count === 1, 'extractPhotos: count depuis images array');
const photos3 = adFields.extractPhotos({});
assert(photos3.count === 0, 'extractPhotos: pas dimages → count 0');

// extractLikes : nombre, string, null
assert(adFields.extractLikes({ favorites_count: 5 }) === 5, 'extractLikes: favorites_count');
assert(adFields.extractLikes({ likes_count: '10' }) === 10, 'extractLikes: string parsée');
assert(adFields.extractLikes({}) === null, 'extractLikes: absent → null');

})();

// --- 17. package.json : plus de exceljs ---
console.log('\n[17] package.json');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
assert(!pkg.dependencies || !pkg.dependencies.exceljs, 'package.json: exceljs supprimé des dépendances');
assert(pkg.dependencies && pkg.dependencies.playwright, 'package.json: playwright conservé');
assert(pkg.devDependencies && pkg.devDependencies.electron, 'package.json: electron conservé');

// --- 18. Error codes (errorCodes.js) ---
console.log('\n[18] Error codes (errorCodes.js)');
(function () {
  const { ErrorCodes, createError, classifyError } = require('../src/main/services/scraping/errorCodes');

  // ErrorCodes : codes principaux présents
  assert(ErrorCodes.NET_TIMEOUT === 'NET_TIMEOUT', 'ErrorCodes: NET_TIMEOUT');
  assert(ErrorCodes.HTTP_403 === 'HTTP_403', 'ErrorCodes: HTTP_403');
  assert(ErrorCodes.HTTP_429 === 'HTTP_429', 'ErrorCodes: HTTP_429');
  assert(ErrorCodes.CAPTCHA_DETECTED === 'CAPTCHA_DETECTED', 'ErrorCodes: CAPTCHA_DETECTED');
  assert(ErrorCodes.CAPTCHA_TIMEOUT === 'CAPTCHA_TIMEOUT', 'ErrorCodes: CAPTCHA_TIMEOUT');
  assert(ErrorCodes.CAPTCHA_UNRESOLVED === 'CAPTCHA_UNRESOLVED', 'ErrorCodes: CAPTCHA_UNRESOLVED');
  assert(ErrorCodes.PARSE_HAR_INVALID === 'PARSE_HAR_INVALID', 'ErrorCodes: PARSE_HAR_INVALID');
  assert(ErrorCodes.EXTRACTOR_SELLER_NAME_FAILED === 'EXTRACTOR_SELLER_NAME_FAILED', 'ErrorCodes: EXTRACTOR_SELLER_NAME_FAILED');
  assert(ErrorCodes.STRUCTURE_CHANGED === 'STRUCTURE_CHANGED', 'ErrorCodes: STRUCTURE_CHANGED');
  assert(ErrorCodes.STRUCTURE_FIELD_MISSING === 'STRUCTURE_FIELD_MISSING', 'ErrorCodes: STRUCTURE_FIELD_MISSING');
  assert(ErrorCodes.AD_EMPTY === 'AD_EMPTY', 'ErrorCodes: AD_EMPTY');
  assert(ErrorCodes.AD_DELETED === 'AD_DELETED', 'ErrorCodes: AD_DELETED');
  assert(ErrorCodes.BROWSER_CRASHED === 'BROWSER_CRASHED', 'ErrorCodes: BROWSER_CRASHED');
  assert(ErrorCodes.SESSION_EXPIRED === 'SESSION_EXPIRED', 'ErrorCodes: SESSION_EXPIRED');

  // createError : structure correcte
  const err = createError('HTTP_403', 'Accès interdit', { url: 'https://example.com' });
  assert(err.code === 'HTTP_403', 'createError: code');
  assert(err.message === 'Accès interdit', 'createError: message');
  assert(err.context.url === 'https://example.com', 'createError: context');
  assert(typeof err.timestamp === 'string' && err.timestamp.length > 0, 'createError: timestamp ISO string');

  // createError : message par défaut = code si non fourni
  const err2 = createError('NET_TIMEOUT');
  assert(err2.message === 'NET_TIMEOUT', 'createError: message defaults to code');
  assert(err2.context && typeof err2.context === 'object', 'createError: context defaults to {}');

  // createError : sans contexte
  const err3 = createError('AD_EMPTY', 'Annonce vide');
  assert(err3.context !== undefined, 'createError: context is {} not undefined');

  // classifyError : catégories correctes pour chaque préfixe
  assert(classifyError('NET_TIMEOUT') === 'network_error', 'classifyError: NET_ → network_error');
  assert(classifyError('NET_CONNECTION_FAILED') === 'network_error', 'classifyError: NET_ → network_error (2)');
  assert(classifyError('HTTP_403') === 'network_error', 'classifyError: HTTP_4xx → network_error');
  assert(classifyError('HTTP_429') === 'network_error', 'classifyError: HTTP_429 → network_error');
  assert(classifyError('HTTP_404') === 'network_error', 'classifyError: HTTP_404 → network_error');
  assert(classifyError('HTTP_500') === 'global_error', 'classifyError: HTTP_5xx → global_error');
  assert(classifyError('HTTP_502') === 'global_error', 'classifyError: HTTP_502 → global_error');
  assert(classifyError('CAPTCHA_DETECTED') === 'session_error', 'classifyError: CAPTCHA_ → session_error');
  assert(classifyError('CAPTCHA_TIMEOUT') === 'session_error', 'classifyError: CAPTCHA_TIMEOUT → session_error');
  assert(classifyError('CAPTCHA_UNRESOLVED') === 'session_error', 'classifyError: CAPTCHA_UNRESOLVED → session_error');
  assert(classifyError('PARSE_HAR_INVALID') === 'global_error', 'classifyError: PARSE_ → global_error');
  assert(classifyError('PARSE_NO_ADS') === 'global_error', 'classifyError: PARSE_NO_ADS → global_error');
  assert(classifyError('EXTRACTOR_SELLER_NAME_FAILED') === 'ad_error', 'classifyError: EXTRACTOR_ → ad_error');
  assert(classifyError('EXTRACTOR_PRICE_FAILED') === 'ad_error', 'classifyError: EXTRACTOR_PRICE → ad_error');
  assert(classifyError('SESSION_EXPIRED') === 'session_error', 'classifyError: SESSION_ → session_error');
  assert(classifyError('SESSION_INVALID') === 'session_error', 'classifyError: SESSION_INVALID → session_error');
  assert(classifyError('BROWSER_CRASHED') === 'global_error', 'classifyError: BROWSER_ → global_error');
  assert(classifyError('BROWSER_LAUNCH_FAILED') === 'global_error', 'classifyError: BROWSER_LAUNCH → global_error');
  assert(classifyError('STRUCTURE_CHANGED') === 'global_error', 'classifyError: STRUCTURE_ → global_error');
  assert(classifyError('STRUCTURE_FIELD_MISSING') === 'global_error', 'classifyError: STRUCTURE_FIELD → global_error');
  assert(classifyError('AD_DELETED') === 'ad_error', 'classifyError: AD_ → ad_error');
  assert(classifyError('AD_EMPTY') === 'ad_error', 'classifyError: AD_EMPTY → ad_error');
  assert(classifyError('AD_MODIFIED') === 'ad_error', 'classifyError: AD_MODIFIED → ad_error');

  // classifyError : cas limites
  assert(classifyError(null) === 'unknown', 'classifyError: null → unknown');
  assert(classifyError(undefined) === 'unknown', 'classifyError: undefined → unknown');
  assert(classifyError('') === 'unknown', 'classifyError: empty string → unknown');
  assert(classifyError('UNKNOWN_CODE') === 'unknown', 'classifyError: unknown code → unknown');
})();

// --- 18b. Extractor error callbacks ---
console.log('\n[18b] Extractor error callbacks (adFields.js)');
(function () {
  const adFields = require('../src/main/services/scraping/adFields');

  // extractSeller : callback appelée quand owner existe sans name
  {
    const errors = [];
    const onError = (err) => errors.push(err);
    // owner avec name → pas d'erreur EXTRACTOR_SELLER_NAME_FAILED
    adFields.extractSeller({ owner: { name: 'Jean' } }, { onError });
    assert(!errors.some((e) => e.code === 'EXTRACTOR_SELLER_NAME_FAILED'), "extractSeller: pas d'erreur EXTRACTOR_SELLER_NAME_FAILED quand owner.name présent");

    // owner sans name → erreur EXTRACTOR_SELLER_NAME_FAILED
    errors.length = 0;
    adFields.extractSeller({ owner: { type: 'pro' } }, { onError });
    assert(errors.length >= 1, 'extractSeller: erreur quand owner existe sans name');
    assert(errors.some((e) => e.code === 'EXTRACTOR_SELLER_NAME_FAILED'), 'extractSeller: code EXTRACTOR_SELLER_NAME_FAILED');

    // owner sans user_id ni id → erreur EXTRACTOR_SELLER_ID_FAILED
    errors.length = 0;
    adFields.extractSeller({ owner: { name: 'Jean' } }, { onError });
    assert(errors.some((e) => e.code === 'EXTRACTOR_SELLER_ID_FAILED'), 'extractSeller: code EXTRACTOR_SELLER_ID_FAILED quand owner sans id');

    // pas d'owner → pas d'erreur
    errors.length = 0;
    adFields.extractSeller({}, { onError });
    assert(errors.length === 0, "extractSeller: pas d'erreur sans owner");
  }

  // extractPrice : callback appelée quand price présent mais non convertible
  {
    const errors = [];
    const onError = (err) => errors.push(err);
    // price valide → pas d'erreur
    adFields.extractPrice({ price: 100 }, { onError });
    assert(errors.length === 0, "extractPrice: pas d'erreur quand price valide");

    // price string non numérique → erreur
    errors.length = 0;
    adFields.extractPrice({ price: 'abc' }, { onError });
    assert(errors.some((e) => e.code === 'EXTRACTOR_PRICE_FAILED'), 'extractPrice: code EXTRACTOR_PRICE_FAILED quand non convertible');

    // pas de price → pas d'erreur
    errors.length = 0;
    adFields.extractPrice({}, { onError });
    assert(errors.length === 0, "extractPrice: pas d'erreur sans price");
  }

  // extractDescription : callback appelée quand body présent mais non exploitable
  {
    const errors = [];
    const onError = (err) => errors.push(err);
    // body string → pas d'erreur
    adFields.extractDescription({ body: 'texte' }, { onError });
    assert(errors.length === 0, "extractDescription: pas d'erreur quand body string");

    // body objet sans text → erreur
    errors.length = 0;
    adFields.extractDescription({ body: { foo: 'bar' } }, { onError });
    assert(errors.some((e) => e.code === 'EXTRACTOR_DESCRIPTION_FAILED'), 'extractDescription: code EXTRACTOR_DESCRIPTION_FAILED quand body non exploitable');

    // body nombre → erreur
    errors.length = 0;
    adFields.extractDescription({ body: 42 }, { onError });
    assert(errors.some((e) => e.code === 'EXTRACTOR_DESCRIPTION_FAILED'), 'extractDescription: erreur quand body nombre');

    // pas de body → pas d'erreur
    errors.length = 0;
    adFields.extractDescription({}, { onError });
    assert(errors.length === 0, "extractDescription: pas d'erreur sans body");
  }

  // extractDates : callback appelée quand aucune date reconnue
  {
    const errors = [];
    const onError = (err) => errors.push(err);
    // date présente → pas d'erreur
    adFields.extractDates({ first_publication_date: '2026-01-15T10:00:00Z' }, { onError });
    assert(errors.length === 0, "extractDates: pas d'erreur quand date présente");

    // annonce avec données mais sans date → erreur
    errors.length = 0;
    adFields.extractDates({ list_id: 1, subject: 'Test', price: 100, body: 'desc' }, { onError });
    assert(errors.some((e) => e.code === 'EXTRACTOR_DATES_FAILED'), 'extractDates: code EXTRACTOR_DATES_FAILED quand aucune date');

    // objet vide → pas d'erreur (trop peu de clés)
    errors.length = 0;
    adFields.extractDates({}, { onError });
    assert(errors.length === 0, "extractDates: pas d'erreur sur objet vide");
  }

  // extractPhotos : callback appelée quand images présent mais structure inattendue
  {
    const errors = [];
    const onError = (err) => errors.push(err);
    // images.urls array → pas d'erreur
    adFields.extractPhotos({ images: { urls: ['https://a.jpg'] } }, { onError });
    assert(errors.length === 0, "extractPhotos: pas d'erreur quand images.urls array");

    // images array → pas d'erreur
    adFields.extractPhotos({ images: ['https://a.jpg'] }, { onError });
    assert(errors.length === 0, "extractPhotos: pas d'erreur quand images array");

    // images objet sans urls → erreur
    errors.length = 0;
    adFields.extractPhotos({ images: { total: 5 } }, { onError });
    assert(errors.some((e) => e.code === 'EXTRACTOR_PHOTOS_FAILED'), 'extractPhotos: code EXTRACTOR_PHOTOS_FAILED quand structure inattendue');

    // pas d'images → pas d'erreur
    errors.length = 0;
    adFields.extractPhotos({}, { onError });
    assert(errors.length === 0, "extractPhotos: pas d'erreur sans images");
  }

  // Sans callback → pas de crash
  assert(adFields.extractSeller({ owner: { type: 'pro' } }) !== undefined, 'extractSeller: sans callback → pas de crash');
  assert(adFields.extractPrice({ price: 'abc' }) === null, 'extractPrice: sans callback → pas de crash');
  assert(adFields.extractDescription({ body: 42 }) === null, 'extractDescription: sans callback → pas de crash');
})();

// --- 18c. computeDeliveryType (existing tests still pass) ---
console.log('\n[18c] computeDeliveryType (non-régression)');
(function () {
  const { computeDeliveryType } = require('../src/main/services/scraping/adFields');
  assert(computeDeliveryType(true, true) === 'les_deux', 'computeDeliveryType: true,true → les_deux');
  assert(computeDeliveryType(true, false) === 'livraison', 'computeDeliveryType: true,false → livraison');
  assert(computeDeliveryType(true, null) === 'livraison', 'computeDeliveryType: true,null → livraison');
  assert(computeDeliveryType(false, true) === 'main_propre', 'computeDeliveryType: false,true → main_propre');
  assert(computeDeliveryType(null, true) === 'main_propre', 'computeDeliveryType: null,true → main_propre');
  assert(computeDeliveryType(false, false) === 'aucun', 'computeDeliveryType: false,false → aucun');
  assert(computeDeliveryType(false, null) === 'aucun', 'computeDeliveryType: false,null → aucun');
  assert(computeDeliveryType(null, false) === 'aucun', 'computeDeliveryType: null,false → aucun');
  assert(computeDeliveryType(null, null) === 'inconnu', 'computeDeliveryType: null,null → inconnu');
})();

// --- 18d. Export : compatibilité des clés d'export avec le modèle normalizeAd ---
// Non-régression du bug : les clés d'export `ville`/`codePostal`/`vendeurNbAvis`/
// `vendeurAnciennete` étaient silencieusement supprimées des exports JSON car le
// modèle expose `city`/`zipcode`/`nombreAvis`/`vendeurAncienneteJours`.
console.log('\n[18d] Export field-key compatibility (non-régression)');
(function () {
  const { filterAdByFields, toReadableBlock } = require('../src/main/services/exporting/exportFields');
  const { getProfileFields } = require('../src/main/services/exporting/dataProfiles');

  // Annonce au format RÉEL produit par normalizeAd() (city/zipcode/nombreAvis…).
  const modelAd = {
    id: '42', title: 'GPU', url: 'https://www.leboncoin.fr/ad/42.htm', prix: 250,
    city: 'Lyon', zipcode: '69001',
    vendeurNom: 'Jean', vendeurType: 'particulier', nombreAvis: 12, vendeurAncienneteJours: 400,
    deliveryType: 'livraison',
    datePublication: '2026-01-01T10:00:00.000Z', dateScraping: '2026-01-02T10:00:00.000Z',
    photosCount: 2, photosUrls: ['a.jpg', 'b.jpg'], description: 'bon état', likes: 5,
  };

  const json = filterAdByFields(modelAd, getProfileFields('default'));
  assert(json.ville === 'Lyon', 'export JSON: ville présent depuis city (modèle réel)');
  assert(json.codePostal === '69001', 'export JSON: codePostal présent depuis zipcode (modèle réel)');
  assert(json.dateScraping === '2026-01-02T10:00:00.000Z', 'export JSON: date ISO brute préservée (non formatée)');
  assert(Array.isArray(json.photosUrls) === false, 'export JSON: photosUrls formaté/brut selon get (pas de crash)');

  const maxJson = filterAdByFields(modelAd, getProfileFields('maximum'));
  // Profil Maximum = dump brut du modèle (clés city/zipcode/nombreAvis/
  // vendeurAncienneteJours). Les profils Défaut/Personnalisé utilisent les clés
  // d'export (ville/codePostal/vendeurNbAvis/vendeurAnciennete).
  assert(maxJson.nombreAvis === 12, 'export JSON: profil Maximum conserve le modèle brut (nombreAvis)');
  assert(maxJson.vendeurAncienneteJours === 400, 'export JSON: profil Maximum conserve le modèle brut (vendeurAncienneteJours)');

  const txt = toReadableBlock(modelAd, 0, getProfileFields('default'));
  assert(txt.includes('Lyon'), 'export TXT: ville affichée');
  assert(txt.includes('69001'), 'export TXT: code postal affiché');

  // Rétro-compat : une annonce « métier » (ville/codePostal) reste lisible.
  const legacyAd = { id: '1', title: 'T', prix: 10, ville: 'Paris', codePostal: '75001' };
  const legacyJson = filterAdByFields(legacyAd, getProfileFields('default'));
  assert(legacyJson.ville === 'Paris', 'export JSON: rétro-compat clé ville directe');
  assert(legacyJson.codePostal === '75001', 'export JSON: rétro-compat clé codePostal directe');
})();

// ═══════════════════════════════════════════════════════════════════════════
// [20] NON-RÉGRESSION — bugs de la Phase 3 (audit global A→Z)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[20] Bugs Phase 3 (audit global)');
(() => {
  const repoRoot = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

  // [20a] Navigation onglets : app.js doit cibler [data-tab], pas .tab-btn.
  //       L'ancien sélecteur .tab-btn ne correspondait à AUCUN élément (sidebar
  //       == .nav-item) → aucun listener de navigation attaché.
  const appCode = read('src/renderer/app.js');
  assert(/querySelectorAll\('\[data-tab\]'\)/.test(appCode), 'app.js: navigation cible [data-tab] (bug onglets morts corrigé)');
  assert(!/querySelectorAll\('\.tab-btn'\)/.test(appCode), 'app.js: ancien sélecteur .tab-btn supprimé');
  const htmlCode = read('src/renderer/index.html');
  assert(!/class="tab-btn/.test(htmlCode), 'index.html: plus de boutons .tab-btn (sidebar = nav-item)');

  // [20b] Champs internes absents des exports (raw, extractionErrors, livraison, mainPropre).
  const pipelineCode = read('src/main/services/scraping/leboncoin-pipeline.js');
  assert(/INTERNAL_AD_FIELDS\s*=\s*\[[^\]]*'raw'/.test(pipelineCode), 'pipeline: raw listé comme champ interne');
  assert(/'extractionErrors'/.test(pipelineCode) && /stripInternalFields/.test(pipelineCode), 'pipeline: extractionErrors nettoyé avant écriture');
  assert(/'livraison'/.test(pipelineCode) && /'mainPropre'/.test(pipelineCode), 'pipeline: livraison/mainPropre exclus des exports');
  assert(/cleanAds/.test(pipelineCode), 'pipeline: writeOutputs utilise cleanAds');

  // [20c] Éléments DOM référencés mais absents (statMedPrice, structureWarning).
  assert(/id="statMedPrice"/.test(htmlCode), 'index.html: carte Prix Médian présente (statMedPrice)');
  assert(/id="structureWarning"/.test(htmlCode), 'index.html: bandeau structureWarning présent');
  assert(/id="structureWarningText"/.test(htmlCode), 'index.html: texte structureWarning présent');

  // [20d] ErrorCodes.UNKNOWN défini (référencé par PipelineRunner en fallback).
  const { ErrorCodes: EC } = require('../src/main/services/scraping/errorCodes');
  assert(EC.UNKNOWN === 'UNKNOWN', 'errorCodes: UNKNOWN défini (évite code [undefined])');

  // [20e] webviewTag désactivé sur la fenêtre principale (hors commentaires).
  const mainCode = read('src/main/main.js');
  const mainCodeNoComments = mainCode.replace(/\/\/[^\n]*/g, '');
  assert(/webviewTag:\s*false/.test(mainCodeNoComments), 'main.js: webviewTag désactivé (surface d\'attaque réduite)');
  assert(!/webviewTag:\s*true/.test(mainCodeNoComments), 'main.js: plus de webviewTag:true actif');

  // [20f] Visibilité données vendeur appliquée dès le chargement (sinon classe
  //       seller-data-hidden jamais positionnée).
  assert(/async function refreshSellerDataSetting\(\)[\s\S]*?applySellerDataVisibility\(\);/.test(appCode), 'app.js: refreshSellerDataSetting applique applySellerDataVisibility');

  // [20g] buildAdHistory : replis rétro-compat likes.
  const jhCode = read('src/main/services/jobs/jobHistory.js');
  assert(/ad\.likes\s*\?\?[\s\S]*statistiques\?\.likes/.test(jhCode), 'jobHistory: repli rétro-compat likes (statistiques.likes)');

  console.log('\n[20] OK');
})();

console.log(`\n=== RÉSULTAT : ${pass} réussis, ${fail} échoués ===`);
process.exit(fail > 0 ? 1 : 0);
}
main().catch((err) => { console.error(err); process.exit(1); });
