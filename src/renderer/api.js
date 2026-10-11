'use strict';

/**
 * api.js — client API centralisé pour la version Web.
 *
 * Fournit une interface `window.api` COMPATIBLE avec celle exposée par le
 * preload Electron (mêmes noms de méthodes), mais implémentée via REST + SSE.
 * Le reste du renderer (scraperModule, logsModule, explorerModule, …) n'a donc
 * pas à connaître le transport : il continue d'appeler window.api.*.
 *
 * En Electron, `window.api` existe déjà (preload) → ce fichier ne l'écrase PAS.
 *
 * Cartographie Electron → Web :
 *   startScraping(config)  → POST /api/jobs (asynchrone, suit via SSE)
 *   stopScraping()         → POST /api/jobs/:id/cancel
 *   onLog / onProgress / onStatusChange → flux SSE /api/jobs/:id/events
 *   getHistory / getAdHistory / deleteJob → /api/history, /api/ad-history, DELETE
 *   getConfig / saveConfig → /api/config
 *   checkNetwork           → navigator.onLine
 *   checkChromium          → /api/health
 *   getDiagnostics         → /api/diagnostics
 *   openExternal           → window.open
 *   openFile/openFolder    → téléchargement HTTP (web) / no-op expliqué
 *   exportLogs             → téléchargement d'un Blob texte
 *   secret:* / widget:*    → non applicables (no-op)
 */

(function () {
  // Ne remplace pas l'API Electron si elle existe (exécution dans Electron).
  if (typeof window === 'undefined') return;
  if (window.api && window.api.__isElectron) return;
  if (window.api && typeof window.api.getHistory === 'function' && !window.__LBC_FORCE_WEB_API) {
    // Preload Electron présent : on ne touche à rien.
    return;
  }

  const BASE = '/api';

  // ─── Abonnés aux événements (persistants entre les tâches) ────────────────
  const logCbs = [];
  const progressCbs = [];
  const statusCbs = [];

  const state = {
    currentJobId: null,
    es: null,
    lastLogId: 0,
    authEnabled: true,
    user: null,
  };

  async function request(method, path, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, opts);
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try { data = await res.json(); } catch { data = null; }
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Erreur HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ─── Authentification ─────────────────────────────────────────────────────
  async function ensureAuth() {
    try {
      const me = await request('GET', '/auth/me');
      state.user = me.user;
      return true;
    } catch (err) {
      if (err.status === 401) {
        state.authEnabled = true;
        showLoginOverlay();
        return false;
      }
      // Erreur réseau : on laisse l'app se charger, les appels échoueront proprement.
      return false;
    }
  }

  function showLoginOverlay() {
    const overlay = document.getElementById('loginOverlay');
    if (overlay) overlay.classList.remove('hidden');
  }
  function hideLoginOverlay() {
    const overlay = document.getElementById('loginOverlay');
    if (overlay) overlay.classList.add('hidden');
  }

  async function login(email, password) {
    const res = await request('POST', '/auth/login', { email, password });
    state.user = res.user;
    hideLoginOverlay();
    return res.user;
  }
  async function register(email, password) {
    const res = await request('POST', '/auth/register', { email, password });
    state.user = res.user;
    hideLoginOverlay();
    return res.user;
  }
  async function logout() {
    try { await request('POST', '/auth/logout'); } catch { /* noop */ }
    state.user = null;
    location.reload();
  }

  // ─── Suivi d'une tâche (SSE) ──────────────────────────────────────────────
  function openJobStream(jobId, afterId) {
    closeJobStream();
    state.currentJobId = jobId;
    state.lastLogId = afterId || 0;
    const url = `${BASE}/jobs/${encodeURIComponent(jobId)}/events?after=${state.lastLogId}`;
    const es = new EventSource(url, { withCredentials: true });
    state.es = es;

    es.addEventListener('log', (e) => {
      let entry;
      try { entry = JSON.parse(e.data); } catch { return; }
      if (entry.id && entry.id > state.lastLogId) state.lastLogId = entry.id;
      for (const cb of logCbs) { try { cb({ level: entry.level, message: entry.message }); } catch { /* noop */ } }
    });

    es.addEventListener('status', (e) => {
      let payload;
      try { payload = JSON.parse(e.data); } catch { return; }
      const mapped = mapStatus(payload);
      for (const cb of progressCbs) { try { cb(mapped.progress); } catch { /* noop */ } }
      for (const cb of statusCbs) { try { cb(mapped.status); } catch { /* noop */ } }
      if (isTerminal(payload.status)) {
        // Ferme le flux : la tâche est finie.
        setTimeout(closeJobStream, 1500);
      }
    });

    es.onerror = () => {
      // EventSource se reconnecte automatiquement ; si la tâche est terminée,
      // le serveur ferme et on ferme à notre tour.
      if (!state.currentJobId) closeJobStream();
    };
  }

  function closeJobStream() {
    if (state.es) {
      try { state.es.close(); } catch { /* noop */ }
      state.es = null;
    }
  }

  function isTerminal(status) {
    return ['completed', 'partial', 'failed', 'cancelled', 'action_required'].includes(status);
  }

  // Convertit un statut serveur → { progress, status } attendus par le renderer.
  function mapStatus(payload) {
    const s = payload || {};
    const percent = typeof s.progress === 'number' ? s.progress : undefined;
    const stateMap = {
      queued: 'capturing',
      running: 'processing',
      completed: 'completed',
      partial: 'partial',
      failed: 'error',
      cancelled: 'cancelled',
      action_required: 'action_required',
    };
    const rendererState = stateMap[s.status] || s.status;
    return {
      progress: { percent, status: s.message, jobId: s.jobId },
      status: { state: rendererState, message: s.message, jobId: s.jobId, adsCount: s.adsCount },
    };
  }

  // Au chargement, reprend le suivi d'une tâche active (reconnexion).
  async function resumeActiveJob() {
    try {
      const data = await request('GET', '/jobs?limit=5');
      const active = (data.jobs || []).find((j) => ['queued', 'running', 'action_required'].includes(j.status));
      if (active) {
        // Rejoue l'état initial puis s'abonne.
        const mapped = mapStatus({ status: active.status, progress: active.progress, message: active.message, jobId: active.id });
        for (const cb of progressCbs) { try { cb(mapped.progress); } catch { /* noop */ } }
        for (const cb of statusCbs) { try { cb(mapped.status); } catch { /* noop */ } }
        openJobStream(active.id, 0);
      }
    } catch { /* non connecté ou pas de tâche : silencieux */ }
  }

  // ─── API compatible Electron ──────────────────────────────────────────────
  const api = {
    __isElectron: false,
    __isWeb: true,

    async startScraping(config) {
      const res = await request('POST', '/jobs', config);
      state.lastLogId = 0;
      openJobStream(res.job.id, 0);
      return res.job;
    },

    async stopScraping() {
      if (!state.currentJobId) return { ok: false };
      return request('POST', `/jobs/${encodeURIComponent(state.currentJobId)}/cancel`);
    },

    onLog(cb) { logCbs.length = 0; logCbs.push(cb); },
    onProgress(cb) { progressCbs.length = 0; progressCbs.push(cb); },
    onStatusChange(cb) { statusCbs.length = 0; statusCbs.push(cb); },

    async getHistory() {
      const data = await request('GET', '/history');
      return data.jobs || [];
    },
    async getAdHistory() {
      const data = await request('GET', '/ad-history');
      return data.adHistory || [];
    },
    async deleteJob(jobId) {
      try { await request('DELETE', `/jobs/${encodeURIComponent(jobId)}`); return true; }
      catch { return false; }
    },
    async getJob(jobId) {
      const data = await request('GET', `/jobs/${encodeURIComponent(jobId)}`);
      return data.job;
    },
    async getJobLogs(jobId, after, limit) {
      const data = await request('GET', `/jobs/${encodeURIComponent(jobId)}/logs?after=${after || 0}&limit=${limit || 2000}`);
      return data.logs || [];
    },
    async getResults(jobId) {
      return request('GET', `/jobs/${encodeURIComponent(jobId)}/results`);
    },
    async listJobs() {
      const data = await request('GET', '/jobs?limit=100');
      return data.jobs || [];
    },

    // Téléchargements (remplacent l'ouverture de fichiers locaux).
    downloadExport(jobId, format) {
      triggerDownload(`${BASE}/jobs/${encodeURIComponent(jobId)}/export/${format}`);
    },
    downloadLogs(jobId) {
      triggerDownload(`${BASE}/jobs/${encodeURIComponent(jobId)}/export-logs`);
    },

    // Paramètres
    async getConfig() { return request('GET', '/config'); },
    async saveConfig(patch) { return request('POST', '/config', patch); },
    async getProfiles() { return request('GET', '/profiles'); },

    // Diagnostic
    async getDiagnostics() { return request('GET', '/diagnostics'); },
    async checkChromium() {
      try { const h = await request('GET', '/health'); return { ok: !!h.ok, path: null, exists: true, reason: null }; }
      catch (e) { return { ok: false, path: null, exists: false, reason: e.message }; }
    },
    async checkNetwork() { return { online: navigator.onLine !== false }; },

    // Ouverture externe (onglet navigateur).
    async openExternal(url) {
      if (!url) return { success: false };
      try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return { success: false, error: 'Schéma non autorisé.' };
        window.open(url, '_blank', 'noopener,noreferrer');
        return { success: true };
      } catch { return { success: false, error: 'URL invalide.' }; }
    },

    // Sur le web il n'y a pas de fichiers/dossiers locaux : on explique.
    async openFile() { return { success: false, error: 'Sur le Web, utilisez les boutons de téléchargement.' }; },
    async openFolder() { return { success: false, error: 'Les dossiers locaux n\'existent pas dans la version Web.' }; },
    async openJobsFolder() { return { success: false, error: 'Les dossiers locaux n\'existent pas dans la version Web.' }; },

    // Export des logs affichés (Blob texte téléchargé).
    async exportLogs(text) {
      try {
        const blob = new Blob([String(text || '')], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        triggerDownload(url, `logs-session-${Date.now()}.log`, true);
        return { ok: true, path: null };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    // Secrets : gérés côté serveur via variables d'environnement.
    async getSecret() { return null; },
    async setSecret() { return false; },
    async hasSecret() { return false; },
    async removeSecret() { return false; },

    // Widget flottant : inexistant sur le web.
    toggleWidget() { if (window.showToast) window.showToast('Le widget flottant n\'existe pas dans la version Web.', 'info'); },
    sendWidgetProgress() {},
    sendWidgetStatus() {},

    // Auth
    login, register, logout, ensureAuth, resumeActiveJob,
    getUser() { return state.user; },
    _request: request,
  };

  function triggerDownload(url, filename, revoke) {
    const a = document.createElement('a');
    a.href = url;
    if (filename) a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (revoke) setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* noop */ } }, 4000);
  }

  window.api = api;
  window.LBC_API = api;
})();
