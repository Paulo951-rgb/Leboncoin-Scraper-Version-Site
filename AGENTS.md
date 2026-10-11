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
- `HTTP_ACCESS_REFUSED` — HTTP 403 : accès refusé par le serveur
- `HTTP_RATE_LIMITED` — HTTP 429 : limitation de débit (Retry-After respecté)
- `ACCESS_UNVERIFIED` — session non validée (accès impossible à confirmer)
- `CAPTCHA_*` — captcha (détecté, timeout, non résolu, non confirmé)
- `PARSE_*` — parsing (HAR invalide, JSON invalide, aucune annonce)
- `EXTRACTOR_*` — extracteurs (vendeur, prix, description, localisation, dates, photos)
- `SESSION_*` — session (expirée, invalide)
- `BROWSER_*` — navigateur (crash, fermé, échec lancement)
- `STRUCTURE_*` — structure (changée, champ manquant)
- `AD_*` — annonce (supprimée, modifiée, vide)

`createError(code, message, context)` crée un objet d'erreur structuré `{ code, message, context, timestamp }`.

`classifyError(code)` catégorise l'erreur pour déterminer l'action : `recoverable`, `ad_error`, `network_error`, `session_error`, `global_error`, `unknown`.

## Vérification d'accès (anti-fausse-réussite)

`_verifyAccess(page, url)` (harCapturer) confirme l'accès APRÈS résolution d'un
CAPTCHA. Elle effectue une requête document autorisée (HEAD puis GET) et juge sur
le **statut HTTP réel** + la validité du contenu — JAMAIS sur la seule disparition
visuelle du défi. HTTP 403 → `HTTP_403`, HTTP 429 → `HTTP_429` (avec Retry-After),
contenu bloqué en 200 → non confirmé, aucune réponse → `ACCESS_UNVERIFIED`.

États de statut envoyés au renderer : `capturing`, `processing`, `completed`,
`partial` (succès partiel : enrichissement bloqué 403/429 ou interruption),
`cancelled`, `error`, `refused` (403), `rate_limited` (429).

Codes de sortie du pipeline (contrat avec `pipelineRunner.js`) : `0` succès,
`1` erreur fatale, `2` aucune donnée exploitable, `3` enrichissement arrêté sur
HTTP 403, `4` enrichissement arrêté sur HTTP 429.

## Anti-débit (rate limiting) — ne PAS réintroduire la régression

`AdaptiveRateLimiter` (`src/main/utils/rateLimiter.js`) utilise `baseDelayMs`
comme délai **MINIMAL** (`minDelayMs` par défaut = `baseDelayMs`). Il est
instancié par `DescriptionEnricher` avec `baseDelayMs = opts.minDelayMs` (le
preset de vitesse) et `maxDelayMs = opts.maxDelayMs`. Conséquence : **si les
presets mettent des délais de base trop faibles, le backoff après blocage est
lui aussi minuscule** (ex. base 50 ms → backoff max 250 ms), ce qui ne freine
rien face à une limitation de débit.

- Presets actuels : `moyen {8, 1500, 4000}`, `rapide {10, 1000, 3000}`,
  `ultra-rapide {12, 700, 2500}` (`{concurrency, minDelayMs, maxDelayMs}`).
- Le backoff saute directement à `base × 2^max(N,4)` (×16) dès le premier
  blocage — cf. commit de diagnostic 403.
- `Retry-After` (429) est appliqué comme **pause inter-batch**
  `max(délai adaptatif, Retry-After)` : aucune reprise avant le délai indiqué.
- Le commit `a861165` (« restore fast parallel scraping ») avait remonté la
  concurrence à 25 et baissé les délais à 50 ms → **régression de débit** à ne
  pas reproduire.

## Compteurs de session (résumé) — motifs exacts

`ipcHandlers` compte via les lignes du pipeline. Motifs à respecter si les
libellés changent :

- Annonces extraites : `/(\d+)\s+annonces?\s+extraites?/i` (ligne
  « Étape HAR -> Annonces terminée : N annonces extraites. ») ET
  `/(\d+)\s+unique\(s\)\s+en\s+sortie/i` (ligne `[METRICS]`).
- Doublons : `/(\d+)\s+doublon/i`, cumulés en `Math.max` (idempotent).
- L'ancien motif `annonce\(s\)\s+(?:unique|extrait)` ne matchait PAS la ligne
  réelle (mot au singulier) → `adsFound` restait à 0 (« 236 extraites / 0
  trouvée »). Ne pas y revenir sans vérifier la ligne émise.

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
  Sections : logique métier, rendu, sécurité, `[27]` carte (logique pure), `[28]` distribution/packaging,
  `[29]` CI Windows (workflow + `verify-dist.js`).
- Le test stub `electron` : BrowserWindow a `webContents.send` mais PAS `isDestroyed`.
- Avant tout commit : `node --check` sur les fichiers modifiés + lancer la suite.

## Intégration continue (GitHub Actions)
- `.github/workflows/build-windows.yml` — runner **windows-latest**, Node 20.
  - Déclencheurs : `push` (main), `pull_request`, `workflow_dispatch`, tags `v*`.
  - `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1'` + `npm run browsers:win` → un seul
    Chromium (Windows), embarqué par `extraResources`.
  - `npm run dist` puis **`node tools/verify-dist.js --dir=dist`** : le build
    échoue si l'installeur, `ffmpeg.dll`, `app.asar` ou le Chromium embarqué
    manquent (garde-fou anti-« installeur tronqué »).
  - Artefact `windows-installer` (build de test) puis, **uniquement sur tag**,
    job `release` (perms `contents: write`) qui publie une Release GitHub avec
    `*.exe` + `*.sha256`.
- **Pour publier une version** : `git tag vX.Y.Z && git push origin vX.Y.Z`
  (voir README §Publication). Aucun jeton dans le dépôt (GITHUB_TOKEN auto).

## Distribution Windows (NSIS + portable)
- Cibles : NSIS x64 + portable x64 (`package.json` → `build.win.target`).
- NSIS : `oneClick:false`, `perMachine:false` (**installation par utilisateur,
  sans admin**), `allowElevation:true`, `createDesktopShortcut` +
  `createStartMenuShortcut`, `deleteAppDataOnUninstall:false`.
- `npmRebuild:false` : pas de module natif, on évite un rebuild inutile (piste
  de fiabilité du build Windows).
- L'erreur historique `Error: spawn UNKNOWN` provient de
  `NsisTarget.computeScriptAndSignUninstaller` → `execWine(installerPath,…)`,
  au moment d'exécuter l'installeur **très volumineux** pour extraire le
  désinstalleur. Contournement : builder nativement sur **Windows** (spec).

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
- Navigateur Playwright : `npm run browsers` (hôte) / `npm run browsers:win` (Windows)
- Icône : `npm run icon` (régénère `build/icon.ico` depuis `tools/generate-icon.py`, nécessite Pillow)
- Build .exe : `npm run dist` (electron-builder --win) → NSIS + portable dans `dist/`
- Packaging local : `npm run pack` (electron-builder --dir)
- Vérifier un build : `node tools/verify-dist.js --dir=dist` (échoue si incomplet, écrit les `.sha256`)
- Publier une version : créer/pousser un tag `vX.Y.Z` (le workflow s'en charge)

## Build (electron-builder)
Configuration dans `package.json` → clé `build` :
- **Cible** : Windows x64 (NSIS + portable).
- **Chromium embarqué** : `extraResources` copie `node_modules/playwright-core/.local-browsers` dans `browsers/`.
- **Fichiers inclus** : `src/**/*`, `package.json`, `node_modules/playwright*/**/*`.
- **Icône** : `build/icon.ico` (multi-résolutions 16→256, généré par `tools/generate-icon.py`).
- **NSIS** : `oneClick: false`, `allowToChangeInstallationDirectory: true`, raccourcis bureau + menu démarrer.
- **Portable** : `Leboncoin-Scraper-Pro-Portable-${version}.exe`.
- Au runtime, `main.js` pointe `PLAYWRIGHT_BROWSERS_PATH` vers `process.resourcesPath/browsers` si l'app est packagée.

## Tools (tools/)
- `prepare-browsers.js` : télécharge le Chromium **de la plateforme cible** dans
  `node_modules/playwright-core/.local-browsers/`. Indispensable en build croisé
  (Linux → Windows) : `--platform=win` récupère `chromium-win64.zip` ; sans cela,
  l'exe embarqué contiendrait un Chromium Linux et le scraping planterait.
  Appelé par les hooks `prepack`/`predist`/`prebuild`. Idempotent.
  **Piège** : les archives Playwright s'appellent `chromium-win64.zip` /
  `chromium-mac.zip` / `chromium-linux.zip` (PAS `chromium-win.zip`), et le
  sous-dossier extrait est `chrome-win` / `chrome-mac` / `chrome-linux`.
- `generate-icon.py` : génère `build/icon.ico` + `build/icon.png` (Pillow).
- `verify-dist.js` : contrôle un dossier `dist/` après build (installeur NSIS,
  `win-unpacked/` + `app.asar` + `ffmpeg.dll`, Chromium embarqué, en-tête PE,
  taille minimale). Écrit les `.sha256`. Échoue (code 1) si un contrôle bloquant
  échoue. Utilisé par la CI avant tout artefact/Release.

## Build croisé Windows depuis Linux
`electron-builder --win` sous Linux exige **Wine** (édition des ressources de
l'.exe via `rcedit`) ET un affichage (Xvfb) — sinon rcedit échoue avec
`XDG_RUNTIME_DIR is invalid` / `could not load kernel32.dll`. Séquera validée :
```bash
sudo dpkg --add-architecture i386 && sudo apt-get install -y wine wine64 wine32:i386 xvfb
export WINEPREFIX=/tmp/wineprefix WINEARCH=win64 XDG_RUNTIME_DIR=/tmp/runtime-openhands
xvfb-run -a npm run dist
```
Sans Wine, `-c.win.signAndEditExecutable=false` permet de produire `dist/win-unpacked`
(dossier app lançable) mais PAS l'installeur ni le portable.

## Pièges corrigés (à ne PAS réintroduire)
- **Navigation onglets** : `app.js` DOIT cibler `[data-tab]` (pas l'ancienne
  classe `.tab-btn`) pour attacher les écouteurs de navigation. La sidebar
  utilise `.nav-item`. Un sélecteur désaligné = onglets totalement morts
  (aucun écouteur posé), sans erreur visible en console.
- **Champs internes d'annonce** : `raw`, `extractionErrors`, `livraison` et
  `mainPropre` sont INTERNES et ne doivent JAMAIS être écrits dans
  `annonces.json`/`annonces.txt`. `writeOutputsFactory` les retire via
  `stripInternalFields` (indispensable en profil Maximum où les annonces sont
  écrites telles quelles). `livraison`/`mainPropre` sont unifiés en
  `deliveryType` : les réexposer viole le modèle documenté.
- **Paramètres renderer** : `config:save` DOIT passer par
  `sanitizeSettingsPatch` (clés connues + type/plage). Fusionner le patch brut
  permettait d'injecter des clés et de régler `autoCleanJobsDays` à une valeur
  énorme → purge massive de jobs au démarrage suivant.
- **`ErrorCodes.UNKNOWN`** : existe et sert de repli dans `pipelineRunner` pour
  les codes de sortie non classés. Ne pas le retirer (sinon logs `[undefined]`).
- **AdStats médiane** : pour un nombre pair de prix, moyenne des deux valeurs
  centrales (le renderer fait pareil dans renderStatsView). Ne pas reprendre
  `validPrices[Math.floor(n/2)]` qui est faux pour les longueurs paires.
- **CAPTCHA détection** : le statut HTTP de la navigation initiale (`vStatus`)
  ne doit JAMAIS être utilisé pour le polling de résolution — il reste figé à
  403 même après résolution. Utiliser `_checkCaptcha(page)` (content-based) +
  `latestHttpStatus` (response listener dynamique) + confirmation 2s anti-faux-positif.
- **Fausse validation d'accès (CAPTCHA)** : la disparition visuelle du défi
  (iframe/texte/URL) NE prouve PAS l'autorisation. `_warmupSession` DOIT appeler
  `_verifyAccess()` (statut HTTP réel) avant de persister la session et de
  reprendre. Ne JAMAIS déclarer « CAPTCHA résolu » puis lancer la capture si le
  serveur répond encore 403/429. En cas d'échec : arrêt propre, pas de boucle.
- **Boucle de fenêtres CAPTCHA** : la capture ne relance la reprise QUE si
  `_warmupSession` renvoie `verified === true`. Sinon elle `break` (arrêt) — ne
  jamais ré-ouvrir une fenêtre en boucle pour chaque page bloquée.
- **Succès partiel vs succès** : si l'enrichissement est bloqué (403/429) ou si
  des pages sont perdues, `ipcHandlers` DOIT émettre `state: 'partial'` (jamais
  `completed`) et préserver `annonces.json`. Exit codes pipeline `3` (403) / `4`
  (429). Le message de succès n'est affiché QUE si tout est réellement réussi.
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
- **`describeError` non importé (pipeline)** : `leboncoin-pipeline.js` utilisait
  `describeError` au recyclage de contexte (`createStealthContext` échoue) sans
  l'importer → `ReferenceError` masquait l'erreur réelle et perdait le log de
  diagnostic. Import depuis `utils/diagnostics` obligatoire.
- **`window.prompt()` (Electron)** : NON supporté par Electron → le bouton
  « Sauvegarder comme Preset » était totalement inopérant. Remplacé par la modale
  `#presetModal`. Ne pas réintroduire `prompt()` dans le renderer.
- **`loadPreset` et spread** : `applySearchConfig({ searchUrl: p.searchUrl, ...p })`
  laissait `p.url` écraser `searchUrl` (spread APRÈS les clés explicites) → URL du
  preset non chargée. Toujours mettre le spread AVANT les clés explicites.
- **`escapePath` ordre `&`/`"`** : échapper `&` APRÈS avoir généré `&quot;`
  double-encode (`&amp;quot;`). `&` doit être remplacé en PREMIER.
- **`--no-seller-data` en profil Maximum** : `filterAdByFields(ad, null, …)`
  renvoyait l'objet tel quel (early-return), donc l'exclusion vendeur était
  ignorée et les données vendeur fuyaient dans l'export Maximum. L'exclusion doit
  s'appliquer aussi quand `fields` est null.
- **Logs dev** : `logger._getLogDir()` écrivait dans `Documents` même en dev ;
  doit rester dans `./output/logs` (cohérent avec jobs/secrets), Documents
  uniquement en version packagée.

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
