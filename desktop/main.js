// codbash desktop — Electron shell around the existing codbash server.
//
// Design goal: an ADDITION, never a downgrade. We do NOT reimplement anything.
// The Electron main process boots the unmodified codbash server as a real Node
// child process (so the native @lydell/node-pty loads under its own Node ABI —
// no Electron rebuild, the browser terminal keeps working), waits until it
// answers, then points a BrowserWindow at it.
'use strict';

const { app, BrowserWindow, shell, dialog, Menu, ipcMain } = require('electron');
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
    // CODBASH_DESKTOP=1 tells the server it runs inside the Electron shell, so the
    // web self-update route (`POST /api/update` → `npm i -g`) refuses: it would
    // update an unrelated npm-global copy while the app keeps running its bundled
    // server. In the desktop app, updates go through electron-updater (below).
    env: Object.assign({}, process.env, { CODEDASH_HOST: '127.0.0.1', CODBASH_DESKTOP: '1' }),
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
  // The renderer decides a shortcut had no in-page meaning (e.g. Cmd+W outside
  // the Workspace) and asks us to close the window instead.
  ipcMain.on('codbash:close-window', function () { if (win) { try { win.close(); } catch (_e) {} } });

  // ── In-app updater (electron-updater) ──────────────────────────────────────
  // The renderer's update banner drives these. autoDownload is off, so the flow
  // is: check → 'available' → user clicks Download → downloadUpdate() → progress
  // → 'downloaded' → user clicks Restart → quitAndInstall(). See initAutoUpdater.
  //
  // Defense in depth, because these calls are powerful (force-download +
  // quitAndInstall = force-relaunch of the whole app):
  //   1. isTrustedSender — only honor calls from a frame served by our own local
  //      server, so a page the window somehow navigated to can't drive updates.
  //   2. _updateState gating — download only when an update is 'available',
  //      install only once it's 'downloaded'. The renderer's button visibility is
  //      a UX convenience, NOT the security boundary; the main process enforces
  //      the sequence so an out-of-order/forged call can't force a relaunch.
  ipcMain.handle('codbash:update-check', function (event) {
    if (!isTrustedSender(event)) return { error: 'forbidden' };
    if (!getAutoUpdater()) return { unavailable: true };
    // Won't clobber an in-flight/downloaded update (see maybeCheckForUpdates).
    return maybeCheckForUpdates().then(function () { return { ok: true }; });
  });
  ipcMain.handle('codbash:update-download', function (event) {
    if (!isTrustedSender(event)) return { error: 'forbidden' };
    if (_updateState !== 'available') return { error: 'no update available' };
    if (_downloadInFlight) return { ok: true, already: true }; // second click before first progress
    const u = getAutoUpdater();
    if (!u) return { unavailable: true };
    _downloadInFlight = true; // set synchronously so a fast double-click can't double-download
    return u.downloadUpdate().then(function () { return { ok: true }; })
      .catch(function (e) { _downloadInFlight = false; return { error: String((e && e.message) || e) }; });
  });
  ipcMain.handle('codbash:update-install', function (event) {
    if (!isTrustedSender(event)) return { error: 'forbidden' };
    if (_updateState !== 'downloaded') return { error: 'update not downloaded' };
    const u = getAutoUpdater();
    if (!u) return { unavailable: true };
    // Defer so the IPC reply is sent before the app tears down. before-quit sets
    // app.isQuitting and kills the server child, so its exit handler stays quiet.
    setImmediate(function () { try { u.quitAndInstall(); } catch (_e) {} });
    return { ok: true };
  });
  // Fallback when in-place update can't apply (e.g. unsigned build): open the
  // GitHub releases page so the user can still grab the installer manually.
  ipcMain.on('codbash:open-releases', function (event) {
    if (!isTrustedSender(event)) return;
    shell.openExternal('https://github.com/vakovalskii/codbash/releases/latest')
      .catch(function (e) { process.stderr.write('[desktop] openExternal failed: ' + ((e && e.message) || e) + '\n'); });
  });
}

// Only trust IPC from a frame our own local server actually served. Blocks a
// page the window was somehow navigated to (see the will-navigate guard in
// createWindow — this is the second, independent layer) from reaching the
// updater bridge. serverPort is 0 until the server binds; reject until then.
function isTrustedSender(event) {
  try {
    const url = event && event.senderFrame && event.senderFrame.url;
    return !!url && serverPort > 0 && url.indexOf('http://127.0.0.1:' + serverPort + '/') === 0;
  } catch (_e) {
    return false;
  }
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

  // Pin top-level navigation to our own local server. The preload bridge
  // (window.codbashDesktop, incl. the powerful updater) is bound to the WINDOW,
  // not an origin — so without this, navigating the window elsewhere (a stray
  // location.href, a target=_top link, a future CSP regression) would hand that
  // page the update-download/install IPC. External http(s) is opened in the real
  // browser instead; anything else off-origin is simply blocked.
  win.webContents.on('will-navigate', function (event, url) {
    if (serverPort > 0 && url.indexOf('http://127.0.0.1:' + serverPort + '/') === 0) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(function () {});
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

// ── In-app auto-update (electron-updater) ────────────────────────────────────
// Real in-place update: the app downloads the new build from GitHub Releases
// (read via latest-mac.yml / latest.yml) and relaunches onto it — no manual DMG
// download. macOS in-place update REQUIRES a signed build (codbash is signed +
// notarized since v7.14.4); Windows uses the NSIS installer. autoDownload is off
// so the renderer's banner controls when the download starts (Download button)
// and when to relaunch (Restart button). If the updater can't apply (unsigned /
// dev / download error) we emit 'error' and the renderer falls back to opening
// the releases page (codbash:open-releases IPC).
let _autoUpdater = null;
let _autoUpdaterDisabled = false; // hard off for this run (dev/smoke) — never retry
// Lifecycle state, the security boundary for the download/install IPC calls (not
// the renderer's button state). Updated from the autoUpdater events below.
let _updateState = 'idle'; // idle | checking | available | downloading | downloaded | error
let _downloadInFlight = false; // guards against a double downloadUpdate() (fast double-click)
let _updateTimer = null;       // 6h re-check interval id (so it can be cleared)

// Lazy + guarded: electron-updater is a packaged runtime dep. In a from-source
// run (npm start) or an unpacked build it can't apply an update, so we skip it
// and let the renderer degrade to the manual releases page. A dev/smoke run is a
// permanent skip; a transient require() failure is NOT latched, so a later call
// can retry rather than silently disabling updates for the whole session.
//
// Event listeners are attached HERE, at creation, so any checkForUpdates() call
// — whoever triggers it and whenever — always has listeners (EventEmitter drops
// events that fire with none attached, which would silently lose a check result).
function getAutoUpdater() {
  if (_autoUpdaterDisabled) return null;
  if (_autoUpdater) return _autoUpdater;
  if (SMOKE || !app.isPackaged) { _autoUpdaterDisabled = true; return null; }
  try {
    _autoUpdater = require('electron-updater').autoUpdater;
    _autoUpdater.autoDownload = false;         // renderer controls when to download
    _autoUpdater.autoInstallOnAppQuit = true;
    _autoUpdater.allowDowngrade = false;       // never move users backwards
    _autoUpdater.allowPrerelease = false;      // stable channel only, explicit
    _autoUpdater.on('checking-for-update', function () { _updateState = 'checking'; sendUpdateState('checking'); });
    _autoUpdater.on('update-available', function (info) { _updateState = 'available'; sendUpdateState('available', { version: info && info.version }); });
    _autoUpdater.on('update-not-available', function () { _updateState = 'idle'; sendUpdateState('none'); });
    _autoUpdater.on('download-progress', function (p) { _updateState = 'downloading'; sendUpdateState('downloading', { percent: p ? Math.round(p.percent) : 0 }); });
    _autoUpdater.on('update-downloaded', function (info) { _downloadInFlight = false; _updateState = 'downloaded'; sendUpdateState('downloaded', { version: info && info.version }); });
    _autoUpdater.on('error', function (err) { _downloadInFlight = false; _updateState = 'error'; sendUpdateState('error', { message: String((err && err.message) || err) }); });
  } catch (e) {
    // Not latched: a corrupted node_modules today shouldn't kill updates forever.
    process.stderr.write('[desktop] electron-updater load failed: ' + ((e && e.message) || e) + '\n');
    return null;
  }
  return _autoUpdater;
}

function sendUpdateState(state, extra) {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send('codbash:update-state', Object.assign({ state: state }, extra || {})); } catch (_e) {}
}

// A check would call update-not-available → 'none' → hide banner. If an update is
// already downloading or sitting downloaded-and-waiting-to-restart, that would
// wipe the user's "ready to restart" affordance. So skip checks in those states.
function maybeCheckForUpdates() {
  const u = getAutoUpdater();
  if (!u) return Promise.resolve();
  if (_updateState === 'downloading' || _updateState === 'downloaded') return Promise.resolve();
  return u.checkForUpdates().catch(function () {});
}

function initAutoUpdater() {
  const u = getAutoUpdater();
  if (!u) return; // dev / smoke / unpacked — renderer stays on its default UI
  // The initial check is triggered by the renderer (wireDesktopUpdater → check),
  // which also re-triggers on page reload. Here we only own the periodic re-check.
  _updateTimer = setInterval(function () { maybeCheckForUpdates(); }, 6 * 60 * 60 * 1000);
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
