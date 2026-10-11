'use strict';

/**
 * authModule.js — amorçage de la version Web.
 *
 * En Electron (window.api.__isElectron), ce module ne fait RIEN.
 * Sur le Web :
 *   - vérifie la session (/api/auth/me) ; affiche l'écran de connexion si 401 ;
 *   - câble connexion / création de compte ;
 *   - reprend le suivi d'une tâche en cours après reconnexion (SSE) ;
 *   - masque les contrôles propres au bureau (widget flottant).
 *
 * L'initialisation est différée à DOMContentLoaded pour que les autres modules
 * (scraperModule, logsModule…) aient déjà attaché leurs écouteurs onProgress /
 * onStatusChange / onLog avant tout rejeu d'état.
 */

(function () {
  const api = window.api;
  if (!api || !api.__isWeb) return; // Electron : rien à faire.

  function $(id) { return document.getElementById(id); }

  function setError(msg) {
    const el = $('loginError');
    if (!el) return;
    if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  async function doLogin() {
    const email = ($('loginEmail') || {}).value || '';
    const password = ($('loginPassword') || {}).value || '';
    setError('');
    if (!email || !password) { setError('Email et mot de passe requis.'); return; }
    try {
      await api.login(email.trim(), password);
      onAuthenticated();
    } catch (err) {
      setError(err.message || 'Connexion impossible.');
    }
  }

  async function doRegister() {
    const email = ($('loginEmail') || {}).value || '';
    const password = ($('loginPassword') || {}).value || '';
    setError('');
    if (!email || !password) { setError('Email et mot de passe requis.'); return; }
    try {
      await api.register(email.trim(), password);
      onAuthenticated();
    } catch (err) {
      setError(err.message || 'Création de compte impossible.');
    }
  }

  function onAuthenticated() {
    const overlay = $('loginOverlay');
    if (overlay) overlay.classList.add('hidden');
    // Reprend le suivi d'une tâche active éventuelle (reconnexion).
    api.resumeActiveJob();
  }

  function webAdaptations() {
    // Le widget flottant est spécifique au bureau.
    const widgetBtn = $('toggleWidgetBtn');
    if (widgetBtn) widgetBtn.classList.add('hidden');
    // Badge hors-ligne : géré par scraperModule (déjà compatible).
  }

  function init() {
    webAdaptations();
    $('loginBtn')?.addEventListener('click', doLogin);
    $('registerBtn')?.addEventListener('click', doRegister);
    $('loginPassword')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doLogin(); }
    });

    api.ensureAuth().then((ok) => {
      if (ok) {
        api.resumeActiveJob();
      }
      // Sinon : l'écran de connexion est déjà affiché.
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
