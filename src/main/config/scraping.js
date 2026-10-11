'use strict';

/**
 * Constantes partagées du scraping.
 *
 * Ce module ne requiert PAS `electron` : il est importable aussi bien par le
 * main process que par le pipeline forké (sous-processus sans accès à `app`).
 * Il centralise les seuils/délais/presets auparavant dispersés entre
 * `leboncoin-pipeline.js`, `ipcHandlers.js` et `harCapturer.js`, afin d'éviter
 * les désynchronisations (une valeur modifiée d'un côté seulement).
 */

// Presets de vitesse de l'enrichissement des descriptions.
// { concurrency, minDelayMs, maxDelayMs } — cf. AGENTS.md (anti-régression
// débit) : des délais de base trop faibles rendent le backoff minuscule.
const SPEED_PRESETS = {
  moyen:          { concurrency: 10, minDelayMs: 500, maxDelayMs: 1000, mode: 'parallèle' },
  rapide:         { concurrency: 15, minDelayMs: 200, maxDelayMs: 600,  mode: 'parallèle' },
  'ultra-rapide': { concurrency: 25, minDelayMs: 50,  maxDelayMs: 300,  mode: 'parallèle' },
};
const DEFAULT_SPEED = 'moyen';

function getSpeedPreset(speed) {
  return SPEED_PRESETS[speed] || SPEED_PRESETS[DEFAULT_SPEED];
}

// Valeurs par défaut du pipeline (surchargées par les presets de vitesse).
const PIPELINE_DEFAULTS = {
  minDelayMs: 500,
  maxDelayMs: 1000,
  headless: false,
  outDir: '.',
  concurrency: 10,
  recycleContextEvery: 200, // recyclage mémoire du contexte navigateur
  includeSellerData: true,
  fetchTimeoutMs: 15000,    // timeout d'un fetch in-page (description)
};

// Nombre maximum de pages de recherche capturables (borne anti-abus).
const MAX_PAGES = 500;

// Seuil de blocages consécutifs déclenchant l'arrêt préventif de l'enrichissement.
const BLOCK_THRESHOLD = 3;

// États du disjoncteur (circuit breaker) de l'enrichissement.
//   normal  → tout va bien
//   slowed  → ralentissement (erreurs réseau/latence) mais on continue
//   blocked → blocages répétés, arrêt préventif imminent
//   stopped → arrêt effectif de l'enrichissement
const CIRCUIT_STATES = Object.freeze({
  NORMAL: 'normal',
  SLOWED: 'slowed',
  BLOCKED: 'blocked',
  STOPPED: 'stopped',
});

module.exports = {
  SPEED_PRESETS,
  DEFAULT_SPEED,
  getSpeedPreset,
  PIPELINE_DEFAULTS,
  MAX_PAGES,
  BLOCK_THRESHOLD,
  CIRCUIT_STATES,
};
