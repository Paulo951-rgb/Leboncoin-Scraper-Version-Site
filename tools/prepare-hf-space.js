'use strict';

/**
 * Assemble un dépôt prêt à pousser vers Hugging Face Spaces (SDK Docker).
 *
 * Hugging Face attend à la RACINE du dépôt du Space : README.md (avec le bloc
 * YAML `sdk: docker`, `app_port: 7860`) et le Dockerfile. Ce script copie donc
 * l'arborescence nécessaire depuis le dépôt source vers un dossier cible, puis
 * y place le README et le Dockerfile adaptés à Hugging Face.
 *
 * Usage :
 *   node tools/prepare-hf-space.js [dossier-cible]
 *   node tools/prepare-hf-space.js ../lbc-hf-space
 *
 * Ensuite :
 *   cd ../lbc-hf-space && git init && git remote add space <URL_DU_SPACE> \
 *     && git add -A && git commit -m "Deploy" && git push space main
 */

const fs = require('fs');
const path = require('path');

const SRC_ROOT = path.resolve(__dirname, '..');
const HF_DIR = path.join(SRC_ROOT, 'deploy', 'huggingface');
const TARGET = path.resolve(process.argv[2] || path.join(SRC_ROOT, '..', 'lbc-hf-space'));

// Fichiers/dossiers copiés depuis le dépôt source vers le Space.
const INCLUDE = [
  'package.json',
  'package-lock.json',
  'src',
  'tools/prepare-browsers.js',
];

// Fichiers fournis par deploy/huggingface/ (à la racine du Space).
const HF_FILES = ['README.md', 'Dockerfile'];

function log(msg) { console.log(`[prepare-hf-space] ${msg}`); }

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function main() {
  if (!fs.existsSync(HF_DIR)) {
    throw new Error(`Dossier introuvable : ${HF_DIR}`);
  }
  // Sécurité : ne jamais écraser la racine du dépôt source.
  if (TARGET === SRC_ROOT || SRC_ROOT.startsWith(TARGET + path.sep)) {
    throw new Error(`Dossier cible invalide (dans le dépôt source) : ${TARGET}`);
  }

  fs.mkdirSync(TARGET, { recursive: true });
  log(`Cible : ${TARGET}`);

  for (const rel of INCLUDE) {
    const src = path.join(SRC_ROOT, rel);
    if (!fs.existsSync(src)) { log(`(ignoré, absent) ${rel}`); continue; }
    copyRecursive(src, path.join(TARGET, rel));
    log(`copié : ${rel}`);
  }

  for (const rel of HF_FILES) {
    const src = path.join(HF_DIR, rel);
    if (!fs.existsSync(src)) throw new Error(`Fichier Hugging Face manquant : ${src}`);
    fs.copyFileSync(src, path.join(TARGET, rel));
    log(`copié (HF) : ${rel}`);
  }

  // .dockerignore du Space (contexte de build minimal).
  fs.writeFileSync(path.join(TARGET, '.dockerignore'), [
    'node_modules', 'output', '.git', '*.log', '.env', '.env.*', '.DS_Store', '',
  ].join('\n'));
  log('écrit : .dockerignore');

  log('Terminé. Poussez ce dossier vers votre Space Hugging Face (voir docs/WEB_DEPLOYMENT_HUGGINGFACE.md).');
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`[prepare-hf-space] ERREUR : ${e.message}`); process.exit(1); }
}

module.exports = { main, TARGET };
