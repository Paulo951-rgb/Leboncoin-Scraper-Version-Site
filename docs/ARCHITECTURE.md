# Architecture Technique

## Stack

| Composant | Technologie | Rôle |
|---|---|---|
| Shell applicatif | **Electron 28** | App web comme application desktop native (main + renderer, contextIsolation, sandbox) |
| Scraping | **Playwright 1.41** (Chromium) | Pilotage du navigateur, capture réseau HAR |
| Graphiques | **Chart.js** | Distribution des prix, vendeurs, top villes, modes de transaction |
| Carte | **Leaflet** | Carte interactive des annonces (géocodage via API Gouv France) |
| Build | **electron-builder 24** | Génération du `.exe` Windows (NSIS + portable) |
| Tests | **Node.js natif** | Suite de non-régression (sans framework externe) |

> **Aucune dépendance IA** : pas d'Ollama, pas de LLM, pas de vision, pas de cloud. L'application est 100% locale.

---

## Process Architecture

```
Main process (main.js)
  ├── IPC handlers (ipcHandlers.js)
  ├── Pipeline runner (forked process)
  │   └── Leboncoin pipeline (Playwright)
  │       ├── HarCapturer — capture réseau + pré-check/détection captcha
  │       ├── adFields.js — extracteurs de champs (SCRAPING PUR)
  │       ├── computeDeliveryType — unification livraison/mainPropre
  │       └── exportFields — filtrage + TXT lisible
  ├── Job history manager
  ├── File manager (JSON/TXT)
  └── Settings manager

Renderer process
  ├── Sidebar navigation
  ├── Scraper tab (config, presets, profils)
  ├── Logs tab (real-time logs)
  ├── History tab (job list)
  ├── Explorer tab (ads table/grid, filters, detail)
  └── Stats tab (charts, map)
```

### Main process (`src/main/`)

Le main process est le processus Node.js principal d'Electron. Il gère :
- le cycle de vie de l'application (`main.js`) ;
- la création des fenêtres (principale + widget flottant) ;
- l'enregistrement unique des handlers IPC (`ipcHandlers.js`) ;
- le lancement du pipeline de scraping en sous-processus (`pipelineRunner.js` via `child_process.fork()`) ;
- la persistance des paramètres (`settings.js`) ;
- la gestion de l'historique des jobs (`jobHistory.js`) ;
- l'ouverture des fichiers/dossiers (`fileManager.js`) ;
- le nettoyage automatique (`storageCleaner.js`) ;
- les secrets chiffrés (`secretStore.js`).

### Renderer process (`src/renderer/`)

Le renderer est le processus Chromium sandboxé. Il n'a **aucun accès direct à Node.js**. Toute communication passe par `preload.js` → `window.api` → `ipcMain`.

L'UI est organisée en **sidebar** + modules :
- `app.js` — orchestration, sidebar, routage.
- `appState.js` — état global du renderer.
- `scraperModule.js` — onglet Scraper (URL, pages, profil, vitesse, presets).
- `logsModule.js` — onglet Logs (console temps réel, filtrage, auto-scroll).
- `historyModule.js` — onglet Historique (jobs, ouverture dossier, suppression).
- `explorerModule.js` — onglet Explorateur (table, grille, filtres, tri, fiche détaillée).
- `statsModule.js` — onglet Stats (cartes, graphiques, carte Leaflet).
- `helpModule.js` — module d'aide (FAQ, guide, feedback).
- `utils.js` — utilitaires (escapeHtml, escapePath, formatage).

### Pourquoi un sous-processus (`fork`) pour le pipeline ?

`leboncoin-pipeline.js` est un script CLI Node.js autonome lancé via `child_process.fork()` depuis `pipelineRunner.js`. Cela permet :
- d'isoler le traitement lourd (parsing de gros `.har`, jusqu'à plusieurs centaines de Mo) du main process pour ne pas geler l'UI ;
- de tuer/interrompre proprement (`SIGINT`) sans affecter Electron ;
- de communiquer la progression via `stdout` (logs formatés `[done/total]`).

---

## Data Flow

```
URL → HAR capture → Pipeline (extract/normalize) → JSON+TXT files → Explorer/Stats
```

1. **Lancement** (`job:start`) → `HarCapturer` ouvre Chromium (headless), navigue vers Leboncoin.
2. **Pré-check captcha** : si blocage détecté (contenu ou HTTP ≥400), ouverture d'une fenêtre visible pour résolution manuelle. Détection automatique de résolution (polling contenu 2s + confirmation 2s anti-faux-positif). Session validée persistée dans `global-session.json`.
3. **Capture HAR** : navigation page par page, enregistrement du trafic filtré (`recherche|api|items`).
4. **Pipeline** (`fork`) : parse le HAR → extrait les annonces (`__NEXT_DATA__`) → normalise via `adFields.js` → calcule `deliveryType` → déduplique → enrichit les descriptions (batchs parallèles + rate limiter, arrêt préventif après 3 blocages 403/429).
5. **Export** : écriture `annonces.json` (checksum SHA-256) + `annonces.txt` (aligné sur le profil choisi).
6. **Historique** : job enregistré, accessible dans l'onglet Historique.

---

## Data Model

Chaque annonce normalisée (dans `annonces.json`) :

```jsonc
{
  "id": "2831923847",
  "title": "PC portable Gamer",
  "prix": 450,
  "url": "https://www.leboncoin.fr/ad/2831923847.htm",
  "city": "Lyon",
  "zipcode": "69000",
  "deliveryType": "livraison",
  "vendeurNom": "Jean D.",
  "vendeurType": "particulier",
  "vendeurId": "123456",
  "vendeurNote": 4.8,
  "nombreAvis": 27,
  "vendeurUrlProfil": "https://www.leboncoin.fr/u/123456.htm",
  "vendeurAncienneteJours": 120,
  "likes": 5,
  "datePublication": "2026-08-01T10:00:00Z",
  "dateModification": null,
  "dateScraping": "2026-08-01T12:30:00Z",
  "etat": "Très bon état",
  "photosCount": 4,
  "photosUrls": ["https://...jpg"],
  "description": "Texte complet..."
}
```

### Champ `deliveryType`

Valeurs canoniques :

| Valeur | Signification |
|---|---|
| `les_deux` | Livraison et remise en main propre |
| `livraison` | Livraison uniquement |
| `main_propre` | Remise en main propre uniquement |
| `aucun` | Ni livraison ni main propre |
| `inconnu` | Indéterminé |

### Profils de données

| Profil | Description | Champs |
|---|---|---|
| **Défaut** | Scraping rapide et léger | 13 champs essentiels |
| **Maximum** | Toutes les données disponibles | ~23 champs |
| **Personnalisé** | Choix de l'utilisateur | Sélection granulaire par catégorie |

### Convention

Tout champ non trouvé est `null` (jamais `0`, jamais `''`, jamais une valeur inventée). Les booléens sont nullables (`true | false | null`) pour distinguer les trois états : détecté OUI, détecté NON, indéterminé.

---

## Error Codes

Le système de codes d'erreurs (`src/main/services/scraping/errorCodes.js`) structure chaque erreur avec un code préfixé par domaine, un message lisible et un contexte.

### Domaines

| Préfixe | Domaine | Exemples |
|---|---|---|
| `NET_` | Erreurs réseau | `NET_TIMEOUT`, `NET_CONNECTION_FAILED`, `NET_DNS_FAILED` |
| `HTTP_` | Erreurs HTTP | `HTTP_403`, `HTTP_429`, `HTTP_404`, `HTTP_500`, `HTTP_UNKNOWN` |
| `CAPTCHA_` | CAPTCHA | `CAPTCHA_DETECTED`, `CAPTCHA_TIMEOUT`, `CAPTCHA_UNRESOLVED` |
| `PARSE_` | Parsing | `PARSE_HAR_INVALID`, `PARSE_JSON_INVALID`, `PARSE_NO_ADS` |
| `EXTRACTOR_` | Extracteurs | `EXTRACTOR_SELLER_NAME_FAILED`, `EXTRACTOR_PRICE_FAILED`, `EXTRACTOR_DESCRIPTION_FAILED` |
| `SESSION_` | Session | `SESSION_EXPIRED`, `SESSION_INVALID` |
| `BROWSER_` | Navigateur | `BROWSER_CRASHED`, `BROWSER_CLOSED`, `BROWSER_LAUNCH_FAILED` |
| `STRUCTURE_` | Structure | `STRUCTURE_CHANGED`, `STRUCTURE_FIELD_MISSING` |
| `AD_` | Annonce | `AD_DELETED`, `AD_MODIFIED`, `AD_EMPTY` |

### Classification

La fonction `classifyError(code)` catégorise chaque erreur pour déterminer l'action à prendre :

| Catégorie | Action | Codes |
|---|---|---|
| `recoverable` | Reprise possible | — |
| `ad_error` | Erreur d'une annonce (continue) | `EXTRACTOR_*`, `AD_*` |
| `network_error` | Erreur réseau (backoff/retry) | `NET_*`, `HTTP_4*` |
| `session_error` | Erreur de session (captcha) | `CAPTCHA_*`, `SESSION_*` |
| `global_error` | Erreur globale (arrêt) | `HTTP_5*`, `PARSE_*`, `BROWSER_*`, `STRUCTURE_*` |
| `unknown` | Non classée | — |

### Création d'erreur

```js
const { createError, ErrorCodes } = require('./errorCodes');
const err = createError(ErrorCodes.HTTP_403, 'Accès refusé par Leboncoin', { url, page: 3 });
// → { code: 'HTTP_403', message: 'Accès refusé par Leboncoin', context: { url, page: 3 }, timestamp: '...' }
```

---

## Security

### Sandbox renderer
- `contextIsolation: true` — le renderer n'a pas accès direct à l'API Node.js.
- `nodeIntegration: false` — pas de `require()` dans le renderer.
- `sandbox: true` — processus renderer isolé.

### Webviews verrouillés
Handler `will-attach-webview` sur `web-contents-created` : tout `<webview>` créé dynamiquement se voit forcer :
- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- `webSecurity: true`
- suppression de tout preload injecté par le renderer
- isolation de session (`webview-sandbox`)

### CSP
Une balise meta Content-Security-Policy est présente dans `index.html` pour restreindre les sources de contenu.

### `shell:openExternal` filtré
Seuls les schémas `http:` et `https:` sont autorisés. Les schémas `file:`, `javascript:`, `data:` sont bloqués.

### Accès fichiers validé
- `isPathAllowed()` n'autorise que les chemins dans `BASE_OUT_DIR` (anti path-traversal).
- `deleteJob()` valide le format `job-<timestamp>` + double-check du chemin résolu.

### Secrets chiffrés
- `safeStorage` OS (Keychain/DPAPI/libsecret) pour le chiffrement natif.
- Fallback AES-256-GCM si `safeStorage` indisponible.
- Secrets jamais en clair, stockés dans `secrets.enc.json`.

### Intégrité des données
- Checksum SHA-256 (`writeWithChecksum` / `readWithChecksum`) sur `annonces.json`.
- Écriture atomique (`.tmp` + `rename`) sur tous les fichiers JSON critiques.

### Single-instance lock
Empêche plusieurs instances concurrentes (conflit session/fichiers).

---

## IPC Communication

Le renderer n'a **aucun accès direct à Node.js**. Toute communication passe par `preload.js` → `window.api` → `ipcMain` dans `ipcHandlers.js`.

### Canaux IPC

| Catégorie | Canaux |
|---|---|
| Job scraping | `job:start` (on), `job:stop` (on), `job:getHistory` (handle), `job:getAdHistory` (handle), `job:delete` (handle) |
| Fichiers | `file:openFolder` (handle), `file:openFile` (handle), `jobs:openFolder` (handle), `shell:openExternal` (handle) |
| Config | `config:get` (handle), `config:save` (handle) |
| Diagnostics | `app:getDiagnostics` (handle), `app:checkChromium` (handle) |
| Secrets | `secret:get` (handle), `secret:set` (handle), `secret:has` (handle), `secret:remove` (handle) |
| Réseau | `network:check` (handle) |
| Widget | `widget:toggle` (on), `widget:progress` (on), `widget:status` (on), `widget:close` (on) |
| Main→Renderer | `log`, `progress`, `status` (emit vers le renderer) |

Les listeners utilisent `removeAllListeners` avant re-souscription pour éviter les fuites. Le getter `getMainWindow()` renvoie null si la fenêtre est détruite (pas de capture par closure). Les handlers IPC sont enregistrés **une seule fois** dans `app.whenReady`.
