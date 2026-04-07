// HTTP server + API routes
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { exec } = require('child_process');
const { loadSessions, loadSessionDetail, deleteSession, getGitCommits, exportSessionMarkdown, getSessionPreview, searchFullText, getActiveSessions, getSessionReplay, getCostAnalytics, computeSessionCost, getProjectGitInfo } = require('./data');
const { detectTerminals, openInTerminal, focusTerminalByPid } = require('./terminals');
const { convertSession } = require('./convert');
const { generateHandoff } = require('./handoff');
const { CHANGELOG } = require('./changelog');
const { getHTML } = require('./html');

// ── Logging ──────────────────────────────────
const LOG_VERBOSE = process.env.CODEDASH_LOG !== '0';

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
  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://${host}:${port}`);
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
      log('DATA', `loaded ${sessions.length} sessions`, byTool);
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

  const bindAddr = host === 'localhost' ? '127.0.0.1' : host;
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  const displayUrl = `http://${displayHost}:${port}`;

  server.listen(port, bindAddr, () => {
    console.log('');
    console.log('  \x1b[36m\x1b[1mcodedash\x1b[0m — Claude & Codex Sessions Dashboard');
    console.log(`  \x1b[2m${displayUrl}\x1b[0m`);
    if (host === '0.0.0.0') {
      console.log('  \x1b[2mListening on all interfaces\x1b[0m');
    }
    console.log('  \x1b[2mPress Ctrl+C to stop\x1b[0m');
    console.log('');

    if (openBrowser) {
      const browserUrl = `http://localhost:${port}`;
      if (process.platform === 'darwin') {
        exec(`open ${browserUrl}`);
      } else if (process.platform === 'linux') {
        exec(`xdg-open ${browserUrl}`);
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

// ── LLM Config ─────────────────────────────
const fs = require('fs');
const path = require('path');
const os = require('os');

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
    const prompt = `You are a helpful assistant that generates concise session titles.

Given a coding session conversation (first and last messages from ${totalMessages} total), generate a short descriptive title (3-8 words) that captures the main topic/task.

Conversation:
${conversation}`;

    const body = JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: 'Generate a concise title for this coding session. Respond with JSON: {"title": "your title here"}' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 100,
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
          const content = result.choices[0].message.content;
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
