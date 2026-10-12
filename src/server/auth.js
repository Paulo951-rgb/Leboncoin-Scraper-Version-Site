'use strict';

/**
 * Authentification + autorisation côté serveur.
 *
 * - Sessions par jeton opaque (32 octets aléatoires), stockées HACHÉES (SHA-256)
 *   en base. Le jeton circule dans un cookie HttpOnly/SameSite=Lax (et peut
 *   aussi être présenté en `Authorization: Bearer`).
 * - Mots de passe hachés avec scrypt + sel aléatoire (jamais en clair).
 * - Chaque route protégée appelle requireAuth ; l'accès aux ressources filtre
 *   TOUJOURS par user_id (un id de job seul ne suffit jamais).
 */

const { verifyPassword } = require('./db');

const COOKIE_NAME = 'lbc_session';

function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function extractToken(req) {
  const auth = req.headers['authorization'];
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const cookies = parseCookies(req.headers['cookie']);
  return cookies[COOKIE_NAME] || null;
}

function setSessionCookie(res, token, ttlMs, isProd) {
  const maxAge = Math.floor(ttlMs / 1000);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * Middleware d'authentification. Attache req.user = { id, email }.
 * Renvoie 401 si absent/invalide. Si l'authentification est désactivée
 * (LBC_AUTH_DISABLED=1, dev uniquement), attache un utilisateur local unique.
 */
function requireAuth(repo, config) {
  return (req, res, next) => {
    if (!config.authEnabled) {
      // Mode dev sans auth : un utilisateur « local » stable.
      let user = repo.getUserByEmail('local@localhost');
      if (!user) user = repo.createUser('local@localhost', 'local-dev-password');
      req.user = { id: user.id, email: user.email };
      return next();
    }
    const token = extractToken(req);
    const session = repo.getSession(token);
    if (!session) {
      return res.status(401).json({ error: 'Authentification requise.' });
    }
    const user = repo.getUserById(session.user_id);
    if (!user) {
      return res.status(401).json({ error: 'Session invalide.' });
    }
    req.user = { id: user.id, email: user.email };
    req.sessionToken = token;
    return next();
  };
}

module.exports = {
  COOKIE_NAME,
  parseCookies,
  extractToken,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  verifyPassword,
};
