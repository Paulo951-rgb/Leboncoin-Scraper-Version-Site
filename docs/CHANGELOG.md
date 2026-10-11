# Changelog — Leboncoin Scraper Pro

Format inspiré de [Keep a Changelog](https://keepachangelog.com/). Les entrées
décrivent des modifications vérifiées (code + tests).

## [Non publié] — Extraction des données manquantes (vendeur, détail, fusion) — 2026-10-11

### Corrigé

- **Enrichissement sauté quand la recherche fournit une description** :
  `DescriptionEnricher.enrichAll` (`leboncoin-pipeline.js`) ne ciblait que
  `a.url && !a.description`. Or la réponse de recherche Leboncoin contient
  souvent déjà un `body` : dès qu'une annonce avait une description, sa page de
  détail n'était **jamais** visitée → les données présentes uniquement sur le
  détail (note vendeur, nombre d'avis, ancienneté, URL de profil, état, mode de
  remise) restaient `null`. La cible inclut désormais les annonces dont un champ
  de détail est manquant.
- **`parseHtmlDescription` ne remontait que la note** : la page de détail
  expose `owner.nb_ratings`, `owner.profile_url`, `owner.member_since`, etc.
  Seule `note` était extraite et recopiée → `nombreAvis`, `vendeurUrlProfil` et
  `vendeurAncienneteJours` étaient perdus même quand la donnée existait. Toutes
  les données vendeur du détail sont maintenant extraites et fusionnées via
  `applyDetailFields` (fonction pure, sans écrasement d'une valeur déjà remplie).
- **`deliveryType` périmé après fusion** : `mergeKeepingNonNull` fusionnait
  `livraison` et `mainPropre` de deux occurrences sans recalculer l'unifié
  (ex. `livraison=true` d'une liste + `mainPropre=true` d'un détail donnaient
  `deliveryType: 'main_propre'` au lieu de `les_deux`). `deliveryType` est
  désormais recalculé dès que l'un des deux booléens est présent.
- **Variantes de champs vendeur non couvertes** : `extractSeller` (`adFields.js`)
  ne cherchait que quelques noms. Ajout des variantes observées/historiques pour
  le nombre d'avis (`nb_reviews`, `reviews_count`, `total_ratings`,
  `feedback_count`, …), l'URL de profil (`web_url`, `shop_url`, `profile`,
  `href`, …), la date de création du compte (`creation_date`,
  `account_creation_date`, `inscription_date`, `since_date`, `created_at`) et le
  nom (`seller_name`, `store_name`).
- **Photos dupliquées** : `extractPhotos` conserve l'ordre mais déduplique les
  URL répétées (une même image ne gonfle plus `photosCount` ni la galerie).
  Aucune URL unique n'est tronquée.

## [Non publié] — Chasse aux bugs : 6 correctifs vérifiés — 2026-10-11

### Corrigé

- **Fuite de données vendeur (RGPD)** : `SELLER_FIELD_KEYS`
  (`exporting/exportFields.js`) ne contenait que les clés d'export
  (`vendeurNbAvis`, `vendeurAnciennete`). En profil **Maximum**,
  `filterAdByFields` parcourt les clés du **modèle** (`nombreAvis`,
  `vendeurAncienneteJours`) → ces deux champs vendeur fuitaient dans
  `annonces.json`/`annonces.txt` malgré « Données vendeur » désactivé. Les deux
  clés du modèle sont désormais exclues.
- **Perte de données à la fusion de doublons** : `mergeKeepingNonNull`
  (`leboncoin-pipeline.js`) ne considérait comme « vide » que `null`/`undefined`.
  Un tableau vide (`photosUrls: []`) d'une occurrence moins riche écrasait une
  liste de photos déjà extraite. Un tableau vide est maintenant traité comme une
  absence de données.
- **Widget flottant — statut sans couleur** : `widget.html` générait une classe
  `status-<état>` pour tout état non mappé (`status-capturing`, `status-processing`,
  `status-cancelled`) alors que le CSS ne définit que `status-idle/running/error/
  completed`. Le point de statut perdait sa couleur pendant la capture. Tous les
  états connus sont désormais mappés explicitement.
- **Rétention HAR à 0 détruisait tout** : `StorageCleaner.cleanOldHars(0)` fixait
  `maxAgeMs = 0` et supprimait **tous** les HAR (y compris ceux du jour), de façon
  incohérente avec `cleanOldJobs` (0 = désactivé). Un garde-fou aligne les deux.
- **`deliveryType` incohérent dans les Stats** : le repli rétro-compat d'
  `AdStats.analyze` renvoyait `inconnu` pour un booléen `false` face à `null`,
  alors que `computeDeliveryType` (et l'explorateur, la fiche annonce) renvoient
  `aucun`. Les mêmes données produisaient deux répartitions différentes.
- **Effet de bord à l'import du pipeline** : `leboncoin-pipeline.js` appelait
  `main()` au niveau module → un simple `require()` (tests, usage bibliothèque)
  lançait la CLI sans `.har` et sortait en code 1. `main()` est désormais gardé
  par `require.main === module` (fork/CLI inchangés).
- **Historique des annonces inversé** : `buildAdHistory` (`jobHistory.js`) triait
  les occurrences par comparaison **lexicographique** de la date affichée FR
  (`jj/mm/aaaa`). Résultat : `01/02/2026` classé AVANT `12/01/2026` → la
  « première découverte » et la « dernière maj » étaient inversées et les
  variations de prix/likes rapportées à l'envers (une baisse affichée comme une
  hausse). Tri désormais basé sur l'horodatage ISO de l'id de job (repli FR).
- **`deliveryType` incohérent (renderer)** : `statsModule.renderStatsView`
  utilisait le même repli erroné que `AdStats` (false+null → inconnu). Les deux
  replis sont alignés sur `computeDeliveryType` (false+null → aucun).

### Tests

- Nouvelle section `[39]` (20 assertions) ciblant chaque bug corrigé.
- `npm test` → 1283 réussis / 0 échoués.

## [Non publié] — Feuille de route : tests, UX, sécurité, perf — 2026-10-11

### Ajouté

- **Tests (Thème 3)** : fixtures HAR synthétiques (`test/fixtures/`) — résultats,
  doublons, 403, page vide, pages de détail avec/sans `__NEXT_DATA__` ; section
  `[36]` pipeline-sur-fixtures ; section `[37]` tests DOM réels via **jsdom** ;
  section `[38]` pour les modules main sous-couverts (settings, logger,
  fileManager, storageCleaner, jobHistory, ipcHandlers, rateLimiter, diagnostics,
  captureState). Couverture instrumentée par **c8** (`.c8rc.json`, seuil 70 %),
  script `npm run coverage`, gate CI dans `.github/workflows/build-windows.yml`.
- **UX (Thème 5)** : `showToast()` (notifications non bloquantes, `createElement`,
  sans injection HTML), `showScrapeError()` (bandeau persistant sur refus
  403/429 / erreur / succès partiel, avec bouton « Voir les logs »), `askConfirm()`
  (modal de confirmation maison remplaçant `window.confirm`). Les 11 `alert()`/
  `confirm()` natifs du renderer ont été retirés. Éléments `#toastContainer`,
  `#scrapeErrorBanner`, `#askModal` + styles dédiés.
- **Sécurité (Thème 6)** : `'unsafe-inline'` retiré de `script-src` (CSP). Les 17
  handlers inline (`onclick`/`onchange`) générés par `innerHTML` sont remplacés
  par des attributs `data-action`/`data-id`/`data-url` + un listener délégué
  unique (`installDelegatedActions`) → un XSS ne peut plus exécuter de script
  inline. IPC secrets : liste blanche de clés (`secret:get`), validation du nom
  de clé et du type de valeur. `main.js` refuse par défaut toutes les permissions
  navigateur.
- **Perf (Thème 7)** : compteur de logs visibles incrémental (`_visibleLogCount`)
  au lieu d'un `filter()` O(n) par log (O(n²) → O(n)) ; débounce des filtres
  texte de l'explorateur (180 ms) ; suppression d'un `items.indexOf()` O(n) dans
  `fetchBatchInPage` (mode séquentiel) ; helper `debounce(fn, wait)`.

### Tests

- `npm test` → 1265 réussis / 0 échoués. `npm run coverage` → exit 0
  (statements/lignes 70.45 %, branches 75.72 %, fonctions 87.5 %).

## [Non publié] — Diagnostic 403 : compteurs, backoff, harmonisation UA — 2026-10-10

### Diagnostiqué (preuves dans le code / l'historique)

- **Régression de débit (a861165)** : le commit « restore fast parallel scraping
  mode » a remonté la concurrence (10/15/25) et effondré les délais de base
  (500/200/50 ms). Comme `AdaptiveRateLimiter` utilise `baseDelayMs` comme
  délai **minimal de repli** (`minDelayMs = baseDelayMs`), le backoff maximal
  après blocage tombait à **250 ms** (ultra-rapide) au lieu de plusieurs
  secondes → aucune protection réelle contre les rafales de 403. Correctif :
  concurrence bornée (8/10/12) + délais de base 1500/1000/700 ms + plancher de
  backoff élevé (×16 dès le premier blocage).
- **Compteurs faux (contradiction « 236 extraites / 0 trouvée »)** :
  `ipcHandlers` cherchait `/(\d+)\s+annonce\(s\)\s+(?:unique|extrait)/`, mais le
  pipeline émet « `N annonces extraites` » (mot au singulier). Le motif ne
  matchait donc **jamais** → `adsFound` restait à 0. Correctif : motifs
  « annonces? extraites? », « N unique(s) en sortie », + ligne `[METRICS]`.

### Corrigé

- `leboncoin-pipeline.js` : presets de vitesse durcis (concurrence bornée,
  délais de base relevés) ; `Retry-After` appliqué comme **pause inter-batch**
  (`max(délai adaptatif, Retry-After)`), non bloquante pour les autres cibles ;
  métriques structurées `[METRICS]` (annonces extraites uniques, descriptions
  enrichies/absentes/bloquées/non traitées).
- `rateLimiter.js` : `waitAfter` accepte `noWait` (l'appelant gère l'attente) ;
  backoff agressif dès le premier blocage.
- `ipcHandlers.js` : compteurs d'annonces et de doublons corrigés (idempotents),
  résumé de session clarifié (« Annonces extraites (uniques) », « Blocages
  d'accès (HTTP 403/429) »).

### Étudié, non concluant (pas de modification)

- **Harmonisation UA capture↔enrichissement** : l'UA du capture (`captureUserAgent`)
  est déjà transmis au pipeline (`--user-agent` → `opts.userAgent`). Aucun bug UA
  trouvé.
- **Cookies de session** : le correctif d'empoisonnement (`0cc25bb`) est toujours
  présent (session globale sauvegardée après la 1re page réussie, jamais
  écrasée ; l'enrichisseur privilégie `global-session.json`). Aucune régression
  trouvée.
- La séquence « ~80 succès puis rafale de 403 » n'est pas causée par un changement
  de contexte (le contexte n'est recyclé qu'à 200 items) mais par une **limitation
  de débit** sous une cadence trop agressive — traitée par les correctifs ci-dessus.

## [Non publié] — Audit complet : accès réel, 403/429, états honnêtes — 2026-10-10

### Corrigé (bugs confirmés par lecture du code)

- **Fausse validation de session (critique)** — `harCapturer._warmupSession`
  déclarait le CAPTCHA « résolu » sur la seule disparition visuelle du défi
  (iframe/texte/URL) puis persistait la session et reprenait la capture, même
  quand le serveur répondait encore **HTTP 403**. Ajout de `_verifyAccess()` :
  requête document autorisée (HEAD puis GET), jugement sur le **statut HTTP réel**
  + validité du contenu. 403/429 ne sont plus jamais un succès.
- **Boucles de fenêtres CAPTCHA (élevée)** — la capture relançait une reprise
  pour chaque page bloquée sans vérifier l'accès réel → fenêtres en chaîne.
  Désormais la reprise n'a lieu QUE sur `verified === true` ; sinon arrêt propre.
- **HTTP 403/429 non distincts (élevée)** — la gestion les traitait de la même
  façon (« BLOCKED_403 »). Ajout de codes structurés `HTTP_ACCESS_REFUSED`
  (403), `HTTP_RATE_LIMITED` (429) et `ACCESS_UNVERIFIED`, du respect de
  l'en-tête **Retry-After**, et de codes de sortie pipeline `3` (403) / `4` (429).
- **Faux « succès » sur enrichissement bloqué (élevée)** — un 403/429 pendant
  l'enrichissement était rapporté « Scraping terminé avec succès ». Nouvel état
  `partial` (succès partiel) ; `annonces.json` partiel est préservé et signalé.
- **Capture bloquée présentée comme réussie (moyenne)** — la capture renvoie
  désormais un résultat structuré `{ pagesCaptured, blocked, blockedCode,
  httpStatus }` ; `ipcHandlers` n'entre PAS dans le pipeline si l'accès n'est pas
  confirmé (états `refused` / `rate_limited`).

### Ajouté

- Codes d'erreurs `HTTP_ACCESS_REFUSED`, `HTTP_RATE_LIMITED`, `ACCESS_UNVERIFIED`,
  `CAPTCHA_NOT_CONFIRMED` (`errorCodes.js`).
- Section de tests `[30]` (33 assertions) : vérification d'accès unitaire
  (`_verifyAccess` avec pages/dispatch simulés, sans navigateur), `_parseRetryAfter`,
  états honnêtes, codes de sortie, préservation des partiels. Tests pilotant
  CAPTCHA visible / 403 persistant / 429 + Retry-After / contenu bloqué en 200.

### Modifié

- `ipcHandlers` : états `partial` / `refused` / `rate_limited` ; conserve et
  signale les résultats partiels en cas d'échec d'enrichissement.
- `scraperModule.js` / `widget.html` : état `partial` (et `refused`/`rate_limited`)
  traité comme terminal (boutons réactivés, rafraîchissement des données).

## [Non publié] — Distribution Windows fiable & Releases GitHub — 2026-10-10

### Ajouté

- **Workflow CI/CD Windows** (`.github/workflows/build-windows.yml`) : build sur
  runner `windows-latest` (Node 20), déclenché sur `push` (main), `pull_request`,
  `workflow_dispatch` et tags `v*`. Il prépare le Chromium Windows, lance
  `npm run dist`, **vérifie l'installeur** (`tools/verify-dist.js`) puis publie
  un artefact GitHub Actions. Sur tag de version uniquement, un job `release`
  (`contents: write`) publie une **GitHub Release** avec les `.exe` et leurs
  `.sha256`. Aucun jeton en dépôt.
- **`tools/verify-dist.js`** : contrôle d'un dossier `dist/` (installeur NSIS,
  `win-unpacked/` + `app.asar` + `ffmpeg.dll`, Chromium embarqué, en-tête PE,
  taille minimale) ; écrit les empreintes `.sha256` ; échoue (code 1) si le build
  est incomplet. Garde-fou anti-« installeur tronqué » avant toute publication.
- Tests `[29]` : vérifient la présence/cohérence du workflow, des permissions et
  du vérificateur (face positive et négative).
- README : sections « Compilation automatique » et « Publier une version ».

### Modifié

- **NSIS durci** (`package.json`) : `perMachine:false` (installation **par
  utilisateur, sans droits administrateur**), `allowElevation:true`,
  `deleteAppDataOnUninstall:false`, `createStartMenuShortcut:true` (déjà
  présent). Cibles NSIS + portable x64 conservées.
- **`npmRebuild:false`** : aucun module natif dans le projet → évite un rebuild
  inutile (piste de fiabilité du build).

### Documenté

- Cause de `Error: spawn UNKNOWN` : `NsisTarget.computeScriptAndSignUninstaller`
  exécute l'installeur (très volumineux) pour extraire le désinstalleur
  (`execWine` en build croisé). La compilation native sur Windows (CI) l'évite.

## [Non publié] — Phase 3 (suite) : carte, ressources locales, packaging Windows — 2026-10-10

### Corrigé

- **Carte Stats détruite au moindre échec (P2)** : `renderMap` utilisait un
  retrait de marqueurs par `instanceof L.Marker` (fragile) et, en cas d'erreur,
  écrivait du HTML brut dans `#leafletMap`, ce qui détruisait le DOM interne de
  Leaflet et rendait la carte définitivement inutilisable. Les marqueurs sont
  désormais stockés dans un `L.layerGroup` dédié (`mapMarkerLayer`), nettoyé via
  `clearLayers()` ; la logique de calcul des points a été extraite en
  `computeMapPoints()` (pure, testable) avec déduplication par `id||url||title`,
  validation `isValidLatLng()` et messages d'état via `setMapStatus()`.
  (`renderer/statsModule.js`, `renderer/appState.js`, `renderer/index.html`,
  `renderer/styles.css`)

### Modifié

- **Bibliothèques cartographiques servies localement (P2, sécurité)** : Leaflet
  1.9.4 et Chart.js sont désormais embarqués dans `src/renderer/vendor/` au lieu
  d'être chargés depuis un CDN distant. La CSP est resserrée (`script-src 'self'`),
  supprimant toute dépendance réseau au chargement de l'UI et la surface d'attaque
  CDN. (`renderer/index.html`, `renderer/vendor/*`, docs de divulgation réseau)

### Distribution Windows

- **Chromium embarqué de la mauvaise plateforme (P1, packaging)** : le build
  croisé Linux → Windows embarquait le Chromium **Linux** (`chrome-linux`),
  inutilisable dans l'exe Windows. Ajout de `tools/prepare-browsers.js` qui
  télécharge le Chromium de la **plateforme cible** (`--platform=win` →
  `chromium-win64.zip`) dans `node_modules/playwright-core/.local-browsers/`.
  Scripts `browsers`, `browsers:win`, et hooks `prepack`/`predist`/`prebuild`.
- **Icône d'application (P2)** : `build/icon.ico` multi-résolutions (16→256) et
  `build/icon.png` générés par `tools/generate-icon.py` (`npm run icon`).
- Installeur NSIS + version portable produits et vérifiés (en-tête PE, version
  string/icône embarquées, Chromium Windows présent dans `resources/browsers/`).

### Documentation

- `README.md` : section build réécrite (build croisé Wine + Xvfb, plateforme du
  Chromium, Windows x64 uniquement), scripts npm complétés, section intégrité
  (SHA-256), clarification de la version portable.
- `AGENTS.md` : sections Commandes / Build / Tools / Build croisé.

### Tests

- Suite : 955 → **984** assertions réussies.
- Ajout de la section `[28]` : distribution Windows (icône multi-résolutions,
  configuration electron-builder, scripts npm, `prepare-browsers` par plateforme,
  chemin `PLAYWRIGHT_BROWSERS_PATH`).

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
- **Badge « Personnalisé » jamais affiché (P2)** : `historyModule` testait
  `exportMeta.exportMode === 'custom'`, mais le pipeline écrit `export-meta.json`
  avec `profileId` (version 2). Le badge était donc toujours absent. Le renderer
  lit désormais `profileId` (repli `exportMode`) et `jobHistory` normalise
  `exportMode → profileId` pour les anciens jobs. (`renderer/historyModule.js`,
  `services/jobs/jobHistory.js`)

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
- `docs/DATA_HANDLING.md` + FAQ (`helpModule.js`) : affirmation réseau corrigée.
  La déclaration « seules connexions : leboncoin.fr + géocodage » omettait les
  CDN d'interface (Chart.js via jsdelivr, Leaflet via unpkg) et les tuiles
  OpenStreetMap. Reformulé honnêtement (aucune donnée scrapée transmise).

### Tests

- Suite : 861 → **901** assertions réussies.
- Ajouts : blocs `[20]` (navigation, fuites d'export, DOM, error codes), `[21]`
  (UI/robustesse), `[22]` (validation des paramètres), `[23]` (parité des champs
  exportables renderer ↔ main) et `[24]` (contrat `export-meta`). Trois assertions
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
