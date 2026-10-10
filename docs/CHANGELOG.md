# Changelog — Leboncoin Scraper Pro

Format inspiré de [Keep a Changelog](https://keepachangelog.com/). Les entrées
décrivent des modifications vérifiées (code + tests).

## [Non publié] — Phase 3 : audit global A→Z (UI, intégrité, robustesse) — 2026-10-10

### Corrigé

- **Navigation par onglets totalement morte (P1)** : `app.js` attachait ses
  écouteurs sur `.tab-btn`, classe qui n'existe plus depuis la refonte de la
  sidebar (`.nav-item`). Résultat : **aucun** écouteur de navigation n'était
  posé et cliquer un onglet (Logs, Historique, Explorateur, Stats) ne faisait
  rien. Sélecteur remplacé par `[data-tab]`. (`renderer/app.js`)
- **Fuite de champs internes dans les exports (P1)** : en profil Maximum,
  `filterAdByFields` renvoie l'objet tel quel, exposant `raw` (objet brut
  Leboncoin complet, plusieurs Ko par annonce) et `extractionErrors`. Les
  champs internes `raw`, `extractionErrors`, `livraison` et `mainPropre` sont
  désormais retirés avant toute écriture (`annonces.json` + `annonces.txt`).
  (`services/scraping/leboncoin-pipeline.js`)
- **`ErrorCodes.UNKNOWN` manquant (P2)** : référencé par `pipelineRunner` pour
  le repli de code de sortie non classé, il était `undefined` → logs `[undefined]`.
  Ajouté à `errorCodes.js`. (`services/scraping/errorCodes.js`)
- **Éléments DOM absents (P2)** : `#statMedPrice` (carte « Prix Médian ») et le
  bandeau `#structureWarning`/`#structureWarningText` étaient référencés par le
  JS mais absents de `index.html` → la médiane n'était jamais affichée et
  l'alerte de changement de structure restait inopérante. Ajoutés.
  (`renderer/index.html`)
- **Visibilité des données vendeur jamais appliquée (P2)** : `applySellerDataVisibility()`
  n'était jamais appelée → la classe `body.seller-data-hidden` (qui masque la
  colonne Vendeur) n'était jamais posée. Elle est désormais appliquée au
  chargement et à chaque changement de paramètre. (`renderer/app.js`)
- **Bandeau d'alerte structure jamais masqué (P2)** : une fois affiché, il
  restait visible indéfiniment (y compris sur des runs OK suivants). Il est
  réarmé au démarrage de chaque run. (`renderer/scraperModule.js`)
- **Graphiques fantômes (P2)** : changer de session pour une session sans
  annonces laissait à l'écran les graphiques de la session précédente
  (`renderCharts` faisait un `return` sans détruire les instances). Les
  instances sont désormais détruites quand il n'y a pas de données.
  (`renderer/statsModule.js`)
- **Sélection de session fantôme (P2)** : après suppression du job sélectionné,
  le `<select>` conservait une valeur inexistante → explorateur/stats affichaient
  une vue vide jusqu'à reselection manuelle. Repli sur `ALL`.
  (`renderer/explorerModule.js`)
- **Pagination sans limite (P2)** : `maxPages: parseInt(pages, 10)` pouvait
  valoir `NaN`/`0` (champ vide ou 0), interprété comme « pas de limite ».
  Bornage `[1, 500]`. (`core/ipcHandlers.js`)
- **Historique d'annonces (P3)** : la détection de variation des likes lisait
  des chemins inexistants (`statistiques.likes`/`likes_count`) ; lecture du
  champ réel `likes` avec repli rétro-compat pour les anciens jobs.
  (`services/jobs/jobHistory.js`)

### Sécurité

- **Validation des paramètres (P1)** : `config:save` fusionnait **n'importe
  quel** objet fourni par le renderer dans `user-settings.json` (injection de
  clés arbitraires ; `autoCleanJobsDays` pouvait être poussé à une valeur
  énorme déclenchant une purge massive de jobs au démarrage suivant).
  `saveSettings` filtre désormais les clés connues avec type/plage validés
  (`sanitizeSettingsPatch`). (`core/settings.js`)
- **`webviewTag` désactivé (P2)** : aucun `<webview>` n'est utilisé par l'UI
  (le module IA Studio, seul consommateur, a été retiré). Le handler
  `will-attach-webview` reste en défense en profondeur. (`main.js`)

### Documentation

- `docs/CHANGELOG.md` : présente entrée (Phase 3).
- `docs/AUDIT_REPORT.md`, `docs/STABILITY_PLAN.md`, `docs/KNOWN_ISSUES.md`
  actualisés.

### Tests

- Suite : 861 → **894** assertions réussies.
- Ajouts : blocs `[20]` (navigation, fuites d'export, DOM, error codes), `[21]`
  (UI/robustesse) et `[22]` (validation des paramètres). Trois assertions
  obsolètes corrigées : elles exigeaient la présence de `livraison`/`mainPropre`
  dans les exports et l'**absence** de `structureWarning`, ce qui contredisait
  le modèle documenté et cassait l'UI.

## [Non publié] — Phase 2 : sécurisation réseau, annulation, dépendances — 2026-10-10

### Corrigé

- **Annulation pendant l'enrichissement (P1)** : `ipcHandlers` ignore
  désormais la valeur de retour du runner ; un code `130` (SIGINT) est traité
  comme une **annulation** et non comme un succès. Le pipeline installe un
  handler `SIGINT` coopératif : sortie de boucle propre, écriture des résultats
  partiels, fermeture du navigateur, handler retiré en `finally`.
  (`core/ipcHandlers.js`, `services/scraping/leboncoin-pipeline.js`)
- **Suffixe trompeur d'allowlist** : `isHostAllowed` traite une entrée de domaine
  comme domaine **inclusif** (exact + sous-domaines) et rejette
  `leboncoin.fr.attacker.com`. (`utils/urlSecurity.js`)
- **IPv6 littérales dans `validateRemoteUrl`/`isSafeFetchDestination`** : les
  crochets de `URL.hostname` sont retirés avant `net.isIP`, sinon `[::1]`,
  `[fe80::1]` et les IPv4-mappées passaient le contrôle. (`utils/urlSecurity.js`)

### Sécurité

- **Chemin Playwright sécurisé (KI-3)** :
  - nouvelle `isSafeFetchDestination(url, allowlist?)` **synchrone** et
    fail-closed (protocole http(s), IP privées/loopback/link-local IPv4 et IPv6,
    hostnames locaux, allowlist) ;
  - `HarCapturer.capture()` refuse une URL de recherche hors domaines Leboncoin
    (`LEBONCOIN_SOURCE_HOSTS`) ou visant une IP interdite, **avant** de lancer
    Chromium ;
  - `_installNetworkGuard` intercepte toutes les sous-requêtes Playwright
    (`ctx.route('**/*')`) et bloque les destinations dangereuses (défense en
    profondeur) ;
  - `validateRemoteUrl` est **fail-closed** si la résolution DNS est vide/échouée.

### Dépendances

- Lockfile : `brace-expansion` (DoS récursif) et `http-cache-semantics` (fuite de
  cache inter-utilisateur) mis à jour dans la plage de compatibilité →
  17 → 15 vulnérabilités `npm audit`.
- Mises à jour **majeures** (Electron, Playwright, electron-builder) **non
  appliquées** : à planifier avec validation packaging/capture. Documentées dans
  `docs/KNOWN_ISSUES.md` (KI-5).

### Tests

- Suite : 813 → **861** assertions réussies.
- Ajouts : `isSafeFetchDestination` (autorisés/interdits/IPv6/suffixe trompeur),
  `validateRemoteUrl` fail-closed, câblage `harCapturer`, scénarios d'erreur du
  pipeline (HAR absent/invalide/données invalides), intégration `PipelineRunner`
  (annulation → 130, HAR absent → rejet), préservation des résultats partiels,
  câblage annulation enrichissement, cas limites de la médiane.

### Documentation

- Ajout de `docs/PHASE2_REPORT.md`.
- `docs/KNOWN_ISSUES.md` : KI-3 (statut, limite), KI-5 (dépendances), KI-7
  (icône de build manquante).

## [Non publié] — Audit de stabilisation 2026-10-10

### Corrigé

- **Annulation (P1)** : un clic « Arrêter » n'aboutit plus à
  « Scraping terminé avec succès ! ». L'état `cancelled` est désormais distinct
  d'un succès et d'une erreur ; le pipeline d'enrichissement n'est plus lancé si
  l'arrêt intervient pendant la capture HAR.
  (`core/ipcHandlers.js`, `renderer/scraperModule.js`)
- **Export personnalisé (P2)** : les champs `ville`, `codePostal`,
  `vendeurNbAvis`, `vendeurAnciennete` ne sont plus silencieusement perdus dans
  les exports JSON/TXT des profils Défaut et Personnalisé (traduction des clés
  d'export vers les clés du modèle `normalizeAd`).
  (`services/exporting/exportFields.js`)
- **Statistiques (P2)** : la médiane des prix est correcte pour un nombre pair
  d'annonces (moyenne des deux valeurs centrales). Ajout du champ `medianPrice`.
  (`services/analysis/adStats.js`)
- **Pipeline (P2)** : contrats de sortie clarifiés — `0` succès, `1` erreur
  CLI/init, `2` aucune donnée exploitable. Le runner ne confond plus un run vide
  avec un succès. (`services/scraping/leboncoin-pipeline.js`,
  `services/scraping/pipelineRunner.js`)
- **Runner** : sur erreur de spawn, la référence au processus fils est libérée
  et rejetée avec un code d'erreur structuré. (`pipelineRunner.js`)
- **Interface (P3)** : la colonne « Vendeur » est réellement masquée lorsque les
  données vendeur sont désactivées (classes `col-vendeur`/`cell-vendeur`).
- **Interface (P3)** : le filtre « État » de l'explorateur lit le bon champ
  (`a.etat`) au lieu d'un `a.produit.etat` inexistant.
- **Interface (P3)** : le listener du bouton « Dossier output/ » utilise la
  constante déjà résolue au lieu d'un `getElementById` redondant.

### Sécurité

- **Navigation Electron** : navigation et `window.open` refusés pour le widget
  et la fenêtre principale hors origine interne. (`main.js`)
- **SSRF** : `urlSecurity.js` détecte désormais les IPv6 loopback (`::1`),
  unspecified (`::`), ULA (`fc00::/7`), link-local (`fe80::/10`) et les
  IPv4-mappées (`::ffff:127.0.0.1`). Nouvelles fonctions `isPrivateIPv6` et
  `isBlockedIpLiteral`. Limite documentée : `validateRemoteUrl` n'est pas sur le
  chemin Playwright ; l'allowlist `ALLOWED_FETCH_HOSTS` protège les `fetch` du
  pipeline.
- **Secrets** : politique explicite à deux niveaux dans `secretStore.js`.
  `safeStorage` (trousseau OS) est préféré ; le repli AES-256-GCM (clé dérivée
  d'informations machine publiques) émet un avertissement unique indiquant une
  protection réduite. `isUsingOsKeychain()` exposé pour l'UI.

### Supprimé

- `src/main/infrastructure/notifications.js` — module mort, jamais importé.
- Import `Notifier` dans `core/ipcHandlers.js`.
- Import `FIELD_CATEGORIES` inutilisé dans `services/exporting/dataProfiles.js`.

### Documentation

- `README.md` : suppression des mentions « notifications système », du nombre
  figé d'assertions, et reformulation de la cible « Windows x64 » (le build
  NSIS/portable est bien Windows uniquement).
- `AGENTS.md`, `docs/ARCHITECTURE.md` : alignement sur les tests et le code
  actuels.
- Ajout de `docs/AUDIT_REPORT.md`, `docs/STABILITY_PLAN.md`, `docs/CHANGELOG.md`,
  `docs/KNOWN_ISSUES.md`.

### Tests

- Suite : 777 → **813** assertions réussies.
- Ajouts : invariants d'annulation, exit codes du pipeline, export Défaut réel
  (fork), médiane AdStats, `urlSecurity` IPv4/IPv6, absence d'imports morts.
