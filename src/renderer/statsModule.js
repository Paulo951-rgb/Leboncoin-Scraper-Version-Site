const statTotalAds = document.getElementById('statTotalAds');
const statAvgPrice = document.getElementById('statAvgPrice');
const statMedPrice = document.getElementById('statMedPrice');
const statMinPrice = document.getElementById('statMinPrice');
const statMaxPrice = document.getElementById('statMaxPrice');
const statHandDelivery = document.getElementById('statHandDelivery');
const statLivraison = document.getElementById('statLivraison');
const statDeliveryTypeDist = document.getElementById('statDeliveryTypeDist');

// Compat + sélection des points de carte : regroupés dans un seul IIFE qui
// expose les helpers au `window` pour que les tests puissent les charger
// directement (sans jsdom ni Leaflet). Les fonctions rendues globales portent
// des noms explicites ; le rendu réel (renderMap) reste appelé par renderStatsView.
(() => {
  /**
   * Calcule le deliveryType depuis les anciens champs livraison/mainPropre
   * pour la rétro-compatibilité des annonces cachées sans deliveryType.
   */
  function _computeDeliveryTypeCompatMap(livraison, mainPropre) {
    if (livraison === true && mainPropre === true) return 'les_deux';
    if (livraison === true) return 'livraison';
    if (mainPropre === true) return 'main_propre';
    if (livraison === false && mainPropre === false) return 'aucun';
    if (livraison === false) return 'aucun';
    if (mainPropre === false) return 'aucun';
    return 'inconnu';
  }

  function _deliveryTypeOf(a) {
    return a.deliveryType ?? _computeDeliveryTypeCompatMap(
      a.livraison ?? a.shipping,
      a.mainPropre ?? a.handDelivery
    );
  }

  // Déduplique (une même annonce peut apparaître dans plusieurs sessions) puis
  // applique, si demandé, le filtre « remise en main propre ». Logique pure,
  // testable sans DOM ni Leaflet.
  function computeMapPoints(ads, handDeliveryOnly) {
    const list = Array.isArray(ads) ? ads : [];
    const seen = new Set();
    const deduped = [];
    for (const a of list) {
      const key = a.id || a.url || a.title;
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      deduped.push(a);
    }
    const target = handDeliveryOnly
      ? deduped.filter((a) => {
          const dt = _deliveryTypeOf(a);
          return dt === 'main_propre' || dt === 'les_deux';
        })
      : deduped;
    return { deduped, target };
  }

  // Coordonnées valides = [lat, lng] finis, lat ∈ [-90,90], lng ∈ [-180,180].
  // Ignore proprement les coordonnées absentes, nulles ou hors bornes au lieu de
  // placer une annonce à un emplacement inventé.
  function isValidLatLng(coords) {
    return Array.isArray(coords) && coords.length === 2 &&
      Number.isFinite(coords[0]) && Number.isFinite(coords[1]) &&
      coords[0] >= -90 && coords[0] <= 90 &&
      coords[1] >= -180 && coords[1] <= 180;
  }

  Object.assign(window, { _computeDeliveryTypeCompatMap, _deliveryTypeOf, computeMapPoints, isValidLatLng });
})();
const statPro = document.getElementById('statPro');
const statPart = document.getElementById('statPart');

// PAGE STATISTIQUES & CARTE LEAFLET
async function loadStatsPage() {
  allJobsCache = await window.api.getHistory();
  populateSessionDropdown(statsSessionSelect);
  renderStatsView();
}

statsSessionSelect.addEventListener('change', renderStatsView);

function renderStatsView() {
  const selectedJobId = statsSessionSelect.value;
  let sourceAds = [];

  if (selectedJobId === 'ALL') {
    allJobsCache.forEach((j) => {
      if (Array.isArray(j.ads)) sourceAds.push(...j.ads);
    });
  } else {
    const found = allJobsCache.find((j) => j.id === selectedJobId);
    if (found && Array.isArray(found.ads)) sourceAds = found.ads;
  }

  // Extraction robuste des prix : gère number, string avec format FR/EN
  const prices = [];
  for (const a of sourceAds) {
    const raw = a.prix ?? a.price;
    if (raw == null || raw === '') continue;
    let n;
    if (typeof raw === 'number') {
      n = Number.isFinite(raw) ? raw : NaN;
    } else if (typeof raw === 'string') {
      n = parseFloat(raw.replace(/\s/g, '').replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
    } else {
      n = NaN;
    }
    if (Number.isFinite(n) && n > 0) prices.push(n);
  }
  prices.sort((a, b) => a - b);
  const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('fr-FR') : '-');

  statTotalAds.textContent = sourceAds.length;

  if (prices.length > 0) {
    const sum = prices.reduce((s, p) => s + p, 0);
    const avg = Math.round(sum / prices.length);
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 !== 0 ? prices[mid] : Math.round((prices[mid - 1] + prices[mid]) / 2);

    statAvgPrice.textContent = fmt(avg) + ' €';
    if (statMedPrice) statMedPrice.textContent = fmt(median) + ' €';
    statMinPrice.textContent = fmt(prices[0]) + ' €';
    statMaxPrice.textContent = fmt(prices[prices.length - 1]) + ' €';
  } else {
    statAvgPrice.textContent = '-';
    if (statMedPrice) statMedPrice.textContent = '-';
    statMinPrice.textContent = '-';
    statMaxPrice.textContent = '-';
  }

  // Statistiques deliveryType (modèle unifié)
  let livraisonCount = 0;
  let mainPropreCount = 0;
  let lesDeuxCount = 0;
  let aucunCount = 0;
  let inconnuCount = 0;
  let nonRenseigneCount = 0;

  for (const a of sourceAds) {
    let dt = a.deliveryType;
    if (!dt) {
      const livraison = a.livraison ?? a.shipping;
      const mainPropre = a.mainPropre ?? a.handDelivery;
      // Doit reproduire computeDeliveryType : false + null → aucun (pas inconnu),
      // sinon l'onglet Stats diverge de l'explorateur et de la fiche annonce.
      if (livraison === true && mainPropre === true) dt = 'les_deux';
      else if (livraison === true) dt = 'livraison';
      else if (mainPropre === true) dt = 'main_propre';
      else if (livraison === false || mainPropre === false) dt = 'aucun';
      else dt = 'inconnu';
    }
    if (dt === 'livraison') livraisonCount++;
    else if (dt === 'main_propre') mainPropreCount++;
    else if (dt === 'les_deux') lesDeuxCount++;
    else if (dt === 'aucun') aucunCount++;
    else { inconnuCount++; nonRenseigneCount++; }
  }

  const proCount = sourceAds.filter((a) => a.vendeurType === 'pro').length;
  const partCount = sourceAds.length - proCount;

  // Cartes livraison / main propre : compte les annonces qui proposent ce mode
  // (livraison seule OU les_deux pour livraison ; main_propre seule OU les_deux pour main propre)
  statHandDelivery.textContent = fmt(mainPropreCount + lesDeuxCount);
  statLivraison.textContent = fmt(livraisonCount + lesDeuxCount);
  if (statDeliveryTypeDist) {
    statDeliveryTypeDist.textContent = `${fmt(livraisonCount)} / ${fmt(mainPropreCount)} / ${fmt(lesDeuxCount)} / ${fmt(aucunCount)} / ${fmt(inconnuCount)}`;
  }
  statPro.textContent = fmt(proCount);
  statPart.textContent = fmt(partCount);

  renderCharts(sourceAds, { livraisonCount, mainPropreCount, lesDeuxCount, aucunCount, inconnuCount, nonRenseigneCount });
  renderMap(sourceAds);
}

// 🗺️ NOUVEAU : Géocodeur officiel API Gouv France avec Cache Local (LocalStorage)
async function geocodeCityGov(cityName, zipcode) {
  if (!cityName) return null;
  const cleanCity = cityName.toLowerCase().trim();
  const cacheKey = `geo-cache-${cleanCity}-${zipcode || ''}`;
  
  // Lecture du cache local (tolérant aux données corrompues : un cache mal
  // écrit ne doit pas faire crasher tout le rendu de carte).
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length === 2) return parsed;
      localStorage.removeItem(cacheKey);
    } catch {
      localStorage.removeItem(cacheKey);
    }
  }

  try {
    let url = `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(cleanCity)}&fields=centre&limit=1`;
    if (zipcode && /^\d{5}$/.test(zipcode)) {
      url = `https://geo.api.gouv.fr/communes?codePostal=${zipcode}&fields=centre&limit=1`;
    }

    // Timeout : sans AbortController, une API gouv injoignable pouvait bloquer
    // indéfiniment le rendu de la carte (fetch natif n'a pas d'option timeout).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      const data = await res.json();
      if (data && data[0] && data[0].centre) {
        const lngLat = data[0].centre.coordinates; // Format gouv : [longitude, latitude]
        const latLng = [lngLat[1], lngLat[0]]; // Format Leaflet : [latitude, longitude]
        
        localStorage.setItem(cacheKey, JSON.stringify(latLng)); // Sauvegarde cache
        return latLng;
      }
    }
  } catch (err) {
    console.warn(`[Geocoding API Gouv] Échec pour la ville ${cityName} :`, err.message);
  }
  return null;
}

// Affiche un message d'état sous la carte (aucun point, Leaflet indisponible,
// coordonnées manquantes…) sans toucher au DOM interne de Leaflet (écrire dans
// le conteneur de la carte le détruirait).
function setMapStatus(message) {
  const el = document.getElementById('mapStatus');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

// 🗺️ CARTE INTERACTIVE LEAFLET AVEC FILTRAGE MAIN PROPRE ET API GOUV (SUR SAUVEGARDE PROPRE)
async function renderMap(ads) {
  // Diagnostic Leaflet : si le script CDN n'a pas pu charger (réseau bloqué,
  // CSP, etc.), on prévient l'utilisateur au lieu de rester silencieux.
  if (typeof L === 'undefined') {
    setMapStatus('⚠️ Carte indisponible : la bibliothèque Leaflet n\'a pas pu être chargée (connexion Internet requise).');
    console.warn('[Carte] Leaflet non disponible (L undefined) — vérifiez la connectivité ou la CSP.');
    return;
  }

  // Invalide tout run précédent : on est désormais la plus récente renderMap.
  const gen = ++mapRenderGen;
  const isStale = () => gen !== mapRenderGen;

  try {
    if (!mapInstance) {
      mapInstance = L.map('leafletMap').setView([46.603354, 1.888334], 5);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '© OpenStreetMap',
      }).addTo(mapInstance);
    }

    // Calque dédié aux marqueurs : vidé à chaque rendu. On n'utilise PAS
    // `instanceof L.Marker` (fragile si le constructeur change de référence) et
    // on garantit l'absence de doublons de marqueurs après plusieurs rendus.
    if (!mapMarkerLayer) {
      mapMarkerLayer = L.layerGroup().addTo(mapInstance);
    }
    mapMarkerLayer.clearLayers();

    const mapHandDeliveryEl = document.getElementById('mapHandDeliveryOnly');
    const mapHandDeliveryOnly = !!(mapHandDeliveryEl && mapHandDeliveryEl.checked);

    const { deduped, target } = computeMapPoints(ads, mapHandDeliveryOnly);
    const dupes = ads.length - deduped.length;
    console.log(`[Carte] ${mapHandDeliveryOnly ? 'Filtre main propre ON' : 'Filtre main propre OFF'} : ${target.length} annonce(s) à géocoder sur ${deduped.length} (${dupes} doublon(s) supprimé(s))`);

    // Rien à afficher : message explicite plutôt qu'une carte muette.
    if (target.length === 0) {
      setMapStatus(mapHandDeliveryOnly
        ? 'Aucune annonce en remise en main propre dans cette sélection. Décochez le filtre pour afficher toutes les annonces localisables.'
        : 'Aucune annonce à localiser dans cette sélection.');
      if (mapInstance) mapInstance.invalidateSize();
      return;
    }

    // Géocodage à concurrence limitée
    const GEOCODE_CONCURRENCY = 6;
    const queue = [...target];
    let placed = 0;
    let geocodeFailed = 0;

    const placeMarker = (a, coords) => {
      if (isStale()) return;
      if (!isValidLatLng(coords)) { geocodeFailed++; return; }
      // Léger décalage pour éviter la superposition exacte de plusieurs annonces
      // d'une même ville ; reste dans l'ordre [latitude, longitude] attendu par
      // Leaflet (le géocodeur gouv renvoie [longitude, latitude], déjà inversé).
      const jitterCoords = [
        coords[0] + (Math.random() - 0.5) * 0.012,
        coords[1] + (Math.random() - 0.5) * 0.012,
      ];
      const marker = L.marker(jitterCoords);
      const dt = _deliveryTypeOf(a);
      const deliveryTxt = dt === 'livraison' ? '📦 Livraison possible'
        : dt === 'main_propre' ? '🤝 Remise en main propre'
        : dt === 'les_deux' ? '📦🤝 Livraison + Main propre'
        : dt === 'aucun' ? '🚫 Aucune remise'
        : 'ℹ️ Remise non précisée';
      marker.bindPopup(`
        <div style="font-family:sans-serif; font-size:0.8rem; line-height:1.3;">
          <strong>${escapeHtml(a.title)}</strong><br>
          <span style="color:var(--primary-color); font-weight:bold;">${a.prix != null ? a.prix + ' €' : (a.price != null ? a.price + ' €' : '-')}</span><br>
          📍 ${escapeHtml(a.city || 'Ville')}<br>
          ${deliveryTxt}<br>
          <a href="#" data-action="openUrl" data-url="${escapeHtml(a.url)}" style="color:#38bdf8; text-decoration:underline;">Ouvrir l'annonce</a>
        </div>
      `);
      mapMarkerLayer.addLayer(marker);
      placed++;
    };

    const worker = async () => {
      while (queue.length > 0) {
        if (isStale()) return;
        const a = queue.shift();
        if (!a) break;
        try {
          const coords = await geocodeCityGov(a.city, a.zipcode);
          placeMarker(a, coords);
        } catch (err) {
          geocodeFailed++;
          console.warn(`[Carte] géocodage échoué pour ${a.city || '?'} :`, err.message);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(GEOCODE_CONCURRENCY, target.length) }, () => worker()));

    // Un rendu plus récent a pris le relais : ne pas écraser son message.
    if (isStale()) return;

    // Compte-rendu utilisateur : nombre de points affichés + raison si vide.
    if (placed === 0) {
      setMapStatus('Aucune annonce localisable dans cette sélection (villes ou codes postaux absents/reconnus par le géocodage).');
    } else {
      const parts = [`${placed} annonce(s) localisée(s) sur la carte.`];
      if (geocodeFailed > 0) parts.push(`${geocodeFailed} sans coordonnées exploitables.`);
      if (dupes > 0) parts.push(`${dupes} doublon(s) ignoré(s).`);
      setMapStatus(parts.join(' '));
    }

    // Important : invalider la taille après le rendu pour que Leaflet recalcule
    if (mapInstance) mapInstance.invalidateSize();
  } catch (err) {
    console.error('[Carte] Erreur lors du rendu de la carte :', err.message);
    setMapStatus('⚠️ Impossible d\'afficher la carte (erreur d\'initialisation).');
  }
}


function renderCharts(ads, transactionStats) {
  // Garde contre les canvas absents du DOM
  const priceDistCanvas = document.getElementById('priceDistChart');
  const sellerCanvas = document.getElementById('sellerChart');
  const citiesCanvas = document.getElementById('topCitiesChart');
  const transactionCanvas = document.getElementById('transactionChart');
  if (!priceDistCanvas || !sellerCanvas || !citiesCanvas || !transactionCanvas) return;

  // Aucune donnée (ou Chart.js indisponible) : on DÉTRUIT les instances
  // existantes pour ne pas laisser à l'écran les graphiques de la session
  // précédente (données fantômes). L'ancien early-return laissait les anciens
  // graphiques affichés quand on bascule sur une session sans annonces.
  if (typeof Chart === 'undefined' || ads.length === 0) {
    if (priceDistChartInstance) { priceDistChartInstance.destroy(); priceDistChartInstance = null; }
    if (sellerChartInstance) { sellerChartInstance.destroy(); sellerChartInstance = null; }
    if (topCitiesChartInstance) { topCitiesChartInstance.destroy(); topCitiesChartInstance = null; }
    if (transactionChartInstance) { transactionChartInstance.destroy(); transactionChartInstance = null; }
    return;
  }

  // 1) Distribution des prix (histogramme)
  const prices = [];
  for (const a of ads) {
    const raw = a.prix ?? a.price;
    if (raw == null || raw === '') continue;
    let n;
    if (typeof raw === 'number') {
      n = Number.isFinite(raw) ? raw : NaN;
    } else if (typeof raw === 'string') {
      n = parseFloat(raw.replace(/\s/g, '').replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
    } else {
      n = NaN;
    }
    if (Number.isFinite(n) && n > 0) prices.push(n);
  }
  prices.sort((a, b) => a - b);
  const priceDistCtx = priceDistCanvas.getContext('2d');
  if (priceDistChartInstance) priceDistChartInstance.destroy();

  if (prices.length > 0) {
    const maxPrice = prices[prices.length - 1];
    // Bornes adaptatives : jusqu'à 8 tranches
    const bucketCount = Math.min(8, Math.max(3, Math.ceil(Math.sqrt(prices.length))));
    const bucketSize = Math.max(1, Math.ceil(maxPrice / bucketCount));
    const buckets = new Array(bucketCount).fill(0);
    const labels = [];
    for (let i = 0; i < bucketCount; i++) {
      const lo = i * bucketSize;
      const hi = (i + 1) * bucketSize;
      labels.push(lo === 0 ? `0–${hi} €` : `${lo}–${hi} €`);
    }
    for (const p of prices) {
      let idx = Math.floor(p / bucketSize);
      if (idx >= bucketCount) idx = bucketCount - 1;
      buckets[idx]++;
    }
    priceDistChartInstance = new Chart(priceDistCtx, {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Nombre d\'annonces', data: buckets, backgroundColor: '#38bdf8', borderRadius: 6 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { title: { display: true, text: 'Distribution des Prix' }, legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  }

  // 2) Vendeurs particuliers vs pros — barres horizontales comparatives
  // (remplace le camembert/doughnut peu lisible pour comparer 2 valeurs).
  const proCount = ads.filter((a) => a.vendeurType === 'pro').length;
  const partCount = ads.length - proCount;
  const total = partCount + proCount;
  const partPct = total ? Math.round((partCount / total) * 100) : 0;
  const proPct = total ? 100 - partPct : 0;
  const sellerCtx = sellerCanvas.getContext('2d');
  if (sellerChartInstance) sellerChartInstance.destroy();

  sellerChartInstance = new Chart(sellerCtx, {
    type: 'bar',
    data: {
      labels: ['Particuliers', 'Professionnels'],
      datasets: [{
        label: 'Nombre d\'annonces',
        data: [partCount, proCount],
        backgroundColor: ['#38bdf8', '#8b5cf6'],
        borderRadius: 8,
        borderSkipped: false,
        barPercentage: 0.65,
        categoryPercentage: 0.7,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: 'Vendeurs Particuliers vs Pros', padding: { bottom: 10 } },
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          padding: 12,
          cornerRadius: 8,
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.x;
              const pct = total ? Math.round((v / total) * 100) : 0;
              return `${ctx.label}: ${v.toLocaleString('fr-FR')} (${pct}%)`;
            },
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: { precision: 0, color: getComputedStyle(document.body).getPropertyValue('--text-muted').trim() || '#94a3b8' },
          grid: { color: 'rgba(148,163,184,0.12)' },
        },
        y: {
          ticks: { color: getComputedStyle(document.body).getPropertyValue('--text-muted').trim() || '#94a3b8' },
          grid: { display: false },
        },
      },
    },
  });

  // 3) Top 10 villes par nombre d'annonces
  const cityCounts = {};
  for (const a of ads) {
    const c = (a.city || 'Inconnue').trim() || 'Inconnue';
    cityCounts[c] = (cityCounts[c] || 0) + 1;
  }
  const topCities = Object.entries(cityCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const citiesCtx = citiesCanvas.getContext('2d');
  if (topCitiesChartInstance) topCitiesChartInstance.destroy();

  topCitiesChartInstance = new Chart(citiesCtx, {
    type: 'bar',
    data: {
      labels: topCities.map((c) => c[0]),
      datasets: [{ label: 'Annonces', data: topCities.map((c) => c[1]), backgroundColor: '#22c55e', borderRadius: 6 }],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { title: { display: true, text: 'Top 10 Villes' }, legend: { display: false } },
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 } },
        // Force l'affichage des 10 labels de villes (autoSkip désactivé, aucun
        // masquage alterné).
        y: { ticks: { autoSkip: false, maxTicksLimit: 10 } },
      },
    },
  });

  // 4) Modes de remise (deliveryType : livraison / main_propre / les_deux / aucun / inconnu)
  const tStats = transactionStats || { livraisonCount: 0, mainPropreCount: 0, lesDeuxCount: 0, aucunCount: 0, inconnuCount: 0, nonRenseigneCount: 0 };
  const transactionCtx = transactionCanvas.getContext('2d');
  if (transactionChartInstance) transactionChartInstance.destroy();

  transactionChartInstance = new Chart(transactionCtx, {
    type: 'bar',
    data: {
      labels: ['📦 Livraison', '🤝 Main propre', '📦+🤝 Les deux', '🚫 Aucun', '❓ Inconnu'],
      datasets: [{
        label: 'Nombre d\'annonces',
        data: [tStats.livraisonCount, tStats.mainPropreCount, tStats.lesDeuxCount, tStats.aucunCount || 0, tStats.inconnuCount || tStats.nonRenseigneCount || 0],
        backgroundColor: ['#38bdf8', '#22c55e', '#a855f7', '#f97316', '#64748b'],
        borderRadius: 8,
        borderSkipped: false,
        barPercentage: 0.65,
        categoryPercentage: 0.7,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: 'Modes de Remise', padding: { bottom: 10 } },
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          padding: 12,
          cornerRadius: 8,
          callbacks: {
            label: (ctx) => `${ctx.label}: ${ctx.parsed.x.toLocaleString('fr-FR')}`,
          },
        },
      },
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 } },
        y: { ticks: { color: getComputedStyle(document.body).getPropertyValue('--text-muted').trim() || '#94a3b8' }, grid: { display: false } },
      },
    },
  });
}

// Écouteur pour rafraîchir la carte si on coche/décoche la remise en main propre
document.getElementById('mapHandDeliveryOnly')?.addEventListener('change', () => {
  renderStatsView();
});
