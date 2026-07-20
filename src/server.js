// HTTP server + API routes
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { exec, execFile, execFileSync } = require('child_process');
const dataApi = require('./data');
const { loadSessions, loadSessionDetail, deleteSession, getGitCommits, exportSessionMarkdown, getSessionPreview, searchFullText, getActiveSessions, getSessionReplay, getCostAnalytics, computeSessionCost, getProjectGitInfo, getLeaderboardStats } = dataApi;
const { detectTerminals, openInTerminal, focusTerminalByPid, isWSL } = require('./terminals');
const { convertSession } = require('./convert');
const { generateHandoff } = require('./handoff');
const { CHANGELOG } = require('./changelog');
const { getHTML } = require('./html');
const projectsApi = require('./projects');
const settingsApi = require('./settings');
const terminal = require('./terminal');
const workspaceCommands = require('./workspace-commands');
const workspaceLayouts = require('./workspace-layouts');
// Element-level allowlist for launch flags. terminals.js currently only checks
// for 'skip-permissions'; this set is the surface area we accept from clients.
const ALLOWED_LAUNCH_FLAGS = new Set(['skip-permissions']);
const agentsDetect = require('./agents-detect');
const os = require('os');
const fs = require('fs');
const pathLib = require('path');
const { repoRefreshManager } = require('./repo-refresh');
const { handleRepoRefreshRoute } = require('./repo-refresh-routes');

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

function getValidatedPiResumeTarget(sessionId, resumeTarget, project) {
  if (typeof sessionId !== 'string' || !SAFE_SESSION_ID.test(sessionId)) return '';
  if (typeof resumeTarget !== 'string' || !resumeTarget.endsWith('.jsonl')) return '';
  if (/['`$\\\n\r\0]/.test(resumeTarget)) return '';
  const found = dataApi.findSessionFile(sessionId, project);
  if (!found || found.format !== 'pi' || !found.file) return '';
  try {
    if (fs.lstatSync(found.file).isSymbolicLink()) return '';
  } catch {
    return '';
  }
  const resolvedFound = pathLib.resolve(found.file);
  if (pathLib.resolve(resumeTarget) !== resolvedFound) return '';
  return resolvedFound;
}

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
  // DNS rebinding defense: only enforce when bound to a loopback address.
  // Users who deliberately bind to a LAN address (e.g. for cross-device
  // access) skip this check so they can hit the server by IP/hostname.
  const isLoopbackBind = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  const server = http.createServer((req, res) => {
    if (isLoopbackBind) {
      const hostName = String(req.headers.host || '').toLowerCase().split(':')[0];
      if (hostName && !allowedHosts.has(hostName)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: host header must be localhost');
        return;
      }
    }
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
      // Defense-in-depth for the loopback-only HTML page:
      // - script-src/style-src 'self' 'unsafe-inline' because the template
      //   injects all JS/CSS inline (zero-deps build, see html.js)
      // - connect-src 'self' so a malicious extension cannot fetch tokens from
      //   our API and POST them elsewhere
      // - frame-ancestors 'none' / X-Frame-Options DENY to block clickjacking
      // - X-Content-Type-Options nosniff so the browser won't sniff text/html
      //   when our endpoints return JSON.
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'",
          // fonts.googleapis.com serves the stylesheet, gstatic.com serves the
          // actual woff2 — both required by the Inter font link in index.html
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "font-src 'self' https://fonts.gstatic.com",
          // ws:/wss: for the browser terminal (same-origin WebSocket to /ws/terminal)
          "connect-src 'self' ws: wss:",
          // avatars.githubusercontent.com serves GitHub profile avatars shown in
          // the cloud profile and leaderboard (avatar_url from the GitHub API)
          "img-src 'self' data: https://avatars.githubusercontent.com",
          "frame-ancestors 'none'",
          "base-uri 'self'",
        ].join('; '),
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(getHTML());
    }

    // Favicon - inline SVG
    else if (req.method === 'GET' && pathname === '/favicon.ico') {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#60a5fa"/><path d="M8 8l8 4 8-4v16l-8 4-8-4z" fill="none" stroke="#fff" stroke-width="2"/></svg>';
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(svg);
    }

    // ── Vendored terminal assets (xterm.js) ──
    // Served lazily so the base dashboard never carries the ~490KB xterm bundle;
    // the Workspace view injects these on demand. Strict filename allowlist so
    // this can never read arbitrary files.
    else if (req.method === 'GET' && pathname.startsWith('/vendor/')) {
      const VENDOR_FILES = {
        'xterm.js': 'application/javascript; charset=utf-8',
        'addon-fit.js': 'application/javascript; charset=utf-8',
        'xterm.css': 'text/css; charset=utf-8',
      };
      const name = pathname.slice('/vendor/'.length);
      const ctype = VENDOR_FILES[name];
      if (!ctype) {
        res.writeHead(404); res.end('Not found');
      } else {
        try {
          const body = fs.readFileSync(pathLib.join(__dirname, 'frontend', 'vendor', name));
          res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'public, max-age=86400' });
          res.end(body);
        } catch (e) {
          res.writeHead(404); res.end('Not found');
        }
      }
    }

    // ── Browser terminal status (+ per-process WS token) ──
    else if (req.method === 'GET' && pathname === '/api/terminal/status') {
      // Token is only readable same-origin (the Host-header guard + no CORS
      // headers mean a cross-origin page cannot read this response), and it is
      // what gates the WS shell — see terminal.verifyUpgradeAuth.
      const status = terminal.terminalStatus();
      jsonLog(res, { available: status.available, error: status.error, hint: status.hint, token: terminal.getToken() });
    }

    // ── Saved Workspace commands (may contain proxy secrets; stored 0600) ──
    else if (pathname === '/api/terminal/commands' && req.method === 'GET') {
      jsonLog(res, { commands: workspaceCommands.loadCommands() });
    }
    else if (pathname === '/api/terminal/commands' && req.method === 'POST') {
      readBody(req, (body) => {
        let data; try { data = JSON.parse(body || '{}'); } catch (e) { data = {}; }
        workspaceCommands.addCommand(data.name, data.command)
          .then((cmd) => jsonLog(res, { ok: true, command: cmd }))
          .catch((err) => jsonLog(res, { ok: false, error: err.message }, 400));
      });
    }
    else if (pathname.startsWith('/api/terminal/commands/') && req.method === 'DELETE') {
      const id = pathname.slice('/api/terminal/commands/'.length);
      workspaceCommands.removeCommand(id)
        .then((list) => jsonLog(res, { ok: true, commands: list }))
        .catch((err) => jsonLog(res, { ok: false, error: err.message }, 400));
    }

    // ── Saved Workspace layouts (whole tab/pane/command snapshots; stored 0600) ──
    else if (pathname === '/api/terminal/layouts' && req.method === 'GET') {
      jsonLog(res, { layouts: workspaceLayouts.loadLayouts() });
    }
    else if (pathname === '/api/terminal/layouts' && req.method === 'POST') {
      readBody(req, (body) => {
        let data; try { data = JSON.parse(body || '{}'); } catch (e) { data = {}; }
        workspaceLayouts.saveLayout(data.name, data.tabs)
          .then((layout) => jsonLog(res, { ok: true, layout }))
          .catch((err) => jsonLog(res, { ok: false, error: err.message }, 400));
      });
    }
    else if (pathname.startsWith('/api/terminal/layouts/') && req.method === 'DELETE') {
      const id = pathname.slice('/api/terminal/layouts/'.length);
      workspaceLayouts.removeLayout(id)
        .then((list) => jsonLog(res, { ok: true, layouts: list }))
        .catch((err) => jsonLog(res, { ok: false, error: err.message }, 400));
    }

    // ── Repo Auto-Refresh API ───────────────
    else if (pathname.startsWith('/api/repo-refresh/') && handleRepoRefreshRoute(req, res, {
      manager: repoRefreshManager,
      getKnownGitRoots: getKnownGitRoots,
    })) {
      // handled
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
        (async () => {
          try {
            const parsed = JSON.parse(body);
            const { sessionId, resumeTarget, tool, flags, project, terminal, mode, autoRegister } = parsed;
            const fresh = mode === 'fresh';
            let piResumeTarget = '';
            if (!fresh) {
              const isSafeId = SAFE_SESSION_ID.test(String(sessionId || ''));
              const hasResumeTarget = resumeTarget !== undefined && resumeTarget !== null && resumeTarget !== '';
              piResumeTarget = tool === 'pi' && hasResumeTarget ? getValidatedPiResumeTarget(sessionId, resumeTarget, project) : '';
              if (!isSafeId || (hasResumeTarget && !piResumeTarget)) throw new Error('invalid sessionId');
            }
            if (fresh && !project) {
              throw new Error('project path required for fresh session');
            }
            // The project path flows into a shell command string in terminals.js
            // (`cd "..." && claude ...`). Even though JSON.stringify wraps the
            // value in double quotes, bash still expands $() and backticks
            // inside double-quoted strings. We refuse anything other than a
            // plain on-disk directory path.
            if (project && !projectsApi.isSafeLaunchPath(project)) {
              throw new Error('invalid or unsafe project path');
            }
            const detection = await agentsDetect.detectRealOS();
            const knownTool = settingsApi.isKnownAgent(tool);
            const detectedAgent = detection.agents.find(a => a.id === tool);
            if (knownTool && !detectedAgent) {
              throw new Error('agent not installed');
            }
            const resolvedTool = knownTool ? tool : 'claude';
            // Explicit allowlist for flags — element-level. Defense-in-depth in
            // case a future code path interpolates a flag string into a shell
            // command. Today only --dangerously-skip-permissions is allowed.
            const safeFlags = Array.isArray(flags)
              ? flags.filter(f => typeof f === 'string' && ALLOWED_LAUNCH_FLAGS.has(f))
              : [];
            const launchCommand = resolvedTool === tool && detectedAgent && typeof detectedAgent.command === 'string'
              ? detectedAgent.command
              : undefined;
            log('LAUNCH', `mode=${fresh ? 'fresh' : 'resume'} session=${sessionId || '(none)'} tool=${resolvedTool} terminal=${terminal || 'default'} project=${project || '(none)'} flags=${safeFlags.join(',') || '(none)'}`);
            openInTerminal(fresh ? '' : sessionId, resolvedTool, safeFlags, project || '', terminal || '', fresh ? 'fresh' : 'resume', launchCommand, fresh ? '' : piResumeTarget);

            // Auto-register: when a fresh launch fires for a path under $HOME
            // that is either a git repo or has been launched ≥2 times, add it
            // to the manual registry so it surfaces as a launcher card. Failures
            // here are non-fatal — the launch already succeeded.
            let registered;
            if (fresh && project && autoRegister !== false) {
              try {
                const maybe = await maybeAutoRegister(project);
                if (maybe && maybe.added) registered = maybe.project;
              } catch (e) {
                log('WARN', `auto-register failed: ${e.message}`);
              }
            }

            // Remember the tool the user picked for this project so the next
            // ▶ New click defaults to the same agent.
            if (project) {
              try { await settingsApi.rememberLastUsed(project, resolvedTool); } catch (_) {}
            }

            log('LAUNCH', 'ok');
            json(res, registered ? { ok: true, registered } : { ok: true });
          } catch (e) {
            log('ERROR', `launch failed: ${e.message}`);
            json(res, { ok: false, error: e.message }, 400);
          }
        })();
      });
    }

    // ── Settings (UI-level) ─────────────────
    else if (req.method === 'GET' && pathname === '/api/settings') {
      // Filter defaultAgent against the current installed list so the client
      // never sees a stale value pointing at an uninstalled agent.
      agentsDetect.detectRealOS().then(det => {
        const settings = settingsApi.loadSettings();
        const installedIds = new Set(det.agents.map(a => a.id));
        const safeDefault = settings.defaultAgent && installedIds.has(settings.defaultAgent)
          ? settings.defaultAgent
          : null;
        json(res, {
          defaultAgent: safeDefault,
          lastUsedByPath: settings.lastUsedByPath,
        });
      }).catch(e => json(res, { error: e.message }, 500));
    }
    else if (req.method === 'PUT' && pathname === '/api/settings') {
      readBody(req, body => {
        agentsDetect.detectRealOS().then(det => {
          let parsed;
          try { parsed = JSON.parse(body || '{}'); }
          catch { return json(res, { error: 'invalid json' }, 400); }

          const next = {};
          if (Object.prototype.hasOwnProperty.call(parsed, 'defaultAgent')) {
            const da = parsed.defaultAgent;
            if (da === null) {
              next.defaultAgent = null;
            } else if (!settingsApi.isKnownAgent(da)) {
              return json(res, { error: 'unknown agent id' }, 400);
            } else if (!det.agents.some(a => a.id === da)) {
              return json(res, { error: 'agent not installed: ' + da }, 400);
            } else {
              next.defaultAgent = da;
            }
          }
          settingsApi.updateSettings(next)
            .then(saved => json(res, {
              defaultAgent: saved.defaultAgent,
              lastUsedByPath: saved.lastUsedByPath,
            }))
            .catch(e => json(res, { error: e.message }, 500));
        }).catch(e => json(res, { error: e.message }, 500));
      });
    }

    // ── Installed agents detection ──────────
    // We expose detection metadata to the browser but strip `binPath` — the
    // browser has no business knowing the user's filesystem layout, and a
    // future code path could otherwise pass an attacker-controlled value back
    // to the server expecting it to be the same internal path.
    else if (req.method === 'GET' && pathname === '/api/agents/installed') {
      agentsDetect.detectRealOS()
        .then(d => json(res, stripBinPaths(d)))
        .catch(e => json(res, { error: e.message }, 500));
    }
    else if (req.method === 'POST' && pathname === '/api/agents/refresh-detect') {
      agentsDetect.detectRealOS({ force: true })
        .then(d => json(res, stripBinPaths(d)))
        .catch(e => json(res, { error: e.message }, 500));
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
          openIDE(ide, target || '.');
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
          const { pid, sessionId } = JSON.parse(body);
          if (!Number.isInteger(pid) || pid <= 0) {
            throw new Error('invalid pid');
          }
          if (sessionId && !/^[A-Za-z0-9._-]{1,128}$/.test(String(sessionId))) {
            throw new Error('invalid sessionId');
          }
          log('FOCUS', `pid=${pid} sessionId=${sessionId || '(none)'}`);
          const result = focusTerminalByPid(pid, sessionId);
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
      if (!profile) return json(res, { authenticated: false });
      // Never vend raw tokens to the browser. The frontend only needs to know
      // *whether* the user is connected and what the display fields are.
      const { token: _t, repoToken: _rt, ...safe } = profile;
      json(res, safe);
    }

    else if (req.method === 'POST' && pathname === '/api/github/logout') {
      saveGitHubProfile(null);
      json(res, { ok: true });
    }

    // ── Repo-scope auth: separate token for /user/repos enumeration ──
    else if (req.method === 'POST' && pathname === '/api/github/repo-scope/device-code') {
      readBody(req, body => {
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch {}
        githubRepoScopeDeviceCode(!!payload.publicOnly)
          .then(data => json(res, data))
          .catch(e => json(res, { error: e.message }, 400));
      });
    }

    else if (req.method === 'POST' && pathname === '/api/github/repo-scope/poll-token') {
      readBody(req, body => {
        try {
          const { device_code } = JSON.parse(body);
          if (!device_code) throw new Error('device_code required');
          githubRepoScopePollToken(device_code)
            .then(data => json(res, data))
            .catch(e => json(res, { error: e.message }, 400));
        } catch (e) {
          json(res, { error: e.message }, 400);
        }
      });
    }

    else if (req.method === 'GET' && pathname === '/api/github/repo-scope/status') {
      const profile = loadGitHubProfile();
      if (!profile || !profile.repoToken) {
        return json(res, { connected: false });
      }
      json(res, {
        connected: true,
        scope: profile.repoTokenScope || 'read:user repo',
        connectedAt: profile.repoTokenConnectedAt || null,
      });
    }

    else if (req.method === 'POST' && pathname === '/api/github/repo-scope/disconnect') {
      try {
        updateGitHubProfile({ repoToken: null, repoTokenScope: null, repoTokenConnectedAt: null });
        log('AUTH', 'Repo-scope GitHub token cleared locally (GitHub authorization must be revoked manually)');
        // Provide the deep link so the UI can nudge the user to also revoke
        // the OAuth authorization on github.com — clearing locally does not
        // invalidate the token at GitHub.
        json(res, {
          ok: true,
          revokeUrl: 'https://github.com/settings/connections/applications/' + GITHUB_CLIENT_ID,
        });
      } catch (e) {
        json(res, { ok: false, error: e.message }, 500);
      }
    }

    // ── GitHub repos (for project launcher) ────────────────────
    // GET /api/github/repos?type=owned|contributing
    // Requires the repo-scope token (separate from the leaderboard token) —
    // the `read:user` scope alone is not enough for /user/repos to return any
    // entries.
    else if (req.method === 'GET' && pathname === '/api/github/repos') {
      const profile = loadGitHubProfile();
      if (!profile || !profile.token) {
        return json(res, { error: 'GitHub not connected', needsRepoScope: true }, 401);
      }
      if (!profile.repoToken) {
        return json(res, { error: 'Repo access not granted yet', needsRepoScope: true }, 401);
      }
      const type = parsed.searchParams.get('type') || 'owned';
      projectsApi.listGithubRepos(profile.repoToken, type)
        .then(repos => json(res, repos))
        .catch(e => {
          const status = /401|unauthorized|bad credentials/i.test(e.message) ? 401 : 500;
          log('ERROR', `github/repos failed: ${e.message}`);
          json(res, { error: e.message, needsRepoScope: status === 401 }, status);
        });
    }

    // ── Manual / cloned projects registry ──────────────────────
    else if (req.method === 'GET' && pathname === '/api/projects/manual') {
      // Enrich each with current git info so the UI can render branch/last commit.
      const list = projectsApi.loadProjects().map(p => {
        const info = getProjectGitInfo(p.path) || null;
        return { ...p, git: info };
      });
      json(res, list);
    }

    else if (req.method === 'POST' && pathname === '/api/projects/manual') {
      readBody(req, body => {
        let payload;
        try { payload = JSON.parse(body || '{}'); }
        catch (e) { return json(res, { ok: false, error: 'invalid json' }, 400); }
        Promise.resolve()
          .then(() => projectsApi.addProject({
            name: payload.name,
            path: payload.path,
            source: payload.source,
            remoteUrl: payload.remoteUrl,
            defaultBranch: payload.defaultBranch,
          }))
          .then(project => {
            log('PROJECT', `registered ${project.name} (${project.path})`);
            json(res, { ok: true, project });
          })
          .catch(e => {
            log('ERROR', `register project failed: ${e.message}`);
            json(res, { ok: false, error: e.message }, 400);
          });
      });
    }

    else if (req.method === 'DELETE' && pathname.startsWith('/api/projects/manual/')) {
      const id = pathname.split('/').pop();
      if (!/^[a-f0-9]{16}$/.test(String(id || ''))) {
        return json(res, { ok: false, error: 'invalid id' }, 400);
      }
      projectsApi.removeProject(id)
        .then(removed => json(res, { ok: removed }))
        .catch(e => json(res, { ok: false, error: e.message }, 500));
    }

    // POST /api/projects/clone — { fullName, cloneUrl, sshUrl } → clone into ~/code/<repo> + register
    else if (req.method === 'POST' && pathname === '/api/projects/clone') {
      readBody(req, body => {
        try {
          const { fullName, cloneUrl, sshUrl, defaultBranch } = JSON.parse(body || '{}');
          if (!fullName || !cloneUrl) throw new Error('fullName and cloneUrl required');
          // Validate fullName shape (owner/repo) and reject anything weird so
          // it cannot poison log output or downstream string handling.
          if (!/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(String(fullName))) {
            throw new Error('invalid fullName (must be owner/repo)');
          }
          // Cross-check: the cloneUrl must point to the same owner/repo so a
          // crafted request can't show "victim/legit" in the UI while cloning
          // attacker-controlled code.
          const urlMatch = String(cloneUrl).match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
          if (!urlMatch) throw new Error('cloneUrl must be a github.com https URL');
          const urlFullName = urlMatch[1] + '/' + urlMatch[2].replace(/\.git$/, '');
          if (urlFullName.toLowerCase() !== String(fullName).toLowerCase()) {
            throw new Error('fullName does not match cloneUrl');
          }
          const repoName = urlMatch[2].replace(/\.git$/, '');
          if (!projectsApi.isSafeRepoName(repoName)) throw new Error('invalid repo name');
          const destDir = projectsApi.suggestCloneDir(repoName);
          log('CLONE', `start ${urlFullName} → ${destDir}`);
          projectsApi.cloneRepo(cloneUrl, destDir)
            .then(result => projectsApi.addProject({
              name: repoName,
              path: result.path,
              source: 'github-clone',
              remoteUrl: cloneUrl,
              defaultBranch: defaultBranch || '',
            }).then(project => ({ project, result })))
            .then(({ project, result }) => {
              log('CLONE', `done ${urlFullName} (${result.alreadyExisted ? 'reused' : 'cloned'})`);
              json(res, { ok: true, project, alreadyExisted: result.alreadyExisted });
            })
            .catch(e => {
              log('ERROR', `clone failed: ${e.message}`);
              json(res, { ok: false, error: e.message, sshFallback: sshUrl || null }, 400);
            });
        } catch (e) {
          json(res, { ok: false, error: e.message }, 400);
        }
      });
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

    // ── Self-update ─────────────────────────
    else if (req.method === 'POST' && pathname === '/api/update') {
      const pkg = require('../package.json');
      log('UPDATE', `Starting self-update from v${pkg.version}...`);
      json(res, { ok: true, message: 'Updating... Page will reload.' });
      // Run update in background after response is sent
      setTimeout(() => {
        const { execSync, spawn } = require('child_process');
        try {
          execSync('npm i -g codbash-app@latest', { stdio: 'inherit', timeout: 120000 });
          log('UPDATE', 'Update installed. Restarting server...');
          // Spawn a FULLY-detached restarter BEFORE exiting. Spawning inside a
          // `process.on('exit')` handler is unreliable — the event loop is already
          // draining, so the child frequently never survives and the server ends
          // up dead (nothing reclaims the port). Instead: detach + unref + ignore
          // stdio so the child outlives us, become its own process-group leader
          // (so the restarter's `lsof … | kill -9` on the port can't take it down),
          // then exit cleanly. The restarter loads the freshly-installed code from
          // the same argv[1] path that npm just overwrote.
          const child = spawn(
            process.argv[0],
            [process.argv[1], 'restart', `--port=${port}`, `--host=${host}`, '--no-browser'],
            { detached: true, stdio: 'ignore' }
          );
          child.unref();
          // Give the OS a tick to fully spawn the detached child before we exit
          // and release the port for the restarter to grab.
          setTimeout(() => process.exit(0), 250);
        } catch (e) {
          log('ERROR', `Update failed: ${e.message}`);
        }
      }, 500);
    }

    // ── 404 ─────────────────────────────────
    else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  // ── Browser terminal WebSocket (Workspace) ──
  // Hand-rolled upgrade on the stdlib server (no `ws` dependency). The terminal
  // grants shell access, so handleUpgrade enforces the per-process token +
  // same-origin Origin check before spawning a pty. cwd is restricted to paths
  // that pass the same safety bar as launching a session.
  server.on('upgrade', (req, socket, head) => {
    try {
      terminal.handleUpgrade(req, socket, head, {
        isSafeCwd: (dir) => {
          try { return projectsApi.isSafeLaunchPath(dir); } catch (_e) { return false; }
        },
        log,
      });
    } catch (err) {
      log('ERROR', 'terminal upgrade failed: ' + (err && err.message));
      try { socket.destroy(); } catch (_e) {}
    }
  });

  const bindAddr = host === 'localhost' ? DEFAULT_HOST : host;
  server.listen(port, bindAddr, () => {
    console.log('');
    console.log('  \x1b[36m\x1b[1mcodbash\x1b[0m — Claude & Codex Sessions Dashboard');
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
      } else if (process.platform === 'linux' && !isWSL()) {
        execFile('xdg-open', [browserUrl]);
      } else if (isWSL()) {
        // In WSL the browser lives on the Windows host. xdg-open inside WSL
        // typically fails or opens a Linux-side browser that nobody is looking
        // at. Print the URL and let the user click it from Windows.
        console.log('  \x1b[33mWSL detected — open this URL in your Windows browser:\x1b[0m');
        console.log(`  \x1b[36m${browserUrl}\x1b[0m`);
      }
    }

    // Delayed heartbeat + auto-sync (don't block startup)
    setTimeout(sendHeartbeat, 5000);
    setTimeout(autoSync, 15000); // first sync 15s after start
    setInterval(autoSync, 300000); // then every 5 min
  });
}

// Auto-register helper for /api/launch. Adds a fresh-launch project to the
// manual registry when it looks like a real workspace the user will revisit:
//   * the path must be under $HOME (no /tmp, no /Applications)
//   * AND either:
//      - the path contains a .git directory or file (real repo or worktree), OR
//      - the user has already fresh-launched the same path before (tracked
//        via settings.lastUsedByPath — second hit means it survived the
//        one-shot threshold).
// Returns { added: boolean, project } so the caller can surface a toast.
// Async: awaits the projects.js mutex-serialized write so we never report
// success before the registry has actually persisted the new entry.
async function maybeAutoRegister(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') return { added: false };
  const abs = pathLib.resolve(projectPath);
  const home = os.homedir();
  if (!abs.startsWith(home + pathLib.sep) && abs !== home) return { added: false };

  const existing = projectsApi.loadProjects().find(p => p.path === abs);
  if (existing) return { added: false, project: existing };

  // Single stat — both directory and file forms of .git count as a repo.
  const isGitRepo = (() => {
    try {
      const st = fs.statSync(pathLib.join(abs, '.git'));
      return st.isDirectory() || st.isFile();
    } catch { return false; }
  })();

  const previouslyLaunched = !!(settingsApi.loadSettings().lastUsedByPath || {})[abs];

  if (!isGitRepo && !previouslyLaunched) return { added: false };

  // Await the registry write so the response to the client reflects reality.
  const project = await projectsApi.addProject({
    name: pathLib.basename(abs),
    path: abs,
    source: 'auto',
  });
  return { added: true, project };
}

// Remove binPath from each agent entry before serialising to the browser.
function stripBinPaths(detection) {
  if (!detection || !Array.isArray(detection.agents)) return detection;
  return {
    refreshedAt: detection.refreshedAt,
    agents: detection.agents.map(a => {
      const { binPath, ...rest } = a;
      return rest;
    }),
  };
}

function openIDE(ide, target) {
  const bin = ide === 'cursor' ? 'cursor' : 'code';
  const winBin = bin + '.exe';
  const runLog = (err) => { if (err) log('ERROR', `${ide} open failed: ${err.message}`); };

  if (!isWSL()) {
    // execFile with argv — a project path containing quotes or spaces must not
    // get re-parsed by /bin/sh.
    execFile(bin, [target], runLog);
    return;
  }

  // WSL: branch on whether the project lives on the Windows side or inside WSL.
  const isWinSide = /^[A-Za-z]:[\\/]/.test(target) || target.includes('\\') || /^\/mnt\/[a-z]\//i.test(target);

  if (isWinSide) {
    // Translate /mnt/c/... back to C:\... and open natively on Windows.
    let winTarget = target;
    const m = target.match(/^\/mnt\/([a-z])\/(.*)$/i);
    if (m) winTarget = m[1].toUpperCase() + ':\\' + m[2].replace(/\//g, '\\');
    execFile(winBin, [winTarget], runLog);
    return;
  }

  // WSL-side project: prefer the Linux wrapper installed by the Remote-WSL
  // extension since it handles path translation. Probe via execFileSync('which')
  // so a missing import would throw loudly instead of being swallowed.
  let hasWrapper = false;
  try {
    execFileSync('which', [bin], { stdio: 'pipe' });
    hasWrapper = true;
  } catch (e) {
    if (e.code !== 1 && !/not found|No such/.test(e.message || '')) {
      log('WARN', `which ${bin} probe error: ${e.message}`);
    }
  }

  if (hasWrapper) {
    execFile(bin, [target], runLog);
    return;
  }

  const distro = process.env.WSL_DISTRO_NAME || '';
  if (!distro) {
    log('WARN', `openIDE: no WSL_DISTRO_NAME, cannot build --remote URI for ${winBin}`);
    execFile(winBin, [target], runLog);
    return;
  }
  execFile(winBin, ['--remote', `wsl+${distro}`, target], runLog);
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
  if (!keyData || !keyData.salt) return { error: 'Run "codbash cloud setup" in terminal first' };

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

  // POST /api/cloud/setup — auto-setup encryption using GitHub token (no passphrase)
  if (req.method === 'POST' && pathname === '/api/cloud/setup') {
    return new Promise(async (resolve) => {
      try {
        if (!profile || !profile.token) {
          json(res, { error: 'Connect GitHub first' }, 400); return resolve();
        }
        const passphrase = profile.token;
        const existing = loadCloudKey();

        if (existing && existing.salt) {
          // Already configured — auto-unlock
          const salt = Buffer.from(existing.salt, 'hex');
          _cachedCloudKey = deriveKey(passphrase, salt);
          log('CLOUD', 'setup: auto-unlocked with GitHub token');
          json(res, { ok: true }); return resolve();
        }

        // Check server for salt from another device
        const verifyRes = await cloudApiRequest('POST', '/api/auth/verify', profile.token);
        const serverSalt = verifyRes.status === 200 ? verifyRes.data?.user?.encryption_salt : null;

        let salt;
        if (serverSalt) {
          log('CLOUD', 'setup: using salt from another device');
          salt = Buffer.from(serverSalt, 'hex');
        } else {
          log('CLOUD', 'setup: first device, generating salt');
          salt = crypto.randomBytes(16);
          await cloudApiRequest('PUT', '/api/auth/salt', profile.token, JSON.stringify({ salt: salt.toString('hex') }));
        }

        const key = deriveKey(passphrase, salt);
        const verifier = encrypt(Buffer.from('codedash-verify'), key);
        saveCloudKey({ salt: salt.toString('hex'), verifier: verifier.toString('hex') });
        _cachedCloudKey = key;
        log('CLOUD', 'setup: OK (auto, GitHub token)');
        json(res, { ok: true }); resolve();
      } catch (e) {
        log('ERROR', `cloud setup: ${e.message}`);
        json(res, { error: e.message }, 500); resolve();
      }
    });
  }

  // GET /api/cloud/locked — auto-unlock if GitHub connected
  if (req.method === 'GET' && pathname === '/api/cloud/locked') {
    const keyData = loadCloudKey();
    const localConfigured = !!(keyData && keyData.salt);

    // Auto-unlock with GitHub token if configured
    if (localConfigured && !_cachedCloudKey && profile && profile.token) {
      try {
        const salt = Buffer.from(keyData.salt, 'hex');
        _cachedCloudKey = deriveKey(profile.token, salt);
        log('CLOUD', 'auto-unlocked with GitHub token');
      } catch {}
    }

    json(res, {
      configured: localConfigured,
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

// Cap request bodies at 2 MB. Without a limit a local process (or a page
// opened by the user that hits the loopback API) can stream arbitrary bytes
// and exhaust heap memory. 2 MB is generous — every legitimate POST body in
// this codebase is well under 100 KB.
const MAX_REQUEST_BODY = 2 * 1024 * 1024;
function readBody(req, cb) {
  let body = '';
  let size = 0;
  let aborted = false;
  req.on('data', chunk => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_REQUEST_BODY) {
      aborted = true;
      req.destroy();
      return;
    }
    body += chunk;
  });
  req.on('end', () => { if (!aborted) cb(body); });
}

// Cache so the repo-refresh routes don't pay the loadSessions cost on every hit.
let _knownGitRootsCache = null;
let _knownGitRootsCacheAt = 0;
const KNOWN_GIT_ROOTS_TTL_MS = 5_000;

function getKnownGitRoots() {
  const now = Date.now();
  if (_knownGitRootsCache && (now - _knownGitRootsCacheAt) < KNOWN_GIT_ROOTS_TTL_MS) {
    return _knownGitRootsCache;
  }
  const set = new Set();
  try {
    for (const p of projectsApi.loadProjects()) {
      if (p && p.path) set.add(p.path);
    }
  } catch {}
  try {
    const sessions = loadSessions();
    const list = Array.isArray(sessions) ? sessions : (sessions && sessions.sessions) || [];
    for (const s of list) {
      if (s && s.git_root) set.add(s.git_root);
    }
  } catch {}
  _knownGitRootsCache = set;
  _knownGitRootsCacheAt = now;
  return set;
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
    const req = https.get(`https://registry.npmjs.org/${packageName}/latest`, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data).version);
        } catch { reject(); }
      });
    });
    req.on('error', reject);
    // The `timeout` option only emits an event — without this the socket is
    // never torn down, so a stalled registry would hang /api/version forever
    // instead of falling back to "no update available".
    req.on('timeout', () => { req.destroy(new Error('registry timeout')); });
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
// fs, os, pathLib are already required at the top of the file. Aliasing path
// here so the legacy block below keeps reading naturally without renames.
const path = pathLib;

const GITHUB_CLIENT_ID = 'Ov23liBD3XGfBBIZiyK6';
const GITHUB_PROFILE_FILE = path.join(os.homedir(), '.codedash', 'github-profile.json');

function githubRequest(hostname, reqPath, method, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
    const options = {
      hostname, path: reqPath, method: method || 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'codbash' },
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
  // Keep scope minimal: the token is forwarded to leaderboard.neuraldeep.ru by
  // syncLeaderboard, so broader scopes would leak write access to a 3rd party.
  // Use the separate repo-scope flow below if you need /user/repos coverage.
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
      headers: { 'Authorization': `Bearer ${data.access_token}`, 'Accept': 'application/json', 'User-Agent': 'codbash' },
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

// ── Repo-scope auth (separate from leaderboard token) ──────────
//
// The base /login/device/code flow gets only `read:user` so the token is safe
// to forward to leaderboard.neuraldeep.ru. To enumerate the user's repos for
// the project launcher we run a second, scope-tagged device flow and store
// the resulting token in `repoToken` — kept strictly away from leaderboard
// sync. The user must explicitly opt in via the Add Project modal.

// In-memory map of pending device codes → requested scope. Bounded by GitHub's
// 15 min device-code TTL plus a small slack. Survives the lifetime of the
// process only — a restart invalidates all in-flight codes, which is fine.
const _pendingRepoScopeCodes = new Map();
const PENDING_CODE_TTL = 16 * 60 * 1000;

function _rememberPendingCode(deviceCode, scope) {
  _pendingRepoScopeCodes.set(deviceCode, { scope, exp: Date.now() + PENDING_CODE_TTL });
  // Cheap GC: prune expired entries opportunistically.
  for (const [code, meta] of _pendingRepoScopeCodes) {
    if (meta.exp < Date.now()) _pendingRepoScopeCodes.delete(code);
  }
}

async function githubRepoScopeDeviceCode(publicOnly) {
  const scope = publicOnly ? 'read:user public_repo' : 'read:user repo';
  const data = await githubRequest('github.com', '/login/device/code', 'POST',
    JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope }));
  if (data.error) throw new Error(data.error_description || data.error);
  // Don't log the user_code itself — anyone with log access could authorize
  // the device flow against the user's account before they enter it.
  log('AUTH', `Repo-scope device code issued (scope=${scope})`);
  _rememberPendingCode(data.device_code, scope);
  return {
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    device_code: data.device_code,
    interval: data.interval || 5,
    expires_in: data.expires_in,
    scope,
  };
}

async function githubRepoScopePollToken(deviceCode) {
  const data = await githubRequest('github.com', '/login/oauth/access_token', 'POST',
    JSON.stringify({ client_id: GITHUB_CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }));
  if (data.error === 'authorization_pending') return { status: 'pending' };
  if (data.error === 'slow_down') return { status: 'slow_down' };
  if (data.error === 'expired_token') {
    _pendingRepoScopeCodes.delete(deviceCode);
    return { status: 'expired' };
  }
  if (data.error) throw new Error(data.error_description || data.error);
  if (!data.access_token) throw new Error('No access token received');

  // Prefer the scope returned by GitHub on the token itself; fall back to the
  // scope we recorded when we issued the device code. We deliberately do not
  // accept a client-supplied scope to keep the stored label trustworthy.
  const requestedScope = (_pendingRepoScopeCodes.get(deviceCode) || {}).scope;
  const grantedScope = data.scope
    ? String(data.scope).split(',').map(s => s.trim()).join(' ')
    : (requestedScope || 'read:user repo');
  _pendingRepoScopeCodes.delete(deviceCode);

  updateGitHubProfile({
    repoToken: data.access_token,
    repoTokenScope: grantedScope,
    repoTokenConnectedAt: new Date().toISOString(),
  });
  log('AUTH', `Repo-scope GitHub token saved (scope=${grantedScope})`);
  return { status: 'ok', scope: grantedScope };
}

function loadGitHubProfile() {
  try {
    const data = JSON.parse(fs.readFileSync(GITHUB_PROFILE_FILE, 'utf8'));
    if (data.authenticated) return {
      authenticated: true,
      username: data.username,
      avatar: data.avatar,
      name: data.name,
      url: data.url,
      token: data.token,
      connectedAt: data.connectedAt,
      // Optional separate token with broader scope, used only by the project
      // launcher. Kept distinct from `token` so the leaderboard sync never
      // sees a write-capable credential.
      repoToken: data.repoToken || null,
      repoTokenScope: data.repoTokenScope || null,
      repoTokenConnectedAt: data.repoTokenConnectedAt || null,
    };
  } catch {}
  return null;
}

function saveGitHubProfile(profile) {
  const dir = path.dirname(GITHUB_PROFILE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (profile) {
    // Atomic write + restrictive perms (owner read/write only). The token file
    // would otherwise be world-readable on shared boxes/CI runners.
    // Double-chmod pattern: set mode on the .tmp, then re-chmod the final
    // path after rename — on some Linux filesystems renameSync preserves the
    // *destination's* mode if the file already existed, leaving a 0644 hole.
    const tmp = GITHUB_PROFILE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(profile, null, 2), { mode: 0o600 });
    if (process.platform !== 'win32') {
      try { fs.chmodSync(tmp, 0o600); } catch {}
    }
    fs.renameSync(tmp, GITHUB_PROFILE_FILE);
    if (process.platform !== 'win32') {
      try { fs.chmodSync(GITHUB_PROFILE_FILE, 0o600); } catch {}
    }
  } else {
    try { fs.unlinkSync(GITHUB_PROFILE_FILE); } catch {}
  }
}

// Merge partial fields into the existing profile so endpoints that touch
// just one slice (e.g. repoToken) don't have to rebuild the whole object.
// Bails on parse error so a corrupt file can't silently erase the user's
// existing leaderboard token. Setting a field to null *removes* it from the
// stored JSON instead of persisting an explicit null.
function updateGitHubProfile(partial) {
  let current;
  if (fs.existsSync(GITHUB_PROFILE_FILE)) {
    try {
      current = JSON.parse(fs.readFileSync(GITHUB_PROFILE_FILE, 'utf8')) || {};
    } catch (e) {
      throw new Error('github profile file is corrupt; refusing to overwrite');
    }
  } else {
    current = {};
  }
  const next = { ...current, ...partial };
  for (const key of Object.keys(partial)) {
    if (partial[key] === null) delete next[key];
  }
  saveGitHubProfile(next);
  return next;
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
    // SECURITY: leaderboard receives only the read:user-scoped token. Never
    // forward `repoToken` here — that token has repo write access.
    token: profile.token, // for server-side GitHub verification
    version: pkg.version,
    integrity: integrity,
    timezone: stats.timezone || '',
    utcOffsetMinutes: stats.utcOffsetMinutes,
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

module.exports = { startServer, getKnownGitRoots };
