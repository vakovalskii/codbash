const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRepoRefreshManager } = require('../src/repo-refresh');

function mkTmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// ── execFile mock ─────────────────────────────────────────────
// Captures call args and lets the test resolve/reject each call independently.
function makeMockExecFile() {
  const calls = [];
  function execFile(cmd, args, opts, cb) {
    // execFile signature can be (cmd, args, cb) or (cmd, args, opts, cb).
    if (typeof opts === 'function') { cb = opts; opts = undefined; }
    const child = {
      killed: false,
      _signals: [],
      kill(sig) { this.killed = true; this._signals.push(sig || 'SIGTERM'); },
    };
    const call = { cmd, args, opts: opts || {}, child, _cb: cb, _resolved: false };
    call.resolve = (stdout = '', stderr = '') => {
      if (call._resolved) return;
      call._resolved = true;
      cb(null, stdout, stderr);
    };
    call.fail = (err, stderr = '') => {
      if (call._resolved) return;
      call._resolved = true;
      cb(Object.assign(err || new Error('fail'), { stderr }), '', stderr);
    };
    calls.push(call);
    return child;
  }
  return { execFile, calls };
}

function makeMockAtomicWrite() {
  const calls = [];
  function atomicWriteJson(filePath, obj) { calls.push({ filePath, obj }); }
  return { atomicWriteJson, calls };
}

function defaults(overrides = {}) {
  const settingsPath = path.join(mkTmp('codbash-repo-refresh-'), 'settings.json');
  return {
    settingsPath,
    maxConcurrency: 4,
    fetchTimeoutMs: 60_000,
    sigkillGraceMs: 2_000,
    debounceMs: 500,
    resolveGitRoot: (p) => p, // identity by default
    existsSync: () => true,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────

test('triggerRefresh transitions idle → fetching → idle on success', async () => {
  const exec = makeMockExecFile();
  const mgr = createRepoRefreshManager({ ...defaults(), execFile: exec.execFile });

  const before = mgr.getState().repos['/repos/x'];
  assert.equal(before, undefined);

  const pending = mgr.triggerRefresh('/repos/x');
  const during = mgr.getState().repos['/repos/x'];
  assert.equal(during.status, 'fetching');
  assert.ok(during.startedAt > 0);

  exec.calls[0].resolve('done\n', '');
  const final = await pending;

  assert.equal(final.status, 'idle');
  assert.equal(final.lastError, null);
  assert.ok(final.lastSuccessAt > 0);
});

test('triggerRefresh single-flight: 2 concurrent calls share the same promise', async () => {
  const exec = makeMockExecFile();
  const mgr = createRepoRefreshManager({ ...defaults(), execFile: exec.execFile });

  const p1 = mgr.triggerRefresh('/repos/x');
  const p2 = mgr.triggerRefresh('/repos/x');

  assert.equal(exec.calls.length, 1, 'only one child process should be spawned');
  assert.equal(p1, p2, 'returned promise must be identical (single-flight)');

  exec.calls[0].resolve();
  await p1;
});

test('semaphore caps concurrent fetches at 4; 5th queues until one finishes', async () => {
  const exec = makeMockExecFile();
  const mgr = createRepoRefreshManager({
    ...defaults(),
    execFile: exec.execFile,
    maxConcurrency: 4,
  });

  const promises = ['a', 'b', 'c', 'd', 'e'].map(k => mgr.triggerRefresh('/repos/' + k));
  // Let microtasks drain so the manager has a chance to start what it can.
  await new Promise(r => setImmediate(r));

  assert.equal(exec.calls.length, 4, '5th call must be queued, not started');

  exec.calls[0].resolve();
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.equal(exec.calls.length, 5, '5th call must start after 1st finishes');

  for (let i = 1; i < exec.calls.length; i++) exec.calls[i].resolve();
  await Promise.all(promises);
});

test('60s timeout: child killed (SIGTERM then SIGKILL grace), state=error, inflight cleared', async () => {
  const exec = makeMockExecFile();
  const mgr = createRepoRefreshManager({
    ...defaults(),
    execFile: exec.execFile,
    fetchTimeoutMs: 50,
    sigkillGraceMs: 30,
  });

  const p = mgr.triggerRefresh('/repos/x');
  // Wait past timeout window (50ms) plus SIGKILL grace (30ms) plus slack.
  await new Promise(r => setTimeout(r, 150));

  // Manager should have killed the child and rejected/resolved with error.
  const child = exec.calls[0].child;
  assert.ok(child._signals.includes('SIGTERM'), 'expected SIGTERM');
  assert.ok(child._signals.includes('SIGKILL'), 'expected SIGKILL after grace');

  // Now invoke callback as the child would after kill — the manager must
  // already have recorded the timeout state and not double-write it.
  exec.calls[0].fail(new Error('killed'));
  const state = await p;
  assert.equal(state.status, 'error');
  assert.match(state.lastError || '', /timeout/i);

  // Inflight cleared — a subsequent trigger must spawn a fresh child.
  const p2 = mgr.triggerRefresh('/repos/x');
  assert.equal(exec.calls.length, 2);
  exec.calls[1].resolve();
  await p2;
});

test('non-zero exit propagates as state=error with truncated stderr (≤200 chars)', async () => {
  const exec = makeMockExecFile();
  const mgr = createRepoRefreshManager({ ...defaults(), execFile: exec.execFile });

  const p = mgr.triggerRefresh('/repos/x');
  const longErr = 'fatal: ' + 'x'.repeat(500);
  exec.calls[0].fail(Object.assign(new Error('exit 128'), { code: 128 }), longErr);
  const state = await p;

  assert.equal(state.status, 'error');
  assert.ok(state.lastError);
  assert.ok(state.lastError.length <= 200, 'lastError must be truncated to ≤200 chars');
  assert.ok(state.lastError.includes('fatal:'), 'truncation should keep the head of the message');
  assert.ok(state.lastErrorAt > 0);
});

test('corrupt settings file → loadSettings logs warning, sets defaults, file untouched', () => {
  const dir = mkTmp('codbash-repo-refresh-');
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, '{ not valid json');
  const original = fs.readFileSync(settingsPath, 'utf8');

  const warnings = [];
  const mgr = createRepoRefreshManager({
    ...defaults(),
    settingsPath,
    logger: { warn: (msg) => warnings.push(msg) },
  });

  const { settings } = mgr.getState();
  assert.equal(settings.refreshOnStartup, false);
  assert.deepEqual(settings.perProject, {});
  assert.ok(warnings.some(w => /refresh.*settings/i.test(w)));
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original, 'file must NOT be auto-overwritten');
});

test('updateSettings round-trips through atomicWriteJson (debounced)', async () => {
  const exec = makeMockExecFile();
  const atomic = makeMockAtomicWrite();
  const mgr = createRepoRefreshManager({
    ...defaults(),
    execFile: exec.execFile,
    atomicWriteJson: atomic.atomicWriteJson,
    debounceMs: 30,
  });

  mgr.updateSettings({ refreshOnStartup: true });
  mgr.updateSettings({ perProject: { '/repos/x': { autoRefreshOnNewChat: true } } });

  // Inside debounce window — no write yet.
  assert.equal(atomic.calls.length, 0);

  await new Promise(r => setTimeout(r, 60));

  // After debounce — exactly one write, with the merged state.
  assert.equal(atomic.calls.length, 1, 'debounce must coalesce multiple updates into one write');
  assert.equal(atomic.calls[0].obj.refreshOnStartup, true);
  assert.deepEqual(atomic.calls[0].obj.perProject, { '/repos/x': { autoRefreshOnNewChat: true } });
});

test('gitRoot with spaces is passed as a single argv element', async () => {
  const exec = makeMockExecFile();
  const mgr = createRepoRefreshManager({ ...defaults(), execFile: exec.execFile });
  const root = '/repos/My Project (legacy)';

  const p = mgr.triggerRefresh(root);
  assert.deepEqual(exec.calls[0].args, ['-C', root, 'fetch', '--all', '--prune']);
  // Critical: the gitRoot is one argv element, not split on whitespace.
  assert.equal(exec.calls[0].args[1], root);

  exec.calls[0].resolve();
  await p;
});

test('initOnStartup triggers only enabled repos and does not block', async () => {
  const dir = mkTmp('codbash-repo-refresh-');
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    version: 1,
    refreshOnStartup: true,
    perProject: {
      '/repos/a': { autoRefreshOnNewChat: true },
      '/repos/b': { autoRefreshOnNewChat: true },
      '/repos/c': { autoRefreshOnNewChat: false },
    },
  }));

  const exec = makeMockExecFile();
  const mgr = createRepoRefreshManager({ ...defaults(), settingsPath, execFile: exec.execFile });

  const t0 = Date.now();
  mgr.initOnStartup();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 50, `initOnStartup must not block (took ${elapsed}ms)`);

  // Let microtasks drain so triggers fire.
  await new Promise(r => setImmediate(r));

  const triggered = exec.calls.map(c => c.args[1]).sort();
  assert.deepEqual(triggered, ['/repos/a', '/repos/b']);
  assert.equal(exec.calls.find(c => c.args[1] === '/repos/c'), undefined, '/repos/c (disabled) must NOT be triggered');

  for (const c of exec.calls) c.resolve();
});

test('initOnStartup with refreshOnStartup=false launches nothing', async () => {
  const dir = mkTmp('codbash-repo-refresh-');
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    version: 1,
    refreshOnStartup: false,
    perProject: { '/repos/a': { autoRefreshOnNewChat: true } },
  }));

  const exec = makeMockExecFile();
  const mgr = createRepoRefreshManager({ ...defaults(), settingsPath, execFile: exec.execFile });

  mgr.initOnStartup();
  await new Promise(r => setImmediate(r));
  assert.equal(exec.calls.length, 0);
});

test('initOnStartup garbage-collects orphan perProject entries', async () => {
  const dir = mkTmp('codbash-repo-refresh-');
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    version: 1,
    refreshOnStartup: false,
    perProject: {
      '/repos/alive':   { autoRefreshOnNewChat: true },
      '/repos/deleted': { autoRefreshOnNewChat: true },
    },
  }));

  const atomic = makeMockAtomicWrite();
  const mgr = createRepoRefreshManager({
    ...defaults(),
    settingsPath,
    atomicWriteJson: atomic.atomicWriteJson,
    debounceMs: 10,
    // /repos/deleted no longer exists on disk.
    existsSync: (p) => p === '/repos/alive',
  });

  mgr.initOnStartup();
  await new Promise(r => setTimeout(r, 40));

  const finalPerProject = mgr.getState().settings.perProject;
  assert.ok('/repos/alive' in finalPerProject);
  assert.ok(!('/repos/deleted' in finalPerProject), 'orphan must be GC-ed');
  // And the cleanup is persisted.
  assert.ok(atomic.calls.some(c => c.obj.perProject && !('/repos/deleted' in c.obj.perProject)));
});

test('waitForRefreshOrTimeout returns timedOut=true when fetch outruns the wait', async () => {
  const exec = makeMockExecFile();
  const mgr = createRepoRefreshManager({ ...defaults(), execFile: exec.execFile });

  const fetchP = mgr.triggerRefresh('/repos/x');
  const result = await mgr.waitForRefreshOrTimeout('/repos/x', 30);

  assert.equal(result.timedOut, true);
  assert.equal(result.state.status, 'fetching');

  // Cleanup — let the fetch finish so the test doesn't leak.
  exec.calls[0].resolve();
  await fetchP;
});

test('lastError redacts https://user:token@host credentials', async () => {
  const exec = makeMockExecFile();
  const mgr = createRepoRefreshManager({ ...defaults(), execFile: exec.execFile });

  const p = mgr.triggerRefresh('/repos/x');
  const errMsg = "fatal: Authentication failed for 'https://alice:ghp_secrettoken123@github.com/org/repo.git'";
  exec.calls[0].fail(Object.assign(new Error('exit 128'), { code: 128 }), errMsg);
  const state = await p;

  assert.equal(state.status, 'error');
  assert.ok(state.lastError);
  assert.ok(!/ghp_secrettoken123/.test(state.lastError), 'token must not appear in lastError');
  assert.ok(!/alice:/.test(state.lastError), 'username must not appear in lastError');
  assert.ok(/<redacted>@github\.com/.test(state.lastError), 'should preserve host with <redacted> placeholder');
});

test('initOnStartup skips perProject entries not in known-roots set', async () => {
  const dir = mkTmp('codbash-repo-refresh-');
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    version: 1,
    refreshOnStartup: true,
    perProject: {
      '/repos/legit':   { autoRefreshOnNewChat: true },
      '/repos/injected':{ autoRefreshOnNewChat: true }, // not in known set — must be skipped
    },
  }));

  const exec = makeMockExecFile();
  const mgr = createRepoRefreshManager({
    ...defaults(),
    settingsPath,
    execFile: exec.execFile,
    getKnownGitRoots: () => new Set(['/repos/legit']),
  });

  mgr.initOnStartup();
  await new Promise(r => setImmediate(r));

  const triggered = exec.calls.map(c => c.args[1]).sort();
  assert.deepEqual(triggered, ['/repos/legit']);
  assert.equal(exec.calls.find(c => c.args[1] === '/repos/injected'), undefined,
    'injected path must NOT be triggered');

  for (const c of exec.calls) c.resolve();
});

test('setKnownGitRootsProvider wires the gate after construction', async () => {
  const dir = mkTmp('codbash-repo-refresh-');
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    version: 1,
    refreshOnStartup: true,
    perProject: { '/repos/a': { autoRefreshOnNewChat: true } },
  }));

  const exec = makeMockExecFile();
  const mgr = createRepoRefreshManager({ ...defaults(), settingsPath, execFile: exec.execFile });
  // No known-roots set yet — wire it in after construction.
  mgr.setKnownGitRootsProvider(() => new Set(['/repos/a']));

  mgr.initOnStartup();
  await new Promise(r => setImmediate(r));
  assert.equal(exec.calls.length, 1);
  exec.calls[0].resolve();
});

test('waitForRefreshOrTimeout returns timedOut=false when fetch finishes first', async () => {
  const exec = makeMockExecFile();
  const mgr = createRepoRefreshManager({ ...defaults(), execFile: exec.execFile });

  const fetchP = mgr.triggerRefresh('/repos/x');
  const waitP = mgr.waitForRefreshOrTimeout('/repos/x', 200);

  // Resolve fetch before the wait timeout.
  setTimeout(() => exec.calls[0].resolve(), 10);

  const result = await waitP;
  assert.equal(result.timedOut, false);
  assert.equal(result.state.status, 'idle');
  await fetchP;
});
