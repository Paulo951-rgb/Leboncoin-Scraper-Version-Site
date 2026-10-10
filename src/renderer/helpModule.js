'use strict';

/**
 * Module d'aide : FAQ, Guide d'utilisation et Formulaire de feedback.
 *
 * Logique renderer isolée, exposée sur window.helpModule.
 * - FAQ : accordéon cliquable généré depuis FAQ_DATA.
 * - Help : guide pédagogique progressif généré depuis HELP_SECTIONS.
 * - Feedback : formulaire avec auto-diagnostic (version/OS/date) non sensible.
 *
 * Le bouton "Envoyer" du feedback appelle submitFeedback(), clairement marquée
 * "à connecter à l'API backend" (V2). Aucune infrastructure serveur pour
 * l'instant — la fonction stocke le rapport localement et affiche un message.
 */

const FAQ_DATA = [
  {
    q: 'À quoi sert Leboncoin Scraper Pro ?',
    a: `<p>Leboncoin Scraper Pro est un logiciel de bureau (Windows / macOS / Linux) qui <strong>collecte automatiquement les annonces Leboncoin</strong> à partir d'une URL de recherche, puis les exporte.</p>
        <p>Il permet de :</p>
        <ul>
          <li>récupérer des dizaines, voire des centaines d'annonces en quelques minutes ;</li>
          <li>visualiser le marché (prix moyen, distribution, carte géographique, modes de transaction) ;</li>
          <li>comparer les annonces et exporter les résultats (JSON, TXT).</li>
        </ul>`
  },
  {
    q: 'Le logiciel envoie-t-il mes données sur Internet ?',
    a: `<p>Le logiciel se connecte uniquement à :</p>
        <ul>
          <li><strong>leboncoin.fr</strong> pour récupérer les annonces ;</li>
          <li>l'API de géocodage du gouvernement français (geo.api.gouv.fr) pour positionner les villes sur la carte ;</li>
          <li>des CDN publics (jsdelivr, unpkg) pour charger les bibliothèques d'affichage (graphiques, carte) et les tuiles OpenStreetMap lorsque la carte est affichée.</li>
        </ul>
        <p>Vos annonces scrapées ne sont jamais envoyées à ces services : ils ne servent qu'à charger du code et des fonds de carte.</p>
        <p>Aucune clé API payante n'est requise.</p>`
  },
  {
    q: 'Comment fonctionne le scraping ?',
    a: `<p>Le logiciel ouvre un navigateur (Chromium via Playwright) qui charge les pages de résultats Leboncoin, capture les données des annonces (titre, prix, ville, vendeur, photos…) puis enrichit éventuellement chaque annonce avec sa <strong>description détaillée</strong> en ouvrant la page de l'annonce.</p>
        <p>Si Leboncoin détecte une activité robotique, un <strong>CAPTCHA peut apparaître</strong> : le navigateur devient alors visible pour que vous le résolviez manuellement, après quoi le scraping reprend tout seul.</p>`
  },
  {
    q: 'À quoi servent les vitesses de scraping (Moyen / Rapide / Ultra-rapide) ?',
    a: `<p>Elles contrôlent le compromis <strong>vitesse ↔ discrétion</strong> lors de l'enrichissement des descriptions (Paramètres ⚙️ → Vitesse de scraping) :</p>
        <ul>
          <li><strong>🟢 Moyen</strong> — 10 annonces en parallèle, délais courts. Bon compromis vitesse/stabilité.</li>
          <li><strong>🟠 Rapide</strong> — 15 annonces en parallèle, délais très courts. Pour les utilisateurs expérimentés.</li>
          <li><strong>🔴 Ultra-rapide</strong> — 25 annonces en parallèle, délais maximaux. Risque de blocage (403) plus élevé.</li>
        </ul>
        <p>Les trois modes utilisent une <strong>queue dynamique avec workers persistants</strong> : dès qu'un worker termine une annonce, il prend immédiatement la suivante. Pas de temps mort entre les batchs.</p>
        <p>Une case <strong>« Ignorer les descriptions (Mode Ultra-Rapide) »</strong> dans le formulaire de recherche permet de sauter l'enrichissement des descriptions pour aller encore plus vite (titre + prix seulement).</p>`
  },
  {
    q: 'Que signifie « Type de remise » (livraison, main propre, les deux) ?',
    a: `<p>Chaque annonce Leboncoin propose un ou plusieurs <strong>modes de remise</strong>. Le logiciel unifie ces informations dans un champ unique <code>deliveryType</code> :</p>
        <ul>
          <li><strong>📦 livraison</strong> — le vendeur propose l'envoi postal uniquement ;</li>
          <li><strong>🤝 main_propre</strong> — remise en main propre uniquement (pas de livraison) ;</li>
          <li><strong>📦🤝 les_deux</strong> — les deux modes sont disponibles ;</li>
          <li><strong>🚫 aucun</strong> — ni livraison ni main propre (rare) ;</li>
          <li><strong>❓ inconnu</strong> — l'information n'a pas pu être extraite.</li>
        </ul>
        <p>La carte propose un filtre « Remise en main propre uniquement » pour visualiser les annonces récupérables près de chez vous (main_propre + les_deux).</p>`
  },
  {
    q: `Pourquoi le nombre d'annonces sur la carte est-il parfois inférieur au total ?`,
    a: `<p>Plusieurs raisons possibles :</p>
        <ul>
          <li><strong>Filtre « main propre »</strong> activé par défaut sur la carte → seules les annonces avec remise en main propre (main_propre ou les_deux) sont affichées.</li>
          <li>Annonces <strong>sans ville détectée</strong> (pas de géocodage possible).</li>
          <li><strong>Déduplication</strong> : si la même annonce (même id Leboncoin) apparaît dans plusieurs sessions, elle n'est affichée qu'une seule fois.</li>
        </ul>`
  },
  {
    q: `Le mode Rapide n'a pas récupéré les descriptions, est-ce normal ?`,
    a: `<p><strong>Oui</strong>. Le mode « Rapide » n'extrait volontairement que le titre et le prix (pas la description détaillée) si la case « Ignorer les descriptions » est cochée.</p>
        <p>Pour les descriptions complètes, utilisez <strong>Équilibré</strong> ou <strong>Prudent</strong>, et décochez « Ignorer les descriptions ».</p>`
  },
  {
    q: 'J\'obtiens une erreur 403 / page blanche pendant le scraping, que faire ?',
    a: `<p>Une erreur <strong>403</strong> signifie que Leboncoin a temporairement bloqué la requête. Solutions :</p>
        <ul>
          <li>Attendez quelques minutes puis réessayez ;</li>
          <li>Choisissez une vitesse plus lente (<strong>Prudent</strong>) ;</li>
          <li>Augmentez le délai entre les pages (Paramètres → Délai entre les pages) ;</li>
          <li>Utilisez un <strong>proxy rotatif</strong> ;</li>
          <li>Ne scrapez pas trop de pages d'un coup.</li>
        </ul>`
  },
  {
    q: 'Mes favoris ou filtres sont-ils conservés ?',
    a: `<p>Les <strong>favoris</strong> (⭐) sont enregistrés dans le navigateur et persistent entre les sessions. Les <strong>filtres de l'explorateur</strong> (mot-clé, prix, tag) sont également mémorisés localement.</p>
        <p>Les <strong>jobs scrapés</strong> (annonces + résultats) sont stockés sur le disque dans le dossier de sortie, avec un contrôle d'intégrité SHA-256.</p>`
  },
  {
    q: 'Comment fonctionne la minimisation des données ?',
    a: `<p>Le logiciel propose plusieurs niveaux de contrôle :</p>
        <ul>
          <li><strong>Mode d'export</strong> : choisissez entre Défaut (toutes les données) et Personnalisé (seuls les champs sélectionnés sont exportés).</li>
          <li><strong>Données vendeur</strong> : vous pouvez désactiver les données vendeur (nom, ID, note, avis, URL profil, ancienneté) dans les Paramètres ⚙️. Elles sont alors exclues de tous les exports et masquées dans l'interface.</li>
          <li><strong>Descriptions</strong> : vous pouvez ignorer les descriptions lors du scraping pour accélérer le traitement et réduire la quantité de texte conservé.</li>
        </ul>
        <p>Consultez <code>docs/DATA_HANDLING.md</code> pour le tableau complet des catégories de données et leur traçabilité.</p>`
  },
  {
    q: 'Où sont stockés mes fichiers exportés ?',
    a: `<p>Dans le <strong>dossier de sortie</strong> du logiciel (bouton « Dossier principal » dans l'onglet Historique). Chaque job crée un sous-dossier horodaté contenant :</p>
        <ul>
          <li><code>annonces.json</code>, <code>annonces.txt</code> ;</li>
          <li>les fichiers <code>.har</code> (capture réseau, nettoyés automatiquement après quelques jours).</li>
        </ul>`
  },
];

const HELP_SECTIONS = [
  {
    icon: '🚀', title: '1. Démarrer un scraping',
    body: `<div class="help-step"><span class="help-step-num">1</span><div>Allez dans l'onglet <strong>🚀 Scraper</strong>.</div></div>
      <div class="help-step"><span class="help-step-num">2</span><div>Collez l'<strong>URL de recherche Leboncoin</strong> (copiée depuis le site, avec vos filtres prix/catégorie).</div></div>
      <div class="help-step"><span class="help-step-num">3</span><div>Choisissez le <strong>nombre de pages</strong> à parcourir et, si besoin, une <strong>limite d'annonces</strong>.</div></div>
      <div class="help-step"><span class="help-step-num">4</span><div>Cliquez sur <strong>Lancer le scraping</strong>. Une barre de progression indique l'avancement.</div></div>
      <div class="help-tip">💡 Vous pouvez enregistrer une recherche comme <strong>preset 1-clic</strong> pour la relancer plus tard.</div>`
  },
  {
    icon: '⚙️', title: '2. Configurer le scraping',
    body: `<p>Paramètres clés :</p>
      <ul>
        <li><strong>Pages</strong> — combien de pages de résultats parcourir (attention : trop de pages = risque de blocage).</li>
        <li><strong>Limite</strong> — plafond d'annonces (vide = toutes).</li>
        <li><strong>Proxy</strong> — serveur HTTP/SOCKS5 pour masquer votre IP (optionnel, utile contre le blocage).</li>
        <li><strong>Vitesse</strong> — voir la FAQ pour le détail (Rapide/Équilibré/Prudent), plus la case « Ignorer les descriptions » pour le mode ultra-rapide.</li>
      </ul>
      <p>Dans <strong>Paramètres ⚙️</strong> vous pouvez aussi régler : le thème, le délai entre les pages, le mode de capture (invisible / visible si CAPTCHA), le nettoyage automatique.</p>`
  },
  {
    icon: '🔍', title: '3. Explorer les résultats',
    body: `<p>Onglet <strong>🔍 Explorateur Annonces</strong> :</p>
      <ul>
        <li><strong>Vue tableau / grille</strong> — basculez avec le bouton dédié ou la touche <code>Espace</code>.</li>
        <li><strong>Filtres</strong> — mot-clé (titre, description, ville), prix min/max, tag de deal (favoris).</li>
        <li><strong>Tri</strong> — prix croissant/décroissant, ordre d'origine.</li>
        <li><strong>Fiche détaillée</strong> — cliquez une annonce pour voir photos, description complète, et informations vendeur.</li>
        <li><strong>Comparateur</strong> — ajoutez des annonces aux favoris (⭐) puis comparez-les côte à côte.</li>
      </ul>
      <div class="help-tip">💡 Raccourci <code>Ctrl+N</code> pour aller vite au Scraper et focus sur l'URL.</div>`
  },
  {
    icon: '📊', title: '4. Comprendre les statistiques',
    body: `<p>Onglet <strong>📊 Statistiques & Carte</strong> :</p>
      <ul>
        <li><strong>8 cartes</strong> : Total, Prix Moyen, Prix Médian, Prix Min/Max, Livraison, Répartition remise, Professionnels, Particuliers.</li>
        <li><strong>3 graphiques</strong> : Distribution des prix, Vendeurs (pro/particulier), Top 10 Villes.</li>
        <li>Le sélecteur en haut permet de choisir <strong>une session précise</strong> ou toutes combinées.</li>
      </ul>
      <div class="help-tip">💡 Le prix <strong>médian</strong> est souvent plus parlant que la moyenne (il ignore les prix extrêmes).</div>`
  },
  {
    icon: '🗺️', title: '5. Utiliser la carte',
    body: `<p>La carte (Leaflet) affiche la <strong>répartition géographique</strong> des annonces en France.</p>
      <ul>
        <li>Cochez <strong>« Remise en main propre uniquement »</strong> pour ne voir que les annonces récupérables en personne (main_propre ou les_deux).</li>
        <li>Les annonces sont <strong>dédupliquées par id</strong> (pas de doublons si plusieurs sessions).</li>
        <li>Le géocodage (ville → coordonnées) utilise l'API gouvernementale, avec un cache et un timeout de 10 s.</li>
      </ul>
      <div class="help-warn">⚠️ Seules les annonces avec une ville détectée peuvent être positionnées.</div>`
  },
  {
    icon: '⚠️', title: '6. Erreurs courantes et solutions',
    body: `<ul>
        <li><strong>403 / page blanche</strong> — Leboncoin bloque. Ralentissez (Prudent), augmentez le délai, utilisez un proxy, attendez.</li>
        <li><strong>CAPTCHA</strong> — le navigateur devient visible : résolvez-le à la main, le scraping reprend.</li>
        <li><strong>0 annonce récupérée</strong> — vérifiez l'URL (catégorie/prix/filtres) et votre connexion.</li>
        <li><strong>Carte vide</strong> — décochez le filtre main propre ou scrapez des annonces avec une ville.</li>
        <li><strong>Badge Hors-ligne</strong> — pas de réseau : le scraping est désactivé mais l'historique reste consultable.</li>
      </ul>`
  },
  {
    icon: '💾', title: '7. Exporter et conserver',
    body: `<p>Chaque job est stocké dans le <strong>dossier de sortie</strong> (bouton « Dossier principal » dans l'onglet Historique).</p>
      <ul>
        <li><strong>JSON / TXT</strong> — formats lisibles pour réutilisation.</li>
        <li>Les fichiers <code>.har</code> sont nettoyés automatiquement (Paramètres → rétention).</li>
      </ul>
      <p>L'onglet <strong>📁 Historique Jobs</strong> liste tous les scrapings passés, avec accès aux fichiers et suppression.</p>`
  },
  {
    icon: '🛡️', title: '8. Données et responsabilités',
    body: `<p>Ce logiciel est un outil technique d'automatisation et d'analyse. Vous êtes responsable de l'utilisation que vous en faites.</p>
      <ul>
        <li>Vérifiez que votre utilisation est autorisée par le site concerné et respecte ses conditions d'utilisation.</li>
        <li>Les données vendeur peuvent contenir des informations permettant d'identifier une personne. Désactivez-les dans les Paramètres ⚙️ si elles ne sont pas nécessaires.</li>
        <li>Utilisez le <strong>Mode Personnalisé</strong> pour ne conserver que les champs strictement nécessaires.</li>
        <li>Consultez <code>LEGAL.md</code> et <code>docs/DATA_HANDLING.md</code> pour plus de détails.</li>
      </ul>`
  },
];

const $ = (id) => document.getElementById(id);

// ──────────────────────────────────────────────────────────────────────────
// OUVERTURE / FERMETURE DES MODALES (réutilise le pattern .modal-overlay)
// ──────────────────────────────────────────────────────────────────────────
function openModal(id) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('hidden');
}

function closeModal(id) {
  const el = $(id);
  if (!el) return;
  el.classList.add('hidden');
}

// ──────────────────────────────────────────────────────────────────────────
// FAQ — rendu de l'accordéon
// ──────────────────────────────────────────────────────────────────────────
function renderFaq() {
  const container = $('faqAccordion');
  if (!container) return;
  container.innerHTML = '';
  FAQ_DATA.forEach((item, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'faq-item';
    wrap.innerHTML = `
      <button class="faq-question" type="button" aria-expanded="false">
        <span>${item.q}</span>
        <span class="faq-chevron">▼</span>
      </button>
      <div class="faq-answer"><div class="faq-answer-inner">${item.a}</div></div>`;
    const btn = wrap.querySelector('.faq-question');
    const ans = wrap.querySelector('.faq-answer');
    btn.addEventListener('click', () => {
      const isOpen = wrap.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(isOpen));
      if (isOpen) {
        ans.style.maxHeight = ans.scrollHeight + 'px';
      } else {
        ans.style.maxHeight = '0';
      }
    });
    container.appendChild(wrap);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// HELP — rendu du guide
// ──────────────────────────────────────────────────────────────────────────
function renderHelp() {
  const container = $('helpContent');
  if (!container) return;
  container.innerHTML = '';
  HELP_SECTIONS.forEach((sec) => {
    const section = document.createElement('div');
    section.className = 'help-section';
    section.innerHTML = `<h4>${sec.icon} ${sec.title}</h4>${sec.body}`;
    container.appendChild(section);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// FEEDBACK — diagnostic + envoi (préparé pour future API, sans backend)
// ──────────────────────────────────────────────────────────────────────────
async function collectDiagnostics() {
  const fallback = {
    appVersion: 'inconnue',
    platform: navigator.platform || 'inconnu',
    timestamp: new Date().toISOString(),
  };
  try {
    if (window.api && typeof window.api.getDiagnostics === 'function') {
      return await window.api.getDiagnostics();
    }
  } catch (err) {
    console.warn('[Feedback] getDiagnostics indisponible :', err);
  }
  return fallback;
}

function formatDiag(diag) {
  const lines = [
    `Version du logiciel : ${diag.appVersion || 'inconnue'}`,
    `Électron : ${diag.electronVersion || 'n/a'}`,
    `Node : ${diag.nodeVersion || 'n/a'}`,
    `Système : ${diag.platform || 'n/a'} ${diag.arch || ''} ${diag.osRelease ? '(' + diag.osRelease + ')' : ''}`,
    `Langue : ${diag.locale || 'n/a'}`,
    `Date : ${diag.timestamp || new Date().toISOString()}`,
  ];
  return lines.join('\n');
}

async function refreshFeedbackDiag() {
  const preview = $('feedbackDiagPreview');
  if (!preview) return;
  const diag = await collectDiagnostics();
  preview.textContent = formatDiag(diag);
  preview.dataset.diag = JSON.stringify(diag);
}

function showFeedbackStatus(cls, msg) {
  const el = $('feedbackStatus');
  if (!el) return;
  el.className = 'feedback-status ' + cls;
  el.textContent = msg;
}

async function submitFeedback() {
  const type = $('feedbackType');
  const msg = $('feedbackMessage');
  const status = $('feedbackStatus');
  if (!type || !msg) return;

  const message = msg.value.trim();
  if (!message) {
    showFeedbackStatus('warn', '⚠️ Merci de décrire votre message avant d\'envoyer.');
    msg.focus();
    return;
  }

  const submitBtn = $('submitFeedbackBtn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Envoi…';
  }

  const diagRaw = $('feedbackDiagPreview')?.dataset.diag;
  let diag = {};
  try { diag = diagRaw ? JSON.parse(diagRaw) : await collectDiagnostics(); } catch (_) { /* garde diag vide */ }

  const payload = {
    type: type.value,
    message,
    diagnostics: diag,
    // Horodatage renderer (double sécurité si diag indisponible)
    clientTimestamp: new Date().toISOString(),
  };

  // ───────────────────────────────────────────────────────────────────────
  // ⚠️ V2 — Envoi vers API backend non implémenté pour l'instant.
  // Brancher ici l'envoi HTTP (fetch POST vers l'endpoint de feedback)
  // lorsque le backend sera disponible. Exemple à venir :
  //
  //   const res = await fetch('https://api.exemple.fr/feedback', {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify(payload),
  //   });
  //   if (!res.ok) throw new Error('Échec de l\'envoi');
  //   return res.json();
  //
  // Pour l'instant : on consigne le rapport en console + localStorage
  // afin qu'il ne soit pas perdu, et on informe l'utilisateur.
  // ───────────────────────────────────────────────────────────────────────
  try {
    const archive = JSON.parse(localStorage.getItem('feedback-archive') || '[]');
    archive.push(payload);
    // On limite à 20 rapports archivés pour ne pas saturer le localStorage.
    if (archive.length > 20) archive.shift();
    localStorage.setItem('feedback-archive', JSON.stringify(archive));
    console.info('[Feedback] Rapport archivé localement (envoi serveur pas encore disponible) :', payload);

    showFeedbackStatus('ok', '✅ Votre rapport a bien été préparé. Il sera envoyé automatiquement dès que le service en ligne sera activé (V2).');
    msg.value = '';
  } catch (err) {
    console.error('[Feedback] Erreur d\'archivage :', err);
    showFeedbackStatus('error', '❌ Impossible d\'enregistrer le rapport. Copiez votre message avant de fermer.');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = '📤 Envoyer';
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// INIT
// ──────────────────────────────────────────────────────────────────────────
const HelpModule = {
  init() {
    renderFaq();
    renderHelp();

    // Boutons du header
    $('openFaqBtn')?.addEventListener('click', () => openModal('faqModal'));
    $('openHelpBtn')?.addEventListener('click', () => openModal('helpModal'));
    $('openFeedbackBtn')?.addEventListener('click', async () => {
      await refreshFeedbackDiag();
      openModal('feedbackModal');
    });

    // Boutons Fermer / Annuler génériques (data-close-modal)
    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
    });

    // Clic sur l'overlay ferme la modale
    ['faqModal', 'helpModal', 'feedbackModal'].forEach((id) => {
      const overlay = $(id);
      if (overlay) {
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) closeModal(id);
        });
      }
    });

    // Envoi feedback
    $('submitFeedbackBtn')?.addEventListener('click', submitFeedback);
  },
};

window.helpModule = HelpModule;
document.addEventListener('DOMContentLoaded', () => {
  try { HelpModule.init(); } catch (err) { console.error('[Help] init échoué :', err); }
});
