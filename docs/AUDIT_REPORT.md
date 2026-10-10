# Rapport d'audit — Leboncoin Scraper Pro

*Date : 2026-10-10*
*Branche : `audit/stabilization-2026` (base `main` @ `b15c978`)*
*Nature : audit de stabilisation, de sécurité et d'intégrité des données.*

> Ce rapport ne contient que des constats adossés à une lecture du code, à une
> commande exécutée ou à un test automatisé. Les contrôles qui n'ont pas pu être
> exécutés dans cet environnement sont explicitement signalés (section « Limites »).

---

## 1. Périmètre

Modules examinés :

- Processus principal Electron : `src/main/main.js`, `preload.js`, `widgetPreload.js`.
- IPC : `src/main/core/ipcHandlers.js`.
- Config / persistance : `src/main/config/constants.js`, `src/main/core/settings.js`.
- Scraping : `harCapturer.js`, `pipelineRunner.js`, `leboncoin-pipeline.js`,
  `adFields.js`, `errorCodes.js`, `userAgents.js`.
- Export / analyse : `exportFields.js`, `dataProfiles.js`, `adStats.js`.
- Jobs / maintenance : `jobHistory.js`, `storageCleaner.js`.
- Infrastructure / utils : `fileManager.js`, `helpers.js`, `diagnostics.js`,
  `integrity.js`, `rateLimiter.js`, `logger.js`, `secretStore.js`, `urlSecurity.js`.
- Renderer : `app.js`, `appState.js`, `utils.js`, `scraperModule.js`,
  `explorerModule.js`, `statsModule.js`, `historyModule.js`, `logsModule.js`,
  `helpModule.js`, `index.html`, `widget.html`, `styles.css`.
- Tests : `test/regression.test.js`.
- Documentation : `README.md`, `AGENTS.md`, `LEGAL.md`, `docs/*.md`.

## 2. Outils et commandes utilisés

| Contrôle | Commande | Résultat |
|---|---|---|
| Suite de non-régression | `node test/regression.test.js` | **813 réussis, 0 échoués** |
| Syntaxe de tous les `.js` | `node --check <fichier>` sur `src/**` et `test/**` | 0 erreur |
| Recherche d'imports morts | script AST-light sur les `require()` déstructurés | 2 trouvés, corrigés |
| Correspondance IPC | comparaison `ipcMain.handle/on` ↔ `preload` | 100 % apparié (après 3 corrections) |
| Handlers `onclick` | croisement `onclick="…"` ↔ `window.<fn>` | 100 % résolu |
| Références mortes | `grep` sur les modules supprimés | 1 commentaire obsolète corrigé |

## 3. Problèmes confirmés et corrigés

### 3bis. Phase 3 — audit global A→Z (constatés et corrigés)

| ID | Prio | Fichier / zone | Constat | Cause racine | Correctif | Test |
|---|---|---|---|---|---|---|
| P3-1 | **P1** | `renderer/app.js` | Navigation par onglets totalement morte (Logs/Historique/Explorateur/Stats inaccessibles) | Écouteurs attachés sur `.tab-btn`, classe remplacée par `.nav-item` lors de la refonte de la sidebar → aucun élément ne correspondait | Sélecteur `[data-tab]` | `[20a]` |
| P3-2 | **P1** | `scraping/leboncoin-pipeline.js` | `raw` (objet brut, multi-Ko) et `extractionErrors` exportés en profil Maximum ; `livraison`/`mainPropre` exposaient les champs internes | `filterAdByFields` renvoie l'objet tel quel quand `fields=null` | `stripInternalFields` avant toute écriture | `[20b]` + fork |
| P3-3 | **P1** | `core/settings.js` | `config:save` fusionnait n'importe quel objet renderer dans `user-settings.json` | Aucune validation du patch | `sanitizeSettingsPatch` (clés connues, type/plage) | `[22]` |
| P3-4 | P2 | `scraping/errorCodes.js` | `ErrorCodes.UNKNOWN` référencé mais absent → `[undefined]` | Code non défini | Ajout de `UNKNOWN` | `[20d]` |
| P3-5 | P2 | `renderer/index.html` | `#statMedPrice` et `#structureWarning` référencés par le JS mais absents du DOM | Refonte HTML incomplète | Éléments ajoutés | `[20c]` |
| P3-6 | P2 | `renderer/app.js` | `applySellerDataVisibility()` jamais appelée → colonne vendeur jamais masquée | Câblage manquant | Appel au chargement + chargement config | `[20f]` |
| P3-7 | P2 | `renderer/scraperModule.js` | Bandeau `structureWarning` jamais masqué (persistait à l'infini) | Aucun reset | Réarmé à chaque run | `[21c]` |
| P3-8 | P2 | `renderer/statsModule.js` | Graphiques fantômes (session précédente) sur session vide | `return` sans `destroy()` | Destruction des instances | `[21d]` |
| P3-9 | P2 | `renderer/explorerModule.js` | Vue vide après suppression du job sélectionné | Valeur `<select>` inexistante restaurée | Repli sur `ALL` | `[21a]` |
| P3-10 | P2 | `core/ipcHandlers.js` | `maxPages` pouvait valoir `NaN`/`0` → pagination illimitée | `parseInt` non borné | Bornage `[1,500]` | `[21b]` |
| P3-11 | P2 | `main.js` | `webviewTag: true` inutile (aucun `<webview>`) | Vestige du module IA Studio | Désactivé ; handler conservé | `[20e]` |
| P3-12 | P3 | `services/jobs/jobHistory.js` | Détection likes morte (chemins inexistants) | Modèle v1 vs v3 | Champ réel + replis rétro-compat | `[20g]` |
| P3-13 | P2 | `renderer/historyModule.js` | Badge « Personnalisé » jamais affiché | Renderer lit `exportMeta.exportMode` mais le pipeline écrit `profileId` (v2) | Lecture `profileId` (repli `exportMode`) ; normalisation dans `jobHistory` | `[24]` |
| P3-14 | P2 | `docs/DATA_HANDLING.md`, `helpModule.js` | Déclaration réseau incomplète (omet les CDN d'interface + tuiles OSM) | Doc non tenue à jour | Reformulation honnête | lecture |

### 3ter. Phase 1/2 (audit de stabilisation)

### P1-1 — L'annulation d'un job était rapportée comme un succès

- **Fichiers** : `src/main/core/ipcHandlers.js`, `src/renderer/scraperModule.js`.
- **Constat** : un clic « Arrêter » pendant/après la capture HAR aboutissait à
  `sendStatus({ state: 'completed', message: 'Scraping terminé avec succès !' })`
  et le pipeline d'enrichissement était quand même lancé.
- **Cause racine** : la branche de finalisation ne testait jamais
  `activeCancel.cancelled`. `activeCancel` était écrit mais jamais lu.
- **Correctif** : après la capture, si `activeCancel.cancelled` → arrêt immédiat
  avec une erreur marquée `_cancelled` ; le `catch` émet un état dédié
  `state: 'cancelled'` (ni succès ni erreur). Le renderer traite `cancelled`
  comme un état terminal (réactive les boutons).
- **Test** : bloc `[3b2]` de `test/regression.test.js`.

### P2-1 — Liste des catégories de champs incohérente entre UI et pipeline

- **Fichiers** : `src/main/services/exporting/exportFields.js`, `leboncoin-pipeline.js`.
- **Constat** : l'UI construisait la liste des champs depuis `FIELD_CATEGORIES`
  (clés « métier » : `ville`, `codePostal`, `vendeurNbAvis`, `vendeurAnciennete`),
  mais `filterAdByFields` copiait `out[key] = ad[key]` alors que le modèle
  produit par `normalizeAd()` expose `city`, `zipcode`, `nombreAvis`,
  `vendeurAncienneteJours`. Ces champs étaient donc silencieusement perdus en
  profils Défaut et Personnalisé.
- **Correctif** : table `MODEL_KEY_FOR_EXPORT` + `_resolveRawFieldValue()` qui
  traduit la clé d'export vers la clé du modèle, avec repli rétro-compatible.
- **Test** : bloc `[3c]` (export réel via fork) + tests unitaires de `filterAdByFields`.

### P2-2 — Médiane fausse pour un nombre pair de prix

- **Fichier** : `src/main/services/analysis/adStats.js`.
- **Constat** : la médiane renvoyait la valeur centrale basse sur une série paire.
- **Correctif** : ajout de `medianPrice` (moyenne des deux valeurs centrales
  pour une longueur paire), aligné sur le calcul du renderer.
- **Test** : additions AdStats dans la suite.

### P2-3 — Timeouts `fetch` sans libération de timer / AbortController

- **Fichier** : `leboncoin-pipeline.js`.
- **Constat** : vérifié que chaque `fetch` passe par un `AbortController` +
  `setTimeout` avec `clearTimeout` en `finally`. Les chemins d'erreur sont couverts.
- **Statut** : conforme, aucune correction nécessaire ; test de présence ajouté.

### P3-1 — Colonne « Vendeur » non masquée en mode « données vendeur OFF »

- **Fichiers** : `explorerModule.js`, `index.html`, `styles.css`, `app.js`.
- **Constat** : le sélecteur `th[style*="Vendeur"]` était fragile, la cellule
  vendeur n'avait pas de classe dédiée.
- **Correctif** : classes `col-vendeur` / `cell-vendeur` + sélecteurs CSS.

### P3-2 — Filtre « État » de l'explorateur vide

- **Fichier** : `explorerModule.js`.
- **Constat** : `populateEtatFilter` lisait `a.produit?.etat` alors que la
  structure v3 est plate (`a.etat`).
- **Correctif** : lecture de `a.etat`.

## 4. Sécurité — constats

| Sujet | Constat | Action |
|---|---|---|
| `contextIsolation` / `nodeIntegration` / `sandbox` | Conformes (true/false/true) sur toutes les fenêtres, y compris webview via `will-attach-webview`. | Vérifié |
| Ouverture de liens externes | `shell:openExternal` filtré http/https via `urlSecurity`. | Vérifié |
| Navigation / `window.open` | Durci : navigation et `window.open` refusés (widget + fenêtre principale) sauf origine interne. | Corrigé |
| SSRF `urlSecurity.js` | Ajout `isPrivateIPv6` (loopback, ULA `fc00::/7`, link-local `fe80::/10`, `::`, IPv4-mappées) + `isBlockedIpLiteral` câblé dans `validateRemoteUrl`. | Corrigé |
| Secrets (`secretStore.js`) | Politique honnête à deux niveaux : `safeStorage` préféré, repli AES-256-GCM avec **avertissement explicite** que la clé est dérivée d'infos machine publiques (protection réduite). | Corrigé |
| XSS attributs | `escapeHtml()` pour `src`, `escapePath()` (double contexte HTML+JS) pour `onclick`. | Vérifié |
| Fuite de secrets dans les logs/exports | `diagnostics.redact()` masque les préfixes sensibles ; les secrets ne sont pas exportés. | Vérifié |

**Limite importante** : `urlSecurity.validateRemoteUrl()` n'est **pas** sur le
chemin d'exécution Playwright. La protection réseau réelle des `fetch` du
pipeline repose sur l'allowlist stricte `ALLOWED_FETCH_HOSTS`
(`leboncoin.fr`/`.com`, `leboncoindirect.com` + sous-domaines). Toute future
utilisation de `validateRemoteUrl` pour un fetch doit refuser en l'absence de
résolution DNS (fail-closed) — c'est documenté dans le code.

## 5. Code mort / hygiène

| Élément | Emplacement | Décision |
|---|---|---|
| `import Notifier` (module supprimé) | `ipcHandlers.js` | Supprimé |
| `src/main/infrastructure/notifications.js` | infrastructure | Fichier supprimé (aucune référence) |
| `FIELD_CATEGORIES` importé mais non utilisé | `dataProfiles.js` | Import retiré |
| `userAgent` / `sessionStats` toujours `undefined` | `ipcHandlers.js` | Corrigé (capture UA via getter `HarCapturer`) |
| Commentaire « notifications système » | `README.md`, `AGENTS.md` | Corrigé |

## 6. Tests exécutés

- `node test/regression.test.js` → **920 réussis, 0 échoués** (base : 777 →
  813 phase 1/2 → 861 → 894 → 898 → 901 → 913 → 920 phase 3).
- Phase 3 — ajouts : `[20]` navigation `[data-tab]`, absence de fuite interne
  (`raw`/`extractionErrors`/`livraison`/`mainPropre`) + vérification par fork
  réel, présence des éléments DOM (`statMedPrice`, `structureWarning`),
  `ErrorCodes.UNKNOWN`, `webviewTag:false`, appel `applySellerDataVisibility`,
  repli likes `[21]` dropdown sans ID fantôme, bornage `maxPages`, reset bandeau
  structure, destruction des graphiques `[22]` validation des paramètres
  (clés inconnues, plages, énumérations, booléens stricts), `[23]` parité des
  champs exportables renderer ↔ main process, `[24]` contrat `export-meta`,
  `[25]` contrat DOM statique (IDs `index.html` + cibles `[data-tab]`), `[26]`
  contrat IPC preload ↔ handlers main.
- Phase 3 — corrections d'assertions obsolètes : deux assertions exigeaient la
  présence de `livraison`/`mainPropre` dans les exports et une exigeait
  l'**absence** de `structureWarning`. Ces attentes contredisaient le modèle
  documenté (`deliveryType` uniquement) et l'UI (le bandeau doit exister) ;
  corrigées vers l'attendu réel.
- Phase 1/2 — ajouts : médiane AdStats, exit codes pipeline (1 = erreur CLI,
  2 = aucune donnée), profil Défaut de bout en bout (fork réel), annulation
  `cancelled`, `urlSecurity` (IPv4 privées, IPv6 loopback/ULA/link-local, IP
  publiques), absence d'imports morts.

## 7. Limites de l'audit

- **Aucun test d'interface graphique réel** : pas de framework UI en place, et
  l'environnement est un conteneur sans affichage. Les modules renderer sont
  vérifiés par lecture + syntaxe + tests d'invariants, pas par exécution DOM.
- **Aucun build `.exe` Windows** : `electron-builder --win` n'est pas exécutable
  ici (pas de wine/Windows). La configuration `build` de `package.json` a été
  relue mais l'installeur n'a pas été généré ni lancé.
- **Aucun scraping Leboncoin réel** : le réseau et le site ne sont pas sollicités.
  Les tests du pipeline utilisent un HAR synthétique.
- Les tests « dal » de stubs Electron ne remplacent pas un lancement réel.
