# Rapport de phase 2 — Finalisation de la stabilisation

*Date : 2026-10-10*
*Branche : `audit/stabilization-2026` (non poussée)*
*Base de phase 1 : commit `8d223c9` (861 assertions en fin de phase 1).*

Ce rapport prolonge `docs/AUDIT_REPORT.md`. Chaque contrôle indique la commande
exacte et le résultat obtenu. Aucun « succès » n'est déclaré sans commande exécutée.

---

## État Git de départ (vérifié)

```
git rev-parse --abbrev-ref HEAD   → audit/stabilization-2026
git log --oneline -1              → 8d223c9 audit: stabilisation, sécurité et intégrité des données
git status --porcelain            → (propre)
```

## Étape 1 — Sécuriser le chemin réseau Playwright (KI-3)

### Constat précis

En phase 1, `validateRemoteUrl` était corrigée mais **non câblée** sur les
chemins de navigation Playwright. Analyse des chemins :

| Chemin réseau | Était validé ? |
|---|---|
| `HarCapturer.capture()` → `page.goto(searchUrl…)` (URL fournie par l'utilisateur) | **Non** |
| `_warmupSession()` → `goto(checkUrl)` | **Non** |
| Sous-ressources / redirections Chromium | **Non** |
| `DescriptionEnricher` → `isFetchUrlAllowed()` (allowlist) | Oui |
| `pipelineRunner` → `fetch` (documents) | Oui |

Le trou réel : **l'URL de recherche** saisie par l'utilisateur pouvait pointer
vers n'importe quelle destination, y compris `http://169.254.169.254/…`,
`http://127.0.0.1/…` ou un domaine arbitraire (SSRF).

### Correctifs

1. **`src/main/utils/urlSecurity.js`**
   - `isHostAllowed(hostname, allowlist)` : domaine inclusif (exact + sous-domaines),
     corrige le contournement par suffixe trompeur (`leboncoin.fr.attacker.com`).
   - `isSafeFetchDestination(url, allowlist?)` : contrôle **synchrone** et
     fail-closed (protocole http(s) uniquement, IP littérales privées/loopback/
     link-local IPv4 **et IPv6**, hostnames locaux, allowlist optionnelle).
   - Correction : `URL.hostname` de Node conserve les crochets `[::1]` → retrait
     des crochets avant `net.isIP`, sinon les IPv6 littérales privées passaient.
   - `validateRemoteUrl` rendue **fail-closed** : résolution DNS vide/échouée → refus.

2. **`src/main/services/scraping/harCapturer.js`**
   - `capture()` refuse (avant tout lancement de navigateur) une `searchUrl` qui
     n'est pas un domaine Leboncoin légitime ou qui vise une IP interdite
     (`LEBONCOIN_SOURCE_HOSTS`, allowlist).
   - `_installNetworkGuard(ctx)` : interception `ctx.route('**/*')` de toutes les
     sous-requêtes, blocage des destinations structurellement dangereuses
     (défense en profondeur). Installée dans `_newStealthContext`, donc active
     pour la capture **et** l'enrichissement Playwright.

### Limite assumée (défense en profondeur)

`isSafeFetchDestination` ne fait **pas** de résolution DNS (impossible dans le
callback `route` sans blocage). Un hostname arbitraire résolvant vers une IP
privée (DNS rebinding) n'est donc pas détecté dans les sous-ressources. Ce point
est documenté dans le code. La protection réelle de l'entrée utilisateur
contrôlée est, elle, appliquée (allowlist stricte).

### Tests ajoutés (`test/regression.test.js`)

- `isSafeFetchDestination` : Leboncoin autorisé, CDN autorisé ; `file:`/`ftp:`/
  `data:`/`javascript:` refusés ; `127.0.0.1`/`169.254.169.254`/`10.0.0.5`/
  `[::1]`/`[fe80::1]`/`[::ffff:127.0.0.1]` refusés ; `localhost`/`.local`/
  `.internal` refusés ; allowlist (y compris suffixe trompeur).
- `validateRemoteUrl` : protocoles non http(s), IP privée littérale, DNS vide → fail-closed.
- Câblage `harCapturer` : présence du contrôle d'URL, de l'allowlist, du route-guard.

**Résultat : `node test/regression.test.js` → 843 réussis, 0 échoués.**

## Étape 2 — Audit des dépendances

Commandes : `npm audit --package-lock-only`, `npm outdated`, `npm install --package-lock-only --ignore-scripts`.

### Vulnérabilités initiales : 17 (4 modérées, 12 élevées, 1 critique)

| Paquet | Gravité | Type | Correctif | Applicable ici ? |
|---|---|---|---|---|
| `tar` | **critique** | transitive (electron-builder) | electron-builder@26.15.3 (majeur) | Non (build dev) |
| `playwright` | élevée | **directe** | playwright@1.64.0 | Non (majeur, voir ci-dessous) |
| `electron` | élevée | **directe** | electron@44.7.0 (majeur) | Non sans revue |
| `electron-builder` + `app-builder-lib`, `builder-util`, `builder-util-runtime`, `dmg-builder`, `electron-publish`, `electron-builder-squirrel-windows` | élevée | directe/transitives | electron-builder@26.15.3 (majeur) | Non (build dev) |
| `@electron/get`, `global-agent`, `roarr`, `sprintf-js` | modérée | transitives (electron) | electron@44.7.0 | Non |
| `brace-expansion` | élevée | transitive | dans la plage | **Oui** |
| `http-cache-semantics` | élevée | transitive | dans la plage | **Oui** |

### Mises à jour justifiées appliquées (lockfile uniquement)

`npm audit fix --package-lock-only` :

- `brace-expansion` 2.1.4 → 2.1.7 et copies 1.1.18 → 1.1.21 (DoS récursif) ;
- `http-cache-semantics` 4.2.0 → 4.3.0 (fuite de cache inter-utilisateur).

**Résultat : 15 vulnérabilités restantes** (contre 17), toutes corrigeables
uniquement par des mises à jour majeures. Aucun code applicatif modifié
(lockfile seul) ; `node test/regression.test.js` → **843 réussis**.

### Décisions argumentées

- **Playwright 1.41 → 1.64 (non appliqué)** : changerait la version de Chromium et
  son chemin `extraResources` (`.local-browsers`), non validable par un scraping
  réel ici. À traiter dans un lot dédié avec campagne de capture. La CVE est
  « téléchargement sans vérification du certificat TLS » — **hors** du chemin
  d'exécution de l'app (aucun `playwright install` au runtime).
- **Electron/electron-builder (non appliqué)** : mises à jour majeures
  (API/preload/NSIS). Les CVE concernent surtout le build (outils de dev non
  embarqués dans le binaire final), mais Electron embarque un Chromium ancien.
  À planifier comme lot dédié avec tests de packaging Windows. **Vulnérabilités
  restantes documentées** dans `docs/KNOWN_ISSUES.md`.

## Étape 3 — Build Windows

Contrôles (lecture + commandes) :

- `package.json` → `build` : cibles `nsis` + `portable`, arch `x64`, icône
  `build/icon.ico`, `extraResources` copie `node_modules/playwright-core/.local-browsers` → `browsers/`.
- `src/main/main.js` : `PLAYWRIGHT_BROWSERS_PATH` pointé vers `process.resourcesPath/browsers`
  si packagé et si le dossier existe. ✅
- `src/main/config/constants.js` : `BASE_OUT_DIR` en `Documents/Leboncoin Scraper Pro`
  (hors dossier d'installation) si packagé. ✅ Bonne pratique : lancement possible
  depuis un répertoire différent du dépôt.
- **Problème trouvé (P2, packaging)** : `build/icon.ico` est **référencé mais
  absent** du dépôt (`build/` n'existe pas). Conséquence : en mode portable,
  electron-builder **échec** (« icon.ico not found ») ; en NSIS, repli sur
  l'icône par défaut d'Electron (avertissement, build non bloqué).
- **Non vérifié ici** : la génération réelle du `.exe` nécessite Windows (ou Wine
  + NSIS) absent de l'environnement. `npm run dist` **non exécuté**. Il n'est donc
  **pas** affirmé que l'installeur fonctionne.

## Étape 4 — Tests d'intégration et scénarios d'erreur

Ajoutés (fixtures déterministes, sans dépendance au site réel) :

| Scénario | Résultat |
|---|---|
| HAR absent | code de sortie non nul (pas de faux succès) |
| HAR invalide (JSON corrompu) | code de sortie non nul |
| Données invalides (`{}`) | **exit 2**, aucune annonce inventée |
| `PipelineRunner` HAR absent | rejet structuré `[CODE] …` |
| `PipelineRunner` annulation | `resolve(130)`, log « Interruption demandée » |
| Résultats partiels | `annonces.json` écrit avant enrichissement, préservé malgré l'échec |

**Résultat cumulé : `node test/regression.test.js` → 861 réussis, 0 échoués.**

## Étape 5 — Validation de l'annulation et des données

### Bug P1 résiduel trouvé et corrigé (annulation pendant l'enrichissement)

- **Constat** : `activeRunner.run()` renvoie `130` sur annulation, mais
  `ipcHandlers` **ignorait la valeur de retour** → une annulation pendant
  l'enrichissement était rapportée « Scraping terminé avec succès ! ».
- **Preuve** : lecture de `ipcHandlers.js` (avant correctif) — `await activeRunner.run(...)`
  sans capture du code. Test `[3e]` : le runner renvoie bien `130`.
- **Correctif 1** (`ipcHandlers.js`) : `const pipelineExit = await … ; if (pipelineExit === 130) throw {_cancelled}`.
- **Correctif 2** (`leboncoin-pipeline.js`) : handler coopératif `SIGINT`
  (le runner envoie `SIGINT`) → `cancelled = true`, sortie de boucle propre,
  `writeOutputs(ads)` partiel, fermeture du navigateur ; handler retiré en `finally`.
- **Tests** : `[3b2]` (câblage 130 + handler SIGINT) et `[3f]` (préservation partielle).

### Validations de données

- Annulation jamais un succès : couvert par `[3b2]`, `[3e]`, `[3f]`.
- Aucun enrichissement après annulation pendant la capture : `[3b2]` (test du throw).
- Résultats partiels + statut final correct : `[3f]`.
- Exports/profils/médiane sur plusieurs jeux : `[3c]` (profil Défaut réel),
  `[3]` (profil Maximum), et 4 nouveaux cas limites de médiane (paire 2 valeurs=8,
  singleton, série constante, non trié).

## Étape 6 — Contrôles finaux

- `node test/regression.test.js` → **861 réussis, 0 échoués**.
- `node --check` sur tous les fichiers modifiés → 0 erreur.
- Diff Git limité aux fichiers liés aux objectifs.

### Décision

**Partiellement stabilisée → prête pour des tests utilisateurs, mais PAS
candidate à une release stable.** Justification :

- Nouveau P1 (annulation pendant l'enrichissement) **corrigé et testé**.
- Sécurité réseau Playwright **câblée** (KI-3 résolu) + défense en profondeur.
- 861 assertions vertes, aucune régression.

Ce qui **manque** pour une release stable (à faire sur une machine Windows) :

1. **Génération et lancement réels du `.exe`** (`npm run dist`, installeur lancé,
   vérif `resources/browsers/`). **Non exécuté ici.**
2. **Validation de l'icône** `build/icon.ico` (absente → portable échoue).
3. **Campagne d'interface manuelle** (démarrage, arrêt, suppression job, thème,
   hors-ligne) — pas de framework UI dans l'environnement.
4. **Mises à jour majeures** Electron/Playwright (CVE) — lot dédié.

Aucune branche poussée, aucune PR créée.
