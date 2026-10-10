#!/usr/bin/env node
'use strict';

/**
 * Vérifie que le dossier `dist/` contient un installeur Windows réellement
 * exploitable, et pas un fichier tronqué. Utilisé par le workflow CI
 * (.github/workflows/build-windows.yml) AVANT toute publication d'artefact ou
 * de Release : un build qui produit un `.exe` vide ou sans ressources doit
 * échouer clairement, jamais publier un faux installeur.
 *
 * Contrôles effectués :
 *   1. présence de l'installeur NSIS (fin par « Setup <version>.exe ») ;
 *   2. présence de l'app packagée (`win-unpacked/`) avec `app.asar`, `ffmpeg.dll`
 *      et l'exécutable de l'application ;
 *   3. présence du Chromium Playwright embarqué dans les ressources
 *      (`resources/browsers/chromium-<rev>/chrome-win/chrome.exe`) ;
 *   4. taille minimale plausible de l'installeur (défaut 20 Mo) ;
 *   5. en-tête PE (`MZ`) des exécutables, preuve qu'il ne s'agit pas d'un
 *      fichier vide ou d'un texte d'erreur.
 *
 * Le module exporte `verifyDist(dir, options)` (testable sans effet de bord) et
 * fournit un CLI `node tools/verify-dist.js [--dir=dist]` qui écrit en plus les
 * empreintes `.sha256` et sort en code 1 si un contrôle bloquant échoue.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = {
  minInstallerBytes: 20 * 1024 * 1024, // 20 Mo : plancher très bas, un vrai build dépasse largement
  requireInstaller: true,
};

function isFileWithSize(p, min) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size >= (min || 1);
  } catch {
    return false;
  }
}

function hasPeHeader(p) {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf[0] === 0x4d && buf[1] === 0x5a; // "MZ"
  } catch {
    return false;
  }
}

function findFiles(dir, predicate) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findFiles(full, predicate));
    else if (predicate(e.name, full)) out.push(full);
  }
  return out;
}

/**
 * @param {string} distDir dossier à vérifier (ex. "dist")
 * @param {object} [options]
 * @returns {{ok: boolean, errors: string[], warnings: string[], stats: object, artifacts: object}}
 */
function verifyDist(distDir, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const errors = [];
  const warnings = [];
  const stats = {};

  if (!fs.existsSync(distDir) || !fs.statSync(distDir).isDirectory()) {
    return { ok: false, errors: [`Dossier de distribution introuvable : ${distDir}`], warnings, stats, artifacts: {} };
  }

  // 1. Installeur NSIS + version portable.
  const exeAtRoot = findFiles(distDir, (name, full) => /\.exe$/i.test(name) && path.dirname(full) === path.resolve(distDir))
    .map((f) => ({ path: f, name: path.basename(f) }));
  const installer = exeAtRoot.find((f) => /Setup .+\.exe$/i.test(f.name) || /Setup-.+\.exe$/i.test(f.name));
  const portable = exeAtRoot.find((f) => /Portable-.+\.exe$/i.test(f.name) || /portable/i.test(f.name));

  if (!installer) {
    const msg = `Installeur NSIS introuvable dans ${distDir} (« <Product> Setup <version>.exe »).`;
    if (opts.requireInstaller) errors.push(msg);
    else warnings.push(msg);
  } else {
    stats.installerBytes = fs.statSync(installer.path).size;
    if (stats.installerBytes < opts.minInstallerBytes) {
      errors.push(
        `Installeur suspect : ${installer.name} = ${stats.installerBytes} octets ` +
        `(< ${opts.minInstallerBytes}). Build probablement incomplet.`
      );
    }
    if (!hasPeHeader(installer.path)) {
      errors.push(`Installeur ${installer.name} n'a pas d'en-tête PE (MZ) : fichier corrompu/vide.`);
    }
  }

  if (portable) {
    stats.portableBytes = fs.statSync(portable.path).size;
    if (stats.portableBytes < opts.minInstallerBytes) {
      warnings.push(`Version portable suspecte : ${portable.name} = ${stats.portableBytes} octets.`);
    }
    if (!hasPeHeader(portable.path)) warnings.push(`Version portable ${portable.name} sans en-tête PE.`);
  } else {
    warnings.push('Version portable absente (cible optionnelle).');
  }

  // 2. Application packagée (win-unpacked).
  const unpackedDir = path.join(distDir, 'win-unpacked');
  const asar = path.join(unpackedDir, 'resources', 'app.asar');
  const ffmpeg = path.join(unpackedDir, 'ffmpeg.dll');
  const appExe = findFiles(unpackedDir, (name) => /\.exe$/i.test(name))
    .map((f) => ({ path: f, name: path.basename(f) }));

  if (!fs.existsSync(unpackedDir)) {
    errors.push(`Dossier « win-unpacked » absent : l'application packagée n'a pas été produite.`);
  } else {
    if (!isFileWithSize(asar, 1024)) errors.push(`app.asar manquant ou vide (${asar}).`);
    if (!isFileWithSize(ffmpeg, 1024)) errors.push(`ffmpeg.dll manquant ou vide (${ffmpeg}) — Electron incomplet.`);
    const mainExe = appExe.find((f) => !/unins/i.test(f.name));
    if (!mainExe) errors.push(`Exécutable de l'application introuvable dans ${unpackedDir}.`);
  }

  // 3. Chromium Playwright embarqué.
  const browsersDir = path.join(unpackedDir, 'resources', 'browsers');
  const chromeExe = findFiles(browsersDir, (name) => /^chrome\.exe$/i.test(name) || /^chrome$/i.test(name));
  if (chromeExe.length === 0) {
    errors.push('Chromium Playwright introuvable dans resources/browsers/ (attendu chromium-<rev>/chrome-win/chrome.exe).');
  } else {
    stats.chromiumExe = path.relative(unpackedDir, chromeExe[0]);
    if (!hasPeHeader(chromeExe[0])) errors.push(`Binaire Chromium embarqué sans en-tête PE : ${chromeExe[0]}`);
  }

  return { ok: errors.length === 0, errors, warnings, stats, artifacts: { installer, portable } };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const arg = process.argv.find((a) => a.startsWith('--dir='));
  const distDir = path.resolve(arg ? arg.split('=')[1] : 'dist');
  const { ok, errors, warnings, stats } = verifyDist(distDir);

  console.log(`[verify-dist] Vérification de ${distDir}`);
  for (const w of warnings) console.warn(`  ⚠ ${w}`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  if (ok) console.log('  ✓ Installeur, application packagée, ffmpeg.dll et Chromium présents.');

  if (ok) {
    // Écrit les empreintes SHA-256 des artefacts publiés (accompagnement Release).
    for (const f of fs.readdirSync(distDir)) {
      if (!/\.exe$/i.test(f)) continue;
      const full = path.join(distDir, f);
      const hash = sha256(full);
      fs.writeFileSync(`${full}.sha256`, `${hash}  ${f}\n`);
      console.log(`  # SHA-256 ${f} : ${hash}`);
    }
  } else {
    console.error(`[verify-dist] ÉCHEC : ${errors.length} problème(s). Build non publiable.`);
  }
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { verifyDist, sha256, DEFAULTS };
