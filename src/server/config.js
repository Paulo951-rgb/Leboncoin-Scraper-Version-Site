'use strict';

/**
 * Configuration centralisée du serveur Web (Render-friendly).
 *
 * Toutes les valeurs sensibles ou dépendantes de l'environnement viennent de
 * variables d'environnement. Aucun secret n'est présent en dur ni exposé au
 * frontend (cf. README / docs/WEB_DEPLOYMENT.md).
 *
 * IMPORTANT : ce module ne requiert PAS `electron` et n'utilise PAS le dépôt
 * comme stockage durable. Le stockage vit sous LBC_BASE_OUT_DIR (monté sur un
 * disque persistant Render) ; la base SQLite vit sous LBC_DB_PATH.
 */

const path = require('path');
const fs = require('fs');

const isProd = process.env.NODE_ENV === 'production';

// Dossier de stockage : par défaut ./output (dev) ; en production Render on
// monte un disque persistant et on pointe LBC_BASE_OUT_DIR dessus.
const BASE_OUT_DIR = process.env.LBC_BASE_OUT_DIR
  ? path.resolve(process.env.LBC_BASE_OUT_DIR)
  : path.join(process.cwd(), 'output');

const DATA_DIR = path.join(BASE_OUT_DIR, 'web');

function _int(name, def, min, max) {
  const n = parseInt(process.env[name], 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

const config = {
  isProd,
  port: _int('PORT', 3000, 0, 65535),
  host: process.env.HOST || '0.0.0.0',

  // Stockage
  baseOutDir: BASE_OUT_DIR,
  dataDir: DATA_DIR,
  dbPath: process.env.LBC_DB_PATH
    ? path.resolve(process.env.LBC_DB_PATH)
    : path.join(DATA_DIR, 'app.db'),
  // Session Playwright globale : par utilisateur sous <baseOutDir>/web/sessions.
  sessionsDir: path.join(DATA_DIR, 'sessions'),
  jobsRootDir: path.join(DATA_DIR, 'jobs'),
  tmpDir: path.join(DATA_DIR, 'tmp'),
  logsDir: path.join(DATA_DIR, 'logs'),

  // Auth
  authEnabled: process.env.LBC_AUTH_DISABLED !== '1',
  // Secret de signature des sessions. DOIT être fourni en production. En dev,
  // un secret éphémère est généré (les sessions ne survivent pas au redémarrage).
  sessionSecret: process.env.LBC_SESSION_SECRET || null,
  sessionTtlMs: _int('LBC_SESSION_TTL_MS', 7 * 24 * 3600 * 1000, 60 * 1000, 90 * 24 * 3600 * 1000),
  allowSignup: process.env.LBC_ALLOW_SIGNUP !== '0',

  // Limites de ressources / sécurité
  maxJobsPerUser: _int('LBC_MAX_JOBS_PER_USER', 2, 1, 20),
  globalMaxConcurrency: _int('LBC_GLOBAL_CONCURRENCY', 2, 1, 10),
  maxPages: _int('LBC_MAX_PAGES', 50, 1, 500),
  maxAdsPerJob: _int('LBC_MAX_ADS', 5000, 1, 100000),
  jobTimeoutMs: _int('LBC_JOB_TIMEOUT_MS', 30 * 60 * 1000, 60 * 1000, 6 * 3600 * 1000),
  maxBodyBytes: _int('LBC_MAX_BODY_BYTES', 64 * 1024, 1024, 1024 * 1024),
  logBufferPerJob: _int('LBC_LOG_BUFFER', 3000, 100, 50000),
  // Rétention (jours) des jobs/logs/HAR. 0 = conservation illimitée.
  jobRetentionDays: _int('LBC_JOB_RETENTION_DAYS', 30, 0, 3650),
  harRetentionDays: _int('LBC_HAR_RETENTION_DAYS', 2, 0, 3650),

  // Scraping
  headless: process.env.LBC_HEADLESS !== '0',
  // Résolution manuelle CAPTCHA impossible en headless → état « action requise ».
  allowVisibleCaptcha: process.env.LBC_ALLOW_VISIBLE_CAPTCHA === '1',
  defaultSpeed: process.env.LBC_SPEED || 'moyen',
  defaultPageDelayMs: _int('LBC_PAGE_DELAY_MS', 1200, 0, 60000),

  // Domaines Leboncoin autorisés (allowlist stricte — anti-SSRF).
  allowedHosts: [
    'leboncoin.fr',
    'leboncoin.com',
    'leboncoindirect.com',
  ],
};

// Création des dossiers de stockage (idempotent).
for (const dir of [BASE_OUT_DIR, DATA_DIR, config.sessionsDir, config.jobsRootDir, config.tmpDir, config.logsDir]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
}

module.exports = config;
