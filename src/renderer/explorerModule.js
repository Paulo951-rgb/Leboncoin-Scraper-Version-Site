const adsTableContainer = document.getElementById('adsTableContainer');
const adsTableBody = document.getElementById('adsTableBody');
const adsGridContainer = document.getElementById('adsGridContainer');
const filteredAdsCount = document.getElementById('filteredAdsCount');

const viewTableBtn = document.getElementById('viewTableBtn');
const viewGridBtn = document.getElementById('viewGridBtn');

const filterKeyword = document.getElementById('filterKeyword');
const filterPriceMin = document.getElementById('filterPriceMin');
const filterPriceMax = document.getElementById('filterPriceMax');
const filterTagSelect = document.getElementById('filterTagSelect');
const sortSelect = document.getElementById('sortSelect');
const filterDeliveryType = document.getElementById('filterDeliveryType');
const filterSellerType = document.getElementById('filterSellerType');
const filterMinRating = document.getElementById('filterMinRating');
const filterMinLikes = document.getElementById('filterMinLikes');
const filterEtat = document.getElementById('filterEtat');

/**
 * Calcule le deliveryType depuis les anciens champs livraison/mainPropre
 * pour la rétro-compatibilité des annonces cachées sans deliveryType.
 */
function _computeDeliveryTypeCompat(livraison, mainPropre) {
  if (livraison === true && mainPropre === true) return 'les_deux';
  if (livraison === true) return 'livraison';
  if (mainPropre === true) return 'main_propre';
  if (livraison === false && mainPropre === false) return 'aucun';
  if (livraison === false) return 'aucun';
  if (mainPropre === false) return 'aucun';
  return 'inconnu';
}

// Modal Suppression & Detail
const closeDetailModalBtn = document.getElementById('closeDetailModalBtn');
const modalAdTitle = document.getElementById('modalAdTitle');
const mainGalleryImg = document.getElementById('mainGalleryImg');
const galleryThumbnails = document.getElementById('galleryThumbnails');
const modalDealBadge = document.getElementById('modalDealBadge');
const modalStarBtn = document.getElementById('modalStarBtn');
const modalPrice = document.getElementById('modalPrice');
const modalCity = document.getElementById('modalCity');
const modalSeller = document.getElementById('modalSeller');
const modalDate = document.getElementById('modalDate');
const modalDescription = document.getElementById('modalDescription');
const modalOpenLeboncoinBtn = document.getElementById('modalOpenLeboncoinBtn');

/** Filtre les annonces par tag (Favoris uniquement — les verdicts IA ont été retirés). */
function matchesVerdictFilter(a, tagFilter) {
  if (tagFilter === 'FAV') return starredAds.has(String(a.id));
  return true;
}

// BASCULE DE VUE TABLEAU / GALERIE
viewTableBtn.addEventListener('click', () => {
  viewMode = 'table';
  localStorage.setItem('explorer-view', 'table');
  viewTableBtn.classList.add('active');
  viewGridBtn.classList.remove('active');
  adsTableContainer.classList.remove('hidden');
  adsGridContainer.classList.add('hidden');
  renderExplorerAds();
});

viewGridBtn.addEventListener('click', () => {
  viewMode = 'grid';
  localStorage.setItem('explorer-view', 'grid');
  viewGridBtn.classList.add('active');
  viewTableBtn.classList.remove('active');
  adsTableContainer.classList.add('hidden');
  adsGridContainer.classList.remove('hidden');
  renderExplorerAds();
});

if (viewMode === 'grid') viewGridBtn.click();

// PAGE 4 : EXPLORATEUR D'ANNONCES
async function loadExplorerPage() {
  allJobsCache = await window.api.getHistory();
  populateSessionDropdown(sessionSelect);
  populateEtatFilter();
  restoreExplorerFilters();
  renderExplorerAds();
}

function populateSessionDropdown(selectEl) {
  const selectedVal = selectEl.value;
  selectEl.innerHTML = '<option value="ALL">🌐 Tous les scrapings combinés (Recherche globale)</option>';

  allJobsCache.forEach((j) => {
    const opt = document.createElement('option');
    opt.value = j.id;
    opt.textContent = `📅 Session du ${j.date} (${j.adsCount} annonces)`;
    selectEl.appendChild(opt);
  });

  // Restaure la sélection précédente UNIQUEMENT si le job existe encore. Sinon
  // (job supprimé entre-temps), affecter une valeur absente laisse le <select>
  // sans sélection (value = '') → l'explorateur/les stats affichaient une vue
  // vide jusqu'à ce que l'utilisateur resélectionne manuellement. On retombe
  // sur 'ALL' dans ce cas.
  const stillExists = selectedVal && [...selectEl.options].some((o) => o.value === selectedVal);
  selectEl.value = stillExists ? selectedVal : 'ALL';
}

// Écouteurs de filtrage sécurisés (Évitent tout plantage en cas d'élément absent)
if (filterKeyword) filterKeyword.addEventListener('input', () => { saveExplorerFilters(); renderExplorerAds(); });
if (filterPriceMin) filterPriceMin.addEventListener('input', () => { saveExplorerFilters(); renderExplorerAds(); });
if (filterPriceMax) filterPriceMax.addEventListener('input', () => { saveExplorerFilters(); renderExplorerAds(); });
if (filterTagSelect) filterTagSelect.addEventListener('change', () => { saveExplorerFilters(); renderExplorerAds(); });
if (sortSelect) sortSelect.addEventListener('change', () => { saveExplorerFilters(); renderExplorerAds(); });
// Filtres scraping (type de remise / type vendeur / note min / likes min / état)
if (filterDeliveryType) filterDeliveryType.addEventListener('change', () => { saveExplorerFilters(); renderExplorerAds(); });
if (filterSellerType) filterSellerType.addEventListener('change', () => { saveExplorerFilters(); renderExplorerAds(); });
if (filterMinRating) filterMinRating.addEventListener('input', () => { saveExplorerFilters(); renderExplorerAds(); });
if (filterMinLikes) filterMinLikes.addEventListener('input', () => { saveExplorerFilters(); renderExplorerAds(); });
if (filterEtat) filterEtat.addEventListener('change', () => { saveExplorerFilters(); renderExplorerAds(); });

// Changement de session : rafraîchit immédiatement tout l'explorateur (sans
// avoir à manipuler un autre filtre pour déclencher la mise à jour).
if (sessionSelect) sessionSelect.addEventListener('change', () => { renderExplorerAds(); });

// Sauvegarde / restauration des filtres entre les sessions
function saveExplorerFilters() {
  try {
    localStorage.setItem('explorer-filters', JSON.stringify({
      keyword: filterKeyword?.value || '',
      priceMin: filterPriceMin?.value || '',
      priceMax: filterPriceMax?.value || '',
      tag: filterTagSelect?.value || 'ALL',
      sort: sortSelect?.value || 'DEFAULT',
      deliveryType: filterDeliveryType?.value || 'tous',
      sellerType: filterSellerType?.value || 'ALL',
      minRating: filterMinRating?.value || '',
      minLikes: filterMinLikes?.value || '',
      etat: filterEtat?.value || 'ALL',
    }));
  } catch { /* quota dépassé */ }
}

function restoreExplorerFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem('explorer-filters') || '{}');
    if (saved.keyword && filterKeyword) filterKeyword.value = saved.keyword;
    if (saved.priceMin != null && filterPriceMin) filterPriceMin.value = saved.priceMin;
    if (saved.priceMax != null && filterPriceMax) filterPriceMax.value = saved.priceMax;
    if (saved.tag && filterTagSelect) filterTagSelect.value = saved.tag;
    if (saved.sort && sortSelect) sortSelect.value = saved.sort === 'DEAL_DESC' ? 'DEFAULT' : saved.sort;
    if (saved.deliveryType && filterDeliveryType) filterDeliveryType.value = saved.deliveryType;
    if (saved.sellerType && filterSellerType) filterSellerType.value = saved.sellerType;
    if (saved.minRating != null && filterMinRating) filterMinRating.value = saved.minRating;
    if (saved.minLikes != null && filterMinLikes) filterMinLikes.value = saved.minLikes;
    if (saved.etat && filterEtat) filterEtat.value = saved.etat;
  } catch { /* JSON corrompu */ }
}

/**
 * Peuple le sélecteur d'état avec les valeurs distinctes trouvées dans les
 * annonces (État déclaré par le vendeur : "Neuf", "Très bon état", etc.).
 */
function populateEtatFilter() {
  if (!filterEtat) return;
  const etats = new Set();
  for (const j of allJobsCache) {
    if (!Array.isArray(j.ads)) continue;
    for (const a of j.ads) {
      // Le modèle expose l'état déclaré sur `etat` (structure plate v3).
      // L'ancien accès `a.produit?.etat` renvoyait toujours undefined → le
      // filtre « État » ne proposait jamais aucune valeur.
      const e = a.etat;
      if (e) etats.add(e);
    }
  }
  const current = filterEtat.value;
  const opts = ['<option value="ALL">Tous états</option>',
    ...[...etats].sort().map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`)];
  filterEtat.innerHTML = opts.join('');
  if (current && etats.has(current)) filterEtat.value = current;
  else filterEtat.value = 'ALL';
}

function renderExplorerAds() {
  const selectedJobId = sessionSelect.value;
  const query = filterKeyword.value.toLowerCase().trim();
  const tagFilter = filterTagSelect.value;
  const sortMode = sortSelect.value;

  const minP = parseFloat(filterPriceMin.value) || 0;
  const maxP = parseFloat(filterPriceMax.value) || Infinity;
  // Filtres scraping
  const sellerTypeFilter = filterSellerType ? filterSellerType.value : 'ALL';
  const minRating = filterMinRating && filterMinRating.value !== '' ? parseFloat(filterMinRating.value) : null;
  const minLikes = filterMinLikes && filterMinLikes.value !== '' ? parseInt(filterMinLikes.value, 10) : null;
  const etatFilter = filterEtat ? filterEtat.value : 'ALL';

  let sourceAds = [];

  if (selectedJobId === 'ALL') {
    allJobsCache.forEach((j) => {
      if (Array.isArray(j.ads)) sourceAds.push(...j.ads);
    });
  } else {
    const found = allJobsCache.find((j) => j.id === selectedJobId);
    if (found && Array.isArray(found.ads)) sourceAds = found.ads;
  }

  // Helpers lecture champs structurés / legacy
  const deliveryTypeOf = (a) => a.deliveryType ?? _computeDeliveryTypeCompat(a.livraison ?? a.shipping, a.mainPropre ?? a.handDelivery);
  const typeVendeurOf = (a) => a.vendeurType || 'particulier';
  const noteOf = (a) => a.vendeurNote != null ? a.vendeurNote : a.sellerRating;
  const likesOf = (a) => a.likes != null ? a.likes : (a.favorites_count != null ? a.favorites_count : null);
  const datePubOf = (a) => a.datePublication || a.date;
  const dateScrapeOf = (a) => a.dateScraping;
  const etatOf = (a) => a.etat;

  // Helper description (lit description si string, ou description.originale si objet legacy)
  const descTextOf = (a) => {
    if (!a) return '';
    if (typeof a.description === 'string') return a.description;
    if (typeof a.description === 'object' && typeof a.description.originale === 'string') return a.description.originale;
    return '';
  };

  const deliveryTypeFilter = filterDeliveryType ? filterDeliveryType.value : 'tous';

  let filtered = sourceAds.filter((a) => {
    const desc = descTextOf(a);
    const fullText = `${a.title || ''} ${desc} ${a.city || ''} ${a.vendeurNom || a.seller || ''}`.toLowerCase();
    const matchesQuery = !query || fullText.includes(query);

    const price = typeof a.prix === 'number' ? a.prix : (typeof a.price === 'number' ? a.price : parseFloat(a.price) || 0);
    const matchesPrice = price >= minP && price <= maxP;

    const matchesTag = matchesVerdictFilter(a, tagFilter);

    // Type de remise unifié
    const matchesDeliveryType = deliveryTypeFilter === 'tous' || deliveryTypeOf(a) === deliveryTypeFilter;

    // Type vendeur
    const matchesSellerType = !includeSellerData || sellerTypeFilter === 'ALL' ||
      (sellerTypeFilter === 'PRO' && typeVendeurOf(a) === 'pro') ||
      (sellerTypeFilter === 'PART' && typeVendeurOf(a) === 'particulier');

    // Note min
    let matchesRating = !includeSellerData || true;
    if (includeSellerData && minRating != null) {
      const r = noteOf(a);
      matchesRating = r != null && r >= minRating;
    }

    // Likes min
    let matchesLikes = true;
    if (minLikes != null) {
      const l = likesOf(a);
      matchesLikes = l != null && l >= minLikes;
    }

    // État déclaré
    const matchesEtat = etatFilter === 'ALL' || (etatOf(a) && etatOf(a) === etatFilter);

    return matchesQuery && matchesPrice && matchesTag && matchesDeliveryType
      && matchesSellerType && matchesRating && matchesLikes && matchesEtat;
  });

  if (sortMode === 'PRICE_ASC') {
    filtered.sort((a, b) => ((a.prix ?? a.price) || 0) - ((b.prix ?? b.price) || 0));
  } else if (sortMode === 'PRICE_DESC') {
    filtered.sort((a, b) => ((b.prix ?? b.price) || 0) - ((a.prix ?? a.price) || 0));
  } else if (sortMode === 'RATING_DESC') {
    filtered.sort((a, b) => (noteOf(b) ?? -1) - (noteOf(a) ?? -1));
  } else if (sortMode === 'LIKES_DESC') {
    filtered.sort((a, b) => (likesOf(b) ?? -1) - (likesOf(a) ?? -1));
  } else if (sortMode === 'DATE_PUB_DESC') {
    filtered.sort((a, b) => new Date(datePubOf(b) || 0).getTime() - new Date(datePubOf(a) || 0).getTime());
  } else if (sortMode === 'DATE_SCRAPE_DESC') {
    filtered.sort((a, b) => new Date(dateScrapeOf(b) || 0).getTime() - new Date(dateScrapeOf(a) || 0).getTime());
  }

  filteredAdsCount.textContent = filtered.length;

  if (filtered.length === 0) {
    adsTableBody.innerHTML = '<tr><td colspan="8" class="text-center">Aucune annonce ne correspond à votre recherche</td></tr>';
    adsGridContainer.innerHTML = '<div class="text-center" style="grid-column:1/-1;">Aucune annonce ne correspond à votre recherche</div>';
    return;
  }

  if (viewMode === 'table') {
    adsTableBody.innerHTML = filtered
      .map((a) => {
        const isStarred = starredAds.has(String(a.id));
        const starIcon = `<span class="star-icon ${isStarred ? 'starred' : ''}" data-action="toggleStar" data-id="${escapeHtml(String(a.id))}">★</span>`;
        const isChecked = compareSet.has(String(a.id));

        const nameHtml = escapeHtml(a.title || 'Sans titre');

        // Pastille type de remise / likes / note vendeur (visuelles)
        const dt = deliveryTypeOf(a);
        const deliveryChip = dt === 'livraison' ? ' <span title="Livraison" style="color:#38bdf8;">📦</span>'
          : dt === 'main_propre' ? ' <span title="Main propre" style="color:#22c55e;">🤝</span>'
          : dt === 'les_deux' ? ' <span title="Livraison + Main propre" style="color:#38bdf8;">📦</span><span title="Main propre" style="color:#22c55e;">🤝</span>'
          : dt === 'aucun' ? ' <span title="Aucune remise" style="color:var(--text-muted);">🚫</span>'
          : ' <span title="Remise indéterminée" style="color:var(--text-muted);">❓</span>';
        const note = noteOf(a);
        const noteChip = includeSellerData && note != null ? ` <span title="Note vendeur" style="color:#facc15;">⭐${String(note).replace('.', ',')}</span>` : '';
        const likesVal = likesOf(a);
        const likesChip = includeSellerData && likesVal != null ? ` <span title="Likes" style="color:#ef4444;">❤️${likesVal}</span>` : '';

        const sellerChip = includeSellerData ? `<small style="color:var(--text-muted);">${escapeHtml(a.vendeurNom || 'Particulier')}</small>` : '';
        const typeVendeurBadge = includeSellerData ? ((a.vendeurType === 'pro') ? '<span style="background:var(--accent); color:white; padding:1px 5px; border-radius:3px; font-size:0.7rem;">PRO</span>' : '<span style="background:var(--bg-secondary); padding:1px 5px; border-radius:3px; font-size:0.7rem;">PART</span>') : '';

        const priceText = a.prix != null ? a.prix + ' €' : (a.price != null ? a.price + ' €' : '-');
        return `
        <tr>
          <td class="text-center"><input type="checkbox" ${isChecked ? 'checked' : ''} data-action="toggleCompare" data-id="${escapeHtml(String(a.id))}"></td>
          <td class="text-center">${starIcon}</td>
          <td>${nameHtml}</td>
          <td><strong>${escapeHtml(String(priceText))}</strong></td>
          <td class="cell-vendeur">${sellerChip} ${typeVendeurBadge}${deliveryChip}${noteChip}${likesChip}</td>
          <td>${escapeHtml(a.city || '-')}</td>
          <td>${escapeHtml(a.datePublication || a.date || '-')}</td>
          <td>
            <div style="display:flex; gap:4px;">
              <button class="btn btn-secondary btn-small" data-action="openAdDetail" data-id="${escapeHtml(String(a.id))}">👁️ Fiche</button>
              <button class="btn btn-secondary btn-small" data-action="openUrl" data-url="${escapeHtml(a.url)}">🔗</button>
            </div>
          </td>
        </tr>
      `;
      })
      .join('');
  }

  if (viewMode === 'grid') {
    adsGridContainer.innerHTML = filtered
      .map((a) => {
        const isStarred = starredAds.has(String(a.id));
        const thumbUrl = (Array.isArray(a.photosUrls) && a.photosUrls.length > 0) ? a.photosUrls[0]
          : (Array.isArray(a.images) && a.images.length > 0 ? a.images[0] : noPhotoUrl());

        return `
        <div class="ad-card">
          <div class="ad-card-thumb-box">
            <img src="${escapeHtml(thumbUrl)}" alt="Photo" class="ad-card-thumb" data-action="openAdDetail" data-id="${escapeHtml(String(a.id))}">
            <div class="ad-card-star"><span class="star-icon ${isStarred ? 'starred' : ''}" data-action="toggleStar" data-id="${escapeHtml(String(a.id))}">★</span></div>
          </div>
          <div class="ad-card-body">
            <div class="ad-card-title">${escapeHtml(a.title || 'Sans titre')}</div>
            <div class="ad-card-price">${escapeHtml(String(a.prix != null ? a.prix + ' €' : (a.price != null ? a.price + ' €' : '-')))}</div>
            <div class="ad-card-city">📍 ${escapeHtml(a.city || 'Inconnue')}</div>
            <div class="ad-card-footer">
              <button class="btn btn-secondary btn-small" style="flex:1;" data-action="openAdDetail" data-id="${escapeHtml(String(a.id))}">👁️ Fiche Détaillée</button>
              <button class="btn btn-primary btn-small" data-action="openUrl" data-url="${escapeHtml(a.url)}">🔗 Voir</button>
            </div>
          </div>
        </div>
      `;
      })
      .join('');
  }
}

// ⭐ SYSTÈME DE FAVORIS
window.toggleStar = (adId) => {
  const idStr = String(adId);
  if (starredAds.has(idStr)) starredAds.delete(idStr);
  else starredAds.add(idStr);

  localStorage.setItem('starred-ads', JSON.stringify([...starredAds]));
  renderExplorerAds();
};

// 👁️ MODAL FICHE DÉTAILLÉE DE L'ANNONCE
window.openAdDetail = (adId) => {
  let targetAd = null;
  allJobsCache.forEach((j) => {
    if (Array.isArray(j.ads)) {
      const found = j.ads.find((a) => String(a.id) === String(adId));
      if (found) targetAd = found;
    }
  });

  if (!targetAd) return;

  /**
   * Formate une date ISO en JJ/MM/AAAA HH:MM:SS (FR).
   * Renvoie la chaîne d'entrée si la date est invalide/absente.
   */
  function formatDateTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  modalAdTitle.textContent = targetAd.title || 'Sans titre';
  modalPrice.textContent = targetAd.prix != null ? targetAd.prix : (targetAd.price != null ? targetAd.price : '-');
  modalCity.textContent = targetAd.city || 'Inconnue';
  const isProSeller = targetAd.vendeurType === 'pro' || targetAd.isPro === true;
  modalSeller.textContent = includeSellerData ? `${targetAd.vendeurNom || targetAd.seller || 'Particulier'}${isProSeller ? ' (Pro)' : ''}` : ' Masqué';
  modalDate.textContent = targetAd.datePublication || targetAd.date || '-';

  // Nouveaux champs : catégorie, note vendeur, mode de remise
  const setExtraVal = (spanId, text) => {
    const span = document.getElementById(spanId);
    if (span) {
      const valEl = span.querySelector('.modal-extra-val');
      if (valEl) valEl.textContent = text;
    }
  };


  let ratingText = '-';
  const note = targetAd.vendeurNote != null ? targetAd.vendeurNote : targetAd.sellerRating;
  const nbAvis = targetAd.nombreAvis != null ? targetAd.nombreAvis : null;
  if (includeSellerData && note != null) {
    ratingText = `${note}/5`;
    if (nbAvis != null) ratingText += ` (${nbAvis} avis)`;
  }
  setExtraVal('modalSellerRating', includeSellerData ? (note != null ? ratingText : '❓ Aucune note') : ' Masqué');

  // Type de remise unifié
  const dt = targetAd.deliveryType ?? _computeDeliveryTypeCompat(
    targetAd.livraison != null ? targetAd.livraison : targetAd.shipping,
    targetAd.mainPropre != null ? targetAd.mainPropre : targetAd.handDelivery
  );
  const deliveryTypeLabels = {
    livraison: '📦 Livraison uniquement',
    main_propre: '🤝 Main propre uniquement',
    les_deux: '📦🤝 Livraison + Main propre',
    aucun: '🚫 Aucune',
    inconnu: '❓ Indéterminé',
  };
  setExtraVal('modalDeliveryType', deliveryTypeLabels[dt] || '❓ Indéterminé');

  // Likes
  const likes = targetAd.likes != null ? targetAd.likes : null;
  setExtraVal('modalLikes', likes != null ? `❤️ ${likes}` : '❓ Indisponible');

  // Date scraping
  const dateScrape = targetAd.dateScraping;
  setExtraVal('modalDateScraping', dateScrape ? `🕒 ${formatDateTime(dateScrape)}` : '❓ Indisponible');

  // Type vendeur
  const typeVendeur = targetAd.vendeurType || (targetAd.isPro ? 'pro' : 'particulier');
  const typeVendeurLabel = includeSellerData ? (typeVendeur === 'pro' ? '🏪 Professionnel' : '👤 Particulier') : ' Masqué';
  setExtraVal('modalTypeVendeur', typeVendeurLabel);

  // État déclaré uniquement
  const etat = targetAd.etat;
  setExtraVal('modalEtat', etat || '❓ Non précisé');

  // Description : lire description string directement (structure plate v3)
  const modalDescText = typeof targetAd.description === 'string' ? targetAd.description
    : (typeof targetAd.description === 'object' && typeof targetAd.description.originale === 'string' ? targetAd.description.originale : '');
  modalDescription.textContent = modalDescText || 'Aucune description disponible.';

  // Badge favori
  modalDealBadge.className = 'tag-deal-normal';
  modalDealBadge.textContent = starredAds.has(String(targetAd.id)) ? '⭐ Favori' : '';

  // Photos & Carrousel
  const images = (Array.isArray(targetAd.photosUrls) && targetAd.photosUrls.length > 0) ? targetAd.photosUrls
    : (Array.isArray(targetAd.images) && targetAd.images.length > 0 ? targetAd.images : [noPhotoUrl()]);
  mainGalleryImg.src = images[0];

  galleryThumbnails.innerHTML = images
    .map(
      (img, i) => `<img src="${escapeHtml(img)}" alt="Thumb" class="thumb-img ${i === 0 ? 'active' : ''}" data-action="switchGalleryImg" data-url="${escapeHtml(img)}">`
    )
    .join('');

  window.switchGalleryImg = (url, el) => {
    mainGalleryImg.src = url;
    document.querySelectorAll('.thumb-img').forEach((t) => t.classList.remove('active'));
    el.classList.add('active');
  };

  modalOpenLeboncoinBtn.onclick = () => window.openUrl(targetAd.url);

  const isStarred = starredAds.has(String(targetAd.id));
  modalStarBtn.textContent = isStarred ? '⭐ Enlevé des Favoris' : '☆ Ajouter aux Favoris';
  modalStarBtn.onclick = () => {
    window.toggleStar(targetAd.id);
    window.openAdDetail(targetAd.id);
  };

  adDetailModal.classList.remove('hidden');
};

closeDetailModalBtn.addEventListener('click', () => {
  adDetailModal.classList.add('hidden');
});
