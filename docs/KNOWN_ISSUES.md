# Problèmes connus — Leboncoin Scraper Pro

*Mis à jour : 2026-10-10*

Cette liste ne contient que des problèmes **non résolus** au terme de l'audit de
stabilisation. Pour chaque entrée : impact, circonstances, prochaines étapes.

---

## KI-1 — Démarrage de l'exe Windows non testé sur Windows réel *(P2, environnement)*

- **Impact réduit** : le build croisé Linux → Windows produit désormais bien
  l'installeur NSIS **et** la version portable, avec le Chromium **Windows**
  embarqué (`resources/browsers/chromium-1097/chrome-win/chrome.exe`). Les
  artefacts ont été vérifiés statiquement (en-tête PE `MZ`, chaînes de version
  `ProductName`/`FileDescription` présentes, icône embarquée, présence du
  Chromium Windows). En revanche, **le lancement effectif sous Windows** n'a pas
  pu être testé ici (environnement Linux) : démarrage de l'installeur, exécution
  de l'app et scraping réel restent à valider sur une machine Windows.
- **Circonstances** : uniquement lors de la distribution.
- **Prochaines étapes** : sur Windows, exécuter l'installeur, lancer l'app,
  vérifier le démarrage hors ligne et un job de scraping complet.

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

## KI-7 — ~~Icône de build manquante~~ *(RÉSOLU, packaging)*

- **Résolu** : `build/icon.ico` (multi-résolutions 16→256) et `build/icon.png`
  sont désormais présents et générables via `npm run icon`
  (`tools/generate-icon.py`, Pillow). La cible portable et l'installeur NSIS
  utilisent bien l'icône dédiée (vérifié dans l'exe : groupe d'icônes présent).
- Conservé ici pour mémoire : ne pas réintroduire un `icon` pointant vers un
  fichier absent.

## KI-6 — Blocage anti-bot Leboncoin (comportement normal, documenté) *(P3)*

- **Impact** : en cas de 403/CAPTCHA, le scraping s'arrête de façon préventive
  (`stoppedEarly`) et sauvegarde les données déjà acquises.
- **Circonstances** : surcharge, IP réputée mauvaise, captcha.
- **Prochaines étapes** : aucune correction agressive (respect des CGU) ; le
  comportement est volontaire.
