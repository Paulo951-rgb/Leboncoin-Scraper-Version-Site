'use strict';

const path = require('path');

function _electronApp() {
  try { return require('electron').app || null; } catch { return null; }
}

function resolveBaseOutDir() {
  if (process.env.LBC_BASE_OUT_DIR) return process.env.LBC_BASE_OUT_DIR;
  const app = _electronApp();
  const isPackaged = app ? app.isPackaged : false;
  return isPackaged
    ? path.join(app.getPath('documents'), 'Leboncoin Scraper Pro')
    : path.join(process.cwd(), 'output');
}

const BASE_OUT_DIR = resolveBaseOutDir();

// 🔑 Chemin unique pour la session globale (Master Session)
const GLOBAL_SESSION_PATH = path.join(BASE_OUT_DIR, 'global-session.json');

// 📁 Répertoires centralisés (cohérents en dev ET en version packagée .exe)
const JOBS_DIR = path.join(BASE_OUT_DIR, 'jobs');
// Note: les résultats de chaque job vont dans JOBS_DIR/job-<timestamp>/results
// (calculé dynamiquement par job dans ipcHandlers), il n'y a pas de RESULTS_DIR global.

module.exports = {
  APP_NAME: 'Leboncoin Scraper Pro',
  BASE_OUT_DIR,
  JOBS_DIR,
  // Note: les valeurs par défaut des réglages utilisateur (vitesse, headless,
  // délais, concurrence IA, rétention…) vivent dans core/settings.js
  // (SETTINGS_DEFAULTS). L'ancien bloc DEFAULTS ici était mort ET conflictuel
  // (headless:false ici vs headless:true dans settings) — supprimé pour éviter
  // toute confusion.
  THEMES: ['theme-dark', 'theme-light', 'theme-oled', 'theme-violet', 'theme-green', 'theme-sunset', 'theme-carbon', 'theme-rose', 'theme-amber', 'theme-mint', 'theme-slate', 'theme-crimson', 'theme-nordic'],
  GLOBAL_SESSION_PATH,
};