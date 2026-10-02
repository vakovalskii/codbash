// Unit tests for desktop/node-resolve.js — locating the Node binary that runs
// the bundled server (extracted from desktop/main.js, which requires electron
// and therefore cannot be loaded under `node --test`).
//
// The bug this pins down: the login-shell fallback used to run
// `$SHELL -lic 'command -v node'` and take the LAST line of stdout. Shell rc
// files freely print to stdout — iTerm2 shell integration emits OSC 1337
// escape sequences WITHOUT a trailing newline, so the node path came back
// glued to escape garbage, existsSync() rejected it, and the app fell through
// to bare `node`, which a Finder launch (PATH=/usr/bin:/bin:/usr/sbin:/sbin)
// cannot find → "Uncaught Exception: spawn node ENOENT". The fix reuses
// src/shell-path.js's rc-noise-proof sentinel probe (see its own tests) and
// scans the captured PATH for a node binary.
//
// NOTE: injected existsSync fakes are scoped to the fake home on purpose —
// resolveNodeBin checks absolute standard paths (/usr/local/bin/node,
// /opt/homebrew/bin/node, ...) first, and a bare fs.existsSync would make
// these tests depend on what the host machine has installed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findNodeInPathString, listNvmNodes, resolveNodeBin } = require('../desktop/node-resolve.js');

// ---------------------------------------------------------------------------
// findNodeInPathString
// ---------------------------------------------------------------------------

test('findNodeInPathString returns the first PATH dir that holds a node binary', () => {
  const exists = (p) => p === path.join('/x/bin', 'node') || p === path.join('/y/bin', 'node');
  assert.equal(findNodeInPathString('/usr/bin:/x/bin:/y/bin', exists), path.join('/x/bin', 'node'));
});

test('findNodeInPathString skips empty and relative entries', () => {
  const exists = (p) => p === path.join('/abs/bin', 'node');
  assert.equal(findNodeInPathString('::rel/bin:./also/rel:/abs/bin', exists), path.join('/abs/bin', 'node'));
});

test('findNodeInPathString returns empty when no dir has node', () => {
  assert.equal(findNodeInPathString('/a:/b', () => false), '');
  assert.equal(findNodeInPathString('', () => true), '');
});

// ---------------------------------------------------------------------------
// listNvmNodes
// ---------------------------------------------------------------------------

function makeFakeHome(versions, defaultAlias) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codbash-nvm-'));
  for (const v of versions) {
    const bin = path.join(home, '.nvm', 'versions', 'node', v, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'node'), '');
  }
  if (defaultAlias != null) {
    const aliasDir = path.join(home, '.nvm', 'alias');
    fs.mkdirSync(aliasDir, { recursive: true });
    fs.writeFileSync(path.join(aliasDir, 'default'), defaultAlias + '\n');
  }
  return home;
}

const nvmBin = (home, v) => path.join(home, '.nvm', 'versions', 'node', v, 'bin', 'node');

test('listNvmNodes returns installed nvm nodes, highest version first (numeric, not lexicographic)', () => {
  // Lexicographic order would put v8 above v20 — the sort must be numeric.
  const home = makeFakeHome(['v8.17.0', 'v20.20.0', 'v18.19.1']);
  assert.deepEqual(listNvmNodes(home), [
    nvmBin(home, 'v20.20.0'),
    nvmBin(home, 'v18.19.1'),
    nvmBin(home, 'v8.17.0'),
  ]);
});

test('listNvmNodes puts the ~/.nvm/alias/default version first, not the highest', () => {
  // The user runs v20 by default (matching the prebuilt node-pty ABI); v24 is
  // merely installed. The scan must not silently override their default.
  const home = makeFakeHome(['v24.1.0', 'v20.20.0'], 'v20.20.0');
  assert.deepEqual(listNvmNodes(home), [
    nvmBin(home, 'v20.20.0'),
    nvmBin(home, 'v24.1.0'),
  ]);
});

test('listNvmNodes resolves a major-only default alias ("20") to the highest matching install', () => {
  const home = makeFakeHome(['v24.1.0', 'v20.20.0', 'v20.3.0'], '20');
  assert.deepEqual(listNvmNodes(home), [
    nvmBin(home, 'v20.20.0'),
    nvmBin(home, 'v24.1.0'),
    nvmBin(home, 'v20.3.0'),
  ]);
});

test('listNvmNodes falls back to highest-first when the default alias is unresolvable', () => {
  const home = makeFakeHome(['v20.20.0', 'v18.19.1'], 'lts/hydrogen');
  assert.deepEqual(listNvmNodes(home), [
    nvmBin(home, 'v20.20.0'),
    nvmBin(home, 'v18.19.1'),
  ]);
});

test('listNvmNodes returns [] when nvm is absent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codbash-nonvm-'));
  assert.deepEqual(listNvmNodes(home), []);
});

// ---------------------------------------------------------------------------
// resolveNodeBin (all I/O injected; existsSync scoped to the fake home — see
// note at the top of the file)
// ---------------------------------------------------------------------------

const noneExist = () => false;
const underHome = (home) => (p) => p.startsWith(home) && fs.existsSync(p);
const probelessShellPath = {
  captureLoginShellPath: () => { throw new Error('login-shell probe must not run'); },
};

test('resolveNodeBin: CODBASH_NODE override wins over everything', () => {
  const got = resolveNodeBin({
    env: { CODBASH_NODE: '/custom/node' },
    platform: 'darwin',
    home: '/nonexistent',
    existsSync: noneExist,
    shellPathModule: probelessShellPath,
  });
  assert.equal(got, '/custom/node');
});

test('resolveNodeBin: finds an nvm-installed node when no standard location has one', () => {
  const home = makeFakeHome(['v20.20.0']);
  const got = resolveNodeBin({
    env: {},
    platform: 'darwin',
    home,
    existsSync: underHome(home),
    shellPathModule: probelessShellPath,
  });
  assert.equal(got, nvmBin(home, 'v20.20.0'));
});

test('resolveNodeBin: honors the nvm default alias over a higher installed version', () => {
  const home = makeFakeHome(['v24.1.0', 'v20.20.0'], 'v20.20.0');
  const got = resolveNodeBin({
    env: {},
    platform: 'darwin',
    home,
    existsSync: underHome(home),
    shellPathModule: probelessShellPath,
  });
  assert.equal(got, nvmBin(home, 'v20.20.0'));
});

test('resolveNodeBin: falls back to scanning the login-shell PATH for node', () => {
  const got = resolveNodeBin({
    env: {},
    platform: 'darwin',
    home: '/nonexistent',
    existsSync: (p) => p === path.join('/opt/weird/bin', 'node'),
    shellPathModule: { captureLoginShellPath: () => '/usr/bin:/opt/weird/bin' },
  });
  assert.equal(got, path.join('/opt/weird/bin', 'node'));
});

test('resolveNodeBin: last resort is bare "node" (probe throws, nothing exists)', () => {
  const got = resolveNodeBin({
    env: {},
    platform: 'darwin',
    home: '/nonexistent',
    existsSync: noneExist,
    shellPathModule: { captureLoginShellPath: () => { throw new Error('rc exploded'); } },
  });
  assert.equal(got, 'node');
});

test('resolveNodeBin: last resort is bare "node" when the shell-path module is unavailable', () => {
  const got = resolveNodeBin({
    env: {},
    platform: 'darwin',
    home: '/nonexistent',
    existsSync: noneExist,
    shellPathModule: null,
  });
  assert.equal(got, 'node');
});
