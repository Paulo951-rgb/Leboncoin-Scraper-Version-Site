'use strict';

const { URL } = require('url');
const dns = require('dns');
const net = require('net');
const { promisify } = require('util');
const resolve4 = promisify(dns.resolve4);
const resolve6 = promisify(dns.resolve6);

// Plages IP privées / locales / loopback / link-local / documentation.
const PRIVATE_RANGES = [
  { start: '127.0.0.0', end: '127.255.255.255' },     // loopback
  { start: '10.0.0.0', end: '10.255.255.255' },       // private
  { start: '172.16.0.0', end: '172.31.255.255' },     // private
  { start: '192.168.0.0', end: '192.168.255.255' },   // private
  { start: '169.254.0.0', end: '169.254.255.255' },   // link-local
  { start: '0.0.0.0', end: '0.255.255.255' },         // unspecified
  { start: '100.64.0.0', end: '100.127.255.255' },    // carrier-grade NAT
  { start: '198.18.0.0', end: '198.19.255.255' },     // benchmark
  { start: '::1', end: '::1' },                        // IPv6 loopback
];

function ipToLong(ip) {
  if (net.isIP(ip) !== 4) return null;
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isPrivateIPv4(ip) {
  const n = ipToLong(ip);
  if (n === null) return false;
  for (const range of PRIVATE_RANGES) {
    if (net.isIP(range.start) === 4) {
      const start = ipToLong(range.start);
      const end = ipToLong(range.end);
      if (start !== null && end !== null && n >= start && n <= end) return true;
    }
  }
  return false;
}

// Normalise une IPv6 en supprimant les zéros de tête par groupe pour comparer
// les préfixes privés (fc00::/7, fe80::/10) de façon robuste.
function _normalizeIPv6(ip) {
  try {
    // net.isIP(ip) === 6 ; on ne gère pas les zones (fe80::1%eth0) ici.
    return ip.toLowerCase().split('%')[0];
  } catch {
    return ip;
  }
}

// Détecte les IPv6 privées/loopback/link-local/ULA, y compris les adresses
// IPv4-mappées (::ffff:127.0.0.1) qui contourneraient sinon le contrôle IPv4.
function isPrivateIPv6(ip) {
  const norm = _normalizeIPv6(ip);
  if (norm === '::1') return true;
  if (norm === '::') return true;
  // IPv4-mappée ::ffff:a.b.c.d → on vérifie la partie IPv4.
  const mapped = norm.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  // fc00::/7 (ULA) : 2 premiers bits du 1er octet = 1111 110.
  // fe80::/10 (link-local).
  const firstGroup = norm.split(':')[0];
  if (!firstGroup) return true; // « ::… » compressé → couvert par loopback/unspecified
  const first = parseInt(firstGroup, 16);
  if (!Number.isFinite(first)) return false;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
  return false;
}

// Vérifie si une chaîne littérale est une IP privée/interdite (v4 ou v6).
function isBlockedIpLiteral(ip) {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) return isPrivateIPv6(ip);
  return false;
}

async function resolveHostnameToIps(hostname) {
  const ips = [];
  try {
    const v4 = await resolve4(hostname).catch(() => []);
    ips.push(...v4);
  } catch { /* ignore */ }
  try {
    const v6 = await resolve6(hostname).catch(() => []);
    ips.push(...v6);
  } catch { /* ignore */ }
  return ips;
}

/**
 * Valide qu'une URL distante est sûre pour un fetch réseau.
 * Bloque:
 *  - protocoles non autorisés (seul http/https)
 *  - localhost, IP privées, link-local, IPv6 loopback/link-local
 *  - redirections vers destinations interdites
 *
 * @param {string} url - URL à valider
 * @param {object} [opts]
 * @param {string[]} [opts.allowedHosts] - allowlist de hostnames autorisés (ex: ['leboncoin.fr'])
 * @param {boolean} [opts.checkRedirect=true] - vérifier la redirection finale
 * @param {Response} [opts.response] - réponse après redirection pour re-valider
 * @returns {{ safe: boolean, reason?: string }}
 */
async function validateRemoteUrl(url, opts = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { safe: false, reason: 'URL invalide' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `Protocole non autorisé: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname;

  // Bloque les hostnames locaux explicites.
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return { safe: false, reason: `Hostname local interdit: ${hostname}` };
  }

  // Si une IP est fournie directement, vérifie les plages privées.
  if (net.isIP(hostname)) {
    if (isBlockedIpLiteral(hostname)) {
      return { safe: false, reason: `IP privée/interdite: ${hostname}` };
    }
  } else {
    // Résolution DNS pour vérifier les IPs associées.
    // LIMITE CONNUE : si la résolution échoue (DNS vide/erreur), on ne peut pas
    // vérifier les IPs → on laisse passer ici. Cette fonction n'est PAS utilisée
    // pour sécuriser le chemin Playwright (voir ALLOWED_FETCH_HOSTS dans le
    // pipeline). Toute future utilisation pour un fetch réseau doit refuser en
    // l'absence de résolution (fail-closed) plutôt que de continuer.
    const ips = await resolveHostnameToIps(hostname);
    for (const ip of ips) {
      if (isBlockedIpLiteral(ip)) {
        return { safe: false, reason: `Résolution DNS vers IP privée: ${hostname} -> ${ip}` };
      }
    }
  }

  // Allowlist: si fournie, le hostname doit y figurer.
  if (Array.isArray(opts.allowedHosts) && opts.allowedHosts.length > 0) {
    const allowed = opts.allowedHosts.some((h) => {
      if (h.startsWith('*.')) {
        const suffix = h.slice(2);
        return hostname === suffix || hostname.endsWith('.' + suffix);
      }
      return hostname === h;
    });
    if (!allowed) {
      return { safe: false, reason: `Hostname hors allowlist: ${hostname}` };
    }
  }

  // Vérification post-redirection: si une réponse est fournie, s'assurer
  // que l'URL finale reste autorisée.
  if (opts.checkRedirect !== false && opts.response && opts.response.url) {
    const finalUrl = opts.response.url;
    if (finalUrl !== url) {
      const finalCheck = await validateRemoteUrl(finalUrl, { ...opts, checkRedirect: false });
      if (!finalCheck.safe) {
        return { safe: false, reason: `Redirection vers destination interdite: ${finalCheck.reason}` };
      }
    }
  }

  return { safe: true };
}

module.exports = { validateRemoteUrl, isPrivateIPv4, isPrivateIPv6, isBlockedIpLiteral, resolveHostnameToIps, PRIVATE_RANGES };
