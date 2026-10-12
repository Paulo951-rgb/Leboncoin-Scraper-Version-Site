'use strict';

/**
 * Lecture des résultats d'une tâche (annonces.json / annonces.txt / export-meta).
 *
 * Réutilise les modules existants :
 *   - readWithChecksum (intégrité SHA-256)
 *   - AdStats.analyze  (statistiques de prix + deliveryType)
 *   - filterAdByFields (exclusion des données vendeur + champs internes)
 *
 * SÉCURITÉ : les champs internes (`raw`, `extractionErrors`, `livraison`,
 * `mainPropre`) sont TOUJOURS retirés avant exposition. Si le réglage « Données
 * vendeur » est désactivé, les champs vendeur sont exclus des réponses API.
 */

const fs = require('fs');
const path = require('path');
const { readWithChecksum } = require('../main/utils/integrity');
const { AdStats } = require('../main/services/analysis/adStats');
const { filterAdByFields } = require('../main/services/exporting/exportFields');

const INTERNAL_FIELDS = ['raw', 'extractionErrors', 'livraison', 'mainPropre'];

function stripInternal(ad) {
  if (!ad || typeof ad !== 'object') return ad;
  const copy = { ...ad };
  for (const k of INTERNAL_FIELDS) delete copy[k];
  return copy;
}

/**
 * Lit et nettoie les annonces d'un dossier de résultats.
 * @param {string} resultsDir
 * @param {boolean} includeSellerData
 * @returns {{ ads: Array, valid: boolean, reason: string|null, meta: object|null }}
 */
function readResults(resultsDir, includeSellerData) {
  const jsonPath = path.join(resultsDir, 'annonces.json');
  const metaPath = path.join(resultsDir, 'export-meta.json');
  let ads = [];
  let valid = false;
  let reason = null;

  if (fs.existsSync(jsonPath)) {
    const r = readWithChecksum(jsonPath);
    valid = r.valid;
    reason = r.reason;
    if (r.valid && Array.isArray(r.data)) {
      const clean = r.data.map(stripInternal);
      ads = includeSellerData === false
        ? clean.map((a) => filterAdByFields(a, null, { excludeSellerData: true }))
        : clean;
    }
  } else {
    reason = 'annonces.json introuvable';
  }

  let meta = null;
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { meta = null; }
  }

  return { ads, valid, reason, meta };
}

/** Statistiques agrégées (mêmes calculs que l'app Electron). */
function statsFor(ads) {
  return AdStats.analyze(ads).stats;
}

/** Chemins des fichiers d'export d'une tâche. */
function exportPaths(resultsDir) {
  const json = path.join(resultsDir, 'annonces.json');
  const txt = path.join(resultsDir, 'annonces.txt');
  return {
    json: fs.existsSync(json) ? json : null,
    txt: fs.existsSync(txt) ? txt : null,
  };
}

module.exports = { readResults, statsFor, exportPaths, stripInternal };
