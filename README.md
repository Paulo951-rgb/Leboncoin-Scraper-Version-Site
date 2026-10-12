# 🛒 Leboncoin Scraper Pro

Application de bureau **Electron** pour scraper, explorer et analyser des annonces [Leboncoin.fr](https://www.leboncoin.fr) : capture automatisée des résultats de recherche, extraction structurée des annonces, enrichissement des descriptions, statistiques et carte géographique.

> **Leboncoin Scraper Pro** est un outil d'automatisation et de structuration de données destiné à faciliter le traitement de données auxquelles l'utilisateur est autorisé à accéder et à traiter. L'utilisateur reste responsable du respect des conditions d'utilisation, des droits applicables et de la réglementation concernant les données collectées. Ce logiciel ne fournit aucune autorisation d'accès ou de réutilisation des données de sites tiers.

> 🌐 **Version Web** : ce dépôt fournit AUSSI une version serveur accessible par URL HTTPS (déploiement Render), sans installation ni Electron chez l'utilisateur. Voir [Version Web (Render)](#-version-web-render) et `docs/WEB_DEPLOYMENT.md`.

---

## 📋 Table des matières

1. [Présentation](#-présentation)
2. [Fonctionnalités](#-fonctionnalités)
3. [Version Web (Render)](#-version-web-render)
4. [Installation pour les utilisateurs finaux](#-installation-pour-les-utilisateurs-finaux)
5. [Installation pour les développeurs](#-installation-pour-les-développeurs)
6. [Guide d'utilisation](#-guide-dutilisation)
7. [Architecture](#-architecture)
8. [Structure du projet](#-structure-du-projet)
9. [Modèle de données](#-modèle-de-données)
10. [Build (génération du .exe)](#-build-génération-du-exe)
11. [Tests](#-tests)
12. [Dépannage](#-dépannage)
13. [Avertissement légal](#-avertissement-légal)

---

## 🎯 Présentation

**Leboncoin Scraper Pro** est une application desktop construite avec **Electron** (code multiplateforme) qui :

1. **Capture** les résultats d'une recherche Leboncoin (Chromium piloté par Playwright).
2. **Extrait** les annonces à partir du trafic réseau capturé (fichier `.har`).
3. **Enrichit** chaque annonce avec sa description complète (non présente dans les résultats bruts).
4. **Normalise** les données dans un schéma structuré avec un champ `deliveryType` unifié.
5. **Exporte** les résultats en **JSON** et **TXT** (avec checksum SHA-256).
6. Offre un **explorateur** d'annonces (filtres, tri, vue tableau/grille, fiche détaillée).
7. Fournit des **statistiques** (cartes, graphiques) et une **carte interactive**.
8. Gère un **historique** complet des jobs avec suppression.

L'application est pensée pour un usage **semi-automatisé** : l'utilisateur peut devoir résoudre un captcha manuellement si Leboncoin détecte une activité robotique — la détection de résolution est **automatique** (polling contenu + confirmation anti-faux-positif), le scraping reprend tout seul.

### Profils de données

L'utilisateur choisit parmi **3 profils de données** au moment du scraping :

- **Défaut** — champs essentiels pour un scraping rapide et léger.
- **Maximum** — toutes les données disponibles techniquement.
- **Personnalisé** — choix exact des champs à récupérer.

---

## ⚙️ Fonctionnalités

### Scraping & extraction
- 🚀 **Scraping automatisé** d'une URL de recherche Leboncoin sur plusieurs pages.
- 🔑 **Session globale persistante** (« Master Session ») pour éviter de repasser un captcha à chaque lancement.
- 🤖 **Détection automatique de blocage/captcha** avec pause, puis **détection automatique de résolution** (polling contenu 2s + confirmation anti-faux-positif) — la fenêtre se ferme et le scraping reprend sans attendre un timeout.
- 📝 **Extraction des descriptions complètes** en mode rapide parallèle (batchs via `Promise.all`, exécutées dans la page pour hériter des cookies/session).
- 📦 **`deliveryType` unifié** — remplace les anciens champs `livraison` / `mainPropre` par un seul champ canonique (`les_deux`, `livraison`, `main_propre`, `aucun`, `inconnu`).
- 🏷️ **Catégorie** de l'annonce extraite à la fois sur la liste et la page de détail.
- ⭐ **Note vendeur + nombre d'avis** extraits défensivement de l'objet `owner`.
- 🔄 **Rotation de User-Agent** (10 UA réalistes en rotation aléatoire, fixé pour toute la durée d'une capture).
- 🚀 **3 presets de vitesse** (Moyen / Rapide / Ultra-rapide) pour l'enrichissement des descriptions.
- ⏳ **Rate limiting adaptatif** — backoff exponentiel si Leboncoin répond lentement ou bloque (403/429).
- ⏹️ **Arrêt préventif** après 3 blocages 403/429 consécutifs pendant l'enrichissement (sauvegarde des données collectées).
- 🧾 **Codes d'erreurs structurés** (`errorCodes.js`) — chaque erreur est catégorisée (`NET_`, `HTTP_`, `CAPTCHA_`, `PARSE_`, `EXTRACTOR_`, `SESSION_`, `BROWSER_`, `STRUCTURE_`, `AD_`).

### Profils de données
- 🎚️ **3 profils** : **Défaut** (champs essentiels), **Maximum** (toutes les données), **Personnalisé** (sélection granulaire).
- ✂️ Sélection par catégorie (Identification, Prix, Localisation, Vendeur, Transaction, Dates, Statistiques, Produit, Photos, Description).
- 🔘 Boutons « Tout sélectionner » / « Tout désélectionner » + sauvegarde de la sélection.
- 👤 **Données vendeur désactivables** — exclusion systématique des champs vendeur de tous les exports et de l'interface.

### Export & visualisation
- 📄 Export **JSON** (avec checksum SHA-256) et **TXT** lisible.
- 🔍 **Explorateur d'annonces** — filtres (mot-clé, prix, type de remise, type vendeur, note, likes, catégorie, ville), tri, vue tableau/grille, fiche détaillée (photos, description, vendeur, dates).
- 📊 **Statistiques** — cartes colorées (Total, Prix Moyen/Min/Max, Livraison, Main Propre, Pro/Particulier) + 4 graphiques (Distribution des prix, Vendeurs, Top 10 Villes, Modes de Transaction) + carte Leaflet.
- 🗺️ **Carte interactive** (Leaflet) — répartition géographique avec filtre « remise main propre », géocodage via API Gouv France (cache + timeout 10s). Déduplication des annonces par id.
- 📁 **Historique** complet des jobs avec suppression.
- 🖥️ **Widget flottant** always-on-top (progression temps réel).
- 🎨 **13 thèmes visuels**.
- 📶 **Mode hors-ligne** — badge de connectivité, scraping désactivé mais historique consultable.
- 📜 **Logs rotatifs** (un fichier par jour, rétention configurable) + console en direct avec mode normal/debug, auto-scroll, copie, vidage, compteur.
- ❓ **Système d'aide intégré** — FAQ (accordéon), guide d'utilisation pas à pas et formulaire de feedback, accessibles depuis l'en-tête.
- 🛡️ **Écran d'information légal** au premier lancement : rappel des responsabilités de l'utilisateur et de la nécessité de vérifier les droits d'accès. Sauvegardé une fois accepté, réaffichage possible depuis les paramètres.

---

## 🌐 Version Web (Render)

Ce dépôt contient **deux applications indépendantes** partageant le même moteur
de scraping :

| Version | Entrée | Exécution | Public |
|---|---|---|---|
| **Bureau** | `src/main/main.js` (`npm start`) | Electron local | Utilisateur desktop |
| **Web** | `src/server/index.js` (`npm run start:web`) | Serveur Node.js (Render) | Navigateur (PC/tablette/téléphone) |

La version Web réutilise **intégralement** le moteur existant (`harCapturer`,
`pipelineRunner`, `leboncoin-pipeline`, `adFields`, `errorCodes`, profils de
données, exports) — aucune simulation. Seule la couche Electron (fenêtres, IPC,
`shell`, `safeStorage`, chemins `Documents`) est remplacée par un serveur HTTP.

### Démarrage local

```bash
npm install
npm run start:web          # http://localhost:3000
# ou, pour désactiver l'authentification en développement :
LBC_AUTH_DISABLED=1 npm run start:web
```

### Fonctionnalités conservées

Scraper (URL, pages, limites, profils, vitesse, progression, annulation,
erreurs, résultats partiels) · Logs (temps réel SSE, filtres, export) ·
Historique · Explorateur (recherche, filtres, tri, tableau/grille, fiche) ·
Statistiques (totaux, prix, distribution, vendeurs, villes, modes de remise) ·
Carte Leaflet · Profils Défaut/Maximum/Personnalisé · exclusion des données
vendeur · Paramètres · Aide & informations légales.

Adaptations Web : écran de connexion, téléchargement des exports (JSON/TXT) via
HTTP, suivi des tâches par **SSE** (repli polling), interface responsive/tactile.
Les fonctions purement locales (ouverture de fichiers, widget flottant, secrets
chiffrés) sont remplacées par des équivalents Web explicites.

### Déploiement

`Dockerfile` (image Playwright `1.41.2-jammy` = version exacte du projet),
`render.yaml` (service + disque persistant `/data`), endpoint de santé
`/api/health`. Détails complets : **`docs/WEB_DEPLOYMENT.md`** ; audit et plan de
migration : **`docs/WEB_MIGRATION_AUDIT.md`**.

Autres cibles :
- **Hugging Face Spaces** : `deploy/huggingface/` + `npm run hf:prepare`
  (⚠️ Space Docker = plan payant depuis 2026, disque non persistant) —
  voir `docs/WEB_DEPLOYMENT_HUGGINGFACE.md`.
- **Oracle Cloud Always Free** : seule offre réellement gratuite et persistante
  capable de faire tourner Chromium (2 OCPU ARM / 12 Go / 200 Go).

### Limite CAPTCHA

Le serveur est **headless** : la résolution manuelle d'un CAPTCHA n'est pas
possible. La tâche passe alors à l'état **`action_required`** (arrêt propre +
message explicite) — aucun contournement n'est tenté et aucune fausse réussite
n'est rapportée.

---

## 💾 Installation pour les utilisateurs finaux

Aucune connaissance technique requise. Vous n'avez **pas besoin de Node.js, npm ou d'un terminal**.

### Windows
1. Téléchargez le fichier `.exe` d'installation (ou la version portable) depuis la page **GitHub Releases** du dépôt (`Releases` → dernière version → `Leboncoin Scraper Pro Setup x.x.x.exe`).
2. Double-cliquez sur le `.exe` et suivez l'assistant d'installation (choix du dossier, raccourci bureau/menu démarrer).
3. Lancez **Leboncoin Scraper Pro** depuis le raccourci créé.
4. Au premier lancement, un écran d'information légal s'affiche : lisez-le et acceptez-le.
5. Le navigateur Chromium est **intégré à l'installeur** (aucun téléchargement au premier lancement). L'application vérifie sa présence et affiche un bandeau si le fichier est absent (installation incomplète).

> **Note** : les installeurs sont produits pour **Windows x64 uniquement**. Aucun build macOS ou Linux n'est fourni par la configuration actuelle (`electron-builder --win`). Sur Windows ARM64, l'émulation x64 de Windows 11 est nécessaire.

### Version portable
La version portable (`Leboncoin-Scraper-Pro-Portable-x.x.x.exe`) est un **exécutable autonome** : il n'y a rien à décompresser ni à installer. Double-cliquez simplement dessus pour lancer l'application. Les données sont alors écrites dans un dossier `output/` à côté de l'exécutable.

> Le démarrage d'un exécutable portable (~260 Mo) peut prendre quelques secondes : l'archive embarquée est décompressée dans un dossier temporaire au premier lancement.

### Vérifier l'intégrité du téléchargement (facultatif)
Chaque fichier `.exe` publié est accompagné de son empreinte SHA-256. Sous PowerShell :

```powershell
Get-FileHash ".\Leboncoin Scraper Pro Setup 1.0.0.exe" -Algorithm SHA256
```

Comparez la valeur obtenue avec celle publiée dans les notes de version.

### Emplacement des données
- **Version installée** : `Documents/Leboncoin Scraper Pro/`
- **Version portable / dev** : dossier `output/` à côté de l'exécutable.

---

## 🛠️ Installation pour les développeurs

### Prérequis
- [Node.js](https://nodejs.org/) (version récente, ≥ 18)
- npm (inclus avec Node.js)

### Installation

```bash
git clone <repo-url>
cd leboncoin-scraper-app
npm install
npx playwright install chromium
```

### Lancement

```bash
npm start
```

(`electron --max-old-space-size=8192 .` — 8 Go alloués à V8 pour les gros `.har`)

### Scripts disponibles

| Script | Commande | Rôle |
|---|---|---|
| `npm start` | `electron --max-old-space-size=8192 .` | Lance l'app de bureau en développement |
| `npm run start:web` | `node src/server/index.js` | Lance le **serveur Web** (Render-compatible) |
| `npm test` | `node test/regression.test.js` | Suite de non-régression (Electron) |
| `npm run test:server` | `node test/server.test.js` | Suite serveur / API / frontend Web |
| `npm run test:all` | `node test/regression.test.js && node test/server.test.js` | Les deux suites |
| `npm run browsers` | `node tools/prepare-browsers.js` | Télécharge le Chromium de la plateforme hôte dans `node_modules` |
| `npm run browsers:win` | `node tools/prepare-browsers.js --platform=win` | Télécharge le Chromium **Windows** (build croisé sur Linux/macOS) |
| `npm run icon` | `python3 tools/generate-icon.py` | Régénère `build/icon.ico` (nécessite Pillow) |
| `npm run hf:prepare` | `node tools/prepare-hf-space.js` | Assemble un dépôt prêt pour Hugging Face Spaces (`deploy/huggingface/`)|
| `npm run pack` | `electron-builder --dir` | Packaging local (non distribuable) — `prepack` prépare le Chromium |
| `npm run dist` | `electron-builder --win` | Génère l'installeur + la version portable Windows — `predist` prépare le Chromium Windows |
| `npm run build` | `electron-builder --win` | Alias de `dist` |
| — | `node tools/verify-dist.js` | Vérifie un build `dist/` et écrit les `.sha256` (utilisé par la CI) |

> Les scripts `prepack`/`predist`/`prebuild` (hooks npm automatiques) appellent `prepare-browsers.js` pour garantir que le Chromium embarqué correspond bien à la plateforme cible : sur un poste Windows, le Chromium hôte ; lors d'un build croisé Windows depuis Linux, le Chromium Windows (`--platform=win`).

---

## 📖 Guide d'utilisation

### Flux rapide

1. **URL** — collez l'URL d'une recherche Leboncoin dans l'onglet **Scraper**.
2. **Pages** — indiquez le nombre de pages à scraper.
3. **Profil** — choisissez un profil de données : **Défaut**, **Maximum** ou **Personnalisé**.
4. **Démarrer** — cliquez sur « Lancer le scraping ».
5. **CAPTCHA** (si apparaît) — résolvez-le manuellement dans la fenêtre qui s'ouvre. Le scraping reprend automatiquement une fois résolu.
6. **Explorer** — consultez les annonces dans l'onglet **Explorateur** (filtres, tri, fiche détaillée).
7. **Exporter** — les fichiers JSON et TXT sont générés automatiquement dans le dossier du job. Ouvrez-les depuis l'onglet **Historique**.

### Onglets

| Onglet | Description |
|---|---|
| 🚀 **Scraper** | Configuration du scraping (URL, pages, profil, vitesse, options) + presets 1-clic + progression temps réel. |
| 📜 **Logs** | Console de logs en direct (info/warn/error/debug) avec mode normal/debug, auto-scroll, copie, vidage, compteur. |
| 📁 **Historique** | Liste des scrapings passés + accès aux fichiers (JSON/TXT) + suppression. |
| 🔍 **Explorateur** | Filtres (mot-clé, prix, type de remise, type vendeur, note, likes, catégorie, ville), tri, vue tableau/grille, fiche détaillée. |
| 📊 **Statistiques** | Cartes colorées + 4 graphiques + carte Leaflet. |

### Paramètres

- **Thème** : 13 thèmes (aperçu temps réel).
- **Vitesse de scraping** : Moyen / Rapide / Ultra-rapide.
- **Délai entre les pages** (ms, défaut 1000).
- **Mode de capture** : invisible (headless) ou visible (sauf CAPTCHA qui bascule toujours en visible).
- **Données vendeur** : exclusion systématique des champs vendeur.
- **Nettoyage auto des .har** (jours, défaut 7).
- **Suppression auto des jobs** (optionnel).
- **Rétention des logs** (jours, défaut 7).

---

## 🏗️ Architecture

Architecture standard **Electron** (main + renderer) avec un **sous-processus** dédié au traitement lourd :

```
┌─────────────────────────────────────────────────────────────────┐
│                  PROCESSUS MAIN (Node.js)                        │
│  main.js → BrowserWindow + ipcHandlers                          │
│  ┌────────────┐   ┌───────────────┐   ┌────────────────┐        │
│  │ HarCapturer │   │ PipelineRunner │   │  JobHistory    │        │
│  │ (Playwright)│──▶│ (fork process) │──▶│  Manager       │        │
│  └────────────┘   └───────────────┘   └────────────────┘        │
│       │                  │                                        │
│       ▼                  ▼                                        │
│   capture.har      annonces.json + annonces.txt                  │
│                    (checksum SHA-256)                            │
│                                                                 │
│  ┌──────────────────────────────┐  ┌──────────────────────┐     │
│  │ FileManager (JSON/TXT)       │  │ Settings manager     │     │
│  └──────────────────────────────┘  └──────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
                            ▲ IPC (ipcMain ↔ ipcRenderer) ▼
┌─────────────────────────────────────────────────────────────────┐
│                PROCESSUS RENDERER (Chromium, sandboxé)           │
│  Sidebar navigation + modules (scraper/logs/history/explorer/   │
│  stats) + widget flottant                                       │
│  Exposé via preload.js (contextBridge → window.api)             │
└─────────────────────────────────────────────────────────────────┘
```

### Pourquoi un sous-processus (`fork`) pour le pipeline ?

`leboncoin-pipeline.js` est un script CLI Node.js autonome lancé via `child_process.fork()` depuis `pipelineRunner.js`. Cela permet :
- d'isoler le traitement lourd (parsing de gros `.har`, jusqu'à plusieurs centaines de Mo) du main process pour ne pas geler l'UI ;
- de tuer/interrompre proprement (`SIGINT`) sans affecter Electron ;
- de communiquer la progression via `stdout` (logs formatés `[done/total]`).

---

## 📁 Structure du projet

```
leboncoin-scraper-app/
├── package.json                          # Métadonnées, dépendances, scripts
├── Dockerfile                            # Image Web (Playwright 1.41.2 + Node)
├── render.yaml                           # Blueprint Render (service + disque)
├── .dockerignore / .env.example          # Contexte Docker / variables d'env
├── test/
│   ├── regression.test.js                # Suite de non-régression Electron
│   └── server.test.js                    # Suite serveur/API/frontend (Web)
└── src/
    ├── server/                           # 🆕 Backend Web (indépendant d'Electron)
    │   ├── index.js                      # Entrée serveur (0.0.0.0:PORT, arrêt propre)
    │   ├── app.js                        # Fabrique Express (CSP, JSON borné, statiques)
    │   ├── config.js                     # Config via variables d'environnement
    │   ├── db.js                         # SQLite (users, sessions, jobs, logs, settings)
    │   ├── auth.js                       # Sessions (cookie HttpOnly) + autorisation
    │   ├── security.js                   # Validation entrées + anti-SSRF
    │   ├── jobManager.js                 # File d'attente + exécution + annulation
    │   ├── logBus.js                     # Bus temps réel (SSE)
    │   ├── resultsService.js             # Lecture/nettoyage des résultats
    │   ├── maintenance.js                # Rétention (jobs/HAR) + purge sessions
    │   └── routes/api.js                 # Routes REST + SSE
    ├── main/                             # Processus principal Electron
    │   ├── main.js                       # Cycle de vie + fenêtres + single-instance lock
    │   ├── preload.js                    # Pont sécurisé Main ↔ Renderer (contextBridge)
    │   ├── widgetPreload.js              # Preload dédié au widget flottant
    │   ├── core/
    │   │   ├── ipcHandlers.js            # Tous les handlers IPC
    │   │   └── settings.js               # Persistance user-settings.json
    │   ├── config/
    │   │   └── constants.js              # Chemins, thèmes (require electron/app)
    │   ├── services/
    │   │   ├── scraping/
    │   │   │   ├── harCapturer.js         # Capture HAR via Playwright + pré-check/détection captcha
    │   │   │   ├── pipelineRunner.js     # Lance le pipeline en fork + parse stdout
    │   │   │   ├── leboncoin-pipeline.js # CLI : HAR → annonces + enrichissement descriptions
    │   │   │   ├── adFields.js           # Extracteurs centralisés (SCRAPING PUR)
    │   │   │   ├── errorCodes.js         # Codes d'erreurs structurés + classification
    │   │   │   └── userAgents.js         # 10 User-Agents réalistes en rotation
    │   │   ├── exporting/
    │   │   │   ├── exportFields.js       # Champs exportables + filtrage + TXT lisible
    │   │   │   └── dataProfiles.js       # 3 profils (Défaut/Maximum/Personnalisé)
    │   │   ├── analysis/
    │   │   │   └── adStats.js            # Statistiques de prix brutes
    │   │   ├── jobs/
    │   │   │   └── jobHistory.js         # Listing/lecture/suppression jobs (checksum)
    │   │   └── maintenance/
    │   │       └── storageCleaner.js     # Nettoyage .har + jobs (âge = timestamp dossier)
    │   ├── infrastructure/
    │   │   └── fileManager.js            # Ouverture fichiers/dossiers (explorateur)
    │   └── utils/
    │       ├── helpers.js                # sleep, atomicWriteFileSync, cleanText...
    │       ├── diagnostics.js            # redact, formatBytes, summarizeAds, describeError
    │       ├── integrity.js              # Checksum SHA-256 + écriture atomique
    │       ├── rateLimiter.js            # Rate limiting adaptatif (backoff)
    │       ├── logger.js                 # Logger rotatif quotidien + rétention
    │       ├── secretStore.js            # Secrets chiffrés (safeStorage + fallback AES)
    │       └── urlSecurity.js            # Validation d'URLs (http/https)
    └── renderer/
        ├── index.html                    # UI (sidebar, onglets, modales)
        ├── api.js                        # 🆕 Client API Web (window.api compatible)
        ├── authModule.js                 # 🆕 Connexion + reprise de tâche (Web)
        ├── widget.html                   # Widget flottant
        ├── app.js                        # Logique front-end (orchestration, sidebar)
        ├── appState.js                   # État global du renderer
        ├── utils.js                      # Utilitaires renderer (escapeHtml, etc.)
        ├── scraperModule.js             # Onglet Scraper (config, presets, profils)
        ├── logsModule.js                # Onglet Logs (console temps réel)
        ├── historyModule.js            # Onglet Historique (jobs)
        ├── explorerModule.js           # Onglet Explorateur (table, filtres, modal)
        ├── statsModule.js              # Onglet Stats (graphiques, carte)
        ├── helpModule.js                # Module d'aide (FAQ + guide + feedback)
        ├── styles.css                    # Habillage + 13 thèmes + stat-cards
        └── vendor/                       # Bibliothèques locales (Leaflet, Chart.js) — hors CDN
```

---

## 🗂️ Modèle de données

Chaque annonce normalisée (dans `annonces.json`) :

```jsonc
{
  "id": "2831923847",
  "title": "PC portable Gamer",
  "prix": 450,
  "url": "https://www.leboncoin.fr/ad/2831923847.htm",
  "city": "Lyon",
  "zipcode": "69000",
  "deliveryType": "livraison",   // les_deux | livraison | main_propre | aucun | inconnu
  "vendeurNom": "Jean D.",
  "vendeurType": "particulier",  // pro | particulier | null
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

### Champ `deliveryType` (unifié)

Remplace les anciens champs `livraison` / `mainPropre` par une seule valeur canonique :

| Valeur | Signification |
|---|---|
| `les_deux` | Livraison **et** remise en main propre |
| `livraison` | Livraison uniquement |
| `main_propre` | Remise en main propre uniquement |
| `aucun` | Ni livraison ni main propre |
| `inconnu` | Indéterminé (données indisponibles) |

### Profils de données

| Profil | Description | Champs |
|---|---|---|
| **Défaut** | Scraping rapide et léger | 13 champs essentiels (id, title, url, prix, ville, codePostal, deliveryType, datePublication, dateScraping, vendeurNom, vendeurType, photosCount, description) |
| **Maximum** | Toutes les données disponibles | Tous les champs exportables (~23 champs) |
| **Personnalisé** | Choix de l'utilisateur | Sélection granulaire par catégorie |

---

## 📦 Build (génération du .exe)

Le build utilise **electron-builder** (configuré dans `package.json`).

### Prérequis
- Node.js + npm installés.
- Dépendances installées (`npm install`).
- Chromium Playwright téléchargé **pour la plateforme cible** : `npm run browsers` (hôte) ou `npm run browsers:win` (Windows, y compris build croisé depuis Linux/macOS). Les hooks `predist`/`prebuild` l'exécutent automatiquement.

### Générer l'installeur Windows

```bash
npm run dist
```

Produit dans `dist/` :
- `Leboncoin Scraper Pro Setup x.x.x.exe` — installeur NSIS (choix du dossier, raccourcis).
- `Leboncoin-Scraper-Pro-Portable-x.x.x.exe` — version portable autonome.

### Vérifier un build

```bash
node tools/verify-dist.js --dir=dist
```

Contrôle que l'installeur, l'application packagée (`win-unpacked/` avec
`app.asar` et `ffmpeg.dll`) et le Chromium embarqué sont bien présents, que les
exécutables ont un en-tête PE valide et que l'installeur dépasse une taille
plancher. Le script écrit les empreintes `.sha256` et sort en code `1` si un
contrôle bloquant échoue — un build incomplet n'est jamais diffusé.

### Compilation automatique (recommandée)

Le build Windows est réalisé automatiquement par GitHub Actions
(`.github/workflows/build-windows.yml`), sur un runner **Windows** — c'est la
méthode la plus fiable : elle évite les problèmes de build croisé (Wine) et
l'erreur `Error: spawn UNKNOWN` observée lors de la génération du désinstalleur
sous Linux.

- **Push sur `main` / pull request / déclenchement manuel** → build de test,
  l'installeur est publié comme **artefact** téléchargeable de l'exécution
  GitHub Actions (rétention 14 jours).
- **Tag de version (`vX.Y.Z`)** → build puis **publication d'une GitHub Release**
  contenant l'installeur NSIS, la version portable et leurs empreintes
  `.sha256`.

### Publier une version ⭐

Pour publier une nouvelle version dans GitHub Releases :

```bash
# 1. mettre à jour la version dans package.json (ex. "1.0.1")
git commit -am "chore: release 1.0.1"
# 2. créer et pousser le tag de version
git tag v1.0.1
git push origin main v1.0.1
```

Le workflow se charge du reste : il compile sur Windows, vérifie l'installeur,
puis crée la Release **`v1.0.1`** et y joint les fichiers. Aucun jeton n'est
requis : le `GITHUB_TOKEN` fourni par GitHub Actions suffit (permission
`contents: write` accordée uniquement au job de publication).

> **Astuce** : un tag contenant un tiret (ex. `v1.0.1-beta.1`) crée une
> *pre-release* GitHub, utile pour les versions de test.

### Configuration electron-builder

- **Cible** : Windows x64 (NSIS + portable).
- **Chromium embarqué** : `extraResources` copie `node_modules/playwright-core/.local-browsers` (dont le Chromium **Windows**) dans `resources/browsers/` ; `main.js` pointe `PLAYWRIGHT_BROWSERS_PATH` vers ce dossier quand l'app est packagée.
- **Fichiers inclus** : `src/**/*`, `package.json`, `node_modules/playwright*/**/*`.
- **Icône** : `build/icon.ico` (multi-résolutions, régénérable via `npm run icon`).

> **Build croisé** : produire un installeur Windows depuis Linux nécessite **Wine** (édition des ressources de l'.exe via `rcedit`) et, sous Linux, `xvfb-run` (Wine a besoin d'un affichage). Exemple validé :
> ```bash
> export WINEPREFIX=/tmp/wineprefix WINEARCH=win64 XDG_RUNTIME_DIR=/tmp/runtime-openhands
> xvfb-run -a npm run dist
> ```
> Sur un poste Windows, `npm run dist` fonctionne directement, sans Wine.

### Packaging local (test, non distribuable)

```bash
npm run pack
```

---

## 🧪 Tests

`test/regression.test.js` — script Node.js autonome (sans framework externe), **suite complète** couvrant :

1. **utils** — diagnostics, helpers, integrity (checksum), rateLimiter, logger, secretStore, urlSecurity.
2. **Modules principaux** — AdStats, StorageCleaner, settings, exportFields, dataProfiles.
3. **Pipeline via fork** — crée un faux HAR, lance le vrai pipeline, vérifie l'extraction.
4. **Corrections & renderer** — fixes présents (mapInstance, escapeHtml, stats, gestion 429, escapePath).
5. **Architecture** — structure en couches, contrat IPC, widget, sandbox, verrouillage webview.
6. **Features** — intégrité SHA-256, rate limiting, logs rotatifs, secretStore, suppression auto jobs, mode hors-ligne, module d'aide (FAQ/Help/Feedback).
7. **Codes d'erreurs** — `errorCodes.js` (création, classification, tous les domaines).
8. **deliveryType** — `computeDeliveryType` (toutes les combinaisons livraison/mainPropre).
9. **Profils** — Défaut/Maximum/Personnalisé, filtrage, exclusion vendeur.

### Exécuter

```bash
npm test            # régression Electron (1317 tests)
npm run test:server # serveur / API / frontend Web (65 tests, moteur factice)
npm run test:all    # les deux suites
```

Résultat attendu : `=== RÉSULTAT : <N> réussis, 0 échoués ===`

> Le test installe des **stubs** pour `electron` et `playwright` afin de `require()` les modules en Node pur, sans lancer Electron/Chromium.
> `test/server.test.js` utilise un **moteur de scraping factice** (données contrôlées, aucune requête réseau) : création de tâche, progression, logs, annulation, résultats complets/partiels, 3 profils, exclusion vendeur, exports, isolation utilisateurs, erreurs, reconnexion, concurrence, rétention, responsive.

---

## ⚠️ Dépannage

### Chromium manquant
**Symptôme** : bandeau rouge au lancement, ou erreur « Executable doesn't exist » au démarrage d'un job.
**Solution** :
- En développement : `npx playwright install chromium`.
- En version installée : réinstallez l'application (le binaire Chromium est embarqué dans l'installeur).
- Cliquez sur « Revérifier » dans le bandeau rouge après installation.

### Erreurs 403 / 429
**Symptôme** : le scraping ou l'enrichissement s'arrête avec un message 403 (accès refusé) ou 429 (limitation de débit).
**Solution** :
- Leboncoin a refusé ou limité temporairement les requêtes. **Patientez quelques minutes** avant de relancer — aucune reprise automatique agressive n'est faite (le `Retry-After` du serveur est respecté lorsqu'il est fourni).
- Réduisez la vitesse (Moyen au lieu de Rapide) : la concurrence et les délais par défaut sont volontairement modérés pour limiter les rafales de requêtes.
- Après 3 blocages 403/429 consécutifs, l'enrichissement s'arrête automatiquement et **sauvegarde les annonces déjà extraites**.
- Le job est alors signalé « **succès partiel** » (jamais « succès ») : les annonces restent exportables même si certaines descriptions manquent.
- Aucun contournement (proxy d'évasion, rotation d'identité) n'est utilisé : le refus est rapporté tel quel.

### CAPTCHA
**Symptôme** : une fenêtre visible s'ouvre avec un captcha (Arkose/FunCaptcha/Cloudflare).
**Solution** :
- Résolvez le captcha manuellement dans la fenêtre.
- L'application détecte automatiquement la disparition du défi (polling du contenu toutes les 2s + confirmation anti-faux-positif), **puis vérifie réellement l'accès** (statut HTTP de la ressource) avant de reprendre.
- Si l'accès reste refusé (HTTP 403/429) malgré la disparition visuelle du défi, l'opération s'arrête proprement avec un message explicite — aucun job « réussi » trompeur et aucune boucle de fenêtres.
- La session n'est persistée que si l'accès est effectivement confirmé.

### Session expirée
**Symptôme** : un job qui fonctionnait ne capture plus rien.
**Solution** :
- La session globale (`global-session.json`) peut être périmée. Supprimez-la (dans le dossier de données) pour forcer une nouvelle session.
- Au prochain lancement, un captcha peut apparaître pour valider la nouvelle session.

### Données nulles
**Symptôme** : certains champs sont `null` dans le JSON.
**Explication** : tout champ non trouvé est `null` (jamais inventé). C'est normal si Leboncoin ne expose pas l'information pour une annonce donnée (ex: note vendeur absente, date de modification absente).

---

## ⚖️ Avertissement légal

Ce logiciel est fourni en tant qu'outil technique d'automatisation et d'analyse. L'utilisateur est seul responsable de son utilisation, notamment en ce qui concerne :

- le respect des conditions d'utilisation des sites concernés ;
- le respect des lois applicables en matière de collecte, de traitement et de conservation de données ;
- le respect du droit à la vie privée et des réglementations sur la protection des données personnelles.

Ce logiciel ne fournit aucune autorisation d'accès ou de réutilisation des données de sites tiers. Le fait de pouvoir techniquement accéder à des données ne signifie pas que l'utilisateur est autorisé à les collecter, les conserver, les analyser ou les réutiliser.

Le développeur ne prétend pas que Leboncoin ou tout autre site tiers autorise officiellement ce logiciel, sauf mention expresse et écrite contraire.

Pour plus de détails, consultez :
- [`LEGAL.md`](LEGAL.md) — informations légales et responsabilités.
- [`docs/DATA_HANDLING.md`](docs/DATA_HANDLING.md) — gestion des données, transparence et minimisation.
- [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) — guide utilisateur pas à pas.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — architecture technique.
- [`docs/FAQ.md`](docs/FAQ.md) — questions fréquentes.
