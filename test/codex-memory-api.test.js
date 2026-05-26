const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const { handleCodexMemoryRoute } = require('../src/server');

function makeProject() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codbash-memory-api-')));
  const project = path.join(root, 'demo-project');
  fs.mkdirSync(project);
  return { root, project: fs.realpathSync(project) };
}

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const parsed = new URL(req.url, 'http://127.0.0.1');
      if (!handleCodexMemoryRoute(req, res, parsed)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not found' }));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      } : {},
    }, (res) => {
      let buf = '';
      res.on('data', chunk => buf += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = buf ? JSON.parse(buf) : null; } catch {}
        resolve({ status: res.statusCode, body: parsed, raw: buf });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('GET /api/codex-memory/status returns initialized=false for a fresh project', async () => {
  const { root, project } = makeProject();
  const { server, port } = await startTestServer();
  try {
    const res = await request(port, 'GET', '/api/codex-memory/status?project=' + encodeURIComponent(project));

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.initialized, false);
    assert.equal(res.body.projectPath, project);
    assert.equal(res.body.memoryDir, path.join(project, '.codex-memory'));
    assert.equal(res.body.summaryCount, 0);
    assert.equal(res.body.embeddingCount, 0);
    assert.equal(res.body.clusterCount, 0);
    assert.equal(res.body.ignoredByGit, false);
  } finally {
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/codex-memory/init initializes memory and status reflects empty counts', async () => {
  const { root, project } = makeProject();
  const { server, port } = await startTestServer();
  try {
    const init = await request(port, 'POST', '/api/codex-memory/init', { project });
    assert.equal(init.status, 200);
    assert.deepEqual(init.body, {
      ok: true,
      memoryDir: path.join(project, '.codex-memory'),
      created: true,
      gitignoreUpdated: true,
    });

    const status = await request(port, 'GET', '/api/codex-memory/status?project=' + encodeURIComponent(project));
    assert.equal(status.status, 200);
    assert.equal(status.body.ok, true);
    assert.equal(status.body.initialized, true);
    assert.equal(status.body.summaryCount, 0);
    assert.equal(status.body.embeddingCount, 0);
    assert.equal(status.body.clusterCount, 0);
    assert.equal(status.body.ignoredByGit, true);
  } finally {
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex memory API returns 400 for invalid project paths', async () => {
  const { server, port } = await startTestServer();
  try {
    const status = await request(port, 'GET', '/api/codex-memory/status?project=relative/path');
    assert.equal(status.status, 400);
    assert.equal(status.body.ok, false);
    assert.match(status.body.error, /absolute path/);

    const init = await request(port, 'POST', '/api/codex-memory/init', {});
    assert.equal(init.status, 400);
    assert.equal(init.body.ok, false);
    assert.match(init.body.error, /project path is required/);
  } finally {
    await stopServer(server);
  }
});
