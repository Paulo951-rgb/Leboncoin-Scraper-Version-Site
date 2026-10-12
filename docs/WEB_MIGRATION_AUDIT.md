# Audit & plan de migration — Version Web (Render)

> Document de la **Phase A** : audit du dépôt, cartographie des dépendances
> Electron, décisions techniques et plan de migration vers une application Web
> servie en HTTPS. La version Electron de bureau reste **indépendante** et n'est
> pas modifiée dans son comportement.

---

## 1. Parcours complet d'une tâche de scraping (version Electron de référence)

```
Renderer (scraperModule)
  │ window.api.startScraping(config)          [preload.js → ipcRenderer.invoke]
  ▼
ipcHandlers (main) — handle('scrape:start')
  │ 1. sanitize settings / validation URL (urlSecurity.isSafeFetchDestination)
  │ 2. new HarCapturer({ proxyUrl, headless, globalSessionPath })
  │ 3. capturer.capture({ searchUrl, maxPages, outputHarPath })
  │      → _warmupSession() : pré-check session, CAPTCHA éventuel, _verifyAccess()
  │      → navigation paginée + capture réseau → capture.har
  │ 4. new PipelineRunner().run({ harPath, outDir, profileFields, … })
  │      → fork(leboncoin-pipeline.js) : extraction HAR → normalisation → dédup →
  │        enrichissement descriptions (HTTP) → exports JSON/TXT + export-meta
  │ 5. lecture annonces.json → sendSessionSummary()
  ▼
Renderer : onProgress / onStatusChange / onLog (webContents.send)
```

Phases de progression : capture HAR ≈ 0-25 %, pipeline ≈ 30-99 %, 100 % à la fin.
États émis : `capturing`, `processing`, `completed`, `partial`, `cancelled`,
`error`, `refused` (403), `rate_limited` (429).

---

## 2. Dépendances entre modules (couche main)

| Module | Dépend de `electron` ? | Rôle |
|---|---|---|
| `config/constants.js` | **oui (top-level)** → rendu *lazy* | BASE_OUT_DIR, JOBS_DIR, GLOBAL_SESSION_PATH |
| `config/scraping.js` | non | presets, seuils, états disjoncteur |
| `utils/logger.js` | **oui (top-level)** → rendu *lazy* | logs fichier (Documents en packagé) |
| `utils/secretStore.js` | oui (`app`, `safeStorage`) | secrets chiffrés (spécifique bureau) |
| `core/settings.js` | oui (`app`) | user-settings.json |
| `core/ipcHandlers.js` | oui (via BrowserWindow) | handlers IPC |
| `services/scraping/harCapturer.js` | **non** (sessionPath injectable) | capture Playwright |
| `services/scraping/pipelineRunner.js` | non | fork + parsing lignes |
| `services/scraping/leboncoin-pipeline.js` | non | extraction/enrichissement/exports |
| `services/scraping/adFields.js` | non | extracteurs (scraping pur) |
| `services/scraping/errorCodes.js` | non | codes d'erreurs |
| `services/exporting/*` | non | profils + filtrage champs |
| `services/jobs/jobHistory.js` | non | listing/lecture jobs |
| `services/analysis/adStats.js` | non | statistiques prix |
| `infrastructure/fileManager.js` | oui (`shell`) | ouverture fichiers/dossiers |
| `utils/urlSecurity.js` | non | allowlist + anti-SSRF |

**Conclusion** : le moteur de scraping (`harCapturer`, `pipelineRunner`,
`leboncoin-pipeline`, `adFields`, `errorCodes`, `exporting`, `adStats`,
`jobHistory`, `urlSecurity`) est **déjà découplé d'Electron**. Seuls
`constants.js`, `logger.js`, `secretStore.js`, `settings.js`, `fileManager.js`
et la couche IPC dépendaient d'Electron.

---

## 3. Canaux IPC et événements UI

| IPC (Electron) | Équivalent Web |
|---|---|
| `invoke('scrape:start')` | `POST /api/jobs` (asynchrone) |
| `invoke('scrape:stop')` | `POST /api/jobs/:id/cancel` |
| `on('scrape:log')` | SSE `/api/jobs/:id/events` (event `log`) |
| `on('scrape:progress')` | SSE `event: status` (champ `progress`) |
| `on('scrape:status')` | SSE `event: status` |
| `invoke('jobs:list')` | `GET /api/history` |
| `invoke('jobs:adHistory')` | `GET /api/ad-history` |
| `invoke('jobs:delete')` | `DELETE /api/jobs/:id` |
| `invoke('config:get/save')` | `GET/POST /api/config` |
| `invoke('file:openFile/openFolder')` | `GET /api/jobs/:id/export/:format` (téléchargement) |
| `invoke('diagnostics:get')` | `GET /api/diagnostics` |

Le client `src/renderer/api.js` expose `window.api` avec **les mêmes noms de
méthodes** que le preload Electron, mais via REST/SSE. Les modules renderer
(scraper, logs, explorateur, stats, historique) sont donc réutilisés **sans
réécriture** de leur logique métier.

---

## 4. Structures de données

### Annonce (`normalizeAd`) — champs conservés

`id, title, url, category, prix (nombre), city, zipcode, deliveryType,
vendeurNom, vendeurType, vendeurId, vendeurNote, nombreAvis, vendeurUrlProfil,
vendeurAncienneteJours, likes, datePublication, dateModification, dateScraping,
etat, photosCount, photosUrls, description`.

- `deliveryType` ∈ {`les_deux`, `livraison`, `main_propre`, `aucun`, `inconnu`}.
- Champ non trouvé → `null` (jamais `0`/`''`).
- Champs **internes** (`raw`, `extractionErrors`, `livraison`, `mainPropre`) :
  jamais exposés dans les réponses API ni les exports.

### Résultats d'un job

`annonces.json` (checksum SHA-256), `annonces.txt`, `export-meta.json`.

---

## 5. Fichiers/répertoires écrits localement

```
<BASE_OUT_DIR>/
  global-session.json         session Playwright globale (cookies)
  jobs/<jobId>/
    capture.har               capture réseau (volumineux)
    capture-progress.json     reprise
    results/annonces.json|txt, export-meta.json, report.json
  logs/
```

Sur le serveur : `BASE_OUT_DIR` est piloté par **`LBC_BASE_OUT_DIR`**
(disque persistant Render monté sur `/data`).

---

## 6. Master Session, cookies, CAPTCHA

- **Session** : `_warmupSession()` charge `global-session.json` (storageState),
  vérifie l'accès (`_verifyAccess` : statut HTTP réel HEAD/GET), persiste après
  validation. En cas d'échec, arrêt propre (pas de boucle).
- **CAPTCHA** : détection content-based (`_checkCaptcha`), fenêtre visible pour
  résolution humaine, puis confirmation 2 s + `_verifyAccess`. Ne JAMAIS déclarer
  résolu si le serveur répond encore 403/429.
- **Limite Web** : un serveur headless ne peut pas ouvrir de fenêtre visible.
  → nouvelle option `allowVisibleCaptcha` (défaut `true`, désactivée côté
  serveur). Un CAPTCHA devient alors un état **`action_required`** (arrêt propre,
  message explicite), jamais une fausse réussite.
- **Cookies** : non copiés depuis Electron. Chaque utilisateur Web possède sa
  propre session (`web/sessions/<userId>/global-session.json`), isolée.

---

## 7. Pipeline, checkpoints, résultats partiels, annulation

- **Checkpoints** : `capture-progress.json` (`lastPageOk`) + fusion HAR.
- **Résultats partiels** : exit code pipeline `3` (403) / `4` (429) → état
  `partial`, `annonces.json` préservé. Code `2` = aucune donnée exploitable.
- **Annulation** : `activeCancel` + `SIGINT` coopératif au fork (handler retiré
  en `finally`), exit `130` → état `cancelled` (jamais « terminé avec succès »).
- **Côté serveur** : mêmes codes mappés vers les états Web
  (`partial`/`failed`/`cancelled`/`action_required`).

---

## 8. Tests de régression existants

- `test/regression.test.js` : **1317 tests** (logique métier, rendu, sécurité,
  carte, packaging, CI Windows). Baseline vérifiée **1317 réussis / 0 échoué**
  avant et après les modifications.
- Nouveau : `test/server.test.js` (**65 tests** serveur/API/frontend).

---

## 9. Fonctionnalités dépendant d'Electron / `fs` / `shell` / `app` / `child_process`

| Fonctionnalité | Dépendance | Traitement Web |
|---|---|---|
| Chemins locaux (Documents) | `app.getPath` | `LBC_BASE_OUT_DIR` (env) |
| Ouverture fichier/dossier | `shell` | téléchargement HTTP |
| Secrets chiffrés | `safeStorage` | variables d'environnement |
| Widget flottant | `BrowserWindow` | masqué (bouton caché) |
| IPC | `ipcMain` | REST + SSE |
| Pipeline `fork` | `child_process` | **conservé** (fonctionne en Node) |

---

## 10. Dépendances inutilisables dans un navigateur

- `electron` (tout), `fs`/`path` (accès disque serveur), `shell`,
  `child_process` (fork pipeline), `playwright`/Chromium (exécution).
  → **Toutes restent côté serveur** ; le navigateur ne fait que consommer
  l'API HTTPS.

---

## 11. Décisions techniques

1. **Serveur Express** + `better-sqlite3` (persistance SQLite WAL, sans ORM).
2. **Auth par session** (jeton opaque haché SHA-256, cookie HttpOnly/SameSite,
   scrypt pour les mots de passe) — pas de JWT dans le frontend.
3. **Tâches asynchrones** : `POST /api/jobs` renvoie immédiatement un id ;
   suivi par **SSE** (`/events`) avec repli par polling (`/jobs/:id`, `/logs`).
4. **Réutilisation intégrale du moteur** (aucune simulation) ; fabriques
   injectables uniquement pour les tests.
5. **Isolation** : jobs/sessions/résultats sous `<userId>/` ; toute ressource
   filtrée par `user_id` en base.
6. **Docker** basé sur `mcr.microsoft.com/playwright:v1.41.2-jammy` (version
   exacte du projet) — Chromium et dépendances système incluses.
7. **CAPTCHA** : état `action_required`, pas de contournement, pas de fausse
   validation.

---

## 12. Plan de migration (phases)

| Phase | Contenu | État |
|---|---|---|
| **A** | Audit + cartographie (ce document) | ✅ |
| **B** | Découplage Electron (`constants`, `logger`, session injectable) | ✅ |
| **C** | Backend Web + système de tâches (`src/server/`) | ✅ |
| **D** | Persistance SQLite + authentification | ✅ |
| **E** | Adaptation frontend (`api.js`, `authModule`, téléchargements, responsive) | ✅ |
| **F** | Docker + Render + santé + arrêt propre | ✅ |
| **G** | Tests (`test/server.test.js`) + non-régression (1317) | ✅ |
| **H** | Documentation (README, ce document, WEB_DEPLOYMENT) | ✅ |

---

## 13. Fichiers créés / modifiés / conservés

**Créés**
- `src/server/{index,app,config,db,auth,security,logBus,jobManager,resultsService,maintenance}.js`
- `src/server/routes/api.js`
- `src/renderer/api.js`, `src/renderer/authModule.js`
- `Dockerfile`, `.dockerignore`, `render.yaml`, `.env.example`
- `test/server.test.js`
- `docs/WEB_DEPLOYMENT.md`, `docs/WEB_MIGRATION_AUDIT.md` (ce fichier)

**Modifiés (comportement Electron inchangé)**
- `src/main/config/constants.js` : electron *lazy* + `LBC_BASE_OUT_DIR`
- `src/main/utils/logger.js` : electron *lazy* + `LBC_BASE_OUT_DIR`
- `src/main/services/scraping/harCapturer.js` : `globalSessionPath` injectable +
  option `allowVisibleCaptcha`
- `src/main/core/ipcHandlers.js` : passe `globalSessionPath`
- `src/renderer/index.html` : scripts `api.js`/`authModule.js` + overlay connexion
- `src/renderer/scraperModule.js` : état `action_required`
- `src/renderer/historyModule.js` : téléchargements (web) vs ouverture (bureau)
- `src/renderer/utils.js` : `openFile/openFolder` web-aware
- `src/renderer/styles.css` : responsive tactile
- `package.json` : deps serveur + scripts `start:web`, `test:server`, `test:all`

**Conservés à l'identique** : tout le moteur de scraping, les profils de
données, les exports, l'app Electron (`main.js`, `preload.js`, IPC, build).

---

## 14. Problèmes non résolus (documentés, non masqués)

- **CAPTCHA en headless** : pas de résolution automatique. État
  `action_required` + message. Solution future éventuelle : navigateur distant
  avec contrôle d'accès (non implémenté volontairement).
- **Plans Render gratuits** : RAM insuffisante pour Chromium stable et tâches
  longues → plan payant + disque persistant requis (voir WEB_DEPLOYMENT).
- **DNS rebinding** sur sous-ressources : limite connue de `urlSecurity` (pas de
  résolution DNS dans le callback `route`).
