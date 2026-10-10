# Problèmes connus — Leboncoin Scraper Pro

*Mis à jour : 2026-10-10*

Cette liste ne contient que des problèmes **non résolus** au terme de l'audit de
stabilisation. Pour chaque entrée : impact, circonstances, prochaines étapes.

---

## KI-1 — Build `.exe` non vérifié dans cet environnement *(P2, environnement)*

- **Impact** : on ne peut pas garantir que l'installeur NSIS/portable démarre
  avec Chromium embarqué, faute de machine Windows et de Wine ici.
- **Circonstances** : uniquement lors de la génération/distribution.
- **Prochaines étapes** : exécuter `npm run dist` sur Windows (ou CI Windows),
  lancer l'installeur, vérifier `resources/browsers/` et le démarrage hors ligne.

## KI-2 — Tests d'interface graphique absents *(P2)*

- **Impact** : les bugs purement UI (rendu, événements DOM) ne sont pas couverts
  automatiquement ; seuls la syntaxe et des invariants de code sont testés.
- **Circonstances** : toute modification des modules `src/renderer/`.
- **Prochaines étapes** : ajouter un harnais DOM léger (jsdom) *si* le bénéfice
  est avéré ; sinon maintenir une checklist manuelle (démarrage de job, arrêt,
  suppression de job, changement de thème, mode hors-ligne).

## KI-3 — `urlSecurity.validateRemoteUrl` n'est pas sur le chemin Playwright *(P2, sécurité)*

- **Impact** : cette fonction ne protège pas les navigations Playwright ni les
  `fetch` du pipeline. La protection réelle des `fetch` repose sur l'allowlist
  `ALLOWED_FETCH_HOSTS` du pipeline.
- **Circonstances** : toute nouvelle utilisation de `validateRemoteUrl` pour une
  requête réseau.
- **Prochaines étapes** : rendre la fonction *fail-closed* (refuser si la
  résolution DNS échoue/vide) avant de l'utiliser pour sécuriser un accès
  réseau, et la câbler explicitement sur le chemin concerné.

## KI-4 — Repli de chiffrement des secrets à protection réduite *(P3, sécurité)*

- **Impact** : si le trousseau OS est indisponible, les secrets sont chiffrés
  avec une clé dérivée d'informations machine publiques. Cela évite le clair sur
  disque mais ne protège pas contre un accès au système de fichiers.
- **Circonstances** : systèmes sans `safeStorage` disponible.
- **Prochaines étapes** : exposer l'avertissement dans l'UI (via
  `SecretStore.isUsingOsKeychain()`) et, à terme, refuser le stockage plutôt que
  de dégrader silencieusement.

## KI-5 — Dépendances non auditées contre les vulnérabilités *(P3)*

- **Impact** : `npm audit` n'a pas pu être exécuté (accès registre non garanti).
  Des CVE transitives dans Playwright/Electron sont possibles.
- **Prochaines étapes** : lancer `npm audit` et `npm outdated` dans un
  environnement avec accès registre ; évaluer les mises à jour majeures
  séparément (compatibilité API Playwright/Electron).

## KI-6 — Blocage anti-bot Leboncoin (comportement normal, documenté) *(P3)*

- **Impact** : en cas de 403/CAPTCHA, le scraping s'arrête de façon préventive
  (`stoppedEarly`) et sauvegarde les données déjà acquises.
- **Circonstances** : surcharge, IP réputée mauvaise, captcha.
- **Prochaines étapes** : aucune correction agressive (respect des CGU) ; le
  comportement est volontaire.
