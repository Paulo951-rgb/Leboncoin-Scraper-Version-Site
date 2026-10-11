// 📶 Mode hors-ligne : détection de connectivité + badge dans l'en-tête.
// L'utilisateur peut consulter les jobs déjà scrapés (lecture disque) mais ne
// peut pas lancer un nouveau scraping ni une analyse IA en ligne.
const offlineBadge = document.getElementById('offlineBadge');

function setOfflineMode(offline) {
  isOffline = offline;
  if (offline) {
    offlineBadge.classList.remove('hidden');
    startBtn.title = 'Indisponible en mode hors-ligne.';
  } else {
    offlineBadge.classList.add('hidden');
    startBtn.title = '';
  }
}

async function refreshConnectivity() {
  try {
    const res = await window.api.checkNetwork();
    setOfflineMode(!res.online);
  } catch {
    setOfflineMode(true);
  }
}

window.addEventListener('online', () => setOfflineMode(false));
window.addEventListener('offline', () => setOfflineMode(true));
setInterval(refreshConnectivity, 60000); // refresh périodique
refreshConnectivity(); // vérification initiale

// 🩺 Vérification du binaire Chromium (Playwright) au démarrage. Sans ce
// binaire, le scraping échoue immédiatement avec « Executable doesn't exist ».
// On affiche un bandeau rouge tant qu'il manque, avec la commande à lancer.
const chromiumWarningEl = document.getElementById('chromiumWarning');
const chromiumWarningRetryBtn = document.getElementById('chromiumWarningRetry');

async function refreshChromiumCheck() {
  if (!window.api || !window.api.checkChromium) return;
  try {
    const res = await window.api.checkChromium();
    if (res && res.ok) {
      // Binaire présent : on masque le bandeau (s'il était affiché).
      if (chromiumWarningEl) chromiumWarningEl.classList.add('hidden');
    } else {
      if (chromiumWarningEl) chromiumWarningEl.classList.remove('hidden');
      if (chromiumWarningRetryBtn) {
        chromiumWarningRetryBtn.textContent = '🔄 Revérifier';
        chromiumWarningRetryBtn.disabled = false;
      }
    }
  } catch (err) {
    // Erreur IPC : on n'affiche pas le bandeau (ne pas alarmer pour un souci
    // de communication), mais on log en console pour le débogage.
    console.warn('[Chromium] Vérification impossible :', err && err.message);
  }
}

if (chromiumWarningRetryBtn) {
  chromiumWarningRetryBtn.addEventListener('click', () => {
    chromiumWarningRetryBtn.textContent = '⏳ Vérification…';
    chromiumWarningRetryBtn.disabled = true;
    refreshChromiumCheck();
  });
}
refreshChromiumCheck(); // vérification initiale

// Proxy
proxyUrl.value = localStorage.getItem('proxy-url') || '';
proxyUrl.addEventListener('change', (e) => localStorage.setItem('proxy-url', e.target.value));

// ─── Profil de données (Défaut / Maximum / Personnalisé) + sélection des champs ──
// Le profil Défaut récupère les champs essentiels (rapide et léger).
// Le profil Maximum récupère toutes les données disponibles techniquement.
// Le profil Personnalisé permet de ne sélectionner que les champs dont
// l'utilisateur a besoin (1 champ, plusieurs, ou quasi-tous).
// Les champs possibles sont listés dans src/main/services/exporting/exportFields.js
const EXPORT_FIELDS = [
  { key: 'id', label: 'ID' },
  { key: 'title', label: 'Titre' },
  { key: 'url', label: 'URL' },
  { key: 'prix', label: 'Prix' },
  { key: 'ville', label: 'Ville' },
  { key: 'codePostal', label: 'Code postal' },
  { key: 'vendeurNom', label: 'Vendeur (nom)' },
  { key: 'vendeurType', label: 'Vendeur (type)' },
  { key: 'vendeurId', label: 'Vendeur (ID)' },
  { key: 'vendeurNote', label: 'Vendeur (note)' },
  { key: 'vendeurNbAvis', label: 'Vendeur (nb avis)' },
  { key: 'vendeurUrlProfil', label: 'Vendeur (URL profil)' },
  { key: 'vendeurAnciennete', label: 'Vendeur (ancienneté)' },
  { key: 'deliveryType', label: 'Type de remise' },
  { key: 'likes', label: 'Likes' },
  { key: 'datePublication', label: 'Date publication' },
  { key: 'dateModification', label: 'Date modification' },
  { key: 'dateScraping', label: 'Date scraping' },
  { key: 'etat', label: 'État déclaré' },
  { key: 'photosCount', label: 'Nombre de photos' },
  { key: 'photosUrls', label: 'URLs des photos' },
  { key: 'description', label: 'Description' },
];

// Descriptions affichées sous les radios selon le profil sélectionné.
const PROFILE_DESCRIPTIONS = {
  default: 'Récupération des données essentielles pour un scraping rapide et léger.',
  maximum: 'Récupération de toutes les données disponibles techniquement.',
  custom: 'Choisissez exactement les champs à récupérer.',
};

const exportModeRadios = document.querySelectorAll('input[name="exportMode"]');
const exportFieldsPanel = document.getElementById('exportFieldsPanel');
const exportFieldsList = document.getElementById('exportFieldsList');
const exportFieldsAll = document.getElementById('exportFieldsAll');
const exportFieldsNone = document.getElementById('exportFieldsNone');
const exportFieldsCount = document.getElementById('exportFieldsCount');
const exportProfileDescription = document.getElementById('exportProfileDescription');

// Persistance localStorage du profil + des champs sélectionnés (clé : lbc-export-config).
const EXPORT_CONFIG_KEY = 'lbc-export-config';
function loadExportConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(EXPORT_CONFIG_KEY) || 'null');
    if (saved && (saved.mode === 'custom' || saved.mode === 'default' || saved.mode === 'maximum')) return saved;
  } catch { /* JSON corrompu : on retombe sur default */ }
  return { mode: 'default', fields: [] };
}
function saveExportConfig() {
  const cfg = {
    mode: getSelectedProfile(),
    fields: getSelectedExportFields(),
  };
  try { localStorage.setItem(EXPORT_CONFIG_KEY, JSON.stringify(cfg)); } catch { /* quota */ }
}
// Retourne le profil sélectionné : 'default', 'maximum' ou 'custom'.
function getSelectedProfile() {
  const el = document.querySelector('input[name="exportMode"]:checked');
  return el ? el.value : 'default';
}
// Alias rétro-compatible pour les tests existants.
function getSelectedExportMode() {
  return getSelectedProfile();
}
function getSelectedExportFields() {
  if (!exportFieldsList) return [];
  return [...exportFieldsList.querySelectorAll('input[type="checkbox"]:checked')]
    .map((cb) => cb.value);
}
function updateExportFieldsCount() {
  if (!exportFieldsCount) return;
  const n = getSelectedExportFields().length;
  exportFieldsCount.textContent = `${n} champ(s) sélectionné(s)`;
}
function renderExportFieldsList() {
  if (!exportFieldsList) return;
  const savedCfg = loadExportConfig();
  const checkedSet = new Set(Array.isArray(savedCfg.fields) ? savedCfg.fields : []);
  exportFieldsList.innerHTML = EXPORT_FIELDS.map((f) => {
    const isChecked = checkedSet.has(f.key) ? 'checked' : '';
    return `<label class="checkbox-label" style="font-size:0.8rem;"><input type="checkbox" value="${f.key}" ${isChecked}> ${escapeHtml(f.label)}</label>`;
  }).join('');
  // Ré-attache les listeners de changement (innerHTML les a effacés)
  exportFieldsList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => { updateExportFieldsCount(); saveExportConfig(); });
  });
  updateExportFieldsCount();
}
// Bascule le profil sélectionné : affiche/masque le panneau de champs et la
// description associée. Le panneau n'est visible qu'en mode Personnalisé.
function setProfile(mode) {
  for (const r of exportModeRadios) r.checked = (r.value === mode);
  if (exportFieldsPanel) exportFieldsPanel.classList.toggle('hidden', mode !== 'custom');
  if (exportProfileDescription) {
    exportProfileDescription.textContent = PROFILE_DESCRIPTIONS[mode] || PROFILE_DESCRIPTIONS.default;
  }
  saveExportConfig();
}
// Alias rétro-compatible pour les tests existants.
function setExportMode(mode) {
  setProfile(mode);
}
if (exportModeRadios && exportModeRadios.length > 0) {
  for (const r of exportModeRadios) {
    r.addEventListener('change', () => setProfile(r.value));
  }
}
if (exportFieldsAll) {
  exportFieldsAll.addEventListener('click', () => {
    if (!exportFieldsList) return;
    for (const cb of exportFieldsList.querySelectorAll('input[type="checkbox"]')) cb.checked = true;
    updateExportFieldsCount(); saveExportConfig();
  });
}
if (exportFieldsNone) {
  exportFieldsNone.addEventListener('click', () => {
    if (!exportFieldsList) return;
    for (const cb of exportFieldsList.querySelectorAll('input[type="checkbox"]')) cb.checked = false;
    updateExportFieldsCount(); saveExportConfig();
  });
}
renderExportFieldsList();
// Restaure le profil sauvegardé
setProfile(loadExportConfig().mode);

// Presets
const presetsRow = document.getElementById('presetsRow');
const savePresetBtn = document.getElementById('savePresetBtn');

function renderPresets() {
  if (presets.length === 0) {
    presetsRow.innerHTML = '<span class="text-muted font-small">Aucun modèle enregistré.</span>';
    return;
  }
  presetsRow.innerHTML = presets
    .map(
      (p, i) => `
    <div class="preset-chip" onclick="loadPreset(${i})">
      📌 ${escapeHtml(p.name)}
      <span style="color:#ef4444; margin-left:4px;" onclick="event.stopPropagation(); deletePreset(${i})">✕</span>
    </div>
  `
    )
    .join('');
}

// Capture l'intégralité de la configuration de recherche (URL + pages + limite
// + options + proxy) afin qu'un preset soit réellement une restauration « 1-clic »
// de la recherche, et pas seulement URL + pages.
function collectSearchConfig() {
  return {
    searchUrl: document.getElementById('searchUrl').value.trim(),
    pages: document.getElementById('pages').value,
    limit: document.getElementById('limit').value,
    noDesc: document.getElementById('noDesc').checked,
    proxyUrl: proxyUrl.value.trim(),
  };
}

// Applique une configuration de recherche sauvegardée dans le formulaire.
// Les champs manquants (presets anciens) retombent sur les valeurs actuelles.
function applySearchConfig(cfg) {
  if (!cfg) return;
  if (cfg.searchUrl) document.getElementById('searchUrl').value = cfg.searchUrl;
  if (cfg.pages != null) document.getElementById('pages').value = cfg.pages;
  if (cfg.limit != null) document.getElementById('limit').value = cfg.limit;
  if (cfg.noDesc != null) document.getElementById('noDesc').checked = cfg.noDesc;
  if (cfg.proxyUrl != null) {
    proxyUrl.value = cfg.proxyUrl;
    localStorage.setItem('proxy-url', cfg.proxyUrl);
  }
}

// Enregistrement d'un preset : `window.prompt()` n'est PAS supporté par Electron
// (il ne s'affiche pas et lève une erreur) → le bouton « Sauvegarder comme Preset »
// était totalement non fonctionnel. On utilise une modale dédiée à la place.
const presetModal = document.getElementById('presetModal');
const presetNameInput = document.getElementById('presetNameInput');
const presetConfirmBtn = document.getElementById('presetConfirmBtn');
const presetCancelBtn = document.getElementById('presetCancelBtn');

function closePresetModal() {
  if (presetModal) presetModal.classList.add('hidden');
}

savePresetBtn.addEventListener('click', () => {
  const cfg = collectSearchConfig();
  if (!cfg.searchUrl) return showToast('Veuillez entrer une URL de recherche.', 'warn');
  if (!presetModal || !presetNameInput) return;
  presetNameInput.value = 'Ma Recherche';
  presetModal.classList.remove('hidden');
  presetNameInput.focus();
  presetNameInput.select();
});

if (presetConfirmBtn) {
  presetConfirmBtn.addEventListener('click', () => {
    const name = (presetNameInput?.value || '').trim();
    if (!name) { presetNameInput?.focus(); return; }
    presets.push({ name, ...collectSearchConfig() });
    try { localStorage.setItem('search-presets', JSON.stringify(presets)); } catch { /* quota */ }
    renderPresets();
    closePresetModal();
  });
}
if (presetCancelBtn) presetCancelBtn.addEventListener('click', closePresetModal);
if (presetNameInput) {
  presetNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); presetConfirmBtn?.click(); }
    if (e.key === 'Escape') { e.preventDefault(); closePresetModal(); }
  });
}
if (presetModal) {
  presetModal.addEventListener('click', (e) => { if (e.target === presetModal) closePresetModal(); });
}

window.loadPreset = (i) => {
  const p = presets[i];
  if (!p) return;
  // L'ordre est important : les clés explicites écrasent les résidus du spread.
  // L'ancienne version re-spreadait l'objet preset APRÈS searchUrl, donc la clé
  // historique `url` écrasait `searchUrl` → le champ URL restait inchangé.
  applySearchConfig({
    searchUrl: p.searchUrl || p.url,
    pages: p.pages,
    limit: p.limit,
    noDesc: p.noDesc,
    proxyUrl: p.proxyUrl,
  });
};

window.deletePreset = (i) => {
  presets.splice(i, 1);
  localStorage.setItem('search-presets', JSON.stringify(presets));
  renderPresets();
};

renderPresets();

// Comparateur
const openCompareModalBtn = document.getElementById('openCompareModalBtn');
const closeCompareModalBtn = document.getElementById('closeCompareModalBtn');
const compareGrid = document.getElementById('compareGrid');
const compareCount = document.getElementById('compareCount');

window.toggleCompare = (adId) => {
  const idStr = String(adId);
  if (compareSet.has(idStr)) compareSet.delete(idStr);
  else compareSet.add(idStr);
  compareCount.textContent = compareSet.size;
};

openCompareModalBtn.addEventListener('click', () => {
  if (compareSet.size === 0) return showToast('Sélectionnez au moins 1 annonce avec les cases ☑️ pour comparer.', 'warn');

  const seenIds = new Set();
  const selectedAds = [];
  allJobsCache.forEach((j) => {
    if (Array.isArray(j.ads)) {
      j.ads.forEach((a) => {
        const idStr = String(a.id);
        if (compareSet.has(idStr) && !seenIds.has(idStr)) {
          seenIds.add(idStr);
          selectedAds.push(a);
        }
      });
    }
  });

  compareGrid.innerHTML = selectedAds
    .map((a) => {
      const sellerName = includeSellerData ? (a.vendeurNom || a.seller || 'Particulier') : 'Masqué';
      const priceText = a.prix != null ? a.prix + ' €' : (a.price != null ? a.price + ' €' : '-');
      const thumb = (a.photosUrls && a.photosUrls[0]) || (a.images && a.images[0]) || noPhotoUrl();
      return `
      <div class="compare-col">
        <img src="${escapeHtml(thumb)}" style="width:100%; height:140px; object-fit:cover; border-radius:6px;">
        <strong>${escapeHtml(a.title || a.titre || 'Sans titre')}</strong>
        <div style="font-size:1.2rem; font-weight:bold; color:var(--primary-color);">${escapeHtml(priceText)}</div>
        <div style="font-size:0.8rem;">Vendeur : ${escapeHtml(sellerName)}</div>
        <button class="btn btn-primary btn-small" onclick="openUrl('${escapePath(a.url)}')">🔗 Voir Leboncoin</button>
      </div>
    `;
    })
    .join('');

  compareModal.classList.remove('hidden');
});

closeCompareModalBtn.addEventListener('click', () => compareModal.classList.add('hidden'));

// Widget Flottant — fenêtre always-on-top qui affiche la progression du scraping
// Feedback visuel : le bouton bascule en état "actif" tant que le widget est ouvert.
const toggleWidgetBtn = document.getElementById('toggleWidgetBtn');
toggleWidgetBtn.addEventListener('click', () => {
  window.api.toggleWidget();
  widgetActive = !widgetActive;
  toggleWidgetBtn.classList.toggle('btn-active', widgetActive);
  toggleWidgetBtn.title = widgetActive ? 'Widget flottant ouvert — cliquez pour fermer' : 'Ouvrir le widget flottant';
});

// Modal Paramètres
const openSettingsModalBtn = document.getElementById('openSettingsModalBtn');
const closeSettingsModalBtn = document.getElementById('closeSettingsModalBtn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const resetSettingsBtn = document.getElementById('resetSettingsBtn');
const cfgTheme = document.getElementById('cfgTheme');
const cfgScrapeSpeed = document.getElementById('cfgScrapeSpeed');
const cfgPageDelay = document.getElementById('cfgPageDelay');
const cfgHeadless = document.getElementById('cfgHeadless');
const cfgIncludeSellerData = document.getElementById('cfgIncludeSellerData');
const cfgCleanHarDays = document.getElementById('cfgCleanHarDays');
const cfgAutoCleanJobs = document.getElementById('cfgAutoCleanJobs');
const cfgAutoCleanJobsDays = document.getElementById('cfgAutoCleanJobsDays');
const cfgLogRetention = document.getElementById('cfgLogRetention');

function applySettingsToUI(cfg) {
  cfgTheme.value = localStorage.getItem('app-theme') || cfg.theme || 'theme-dark';
  cfgScrapeSpeed.value = cfg.scrapeSpeed || 'moyen';
  cfgPageDelay.value = cfg.pageDelayMs ?? 1000;
  cfgHeadless.checked = cfg.headless !== false;
  if (cfgIncludeSellerData) cfgIncludeSellerData.checked = cfg.includeSellerData !== false;
  cfgCleanHarDays.value = cfg.autoCleanHarDays || 7;
  const jobsDays = cfg.autoCleanJobsDays || 0;
  cfgAutoCleanJobs.checked = jobsDays > 0;
  cfgAutoCleanJobsDays.value = jobsDays > 0 ? jobsDays : 30;
  cfgAutoCleanJobsDays.disabled = !cfgAutoCleanJobs.checked;
  cfgLogRetention.value = cfg.logRetentionDays || 7;
}

// Active/désactive le champ "jours" selon la checkbox
cfgAutoCleanJobs.addEventListener('change', () => {
  cfgAutoCleanJobsDays.disabled = !cfgAutoCleanJobs.checked;
});

openSettingsModalBtn.addEventListener('click', async () => {
  const cfg = await window.api.getConfig();
  applySettingsToUI(cfg);
  settingsModal.classList.remove('hidden');
});

closeSettingsModalBtn.addEventListener('click', () => settingsModal.classList.add('hidden'));

// Aperçu du thème en temps réel quand on change dans la modale
cfgTheme.addEventListener('change', () => {
  document.body.className = cfgTheme.value;
});

saveSettingsBtn.addEventListener('click', async () => {
  const theme = cfgTheme.value;
  localStorage.setItem('app-theme', theme);
  document.body.className = theme;

  await window.api.saveConfig({
    scrapeSpeed: cfgScrapeSpeed.value,
    pageDelayMs: parseInt(cfgPageDelay.value, 10) || 1000,
    headless: cfgHeadless.checked,
    includeSellerData: cfgIncludeSellerData ? cfgIncludeSellerData.checked : true,
    autoCleanHarDays: parseInt(cfgCleanHarDays.value, 10) || 7,
    autoCleanJobsDays: cfgAutoCleanJobs.checked ? (parseInt(cfgAutoCleanJobsDays.value, 10) || 30) : 0,
    logRetentionDays: parseInt(cfgLogRetention.value, 10) || 7,
  });
  settingsModal.classList.add('hidden');
  showToast('Paramètres enregistrés avec succès !', 'success');
});

resetSettingsBtn.addEventListener('click', async () => {
  const ok = await askConfirm({
    title: 'Réinitialiser les paramètres',
    message: 'Réinitialiser tous les paramètres aux valeurs par défaut ?',
    confirmLabel: 'Réinitialiser',
  });
  if (!ok) return;
  localStorage.setItem('app-theme', 'theme-dark');
  document.body.className = 'theme-dark';
  await window.api.saveConfig({
    scrapeSpeed: 'moyen',
    pageDelayMs: 1000,
    headless: true,
    includeSellerData: true,
    autoCleanHarDays: 7,
    autoCleanJobsDays: 0,
    logRetentionDays: 7,
  });
  applySettingsToUI({ scrapeSpeed: 'moyen', pageDelayMs: 1000, headless: true, includeSellerData: true, autoCleanHarDays: 7, autoCleanJobsDays: 0, logRetentionDays: 7 });
  showToast('Paramètres réinitialisés.', 'success');
});

// Start / Stop
startBtn.addEventListener('click', () => {
  if (isOffline) {
    showToast('📶 Mode hors-ligne actif. Consultez les jobs déjà scrapés dans l\'onglet Historique ; le scraping nécessite une connexion à Leboncoin.', 'warn', { duration: 7000 });
    return;
  }
  const searchUrl = document.getElementById('searchUrl').value.trim();
  if (!searchUrl) {
    showToast('Veuillez entrer une URL de recherche Leboncoin valide.', 'warn');
    return;
  }

  const config = {
    searchUrl,
    pages: document.getElementById('pages').value,
    limit: document.getElementById('limit').value,
    noDesc: document.getElementById('noDesc').checked,
    proxyUrl: proxyUrl.value.trim() || undefined,
    // Profil de données (Défaut / Maximum / Personnalisé) + champs sélectionnés.
    // Le main process applique ce profil à TOUS les exports : JSON, TXT.
    profileId: getSelectedProfile(),
    exportFields: getSelectedProfile() === 'custom' ? getSelectedExportFields() : null,
  };

  startBtn.disabled = true;
  stopBtn.disabled = false;
  progressBar.style.width = '0%';
  statusText.textContent = 'Statut : Lancement...';

  // Réarme le bandeau d'alerte structure : sans cela, un avertissement de
  // structure affiché lors d'un run précédent restait visible indéfiniment
  // (aucun code ne le masquait) et donnait une fausse alerte sur les runs OK.
  const structureWarningEl = document.getElementById('structureWarning');
  if (structureWarningEl) structureWarningEl.classList.add('hidden');
  // Masque aussi le bandeau d'erreur actionnable du run précédent (Thème 5).
  hideScrapeError();

  window.api.startScraping(config);
});

stopBtn.addEventListener('click', () => {
  window.api.stopScraping();
  stopBtn.disabled = true;
});

// Bandeau d'erreur : bouton « Voir les logs » → bascule sur l'onglet Logs,
// bouton fermer → masque le bandeau. Câblés une seule fois ici.
document.getElementById('scrapeErrorLogsBtn')?.addEventListener('click', () => {
  document.querySelector('[data-tab="tab-logs"]')?.click();
});
document.getElementById('scrapeErrorCloseBtn')?.addEventListener('click', () => {
  hideScrapeError();
});

window.api.onProgress(({ percent, status, eta }) => {
  if (percent !== undefined) progressBar.style.width = `${percent}%`;
  if (status) statusText.textContent = `Statut : ${status}`;
  if (eta) etaText.textContent = `ETA : ${eta}`;
  // Transmet au widget flottant (si ouvert)
  if (typeof window.api.sendWidgetProgress === 'function') {
    window.api.sendWidgetProgress({ percent, status });
  }
});

window.api.onStatusChange(({ state, message }) => {
  if (message) statusText.textContent = `Statut : ${message}`;

  // États terminaux : succès complet, succès partiel, erreur, annulation,
  // accès refusé (403), limitation de débit (429). Tous réactivent les boutons.
  const terminalStates = ['completed', 'partial', 'error', 'cancelled', 'refused', 'rate_limited'];
  if (terminalStates.includes(state)) {
    startBtn.disabled = false;
    stopBtn.disabled = true;
    if (state !== 'refused' && state !== 'rate_limited') {
      progressBar.style.width = '100%';
    }
    etaText.textContent = '';

    // Un scraping vient de se terminer : on rafraîchit l'onglet de données
    // actuellement affiché pour qu'aucune donnée ancienne ne persiste après
    // un nouveau scraping (cohérence Historique / Explorateur / Statistiques).
    // On rafraîchit aussi après un succès PARTIEL : des annonces valides ont
    // été sauvegardées même si l'enrichissement a été bloqué.
    if (state === 'completed' || state === 'partial') {
      refreshActiveDataTab();
    }

    // Bandeau d'erreur actionnable : les états non nominaux affichent un
    // message persistant avec accès direct aux logs (au lieu d'un alert()
    // transitoire). Le succès complet et l'annulation utilisateur n'affichent
    // pas de bandeau (ce ne sont pas des erreurs).
    if (state === 'refused') {
      showScrapeError({
        type: 'error',
        title: 'Accès refusé par le site (HTTP 403)',
        message: message || 'Le site a refusé l\'accès. Consultez les logs, puis réessayez plus tard.',
      });
    } else if (state === 'rate_limited') {
      showScrapeError({
        type: 'error',
        title: 'Trop de requêtes (HTTP 429)',
        message: message || 'Le site limite temporairement les requêtes. Attendez avant de relancer.',
      });
    } else if (state === 'partial') {
      showScrapeError({
        type: 'warn',
        title: 'Succès partiel',
        message: message || 'Des annonces ont été sauvegardées, mais la collecte est incomplète.',
      });
    } else if (state === 'error') {
      showScrapeError({
        type: 'error',
        title: 'Erreur de scraping',
        message: message || 'Le scraping a échoué. Consultez les logs pour le détail.',
      });
    }
  }
  // Transmet au widget flottant (si ouvert)
  if (typeof window.api.sendWidgetStatus === 'function') {
    window.api.sendWidgetStatus({ state, message });
  }
});
