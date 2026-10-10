'use strict';

/**
 * Codes d'erreurs structurés pour le scraper.
 * Chaque code est préfixé par le domaine : NET_, HTTP_, CAPTCHA_, PARSE_,
 * EXTRACT_, SESSION_, BROWSER_, AD_, STRUCTURE_.
 */
const ErrorCodes = {
  // Erreurs réseau
  NET_TIMEOUT: 'NET_TIMEOUT',
  NET_CONNECTION_FAILED: 'NET_CONNECTION_FAILED',
  NET_DNS_FAILED: 'NET_DNS_FAILED',

  // Erreurs HTTP
  HTTP_403: 'HTTP_403',
  HTTP_429: 'HTTP_429',
  HTTP_404: 'HTTP_404',
  HTTP_500: 'HTTP_500',
  HTTP_UNKNOWN: 'HTTP_UNKNOWN',

  // CAPTCHA
  CAPTCHA_DETECTED: 'CAPTCHA_DETECTED',
  CAPTCHA_TIMEOUT: 'CAPTCHA_TIMEOUT',
  CAPTCHA_UNRESOLVED: 'CAPTCHA_UNRESOLVED',
  // Le défi a disparu visuellement (iframe/texte/URL) mais la ressource reste
  // inaccessible : la résolution visuelle n'est PAS une preuve d'autorisation.
  CAPTCHA_NOT_CONFIRMED: 'CAPTCHA_NOT_CONFIRMED',

  // Accès ressource : distinguent un refus/l'une limitation durable d'un
  // simple blocage ponctuel.
  HTTP_ACCESS_REFUSED: 'HTTP_ACCESS_REFUSED', // HTTP 403 : accès refusé par le serveur
  HTTP_RATE_LIMITED: 'HTTP_RATE_LIMITED',     // HTTP 429 : limitation de débit (Retry-After respecté)
  ACCESS_UNVERIFIED: 'ACCESS_UNVERIFIED',     // session non validée : impossible de confirmer l'accès

  // Parsing
  PARSE_HAR_INVALID: 'PARSE_HAR_INVALID',
  PARSE_JSON_INVALID: 'PARSE_JSON_INVALID',
  PARSE_NO_ADS: 'PARSE_NO_ADS',

  // Extracteurs
  EXTRACTOR_SELLER_NAME_FAILED: 'EXTRACTOR_SELLER_NAME_FAILED',
  EXTRACTOR_SELLER_RATING_FAILED: 'EXTRACTOR_SELLER_RATING_FAILED',
  EXTRACTOR_SELLER_ID_FAILED: 'EXTRACTOR_SELLER_ID_FAILED',
  EXTRACTOR_PRICE_FAILED: 'EXTRACTOR_PRICE_FAILED',
  EXTRACTOR_DESCRIPTION_FAILED: 'EXTRACTOR_DESCRIPTION_FAILED',
  EXTRACTOR_LOCATION_FAILED: 'EXTRACTOR_LOCATION_FAILED',
  EXTRACTOR_DATES_FAILED: 'EXTRACTOR_DATES_FAILED',
  EXTRACTOR_PHOTOS_FAILED: 'EXTRACTOR_PHOTOS_FAILED',

  // Session
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_INVALID: 'SESSION_INVALID',

  // Navigateur
  BROWSER_CRASHED: 'BROWSER_CRASHED',
  BROWSER_CLOSED: 'BROWSER_CLOSED',
  BROWSER_LAUNCH_FAILED: 'BROWSER_LAUNCH_FAILED',

  // Structure
  STRUCTURE_CHANGED: 'STRUCTURE_CHANGED',
  STRUCTURE_FIELD_MISSING: 'STRUCTURE_FIELD_MISSING',

  // Annonce
  AD_DELETED: 'AD_DELETED',
  AD_MODIFIED: 'AD_MODIFIED',
  AD_EMPTY: 'AD_EMPTY',

  // Générique : échec non classé (ex. code de sortie pipeline inattendu).
  // Utilisé par PipelineRunner pour le fallback de classification.
  UNKNOWN: 'UNKNOWN',
};

/**
 * Crée un objet d'erreur structuré.
 * @param {string} code - Code d'erreur (ErrorCodes.*)
 * @param {string} message - Message lisible
 * @param {object} [context] - Contexte supplémentaire (url, page, etc.)
 * @returns {object} { code, message, context, timestamp }
 */
function createError(code, message, context) {
  return {
    code,
    message: message || code,
    context: context || {},
    timestamp: new Date().toISOString(),
  };
}

/**
 * Catégorise une erreur pour déterminer l'action à prendre.
 * @param {string} code
 * @returns {'recoverable'|'ad_error'|'network_error'|'session_error'|'global_error'|'unknown'}
 */
function classifyError(code) {
  if (!code) return 'unknown';
  if (code.startsWith('NET_')) return 'network_error';
  if (code === 'HTTP_ACCESS_REFUSED' || code === 'HTTP_RATE_LIMITED') return 'network_error';
  if (code.startsWith('HTTP_4')) return 'network_error';
  if (code.startsWith('HTTP_5')) return 'global_error';
  if (code.startsWith('CAPTCHA_')) return 'session_error';
  if (code === 'ACCESS_UNVERIFIED') return 'session_error';
  if (code.startsWith('PARSE_')) return 'global_error';
  if (code.startsWith('EXTRACTOR_')) return 'ad_error';
  if (code.startsWith('SESSION_')) return 'session_error';
  if (code.startsWith('BROWSER_')) return 'global_error';
  if (code.startsWith('STRUCTURE_')) return 'global_error';
  if (code.startsWith('AD_')) return 'ad_error';
  return 'unknown';
}

module.exports = { ErrorCodes, createError, classifyError };
