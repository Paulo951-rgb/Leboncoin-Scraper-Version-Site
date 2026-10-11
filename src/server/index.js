'use strict';

/**
 * Point d'entrée du serveur Web (Render-ready).
 *
 * - Écoute sur 0.0.0.0 et process.env.PORT (défaut 3000 en local).
 * - Gestion propre des signaux SIGTERM/SIGINT : annule les tâches actives,
 *   ferme les navigateurs/processus enfants et la base, puis quitte.
 * - Ne requiert PAS `electron`.
 */

const os = require('os');
const { buildApp } = require('./app');
const { runMaintenance } = require('./maintenance');

function log(msg) {
  console.log(`[server] ${new Date().toISOString()} ${msg}`);
}

function start() {
  const { app, repo, manager, db, config } = buildApp();

  const server = app.listen(config.port, config.host, () => {
    log(`Leboncoin Scraper Web démarré sur http://${config.host}:${config.port} (mode ${config.isProd ? 'production' : 'development'})`);
    log(`Stockage : ${config.dataDir}`);
    log(`Authentification : ${config.authEnabled ? 'activée' : 'DÉSACTIVÉE (dev)'}`);
    log(`Concurrence globale : ${config.globalMaxConcurrency} | tâches/utilisateur : ${config.maxJobsPerUser}`);
    log(`RAM totale : ${Math.round(os.totalmem() / 1024 / 1024)} Mo | CPU : ${os.cpus().length} cœur(s)`);
  });

  // Nettoyage périodique des sessions expirées.
  const sessionTimer = setInterval(() => {
    try { repo.purgeExpiredSessions(); } catch { /* best-effort */ }
  }, 60 * 60 * 1000);
  sessionTimer.unref();

  // Maintenance (rétention des tâches/HAR) — toutes les 6 heures.
  const maintenanceTimer = setInterval(() => {
    try { runMaintenance(repo, config, log); } catch (e) { log(`maintenance: ${e.message}`); }
  }, 6 * 60 * 60 * 1000);
  maintenanceTimer.unref();
  // Un passage au démarrage (récupère un éventuel backlog après redéploiement).
  setTimeout(() => { try { runMaintenance(repo, config, log); } catch { /* noop */ } }, 5000).unref();

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Signal ${signal} reçu — arrêt propre…`);
    // 1) Annule toutes les tâches (ferme navigateurs + processus enfants).
    try { manager.shutdown(); } catch (e) { log(`shutdown manager: ${e.message}`); }
    // 2) Ferme le serveur HTTP.
    server.close(() => {
      try { db.close(); } catch { /* noop */ }
      log('Arrêt terminé.');
      process.exit(0);
    });
    // Filet de sécurité : arrêt forcé si le close traîne.
    setTimeout(() => {
      log('Arrêt forcé (délai dépassé).');
      process.exit(0);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => log(`Promesse rejetée non gérée : ${reason}`));
  process.on('uncaughtException', (err) => log(`Exception non gérée : ${err && err.stack ? err.stack : err}`));

  return { server, manager, repo, db };
}

if (require.main === module) {
  start();
}

module.exports = { start };
