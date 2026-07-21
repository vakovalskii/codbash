'use strict';

// Minimal, safe bridge exposed to the loaded dashboard page. contextIsolation
// is on and nodeIntegration off, so the renderer only sees exactly what we
// expose here — a single method that opens the native folder picker.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codbashDesktop', {
  isDesktop: true,
  // Resolves to the chosen absolute folder path, or null if the user cancels.
  pickFolder: () => ipcRenderer.invoke('codbash:pick-folder'),
});
