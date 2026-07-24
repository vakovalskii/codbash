'use strict';

// Minimal, safe bridge exposed to the loaded dashboard page. contextIsolation
// is on and nodeIntegration off, so the renderer only sees exactly what we
// expose here — a single method that opens the native folder picker.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codbashDesktop', {
  isDesktop: true,
  // Resolves to the chosen absolute folder path, or null if the user cancels.
  pickFolder: () => ipcRenderer.invoke('codbash:pick-folder'),
  // Desktop OTA is owned by the Electron main process. The page can request a
  // check, install an already-downloaded update, and subscribe to status events.
  checkForUpdates: () => ipcRenderer.invoke('codbash:update-check'),
  installUpdate: () => ipcRenderer.invoke('codbash:update-install'),
  onUpdateEvent: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_e, event) => cb(event);
    ipcRenderer.on('codbash:update-event', handler);
    return () => ipcRenderer.removeListener('codbash:update-event', handler);
  },
  // Keyboard shortcuts the native menu would otherwise swallow (e.g. Cmd+W
  // closing the whole window). Main intercepts them and forwards the name here
  // so the page can act (close a tab instead). cb receives the shortcut name.
  onShortcut: (cb) => ipcRenderer.on('codbash:shortcut', (_e, name) => cb(name)),
  // Ask main to close the window (used when a shortcut has no in-page meaning).
  closeWindow: () => ipcRenderer.send('codbash:close-window'),
});
