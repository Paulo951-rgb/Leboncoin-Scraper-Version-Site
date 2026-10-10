# AGENTS.md — Leboncoin Scraper Pro

Repository knowledge for AI agents working on this codebase.

## Stack
- Electron 28 (main + renderer, contextIsolation + sandbox)
- Node.js main process, Playwright 1.41 (Chromium) pour le scraping
- electron-builder 24 pour la génération du `.exe` (NSIS + portable)
- **Aucune IA** : pas d'Ollama, pas de LLM, pas de vision, pas de cloud. L'app est 100% locale.
- **Aucune dépendance Excel** : pas d'ExcelJS, pas d'export XLSX/CSV. Seuls JSON et TXT sont générés.

## Architecture SCRAPING → EXPORTS
```
SCRAPER (harCapturer + pipeline) → DONNÉES SCRAPÉES → EXPORTS (JSON/TXT)
```

Le scraping fonctionne **100% sans IA**. Il n'y a aucun système d'IA dans le projet. Toutes les opérations sont déterministes : extraction, normalisation, calcul du `deliveryType`, statistiques, exports.

`adFields.js` est un module de **scraping pur** : aucun appel IA, aucun prompt, aucun LLM, aucun fetch externe.

## Champ `deliveryType` (unifié)

L'ancienne paire de champs `livraison` / `mainPropre` a été remplacée par un **champ unique** `deliveryType` calculé par `computeDeliveryType(livraison, mainPropre)` dans `adFields.js` :

| Valeur | Condition |
|---|---|
| `les_deux` | `livraison === true && mainPropre === true` |
| `livraison` | `livraison === true && (mainPropre === false \|\| mainPropre === null)` |
| `main_propre` | `(livraison === false \|\| livraison === null) && mainPropre === true` |
| `aucun` | `livraison === false && mainPropre === false` (ou l'un false et l'autre null) |
| `inconnu` | `livraison === null && mainPropre === null` |

Les deux booléens internes (`livraison`, `mainPropre`) sont toujours extraits séparément par `extractTransaction(raw)` puis unifiés en `deliveryType`. Les anciens champs `livraison` et `mainPropre` ne sont plus exposés dans le modèle de données final — seul `deliveryType` figure dans `annonces.json`.

## Profils de données (3 profils)

`src/main/services/exporting/dataProfiles.js` définit 3 profils :

| Profil | ID | Description | Champs |
|---|---|---|---|
| **Défaut** | `default` | Scraping rapide et léger | 13 champs essentiels (DEFAULT_PROFILE_FIELDS) |
| **Maximum** | `maximum` | Toutes les données disponibles | ALL_FIELD_KEYS (~23 champs) |
| **Personnalisé** | `custom` | Choix de l'utilisateur | Stocké en localStorage côté renderer, transmis au main process |

`getProfileFields(profileId, customFields)` renvoie la liste des clés à conserver. En mode Personnalisé, les clés sont filtrées contre `ALL_FIELD_KEYS` (validation côté main process).

## Codes d'erreurs structurés

`src/main/services/scraping/errorCodes.js` définit un système de codes d'erreurs préfixés par domaine :

- `NET_*` — erreurs réseau (timeout, DNS, connexion)
- `HTTP_*` — erreurs HTTP (403, 429, 404, 500, inconnu)
- `CAPTCHA_*` — captcha (détecté, timeout, non résolu)
- `PARSE_*` — parsing (HAR invalide, JSON invalide, aucune annonce)
- `EXTRACTOR_*` — extracteurs (vendeur, prix, description, localisation, dates, photos)
- `SESSION_*` — session (expirée, invalide)
- `BROWSER_*` — navigateur (crash, fermé, échec lancement)
- `STRUCTURE_*` — structure (changée, champ manquant)
- `AD_*` — annonce (supprimée, modifiée, vide)

`createError(code, message, context)` crée un objet d'erreur structuré `{ code, message, context, timestamp }`.

`classifyError(code)` catégorise l'erreur pour déterminer l'action : `recoverable`, `ad_error`, `network_error`, `session_error`, `global_error`, `unknown`.

## Champs d'annonce (schéma scraping pur)

Structure produite par `normalizeAd()` (sans aucune dépendance IA) :

| Section | Champs | Notes |
|---------|--------|-------|
| GÉNÉRAL | id, title, url, category | |
| PRIX | prix (nombre) | `prix` est un nombre, PAS un objet |
| LOCALISATION | city, zipcode | |
| TRANSACTION | deliveryType | Champ unifié (les_deux / livraison / main_propre / aucun / inconnu) |
| VENDEUR | vendeurNom, vendeurType, vendeurId, vendeurNote, nombreAvis, vendeurUrlProfil, vendeurAncienneteJours | note=null si pas dispo |
| STATS | likes | 0 ≠ null |
| DATES | datePublication, dateModification, dateScraping | scraping=ISO au moment de l'extraction |
| PRODUIT | etat | État déclaré UNIQUEMENT (extrait des attributs structurés) |
| PHOTOS | photosCount, photosUrls | |
| DESCRIPTION | description | Toujours une string (jamais un objet) |

**Convention** : tout champ non trouvé est `null` (jamais `0`, jamais `''`, jamais une valeur inventée).

**Champs SUPPRIMÉS (ne doivent plus apparaître nulle part)** : `livraison`, `mainPropre` (remplacés par `deliveryType`), `negociable`, `facture`, `garantie`, `echangeAccepte`, `urgent`, `vues`, `marque`, `modele`, `couleur`, `taille`, `capacite`, `annee`, `matiere`, `reference`, `etatDetecte`, `etatInferre`, `detection{}`, `prix.valeur` (remplacé par prix simple), `prix.devise` séparé, `prix.original`, `prix.negociable`, `adAnalysis` (IA supprimée), `marketAnalysis` (IA supprimée), `vision` (IA supprimée).

## Architecture (src/main/)
```
main.js                      cycle de vie Electron, fenêtres, single-instance lock, webview lock
preload.js                   pont sécurisé Main ↔ Renderer (contextBridge)
widgetPreload.js             preload dédié au widget flottant
core/ipcHandlers.js          TOUS les handlers IPC (job, fichiers, secrets, config)
core/settings.js             persistance user-settings.json
config/constants.js          BASE_OUT_DIR, JOBS_DIR, GLOBAL_SESSION_PATH, THEMES (require electron/app)
services/scraping/           harCapturer (Playwright) + pipelineRunner (fork) + leboncoin-pipeline
                             + adFields.js (extracteurs centralisés — SCRAPING PUR)
                             + errorCodes.js (codes d'erreurs structurés)
                             + userAgents.js (10 UA réalistes)
services/exporting/          exportFields.js (champs exportables + filtrage + TXT lisible)
                             dataProfiles.js (3 profils : Défaut/Maximum/Personnalisé)
services/analysis/adStats.js statistiques de prix brutes (sans scoring)
services/jobs/jobHistory.js  listing/lecture/suppression jobs, buildAdHistory
services/maintenance/storageCleaner
infrastructure/              fileManager (ouverture fichiers/dossiers)
utils/                       helpers, diagnostics, integrity, rateLimiter, logger, secretStore, urlSecurity
```

## Architecture (src/renderer/)
```
index.html                   UI (sidebar, onglets, modales)
widget.html                  widget flottant
app.js                       orchestration, sidebar, routage
appState.js                  état global du renderer
utils.js                     escapeHtml, escapePath, formatage
scraperModule.js             onglet Scraper (URL, pages, profil, vitesse, presets)
logsModule.js                onglet Logs (console temps réel, filtrage)
historyModule.js            onglet Historique (jobs, ouverture, suppression)
explorerModule.js           onglet Explorateur (table, grille, filtres, tri, fiche)
statsModule.js              onglet Stats (cartes, graphiques, carte Leaflet)
helpModule.js               module d'aide (FAQ, guide, feedback)
styles.css                   habillage + 13 thèmes + stat-cards
```

> **Note** : l'ancien répertoire `services/ai/` (adAnalyzer, marketValueAnalyzer, promptGenerator, promptTemplates, aiCache, ollamaHealth, providers/, search/) a été **entièrement supprimé**. L'ancien module `aiStudioModule.js` (renderer) a été supprimé. L'ancien `excelExporter.js` (infrastructure) a été supprimé.

## Conventions clés
- Les handlers IPC sont enregistrés UNE SEULE FOIS (dans app.whenReady) via
  `setupIpcHandlers(getMainWindow)`. Le getter `getMainWindow()` renvoie null si
  la fenêtre est détruite — ne JAMAIS capturer `mainWindow` par closure.
- `sendLog/sendProgress/sendStatus` (ipcHandlers) utilisent `getWin()` qui garde
  contre les fenêtres détruites. Ne pas remettre d'appels directs `mainWindow.webContents.send`.
- **Onglet Logs (renderer)** : buffer mémoire `_logBuffer` (MAX 3000) + filtrage
  rétroactif par mode (normal=info/warn/error, debug=tout). Auto-scroll ON par
  défaut. `sendSessionSummary()` en fin de job envoie un résumé formaté.
- Écriture JSON avec intégrité : `writeWithChecksum(path, data, replacer, space)`
  (src/main/utils/integrity.js). NE PAS utiliser `fs.writeFileSync` pour les
  fichiers d'annonces — cela casse la validation SHA-256.
- Fetch natif Node.js : PAS d'option `timeout`. Utiliser AbortController + setTimeout
  pour tous les fetch (sinon requête bloquée indéfiniment).
- `constants.js` et `logger.js` et `secretStore.js` require('electron') au
  top-level → NE JAMAIS les require depuis le pipeline sous-processus (fork), qui
  n'a pas accès à `app`.

## Tests
- `node test/regression.test.js` → suite de non-régression (syntaxe + stubs Electron).
- Le test stub `electron` : BrowserWindow a `webContents.send` mais PAS `isDestroyed`.
- Avant tout commit : `node --check` sur les fichiers modifiés + lancer la suite.

## Sécurité (en place)
- Renderer sandboxé (sandbox:true, contextIsolation:true, nodeIntegration:false)
- `shell:openExternal` filtré (http/https uniquement) — `urlSecurity.js`
- `file:openFolder/openFile` validés contre BASE_OUT_DIR (anti path-traversal)
- Clés API via `safeStorage` (secretStore.js), pas en clair
- **XSS attribut HTML** : `escapePath()` échappe `"` → `&quot;` et `&` → `&amp;`
  en plus de `\` et `'`. Les données scrapées (URLs, images, a.id) injectées dans
  des attributs HTML (`src=`, `onclick=`) sont échappées via `escapeHtml()` (src)
  ou `escapePath()` (onclick double-contexte HTML+JS).
- **Hardening webview** : handler `will-attach-webview` sur `web-contents-created`
  — verrouille `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`,
  supprime tout preload injecté, isole la session.
- **Single-instance lock** : empêche plusieurs instances concurrentes.
- **Intégrité des données** : checksum SHA-256, écriture atomique (`.tmp` + `rename`).

## Commandes
- Lancer l'app : `npm start` (electron --max-old-space-size=8192 .)
- Tests : `npm test` (ou `node test/regression.test.js`)
- Build .exe : `npm run dist` (electron-builder --win) → NSIS + portable dans `dist/`
- Packaging local : `npm run pack` (electron-builder --dir)

## Build (electron-builder)
Configuration dans `package.json` → clé `build` :
- **Cible** : Windows x64 (NSIS + portable).
- **Chromium embarqué** : `extraResources` copie `node_modules/playwright-core/.local-browsers` dans `browsers/`.
- **Fichiers inclus** : `src/**/*`, `package.json`, `node_modules/playwright*/**/*`.
- **Icône** : `build/icon.ico`.
- **NSIS** : `oneClick: false`, `allowToChangeInstallationDirectory: true`, raccourcis bureau + menu démarrer.
- **Portable** : `Leboncoin-Scraper-Pro-Portable-${version}.exe`.
- Au runtime, `main.js` pointe `PLAYWRIGHT_BROWSERS_PATH` vers `process.resourcesPath/browsers` si l'app est packagée.

## Pièges corrigés (à ne PAS réintroduire)
- **AdStats médiane** : pour un nombre pair de prix, moyenne des deux valeurs
  centrales (le renderer fait pareil dans renderStatsView). Ne pas reprendre
  `validPrices[Math.floor(n/2)]` qui est faux pour les longueurs paires.
- **CAPTCHA détection** : le statut HTTP de la navigation initiale (`vStatus`)
  ne doit JAMAIS être utilisé pour le polling de résolution — il reste figé à
  403 même après résolution. Utiliser `_checkCaptcha(page)` (content-based) +
  `latestHttpStatus` (response listener dynamique) + confirmation 2s anti-faux-positif.
- **Pipeline exit code** : une erreur CLI/init doit faire sortir le pipeline en
  code `1` ; « aucune donnée exploitable » (HAR vide, 0 annonce) en code `2` ;
  succès en code `0`. Sinon le PipelineRunner voit 0 et croit que le pipeline a
  réussi, ou confond un run vide avec un crash.
- **Annulation ≠ succès** : `activeCancel.cancelled` doit être LU après la
  capture HAR. Si l'utilisateur a demandé l'arrêt, NE PAS lancer le pipeline
  d'enrichissement et émettre `sendStatus({ state: 'cancelled' })` (état dédié,
  distinct de `completed` et `error`). Le renderer traite `cancelled` comme
  terminal. Sans cela, « Arrêter » affichait « terminé avec succès ».
- **Annulation PENDANT l'enrichissement** : `PipelineRunner.run()` renvoie `130`
  si le pipeline forké a été interrompu. `ipcHandlers` DOIT tester
  `pipelineExit === 130` et lever une erreur `_cancelled` — sinon une annulation
  pendant l'enrichissement était rapportée « terminé avec succès ». Côté
  pipeline, un handler coopératif `process.once('SIGINT')` positionne
  `cancelled=true`/`shouldStopAll=true` pour écrire les résultats partiels et
  fermer le navigateur (handler retiré en `finally`).
- **Sécurité du chemin Playwright (KI-3)** : l'URL de recherche (entrée
  utilisateur) est validée par `isSafeFetchDestination(searchUrl, LEBONCOIN_SOURCE_HOSTS)`
  AVANT de lancer Chromium. Toutes les sous-requêtes passent par
  `_installNetworkGuard` (`ctx.route('**/*')`) qui bloque IP privées/locales et
  schémas exotiques. LIMITE : pas de résolution DNS dans le callback `route`
  (rebinding DNS non détecté sur les sous-ressources).
- **`isHostAllowed` inclusif** (domaine + sous-domaines) : rejette les suffixes
  trompeurs (`leboncoin.fr.attacker.com`) grâce au préfixe `.`.
- **IPv6 littérales** : `URL.hostname` conserve les crochets (`[::1]`) → les
  retirer avant `net.isIP`, sinon les IP privées IPv6 passent les contrôles.
- **Clés d'export vs clés du modèle** : `filterAdByFields` traduit les clés
  d'export (`ville`, `codePostal`, `vendeurNbAvis`, `vendeurAnciennete`) vers les
  clés du modèle `normalizeAd` (`city`, `zipcode`, `nombreAvis`,
  `vendeurAncienneteJours`) via `MODEL_KEY_FOR_EXPORT`. Ne PAS revenir à une
  copie `out[key] = ad[key]` : ces champs disparaîtraient des exports Défaut et
  Personnalisé.
- **harCapturer warmup cancel** : si l'utilisateur annule pendant la résolution
  CAPTCHA (fenêtre visible), NE PAS persister `storageState` — la session est
  encore bloquée (cookies anti-bot). Fermer sans `storageState()`.
- **harCapturer CAPTCHA** : `domcontentloaded` + `sleep(1500)` était trop tôt pour
  détecter le CAPTCHA. Fix : `networkidle` + `sleep(3000)`. `_checkCaptcha` doit
  vérifier les iframes (Arkose/hCaptcha/reCaptcha/Cloudflare), les éléments DOM
  (`#challenge-form`, `.cf-turnstile`) et l'URL (`/captcha`, `/challenge`). Ne
  JAMAIS recharger la page pendant la résolution (polling sans reload).
- **UA différent entre warmup et capture** : chaque `_newStealthContext` ne doit
  PAS appeler `getRandomUserAgent()` à chaque fois. UA fixe choisi une fois dans
  le constructeur (`this._userAgent`), réutilisé par `_baseContextOptions`.
- **Renderer canvas null** : `renderCharts` doit vérifier l'existence des canvas
  avant `getContext('2d')`.
- **Renderer localStorage JSON** : `JSON.parse(cached)` sur un cache géocodage
  doit être dans un try/catch. En cas d'échec, `localStorage.removeItem` pour purger.
- **Écritures atomiques pour fichiers critiques** : `secretStore._save()`,
  `settings.saveSettings()` utilisent `atomicWriteFileSync` (tmp + rename).
- **Refresh après suppression job** : `askDeleteJob` doit rafraîchir l'explorateur/
  stats/sessionSelect → sinon données fantômes dans l'UI.
- **compareSet stale** : les IDs d'annonces supprimées doivent être nettoyés du
  compareSet au changement de cache.

## Code mort retiré
- `services/ai/` (adAnalyzer, marketValueAnalyzer, promptGenerator, promptTemplates,
  aiCache, ollamaHealth, providers/, search/) — IA entièrement supprimée.
- `aiStudioModule.js` (renderer) — module Navigateur IA Studio supprimé.
- `aistudioLoginPreload.js` (main) — preload anti-détection Google supprimé.
- `excelExporter.js` (infrastructure) — export XLSX/CSV supprimé.
- `runWithConcurrency` et `formatDuration` (utils/helpers.js) — non utilisés.
- `rapport.txt` (jobHistory.js) — chemin + champ vérifiant un fichier jamais créé.
- `DEFAULTS` (constants.js) — bloc mort conflictuel avec `SETTINGS_DEFAULTS`.
- `risk-keywords.js` (config/) — jamais importé dans l'app.
- `resumes-ia.json` — résumés IA compacts supprimés (plus d'IA).
- `export-meta.json` — métadonnées d'export XLSX/CSV supprimées.
- `infrastructure/notifications.js` — module mort, jamais importé (retiré avec
  l'import `Notifier` qu'il exposait).
- Import `FIELD_CATEGORIES` dans `exporting/dataProfiles.js` — inutilisé.

## Documents d'audit
- `docs/AUDIT_REPORT.md` — périmètre, constats, corrections, limites.
- `docs/STABILITY_PLAN.md` — lots, critères de validation, reste à faire.
- `docs/CHANGELOG.md` — journal des changements significatifs.
- `docs/KNOWN_ISSUES.md` — problèmes non résolus (build Windows, tests UI, etc.).
