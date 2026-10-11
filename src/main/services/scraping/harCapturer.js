'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { chromium } = require('playwright');
const { sleep } = require('../../utils/helpers');
const { GLOBAL_SESSION_PATH } = require('../../config/constants');
const { formatBytes, formatMs, describeError } = require('../../utils/diagnostics');

const { getRandomUserAgent } = require('./userAgents');
const { ErrorCodes, createError } = require('./errorCodes');
const { NetworkJournal } = require('./networkJournal');
const { readProgress, writeProgress, mergeHarFiles } = require('./captureState');

function buildPageUrl(baseUrl, pageNumber) {
  try {
    const urlObj = new URL(baseUrl);
    urlObj.searchParams.set('page', String(pageNumber));
    return urlObj.toString();
  } catch (err) {
    throw new Error(`URL invalide : "${baseUrl}" (${err.message})`);
  }
}

class HarCapturer extends EventEmitter {
  constructor(options = {}) {
    super();
    // Par défaut invisible. La bascule visible/invisible est gérée en interne
    // lors du pré-check captcha (voir _warmupSession).
    this.headless = options.headless !== undefined ? options.headless : true;
    this.proxyUrl = options.proxyUrl || null;
    this.minPageDelayMs = options.minPageDelayMs || 800;
    this.maxPageDelayMs = options.maxPageDelayMs || 1500;
    this.isCancelled = false;
    // Journal réseau structuré (compteurs objectifs pour report.json) : compte
    // les navigations, pages réussies/échouées et blocages avec leur URL.
    this.journal = options.journal || new NetworkJournal();
    // 🛑 FIX CRITIQUE : UA FIXE pour toute la durée de la capture.
    // Avant, chaque _newStealthContext() appelait getRandomUserAgent() → UA
    // différent entre le warmup et la capture. Leboncoin détectait l'incohérence
    // (mêmes cookies + UA différent) → HTTP 403 au 1er scraping.
    // Un UA unique, choisi une fois, garantit la cohérence de l'empreinte.
    this._userAgent = getRandomUserAgent();
  }

  stop() {
    this.isCancelled = true;
  }

  // UA figé pour toute la capture. Exposé pour que le pipeline d'enrichissement
  // réutilise EXACTEMENT le même UA (cohérence d'empreinte cookies+UA → 403 évité).
  getUserAgent() {
    return this._userAgent;
  }

  _launchOptions(headless) {
    const opts = { headless };
    if (this.proxyUrl) opts.proxy = { server: this.proxyUrl };
    return opts;
  }

  _baseContextOptions(extras = {}) {
    return {
      userAgent: this._userAgent,
      locale: 'fr-FR',
      viewport: { width: 1366, height: 850 },
      ...extras,
    };
  }

  async _newStealthContext(browser, contextOptions) {
    const ctx = await browser.newContext(contextOptions);
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const p = await ctx.newPage();
    return { ctx, p };
  }

  // Détecte un CAPTCHA / blocage sur la page. Vérifie plusieurs vecteurs :
  // 1) texte de la page (BLOCK_MARKERS)
  // 2) iframes Arkose/FunCaptcha/Cloudflare (cross-origin → non lisibles via innerText)
  // 3) URL de la page (redirection vers /captcha, /challenge, etc.)
  // 4) challenge Cloudflare (élément #challenge-form, .cf-turnstile)
  // Retourne { blocked, reason } pour un diagnostic précis.
  async _checkCaptcha(page) {
    try {
      const currentUrl = page.url();
      // 3) URL-based : Leboncoin redirige parfois vers /captcha ou /challenge
      const captchaUrlMatch = /captcha|challenge|verify|blocked|restreint/i.test(currentUrl);

      const result = await page.evaluate(() => {
        const text = (document.title + ' ' + (document.body ? document.body.innerText : '')).toLowerCase();

        // 1) Marqueurs texte
        const markers = ['captcha', 'vitesse surhumaine', 'robot', 'restreint', 'captcha-delivery', 'unusual traffic', 'vérification', 'are you human', 'unusual activity'];
        const matched = markers.find((m) => text.includes(m));

        // 2) Iframes Arkose/FunCaptcha/Cloudflare (cross-origin, non lisibles via innerText)
        const iframes = Array.from(document.querySelectorAll('iframe'));
        const captchaIframe = iframes.find((f) => {
          const src = (f.src || '').toLowerCase();
          return src.includes('arkoselabs') || src.includes('funcaptcha') ||
                 src.includes('hcaptcha') || src.includes('recaptcha') ||
                 src.includes('challenges.cloudflare') || src.includes('turnstile') ||
                 src.includes('captcha');
        });

        // 4) Cloudflare challenge form
        const cfChallenge = !!document.querySelector('#challenge-form, .cf-turnstile, #cf-challenge-running, .cf-challenge-form');

        return {
          matched,
          hasCaptchaIframe: !!captchaIframe,
          cfChallenge,
        };
      });

      const blocked = !!(result.matched || result.hasCaptchaIframe || result.cfChallenge || captchaUrlMatch);
      const reason = result.matched ? `texte "${result.matched}"`
        : result.hasCaptchaIframe ? 'iframe CAPTCHA détectée'
        : result.cfChallenge ? 'challenge Cloudflare'
        : captchaUrlMatch ? `URL suspecte (${currentUrl})`
        : null;

      if (blocked) {
        const captchaErr = createError(ErrorCodes.CAPTCHA_DETECTED, `Blocage détecté — ${reason}`, { url: currentUrl, reason });
        this.emit('log', { level: 'debug', message: `[captcha] [${captchaErr.code}] Blocage détecté — ${reason}.` });
      }
      return blocked;
    } catch (e) {
      this.emit('log', { level: 'debug', message: `[captcha] Évaluation du contenu impossible : ${e.message} — considéré comme non bloqué.` });
      return false;
    }
  }

  // Pré-check Leboncoin : navigue en invisible, et si un CAPTCHA est détecté,
  // bascule dans une fenêtre VISIBLE pour résolution humaine, puis revient en
  // invisible. La session validée est persistée dans GLOBAL_SESSION_PATH.
  async _warmupSession(browser, checkUrl) {
    this.emit('log', { level: 'info', message: '🔍 Pré-check session : navigation invisible vers Leboncoin...' });
    this.emit('log', { level: 'debug', message: `[warmup] URL de vérification : ${checkUrl} | session existante : ${fs.existsSync(GLOBAL_SESSION_PATH) ? 'OUI (' + formatBytes(fs.statSync(GLOBAL_SESSION_PATH).size) + ')' : 'NON'}` });

    const ctxOpts = this._baseContextOptions();
    if (fs.existsSync(GLOBAL_SESSION_PATH)) {
      ctxOpts.storageState = GLOBAL_SESSION_PATH;
      this.emit('log', { level: 'info', message: '🔑 Chargement de la session globale (Master Session)...' });
    }

    const { ctx, p } = await this._newStealthContext(browser, ctxOpts);
    const t0Goto = Date.now();
    let warmupStatus = null;
    // networkidle : attend que le réseau soit inactif → laisse le temps au JS de
    // rendre le CAPTCHA (Arkose/Cloudflare chargent après domcontentloaded).
    // domcontentloaded était trop tôt : le CAPTCHA n'était pas encore rendu.
    await p.goto(checkUrl, { waitUntil: 'networkidle', timeout: 45000 })
      .then((resp) => { warmupStatus = resp ? resp.status() : null; })
      .catch((e) => {
        this.emit('log', { level: 'warn', message: `Pré-check : navigation initiale impossible (${e.message}).` });
        this.emit('log', { level: 'debug', message: `[warmup] Détail erreur goto : ${describeError(e)}` });
      });
    this.emit('log', { level: 'debug', message: `[warmup] Navigation pré-check terminée en ${formatMs(Date.now() - t0Goto)}${warmupStatus ? ` — HTTP ${warmupStatus}` : ''}.` });

    // Délai supplémentaire : Leboncoin peut injecter le CAPTCHA en JS après
    // networkidle (chargement différé de l'iframe Arkose). 3s au lieu de 1.5s.
    await sleep(3000);

    // Un blocage peut se manifester par un CAPTCHA (texte/iframe/URL) OU par
    // un code HTTP d'erreur (403/429). On vérifie les deux pour ne pas rater un
    // blocage "silencieux" (403 sans page CAPTCHA).
    const captchaBlocked = await this._checkCaptcha(p);
    const httpBlocked = typeof warmupStatus === 'number' && warmupStatus >= 400;
    const blocked = captchaBlocked || httpBlocked;

    if (httpBlocked && !captchaBlocked) {
      this.emit('log', { level: 'warn', message: `[warmup] HTTP ${warmupStatus} détecté (blocage anti-bot sans CAPTCHA visible) — ouverture navigateur visible pour résolution manuelle.` });
    }

    if (!blocked) {
      // Pas de captcha : on persiste la session fraîche si elle n'existait pas,
      // AVANT de fermer le contexte (storageState sur un contexte fermé échoue).
      if (!fs.existsSync(GLOBAL_SESSION_PATH)) {
        await ctx.storageState({ path: GLOBAL_SESSION_PATH }).catch((e) => {
          this.emit('log', { level: 'warn', message: `[warmup] Sauvegarde session fraîche impossible : ${e.message}` });
        });
        this.emit('log', { level: 'debug', message: `[warmup] Session fraîche persistée : ${GLOBAL_SESSION_PATH}` });
      }
      await p.close().catch(() => {});
      await ctx.close().catch(() => {});
      this.emit('log', { level: 'info', message: '✅ Pré-check OK : aucun CAPTCHA, reprise invisible.' });
      return { verified: true, reason: 'no_captcha' };
    }

    // Blocage détecté (CAPTCHA ou HTTP 403/429) : ferme le contexte invisible
    // avant d'ouvrir une fenêtre VISIBLE pour résolution humaine.
    await p.close().catch(() => {});
    await ctx.close().catch(() => {});

    const captchaDetectedErr = createError(ErrorCodes.CAPTCHA_DETECTED, 'Blocage CAPTCHA détecté — affichage de la fenêtre (résolution humaine requise)');
    this.emit('log', { level: 'warn', message: `⚠️ [${captchaDetectedErr.code}] Blocage CAPTCHA détecté — affichage de la fenêtre (résolution humaine requise).` });
    this.emit('log', { level: 'info', message: '👤 Une fenêtre va s\'ouvrir. Résolvez le CAPTCHA manuellement — le scraping reprendra automatiquement.' });
    this.emit('progress', { currentPage: 0, totalPages: 0, percent: 0, status: 'CAPTCHA : veuillez résoudre dans la fenêtre ouverte...' });

    // Relance un navigateur visible (le navigateur headless actuel ne peut pas
    // devenir visible à chaud) afin que l'utilisateur puisse interagir.
    const visibleBrowser = await chromium.launch(this._launchOptions(false));
    try {
      const vOpts = this._baseContextOptions();
      if (fs.existsSync(GLOBAL_SESSION_PATH)) vOpts.storageState = GLOBAL_SESSION_PATH;
      const { ctx: vCtx, p: vPage } = await this._newStealthContext(visibleBrowser, vOpts);

      // 🛑 FIX CRITIQUE : suivre le statut HTTP en temps réel via les responses.
      // Avant, vStatus était figé à la navigation initiale (souvent 403) et jamais
      // mis à jour → la détection ne détectait JAMAIS la résolution et attendait
      // les 10 minutes complètes. Maintenant on track la dernière réponse HTTP
      // document dynamiquement, ce qui permet de confirmer la résolution
      // (redirection post-CAPTCHA → HTTP 200).
      let latestHttpStatus = null;
      vPage.on('response', (resp) => {
        // Ne track que les réponses de navigation principale (document), pas les
        // sous-ressources (CSS/JS/images) qui peuvent renvoyer des codes trompeurs.
        if (resp.request().resourceType() === 'document') {
          latestHttpStatus = resp.status();
        }
      });

      let vStatus = null;
      await vPage.goto(checkUrl, { waitUntil: 'networkidle', timeout: 60000 })
        .then((resp) => { vStatus = resp ? resp.status() : null; latestHttpStatus = vStatus; })
        .catch((e) => {
          this.emit('log', { level: 'warn', message: `[warmup] Navigation fenêtre visible échouée : ${e.message}` });
        });

      // Attend que le CAPTCHA soit rendu avant de demander la résolution.
      await sleep(2000);

      // Vérifie le blocage : CAPTCHA (texte/iframe/URL) uniquement.
      // 🛑 On NE vérifie PLUS le statut HTTP figé (vStatus) pendant le polling :
      // il reste à 403 même après résolution car la navigation initiale est restée
      // bloquée. On se fie au contenu (iframe/texte/URL) qui change quand
      // l'utilisateur résout le CAPTCHA → la page se redirige vers les résultats.
      const checkVBlocked = async () => {
        return this._checkCaptcha(vPage);
      };

      let isBlocked = await checkVBlocked();
      let waitAttempts = 0;
      const POLL_INTERVAL_MS = 2000; // 2s pour une détection rapide
      const MAX_WAIT_MS = 10 * 60 * 1000; // 10 min max (sécurité)
      const startTime = Date.now();

      this.emit('log', { level: 'info', message: `[warmup] Fenêtre CAPTCHA ouverte. Résolvez le défi — la détection est automatique (polling ${POLL_INTERVAL_MS / 1000}s). Maximum ${Math.round(MAX_WAIT_MS / 60000)} min.` });

      // 🛑 FIX CLEF : on NE RECHARGE PAS la page pendant la résolution.
      // L'ancien code faisait vPage.reload() toutes les 2s → l'utilisateur ne
      // pouvait pas résoudre le CAPTCHA (la page se réinitialisait en continu).
      // On se contente de POLLER le contenu de la page (innerText/URL/iframes)
      // sans recharger, pour détecter quand l'utilisateur a résolu le défi.
      let confirmedClear = false;
      while (!confirmedClear && !this.isCancelled) {
        waitAttempts++;
        const elapsed = Date.now() - startTime;
        if (elapsed > MAX_WAIT_MS) {
          this.emit('log', { level: 'warn', message: `[warmup] Délai max (${Math.round(MAX_WAIT_MS / 60000)} min) atteint — abandon.` });
          break;
        }
        if (waitAttempts % 10 === 0) {
          const totalSec = Math.round((elapsed) / 1000);
          this.emit('log', { level: 'debug', message: `[warmup] En attente de résolution... (${totalSec}s écoulées).` });
        }
        await sleep(POLL_INTERVAL_MS);

        // Poll SANS reload : l'utilisateur résout le CAPTCHA → le DOM change
        // (les marqueurs disparaissent, l'iframe est retirée, ou l'URL change
        // suite à une redirection automatique).
        const stillBlocked = await checkVBlocked();

        if (!stillBlocked) {
          // 🛑 FIX : confirmation pour éviter les faux positifs.
          // Leboncoin peut brièvement retirer l'iframe CAPTCHA pendant une
          // transition (animation, redirection intermédiaire). On attend 2s et
          // on re-vérifie : si toujours non bloqué → résolution confirmée.
          this.emit('log', { level: 'debug', message: '[warmup] CAPTCHA semble résolu — confirmation (2s)...' });
          await sleep(2000);
          const recheck = await checkVBlocked();
          if (!recheck) {
            confirmedClear = true;
          } else {
            this.emit('log', { level: 'debug', message: '[warmup] Faux positif — CAPTCHA toujours présent, reprise de l\'attente.' });
          }
        }
      }

      if (this.isCancelled) {
        const cancelErr = createError(ErrorCodes.CAPTCHA_UNRESOLVED, 'Résolution annulée par l\'utilisateur');
        this.emit('log', { level: 'warn', message: `[warmup] [${cancelErr.code}] Résolution annulée par l\'utilisateur.` });
        // NE PAS persister la session : on est encore bloqué (CAPTCHA non résolu),
        // persister reviendrait à sauvegarder une session avec des cookies anti-bot
        // qui empoisonneraient tous les jobs suivants. On ferme sans storageState.
        await vPage.close().catch(() => {});
        await vCtx.close().catch(() => {});
        return { verified: false, reason: 'cancelled' };
      }

      if (!confirmedClear) {
        // Timeout atteint sans résolution — on ne persiste pas la session.
        const timeoutErr = createError(ErrorCodes.CAPTCHA_TIMEOUT, `CAPTCHA non résolu dans le délai (${Math.round(MAX_WAIT_MS / 60000)} min) — session non persistée`);
        this.emit('log', { level: 'warn', message: `[warmup] [${timeoutErr.code}] CAPTCHA non résolu dans le délai — session non persistée.` });
        await vPage.close().catch(() => {});
        await vCtx.close().catch(() => {});
        return { verified: false, reason: 'timeout' };
      }

      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      this.emit('log', { level: 'info', message: `[warmup] ✅ [${ErrorCodes.CAPTCHA_DETECTED}] CAPTCHA résolu après ${elapsedSec}s (HTTP ${latestHttpStatus || '?'}) — stabilisation de la session...` });

      // FIX POST-CAPTCHA : attendre que la page se stabilise complètement
      // avant de persister la session. Leboncoin redirige ou recharge la page
      // après résolution — si on sauvegarde trop tôt, on capture une session
      // incomplète (sans le cookie de validation) → erreur au prochain goto.
      try {
        await vPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      } catch { /* timeout networkidle acceptable */ }
      // Grace period courte : Leboncoin peut définir des cookies supplémentaires
      // après la redirection post-CAPTCHA.
      await sleep(1500);

      // Re-vérifie une dernière fois : Leboncoin peut afficher un 2e CAPTCHA
      // consécutif (anti-bot agressif). Si oui, on ne persiste PAS.
      const stillBlocked = await checkVBlocked();
      if (stillBlocked) {
        const secondCaptchaErr = createError(ErrorCodes.CAPTCHA_UNRESOLVED, 'Un 2e CAPTCHA consécutif est apparu — session non persistée. Relancez le scraping.');
        this.emit('log', { level: 'warn', message: `[warmup] [${secondCaptchaErr.code}] Un 2e CAPTCHA consécutif est apparu — session non persistée. Relancez le scraping.` });
        await vPage.close().catch(() => {});
        await vCtx.close().catch(() => {});
        return { verified: false, reason: 'second_captcha' };
      }

      // Persiste la session validée pour les jobs suivants (plus de fenêtre visible).
      await vCtx.storageState({ path: GLOBAL_SESSION_PATH });
      this.emit('log', { level: 'debug', message: `[warmup] Session validée persistée : ${GLOBAL_SESSION_PATH} (${formatBytes(fs.statSync(GLOBAL_SESSION_PATH).size)})` });
      await vPage.close().catch(() => {});
      await vCtx.close().catch(() => {});
      this.emit('log', { level: 'info', message: '✅ CAPTCHA résolu et session persistée — reprise du scraping invisible.' });
      return { verified: true, reason: 'captcha_resolved' };
    } finally {
      await visibleBrowser.close().catch(() => {});
    }
  }

  // Détecte une page de résultats VIDE (HTTP 200 mais sans annonces) : soft-block
  // anti-bot, page d'erreur HTML, ou recherche réellement sans résultat. On
  // distingue les deux via des marqueurs d'erreur/blocklist. Sans ce contrôle,
  // un soft-block en 200 était traité comme une page réussie (aucune alerte).
  async _looksLikeEmptyResults(page) {
    try {
      const info = await page.evaluate(() => {
        const text = (document.title + ' ' + (document.body ? document.body.innerText : '')).toLowerCase();
        // Sélecteurs connus des cartes d'annonces Leboncoin.
        const count = document.querySelectorAll('a[href*="/ad/"], article[data-test-id], [data-role="ad-card"], a[data-test-id="ad"]').length;
        const errorMarkers = ['erreur', 'error', 'indisponible', 'unavailable', 'réessayez', 'service indisponible', 'try again', 'something went wrong'];
        const matched = errorMarkers.find((m) => text.includes(m)) || null;
        return { count, matched };
      });
      if (info.count > 0) return { empty: false };
      // Aucune carte : soit blocage (marqueur d'erreur), soit recherche vide.
      return { empty: true, blocked: !!info.matched, marker: info.matched };
    } catch (e) {
      this.emit('log', { level: 'debug', message: `[capture] Détection page vide impossible : ${e.message}.` });
      return { empty: false };
    }
  }

  async capture({ searchUrl, maxPages = 1, outputHarPath, resumeFrom = null }) {
    if (!searchUrl) throw new Error("L'URL de recherche est requise.");
    const targetDir = path.dirname(outputHarPath);
    fs.mkdirSync(targetDir, { recursive: true });
    const statePath = path.join(targetDir, 'session-state.json');

    // Reprise incrémentale : si `resumeFrom` est fourni (ou détecté via
    // capture-progress.json), on redémarre à cette page au lieu de 1. Les pages
    // déjà capturées restent dans le HAR précédent (fusionné par le main process).
    let startPage = 1;
    if (typeof resumeFrom === 'number' && resumeFrom > 1) {
      startPage = Math.min(resumeFrom, maxPages);
      this.emit('log', { level: 'info', message: `⏩ Reprise incrémentale demandée : capture à partir de la page ${startPage} (pages 1-${startPage - 1} déjà capturées).` });
    } else {
      // Auto-reprise : si un HAR partiel et un état de progression existent dans
      // ce job (nouvelle tentative sur le même dossier), on reprend après la
      // dernière page réussie au lieu de tout re-capturer.
      const prev = readProgress(targetDir);
      if (prev && typeof prev.lastPageOk === 'number' && prev.lastPageOk >= 1 && fs.existsSync(outputHarPath)) {
        const resumeAt = Math.min(prev.lastPageOk + 1, maxPages);
        if (resumeAt > 1) {
          startPage = resumeAt;
          this.emit('log', { level: 'info', message: `⏩ Reprise automatique détectée (${prev.lastPageOk} page(s) déjà OK) — capture à partir de la page ${startPage}.` });
        }
      }
    }

    this.emit('log', { level: 'info', message: `🚀 Initialisation de la capture HAR (${maxPages} page(s))...` });
    this.emit('log', { level: 'debug', message: `[capture] searchUrl=${searchUrl} | maxPages=${maxPages} | outputHarPath=${outputHarPath} | proxy=${this.proxyUrl || 'aucun'} | headless=${this.headless}` });

    // En reprise (startPage>1), Playwright écrirait dans outputHarPath et
    // écraserait le HAR des pages déjà capturées. On écrit donc dans un HAR
    // séparé, fusionné avec l'ancien à la fin.
    const resumeHarPath = path.join(targetDir, 'capture-resume.har');
    const activeHarPath = startPage > 1 ? resumeHarPath : outputHarPath;
    const isResume = startPage > 1;

    let browser;
    let context;
    let page;

    try {
      browser = await chromium.launch(this._launchOptions(true));
      this.emit('log', { level: 'debug', message: '[capture] Chromium lancé (headless=true pour la capture).' });

      let globalSessionSaved = false;

      // Pré-check captcha + bascule visible si nécessaire (avant la boucle HAR).
      const warmup = await this._warmupSession(browser, buildPageUrl(searchUrl, 1));
      // Si le pré-check n'a PAS pu valider l'accès (CAPTCHA non résolu, timeout,
      // 2e CAPTCHA), on n'entame PAS la capture : c'était une boucle de fenêtres
      // CAPTCHA stérile. Arrêt propre (le main process rapportera un échec).
      if (warmup && warmup.verified === false) {
        this.emit('log', { level: 'warn', message: `[capture] Pré-check non validé (${warmup.reason}) — capture annulée (aucune fenêtre CAPTCHA en boucle).` });
        await browser.close().catch(() => {});
        throw new Error(`Session non validée (${warmup.reason}) : capture annulée pour éviter une boucle de CAPTCHA.`);
      }
      if (this.isCancelled) {
        this.emit('log', { level: 'debug', message: '[capture] Capture annulée après pré-check (isCancelled=true).' });
        await browser.close().catch(() => {});
        return outputHarPath;
      }

      // 🛑 FIX : délai entre warmup et capture. Les logs montraient que le
      // warmup (HTTP 200) et la capture (HTTP 403) arrivaient dans la même
      // seconde → Leboncoin rate-limitait la requête trop rapide. Un délai de
      // 2s laisse le temps au rate-limiter de Leboncoin de se réinitialiser.
      this.emit('log', { level: 'debug', message: '[capture] Délai de sécurité (2s) après warmup pour éviter le rate-limit Leboncoin.' });
      await sleep(2000);

      const contextOptions = this._baseContextOptions({
        recordHar: {
          path: activeHarPath,
          mode: 'full',
          urlFilter: /recherche|api|items/i,
        },
      });

      if (fs.existsSync(GLOBAL_SESSION_PATH)) {
        contextOptions.storageState = GLOBAL_SESSION_PATH;
        this.emit('log', { level: 'info', message: '🔑 Session validée chargée pour la capture.' });
      } else {
        this.emit('log', { level: 'warn', message: '[capture] Aucune session globale trouvée pour la capture — risque de blocage captcha plus élevé.' });
      }

      ({ ctx: context, p: page } = await this._newStealthContext(browser, contextOptions));
      this.emit('log', { level: 'debug', message: '[capture] Contexte HAR créé (filtrage URL: recherche|api|items).' });

      // Signatures des pages déjà vues : détecte une boucle de pagination
      // (Leboncoin peut renvoyer la MÊME page pour page=2, page=3…). Sans ce
      // garde-fou, on consommait N navigations identiques (durée de session et
      // risque de rate-limit multipliés sans aucun gain de données).
      const seenPageSignatures = new Set();
      // Erreur fatale différée : un `throw` direct dans le try par-page serait
      // avalé par son `catch (gotoErr)`. On mémorise puis on relance après la boucle.
      let fatalError = null;

      for (let pageNum = startPage; pageNum <= maxPages; pageNum++) {
        if (this.isCancelled) {
          this.emit('log', { level: 'debug', message: `[capture] Boucle de capture interrompue à la page ${pageNum} (annulation).` });
          break;
        }

        // Recyclage toutes les 3 pages pour la RAM
        if (pageNum > 1 && pageNum % 3 === 0) {
          this.emit('log', { level: 'debug', message: '🔄 Purge mémoire Chromium...' });
          await page.close().catch(() => {});
          await sleep(500);
          page = await context.newPage();
        }

        const targetUrl = buildPageUrl(searchUrl, pageNum);
        this.emit('progress', { currentPage: pageNum, totalPages: maxPages, percent: Math.round((pageNum / maxPages) * 100), status: `Navigation page ${pageNum}/${maxPages}...` });
        this.emit('log', { level: 'info', message: `[Page ${pageNum}/${maxPages}] Navigation vers ${targetUrl}` });

        try {
          this.journal.recordNavigation();
          const resp = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
          const httpStatus = resp ? resp.status() : '?';
          this.emit('log', { level: 'debug', message: `[Page ${pageNum}] Page chargée — HTTP ${httpStatus}.` });

          // Sauvegarde la session globale dès la 1ère page réussie (HTTP < 400).
          // On NE la réécrit PAS ensuite : les pages suivantes peuvent être 403
          // (anti-bot) et empoisonneraient la session avec des cookies de blocage.
          if (typeof httpStatus === 'number' && httpStatus < 400 && !globalSessionSaved) {
            await context.storageState({ path: GLOBAL_SESSION_PATH }).catch((e) => {
              this.emit('log', { level: 'warn', message: `[capture] Sauvegarde session globale impossible après page ${pageNum} : ${e.message}` });
            });
            globalSessionSaved = true;
            this.emit('log', { level: 'debug', message: `[capture] Session globale sauvegardée après page ${pageNum} (HTTP ${httpStatus}).` });
          }

          // Best-effort networkidle avant la détection CAPTCHA : les iframes
          // Arkose/Cloudflare chargent après domcontentloaded. Sans ce délai,
          // on peut rater un CAPTCHA qui n'est pas encore rendu.
          await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

          // 🤖 DÉTECTION DE BLOCAGE : CAPTCHA (texte/iframe/URL) OU HTTP >= 400.
          // Un 403 sans texte CAPTCHA est un blocage silencieux : on arrête
          // immédiatement au lieu de gaspiller des requêtes sur les pages suivantes.
          const captchaBlocked = await this._checkCaptcha(page);
          const httpBlocked = typeof httpStatus === 'number' && httpStatus >= 400;
          if (captchaBlocked || httpBlocked) {
            const reason = httpBlocked ? `HTTP ${httpStatus}` : 'CAPTCHA';
            const blockCode = httpBlocked ? (httpStatus === 403 ? ErrorCodes.HTTP_403 : httpStatus === 429 ? ErrorCodes.HTTP_429 : ErrorCodes.HTTP_UNKNOWN) : ErrorCodes.CAPTCHA_DETECTED;
            const blockErr = createError(blockCode, `BLOCAGE DÉTECTÉ (${reason}) — tentative de résolution interactive`, { page: pageNum, httpStatus, reason });
            this.emit('log', { level: 'warn', message: `⚠️ [Page ${pageNum}] [${blockErr.code}] BLOCAGE DÉTECTÉ (${reason}) — tentative de résolution interactive...` });
            this.journal.recordBlock(targetUrl, typeof httpStatus === 'number' ? httpStatus : null);

            // Au lieu d'abandonner, on tente une résolution interactive :
            // ferme le contexte HAR, ouvre une fenêtre visible, puis relance
            // la capture depuis la page bloquée.
            await page.close().catch(() => {});
            await context.close().catch(() => {});
            context = null;
            page = null;
            await browser.close().catch(() => {});
            browser = null;

            // _warmupSession ouvre un navigateur visible, attend la résolution,
            // persiste la session, puis ferme. Si résolu, on relance la capture.
            this.emit('log', { level: 'info', message: '[capture] Ouverture fenêtre de résolution CAPTCHA (pendant la capture)...' });
            const retryBrowser = await chromium.launch(this._launchOptions(true));
            let retryWarmup = null;
            try {
              retryWarmup = await this._warmupSession(retryBrowser, buildPageUrl(searchUrl, pageNum));
            } finally {
              await retryBrowser.close().catch(() => {});
            }

            if (this.isCancelled) {
              this.emit('log', { level: 'debug', message: '[capture] Capture annulée pendant résolution CAPTCHA.' });
              return outputHarPath;
            }

            // Si la résolution interactive n'a pas validé l'accès, on ARRÊTE :
            // relancer la capture relancerait une fenêtre CAPTCHA en boucle.
            if (retryWarmup && retryWarmup.verified === false) {
              this.emit('log', { level: 'warn', message: `[capture] Résolution non validée (${retryWarmup.reason}) — arrêt de la capture (pas de boucle CAPTCHA).` });
              fatalError = new Error(`Accès non validé (${retryWarmup.reason}) : arrêt de la capture.`);
              break;
            }

            // Relance le navigateur et le contexte HAR, puis reprend à la page bloquée.
            browser = await chromium.launch(this._launchOptions(true));
            const retryCtxOpts = this._baseContextOptions({
              recordHar: { path: activeHarPath, mode: 'full', urlFilter: /recherche|api|items/i },
            });
            if (fs.existsSync(GLOBAL_SESSION_PATH)) {
              retryCtxOpts.storageState = GLOBAL_SESSION_PATH;
              this.emit('log', { level: 'info', message: '🔑 Session validée chargée pour reprise de capture.' });
            }
            ({ ctx: context, p: page } = await this._newStealthContext(browser, retryCtxOpts));
            this.emit('log', { level: 'info', message: `[capture] Reprise après résolution CAPTCHA — page ${pageNum}.` });
            // Ne pas retry cette page dans la boucle : on la capture à nouveau.
            this.journal.recordNavigation();
            const retryResp = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch((e) => {
              this.emit('log', { level: 'warn', message: `[Page ${pageNum}] Reprise échouée : ${e.message}` });
            });
            const retryStatus = retryResp ? retryResp.status() : '?';
            this.emit('log', { level: 'debug', message: `[Page ${pageNum}] Reprise — HTTP ${retryStatus}.` });
            this.journal.recordPageResult(typeof retryStatus === 'number' && retryStatus < 400);
          } else {
            // Page non bloquée : détection d'une page de résultats VIDE (HTTP 200
            // sans annonces → soft-block/erreur HTML) et d'une boucle de pagination.
            const emptyCheck = await this._looksLikeEmptyResults(page);
            if (emptyCheck.empty) {
              if (emptyCheck.blocked) {
                const emptyErr = createError(ErrorCodes.CAPTCHA_DETECTED, `Page de résultats vide (marqueur « ${emptyCheck.marker} ») — blocage probable`, { page: pageNum, httpStatus });
                this.emit('log', { level: 'warn', message: `⚠️ [Page ${pageNum}] [${emptyErr.code}] Page 200 vide (marqueur « ${emptyCheck.marker} ») — blocage probable, arrêt préventif.` });
                this.journal.recordPageResult(false);
                break;
              }
              this.emit('log', { level: 'warn', message: `[Page ${pageNum}] Aucune annonce détectée sur cette page (recherche sans résultat ou fin de pagination).` });
            }

            // Boucle de pagination : signature = nombre d'annonces + 1er id/titre.
            try {
              const sig = await page.evaluate(() => {
                const cards = document.querySelectorAll('a[href*="/ad/"]');
                const first = cards[0] ? cards[0].getAttribute('href') : '';
                return `${cards.length}|${first}`;
              });
              if (seenPageSignatures.has(sig)) {
                this.emit('log', { level: 'warn', message: `[Page ${pageNum}] Contenu identique à une page déjà vue (boucle de pagination) — arrêt pour éviter des requêtes dupliquées.` });
                this.journal.recordPageResult(false);
                break;
              }
              seenPageSignatures.add(sig);
            } catch { /* signature best-effort */ }

            this.journal.recordPageResult(true);
            // Reprise incrémentale : mémorise la dernière page réussie. En cas de
            // blocage ultérieur, le main process peut reprendre à lastPageOk+1 sans
            // re-capturer les pages déjà valides.
            writeProgress(targetDir, {
              searchUrl,
              pagesRequested: maxPages,
              lastPageOk: pageNum,
              pagesOk: this.journal.pagesOk,
            });
          }
        } catch (gotoErr) {
          this.journal.recordError();
          this.emit('log', { level: 'warn', message: `[Page ${pageNum}] Avertissement : ${gotoErr.message}` });
          this.emit('log', { level: 'debug', message: `[capture] Détail erreur page ${pageNum} : ${describeError(gotoErr)}` });
        }

        if (pageNum < maxPages) {
          const minDelay = this.minPageDelayMs;
          const maxDelay = Math.max(this.maxPageDelayMs, minDelay);
          await sleep(minDelay + Math.random() * (maxDelay - minDelay));
        }
      }

      // Une erreur fatale différée (résolution CAPTCHA non validée) doit
      // interrompre la capture AVANT la finalisation/sauvegarde de session.
      if (fatalError) throw fatalError;

      this.emit('log', { level: 'info', message: 'Finalisation et sauvegarde de la session...' });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

      // Session locale (par-job) : toujours sauvegardée pour le pipeline d'enrichissement.
      // La session globale (GLOBAL_SESSION_PATH) a déjà été sauvegardée après la 1ère page
      // réussie ci-dessus — on ne l'écrase PAS ici pour éviter de la corrompre avec d'éventuels
      // cookies anti-bot accumulés sur les pages suivantes (403).
      await context.storageState({ path: statePath });

      await context.close();
      await browser.close();
      browser = null;
      this.emit('log', { level: 'info', message: `✅ Session synchronisée.` });

      // Bilan réseau structuré (compteurs objectifs, sans heuristique de texte).
      const j = this.journal.snapshot();
      this.emit('log', { level: 'info', message: `[NET_JOURNAL] navigations=${j.navigations} pages_ok=${j.pagesOk} pages_failed=${j.pagesFailed} blocked=${j.blockedRequests} errors=${j.otherErrors}` });
      this.emit('log', { level: 'debug', message: `[capture] Journal réseau : ${JSON.stringify(j)}` });

      // Reprise : fusionne le HAR de reprise (pages startPage..N) avec le HAR
      // précédent (pages 1..startPage-1) → outputHarPath contient toutes les pages.
      if (isResume) {
        try {
          const merged = mergeHarFiles([outputHarPath, resumeHarPath], outputHarPath);
          this.emit('log', { level: 'info', message: `🔗 HAR de reprise fusionné : ${merged.sources} source(s), ${merged.entries} entrée(s).` });
        } catch (e) {
          this.emit('log', { level: 'warn', message: `[capture] Fusion HAR impossible : ${e.message} — le HAR de reprise reste séparé (${resumeHarPath}).` });
        }
      }

      // Diagnostic final : taille du HAR généré
      if (fs.existsSync(outputHarPath)) {
        const harSize = fs.statSync(outputHarPath).size;
        this.emit('log', { level: 'debug', message: `[capture] HAR généré : ${outputHarPath} (${formatBytes(harSize)}).` });
      } else {
        this.emit('log', { level: 'warn', message: `[capture] ⚠️ Le fichier HAR n'a pas été créé : ${outputHarPath}` });
      }

      return outputHarPath;
    } catch (err) {
      this.emit('log', { level: 'error', message: `❌ Erreur : ${err.message}` });
      this.emit('log', { level: 'debug', message: `[capture] Détail erreur fatale : ${describeError(err)}` });
      throw err;
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }
}

module.exports = { HarCapturer };