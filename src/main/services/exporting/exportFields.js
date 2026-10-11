'use strict';

/**
 * exportFields — module central de configuration des exports.
 *
 * Définit :
 *   - DEFAULT_FIELDS : la liste exhaustive des champs disponibles (mode Défaut).
 *   - FIELD_CATEGORIES : regroupement par catégorie pour faciliter la sélection UI.
 *   - filterAdByFields(ad, fields) : filtre un objet annonce selon un set de champs.
 *   - toReadableBlock(ad, fields, index) : bloc TXT lisible (1 annonce), aligné
 *     sur le mode choisi. Renvoie une string (jamais un objet, jamais undefined).
 *
 * RÈGLE FONDAMENTALE :
 *   - Mode Défaut    → toutes les informations sont exportées.
 *   - Mode Personnalisé → UNIQUEMENT les champs sélectionnés (1, plusieurs,
 *     ou quasi-tous). Les champs absents ne figurent ni dans le JSON, ni dans
 *     le TXT.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Définition des champs exportables (mode Défaut)
// ─────────────────────────────────────────────────────────────────────────────
//
// On couvre tous les champs actuellement produits par adFields.js + normalizeAd.
// L'ordre est FIXE pour conserver la lisibilité TXT.
//
// Chaque champ est décrit par :
//   - key     : identifiant (utilisé dans le JSON, le TXT label)
//   - label   : libellé humain affiché dans le TXT normal
//   - get     : extracteur (ad) => valeur ou null
//   - fmt     : (optionnel) formateur pour le TXT normal, sinon String(v) suffit

const DEFAULT_FIELDS = [
  // ─── IDENTIFICATION ───────────────────────────────────────────────────────
  { key: 'id',          label: 'ID',                          get: (a) => a.id ?? null },
  { key: 'title',       label: 'Titre',                       get: (a) => a.title ?? null },
  { key: 'url',         label: 'URL',                         get: (a) => a.url ?? null },

  // ─── PRIX ─────────────────────────────────────────────────────────────────
  { key: 'prix',        label: 'Prix',                        get: (a) => a.prix ?? null, fmt: (v) => v != null ? `${v} €` : 'null' },

  // ─── LOCALISATION ────────────────────────────────────────────────────────
  { key: 'ville',       label: 'Ville',                       get: (a) => a.city ?? null },
  { key: 'codePostal',  label: 'Code postal',                 get: (a) => a.zipcode ?? null },

  // ─── VENDEUR ─────────────────────────────────────────────────────────────
  { key: 'vendeurNom',          label: 'Vendeur (nom)',           get: (a) => a.vendeurNom ?? null },
  { key: 'vendeurType',         label: 'Vendeur (type)',          get: (a) => a.vendeurType ?? null },
  { key: 'vendeurId',           label: 'Vendeur (ID)',            get: (a) => a.vendeurId ?? null },
  { key: 'vendeurNote',         label: 'Vendeur (note)',          get: (a) => a.vendeurNote ?? null, fmt: (v) => v != null ? `${v}/5` : 'null' },
  { key: 'vendeurNbAvis',       label: 'Vendeur (nb avis)',       get: (a) => a.nombreAvis ?? null },
  { key: 'vendeurUrlProfil',    label: 'Vendeur (URL profil)',    get: (a) => a.vendeurUrlProfil ?? null },
  { key: 'vendeurAnciennete',   label: 'Vendeur (ancienneté, jours)', get: (a) => a.vendeurAncienneteJours ?? null },

  // ─── TRANSACTION ─────────────────────────────────────────────────────────
  { key: 'deliveryType', label: 'Type de remise',              get: (a) => a.deliveryType ?? null, fmt: (v) => v || 'null' },

  // ─── STATS / DATES ───────────────────────────────────────────────────────
  { key: 'likes',              label: 'Likes',            get: (a) => a.likes ?? null },
  { key: 'datePublication',    label: 'Date publication', get: (a) => _fmtDate(a.datePublication) },
  { key: 'dateModification',   label: 'Date modification', get: (a) => _fmtDate(a.dateModification) },
  { key: 'dateScraping',       label: 'Date scraping',     get: (a) => _fmtDate(a.dateScraping) },

  // ─── PRODUIT / ÉTAT ──────────────────────────────────────────────────────
  { key: 'etat',       label: 'État déclaré',                 get: (a) => a.etat ?? null },

  // ─── PHOTOS ──────────────────────────────────────────────────────────────
  { key: 'photosCount', label: 'Nombre de photos',            get: (a) => a.photosCount ?? null },
  { key: 'photosUrls',  label: 'URLs des photos',             get: (a) => Array.isArray(a.photosUrls) ? a.photosUrls.join(',') : null },

  // ─── DESCRIPTION ─────────────────────────────────────────────────────────
  { key: 'description', label: 'Description',                 get: (a) => _descString(a) },
];

// Regroupement par catégorie pour la sélection UI en mode Personnalisé.
const FIELD_CATEGORIES = [
  {
    id: 'identification',
    label: 'Identification',
    keys: ['id', 'title', 'url'],
  },
  {
    id: 'prix',
    label: 'Prix',
    keys: ['prix'],
  },
  {
    id: 'localisation',
    label: 'Localisation',
    keys: ['ville', 'codePostal'],
  },
  {
    id: 'vendeur',
    label: 'Vendeur',
    keys: ['vendeurNom', 'vendeurType', 'vendeurId', 'vendeurNote', 'vendeurNbAvis', 'vendeurUrlProfil', 'vendeurAnciennete'],
  },
  {
    id: 'transaction',
    label: 'Transaction',
    keys: ['deliveryType'],
  },
  {
    id: 'dates',
    label: 'Dates',
    keys: ['datePublication', 'dateModification', 'dateScraping'],
  },
  {
    id: 'stats',
    label: 'Statistiques',
    keys: ['likes'],
  },
  {
    id: 'produit',
    label: 'Produit',
    keys: ['etat'],
  },
  {
    id: 'photos',
    label: 'Photos',
    keys: ['photosCount', 'photosUrls'],
  },
  {
    id: 'description',
    label: 'Description',
    keys: ['description'],
  },
];

// Clés des champs vendeur (pour exclusion optionnelle).
// On liste à la fois les clés d'export (`vendeurNbAvis`, `vendeurAnciennete`)
// ET les clés du modèle `normalizeAd` (`nombreAvis`, `vendeurAncienneteJours`).
// BUG corrigé : en profil Maximum, `filterAdByFields` opère sur l'objet du modèle
// (fields=null → parcours de Object.keys(ad)), donc seules les clés du modèle
// sont présentes. Sans `nombreAvis`/`vendeurAncienneteJours` ici, ces deux champs
// vendeur FUYAIENT malgré « Données vendeur » désactivé (violation RGPD : nombre
// d'avis et ancienneté du compte vendeur sont des données du vendeur).
const SELLER_FIELD_KEYS = new Set([
  'vendeurNom', 'vendeurType', 'vendeurId', 'vendeurNote', 'vendeurNbAvis',
  'vendeurUrlProfil', 'vendeurAnciennete',
  'nombreAvis', 'vendeurAncienneteJours',
]);

// Liste complète des clés pour faciliter les UI « Tout sélectionner ».
const ALL_FIELD_KEYS = DEFAULT_FIELDS.map((f) => f.key);

// Map rapide key → fieldDef (utilisée par les exporters)
const FIELDS_BY_KEY = (() => {
  const m = {};
  for (const f of DEFAULT_FIELDS) m[f.key] = f;
  return m;
})();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de formatage (alignés sur toReadableBlock existant)
// ─────────────────────────────────────────────────────────────────────────────

function _fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function _descString(ad) {
  if (!ad) return '';
  if (typeof ad.description === 'string') return ad.description;
  if (ad.description && typeof ad.description === 'object' && typeof ad.description.originale === 'string') {
    return ad.description.originale;
  }
  return '';
}

function _formatValue(fieldDef, value) {
  if (value == null) return 'null';
  if (typeof fieldDef.fmt === 'function') return fieldDef.fmt(value);
  if (typeof value === 'string') return value;
  return String(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Compatibilité des noms de champs (modèle de données vs clés d'export)
// ─────────────────────────────────────────────────────────────────────────────
//
// HISTORIQUE DU BUG : le modèle produit par normalizeAd() nomme ses champs
// `city`, `zipcode`, `nombreAvis`, `vendeurAncienneteJours`. Les champs
// exportables utilisent des clés « métier » : `ville`, `codePostal`,
// `vendeurNbAvis`, `vendeurAnciennete`. filterAdByFields faisait une simple
// copie `out[key] = ad[key]` → `ad['ville']` n'existe pas (le modèle expose
// `city`), donc ces champs étaient SILENCIEUSEMENT supprimés des exports JSON
// en profils Défaut et Personnalisé.
//
// On distingue deux résolutions :
//   - _resolveRawFieldValue : valeur BRUTE du modèle (JSON), sans formatage,
//     en traduisant la clé d'export vers le nom du champ du modèle.
//   - get du champ (inchangé) : valeur FORMATÉE pour le TXT lisible.
// Les alias ci-dessous couvrent les anciens exports/fixtures qui utiliseraient
// encore les noms « métier » (`ville`, `codePostal`…).
const MODEL_KEY_FOR_EXPORT = {
  ville: 'city',
  codePostal: 'zipcode',
  vendeurNbAvis: 'nombreAvis',
  vendeurAnciennete: 'vendeurAncienneteJours',
};

// Valeur brute du modèle pour une clé d'export : essaie le nom canonique du
// modèle, puis la clé d'export elle-même (rétro-compat fixtures/anciens exports).
function _resolveRawFieldValue(exportKey, ad) {
  if (ad == null || typeof ad !== 'object') return null;
  const modelKey = MODEL_KEY_FOR_EXPORT[exportKey] || exportKey;
  const v = ad[modelKey];
  if (v !== undefined && v !== null) return v;
  const fallback = ad[exportKey];
  return fallback === undefined ? null : fallback;
}

// Valeur lisible (TXT) : le `get` du champ applique le formatage ; si le champ
// d'export n'est pas reconnu par le modèle, repli sur la valeur brute.
function _resolveDisplayFieldValue(fieldDef, ad) {
  const formatted = fieldDef.get ? fieldDef.get(ad) : undefined;
  if (formatted != null) return formatted;
  return _resolveRawFieldValue(fieldDef.key, ad);
}

// ─────────────────────────────────────────────────────────────────────────────
// Filtrage des annonces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construit un objet ne contenant que les champs sélectionnés.
 * Si `fields` est null/undefined ou contient toutes les clés → renvoie l'objet
 * tel quel (mode Défaut).
 *
 * @param {object} ad - L'annonce à filtrer
 * @param {string[]} [fields] - Liste des clés à conserver (null = toutes)
 * @param {object} [options] - Options de filtrage
 * @param {boolean} [options.excludeSellerData] - Si true, exclut les champs vendeur
 */
function filterAdByFields(ad, fields, options) {
  if (!ad || typeof ad !== 'object') return ad;
  const excludeSeller = options && options.excludeSellerData === true;

  // fields null/[] = « toutes les clés » (profil Maximum). On ne peut pas
  // retourner l'objet tel quel si l'utilisateur a demandé à exclure les données
  // vendeur : sinon le réglage « Données vendeur » n'avait AUCUN effet en profil
  // Maximum (les champs vendeur restaient dans l'export).
  if (!fields || !Array.isArray(fields) || fields.length === 0) {
    if (!excludeSeller) return ad;
    const out = {};
    for (const k of Object.keys(ad)) {
      if (!SELLER_FIELD_KEYS.has(k)) out[k] = ad[k];
    }
    return out;
  }

  let selectedKeys = fields;
  if (excludeSeller) {
    selectedKeys = fields.filter((k) => !SELLER_FIELD_KEYS.has(k));
  }

  if (selectedKeys.length >= ALL_FIELD_KEYS.length && ALL_FIELD_KEYS.every((k) => selectedKeys.includes(k))) {
    return ad;
  }

  const out = {};
  // Résout chaque clé sélectionnée vers la valeur BRUTE du modèle (JSON non
  // formaté). Sans cette traduction, les clés d'export sans homonyme exact dans
  // le modèle (`ville`→`city`, `codePostal`→`zipcode`, `vendeurNbAvis`→
  // `nombreAvis`, `vendeurAnciennete`→`vendeurAncienneteJours`) étaient perdues.
  for (const key of selectedKeys) {
    const value = _resolveRawFieldValue(key, ad);
    if (value !== undefined && value !== null) out[key] = value;
    else if (Object.prototype.hasOwnProperty.call(ad, key)) out[key] = ad[key];
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// TXT normal (lisible)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bloc TXT lisible d'une annonce, aligné sur le mode (Défaut / Personnalisé).
 * Le rendu est compacté : on n'affiche QUE les champs sélectionnés, et on
 * conserve le préfixe "===== ANNONCE X =====" pour la navigation humaine.
 *
 * `fields` = tableau de clés sélectionnées. null/undefined → toutes les clés.
 * `options` = { excludeSellerData: boolean } pour exclure les champs vendeur.
 */
function toReadableBlock(ad, index, fields, options) {
  if (!ad || typeof ad !== 'object') ad = {};
  let selectedKeys = (Array.isArray(fields) && fields.length > 0) ? fields : ALL_FIELD_KEYS;
  if (options && options.excludeSellerData) {
    selectedKeys = selectedKeys.filter((k) => !SELLER_FIELD_KEYS.has(k));
  }

  // Calcule la longueur max de label pour aligner joliment les valeurs.
  const fieldDefs = selectedKeys.map((k) => FIELDS_BY_KEY[k]).filter(Boolean);
  const labelMax = fieldDefs.reduce((m, f) => Math.max(m, f.label.length), 0);

  const lines = [];
  lines.push(`===== ANNONCE ${index + 1} =====`);
  lines.push('');

  for (const f of fieldDefs) {
    const raw = _resolveDisplayFieldValue(f, ad);
    const labelPad = f.label.padEnd(labelMax, ' ');
    lines.push(`${labelPad} : ${_formatValue(f, raw)}`);
  }
  lines.push('');
  lines.push('========================');
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  DEFAULT_FIELDS,
  ALL_FIELD_KEYS,
  FIELD_CATEGORIES,
  FIELDS_BY_KEY,
  SELLER_FIELD_KEYS,
  filterAdByFields,
  toReadableBlock,
};
