#!/usr/bin/env node
'use strict';

/**
 * Prépare le Chromium Playwright destiné au packaging Electron.
 *
 * Objectif : garantir que l'application packagée embarque le Chromium de la
 * BONNE plateforme, et pas celui de la machine de build. Sur un poste Windows,
 * `playwright install --with-deps chromium` suffit ; mais une CI Linux qui
 * produit un installeur Windows doit télécharger explicitement le Chromium
 * Windows (build `win64`), sinon l'exécutable embarqué ne démarre pas.
 *
 * Le script :
 *   1. détermine la plateforme cible (--platform=win|mac|linux, défaut = hôte) ;
 *   2. lit la révision Chromium dans node_modules/playwright-core/browsers.json ;
 *   3. télécharge et extrait l'archive correspondante dans
 *      node_modules/playwright-core/.local-browsers/chromium-<rev>/ (chemin que
 *      electron-builder copie vers resources/browsers/ via extraResources) ;
 *   4. marque l'installation comme complète (fichier INSTALLATION_COMPLETE).
 *
 * Le téléchargement est idempotent : si le dossier cible existe déjà avec le
 * bon exécutable, l'étape est ignorée.
 *
 * Utilisation :
 *   node tools/prepare-browsers.js                 # plateforme hôte
 *   node tools/prepare-browsers.js --platform=win  # Chromium Windows (build win sur Linux)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PW_CORE = path.join(ROOT, 'node_modules', 'playwright-core');
const LOCAL_BROWSERS = path.join(PW_CORE, '.local-browsers');

const CDN_PRIMARY = 'https://cdn.playwright.dev/builds';
const CDN_FALLBACK = 'https://playwright.azureedge.net/builds';

function getArgPlatform() {
  const arg = process.argv.find((a) => a.startsWith('--platform='));
  if (arg) return arg.split('=')[1];
  // Hôte → cible Playwright
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

// Nom de l'archive Playwright pour (plateforme, révision, arch).
// Playwright nomme les archives win64/win-arm64, mac/mac-arm64, linux.
function archiveName(platform, arch) {
  if (platform === 'win') return arch === 'arm64' ? 'chromium-win-arm64.zip' : 'chromium-win64.zip';
  if (platform === 'mac') return arch === 'arm64' ? 'chromium-mac-arm64.zip' : 'chromium-mac.zip';
  return 'chromium-linux.zip';
}

// Sous-dossier d'extraction produit par l'archive.
function extractedDir(platform) {
  if (platform === 'win') return 'chrome-win';
  if (platform === 'mac') return 'chrome-mac';
  return 'chrome-linux';
}

function config() {
  const platform = getArgPlatform();
  const arch = process.env.npm_config_arch || (platform === 'win' ? 'x64' : process.arch);
  const browsersJson = JSON.parse(fs.readFileSync(path.join(PW_CORE, 'browsers.json'), 'utf8'));
  const chromium = browsersJson.browsers.find((b) => b.name === 'chromium');
  if (!chromium) throw new Error('Révision Chromium introuvable dans browsers.json');
  return { platform, arch, revision: chromium.revision, version: chromium.browserVersion };
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} pour ${url}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', reject);
    }).on('error', reject);
  });
}

function unzip(zipPath, destDir) {
  // Dépendance déjà présente (transitive de playwright) : pas d'appel système.
  const extract = require('extract-zip');
  return extract(zipPath, { dir: path.resolve(destDir) });
}

async function main() {
  const { platform, arch, revision, version } = config();
  const targetDir = path.join(LOCAL_BROWSERS, `chromium-${revision}`);
  const marker = path.join(targetDir, 'INSTALLATION_COMPLETE');
  const exeName = platform === 'win' ? 'chrome.exe' : (platform === 'mac' ? 'Chromium.app' : 'chrome');
  const extractSub = extractedDir(platform);
  const exePath = path.join(targetDir, extractSub, exeName);

  console.log(`[prepare-browsers] Cible : ${platform}-${arch}, Chromium ${version} (rev ${revision})`);

  if (fs.existsSync(exePath)) {
    if (!fs.existsSync(marker)) fs.writeFileSync(marker, '');
    console.log(`[prepare-browsers] Déjà présent → ${targetDir} (ignoré).`);
    return;
  }

  const file = archiveName(platform, arch);
  const urls = [
    `${CDN_PRIMARY}/chromium/${revision}/${file}`,
    `${CDN_FALLBACK}/chromium/${revision}/${file}`,
  ];

  const tmpZip = path.join(os.tmpdir(), `pw-${platform}-chromium-${revision}.zip`);
  let downloaded = false;
  for (const url of urls) {
    try {
      console.log(`[prepare-browsers] Téléchargement : ${url}`);
      await download(url, tmpZip);
      downloaded = true;
      break;
    } catch (err) {
      console.warn(`[prepare-browsers] Échec (${url}) : ${err.message}`);
    }
  }
  if (!downloaded) {
    throw new Error(`Téléchargement du Chromium ${platform} impossible (CDN injoignable).`);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  console.log(`[prepare-browsers] Extraction vers ${targetDir}…`);
  await unzip(tmpZip, targetDir);
  fs.writeFileSync(marker, '');
  fs.unlinkSync(tmpZip);
  console.log(`[prepare-browsers] Terminé : ${extractSub}/${exeName} embarqué pour ${platform}.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[prepare-browsers] Échec :', err.message);
    process.exit(1);
  });
}

// Exports pour les tests unitaires (nom d'archive/sous-dossier selon plateforme).
module.exports = { archiveName, extractedDir, getArgPlatform };
