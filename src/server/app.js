'use strict';

/**
 * Fabrique de l'application Express (réutilisable par index.js et les tests).
 *
 * N'importe PAS `electron`. Monte :
 *   - le durcissement des en-têtes (CSP, anti-sniff, frame-options) ;
 *   - le parseur JSON borné (limite de taille de requête) ;
 *   - l'API REST/SSE (/api) ;
 *   - les fichiers statiques du frontend Web (src/renderer).
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');
const { openDatabase, Repository } = require('./db');
const { JobEvents } = require('./logBus');
const { JobManager } = require('./jobManager');
const { requireAuth } = require('./auth');
const { createApiRouter } = require('./routes/api');

/**
 * Construit l'application + ses dépendances.
 * @param {object} [overrides] options de test (dbPath, config partielle…)
 */
function buildApp(overrides = {}) {
  const cfg = { ...config, ...(overrides.config || {}) };
  const dbPath = overrides.dbPath || cfg.dbPath;
  const db = openDatabase(dbPath);
  const repo = new Repository(db);
  repo.purgeExpiredSessions();

  const events = new JobEvents();
  const manager = new JobManager({ repo, config: cfg, events });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render place un proxy devant l'app.

  // Durcissement des en-têtes.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    // CSP : aucune source externe en script ; images (photos d'annonces, tuiles
    // OSM) et connexions (géocodage gouv, OSM) autorisées en https.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https: http:; font-src 'self' data:; " +
      "connect-src 'self' https:; frame-src 'self'; object-src 'none'; base-uri 'self';"
    );
    next();
  });

  // Parseur JSON borné (limite de taille de requête).
  app.use(express.json({ limit: cfg.maxBodyBytes }));

  const auth = requireAuth(repo, cfg);
  app.use('/api', createApiRouter({ repo, manager, config: cfg, requireAuth: auth }));

  // Frontend statique (interface Web). Le HTML principal est index.html.
  const rendererDir = path.join(__dirname, '..', 'renderer');
  app.use(express.static(rendererDir, { index: false, extensions: ['html'] }));

  // SPA : toute route non-API renvoie index.html.
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(rendererDir, 'index.html'));
  });

  // Gestion d'erreurs : ne divulgue jamais de secret/stack.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Requête trop volumineuse.' });
    }
    console.error('[server] Erreur non gérée :', err && err.message);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  });

  return { app, repo, manager, db, config: cfg, events };
}

module.exports = { buildApp };
