// codbash desktop — Electron shell around the existing codbash server.
//
// Design goal: an ADDITION, never a downgrade. We do NOT reimplement anything.
// The Electron main process boots the unmodified codbash server as a real Node
// child process (so the native @lydell/node-pty loads under its own Node ABI —
// no Electron rebuild, the browser terminal keeps working), waits until it
// answers, then points a BrowserWindow at it.
'use strict';

const { app, BrowserWindow, shell, dialog, Menu } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');

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

// Where the codbash server lives: repo layout in dev, bundled resources when packaged.
function resolveServerEntry() {
  const dev = path.join(__dirname, '..', 'bin', 'cli.js');
  const packaged = path.join(process.resourcesPath || '', 'app', 'bin', 'cli.js');
  return app.isPackaged ? packaged : dev;
}

// The Node binary used to run the server. We deliberately avoid Electron's own
// Node (ELECTRON_RUN_AS_NODE) because its ABI differs from the prebuilt
// node-pty. Prefer an explicit override, then a bundled node, then PATH node.
function resolveNodeBin() {
  if (process.env.CODBASH_NODE) return process.env.CODBASH_NODE;
  const bundled = path.join(process.resourcesPath || '', process.platform === 'win32' ? 'node.exe' : 'node');
  try { if (app.isPackaged && fs.existsSync(bundled)) return bundled; } catch (_e) {}
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

function startServer(port) {
  const entry = resolveServerEntry();
  const nodeBin = resolveNodeBin();
  serverProc = spawn(nodeBin, [entry, 'run', '--port=' + port, '--host=127.0.0.1', '--no-browser'], {
    env: Object.assign({}, process.env, { CODEDASH_HOST: '127.0.0.1' }),
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

async function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 920,
    minHeight: 600,
    title: 'codbash',
    backgroundColor: '#0b0d12',
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });

  // http/https links open in the user's real browser, not inside the app.
  win.webContents.setWindowOpenHandler(function (details) {
    if (/^https?:/i.test(details.url)) { shell.openExternal(details.url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  await win.loadURL('http://127.0.0.1:' + serverPort + '/');

  if (SMOKE) {
    // Smoke test: prove the window + server came up, then leave cleanly.
    process.stdout.write('[desktop] SMOKE OK — window loaded on port ' + serverPort + '\n');
    setTimeout(function () { app.isQuitting = true; app.quit(); }, 1200);
  }
}

app.whenReady().then(async function () {
  try {
    serverPort = await getFreePort();
    startServer(serverPort);
    await waitForServer(serverPort);
    await createWindow();
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
