# Changelog — Leboncoin Scraper Pro

Format inspiré de [Keep a Changelog](https://keepachangelog.com/). Les entrées
décrivent des modifications vérifiées (code + tests).

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
