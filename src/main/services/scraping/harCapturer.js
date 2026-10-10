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
const { isSafeFetchDestination } = require('../../utils/urlSecurity');

// Domaines Leboncoin légitimes : l'URL de recherche fournie par l'utilisateur
// DOIT pointer vers l'un d'eux. C'est le principal point d'entrée réseau
// contrôlable par l'utilisateur (protection SSRF) : sans ce contrôle, une URL
// de recherche comme `http://169.254.169.254/...` serait naviguée par Chromium.
const LEBONCOIN_SOURCE_HOSTS = [
  'leboncoin.fr', 'www.leboncoin.fr',
  'leboncoin.com', 'www.leboncoin.com',
  'leboncoindirect.com', 'www.leboncoindirect.com',
];

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
    await this._installNetworkGuard(ctx);
    const p = await ctx.newPage();
    return { ctx, p };
  }

  // Défense en profondeur sur les sous-requêtes : intercepte chaque requête du
  // contexte et bloque les destinations structurellement dangereuses (IP
  // privées/loopback/link-local littérales, hostnames locaux, schémas
  // exotiques). On n'applique PAS d'allowlist ici : les CDN d'images/JS
  // Leboncoin sont nécessaires au rendu et trop nombreux à énumérer.
  //
  // LIMITE ASSUMÉE : ce filtre ne fait pas de résolution DNS (un hostname
  // arbitraire résolvant vers une IP privée n'est pas détecté ici). Playwright
  // Python/Node ne réexpose pas l'IP de socket résolue de façon fiable. La
  // protection réelle contre le rebinding DNS est hors de portée ; l'entrée
  // utilisateur contrôlée (URL de recherche) est, elle, strictement limitée aux
  // domaines Leboncoin dans capture().
  async _installNetworkGuard(ctx) {
    await ctx.route('**/*', (route) => {
      const url = route.request().url();
      const check = isSafeFetchDestination(url);
      if (!check.safe) {
        this.emit('log', { level: 'warn', message: `[network-guard] Requête bloquée : ${url} (${check.reason})` });
        return route.abort('blockedbyclient').catch(() => {});
      }
      return route.continue().catch(() => {});
    });
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

  // Vérification RÉELLE de l'accès (autorisation effective), distincte de la
  // simple « disparition visuelle » d'un CAPTCHA. On ne se fie pas à la
  // disparition d'une iframe, d'un texte ou d'une URL : on effectue des requêtes
  // autorisées (mêmes que celles du scraping normal) et on juge sur le STATUT
  // HTTP + la validité du contenu. Une réponse 403/429 n'est JAMAIS un succès.
  //
  // Renvoie un objet structuré :
  //   { verified: boolean, code, httpStatus, retryAfterMs, reason }
  // où code ∈ { null, HTTP_403, HTTP_429, ACCESS_UNVERIFIED, CAPTCHA_DETECTED }.
  //
  // LIMITE ASSUMÉE : on ne tente pas de résoudre un CAPTCHA. Si un CAPTCHA est
  // encore visible à l'écran, on ne peut affirmer l'accès → CAPTCHA_DETECTED.
  async _verifyAccess(page, verifyUrl) {
    // 1) CAPTCHA encore visible → access NON confirmé (jamais considéré comme OK).
    const captchaBlocked = await this._checkCaptcha(page);
    if (captchaBlocked) {
      return { verified: false, code: ErrorCodes.CAPTCHA_DETECTED, httpStatus: null, retryAfterMs: null, reason: 'CAPTCHA encore présent à l\'écran' };
    }

    const url = verifyUrl || (page && page.url ? page.url() : null);
    if (!url) {
      return { verified: false, code: ErrorCodes.ACCESS_UNVERIFIED, httpStatus: null, retryAfterMs: null, reason: 'URL de vérification indisponible' };
    }

    // 2) Requête autorisée via l'API de la page (mêmes cookies + même UA que le
    //    scraping, aucun signal d'automatisation ajouté, aucune navigation
    //    parasite). On juge sur le STATUT HTTP réel.
    let resp = null;
    try {
      resp = await page.request.get(url, { timeout: 20000, maxRedirects: 5, failOnStatusCode: false });
    } catch (e) {
      this.emit('log', { level: 'debug', message: `[verify] GET ${url} a échoué : ${e.message}` });
      return { verified: false, code: ErrorCodes.ACCESS_UNVERIFIED, httpStatus: null, retryAfterMs: null, reason: `échec de la requête (${e.message})` };
    }
    if (!resp) {
      return { verified: false, code: ErrorCodes.ACCESS_UNVERIFIED, httpStatus: null, retryAfterMs: null, reason: 'aucune réponse' };
    }

    const status = resp.status();
    const retryAfterMs = this._parseRetryAfter(resp.headers ? resp.headers()['retry-after'] : null);

    if (status === 403) {
      return { verified: false, code: ErrorCodes.HTTP_403, httpStatus: 403, retryAfterMs: null, reason: 'HTTP 403 (accès refusé par le serveur)' };
    }
    if (status === 429) {
      return { verified: false, code: ErrorCodes.HTTP_429, httpStatus: 429, retryAfterMs, reason: 'HTTP 429 (limitation de débit)' };
    }
    if (status >= 500) {
      return { verified: false, code: ErrorCodes.HTTP_UNKNOWN, httpStatus: status, retryAfterMs: null, reason: `HTTP ${status} (erreur serveur)` };
    }
    if (status >= 400) {
      return { verified: false, code: ErrorCodes.HTTP_UNKNOWN, httpStatus: status, retryAfterMs: null, reason: `HTTP ${status}` };
    }

    // 3) Statut 2xx : on valide le CONTENU (une page de blocage peut renvoyer 200).
    await sleep(500);
    let body = '';
    try { body = await resp.text(); } catch { /* corps illisible : contrôles ci-dessous */ }
    const captchaStillThere = await this._checkCaptcha(page);
    const low = String(body).toLowerCase();
    const bodyOk = low.trim().length > 40 &&
      !/captcha|robot|restreint|vérification|unusual traffic|access denied|accès refusé|trop de requ|too many requests/.test(low);

    if (captchaStillThere || !bodyOk) {
      return { verified: false, code: ErrorCodes.CAPTCHA_DETECTED, httpStatus: status, retryAfterMs: null, reason: 'Contenu bloqué/illisible malgré un statut HTTP favorable' };
    }

    return { verified: true, code: null, httpStatus: status, retryAfterMs: null, reason: `HTTP ${status} - contenu valide` };
  }

  // Convertit un en-tête Retry-After (secondes ou date HTTP) en millisecondes.
  _parseRetryAfter(value) {
    if (value == null) return null;
    const s = String(value).trim();
    if (/^\d+$/.test(s)) return Math.min(parseInt(s, 10) * 1000, 5 * 60 * 1000);
    const when = Date.parse(s);
    if (!Number.isNaN(when)) return Math.max(0, Math.min(when - Date.now(), 5 * 60 * 1000));
    return null;
  }

  // Pré-check Leboncoin : navigue en invisible, et si un blocage est détecté,
  // bascule dans une fenêtre VISIBLE pour résolution humaine, puis VÉRIFIE
  // RÉELLEMENT l'accès avant de persister la session.
  //
  // Renvoie un résultat structuré (jamais un booléen ambigu) :
  //   { resolved, opened, verified, code, httpStatus, retryAfterMs, reason }
  // L'accès n'est confirmé QUE si `verified === true` (statut HTTP favorable +
  // contenu valide), JAMAIS sur la seule disparition visuelle du CAPTCHA.
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
    // un code HTTP d'erreur (403/429).
    const captchaBlocked = await this._checkCaptcha(p);
    const httpBlocked = typeof warmupStatus === 'number' && warmupStatus >= 400;
    const blocked = captchaBlocked || httpBlocked;

    if (!blocked) {
      // Pas de blocage : on persiste la session fraîche si elle n'existait pas,
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
      return { resolved: true, opened: false, verified: true, code: null, httpStatus: warmupStatus, retryAfterMs: null, reason: 'pré-check sans blocage' };
    }

    // Blocage détecté (CAPTCHA ou HTTP 403/429) : ferme le contexte invisible
    // avant d'ouvrir une fenêtre VISIBLE pour résolution humaine.
    await p.close().catch(() => {});
    await ctx.close().catch(() => {});

    // Distinction honnête 403 (refus) / 429 (limitation) sans CAPTCHA visible.
    if (httpBlocked && !captchaBlocked) {
      if (warmupStatus === 403) {
        this.emit('log', { level: 'warn', message: `⛔ [${ErrorCodes.HTTP_ACCESS_REFUSED}] Accès refusé par le serveur (HTTP 403).` });
      } else if (warmupStatus === 429) {
        this.emit('log', { level: 'warn', message: `⏳ [${ErrorCodes.HTTP_RATE_LIMITED}] Requête limitée (HTTP 429).` });
      } else {
        this.emit('log', { level: 'warn', message: `[warmup] HTTP ${warmupStatus} détecté (blocage anti-bot sans CAPTCHA visible).` });
      }
    }

    this.emit('log', { level: 'info', message: '👤 Vérification du site en cours — une fenêtre va s\'ouvrir. Résolvez le défi manuellement ; le scraping reprendra automatiquement après confirmation effective de l\'accès.' });
    this.emit('progress', { currentPage: 0, totalPages: 0, percent: 0, status: 'Vérification du site : veuillez résoudre dans la fenêtre ouverte...' });

    // L'utilisateur a pu annuler pendant la navigation de pré-check : dans ce cas
    // on n'ouvre PAS de fenêtre visible inutilement.
    if (this.isCancelled) {
      this.emit('log', { level: 'warn', message: `[warmup] [${ErrorCodes.CAPTCHA_UNRESOLVED}] Pré-check annulé par l'utilisateur — aucune fenêtre ouverte.` });
      return { resolved: false, opened: false, verified: false, code: ErrorCodes.CAPTCHA_UNRESOLVED, httpStatus: warmupStatus, retryAfterMs: null, reason: 'annulé par l\'utilisateur' };
    }

    // Relance un navigateur visible (le navigateur headless actuel ne peut pas
    // devenir visible à chaud) afin que l'utilisateur puisse interagir.
    const visibleBrowser = await chromium.launch(this._launchOptions(false));
    try {
      const vOpts = this._baseContextOptions();
      if (fs.existsSync(GLOBAL_SESSION_PATH)) vOpts.storageState = GLOBAL_SESSION_PATH;
      const { ctx: vCtx, p: vPage } = await this._newStealthContext(visibleBrowser, vOpts);

      // Suivi du statut HTTP en temps réel (navigation document uniquement).
      let latestHttpStatus = null;
      vPage.on('response', (resp) => {
        if (resp.request().resourceType() === 'document') {
          latestHttpStatus = resp.status();
        }
      });

      await vPage.goto(checkUrl, { waitUntil: 'networkidle', timeout: 60000 })
        .then((resp) => { latestHttpStatus = resp ? resp.status() : latestHttpStatus; })
        .catch((e) => {
          this.emit('log', { level: 'warn', message: `[warmup] Navigation fenêtre visible échouée : ${e.message}` });
        });

      // Attend que le CAPTCHA soit rendu avant de demander la résolution.
      await sleep(2000);

      // On NE RECHARGE PAS la page pendant la résolution : on POLLE le contenu
      // (innerText/URL/iframes) sans reload pour laisser l'utilisateur résoudre.
      const checkVBlocked = async () => this._checkCaptcha(vPage);

      let waitAttempts = 0;
      const POLL_INTERVAL_MS = 2000; // 2s pour une détection rapide
      const MAX_WAIT_MS = 10 * 60 * 1000; // 10 min max (sécurité)
      const startTime = Date.now();

      this.emit('log', { level: 'info', message: `[warmup] Fenêtre de vérification ouverte. Résolvez le défi — suivi automatique (polling ${POLL_INTERVAL_MS / 1000}s). Maximum ${Math.round(MAX_WAIT_MS / 60000)} min.` });

      let visualClear = false;
      while (!visualClear && !this.isCancelled) {
        waitAttempts++;
        const elapsed = Date.now() - startTime;
        if (elapsed > MAX_WAIT_MS) {
          this.emit('log', { level: 'warn', message: `[warmup] Délai max (${Math.round(MAX_WAIT_MS / 60000)} min) atteint — abandon.` });
          break;
        }
        if (waitAttempts % 10 === 0) {
          this.emit('log', { level: 'debug', message: `[warmup] En attente de résolution... (${Math.round(elapsed / 1000)}s écoulées).` });
        }
        await sleep(POLL_INTERVAL_MS);

        const stillBlocked = await checkVBlocked();
        if (!stillBlocked) {
          // Confirmation anti-faux-positif : on attend 2s et on re-vérifie.
          this.emit('log', { level: 'debug', message: '[warmup] Défi visuellement résolu — confirmation (2s)...' });
          await sleep(2000);
          const recheck = await checkVBlocked();
          if (!recheck) {
            visualClear = true;
          } else {
            this.emit('log', { level: 'debug', message: '[warmup] Faux positif — défi toujours présent, reprise de l\'attente.' });
          }
        }
      }

      if (this.isCancelled) {
        this.emit('log', { level: 'warn', message: `[warmup] [${ErrorCodes.CAPTCHA_UNRESOLVED}] Vérification annulée par l'utilisateur — session non persistée.` });
        // NE PAS persister : on est encore bloqué (cookies anti-bot).
        await vPage.close().catch(() => {});
        await vCtx.close().catch(() => {});
        return { resolved: false, opened: true, verified: false, code: ErrorCodes.CAPTCHA_UNRESOLVED, httpStatus: latestHttpStatus, retryAfterMs: null, reason: 'annulé par l\'utilisateur' };
      }

      if (!visualClear) {
        this.emit('log', { level: 'warn', message: `[warmup] [${ErrorCodes.CAPTCHA_TIMEOUT}] Vérification non résolue dans le délai — session non persistée.` });
        await vPage.close().catch(() => {});
        await vCtx.close().catch(() => {});
        return { resolved: false, opened: true, verified: false, code: ErrorCodes.CAPTCHA_TIMEOUT, httpStatus: latestHttpStatus, retryAfterMs: null, reason: 'délai dépassé' };
      }

      // ⚠️ POINT CRITIQUE : la disparition visuelle du défi NE prouve PAS que
      // l'accès est autorisé (un HTTP 403/429 peut persister). On effectue donc
      // une VÉRIFICATION RÉELLE de l'accès avant toute persistance.
      this.emit('log', { level: 'info', message: `[warmup] Défi disparu — vérification réelle de l'accès (HTTP ${latestHttpStatus || '?'})...` });
      // Stabilisation : Leboncoin redirige/recharge après la résolution.
      await vPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await sleep(1500);

      const verification = await this._verifyAccess(vPage, checkUrl);

      if (!verification.verified) {
        const refused = verification.code === ErrorCodes.HTTP_403;
        const limited = verification.code === ErrorCodes.HTTP_429;
        if (limited && verification.retryAfterMs) {
          this.emit('log', { level: 'warn', message: `[warmup] Retry-After indiqué par le serveur : ${Math.round(verification.retryAfterMs / 1000)}s (aucune reprise automatique).` });
        }
        const label = refused ? 'Accès refusé par le serveur (HTTP 403)'
          : limited ? 'Requête limitée (HTTP 429)'
          : `Session non validée (${verification.reason})`;
        this.emit('log', { level: 'warn', message: `[warmup] [${verification.code || ErrorCodes.ACCESS_UNVERIFIED}] ${label} — session non persistée.` });
        await vPage.close().catch(() => {});
        await vCtx.close().catch(() => {});
        return {
          resolved: true, opened: true, verified: false,
          code: verification.code || ErrorCodes.ACCESS_UNVERIFIED,
          httpStatus: verification.httpStatus != null ? verification.httpStatus : latestHttpStatus,
          retryAfterMs: verification.retryAfterMs || null,
          reason: verification.reason,
        };
      }

      // Accès CONFIRMÉ : persiste la session validée pour les jobs suivants.
      await vCtx.storageState({ path: GLOBAL_SESSION_PATH });
      this.emit('log', { level: 'debug', message: `[warmup] Session validée persistée : ${GLOBAL_SESSION_PATH} (${formatBytes(fs.statSync(GLOBAL_SESSION_PATH).size)})` });
      await vPage.close().catch(() => {});
      await vCtx.close().catch(() => {});
      this.emit('log', { level: 'info', message: `✅ [${verification.httpStatus || 200}] Accès confirmé et session persistée — reprise du scraping invisible.` });
      return { resolved: true, opened: true, verified: true, code: null, httpStatus: verification.httpStatus, retryAfterMs: null, reason: verification.reason };
    } finally {
      await visibleBrowser.close().catch(() => {});
    }
  }

  async capture({ searchUrl, maxPages = 1, outputHarPath }) {
    if (!searchUrl) throw new Error("L'URL de recherche est requise.");
    // Contrôle de destination (SSRF) AVANT tout lancement de navigateur :
    // protocole http(s), pas d'IP privée/locale, et domaine Leboncoin imposé.
    const destCheck = isSafeFetchDestination(searchUrl, LEBONCOIN_SOURCE_HOSTS);
    if (!destCheck.safe) {
      const err = createError(ErrorCodes.NET_CONNECTION_FAILED, `URL de recherche refusée : ${destCheck.reason}`, { url: searchUrl, reason: destCheck.reason });
      throw Object.assign(new Error(err.message), { _code: err.code });
    }
    const targetDir = path.dirname(outputHarPath);
    fs.mkdirSync(targetDir, { recursive: true });
    const statePath = path.join(targetDir, 'session-state.json');

    this.emit('log', { level: 'info', message: `🚀 Initialisation de la capture HAR (${maxPages} page(s))...` });
    this.emit('log', { level: 'debug', message: `[capture] searchUrl=${searchUrl} | maxPages=${maxPages} | outputHarPath=${outputHarPath} | proxy=${this.proxyUrl || 'aucun'} | headless=${this.headless}` });

    let browser;
    let context;
    let page;

    // Suivi honnête de l'état de capture (résultat structuré renvoyé au main).
    let pagesCaptured = 0;
    let blockedCode = null;
    let blockedHttpStatus = null;
    let blockedReason = null;

    try {
      browser = await chromium.launch(this._launchOptions(true));
      this.emit('log', { level: 'debug', message: '[capture] Chromium lancé (headless=true pour la capture).' });

      let globalSessionSaved = false;

      // Pré-check : vérifie réellement l'accès avant la boucle HAR. Si l'accès
      // n'est PAS confirmé (refus 403, limitation 429, session non validée),
      // on N'entre PAS dans la boucle de capture : lancer la capture produirait
      // un HAR vide et un faux « succès ».
      const warmupResult = await this._warmupSession(browser, buildPageUrl(searchUrl, 1));
      if (this.isCancelled) {
        this.emit('log', { level: 'debug', message: '[capture] Capture annulée après pré-check (isCancelled=true).' });
        await browser.close().catch(() => {});
        return { harPath: outputHarPath, pagesCaptured: 0, blocked: false, cancelled: true, blockedCode: null, httpStatus: null, retryAfterMs: null, note: 'annulé' };
      }
      if (warmupResult && warmupResult.verified === false) {
        this.emit('log', { level: 'warn', message: `[capture] Accès NON confirmé après vérification (${warmupResult.code || 'ACCESS_UNVERIFIED'}) — capture annulée sans lancer de scraping.` });
        await browser.close().catch(() => {});
        return {
          harPath: outputHarPath,
          pagesCaptured: 0,
          blocked: true,
          cancelled: false,
          blockedCode: warmupResult.code || ErrorCodes.ACCESS_UNVERIFIED,
          httpStatus: warmupResult.httpStatus != null ? warmupResult.httpStatus : null,
          retryAfterMs: warmupResult.retryAfterMs || null,
          note: warmupResult.reason || 'accès non confirmé',
        };
      }

      // Délai entre warmup et capture pour laisser le rate-limiter se réinitialiser.
      this.emit('log', { level: 'debug', message: '[capture] Délai de sécurité (2s) après warmup pour éviter le rate-limit Leboncoin.' });
      await sleep(2000);

      const contextOptions = this._baseContextOptions({
        recordHar: {
          path: outputHarPath,
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

      for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
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
          const resp = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
          const httpStatus = resp ? resp.status() : null;
          this.emit('log', { level: 'debug', message: `[Page ${pageNum}] Page chargée — HTTP ${httpStatus ?? '?'}.` });

          // Best-effort networkidle avant la détection CAPTCHA.
          await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

          // DÉTECTION DE BLOCAGE : CAPTCHA (texte/iframe/URL) OU HTTP >= 400.
          const captchaBlocked = await this._checkCaptcha(page);
          const httpBlocked = typeof httpStatus === 'number' && httpStatus >= 400;

          if (!captchaBlocked && !httpBlocked) {
            // Page exploitée : on incrémente le compteur AVANT de sauver la
            // session globale (sauvegarde uniquement sur page réellement réussie).
            pagesCaptured++;
            if (!globalSessionSaved) {
              await context.storageState({ path: GLOBAL_SESSION_PATH }).catch((e) => {
                this.emit('log', { level: 'warn', message: `[capture] Sauvegarde session globale impossible après page ${pageNum} : ${e.message}` });
              });
              globalSessionSaved = true;
              this.emit('log', { level: 'debug', message: `[capture] Session globale sauvegardée après page ${pageNum} (HTTP ${httpStatus}).` });
            }
          } else {
            const reason = httpBlocked ? `HTTP ${httpStatus}` : 'CAPTCHA';
            const blockCode = httpBlocked
              ? (httpStatus === 403 ? ErrorCodes.HTTP_ACCESS_REFUSED : httpStatus === 429 ? ErrorCodes.HTTP_RATE_LIMITED : ErrorCodes.HTTP_UNKNOWN)
              : ErrorCodes.CAPTCHA_DETECTED;
            this.emit('log', { level: 'warn', message: `⚠️ [Page ${pageNum}] [${blockCode}] Blocage détecté (${reason}) — vérification interactive...` });

            // Ferme le contexte HAR, ouvre une fenêtre visible de vérification.
            await page.close().catch(() => {});
            await context.close().catch(() => {});
            context = null;
            page = null;
            await browser.close().catch(() => {});
            browser = null;

            this.emit('log', { level: 'info', message: '[capture] Ouverture de la fenêtre de vérification (pendant la capture)...' });
            const retryBrowser = await chromium.launch(this._launchOptions(true));
            let retryResult = null;
            try {
              retryResult = await this._warmupSession(retryBrowser, buildPageUrl(searchUrl, pageNum));
            } finally {
              await retryBrowser.close().catch(() => {});
            }

            if (this.isCancelled) {
              this.emit('log', { level: 'debug', message: '[capture] Capture annulée pendant la vérification.' });
              return { harPath: outputHarPath, pagesCaptured, blocked: false, cancelled: true, blockedCode: null, httpStatus: null, retryAfterMs: null, note: 'annulé' };
            }

            // L'accès n'est repris QUE s'il est réellement confirmé. Sinon on
            // arrête la capture sans relancer de requête (pas de boucle).
            if (!retryResult || retryResult.verified !== true) {
              blockedCode = (retryResult && retryResult.code) || blockCode;
              blockedHttpStatus = (retryResult && retryResult.httpStatus != null) ? retryResult.httpStatus : (typeof httpStatus === 'number' ? httpStatus : null);
              blockedReason = (retryResult && retryResult.reason) || reason;
              this.emit('log', { level: 'warn', message: `[capture] Accès toujours non confirmé (${blockedCode}) — arrêt de la capture sans nouvelle tentative.` });
              break;
            }

            // Accès confirmé : relance le navigateur + contexte HAR et reprend.
            browser = await chromium.launch(this._launchOptions(true));
            const retryCtxOpts = this._baseContextOptions({
              recordHar: { path: outputHarPath, mode: 'full', urlFilter: /recherche|api|items/i },
            });
            if (fs.existsSync(GLOBAL_SESSION_PATH)) {
              retryCtxOpts.storageState = GLOBAL_SESSION_PATH;
              this.emit('log', { level: 'info', message: '🔑 Session validée chargée pour reprise de capture.' });
            }
            ({ ctx: context, p: page } = await this._newStealthContext(browser, retryCtxOpts));
            this.emit('log', { level: 'info', message: `[capture] Reprise après confirmation d'accès — page ${pageNum}.` });
            const retryResp = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch((e) => {
              this.emit('log', { level: 'warn', message: `[Page ${pageNum}] Reprise échouée : ${e.message}` });
            });
            const retryStatus = retryResp ? retryResp.status() : null;
            this.emit('log', { level: 'debug', message: `[Page ${pageNum}] Reprise — HTTP ${retryStatus ?? '?'}.` });
            if (typeof retryStatus === 'number' && retryStatus < 400) pagesCaptured++;
            else {
              blockedCode = typeof retryStatus === 'number' && retryStatus === 403 ? ErrorCodes.HTTP_ACCESS_REFUSED : (typeof retryStatus === 'number' && retryStatus === 429 ? ErrorCodes.HTTP_RATE_LIMITED : ErrorCodes.ACCESS_UNVERIFIED);
              blockedHttpStatus = typeof retryStatus === 'number' ? retryStatus : null;
              blockedReason = `reprise HTTP ${retryStatus ?? '?'}`;
              break;
            }
          }
        } catch (gotoErr) {
          this.emit('log', { level: 'warn', message: `[Page ${pageNum}] Avertissement : ${gotoErr.message}` });
          this.emit('log', { level: 'debug', message: `[capture] Détail erreur page ${pageNum} : ${describeError(gotoErr)}` });
        }

        if (pageNum < maxPages) {
          const minDelay = this.minPageDelayMs;
          const maxDelay = Math.max(this.maxPageDelayMs, minDelay);
          await sleep(minDelay + Math.random() * (maxDelay - minDelay));
        }
      }

      this.emit('log', { level: 'info', message: 'Finalisation et sauvegarde de la session...' });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

      // Session locale (par-job) : toujours sauvegardée pour le pipeline d'enrichissement.
      // La session globale a déjà été sauvegardée après la 1ère page réellement réussie.
      await context.storageState({ path: statePath });
      await context.close();
      await browser.close();
      browser = null;
      this.emit('log', { level: 'info', message: `✅ Session synchronisée (${pagesCaptured} page(s) exploitée(s)).` });

      // Diagnostic final : taille du HAR généré.
      let harSize = null;
      if (fs.existsSync(outputHarPath)) {
        harSize = fs.statSync(outputHarPath).size;
        this.emit('log', { level: 'debug', message: `[capture] HAR généré : ${outputHarPath} (${formatBytes(harSize)}).` });
      } else {
        this.emit('log', { level: 'warn', message: `[capture] ⚠️ Le fichier HAR n'a pas été créé : ${outputHarPath}` });
      }

      return {
        harPath: outputHarPath,
        pagesCaptured,
        // « blocked » = AUCUNE page exploitable. Si des pages ont été capturées
        // avant le blocage, on laisse le pipeline traiter le HAR partiel (les
        // annonces valides sont préservées) ; le blocage sera traité côté
        // enrichissement.
        blocked: blockedCode != null && pagesCaptured === 0,
        cancelled: false,
        blockedCode,
        httpStatus: blockedHttpStatus,
        retryAfterMs: null,
        note: blockedReason,
        harSize,
      };
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