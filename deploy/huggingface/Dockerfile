# ─────────────────────────────────────────────────────────────────────────────
# Leboncoin Scraper Pro — version Web (cible Hugging Face Spaces)
#
# Adapté de ./Dockerfile pour les Spaces Docker :
#   - le port exposé est 7860 (valeur de `app_port` dans README.md) ;
#   - le dossier de données est /data, inscriptible par l'utilisateur non-root ;
#   - le serveur écoute déjà sur 0.0.0.0 (config.js → HOST par défaut).
#
# L'image de base correspond EXACTEMENT à la version de Playwright du projet
# (package.json → "playwright": "1.41.2"). Elle embarque Node.js et toutes les
# dépendances système de Chromium. Ne pas la remplacer par une image Node nue.
# ─────────────────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.41.2-jammy

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=7860 \
    LBC_BASE_OUT_DIR=/data \
    HOST=0.0.0.0

WORKDIR /app

# 1) Dépendances verrouillées (npm ci). Chromium est déjà dans l'image de base.
COPY package.json package-lock.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev --no-audit --no-fund

# 2) Code applicatif.
COPY src ./src
COPY tools ./tools

# 3) Dossier de données inscriptible par l'utilisateur non-root de l'image.
RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||7860)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server/index.js"]
