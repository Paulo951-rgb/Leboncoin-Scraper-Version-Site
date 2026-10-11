// ─── Système de logs (mode normal/debug + auto-scroll + copie) ───────────────
// Les logs sont stockés en mémoire pour permettre le filtrage rétroactif :
// quand l'utilisateur bascule entre mode normal et debug, les logs déjà reçus
// sont réaffichés selon le mode choisi (pas besoin d'attendre de nouveaux logs).
const logsConsole = document.getElementById('logsConsole');
const logStats = document.getElementById('logStats');
const autoScrollToggleBtn = document.getElementById('autoScrollToggleBtn');
const logModeToggleBtn = document.getElementById('logModeToggleBtn');
const copyLogsBtn = document.getElementById('copyLogsBtn');
const exportLogsBtn = document.getElementById('exportLogsBtn');
const clearLogsBtn = document.getElementById('clearLogsBtn');

// Construit le texte des logs visibles (mode courant), réutilisé par Copier/Exporter.
function _buildVisibleLogText() {
  const lines = [];
  for (const entry of _logBuffer) {
    if (!_logLevelVisible(entry.level)) continue;
    lines.push(`[${entry.time}] [${(entry.level || 'info').toUpperCase()}] ${entry.message}`);
  }
  return lines.join('\n');
}

function _logLevelVisible(level) {
  if (_logMode === 'debug') return true;
  // Mode normal : on cache les logs debug, on garde info/warn/error
  return level !== 'debug';
}

// Compteur de lignes visibles maintenu de façon INCRÉMENTALE (Thème 7 perf).
// Avant, chaque log entrant recalculait `_logBuffer.filter(_logLevelVisible)`
// → O(n) par log, donc O(n²) sur une session de plusieurs milliers de lignes.
let _visibleLogCount = 0;

function _updateLogStats() {
  if (logStats) logStats.textContent = `${_visibleLogCount} log(s) affiché(s) / ${_logBuffer.length} total`;
}

function _renderLogs() {
  // On reconstruit le DOM à partir du buffer filtré.
  // Pour les longues sessions, c'est plus rapide que d'ajouter ligne par ligne
  // et ça permet le filtrage rétroactif quand on change de mode.
  const frag = document.createDocumentFragment();
  let visibleCount = 0;
  for (const entry of _logBuffer) {
    if (!_logLevelVisible(entry.level)) continue;
    const line = document.createElement('div');
    line.className = `log-${entry.level || 'info'}`;
    line.textContent = `[${entry.time}] ${entry.message}`;
    frag.appendChild(line);
    visibleCount++;
  }
  logsConsole.innerHTML = '';
  logsConsole.appendChild(frag);
  _visibleLogCount = visibleCount;
  _updateLogStats();
  if (_autoScroll) logsConsole.scrollTop = logsConsole.scrollHeight;
}

window.api.onLog(({ level, message }) => {
  const lvl = level || 'info';
  _logBuffer.push({ level: lvl, message, time: new Date().toLocaleTimeString() });
  // Plafond mémoire : on décrémente le compteur visible si la ligne évincée
  // était visible dans le mode courant.
  while (_logBuffer.length > MAX_LOG_BUFFER) {
    const evicted = _logBuffer.shift();
    if (_logLevelVisible(evicted.level)) _visibleLogCount--;
  }
  if (_logLevelVisible(lvl)) _visibleLogCount++;

  // Détection d'avertissement de changement de structure Leboncoin
  if (message && message.includes('detectStructureChanges') && level === 'warn') {
    const sw = document.getElementById('structureWarning');
    const swt = document.getElementById('structureWarningText');
    if (sw && swt) {
      swt.textContent = 'Leboncoin a peut-être modifié sa structure JSON. Le scraping continue mais certaines données peuvent être incomplètes. Vérifiez les extracteurs si le problème persiste.';
      sw.classList.remove('hidden');
    }
  }

  // Si le log n'est pas visible dans le mode actuel, on ne touche pas au DOM
  // (optimisation : pas de re-render complet pour un log caché).
  if (!_logLevelVisible(lvl)) {
    _updateLogStats();
    return;
  }

  // Ajout incrémental (plus rapide qu'un re-render complet)
  const line = document.createElement('div');
  line.className = `log-${lvl}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logsConsole.appendChild(line);

  // Plafond DOM (séparé du buffer mémoire pour la perf)
  const MAX_LOG_LINES = 1000;
  while (logsConsole.childElementCount > MAX_LOG_LINES) {
    logsConsole.removeChild(logsConsole.firstChild);
  }

  if (_autoScroll) logsConsole.scrollTop = logsConsole.scrollHeight;
  _updateLogStats();
});

// Bascule auto-scroll
if (autoScrollToggleBtn) {
  autoScrollToggleBtn.addEventListener('click', () => {
    _autoScroll = !_autoScroll;
    autoScrollToggleBtn.classList.toggle('active', _autoScroll);
    autoScrollToggleBtn.textContent = _autoScroll ? '⬇ Auto-scroll ON' : '⬇ Auto-scroll OFF';
    if (_autoScroll) logsConsole.scrollTop = logsConsole.scrollHeight;
  });
}

// Bascule mode normal / debug
if (logModeToggleBtn) {
  logModeToggleBtn.addEventListener('click', () => {
    _logMode = _logMode === 'normal' ? 'debug' : 'normal';
    logModeToggleBtn.textContent = _logMode === 'debug' ? '🐛 Mode debug' : '🩻 Mode normal';
    logModeToggleBtn.classList.toggle('active', _logMode === 'debug');
    logModeToggleBtn.title = _logMode === 'debug'
      ? 'Mode Debug : tous les logs (y compris détaillés). Cliquez pour revenir au mode normal.'
      : 'Mode normal : logs principaux uniquement. Cliquez pour le mode Debug complet.';
    _renderLogs();
  });
}

// Copier tous les logs affichés
if (copyLogsBtn) {
  copyLogsBtn.addEventListener('click', async () => {
    const text = _buildVisibleLogText();
    if (!text) {
      const orig = copyLogsBtn.textContent;
      copyLogsBtn.textContent = 'Rien à copier';
      setTimeout(() => { copyLogsBtn.textContent = orig; }, 1500);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy');
      document.body.removeChild(ta);
    }
    const orig = copyLogsBtn.textContent;
    copyLogsBtn.textContent = `✅ ${text.split('\n').length} copiés`;
    setTimeout(() => { copyLogsBtn.textContent = orig; }, 2000);
  });
}

// Exporter les logs affichés dans un fichier .log (via le main process).
if (exportLogsBtn) {
  exportLogsBtn.addEventListener('click', async () => {
    const text = _buildVisibleLogText();
    const orig = exportLogsBtn.textContent;
    if (!text) {
      exportLogsBtn.textContent = 'Rien à exporter';
      setTimeout(() => { exportLogsBtn.textContent = orig; }, 1500);
      return;
    }
    try {
      const res = await window.api.exportLogs(text);
      if (res && res.ok) {
        exportLogsBtn.textContent = '✅ Exporté';
      } else {
        exportLogsBtn.textContent = '⚠️ Échec';
      }
    } catch {
      exportLogsBtn.textContent = '⚠️ Échec';
    }
    setTimeout(() => { exportLogsBtn.textContent = orig; }, 2500);
  });
}

// Vider l'affichage + le buffer
if (clearLogsBtn) {
  clearLogsBtn.addEventListener('click', () => {
    _logBuffer = [];
    _visibleLogCount = 0;
    logsConsole.innerHTML = '';
    if (logStats) logStats.textContent = '0 log(s) affiché(s)';
  });
}
