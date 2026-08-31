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
// cannot find → "Uncaught Exception: spawn node ENOENT". The fix mirrors
// src/shell-path.js: wrap the answer in \x01 sentinels and extract by regex,
// so rc noise can never contaminate it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractProbedNodePath, listNvmNodes, resolveNodeBin } = require('../desktop/node-resolve.js');

const NVM_NODE = '/Users/u/.nvm/versions/node/v20.20.0/bin/node';
const wrap = (s) => '\x01CBN\x01' + s + '\x01CBE\x01';

// ---------------------------------------------------------------------------
// extractProbedNodePath
// ---------------------------------------------------------------------------

test('extractProbedNodePath survives iTerm2 OSC escape noise glued around the sentinel (the original crash)', () => {
  // Real stdout captured on the machine where the app crashed: oh-my-zsh
  // warning, then three OSC 1337 sequences with no trailing newline, then the
  // probe answer on the same "line".
  const raw =
    "[oh-my-zsh] plugin 'fig' not found\n" +
    '\x1b]1337;RemoteHost=u@mac.local\x07' +
    '\x1b]1337;CurrentDir=/Users/u\x07' +
    '\x1b]1337;ShellIntegrationVersion=14;shell=zsh\x07' +
    wrap(NVM_NODE) +
    '\x1b]1337;After=1\x07';
  assert.equal(extractProbedNodePath(raw), NVM_NODE);
});

test('extractProbedNodePath trims whitespace inside the sentinels', () => {
  assert.equal(extractProbedNodePath(wrap('\n ' + NVM_NODE + ' \n')), NVM_NODE);
});

test('extractProbedNodePath returns empty for empty/missing/relative answers', () => {
  assert.equal(extractProbedNodePath(''), '');
  assert.equal(extractProbedNodePath(undefined), '');
  assert.equal(extractProbedNodePath('no sentinels here'), '');
  assert.equal(extractProbedNodePath(wrap('')), ''); // node not installed
  assert.equal(extractProbedNodePath(wrap('node')), ''); // not absolute
});

// ---------------------------------------------------------------------------
// listNvmNodes
// ---------------------------------------------------------------------------

function makeFakeHome(versions) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codbash-nvm-'));
  for (const v of versions) {
    const bin = path.join(home, '.nvm', 'versions', 'node', v, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'node'), '');
  }
  return home;
}

test('listNvmNodes returns installed nvm nodes, highest version first (numeric, not lexicographic)', () => {
  // Lexicographic order would put v8 above v20 — the sort must be numeric.
  const home = makeFakeHome(['v8.17.0', 'v20.20.0', 'v18.19.1']);
  const got = listNvmNodes(home);
  assert.deepEqual(got, [
    path.join(home, '.nvm', 'versions', 'node', 'v20.20.0', 'bin', 'node'),
    path.join(home, '.nvm', 'versions', 'node', 'v18.19.1', 'bin', 'node'),
    path.join(home, '.nvm', 'versions', 'node', 'v8.17.0', 'bin', 'node'),
  ]);
});

test('listNvmNodes returns [] when nvm is absent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codbash-nonvm-'));
  assert.deepEqual(listNvmNodes(home), []);
});

// ---------------------------------------------------------------------------
// resolveNodeBin (all I/O injected)
// ---------------------------------------------------------------------------

const noneExist = () => false;

test('resolveNodeBin: CODBASH_NODE override wins over everything', () => {
  const got = resolveNodeBin({
    env: { CODBASH_NODE: '/custom/node' },
    platform: 'darwin',
    home: '/nonexistent',
    existsSync: noneExist,
    probe: () => { throw new Error('probe must not run'); },
  });
  assert.equal(got, '/custom/node');
});

test('resolveNodeBin: finds an nvm-installed node when no standard location has one', () => {
  const home = makeFakeHome(['v20.20.0']);
  const expected = path.join(home, '.nvm', 'versions', 'node', 'v20.20.0', 'bin', 'node');
  const got = resolveNodeBin({
    env: {},
    platform: 'darwin',
    home,
    existsSync: fs.existsSync, // standard candidates don't exist under this fake home
    probe: () => { throw new Error('probe must not run when nvm node exists'); },
  });
  assert.equal(got, expected);
});

test('resolveNodeBin: falls back to the sentinel login-shell probe', () => {
  const got = resolveNodeBin({
    env: {},
    platform: 'darwin',
    home: '/nonexistent',
    existsSync: (p) => p === '/opt/weird/bin/node',
    probe: () => '/opt/weird/bin/node',
  });
  assert.equal(got, '/opt/weird/bin/node');
});

test('resolveNodeBin: probe answers pointing at nonexistent files are rejected', () => {
  const got = resolveNodeBin({
    env: {},
    platform: 'darwin',
    home: '/nonexistent',
    existsSync: noneExist,
    probe: () => '/gone/node',
  });
  assert.equal(got, 'node');
});

test('resolveNodeBin: last resort is bare "node"', () => {
  const got = resolveNodeBin({
    env: {},
    platform: 'darwin',
    home: '/nonexistent',
    existsSync: noneExist,
    probe: () => '',
  });
  assert.equal(got, 'node');
});
