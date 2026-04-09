// HTTP server + API routes
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { exec, execFile } = require('child_process');
const { loadSessions, loadSessionDetail, deleteSession, getGitCommits, exportSessionMarkdown, getSessionPreview, searchFullText, getActiveSessions, getSessionReplay, getCostAnalytics, computeSessionCost, getProjectGitInfo, getLeaderboardStats } = require('./data');
const { detectTerminals, openInTerminal, focusTerminalByPid } = require('./terminals');
const { convertSession } = require('./convert');
const { generateHandoff } = require('./handoff');
const { CHANGELOG } = require('./changelog');
const { getHTML } = require('./html');

// ── Logging ──────────────────────────────────
const LOG_VERBOSE = process.env.CODEDASH_LOG !== '0';
const DEFAULT_HOST = '127.0.0.1';

function log(tag, msg, data) {
  if (!LOG_VERBOSE && tag !== 'ERROR') return;
  const ts = new Date().toLocaleTimeString('en-GB');
  const color = tag === 'ERROR' ? '\x1b[31m' : tag === 'WARN' ? '\x1b[33m' : tag === 'API' ? '\x1b[36m' : '\x1b[2m';
  let line = `  ${color}${ts} [${tag}]\x1b[0m ${msg}`;
  if (data !== undefined) {
    const str = typeof data === 'object' ? JSON.stringify(data) : String(data);
    line += ` \x1b[2m${str.length > 300 ? str.slice(0, 300) + '...' : str}\x1b[0m`;
  }
  console.log(line);
}

function startServer(host, port, openBrowser = true) {
  const browserUrl = getBrowserUrl(host, port);
  const server = http.createServer((req, res) => {
    // req.url is usually relative, so this base is only for URL parsing.
    // Keep it stable instead of reusing the bind host, which may be a wildcard listen address.
    const parsed = new URL(req.url, `http://localhost:${port}`);
    const pathname = parsed.pathname;
    const reqStart = Date.now();

    // Log all API requests (skip static & frequent polls)
    const isApi = pathname.startsWith('/api/');
    const isFrequent = pathname === '/api/active' || pathname === '/api/version';
    if (isApi && !isFrequent) {
      const params = Object.fromEntries(parsed.searchParams);
      log('API', `${req.method} ${pathname}`, Object.keys(params).length ? params : undefined);
    }

    // Wrap json to log response time
    const origJson = json;
    const jsonLog = (r, data, status) => {
      if (isApi && !isFrequent) {
        const ms = Date.now() - reqStart;
        const count = Array.isArray(data) ? data.length + ' items' : data && data.ok !== undefined ? (data.ok ? 'ok' : 'FAIL: ' + (data.error || '')) : '';
        log('RESP', `${pathname} ${ms}ms`, count);
      }
      origJson(r, data, status);
    };

    // ── Static ──────────────────────────────
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getHTML());
    }

    // Favicon - inline SVG
    else if (req.method === 'GET' && pathname === '/favicon.ico') {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#60a5fa"/><path d="M8 8l8 4 8-4v16l-8 4-8-4z" fill="none" stroke="#fff" stroke-width="2"/></svg>';
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(svg);
    }

    // ── Sessions API ────────────────────────
    else if (req.method === 'GET' && pathname === '/api/sessions') {
      const sessions = loadSessions();
      const byTool = {};
      sessions.forEach(s => { byTool[s.tool] = (byTool[s.tool] || 0) + 1; });
      log('DATA', `loaded ${sessions.length} sessions${sessions._loading ? ' (cursor loading...)' : ''}`, byTool);
      // Send _loading flag as header to avoid polluting array response
      if (sessions._loading) res.setHeader('X-Loading', '1');
      json(res, sessions);
    }

    else if (req.method === 'GET' && pathname.startsWith('/api/session/') && !pathname.includes('/export')) {
      const sessionId = pathname.split('/').pop();
      const project = parsed.searchParams.get('project') || '';
      const data = loadSessionDetail(sessionId, project);
      json(res, data);
    }

    // ── Export Markdown ─────────────────────
    else if (req.method === 'GET' && pathname.includes('/export')) {
      // /api/session/<id>/export?project=...
      const parts = pathname.split('/');
      const sessionId = parts[parts.indexOf('session') + 1];
      const project = parsed.searchParams.get('project') || '';
      const md = exportSessionMarkdown(sessionId, project);
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="session-${sessionId.slice(0, 8)}.md"`,
      });
      res.end(md);
    }

    // ── Terminals ───────────────────────────
    else if (req.method === 'GET' && pathname === '/api/terminals') {
      const terminals = detectTerminals();
      json(res, terminals);
    }

    // ── Launch ──────────────────────────────
    else if (req.method === 'POST' && pathname === '/api/launch') {
      readBody(req, body => {
        try {
          const { sessionId, tool, flags, project, terminal } = JSON.parse(body);
          log('LAUNCH', `session=${sessionId} tool=${tool || 'claude'} terminal=${terminal || 'default'} project=${project || '(none)'} flags=${(flags || []).join(',') || '(none)'}`);
          openInTerminal(sessionId, tool || 'claude', flags || [], project || '', terminal || '');
          log('LAUNCH', 'ok');
          json(res, { ok: true });
        } catch (e) {
          log('ERROR', `launch failed: ${e.message}`);
          json(res, { ok: false, error: e.message }, 400);
        }
      });
    }

    // ── Delete ──────────────────────────────
    else if (req.method === 'DELETE' && pathname.startsWith('/api/session/')) {
      const sessionId = pathname.split('/').pop();
      readBody(req, body => {
        try {
          const { project } = JSON.parse(body || '{}');
          const deleted = deleteSession(sessionId, project || '');
          json(res, { ok: true, deleted });
        } catch (e) {
          json(res, { ok: false, error: e.message }, 400);
        }
      });
    }

    // ── Bulk Delete ─────────────────────────
    else if (req.method === 'POST' && pathname === '/api/bulk-delete') {
      readBody(req, body => {
        try {
          const { sessions } = JSON.parse(body); // [{id, project}, ...]
          const results = [];
          for (const s of sessions) {
            const deleted = deleteSession(s.id, s.project || '');
            results.push({ id: s.id, deleted });
          }
          json(res, { ok: true, results });
        } catch (e) {
          json(res, { ok: false, error: e.message }, 400);
        }
      });
    }

    // ── Git Commits ─────────────────────────
    else if (req.method === 'GET' && pathname === '/api/git-commits') {
      const project = parsed.searchParams.get('project') || '';
      const from = parseInt(parsed.searchParams.get('from') || '0');
      const to = parseInt(parsed.searchParams.get('to') || Date.now().toString());
      const commits = getGitCommits(project, from, to);
      json(res, commits);
    }

    // ── Project git info ────────────────────
    else if (req.method === 'GET' && pathname === '/api/git-info') {
      const project = parsed.searchParams.get('project') || '';
      const info = getProjectGitInfo(project);
      json(res, info || { error: 'No git repo found' });
    }

    // ── Active sessions ─────────────────────
    else if (req.method === 'GET' && pathname === '/api/active') {
      const active = getActiveSessions();
      // Log only when active set changes
      const activeKey = active.map(a => a.pid + ':' + a.status).sort().join(',');
      if (activeKey !== startServer._lastActiveKey) {
        startServer._lastActiveKey = activeKey;
        if (active.length > 0) {
          for (const a of active) {
            log('ACTIVE', `pid=${a.pid} ${a.kind}/${a.status} cpu=${a.cpu}% cwd=${a.cwd || '?'} session=${a.sessionId ? a.sessionId.slice(0,8) + '...' : 'none'} source=${a._sessionSource || 'none'}`);
          }
        } else if (startServer._lastActiveKey !== '') {
          log('ACTIVE', 'no running agents');
        }
      }
      json(res, active);
    }

    // ── Open in IDE ────────────────────────
    else if (req.method === 'POST' && pathname === '/api/open-ide') {
      readBody(req, body => {
        try {
          const { ide, project } = JSON.parse(body);
          const fs = require('fs');
          // Ensure we open a directory, not a file
          let target = project;
          if (target && fs.existsSync(target) && !fs.statSync(target).isDirectory()) {
            target = require('path').dirname(target);
          }
          log('IDE', `ide=${ide} project=${project} target=${target}`);
          if (ide === 'cursor') {
            exec(`cursor "${target || '.'}"`);
          } else if (ide === 'code') {
            exec(`code "${target || '.'}"`);
          }
          json(res, { ok: true });
        } catch (e) {
          json(res, { ok: false, error: e.message }, 400);
        }
      });
    }

    // ── Handoff document ───────────────────
    else if (req.method === 'GET' && pathname.startsWith('/api/handoff/')) {
      const sessionId = pathname.split('/').pop();
      const project = parsed.searchParams.get('project') || '';
      const verbosity = parsed.searchParams.get('verbosity') || 'standard';
      const result = generateHandoff(sessionId, project, { verbosity });
      if (result.ok) {
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="handoff-${sessionId.slice(0, 8)}.md"`,
        });
        res.end(result.markdown);
      } else {
        json(res, result, 404);
      }
    }

    // ── Convert session ─────────────────────
    else if (req.method === 'POST' && pathname === '/api/convert') {
      readBody(req, body => {
        try {
          const { sessionId, project, targetFormat } = JSON.parse(body);
          const result = convertSession(sessionId, project || '', targetFormat);
          json(res, result);
        } catch (e) {
          json(res, { ok: false, error: e.message }, 400);
        }
      });
    }

    // ── Focus terminal ──────────────────────
    else if (req.method === 'POST' && pathname === '/api/focus') {
      readBody(req, body => {
        try {
          const { pid } = JSON.parse(body);
          log('FOCUS', `pid=${pid}`);
          const result = focusTerminalByPid(pid);
          log('FOCUS', `result: terminal=${result.terminal || 'none'} ok=${result.ok}`);
          json(res, result);
        } catch (e) {
          json(res, { ok: false, error: e.message }, 400);
        }
      });
    }

    // ── Session preview ─────────────────────
    else if (req.method === 'GET' && pathname.startsWith('/api/preview/')) {
      const sessionId = pathname.split('/').pop();
      const project = parsed.searchParams.get('project') || '';
      const limit = parseInt(parsed.searchParams.get('limit') || '10');
      const messages = getSessionPreview(sessionId, project, limit);
      json(res, messages);
    }

    // ── Full-text search ──────────────────────
    else if (req.method === 'GET' && pathname === '/api/search') {
      const q = parsed.searchParams.get('q') || '';
      const sessions = loadSessions();
      const results = searchFullText(q, sessions);
      json(res, results);
    }

    // ── Session cost ──────────────────────
    else if (req.method === 'GET' && pathname.startsWith('/api/cost/')) {
      const sessionId = pathname.split('/').pop();
      const project = parsed.searchParams.get('project') || '';
      const data = computeSessionCost(sessionId, project);
      json(res, data);
    }

    // ── Session replay ─────────────────────
    else if (req.method === 'GET' && pathname.startsWith('/api/replay/')) {
      const sessionId = pathname.split('/').pop();
      const project = parsed.searchParams.get('project') || '';
      const data = getSessionReplay(sessionId, project);
      json(res, data);
    }

    // ── Cost analytics ──────────────────────
    else if (req.method === 'GET' && pathname === '/api/analytics/cost') {
      let sessions = loadSessions();
      const from = parsed.searchParams.get('from');
      const to = parsed.searchParams.get('to');
      if (from) sessions = sessions.filter(s => s.date >= from);
      if (to) sessions = sessions.filter(s => s.date <= to);
      const data = getCostAnalytics(sessions);
      json(res, data);
    }

    // ── LLM Config ────────────────────────────
    else if (req.method === 'GET' && pathname === '/api/llm-config') {
      const config = loadLLMConfig();
      json(res, config);
    }

    else if (req.method === 'POST' && pathname === '/api/llm-config') {
      readBody(req, body => {
        try {
          const config = JSON.parse(body);
          saveLLMConfig(config);
          log('LLM', 'config saved', { model: config.model, url: config.url });
          json(res, { ok: true });
        } catch (e) {
          json(res, { ok: false, error: e.message }, 400);
        }
      });
    }

    // ── Generate Title ──────────────────────────
    else if (req.method === 'POST' && pathname === '/api/generate-title') {
      readBody(req, body => {
        try {
          const { sessionId, project } = JSON.parse(body);
          log('LLM', `generate-title session=${sessionId}`);
          const config = loadLLMConfig();
          if (!config.url || !config.apiKey) {
            json(res, { ok: false, error: 'LLM not configured. Set URL and API key in Settings.' }, 400);
            return;
          }
          const detail = loadSessionDetail(sessionId, project || '');
          const msgs = detail.messages || [];
          // Take first 10 + last 10 (deduped)
          const first10 = msgs.slice(0, 10);
          const last10 = msgs.slice(-10);
          const seen = new Set();
          const sample = [];
          for (const m of first10.concat(last10)) {
            const key = (m.uuid || '') + (m.role || '') + (m.content || '').slice(0, 50);
            if (!seen.has(key)) { seen.add(key); sample.push(m); }
          }
          const conversation = sample.map(function(m) {
            var text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            if (text.length > 300) text = text.slice(0, 300) + '...';
            return (m.role === 'user' ? 'User' : 'Assistant') + ': ' + text;
          }).join('\n\n');

          callLLM(config, conversation, msgs.length).then(function(title) {
            log('LLM', `title generated: "${title}"`);
            json(res, { ok: true, title: title });
          }).catch(function(e) {
            log('ERROR', `LLM call failed: ${e.message}`);
            json(res, { ok: false, error: e.message }, 500);
          });
        } catch (e) {
          json(res, { ok: false, error: e.message }, 400);
        }
      });
    }

    // ── Leaderboard stats ────────────────────
    else if (req.method === 'GET' && pathname === '/api/leaderboard') {
      const stats = getLeaderboardStats();
      json(res, stats);
    }

    else if (req.method === 'POST' && pathname === '/api/leaderboard/sync') {
      syncLeaderboard().then(data => json(res, data)).catch(e => json(res, { error: e.message }, 500));
    }

    else if (req.method === 'GET' && pathname === '/api/leaderboard/remote') {
      fetchRemoteLeaderboard().then(data => json(res, data)).catch(e => json(res, { error: e.message }, 500));
    }

    // ── GitHub Auth (Device Flow) ────────────
    else if (req.method === 'POST' && pathname === '/api/github/device-code') {
      githubDeviceCode().then(data => json(res, data)).catch(e => json(res, { error: e.message }, 400));
    }

    else if (req.method === 'POST' && pathname === '/api/github/poll-token') {
      readBody(req, body => {
        try {
          const { device_code } = JSON.parse(body);
          githubPollToken(device_code).then(data => json(res, data)).catch(e => json(res, { error: e.message }, 400));
        } catch (e) { json(res, { error: e.message }, 400); }
      });
    }

    else if (req.method === 'GET' && pathname === '/api/github/profile') {
      const profile = loadGitHubProfile();
      json(res, profile || { authenticated: false });
    }

    else if (req.method === 'POST' && pathname === '/api/github/logout') {
      saveGitHubProfile(null);
      json(res, { ok: true });
    }

    // ── Cloud Sync Proxy ─────────────────────
    else if (pathname.startsWith('/api/cloud/')) {
      handleCloudProxy(req, res, pathname).catch(e => json(res, { error: e.message }, 500));
    }

    // ── Changelog ─────────────────────────────
    else if (req.method === 'GET' && pathname === '/api/changelog') {
      json(res, CHANGELOG);
    }

    // ── Version check ────────────────────────
    else if (req.method === 'GET' && pathname === '/api/version') {
      const pkg = require('../package.json');
      const current = pkg.version;
      // Fetch latest from npm registry
      fetchLatestVersion(pkg.name).then(latest => {
        json(res, { current, latest, updateAvailable: latest && latest !== current && isNewer(latest, current) });
      }).catch(() => {
        json(res, { current, latest: null, updateAvailable: false });
      });
    }

    // ── 404 ─────────────────────────────────
    else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  const bindAddr = host === 'localhost' ? DEFAULT_HOST : host;
  server.listen(port, bindAddr, () => {
    console.log('');
    console.log('  \x1b[36m\x1b[1mcodedash\x1b[0m — Claude & Codex Sessions Dashboard');
    console.log(`  \x1b[2mbind ${bindAddr}:${port}\x1b[0m`);
    console.log(`  \x1b[2m${browserUrl}\x1b[0m`);
    if (host === '0.0.0.0' || host === '::' || host === '[::]') {
      console.log('  \x1b[2mListening on all interfaces\x1b[0m');
    }
    console.log('  \x1b[2mPress Ctrl+C to stop\x1b[0m');
    console.log('');

    if (openBrowser) {
      if (process.platform === 'darwin') {
        execFile('open', [browserUrl]);
      } else if (process.platform === 'linux') {
        execFile('xdg-open', [browserUrl]);
      }
    }

    // Delayed heartbeat + auto-sync (don't block startup)
    setTimeout(sendHeartbeat, 5000);
    setTimeout(autoSync, 15000); // first sync 15s after start
    setInterval(autoSync, 300000); // then every 5 min
  });
}

function sendHeartbeat() {
  try {
    const { getOrCreateAnonId } = require('./data');
    const anon = getOrCreateAnonId();
    const pkg = require('../package.json');

    const body = JSON.stringify({
      anonId: anon.id,
      version: pkg.version,
      platform: process.platform,
    });

    const req = https.request({
      hostname: 'leaderboard.neuraldeep.ru',
      path: '/api/heartbeat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    });
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch {}
}

function autoSync() {
  try {
    const profile = loadGitHubProfile();
    if (!profile || !profile.authenticated) return; // not connected — skip
    syncLeaderboard().then(() => {
      log('SYNC', 'Auto-sync OK');
    }).catch(() => {});
  } catch {}
}

// ── Cloud Sync Proxy ────────────────────────
const { serializeSession, encryptSession, decryptSession, deserializeSession, loadCloudKey, saveCloudKey, cloudRequest: cloudApiRequest, deriveKey, encrypt, decrypt, CLOUD_API } = require('./cloud');
const crypto = require('crypto');

// Cached encryption key (in-memory, survives until server restart)
let _cachedCloudKey = null;

function getCloudKey() {
  if (_cachedCloudKey) return _cachedCloudKey;
  return null;
}

function unlockCloudKey(passphrase) {
  const keyData = loadCloudKey();
  if (!keyData || !keyData.salt) return { error: 'Run "codedash cloud setup" in terminal first' };

  const salt = Buffer.from(keyData.salt, 'hex');
  const key = deriveKey(passphrase, salt);

  // Verify passphrase
  try {
    const dec = decrypt(Buffer.from(keyData.verifier, 'hex'), key);
    if (dec.toString() !== 'codedash-verify') return { error: 'Wrong passphrase' };
  } catch {
    return { error: 'Wrong passphrase' };
  }

  _cachedCloudKey = key;
  return { ok: true };
}

async function handleCloudProxy(req, res, pathname) {
  const profile = loadGitHubProfile();
  if (!profile || !profile.authenticated) {
    log('CLOUD', `${req.method} ${pathname} → 401 not authenticated`);
    return json(res, { error: 'Connect GitHub first' }, 401);
  }

  // POST /api/cloud/setup — create passphrase (first time) or re-enter on new device
  if (req.method === 'POST' && pathname === '/api/cloud/setup') {
    return new Promise((resolve) => {
      readBody(req, async (body) => {
        try {
          const { passphrase } = JSON.parse(body);
          if (!passphrase || passphrase.length < 4) {
            log('CLOUD', 'setup: passphrase too short');
            json(res, { error: 'Passphrase too short (min 4 chars)' }, 400); return resolve();
          }

          const existing = loadCloudKey();
          if (existing && existing.salt) {
            log('CLOUD', 'setup: local key exists, unlocking...');
            const result = unlockCloudKey(passphrase);
            log('CLOUD', `setup unlock: ${result.error ? 'FAIL ' + result.error : 'OK'}`);
            json(res, result.error ? result : { ok: true }, result.error ? 400 : 200);
            return resolve();
          }

          // Check if server has a salt from another device
          log('CLOUD', 'setup: checking server for existing salt...');
          const verifyRes = await cloudApiRequest('POST', '/api/auth/verify', profile.token);
          const serverSalt = verifyRes.status === 200 ? verifyRes.data?.user?.encryption_salt : null;

          let salt;
          if (serverSalt) {
            log('CLOUD', 'setup: using salt from another device');
            salt = Buffer.from(serverSalt, 'hex');
          } else {
            log('CLOUD', 'setup: first device, generating new salt');
            salt = crypto.randomBytes(16);
            await cloudApiRequest('PUT', '/api/auth/salt', profile.token, JSON.stringify({ salt: salt.toString('hex') }));
          }

          const key = deriveKey(passphrase, salt);
          const verifier = encrypt(Buffer.from('codedash-verify'), key);
          saveCloudKey({ salt: salt.toString('hex'), verifier: verifier.toString('hex') });

          _cachedCloudKey = key;
          log('CLOUD', `setup: OK (new=${!serverSalt})`);
          json(res, { ok: true, isNew: !serverSalt });
          resolve();
        } catch (e) {
          log('ERROR', `cloud setup: ${e.message}`);
          json(res, { error: e.message }, 500); resolve();
        }
      });
    });
  }

  // POST /api/cloud/lock — clear cached key
  if (req.method === 'POST' && pathname === '/api/cloud/lock') {
    _cachedCloudKey = null;
    log('CLOUD', 'locked (key cleared)');
    json(res, { ok: true });
    return;
  }

  // POST /api/cloud/unlock — cache encryption key from passphrase
  if (req.method === 'POST' && pathname === '/api/cloud/unlock') {
    return new Promise((resolve) => {
      readBody(req, (body) => {
        try {
          const { passphrase } = JSON.parse(body);
          if (!passphrase) { json(res, { error: 'passphrase required' }, 400); return resolve(); }
          const result = unlockCloudKey(passphrase);
          log('CLOUD', `unlock: ${result.error ? 'FAIL ' + result.error : 'OK'}`);
          if (result.error) { json(res, result, 400); return resolve(); }
          json(res, { ok: true });
          resolve();
        } catch (e) {
          log('ERROR', `cloud unlock: ${e.message}`);
          json(res, { error: e.message }, 500); resolve();
        }
      });
    });
  }

  // GET /api/cloud/locked — check if key is cached
  if (req.method === 'GET' && pathname === '/api/cloud/locked') {
    const keyData = loadCloudKey();
    const localConfigured = !!(keyData && keyData.salt);

    // Also check if server has a salt (another device set it up)
    let serverHasSalt = false;
    if (!localConfigured) {
      try {
        const verifyRes = await cloudApiRequest('POST', '/api/auth/verify', profile.token);
        serverHasSalt = !!(verifyRes.status === 200 && verifyRes.data?.user?.encryption_salt);
      } catch {}
    }

    json(res, {
      configured: localConfigured,
      serverHasSalt: serverHasSalt,
      unlocked: !!_cachedCloudKey,
    });
    return;
  }

  // POST /api/cloud/push — encrypt and upload session
  if (req.method === 'POST' && pathname === '/api/cloud/push') {
    return new Promise((resolve) => {
      readBody(req, async (body) => {
        try {
          const { sessionId, project } = JSON.parse(body);
          if (!sessionId) { json(res, { error: 'sessionId required' }, 400); return resolve(); }

          const key = getCloudKey();
          if (!key) {
            log('CLOUD', `push ${sessionId.slice(0,8)}: LOCKED`);
            json(res, { error: 'Cloud locked. Enter passphrase first.' }, 403); return resolve();
          }

          log('CLOUD', `push ${sessionId.slice(0,8)}: serializing...`);
          const sessions = loadSessions();
          const canonical = serializeSession(sessionId, sessions);
          if (!canonical) {
            log('CLOUD', `push ${sessionId.slice(0,8)}: session not found`);
            json(res, { error: 'Session not found locally' }, 404); return resolve();
          }

          const blob = encryptSession(canonical, key);
          const checksum = crypto.createHash('sha256').update(blob).digest('hex');
          log('CLOUD', `push ${sessionId.slice(0,8)}: ${canonical.agent} ${canonical.messageCount}msgs ${(blob.length/1024).toFixed(0)}KB → uploading...`);

          const result = await cloudApiRequest('POST', '/api/sessions/upload', profile.token, blob, {
            'Content-Type': 'application/octet-stream',
            'X-Session-Id': sessionId,
            'X-Agent': canonical.agent,
            'X-Project-Short': encodeURIComponent(canonical.projectShort || ''),
            'X-First-Message': encodeURIComponent((canonical.firstMessage || '').slice(0, 200)),
            'X-First-Ts': String(canonical.firstTs || 0),
            'X-Last-Ts': String(canonical.lastTs || 0),
            'X-Message-Count': String(canonical.messageCount || 0),
            'X-Checksum': checksum,
          });

          if (result.status === 200) {
            log('CLOUD', `push ${sessionId.slice(0,8)}: OK (${(blob.length/1024).toFixed(0)}KB)`);
            json(res, { ok: true, size: blob.length });
          } else {
            log('CLOUD', `push ${sessionId.slice(0,8)}: FAIL ${result.status} ${JSON.stringify(result.data).slice(0,200)}`);
            json(res, result.data || { error: 'Upload failed' }, result.status);
          }
          resolve();
        } catch (e) {
          log('ERROR', `cloud push: ${e.message}`);
          json(res, { error: e.message }, 500); resolve();
        }
      });
    });
  }

  // POST /api/cloud/pull — download and decrypt session
  if (req.method === 'POST' && pathname === '/api/cloud/pull') {
    return new Promise((resolve) => {
      readBody(req, async (body) => {
        try {
          const { sessionId } = JSON.parse(body);
          if (!sessionId) { json(res, { error: 'sessionId required' }, 400); return resolve(); }

          const key = getCloudKey();
          if (!key) {
            log('CLOUD', `pull ${sessionId.slice(0,12)}: LOCKED`);
            json(res, { error: 'Cloud locked. Enter passphrase first.' }, 403); return resolve();
          }

          log('CLOUD', `pull ${sessionId.slice(0,12)}: downloading...`);
          const dlRes = await cloudApiRequest('GET', `/api/sessions/${encodeURIComponent(sessionId)}/download`, profile.token);
          if (dlRes.status !== 200) {
            log('CLOUD', `pull ${sessionId.slice(0,12)}: download FAIL ${dlRes.status}`);
            json(res, { error: 'Download failed' }, dlRes.status); return resolve();
          }

          log('CLOUD', `pull ${sessionId.slice(0,12)}: decrypting ${(dlRes.data.length/1024).toFixed(0)}KB...`);
          const canonical = decryptSession(dlRes.data, key);
          const result = deserializeSession(canonical);
          log('CLOUD', `pull ${sessionId.slice(0,12)}: ${result.skipped ? 'SKIPPED (exists)' : 'OK → ' + (result.file || '').slice(-40)}`);
          json(res, { ok: true, ...result });
          resolve();
        } catch (e) {
          log('ERROR', `cloud pull: ${e.message}`);
          json(res, { error: e.message }, 500); resolve();
        }
      });
    });
  }

  // GET /api/cloud/list — proxy to cloud server
  if (req.method === 'GET' && pathname === '/api/cloud/list') {
    log('CLOUD', 'list: fetching from cloud server...');
    const result = await cloudApiRequest('GET', '/api/sessions?limit=500', profile.token);
    log('CLOUD', `list: ${result.status === 200 ? (result.data?.sessions?.length || 0) + ' sessions' : 'FAIL ' + result.status}`);
    json(res, result.data, result.status);
    return;
  }

  // GET /api/cloud/status — proxy stats
  if (req.method === 'GET' && pathname === '/api/cloud/status') {
    const result = await cloudApiRequest('GET', '/api/sessions/stats', profile.token);
    log('CLOUD', `status: ${result.status === 200 ? JSON.stringify(result.data).slice(0,100) : 'FAIL ' + result.status}`);
    json(res, result.data, result.status);
    return;
  }

  // DELETE /api/cloud/:id
  const deleteMatch = pathname.match(/^\/api\/cloud\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    const sid = decodeURIComponent(deleteMatch[1]);
    log('CLOUD', `delete ${sid.slice(0,12)}...`);
    const result = await cloudApiRequest('DELETE', `/api/sessions/${encodeURIComponent(sid)}`, profile.token);
    log('CLOUD', `delete ${sid.slice(0,12)}: ${result.status === 200 ? 'OK' : 'FAIL ' + result.status}`);
    json(res, result.data, result.status);
    return;
  }

  log('CLOUD', `unknown endpoint: ${req.method} ${pathname}`);
  json(res, { error: 'Unknown cloud endpoint' }, 404);
}

// ── Helpers ─────────────────────────────────
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req, cb) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => cb(body));
}

function getBrowserUrl(host, port) {
  const browserHost = getBrowserHost(host);
  const wrappedHost = browserHost.includes(':') && !browserHost.startsWith('[')
    ? `[${browserHost}]`
    : browserHost;
  return `http://${wrappedHost}:${port}`;
}

function getBrowserHost(host) {
  if (!host || host === DEFAULT_HOST || host === 'localhost' || host === '::1') {
    return 'localhost';
  }
  if (host === '0.0.0.0' || host === '::' || host === '[::]') {
    // This URL is only used to show/open the app locally on the machine that started it.
    // Wildcard bind addresses are valid listen targets, but they are not usable browser hosts.
    return 'localhost';
  }
  return host;
}

// ── npm version check ───────────────────
function fetchLatestVersion(packageName) {
  return new Promise((resolve, reject) => {
    https.get(`https://registry.npmjs.org/${packageName}/latest`, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data).version);
        } catch { reject(); }
      });
    }).on('error', reject);
  });
}

function isNewer(latest, current) {
  const l = latest.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) return true;
    if ((l[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

// ── GitHub Auth (Device Flow) ──────────────
const fs = require('fs');
const path = require('path');
const os = require('os');

const GITHUB_CLIENT_ID = 'Ov23liBD3XGfBBIZiyK6';
const GITHUB_PROFILE_FILE = path.join(os.homedir(), '.codedash', 'github-profile.json');

function githubRequest(hostname, reqPath, method, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
    const options = {
      hostname, path: reqPath, method: method || 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'codedash' },
      timeout: 15000,
    };
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function githubDeviceCode() {
  const data = await githubRequest('github.com', '/login/device/code', 'POST',
    JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: 'read:user' }));
  if (data.error) throw new Error(data.error_description || data.error);
  log('AUTH', `Device code: ${data.user_code} → ${data.verification_uri}`);
  return { user_code: data.user_code, verification_uri: data.verification_uri, device_code: data.device_code, interval: data.interval || 5, expires_in: data.expires_in };
}

async function githubPollToken(deviceCode) {
  const data = await githubRequest('github.com', '/login/oauth/access_token', 'POST',
    JSON.stringify({ client_id: GITHUB_CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }));
  if (data.error === 'authorization_pending') return { status: 'pending' };
  if (data.error === 'slow_down') return { status: 'slow_down' };
  if (data.error === 'expired_token') return { status: 'expired' };
  if (data.error) throw new Error(data.error_description || data.error);
  if (!data.access_token) throw new Error('No access token received');

  // Fetch user profile with token
  const user = await new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.github.com', path: '/user', method: 'GET',
      headers: { 'Authorization': `Bearer ${data.access_token}`, 'Accept': 'application/json', 'User-Agent': 'codedash' },
      timeout: 10000,
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('parse error')); } }); });
    req.on('error', reject);
    req.end();
  });
  // Override headers for auth
  const profile = {
    authenticated: true,
    username: user.login,
    avatar: user.avatar_url,
    name: user.name || user.login,
    url: user.html_url,
    token: data.access_token,
    connectedAt: new Date().toISOString(),
  };
  saveGitHubProfile(profile);
  log('AUTH', `GitHub connected: @${profile.username}`);
  return { status: 'ok', profile: { username: profile.username, avatar: profile.avatar, name: profile.name, url: profile.url } };
}

function loadGitHubProfile() {
  try {
    const data = JSON.parse(fs.readFileSync(GITHUB_PROFILE_FILE, 'utf8'));
    if (data.authenticated) return { authenticated: true, username: data.username, avatar: data.avatar, name: data.name, url: data.url, token: data.token };
  } catch {}
  return null;
}

function saveGitHubProfile(profile) {
  const dir = path.dirname(GITHUB_PROFILE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (profile) {
    fs.writeFileSync(GITHUB_PROFILE_FILE, JSON.stringify(profile, null, 2));
  } else {
    try { fs.unlinkSync(GITHUB_PROFILE_FILE); } catch {}
  }
}

// ── Leaderboard Sync ──────────────────────
const LEADERBOARD_API = 'https://leaderboard.neuraldeep.ru';

async function syncLeaderboard() {
  const profile = loadGitHubProfile();
  if (!profile || !profile.authenticated) throw new Error('Connect GitHub first');

  const stats = getLeaderboardStats();
  const anon = stats.anon || {};
  // Build integrity fingerprint: SHA-256(version + data.js header)
  const pkg = require('../package.json');
  let integrity = '';
  try {
    const dataJsPath = require('path').join(__dirname, 'data.js');
    const header = require('fs').readFileSync(dataJsPath, 'utf8').slice(0, 200);
    integrity = require('crypto').createHash('sha256').update(pkg.version + header).digest('hex').slice(0, 16);
  } catch {}

  const payload = {
    username: profile.username,
    avatar: profile.avatar,
    name: profile.name,
    deviceId: anon.id || require('crypto').randomUUID(),
    token: profile.token, // for server-side GitHub verification
    version: pkg.version,
    integrity: integrity,
    stats: {
      today: { ...stats.today, hours: Math.min(stats.today.hours || 0, 24) },
      week: stats.daily ? stats.daily.slice(0, 7).reduce((acc, d) => ({ messages: acc.messages + d.messages, hours: acc.hours + d.hours, cost: acc.cost + d.cost }), { messages: 0, hours: 0, cost: 0 }) : { messages: 0, hours: 0, cost: 0 },
      totals: stats.totals,
      agents: stats.agents,
      streak: stats.streak,
      activeDays: stats.activeDays,
    },
  };

  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(LEADERBOARD_API + '/api/stats');
    const req = https.request({
      hostname: parsed.hostname, path: parsed.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        log('SYNC', `Response status=${res.statusCode} body=${data.slice(0, 500)}`);
        if (res.statusCode >= 400) {
          reject(new Error(`Leaderboard API ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          const r = JSON.parse(data);
          log('SYNC', `Pushed stats to leaderboard as @${profile.username}`);
          resolve(r);
        } catch { reject(new Error('Bad response: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', (e) => { log('SYNC', `Request error: ${e.message}`); reject(e); });
    req.write(body);
    req.end();
  });
}

async function fetchRemoteLeaderboard() {
  return new Promise((resolve, reject) => {
    https.get(LEADERBOARD_API + '/api/leaderboard', { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Parse error')); } });
    }).on('error', reject);
  });
}

// ── LLM Config ─────────────────────────────

const LLM_CONFIG_FILE = path.join(os.homedir(), '.claude', 'codedash-llm.json');

function loadLLMConfig() {
  try {
    return JSON.parse(fs.readFileSync(LLM_CONFIG_FILE, 'utf8'));
  } catch {
    return { model: '', url: '', apiKey: '' };
  }
}

function saveLLMConfig(config) {
  const dir = path.dirname(LLM_CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LLM_CONFIG_FILE, JSON.stringify({
    model: config.model || '',
    url: config.url || '',
    apiKey: config.apiKey || '',
  }, null, 2));
}

function callLLM(config, conversation, totalMessages) {
  return new Promise((resolve, reject) => {
    const systemPrompt = `<MAIN_ROLE>
You are a coding session summarizer. You read coding conversations and produce a single short concrete title describing what was done.
</MAIN_ROLE>

<MAIN_GUIDELINES>
- Write 5-15 words summarizing WHAT was concretely done
- Mention specific: technologies, files, features, bugs, configs
- Write in the SAME language the user used in the conversation
- Never write vague/generic descriptions
- Respond ONLY with JSON: {"title": "your summary"}

GOOD: "Фикс авторизации OAuth + рефактор middleware"
GOOD: "Добавил Cursor сессии, cmux терминал, WSL поддержку"
GOOD: "Настройка nginx reverse proxy для staging"
GOOD: "Fix Codex message count bug in grid view"
BAD: "Coding session about project" — too vague
BAD: "Bug fix and improvements" — no specifics
BAD: "Working with code" — meaningless
</MAIN_GUIDELINES>`;

    const prompt = `Coding session: ${totalMessages} messages total. First and last messages below.

${conversation}`;

    const body = JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      max_tokens: 200,
      temperature: 0.3,
    });

    const parsed = new URL(config.url);
    const isHttps = parsed.protocol === 'https:';
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: (parsed.pathname.replace(/\/+$/, '')) + '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    };

    const mod = isHttps ? https : http;
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.error) {
            reject(new Error(result.error.message || JSON.stringify(result.error)));
            return;
          }
          const msg = result.choices && result.choices[0] && result.choices[0].message;
          // Reasoning models may put output in reasoning_content or content
          const content = (msg && msg.content) || (msg && msg.reasoning_content) || '';
          if (!content) {
            // Log full response for debugging
            log('ERROR', 'LLM empty content, full response: ' + JSON.stringify(result).slice(0, 500));
            reject(new Error('LLM returned empty content. If using a reasoning model, it may not support structured output.'));
            return;
          }
          let title;
          try {
            title = JSON.parse(content).title;
          } catch {
            // Fallback: extract title from malformed JSON or raw text
            var m = content.match(/["']?title["']?\s*[:=]\s*["']([^"']+)["']/i);
            if (m) {
              title = m[1].trim();
            } else {
              // Strip JSON artifacts and use as-is
              title = content.replace(/[{}"'\n]/g, '').replace(/^title\s*[:=]\s*/i, '').trim();
            }
          }
          // Sanitize: limit length, strip leftover JSON
          if (title) title = title.replace(/^\{.*?:\s*/, '').slice(0, 80).trim();
          resolve(title || 'Untitled session');
        } catch (e) {
          reject(new Error('Failed to parse LLM response: ' + data.slice(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('LLM request timeout')); });
    req.write(body);
    req.end();
  });
}

module.exports = { startServer };
