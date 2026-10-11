function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Placeholder d'image 100% local (data-URI SVG) — évite toute dépendance réseau
// (via.placeholder.com) lorsqu'une annonce n'a pas de photo ou en mode hors-ligne.
const PLACEHOLDER_SVG = (label) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='250'><rect width='100%' height='100%' fill='#1e293b'/><text x='50%' y='50%' fill='#64748b' font-family='sans-serif' font-size='18' text-anchor='middle' dominant-baseline='middle'>${label || 'Pas de photo'}</text></svg>`
  )}`;
const noPhotoUrl = () => PLACEHOLDER_SVG('Pas de photo');

// Échappe une valeur injectée dans un attribut HTML contenant du JS
// (ex: onclick="func('VALUE')"). Double contexte : attribut HTML (") +
// chaîne JS ('\). escapeHtml ne convient PAS ici car il transformerait ' en
// &#39; que le navigateur décode en ' avant d'exécuter le JS → casserait la
// chaîne JS. On échappe donc \ et ' pour le JS, puis " et & pour le HTML.
function escapePath(pathStr) {
  if (!pathStr) return '';
  return String(pathStr)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    // '&' en PREMIER (avant '&quot;') : sinon l'échappement des guillemets
    // injecterait un '&' qui serait ensuite transformé en '&amp;' → '&amp;quot;'
    // affiché littéralement et double-encodage. L'ordre initial était buggé.
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

window.openUrl = (urlStr) => {
  if (urlStr) window.api.openExternal(urlStr);
};

window.openFolder = async (folderPath) => {
  if (!folderPath) return;
  try {
    const res = await window.api.openFolder(folderPath);
    if (res && res.success === false) {
      alert('Impossible d\'ouvrir le dossier : ' + (res.error || 'erreur inconnue'));
    }
  } catch (err) {
    alert('Impossible d\'ouvrir le dossier : ' + (err.message || err));
  }
};

window.openFile = async (filePath) => {
  if (!filePath) return;
  try {
    const res = await window.api.openFile(filePath);
    if (res && res.success === false) {
      alert('Impossible d\'ouvrir le fichier : ' + (res.error || 'erreur inconnue'));
    }
  } catch (err) {
    alert('Impossible d\'ouvrir le fichier : ' + (err.message || err));
  }
};
