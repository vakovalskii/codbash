// codbash desktop — Electron shell around the existing codbash server.
//
// Design goal: an ADDITION, never a downgrade. We do NOT reimplement anything.
// The Electron main process boots the unmodified codbash server as a real Node
// child process (so the native @lydell/node-pty loads under its own Node ABI —
// no Electron rebuild, the browser terminal keeps working), waits until it
// answers, then points a BrowserWindow at it.
'use strict';

const { app, BrowserWindow, shell, dialog, Menu, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

let serverProc = null;
let win = null;
let serverPort = 0;
let updateState = { status: 'idle' };
let updateCheckInFlight = null;
const SMOKE = !!process.env.CODBASH_SMOKE; // launch, verify, auto-quit (CI/local test)

// Grab an ephemeral loopback port the OS hands us, then release it for the server.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// A STABLE loopback port keeps the window's origin (http://127.0.0.1:<port>)
// constant across launches. This is REQUIRED for persistence: localStorage is
// scoped to the origin, so a random ephemeral port silently wiped EVERYTHING
// origin-scoped every launch — theme, starred sessions, tags, terminal prefs,
// and the saved Workspace session used to restore tabs/panes. We therefore
// prefer a fixed port and only fall back to an ephemeral one if it is genuinely
// occupied (rare — another instance or an unrelated listener).
const PREFERRED_PORT = 51763;
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}
async function resolveStablePort() {
  if (process.env.CODBASH_PORT) {
    const p = parseInt(process.env.CODBASH_PORT, 10);
    if (Number.isInteger(p) && p > 0 && await isPortFree(p)) return p;
  }
  if (await isPortFree(PREFERRED_PORT)) return PREFERRED_PORT;
  return getFreePort();
}

// Where the codbash server lives: repo layout in dev, bundled resources when packaged.
function resolveServerEntry() {
  const dev = path.join(__dirname, '..', 'bin', 'cli.js');
  const packaged = path.join(process.resourcesPath || '', 'app', 'bin', 'cli.js');
  return app.isPackaged ? packaged : dev;
}

// The Node binary used to run the server. We deliberately avoid Electron's own
// Node (ELECTRON_RUN_AS_NODE) because its ABI differs from the prebuilt
// node-pty.
//
// A Finder/`open`-launched macOS app inherits only a minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), so bare "node" (installed via nvm, Homebrew,
// conda, etc.) usually isn't found. We therefore resolve an absolute path:
// explicit override → bundled node → common install locations → the user's
// login shell → bare "node" as a last resort.
function resolveNodeBin() {
  if (process.env.CODBASH_NODE) return process.env.CODBASH_NODE;

  const bundled = path.join(process.resourcesPath || '', process.platform === 'win32' ? 'node.exe' : 'node');
  try { if (app.isPackaged && fs.existsSync(bundled)) return bundled; } catch (_e) {}

  if (process.platform === 'win32') return 'node.exe';

  const home = os.homedir();
  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    path.join(home, '.local/bin/node'),
    path.join(home, '.volta/bin/node'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_e) {}
  }

  // Ask the user's login shell (picks up nvm/conda/asdf shims a plain env misses).
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-lic', 'command -v node'], { encoding: 'utf8', timeout: 6000 });
    const p = out.split('\n').map(function (s) { return s.trim(); }).filter(Boolean).pop();
    if (p && fs.existsSync(p)) return p;
  } catch (_e) {}

  return 'node';
}

function startServer(port) {
  const entry = resolveServerEntry();
  const nodeBin = resolveNodeBin();
  serverProc = spawn(nodeBin, [entry, 'run', '--port=' + port, '--host=127.0.0.1', '--no-browser'], {
    env: Object.assign({}, process.env, {
      CODEDASH_HOST: '127.0.0.1',
      CODBASH_DESKTOP: '1',
      CODBASH_DESKTOP_VERSION: app.getVersion(),
      CODBASH_DESKTOP_PACKAGED: app.isPackaged ? '1' : '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', function (d) { process.stdout.write('[codbash] ' + d); });
  serverProc.stderr.on('data', function (d) { process.stderr.write('[codbash] ' + d); });
  serverProc.on('exit', function (code) {
    serverProc = null;
    if (!app.isQuitting && !SMOKE) {
      dialog.showErrorBox('codbash stopped', 'The codbash server exited (code ' + code + ').');
      app.quit();
    }
  });
}

function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  return new Promise(function (resolve, reject) {
    function attempt() {
      const req = http.get({ host: '127.0.0.1', port: port, path: '/', timeout: 1500 }, function (res) {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry();
      });
      req.on('error', retry);
      req.on('timeout', function () { req.destroy(); retry(); });
    }
    function retry() {
      if (Date.now() > deadline) reject(new Error('codbash server did not become ready in time'));
      else setTimeout(attempt, 300);
    }
    attempt();
  });
}

// Native folder picker for the "Add project" flow. Returns the chosen absolute
// path, or null on cancel. Registered once (guarded) so re-creating the window
// doesn't stack duplicate handlers.
let _pickFolderRegistered = false;
function registerIpc() {
  if (_pickFolderRegistered) return;
  _pickFolderRegistered = true;
  ipcMain.handle('codbash:pick-folder', async function () {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a project folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
    return res.filePaths[0];
  });
  ipcMain.handle('codbash:update-check', async function () {
    return checkForUpdates(true);
  });
  ipcMain.handle('codbash:update-install', async function () {
    installDownloadedUpdate();
    return { ok: true };
  });
  // The renderer decides a shortcut had no in-page meaning (e.g. Cmd+W outside
  // the Workspace) and asks us to close the window instead.
  ipcMain.on('codbash:close-window', function () { if (win) { try { win.close(); } catch (_e) {} } });
}

async function createWindow() {
  registerIpc();
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 920,
    minHeight: 600,
    title: 'codbash',
    backgroundColor: '#0b0d12',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // http/https links open in the user's real browser, not inside the app.
  win.webContents.setWindowOpenHandler(function (details) {
    if (/^https?:/i.test(details.url)) { shell.openExternal(details.url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  // Cmd/Ctrl+W would hit the native menu's "Close Window" before the page ever
  // sees the keystroke. Intercept it here so it can close the ACTIVE TAB instead
  // (Chrome-like). We forward it to the renderer, which closes a tab or — if
  // there's nothing to close — calls back to close the window. Cmd+T and
  // Cmd+Shift+T are NOT default menu accelerators, so the page handles those.
  win.webContents.on('before-input-event', function (event, input) {
    if (input.type !== 'keyDown') return;
    const mod = input.meta || input.control;
    if (mod && !input.shift && !input.alt && (input.key === 'w' || input.key === 'W')) {
      event.preventDefault();
      try { win.webContents.send('codbash:shortcut', 'close-tab'); } catch (_e) {}
    }
  });

  await win.loadURL('http://127.0.0.1:' + serverPort + '/');

  if (SMOKE) {
    // Smoke test: prove the window + server came up, then leave cleanly.
    process.stdout.write('[desktop] SMOKE OK — window loaded on port ' + serverPort + '\n');
    setTimeout(function () { app.isQuitting = true; app.quit(); }, 1200);
  }
}

function sendUpdateEvent(type, payload) {
  const event = Object.assign({ type: type }, payload || {});
  if (win && win.webContents) {
    try { win.webContents.send('codbash:update-event', event); } catch (_e) {}
  }
}

function setUpdateState(status, payload) {
  updateState = Object.assign({ status: status }, payload || {});
  sendUpdateEvent(status, updateState);
  return updateState;
}

function installDownloadedUpdate() {
  if (SMOKE || updateState.status !== 'downloaded') return;
  app.isQuitting = true;
  if (serverProc) { try { serverProc.kill(); } catch (_e) {} }
  autoUpdater.quitAndInstall(false, true);
}

function promptInstallUpdate(info) {
  if (SMOKE) return;
  dialog.showMessageBox(win || undefined, {
    type: 'info',
    message: 'codbash ' + info.version + ' is ready to install',
    detail: 'Restart codbash now to finish the update?',
    buttons: ['Restart to update', 'Later'],
    defaultId: 0,
    cancelId: 1,
  }).then(function (r) {
    if (r.response === 0) installDownloadedUpdate();
  }).catch(function () {});
}

function checkForUpdates(interactive) {
  if (SMOKE) return Promise.resolve(updateState);
  if (!app.isPackaged) {
    const state = setUpdateState('unavailable', { reason: 'dev', current: app.getVersion() });
    if (interactive) {
      dialog.showMessageBox(win || undefined, {
        type: 'info',
        message: 'Desktop auto-update is disabled in development',
        detail: 'Packaged builds use GitHub Releases via electron-updater.',
        buttons: ['OK'],
      }).catch(function () {});
    }
    return Promise.resolve(state);
  }
  if (updateCheckInFlight) return updateCheckInFlight;
  updateCheckInFlight = autoUpdater.checkForUpdates()
    .then(function () { return updateState; })
    .catch(function (e) {
      return setUpdateState('error', { message: String((e && e.message) || e) });
    })
    .finally(function () { updateCheckInFlight = null; });
  return updateCheckInFlight;
}

function initAutoUpdater() {
  if (SMOKE) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', function () {
    setUpdateState('checking', { current: app.getVersion() });
  });
  autoUpdater.on('update-available', function (info) {
    setUpdateState('available', { version: info.version, current: app.getVersion() });
  });
  autoUpdater.on('update-not-available', function (info) {
    setUpdateState('idle', { version: info.version, current: app.getVersion() });
  });
  autoUpdater.on('download-progress', function (progress) {
    setUpdateState('downloading', {
      current: app.getVersion(),
      percent: progress && typeof progress.percent === 'number' ? progress.percent : null,
    });
  });
  autoUpdater.on('update-downloaded', function (info) {
    setUpdateState('downloaded', { version: info.version, current: app.getVersion() });
    promptInstallUpdate(info);
  });
  autoUpdater.on('error', function (e) {
    setUpdateState('error', { message: String((e && e.message) || e), current: app.getVersion() });
  });
  checkForUpdates(false);
  // Re-check every 6 hours while the app stays open.
  setInterval(function () { checkForUpdates(false); }, 6 * 60 * 60 * 1000);
}

app.whenReady().then(async function () {
  try {
    serverPort = await resolveStablePort();
    startServer(serverPort);
    await waitForServer(serverPort);
    await createWindow();
    initAutoUpdater();
  } catch (e) {
    dialog.showErrorBox('codbash failed to start', String((e && e.message) || e));
    app.isQuitting = true;
    app.quit();
    return;
  }
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', function () {
  app.isQuitting = true;
  if (serverProc) { try { serverProc.kill(); } catch (_e) {} }
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
