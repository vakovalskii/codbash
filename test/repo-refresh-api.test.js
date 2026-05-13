const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRepoRefreshManager } = require('../src/repo-refresh');
const { handleRepoRefreshRoute } = require('../src/repo-refresh-routes');

function mkTmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeMockExecFile() {
  const calls = [];
  function execFile(cmd, args, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = undefined; }
    const child = { killed: false, _signals: [], kill(s) { this.killed = true; this._signals.push(s || 'SIGTERM'); } };
    const call = { cmd, args, opts: opts || {}, child, _cb: cb, _resolved: false };
    call.resolve = (stdout = '', stderr = '') => {
      if (call._resolved) return; call._resolved = true; cb(null, stdout, stderr);
    };
    call.fail = (err, stderr = '') => {
      if (call._resolved) return; call._resolved = true;
      cb(Object.assign(err || new Error('fail'), { stderr }), '', stderr);
    };
    calls.push(call);
    return child;
  }
  return { execFile, calls };
}

// Mount the router on a real http server bound to an ephemeral port.
function startTestServer(deps) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const handled = handleRepoRefreshRoute(req, res, deps);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_my_route' }));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      host: '127.0.0.1', port, method, path: urlPath,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    };
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (chunk) => buf += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = buf ? JSON.parse(buf) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: buf });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function makeDeps(extraOverrides = {}) {
  const settingsPath = path.join(mkTmp('codbash-api-'), 'settings.json');
  const exec = makeMockExecFile();
  const manager = createRepoRefreshManager({
    execFile: exec.execFile,
    settingsPath,
    maxConcurrency: 4,
    fetchTimeoutMs: 60_000,
    sigkillGraceMs: 1_000,
    debounceMs: 10,
    resolveGitRoot: (p) => p,
    existsSync: () => true,
    ...extraOverrides,
  });
  // Fixed list of "known" gitRoots used for /trigger and /settings validation.
  const knownGitRoots = new Set(['/repos/known-a', '/repos/known-b']);
  const getKnownGitRoots = () => knownGitRoots;
  return { manager, getKnownGitRoots, settingsPath, exec, knownGitRoots };
}

// ── Tests ─────────────────────────────────────────────────────

test('GET /api/repo-refresh/state returns repos + settings on a fresh manager', async () => {
  const deps = makeDeps();
  const { server, port } = await startTestServer(deps);
  try {
    const res = await request(port, 'GET', '/api/repo-refresh/state');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.repos, {});
    assert.equal(res.body.settings.refreshOnStartup, false);
    assert.deepEqual(res.body.settings.perProject, {});
  } finally {
    await stopServer(server);
  }
});

test('POST /api/repo-refresh/trigger spawns a fetch for a known gitRoot', async () => {
  const deps = makeDeps();
  const { server, port } = await startTestServer(deps);
  try {
    const res = await request(port, 'POST', '/api/repo-refresh/trigger', { gitRoot: '/repos/known-a' });
    assert.equal(res.status, 200);
    assert.equal(res.body.state.status, 'fetching');
    assert.equal(deps.exec.calls.length, 1);
    assert.equal(deps.exec.calls[0].args[1], '/repos/known-a');
    deps.exec.calls[0].resolve();
  } finally {
    await stopServer(server);
  }
});

test('POST /api/repo-refresh/trigger returns 404 with code=not_found for an unknown gitRoot', async () => {
  const deps = makeDeps();
  const { server, port } = await startTestServer(deps);
  try {
    const res = await request(port, 'POST', '/api/repo-refresh/trigger', { gitRoot: '/repos/wat' });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'not_found');
    assert.equal(deps.exec.calls.length, 0, 'no child process should be spawned for unknown gitRoot');
  } finally {
    await stopServer(server);
  }
});

test('POST /api/repo-refresh/trigger returns 400 with code=invalid_payload when gitRoot is missing', async () => {
  const deps = makeDeps();
  const { server, port } = await startTestServer(deps);
  try {
    const res = await request(port, 'POST', '/api/repo-refresh/trigger', {});
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_payload');
  } finally {
    await stopServer(server);
  }
});

test('POST /api/repo-refresh/trigger returns 400 for malformed JSON body', async () => {
  const deps = makeDeps();
  const { server, port } = await startTestServer(deps);
  try {
    const res = await request(port, 'POST', '/api/repo-refresh/trigger', '{ not json');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_payload');
  } finally {
    await stopServer(server);
  }
});

test('POST /api/repo-refresh/wait returns timedOut=true when fetch outruns the wait', async () => {
  const deps = makeDeps();
  const { server, port } = await startTestServer(deps);
  try {
    // Start a fetch that never resolves.
    await request(port, 'POST', '/api/repo-refresh/trigger', { gitRoot: '/repos/known-a' });
    const res = await request(port, 'POST', '/api/repo-refresh/wait', { gitRoot: '/repos/known-a', timeoutMs: 30 });
    assert.equal(res.status, 200);
    assert.equal(res.body.timedOut, true);
    assert.equal(res.body.state.status, 'fetching');
    deps.exec.calls[0].resolve();
  } finally {
    await stopServer(server);
  }
});

test('POST /api/repo-refresh/wait returns 404 with code=not_found for unknown gitRoot', async () => {
  const deps = makeDeps();
  const { server, port } = await startTestServer(deps);
  try {
    const res = await request(port, 'POST', '/api/repo-refresh/wait', { gitRoot: '/repos/not-mine' });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'not_found');
  } finally {
    await stopServer(server);
  }
});

test('POST /api/repo-refresh/wait clamps timeoutMs to a sane maximum', async () => {
  const deps = makeDeps();
  const { server, port } = await startTestServer(deps);
  try {
    // No fetch in flight — wait should return immediately regardless of timeoutMs.
    // gitRoot must be known (post-fix); known-a is in the test's known set.
    const res = await request(port, 'POST', '/api/repo-refresh/wait', { gitRoot: '/repos/known-a', timeoutMs: 999_999_999 });
    assert.equal(res.status, 200);
    assert.equal(res.body.timedOut, false);
  } finally {
    await stopServer(server);
  }
});

test('GET /api/repo-refresh/settings returns the current settings', async () => {
  const deps = makeDeps();
  const { server, port } = await startTestServer(deps);
  try {
    const res = await request(port, 'GET', '/api/repo-refresh/settings');
    assert.equal(res.status, 200);
    assert.equal(res.body.refreshOnStartup, false);
    assert.deepEqual(res.body.perProject, {});
  } finally {
    await stopServer(server);
  }
});

test('POST /api/repo-refresh/settings merges and persists valid input', async () => {
  const deps = makeDeps();
  const { server, port } = await startTestServer(deps);
  try {
    const res = await request(port, 'POST', '/api/repo-refresh/settings', {
      refreshOnStartup: true,
      perProject: { '/repos/known-a': { autoRefreshOnNewChat: true } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.refreshOnStartup, true);
    assert.deepEqual(res.body.perProject, { '/repos/known-a': { autoRefreshOnNewChat: true } });

    // Wait past the debounce so the file lands on disk.
    await new Promise(r => setTimeout(r, 30));
    const onDisk = JSON.parse(fs.readFileSync(deps.settingsPath, 'utf8'));
    assert.equal(onDisk.refreshOnStartup, true);
    assert.deepEqual(onDisk.perProject, { '/repos/known-a': { autoRefreshOnNewChat: true } });
  } finally {
    await stopServer(server);
  }
});

test('POST /api/repo-refresh/settings returns 400 with code=invalid_payload for unknown gitRoot in perProject', async () => {
  const deps = makeDeps();
  const { server, port } = await startTestServer(deps);
  try {
    const res = await request(port, 'POST', '/api/repo-refresh/settings', {
      perProject: { '/repos/wat': { autoRefreshOnNewChat: true } },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_payload');
  } finally {
    await stopServer(server);
  }
});

test('GET /api/repo-refresh/settings returns the value just POSTed', async () => {
  const deps = makeDeps();
  const { server, port } = await startTestServer(deps);
  try {
    await request(port, 'POST', '/api/repo-refresh/settings', {
      perProject: { '/repos/known-a': { autoRefreshOnNewChat: true } },
    });
    const res = await request(port, 'GET', '/api/repo-refresh/settings');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.perProject, { '/repos/known-a': { autoRefreshOnNewChat: true } });
  } finally {
    await stopServer(server);
  }
});

test('Unknown route under /api/repo-refresh/ returns 404', async () => {
  const deps = makeDeps();
  const { server, port } = await startTestServer(deps);
  try {
    const res = await request(port, 'GET', '/api/repo-refresh/nonsense');
    assert.equal(res.status, 404);
  } finally {
    await stopServer(server);
  }
});
