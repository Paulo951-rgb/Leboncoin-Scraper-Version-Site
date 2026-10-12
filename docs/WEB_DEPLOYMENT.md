# Déploiement Web — Leboncoin Scraper Pro (Render)

Guide de configuration, déploiement, test et maintenance de la **version Web**.
La version Electron de bureau reste indépendante ; ce document ne concerne que
le serveur `src/server/`.

---

## 1. Vue d'ensemble

```
Navigateur (PC / tablette / téléphone)
        │  HTTPS
        ▼
Render (Docker)  ── Node.js + Express ── SQLite (disque persistant /data)
        │
        ├─ HarCapturer  → Playwright + Chromium  (capture HAR)
        └─ PipelineRunner → fork leboncoin-pipeline.js (extraction, enrichissement, exports)
```

Tout le scraping s'exécute **côté serveur**. Le navigateur de l'utilisateur
n'exécute que l'interface (aucune installation requise).

---

## 2. Prérequis

- Un compte Render.
- Un disque persistant Render (obligatoire pour conserver la base et les
  résultats entre redéploiements).
- Plan **payant** recommandé : Chromium + Playwright nécessitent de la RAM.
  Voir §6 « Choix du plan ».

---

## 3. Variables d'environnement

| Variable | Défaut | Description |
|---|---|---|
| `PORT` | `3000` | Port d'écoute (Render l'injecte). |
| `HOST` | `0.0.0.0` | Interface d'écoute. |
| `NODE_ENV` | — | `production` active les cookies `Secure`. |
| `LBC_BASE_OUT_DIR` | `./output` | Racine de stockage (monter `/data` en prod). |
| `LBC_DB_PATH` | `<base>/web/app.db` | Chemin SQLite. |
| `LBC_SESSION_SECRET` | — | **Requis en prod.** Signature des sessions. |
| `LBC_AUTH_DISABLED` | `0` | `1` = désactive l'auth (**dev uniquement**). |
| `LBC_ALLOW_SIGNUP` | `1` | `0` = ferme les inscriptions. |
| `LBC_MAX_JOBS_PER_USER` | `2` | Tâches actives max par utilisateur. |
| `LBC_GLOBAL_CONCURRENCY` | `2` | Tâches simultanées globales. |
| `LBC_MAX_PAGES` | `50` | Pages max par tâche. |
| `LBC_MAX_ADS` | `5000` | Annonces max (limite). |
| `LBC_JOB_TIMEOUT_MS` | `1800000` | Délai max d'une tâche (30 min). |
| `LBC_MAX_BODY_BYTES` | `65536` | Taille max du corps JSON. |
| `LBC_LOG_BUFFER` | `3000` | Lignes de log conservées par tâche. |
| `LBC_JOB_RETENTION_DAYS` | `30` | Rétention des tâches (0 = illimité). |
| `LBC_HAR_RETENTION_DAYS` | `2` | Rétention des HAR (0 = illimité). |
| `LBC_HEADLESS` | `1` | Scraping sans écran. |
| `LBC_ALLOW_VISIBLE_CAPTCHA` | `0` | `1` = fenêtre visible (nécessite un écran). |
| `LBC_SPEED` | `moyen` | Vitesse par défaut (`moyen`/`rapide`/`ultra-rapide`). |
| `LBC_PAGE_DELAY_MS` | `1200` | Délai de base entre pages. |

Voir `.env.example` pour un modèle de développement local.

---

## 4. Déploiement sur Render

### Option A — Blueprint (`render.yaml`)

1. Pousser le dépôt sur GitHub.
2. Render → **New → Blueprint** → sélectionner le dépôt.
3. Renseigner `LBC_SESSION_SECRET` (générer : `openssl rand -hex 32`).
4. Déployer.

### Option B — Service manuel

1. Render → **New → Web Service** → **Docker**.
2. `Dockerfile path` : `./Dockerfile`.
3. `Health check path` : `/api/health`.
4. Ajouter les variables d'environnement (§3).
5. Ajouter un **disque** monté sur `/data` (taille ≥ 10 Go).
6. Déployer.

---

## 5. Docker — points clés

- Image de base : `mcr.microsoft.com/playwright:v1.41.2-jammy`, **exactement**
  la version de `playwright` du projet (`package.json`). Ne pas la changer sans
  mettre à jour la dépendance (risque de Chromium incompatible).
- `npm ci --omit=dev` : installation reproductible depuis `package-lock.json`.
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` : Chromium est déjà dans l'image.
- `HEALTHCHECK` intégré (appelle `/api/health`).

### Test local du conteneur

```bash
docker build -t lbc-web .
docker run --rm -p 3000:3000 \
  -e LBC_AUTH_DISABLED=1 \
  -e LBC_BASE_OUT_DIR=/data \
  -v lbc-data:/data \
  lbc-web
# puis ouvrir http://localhost:3000
```

---

## 6. Choix du plan Render (mesures)

| Ressource | Valeur observée (dev, 4 cœurs / 16 Go) |
|---|---|
| RAM serveur au repos | ~80-120 Mo |
| RAM par tâche Chromium | ~250-450 Mo (pics possibles > 500 Mo) |
| CPU par tâche | 1 cœur pendant la capture/enrichissement |
| Stockage par tâche | JSON/TXT : quelques Ko ; HAR : 5-80 Mo (supprimés après le job) |

**Recommandation** :
- Plan **gratuit** : ❌ insuffisant (512 Mo, mise en veille, pas de disque
  persistant). Chromium plantera ou les tâches seront interrompues.
- Plan **starter** (512 Mo) : ❌ trop juste pour Chromium.
- Plan **standard** (2 Go) : ✅ minimum viable, concurrence 1-2.
- Plan **pro** (4 Go+) : ✅ pour concurrence 2-3 et tâches longues.

> Ces mesures doivent être refaites sur le plan cible avant mise en production.

---

## 7. API REST

Base : `/api`. Auth par cookie de session (HttpOnly) ou `Authorization: Bearer`.

| Méthode | Route | Description |
|---|---|---|
| GET | `/health` | État du service (public). |
| POST | `/auth/register` | Créer un compte. |
| POST | `/auth/login` | Se connecter. |
| POST | `/auth/logout` | Se déconnecter. |
| GET | `/auth/me` | Utilisateur courant. |
| GET/POST | `/config` | Lire / enregistrer les réglages. |
| GET | `/profiles` | Profils de données + champs. |
| POST | `/jobs` | Créer une tâche. |
| GET | `/jobs` | Lister ses tâches (`limit`, `offset`). |
| GET | `/jobs/:id` | État d'une tâche. |
| GET | `/jobs/:id/logs` | Logs (`after`, `limit`). |
| GET | `/jobs/:id/events` | **SSE** : `log` + `status`. |
| POST | `/jobs/:id/cancel` | Annuler. |
| GET | `/jobs/:id/results` | Annonces + statistiques. |
| DELETE | `/jobs/:id` | Supprimer. |
| GET | `/jobs/:id/export/json\|txt` | Télécharger un export. |
| GET | `/jobs/:id/export-logs` | Télécharger les logs. |
| GET | `/history` | Historique agrégé. |
| GET | `/ad-history` | Évolution des annonces. |
| GET | `/diagnostics` | Infos non sensibles. |

**États de tâche** : `queued`, `running`, `completed`, `partial`, `failed`,
`cancelled`, `action_required`.

**Exemple**

```bash
# connexion
curl -c jar.txt -X POST https://<app>.onrender.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"moi@exemple.com","password":"motdepasse"}'

# création d'une tâche
curl -b jar.txt -X POST https://<app>.onrender.com/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{"searchUrl":"https://www.leboncoin.fr/recherche?text=velo","pages":3,"profileId":"default"}'

# suivi temps réel (SSE)
curl -b jar.txt -N https://<app>.onrender.com/api/jobs/<id>/events
```

---

## 8. Sécurité

- Authentification obligatoire en production (`LBC_AUTH_DISABLED=0`).
- Autorisation vérifiée **côté serveur** sur chaque ressource ; un `id` de tâche
  ne suffit jamais (filtrage `user_id` en base → 404 sinon).
- Mots de passe hachés (scrypt + sel), jetons de session hachés (SHA-256).
- Cookies `HttpOnly`, `SameSite=Lax`, `Secure` en production.
- Validation stricte des entrées ; allowlist stricte des domaines Leboncoin ;
  refus des IP privées/localhost (anti-SSRF) ; limites de pagination.
- Limites : taille de corps, tâches/utilisateur, concurrence globale, délai max.
- En-têtes de durcissement (CSP, `X-Content-Type-Options`, `X-Frame-Options`).
- Erreurs API génériques (pas de fuite de secret/stack).
- Aucun secret dans le frontend ni dans le dépôt.

---

## 9. CAPTCHA & sessions (limites)

- Le serveur est **headless** : impossible d'ouvrir une fenêtre pour résoudre un
  CAPTCHA manuellement. Un CAPTCHA donne l'état **`action_required`** (arrêt
  propre + message), jamais une fausse réussite.
- Aucun contournement de CAPTCHA / restriction d'accès n'est tenté.
- Les cookies/sessions Electron ne sont **pas** réutilisés ; chaque utilisateur
  Web a sa session isolée (`web/sessions/<userId>/`).
- Solution future possible : navigateur distant avec contrôle d'accès (non
  implémenté volontairement — risque de sécurité si exposé sans auth).

---

## 10. Persistance & rétention

- SQLite (`better-sqlite3`, WAL) sur le disque persistant (`/data`).
- Résultats JSON/TXT conservés ; HAR supprimés après chaque tâche.
- Maintenance périodique : purge des sessions expirées, des tâches au-delà de
  la rétention, et des HAR résiduels.

---

## 11. Tests

```bash
npm test            # régression Electron : 1317 tests
npm run test:server # serveur/API/frontend : 65 tests (données fictives)
npm run test:all    # les deux
```

Les tests serveur utilisent un **moteur factice** (aucune requête réseau réelle)
pour rester déterministes et respecter les conditions d'accès du site.

---

## 12. Maintenance & exploitation

- **Logs** : logs structurés sur stdout (Render les collecte).
- **Santé** : `GET /api/health` (Render + HEALTHCHECK Docker).
- **Arrêt propre** : `SIGTERM`/`SIGINT` → annulation des tâches, fermeture des
  navigateurs/processus enfants, fermeture de la base.
- **Redéploiement** : les données survivent via le disque persistant.
- **Migration de base** : schéma idempotent (`CREATE TABLE IF NOT EXISTS`) ;
  toute évolution doit être additive et rétrocompatible.
