'use strict';

/**
 * AdStats — statistiques agrégées sur un ensemble d'annonces (sans scoring).
 */
class AdStats {
  /**
   * Calcule les statistiques d'un lot d'annonces.
   * @param {Array} ads annonces (champ `prix` number ou string)
   * @returns {{stats: Object|null, ads: Array}} stats + annonces inchangées
   */
  static analyze(ads) {
    if (!Array.isArray(ads) || ads.length === 0) {
      return { stats: null, ads: [] };
    }

    // Extraction robuste des prix : gère number, string avec format FR/EN,
    // null, undefined, valeurs invalides.
    const validPrices = [];
    for (const a of ads) {
      const raw = a.prix ?? a.price;
      if (raw == null || raw === '') continue;
      let n;
      if (typeof raw === 'number') {
        n = Number.isFinite(raw) ? raw : NaN;
      } else if (typeof raw === 'string') {
        // Gère "1 250 €", "1.299,99", "12,50", "1250", etc.
        n = parseFloat(raw.replace(/\s/g, '').replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
      } else {
        n = NaN;
      }
      if (Number.isFinite(n) && n > 0) validPrices.push(n);
    }
    validPrices.sort((a, b) => a - b);

    if (validPrices.length === 0) {
      return { stats: null, ads };
    }

    const sum = validPrices.reduce((s, p) => s + p, 0);
    const avg = Math.round(sum / validPrices.length);
    const minPrice = validPrices[0];
    const maxPrice = validPrices[validPrices.length - 1];
    // Médiane : pour un nombre PAIR de prix, moyenne des deux valeurs centrales
    // (ne pas reprendre validPrices[Math.floor(n/2)] qui est faux pour n pair).
    const mid = Math.floor(validPrices.length / 2);
    const medianPrice = validPrices.length % 2 !== 0
      ? validPrices[mid]
      : Math.round((validPrices[mid - 1] + validPrices[mid]) / 2);

    // Statistiques deliveryType (modèle unifié)
    let livraisonCount = 0;
    let mainPropreCount = 0;
    let lesDeuxCount = 0;
    let aucunCount = 0;
    let inconnuCount = 0;
    let nonRenseigneCount = 0; // alias pour inconnu (rétro-compat)

    for (const a of ads) {
      let dt = a.deliveryType;
      // Rétro-compat : si deliveryType absent, calcule depuis livraison/mainPropre
      if (!dt) {
        const livraison = a.livraison ?? a.shipping;
        const mainPropre = a.mainPropre ?? a.handDelivery;
        if (livraison === true && mainPropre === true) dt = 'les_deux';
        else if (livraison === true) dt = 'livraison';
        else if (mainPropre === true) dt = 'main_propre';
        else if (livraison === false && mainPropre === false) dt = 'aucun';
        else dt = 'inconnu';
      }
      if (dt === 'livraison') livraisonCount++;
      else if (dt === 'main_propre') mainPropreCount++;
      else if (dt === 'les_deux') lesDeuxCount++;
      else if (dt === 'aucun') aucunCount++;
      else { inconnuCount++; nonRenseigneCount++; }
    }

    return {
      stats: {
        minPrice,
        maxPrice,
        avgPrice: avg,
        medianPrice,
        totalAds: ads.length,
        pricedAds: validPrices.length,
        livraisonCount,
        mainPropreCount,
        lesDeuxCount,
        aucunCount,
        inconnuCount,
        nonRenseigneCount,
      },
      ads,
    };
  }
}

module.exports = { AdStats };
