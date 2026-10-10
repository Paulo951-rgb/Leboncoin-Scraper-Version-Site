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

- `node test/regression.test.js` → **813 réussis, 0 échoués** (base : 777).
- Ajouts : médiane AdStats, exit codes pipeline (1 = erreur CLI, 2 = aucune
  donnée), profil Défaut de bout en bout (fork réel), annulation `cancelled`,
  `urlSecurity` (IPv4 privées, IPv6 loopback/ULA/link-local, IP publiques),
  absence d'imports morts.

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
