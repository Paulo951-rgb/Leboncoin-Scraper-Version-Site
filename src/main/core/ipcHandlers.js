'use strict';

const path = require('path');
const fs = require('fs');
const { ipcMain, shell, app } = require('electron');
const { HarCapturer } = require('../services/scraping/harCapturer');
const { PipelineRunner } = require('../services/scraping/pipelineRunner');
const { FileManager } = require('../infrastructure/fileManager');
const { JobHistoryManager } = require('../services/jobs/jobHistory');
const { StorageCleaner } = require('../services/maintenance/storageCleaner');
const { JOBS_DIR, BASE_OUT_DIR } = require('../config/constants');
const { summarizeAds, formatBytes, describeError } = require('../utils/diagnostics');
const { readWithChecksum } = require('../utils/integrity');
const { loadSettings, saveSettings } = require('./settings');
const { getProfileFields } = require('../services/exporting/dataProfiles');

function setupIpcHandlers(getMainWindow) {
  let activeCapturer = null;
  let activeRunner = null;
  let isRunning = false;

  // Token d'annulation partagé pour les tâches longues (scraping). Le bouton
  // « Arrêter » positionne activeCancel.cancelled = true ; la capture HAR et le
  // pipeline forké s'arrêtent proprement.
  let activeCancel = null;

  // Identifiant de corrélation du job courant : attaché à chaque log/statut pour
  // permettre de filtrer/regrouper les lignes d'un même run (utile quand
  // plusieurs sessions se succèdent dans la même console).
  let currentJobId = null;

  // Niveau de log minimal transmis au renderer (configurable). Le pipeline
  // continue de tout émettre ; on filtre au niveau du pont IPC pour éviter de
  // saturer la console avec des logs debug en production.
  const LOG_LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40 };
  let currentLogLevel = 'debug';
  const isLogVisible = (level) => (LOG_LEVEL_RANK[level] || 20) >= (LOG_LEVEL_RANK[currentLogLevel] || 10);

  // Getter de fenêtre principale : renvoie null si détruite/fermée,
  // évitant les crashes "Cannot read properties of null" sur webContents.send.
  const getWin = () => {
    const w = typeof getMainWindow === 'function' ? getMainWindow() : getMainWindow;
    return w && !w.isDestroyed() ? w : null;
  };

  // Arrêt forcé des opérations en cours (appelé sur before-quit) : stoppe le
  // pipeline forké (SIGINT → le fils ferme son Playwright et exit) et la
  // capture HAR (isCancelled → finally ferme le navigateur). Sans cela, fermer
  // l'app pendant un job laissait le processus fils (leboncoin-pipeline) et son
  // navigateur Chromium orphelins, continuant à tourner en arrière-plan.
  function shutdown() {
    try {
      if (activeCancel) activeCancel.cancelled = true;
    } catch { /* shutdown best-effort */ }
    try {
      if (activeRunner) activeRunner.stop();
    } catch { /* shutdown best-effort */ }
    try {
      if (activeCapturer) activeCapturer.stop();
    } catch { /* shutdown best-effort */ }
  }

  const settings = loadSettings();

  const { logger } = require('../utils/logger');
  logger.setRetention(settings.logRetentionDays || 7);
  currentLogLevel = settings.logLevel || 'debug';

  setTimeout(() => {
    StorageCleaner.cleanOldHars(settings.autoCleanHarDays || 7);
    if (settings.autoCleanJobsDays && settings.autoCleanJobsDays > 0) {
      const purged = StorageCleaner.cleanOldJobs(settings.autoCleanJobsDays);
      if (purged > 0) logger.info(`[startup] ${purged} job(s) ancien(s) supprimé(s) (>${settings.autoCleanJobsDays}j).`);
    }
  }, 3000);

  const sendLog = (data) => {
    if (!isLogVisible(data.level || 'info')) return;
    const w = getWin(); if (w) w.webContents.send('log', currentJobId ? { ...data, jobId: currentJobId } : data);
  };
  const sendProgress = (data) => { const w = getWin(); if (w) w.webContents.send('progress', data); };
  const sendStatus = (status) => { const w = getWin(); if (w) w.webContents.send('status', currentJobId ? { ...status, jobId: currentJobId } : status); };

  // ─── Suivi de session pour le résumé de fin de scraping ────────────────────
  // Les compteurs sont incrémentés au fil du job (via l'écoute des logs du
  // pipeline). À la fin, un résumé formaté est envoyé.
  function newSessionStats() {
    return {
      t0: 0, pagesRequested: 0, pagesScraped: 0,
      adsFound: 0, adsKept: 0, adsDuplicates: 0,
      descriptionsExtracted: 0, descriptionsBlocked: 0,
      errors: 0, warnings: 0, debugs: 0,
      stoppedEarly: false,
      // Blocage d'accès détecté pendant l'enrichissement (403/429) : permet de
      // rapporter un « succès partiel » honnête plutôt qu'un succès complet.
      accessBlocked: false, accessCode: null,
    };
  }
  let sessionStats = newSessionStats();

  function formatDuration(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  }

  function sendSessionSummary() {
    const dur = Math.round((Date.now() - sessionStats.t0) / 1000);
    const lines = [
      '',
      '═══════════════════════════════════════════════════════════',
      '📋 RÉSUMÉ DE SESSION',
      '═══════════════════════════════════════════════════════════',
      `  ⏱  Durée totale        : ${formatDuration(dur)}`,
      `  📄 Pages demandées      : ${sessionStats.pagesRequested}`,
      `  📄 Pages scrapées      : ${sessionStats.pagesScraped}`,
      `  🔍 Annonces extraites   : ${sessionStats.adsFound} (uniques)`,
      `  ✅ Annonces conservées  : ${sessionStats.adsKept}`,
      `  🔄 Doublons fusionnés   : ${sessionStats.adsDuplicates}`,
      `  📝 Descriptions extraites: ${sessionStats.descriptionsExtracted}`,
      `  🛑 Blocages d'accès     : ${sessionStats.descriptionsBlocked} (HTTP 403/429)`,
      `  ❌ Erreurs              : ${sessionStats.errors}`,
      `  ⚠️  Avertissements      : ${sessionStats.warnings}`,
      `  🐛 Logs debug           : ${sessionStats.debugs}`,
      sessionStats.stoppedEarly ? '  ⚠️  Terminé en avance (interruption IP/CAPTCHA)' : '  ✅ Terminé normalement',
      '═══════════════════════════════════════════════════════════',
    ];
    for (const line of lines) {
      sendLog({ level: 'info', message: line });
    }
  }

  ipcMain.on('job:start', async (event, config) => {
    if (isRunning) {
      sendLog({ level: 'warn', message: '[job:start] Un job est déjà en cours — requête ignorée.' });
      return;
    }
    isRunning = true;
    // Nouveau token d'annulation pour ce job (bouton « Arrêter »). Réinitialisé
    // à chaque job : un clic Arrêter n'affecte QUE le job en cours.
    activeCancel = { cancelled: false };
    sessionStats = newSessionStats();
    sessionStats.t0 = Date.now();
    sessionStats.pagesRequested = parseInt(config.pages, 10) || 1;

    const { searchUrl, pages = 1, noDesc = false, limit, proxyUrl, profileId, exportFields } = config;
    // Résolution du profil de données (Défaut / Maximum / Personnalisé) en une
    // liste concrète de clés de champs. Le pipeline reçoit `profileFields` qu'il
    // applique aux exports JSON et TXT.
    const resolvedProfileId = (profileId === 'maximum' || profileId === 'custom') ? profileId : 'default';
    const profileFields = getProfileFields(resolvedProfileId, exportFields);
    if (resolvedProfileId === 'custom' && (!profileFields || profileFields.length === 0)) {
      // Mode custom demandé mais aucun champ valide fourni : getProfileFields a
      // déjà appliqué un fallback sur les champs essentiels. On log un
      // avertissement pour aider l'utilisateur à comprendre ce qu'il a choisi.
      sendLog({ level: 'warn', message: '[job:start] Profil Personnalisé actif mais aucun champ valide sélectionné — fallback sur les champs essentiels.' });
    }
    const userSettings = loadSettings();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jobDir = path.join(JOBS_DIR, `job-${timestamp}`);
    const harPath = path.join(jobDir, 'capture.har');
    const resultsDir = path.join(jobDir, 'results');
    currentJobId = `job-${timestamp}`;

    sendLog({ level: 'debug', message: `[job:start] Config reçue — searchUrl=${searchUrl} | pages=${pages} | noDesc=${noDesc} | limit=${limit ?? '(aucun)'} | proxy=${proxyUrl || 'aucun'}` });
    sendLog({ level: 'debug', message: `[job:start] Dossiers — jobDir=${jobDir} | harPath=${harPath} | resultsDir=${resultsDir}` });

    let stoppedEarly = false;

    try {
      sendStatus({ state: 'capturing', message: 'Capture HAR automatique en cours...' });
      sendLog({ level: 'info', message: '--- DÉMARRAGE DU SCRAPING ---' });
      const t0Total = Date.now();

      // Le HarCapturer gère lui-même la bascule headless/visible (pré-check captcha).
      const pageDelay = parseInt(userSettings.pageDelayMs, 10) || 1000;
      activeCapturer = new HarCapturer({
        proxyUrl,
        headless: userSettings.headless !== false,
        minPageDelayMs: pageDelay,
        maxPageDelayMs: pageDelay + 700,
      });
      sendLog({ level: 'debug', message: `[job:start] Vitesse=${userSettings.scrapeSpeed} | headless=${userSettings.headless !== false} | délai pages=${pageDelay}ms` });

      activeCapturer.on('log', sendLog);
      activeCapturer.on('progress', ({ currentPage, totalPages, percent, status }) => {
        sendProgress({ percent: Math.round(percent * 0.25), status: `[HAR] ${status}` });
        // Met à jour pagesScraped pour le résumé de session (la dernière page
        // réussie atteinte pendant la capture HAR).
        if (typeof currentPage === 'number' && currentPage > sessionStats.pagesScraped) {
          sessionStats.pagesScraped = currentPage;
        }
      });

      // UA figé pour toute la capture : capturé AVANT capture() et avant de
      // mettre activeCapturer à null, pour le transmettre au pipeline
      // (enrichissement) et garder une empreinte cohérente (mêmes cookies + UA).
      const captureUserAgent = activeCapturer.getUserAgent();

      await activeCapturer.capture({
        searchUrl,
        maxPages: Math.min(500, Math.max(1, parseInt(pages, 10) || 1)),
        outputHarPath: harPath,
      });
      const harElapsed = Date.now() - t0Total;
      sendLog({ level: 'debug', message: `[job:start] Phase capture HAR terminée en ${Math.round(harElapsed / 1000)}s. Taille HAR : ${fs.existsSync(harPath) ? formatBytes(fs.statSync(harPath).size) : '(introuvable)'}.` });

      activeCapturer = null;

      // Si l'utilisateur a demandé l'arrêt pendant la capture HAR, on NE lance
      // PAS le pipeline d'enrichissement (coûteux) et on remonte un état
      // « annulé » distinct — sinon un clic « Arrêter » aboutissait à un
      // message « Scraping terminé avec succès ! » trompeur.
      if (activeCancel && activeCancel.cancelled) {
        throw Object.assign(new Error('Scraping annulé par l\'utilisateur.'), { _cancelled: true });
      }

      sendStatus({ state: 'processing', message: 'Extraction et enrichissement des annonces...' });

      activeRunner = new PipelineRunner();

      activeRunner.on('log', (data) => {
        sendLog(data);
        // Comptage pour le résumé de session
        const level = data.level || 'info';
        if (level === 'error') sessionStats.errors++;
        else if (level === 'warn') sessionStats.warnings++;
        else if (level === 'debug') sessionStats.debugs++;
        // Extraction des métriques depuis les logs du pipeline
        const msg = data.message || '';
        // Signal d'arrêt STRUCTURÉ (machine-lisible) émis par le pipeline :
        //   « [STOP_REASON] code=HTTP_403 status=403 reason=access_refused consecutiveBlocks=3 »
        // Remplace les heuristiques de texte fragiles ("interrompu"/"restreint")
        // qui pouvaient déclencher un faux « succès partiel » sur un simple
        // message de détection CAPTCHA (le mot "restreint" apparaît dans les
        // marqueurs de détection, pas forcément dans une vraie restriction).
        const stopMatch = msg.match(/\[STOP_REASON\]\s+code=(\S+)\s+status=(\S*)\s+reason=(\S+)/);
        if (stopMatch) {
          stoppedEarly = true;
          sessionStats.stoppedEarly = true;
          sessionStats.accessBlocked = true;
          sessionStats.accessCode = /429/.test(stopMatch[1]) ? 'HTTP_RATE_LIMITED' : 'HTTP_ACCESS_REFUSED';
        }
        // Compter les annonces extraites. Le pipeline émet :
        //   « Étape HAR -> Annonces terminée : N annonces extraites. » (info)
        //   « [mergeDuplicates] M annonce(s) en entrée | … | N unique(s) en sortie. » (debug)
        // L'ancien motif exigeait « annonce(s) unique|extrait ». Il ne matchait
        // PAS « N annonces extraites » (mot au singulier alors que le nombre peut
        // être pluriel) → adsFound restait à 0 dans le résumé alors que la capture
        // avait bien extrait N annonces (contradiction « 236 extraites / 0 trouvée »).
        const extractMatch = msg.match(/(\d+)\s+annonces?\s+extraites?/i);
        if (extractMatch) sessionStats.adsFound = Math.max(sessionStats.adsFound, parseInt(extractMatch[1], 10));
        const uniqueMatch = msg.match(/(\d+)\s+unique\(s\)\s+en\s+sortie/i);
        if (uniqueMatch) sessionStats.adsFound = Math.max(sessionStats.adsFound, parseInt(uniqueMatch[1], 10));
        // Compat : ancien format « N annonce(s) unique(s) ».
        const adsMatch = msg.match(/(\d+)\s+annonce\(s\)\s+(?:unique|extrait)/i);
        if (adsMatch) sessionStats.adsFound = Math.max(sessionStats.adsFound, parseInt(adsMatch[1], 10));
        // Compter les doublons fusionnés. Deux formats possibles :
        //   « N doublon(s) fusionné(s) » (pipeline)  |  « N doublon » (générique)
        const dupMatch = msg.match(/(\d+)\s+doublon/i);
        if (dupMatch) sessionStats.adsDuplicates = Math.max(sessionStats.adsDuplicates, parseInt(dupMatch[1], 10));
        // Compter les descriptions extraites (✅ [X/Y])
        const descMatch = msg.match(/✅\s*\[(\d+)\/\d+\]/);
        if (descMatch) sessionStats.descriptionsExtracted = Math.max(sessionStats.descriptionsExtracted, parseInt(descMatch[1], 10));
        // Compter les blocages d'accès (403/429) — formats actuels et historiques.
        if (msg.includes('Accès refusé (HTTP 403)') || msg.includes('Bloqué (HTTP 403') || msg.includes('BLOCKED_403')) sessionStats.descriptionsBlocked++;
        else if (msg.includes('Requête limitée (HTTP 429)') || msg.includes('BLOCKED_429')) sessionStats.descriptionsBlocked++;
        // Blocage d'accès structuré remonté par l'enrichissement (403/429/arrêt
        // préventif) → succès partiel honnête.
        if (msg.includes('[HTTP_ACCESS_REFUSED]') || msg.includes('[HTTP_429]') || msg.includes('[HTTP_RATE_LIMITED]')) {
          sessionStats.accessBlocked = true;
          sessionStats.accessCode = msg.includes('[HTTP_RATE_LIMITED]') || msg.includes('[HTTP_429]') ? 'HTTP_RATE_LIMITED' : 'HTTP_ACCESS_REFUSED';
        }
        if (msg.includes('Blocage détecté. Arrêt préventif')) sessionStats.accessBlocked = true;
      });

      activeRunner.on('progress', ({ percent, status, eta }) => {
        const globalPercent = 25 + Math.round((percent / 100) * 50);
        sendProgress({ percent: globalPercent, status, eta });
      });

      const t0Pipeline = Date.now();
      const pipelineExit = await activeRunner.run({
        harPath,
        outDir: resultsDir,
        noDesc,
        fresh: true,
        limit: limit ? parseInt(limit, 10) : undefined,
        speed: userSettings.scrapeSpeed || 'moyen',
        headless: userSettings.headless !== false,
        userAgent: captureUserAgent,
        // BASE_OUT_DIR : le pipeline forké n'a pas accès à electron → on lui
        // transmet le chemin pour qu'il localise la session globale.
        baseOutDir: BASE_OUT_DIR,
        // Profil de données (Défaut / Maximum / Personnalisé) : liste concrète de
        // clés de champs à exporter, appliquée par le pipeline (JSON + TXT).
        profileId: resolvedProfileId,
        profileFields,
        includeSellerData: userSettings.includeSellerData !== false,
      });
      sendLog({ level: 'debug', message: `[job:start] Phase pipeline terminée en ${Math.round((Date.now() - t0Pipeline) / 1000)}s.` });

      activeRunner = null;

      // Le runner renvoie 130 si le pipeline forké a été interrompu (SIGINT).
      // Sans ce test, une annulation PENDANT l'enrichissement était rapportée
      // comme un succès. Les résultats partiels restent sur disque (écritures
      // atomiques + checkpoints), on se contente de corriger l'état final.
      if (pipelineExit === 130) {
        throw Object.assign(new Error('Scraping annulé par l\'utilisateur.'), { _cancelled: true });
      }

      const jsonPath = path.join(resultsDir, 'annonces.json');

      if (fs.existsSync(jsonPath)) {
        // Lecture via checksum : le pipeline écrit annonces.json avec
        // writeWithChecksum. readWithChecksum valide l'intégrité (SHA-256) et
        // donne un message clair si le fichier est corrompu (crash pendant
        // l'écriture, disque défaillant) au lieu d'un JSON.parse qui throw
        // silencieusement et fait tomber le job en erreur générique.
        const { data: ads, valid, reason } = readWithChecksum(jsonPath);
        if (!valid || !Array.isArray(ads)) {
          sendLog({ level: 'warn', message: `[job:start] annonces.json illisible (${reason || 'format inattendu'}) — étapes suivantes ignorées pour ce job.` });
          sessionStats.warnings++;
        } else {
          sessionStats.adsKept = ads.length;
          if (sessionStats.adsFound === 0) sessionStats.adsFound = ads.length;
          sendLog({ level: 'debug', message: `[job:start] annonces.json lu : ${summarizeAds(ads)}.` });
        }
      } else {
        sendLog({ level: 'warn', message: `[job:start] annonces.json introuvable après pipeline : ${jsonPath} — le scraping a peut-être échoué silencieusement.` });
      }

      const latestJob = JobHistoryManager.getLatestJob();
      sendLog({ level: 'debug', message: `[job:start] Durée totale du job : ${Math.round((Date.now() - t0Total) / 1000)}s | stoppedEarly=${stoppedEarly} | accessBlocked=${sessionStats.accessBlocked}.` });

      // ─── Résumé de session ───
      sendSessionSummary();

      // Succès PARTIEL : soit les pages ont été interrompues (stop préventif), soit
      // l'enrichissement a été bloqué (403/429) alors que des annonces avaient
      // déjà été extraites. On ne déclare JAMAIS « succès » dans ces cas.
      const partial = stoppedEarly || sessionStats.accessBlocked;
      if (partial) {
        const reason = sessionStats.accessCode === 'HTTP_RATE_LIMITED'
          ? 'Requête limitée (HTTP 429) pendant l\'enrichissement'
          : sessionStats.accessCode === 'HTTP_ACCESS_REFUSED'
            ? 'Accès refusé (HTTP 403) pendant l\'enrichissement'
            : 'Interruption préventive anti-bot';
        sendProgress({ percent: 100, status: 'Sauvegardé (succès partiel)' });
        sendStatus({
          state: 'partial',
          message: `Succès partiel : ${sessionStats.adsKept} annonce(s) conservée(s). ${reason} — certaines descriptions manquent. L'export reste disponible.`,
          latestJob,
        });
      } else {
        sendProgress({ percent: 100, status: 'Terminé à 100 % !' });
        sendStatus({
          state: 'completed',
          message: `Scraping terminé avec succès ! ${sessionStats.adsKept} annonce(s).`,
          latestJob,
        });
      }

    } catch (err) {
      if (err && err._cancelled) {
        // Annulation utilisateur : état dédié (« cancelled »), distinct d'un
        // succès et d'une erreur. Le renderer réactive les boutons.
        sendLog({ level: 'warn', message: `⏹️ ${err.message}` });
        sendSessionSummary();
        sendStatus({ state: 'cancelled', message: 'Scraping annulé par l\'utilisateur.' });
      } else {
        sendLog({ level: 'error', message: `❌ Erreur : ${err.message}` });
        sendLog({ level: 'debug', message: `[job:start] Détail erreur fatale : ${describeError(err)}` });
        sessionStats.errors++;
        // Résultats partiels : le pipeline écrit annonces.json AVANT la phase
        // d'enrichissement. Si l'échec survient après (ex. enrichissement bloqué),
        // les annonces déjà extraites restent valides — on les signale au lieu de
        // les perdre derrière une erreur générique.
        const partialJson = path.join(resultsDir, 'annonces.json');
        let partialAds = null;
        if (fs.existsSync(partialJson)) {
          const r = readWithChecksum(partialJson);
          if (r.valid && Array.isArray(r.data) && r.data.length > 0) partialAds = r.data.length;
        }
        sendSessionSummary();
        if (partialAds != null) {
          sessionStats.adsKept = partialAds;
          sendLog({ level: 'warn', message: `[job:start] ${partialAds} annonce(s) déjà extraite(s) conservée(s) malgré l'échec de l'enrichissement.` });
          sendStatus({ state: 'partial', message: `Succès partiel : ${partialAds} annonce(s) extraite(s) et conservée(s). ${err.message}`, latestJob: JobHistoryManager.getLatestJob() });
        } else {
          sendStatus({ state: 'error', message: `Erreur : ${err.message}` });
        }
      }
    } finally {
      isRunning = false;
      activeCapturer = null;
      activeRunner = null;
      activeCancel = null;
      currentJobId = null;
    }
  });

  // ⏹️ Bouton « Arrêter » : arrêt propre de la capture HAR et du pipeline forké.
  ipcMain.on('job:stop', () => {
    if (activeCancel) {
      activeCancel.cancelled = true;
      sendLog({ level: 'warn', message: '⏹️ Demande d\'arrêt envoyée — arrêt en cours de la tâche.' });
    }
    if (activeRunner) activeRunner.stop();
    if (activeCapturer) activeCapturer.stop(); // Arrêt immédiat de la capture HAR en cours
    if (!isRunning && !activeCancel) {
      sendLog({ level: 'debug', message: '[job:stop] Aucune tâche en cours.' });
    }
  });

  ipcMain.handle('config:get', async () => {
    return loadSettings();
  });

  // ℹ️ Diagnostic applicatif (non sensible) pour le formulaire de feedback.
  // Renvoie version, plateforme, arch et date — rien de personnel.
  ipcMain.handle('app:getDiagnostics', async () => {
    const os = require('os');
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      platform: os.platform(),
      arch: process.arch,
      osRelease: os.release(),
      locale: app.getLocale(),
      timestamp: new Date().toISOString(),
    };
  });

  // 🩺 Vérification du binaire Chromium (Playwright) : scraping-critique.
  // Si le binaire n'est pas installé, le scraping échoue avec une erreur
  // cryptique « Executable doesn't exist » au moment de chromium.launch().
  // On vérifie le chemin renvoyé par chromium.executablePath() sur le disque
  // et on renvoie un statut + un message d'aide (« npx playwright install
  // chromium ») pour que le renderer affiche un bandeau d'avertissement
  // AVANT que l'utilisateur ne lance un job qui échouera.
  ipcMain.handle('app:checkChromium', async () => {
    try {
      const { chromium } = require('playwright');
      const exePath = chromium.executablePath();
      const exists = fs.existsSync(exePath);
      const result = {
        ok: exists,
        path: exePath,
        exists,
        reason: exists ? null : 'Binaire Chromium introuvable sur le disque.',
        fixCommand: 'npx playwright install chromium',
      };
      if (!exists) {
        logger.warn(`[Chromium] Binaire manquant : ${exePath} — exécutez « npx playwright install chromium ».`);
      } else {
        logger.info(`[Chromium] Binaire OK : ${exePath}`);
      }
      return result;
    } catch (err) {
      logger.warn(`[Chromium] Vérification impossible : ${err.message}`);
      return { ok: false, path: null, exists: false, reason: err.message, fixCommand: 'npx playwright install chromium' };
    }
  });

  ipcMain.handle('config:save', async (event, patch) => {
    const merged = saveSettings(patch);
    if (merged && merged.logLevel) currentLogLevel = merged.logLevel;
    return merged;
  });

  // 💾 Export des logs de session vers un fichier texte (dans BASE_OUT_DIR/logs).
  // Le renderer envoie le texte déjà formaté ; le main choisit le chemin (jamais
  // fourni par le renderer) pour éviter toute écriture arbitraire.
  ipcMain.handle('logs:export', async (event, text) => {
    const safeText = typeof text === 'string' ? text : '';
    if (!safeText.trim()) return { ok: false, error: 'Aucun log à exporter.' };
    const logsDir = path.join(BASE_OUT_DIR, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(logsDir, `session-export-${ts}.log`);
    fs.writeFileSync(outPath, safeText, 'utf8');
    return { ok: true, path: outPath };
  });

  // 🔐 Secrets chiffrés (clés API stockées via safeStorage, pas en clair)
  // Liste blanche des clés : un renderer compromis (XSS) ne peut PAS exiger le
  // déchiffrement d'un secret arbitraire. La lecture d'une valeur en clair est
  // réservée aux clés effectivement consommées par l'UI. `secret:get` reste
  // sinon exposé et renverrait n'importe quelle valeur déchiffrée.
  const SECRET_GET_ALLOWLIST = new Set(['tavily-api-key', 'search-api-key']);
  const SECRET_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  const isAllowedSecretKey = (key) => typeof key === 'string' && SECRET_KEY_RE.test(key);
  ipcMain.handle('secret:get', async (event, key) => {
    if (!isAllowedSecretKey(key)) {
      sendLog({ level: 'warn', message: `[security] secret:get refusé (clé invalide) : ${String(key).slice(0, 40)}` });
      return null;
    }
    if (!SECRET_GET_ALLOWLIST.has(key)) {
      sendLog({ level: 'warn', message: `[security] secret:get refusé (clé hors liste blanche) : ${key}` });
      return null;
    }
    const { SecretStore } = require('../utils/secretStore');
    return SecretStore.get(key);
  });
  ipcMain.handle('secret:set', async (event, { key, value } = {}) => {
    if (!isAllowedSecretKey(key)) {
      sendLog({ level: 'warn', message: `[security] secret:set refusé (clé invalide) : ${String(key).slice(0, 40)}` });
      return false;
    }
    if (value != null && typeof value !== 'string') {
      sendLog({ level: 'warn', message: `[security] secret:set refusé (valeur non textuelle) : ${key}` });
      return false;
    }
    const { SecretStore } = require('../utils/secretStore');
    SecretStore.set(key, value);
    return true;
  });
  ipcMain.handle('secret:has', async (event, key) => {
    if (!isAllowedSecretKey(key)) return false;
    const { SecretStore } = require('../utils/secretStore');
    return SecretStore.get(key) != null;
  });
  ipcMain.handle('secret:remove', async (event, key) => {
    if (!isAllowedSecretKey(key)) {
      sendLog({ level: 'warn', message: `[security] secret:remove refusé (clé invalide) : ${String(key).slice(0, 40)}` });
      return false;
    }
    const { SecretStore } = require('../utils/secretStore');
    SecretStore.remove(key);
    return true;
  });

  // 🌐 Test de connectivité réseau (pour le mode hors-ligne)
  ipcMain.handle('network:check', async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch('https://www.leboncoin.fr', {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'manual',
      });
      clearTimeout(timer);
      return { online: true, status: res.status };
    } catch {
      return { online: false };
    }
  });

  ipcMain.handle('job:getHistory', async () => {
    return JobHistoryManager.listAllJobs();
  });

  // Historique d'évolution des annonces (changements de prix / likes / statut
  // entre sessions). Permet de détecter les annonces dont le prix baisse d'un
  // scraping à l'autre.
  ipcMain.handle('job:getAdHistory', async () => {
    return JobHistoryManager.getAdHistory();
  });

  ipcMain.handle('job:delete', async (event, jobId) => {
    return JobHistoryManager.deleteJob(jobId);
  });

  // Validation de chemin : n'autorise que les chemins dans BASE_OUT_DIR ou ses
  // sous-dossiers (anti path-traversal depuis un renderer compromis).
  function isPathAllowed(target) {
    if (!target || typeof target !== 'string') return false;
    const resolved = path.resolve(target);
    const baseResolved = path.resolve(BASE_OUT_DIR);
    return resolved === baseResolved || resolved.startsWith(baseResolved + path.sep);
  }

  ipcMain.handle('file:openFolder', async (event, folderPath) => {
    try {
      const target = folderPath || BASE_OUT_DIR;
      if (!isPathAllowed(target)) return { success: false, error: 'Chemin non autorisé.' };
      const errStr = await FileManager.openFolder(target);
      // shell.openPath renvoie '' en cas de succès, ou un message d'erreur
      // (ex: "Failed to open ...") sans throw. Sans cette vérification, l'échec
      // était silencieux : le bouton paraissait ne « rien faire ».
      if (errStr) return { success: false, error: errStr };
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Handler dédié pour ouvrir le dossier des jobs (JOBS_DIR).
  ipcMain.handle('jobs:openFolder', async () => {
    try {
      const errStr = await FileManager.openFolder(JOBS_DIR);
      // shell.openPath renvoie '' si OK, sinon un message d'erreur. On remonte
      // l'échec pour que le renderer puisse l'afficher (sinon bouton silencieux).
      if (errStr) return { success: false, error: errStr };
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('file:openFile', async (event, filePath) => {
    try {
      if (!isPathAllowed(filePath)) return { success: false, error: 'Chemin non autorisé.' };
      const errStr = await FileManager.openFile(filePath);
      if (errStr) return { success: false, error: errStr };
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('shell:openExternal', async (event, url) => {
    try {
      if (!url) return { success: false, error: 'URL vide' };
      let parsed;
      try { parsed = new URL(url); } catch { return { success: false, error: 'URL invalide' }; }
      // N'autorise que http/https (bloque file://, javascript:, data:, etc.)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { success: false, error: `Schéma non autorisé : ${parsed.protocol}` };
      }
      await shell.openExternal(url);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  return { shutdown };
}

module.exports = { setupIpcHandlers };
