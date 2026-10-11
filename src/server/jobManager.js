'use strict';

/**
 * JobManager — orchestrateur des tâches de scraping côté serveur.
 *
 * Réutilise le MOTEUR EXISTANT (aucune simulation) :
 *   - HarCapturer   (capture réseau/HAR + session + détection CAPTCHA)
 *   - PipelineRunner(fork de leboncoin-pipeline.js : extraction, normalisation,
 *                    déduplication, enrichissement, exports JSON/TXT)
 *
 * Responsabilités serveur :
 *   - file d'attente (queued) + limites de concurrence (globale + par utilisateur) ;
 *   - états explicites : queued, running, completed, partial, failed, cancelled,
 *     action_required ;
 *   - progression cohérente (jamais 100 % avant la fin effective) ;
 *   - logs persistés + diffusés (SSE) ;
 *   - annulation coopérative (aucun processus/Chromium orphelin) ;
 *   - isolation par utilisateur (dossiers de travail séparés).
 *
 * Ce module n'importe PAS `electron`.
 */

const fs = require('fs');
const path = require('path');

const { HarCapturer } = require('../main/services/scraping/harCapturer');
const { PipelineRunner } = require('../main/services/scraping/pipelineRunner');
const { EventEmitter } = require('events');
const { getProfileFields } = require('../main/services/exporting/dataProfiles');
const { readWithChecksum } = require('../main/utils/integrity');
const { formatBytes } = require('../main/utils/diagnostics');
const { JobEvents } = require('./logBus');
const { newId } = require('./db');

const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled', 'action_required']);

class JobManager {
  /**
   * @param {object} deps
   * @param {Repository} deps.repo
   * @param {object} deps.config
   * @param {JobEvents} [deps.events]
   */
  constructor(deps) {
    this.repo = deps.repo;
    this.config = deps.config;
    this.events = deps.events || new JobEvents();
    // Fabriques du moteur de scraping : permettent l'injection d'un moteur
    // factice dans les tests (données contrôlées, sans réseau ni Chromium)
    // tout en utilisant le VRAI moteur en production.
    this.captureFactory = deps.captureFactory || ((opts) => new HarCapturer(opts));
    this.runnerFactory = deps.runnerFactory || (() => new PipelineRunner());
    this.queue = [];
    this.active = new Map(); // jobId -> { capturer, runner, cancel, timer }
    this._draining = false;
    this._shuttingDown = false;
  }

  // ─── Création ───────────────────────────────────────────────────────────────

  createJob(userId, jobConfig) {
    // Limites de ressources : concurrence active par utilisateur + globale.
    const activeForUser = this.repo.countActiveJobsForUser(userId);
    if (activeForUser >= this.config.maxJobsPerUser) {
      const err = new Error(`Limite atteinte : ${this.config.maxJobsPerUser} tâche(s) active(s) maximum par utilisateur.`);
      err.statusCode = 429;
      throw err;
    }
    const jobId = newId('job');
    const job = this.repo.createJob({
      id: jobId,
      user_id: userId,
      status: 'queued',
      search_url: jobConfig.searchUrl,
      pages: jobConfig.pages,
      limit_ads: jobConfig.limit,
      no_desc: jobConfig.noDesc,
      proxy_url: jobConfig.proxyUrl,
      profile_id: jobConfig.profileId,
      export_fields: jobConfig.exportFields,
      include_seller_data: jobConfig.includeSellerData,
      speed: jobConfig.speed,
      message: 'En file d\'attente',
    });
    this.queue.push(jobId);
    this._log(jobId, 'info', `Tâche créée (profil=${jobConfig.profileId}, pages=${jobConfig.pages}, vitesse=${jobConfig.speed}).`);
    // Planifie l'exécution (asynchrone : la réponse HTTP ne dépend pas du scraping).
    setImmediate(() => this._drain());
    return job;
  }

  // ─── File d'attente ────────────────────────────────────────────────────────

  _drain() {
    if (this._shuttingDown) return;
    while (this.queue.length > 0 && this.active.size < this.config.globalMaxConcurrency) {
      const jobId = this.queue.shift();
      const job = this.repo.getJob(jobId);
      if (!job) continue;
      if (job.status !== 'queued') continue; // annulé/supprimé entre-temps
      this._runJob(job).catch((err) => {
        // Ne doit jamais rejeter silencieusement : la tâche est marquée failed.
        try {
          this._log(jobId, 'error', `Erreur interne non gérée : ${err.message}`);
          this._finalize(jobId, 'failed', `Erreur interne : ${err.message}`);
        } catch { /* best-effort */ }
      });
    }
  }

  // ─── Exécution d'une tâche ─────────────────────────────────────────────────

  async _runJob(job) {
    const jobId = job.id;
    const userId = job.user_id;
    const jobDir = path.join(this.config.jobsRootDir, userId, jobId);
    const resultsDir = path.join(jobDir, 'results');
    const harPath = path.join(jobDir, 'capture.har');
    fs.mkdirSync(resultsDir, { recursive: true });

    // Session Playwright par utilisateur : la session globale n'est JAMAIS
    // partagée entre utilisateurs (isolation + pas de fuite de cookies).
    const userSessionDir = path.join(this.config.sessionsDir, userId);
    fs.mkdirSync(userSessionDir, { recursive: true });
    const globalSessionPath = path.join(userSessionDir, 'global-session.json');

    const cancel = { cancelled: false };
    const ctx = { capturer: null, runner: null, cancel, timer: null };
    this.active.set(jobId, ctx);

    this.repo.updateJob(jobId, { status: 'running', progress: 2, message: 'Capture HAR en cours…', started_at: new Date().toISOString(), job_dir: jobDir, results_dir: resultsDir });
    this._emitStatus(jobId);

    const t0 = Date.now();
    let adsCount = 0;
    let duplicateCount = 0;
    let finalStatus = 'completed';
    let finalMessage = '';
    let errorCode = null;

    try {
      // Timeout global de la tâche (anti-blocage).
      const timeout = setTimeout(() => {
        this._log(jobId, 'error', `Délai maximal dépassé (${Math.round(this.config.jobTimeoutMs / 60000)} min) — arrêt de la tâche.`);
        ctx.timedOut = true;
        this.cancel(jobId, 'timeout');
      }, this.config.jobTimeoutMs);
      ctx.timer = timeout;

      // ── Phase 1 : capture HAR (avec pré-check session + CAPTCHA) ──
      const capturer = this.captureFactory({
        proxyUrl: job.proxy_url || null,
        headless: this.config.headless,
        allowVisibleCaptcha: this.config.allowVisibleCaptcha,
        minPageDelayMs: this.config.defaultPageDelayMs,
        maxPageDelayMs: this.config.defaultPageDelayMs + 700,
        globalSessionPath,
      });
      ctx.capturer = capturer;

      capturer.on('log', (entry) => this._log(jobId, entry.level || 'info', entry.message));
      capturer.on('progress', ({ currentPage, totalPages, percent, status }) => {
        // La capture représente ~25 % de la progression (comme l'app Electron).
        this._progress(jobId, Math.round((percent || 0) * 0.25), `[HAR] ${status || ''}`);
      });

      const captureUserAgent = capturer.getUserAgent();

      try {
        await capturer.capture({
          searchUrl: job.search_url,
          maxPages: job.pages,
          outputHarPath: harPath,
        });
      } catch (capErr) {
        // L'annulation utilisateur prime sur toute autre classification :
        // une capture interrompue peut produire un message « non validée »
        // (CAPTCHA) qui ne doit PAS être confondu avec action_required.
        if (cancel.cancelled) {
          throw Object.assign(new Error('Tâche annulée par l\'utilisateur.'), { _cancelled: true });
        }
        const msg = capErr && capErr.message ? capErr.message : String(capErr);
        // CAPTCHA non résolvable en headless → action humaine requise.
        if (/captcha_required|non validée/i.test(msg)) {
          finalStatus = 'action_required';
          finalMessage = 'CAPTCHA détecté : une intervention humaine est requise. La résolution manuelle n\'est pas disponible en mode serveur headless.';
          errorCode = 'CAPTCHA_UNRESOLVED';
        }
        throw capErr;
      } finally {
        ctx.capturer = null;
      }

      if (cancel.cancelled) throw Object.assign(new Error('Tâche annulée par l\'utilisateur.'), { _cancelled: true });

      // ── Phase 2 : pipeline d'extraction/enrichissement (sous-processus) ──
      this._progress(jobId, 30, 'Extraction et enrichissement des annonces…');
      this.repo.updateJob(jobId, { status: 'running', progress: 30, message: 'Extraction et enrichissement des annonces…' });
      this._emitStatus(jobId);

      const profileFields = getProfileFields(job.profile_id, job.export_fields ? JSON.parse(job.export_fields) : null);
      const runner = this.runnerFactory();
      ctx.runner = runner;
      runner.on('log', (entry) => this._log(jobId, entry.level || 'info', entry.message));
      runner.on('progress', ({ percent, status }) => {
        // Le pipeline occupe 30 → 99 %.
        const mapped = 30 + Math.round((percent || 0) * 0.69);
        this._progress(jobId, Math.min(99, mapped), status || '');
      });

      let pipelineExit = 0;
      try {
        pipelineExit = await runner.run({
          harPath,
          outDir: resultsDir,
          noDesc: job.no_desc === 1,
          limit: job.limit_ads || undefined,
          speed: job.speed,
          headless: true,
          userAgent: captureUserAgent,
          profileId: job.profile_id,
          profileFields,
          includeSellerData: job.include_seller_data !== 0,
          baseOutDir: this.config.baseOutDir,
        });
      } catch (pipeErr) {
        const msg = pipeErr && pipeErr.message ? pipeErr.message : String(pipeErr);
        if (/HTTP_ACCESS_REFUSED|403/.test(msg)) { errorCode = 'HTTP_ACCESS_REFUSED'; }
        else if (/HTTP_RATE_LIMITED|429/.test(msg)) { errorCode = 'HTTP_RATE_LIMITED'; }
        else if (/PARSE_NO_ADS/.test(msg)) { errorCode = 'PARSE_NO_ADS'; }
        else { errorCode = 'PIPELINE_ERROR'; }
        throw pipeErr;
      } finally {
        ctx.runner = null;
      }

      if (pipelineExit === 130 || cancel.cancelled) {
        throw Object.assign(new Error('Tâche annulée par l\'utilisateur.'), { _cancelled: true });
      }

      // ── Phase 3 : lecture des résultats ──
      const jsonPath = path.join(resultsDir, 'annonces.json');
      if (fs.existsSync(jsonPath)) {
        const { data, valid } = readWithChecksum(jsonPath);
        if (valid && Array.isArray(data)) {
          adsCount = data.length;
          duplicateCount = 0;
        } else {
          this._log(jobId, 'warn', 'annonces.json illisible (checksum/format) — compteurs approximatifs.');
        }
      } else {
        this._log(jobId, 'warn', 'annonces.json introuvable après le pipeline.');
      }

      if (pipelineExit === 3 || errorCode === 'HTTP_ACCESS_REFUSED') {
        finalStatus = 'partial';
        finalMessage = `Succès partiel : ${adsCount} annonce(s) conservée(s). Accès refusé (HTTP 403) pendant l'enrichissement — certaines descriptions manquent.`;
        errorCode = 'HTTP_ACCESS_REFUSED';
      } else if (pipelineExit === 4 || errorCode === 'HTTP_RATE_LIMITED') {
        finalStatus = 'partial';
        finalMessage = `Succès partiel : ${adsCount} annonce(s) conservée(s). Requête limitée (HTTP 429) pendant l'enrichissement.`;
        errorCode = 'HTTP_RATE_LIMITED';
      } else if (adsCount === 0) {
        finalStatus = 'partial';
        finalMessage = 'Aucune annonce extraite (0 résultat) — vérifiez l\'URL de recherche ou réessayez plus tard.';
        errorCode = 'PARSE_NO_ADS';
      } else {
        finalStatus = 'completed';
        finalMessage = `Scraping terminé : ${adsCount} annonce(s).`;
      }

      this._log(jobId, 'info', finalMessage);
      this._finalize(jobId, finalStatus, finalMessage, { ads_count: adsCount, duplicate_count: duplicateCount, error_code: errorCode });
    } catch (err) {
      const isCancel = (err && err._cancelled) || cancel.cancelled;
      if (ctx.timedOut) {
        // Un dépassement de délai est un ÉCHEC, pas une annulation utilisateur.
        const m = `Échec : délai maximal dépassé (${Math.round(this.config.jobTimeoutMs / 60000)} min).`;
        this._log(jobId, 'error', m);
        this._finalize(jobId, 'failed', m, { error_code: 'JOB_TIMEOUT' });
      } else if (isCancel) {
        this._log(jobId, 'warn', '⏹️ Tâche annulée.');
        this._finalize(jobId, 'cancelled', 'Tâche annulée par l\'utilisateur.');
      } else if (finalStatus === 'action_required') {
        this._log(jobId, 'warn', finalMessage);
        this._finalize(jobId, 'action_required', finalMessage, { error_code: errorCode });
      } else {
        // Résultats partiels éventuels (annonces.json écrit avant l'échec).
        let partialAds = 0;
        const partialJson = path.join(resultsDir, 'annonces.json');
        if (fs.existsSync(partialJson)) {
          const r = readWithChecksum(partialJson);
          if (r.valid && Array.isArray(r.data)) partialAds = r.data.length;
        }
        if (partialAds > 0) {
          const m = `Succès partiel : ${partialAds} annonce(s) conservée(s). ${err.message}`;
          this._log(jobId, 'warn', m);
          this._finalize(jobId, 'partial', m, { ads_count: partialAds, error_code: errorCode || 'PARTIAL' });
        } else {
          const m = `Échec : ${err.message}`;
          this._log(jobId, 'error', m);
          this._finalize(jobId, 'failed', m, { error_code: errorCode || 'JOB_FAILED' });
        }
      }
    } finally {
      const ctx2 = this.active.get(jobId);
      if (ctx2 && ctx2.timer) clearTimeout(ctx2.timer);
      this.active.delete(jobId);
      // Ferme le navigateur/processus si encore ouvert (aucun orphelin).
      try { ctx.capturer && ctx.capturer.stop(); } catch { /* noop */ }
      try { ctx.runner && ctx.runner.stop(); } catch { /* noop */ }
      this._cleanupHar(jobId, jobDir);
      this._log(jobId, 'debug', `Tâche ${jobId} terminée en ${Math.round((Date.now() - t0) / 1000)}s.`);
      // Réveille la file (une place s'est libérée).
      setImmediate(() => this._drain());
    }
  }

  // ─── Annulation ────────────────────────────────────────────────────────────

  /**
   * Demande l'annulation d'une tâche. Coopératif : arrête la capture HAR et
   * envoie SIGINT au pipeline forké (qui écrit ses résultats partiels et ferme
   * son navigateur).
   * @returns {boolean} true si la tâche existait et pouvait être annulée
   */
  cancel(jobId, reason) {
    const job = this.repo.getJob(jobId);
    if (!job) return false;
    if (TERMINAL.has(job.status)) return false;
    this.repo.requestCancel(jobId);
    const ctx = this.active.get(jobId);
    if (ctx) {
      ctx.cancel.cancelled = true;
      this._log(jobId, 'warn', `⏹️ Demande d'arrêt${reason ? ` (${reason})` : ''} — arrêt en cours…`);
      try { ctx.runner && ctx.runner.stop(); } catch { /* noop */ }
      try { ctx.capturer && ctx.capturer.stop(); } catch { /* noop */ }
    } else {
      // Encore en file : retirée et marquée annulée.
      this.queue = this.queue.filter((id) => id !== jobId);
      this._finalize(jobId, 'cancelled', 'Tâche annulée avant exécution.');
    }
    return true;
  }

  // ─── Helpers internes ──────────────────────────────────────────────────────

  _finalize(jobId, status, message, extra) {
    const patch = { status, message, progress: status === 'completed' ? 100 : undefined, finished_at: new Date().toISOString() };
    if (extra) {
      if (extra.ads_count != null) patch.ads_count = extra.ads_count;
      if (extra.duplicate_count != null) patch.duplicate_count = extra.duplicate_count;
      if (extra.error_code !== undefined) patch.error_code = extra.error_code;
    }
    // Progression finale cohérente : jamais 100 % sur un échec/annulation.
    if (status === 'partial' || status === 'failed' || status === 'cancelled' || status === 'action_required') {
      patch.progress = undefined; // conserve la dernière valeur réelle
    }
    this.repo.updateJob(jobId, patch);
    this._emitStatus(jobId);
  }

  _progress(jobId, percent, status) {
    const p = Math.max(0, Math.min(99, Math.round(percent)));
    this.repo.updateJob(jobId, { progress: p, message: status || undefined });
    this._emitStatus(jobId, { progress: p, message: status });
  }

  _log(jobId, level, message) {
    if (!message) return;
    this.repo.addLog(jobId, level, message, this.config.logBufferPerJob);
    this.events.publish(jobId, 'log', { level, message, ts: new Date().toISOString() });
  }

  _emitStatus(jobId, extra) {
    const job = this.repo.getJob(jobId);
    if (!job) return;
    const payload = {
      jobId,
      status: job.status,
      progress: job.progress,
      message: job.message,
      adsCount: job.ads_count,
      duplicateCount: job.duplicate_count,
      errorCode: job.error_code,
      updatedAt: job.updated_at,
      ...(extra || {}),
    };
    this.events.publish(jobId, 'status', payload);
  }

  _cleanupHar(jobId, jobDir) {
    // Les HAR sont volumineux : on les supprime immédiatement après le job
    // (les résultats JSON/TXT sont conservés). Configurable.
    if (this.config.harRetentionDays <= 0) return;
    try {
      const harPath = path.join(jobDir, 'capture.har');
      const resumePath = path.join(jobDir, 'capture-resume.har');
      for (const p of [harPath, resumePath]) {
        if (fs.existsSync(p)) {
          const size = fs.statSync(p).size;
          fs.unlinkSync(p);
          this._log(jobId, 'debug', `HAR temporaire supprimé (${formatBytes(size)}).`);
        }
      }
    } catch { /* best-effort */ }
  }

  /** Instantané d'une tâche pour l'API (sans exposer de chemin interne). */
  getJobView(job) {
    if (!job) return null;
    return {
      id: job.id,
      status: job.status,
      searchUrl: job.search_url,
      pages: job.pages,
      limit: job.limit_ads,
      noDesc: job.no_desc === 1,
      profileId: job.profile_id,
      includeSellerData: job.include_seller_data !== 0,
      speed: job.speed,
      progress: job.progress,
      message: job.message,
      adsCount: job.ads_count,
      duplicateCount: job.duplicate_count,
      errorCode: job.error_code,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
    };
  }

  /** Arrêt propre (SIGTERM) : annule toutes les tâches actives. */
  shutdown() {
    this._shuttingDown = true;
    for (const [jobId, ctx] of this.active.entries()) {
      try {
        ctx.cancel.cancelled = true;
        ctx.runner && ctx.runner.stop();
        ctx.capturer && ctx.capturer.stop();
        if (ctx.timer) clearTimeout(ctx.timer);
      } catch { /* noop */ }
      try { this.repo.updateJob(jobId, { status: 'cancelled', message: 'Serveur arrêté.', finished_at: new Date().toISOString() }); } catch { /* noop */ }
    }
    this.active.clear();
    this.queue = [];
  }
}

module.exports = { JobManager, TERMINAL };
