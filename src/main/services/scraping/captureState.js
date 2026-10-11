'use strict';

/**
 * État de progression de capture + fusion de fichiers HAR.
 *
 * Objectif (reprise incrémentale) : si la page 7/10 est bloquée, on ne perd pas
 * les pages 1-6 déjà capturées. On persiste un `capture-progress.json` après
 * chaque page réussie, et on sait reprendre la capture à `lastPageOk + 1` en
 * fusionnant le nouveau HAR partiel avec le précédent.
 *
 * Pur (fs uniquement, pas de Playwright/electron) → testable sans navigateur.
 */

const fs = require('fs');
const path = require('path');

const PROGRESS_FILE = 'capture-progress.json';

function getProgressPath(jobDir) {
  return path.join(jobDir, PROGRESS_FILE);
}

/**
 * Lit l'état de progression d'un job.
 * @returns {{searchUrl:string,pagesRequested:number,lastPageOk:number,pagesOk:number,updatedAt:string}|null}
 */
function readProgress(jobDir) {
  try {
    const p = getProgressPath(jobDir);
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

function writeProgress(jobDir, data) {
  try {
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(getProgressPath(jobDir), JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  } catch { /* best-effort : ne doit jamais faire échouer la capture */ }
}

function clearProgress(jobDir) {
  try {
    const p = getProgressPath(jobDir);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* best-effort */ }
}

/**
 * Fusionne plusieurs fichiers HAR en un seul (concaténation des entrées).
 * Utilisé pour la reprise : HAR précédent (pages 1-6) + HAR de reprise (7-10).
 * @param {string[]} harPaths - chemins des HAR à fusionner (dans l'ordre)
 * @param {string} outPath - chemin du HAR fusionné
 * @returns {{entries:number, sources:number}} compteurs
 */
function mergeHarFiles(harPaths, outPath) {
  const existing = (harPaths || []).filter((p) => p && fs.existsSync(p));
  if (existing.length === 0) return { entries: 0, sources: 0 };

  let base = null;
  const allEntries = [];
  for (const p of existing) {
    try {
      const har = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!base) base = har;
      const entries = (har && har.log && Array.isArray(har.log.entries)) ? har.log.entries : [];
      for (const e of entries) allEntries.push(e);
    } catch { /* HAR illisible : ignoré */ }
  }
  if (!base) return { entries: 0, sources: 0 };

  base.log = base.log || {};
  base.log.entries = allEntries;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(base), 'utf8');
  return { entries: allEntries.length, sources: existing.length };
}

module.exports = {
  PROGRESS_FILE,
  getProgressPath,
  readProgress,
  writeProgress,
  clearProgress,
  mergeHarFiles,
};
