// Workspace — iTerm-like browser terminal: named tabs, each with 1–4 split
// panes (B-3). Every pane is an independent xterm + WebSocket + server-side pty.
//
// Model:
//   _wsTabs = [{ id, name, panes: [pane] }]      pane = { id, cmd, term, sock, fit, ro }
//   _wsActiveTabId                                the visible tab
// Each tab owns a <div.workspace-grid data-tab-id>; only the active one is
// shown (display:grid), the rest stay in the DOM hidden so their ptys live on
// across tab switches. Layout is a CSS grid of 1–4 panes.
//
// Wire protocol (mirror of src/terminal.js):
//   • binary frames = raw terminal bytes (stdin up / stdout down)
//   • text frames   = JSON control ({t:'resize'|'ready'|'exit'|'error'})

var MAX_WS_PANES = 4;

// Split-layout icons (glyph chars like ▯ render as tofu in many fonts).
var _WS_SVG = 'width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"';
var _WS_ICON_1 = '<svg ' + _WS_SVG + '><rect x="2" y="3" width="12" height="10" rx="1"/></svg>';
var _WS_ICON_2 = '<svg ' + _WS_SVG + '><rect x="2" y="3" width="5" height="10" rx="1"/><rect x="9" y="3" width="5" height="10" rx="1"/></svg>';
var _WS_ICON_3 = '<svg ' + _WS_SVG + '><rect x="1.5" y="3" width="3.6" height="10" rx="1"/><rect x="6.2" y="3" width="3.6" height="10" rx="1"/><rect x="10.9" y="3" width="3.6" height="10" rx="1"/></svg>';
var _WS_ICON_4 = '<svg ' + _WS_SVG + '><rect x="2" y="2.5" width="5" height="5" rx="1"/><rect x="9" y="2.5" width="5" height="5" rx="1"/><rect x="2" y="8.5" width="5" height="5" rx="1"/><rect x="9" y="8.5" width="5" height="5" rx="1"/></svg>';
var _WS_ICON_GEAR = '<svg ' + _WS_SVG + '><circle cx="8" cy="8" r="2.4"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"/></svg>';

var WORKSPACE_AGENTS = [
  { label: 'Claude Code', cmd: 'claude' },
  { label: 'Codex', cmd: 'codex' },
  { label: 'Qwen', cmd: 'qwen' },
  { label: 'OpenCode', cmd: 'opencode' },
  { label: 'Kiro', cmd: 'kiro-cli' },
  { label: 'Gemini', cmd: 'gemini' }
];

var _wsTabs = [];
var _wsActiveTabId = null;
var _wsTabSeq = 0;
var _wsPaneSeq = 0;
var _wsToken = null;
var _wsVendorLoaded = false;
var _wsSavedCommands = [];   // [{ id, name, command }]
var _wsSavedLayouts = [];    // [{ id, name, tabs:[{name,panes:[{cmd}]}] }]
var _wsRoot = null;          // the live .workspace-wrap element (kept across view switches)
var _wsFocusedPaneId = null; // the pane the user is currently in (target for commands)
var _wsPendingOpen = null;   // {name?, cwd?, panes?} to open on the next mount (see openInWorkspace)

// Mark a pane as focused: remember it and highlight its box so it's obvious
// where a launched command will land.
function _wsSetFocusedPane(id) {
  _wsFocusedPaneId = id;
  Array.prototype.forEach.call(document.querySelectorAll('.ws-pane'), function (el) {
    el.classList.toggle('focused', el.getAttribute('data-pane-id') === id);
  });
}

// ── Live status (top bar) ───────────────────────────────────────────────────
// Account-limit cues we can spot in agent output (heuristic, extend freely).
var WS_LIMIT_RE = /rate.?limit|usage limit|too many requests|\b429\b|quota (?:exceeded|reached)|limit reached|overloaded|insufficient.*(?:quota|credit)/i;
var _wsStatusTimer = null;

// Output flow-control watermarks. A burst of agent output (a full-screen TUI
// repaint, `cat`-ing a big file) can pile up faster than xterm parses it on the
// main thread — which is what makes TYPING freeze. When unparsed bytes exceed
// HIGH we ask the server to pause the pty; when they drain below LOW we resume.
var WS_HIGH_WATER = 1 << 20;   // 1 MB in flight → pause
var WS_LOW_WATER = 1 << 18;    // 256 KB → resume

// A shell line that LAUNCHES a CLI agent — the first word (after any leading
// `VAR=value` env assignments, which may hold a proxy) is a known agent binary.
// We capture such lines as the user types them (see _wsConnectPane) so a window
// remembers the exact command — incl. `HTTPS_PROXY=… claude` — that macOS `ps`
// can't recover from a running process (it won't expose another proc's env).
var _WS_ENV_PREFIX_RE = /^([A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)+/;
var _WS_AGENT_WORD_RE = /^(claude|codex|opencode|cursor-agent|kiro|kiro-cli|kilo|qwen|gemini|aider|pi|omp|copilot)$/i;
function _wsIsAgentLine(line) {
  var s = String(line || '').trim().replace(_WS_ENV_PREFIX_RE, '');
  var w = s.split(/\s+/)[0] || '';
  return _WS_AGENT_WORD_RE.test(w);
}

function _wsNow() { try { return performance.now(); } catch (e) { return 0; } }

// Per-pane status: exited > limit > active (recent output) > idle.
function _wsPaneStatus(pane) {
  if (pane.exited || (pane.sock && pane.sock.readyState > 1)) return 'exited';
  if (pane.flaggedLimit) return 'limit';
  if (pane.lastOutputAt && (_wsNow() - pane.lastOutputAt) < 2500) return 'active';
  return 'idle';
}

var WS_STATUS_META = {
  active: { label: 'active', cls: 'active' },
  idle: { label: 'idle', cls: 'idle' },
  limit: { label: 'limit', cls: 'limit' },
  exited: { label: 'exited', cls: 'exited' },
};

function _wsAllPanes() {
  var out = [];
  _wsTabs.forEach(function (t) { t.panes.forEach(function (p) { out.push({ tab: t, pane: p }); }); });
  return out;
}

// The bar lives at the very top of .main so it shows on every view (not just
// Workspace). It appears only while there are live terminal panes.
function _wsEnsureStatusBar() {
  var bar = document.getElementById('wsStatusBar');
  if (bar) return bar;
  var main = document.querySelector('.main');
  if (!main) return null;
  bar = document.createElement('div');
  bar.id = 'wsStatusBar';
  bar.className = 'ws-statusbar';
  bar.style.display = 'none';
  main.insertBefore(bar, main.firstChild);
  return bar;
}

var _wsStatusSig = '';
function _wsUpdateStatusBar() {
  var bar = _wsEnsureStatusBar();
  if (!bar) return;
  // Inside the Workspace the tab bar already shows every terminal, so this
  // top strip is pure duplication that eats vertical space — hide it here and
  // keep it only as a "jump back to a running agent" affordance on other views.
  if (typeof currentView !== 'undefined' && currentView === 'workspace') {
    if (bar.style.display !== 'none') { bar.style.display = 'none'; bar.innerHTML = ''; }
    _wsStatusSig = '';   // force a rebuild when we later show it on another view
    return;
  }
  var items = _wsAllPanes().filter(function (x) { return x.pane.sock || x.pane.exited; });
  if (!items.length) {
    if (_wsStatusSig !== '') { _wsStatusSig = ''; bar.style.display = 'none'; bar.innerHTML = ''; }
    return;
  }

  var counts = { active: 0, idle: 0, limit: 0, exited: 0 };
  var sigParts = [];
  var chips = items.map(function (x) {
    var st = _wsPaneStatus(x.pane);
    counts[st]++;
    var meta = WS_STATUS_META[st];
    // The chip shows the (renamable) tab name only — clean and stable. The
    // command lands in the tooltip so it never makes the bar jitter.
    var tip = (x.pane.cwd || '') + (x.pane.cmd ? '  —  ' + _wsMaskSecrets(x.pane.cmd) : '');
    // Include `tip` in the signature: without it a cwd/cmd change with an
    // unchanged tab name + status would skip the rebuild and leave a stale tooltip.
    sigParts.push(x.tab.id + ':' + x.pane.id + ':' + x.tab.name + ':' + st + ':' + tip);
    return '<button class="ws-chip ' + meta.cls + '" title="' + escHtml(tip) + '" ' +
      'onclick="jumpToWorkspacePane(\'' + escHtml(x.tab.id) + '\',\'' + escHtml(x.pane.id) + '\')">' +
      '<span class="ws-chip-dot"></span>' + escHtml(x.tab.name) +
      '<span class="ws-chip-st">' + meta.label + '</span></button>';
  }).join('');

  // Skip the DOM rebuild when nothing changed — this is what stops the bar
  // from visibly "twitching" on every 1s tick.
  var sig = sigParts.join('|');
  if (sig === _wsStatusSig) return;
  _wsStatusSig = sig;

  var summary = '<span class="ws-sb-title">Terminals</span>' +
    '<span class="ws-sb-count">' + items.length + '</span>' +
    (counts.active ? '<span class="ws-sb-tag active">' + counts.active + ' active</span>' : '') +
    (counts.limit ? '<span class="ws-sb-tag limit">' + counts.limit + ' limit</span>' : '') +
    (counts.exited ? '<span class="ws-sb-tag exited">' + counts.exited + ' exited</span>' : '');

  bar.innerHTML = '<div class="ws-sb-summary">' + summary + '</div><div class="ws-sb-chips">' + chips + '</div>';
  bar.style.display = 'flex';
}

// ── Session restore (Chrome-like) ────────────────────────────────────────────
// Persist the open tabs/panes so a relaunch reopens the same workspace. Stored
// as the capture-layout shape ({tabs:[{name,panes:[{cmd,prefill,cwd}]}]}).
var _WS_SESSION_KEY = 'codbash-workspace-session';
var _wsLastSessionSig = '';

function _wsSaveSession() {
  try {
    var snap = _wsCaptureLayout();
    // Don't persist a lone empty pane — that's just the default blank state.
    var meaningful = snap.tabs.some(function (t) {
      return t.panes.some(function (p) { return p.cmd || p.prefill || p.cwd || p.enteredCmd; });
    }) || snap.tabs.length > 1 || (snap.tabs[0] && snap.tabs[0].panes.length > 1);
    var sig = meaningful ? JSON.stringify(snap) : '';
    if (sig === _wsLastSessionSig) return;
    _wsLastSessionSig = sig;
    if (sig) localStorage.setItem(_WS_SESSION_KEY, sig);
    else localStorage.removeItem(_WS_SESSION_KEY);
  } catch (e) { /* localStorage unavailable — non-fatal */ }
}

function _wsLoadSession() {
  try {
    var s = JSON.parse(localStorage.getItem(_WS_SESSION_KEY));
    return (s && s.tabs && s.tabs.length) ? s : null;
  } catch (e) { return null; }
}

// Does a restorable workspace session exist? Used to land straight in Terminal.
function wsHasSavedSession() { return !!_wsLoadSession(); }

// Rebuild _wsTabs from a saved session. The agent command a window launched
// comes back as a RESTORE OFFER (a banner in the pane with a "Restore" button),
// never auto-run — so a relaunch reopens the same folder and lets you resume the
// agent with one click, without silently re-spawning agents / burning tokens.
// enteredCmd (the exact typed line, incl. a proxy prefix) is preferred over the
// ps-detected command, which on macOS can't include env vars.
function _wsRestoreTabsFromSession(sess) {
  _wsTabs = sess.tabs.map(function (t, ti) {
    var panes = (t.panes && t.panes.length ? t.panes : [{}])
      .slice(0, MAX_WS_PANES)
      .map(function (p) {
        var restoreCmd = (p && (p.cmd || p.enteredCmd || p.detectedCmd || p.prefill)) || '';
        return { id: 'p' + (++_wsPaneSeq), cmd: null, prefill: null, restoreCmd: restoreCmd || null, wantCwd: (p && p.cwd) || null };
      });
    return { id: 't' + (++_wsTabSeq), name: t.name || ('Tab ' + (ti + 1)), panes: panes,
             cols: Array.isArray(t.cols) ? t.cols.slice() : null, rows: Array.isArray(t.rows) ? t.rows.slice() : null };
  });
  _wsActiveTabId = _wsTabs[0].id;
}

// Follow each live pane's real working directory (updated as the user `cd`s) by
// asking the server for the shell pids' current cwd. Runs on a slow cadence —
// the result feeds _wsSaveSession so a restored pane reopens where it actually
// was, not just where it first opened.
var _wsCwdTick = 0;
function _wsRefreshCwds() {
  var byPid = {}, pids = [];
  _wsTabs.forEach(function (t) {
    t.panes.forEach(function (p) {
      if (p.pid && _wsPaneLive(p)) { pids.push(p.pid); (byPid[p.pid] = byPid[p.pid] || []).push(p); }
    });
  });
  if (!pids.length) return;
  fetch('/api/terminal/cwd?pids=' + pids.join(','))
    .then(function (r) { return r.json(); })
    .then(function (map) {
      Object.keys(map || {}).forEach(function (pid) {
        var info = map[pid] || {};
        (byPid[pid] || []).forEach(function (p) {
          if (info.cwd) p.cwd = info.cwd;
          // The live-running agent command (incl. a rebuilt proxy prefix). Kept
          // separate from p.cmd (UI-launched) so hand-typed agents also restore.
          p.detectedCmd = info.cmd || '';
        });
      });
    })
    .catch(function () {});
}

function _wsStartStatusLoop() {
  if (_wsStatusTimer) return;
  _wsStatusTimer = setInterval(function () {
    _wsUpdateStatusBar();
    _wsRenderRunningTree();
    if ((++_wsCwdTick % 4) === 0) _wsRefreshCwds();  // ~every 4s: follow `cd`
    _wsSaveSession();   // cheap: only writes localStorage when the layout changes
    // Keep the Overview landing's cards live too.
    if (typeof _ovRefreshIfCurrent === 'function') _ovRefreshIfCurrent();
  }, 1000);
}

// Human label for an agent kind (the `kind` field from /api/active), e.g.
// 'claude' → 'Claude', 'kiro' → 'Kiro'. Falls back to a capitalized kind.
var _WS_TOOL_LABELS = {
  claude: 'Claude', codex: 'Codex', qwen: 'Qwen', opencode: 'OpenCode',
  kiro: 'Kiro', 'kiro-cli': 'Kiro', kilo: 'Kilo', cursor: 'Cursor',
  copilot: 'Copilot', 'copilot-chat': 'Copilot', pi: 'Pi', gemini: 'Gemini',
};
function _wsToolLabel(kind) {
  if (!kind) return 'Agent';
  return _WS_TOOL_LABELS[kind] || (kind.charAt(0).toUpperCase() + kind.slice(1));
}

// Group *running agents in EXTERNAL native terminals* (from the live /api/active
// map, not Workspace panes) by their real project folder. Agents running inside
// a codbash browser-pty pane (tagged `local` server-side) are excluded — they
// are already visible as Workspace tabs, so surfacing them here too is just
// noise. See docs/design/running-agents-external.md. Used by the sidebar tree.
function _wsRunningByProject() {
  var map = (typeof activeSessions === 'object' && activeSessions) || {};
  var groups = {}, order = [];
  Object.keys(map).forEach(function (k) {
    var a = map[k];
    // Skip codbash's own panes: this tree is for agents in external terminals,
    // the ones that have no other UI home. (Undefined `local` — an older server
    // payload — is treated as external so nothing silently disappears.)
    if (a && a.local === true) return;
    var cwd = (a && a.cwd) || '';
    // Only skip entries with no cwd (can't group or focus a window).
    if (!cwd) return;
    var isHome = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)\/?$/.test(cwd);
    var key = cwd; // group by full path so two same-named folders don't merge
    if (!groups[key]) {
      groups[key] = { name: isHome ? '~' : _wsProjectBasename(cwd), cwd: cwd, items: [] };
      order.push(key);
    }
    groups[key].items.push(a);
  });
  return order.map(function (k) { return groups[k]; });
}

// Sanitize a pid for an inline onclick arg: a positive integer, else 0. Mirrors
// the server's /api/focus check (Number.isInteger(pid) > 0) — a truncated float
// would be rejected there anyway, so we reject it here too rather than round it.
function _wsPidArg(pid) {
  var n = typeof pid === 'number' ? pid : parseInt(pid, 10);
  return (Number.isInteger(n) && n > 0) ? String(n) : '0';
}

// Click a running-agent row. These rows are agents in EXTERNAL native terminals
// (codbash's own panes are filtered out of the tree), so the honest action is to
// raise that real terminal window by PID — reusing /api/focus (focusTerminalByPid,
// same path the session cards' "Focus Terminal" uses). We deliberately do NOT
// open a blank in-app terminal as a stand-in: an empty shell is not the agent,
// and resuming (claude --continue) would spawn a SECOND instance of a live agent.
// `cwd`/`kind` are kept in the signature for call-site stability but unused here
// (focus is keyed purely by pid); `sessionId` is forwarded for the server log.
function jumpToRunningAgent(cwd, sessionId, kind, pid) {
  var n = typeof pid === 'number' ? pid : parseInt(pid, 10);
  if (!Number.isInteger(n) || n <= 0) {
    if (typeof showToast === 'function') showToast('No terminal window to focus for this agent.');
    return;
  }
  fetch('/api/focus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid: n, sessionId: sessionId || '' })
  })
    .then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, d: d }; },
        function () { return { ok: r.ok, d: {} }; });
    })
    .then(function (res) {
      if (!res.ok || !res.d || res.d.ok === false) {
        if (typeof showToast === 'function') showToast('Couldn’t focus its terminal window.');
      }
    })
    .catch(function () {
      if (typeof showToast === 'function') showToast('Couldn’t focus its terminal window.');
    });
}

// Render a compact tree at the bottom of the sidebar: each project folder with a
// running agent, the agents underneath labeled by agent name — click to jump.
var _wsRunTreeSig = '';
function _wsRenderRunningTree() {
  var el = document.getElementById('wsRunningTree');
  if (!el) return;
  var groups = _wsRunningByProject();
  var sig = groups.map(function (g) {
    return g.cwd + ':' + g.items.map(function (a) {
      return (a.sessionId || a.pid) + '=' + a.kind + '/' + a.status;
    }).join(',');
  }).join('|');
  if (sig === _wsRunTreeSig) return;   // no change → no rebuild
  _wsRunTreeSig = sig;

  if (!groups.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  var html = '<div class="ws-run-title" title="Agents running in external terminals — click to bring their window forward">Running agents</div>';
  groups.forEach(function (g) {
    // The project header focuses the first agent's window (a reasonable default
    // when a folder hosts several).
    var headPid = _wsPidArg(g.items[0] && g.items[0].pid);
    html += '<div class="ws-run-proj" title="' + escHtml(g.cwd) + '" ' +
      'onclick="jumpToRunningAgent(' + _wsJsStr(g.cwd) + ',null,null,' + headPid + ')">' +
      '<span class="ws-run-dot"></span><span class="ws-run-name">' + escHtml(g.name) + '</span>' +
      '<span class="ws-run-count">' + g.items.length + '</span></div>';
    g.items.forEach(function (a) {
      var waiting = a.status === 'waiting';
      html += '<div class="ws-run-term' + (waiting ? ' ws-run-idle' : '') + '" ' +
        'title="' + escHtml(_wsToolLabel(a.kind) + (waiting ? ' — idle' : ' — active') + ' — click to focus its terminal window') + '" ' +
        'onclick="jumpToRunningAgent(' + _wsJsStr(g.cwd) + ',' + _wsJsStr(a.sessionId || '') + ',' + _wsJsStr(a.kind || '') + ',' + _wsPidArg(a.pid) + ')">' +
        escHtml(_wsToolLabel(a.kind)) + '</div>';
    });
  });
  el.innerHTML = html;
  el.style.display = '';
}

// Safely embed a JS string literal inside a double-quoted inline onclick=""
// attribute: JS-escape backslash/quote, then HTML-escape the attribute-breaking
// characters so an odd path (spaces, &, quotes) can't break out of either layer.
function _wsJsStr(s) {
  var js = "'" + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  return js.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Jump from a status chip to that pane: show Workspace, activate its tab, focus it.
function jumpToWorkspacePane(tabId, paneId) {
  if (typeof setView === 'function') setView('workspace');
  setTimeout(function () {
    activateWorkspaceTab(tabId);
    _wsSetFocusedPane(paneId);
    var host = document.getElementById('wsTermHost-' + paneId);
    var pane = _wsFindPane(paneId);
    if (pane && pane.term) { try { pane.term.focus(); } catch (e) {} }
    if (host && host.scrollIntoView) host.scrollIntoView({ block: 'nearest' });
  }, 30);
}

// Mask credentials in a URL userinfo (proxy passwords) for display only.
function _wsMaskSecrets(cmd) {
  return String(cmd).replace(/(:\/\/[^:/@\s]+:)[^@\s]+(@)/g, '$1****$2');
}

function _wsLoadCommands() {
  return fetch('/api/terminal/commands')
    .then(function (r) { return r.json(); })
    .then(function (d) { _wsSavedCommands = (d && d.commands) || []; _wsRefreshLaunchers(); })
    .catch(function () { _wsSavedCommands = []; });
}

// <option>s for a pane's Launch menu: built-in agents + saved commands.
function _wsLaunchOptionsHtml() {
  var html = '<option value="">Launch ▾</option>';
  html += '<optgroup label="Agents">';
  WORKSPACE_AGENTS.forEach(function (a) { html += '<option value="' + escHtml(a.cmd) + '">' + escHtml(a.label) + '</option>'; });
  html += '</optgroup>';
  if (_wsSavedCommands.length) {
    html += '<optgroup label="Saved">';
    _wsSavedCommands.forEach(function (c) { html += '<option value="' + escHtml(c.command) + '">' + escHtml(c.name) + '</option>'; });
    html += '</optgroup>';
  }
  return html;
}

// Refresh every open pane's Launch menu in place (after commands change).
function _wsRefreshLaunchers() {
  Array.prototype.forEach.call(document.querySelectorAll('.ws-pane-launch'), function (sel) {
    sel.innerHTML = _wsLaunchOptionsHtml();
  });
}

// ── vendor ──────────────────────────────────────────────────────────────────
function _loadWorkspaceVendor() {
  if (_wsVendorLoaded) return Promise.resolve();
  return new Promise(function (resolve, reject) {
    if (!document.querySelector('link[data-xterm]')) {
      var link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = '/vendor/xterm.css';
      link.setAttribute('data-xterm', '1');
      document.head.appendChild(link);
    }
    function loadScript(src) {
      return new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = src; s.onload = res;
        s.onerror = function () { rej(new Error('failed to load ' + src)); };
        document.head.appendChild(s);
      });
    }
    loadScript('/vendor/xterm.js')
      .then(function () { return loadScript('/vendor/addon-fit.js'); })
      // GPU/canvas renderer addons — sharpen glyph rendering to native-terminal
      // quality (the default DOM renderer leaves hairline gaps between block
      // glyphs). WebGL is preferred: unlike the canvas renderer it doesn't show
      // HiDPI horizontal banding inside Electron. Both are optional — a load
      // failure must not block the terminal, so we swallow errors and fall back.
      .then(function () { return loadScript('/vendor/addon-webgl.js').catch(function () {}); })
      .then(function () { return loadScript('/vendor/addon-canvas.js').catch(function () {}); })
      .then(function () { _wsVendorLoaded = true; resolve(); })
      .catch(reject);
  });
}

// ── lookups ─────────────────────────────────────────────────────────────────
function _wsTab(id) { return _wsTabs.find(function (t) { return t.id === id; }); }
function _wsActiveTab() { return _wsTab(_wsActiveTabId); }
function _wsFindPane(id) {
  for (var i = 0; i < _wsTabs.length; i++) {
    var p = _wsTabs[i].panes.find(function (x) { return x.id === id; });
    if (p) return p;
  }
  return null;
}

// ── teardown ────────────────────────────────────────────────────────────────
function _wsTeardownPane(pane) {
  if (!pane) return;
  if (pane.ro) { try { pane.ro.disconnect(); } catch (e) {} }
  if (pane.sock) { try { pane.sock.onclose = null; pane.sock.close(); } catch (e) {} }
  if (pane.term) { try { pane.term.dispose(); } catch (e) {} }
  pane.sock = null; pane.term = null; pane.fit = null; pane.ro = null;
}
// Hidden off-screen holder that keeps the live workspace DOM (and therefore its
// xterm instances + WebSockets + ptys) alive while another dashboard view is
// shown. Leaving the Workspace view DETACHES here; returning re-attaches.
function _wsHolder() {
  var h = document.getElementById('wsHolder');
  if (!h) {
    h = document.createElement('div');
    h.id = 'wsHolder';
    h.style.display = 'none';
    document.body.appendChild(h);
  }
  return h;
}

// Called from render() when navigating AWAY from the Workspace view. Moves the
// live workspace into the hidden holder instead of destroying it, so panes and
// their ptys keep running and everything is exactly as left on return.
function detachWorkspaceIfMounted() {
  if (_wsRoot && _wsRoot.parentNode && _wsRoot.parentNode.id === 'content') {
    _wsHolder().appendChild(_wsRoot);
  }
}

// Full teardown — kills every pty and drops all state. Not used on normal view
// switches (those detach); reserved for an explicit reset.
function teardownWorkspaceIfActive() {
  if (_wsTabs.length) _wsTabs.forEach(function (t) { t.panes.forEach(_wsTeardownPane); });
  _wsTabs = []; _wsActiveTabId = null;
  if (_wsRoot) { try { _wsRoot.remove(); } catch (e) {} _wsRoot = null; }
  if (_wsStatusTimer) { clearInterval(_wsStatusTimer); _wsStatusTimer = null; }
  _wsUpdateStatusBar();
}

// ── pane connection ─────────────────────────────────────────────────────────
function _wsShortCwd(cwd) {
  if (!cwd) return 'ready';
  return cwd.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

// A short, human label for a pane's title bar: the running agent (if any),
// otherwise the folder name (e.g. "CoWork"), or "~" for the home directory.
function _wsPaneLabel(pane) {
  if (pane && pane.cmd) {
    // Strip leading `VAR=value` env assignments (value may be quoted and hold
    // secrets, e.g. HTTPS_PROXY='http://user:pass@host') so the label is the
    // actual command — "claude", not the proxy string.
    var cmd = String(pane.cmd).trim()
      .replace(/^([A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)+/, '');
    var w = cmd.split(/\s+/)[0];
    if (w) return (typeof _wsMaskSecrets === 'function') ? _wsMaskSecrets(w) : w;
  }
  var c = (pane && pane.cwd) || '';
  if (!c) return 'shell';
  if (/^(\/Users\/[^/]+|\/home\/[^/]+|\/root)\/?$/.test(c)) return '~';
  return _wsProjectBasename(c);
}

function _wsConnectPane(pane) {
  var host = document.getElementById('wsTermHost-' + pane.id);
  if (!host) return;

  var _tp = _wsTermPrefs;
  var term = new Terminal({
    cursorBlink: _tp.cursorBlink, cursorStyle: _tp.cursorStyle,
    fontSize: _tp.fontSize, fontFamily: _tp.fontFamily,
    theme: _wsTermTheme(), scrollback: 5000, allowProposedApi: true
  });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  host.style.background = _wsTermTheme().background;   // match frame to theme
  term.open(host);
  // Upgrade the renderer for crisp, native-terminal glyph rendering (the DOM
  // renderer leaves sub-pixel gaps between block glyphs). Try WebGL first — it
  // avoids the HiDPI horizontal banding the canvas renderer shows inside
  // Electron — then canvas, then keep the DOM renderer. Best-effort throughout:
  // the vendored addons target a nearby @xterm core, so any activate()/context
  // failure silently falls through to the next option and never breaks the term.
  var _rendererUpgraded = false;
  try {
    if (typeof WebglAddon !== 'undefined' && WebglAddon.WebglAddon) {
      var webgl = new WebglAddon.WebglAddon();
      // If the GPU context is lost (driver reset, too many contexts), drop the
      // addon so xterm falls back to its DOM renderer instead of going blank.
      if (webgl.onContextLoss) webgl.onContextLoss(function () { try { webgl.dispose(); } catch (e) {} });
      term.loadAddon(webgl);
      _rendererUpgraded = true;
    }
  } catch (e) { _rendererUpgraded = false; /* try canvas next */ }
  if (!_rendererUpgraded) {
    try {
      if (typeof CanvasAddon !== 'undefined' && CanvasAddon.CanvasAddon) {
        term.loadAddon(new CanvasAddon.CanvasAddon());
      }
    } catch (e) { /* keep DOM renderer */ }
  }
  pane.term = term; pane.fit = fit;

  // Fit only when the host actually has a size. Fitting a zero-size / not-yet-
  // laid-out host (inactive tab, mid-transition pane) computes bogus cols/rows,
  // which spawns the pty at the wrong width and garbles full-screen TUIs like
  // Claude Code — most visibly on large / hi-DPI displays (see #259).
  function _wsFitPane() {
    if (!host.clientWidth || !host.clientHeight) return false;
    try { fit.fit(); return true; } catch (e) { return false; }
  }
  _wsFitPane();                          // best-effort now (correct URL dims if laid out)
  requestAnimationFrame(_wsFitPane);     // and again after the first paint

  // Track which pane the user is "in": focusing/clicking the terminal marks it
  // as the focused pane, so saved commands / resume land where you're looking.
  host.addEventListener('focusin', function () { _wsSetFocusedPane(pane.id); });
  host.addEventListener('mousedown', function () { _wsSetFocusedPane(pane.id); });

  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var url = proto + '//' + location.host + '/ws/terminal' +
    '?token=' + encodeURIComponent(_wsToken) + '&cols=' + term.cols + '&rows=' + term.rows +
    (pane.wantCwd ? '&cwd=' + encodeURIComponent(pane.wantCwd) : '');
  var sock = new WebSocket(url);
  sock.binaryType = 'arraybuffer';
  pane.sock = sock;

  var enc = new TextEncoder();
  var dec = new TextDecoder();
  function setStatus(txt) { var el = document.getElementById('wsStatus-' + pane.id); if (el) el.textContent = txt; }

  sock.onopen = function () { setStatus('connected'); pane.exited = false; };
  sock.onmessage = function (ev) {
    if (typeof ev.data === 'string') {
      var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === 'ready') {
        pane.cwd = msg.cwd;
        pane.pid = msg.pid;   // shell pid — used to follow `cd` for session restore
        setStatus(_wsPaneLabel(pane));
        _wsAutoNameTab(pane);
        // Now that the pane is laid out and connected, re-fit and push the true
        // size to the pty so xterm and the pty agree (fixes wrong-width TUIs).
        if (_wsFitPane() && sock.readyState === 1) {
          sock.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
        }
        // The requested folder couldn't be opened, so the shell started in $HOME.
        // Running an agent here would MISFILE its conversation under the wrong
        // project (agents key history by cwd). Warn loudly and DON'T auto-run —
        // this is exactly the "my dialog disappeared from that folder" trap.
        if (msg.cwdFellBack) {
          var wanted = _wsShortCwd(pane.wantCwd || msg.requestedCwd || '');
          if (typeof showToast === 'function') showToast('⚠ Couldn’t open ' + wanted + ' — shell started in ~. Agent history would save under home. cd there first, or reopen the folder.');
          term.write('\r\n\x1b[33m⚠ Requested folder unavailable — started in home (' + msg.cwd + ').\x1b[0m\r\n');
          if (pane.restoreCmd) _wsShowRestoreBanner(pane);  // let the user decide, don't auto-run
          _wsUpdateStatusBar();
          return;
        }
        // cmd auto-runs (trailing \r); prefill is typed but NOT executed so the
        // user can review/edit a resume command before pressing Enter; restoreCmd
        // is offered via a banner (one click to resume the remembered agent).
        if (pane.cmd) setTimeout(function () { if (sock.readyState === 1) sock.send(enc.encode(pane.cmd + '\r')); }, 120);
        else if (pane.prefill) setTimeout(function () { if (sock.readyState === 1) sock.send(enc.encode(pane.prefill)); if (pane.term) pane.term.focus(); }, 120);
        else if (pane.restoreCmd) _wsShowRestoreBanner(pane);
      } else if (msg.t === 'exit') { pane.exited = true; setStatus('exited (' + msg.code + ')'); _wsUpdateStatusBar(); }
      else if (msg.t === 'error') { setStatus('error'); term.write('\r\n\x1b[31m' + (msg.message || 'error') + '\x1b[0m\r\n'); }
      return;
    }
    // Raw output. Write with a completion callback so we can flow-control: xterm
    // invokes the callback once it has PARSED this chunk, letting us track how
    // much output is still in flight. Without this a burst blocks the main thread
    // and typing appears to freeze.
    pane.lastOutputAt = _wsNow();
    var bytes = new Uint8Array(ev.data);
    pane._pending = (pane._pending || 0) + bytes.length;
    term.write(bytes, function () {
      pane._pending -= bytes.length;
      if (pane._paused && pane._pending < WS_LOW_WATER) {
        pane._paused = false;
        if (sock.readyState === 1) sock.send(JSON.stringify({ t: 'resume' }));
      }
    });
    if (!pane._paused && pane._pending > WS_HIGH_WATER) {
      pane._paused = true;
      if (sock.readyState === 1) sock.send(JSON.stringify({ t: 'pause' }));
    }
    // Account-limit detection: previously decoded + regex-scanned EVERY chunk,
    // which amplified bursts. Now throttled to ~1/s and only on small chunks
    // (a limit notice is short), decoding just what we scan.
    if (bytes.length <= 8192 && (pane._lastLimitScan == null || _wsNow() - pane._lastLimitScan > 1000)) {
      pane._lastLimitScan = _wsNow();
      try { if (WS_LIMIT_RE.test(dec.decode(bytes))) pane.flaggedLimit = true; } catch (e) {}
    }
  };
  sock.onclose = function () { setStatus('disconnected'); pane.exited = true; _wsUpdateStatusBar(); };
  sock.onerror = function () { setStatus('connection error'); };

  // Shift+Enter → insert a newline instead of submitting. Plain xterm sends a
  // bare CR for Enter with no Shift distinction, so multiline TUIs (Claude Code,
  // Codex) can't tell them apart. We send ESC+CR (\x1b\r) — the exact sequence
  // `claude /terminal-setup` binds Shift+Enter to — so newline works out of the
  // box. Returning false stops xterm from also emitting a plain CR.
  term.attachCustomKeyEventHandler(function (e) {
    if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey) {
      if (sock.readyState === 1) sock.send(enc.encode('\x1b\r'));
      return false;
    }
    return true;
  });

  // Capture the shell input line so a window remembers the agent command it
  // launched (folder + `HTTPS_PROXY=… claude`). We track keystrokes into a line
  // buffer; on Enter, if the completed line launches an agent, store it verbatim
  // on the pane (persisted by _wsSaveSession, offered back on next open). Reading
  // the typed line — not the running process — is the only way to recover the
  // proxy prefix, which macOS `ps` refuses to expose.
  pane._lineBuf = '';
  term.onData(function (data) {
    if (sock.readyState === 1) sock.send(enc.encode(data));
    try {
      for (var i = 0; i < data.length; i++) {
        var code = data.charCodeAt(i);
        if (code === 0x1b) { pane._lineBuf = ''; break; }        // escape seq (arrows, etc.) — bail on this chunk
        if (code === 0x0d || code === 0x0a) {                     // Enter — line committed
          var line = pane._lineBuf; pane._lineBuf = '';
          if (_wsIsAgentLine(line)) { pane.enteredCmd = line.trim(); _wsSaveSession(); }
        } else if (code === 0x7f || code === 0x08) {              // backspace
          pane._lineBuf = pane._lineBuf.slice(0, -1);
        } else if (code === 0x15 || code === 0x03) {              // Ctrl-U / Ctrl-C — clear line
          pane._lineBuf = '';
        } else if (code >= 0x20) {                                // printable
          pane._lineBuf += data[i];
        }
      }
    } catch (e) { /* capture is best-effort — never break input */ }
  });

  var rt = null;
  pane.ro = new ResizeObserver(function () {
    clearTimeout(rt);
    rt = setTimeout(function () {
      if (_wsFitPane() && sock.readyState === 1) {
        sock.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
      }
    }, 100);
  });
  try { pane.ro.observe(host.parentNode); } catch (e) {}
}

// ── markup ──────────────────────────────────────────────────────────────────
function _wsPaneMarkup(pane) {
  return '' +
    '<div class="ws-pane" data-pane-id="' + escHtml(pane.id) + '">' +
      '<div class="ws-pane-bar">' +
        '<span class="ws-pane-status" id="wsStatus-' + escHtml(pane.id) + '">connecting…</span>' +
        '<select class="ws-pane-launch" title="Launch an agent or saved command in this pane" ' +
          'onchange="launchAgentInPane(\'' + escHtml(pane.id) + '\', this.value); this.selectedIndex=0;">' + _wsLaunchOptionsHtml() + '</select>' +
        '<button class="ws-pane-bm" title="Bookmark this folder + agent" aria-label="Bookmark" onclick="bookmarkPane(\'' + escHtml(pane.id) + '\')">&#9734;</button>' +
        '<button class="ws-pane-close" title="Close pane" onclick="closeWorkspacePane(\'' + escHtml(pane.id) + '\')">&times;</button>' +
      '</div>' +
      '<div class="ws-pane-term" id="wsTermHost-' + escHtml(pane.id) + '"></div>' +
      '<div class="ws-restore-banner" id="wsRestore-' + escHtml(pane.id) + '" hidden></div>' +
    '</div>';
}

// Turn a remembered launch command into the one that CONTINUES that agent's
// last conversation in this folder — the browser-tab-state metaphor: reopening
// restores the dialog, not a blank agent. We keep any `VAR=value` env prefix
// (so the proxy survives) and only append/insert the agent's continue form.
// If the command already resumes, or the agent has no known continue flag, it's
// returned unchanged (so the worst case is a fresh agent, never a broken cmd).
function _wsResumeVariant(cmd) {
  var s = String(cmd || '').trim();
  if (!s) return s;
  var env = '';
  var m = s.match(_WS_ENV_PREFIX_RE);
  if (m) { env = m[0]; s = s.slice(m[0].length); }
  // Already a resume/continue invocation — leave it be.
  if (/(^|\s)(--continue|-c|--resume|resume)(\s|$)/.test(s)) return env + s;
  var word = (s.split(/\s+/)[0] || '').toLowerCase();
  switch (word) {
    // Claude: `--continue` resumes the most recent conversation in the cwd,
    // keeping any other flags (e.g. --dangerously-skip-permissions).
    case 'claude':
    case 'claude-ext': return env + s + ' --continue';
    // Codex only resumes via a subcommand; safe when launched bare (`codex`).
    case 'codex': return env + (s === 'codex' ? 'codex resume --last' : s);
    default: return env + s;
  }
}

// Show the "resume where you left off" banner for a restored pane: the folder it
// opened in and a one-click button that CONTINUES the agent's last conversation
// there (incl. its proxy prefix). Nothing runs until the user clicks — reopening
// a tab shouldn't silently spend tokens.
function _wsShowRestoreBanner(pane) {
  var el = document.getElementById('wsRestore-' + pane.id);
  if (!el || !pane.restoreCmd) return;
  pane._resumeCmd = _wsResumeVariant(pane.restoreCmd);
  var label = (typeof _wsMaskSecrets === 'function') ? _wsMaskSecrets(pane._resumeCmd) : pane._resumeCmd;
  var where = _wsShortCwd(pane.cwd || pane.wantCwd || '');
  var continues = pane._resumeCmd !== pane.restoreCmd;   // did we add a continue form?
  el.innerHTML =
    '<div class="ws-restore-inner">' +
      '<div class="ws-restore-text">' +
        '<span class="ws-restore-title">' + (continues ? 'Resume your conversation' : 'Reopen this terminal') + '</span>' +
        '<span class="ws-restore-sub"><code>' + escHtml(label) + '</code> in ' + escHtml(where) + '</span>' +
      '</div>' +
      '<div class="ws-restore-actions">' +
        '<button class="ws-restore-run" onclick="wsRestorePaneCmd(\'' + escHtml(pane.id) + '\')">' + (continues ? 'Resume' : 'Run') + '</button>' +
        '<button class="ws-restore-dismiss" onclick="wsDismissRestore(\'' + escHtml(pane.id) + '\')" title="Dismiss">&times;</button>' +
      '</div>' +
    '</div>';
  el.hidden = false;
}

// Run the resume command in the pane (user clicked Resume) — the continue
// variant when the agent supports it, otherwise the remembered command.
function wsRestorePaneCmd(paneId) {
  var pane = _wsFindPane(paneId);
  if (!pane || !pane.restoreCmd) return;
  var cmd = pane._resumeCmd || _wsResumeVariant(pane.restoreCmd);
  if (pane.sock && pane.sock.readyState === 1) {
    pane.sock.send(new TextEncoder().encode(cmd + '\r'));
  }
  pane.cmd = cmd;            // now it's the pane's running command (label, restore next time)
  pane.restoreCmd = null;
  pane._resumeCmd = null;
  wsDismissRestore(paneId);
  if (pane.term) pane.term.focus();
  var st = document.getElementById('wsStatus-' + paneId);
  if (st) st.textContent = _wsPaneLabel(pane);
  _wsSaveSession();
}

// Dismiss the restore banner without running anything.
function wsDismissRestore(paneId) {
  var pane = _wsFindPane(paneId);
  if (pane) pane.restoreCmd = null;
  var el = document.getElementById('wsRestore-' + paneId);
  if (el) { el.hidden = true; el.innerHTML = ''; }
  _wsSaveSession();
}

// ── Bookmarks (Chrome-like bookmarks bar) ────────────────────────────────────
// A bookmark is a saved "site" in the browser metaphor: a folder + the agent to
// run in it. One click opens a new terminal there and launches that agent. This
// is deliberately lighter than a saved Layout (a whole-workspace snapshot) — a
// bookmark is a single target you reach for constantly, like a pinned tab.
var _WS_BOOKMARKS_KEY = 'codbash-bookmarks';
var _WS_BM_FOLDERS_KEY = 'codbash-bookmark-folders';
var _wsBookmarks = [];
var _wsBmFolders = [];   // [{ id, name, color }] — named groups, Chrome-like
var _WS_BM_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#ef4444', '#06b6d4', '#eab308'];

function _wsLoadBookmarks() {
  try { var a = JSON.parse(localStorage.getItem(_WS_BOOKMARKS_KEY)); _wsBookmarks = Array.isArray(a) ? a : []; }
  catch (e) { _wsBookmarks = []; }
  try { var f = JSON.parse(localStorage.getItem(_WS_BM_FOLDERS_KEY)); _wsBmFolders = Array.isArray(f) ? f : []; }
  catch (e) { _wsBmFolders = []; }
}
function _wsSaveBookmarks() {
  try { localStorage.setItem(_WS_BOOKMARKS_KEY, JSON.stringify(_wsBookmarks)); } catch (e) {}
  try { localStorage.setItem(_WS_BM_FOLDERS_KEY, JSON.stringify(_wsBmFolders)); } catch (e) {}
}
function _wsBmNextColor() {
  return _WS_BM_COLORS[_wsBookmarks.length % _WS_BM_COLORS.length];
}
function _wsBmFolder(id) { return _wsBmFolders.find(function (f) { return f.id === id; }); }

// The agent word a bookmark launches (for its label/icon), e.g. "claude".
function _wsBmAgentWord(cmd) {
  var s = String(cmd || '').trim().replace(_WS_ENV_PREFIX_RE, '');
  return (s.split(/\s+/)[0] || '').toLowerCase();
}

// One bookmark chip (draggable — drop it on a folder to file it there).
function _wsBmChipHtml(b) {
  var sub = b.cmd ? _wsBmAgentWord(b.cmd) : (_wsShortCwd(b.cwd) || 'shell');
  var tip = (b.cwd || '') + (b.cmd ? '  —  ' + _wsMaskSecrets(b.cmd) : '');
  var id = escHtml(b.id);
  return '' +
    '<button class="ws-bm" data-bm-id="' + id + '" title="' + escHtml(tip) + '" draggable="true" ' +
      'ondragstart="wsBmDragStart(event,\'' + id + '\')" ondragend="wsBmDragEnd(event)" ' +
      'onclick="openBookmark(\'' + id + '\')" ondblclick="renameBookmark(\'' + id + '\')">' +
      '<span class="ws-bm-dot" style="background:' + escHtml(b.color || '#3b82f6') + '"></span>' +
      '<span class="ws-bm-label">' + escHtml(b.label || _wsProjectBasename(b.cwd) || 'shell') + '</span>' +
      '<span class="ws-bm-sub">' + escHtml(sub) + '</span>' +
      '<span class="ws-bm-x" title="Remove bookmark" onclick="event.stopPropagation();removeBookmark(\'' + id + '\')">&times;</span>' +
    '</button>';
}

function _wsRenderBookmarks() {
  var bar = document.getElementById('wsBookmarks');
  if (!bar) return;
  // Empty (no folders AND no bookmarks) → hide the strip. Add bookmarks via the
  // ☆ in a pane's title bar, or make a folder with the 📁+ button.
  if (!_wsBookmarks.length && !_wsBmFolders.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = 'flex';

  // Folder chips (dropdowns) first, then loose bookmarks (no valid folder).
  var folderChips = _wsBmFolders.map(function (f) {
    var count = _wsBookmarks.filter(function (b) { return b.folderId === f.id; }).length;
    var id = escHtml(f.id);
    return '' +
      '<button class="ws-bm ws-bm-folder" data-folder-id="' + id + '" title="' + escHtml(f.name) + '" ' +
        'onclick="toggleBookmarkFolder(event,\'' + id + '\')" ondblclick="renameBmFolder(\'' + id + '\')" ' +
        'ondragover="wsBmDragOverFolder(event,\'' + id + '\')" ondragleave="wsBmDragLeaveFolder(event)" ondrop="wsBmDropOnFolder(event,\'' + id + '\')">' +
        '<span class="ws-bm-folder-ico" style="color:' + escHtml(f.color || '#f59e0b') + '">▾</span>' +
        '<span class="ws-bm-label">' + escHtml(f.name) + '</span>' +
        '<span class="ws-bm-sub">' + count + '</span>' +
      '</button>';
  }).join('');
  var loose = _wsBookmarks.filter(function (b) { return !b.folderId || !_wsBmFolder(b.folderId); });
  var looseChips = loose.map(_wsBmChipHtml).join('');

  bar.innerHTML =
    '<span class="ws-bm-lead" title="Bookmarks">☆</span>' +
    folderChips + looseChips +
    '<button class="ws-bm-add" title="Bookmark the current terminal" onclick="addBookmarkFromFocused()">+</button>' +
    '<button class="ws-bm-add ws-bm-newfolder" title="New bookmark group" onclick="createBmFolder()">▾+</button>';
}

// Open a bookmark: a new tab in its folder, launching its agent (explicit click
// = intent to run, so this auto-runs — unlike passive session restore).
function openBookmark(id) {
  _wsCloseBmMenu();
  var b = _wsBookmarks.find(function (x) { return x.id === id; });
  if (!b) return;
  openInWorkspace({ name: b.label || _wsProjectBasename(b.cwd), cwd: b.cwd || null, cmd: b.cmd || null });
}

// Save a bookmark from a pane (its folder + the agent command it launched).
function _wsBookmarkFromPane(pane) {
  if (!pane) return;
  var cwd = pane.cwd || pane.wantCwd || '';
  var cmd = pane.cmd || pane.enteredCmd || pane.detectedCmd || '';
  if (!cwd && !cmd) { showToast('Nothing to bookmark yet — open a folder or run an agent first'); return; }
  var suggested = _wsProjectBasename(cwd) || _wsBmAgentWord(cmd) || 'bookmark';
  codbashPrompt('Bookmark name:', suggested).then(function (name) {
    if (name == null) return;
    name = String(name).trim() || suggested;
    _wsBookmarks.push({ id: 'bm' + (++_wsPaneSeq), label: name, cwd: cwd, cmd: cmd, color: _wsBmNextColor() });
    _wsSaveBookmarks();
    _wsRenderBookmarks();
    showToast('Bookmarked "' + name + '"');
  });
}

// Pane-bar star button → bookmark this pane.
function bookmarkPane(paneId) { _wsBookmarkFromPane(_wsFindPane(paneId)); }

// Bar "+" → bookmark the focused pane (fallback: first pane of active tab).
function addBookmarkFromFocused() {
  var pane = (_wsFocusedPaneId && _wsFindPane(_wsFocusedPaneId));
  if (!pane) { var t = _wsActiveTab(); pane = t && t.panes[0]; }
  _wsBookmarkFromPane(pane);
}

function removeBookmark(id) {
  _wsBookmarks = _wsBookmarks.filter(function (x) { return x.id !== id; });
  _wsSaveBookmarks();
  _wsRenderBookmarks();
  _wsRefreshBmMenu();
}

function renameBookmark(id) {
  var b = _wsBookmarks.find(function (x) { return x.id === id; });
  if (!b) return;
  codbashPrompt('Rename bookmark:', b.label || '').then(function (name) {
    if (name == null) return;
    b.label = String(name).trim() || b.label;
    _wsSaveBookmarks();
    _wsRenderBookmarks();
    _wsRefreshBmMenu();
  });
}

// ── Bookmark folders (named groups) ──────────────────────────────────────────
function createBmFolder() {
  codbashPrompt('New bookmark group name:', 'Group ' + (_wsBmFolders.length + 1)).then(function (name) {
    if (name == null) return;
    name = String(name).trim();
    if (!name) return;
    var color = _WS_BM_COLORS[_wsBmFolders.length % _WS_BM_COLORS.length];
    _wsBmFolders.push({ id: 'bf' + (++_wsPaneSeq), name: name, color: color });
    _wsSaveBookmarks();
    _wsRenderBookmarks();
    showToast('Created group "' + name + '"');
  });
}
function renameBmFolder(id) {
  var f = _wsBmFolder(id);
  if (!f) return;
  codbashPrompt('Rename group:', f.name || '').then(function (name) {
    if (name == null) return;
    f.name = String(name).trim() || f.name;
    _wsSaveBookmarks();
    _wsRenderBookmarks();
  });
}
// Delete a group. Its bookmarks are kept (moved back out to loose) — deleting a
// group should never silently drop the bookmarks inside it.
function deleteBmFolder(id) {
  var f = _wsBmFolder(id);
  if (!f) return;
  var n = _wsBookmarks.filter(function (b) { return b.folderId === id; }).length;
  if (!confirm('Delete group "' + f.name + '"?' + (n ? ' Its ' + n + ' bookmark' + (n === 1 ? '' : 's') + ' will move out, not be deleted.' : ''))) return;
  _wsBookmarks.forEach(function (b) { if (b.folderId === id) b.folderId = null; });
  _wsBmFolders = _wsBmFolders.filter(function (x) { return x.id !== id; });
  _wsSaveBookmarks();
  _wsCloseBmMenu();
  _wsRenderBookmarks();
}
function moveBookmarkToFolder(bmId, folderId) {
  var b = _wsBookmarks.find(function (x) { return x.id === bmId; });
  if (!b) return;
  b.folderId = folderId || null;
  _wsSaveBookmarks();
  _wsRenderBookmarks();
  _wsRefreshBmMenu();
}

// Drag a bookmark chip onto a folder to file it there.
var _wsDragBmId = null;
function wsBmDragStart(e, id) { _wsDragBmId = id; try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); } catch (_e) {} }
function wsBmDragEnd(e) {
  _wsDragBmId = null;
  var bar = document.getElementById('wsBookmarks');
  if (bar) Array.prototype.slice.call(bar.querySelectorAll('.drop-target')).forEach(function (x) { x.classList.remove('drop-target'); });
}
function wsBmDragOverFolder(e, fid) {
  if (!_wsDragBmId) return;
  e.preventDefault();
  try { e.dataTransfer.dropEffect = 'move'; } catch (_e) {}
  if (e.currentTarget) e.currentTarget.classList.add('drop-target');
}
function wsBmDragLeaveFolder(e) { if (e.currentTarget) e.currentTarget.classList.remove('drop-target'); }
function wsBmDropOnFolder(e, fid) {
  e.preventDefault();
  if (e.currentTarget) e.currentTarget.classList.remove('drop-target');
  if (_wsDragBmId) { moveBookmarkToFolder(_wsDragBmId, fid); _wsDragBmId = null; }
}

// Folder dropdown menu (contents of a group).
function _wsCloseBmMenu() {
  var m = document.getElementById('wsBmMenu');
  if (m) m.remove();
}
function _wsBmMenuHtml(f) {
  var items = _wsBookmarks.filter(function (b) { return b.folderId === f.id; });
  var rows = items.length ? items.map(function (b) {
    var sub = b.cmd ? _wsBmAgentWord(b.cmd) : (_wsShortCwd(b.cwd) || 'shell');
    var id = escHtml(b.id);
    return '' +
      '<div class="ws-bmf-item" draggable="true" ondragstart="wsBmDragStart(event,\'' + id + '\')" ondragend="wsBmDragEnd(event)" onclick="openBookmark(\'' + id + '\')">' +
        '<span class="ws-bm-dot" style="background:' + escHtml(b.color || '#3b82f6') + '"></span>' +
        '<span class="ws-bmf-label">' + escHtml(b.label || _wsProjectBasename(b.cwd) || 'shell') + '</span>' +
        '<span class="ws-bmf-sub">' + escHtml(sub) + '</span>' +
        '<span class="ws-bmf-out" title="Move out of group" onclick="event.stopPropagation();moveBookmarkToFolder(\'' + id + '\',\'\')">↤</span>' +
        '<span class="ws-bmf-x" title="Remove bookmark" onclick="event.stopPropagation();removeBookmark(\'' + id + '\')">&times;</span>' +
      '</div>';
  }).join('') : '<div class="ws-bmf-empty">Empty — drag bookmarks here</div>';
  return '<div class="ws-bmf-list">' + rows + '</div>' +
    '<div class="ws-bmf-foot">' +
      '<button onclick="renameBmFolder(\'' + escHtml(f.id) + '\')">Rename</button>' +
      '<button class="danger" onclick="deleteBmFolder(\'' + escHtml(f.id) + '\')">Delete group</button>' +
    '</div>';
}
function _wsRefreshBmMenu() {
  var m = document.getElementById('wsBmMenu');
  if (!m) return;
  var fid = m.getAttribute('data-folder-id');
  var f = _wsBmFolder(fid);
  if (!f) { m.remove(); return; }
  m.innerHTML = _wsBmMenuHtml(f);
}
function toggleBookmarkFolder(ev, fid) {
  if (ev) ev.stopPropagation();
  var existing = document.getElementById('wsBmMenu');
  if (existing && existing.getAttribute('data-folder-id') === fid) { existing.remove(); return; }
  if (existing) existing.remove();
  var f = _wsBmFolder(fid);
  if (!f) return;
  var m = document.createElement('div');
  m.id = 'wsBmMenu';
  m.className = 'ws-bmf-menu';
  m.setAttribute('data-folder-id', fid);
  m.innerHTML = _wsBmMenuHtml(f);
  document.body.appendChild(m);
  var chip = ev && ev.currentTarget;
  if (chip && chip.getBoundingClientRect) {
    var r = chip.getBoundingClientRect();
    m.style.top = (r.bottom + 6) + 'px';
    m.style.left = Math.min(r.left, window.innerWidth - 280) + 'px';
  }
  setTimeout(function () {
    function off(e) { if (m.contains(e.target)) return; if (e.target.closest && e.target.closest('.ws-bm-folder')) return; m.remove(); document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); }
    function esc(e) { if (e.key === 'Escape') { m.remove(); document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); } }
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', esc);
  }, 0);
}

// ── Terminal settings (font / theme / cursor) ────────────────────────────────
// Persisted appearance prefs applied live to every xterm instance. Themes are
// xterm theme objects; the "dark" default matches the app chrome.
var _WS_TERM_PREFS_KEY = 'codbash-term-prefs';
var _WS_TERM_FONTS = [
  { v: 'Menlo, Monaco, "Courier New", monospace', label: 'Menlo' },
  { v: '"JetBrains Mono", Menlo, monospace', label: 'JetBrains Mono' },
  { v: '"Fira Code", Menlo, monospace', label: 'Fira Code' },
  { v: '"SF Mono", Menlo, monospace', label: 'SF Mono' },
  { v: '"Cascadia Code", Menlo, monospace', label: 'Cascadia Code' },
  { v: '"Source Code Pro", Menlo, monospace', label: 'Source Code Pro' },
];
var _WS_TERM_THEMES = {
  // iTerm-like soft charcoal (Tomorrow Night palette) — the default. A warm dark
  // grey instead of near-black, with a full ANSI palette so agent output (Claude
  // Code's colors, diffs, spinners) looks like it does in iTerm2.
  iterm: {
    background: '#1d1f21', foreground: '#c5c8c6', cursor: '#c5c8c6', cursorAccent: '#1d1f21',
    selectionBackground: '#373b41',
    black: '#1d1f21', red: '#cc6666', green: '#b5bd68', yellow: '#f0c674',
    blue: '#81a2be', magenta: '#b294bb', cyan: '#8abeb7', white: '#c5c8c6',
    brightBlack: '#666666', brightRed: '#d54e53', brightGreen: '#b9ca4a', brightYellow: '#e7c547',
    brightBlue: '#7aa6da', brightMagenta: '#c397d8', brightCyan: '#70c0b1', brightWhite: '#eaeaea',
  },
  dark:      { background: '#08090c', foreground: '#e6e6e6', cursor: '#e6e6e6', selectionBackground: '#264f78' },
  midnight:  { background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff', selectionBackground: '#1f6feb55' },
  monokai:   { background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', selectionBackground: '#49483e' },
  dracula:   { background: '#282a36', foreground: '#f8f8f2', cursor: '#bd93f9', selectionBackground: '#44475a' },
  solarized: { background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', selectionBackground: '#073642' },
  light:     { background: '#ffffff', foreground: '#1f2328', cursor: '#1f2328', selectionBackground: '#add6ff' },
};
var _WS_TERM_THEME_LABELS = { iterm: 'iTerm', dark: 'Dark', midnight: 'Midnight', monokai: 'Monokai', dracula: 'Dracula', solarized: 'Solarized', light: 'Light' };
var _wsTermPrefs = { fontFamily: _WS_TERM_FONTS[0].v, fontSize: 13, theme: 'iterm', cursorStyle: 'block', cursorBlink: true };

function _wsLoadTermPrefs() {
  try {
    var p = JSON.parse(localStorage.getItem(_WS_TERM_PREFS_KEY));
    if (p && typeof p === 'object') Object.assign(_wsTermPrefs, p);
  } catch (e) {}
  if (!_WS_TERM_THEMES[_wsTermPrefs.theme]) _wsTermPrefs.theme = 'iterm';
}
function _wsSaveTermPrefs() { try { localStorage.setItem(_WS_TERM_PREFS_KEY, JSON.stringify(_wsTermPrefs)); } catch (e) {} }
function _wsTermTheme() { return _WS_TERM_THEMES[_wsTermPrefs.theme] || _WS_TERM_THEMES.iterm; }

// Match the pane frame (the padding around xterm's canvas, and the container
// behind it) to the terminal theme's background so there's no dark seam around
// a lighter theme.
function _wsApplyPaneBg(pane) {
  var host = document.getElementById('wsTermHost-' + pane.id);
  if (!host) return;
  var bg = _wsTermTheme().background;
  host.style.background = bg;
  var pel = host.closest ? host.closest('.ws-pane') : null;
  if (pel) pel.style.background = bg;
}

// Push current prefs onto one pane's terminal, then re-fit (font size changes
// the cell grid, so the pty must be resized to match).
function _wsApplyTermPrefsToPane(pane) {
  if (!pane || !pane.term) return;
  var t = pane.term, p = _wsTermPrefs;
  try {
    t.options.fontFamily = p.fontFamily;
    t.options.fontSize = p.fontSize;
    t.options.theme = _wsTermTheme();
    t.options.cursorStyle = p.cursorStyle;
    t.options.cursorBlink = p.cursorBlink;
  } catch (e) {}
  _wsApplyPaneBg(pane);
  if (pane.fit) { try { pane.fit.fit(); } catch (e) {} }
  if (pane.sock && pane.sock.readyState === 1 && t) {
    pane.sock.send(JSON.stringify({ t: 'resize', cols: t.cols, rows: t.rows }));
  }
}
function _wsApplyTermPrefsAll() { _wsAllPanes().forEach(function (x) { _wsApplyTermPrefsToPane(x.pane); }); }

// Change one setting → persist → apply to every open terminal immediately.
function setTermPref(key, value) {
  if (key === 'fontSize') value = Math.max(9, Math.min(24, parseInt(value, 10) || 13));
  if (key === 'cursorBlink') value = !!value;
  _wsTermPrefs[key] = value;
  _wsSaveTermPrefs();
  _wsApplyTermPrefsAll();
  var fs = document.getElementById('wsSetFontSizeVal');
  if (fs && key === 'fontSize') fs.textContent = value + 'px';
}

// Build (once) and toggle the settings popover anchored under the gear button.
function toggleTerminalSettings(ev) {
  if (ev) ev.stopPropagation();
  var pop = document.getElementById('wsSettingsPop');
  if (pop) { pop.remove(); return; }   // toggle off
  pop = document.createElement('div');
  pop.id = 'wsSettingsPop';
  pop.className = 'ws-settings-pop';
  var fontOpts = _WS_TERM_FONTS.map(function (f) {
    return '<option value="' + escHtml(f.v) + '"' + (f.v === _wsTermPrefs.fontFamily ? ' selected' : '') + '>' + escHtml(f.label) + '</option>';
  }).join('');
  var themeOpts = Object.keys(_WS_TERM_THEMES).map(function (k) {
    return '<option value="' + k + '"' + (k === _wsTermPrefs.theme ? ' selected' : '') + '>' + escHtml(_WS_TERM_THEME_LABELS[k] || k) + '</option>';
  }).join('');
  var cursorOpts = ['block', 'bar', 'underline'].map(function (c) {
    return '<option value="' + c + '"' + (c === _wsTermPrefs.cursorStyle ? ' selected' : '') + '>' + c.charAt(0).toUpperCase() + c.slice(1) + '</option>';
  }).join('');
  pop.innerHTML =
    '<div class="ws-set-head">Terminal settings</div>' +
    '<label class="ws-set-row"><span>Font</span>' +
      '<select onchange="setTermPref(\'fontFamily\', this.value)">' + fontOpts + '</select></label>' +
    '<label class="ws-set-row"><span>Size</span>' +
      '<span class="ws-set-size">' +
        '<button onclick="setTermPref(\'fontSize\', _wsTermPrefs.fontSize-1)">&minus;</button>' +
        '<b id="wsSetFontSizeVal">' + _wsTermPrefs.fontSize + 'px</b>' +
        '<button onclick="setTermPref(\'fontSize\', _wsTermPrefs.fontSize+1)">+</button>' +
      '</span></label>' +
    '<label class="ws-set-row"><span>Theme</span>' +
      '<select onchange="setTermPref(\'theme\', this.value)">' + themeOpts + '</select></label>' +
    '<label class="ws-set-row"><span>Cursor</span>' +
      '<select onchange="setTermPref(\'cursorStyle\', this.value)">' + cursorOpts + '</select></label>' +
    '<label class="ws-set-row"><span>Blink</span>' +
      '<input type="checkbox"' + (_wsTermPrefs.cursorBlink ? ' checked' : '') + ' onchange="setTermPref(\'cursorBlink\', this.checked)"></label>';
  document.body.appendChild(pop);
  // Anchor under the gear button.
  var gear = ev && ev.currentTarget;
  if (gear && gear.getBoundingClientRect) {
    var r = gear.getBoundingClientRect();
    pop.style.top = (r.bottom + 6) + 'px';
    pop.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  }
  // Dismiss on outside click / Escape.
  setTimeout(function () {
    function off(e) {
      if (pop.contains(e.target)) return;
      pop.remove();
      document.removeEventListener('mousedown', off);
      document.removeEventListener('keydown', esc);
    }
    function esc(e) { if (e.key === 'Escape') { pop.remove(); document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); } }
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', esc);
  }, 0);
}

function _wsTabMarkup(tab) {
  var id = escHtml(tab.id);
  return '' +
    '<div class="ws-tab' + (tab.id === _wsActiveTabId ? ' active' : '') + '" data-tab-id="' + id + '" ' +
      'draggable="true" ' +
      'ondragstart="wsTabDragStart(event,\'' + id + '\')" ondragover="wsTabDragOver(event,\'' + id + '\')" ' +
      'ondragleave="wsTabDragLeave(event,\'' + id + '\')" ondrop="wsTabDrop(event,\'' + id + '\')" ondragend="wsTabDragEnd(event)" ' +
      'onclick="activateWorkspaceTab(\'' + id + '\')" ondblclick="renameWorkspaceTab(\'' + id + '\')" ' +
      'title="Drag to reorder · double-click to rename">' +
      '<span class="ws-tab-name">' + escHtml(tab.name) + '</span>' +
      '<button class="ws-tab-rename-btn" title="Rename terminal" aria-label="Rename terminal" onclick="event.stopPropagation();renameWorkspaceTab(\'' + id + '\')">&#9998;</button>' +
      '<button class="ws-tab-close" title="Close tab" onclick="event.stopPropagation();closeWorkspaceTab(\'' + id + '\')">&times;</button>' +
    '</div>';
}

// ── Tab reordering (drag to sort, Chrome-like) ───────────────────────────────
var _wsDragTabId = null;
function wsTabDragStart(e, id) {
  _wsDragTabId = id;
  try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); } catch (_e) {}
  var el = e.currentTarget; if (el && el.classList) el.classList.add('dragging');
}
function wsTabDragOver(e, id) {
  if (!_wsDragTabId || _wsDragTabId === id) return;
  e.preventDefault();
  try { e.dataTransfer.dropEffect = 'move'; } catch (_e) {}
  // Show an insertion cue on the side the cursor is nearest.
  var el = e.currentTarget; if (!el) return;
  var r = el.getBoundingClientRect();
  var before = (e.clientX - r.left) < r.width / 2;
  el.classList.toggle('drop-before', before);
  el.classList.toggle('drop-after', !before);
}
function wsTabDragLeave(e, id) {
  var el = e.currentTarget; if (el) el.classList.remove('drop-before', 'drop-after');
}
function wsTabDrop(e, id) {
  e.preventDefault();
  var el = e.currentTarget;
  var before = el && el.classList.contains('drop-before');
  if (el) el.classList.remove('drop-before', 'drop-after');
  if (_wsDragTabId && _wsDragTabId !== id) _wsMoveTab(_wsDragTabId, id, before);
  _wsDragTabId = null;
}
function wsTabDragEnd(e) {
  _wsDragTabId = null;
  var bar = document.getElementById('wsTabbar');
  if (bar) Array.prototype.slice.call(bar.querySelectorAll('.ws-tab')).forEach(function (t) {
    t.classList.remove('dragging', 'drop-before', 'drop-after');
  });
}
// Move tab `fromId` to sit before/after `toId`. Panes are keyed by tab id and
// reconciled on render, so live terminals survive the reorder untouched.
function _wsMoveTab(fromId, toId, before) {
  var from = _wsTabs.findIndex(function (t) { return t.id === fromId; });
  var to = _wsTabs.findIndex(function (t) { return t.id === toId; });
  if (from < 0 || to < 0) return;
  var moved = _wsTabs.splice(from, 1)[0];
  // Recompute target index after removal, then insert before/after it.
  to = _wsTabs.findIndex(function (t) { return t.id === toId; });
  _wsTabs.splice(before ? to : to + 1, 0, moved);
  _wsRenderTabbar();
  _wsSaveSession();
}

// ── tab bar + active-tab rendering ──────────────────────────────────────────
function _wsRenderTabbar() {
  var bar = document.getElementById('wsTabbar');
  if (!bar) return;
  bar.innerHTML = _wsTabs.map(_wsTabMarkup).join('') +
    '<button class="ws-tab-add" title="New tab" onclick="addWorkspaceTab()">+</button>';
}

function _wsRefitTab(tab) {
  if (!tab) return;
  tab.panes.forEach(function (p) {
    if (p.fit) { try { p.fit.fit(); } catch (e) {} }
    if (p.sock && p.sock.readyState === 1 && p.term) {
      p.sock.send(JSON.stringify({ t: 'resize', cols: p.term.cols, rows: p.term.rows }));
    }
  });
  _wsLayoutResizers(tab);   // keep drag handles aligned with the gaps
}

// Ensure every tab has a grid div; reconcile the active tab's panes; show only
// the active grid. Live panes are never rebuilt — only new panes get connected.
function _wsRenderPanes() {
  var area = document.getElementById('wsTabPanes');
  if (!area) return;

  // Remove grids for tabs that no longer exist.
  var tabIds = {};
  _wsTabs.forEach(function (t) { tabIds[t.id] = true; });
  Array.prototype.slice.call(area.querySelectorAll('.workspace-grid')).forEach(function (g) {
    if (!tabIds[g.getAttribute('data-tab-id')]) g.remove();
  });

  _wsTabs.forEach(function (tab) {
    var grid = area.querySelector('.workspace-grid[data-tab-id="' + tab.id + '"]');
    if (!grid) {
      area.insertAdjacentHTML('beforeend', '<div class="workspace-grid" data-tab-id="' + tab.id + '"></div>');
      grid = area.querySelector('.workspace-grid[data-tab-id="' + tab.id + '"]');
    }
    var active = tab.id === _wsActiveTabId;
    grid.classList.toggle('active', active);
    grid.setAttribute('data-count', String(tab.panes.length));

    // Reconcile panes within this tab's grid.
    var present = {};
    tab.panes.forEach(function (p) { present[p.id] = true; });
    Array.prototype.slice.call(grid.querySelectorAll('.ws-pane')).forEach(function (el) {
      if (!present[el.getAttribute('data-pane-id')]) el.remove();
    });
    tab.panes.forEach(function (p) {
      if (!grid.querySelector('.ws-pane[data-pane-id="' + p.id + '"]')) {
        grid.insertAdjacentHTML('beforeend', _wsPaneMarkup(p));
        _wsConnectPane(p);
      }
    });
    _wsApplyGrid(tab);   // honor any custom column/row fractions
  });

  // Refit the active tab shortly after it becomes visible (0-size while hidden),
  // then place the drag handles over the (now laid-out) pane gaps.
  setTimeout(function () { var at = _wsActiveTab(); _wsRefitTab(at); _wsLayoutResizers(at); }, 60);

  // Ensure a focused pane is always highlighted within the active tab.
  var at = _wsActiveTab();
  if (at && at.panes.length) {
    var focusedInTab = _wsFocusedPaneId && at.panes.some(function (p) { return p.id === _wsFocusedPaneId; });
    _wsSetFocusedPane(focusedInTab ? _wsFocusedPaneId : at.panes[0].id);
  }
}

// ── Draggable pane splitters (resize by dragging the divider) ────────────────
// Each tab stores column/row fractions; a drag adjusts the two tracks either
// side of the divider, keeping their sum constant. Handles are absolutely
// positioned over the gaps (the grid itself stays pure panes). Fractions
// persist with the session so a restored layout keeps your sizes.
var _WS_MIN_PANE_PX = 140;

function _wsGridEl(tab) {
  var area = document.getElementById('wsTabPanes');
  return area ? area.querySelector('.workspace-grid[data-tab-id="' + tab.id + '"]') : null;
}
function _wsColRowCounts(n) { return n === 4 ? { cols: 2, rows: 2 } : { cols: n, rows: 1 }; }
function _wsEqualFr(k) { var a = []; for (var i = 0; i < k; i++) a.push(1); return a; }

// Make sure tab.cols/tab.rows exist and match the current pane count.
function _wsEnsureSplit(tab) {
  var c = _wsColRowCounts(tab.panes.length);
  if (!Array.isArray(tab.cols) || tab.cols.length !== c.cols) tab.cols = _wsEqualFr(c.cols);
  if (!Array.isArray(tab.rows) || tab.rows.length !== c.rows) tab.rows = _wsEqualFr(c.rows);
}

function _wsApplyGrid(tab) {
  var grid = _wsGridEl(tab);
  if (!grid) return;
  var n = tab.panes.length;
  if (n <= 1) { grid.style.gridTemplateColumns = ''; grid.style.gridTemplateRows = ''; return; }
  _wsEnsureSplit(tab);
  var fr = function (a) { return a.map(function (x) { return x.toFixed(4) + 'fr'; }).join(' '); };
  grid.style.gridTemplateColumns = fr(tab.cols);
  grid.style.gridTemplateRows = (tab.rows.length > 1) ? fr(tab.rows) : '';
}

var _wsRefitRaf = 0;
function _wsThrottleRefit(tab) {
  if (_wsRefitRaf) return;
  _wsRefitRaf = requestAnimationFrame(function () {
    _wsRefitRaf = 0;
    tab.panes.forEach(function (p) { if (p.fit) { try { p.fit.fit(); } catch (e) {} } });
  });
}

// Rebuild the drag handles for a tab's grid from live pane rects.
function _wsLayoutResizers(tab) {
  if (!tab || tab.id !== _wsActiveTabId) return;
  var grid = _wsGridEl(tab);
  if (!grid) return;
  Array.prototype.slice.call(grid.querySelectorAll('.ws-resizer')).forEach(function (e) { e.remove(); });
  var n = tab.panes.length;
  if (n < 2) return;
  _wsEnsureSplit(tab);
  var gr = grid.getBoundingClientRect();
  var els = tab.panes.map(function (p) { return grid.querySelector('.ws-pane[data-pane-id="' + p.id + '"]'); });
  if (els.some(function (e) { return !e; })) return;
  var rects = els.map(function (e) { return e.getBoundingClientRect(); });
  var ncols = _wsColRowCounts(n).cols;

  // Vertical dividers between adjacent columns (top-row panes give the x-span).
  for (var j = 0; j < ncols - 1; j++) {
    var x = ((rects[j].right + rects[j + 1].left) / 2) - gr.left;
    _wsMakeResizer(grid, tab, 'v', x, gr, j);
  }
  // Horizontal divider between the two rows (count 4 only).
  if (n === 4) {
    var y = ((rects[0].bottom + rects[2].top) / 2) - gr.top;
    _wsMakeResizer(grid, tab, 'h', y, gr, 0);
  }
}

function _wsMakeResizer(grid, tab, dir, pos, gr, idx) {
  var h = document.createElement('div');
  h.className = 'ws-resizer ws-resizer-' + dir;
  if (dir === 'v') { h.style.left = pos + 'px'; }
  else { h.style.top = pos + 'px'; }
  grid.appendChild(h);
  h.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    var els = tab.panes.map(function (p) { return grid.querySelector('.ws-pane[data-pane-id="' + p.id + '"]'); });
    var gr2 = grid.getBoundingClientRect();
    var arr = (dir === 'v') ? tab.cols : tab.rows;
    var a = idx, b = idx + 1;
    var sum = arr[a] + arr[b];
    // Pixel span of the two tracks being resized.
    var startPx, endPx;
    if (dir === 'v') {
      startPx = els[a].getBoundingClientRect().left;
      endPx = els[b].getBoundingClientRect().right;   // adjacent top-row panes (works for 2/3/4)
    } else {
      startPx = els[0].getBoundingClientRect().top;      // top row
      endPx = els[2].getBoundingClientRect().bottom;     // bottom row (count 4)
    }
    var S = endPx - startPx;
    if (S < 2 * _WS_MIN_PANE_PX) return;
    h.classList.add('dragging');
    try { h.setPointerCapture(e.pointerId); } catch (_e) {}
    function move(ev) {
      var p = (dir === 'v') ? ev.clientX : ev.clientY;
      var rel = Math.min(S - _WS_MIN_PANE_PX, Math.max(_WS_MIN_PANE_PX, p - startPx));
      arr[a] = sum * (rel / S);
      arr[b] = sum - arr[a];
      _wsApplyGrid(tab);
      if (dir === 'v') h.style.left = (p - gr2.left) + 'px';
      else h.style.top = (p - gr2.top) + 'px';
      _wsThrottleRefit(tab);
    }
    function up(ev) {
      h.classList.remove('dragging');
      try { h.releasePointerCapture(e.pointerId); } catch (_e) {}
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      _wsRefitTab(tab);
      _wsLayoutResizers(tab);
      _wsSaveSession();
    }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
}

function _wsSyncLayoutButtons() {
  var tab = _wsActiveTab();
  var n = tab ? tab.panes.length : 0;
  ['1', '2', '3', '4'].forEach(function (k) {
    var b = document.getElementById('wsLayout-' + k);
    if (b) b.classList.toggle('active', n === Number(k));
  });
  var add = document.getElementById('wsAddPane');
  if (add) add.disabled = n >= MAX_WS_PANES;
}

function _wsRenderAll() { _wsRenderTabbar(); _wsRenderPanes(); _wsSyncLayoutButtons(); }

// ── tab ops ─────────────────────────────────────────────────────────────────
function addWorkspaceTab() {
  var tab = { id: 't' + (++_wsTabSeq), name: 'Tab ' + (_wsTabs.length + 1), panes: [{ id: 'p' + (++_wsPaneSeq), cmd: null }] };
  _wsTabs.push(tab);
  _wsActiveTabId = tab.id;
  _wsRenderAll();
}

// ── Open a project / resume a session into the terminal ──────────────────────
// A "spec" describes a tab to open: { name?, cwd?, panes?:[{cwd,cmd,prefill}] }.
// If panes is omitted, a single pane is created from the top-level cwd/cmd/prefill.
function _wsProjectBasename(p) {
  if (!p) return '';
  return String(p).replace(/[\/\\]+$/, '').split(/[\/\\]/).pop() || String(p);
}

// Give a terminal a meaningful name automatically: when a pane connects and
// reports its cwd, name its tab after the folder (basename) — unless the user
// renamed it, or it already has a non-default name (e.g. a project tab).
function _wsAutoNameTab(pane) {
  if (!pane || !pane.cwd) return;
  var tab = null;
  for (var i = 0; i < _wsTabs.length; i++) {
    if (_wsTabs[i].panes.some(function (p) { return p.id === pane.id; })) { tab = _wsTabs[i]; break; }
  }
  if (!tab || tab.userNamed) return;
  if (!/^Tab \d+$/.test(tab.name)) return;   // already meaningful — leave it
  // Skip the home directory — "username" is a poor terminal name; keep "Tab N".
  if (/^(\/Users\/[^/]+|\/home\/[^/]+|\/root)\/?$/.test(pane.cwd)) return;
  var base = _wsProjectBasename(pane.cwd);
  if (base && base !== tab.name) { tab.name = base; _wsRenderTabbar(); }
}
function _wsTabName(spec) {
  return spec.name || _wsProjectBasename(spec.cwd) || ('Tab ' + (_wsTabs.length + 1));
}
function _wsBuildPanes(spec) {
  var list = (spec.panes && spec.panes.length) ? spec.panes
    : [{ cwd: spec.cwd, cmd: spec.cmd, prefill: spec.prefill }];
  list = list.slice(0, MAX_WS_PANES);
  return list.map(function (pc) {
    return { id: 'p' + (++_wsPaneSeq), cmd: pc.cmd || null, prefill: pc.prefill || null, wantCwd: pc.cwd || null };
  });
}

// Open a spec in the Workspace. If the terminal is already mounted, append a new
// tab; otherwise stash it and let renderWorkspace seed it as the first tab.
function openInWorkspace(spec) {
  if (_wsRoot) {
    var tab = { id: 't' + (++_wsTabSeq), name: _wsTabName(spec), panes: _wsBuildPanes(spec) };
    _wsTabs.push(tab);
    _wsActiveTabId = tab.id;
    _wsRenderAll();
  } else {
    _wsPendingOpen = spec;
  }
  if (typeof setView === 'function') setView('workspace');
}

// Best-effort per-agent resume command. Prefilled (not auto-run) so the user
// can review/edit before pressing Enter — safe even where syntax varies.
function _wsResumeCommand(tool, id) {
  switch (tool) {
    case 'claude':
    case 'claude-ext': return 'claude --resume ' + id;
    case 'codex': return 'codex resume ' + id;
    case 'opencode': return 'opencode';
    case 'kiro': return 'kiro-cli';
    case 'qwen': return 'qwen';
    case 'gemini': return 'gemini';
    case 'pi': return 'pi';
    default: return '';
  }
}

// Card action: open a pane in the session's project folder with the agent's
// resume command prefilled (awaiting Enter). Used by the session cards.
function openSessionInWorkspace(sessionId) {
  var list = (typeof allSessions !== 'undefined' && allSessions) ? allSessions : [];
  var s = list.find(function (x) { return x.id === sessionId; });
  if (!s) return;
  var cwd = s.git_root || s.project || null;
  var resume = _wsResumeCommand(s.tool, s.id);
  openInWorkspace({ name: _wsProjectBasename(cwd) || s.tool, cwd: cwd, prefill: resume || null });
}

// Projects action: open up to `n` (1-4) panes all cd'd into a project folder.
function spawnProjectTerminals(cwd, n) {
  n = Math.max(1, Math.min(MAX_WS_PANES, parseInt(n, 10) || 1));
  var panes = [];
  for (var i = 0; i < n; i++) panes.push({ cwd: cwd });
  openInWorkspace({ name: _wsProjectBasename(cwd), cwd: cwd, panes: panes });
}

function activateWorkspaceTab(id) {
  if (id === _wsActiveTabId) return;
  _wsActiveTabId = id;
  _wsRenderAll();
  var tab = _wsActiveTab();
  if (tab && tab.panes[0] && tab.panes[0].term) tab.panes[0].term.focus();
}

// Stack of recently-closed tabs, so Cmd/Ctrl+Shift+T can reopen them (Chrome).
var _wsClosedTabs = [];
var _WS_CLOSED_MAX = 12;

function _wsSerializeTab(tab) {
  return {
    name: tab.name,
    cols: Array.isArray(tab.cols) ? tab.cols.slice() : null,
    rows: Array.isArray(tab.rows) ? tab.rows.slice() : null,
    panes: tab.panes.map(function (p) {
      return { cmd: p.cmd || '', prefill: p.prefill || '', cwd: p.cwd || p.wantCwd || '', detectedCmd: p.detectedCmd || '', enteredCmd: p.enteredCmd || '' };
    }),
  };
}

function closeWorkspaceTab(id) {
  var idx = _wsTabs.findIndex(function (t) { return t.id === id; });
  if (idx < 0) return;
  var live = _wsTabs[idx].panes.filter(_wsPaneLive).length;
  if (live > 0 && !confirm('Close this tab and its ' + live + ' running terminal' +
      (live === 1 ? '' : 's') + '?')) return;
  // Remember it for Cmd+Shift+T before tearing it down.
  _wsClosedTabs.push(_wsSerializeTab(_wsTabs[idx]));
  if (_wsClosedTabs.length > _WS_CLOSED_MAX) _wsClosedTabs.shift();
  _wsTabs[idx].panes.forEach(_wsTeardownPane);
  _wsTabs.splice(idx, 1);
  if (_wsTabs.length === 0) { addWorkspaceTab(); return; }
  if (_wsActiveTabId === id) _wsActiveTabId = _wsTabs[Math.max(0, idx - 1)].id;
  _wsRenderAll();
}

// Reopen the most recently closed tab (Cmd/Ctrl+Shift+T). The agent command
// comes back as a restore offer (banner + button), same as session restore —
// no auto-respawn.
function reopenLastClosedTab() {
  if (!_wsClosedTabs.length) return;
  var spec = _wsClosedTabs.pop();
  var panes = (spec.panes && spec.panes.length ? spec.panes : [{}])
    .slice(0, MAX_WS_PANES)
    .map(function (p) {
      var cmd = (p && (p.cmd || p.enteredCmd || p.detectedCmd || p.prefill)) || '';
      return { id: 'p' + (++_wsPaneSeq), cmd: null, prefill: null, restoreCmd: cmd || null, wantCwd: (p && p.cwd) || null };
    });
  var tab = { id: 't' + (++_wsTabSeq), name: spec.name || 'Tab', panes: panes,
              cols: Array.isArray(spec.cols) ? spec.cols.slice() : null, rows: Array.isArray(spec.rows) ? spec.rows.slice() : null };
  _wsTabs.push(tab);
  _wsActiveTabId = tab.id;
  if (typeof setView === 'function' && currentView !== 'workspace') setView('workspace');
  _wsRenderAll();
}

function renameWorkspaceTab(id) {
  var tab = _wsTab(id);
  if (!tab) return;
  var el = document.querySelector('.ws-tab[data-tab-id="' + id + '"] .ws-tab-name');
  if (!el) return;
  var input = document.createElement('input');
  input.className = 'ws-tab-rename-input';
  input.value = tab.name;
  el.replaceWith(input);
  input.focus(); input.select();
  // `done` guards against the blur handler re-firing after we remove the input:
  // both Enter (commit → re-render removes input → blur) and Escape (cancel →
  // re-render removes input → blur) would otherwise commit a second time. Escape
  // must NOT commit at all.
  var done = false;
  function commit() {
    if (done) return;
    done = true;
    var v = input.value.trim();
    if (v) { tab.name = v; tab.userNamed = true; }   // manual name wins over auto-naming
    _wsRenderTabbar();
  }
  function cancel() {
    if (done) return;
    done = true;
    _wsRenderTabbar();
  }
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', commit);
  input.addEventListener('click', function (e) { e.stopPropagation(); });
}

// ── pane ops (operate on the active tab) ────────────────────────────────────
// A pane is "live" if its terminal is connected and hasn't exited — closing it
// would kill whatever is running, so we confirm before destroying live panes.
function _wsPaneLive(p) { return !!(p && p.sock && p.sock.readyState === 1 && !p.exited); }

function setWorkspaceLayout(n) {
  var tab = _wsActiveTab();
  if (!tab) return;
  n = Math.max(1, Math.min(MAX_WS_PANES, n));
  if (n < tab.panes.length) {
    var live = tab.panes.slice(n).filter(_wsPaneLive).length;
    if (live > 0 && !confirm('Switching layout will close ' + live + ' running terminal' +
        (live === 1 ? '' : 's') + ' in this tab. Continue?')) {
      _wsSyncLayoutButtons(); // keep the button selection in sync with reality
      return;
    }
  }
  while (tab.panes.length < n) tab.panes.push({ id: 'p' + (++_wsPaneSeq), cmd: null });
  while (tab.panes.length > n) _wsTeardownPane(tab.panes.pop());
  _wsRenderPanes(); _wsSyncLayoutButtons();
}

function addWorkspacePane(cmd) {
  var tab = _wsActiveTab();
  if (!tab || tab.panes.length >= MAX_WS_PANES) return;
  tab.panes.push({ id: 'p' + (++_wsPaneSeq), cmd: cmd || null });
  _wsRenderPanes(); _wsSyncLayoutButtons();
}

function closeWorkspacePane(id) {
  for (var i = 0; i < _wsTabs.length; i++) {
    var tab = _wsTabs[i];
    var idx = tab.panes.findIndex(function (p) { return p.id === id; });
    if (idx < 0) continue;
    // Closing a pane kills whatever runs in it (a shell, or a live agent), so
    // confirm first when it's live — same guard as closing a whole tab.
    if (_wsPaneLive(tab.panes[idx]) &&
        !confirm('Close this terminal? The running ' + _wsPaneLabel(tab.panes[idx]) + ' session will be terminated.')) return;
    _wsTeardownPane(tab.panes[idx]);
    tab.panes.splice(idx, 1);
    if (tab.panes.length === 0) tab.panes.push({ id: 'p' + (++_wsPaneSeq), cmd: null });
    _wsRenderPanes(); _wsSyncLayoutButtons();
    return;
  }
}

function launchAgentInPane(id, cmd) {
  if (!cmd) return;
  var pane = _wsFindPane(id);
  if (!pane || !pane.sock || pane.sock.readyState !== 1) return;
  // Remember what was launched so "Save layout" captures the running setup.
  pane.cmd = cmd;
  pane.flaggedLimit = false;          // fresh attempt clears any prior limit flag
  pane.lastOutputAt = _wsNow();
  pane.sock.send(new TextEncoder().encode(cmd + '\r'));
  if (pane.term) pane.term.focus();
  var st = document.getElementById('wsStatus-' + pane.id);
  if (st) st.textContent = _wsPaneLabel(pane);   // reflect the launched agent
  _wsUpdateStatusBar();
}

// ── Saved-commands manager (modal) ──────────────────────────────────────────
// The pane a launched command should target: the focused pane if it belongs to
// the active tab, otherwise that tab's first pane.
function _wsActivePaneId() {
  var tab = _wsActiveTab();
  if (!tab || !tab.panes.length) return null;
  if (_wsFocusedPaneId && tab.panes.some(function (p) { return p.id === _wsFocusedPaneId; })) {
    return _wsFocusedPaneId;
  }
  return tab.panes[0].id;
}

function _wsCommandsListHtml() {
  if (!_wsSavedCommands.length) return '<div class="ws-cmd-empty">No saved commands yet.</div>';
  return _wsSavedCommands.map(function (c) {
    return '<div class="ws-cmd-row">' +
      '<div class="ws-cmd-info">' +
        '<div class="ws-cmd-name">' + escHtml(c.name) + '</div>' +
        '<code class="ws-cmd-cmd">' + escHtml(_wsMaskSecrets(c.command)) + '</code>' +
      '</div>' +
      '<div class="ws-cmd-actions">' +
        '<button class="toolbar-btn" title="Run in the focused pane (highlighted)" onclick="runSavedCommand(\'' + escHtml(c.id) + '\')">Run</button>' +
        '<button class="toolbar-btn ws-cmd-del" title="Delete" onclick="deleteWorkspaceCommand(\'' + escHtml(c.id) + '\')">&times;</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function _wsRenderCommandsModalBody() {
  var el = document.getElementById('wsCmdList');
  if (el) el.innerHTML = _wsCommandsListHtml();
}

function openWorkspaceCommands() {
  var existing = document.getElementById('wsCmdModal');
  if (existing) existing.remove();
  var modal = document.createElement('div');
  modal.id = 'wsCmdModal';
  modal.className = 'ws-cmd-modal';
  modal.innerHTML =
    '<div class="ws-cmd-dialog">' +
      '<div class="ws-cmd-head"><span>Saved commands</span>' +
        '<button class="ws-cmd-close" onclick="closeWorkspaceCommands()">&times;</button></div>' +
      '<div class="ws-cmd-note">Stored on your machine at <code>~/.codedash/workspace-commands.json</code> (0600). ' +
        'Fine for proxy launches — the value is typed into the <strong>focused pane</strong> (the one with the blue border).</div>' +
      '<div class="ws-cmd-list" id="wsCmdList">' + _wsCommandsListHtml() + '</div>' +
      '<div class="ws-cmd-form">' +
        '<input id="wsCmdName" class="ws-cmd-input" placeholder="Name (e.g. Claude via proxy)" maxlength="120">' +
        '<input id="wsCmdCommand" class="ws-cmd-input" placeholder="HTTPS_PROXY=\'…\' claude --dangerously-skip-permissions">' +
        '<button class="toolbar-btn ws-cmd-save" onclick="saveWorkspaceCommand()">Save</button>' +
      '</div>' +
      '<div class="ws-cmd-error" id="wsCmdError"></div>' +
    '</div>';
  modal.addEventListener('click', function (e) { if (e.target === modal) closeWorkspaceCommands(); });
  document.body.appendChild(modal);
  var nameEl = document.getElementById('wsCmdName');
  if (nameEl) nameEl.focus();
}

function closeWorkspaceCommands() {
  var m = document.getElementById('wsCmdModal');
  if (m) m.remove();
}

function saveWorkspaceCommand() {
  var name = (document.getElementById('wsCmdName') || {}).value || '';
  var command = (document.getElementById('wsCmdCommand') || {}).value || '';
  var errEl = document.getElementById('wsCmdError');
  if (errEl) errEl.textContent = '';
  fetch('/api/terminal/commands', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, command: command })
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (!d.ok) { if (errEl) errEl.textContent = d.error || 'Could not save'; return; }
    document.getElementById('wsCmdName').value = '';
    document.getElementById('wsCmdCommand').value = '';
    return _wsLoadCommands().then(_wsRenderCommandsModalBody);
  }).catch(function () { if (errEl) errEl.textContent = 'Request failed'; });
}

function deleteWorkspaceCommand(id) {
  fetch('/api/terminal/commands/' + encodeURIComponent(id), { method: 'DELETE' })
    .then(function (r) { return r.json(); })
    .then(function () { return _wsLoadCommands().then(_wsRenderCommandsModalBody); });
}

function runSavedCommand(id) {
  var cmd = _wsSavedCommands.find(function (c) { return c.id === id; });
  var paneId = _wsActivePaneId();
  if (cmd && paneId) { launchAgentInPane(paneId, cmd.command); closeWorkspaceCommands(); }
}

// ── Saved layouts (whole-workspace snapshots) ───────────────────────────────
// A layout = every tab, its panes, and each pane's start command. Saved
// server-side (0600) because a command may embed proxy secrets. Relaunching
// rebuilds the tabs/panes and auto-runs each command on pane connect.

function _wsLoadLayouts() {
  return fetch('/api/terminal/layouts')
    .then(function (r) { return r.json(); })
    .then(function (d) { _wsSavedLayouts = (d && d.layouts) || []; _wsRenderLayoutsMenu(); })
    .catch(function () { _wsSavedLayouts = []; });
}

// Snapshot the current workspace into the { tabs:[{name,panes}] } shape the
// server expects. Each pane records its launched command (cmd), any typed-but-
// not-run command (prefill, e.g. a resume line from a session card) and the
// folder it opened in (cwd) — so restoring the layout reopens every pane in the
// same project and re-issues the same command. A blank pane is stored as cmd:''.
function _wsCaptureLayout() {
  return {
    tabs: _wsTabs.map(function (t) {
      return {
        name: t.name,
        cols: Array.isArray(t.cols) ? t.cols.slice() : null,
        rows: Array.isArray(t.rows) ? t.rows.slice() : null,
        panes: t.panes.map(function (p) {
          return {
            cmd: p.cmd || '',
            prefill: p.prefill || '',
            cwd: p.cwd || p.wantCwd || '',
            detectedCmd: p.detectedCmd || '',
            enteredCmd: p.enteredCmd || '',
          };
        }),
      };
    }),
  };
}

// Rebuild "Launch a saved layout ▾" menu in the toolbar.
function _wsRenderLayoutsMenu() {
  var sel = document.getElementById('wsLayoutsMenu');
  if (!sel) return;
  var html = '<option value="">Layouts ▾</option>';
  if (_wsSavedLayouts.length) {
    _wsSavedLayouts.forEach(function (l) {
      var n = l.tabs ? l.tabs.length : 0;
      html += '<option value="' + escHtml(l.id) + '">' + escHtml(l.name) + '  (' + n + (n === 1 ? ' tab' : ' tabs') + ')</option>';
    });
    html += '<option disabled>──────────</option>';
    html += '<option value="__manage__">Manage…</option>';
  } else {
    html += '<option value="" disabled>No saved layouts</option>';
  }
  sel.innerHTML = html;
}

// Save button: snapshot → ask for a name (default = active tab name) → POST.
function saveWorkspaceLayout() {
  var active = _wsActiveTab();
  var suggested = (active && active.name) || ('Workspace ' + (_wsSavedLayouts.length + 1));
  // codbashPrompt (not window.prompt — the latter is a no-op in the Electron app).
  codbashPrompt('Save this workspace as:', suggested).then(function (name) {
    if (name == null) return;
    name = name.trim();
    if (!name) return;
    var payload = _wsCaptureLayout();
    payload.name = name;
    return fetch('/api/terminal/layouts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) { showToast('Could not save layout: ' + ((d && d.error) || 'error')); return; }
      showToast('Saved layout "' + name + '"');
      return _wsLoadLayouts();
    }).catch(function () { showToast('Could not save layout: request failed'); });
  });
}

// Menu handler: launch a saved layout, or open the manager.
function onWorkspaceLayoutsMenu(value) {
  if (!value) return;
  if (value === '__manage__') { openWorkspaceLayouts(); return; }
  applyWorkspaceLayout(value);
}

// Tear down the current workspace and rebuild it from a saved layout, running
// each pane's start command on connect (via pane.cmd + _wsConnectPane).
function applyWorkspaceLayout(id) {
  var layout = _wsSavedLayouts.find(function (l) { return l.id === id; });
  if (!layout || !layout.tabs || !layout.tabs.length) return;

  _wsTabs.forEach(function (t) { t.panes.forEach(_wsTeardownPane); });
  _wsTabs = layout.tabs.map(function (t, ti) {
    var panes = (t.panes && t.panes.length ? t.panes : [{ cmd: '' }])
      .slice(0, MAX_WS_PANES)
      .map(function (p) {
        return {
          id: 'p' + (++_wsPaneSeq),
          cmd: (p && p.cmd) || null,
          prefill: (p && p.prefill) || null,
          wantCwd: (p && p.cwd) || null,
        };
      });
    return { id: 't' + (++_wsTabSeq), name: t.name || ('Tab ' + (ti + 1)), panes: panes };
  });
  _wsActiveTabId = _wsTabs[0].id;
  _wsRenderAll();
}

// ── Layout manager (modal): rename-free list with delete ────────────────────
function _wsLayoutsListHtml() {
  if (!_wsSavedLayouts.length) return '<div class="ws-cmd-empty">No saved layouts yet.</div>';
  return _wsSavedLayouts.map(function (l) {
    var summary = (l.tabs || []).map(function (t) {
      return escHtml(t.name) + ' (' + (t.panes ? t.panes.length : 0) + ')';
    }).join(' · ');
    return '<div class="ws-cmd-row">' +
      '<div class="ws-cmd-info">' +
        '<div class="ws-cmd-name">' + escHtml(l.name) + '</div>' +
        '<code class="ws-cmd-cmd">' + summary + '</code>' +
      '</div>' +
      '<div class="ws-cmd-actions">' +
        '<button class="toolbar-btn" title="Launch this workspace" onclick="applyWorkspaceLayout(\'' + escHtml(l.id) + '\');closeWorkspaceLayouts();">Launch</button>' +
        '<button class="toolbar-btn ws-cmd-del" title="Delete" onclick="deleteWorkspaceLayout(\'' + escHtml(l.id) + '\')">&times;</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function _wsRenderLayoutsModalBody() {
  var el = document.getElementById('wsLayoutList');
  if (el) el.innerHTML = _wsLayoutsListHtml();
}

function openWorkspaceLayouts() {
  var existing = document.getElementById('wsLayoutModal');
  if (existing) existing.remove();
  var modal = document.createElement('div');
  modal.id = 'wsLayoutModal';
  modal.className = 'ws-cmd-modal';
  modal.innerHTML =
    '<div class="ws-cmd-dialog">' +
      '<div class="ws-cmd-head"><span>Saved workspaces</span>' +
        '<button class="ws-cmd-close" onclick="closeWorkspaceLayouts()">&times;</button></div>' +
      '<div class="ws-cmd-note">A layout stores every tab, its panes, and each pane\'s start command. ' +
        'Stored on your machine at <code>~/.codedash/workspace-layouts.json</code> (0600). ' +
        'Use <strong>Save layout</strong> in the toolbar to capture the current setup.</div>' +
      '<div class="ws-cmd-list" id="wsLayoutList">' + _wsLayoutsListHtml() + '</div>' +
    '</div>';
  modal.addEventListener('click', function (e) { if (e.target === modal) closeWorkspaceLayouts(); });
  document.body.appendChild(modal);
}

function closeWorkspaceLayouts() {
  var m = document.getElementById('wsLayoutModal');
  if (m) m.remove();
}

function deleteWorkspaceLayout(id) {
  fetch('/api/terminal/layouts/' + encodeURIComponent(id), { method: 'DELETE' })
    .then(function (r) { return r.json(); })
    .then(function () { return _wsLoadLayouts().then(_wsRenderLayoutsModalBody); });
}

// ── mount ───────────────────────────────────────────────────────────────────
async function renderWorkspace(container) {
  // If a live workspace already exists, re-attach it instead of rebuilding —
  // this preserves every pane's terminal, WebSocket and pty across view
  // switches (and makes background dashboard refreshes a no-op). The root is
  // moved back from the hidden holder (or left in place if already here).
  if (_wsRoot) {
    if (_wsRoot.parentNode !== container) {
      container.innerHTML = '';
      container.appendChild(_wsRoot);
    }
    setTimeout(function () { _wsRefitTab(_wsActiveTab()); }, 60);
    return;
  }

  container.innerHTML = '<div class="loading">Loading terminal…</div>';

  var status;
  try { status = await (await fetch('/api/terminal/status')).json(); }
  catch (e) { container.innerHTML = '<div class="empty-state">Could not reach the terminal service.</div>'; return; }

  if (!status.available) {
    container.innerHTML =
      '<div class="empty-state" style="max-width:520px;line-height:1.6">' +
      '<strong>Terminal not available</strong><br>' +
      escHtml(status.hint || 'The optional terminal dependency is not installed.') +
      (status.error ? '<br><span style="opacity:0.6;font-size:12px">' + escHtml(status.error) + '</span>' : '') +
      '</div>';
    return;
  }
  _wsToken = status.token;

  container.innerHTML =
    '<div class="workspace-wrap">' +
      // One compact top row: tabs on the left (scrollable), tools on the right —
      // Chrome-like. Merging the old tab bar + toolbar reclaims a whole strip.
      '<div class="ws-topbar">' +
        '<div class="ws-tabbar" id="wsTabbar"></div>' +
        '<div class="ws-tools">' +
          '<div class="ws-layouts" role="group" aria-label="Split layout">' +
            '<button class="toolbar-btn ws-layout-btn" id="wsLayout-1" title="1 pane" aria-label="1 pane" onclick="setWorkspaceLayout(1)">' + _WS_ICON_1 + '</button>' +
            '<button class="toolbar-btn ws-layout-btn" id="wsLayout-2" title="2 panes" aria-label="2 panes" onclick="setWorkspaceLayout(2)">' + _WS_ICON_2 + '</button>' +
            '<button class="toolbar-btn ws-layout-btn" id="wsLayout-3" title="3 panes" aria-label="3 panes" onclick="setWorkspaceLayout(3)">' + _WS_ICON_3 + '</button>' +
            '<button class="toolbar-btn ws-layout-btn" id="wsLayout-4" title="4 panes (2×2)" aria-label="4 panes" onclick="setWorkspaceLayout(4)">' + _WS_ICON_4 + '</button>' +
          '</div>' +
          '<button class="toolbar-btn" id="wsAddPane" title="Add a pane to this tab" onclick="addWorkspacePane(null)">+ Pane</button>' +
          '<span class="ws-tools-sep"></span>' +
          '<button class="toolbar-btn ws-icon-btn" title="Terminal settings — font, theme, cursor" aria-label="Terminal settings" onclick="toggleTerminalSettings(event)">' + _WS_ICON_GEAR + '</button>' +
          '<button class="toolbar-btn" title="Manage saved start commands" onclick="openWorkspaceCommands()">Commands</button>' +
          '<button class="toolbar-btn" title="Save the current tabs, panes and commands as a reusable layout" onclick="saveWorkspaceLayout()">Save</button>' +
          '<select class="ws-pane-launch" id="wsLayoutsMenu" title="Launch a saved workspace layout" ' +
            'onchange="onWorkspaceLayoutsMenu(this.value); this.selectedIndex=0;"><option value="">Layouts ▾</option></select>' +
        '</div>' +
      '</div>' +
      '<div class="ws-bookmarks" id="wsBookmarks"></div>' +
      '<div class="workspace-tabpanes" id="wsTabPanes"></div>' +
    '</div>';

  try { await _loadWorkspaceVendor(); }
  catch (e) { container.innerHTML = '<div class="empty-state">Failed to load terminal assets.</div>'; return; }
  if (!document.getElementById('wsTabPanes')) return; // switched away while loading

  // Remember the root so future view switches detach/re-attach it (never rebuild).
  _wsRoot = container.querySelector('.workspace-wrap');
  // If something asked to open a project/session before the terminal had
  // mounted, seed that tab as the initial one (no throwaway "Tab 1").
  var _restoredSession = _wsLoadSession();
  if (_wsPendingOpen) {
    var spec = _wsPendingOpen; _wsPendingOpen = null;
    _wsTabs = [{ id: 't' + (++_wsTabSeq), name: _wsTabName(spec), panes: _wsBuildPanes(spec) }];
  } else if (_restoredSession) {
    // Reopen last session's tabs/panes (Chrome-like restore).
    _wsRestoreTabsFromSession(_restoredSession);
  } else {
    _wsTabs = [{ id: 't' + (++_wsTabSeq), name: 'Tab 1', panes: [{ id: 'p' + (++_wsPaneSeq), cmd: null }] }];
  }
  _wsActiveTabId = _wsTabs[0].id;
  _wsLoadTermPrefs();
  _wsLoadBookmarks();
  _wsRenderAll();
  _wsRenderBookmarks();
  _wsLoadCommands();
  _wsLoadLayouts();
  _wsStartStatusLoop();
  _wsUpdateStatusBar();
  _wsBindReopenShortcut();
  _wsBindWindowResize();
}

// Reposition split handles + refit terminals whenever the window resizes —
// maximize, enter/exit fullscreen, or a manual drag. The resizers are absolutely
// positioned by pixel offset over the pane gaps, so without this they keep their
// old coordinates after the window changes size and drift off the dividers.
// Bound once; debounced so it fires after the resize (incl. the fullscreen
// animation) settles.
var _wsResizeBound = false;
var _wsResizeTimer = null;
function _wsBindWindowResize() {
  if (_wsResizeBound) return;
  _wsResizeBound = true;
  window.addEventListener('resize', function () {
    clearTimeout(_wsResizeTimer);
    _wsResizeTimer = setTimeout(function () {
      var at = _wsActiveTab();
      if (at) _wsRefitTab(at);   // refits panes AND re-lays the drag handles
    }, 120);
    // A second pass catches the end of macOS's fullscreen animation, where the
    // final size arrives after the last 'resize' event.
    setTimeout(function () { var at = _wsActiveTab(); if (at) _wsLayoutResizers(at); }, 450);
  });
}

// Is focus in a real editable field (a rename box, the command modal…)? Then
// browser-style tab shortcuts must NOT hijack the keystroke. The xterm terminal
// uses a hidden helper textarea — that's the normal terminal case, so we DON'T
// treat it as a form field (Cmd+T/W should still manage tabs while in a term).
function _wsInFormField() {
  var el = document.activeElement;
  if (!el) return false;
  if (el.classList && el.classList.contains('xterm-helper-textarea')) return false;
  var tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// Chrome-like tab keyboard shortcuts, bound once globally:
//   Cmd/Ctrl+T        → new empty tab
//   Cmd/Ctrl+W        → close the current tab (same as the × — confirms if live)
//   Cmd/Ctrl+Shift+T  → reopen the last closed tab, fully (layout + panes)
// The tab shortcuts only act inside the Workspace so they don't steal Cmd+W /
// Cmd+T on other views (there Cmd+W keeps its native "close window" meaning).
var _wsKeysBound = false;
function _wsBindReopenShortcut() {
  if (_wsKeysBound) return;
  _wsKeysBound = true;
  document.addEventListener('keydown', function (e) {
    var mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    var isT = (e.key === 'T' || e.key === 't' || e.code === 'KeyT');
    var isW = (e.key === 'W' || e.key === 'w' || e.code === 'KeyW');
    var inWs = (typeof currentView === 'undefined') || currentView === 'workspace';

    if (e.shiftKey && isT) {                       // reopen closed tab
      if (_wsInFormField()) return;                // don't hijack while typing in a field
      if (_wsClosedTabs.length) { e.preventDefault(); reopenLastClosedTab(); }
      return;
    }
    if (e.shiftKey) return;
    if (_wsInFormField()) return;
    if (isT && inWs) {                             // new empty tab
      e.preventDefault();
      addWorkspaceTab();
      var nt = _wsActiveTab();
      if (nt && nt.panes[0] && nt.panes[0].term) nt.panes[0].term.focus();
      return;
    }
    if (isW && inWs && _wsActiveTabId) {           // close current tab (like the ×)
      e.preventDefault();
      closeWorkspaceTab(_wsActiveTabId);
      return;
    }
  });
}

// In the desktop app the native menu grabs Cmd+W before the page can, so main
// forwards it here (see desktop/main.js before-input-event). Bound once at load
// so it works on every view. In a plain browser this is inert (no codbashDesktop).
(function _wsBindDesktopShortcuts() {
  if (typeof window === 'undefined' || !window.codbashDesktop || !window.codbashDesktop.onShortcut) return;
  window.codbashDesktop.onShortcut(function (name) {
    if (name !== 'close-tab') return;
    var inWs = (typeof currentView === 'undefined') || currentView === 'workspace';
    if (inWs && typeof _wsActiveTabId !== 'undefined' && _wsActiveTabId) {
      closeWorkspaceTab(_wsActiveTabId);
    } else if (window.codbashDesktop.closeWindow) {
      window.codbashDesktop.closeWindow();   // nothing to close in-page → close window
    }
  });
})();
