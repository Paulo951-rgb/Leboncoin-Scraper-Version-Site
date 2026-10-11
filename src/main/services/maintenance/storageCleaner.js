'use strict';

const fs = require('fs');
const path = require('path');
const { JOBS_DIR } = require('../../config/constants');

class StorageCleaner {
  /**
   * Nettoie les fichiers .har de plus de `maxDays` jours dans output/
   */
  static cleanOldHars(maxDays = 7) {
    // Cohérent avec cleanOldJobs : 0 = désactivé. Sans ce garde-fou,
    // cleanOldHars(0) fixait maxAgeMs=0 et supprimait TOUS les HAR (y compris
    // ceux des jobs du jour) — un réglage à 0 côté utilisateur détruisait tout
    // l'historique de capture.
    if (!maxDays || maxDays <= 0) return 0;

    const jobsDir = JOBS_DIR;
    if (!fs.existsSync(jobsDir)) {
      console.log(`[StorageCleaner] Dossier jobs introuvable : ${jobsDir} — rien à nettoyer.`);
      return 0;
    }

    const now = Date.now();
    const maxAgeMs = maxDays * 24 * 60 * 60 * 1000;
    let deletedCount = 0;
    let scannedCount = 0;

    try {
      const entries = fs.readdirSync(jobsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const harPath = path.join(jobsDir, entry.name, 'capture.har');
        if (fs.existsSync(harPath)) {
          scannedCount++;
          const stats = fs.statSync(harPath);
          const ageDays = Math.floor((now - stats.mtimeMs) / (24 * 60 * 60 * 1000));
          if (now - stats.mtimeMs > maxAgeMs) {
            fs.unlinkSync(harPath);
            deletedCount++;
            console.log(`[StorageCleaner] HAR supprimé : ${harPath} (${ageDays} jours, > ${maxDays}j).`);
          }
        }
      }
      console.log(`[StorageCleaner] Nettoyage terminé : ${scannedCount} HAR scanné(s) | ${deletedCount} supprimé(s) (> ${maxDays} jours) dans ${jobsDir}.`);
    } catch (err) {
      console.error('[StorageCleaner] Erreur lors du nettoyage des fichiers HAR :', err.message);
    }

    return deletedCount;
  }

  /**
   * Nettoie les dossiers de jobs (job-*) de plus de `maxDays` jours.
   * Supprime entièrement le dossier job-<timestamp> (HAR + résultats + session).
   * @param {number} maxDays Âge maximum en jours (0 = désactivé).
   * @returns {number} Nombre de jobs supprimés.
   */
  static cleanOldJobs(maxDays = 0) {
    if (!maxDays || maxDays <= 0) return 0;

    const jobsDir = JOBS_DIR;
    if (!fs.existsSync(jobsDir)) {
      console.log(`[StorageCleaner] Dossier jobs introuvable : ${jobsDir} — rien à nettoyer.`);
      return 0;
    }

    const now = Date.now();
    const maxAgeMs = maxDays * 24 * 60 * 60 * 1000;
    let deletedCount = 0;
    let scannedCount = 0;

    try {
      const entries = fs.readdirSync(jobsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('job-')) continue;
        scannedCount++;
        const jobPath = path.join(jobsDir, entry.name);

        // Âge basé sur le timestamp ISO embarqué dans le nom du dossier
        // (job-<ISO>) plutôt que sur le mtime : annonces.json est réécrit à
        // chaque re-scraping/re-analyse, ce qui rafraîchit le mtime et
        // empêchait à tort les vieux jobs d'être nettoyés.
        const tsMatch = entry.name.match(/^job-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
        let referenceMs;
        if (tsMatch) {
          const iso = tsMatch[1].replace(/-(\d{2})-(\d{2})$/, ':$1:$2');
          referenceMs = Date.parse(iso);
        }
        if (!Number.isFinite(referenceMs)) {
          // Fallback mtime si le timestamp du nom est illisible
          referenceMs = fs.statSync(jobPath).mtimeMs;
        }

        const ageDays = Math.floor((now - referenceMs) / (24 * 60 * 60 * 1000));
        if (now - referenceMs > maxAgeMs) {
          fs.rmSync(jobPath, { recursive: true, force: true });
          deletedCount++;
          console.log(`[StorageCleaner] Job supprimé : ${entry.name} (${ageDays} jours, > ${maxDays}j).`);
        }
      }
      console.log(`[StorageCleaner] Nettoyage jobs : ${scannedCount} scanné(s) | ${deletedCount} supprimé(s) (> ${maxDays} jours) dans ${jobsDir}.`);
    } catch (err) {
      console.error('[StorageCleaner] Erreur lors du nettoyage des jobs :', err.message);
    }

    return deletedCount;
  }
}

module.exports = { StorageCleaner };