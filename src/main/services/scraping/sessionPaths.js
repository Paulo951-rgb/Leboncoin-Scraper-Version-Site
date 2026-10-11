'use strict';

/**
 * Résolution centralisée des chemins de session.
 *
 * La session globale (« Master Session ») et la session locale par job étaient
 * recalculées à plusieurs endroits (harCapturer, pipeline) avec des
 * `path.join`/`path.dirname` imbriqués fragiles. Une seule source de vérité
 * évite qu'une évolution de l'arborescence ne désynchronise la capture et
 * l'enrichissement (qui DOIVENT utiliser la même session pour rester cohérents :
 * mêmes cookies → empreinte stable).
 *
 * Ce module ne requiert PAS `electron` : importable depuis le pipeline forké.
 */

const path = require('path');
const fs = require('fs');

/**
 * Session globale, persistée dans BASE_OUT_DIR (racine des sorties).
 * @param {string} baseOutDir - BASE_OUT_DIR (dossier de sortie racine)
 */
function getGlobalSessionPath(baseOutDir) {
  return path.join(baseOutDir, 'global-session.json');
}

/**
 * Session locale d'un job : <jobDir>/session-state.json.
 * @param {string} jobDir - dossier du job (ex: JOBS_DIR/job-<timestamp>)
 */
function getJobSessionPath(jobDir) {
  return path.join(jobDir, 'session-state.json');
}

/**
 * Session locale d'un job déduite du dossier de résultats du pipeline
 * (<jobDir>/results). Le pipeline reçoit `outDir = <jobDir>/results` ; la
 * session locale est au niveau du job, soit un cran au-dessus.
 * @param {string} resultsDir - dossier `results/` du pipeline
 */
function getJobSessionPathFromResults(resultsDir) {
  return getJobSessionPath(path.dirname(resultsDir));
}

/**
 * Renvoie le chemin de session à utiliser, par ordre de préférence :
 *   1. session globale (baseOutDir/global-session.json) si elle existe ;
 *   2. session locale du job si elle existe ;
 *   3. null (aucune session → contexte vierge).
 * @param {object} opts
 * @param {string} opts.baseOutDir - BASE_OUT_DIR
 * @param {string} opts.jobDir - dossier du job
 * @returns {{path: string|null, kind: 'global'|'job'|null}}
 */
function resolveSessionPath({ baseOutDir, jobDir }) {
  const globalPath = getGlobalSessionPath(baseOutDir);
  if (fs.existsSync(globalPath)) return { path: globalPath, kind: 'global' };
  const jobPath = getJobSessionPath(jobDir);
  if (fs.existsSync(jobPath)) return { path: jobPath, kind: 'job' };
  return { path: null, kind: null };
}

module.exports = {
  getGlobalSessionPath,
  getJobSessionPath,
  getJobSessionPathFromResults,
  resolveSessionPath,
};
