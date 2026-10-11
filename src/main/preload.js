'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startScraping: (config) => ipcRenderer.send('job:start', config),
  stopScraping: () => ipcRenderer.send('job:stop'),

  // removeAllListeners avant (re)souscription : évite la fuite de listeners
  // à chaque ré-abonnement (changement d'onglet, relance d'écoute).
  onLog: (callback) => {
    ipcRenderer.removeAllListeners('log');
    ipcRenderer.on('log', (event, data) => callback(data));
  },
  onProgress: (callback) => {
    ipcRenderer.removeAllListeners('progress');
    ipcRenderer.on('progress', (event, data) => callback(data));
  },
  onStatusChange: (callback) => {
    ipcRenderer.removeAllListeners('status');
    ipcRenderer.on('status', (event, data) => callback(data));
  },

  getHistory: () => ipcRenderer.invoke('job:getHistory'),
  getAdHistory: () => ipcRenderer.invoke('job:getAdHistory'),
  deleteJob: (jobId) => ipcRenderer.invoke('job:delete', jobId),

  openFolder: (pathStr) => ipcRenderer.invoke('file:openFolder', pathStr),
  openJobsFolder: () => ipcRenderer.invoke('jobs:openFolder'),
  openFile: (pathStr) => ipcRenderer.invoke('file:openFile', pathStr),
  openExternal: (urlStr) => ipcRenderer.invoke('shell:openExternal', urlStr),

  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  exportLogs: (text) => ipcRenderer.invoke('logs:export', text),
  getDiagnostics: () => ipcRenderer.invoke('app:getDiagnostics'),
  checkChromium: () => ipcRenderer.invoke('app:checkChromium'),

  checkNetwork: () => ipcRenderer.invoke('network:check'),

  getSecret: (key) => ipcRenderer.invoke('secret:get', key),
  setSecret: (key, value) => ipcRenderer.invoke('secret:set', { key, value }),
  hasSecret: (key) => ipcRenderer.invoke('secret:has', key),
  removeSecret: (key) => ipcRenderer.invoke('secret:remove', key),

  toggleWidget: () => ipcRenderer.send('widget:toggle'),
  sendWidgetProgress: (data) => ipcRenderer.send('widget:progress', data),
  sendWidgetStatus: (data) => ipcRenderer.send('widget:status', data),
});