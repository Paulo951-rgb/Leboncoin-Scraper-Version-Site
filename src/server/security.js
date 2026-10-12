'use strict';

/**
 * Validation des entrées + protections SSRF/anti-accès interne.
 *
 * RÈGLE DE SÉCURITÉ FONDAMENTALE : une URL fournie par l'utilisateur n'est
 * JAMAIS utilisée comme destination HTTP arbitraire. Le scraping n'accepte que
 * des URLs Leboncoin explicitement autorisées (allowlist stricte) et refuse
 * toute adresse interne/localhost/IP privée.
 */

const { URL } = require('url');
const net = require('net');
const { isHostAllowed, isSafeFetchDestination } = require('../main/utils/urlSecurity');

const SPEEDS = ['moyen', 'rapide', 'ultra-rapide'];
const PROFILES = ['default', 'maximum', 'custom'];

/**
 * Valide l'URL de recherche Leboncoin.
 * @returns {{ ok: boolean, value?: string, error?: string }}
 */
function validateSearchUrl(rawUrl, allowedHosts) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, error: 'URL de recherche manquante.' };
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length > 2000) return { ok: false, error: 'URL trop longue.' };

  // Contrôle structurel (protocole http/https, pas d'IP privée, pas de localhost).
  const safe = isSafeFetchDestination(trimmed, allowedHosts);
  if (!safe.safe) return { ok: false, error: `URL refusée : ${safe.reason}` };

  let parsed;
  try { parsed = new URL(trimmed); } catch { return { ok: false, error: 'URL invalide.' }; }
  if (!isHostAllowed(parsed.hostname, allowedHosts)) {
    return { ok: false, error: `Domaine non autorisé : ${parsed.hostname}. Seules les URLs Leboncoin sont acceptées.` };
  }
  return { ok: true, value: parsed.toString() };
}

/**
 * Valide l'URL d'un proxy éventuel (http/socks5, hôte public).
 * @returns {{ ok: boolean, value?: string|null, error?: string }}
 */
function validateProxyUrl(rawProxy) {
  if (rawProxy == null || rawProxy === '') return { ok: true, value: null };
  if (typeof rawProxy !== 'string') return { ok: false, error: 'Proxy invalide.' };
  const trimmed = rawProxy.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > 300) return { ok: false, error: 'Proxy trop long.' };
  let parsed;
  try { parsed = new URL(trimmed); } catch { return { ok: false, error: 'Proxy : URL invalide.' }; }
  if (!['http:', 'https:', 'socks5:', 'socks4:', 'socks:'].includes(parsed.protocol)) {
    return { ok: false, error: `Proxy : schéma non autorisé (${parsed.protocol}).` };
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, error: 'Proxy : hôte local interdit.' };
  }
  if (net.isIP(host)) {
    const check = isSafeFetchDestination(trimmed);
    if (!check.safe) return { ok: false, error: `Proxy refusé : ${check.reason}` };
  }
  return { ok: true, value: trimmed };
}

function toInt(value, def, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/**
 * Valide et normalise la configuration d'un job de scraping.
 * @returns {{ ok: boolean, value?: object, error?: string }}
 */
function validateJobConfig(body, opts) {
  const cfg = opts || {};
  const allowedHosts = cfg.allowedHosts || ['leboncoin.fr'];
  const maxPages = cfg.maxPages || 50;
  const maxAds = cfg.maxAds || 5000;

  if (!body || typeof body !== 'object') return { ok: false, error: 'Corps de requête invalide.' };

  const url = validateSearchUrl(body.searchUrl, allowedHosts);
  if (!url.ok) return { ok: false, error: url.error };

  const pages = toInt(body.pages, 1, 1, maxPages);
  let limit = null;
  if (body.limit != null && body.limit !== '') {
    limit = toInt(body.limit, null, 1, maxAds);
  }

  const profileId = PROFILES.includes(body.profileId) ? body.profileId : 'default';
  let exportFields = null;
  if (profileId === 'custom') {
    if (!Array.isArray(body.exportFields)) {
      return { ok: false, error: 'Profil Personnalisé : exportFields doit être un tableau.' };
    }
    exportFields = body.exportFields.filter((k) => typeof k === 'string').slice(0, 100);
  }

  const speed = SPEEDS.includes(body.speed) ? body.speed : (cfg.defaultSpeed || 'moyen');
  const proxy = validateProxyUrl(body.proxyUrl);
  if (!proxy.ok) return { ok: false, error: proxy.error };

  return {
    ok: true,
    value: {
      searchUrl: url.value,
      pages,
      limit,
      noDesc: body.noDesc === true,
      profileId,
      exportFields,
      includeSellerData: body.includeSellerData !== false,
      speed,
      proxyUrl: proxy.value,
    },
  };
}

/**
 * Valide un patch de réglages utilisateur (mêmes règles que l'app Electron,
 * étendues aux préférences Web). Rejette les clés inconnues et hors plage.
 */
function sanitizeSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object') return {};
  const out = {};
  const intInRange = (v, min, max) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
  };
  if ('scrapeSpeed' in patch && SPEEDS.includes(patch.scrapeSpeed)) out.scrapeSpeed = patch.scrapeSpeed;
  if ('pageDelayMs' in patch) { const n = intInRange(patch.pageDelayMs, 0, 60000); if (n !== undefined) out.pageDelayMs = n; }
  if ('headless' in patch && typeof patch.headless === 'boolean') out.headless = patch.headless;
  if ('includeSellerData' in patch && typeof patch.includeSellerData === 'boolean') out.includeSellerData = patch.includeSellerData;
  if ('autoCleanHarDays' in patch) { const n = intInRange(patch.autoCleanHarDays, 0, 3650); if (n !== undefined) out.autoCleanHarDays = n; }
  if ('autoCleanJobsDays' in patch) { const n = intInRange(patch.autoCleanJobsDays, 0, 3650); if (n !== undefined) out.autoCleanJobsDays = n; }
  if ('logRetentionDays' in patch) { const n = intInRange(patch.logRetentionDays, 1, 3650); if (n !== undefined) out.logRetentionDays = n; }
  if ('logLevel' in patch && ['debug', 'info', 'warn', 'error'].includes(patch.logLevel)) out.logLevel = patch.logLevel;
  if ('theme' in patch && typeof patch.theme === 'string' && /^theme-[a-z]+$/.test(patch.theme)) out.theme = patch.theme;
  return out;
}

const SETTINGS_DEFAULTS = Object.freeze({
  scrapeSpeed: 'moyen',
  pageDelayMs: 1200,
  headless: true,
  includeSellerData: true,
  autoCleanHarDays: 2,
  autoCleanJobsDays: 0,
  logRetentionDays: 7,
  logLevel: 'info',
  theme: 'theme-dark',
});

module.exports = {
  validateSearchUrl,
  validateProxyUrl,
  validateJobConfig,
  sanitizeSettingsPatch,
  SETTINGS_DEFAULTS,
  SPEEDS,
  PROFILES,
  toInt,
};
