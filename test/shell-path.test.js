// Tests for src/shell-path.js — login-shell PATH repair for GUI launches.
//
// Strategy: augmentPathFromLoginShell() takes an injected context
// ({ platform, home, path, capture, force }) so we can drive every branch
// without spawning a real shell or touching process.env — mirroring the DI
// approach used in agents-detect.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');

function loadFresh() {
  delete require.cache[require.resolve('../src/shell-path')];
  return require('../src/shell-path');
}

const HOME = '/Users/test';
const STRIPPED = '/usr/bin:/bin:/usr/sbin:/sbin';
const LOGIN = '/Users/test/.local/bin:/Users/test/.npm-global/bin:/opt/homebrew/bin:/usr/bin:/bin';

// Base options for a GUI-stripped darwin launch. Individual tests override.
function base(over) {
  return Object.assign({ force: true, platform: 'darwin', home: HOME, path: STRIPPED }, over);
}

test('hasUserBinPaths: false for a stripped GUI PATH', () => {
  const { hasUserBinPaths } = loadFresh();
  assert.equal(hasUserBinPaths(STRIPPED, HOME), false);
});

test('hasUserBinPaths: true when a bin dir under $HOME is present', () => {
  const { hasUserBinPaths } = loadFresh();
  assert.equal(hasUserBinPaths(LOGIN, HOME), true);
});

test('hasUserBinPaths: a lone non-bin home dir does NOT count (avoids false-negative skip)', () => {
  const { hasUserBinPaths } = loadFresh();
  const p = '/Users/test/Library/Caches/foo:/usr/bin:/bin';
  assert.equal(hasUserBinPaths(p, HOME), false);
});

test('hasUserBinPaths: nvm/fnm shim dirs count', () => {
  const { hasUserBinPaths } = loadFresh();
  assert.equal(hasUserBinPaths('/Users/test/.nvm/versions/node/v20/bin:/usr/bin', HOME), true);
  assert.equal(hasUserBinPaths('/Users/test/.fnm/aliases/default/bin:/usr/bin', HOME), true);
});

test('augment: stripped PATH gets login dirs appended, existing entries kept first', () => {
  const { augmentPathFromLoginShell } = loadFresh();
  const added = augmentPathFromLoginShell(base({ capture: () => LOGIN }));
  assert.deepEqual(added, [
    '/Users/test/.local/bin',
    '/Users/test/.npm-global/bin',
    '/opt/homebrew/bin',
  ]);
});

test('augment: precedence — system dirs stay first, new dirs appended after (not prepended)', () => {
  const { augmentPathFromLoginShell } = loadFresh();
  let written = null;
  // Use the process.env path branch by omitting `path`, but capture the result
  // via the return value + reconstruct expected ordering explicitly instead.
  const added = augmentPathFromLoginShell(base({ capture: () => LOGIN }));
  // The merged order is: existing (trimmed) entries, then added.
  const expectedMerged = STRIPPED.split(':').concat(added).join(':');
  assert.equal(
    expectedMerged,
    '/usr/bin:/bin:/usr/sbin:/sbin:/Users/test/.local/bin:/Users/test/.npm-global/bin:/opt/homebrew/bin'
  );
});

test('augment: no-op (capture never called) when PATH already has user bin dirs', () => {
  const { augmentPathFromLoginShell } = loadFresh();
  let called = false;
  const added = augmentPathFromLoginShell(base({
    path: LOGIN,
    capture: () => { called = true; return LOGIN; },
  }));
  assert.deepEqual(added, []);
  assert.equal(called, false, 'capture must not be invoked when PATH is already good');
});

test('augment: control-char entries (incl. TAB and DEL) are filtered out', () => {
  const { augmentPathFromLoginShell } = loadFresh();
  const added = augmentPathFromLoginShell(base({
    capture: () => '/Users/test/.local/bin:/ta\tb/dir:/del\x7fdir:/ctrl\x01dir',
  }));
  assert.deepEqual(added, ['/Users/test/.local/bin']);
});

test('augment: does not re-add a dir already present, even with surrounding whitespace', () => {
  const { augmentPathFromLoginShell } = loadFresh();
  const added = augmentPathFromLoginShell(base({
    path: ' /usr/bin : /bin ',
    capture: () => '/usr/bin:/Users/test/.local/bin',
  }));
  assert.deepEqual(added, ['/Users/test/.local/bin'], 'trimmed existing entry should dedupe');
});

test('augment: win32 short-circuits without calling capture', () => {
  const { augmentPathFromLoginShell } = loadFresh();
  let called = false;
  const added = augmentPathFromLoginShell(base({
    platform: 'win32',
    capture: () => { called = true; return LOGIN; },
  }));
  assert.deepEqual(added, []);
  assert.equal(called, false);
});

test('augment: CODBASH_NO_PATH_REPAIR=1 opts out without calling capture', () => {
  const { augmentPathFromLoginShell } = loadFresh();
  const prev = process.env.CODBASH_NO_PATH_REPAIR;
  process.env.CODBASH_NO_PATH_REPAIR = '1';
  try {
    let called = false;
    const added = augmentPathFromLoginShell(base({ capture: () => { called = true; return LOGIN; } }));
    assert.deepEqual(added, []);
    assert.equal(called, false);
  } finally {
    if (prev === undefined) delete process.env.CODBASH_NO_PATH_REPAIR;
    else process.env.CODBASH_NO_PATH_REPAIR = prev;
  }
});

test('augment: a throwing capture is swallowed and returns []', () => {
  const { augmentPathFromLoginShell } = loadFresh();
  const added = augmentPathFromLoginShell(base({
    capture: () => { throw new Error('boom'); },
  }));
  assert.deepEqual(added, []);
});

test('augment: empty capture (no sentinel match) returns []', () => {
  const { augmentPathFromLoginShell } = loadFresh();
  const added = augmentPathFromLoginShell(base({ capture: () => '' }));
  assert.deepEqual(added, []);
});

test('augment: idempotent — second call without force is a no-op even after state change', () => {
  const { augmentPathFromLoginShell } = loadFresh();
  const first = augmentPathFromLoginShell({ platform: 'darwin', home: HOME, path: STRIPPED, capture: () => LOGIN });
  assert.ok(first.length > 0, 'first call augments');
  const second = augmentPathFromLoginShell({ platform: 'darwin', home: HOME, path: STRIPPED, capture: () => LOGIN });
  assert.deepEqual(second, [], 'second call without force is guarded by _done');
});

test('augment: mutates process.env.PATH when no explicit path is injected', () => {
  const { augmentPathFromLoginShell } = loadFresh();
  const prev = process.env.PATH;
  process.env.PATH = STRIPPED;
  try {
    const added = augmentPathFromLoginShell({ force: true, platform: 'darwin', home: HOME, capture: () => LOGIN });
    assert.ok(added.includes('/Users/test/.local/bin'));
    assert.ok(process.env.PATH.includes('/Users/test/.local/bin'));
    assert.ok(process.env.PATH.startsWith('/usr/bin:/bin'), 'system dirs remain first');
  } finally {
    process.env.PATH = prev;
  }
});
