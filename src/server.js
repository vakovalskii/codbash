// HTTP server + API routes
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { exec } = require('child_process');
const { loadSessions, loadSessionDetail, deleteSession, getGitCommits, exportSessionMarkdown, getSessionPreview, searchFullText, getActiveSessions, getSessionReplay, getCostAnalytics, computeSessionCost } = require('./data');
const { detectTerminals, openInTerminal, focusTerminalByPid } = require('./terminals');
const { getHTML } = require('./html');

function startServer(port, openBrowser = true) {
  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://localhost:${port}`);
    const pathname = parsed.pathname;

    // ── Static ──────────────────────────────
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getHTML());
    }

    // ── Sessions API ────────────────────────
    else if (req.method === 'GET' && pathname === '/api/sessions') {
      const sessions = loadSessions();
      json(res, sessions);
    }

    else if (req.method === 'GET' && pathname.startsWith('/api/session/') && !pathname.includes('/export')) {
      const sessionId = pathname.split('/').pop();
      const project = parsed.searchParams.get('project') || '';
      const tool = parsed.searchParams.get('tool') || '';
      const data = loadSessionDetail(sessionId, project, tool);
      json(res, data);
    }

    // ── Export Markdown ─────────────────────
    else if (req.method === 'GET' && pathname.includes('/export')) {
      // /api/session/<id>/export?project=...&tool=...
      const parts = pathname.split('/');
      const sessionId = parts[parts.indexOf('session') + 1];
      const project = parsed.searchParams.get('project') || '';
      const tool = parsed.searchParams.get('tool') || '';
      const md = exportSessionMarkdown(sessionId, project, tool);
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
          openInTerminal(sessionId, tool || 'claude', flags || [], project || '', terminal || '');
          json(res, { ok: true });
        } catch (e) {
          json(res, { ok: false, error: e.message }, 400);
        }
      });
    }

    // ── Delete ──────────────────────────────
    else if (req.method === 'DELETE' && pathname.startsWith('/api/session/')) {
      const sessionId = pathname.split('/').pop();
      readBody(req, body => {
        try {
          const { project, tool } = JSON.parse(body || '{}');
          const deleted = deleteSession(sessionId, project || '', tool || '');
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
            const deleted = deleteSession(s.id, s.project || '', s.tool || '');
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

    // ── Active sessions ─────────────────────
    else if (req.method === 'GET' && pathname === '/api/active') {
      const active = getActiveSessions();
      json(res, active);
    }

    // ── Focus terminal ──────────────────────
    else if (req.method === 'POST' && pathname === '/api/focus') {
      readBody(req, body => {
        try {
          const { pid } = JSON.parse(body);
          const ok = focusTerminalByPid(pid);
          json(res, { ok });
        } catch (e) {
          json(res, { ok: false, error: e.message }, 400);
        }
      });
    }

    // ── Session preview ─────────────────────
    else if (req.method === 'GET' && pathname.startsWith('/api/preview/')) {
      const sessionId = pathname.split('/').pop();
      const project = parsed.searchParams.get('project') || '';
      const tool = parsed.searchParams.get('tool') || '';
      const limit = parseInt(parsed.searchParams.get('limit') || '10');
      const messages = getSessionPreview(sessionId, project, limit, tool);
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
      const tool = parsed.searchParams.get('tool') || '';
      const data = getSessionReplay(sessionId, project, tool);
      json(res, data);
    }

    // ── Cost analytics ──────────────────────
    else if (req.method === 'GET' && pathname === '/api/analytics/cost') {
      const sessions = loadSessions();
      const data = getCostAnalytics(sessions);
      json(res, data);
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

  server.listen(port, '127.0.0.1', () => {
    console.log('');
    console.log('  \x1b[36m\x1b[1mcodedash\x1b[0m — Claude, Codex, OpenCode & Kilo Sessions Dashboard');
    console.log(`  \x1b[2mhttp://localhost:${port}\x1b[0m`);
    console.log('  \x1b[2mPress Ctrl+C to stop\x1b[0m');
    console.log('');

    if (openBrowser) {
      if (process.platform === 'darwin') {
        exec(`open http://localhost:${port}`);
      } else if (process.platform === 'linux') {
        exec(`xdg-open http://localhost:${port}`);
      }
    }
  });
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

module.exports = { startServer };
