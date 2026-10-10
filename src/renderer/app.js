// 🎨 THÈME — appliqué au chargement depuis localStorage (le sélecteur est dans la modale Paramètres)
const savedTheme = localStorage.getItem('app-theme') || 'theme-dark';
document.body.className = savedTheme;

// ⚠️ ÉCRAN D'INFORMATION LÉGALE (premier lancement)
const legalNoticeModal = document.getElementById('legalNoticeModal');
const legalNoticeAcceptBtn = document.getElementById('legalNoticeAcceptBtn');
const LEGAL_NOTICE_KEY = 'lbc-legal-notice-accepted';

function showLegalNotice() {
  if (legalNoticeModal) legalNoticeModal.classList.remove('hidden');
}
function hideLegalNotice() {
  if (legalNoticeModal) legalNoticeModal.classList.add('hidden');
  localStorage.setItem(LEGAL_NOTICE_KEY, '1');
}

if (legalNoticeAcceptBtn) {
  legalNoticeAcceptBtn.addEventListener('click', hideLegalNotice);
}

// Afficher l'écran légal au premier lancement (pas encore accepté)
if (!localStorage.getItem(LEGAL_NOTICE_KEY)) {
  setTimeout(showLegalNotice, 500);
}

// 👤 DONNÉES VENDEUR — visibilité conditionnelle
async function refreshSellerDataSetting() {
  try {
    const cfg = await window.api.getConfig();
    includeSellerData = cfg.includeSellerData !== false;
  } catch {
    includeSellerData = true;
  }
  applySellerDataVisibility();
}

function applySellerDataVisibility() {
  // Filtres vendeur dans l'explorateur
  const sellerFilterRow = document.getElementById('filterSellerType')?.closest('.form-group');
  const ratingFilterRow = document.getElementById('filterMinRating')?.closest('.form-group');
  if (sellerFilterRow) sellerFilterRow.classList.toggle('hidden', !includeSellerData);
  if (ratingFilterRow) ratingFilterRow.classList.toggle('hidden', !includeSellerData);

  // Masque la colonne Vendeur du tableau via la classe dédiée (l'ancien
  // sélecteur `th[style*="Vendeur"]`/nth-child était fragile et retournait null).
  if (!includeSellerData) {
    document.body.classList.add('seller-data-hidden');
  } else {
    document.body.classList.remove('seller-data-hidden');
  }
}

refreshSellerDataSetting();

// ONGLETS — les boutons de navigation portent l'attribut data-tab (classes
// .nav-item). L'ancien sélecteur `.tab-btn` ne correspondait plus à aucun élément
// depuis la refonte de la sidebar → AUCUN listener de navigation n'était attaché
// et cliquer un onglet ne faisait rien. On cible [data-tab] pour rester aligné
// sur le raccourci clavier et robuste à un futur changement de classe.
document.querySelectorAll('[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));

    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');

    if (btn.dataset.tab === 'tab-history') loadHistoryPage();
    if (btn.dataset.tab === 'tab-explorer') loadExplorerPage();
    if (btn.dataset.tab === 'tab-stats') {
      loadStatsPage();
      // Force Leaflet à recalculer sa taille d'affichage après l'ouverture de l'onglet (anti-bug d'affichage)
      setTimeout(() => {
        if (typeof mapInstance !== 'undefined' && mapInstance) {
          mapInstance.invalidateSize();
        }
      }, 200);
    }
  });
});

// ⌨️ RACCOURCIS CLAVIER PRO
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    document.querySelector('[data-tab="tab-scraper"]').click();
    document.getElementById('searchUrl').focus();
  }
  if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
    e.preventDefault();
    if (viewMode === 'table') viewGridBtn.click();
    else viewTableBtn.click();
  }
  if (e.key === 'Escape') {
    confirmModal.classList.add('hidden');
    adDetailModal.classList.add('hidden');
    compareModal.classList.add('hidden');
    settingsModal.classList.add('hidden');
    // Modales d'aide (FAQ / Help / Feedback)
    document.getElementById('faqModal')?.classList.add('hidden');
    document.getElementById('helpModal')?.classList.add('hidden');
    document.getElementById('feedbackModal')?.classList.add('hidden');
  }
});

// Rafraîchit la vue de données de l'onglet actuellement actif. Sans effet si
// l'onglet actif n'est pas un onglet de données (Scraper / Logs / Aide).
function refreshActiveDataTab() {
  try {
    const activeId = document.querySelector('.tab-content.active')?.id;
    if (activeId === 'tab-history') loadHistoryPage();
    else if (activeId === 'tab-explorer') loadExplorerPage();
    else if (activeId === 'tab-stats') loadStatsPage();
  } catch (err) {
    console.warn('[status] Rafraîchissement onglet actif échoué :', err.message);
  }
}
