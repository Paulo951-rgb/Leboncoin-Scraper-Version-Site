'use strict';

/**
 * Stockage chiffré des secrets (clés API, tokens).
 *
 * Deux niveaux de protection, distincts et signalés :
 *  1. safeStorage (préféré) : s'appuie sur le trousseau de l'OS (Keychain macOS,
 *     DPAPI Windows, libsecret/KWallet Linux). Protection liée au compte
 *     utilisateur du système → un autre compte ne peut pas déchiffrer.
 *  2. Repli AES-256-GCM : utilisé UNIQUEMENT si le trousseau n'est pas disponible.
 *     La clé est dérivée d'informations machine PUBLIQUES (nom d'utilisateur +
 *     hostname). Ce n'est PAS équivalent au trousseau OS : quiconque accède au
 *     fichier et connaît ces informations peut reconstruire la clé. Ce repli
 *     évite seulement le clair sur disque ; il ne protège pas contre un accès
 *     au système de fichiers. `isUsingOsKeychain()` permet à l'UI d'avertir.
 *
 * Les secrets sont stockés dans `secrets.enc.json` (jamais en clair, jamais
 * dans user-settings.json ni le localStorage).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');
const { atomicWriteFileSync } = require('./helpers');

const ALGO = 'aes-256-gcm';
const FALLBACK_KEY_SALT = 'leboncoin-scraper-v1';

let _secretsPath = null;
let _cache = null;
let _fallbackWarned = false;

function _getSecretsPath() {
  if (_secretsPath) return _secretsPath;
  let base;
  try {
    base = app && app.isPackaged
      ? path.join(app.getPath('documents'), 'Leboncoin Scraper Pro')
      : path.join(process.cwd(), 'output');
  } catch {
    base = path.join(process.cwd(), 'output');
  }
  _secretsPath = path.join(base, 'secrets.enc.json');
  return _secretsPath;
}

function _isEncryptionAvailable() {
  try { return typeof safeStorage !== 'undefined' && safeStorage.isEncryptionAvailable(); } catch { return false; }
}

function _deriveFallbackKey() {
  // Fallback : clé dérivée d'un identifiant machine stable.
  // Moins sûr que safeStorage, mais évite le clair sur disque.
  const userInfo = (() => { try { return require('os').userInfo().username; } catch { return 'anon'; } })();
  const hostname = (() => { try { return require('os').hostname(); } catch { return 'host'; } })();
  return crypto.createHash('sha256').update(`${userInfo}@${hostname}:${FALLBACK_KEY_SALT}`).digest();
}

function _encryptString(plain) {
  if (_isEncryptionAvailable()) {
    return { method: 'safeStorage', value: safeStorage.encryptString(plain).toString('base64') };
  }
  // Fallback AES-256-GCM : protection RÉDUITE (clé dérivée d'infos machine
  // publiques). On avertit une seule fois pour ne pas laisser croire à une
  // protection équivalente au trousseau OS.
  if (!_fallbackWarned) {
    _fallbackWarned = true;
    console.warn('[SecretStore] Trousseau OS indisponible — repli AES-256-GCM (clé dérivée d\'identifiants machine publics). Protection réduite : ne protège pas contre un accès au système de fichiers.');
  }
  const key = _deriveFallbackKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { method: 'aes-256-gcm', value: enc.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64') };
}

function _decryptString(blob) {
  if (!blob || !blob.method || !blob.value) return null;
  if (blob.method === 'safeStorage') {
    if (!_isEncryptionAvailable()) return null;
    try {
      return safeStorage.decryptString(Buffer.from(blob.value, 'base64'));
    } catch { return null; }
  }
  if (blob.method === 'aes-256-gcm') {
    try {
      const key = _deriveFallbackKey();
      const iv = Buffer.from(blob.iv, 'base64');
      const tag = Buffer.from(blob.tag, 'base64');
      const enc = Buffer.from(blob.value, 'base64');
      const decipher = crypto.createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);
      const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
      return dec.toString('utf8');
    } catch { return null; }
  }
  return null;
}

function _load() {
  if (_cache) return _cache;
  const p = _getSecretsPath();
  try {
    if (fs.existsSync(p)) {
      _cache = JSON.parse(fs.readFileSync(p, 'utf8'));
    } else {
      _cache = {};
    }
  } catch {
    _cache = {};
  }
  return _cache;
}

function _save() {
  const p = _getSecretsPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Écriture atomique : un crash pendant fs.writeFileSync laissait
    // secrets.enc.json tronqué → tous les secrets définitivement perdus.
    atomicWriteFileSync(p, JSON.stringify(_cache, null, 2), 'utf8');
  } catch (err) {
    console.error('[SecretStore] Erreur sauvegarde secrets :', err.message);
  }
}

const SecretStore = {
  /**
   * Récupère un secret chiffré et le déchiffre.
   * @param {string} key  Nom du secret (ex: 'search-api-key' pour Tavily)
   * @returns {string|null} Valeur en clair, ou null si absent/illisible.
   */
  get(key) {
    const store = _load();
    const blob = store[key];
    if (!blob) return null;
    return _decryptString(blob);
  },

  /**
   * Chiffre et stocke un secret.
   * @param {string} key
   * @param {string} value
   */
  set(key, value) {
    const store = _load();
    if (value == null || value === '') {
      delete store[key];
    } else {
      store[key] = _encryptString(String(value));
    }
    _cache = store;
    _save();
  },

  /**
   * Supprime un secret.
   */
  remove(key) {
    const store = _load();
    delete store[key];
    _cache = store;
    _save();
  },

  /**
   * Liste les noms de secrets stockés (sans les valeurs).
   */
  list() {
    return Object.keys(_load());
  },

  /**
   * Indique si le chiffrement OS natif est utilisé (true) ou le fallback (false).
   */
  isUsingOsKeychain() {
    return _isEncryptionAvailable();
  },
};

module.exports = { SecretStore };
