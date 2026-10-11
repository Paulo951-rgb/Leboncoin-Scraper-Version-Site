'use strict';

/**
 * NetworkJournal — journal réseau structuré d'un job.
 *
 * Objectif : disposer de compteurs OBJECTIFS (navigations, requêtes de détail,
 * 403/429 avec URL, pages réussies/échouées) pour comparer deux runs et
 * diagnostiquer un blocage, sans dépendre d'heuristiques de texte dans les logs.
 *
 * Purement en mémoire (sérialisé dans report.json en fin de job). Aucune I/O.
 */

class NetworkJournal {
  constructor() {
    this.navigations = 0;          // navigations de page de recherche
    this.detailRequests = 0;       // requêtes de page de détail (enrichissement)
    this.blockedRequests = 0;      // réponses 403/429 (toutes origines)
    this.otherErrors = 0;          // autres erreurs réseau/HTTP
    this.pagesOk = 0;              // pages de recherche réussies
    this.pagesFailed = 0;          // pages de recherche en échec/bloquées
    this.blockedUrls = [];         // URLs bloquées (plafonné)
    this.maxBlockedUrls = 50;
  }

  recordNavigation() { this.navigations++; }

  recordPageResult(ok) {
    if (ok) this.pagesOk++;
    else this.pagesFailed++;
  }

  recordDetailRequest() { this.detailRequests++; }

  /**
   * Enregistre un blocage (403/429).
   * @param {string} [url]
   * @param {number} [status]
   */
  recordBlock(url, status) {
    this.blockedRequests++;
    if (url && this.blockedUrls.length < this.maxBlockedUrls) {
      this.blockedUrls.push({ url, status: status ?? null });
    }
  }

  recordError() { this.otherErrors++; }

  snapshot() {
    return {
      navigations: this.navigations,
      detailRequests: this.detailRequests,
      blockedRequests: this.blockedRequests,
      otherErrors: this.otherErrors,
      pagesOk: this.pagesOk,
      pagesFailed: this.pagesFailed,
      blockedUrls: this.blockedUrls.slice(),
    };
  }
}

module.exports = { NetworkJournal };
