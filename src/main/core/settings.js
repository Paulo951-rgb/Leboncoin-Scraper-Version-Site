'use strict';

/**
 * Persistance légère des paramètres utilisateur (durée de rétention HAR, etc.).
 * Extrait d'ipcHandlers.js pour séparer la persistance (infrastructure de config)
 * du routage IPC (cœur applicatif).
 */
const path = require('path');
const fs = require('fs');
const { atomicWriteFileSync } = require('../utils/helpers');

let _settingsPath = null;
function getSettingsPath() {
  if (_settingsPath) return _settingsPath;
  let base;
  try {
    const { app } = require('electron');
    base = app.getPath('userData');
  } catch {
    base = path.join(process.cwd(), 'output');
  }
  _settingsPath = path.join(base, 'user-settings.json');
  return _settingsPath;
}
const SETTINGS_DEFAULTS = Object.freeze({
  autoCleanHarDays: 7,
  scrapeSpeed: 'moyen',      // 'moyen' | 'rapide' | 'ultra-rapide'
  pageDelayMs: 1000,        // délai entre les pages de recherche
  headless: true,           // navigateur invisible (sauf CAPTCHA)

  logRetentionDays: 7,      // rétention des logs rotatifs (jours)
  logLevel: 'debug',        // niveau minimal transmis au renderer : 'debug'|'info'|'warn'|'error'
  autoCleanJobsDays: 0,     // 0 = désactivé ; sinon nb de jours avant suppression auto des jobs
  includeSellerData: true,  // inclure les données vendeur dans les exports et l'interface
});

function loadSettings() {
  try {
    if (!fs.existsSync(getSettingsPath())) return { ...SETTINGS_DEFAULTS };
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'));
    return { ...SETTINGS_DEFAULTS, ...(data && typeof data === 'object' ? data : {}) };
  } catch (err) {
    console.warn('Lecture paramètres impossible :', err.message);
    return { ...SETTINGS_DEFAULTS };
  }
}

/**
 * Valide et normalise un patch de paramètres venant du renderer.
 * Ne conserve que les clés connues avec un type/une plage valides : un renderer
 * compromis (ou une valeur erronée) ne peut donc pas injecter de clés
 * arbitraires dans user-settings.json ni pousser `autoCleanJobsDays` à une
 * valeur absurde qui déclencherait une purge massive de jobs.
 * @param {Object} patch
 * @returns {Object} patch nettoyé
 */
function sanitizeSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object') return {};
  const out = {};
  const intInRange = (v, min, max) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
  };

  if ('autoCleanHarDays' in patch) {
    const n = intInRange(patch.autoCleanHarDays, 0, 3650);
    if (n !== undefined) out.autoCleanHarDays = n;
  }
  if ('logRetentionDays' in patch) {
    const n = intInRange(patch.logRetentionDays, 1, 3650);
    if (n !== undefined) out.logRetentionDays = n;
  }
  if ('logLevel' in patch) {
    if (['debug', 'info', 'warn', 'error'].includes(patch.logLevel)) out.logLevel = patch.logLevel;
  }
  if ('autoCleanJobsDays' in patch) {
    const n = intInRange(patch.autoCleanJobsDays, 0, 3650);
    if (n !== undefined) out.autoCleanJobsDays = n;
  }
  if ('pageDelayMs' in patch) {
    const n = intInRange(patch.pageDelayMs, 0, 60000);
    if (n !== undefined) out.pageDelayMs = n;
  }
  if ('scrapeSpeed' in patch) {
    if (['moyen', 'rapide', 'ultra-rapide'].includes(patch.scrapeSpeed)) out.scrapeSpeed = patch.scrapeSpeed;
  }
  if ('headless' in patch) {
    if (typeof patch.headless === 'boolean') out.headless = patch.headless;
  }
  if ('includeSellerData' in patch) {
    if (typeof patch.includeSellerData === 'boolean') out.includeSellerData = patch.includeSellerData;
  }
  return out;
}

function saveSettings(patch) {
  const merged = { ...loadSettings(), ...sanitizeSettingsPatch(patch) };
  try {
    fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
    // Écriture atomique : un crash pendant fs.writeFileSync laissait
    // user-settings.json tronqué → tous les réglages perdus au redémarrage.
    atomicWriteFileSync(getSettingsPath(), JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    console.warn('Sauvegarde paramètres impossible :', err.message);
  }
  return merged;
}

module.exports = { loadSettings, saveSettings, sanitizeSettingsPatch, SETTINGS_DEFAULTS };
