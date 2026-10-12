'use strict';

/**
 * Bus d'événements temps réel par tâche (pub/sub).
 *
 * Diffuse les lignes de log ET les changements d'état/progression aux clients
 * connectés en SSE, sans dépendre d'une requête HTTP longue. Les logs sont
 * AUSSI persistés en base (job_logs) → un client qui se reconnecte peut rejouer
 * l'historique via `GET /api/jobs/:id/logs`.
 *
 * Événements : 'log' (ligne de log) et 'status' (état/progression).
 */

const { EventEmitter } = require('events');

class JobEvents {
  constructor() {
    this._emitters = new Map(); // jobId -> EventEmitter
  }

  _get(jobId) {
    let em = this._emitters.get(jobId);
    if (!em) {
      em = new EventEmitter();
      em.setMaxListeners(0);
      this._emitters.set(jobId, em);
    }
    return em;
  }

  /**
   * Abonne un callback à un type d'événement d'une tâche.
   * @returns {Function} fonction de désabonnement
   */
  subscribe(jobId, type, cb) {
    const em = this._get(jobId);
    em.on(type, cb);
    return () => { em.removeListener(type, cb); };
  }

  publish(jobId, type, payload) {
    this._get(jobId).emit(type, payload);
  }

  /** Libère l'émetteur d'une tâche terminée. */
  close(jobId) {
    const em = this._emitters.get(jobId);
    if (em) {
      em.removeAllListeners();
      this._emitters.delete(jobId);
    }
  }
}

module.exports = { JobEvents };

