# Plan de stabilisation — Leboncoin Scraper Pro

*Branche de travail : `audit/stabilization-2026`*

---

## 1. Points de restauration

- **Base de référence** : `main` @ `b15c978` (dernier commit avant audit).
- **Branche d'audit** : `audit/stabilization-2026`.
- **État initial testé** : 777 assertions réussies (documentées historiquement),
  puis 789 → 792 → 809 → **813** après les lots.
- Aucun historique n'a été réécrit, aucune branche protégée modifiée.

## 2. Étapes de stabilisation (ordonnées)

| Lot | Objet | Statut | Vérification |
|---|---|---|---|
| 1 | Médiane `adStats` (série paire) | ✅ | Tests AdStats |
| 2 | Contrat de sortie du pipeline (0/1/2) + runner | ✅ | Tests `[3]`, `[3b]` |
| 2 | Suppression du code mort (`Notifier`, module `notifications.js`) | ✅ | `grep` + suite |
| 3 | Durcissement navigation Electron (`main.js`) | ✅ | lecture + syntaxe |
| 3 | Politique honnête des secrets (`secretStore.js`) | ✅ | lecture + syntaxe |
| 3 | SSRF IPv6 (`urlSecurity.js`) | ✅ | Tests `urlSecurity` |
| 4 | Correctifs UI (colonne vendeur, filtre état, listener) | ✅ | syntaxe + invariants |
| 5 | Compatibilité des clés d'export (`exportFields.js`) | ✅ | Test `[3c]` (fork réel) |
| 6 | Intégrité des exports (JSON/TXT/meta + checksum) | ✅ | lecture + suite |
| 6 | **Annulation = état `cancelled` distinct** | ✅ | Test `[3b2]` |
| 7 | Hygiène des imports (`dataProfiles.js`) | ✅ | scan + suite |
| 8 | Documentation (README/AGENTS/docs) | ✅ | revue |

## 3. Dépendances entre corrections

- La correction d'annulation (Lot 6) dépend du contrat de sortie du pipeline
  (Lot 2) : sans la distinction exit 1/2, l'annulation serait confondue avec un
  échec.
- La compatibilité des clés d'export (Lot 5) est indépendante des autres lots.
- La doc (Lot 8) doit être mise à jour **après** les correctifs, sinon elle
  décrit un état obsolète.

## 4. Critères de validation (rappel de la définition de « stable »)

- [x] Aucun P0 connu non résolu.
- [x] Aucun P1 bloquant restant (annulation corrigée).
- [x] Tests de non-régression verts (813/813).
- [x] Nouveaux tests pour chaque bug corrigé.
- [x] Syntaxe vérifiée sur tous les fichiers modifiés.
- [x] Interfaces IPC appariées (preload ↔ handlers).
- [x] Exports et historique vérifiés.
- [x] Aucune suppression de fonctionnalité injustifiée.
- [ ] **Build `.exe` Windows** — non exécutable dans cet environnement
      (voir `docs/KNOWN_ISSUES.md`).
- [ ] **Test d'interface réel** — non exécutable sans affichage/DOM.

## 5. Actions restantes avant une release

1. Générer le `.exe` sur une machine Windows (ou CI Windows) via
   `npm run dist`, puis lancer l'installeur et vérifier :
   - présence de Chromium dans `resources/browsers/`,
   - démarrage (pas de DNS/réseau requis),
   - création de `BASE_OUT_DIR` et persistance des paramètres.
2. Campagne manuelle d'interface : démarrage de job, arrêt, reprise,
   suppression de job, changement de thème, mode hors-ligne.
3. Vérifier `npm audit` (non exécuté ici faute de registre accessible).

## 6. Problèmes restants

Voir `docs/KNOWN_ISSUES.md`. Aucun n'est bloquant pour des tests utilisateurs.
