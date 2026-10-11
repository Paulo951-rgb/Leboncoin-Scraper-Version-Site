'use strict';

const path = require('path');
const { fork } = require('child_process');
const { EventEmitter } = require('events');
const { formatMs, describeError, truncate } = require('../../utils/diagnostics');
const { classifyError, ErrorCodes, createError } = require('./errorCodes');

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

class PipelineRunner extends EventEmitter {
  constructor() {
    super();
    this.childProcess = null;
    this.isCancelled = false;
  }

  run(options) {
    return new Promise((resolve, reject) => {
      const { harPath, outDir, noDesc = false, limit, fresh = false, speed, headless = true, userAgent, profileId, profileFields, includeSellerData = true, baseOutDir } = options;

      if (!harPath) return reject(new Error('harPath est requis pour exécuter le pipeline.'));
      if (!outDir) return reject(new Error('outDir est requis pour exécuter le pipeline.'));

      const scriptPath = path.join(__dirname, 'leboncoin-pipeline.js');

      // fork() gère de manière native et parfaite les espaces dans les chemins Windows !
      // Le premier argument de fork est le script, le deuxième est le tableau des arguments restants (harPath, --out, etc.)
      const remainingArgs = [harPath, '--out', outDir];
      if (headless) remainingArgs.push('--headless');
      if (speed) remainingArgs.push('--speed', speed); 
      if (userAgent) remainingArgs.push('--user-agent', userAgent);

        if (noDesc) remainingArgs.push('--no-desc');
        if (fresh) remainingArgs.push('--fresh');
        if (limit) remainingArgs.push('--limit', String(limit));
        // Profil de données (Défaut / Maximum / Personnalisé) : on transmet la
        // liste concrète de clés de champs au pipeline forké. Le pipeline
        // l'applique directement aux exports JSON et TXT.
        if (profileId) remainingArgs.push('--profile-id', String(profileId));
        if (Array.isArray(profileFields) && profileFields.length > 0) {
          remainingArgs.push('--profile-fields', profileFields.join(','));
        }
        if (!includeSellerData) remainingArgs.push('--no-seller-data');
        // BASE_OUT_DIR transmis explicitement : le pipeline forké n'a pas accès
        // à `electron`, il ne peut donc pas importer config/constants. Ce chemin
        // lui sert à localiser la session globale (global-session.json).
        if (baseOutDir) remainingArgs.push('--base-out-dir', String(baseOutDir));

      this.emit('log', {
        level: 'info',
        message: `⚙️ Lancement du pipeline sous-processus (Moteur de fork sécurisé)...`,
      });
      this.emit('log', { level: 'debug', message: `[pipelineRunner] Script : ${scriptPath}` });
      this.emit('log', { level: 'debug', message: `[pipelineRunner] Args : ${remainingArgs.join(' ')}` });
      this.emit('log', { level: 'debug', message: `[pipelineRunner] Options : noDesc=${noDesc}  limit=${limit ?? '(aucun)'} | fresh=${fresh} | userAgent=${userAgent ? '(transmis)' : '(aléatoire)'} | cwd=${process.cwd()} | profileId=${profileId || 'default'} | profileFields=${Array.isArray(profileFields) ? `[${profileFields.length} champ(s)]` : '(toutes)'} | includeSellerData=${includeSellerData}` });

      this.isCancelled = false;
      const t0Fork = Date.now();
      this.childProcess = fork(scriptPath, remainingArgs, {
        cwd: process.cwd(),
        env: { ...process.env, FORCE_COLOR: '0' },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'] // Redirige les flux pour capturer la progression
      });
      this.emit('log', { level: 'debug', message: `[pipelineRunner] Sous-processus forké (PID ${this.childProcess.pid}) en ${formatMs(Date.now() - t0Fork)}.` });

      let stdoutBuffer = '';
      let stderrTotal = '';

      this.childProcess.stdout.on('data', (data) => {
        stdoutBuffer += data.toString('utf8');
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop();

        for (const rawLine of lines) {
          this._handleLine(rawLine);
        }
      });

      let stderrBuffer = '';
      this.childProcess.stderr.on('data', (data) => {
        stderrBuffer += data.toString('utf8');
        stderrTotal += data.toString('utf8');
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop();

        for (const rawLine of lines) {
          const clean = stripAnsi(rawLine).trim();
          if (clean) {
            this.emit('log', { level: 'error', message: `[Pipeline STDERR] ${clean}` });
          }
        }
      });

      this.childProcess.on('error', (err) => {
        const errCode = err.code === 'ENOENT' ? ErrorCodes.BROWSER_LAUNCH_FAILED : ErrorCodes.BROWSER_CRASHED;
        const structuredErr = createError(errCode, `Erreur processus : ${err.message}`, { error: err.message, code: err.code });
        this.emit('log', { level: 'error', message: `[${structuredErr.code}] Erreur processus : ${err.message}` });
        this.emit('log', { level: 'debug', message: `[pipelineRunner] Détail erreur processus : ${describeError(err)}` });
        // Libere la reference même si 'close' ne se déclenche pas (échec de spawn).
        this.childProcess = null;
        reject(new Error(`[${structuredErr.code}] ${structuredErr.message}`));
      });

      this.childProcess.on('close', (code) => {
        if (stdoutBuffer.trim()) this._handleLine(stdoutBuffer);
        const elapsed = formatMs(Date.now() - t0Fork);

        this.childProcess = null;

        if (this.isCancelled) {
          this.emit('log', { level: 'warn', message: 'Pipeline annulé par l\'utilisateur.' });
          this.emit('log', { level: 'debug', message: `[pipelineRunner] Annulation — code de sortie ${code} | durée ${elapsed}.` });
          resolve(130);
          return;
        }

        if (code === 0) {
          this.emit('log', { level: 'info', message: '✅ Execution du pipeline terminée avec succès.' });
          this.emit('log', { level: 'debug', message: `[pipelineRunner] Terminé en ${elapsed} (code 0).${stderrTotal ? ' STDERR total : ' + truncate(stripAnsi(stderrTotal), 200) : ''}` });
          resolve(0);
        } else if (code === 2) {
          // Exit 2 : le pipeline n'a trouvé AUCUNE donnée exploitable (HAR vide,
          // 0 annonce). Ce n'est PAS un crash navigateur : on remonte un échec
          // explicite pour ne pas présenter un run vide comme un succès.
          const errCode = ErrorCodes.PARSE_NO_ADS;
          const errMessage = 'Le pipeline n\'a extrait aucune annonce (HAR vide ou structure inattendue).';
          const structuredErr = createError(errCode, errMessage, { exitCode: code, category: classifyError(errCode), stderr: truncate(stripAnsi(stderrTotal), 500) });
          this.emit('log', { level: 'error', message: `[${structuredErr.code}] ${errMessage}` });
          this.emit('log', { level: 'debug', message: `[pipelineRunner] Aucun résultat en ${elapsed} (code 2). STDERR : ${truncate(stripAnsi(stderrTotal), 500) || '(vide)'}` });
          reject(new Error(`[${structuredErr.code}] ${errMessage}`));
        } else if (code === 3) {
          // Exit 3 : accès refusé (HTTP 403) pendant l'enrichissement. Les
          // annonces de base ont pu être écrites — le message reste explicite.
          const errCode = ErrorCodes.HTTP_ACCESS_REFUSED;
          const errMessage = 'Enrichissement interrompu : accès refusé par le serveur (HTTP 403).';
          const structuredErr = createError(errCode, errMessage, { exitCode: code, category: classifyError(errCode), stderr: truncate(stripAnsi(stderrTotal), 500) });
          this.emit('log', { level: 'error', message: `[${structuredErr.code}] ${errMessage}` });
          this.emit('log', { level: 'debug', message: `[pipelineRunner] Arrêt enrichissement en ${elapsed} (code 3, HTTP 403).` });
          reject(new Error(`[${structuredErr.code}] ${errMessage}`));
        } else if (code === 4) {
          // Exit 4 : limitation de débit (HTTP 429) pendant l'enrichissement.
          const errCode = ErrorCodes.HTTP_RATE_LIMITED;
          const errMessage = 'Enrichissement interrompu : requête limitée par le serveur (HTTP 429).';
          const structuredErr = createError(errCode, errMessage, { exitCode: code, category: classifyError(errCode), stderr: truncate(stripAnsi(stderrTotal), 500) });
          this.emit('log', { level: 'error', message: `[${structuredErr.code}] ${errMessage}` });
          this.emit('log', { level: 'debug', message: `[pipelineRunner] Arrêt enrichissement en ${elapsed} (code 4, HTTP 429).` });
          reject(new Error(`[${structuredErr.code}] ${errMessage}`));
        } else {
          // Classifie l'erreur selon le code de sortie pour un diagnostic structuré.
          const exitCode = code != null ? code : -1;
          const errCode = exitCode === 1 ? ErrorCodes.BROWSER_CRASHED : ErrorCodes.UNKNOWN;
          const category = classifyError(errCode);
          const errMessage = `Le pipeline s'est terminé avec un code : ${exitCode}`;
          const structuredErr = createError(errCode, errMessage, { exitCode, category, stderr: truncate(stripAnsi(stderrTotal), 500) });
          this.emit('log', { level: 'error', message: `[${structuredErr.code}] ${errMessage}` });
          this.emit('log', { level: 'debug', message: `[pipelineRunner] Échec en ${elapsed} (code ${exitCode}). STDERR : ${truncate(stripAnsi(stderrTotal), 500) || '(vide)'}` });
          reject(new Error(`[${structuredErr.code}] ${errMessage}`));
        }
      });
    });
  }

  stop() {
    if (this.childProcess) {
      this.isCancelled = true;
      this.emit('log', { level: 'warn', message: 'Interruption demandée du pipeline...' });
      this.childProcess.kill('SIGINT');
    }
  }

  _handleLine(rawLine) {
    const clean = stripAnsi(rawLine).trim();
    if (!clean) return;

    let level = 'info';
    if (clean.includes('[WARN]')) level = 'warn';
    else if (clean.includes('[ERROR]')) level = 'error';
    else if (clean.includes('[DEBUG]')) level = 'debug';

    // Si la ligne contient un code d'erreur structuré (ex: [CAPTCHA_DETECTED]),
    // on la transmet telle quelle — le code est déjà inclus dans le message.
    this.emit('log', { level, message: clean });

    // Progression
    const match = clean.match(/\[(\d+)\/(\d+)\]/);
    if (match) {
      const done = parseInt(match[1], 10);
      const total = parseInt(match[2], 10);
      const percent = total > 0 ? Math.round((done / total) * 100) : 0;

      this.emit('progress', {
        done,
        total,
        percent,
        status: `Traitement : ${done}/${total} (${percent}%)`,
      });
    }
  }
}

module.exports = { PipelineRunner };