'use strict';

console.log('--- DÉMARRAGE ELECTRON ---');

process.on('uncaughtException', (err) => {
  console.error('❌ ERREUR DANS MAIN PROCESS :', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ PROMESSE REJETÉE DANS MAIN PROCESS :', reason);
});

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');

// In a packaged app, Playwright's Chromium binary lives in extraResources/browsers/.
// Point PLAYWRIGHT_BROWSERS_PATH there so Playwright finds it at runtime.
if (process.env.NODE_ENV === 'production' || app.isPackaged) {
  const browsersPath = path.join(process.resourcesPath, 'browsers');
  if (fs.existsSync(browsersPath)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  }
}

const { logger } = require('./utils/logger');
logger.info('--- DÉMARRAGE ELECTRON ---');

let setupIpcHandlers;
try {
  ({ setupIpcHandlers } = require('./core/ipcHandlers'));
  console.log('✅ ipcHandlers chargé avec succès.');
} catch (err) {
  console.error('❌ Erreur de chargement de ipcHandlers :', err);
}

let mainWindow;
let widgetWindow = null;

// Getter de la fenêtre principale (pour ipcHandlers) : renvoie null si fermée.
function getMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function createWidgetWindow() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.focus();
    return;
  }

  widgetWindow = new BrowserWindow({
    width: 220,
    height: 160,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: false,
    title: 'Widget Scraper',
    webPreferences: {
      preload: path.join(__dirname, 'widgetPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  widgetWindow.loadFile(path.join(__dirname, '../renderer/widget.html'));

  // Le widget est une page locale figée : aucune navigation ni fenêtre externe.
  widgetWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  widgetWindow.on('closed', () => {
    widgetWindow = null;
  });
}

// IPC pour le widget flottant
ipcMain.on('widget:toggle', () => {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.close();
  } else {
    createWidgetWindow();
  }
});

ipcMain.on('widget:close', () => {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.close();
  }
});

// Envoie les mises à jour de progression/statut au widget flottant
function sendToWidget(channel, data) {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send(channel, data);
  }
}

ipcMain.on('widget:progress', (event, data) => sendToWidget('widget:progress', data));
ipcMain.on('widget:status', (event, data) => sendToWidget('widget:status', data));

function createWindow() {
  console.log('Création de la fenêtre Electron...');

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 650,
    title: 'Leboncoin Scraper Pro',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // webviewTag désactivé : aucun <webview> n'est utilisé par l'UI (l'ancien
      // module IA Studio, seul consommateur, a été retiré). Laisser ce tag actif
      // augmentait inutilement la surface d'attaque (création de webview depuis
      // le renderer). Le handler will-attach-webview reste en défense en
      // profondeur au cas où il serait réactivé.
      webviewTag: false,
    },
  });

  const indexPath = path.join(__dirname, '../renderer/index.html');
  console.log('Chargement du fichier HTML :', indexPath);

  mainWindow.loadFile(indexPath).catch((err) => {
    console.error('❌ Impossible de charger index.html :', err);
  });

  // Durcissement navigation : l'UI est une page locale unique. Toute tentative
  // d'ouverture de fenêtre (window.open / target=_blank) ou de navigation vers
  // une autre origine est refusée. Les liens externes passent exclusivement par
  // shell:openExternal (validé http/https). Sans cela, un lien injecté (ex: dans
  // une description d'annonce) pourrait charger une page distante dans la fenêtre
  // privilégiée (nodeIntegration=false, mais accès à window.api).
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    const allowed = path.join(__dirname, '../renderer/index.html');
    if (navigationUrl.split('#')[0] !== `file://${allowed}`) {
      event.preventDefault();
      console.warn(`[security] Navigation bloquée : ${navigationUrl}`);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Single-instance lock : empêche plusieurs instances concurrentes (qui se
// battraient pour la session globale et les fichiers de job).
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  console.log('Une autre instance est déjà en cours — fermeture.');
  app.quit();
} else {
  app.on('second-instance', () => {
    // L'utilisateur a relancé l'app : focus sur la fenêtre existante.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  console.log('✅ Electron app ready !');
  // Enregistre les handlers IPC UNE SEULE FOIS (évite "second handler" au
  // recréation de fenêtre). Le getter permet de toujours cibler la fenêtre
  // courante même après recréation.
  if (setupIpcHandlers) {
    const { shutdown } = setupIpcHandlers(getMainWindow);
    // Arrêt propre des jobs en cours à la fermeture (sinon le pipeline forké
    // et son Chromium continuaient en arrière-plan, orphelins du main).
    app.on('before-quit', () => {
      try { shutdown(); } catch { /* best-effort */ }
    });
  }
  createWindow();
}).catch((err) => {
  console.error('❌ Erreur app.whenReady :', err);
});

app.on('window-all-closed', () => {
  console.log('Toutes les fenêtres sont fermées.');
  if (process.platform !== 'darwin') app.quit();
});

// macOS : recrée une fenêtre quand on clique sur l'icône du dock et qu'aucune
// fenêtre n'est ouverte (comportement attendu sur Mac).
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Défense en profondeur pour les <webview>. webviewTag est DÉSACTIVÉ sur la
// fenêtre principale (aucun <webview> n'est utilisé), mais ce handler reste en
// place : s'il était un jour réactivé, un renderer compromis ne pourrait pas
// créer un <webview> avec nodeIntegration:true contournant le sandboxing. On
// force donc les webpreferences sûres sur TOUT webview attaché.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (_e, webPreferences, params) => {
    // Tout preload non autorisé est supprimé (sécurité : un renderer
    // compromis ne peut pas injecter son propre preload).
    delete webPreferences.preload;
    webPreferences.contextIsolation = true;
    // Verrouille systématiquement : pas de Node.js dans le webview.
    webPreferences.nodeIntegration = false;
    webPreferences.webSecurity = true;
    webPreferences.sandbox = true;
    // Isole chaque webview dans sa propre session (pas d'accès
    // au cache/cookies app).
    if (!params.partition || params.partition === 'persist:default') {
      webPreferences.partition = 'webview-sandbox';
    }
  });
});