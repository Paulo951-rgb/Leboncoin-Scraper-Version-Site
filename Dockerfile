# ─────────────────────────────────────────────────────────────────────────────
# Leboncoin Scraper Pro — version Web (serveur Node.js + Playwright/Chromium)
#
# L'image de base correspond EXACTEMENT à la version de Playwright du projet
# (package.json → "playwright": "1.41.2"). Elle embarque déjà Node.js et toutes
# les dépendances système de Chromium (libs graphiques, polices, etc.).
#
# Ne pas remplacer par une image Node.js « nue » : Chromium ne démarrerait pas
# (bibliothèques manquantes) et le scraping échouerait au lancement.
# ─────────────────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.41.2-jammy

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=3000 \
    LBC_BASE_OUT_DIR=/data

WORKDIR /app

# 1) Dépendances (couche mise en cache). On installe les versions verrouillées
#    du package-lock (npm ci) pour un build reproductible.
#    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD : Chromium est déjà dans l'image de base.
COPY package.json package-lock.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev --no-audit --no-fund

# 2) Code applicatif.
COPY src ./src
COPY tools ./tools

# 3) Dossier de données (Render monte un disque persistant ici via render.yaml).
RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser

EXPOSE 3000

# Endpoint de santé (Render l'utilise pour déterminer l'état du service).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server/index.js"]
