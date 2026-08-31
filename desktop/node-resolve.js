// Locate the Node binary that runs the bundled codbash server.
//
// Extracted from main.js (which requires electron and can't be unit-tested
// under `node --test`). The resolution order is: explicit override → bundled
// node → common install locations → nvm-installed versions (the user's
// default alias first) → the user's login-shell PATH → bare "node" as a last
// resort.
//
// The login-shell step deliberately reuses src/shell-path.js rather than
// spawning its own probe: rc files freely print to stdout (oh-my-zsh
// warnings, iTerm2 OSC 1337 escape sequences without a trailing newline), so
// the old `$SHELL -lic 'command -v node'` + "take the last line" approach
// returned the node path glued to escape garbage and silently failed.
// shell-path.js already solves this with an \x01-sentinel probe, logs probe
// failures, and caches the ~1s interactive shell spawn on disk for a day —
// duplicating that machinery here would just drift.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// First PATH entry that holds a node binary ('' when none). Relative entries
// are skipped — a poisoned PATH must not make us spawn ./node.
function findNodeInPathString(pathString, exists) {
  for (const dir of String(pathString || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const p = path.join(dir, 'node');
    try { if (exists(p)) return p; } catch (_e) {}
  }
  return '';
}

// Installed nvm nodes (~/.nvm/versions/node/vX.Y.Z/bin/node). The version the
// user actually runs — ~/.nvm/alias/default, exact ("v20.20.0") or prefix
// ("20", "20.3") form — comes first so we never silently override their
// default with a newer install (the prebuilt node-pty ABI may not match it);
// the rest follow highest-first (numeric compare — lexicographic would rank
// v8 above v20). Existence of bin/node is left to the caller's candidate
// loop, which owns the injected existsSync seam.
function listNvmNodes(home) {
  const root = path.join(home, '.nvm', 'versions', 'node');
  let entries;
  try { entries = fs.readdirSync(root); } catch (_e) { return []; }

  const versions = entries
    .map((name) => ({ name, parts: /^v(\d+)\.(\d+)\.(\d+)$/.exec(name) }))
    .filter((e) => e.parts)
    .sort((a, b) =>
      (b.parts[1] - a.parts[1]) || (b.parts[2] - a.parts[2]) || (b.parts[3] - a.parts[3]));

  let alias = '';
  try { alias = fs.readFileSync(path.join(home, '.nvm', 'alias', 'default'), 'utf8').trim(); } catch (_e) {}
  if (alias) {
    const want = alias.replace(/^v/, '');
    // Highest install matching the alias exactly or by prefix ("20" → v20.20.0).
    const i = versions.findIndex((e) => {
      const have = e.name.slice(1);
      return have === want || have.startsWith(want + '.');
    });
    if (i > 0) versions.unshift(versions.splice(i, 1)[0]);
  }

  return versions.map((e) => path.join(root, e.name, 'bin', 'node'));
}

// src/shell-path.js ships beside the server: repo layout in dev,
// extraResources (app/src) when packaged — mirroring resolveServerEntry in
// main.js. Electron can require() it from outside the asar.
function loadShellPathModule(o) {
  const candidates = [
    o.isPackaged && o.resourcesPath ? path.join(o.resourcesPath, 'app', 'src', 'shell-path.js') : null,
    path.join(__dirname, '..', 'src', 'shell-path.js'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch (_e) {}
  }
  return null;
}

// Options exist for tests only; production callers pass the real process/app
// values (see main.js). `existsSync` and `shellPathModule` default to the
// real thing.
function resolveNodeBin(o) {
  o = o || {};
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const exists = o.existsSync || fs.existsSync;

  if (env.CODBASH_NODE) return env.CODBASH_NODE;

  const bundled = path.join(o.resourcesPath || '', platform === 'win32' ? 'node.exe' : 'node');
  try { if (o.isPackaged && exists(bundled)) return bundled; } catch (_e) {}

  if (platform === 'win32') return 'node.exe';

  const home = o.home || os.homedir();
  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    path.join(home, '.local/bin/node'),
    path.join(home, '.volta/bin/node'),
    ...listNvmNodes(home),
  ];
  for (const c of candidates) {
    try { if (exists(c)) return c; } catch (_e) {}
  }

  const shellPath = 'shellPathModule' in o ? o.shellPathModule : loadShellPathModule(o);
  if (shellPath) {
    try {
      const found = findNodeInPathString(shellPath.captureLoginShellPath(), exists);
      if (found) return found;
    } catch (_e) {} // probe failures are logged inside shell-path.js
  }

  return 'node';
}

module.exports = { findNodeInPathString, listNvmNodes, resolveNodeBin };
