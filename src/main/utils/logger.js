'use strict';

/**
 * Logger avec rotation quotidienne.
 *
 * Les logs sont écrits dans <BASE_OUT_DIR>/logs/scraper-YYYY-MM-DD.log
 * avec une rétention configurable (défaut : 7 jours).
 * Les messages sont aussi conservés sur la console (stdout/stderr).
 *
 * Le logger s'utilise via getLogger() qui renvoie { debug, info, warn, error }.
 * Il est conçu pour le main process (Node.js) et non le renderer.
 */

const fs = require('fs');
const path = require('path');

// `electron` est requis PARESSEUSEMENT : ce module doit rester importable par
// le serveur Web Node.js (Render), qui n'a pas d'`app` Electron. On tente le
// require au moment de résoudre le dossier de logs, pas à l'import.
function _electronApp() {
  try { return require('electron').app || null; } catch { return null; }
}

const DEFAULT_RETENTION_DAYS = 7;
const LOG_DIR_DEV = path.join(process.cwd(), 'output', 'logs');

let _logDir = null;
let _retentionDays = DEFAULT_RETENTION_DAYS;
let _currentDate = '';
let _stream = null;

function _getLogDir() {
  if (_logDir) return _logDir;
  // Priorité à la surcharge explicite (serveur Web : LBC_BASE_OUT_DIR).
  if (process.env.LBC_BASE_OUT_DIR) {
    _logDir = path.join(process.env.LBC_BASE_OUT_DIR, 'logs');
    return _logDir;
  }
  // En version packagée, les logs vont dans le dossier utilisateur (Documents).
  // En dev, ils vont dans ./output/logs — comme les jobs et les secrets
  // (constants.js BASE_OUT_DIR, secretStore) — et NON dans Documents, ce qui
  // éparpillait les artefacts de dev hors du projet.
  try {
    const app = _electronApp();
    const base = app && app.isPackaged
      ? path.join(app.getPath('documents'), 'Leboncoin Scraper Pro')
      : null;
    _logDir = base ? path.join(base, 'logs') : LOG_DIR_DEV;
  } catch {
    _logDir = LOG_DIR_DEV;
  }
  return _logDir;
}

function _todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function _ensureStream() {
  const today = _todayStr();
  if (_stream && _currentDate === today) return _stream;

  // Changement de jour : on ferme l'ancien flux et purge les vieux logs
  if (_stream) {
    try { _stream.end(); } catch { /* ignore */ }
    _stream = null;
  }

  const dir = _getLogDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch { /* ignore */ }

  const logPath = path.join(dir, `scraper-${today}.log`);
  _stream = fs.createWriteStream(logPath, { flags: 'a' });
  _currentDate = today;

  _stream.on('error', (err) => {
    console.error(`[Logger] Erreur écriture log ${logPath} : ${err.message}`);
    _stream = null;
  });

  // Purge asynchrone des vieux logs (une fois par jour)
  _purgeOldLogs(dir);

  return _stream;
}

function _purgeOldLogs(dir) {
  try {
    const now = Date.now();
    const maxAgeMs = _retentionDays * 24 * 60 * 60 * 1000;
    const entries = fs.readdirSync(dir);
    let purged = 0;
    for (const name of entries) {
      if (!/^scraper-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const fullPath = path.join(dir, name);
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(fullPath);
        purged++;
      }
    }
    if (purged > 0) console.log(`[Logger] ${purged} fichier(s) de log purge(s) (>${_retentionDays}j).`);
  } catch { /* ignore */ }
}

function _formatLine(level, msg) {
  const ts = new Date().toISOString();
  return `[${ts}] [${level}] ${typeof msg === 'string' ? msg : safeStringify(msg)}\n`;
}

function safeStringify(obj) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}

function _write(level, msg) {
  // Console (toujours)
  const line = _formatLine(level, msg);
  if (level === 'ERROR') console.error(line.trimEnd());
  else if (level === 'WARN') console.warn(line.trimEnd());
  else console.log(line.trimEnd());

  // Fichier (best-effort, ne plante jamais)
  try {
    const stream = _ensureStream();
    if (stream && stream.writable) stream.write(line);
  } catch { /* ignore */ }
}

const logger = {
  debug: (msg) => _write('DEBUG', msg),
  info: (msg) => _write('INFO', msg),
  warn: (msg) => _write('WARN', msg),
  error: (msg) => _write('ERROR', msg),

  /** Configure la rétention (en jours). */
  setRetention(days) {
    _retentionDays = Math.max(1, parseInt(days, 10) || DEFAULT_RETENTION_DAYS);
  },

  /** Renvoie le dossier des logs. */
  getLogDir() { return _getLogDir(); },

  /** Force la fermeture du flux courant (utile en fin d'app). */
  close() {
    if (_stream) { try { _stream.end(); } catch { /* ignore */ } _stream = null; }
  },
};

module.exports = { logger, getLogger: () => logger };
