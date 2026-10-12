'use strict';

/**
 * Routes REST + SSE de l'application Web.
 *
 * Contrat d'API (documenté dans README / docs/WEB_DEPLOYMENT.md) :
 *   GET    /api/health                      — état du service (public)
 *   POST   /api/auth/register               — création de compte
 *   POST   /api/auth/login                  — connexion (cookie de session)
 *   POST   /api/auth/logout                 — déconnexion
 *   GET    /api/auth/me                     — utilisateur courant
 *   GET    /api/config                      — réglages utilisateur
 *   POST   /api/config                      — enregistrer les réglages
 *   GET    /api/profiles                    — profils de données + champs
 *   POST   /api/jobs                        — créer une tâche
 *   GET    /api/jobs                        — lister ses tâches (paginé)
 *   GET    /api/jobs/:id                    — état d'une tâche
 *   GET    /api/jobs/:id/logs               — logs (after/limit)
 *   GET    /api/jobs/:id/events             — flux SSE (log + status)
 *   POST   /api/jobs/:id/cancel             — annuler
 *   GET    /api/jobs/:id/results            — annonces + statistiques
 *   DELETE /api/jobs/:id                    — supprimer
 *   GET    /api/jobs/:id/export/:format     — télécharger JSON/TXT
 *   GET    /api/jobs/:id/export-logs        — télécharger les logs
 *   GET    /api/history                     — historique agrégé (explorateur/stats)
 *   GET    /api/ad-history                  — évolution des annonces
 *   GET    /api/diagnostics                 — infos non sensibles
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const { validateJobConfig, sanitizeSettingsPatch, SETTINGS_DEFAULTS } = require('../security');
const { PROFILES, getProfileFields, DEFAULT_PROFILE_FIELDS } = require('../../main/services/exporting/dataProfiles');
const { FIELD_CATEGORIES } = require('../../main/services/exporting/exportFields');
const { readResults, statsFor, exportPaths } = require('../resultsService');
const { setSessionCookie, clearSessionCookie } = require('../auth');
const { buildAdHistory } = require('../../main/services/jobs/jobHistory');

const EXPORT_FIELD_LABELS = {
  id: 'ID', title: 'Titre', url: 'URL', prix: 'Prix', ville: 'Ville', codePostal: 'Code postal',
  vendeurNom: 'Vendeur (nom)', vendeurType: 'Vendeur (type)', vendeurId: 'Vendeur (ID)',
  vendeurNote: 'Vendeur (note)', vendeurNbAvis: 'Vendeur (nb avis)', vendeurUrlProfil: 'Vendeur (URL profil)',
  vendeurAnciennete: 'Vendeur (ancienneté)', deliveryType: 'Type de remise', likes: 'Likes',
  datePublication: 'Date publication', dateModification: 'Date modification', dateScraping: 'Date scraping',
  etat: 'État déclaré', photosCount: 'Nombre de photos', photosUrls: 'URLs des photos', description: 'Description',
};

function pagination(query, maxLimit) {
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(query.offset, 10) || 0);
  return { limit, offset };
}

function createApiRouter({ repo, manager, config, requireAuth }) {
  const router = express.Router();

  // ─── Santé (public) ───────────────────────────────────────────────────────
  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      service: 'leboncoin-scraper-web',
      version: require('../../../package.json').version,
      authEnabled: config.authEnabled,
      activeJobs: repo.countActiveJobs(),
      concurrency: config.globalMaxConcurrency,
      uptimeSec: Math.round(process.uptime()),
    });
  });

  // ─── Authentification ─────────────────────────────────────────────────────
  router.post('/auth/register', (req, res) => {
    if (!config.authEnabled) return res.status(400).json({ error: 'Inscription désactivée.' });
    if (!config.allowSignup) return res.status(403).json({ error: 'Inscription désactivée.' });
    const email = String(req.body && req.body.email || '').trim().toLowerCase();
    const password = String(req.body && req.body.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
      return res.status(400).json({ error: 'Email invalide.' });
    }
    if (password.length < 8 || password.length > 200) {
      return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum.' });
    }
    if (repo.getUserByEmail(email)) return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
    const user = repo.createUser(email, password);
    const token = repo.createSession(user.id, config.sessionTtlMs);
    setSessionCookie(res, token, config.sessionTtlMs, config.isProd);
    res.status(201).json({ user: { id: user.id, email: user.email } });
  });

  router.post('/auth/login', (req, res) => {
    if (!config.authEnabled) return res.status(400).json({ error: 'Authentification désactivée.' });
    const email = String(req.body && req.body.email || '').trim();
    const password = String(req.body && req.body.password || '');
    const user = repo.verifyUser(email, password);
    if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
    const token = repo.createSession(user.id, config.sessionTtlMs);
    setSessionCookie(res, token, config.sessionTtlMs, config.isProd);
    res.json({ user });
  });

  router.post('/auth/logout', requireAuth, (req, res) => {
    if (req.sessionToken) repo.deleteSession(req.sessionToken);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  // ─── Réglages ─────────────────────────────────────────────────────────────
  router.get('/config', requireAuth, (req, res) => {
    const saved = repo.getSettings(req.user.id) || {};
    res.json({ ...SETTINGS_DEFAULTS, ...saved });
  });

  router.post('/config', requireAuth, (req, res) => {
    const clean = sanitizeSettingsPatch(req.body);
    const merged = { ...SETTINGS_DEFAULTS, ...(repo.getSettings(req.user.id) || {}), ...clean };
    repo.saveSettings(req.user.id, merged);
    res.json(merged);
  });

  // ─── Profils de données ───────────────────────────────────────────────────
  router.get('/profiles', requireAuth, (req, res) => {
    res.json({
      profiles: [
        { id: 'default', label: PROFILES.default.label, description: PROFILES.default.description },
        { id: 'maximum', label: PROFILES.maximum.label, description: PROFILES.maximum.description },
        { id: 'custom', label: PROFILES.custom.label, description: PROFILES.custom.description },
      ],
      defaultFields: DEFAULT_PROFILE_FIELDS,
      categories: FIELD_CATEGORIES,
      fields: Object.entries(EXPORT_FIELD_LABELS).map(([key, label]) => ({ key, label })),
    });
  });

  // ─── Tâches ───────────────────────────────────────────────────────────────
  router.post('/jobs', requireAuth, (req, res) => {
    const v = validateJobConfig(req.body, {
      allowedHosts: config.allowedHosts,
      maxPages: config.maxPages,
      maxAds: config.maxAdsPerJob,
      defaultSpeed: config.defaultSpeed,
    });
    if (!v.ok) return res.status(400).json({ error: v.error });
    try {
      const job = manager.createJob(req.user.id, v.value);
      res.status(201).json({ job: manager.getJobView(job) });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  router.get('/jobs', requireAuth, (req, res) => {
    const { limit, offset } = pagination(req.query, 100);
    const jobs = repo.listJobsForUser(req.user.id, limit, offset);
    res.json({
      jobs: jobs.map((j) => manager.getJobView(j)),
      total: repo.countJobsForUser(req.user.id),
      limit,
      offset,
    });
  });

  // Middleware de résolution + autorisation : un id seul ne suffit JAMAIS.
  function loadOwnedJob(req, res, next) {
    const job = repo.getJobForUser(req.params.id, req.user.id);
    if (!job) return res.status(404).json({ error: 'Tâche introuvable.' });
    req.job = job;
    next();
  }

  router.get('/jobs/:id', requireAuth, loadOwnedJob, (req, res) => {
    res.json({ job: manager.getJobView(req.job) });
  });

  router.get('/jobs/:id/logs', requireAuth, loadOwnedJob, (req, res) => {
    const after = Math.max(0, parseInt(req.query.after, 10) || 0);
    const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 2000));
    const logs = repo.getLogs(req.job.id, after, limit);
    res.json({ logs });
  });

  // Flux temps réel (SSE) : rejoue les logs manquants puis diffuse.
  router.get('/jobs/:id/events', requireAuth, loadOwnedJob, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const jobId = req.job.id;
    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Rejoue les logs manquants si le client fournit `after`.
    const after = Math.max(0, parseInt(req.query.after, 10) || 0);
    for (const l of repo.getLogs(jobId, after, 2000)) {
      send('log', { id: l.id, level: l.level, message: l.message, ts: l.ts });
    }
    send('status', manager.getJobView(repo.getJob(jobId)));

    const unsubLog = manager.events.subscribe(jobId, 'log', (entry) => send('log', entry));
    const unsubStatus = manager.events.subscribe(jobId, 'status', (payload) => send('status', payload));
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 15000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubLog();
      unsubStatus();
      try { res.end(); } catch { /* noop */ }
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  });

  router.post('/jobs/:id/cancel', requireAuth, loadOwnedJob, (req, res) => {
    const ok = manager.cancel(req.job.id);
    res.json({ ok, job: manager.getJobView(repo.getJob(req.job.id)) });
  });

  router.get('/jobs/:id/results', requireAuth, loadOwnedJob, (req, res) => {
    const resultsDir = path.join(config.jobsRootDir, req.job.user_id, req.job.id, 'results');
    const { ads, valid, reason, meta } = readResults(resultsDir, req.job.include_seller_data !== 0);
    res.json({
      job: manager.getJobView(req.job),
      ads,
      stats: statsFor(ads),
      integrity: { valid, reason },
      exportMeta: meta,
    });
  });

  router.delete('/jobs/:id', requireAuth, loadOwnedJob, (req, res) => {
    // Annule d'abord si active (évite un processus orphelin).
    if (!['completed', 'partial', 'failed', 'cancelled', 'action_required'].includes(req.job.status)) {
      manager.cancel(req.job.id, 'suppression');
    }
    const jobDir = path.join(config.jobsRootDir, req.job.user_id, req.job.id);
    repo.deleteJob(req.job.id, req.user.id);
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    manager.events.close(req.job.id);
    res.json({ ok: true });
  });

  // ─── Téléchargements (réponses HTTP avec type + nom de fichier) ───────────
  router.get('/jobs/:id/export/:format', requireAuth, loadOwnedJob, (req, res) => {
    const format = req.params.format;
    if (format !== 'json' && format !== 'txt') return res.status(400).json({ error: 'Format non supporté (json|txt).' });
    const resultsDir = path.join(config.jobsRootDir, req.job.user_id, req.job.id, 'results');
    const paths = exportPaths(resultsDir);
    const filePath = format === 'json' ? paths.json : paths.txt;
    if (!filePath) return res.status(404).json({ error: 'Export indisponible pour cette tâche.' });
    const safeName = `annonces-${req.job.id}.${format}`;
    res.setHeader('Content-Type', format === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);

    // Défense en profondeur : si les données vendeur sont désactivées pour cette
    // tâche, on REGÉNÈRE le JSON filtré (garantit qu'aucune donnée vendeur ne
    // fuit, même si le fichier sur disque en contenait).
    if (format === 'json' && req.job.include_seller_data === 0) {
      const { ads } = readResults(resultsDir, false);
      return res.send(JSON.stringify(ads, null, 2));
    }
    fs.createReadStream(filePath).pipe(res);
  });

  router.get('/jobs/:id/export-logs', requireAuth, loadOwnedJob, (req, res) => {
    const logs = repo.getLogs(req.job.id, 0, config.logBufferPerJob);
    const text = logs.map((l) => `[${l.ts}] [${(l.level || 'info').toUpperCase()}] ${l.message}`).join('\n');
    const safeName = `logs-${req.job.id}.log`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.send(text);
  });

  // ─── Historique agrégé (explorateur + statistiques) ───────────────────────
  router.get('/history', requireAuth, (req, res) => {
    const jobs = repo.listJobsForUser(req.user.id, 200, 0);
    const out = [];
    for (const j of jobs) {
      if (j.status !== 'completed' && j.status !== 'partial') continue;
      const resultsDir = path.join(config.jobsRootDir, j.user_id, j.id, 'results');
      const { ads, valid, meta } = readResults(resultsDir, j.include_seller_data !== 0);
      out.push({
        id: j.id,
        date: j.created_at,
        status: j.status,
        adsCount: ads.length,
        stats: statsFor(ads),
        ads,
        integrityWarning: valid ? null : 'Résultats indisponibles ou corrompus',
        exportMeta: meta,
        files: { json: true, txt: true },
      });
    }
    res.json({ jobs: out });
  });

  router.get('/ad-history', requireAuth, (req, res) => {
    const jobs = repo.listJobsForUser(req.user.id, 200, 0);
    const full = [];
    for (const j of jobs) {
      if (j.status !== 'completed' && j.status !== 'partial') continue;
      const resultsDir = path.join(config.jobsRootDir, j.user_id, j.id, 'results');
      const { ads } = readResults(resultsDir, j.include_seller_data !== 0);
      full.push({ id: j.id, date: j.created_at, ads });
    }
    res.json({ adHistory: buildAdHistory(full) });
  });

  // ─── Diagnostics (non sensible) ───────────────────────────────────────────
  router.get('/diagnostics', requireAuth, (req, res) => {
    res.json({
      appVersion: require('../../../package.json').version,
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      osRelease: require('os').release(),
      timestamp: new Date().toISOString(),
      mode: config.isProd ? 'production' : 'development',
    });
  });

  return router;
}

module.exports = { createApiRouter, EXPORT_FIELD_LABELS };
