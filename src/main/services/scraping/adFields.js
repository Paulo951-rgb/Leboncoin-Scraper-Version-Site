'use strict';

/**
 * adFields — extracteurs de champs pour les annonces Leboncoin.
 *
 * Module de SCRAPING PUR : aucun appel IA, aucun prompt, aucun LLM, aucun
 * fetch externe. Reçoit l'objet brut d'une annonce Leboncoin (extrait du HAR
 * ou du __NEXT_DATA__) et renvoie les champs structurés.
 *
 * CONVENTION STRICTE : tout champ non trouvé est `null` (jamais `0`, jamais
 * `''`, jamais une valeur inventée). Les booléens sont nullables (true | false
 * | null) pour distinguer les trois états : détecté OUI, détecté NON, indéterminé.
 */

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return null;
}

function firstNonNull(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (typeof v === 'number' && Number.isNaN(v)) continue;
    return v;
  }
  return null;
}

function _normalizeBool(val) {
  if (val === true || val === 'true' || val === 1 || val === '1') return true;
  if (val === false || val === 'false' || val === 0 || val === '0') return false;
  if (val && typeof val === 'object' && 'value' in val) return _normalizeBool(val.value);
  if (val && typeof val === 'object' && 'shipping' in val) return _normalizeBool(val.shipping);
  return null;
}

/**
 * Extraction de la description depuis l'objet brut Leboncoin.
 * Renvoie une string ou null. Garantit qu'on ne renvoie JAMAIS un objet.
 *
 * La description peut apparaître sous plusieurs formes :
 *   - string direct : raw.body = "texte..."
 *   - objet {text, ...} : raw.body = { text: "texte...", ... }
 *   - string dans raw.description ou raw.text
 */
function extractDescription(raw, opts = {}) {
  const onError = opts.onError || (() => {});
  if (!raw) return null;
  const candidates = [raw.body, raw.description, raw.text];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
    if (c && typeof c === 'object' && typeof c.text === 'string' && c.text.length > 0) return c.text;
  }
  // Si l'annonce a un body mais qu'il n'est pas exploitable (objet sans text,
  // nombre, etc.), c'est potentiellement un changement de structure.
  if (raw.body != null && typeof raw.body !== 'string' && !(raw.body && typeof raw.body.text === 'string')) {
    onError({ code: 'EXTRACTOR_DESCRIPTION_FAILED', message: 'Champ body présent mais non exploitable (type inattendu)' });
  }
  return null;
}

/**
 * Extraction du prix (valeur numérique).
 * Renvoie un nombre ou null.
 */
function extractPrice(raw, opts = {}) {
  const onError = opts.onError || (() => {});
  if (!raw || raw.price == null) return null;
  if (typeof raw.price === 'number') return raw.price;
  if (Array.isArray(raw.price) && raw.price.length > 0) {
    const first = raw.price[0];
    if (first && typeof first === 'object' && first.value != null) {
      const n = parseFloat(first.value);
      if (!Number.isNaN(n)) return n;
    } else if (typeof first === 'number') return first;
    else if (typeof first === 'string') {
      const n = parseFloat(first);
      if (!Number.isNaN(n)) return n;
    }
  } else if (typeof raw.price === 'object' && raw.price.value != null) {
    const n = parseFloat(raw.price.value);
    if (!Number.isNaN(n)) return n;
  } else {
    const n = parseFloat(raw.price);
    if (!Number.isNaN(n)) return n;
  }
  // Si price est présent mais qu'on n'a pas pu le convertir → structure inattendue.
  if (raw.price != null) {
    onError({ code: 'EXTRACTOR_PRICE_FAILED', message: 'Champ price présent mais non convertible en nombre' });
  }
  return null;
}

/**
 * Extraction de la transaction : livraison + main propre, SÉPARÉS et INDÉPENDANTS.
 * Renvoie { livraison, mainPropre }.
 *   livraison  : true / false / null
 *   mainPropre : true / false / null
 */
function extractTransaction(raw) {
  const shippingVal = firstNonNull(
    raw?.has_option?.shipping,
    raw?.options?.shipping,
    raw?.has_shipping,
    raw?.shipping,
    raw?.delivery?.shipping,
    raw?.shipping_option?.shipping,
    raw?.shippingOptions,
    raw?.is_shippable,
    raw?.shippable,
    raw?.is_shipping,
    null
  );
  let livraison = _normalizeBool(shippingVal);

  if (livraison === null && Array.isArray(raw?.attributes)) {
    for (const attr of raw.attributes) {
      if (!attr || typeof attr !== 'object') continue;
      const key = String(attr.key || attr.name || '').toLowerCase();
      const val = attr.value;
      if (key === 'shippable' || key === 'is_shippable' || key === 'shipping' || key === 'is_shipping') {
        livraison = _normalizeBool(val);
        if (livraison !== null) break;
      }
    }
  }

  // Détection main propre via description.
  let mainPropre = null;
  const body = extractDescription(raw);
  if (body) {
    const lower = body.toLowerCase();
    if (/remise\s+en\s+main\s+propre|main\s+propre\s+uniquement|en\s+main\s+propre|retrait\s+sur\s+place|[àa]\s+venir\s+chercher|retrait\s+en\s+main\s+propre|pas\s+d.envoi|pas\s+d.exp[ée]dition|pas\s+de\s+livraison/.test(lower)) {
      mainPropre = true;
    }
  }

  return { livraison, mainPropre };
}

/**
 * Calcule le `deliveryType` unifié à partir des deux booléens internes
 * `livraison` et `mainPropre` (extraits par extractTransaction).
 *
 * Renvoie une chaîne canonique :
 *   - "les_deux"     : livraison=true ET mainPropre=true
 *   - "livraison"    : livraison=true, mainPropre=false/null
 *   - "main_propre"  : livraison=false/null, mainPropre=true
 *   - "aucun"        : livraison=false ET mainPropre=false
 *   - "inconnu"      : livraison=null ET mainPropre=null (indéterminé)
 *
 * @param {boolean|null} livraison
 * @param {boolean|null} mainPropre
 * @returns {string}
 */
function computeDeliveryType(livraison, mainPropre) {
  if (livraison === true && mainPropre === true) return 'les_deux';
  if (livraison === true && mainPropre === false) return 'livraison';
  if (livraison === true && mainPropre === null) return 'livraison';
  if (livraison === false && mainPropre === true) return 'main_propre';
  if (livraison === null && mainPropre === true) return 'main_propre';
  if (livraison === false && mainPropre === false) return 'aucun';
  if (livraison === false && mainPropre === null) return 'aucun';
  if (livraison === null && mainPropre === false) return 'aucun';
  // both null
  return 'inconnu';
}

/**
 * Extraction des likes / favoris.
 * Renvoie un nombre ou null (0 = Leboncoin affiche 0, null = info absente).
 */
function extractLikes(raw) {
  const likesRaw = firstNonNull(
    raw?.favorites_count,
    raw?.likes_count,
    raw?.nb_favorites,
    raw?.fav_count,
    raw?.favourites_count,
    raw?.likes,
    null
  );
  if (likesRaw == null) return null;
  const n = parseInt(likesRaw, 10);
  if (!Number.isNaN(n) && n >= 0) return n;
  return null;
}

/**
 * Extraction des photos : URLs.
 * Renvoie { count, urls }.
 */
function extractPhotos(raw, opts = {}) {
  const onError = opts.onError || (() => {});
  let urls = [];
  if (Array.isArray(raw?.images?.urls)) {
    urls = raw.images.urls.filter((u) => typeof u === 'string' && u.trim() !== '');
  } else if (Array.isArray(raw?.images)) {
    urls = raw.images.filter((u) => typeof u === 'string' && u.trim() !== '');
  } else if (raw?.images != null && !Array.isArray(raw.images) && typeof raw.images === 'object' && !Array.isArray(raw.images.urls)) {
    // images est un objet mais sans urls array → structure potentiellement changée.
    onError({ code: 'EXTRACTOR_PHOTOS_FAILED', message: 'Champ images présent mais structure inattendue (ni array ni {urls:[]})' });
  }
  // Déduplication en conservant l'ordre : une même URL répétée dans la réponse
  // ne doit pas gonfler photosCount ni dupliquer la galerie. Toutes les URL
  // uniques réellement fournies sont conservées (aucune troncature).
  const seen = new Set();
  const unique = [];
  for (const u of urls) {
    const key = u.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(u);
  }
  return { count: unique.length, urls: unique };
}

/**
 * Extraction du vendeur.
 * Renvoie { nom, type, id, note, urlProfil, ancienneteJours }.
 */
function extractSeller(raw, opts = {}) {
  const onError = opts.onError || (() => {});
  const owner = raw?.owner || {};
  const seller = raw?.seller || {};
  const store = raw?.store || {};

  const nom = firstNonNull(
    typeof owner.name === 'string' ? owner.name : null,
    typeof owner.store_name === 'string' ? owner.store_name : null,
    typeof seller.name === 'string' ? seller.name : null,
    typeof store.name === 'string' ? store.name : null,
    raw?.owner_name,
    raw?.seller_name,
    typeof raw?.store_name === 'string' ? raw.store_name : null,
    null
  );
  // Si owner existe mais sans name ni store_name → possible changement de structure.
  if (!nom && raw?.owner && typeof raw.owner === 'object' && !raw.owner.name && !raw.owner.store_name) {
    onError({ code: 'EXTRACTOR_SELLER_NAME_FAILED', message: 'Champ owner.name absent alors que owner existe' });
  }

  const id = firstNonNull(owner.user_id, owner.id, seller.id, store.id, raw?.user_id, raw?.owner_id, null);
  // Si owner existe avec un user_id attendu mais absent → possible changement de structure.
  if (!id && raw?.owner && typeof raw.owner === 'object' && !raw.owner.user_id && !raw.owner.id) {
    onError({ code: 'EXTRACTOR_SELLER_ID_FAILED', message: 'Champ owner.user_id absent alors que owner existe' });
  }

  const rawType = firstNonNull(owner.type, seller.type, store.type, raw?.user_type, null);
  let type = null;
  if (rawType) {
    const t = String(rawType).toLowerCase();
    if (t === 'pro' || t === 'professional') type = 'pro';
    else if (t === 'private' || t === 'particulier' || t === 'individual') type = 'particulier';
  }
  const isPro = type === 'pro' || store.is_pro === true || (owner.siren != null && owner.siren !== '');

  let note = null;
  const ratingVal = firstNonNull(owner.rating, owner.rating_average, owner.score, owner.ratingValue, seller.rating, raw?.seller_rating, raw?.rating, null);
  if (ratingVal !== null) {
    const n = parseFloat(ratingVal);
    if (!Number.isNaN(n) && n >= 0 && n <= 5) note = Math.round(n * 10) / 10;
  } else if (raw?.owner && typeof raw.owner === 'object' && raw.owner.rating === undefined && raw.owner.rating_average === undefined) {
    // owner existe mais aucune clé de rating → possible changement de structure.
    onError({ code: 'EXTRACTOR_SELLER_RATING_FAILED', message: 'Champ owner.rating absent alors que owner existe' });
  }

  let nombreAvis = null;
  const countVal = firstNonNull(
    owner.nb_ratings, owner.ratings_count, owner.rating_count, owner.nbReviews, owner.review_count, owner.nb_reviews,
    owner.reviews_count, owner.total_ratings, owner.feedback_count,
    seller.nb_ratings, seller.ratings_count, seller.nb_reviews, seller.review_count,
    raw?.seller_rating_count, raw?.nb_ratings, raw?.nb_reviews, raw?.review_count, raw?.ratings_count,
    null
  );
  if (countVal !== null) {
    const c = parseInt(countVal, 10);
    if (!Number.isNaN(c) && c >= 0) nombreAvis = c;
  }

  // URL du profil vendeur. Leboncoin expose plusieurs variantes selon la
  // source (liste vs page de détail) : owner.profile_url, owner.url, seller.url,
  // store.url, owner.web_url, owner.shop_url, owner.profile, owner.href.
  const urlProfil = firstNonNull(
    owner.profile_url, owner.web_url, owner.shop_url, owner.url, owner.profile, owner.href,
    seller.profile_url, seller.url, seller.href,
    store.profile_url, store.url, store.href,
    raw?.owner_url, raw?.profile_url, raw?.seller_url,
    null
  );

  // Ancienneté du compte vendeur. On cherche une date de création/inscription
  // réellement exposée par Leboncoin (owner.member_since / registration_date /
  // since / creation_date / account_creation_date / inscription_date / since_date).
  // Aucune URL de profil n'est fabriquée et aucune date n'est inventée : si la
  // donnée est absente, on conserve null.
  let ancienneteJours = null;
  const memberSince = firstNonNull(
    owner.member_since, owner.registration_date, owner.since, owner.creation_date,
    owner.account_creation_date, owner.inscription_date, owner.since_date, owner.created_at,
    seller.member_since, seller.registration_date, seller.since, seller.creation_date,
    raw?.member_since, raw?.registration_date, raw?.since, raw?.account_creation_date,
    null
  );
  if (memberSince) {
    const d = new Date(memberSince);
    if (!Number.isNaN(d.getTime())) {
      ancienneteJours = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
    }
  }

  return {
    nom,
    type,
    isPro,
    id: id != null ? String(id) : null,
    note,
    nombreAvis,
    urlProfil,
    ancienneteJours,
  };
}

/**
 * Extraction des dates : publication, modification.
 * Renvoie { publication, modification }.
 */
function extractDates(raw, opts = {}) {
  const onError = opts.onError || (() => {});
  const publication = firstNonNull(
    raw?.first_publication_date,
    raw?.publication_date,
    raw?.index_date,
    raw?.date,
    raw?.created_at,
    null
  );
  const modification = firstNonNull(
    raw?.last_update_date,
    raw?.modification_date,
    raw?.updated_at,
    raw?.refresh_date,
    null
  );
  // Si l'annonce a des champs mais aucune date de publication reconnue →
  // possible changement de structure.
  if (!publication && raw && typeof raw === 'object' && !raw.first_publication_date && !raw.publication_date && !raw.index_date && !raw.date && !raw.created_at && Object.keys(raw).length > 3) {
    onError({ code: 'EXTRACTOR_DATES_FAILED', message: 'Aucune date de publication reconnue alors que l\'annonce contient des données' });
  }
  return { publication, modification };
}

/**
 * Extraction de l'État déclaré du produit.
 * Renvoie l'état tel que déclaré par le vendeur dans les attributs structurés
 * (champ "condition" / "etat" / "état" dans le tableau attributes[]).
 * Renvoie null si non trouvé.
 */
function extractCondition(raw) {
  if (Array.isArray(raw?.attributes)) {
    for (const attr of raw.attributes) {
      if (!attr || typeof attr !== 'object') continue;
      const key = String(attr.key || attr.name || '').toLowerCase();
      if (key === 'condition' || key === 'etat' || key === 'état') {
        const v = firstNonNull(attr.value, attr.label, null);
        if (v != null && v !== '') return String(v);
      }
    }
  }
  return null;
}

module.exports = {
  firstDefined,
  firstNonNull,
  extractDescription,
  extractPrice,
  extractTransaction,
  computeDeliveryType,
  extractLikes,
  extractPhotos,
  extractSeller,
  extractDates,
  extractCondition,
};
