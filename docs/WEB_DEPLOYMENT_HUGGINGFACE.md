# Déploiement — Hugging Face Spaces (version Web)

Guide pas à pas pour héberger le serveur Web de **Leboncoin Scraper Pro** sur un
Space Docker de Hugging Face.

> 📌 **À lire en premier — la réalité 2026**
> Depuis **juillet 2026**, créer un Space **Docker** (ou Gradio) nécessite un
> **plan payant** : **PRO (9 $/mois)** pour un compte personnel, Team/Enterprise
> pour une organisation. Un compte **gratuit** ne peut créer que des Spaces
> **statiques** — inadaptés à un serveur Node.js/Chromium.
>
> Autrement dit : Hugging Face n'est **pas** une alternative gratuite à Render
> pour ce projet. Si l'objectif est le « vrai » gratuit avec Chromium et
> persistance, utilisez **Oracle Cloud Always Free** (2 OCPU ARM / 12 Go / 200 Go).
>
> Ce guide reste utile si vous disposez déjà de PRO, ou pour comprendre les
> adaptations nécessaires. Le déploiement a été **validé** (build + Chromium).

---

## 1. Ce que Hugging Face apporte (et ses limites)

| Caractéristique | Valeur |
|---|---|
| Matériel gratuit | CPU Basic : 2 vCPU, **16 Go RAM** |
| Création d'un Space Docker | **plan payant requis** (PRO 9 $/mois) |
| Disque | 50 Go **NON persistant** |
| Mise en veille | après 48 h sans visite |
| Port exposé | un seul : `app_port` (défaut `7860`) |
| Réseau sortant | ports 80, 443, 8080 uniquement |

### ⚠️ Limite majeure : pas de stockage persistant

Le disque d'un Space **n'est pas conservé** entre deux redémarrages. Conséquence
directe sur cette application :

- la base SQLite (comptes, sessions, historique, logs) est **perdue** à chaque
  redémarrage ou rebuild ;
- les exports JSON/TXT déjà générés sont perdus ;
- après une mise en veille puis un réveil, il faut **recréer un compte**.

Le Space reste utilisable pour **démontrer** l'application (interface, scraping,
exports pendant la session), mais **pas** pour un usage durable. C'est une
limite de la plateforme, pas de l'application.

---

## 2. Prérequis

- Un compte Hugging Face avec le plan **PRO**.
- `git` et `openssl` installés localement.
- Le dépôt source de ce projet cloné.

---

## 3. Étape 1 — Créer le Space

1. Allez sur <https://huggingface.co/new-space>.
2. **Name** : `leboncoin-scraper-web` (ou un autre nom).
3. **SDK** : **Docker** → *Blank*.
4. **Visibility** : *Private* de préférence (l'app gère ses propres comptes ;
   évitez une instance publique ouverte à tous).
5. **Hardware** : `CPU basic` (2 vCPU, 16 Go).
6. **Create Space**.

Notez l'URL de clonage du Space (bouton *Clone repository*), de la forme :
`https://huggingface.co/spaces/<votre-compte>/leboncoin-scraper-web`

---

## 4. Étape 2 — Assembler le contenu du Space

Le Space attend à sa **racine** : `README.md` (bloc YAML `sdk: docker`,
`app_port: 7860`) et le `Dockerfile`. Le script fourni assemble tout :

```bash
# depuis le dépôt source
node tools/prepare-hf-space.js ../lbc-hf-space
```

Résultat dans `../lbc-hf-space/` :

```
lbc-hf-space/
├── README.md            # métadonnées HF (sdk: docker, app_port: 7860)
├── Dockerfile           # image Playwright 1.41.2, PORT=7860
├── .dockerignore
├── package.json
├── package-lock.json
├── src/                 # serveur + renderer + moteur de scraping
└── tools/prepare-browsers.js
```

---

## 5. Étape 3 — Pousser vers le Space

```bash
cd ../lbc-hf-space
git init -b main
git remote add space https://huggingface.co/spaces/<votre-compte>/leboncoin-scraper-web
# si le Space est privé, authentifiez-vous avec un jeton d'accès HF :
#   git remote set-url space https://<user>:<HF_TOKEN>@huggingface.co/spaces/<votre-compte>/leboncoin-scraper-web
git add -A
git commit -m "Deploy Leboncoin Scraper Pro (Web)"
git push space main
```

> Le Space est déjà initialisé par Hugging Face : si le `push` est refusé,
> faites `git pull space main --allow-unrelated-histories` puis re-poussez.

Le build démarre automatiquement (onglet **Logs** du Space).

---

## 6. Étape 4 — Configurer les Secrets et Variables

Dans **Settings → Variables and secrets** du Space :

| Nom | Valeur | Type |
|---|---|---|
| `LBC_SESSION_SECRET` | résultat de `openssl rand -hex 32` | **Secret** |
| `LBC_AUTH_DISABLED` | `0` | Variable |
| `LBC_ALLOW_SIGNUP` | `1` | Variable |
| `NODE_ENV` | `production` | Variable |

> ❌ Ne définissez **pas** `PORT` : Hugging Face route le trafic vers `app_port`
> (`7860`) et le Dockerfile fixe déjà `PORT=7860`. Le définir à une autre valeur
> casserait le routage (Space bloqué sur « Starting »).
> ❌ Ne définissez **pas** `LBC_BASE_OUT_DIR` : il vaut `/data` (fixé dans l'image).

Après ajout des secrets, faites **Restart** (Settings → Restart this Space).

---

## 7. Étape 5 — Vérifier

1. Ouvrez l'URL du Space : `https://<compte>-leboncoin-scraper-web.hf.space`.
2. Vous devez voir l'écran de connexion. Créez un compte, connectez-vous.
3. Lancez une recherche de test (1 page). Suivez les logs, puis annulez ou
   laissez terminer.
4. Vérifiez la santé directement :
   `https://<compte>-leboncoin-scraper-web.hf.space/api/health`

---

## 8. Ce qui a été validé techniquement

- Le Dockerfile HF **build** correctement (image Playwright 1.41.2).
- Le serveur démarre sur `0.0.0.0:7860` et `/api/health` répond 200.
- **Chromium se lance** dans le conteneur (dépendances système incluses dans
  l'image de base).

Non testable depuis l'environnement de développement : l'exécution d'un scraping
réel vers Leboncoin depuis l'infrastructure Hugging Face (dépend du réseau et de
l'accès au site).

---

## 9. Pièges connus

- **Space bloqué sur « Starting »** : le plus souvent `app_port` ≠ port réel
  d'écoute. Ici les deux valent 7860 — ne les changez pas de façon désynchronisée.
- **Données perdues après redémarrage** : normal (disque non persistant). Voir §1.
- **CAPTCHA** : headless, impossible à résoudre manuellement → état
  `action_required`, arrêt propre, aucun contournement.
- **Build long** : l'image Playwright est volumineuse ; comptez plusieurs minutes.

---

## 10. Alternative recommandée

Pour un hébergement **réellement gratuit**, **persistant** et capable de faire
tourner Chromium : **Oracle Cloud Always Free** (2 OCPU ARM, 12 Go RAM,
200 Go de stockage bloc) + le `Dockerfile` de ce projet + Caddy pour le HTTPS.
Voir `docs/WEB_DEPLOYMENT.md` (section persistance) et demander le guide Oracle
si nécessaire.
