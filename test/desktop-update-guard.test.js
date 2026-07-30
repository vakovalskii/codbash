// Guards the desktop-mode refusal of the npm-based self-update route.
//
// In the Electron desktop app, `POST /api/update` (which runs `npm i -g
// codbash-app@latest`) is wrong: it would update an unrelated npm-global copy
// while the app keeps running its bundled server, so the "restart" lands back on
// the old version. desktop/main.js sets CODBASH_DESKTOP=1 when it spawns the
// server, and the server must refuse the route with 400. This is the single
// feature flag that makes the desktop use electron-updater instead — a future
// refactor of the spawn options must not silently drop it, so we pin it here.
//
// We only assert the desktop (guarded) path: the non-desktop path actually runs
// `npm i -g` + restart and is destructive, so it is deliberately NOT exercised.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForReady(port, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/version', timeout: 1500 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('server did not become ready'));
        else setTimeout(attempt, 200);
      });
      req.on('timeout', () => { req.destroy(); if (Date.now() > deadline) reject(new Error('timeout')); else setTimeout(attempt, 200); });
    };
    attempt();
  });
}

function post(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: urlPath, timeout: 5000 }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        let body = null;
        try { body = buf ? JSON.parse(buf) : null; } catch {}
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    req.end();
  });
}

test('POST /api/update is refused (400) when CODBASH_DESKTOP=1', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, 'run', `--port=${port}`, '--host=127.0.0.1', '--no-browser'], {
    env: Object.assign({}, process.env, { CODBASH_DESKTOP: '1' }),
    stdio: 'ignore',
  });
  try {
    await waitForReady(port, 15000);
    const res = await post(port, '/api/update');
    assert.equal(res.status, 400, 'desktop mode must refuse the npm self-update route');
    assert.ok(res.body && res.body.ok === false, 'response should carry ok:false');
  } finally {
    child.kill('SIGKILL');
  }
});
