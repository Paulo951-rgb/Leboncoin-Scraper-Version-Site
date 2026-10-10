'use strict';

// ─── État partagé mutable (accessible depuis tous les modules) ──────────────
let allJobsCache = [];
let includeSellerData = true;
let isOffline = false;
let viewMode = localStorage.getItem('explorer-view') || 'table';
let compareSet = new Set();
let starredAds = new Set();
let mapInstance = null;
let mapMarkerLayer = null;
let mapRenderGen = 0;
let pendingDeleteJobId = null;
let isConfirming = false;
let priceDistChartInstance = null;
let sellerChartInstance = null;
let topCitiesChartInstance = null;
let transactionChartInstance = null;
let widgetActive = false;
let presets = [];

// ─── État du système de logs (partagé entre logsModule et le reste) ──────────
let _logBuffer = [];
let _logMode = 'normal';
let _autoScroll = true;
const MAX_LOG_BUFFER = 3000;

// ─── Éléments DOM partagés entre plusieurs modules ───────────────────────────
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusText = document.getElementById('statusText');
const etaText = document.getElementById('etaText');
const progressBar = document.getElementById('progressBar');
const sessionSelect = document.getElementById('sessionSelect');
const statsSessionSelect = document.getElementById('statsSessionSelect');
const confirmModal = document.getElementById('confirmModal');
const modalMessage = document.getElementById('modalMessage');
const modalCancelBtn = document.getElementById('modalCancelBtn');
const modalConfirmBtn = document.getElementById('modalConfirmBtn');
const adDetailModal = document.getElementById('adDetailModal');
const compareModal = document.getElementById('compareModal');
const settingsModal = document.getElementById('settingsModal');
const proxyUrl = document.getElementById('proxyUrl');

// ─── Favoris : chargement initial depuis localStorage ───────────────────────
try {
  const raw = localStorage.getItem('starred-ads');
  if (raw) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) starredAds = new Set(parsed);
  }
} catch {
  starredAds = new Set();
}

// ─── Presets : chargement initial depuis localStorage ────────────────────────
try {
  const raw = localStorage.getItem('search-presets');
  if (raw) presets = JSON.parse(raw);
  if (!Array.isArray(presets)) presets = [];
} catch {
  presets = [];
}
