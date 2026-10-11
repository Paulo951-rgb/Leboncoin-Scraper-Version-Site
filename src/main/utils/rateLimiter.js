'use strict';

/**
 * Rate limiting adaptatif avec backoff exponentiel.
 *
 * Le limiteur ajuste dynamiquement le délai entre les requêtes en fonction
 * des signaux du serveur (latence, codes 429/403, erreurs réseau).
 *
 * Stratégie :
 *  - Toutes les requêtes réussies rapidement → on garde le délai de base.
 *  - Une réponse lente (> slowThresholdMs) → on augmente légèrement le délai.
 *  - Un 429/403 (blocage) → backoff exponentiel immédiat, on ralentit fort.
 *  - Une erreur réseau → on augmente le délai prudemment.
 *  - Après un certain nombre de succès consécutifs rapides, on peut accélérer
 *    (jusqu'au minimum).
 *
 * Le limiteur expose aussi une méthode `currentDelayMs()` pour introspection.
 */

const { sleep } = require('./helpers');

class AdaptiveRateLimiter {
  /**
   * @param {Object} opts
   * @param {number} opts.baseDelayMs      Délai de base (défaut 800)
   * @param {number} opts.minDelayMs       Délai minimum (défaut 300)
   * @param {number} opts.maxDelayMs       Délai maximum (défaut 8000)
   * @param {number} opts.slowThresholdMs Seuil de latence au-delà duquel on ralentit (défaut 3000)
   * @param {number} opts.backoffFactor    Facteur multiplicateur en cas de blocage (défaut 2)
   * @param {Object} [logger]
   */
  constructor(opts = {}) {
    this.baseDelayMs = opts.baseDelayMs ?? 800;
    this.minDelayMs = opts.minDelayMs ?? 300;
    this.maxDelayMs = opts.maxDelayMs ?? 8000;
    this.slowThresholdMs = opts.slowThresholdMs ?? 3000;
    this.backoffFactor = opts.backoffFactor ?? 2;
    this.logger = opts.logger || null;

    this._currentDelay = this.baseDelayMs;
    this._consecutiveBlocks = 0;
    this._consecutiveFastSuccess = 0;
  }

  currentDelayMs() {
    return Math.round(this._currentDelay);
  }

  /**
   * Signale un résultat de requête et attend le délai adapté approprié.
   * @param {Object} result
   * @param {number} result.durationMs Durée de la requête (fetch)
   * @param {number} [result.status]   Code HTTP (optionnel)
   * @param {boolean} [result.blocked] True si 403/429
   * @param {boolean} [result.error]    True si erreur réseau
   */
  async waitAfter(result) {
    const { durationMs = 0, status = 0, blocked = false, error = false } = result;

    if (blocked) {
      // Blocage explicite → backoff exponentiel agressif
      this._consecutiveBlocks++;
      this._consecutiveFastSuccess = 0;
      const backoff = Math.min(
        this.maxDelayMs,
        this.baseDelayMs * Math.pow(this.backoffFactor, this._consecutiveBlocks)
      );
      this._currentDelay = backoff;
      this._log('warn', `Blocage détecté (HTTP ${status || '?'}). Backoff ×${this.backoffFactor}^${this._consecutiveBlocks} → ${Math.round(backoff)}ms.`);
    } else if (error) {
      // Erreur réseau → ralentir prudemment
      this._consecutiveBlocks = 0;
      this._consecutiveFastSuccess = 0;
      this._currentDelay = Math.min(this.maxDelayMs, this._currentDelay * 1.5);
      this._log('warn', `Erreur réseau — ralentissement à ${Math.round(this._currentDelay)}ms.`);
    } else if (durationMs > this.slowThresholdMs) {
      // Réponse lente → augmenter légèrement
      this._consecutiveBlocks = 0;
      this._consecutiveFastSuccess = 0;
      this._currentDelay = Math.min(this.maxDelayMs, this._currentDelay * 1.25);
      this._log('debug', `Réponse lente (${Math.round(durationMs)}ms > ${this.slowThresholdMs}ms) → délai porté à ${Math.round(this._currentDelay)}ms.`);
    } else {
      // Succès rapide → compte les succès, accélère progressivement
      this._consecutiveBlocks = 0;
      this._consecutiveFastSuccess++;
      if (this._consecutiveFastSuccess >= 5 && this._currentDelay > this.minDelayMs) {
        this._currentDelay = Math.max(this.minDelayMs, this._currentDelay * 0.85);
        this._consecutiveFastSuccess = 0;
        this._log('debug', `${5} succès rapides → accélération, délai réduit à ${Math.round(this._currentDelay)}ms.`);
      }
    }

    await sleep(this._currentDelay);
  }

  /**
   * Attend le délai courant sans ajuster (avant une requête).
   */
  async wait() {
    await sleep(this._currentDelay);
  }

  /**
   * Réinitialise le limiteur (après une pause prolongée, nouvelle session…).
   */
  reset() {
    this._currentDelay = this.baseDelayMs;
    this._consecutiveBlocks = 0;
    this._consecutiveFastSuccess = 0;
  }

  _log(level, msg) {
    if (!this.logger) return;
    const fn = this.logger[level] || this.logger.info || (() => {});
    fn.call(this.logger, `[RateLimiter] ${msg}`);
  }
}

module.exports = { AdaptiveRateLimiter };
