# Audit complet — accès réel, HTTP 403/429, états honnêtes

*Date : 2026-10-10*
*Base : `main` @ `fefc7f1`*
*Nature : audit complet (dépôt entier), corrections ciblées, tests de non-régression.*

> Méthode : chaque constat est adossé à une lecture du code réel, à une commande
> exécutée et/ou à un test automatisé. Les contrôles impossibles dans cet
> environnement (Windows, CAPTCHA réel) sont explicitement signalés.

---

## 0. État Git de départ

```
git rev-parse --abbrev-ref HEAD   → main
git status --porcelain            → (propre)
git log --oneline -1              → fefc7f1 (grafted) Merge pull request #21
git rev-parse --is-shallow-repository → true
```

Référence obsolète corrigée : le dépôt mentionnait `Excel` et `Ollama/Gemini` ;
l'état réel (AGENTS.md + code) est **scraping pur, sans IA, sans Excel** (exports
JSON/TXT). Aucune IA n'a été trouvée dans le code.

---

## 1. Diagnostic — problèmes confirmés

| ID | Gravité | Fichier / fonction | Cause technique exacte | Conséquence utilisateur | Correction | Test |
|----|---------|--------------------|------------------------|-------------------------|-----------|------|
| **P1** | **Critique** | `harCapturer.js` `_warmupSession` | Le CAPTCHA était déclaré « résolu » sur la seule **disparition visuelle** du défi (iframe/texte/URL). Aucune vérification du statut HTTP. Un 403 persistant n'était pas détecté. | Session déclarée valide alors que le serveur refuse encore l'accès → job « réussi » avec 0 donnée. | `_verifyAccess()` : requête autorisée (`page.request.get`) + jugement sur le **statut HTTP réel** et le contenu. 403/429 = jamais un succès. | `[30]` (`_verifyAccess` unitaire) |
| **P2** | **Élevée** | `harCapturer.js` `capture()` | À chaque page bloquée, la capture rouvrait une fenêtre visible (`_warmupSession`) et reprenait **sans vérifier l'accès réel** → fenêtres en chaîne. | Boucles de fenêtres CAPTCHA, reprises répétées qui échouent immédiatement. | Reprise UNIQUEMENT si `_warmupSession` renvoie `verified === true` ; sinon `break` propre. | `[30]` + statique |
| **P3** | **Élevée** | `leboncoin-pipeline.js` `fetchBatchInPage`/`enrichAll` | 403 et 429 étaient confondus dans un seul code `BLOCKED_403` ; `Retry-After` ignoré. | Impossibilité de distinguer un refus d'une limitation, reprise inadaptée. | `BLOCKED_429` distinct, `Retry-After` capturé, codes structurés `HTTP_ACCESS_REFUSED`/`HTTP_RATE_LIMITED`. | `[30]` |
| **P4** | **Élevée** | `ipcHandlers.js` + `pipelineRunner.js` + pipeline | Un 403/429 pendant l'enrichissement aboutissait à « **Scraping terminé avec succès** » (exit 0). | Faux succès alors que l'enrichissement a échoué. Résultats partiels non signalés. | Exit codes `3` (403) / `4` (429), état `partial`, `annonces.json` partiel préservé et signalé. | `[3g]`, `[30]` |
| **P5** | **Moyenne** | `harCapturer.js` `capture()` + `ipcHandlers` | La capture renvoyait un chemin de HAR sans indiquer si des pages avaient été réellement exploitées ; un HAR vide était passé au pipeline. | Un HAR vide (capture bloquée) produisait une erreur générique au lieu d'un message d'accès. | Résultat structuré `{ pagesCaptured, blocked, blockedCode, httpStatus }` ; `ipcHandlers` court-circuite le pipeline si accès non confirmé (états `refused`/`rate_limited`). | `[30]` |
| **P6** | **Faible** | `scraperModule.js` / `widget.html` | Seuls `completed`/`error`/`cancelled` étaient terminaux ; les nouveaux états auraient laissé les boutons bloqués. | Boutons « démarrer » inactifs après un refus/limitation. | Tableau `terminalStates` étendu (`partial`, `refused`, `rate_limited`). | `[30]`, `[3b2]` |

### Points vérifiés et jugés SAINS (pas de changement)

- Parser HAR, extracteurs (`adFields.js`), déduplication, profils d'export,
  intégrité SHA-256, sécurité réseau (`urlSecurity`), vérification d'URL Playwright,
  annulation coopérative SIGINT, cycle de vie Electron / single-instance.
- `fetchBatchInPage` : le code mort `stats`/`IGNORED` dans `getJsonResponses` n'a
  pas été touché (hors périmètre, fonctionnel).
- Aucune IA, aucun Excel (conforme à la documentation du dépôt).

---

## 2. Corrections — fichiers modifiés

| Fichier | Changement |
|---------|-----------|
| `src/main/services/scraping/errorCodes.js` | Codes `HTTP_ACCESS_REFUSED`, `HTTP_RATE_LIMITED`, `ACCESS_UNVERIFIED`, `CAPTCHA_NOT_CONFIRMED` ; classification associée. |
| `src/main/services/scraping/harCapturer.js` | `_verifyAccess()` (vérification réelle sur statut HTTP), `_parseRetryAfter()`, `_warmupSession` renvoie un résultat structuré et ne persiste QUE sur accès confirmé, `capture()` renvoie `{ pagesCaptured, blocked, blockedCode, httpStatus }` et ne relance pas de fenêtre en boucle. |
| `src/main/services/scraping/leboncoin-pipeline.js` | 403/429 distincts (`BLOCKED_429`), `Retry-After`, `stopReason`, exit `3`/`4`, résultats partiels conservés. |
| `src/main/services/scraping/pipelineRunner.js` | Classification des exit `3` (403) / `4` (429). |
| `src/main/core/ipcHandlers.js` | Consomme le résultat structuré ; états `partial`/`refused`/`rate_limited` ; conserve et signale les annonces partielles. |
| `src/renderer/scraperModule.js`, `src/renderer/widget.html` | États terminaux étendus (`partial`/`refused`/`rate_limited`). |
| `test/regression.test.js` | Mise à jour des tests obsolètes (comportement renforcé) + sections `[3g]` et `[30]`. |
| `AGENTS.md`, `docs/CHANGELOG.md` | Documentation des nouveaux contrats. |

---

## 3. Tests — résultats réels

Commande : `node test/regression.test.js`

```
=== RÉSULTAT : 1057 réussis, 0 échoués ===
```

Vérifications statiques : `node --check` sur **tous** les fichiers `src/`, `test/`,
`tools/` → 0 erreur.

| Scénario de l'audit | Couvert par | Résultat |
|---|---|---|
| CAPTCHA absent, accès confirmé | `[30]` `_verifyAccess` (200) | ✓ |
| CAPTCHA présent → accès non confirmé | `[30]` (captcha visible) | ✓ |
| CAPTCHA disparu mais HTTP 403 persistant | `[30]` (403) | ✓ |
| HTTP 403 sans CAPTCHA visible | `[30]` (403 direct) | ✓ |
| HTTP 429 + Retry-After | `[30]` (429 → 120000 ms) | ✓ |
| Échec de reprise → ACCESS_UNVERIFIED | `[30]` (request.get lève) | ✓ |
| HAR vide → exit 2 | `[3b]` | ✓ |
| HAR malformé → exit non nul | `[3d]` | ✓ |
| Résultats partiels préservés | `[3f]` | ✓ |
| Blocage enrichissement → exit 3/4 | `[3g]` | ✓ |
| Annulation = état `cancelled` | `[3b2]` | ✓ |
| États `partial`/`refused`/`rate_limited` | `[30]` | ✓ |
| Construction / packaging (statique) | `[28]`, `[29]` | ✓ |

Non couverts dans cet environnement (limites explicitées) : résolution d'un vrai
CAPTCHA, trafic réel Leboncoin, exécution de l'installeur Windows.

---

## 4. Sécurité

- Aucun secret, jeton ou cookie introduit dans le code, les tests ou les logs.
- Les nouveaux logs ne contiennent que des codes d'erreur, URLs et statuts HTTP —
  jamais de cookies ni d'en-têtes d'authentification.
- `_verifyAccess` utilise une requête **autorisée** (mêmes cookies/session,
  mêmes UA) : aucun contournement de contrôle d'accès, aucune rotation de proxy,
  aucun masquage d'automatisation. En cas de refus : arrêt, pas de reprise forcée.
- `Retry-After` est **respecté** (aucune reprise automatique agressive).
- SSRF : la validation existante (`isSafeFetchDestination`, allowlist, route-guard)
  est conservée.

---

## 5. Construction sous Windows

Non exécutée ici (environnement Linux, pas de Wine/Windows). Commandes exactes :

```bash
npm ci
npm run browsers        # hôte
npm run browsers:win    # Chromium Windows (build croisé)
npm run dist            # electron-builder --win → dist/ (NSIS + portable)
node tools/verify-dist.js --dir=dist   # échoue si installeur/ffmpeg/Chromium manquants
```

En CI, `.github/workflows/build-windows.yml` (runner `windows-latest`) exécute
`npm run dist` + `verify-dist.js`. Le **lancement effectif** de l'installeur n'a
pas été rejoué (voir `docs/KNOWN_ISSUES.md` KI-1).

---

## 6. Installation (test sans écraser la version précédente)

1. Récupérer l'artefact de la CI (ou la Release) : `Leboncoin-Scraper-Pro-Setup-*.exe`
   et le portables `.exe`.
2. Tester d'abord le **portable** (aucune installation) : exécuter
   `Leboncoin-Scraper-Pro-Portable-1.0.0.exe` depuis un chemin contenant des
   espaces et un accent (ex. `C:\Users\<user>\Téléchargements\test dossier\`).
3. Pour l'installeur NSIS : installation **par utilisateur** (`perMachine:false`) ;
   en changer le dossier d'installation ne touche pas l'installation existante.
   `deleteAppDataOnUninstall:false` → les données de `Documents/Leboncoin Scraper Pro`
   sont conservées à la désinstallation.
4. Vérifier : démarrage, bandeau Chromium OK, un job de scraping complet, un arrêt
   (« Arrêter »), l'export JSON/TXT, puis la désinstallation.

---

## 7. Points restants

- **KI-1** : lancement réel de l'exe sous Windows non rejoué (Linux/Wine absent).
  La structure du build est vérifiée statiquement.
- **KI-5** : vulnérabilités de dépendances (playwright directe élevée) —
  correction hors plage (1.64), à traiter dans un lot dédié.
- Tests d'interface graphique réels (DOM) toujours absents (KI-2) ; couverture
  statique `[25]` conservée.
- Résolution d'un vrai CAPTCHA et scraping réel : non testables sans trafic vers
  le site (interdit ici). La vérification d'accès est testée en unitaire.
- La méthode `GET` de vérification (`page.request.get`) n'est pas exécutée en
  test (Playwright stubbé) : la logique de décision est testée via des réponses
  simulées fidèles à l'API Playwright.

---

## 8. Conclusion

**Fonctionnel et vérifié** sur les points corrigés : la fausse validation de
session (P1) est supprimée, les boucles de fenêtres CAPTCHA (P2) sont empêchées,
403/429 sont distincts (P3) et aucun faux « succès » n'est plus émis (P4/P5).

- 1057 assertions vertes, 0 échouée.
- Aucun `node --check` en erreur.
- Aucune fonctionnalité existante supprimée.

**Partiellement vérifié** : empaquetage/installeur Windows (structure oui,
exécution non). **Non vérifié** : CAPTCHA réel sur le site (respect des CGU,
par conception).
