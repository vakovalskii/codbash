'use strict';

// Minimal, safe bridge exposed to the loaded dashboard page. contextIsolation
// is on and nodeIntegration off, so the renderer only sees exactly what we
// expose here — a single method that opens the native folder picker.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codbashDesktop', {
  isDesktop: true,
  // Resolves to the chosen absolute folder path, or null if the user cancels.
  pickFolder: () => ipcRenderer.invoke('codbash:pick-folder'),
  // Keyboard shortcuts the native menu would otherwise swallow (e.g. Cmd+W
  // closing the whole window). Main intercepts them and forwards the name here
  // so the page can act (close a tab instead). cb receives the shortcut name.
  onShortcut: (cb) => ipcRenderer.on('codbash:shortcut', (_e, name) => cb(name)),
  // Ask main to close the window (used when a shortcut has no in-page meaning).
  closeWindow: () => ipcRenderer.send('codbash:close-window'),
  // In-app updater (electron-updater). The dashboard's update banner drives this:
  //   onState(cb) → receives {state, version?, percent?, message?} pushes
  //   download() → start downloading the available update
  //   install()  → relaunch onto the downloaded update
  //   check()    → force a check now
  //   openReleases() → fallback: open the GitHub releases page in the browser
  updater: {
    onState: (cb) => ipcRenderer.on('codbash:update-state', (_e, s) => cb(s)),
    check: () => ipcRenderer.invoke('codbash:update-check'),
    download: () => ipcRenderer.invoke('codbash:update-download'),
    install: () => ipcRenderer.invoke('codbash:update-install'),
    openReleases: () => ipcRenderer.send('codbash:open-releases'),
  },
});
