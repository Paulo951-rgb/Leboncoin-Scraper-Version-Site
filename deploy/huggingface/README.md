---
title: Leboncoin Scraper Pro (Web)
emoji: 🛒
colorFrom: gray
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# Leboncoin Scraper Pro — version Web (Hugging Face Space)

Serveur Node.js + Playwright/Chromium exposant l'interface Web de
**Leboncoin Scraper Pro**. Tout le scraping s'exécute ici (côté serveur) ;
le navigateur de l'utilisateur ne fait que consommer l'API HTTPS.

## ⚠️ Limites à connaître avant d'utiliser cette cible

- **Space Docker = plan payant.** Depuis mi-2026, créer un Space `docker`
  (ou `gradio`) nécessite un plan **PRO** (9 $/mois) sur un compte personnel.
  Les comptes gratuits ne peuvent créer que des Spaces *statiques*, inadaptés
  à un serveur. Voir `docs/WEB_DEPLOYMENT_HUGGINGFACE.md`.
- **Stockage NON persistant.** Le disque d'un Space n'est pas conservé entre
  deux redémarrages : la base SQLite, l'historique, les résultats et les
  sessions sont **perdus** au redémarrage. Pour une persistance réelle,
  utilisez Oracle Cloud Always Free (voir la documentation).
- **CAPTCHA** : le serveur est headless. La résolution manuelle est impossible ;
  une tâche bloquée passe à l'état `action_required` et s'arrête proprement.
  Aucun contournement n'est tenté.

## Variables d'environnement (Secrets / Variables du Space)

| Nom | Valeur | Type |
|---|---|---|
| `LBC_SESSION_SECRET` | `openssl rand -hex 32` | Secret |
| `LBC_AUTH_DISABLED` | `0` | Variable |
| `LBC_ALLOW_SIGNUP` | `1` | Variable |
| `NODE_ENV` | `production` | Variable |

> Ne définissez **pas** `PORT` : le serveur lit `PORT` (HF fixe le port via
> `app_port: 7860`) et `LBC_BASE_OUT_DIR` est déjà fixé dans le Dockerfile.

## Déploiement

Voir `docs/WEB_DEPLOYMENT_HUGGINGFACE.md` (procédure complète + script
`tools/prepare-hf-space.js`).
