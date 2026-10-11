const historyTableBody = document.getElementById('historyTableBody');
const openMainFolderBtn = document.getElementById('openMainFolderBtn');

// PAGE 3 : HISTORIQUE
async function loadHistoryPage() {
  try {
    allJobsCache = await window.api.getHistory();
    renderHistoryTable(allJobsCache);
  } catch (err) {
    historyTableBody.innerHTML = `<tr><td colspan="4" class="text-center">Erreur : ${escapeHtml(err && err.message ? err.message : 'inconnue')}</td></tr>`;
  }
}

function renderHistoryTable(jobs) {
  if (!jobs || jobs.length === 0) {
    historyTableBody.innerHTML = '<tr><td colspan="4" class="text-center">Aucun scraping trouvé dans output/jobs/</td></tr>';
    return;
  }

  historyTableBody.innerHTML = jobs
    .map(
      (j) => `
    <tr>
              <td>${escapeHtml(j.date)}${(j.exportMeta && ((j.exportMeta.profileId || j.exportMeta.exportMode) === 'custom')) ? '<br><span class="tag-export-custom" title="Mode Personnalisé : uniquement les champs sélectionnés">✂️ Personnalisé</span>' : ''}</td>
      <td><strong>${escapeHtml(String(j.adsCount))}</strong> annonces</td>
      <td>
        <div class="file-tags">
          ${j.files.json ? `<span class="file-tag" data-action="openFile" data-id="${escapeHtml(j.files.json)}">JSON</span>` : ''}
          ${j.files.txt ? `<span class="file-tag tag-txt" data-action="openFile" data-id="${escapeHtml(j.files.txt)}">TXT</span>` : ''}
        </div>
      </td>
      <td>
        ${j.id ? `<span class="file-tag" data-action="askDeleteJob" data-id="${escapeHtml(j.id)}">🗑</span>` : ''}
      </td>
    </tr>
  `
    )
    .join('');
}

window.askDeleteJob = (jobId) => {
  pendingDeleteJobId = jobId;
  modalMessage.textContent = `Voulez-vous vraiment supprimer définitivement le scraping "${jobId}" ?`;
  confirmModal.classList.remove('hidden');
};

modalCancelBtn.addEventListener('click', () => {
  confirmModal.classList.add('hidden');
  pendingDeleteJobId = null;
});

modalConfirmBtn.addEventListener('click', async () => {
  if (!pendingDeleteJobId || isConfirming) return;
  const jobId = pendingDeleteJobId;
  isConfirming = true;
  modalConfirmBtn.disabled = true;
  try {
    await window.api.deleteJob(jobId);
    confirmModal.classList.add('hidden');
    pendingDeleteJobId = null;
    // Rafraîchit l'onglet de données actif (Historique, Explorateur ou Stats).
    // Avant, seul l'historique était rafraîchi ; si l'utilisateur supprimait un
    // job depuis l'historique puis allait sur l'Explorateur, le sessionSelect
    // pouvait encore référencer le job supprimé (phantom) jusqu'au prochain
    // getHistory. refreshActiveDataTab couvre les 3 onglets de données.
    await loadHistoryPage();
    // Nettoie le comparateur : les ads du job supprimé ne sont plus dans
    // allJobsCache. Sans cela, compareCount affichait un nombre supérieur aux
    // colonnes réellement affichables (IDs fantômes).
    if (compareSet.size > 0) {
      const validIds = new Set();
      allJobsCache.forEach((j) => {
        if (Array.isArray(j.ads)) j.ads.forEach((a) => validIds.add(String(a.id)));
      });
      compareSet = new Set([...compareSet].filter((id) => validIds.has(id)));
      compareCount.textContent = compareSet.size;
    }
    refreshActiveDataTab();
  } catch (err) {
    console.error('[confirmDelete] Échec suppression :', err);
    confirmModal.classList.add('hidden');
    pendingDeleteJobId = null;
  } finally {
    isConfirming = false;
    modalConfirmBtn.disabled = false;
  }
});

openMainFolderBtn.addEventListener('click', async () => {
  try {
    // Ouvrir le dossier results/ (JOBS_DIR) qui contient les résultats du scraping
    const res = await window.api.openJobsFolder();
    if (res && res.success === false) {
      showToast('Impossible d\'ouvrir le dossier results : ' + (res.error || 'erreur inconnue'), 'error');
    }
  } catch (err) {
    showToast('Impossible d\'ouvrir le dossier results : ' + (err.message || err), 'error');
  }
});
