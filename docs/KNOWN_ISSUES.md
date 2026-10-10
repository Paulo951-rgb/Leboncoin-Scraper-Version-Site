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
- **Constat aggravant (phase 3)** : plusieurs bugs UI réels et silencieux ont été
  découverts uniquement par relecture — **navigation par onglets totalement
  morte** (sélecteur `.tab-btn` obsolète), éléments DOM absents
  (`statMedPrice`, `structureWarning`), `applySellerDataVisibility` jamais
  appelée, bandeau structure jamais masqué, graphiques fantômes. Aucun n'aurait
  été attrapé par la suite actuelle. Ils sont corrigés, mais le manque de tests
  UI reste une source de risque de régression.
- **Circonstances** : toute modification des modules `src/renderer/`.
- **Prochaines étapes** : ajouter un harnais DOM léger (jsdom) *si* le bénéfice
  est avéré ; sinon maintenir une checklist manuelle (démarrage de job, arrêt,
  suppression de job, changement de thème, mode hors-ligne, navigation entre
  tous les onglets).
- **Mitigation partielle (phase 3)** : un test statique `[25]` vérifie que tous
  les `getElementById('X')` littéraux des modules renderer ciblent un `id`
  présent dans `index.html`, et que chaque `[data-tab="X"]` pointe vers un
  `.tab-content` d'id `X` existant. Cela couvre la classe exacte des bugs P3-1
  (navigation morte) et P3-5 (éléments DOM absents) sans exécuter de DOM.

## KI-3 — `urlSecurity` : couverture DNS incomplète sur le chemin navigateur *(P2, sécurité)*

- **Statut : partiellement résolu (phase 2).** `isSafeFetchDestination` (synchrone,
  fail-closed) est désormais **câblé** sur le chemin Playwright :
  - `HarCapturer.capture()` refuse une URL de recherche hors domaines Leboncoin
    ou visant une IP interdite (allowlist `LEBONCOIN_SOURCE_HOSTS`) ;
  - `_installNetworkGuard` intercepte toutes les sous-requêtes (`ctx.route('**/*')`)
    et bloque IP privées/locales et schémas exotiques ;
  - `validateRemoteUrl` est fail-closed si la résolution DNS est vide.
- **Limite résiduelle** : le filtre synchroné ne fait **pas** de résolution DNS
  (impossible dans le callback `route` sans blocage). Un hostname arbitraire
  résolvant vers une IP privée (DNS rebinding) n'est pas détecté sur les
  sous-ressources. Documenté dans le code.
- **Prochaines étapes** : envisager un proxy applicatif ou une résolution DNS
  asynchrone préalable si le risque rebinding devient pertinent.

## KI-4 — Repli de chiffrement des secrets à protection réduite *(P3, sécurité)*

- **Impact** : si le trousseau OS est indisponible, les secrets sont chiffrés
  avec une clé dérivée d'informations machine publiques. Cela évite le clair sur
  disque mais ne protège pas contre un accès au système de fichiers.
- **Circonstances** : systèmes sans `safeStorage` disponible.
- **Prochaines étapes** : exposer l'avertissement dans l'UI (via
  `SecretStore.isUsingOsKeychain()`) et, à terme, refuser le stockage plutôt que
  de dégrader silencieusement.

## KI-5 — Dépendances vulnérables non corrigeables sans majeur *(P2)*

- **Impact** : `npm audit` (phase 2) → **15 vulnérabilités** (4 modérées, 10
  élevées, 1 critique) après les correctifs en plage. Détail :
  - `tar` (critique, transitive electron-builder) → nécessite electron-builder@26 ;
  - `playwright` (élevée, **directe**) → nécessite playwright@1.64 (chemin
    Chromium/`extraResources` à revalider) ; CVE « téléchargement sans vérif TLS »
    **hors** du chemin runtime ;
  - `electron` + `@electron/get`/`global-agent`/`roarr`/`sprintf-js` → nécessitent
    electron@44 (majeur) ;
  - `electron-builder` et ses sous-paquets → outils de **build** (non embarqués
    dans le binaire final), mise à jour majeure.
- **Corrigé en phase 2** (en plage) : `brace-expansion`, `http-cache-semantics`.
- **Prochaines étapes** : planifier un lot « dépendances » avec majeur Playwright
  + Electron + electron-builder, et une campagne de packaging/capture après.

## KI-7 — Icône de build manquante *(P2, packaging)*

- **Impact** : `build/icon.ico` est référencé par `package.json` mais **absent**
  du dépôt. La cible **portable** d'electron-builder échoue (« icon.ico not
  found ») ; la cible NSIS utilise l'icône par défaut d'Electron.
- **Circonstances** : `npm run dist` / `npm run pack`.
- **Prochaines étapes** : fournir `build/icon.ico` (≥ 256×256, multi-résolutions)
  ou retirer `icon`/`installerIcon`/`uninstallerIcon` de la config pour accepter
  l'icône par défaut. Non corrigé ici car aucune ressource graphique n'est
  disponible dans l'environnement.

## KI-6 — Blocage anti-bot Leboncoin (comportement normal, documenté) *(P3)*

- **Impact** : en cas de 403/CAPTCHA, le scraping s'arrête de façon préventive
  (`stoppedEarly`) et sauvegarde les données déjà acquises.
- **Circonstances** : surcharge, IP réputée mauvaise, captcha.
- **Prochaines étapes** : aucune correction agressive (respect des CGU) ; le
  comportement est volontaire.
