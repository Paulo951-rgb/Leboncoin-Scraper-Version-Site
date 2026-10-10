#!/usr/bin/env node
/* =========================================================================
 * leboncoin-pipeline.js (Batching In-Page + Exit Propre)
 *
 * Codes de sortie (contrat avec pipelineRunner.js) :
 *   0 → succès (au moins une annonce écrite)
 *   1 → erreur fatale (exception non gérée : HAR illisible, etc.)
 *   2 → échec explicite « aucune donnée exploitable » (HAR vide, 0 annonce)
 * =========================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { sleep, atomicWriteFileSync, cleanText } = require('../../utils/helpers');
const { summarizeAds, summarizeHarEntries, truncate, formatBytes, formatMs } = require('../../utils/diagnostics');
const { getRandomUserAgent } = require('./userAgents');
const { writeWithChecksum } = require('../../utils/integrity');
const { AdaptiveRateLimiter } = require('../../utils/rateLimiter');
const adFields = require('./adFields');
const { ErrorCodes, createError } = require('./errorCodes');
const { filterAdByFields, toReadableBlock } = require('../exporting/exportFields');
const { DEFAULT_PROFILE_FIELDS } = require('../exporting/dataProfiles');

const DEFAULTS = Object.freeze({
  // Valeurs par défaut pour les options du pipeline.
  minDelayMs: 500,
  maxDelayMs: 1000,
  headless: false,
  outDir: '.',
  concurrency: 10,
  recycleContextEvery: 200, // Recycler la mémoire tous les 200 produits extraits
  includeSellerData: true,
});

class CliError extends Error {}

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--concurrency':
        argv[++i]; // Ignorer silencieusement si transmis par un ancien script
        break;
      case '--fresh':
        opts.fresh = true;
        break;
      case '--headless':
        opts.headless = true;
        break;
      case '--no-desc':
        opts.noDesc = true;
        break;
      case '--limit':
        opts.limit = parseInt(argv[++i], 10);
        break;
      case '--out':
        opts.outDir = argv[++i];
        break;
       case '--speed':
        opts.speed = argv[++i];
        break;
      case '--user-agent':
        opts.userAgent = argv[++i];
        break;
      case '--profile-id':
        // 'default' | 'maximum' | 'custom'
        opts.profileId = argv[++i];
        break;
        case '--profile-fields':
          // Liste de clés séparées par des virgules. Liste concrète de champs à
          // exporter, déjà résolue par le main process selon le profil.
          {
            const raw = argv[++i];
            opts.profileFields = raw ? String(raw).split(',').map((s) => s.trim()).filter(Boolean) : null;
          }
          break;
        case '--no-seller-data':
          opts.includeSellerData = false;
          break;
      default:
        if (a.startsWith('--')) throw new CliError(`Option inconnue : ${a}`);
        positional.push(a);
    }
  }

  if (!positional[0]) throw new CliError('Le chemin du fichier .har est requis.');
  opts.harPath = positional[0];
  return opts;
}

function loadHar(harPath, logger) {
  if (!fs.existsSync(harPath)) {
    if (logger) logger.error(`[loadHar] Fichier HAR introuvable : ${harPath}`);
    throw new Error(`Fichier HAR introuvable : ${harPath}`);
  }
  const stat = fs.statSync(harPath);
  if (logger) logger.debug(`[loadHar] Lecture du fichier : ${harPath} (${formatBytes(stat.size)})`);

  let raw = fs.readFileSync(harPath, 'utf8');
  if (logger) logger.debug(`[loadHar] Fichier lu en mémoire : ${formatBytes(raw.length)} de texte`);

  let har;
  try {
    har = JSON.parse(raw);
  } catch (err) {
    if (logger) logger.error(`[loadHar] JSON invalide dans le fichier HAR : ${err.message}`);
    throw err;
  }
  // 🟢 OPTIMISATION MÉMOIRE : Libérer immédiatement le tampon texte de 220 Mo de la RAM
  raw = null;

  if (!har || !har.log) {
    if (logger) logger.error(`[loadHar] Structure HAR invalide : pas de propriété "log". Clés présentes : ${Object.keys(har || {}).join(', ') || '(aucune)'}`);
    return [];
  }
  const entries = har.log.entries || [];
  if (logger) logger.debug(`[loadHar] ${entries.length} entrée(s) HAR trouvées. ${summarizeHarEntries(entries)}`);
  return entries;
}

function getJsonResponses(entries, logger) {
  const jsonResponses = [];
  const IGNORED = /image|font\/|css|javascript|octet-stream|svg|video|audio/i;

  const stats = { total: entries.length, parsed: 0, noBody: 0, ignoredMime: 0, notJson: 0, nextDataFound: 0, parseError: 0, errorStatus: 0 };

  for (const entry of entries) {
    const res = entry.response;
    if (!res || !res.content) {
      stats.noBody++;
      continue;
    }
    if (typeof res.status === 'number' && res.status >= 400) {
      stats.errorStatus++;
      if (logger) logger.debug(`[getJsonResponses] Entrée en erreur HTTP ${res.status} ignorée : ${truncate(entry.request?.url, 80)}`);
      continue;
    }
    if (IGNORED.test(res.content.mimeType || '') && !res.content.mimeType.includes('json')) {
      stats.ignoredMime++;
      continue;
    }

    let text = res.content.text;
    if (!text) {
      stats.noBody++;
      continue;
    }

    if (res.content.encoding === 'base64') {
      try {
        text = Buffer.from(text, 'base64').toString('utf8');
      } catch {
        stats.parseError++;
        continue;
      }
    }

    const trimmed = text.trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
      // Tentative d'extraction __NEXT_DATA__ depuis du HTML
      const match = trimmed.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">\s*([\s\S]*?)\s*<\/script>/i);
      if (match && match[1]) {
        try {
          jsonResponses.push({ url: entry.request?.url || '', data: JSON.parse(match[1]) });
          stats.nextDataFound++;
          stats.parsed++;
        } catch {
          stats.parseError++;
          if (logger) logger.debug(`[getJsonResponses] __NEXT_DATA__ JSON invalide dans : ${truncate(entry.request?.url, 80)}`);
        }
      } else {
        stats.notJson++;
      }
      continue;
    }

    try {
      jsonResponses.push({ url: entry.request?.url || '', data: JSON.parse(trimmed) });
      stats.parsed++;
    } catch {
      stats.parseError++;
    }
  }

  if (logger) {
    logger.debug(`[getJsonResponses] Stats extraction : ${stats.parsed} JSON parsés | ${stats.nextDataFound} via __NEXT_DATA__ | ${stats.ignoredMime} ignorés (mime) | ${stats.notJson} non-JSON | ${stats.noBody} sans corps | ${stats.errorStatus} en erreur HTTP | ${stats.parseError} erreurs de parsing`);
    if (jsonResponses.length > 0) {
      logger.debug(`[getJsonResponses] URLs JSON captées : ${jsonResponses.slice(0, 5).map((r) => truncate(r.url, 60)).join(' | ')}${jsonResponses.length > 5 ? ` (+${jsonResponses.length - 5} autres)` : ''}`);
    }
  }
  return jsonResponses;
}

function looksLikeAd(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const hasId = 'list_id' in obj || ('id' in obj && typeof obj.id !== 'object');
  const hasTitle = 'subject' in obj || 'title' in obj;
  const hasPriceOrUrl = 'price' in obj || 'url' in obj;
  return hasId && hasTitle && hasPriceOrUrl;
}

function findAdsIterative(root, logger) {
  const found = [];
  const seen = new Set();
  const stack = [root];
  let visited = 0;

  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    visited++;
    if (visited > 500000) {
      if (logger) logger.warn(`[findAdsIterative] Limite de parcours atteinte (500000 nœuds) — arret pour éviter une boucle infinie.`);
      break;
    }

    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }

    if (looksLikeAd(node)) found.push(node);

    for (const key of Object.keys(node)) stack.push(node[key]);
  }

  if (logger) logger.debug(`[findAdsIterative] ${visited} nœud(s) parcouru(s), ${found.length} objet(s) ressemblant à une annonce détecté(s).`);
  return found;
}

// Allowlist des domaines autorisés pour les fetches in-page (descriptions).
// Les URLs proviennent du HAR Leboncoin : ce sont des annonces Leboncoin ou
// leurs CDN d'images. Toute URL hors allowlist est rejetée pour éviter le SSRF.
const ALLOWED_FETCH_HOSTS = [
  'leboncoin.fr', 'www.leboncoin.fr',
  'leboncoin.com', 'www.leboncoin.com',
  'leboncoindirect.com', 'www.leboncoindirect.com',
];

function isFetchUrlAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (ALLOWED_FETCH_HOSTS.includes(host)) return true;
    // Allow sous-domaines explicites de leboncoin (ex: img.leboncoin.fr)
    for (const allowed of ALLOWED_FETCH_HOSTS) {
      if (host === allowed || host.endsWith('.' + allowed)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Détecte proactivement un changement de structure Leboncoin en analysant
 * les clés présentes dans les objets bruts. Si Leboncoin renomme ou supprime
 * des champs clés (list_id, subject, price, body, location), le scraper
 * continuera à fonctionner mais perdra silencieusement des données.
 *
 * Cette fonction vérifie la présence des champs critiques sur un échantillon
 * d'objets bruts et émet un avertissement explicite si un champ clé manque
 * sur une proportion significative d'annonces.
 *
 * @param {Array} rawAds - objets bruts extraits du HAR (avant normalisation)
 * @param {object} logger - logger du pipeline
 * @returns {object} { warnings: string[], missingFields: string[] }
 */
function detectStructureChanges(rawAds, logger) {
  const result = { warnings: [], missingFields: [] };
  if (!Array.isArray(rawAds) || rawAds.length === 0) return result;

  // Champs critiques attendus dans chaque objet annonce Leboncoin brut.
  // Si un de ces champs disparaît, c'est un signal fort que Leboncoin a
  // changé sa structure JSON.
  const CRITICAL_FIELDS = [
    { key: 'list_id', alternatives: ['id', 'ad_id'], label: 'identifiant' },
    { key: 'subject', alternatives: ['title', 'name'], label: 'titre' },
    { key: 'price', alternatives: [], label: 'prix' },
    { key: 'body', alternatives: ['description', 'text'], label: 'description' },
    { key: 'location', alternatives: [], label: 'localisation' },
  ];

  const sample = rawAds.slice(0, Math.min(rawAds.length, 50));
  const sampleSize = sample.length;

  for (const field of CRITICAL_FIELDS) {
    const missingCount = sample.filter((ad) => {
      if (!ad || typeof ad !== 'object') return true;
      if (ad[field.key] != null) return false;
      for (const alt of field.alternatives) {
        if (ad[alt] != null) return false;
      }
      return true;
    }).length;

    const missingRatio = missingCount / sampleSize;
    // Seuil : si >70% des annonces manquent un champ critique, c'est un
    // changement de structure probable (pas juste une annonce incomplète).
    if (missingRatio > 0.7) {
      const msg = `Champ "${field.key}" (${field.label}) absent sur ${missingCount}/${sampleSize} annonces (${Math.round(missingRatio * 100)}%) — Leboncoin a peut-être modifié sa structure JSON.`;
      const err = createError('STRUCTURE_FIELD_MISSING', msg, { field: field.key, label: field.label, missingCount, sampleSize });
      result.warnings.push(msg);
      result.missingFields.push(field.key);
      result.errors = result.errors || [];
      result.errors.push(err);
      if (logger) logger.warn(`[detectStructureChanges] [${err.code}] ${msg}`);
    }
  }

  if (result.warnings.length > 0 && logger) {
    const structureErr = createError('STRUCTURE_CHANGED', `${result.warnings.length} champ(s) critique(s) potentiellement modifié(s) par Leboncoin. Le scraper continue mais certaines données peuvent être incomplètes. Vérifiez les extracteurs dans adFields.js si le problème persiste.`, { missingFields: result.missingFields });
    result.errors = result.errors || [];
    result.errors.push(structureErr);
    logger.warn(`[detectStructureChanges] [${structureErr.code}] ${structureErr.message}`);
  }

  return result;
}

// Note : les wrappers extractDeliveryInfo et extractSellerRating ont été
// supprimés car la structure plate expose directement livraison, mainPropre,
// vendeurNom, vendeurNote, etc. via normalizeAd().

/**
 * Normalise une annonce brute Leboncoin en structure PLATE et SIMPLE.
 *
 * Structure v3 (SCRAPING PUR, indépendant de l'IA) :
 *   id, title, url, prix,
 *   city, zipcode,
 *   vendeurNom, vendeurType, vendeurId, vendeurNote, vendeurUrlProfil, vendeurAncienneteJours,
 *   livraison, mainPropre,
 *   likes,
 *   datePublication, dateModification, dateScraping,
 *   etat,
 *   photosCount, photosUrls,
 *   description
 *
 * L'IA peut ensuite enrichir cette structure avec ses propres champs
 * (adAnalysis, marketAnalysis) SANS JAMAIS scraper Leboncoin elle-même.
 */
function normalizeAd(raw) {
  const id = adFields.firstDefined(raw.list_id, raw.id, raw.ad_id);
  const title = adFields.firstDefined(raw.subject, raw.title, raw.name);

  // Collecte les erreurs d'extraction pour diagnostic par-annonce.
  const extractionErrors = [];
  const onError = (err) => {
    extractionErrors.push({
      code: err.code,
      message: err.message,
      timestamp: new Date().toISOString(),
    });
  };

  const description = adFields.extractDescription(raw, { onError });
  const url = adFields.firstDefined(raw.url, id ? `https://www.leboncoin.fr/ad/${id}.htm` : null);

  const city = adFields.firstDefined(raw.location?.city, raw.location?.city_label, raw.city);
  const zipcode = adFields.firstDefined(raw.location?.zipcode, raw.location?.zip_code);

  const seller = adFields.extractSeller(raw, { onError });
  const transaction = adFields.extractTransaction(raw);
  const dates = adFields.extractDates(raw, { onError });
  const prix = adFields.extractPrice(raw, { onError });
  const likes = adFields.extractLikes(raw);
  const photos = adFields.extractPhotos(raw, { onError });
  const etat = adFields.extractCondition(raw);

  const scrapedAt = new Date().toISOString();

  // Détecte les annonces vides (ni id ni titre) — code AD_EMPTY.
  if (!id && !title) {
    extractionErrors.push(createError('AD_EMPTY', 'Annonce vide : ni id ni titre trouvé'));
  }

  return {
    id: id != null ? String(id) : null,
    title: title || null,
    url: url || null,
    prix,
    city: city || null,
    zipcode: zipcode || null,

    vendeurNom: seller.nom,
    vendeurType: seller.type,
    vendeurId: seller.id,
    vendeurNote: seller.note,
    nombreAvis: seller.nombreAvis,
    vendeurUrlProfil: seller.urlProfil,
    vendeurAncienneteJours: seller.ancienneteJours,

    livraison: transaction.livraison,
    mainPropre: transaction.mainPropre,
    deliveryType: adFields.computeDeliveryType(transaction.livraison, transaction.mainPropre),

    likes,

    datePublication: dates.publication,
    dateModification: dates.modification,
    dateScraping: scrapedAt,

    etat,

    photosCount: photos.count,
    photosUrls: photos.urls,

    description,

    // Erreurs d'extraction collectées pour diagnostic (par-annonce).
    extractionErrors,

    // Objet brut Leboncoin : conservé en mémoire car mergeDuplicates s'en sert
    // pour garder la version la plus riche, et la résolution de description
    // l'utilise. N'est JAMAIS exporté (stripInternalFields le retire).
    raw,
  };
}

// Fusionne deux annonces en préservant les valeurs non-nulles : on ne remplace
// JAMAIS un champ déjà renseigné (non-null) par une valeur null provenant de
// l'autre version. Évite de perdre un champ (ex. note vendeur, deliveryType)
// extrait sur une page quand l'autre occurrence de l'annonce ne le contient pas.
function mergeKeepingNonNull(existing, incoming) {
  const merged = { ...existing, ...incoming };
  for (const key of Object.keys(merged)) {
    if (existing[key] != null && incoming[key] == null) {
      merged[key] = existing[key];
    }
  }
  // raw : garde l'objet brut le plus riche (celui avec le plus de clés).
  // Si égalité, on garde existing.raw (première occurrence).
  const existingKeys = existing.raw && typeof existing.raw === 'object' ? Object.keys(existing.raw).length : 0;
  const incomingKeys = incoming.raw && typeof incoming.raw === 'object' ? Object.keys(incoming.raw).length : 0;
  merged.raw = incomingKeys > existingKeys ? incoming.raw : existing.raw;
  return merged;
}

function mergeDuplicates(ads, logger) {
  const byId = new Map();
  let noIdCount = 0;
  let dupCount = 0;
  for (const ad of ads) {
    if (!ad.id) {
      noIdCount++;
      continue;
    }
    if (byId.has(ad.id)) {
      const existing = byId.get(ad.id);
      const merged = mergeKeepingNonNull(existing, ad);
      byId.set(ad.id, merged);
      dupCount++;
    } else {
      byId.set(ad.id, ad);
    }
  }
  if (logger) logger.debug(`[mergeDuplicates] ${ads.length} annonce(s) en entrée | ${noIdCount} sans ID (ignorées) | ${dupCount} doublon(s) fusionné(s) | ${byId.size} unique(s) en sortie.`);
  return [...byId.values()];
}

// -------------------------------------------------------------------------
// ENRICHISSEMENT DES DESCRIPTIONS BATCHING IN-PAGE
// -------------------------------------------------------------------------

class DescriptionEnricher {
  constructor(opts, logger) {
    this.opts = opts;
    this.logger = logger;
    this.consecutiveBlocks = 0;
    this.shouldStopAll = false;
    // 🛑 FIX : UA FIXE pour toute la durée de l'enrichissement. Avant,
    // getRandomUserAgent() était appelé dans createStealthContext → UA différent
    // à chaque recyclage de contexte (tous les 200 produits). Le UA choisi ici
    // peut être fourni par HarCapturer (opts.userAgent) pour garantir la cohérence
    // d'empreinte avec la phase de capture (mêmes cookies + même UA → 403 évité).
    this._userAgent = opts.userAgent || getRandomUserAgent();
    // Annulation coopérative : le PipelineRunner envoie SIGINT au sous-processus.
    // Sans ce drapeau, Node quittait immédiatement (pas de handler SIGINT) →
    // les checkpoints d'enrichissement n'étaient pas rejoués. On intercepte le
    // signal pour terminer proprement la boucle et écrire les résultats partiels.
    this.cancelled = false;
    this._onSigint = () => {
      this.cancelled = true;
      this.shouldStopAll = true;
      this.logger.warn('⏹️ SIGINT reçu — arrêt de l\'enrichissement, sauvegarde des données partielles.');
    };
    process.once('SIGINT', this._onSigint);
    // Rate limiting adaptatif : ajuste dynamiquement les délais selon les
    // signaux du serveur (latence, 429/403, erreurs réseau).
    this.rateLimiter = new AdaptiveRateLimiter({
      baseDelayMs: opts.minDelayMs || 800,
      maxDelayMs: opts.maxDelayMs || 8000,
      slowThresholdMs: 3000,
      logger,
    });
  }

  async fetchBatchInPage(page, batchItems) {
    // Filtre préventif : ne passe au navigateur que les URLs autorisées.
    // Si une URL est rejetée, elle est marquée comme erreur immédiatement.
    const safeItems = [];
    for (const item of batchItems) {
      if (isFetchUrlAllowed(item.url)) {
        safeItems.push(item);
      } else {
        this.logger.warn(`[DescriptionEnricher] URL bloquée (SSRF) : ${truncate(item.url, 80)}`);
      }
    }

    const sequential = this.opts.sequential === true;
    const fetchTimeoutMs = this.opts.fetchTimeoutMs || 15000;
    return await page.evaluate(async ({ items, seq, timeoutMs }) => {
      const results = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(url, { ...options, signal: controller.signal });
          return res;
        } catch (err) {
          if (err && err.name === 'AbortError') throw new Error(`fetch timeout (${timeoutMs}ms)`);
          throw err;
        } finally {
          clearTimeout(timer);
        }
      }

      if (seq) {
        for (const item of items) {
          try {
            // Double vérification côté navigateur (défense en profondeur).
            const u = new URL(item.url);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') {
              results[item.id] = { error: 'BLOCKED_URL' };
              continue;
            }
            const res = await fetchWithTimeout(item.url, {
              headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
            }, timeoutMs);
            if (!res.ok) {
              if (res.status === 429) results[item.id] = { error: 'BLOCKED_429', retryAfter: res.headers.get('retry-after') || null };
              else if (res.status === 403) results[item.id] = { error: 'BLOCKED_403' };
              else results[item.id] = { error: 'HTTP_' + res.status };
            } else {
              const html = await res.text();
              results[item.id] = { html };
            }
          } catch (e) {
            results[item.id] = { error: e.message };
          }
          if (items.indexOf(item) < items.length - 1) {
            await sleep(800 + Math.random() * 1000);
          }
        }
      } else {
        const promises = items.map(async (item) => {
          try {
            const u = new URL(item.url);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') {
              results[item.id] = { error: 'BLOCKED_URL' };
              return;
            }
            const res = await fetchWithTimeout(item.url, {
              headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
            }, timeoutMs);
            if (!res.ok) {
              if (res.status === 429) results[item.id] = { error: 'BLOCKED_429', retryAfter: res.headers.get('retry-after') || null };
              else if (res.status === 403) results[item.id] = { error: 'BLOCKED_403' };
              else results[item.id] = { error: 'HTTP_' + res.status };
            } else {
              const html = await res.text();
              results[item.id] = { html };
            }
          } catch (e) {
            results[item.id] = { error: e.message };
          }
        });
        await Promise.all(promises);
      }
      return results;
    }, { items: safeItems, seq: sequential, timeoutMs: fetchTimeoutMs });
  }

  parseHtmlDescription(html, adId) {
    if (!html) return { description: null, livraison: null, mainPropre: null, note: null, etat: null };
    const match = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">\s*([\s\S]*?)\s*<\/script>/i);
    if (match && match[1]) {
      try {
        const nextData = JSON.parse(match[1]);
        const found = findAdsIterative(nextData);
        const exact = found.find((c) => String(c.list_id || c.id) === String(adId));
        const target = exact || found[0];
        const body = target?.body || target?.description;
        const descriptionText = (typeof body === 'string') ? body : (body && typeof body.text === 'string' ? body.text : null);

        const transaction = target ? adFields.extractTransaction(target) : null;
        const seller = target ? adFields.extractSeller(target) : null;
        const etat = target ? adFields.extractCondition(target) : null;

        return {
          description: descriptionText ? cleanText(descriptionText) : null,
          livraison: transaction ? transaction.livraison : null,
          mainPropre: transaction ? transaction.mainPropre : null,
          note: seller ? seller.note : null,
          etat,
        };
      } catch { /* Ignorer */ }
    }
    return { description: null, livraison: null, mainPropre: null, note: null, etat: null };
  }

  async enrichAll(ads, writeOutputs) {
    const targets = ads.filter((a) => a.url && !a.description);
    const noUrlCount = ads.filter((a) => !a.url).length;
    const alreadyHasDesc = ads.filter((a) => a.description).length;
    if (targets.length === 0) {
      this.logger.info('Toutes les annonces ont déjà une description !');
      this.logger.debug(`[DescriptionEnricher] Rien à faire : ${alreadyHasDesc} avec description, ${noUrlCount} sans URL.`);
      return;
    }

    this.logger.info(`\nExtraction des descriptions pour ${targets.length} annonce(s) (mode rapide parallèle)...`);
    this.logger.debug(`[DescriptionEnricher] Cibles : ${targets.length} | déjà avec description : ${alreadyHasDesc} | sans URL : ${noUrlCount} | concurrency : ${this.opts.concurrency || 10} | headless : ${this.opts.headless}`);

    const { chromium } = require('playwright');
    this.logger.debug(`[DescriptionEnricher] Lancement Chromium (headless=${this.opts.headless})...`);
    const t0Launch = Date.now();
    const browser = await chromium.launch({ headless: this.opts.headless });
    this.logger.debug(`[DescriptionEnricher] Chromium lancé en ${formatMs(Date.now() - t0Launch)}.`);

    const parentDir = path.dirname(this.opts.outDir);
    const statePath = path.join(parentDir, 'session-state.json');
    // outDir = JOBS_DIR/job-<timestamp>/results → parentDir = jobDir
    // La session globale est dans BASE_OUT_DIR/global-session.json, soit 2 niveaux
    // au-dessus de outDir (parentDir = jobDir, path.dirname(parentDir) = JOBS_DIR,
    // path.dirname(path.dirname(parentDir)) = BASE_OUT_DIR).
    const globalStatePath = path.join(path.dirname(path.dirname(parentDir)), 'global-session.json');

    const createStealthContext = async () => {
      const contextOptions = {
        userAgent: this._userAgent,
        locale: 'fr-FR',
        viewport: { width: 1366, height: 850 },
      };

      const sessionToUse = fs.existsSync(globalStatePath) ? globalStatePath : (fs.existsSync(statePath) ? statePath : null);
      if (sessionToUse) {
        contextOptions.storageState = sessionToUse;
        this.logger.debug(`[DescriptionEnricher] Session utilisée : ${sessionToUse}`);
      } else {
        this.logger.debug(`[DescriptionEnricher] Aucune session trouvée (ni ${path.basename(globalStatePath)}, ni ${path.basename(statePath)}) — contexte vierge.`);
      }

      const ctx = await browser.newContext(contextOptions);
      const p = await ctx.newPage();
      
      await p.route('**/*', (route) => {
        if (['image', 'media', 'font', 'stylesheet'].includes(route.request().resourceType())) {
          return route.abort();
        }
        return route.continue();
      });

      const t0Goto = Date.now();
      await p.goto('https://www.leboncoin.fr', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => {
        this.logger.warn(`[DescriptionEnricher] Navigation initiale vers leboncoin.fr échouée : ${e.message} — le contexte reste toutefois utilisable pour les fetch in-page.`);
      });
      this.logger.debug(`[DescriptionEnricher] Page d'accueil chargée en ${formatMs(Date.now() - t0Goto)}.`);
      await sleep(1500);
      return { ctx, p };
    };

    let setup;
    let context;
    let page;
    try {
      setup = await createStealthContext();
      context = setup.ctx;
      page = setup.p;

    let done = 0;
    let successCount = 0;
    let notFoundCount = 0;
    let httpErrorCount = 0;
    let blockedCount = 0;
    // Motif d'arrêt explicite : permet de distinguer un 403 (refus) d'un 429
    // (limitation) pour un code de sortie honnête.
    let stopReason = null; // 'HTTP_403' | 'HTTP_429' | null
    let retryAfterMs = null;
    let pendingRetryAfterMs = null; // appliqué une seule fois (pause inter-batch)
    const concurrency = this.opts.concurrency || 10;
    let batchIndex = 0;

    for (let i = 0; i < targets.length; i += concurrency) {
      if (this.shouldStopAll || this.cancelled) {
        this.logger.debug(`[DescriptionEnricher] Arrêt demandé (shouldStopAll=${this.shouldStopAll}, cancelled=${this.cancelled}) — sortie de la boucle à ${done}/${targets.length}.`);
        break;
      }

      const batch = targets.slice(i, i + concurrency);
      const batchItems = batch.map((a) => ({ id: a.id, url: a.url }));
      batchIndex++;
      this.logger.debug(`[DescriptionEnricher] Batch ${batchIndex} : ${batch.length} annonce(s) — IDs [${batchItems.map((b) => b.id).join(', ')}]`);

      const t0Batch = Date.now();
      const results = await this.fetchBatchInPage(page, batchItems);
      this.logger.debug(`[DescriptionEnricher] Batch ${batchIndex} terminé en ${formatMs(Date.now() - t0Batch)} — ${Object.keys(results).length}/${batch.length} réponses.`);

      for (const ad of batch) {
        done++;
        const res = results[ad.id];

        if (res && res.html) {
          const parsed = this.parseHtmlDescription(res.html, ad.id);
          // Enrichissement des champs extraits de la page de détail.
          let enriched = false;
          if (parsed.livraison != null && ad.livraison == null) { ad.livraison = parsed.livraison; enriched = true; }
          if (parsed.mainPropre != null && ad.mainPropre == null) { ad.mainPropre = parsed.mainPropre; enriched = true; }
          // Recalcule deliveryType si livraison ou mainPropre ont été enrichis.
          if (enriched) { ad.deliveryType = adFields.computeDeliveryType(ad.livraison, ad.mainPropre); }
          if (parsed.note != null && ad.vendeurNote == null) { ad.vendeurNote = parsed.note; enriched = true; }
          if (parsed.etat && !ad.etat) { ad.etat = parsed.etat; enriched = true; }

          if (parsed.description) {
            const text = String(parsed.description);
            ad.description = text;
            successCount++;
            this.consecutiveBlocks = 0;
            this.logger.info(`✅ [${done}/${targets.length}] ${(ad.title || '').slice(0, 50)}`);
          } else if (enriched) {
            successCount++;
            this.consecutiveBlocks = 0;
            this.logger.info(`✅ [${done}/${targets.length}] ${(ad.title || '').slice(0, 50)} (attributs enrichis, description absente)`);
          } else {
            notFoundCount++;
            this.logger.warn(`⚠️ [${done}/${targets.length}] Description non trouvée sur ${ad.id}`);
            this.logger.debug(`[DescriptionEnricher] HTML reçu (${formatBytes(res.html.length)}) mais pas de __NEXT_DATA__ ou pas de body pour l'ID ${ad.id}.`);
          }
        } else if (res && (res.error === 'BLOCKED_403' || res.error === 'BLOCKED_429')) {
          blockedCount++;
          this.consecutiveBlocks++;
          const isRateLimited = res.error === 'BLOCKED_429';
          const blockCode = isRateLimited ? ErrorCodes.HTTP_RATE_LIMITED : ErrorCodes.HTTP_ACCESS_REFUSED;
          if (isRateLimited) {
            stopReason = 'HTTP_429';
            const ra = typeof res.retryAfter === 'string' ? res.retryAfter : null;
            const parsedRa = ra && /^\d+$/.test(ra.trim()) ? parseInt(ra.trim(), 10) * 1000 : null;
            if (parsedRa != null) { retryAfterMs = parsedRa; pendingRetryAfterMs = parsedRa; }
            this.logger.warn(`🛑 [${done}/${targets.length}] [${blockCode}] Requête limitée (HTTP 429) sur ${ad.id}${ra ? ` — Retry-After ${ra}` : ''}`);
          } else {
            if (stopReason !== 'HTTP_429') stopReason = 'HTTP_403';
            this.logger.warn(`🛑 [${done}/${targets.length}] [${blockCode}] Accès refusé (HTTP 403) sur ${ad.id} — ${truncate(ad.url, 60)}`);
          }
          if (this.consecutiveBlocks >= 3) {
            this.shouldStopAll = true;
            this.logger.warn('\n🛑 Blocage détecté. Arrêt préventif.');
            this.logger.debug(`[DescriptionEnricher] Raison arrêt : ${this.consecutiveBlocks} blocages consécutifs (seuil=3). ${blockedCount} blocages au total sur ce batch.`);
            break;
          }
        } else if (res && res.error && res.error.startsWith('HTTP_')) {
          httpErrorCount++;
          const httpStatus = parseInt(res.error.replace('HTTP_', ''), 10);
          const httpCode = httpStatus === 404 ? ErrorCodes.HTTP_404 : httpStatus >= 500 ? ErrorCodes.HTTP_500 : ErrorCodes.HTTP_UNKNOWN;
          const httpErr = createError(httpCode, `HTTP ${httpStatus} sur ${ad.id}`, { adId: ad.id, httpStatus });
          this.logger.warn(`⚠️ [${done}/${targets.length}] [${httpErr.code}] HTTP ${httpStatus} sur ${ad.id}`);
        } else if (res && res.error) {
          httpErrorCount++;
          const fetchErr = createError(ErrorCodes.NET_CONNECTION_FAILED, `Erreur fetch sur ${ad.id} : ${res.error}`, { adId: ad.id, error: res.error });
          this.logger.warn(`⚠️ [${done}/${targets.length}] [${fetchErr.code}] Erreur fetch sur ${ad.id} : ${res.error}`);
        } else {
          httpErrorCount++;
          this.logger.warn(`⚠️ [${done}/${targets.length}] Aucune réponse reçue pour ${ad.id}`);
        }
      }

      if (done % 10 === 0 || done === targets.length) writeOutputs(ads);
      // Rate limiting adaptatif : on ajuste le délai selon le résultat du batch
      // (backoff exponentiel si blocage, accélération si succès rapides) SANS
      // attendre ici — l'attente est faite juste après, explicitement, afin de
      // pouvoir respecter l'en-tête Retry-After fourni par le serveur.
      const batchDuration = Date.now() - t0Batch;
      const batchHadBlock = batch.some((ad) => results[ad.id]?.error === 'BLOCKED_403' || results[ad.id]?.error === 'BLOCKED_429');
      const batchHadError = batch.some((ad) => {
        const e = results[ad.id]?.error;
        return e && e !== 'BLOCKED_403' && e !== 'BLOCKED_429' && !e.startsWith('HTTP_');
      });
      if (batchHadBlock) {
        await this.rateLimiter.waitAfter({ durationMs: batchDuration, blocked: true, status: 403, noWait: true });
      } else if (batchHadError) {
        await this.rateLimiter.waitAfter({ durationMs: batchDuration, error: true, noWait: true });
      } else {
        await this.rateLimiter.waitAfter({ durationMs: batchDuration, noWait: true });
      }

      // Respect de Retry-After : si le serveur a fourni un délai, on attend AU
      // MOINS ce délai avant de lancer le batch suivant (aucune reprise avant
      // l'heure indiquée, aucune accélération au-delà).
      const adaptiveDelay = this.rateLimiter.currentDelayMs();
      const waitMs = Math.max(adaptiveDelay, pendingRetryAfterMs || 0);
      if (waitMs > 0 && i + concurrency < targets.length) {
        this.logger.debug(`[DescriptionEnricher] Pause inter-batch ${Math.round(waitMs)}ms${pendingRetryAfterMs ? ` (Retry-After ${Math.round(pendingRetryAfterMs)}ms respecté)` : ''} — prochain délai adaptatif ${adaptiveDelay}ms.`);
        await sleep(waitMs);
      }
      // Le délai Retry-After du serveur ne s'applique qu'une fois (le suivant
      // repart sur le backoff adaptatif courant).
      pendingRetryAfterMs = null;

      if (done > 0 && done % this.opts.recycleContextEvery === 0 && i + concurrency < targets.length) {
        this.logger.info(`🔄 Purge mémoire RAM (${done} items)...`);
        // Sauvegarde préventive AVANT le recyclage : si createStealthContext()
        // échoue pendant le recyclage (contexte Playwright instable après un
        // long run), on ne perd pas les descriptions déjà récupérées depuis le
        // dernier writeOutputs.
        writeOutputs(ads);
        await page.close().catch(() => {});
        await context.close().catch(() => {});
        await sleep(1000);
        try {
          setup = await createStealthContext();
          context = setup.ctx;
          page = setup.p;
        } catch (recycleErr) {
          // Recyclage impossible : on ne peut pas continuer à enrichir (le
          // navigateur est dans un état instable). On sauvegarde ce qu'on a et
          // on sort proprement plutôt que de crasher et perdre le job entier.
          this.logger.warn(`🛑 Recyclage contexte échoué : ${recycleErr.message} — arrêt de l'enrichissement, données sauvegardées.`);
          this.logger.debug(`[DescriptionEnricher] Détail échec recyclage : ${describeError(recycleErr)}`);
          context = null;
          page = null;
          break;
        }
      }
    }

    writeOutputs(ads);
    this.logger.info(`Session terminée : ${successCount}/${targets.length} récupérées.`);
    this.logger.debug(`[DescriptionEnricher] Bilan final : ${successCount} réussies | ${notFoundCount} sans description trouvée | ${blockedCount} bloquées (403/429) | ${httpErrorCount} autres erreurs HTTP/fetch | arrêt préventif : ${this.shouldStopAll ? 'OUI' : 'non'}.`);
    // Résumé structuré (compteurs explicites : enrichies vs en attente).
    const pendingCount = Math.max(0, targets.length - successCount - notFoundCount - blockedCount - httpErrorCount);
    this.logger.info(`[METRICS] Descriptions : ${successCount} enrichies | ${notFoundCount} absentes | ${blockedCount} bloquées | ${httpErrorCount} erreurs HTTP | ${pendingCount} non traitées (${targets.length} cibles).`);
    return {
      successCount,
      notFoundCount,
      blockedCount,
      httpErrorCount,
      pendingCount,
      targetsCount: targets.length,
      stopReason,
      retryAfterMs,
      partial: this.shouldStopAll || stopReason != null || this.cancelled,
    };
    } finally {
      process.removeListener('SIGINT', this._onSigint);
      // Garanti la fermeture du navigateur/contexte/page même en cas d'erreur
      // (ex. createStealthContext ou fetchBatchInPage lance) — sinon Chromium
      // restait orphan (processus zombie) et la RAM/sockets fuyaient.
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }
}

// -------------------------------------------------------------------------
// EXPORTATION DES FICHIERS
// -------------------------------------------------------------------------

function _fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// toReadableBlock : importé depuis services/exporting/exportFields (supporte
// le mode Défaut / Personnalisé). L'ancienne implémentation locale a été
// supprimée pour éviter le shadowing.

function writeOutputsFactory(outDir, opts) {
  const jsonPath = path.join(outDir, 'annonces.json');
  const txtPath = path.join(outDir, 'annonces.txt');

  // Détermine la liste effective de champs à exporter selon le profil.
  // - profileId='default'  → DEFAULT_PROFILE_FIELDS (champs essentiels).
  // - profileId='maximum'  → toutes les clés (ALL_FIELD_KEYS).
  // - profileId='custom'   → uniquement opts.profileFields (validés).
  // - opts.profileFields=null/[] en custom → fallback sur les essentiels.
  function _resolveFields() {
    if (opts.profileId === 'custom') {
      if (Array.isArray(opts.profileFields) && opts.profileFields.length > 0) {
        return opts.profileFields;
      }
      // Mode custom mais aucun champ fourni → on garde au moins les essentiels
      // (id + title + prix + url + description) plutôt qu'un fichier vide.
      return ['id', 'title', 'url', 'prix', 'description'];
    }
    if (opts.profileId === 'maximum') {
      return null; // null = toutes les clés (profil Maximum)
    }
    // Profil Défaut : on restreint aux champs essentiels.
    return DEFAULT_PROFILE_FIELDS;
  }

  const exportOptions = opts.includeSellerData === false ? { excludeSellerData: true } : {};

  // Champs internes au pipeline : nécessaires en mémoire (mergeDuplicates se sert
  // de `raw` pour garder la version la plus riche), mais ils ne doivent JAMAIS
  // être écrits dans annonces.json/txt. `raw` est l'objet brut Leboncoin complet
  // (jusqu'à plusieurs Ko par annonce, avec des données non prévues au modèle) et
  // `extractionErrors` est un détail de diagnostic interne. En profil Maximum,
  // filterAdByFields renvoie l'objet tel quel (fields=null) → ces champs
  // fuiteraient sans ce nettoyage. `livraison`/`mainPropre` sont les deux
  // booléens internes unifiés en `deliveryType` : la convention du modèle impose
  // qu'ils n'apparaissent plus dans les exports. Aucun consommateur (renderer,
  // historique, stats) ne les lit.
  const INTERNAL_AD_FIELDS = ['raw', 'extractionErrors', 'livraison', 'mainPropre'];

  function stripInternalFields(ad) {
    if (!ad || typeof ad !== 'object') return ad;
    let copy = ad;
    for (const k of INTERNAL_AD_FIELDS) {
      if (k in copy) {
        if (copy === ad) copy = { ...ad };
        delete copy[k];
      }
    }
    return copy;
  }

  return function writeOutputs(ads) {
    for (const ad of ads) {
      if (ad && typeof ad === 'object') {
        if (!ad.dateScraping) ad.dateScraping = new Date().toISOString();
      }
    }
    const fields = _resolveFields();
    // Nettoie les champs internes AVANT tout filtrage/écriture. En profil Maximum
    // (fields=null) les annonces sont écrites telles quelles, donc ce nettoyage
    // est le seul rempart contre la fuite de `raw`/`extractionErrors`.
    const cleanAds = ads.map(stripInternalFields);
    // JSON : on filtre chaque annonce pour respecter strictement le profil
    // (seuls les champs sélectionnés sont conservés en clair). fields=null
    // signifie « toutes les clés » (profil Maximum) → objet tel quel.
    const jsonAds = fields ? cleanAds.map((a) => filterAdByFields(a, fields, exportOptions)) : cleanAds;
    writeWithChecksum(jsonPath, jsonAds, null, 2);
    atomicWriteFileSync(txtPath, cleanAds.map((a, i) => toReadableBlock(a, i, fields, exportOptions)).join('\n'));
    // Méta-données d'export (profil + liste de champs).
    const meta = {
      version: 2,
      profileId: opts.profileId || 'default',
      fields: fields || null,
      includeSellerData: opts.includeSellerData !== false,
      generatedAt: new Date().toISOString(),
    };
    writeWithChecksum(path.join(outDir, 'export-meta.json'), meta, null, 2);
  };
}

module.exports = { detectStructureChanges, normalizeAd, looksLikeAd };

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Erreur CLI : ${err.message}`);
    // Exit code 1 (erreur) : le PipelineRunner doit savoir que le pipeline a
    // échoué, sinon il voit code 0 et croit que tout s'est bien passé.
    throw err;
  }

  // Preset de vitesse : ajuste concurrence et délais selon le choix utilisateur.
  // La concurrence est le nombre de workers persistants qui traitent les annonces
  // en parallèle (queue dynamique : dès qu'un worker termine, il prend la suivante).
  const SPEED_PRESETS = {
    moyen:          { concurrency: 8,  minDelayMs: 1500, maxDelayMs: 4000, mode: 'parallèle' },
    rapide:         { concurrency: 10, minDelayMs: 1000, maxDelayMs: 3000, mode: 'parallèle' },
    'ultra-rapide': { concurrency: 12, minDelayMs: 700,  maxDelayMs: 2500, mode: 'parallèle' },
  };
  const preset = SPEED_PRESETS[opts.speed] || SPEED_PRESETS.moyen;
  opts.concurrency = preset.concurrency;
  opts.minDelayMs = preset.minDelayMs;
  opts.maxDelayMs = preset.maxDelayMs;
  opts.sequential = false;

  const ts = () => new Date().toLocaleTimeString();
  const logger = {
    debug: (msg) => console.log(`[${ts()}] [DEBUG] ${msg}`),
    info: (msg) => console.log(`[${ts()}] [INFO] ${msg}`),
    warn: (msg) => console.log(`\x1b[33m[${ts()}] [WARN] ${msg}\x1b[0m`),
    error: (msg) => console.log(`\x1b[31m[${ts()}] [ERROR] ${msg}\x1b[0m`),
  };

  logger.info(`=== Pipeline Leboncoin (Vitesse: ${opts.speed || 'moyen'} — ${preset.mode}, concurrency=${preset.concurrency}) ===`);
  logger.debug(`[main] Options : harPath=${opts.harPath} | outDir=${opts.outDir} | headless=${opts.headless}  noDesc=${opts.noDesc} | limit=${opts.limit ?? '(aucun)'} | fresh=${opts.fresh} | speed=${opts.speed || 'moyen'} | concurrency=${opts.concurrency} | minDelay=${opts.minDelayMs} | maxDelay=${opts.maxDelayMs} | profileId=${opts.profileId || 'default'} | profileFields=${opts.profileFields ? `[${opts.profileFields.join(', ')}]` : '(selon profil)'} | includeSellerData=${opts.includeSellerData}`);

  const writeOutputs = writeOutputsFactory(opts.outDir, opts);
  const jsonPath = path.join(opts.outDir, 'annonces.json');

  let ads;
  if (fs.existsSync(jsonPath) && !opts.fresh) {
    logger.info('annonces.json existant trouvé -> Reprise automatique.');
    logger.debug(`[main] Reprise depuis : ${jsonPath}`);
    try {
      ads = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (err) {
      logger.error(`[main] annonces.json corrompu (${err.message}) -> re-scraping complet.`);
      ads = null;
    }
    if (ads) logger.debug(`[main] ${summarizeAds(ads)}`);
  } else {
    logger.debug(`[main] Étape 1/3 : Chargement du HAR depuis ${opts.harPath}`);
    const entries = loadHar(opts.harPath, logger);

    logger.debug(`[main] Étape 2/3 : Extraction des réponses JSON depuis ${entries.length} entrée(s) HAR`);
    const jsonResponses = getJsonResponses(entries, logger);

    if (jsonResponses.length === 0) {
      const parseErr = createError('PARSE_NO_ADS', 'Aucune réponse JSON exploitable trouvée dans le HAR');
      logger.error(`[${parseErr.code}] Aucune réponse JSON exploitable trouvée dans le HAR.`);
      logger.warn(`[main] Causes possibles : (1) Leboncoin a bloqué la recherche (captcha/403) durant la capture HAR ; (2) structure du HAR différente de celle attendue ; (3) le fichier HAR est vide ou corrompu.`);
      logger.debug(`[main] Diagnostic : ${summarizeHarEntries(entries)}`);
      // Exit code 2 : échec explicite « aucune donnée exploitable ». Distinct de
      // 0 (succès) et 1 (erreur fatale) pour que PipelineRunner ne présente PAS
      // un run vide comme un succès complet.
      process.exitCode = 2;
      return;
    }

    logger.debug(`[main] Étape 3/3 : Recherche d'annonces dans ${jsonResponses.length} réponse(s) JSON`);
    const rawAds = [];
    let responseWithAds = 0;
    for (const r of jsonResponses) {
      const found = findAdsIterative(r.data, logger);
      if (found.length > 0) responseWithAds++;
      for (const f of found) rawAds.push(f);
    }
    logger.debug(`[main] ${rawAds.length} objet(s) annonce brut(s) trouvé(s) dans ${responseWithAds}/${jsonResponses.length} réponse(s) JSON.`);

    if (rawAds.length === 0) {
      const noAdsErr = createError('PARSE_NO_ADS', 'Aucun objet annonce trouvé dans les réponses JSON (les données HAR ne contiennent pas le format attendu)');
      logger.warn(`[${noAdsErr.code}] Aucun objet annonce trouvé dans les réponses JSON (les données HAR ne contiennent pas le format attendu).`);
      logger.debug(`[main] Cela peut arriver si Leboncoin a changé sa structure JSON ou si la capture HAR a intercepté une page d'erreur au lieu des résultats de recherche.`);
    } else {
      detectStructureChanges(rawAds, logger);
    }

    const beforeFilter = rawAds.length;
    const normalized = rawAds.map(normalizeAd).filter((a) => a.id || a.title);
    const filteredOut = beforeFilter - normalized.length;
    if (filteredOut > 0) {
      const emptyErr = createError('AD_EMPTY', `${filteredOut} objet(s) sans ID ni titre supprimé(s) après normalisation (${beforeFilter} → ${normalized.length})`);
      logger.debug(`[main] [${emptyErr.code}] ${emptyErr.message}`);
    }

    ads = mergeDuplicates(normalized, logger);

    if (ads.length === 0) {
      const emptyErr = createError('PARSE_NO_ADS', '0 annonce extraite de ce HAR');
      logger.error(`[${emptyErr.code}] 0 annonce extraite de ce HAR.`);
      logger.warn(`[main] Récapitulatif diagnostic : ${entries.length} entrées HAR | ${jsonResponses.length} JSON parsés | ${rawAds.length} annonces brutes | ${normalized.length} après normalisation | 0 après déduplication.`);
      logger.warn(`[main] Causes probables : page de recherche non chargée, réponse réseau absente, données reçues mais ne contenant pas d'annonces, ou filtre ayant tout supprimé.`);
      process.exitCode = 2;
      return;
    }

    writeOutputs(ads);
    logger.info(`Étape HAR -> Annonces terminée : ${ads.length} annonces extraites.`);
    // Métriques structurées (compteurs cohérents pour le résumé de session) :
    // annonces brutes → normalisées → uniques après déduplication.
    logger.info(`[METRICS] ${ads.length} annonces extraites uniques (${normalized.length} normalisées, ${Math.max(0, normalized.length - ads.length)} doublons fusionnés).`);
    const dtLivraison = ads.filter((a) => a.deliveryType === 'livraison').length;
    const dtMainPropre = ads.filter((a) => a.deliveryType === 'main_propre').length;
    const dtLesDeux = ads.filter((a) => a.deliveryType === 'les_deux').length;
    const dtAucun = ads.filter((a) => a.deliveryType === 'aucun').length;
    const dtInconnu = ads.filter((a) => a.deliveryType === 'inconnu' || !a.deliveryType).length;
    logger.debug(`[main] ${summarizeAds(ads)}`);
    logger.debug(`[main] Type de remise : ${dtLivraison} livraison | ${dtMainPropre} main_propre | ${dtLesDeux} les_deux | ${dtAucun} aucun | ${dtInconnu} inconnu.`);
  }

  if (opts.limit) {
    logger.debug(`[main] Application de la limite : ${ads.length} → ${Math.min(opts.limit, ads.length)} annonces.`);
    ads = ads.slice(0, opts.limit);
  }

  if (!opts.noDesc) {
    logger.debug(`[main] Lancement de l'enrichissement des descriptions...`);
    const enricher = new DescriptionEnricher(opts, logger);
    const enrichResult = await enricher.enrichAll(ads, writeOutputs);

    // Arrêt sur blocage d'accès : on sort en code dédié (3=403 refus, 4=429
    // limitation) APRÈS avoir écrit les résultats partiels. Les annonces déjà
    // extraites restent sur disque ; aucune reprise automatique n'est tentée.
    if (enrichResult && enrichResult.stopReason) {
      const refused = enrichResult.stopReason === 'HTTP_403';
      logger.warn(`[main] Enrichissement interrompu (${enrichResult.stopReason}) — ${enrichResult.successCount} description(s) récupérée(s), ${enrichResult.blockedCount} blocage(s). Résultats partiels conservés.`);
      process.exitCode = refused ? 3 : 4;
      return;
    }
  } else {
    logger.debug(`[main] Enrichissement des descriptions ignoré (option --no-desc).`);
  }

  writeOutputs(ads);
  logger.info('\n✅ Opération terminée avec succès.');
  logger.debug(`[main] Bilan final : ${summarizeAds(ads)}`);
}

main().catch((err) => {
  console.error('Erreur fatale :', err.stack || err.message);
  // Exit code 1 : le PipelineRunner doit savoir que le pipeline a échoué.
  process.exitCode = 1;
});