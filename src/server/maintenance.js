'use strict';

/**
 * Maintenance périodique du serveur Web :
 *   - purge des sessions expirées ;
 *   - suppression des tâches plus anciennes que la rétention configurée
 *     (base + fichiers sur disque) — évite la croissance illimitée du stockage ;
 *   - suppression des HAR résiduels (déjà nettoyés après chaque job, filet).
 *
 * Idempotent et sûr : ne touche qu'aux tâches TERMINÉES plus vieilles que le
 * seuil. Une tâche en cours n'est jamais purgée.
 */

const fs = require('fs');
const path = require('path');

function runMaintenance(repo, config, log = () => {}) {
  const stats = { sessions: 0, jobs: 0, hars: 0 };

  // 1) Sessions expirées.
  try { repo.purgeExpiredSessions(); } catch { /* best-effort */ }

  // 2) Tâches expirées.
  if (config.jobRetentionDays > 0) {
    const cutoff = new Date(Date.now() - config.jobRetentionDays * 86400000).toISOString();
    let rows = [];
    try { rows = repo.stmt.oldestJobs.all(cutoff); } catch { rows = []; }
    for (const row of rows) {
      const job = repo.getJob(row.id);
      if (!job) continue;
      // Ne purge jamais une tâche encore active.
      if (['queued', 'running', 'action_required'].includes(job.status)) continue;
      try { repo.db.prepare('DELETE FROM jobs WHERE id = ?').run(row.id); } catch { /* noop */ }
      const jobDir = row.job_dir || path.join(config.jobsRootDir, job.user_id, row.id);
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch { /* noop */ }
      stats.jobs++;
    }
  }

  // 3) HAR résiduels dans les dossiers de jobs (filet de sécurité).
  if (config.harRetentionDays > 0) {
    try {
      const users = fs.readdirSync(config.jobsRootDir, { withFileTypes: true }).filter((e) => e.isDirectory());
      const maxAge = config.harRetentionDays * 86400000;
      for (const u of users) {
        const userDir = path.join(config.jobsRootDir, u.name);
        for (const jd of fs.readdirSync(userDir, { withFileTypes: true })) {
          if (!jd.isDirectory()) continue;
          for (const name of ['capture.har', 'capture-resume.har']) {
            const p = path.join(userDir, jd.name, name);
            try {
              if (fs.existsSync(p) && (Date.now() - fs.statSync(p).mtimeMs) > maxAge) { fs.unlinkSync(p); stats.hars++; }
            } catch { /* noop */ }
          }
        }
      }
    } catch { /* dossier absent : rien à faire */ }
  }

  if (stats.jobs || stats.hars) {
    log(`Maintenance : ${stats.jobs} tâche(s) purgée(s), ${stats.hars} HAR supprimé(s).`);
  }
  return stats;
}

module.exports = { runMaintenance };
