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
    sigParts.push(x.tab.id + ':' + x.pane.id + ':' + x.tab.name + ':' + st);
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

function _wsStartStatusLoop() {
  if (_wsStatusTimer) return;
  _wsStatusTimer = setInterval(function () {
    _wsUpdateStatusBar();
    _wsRenderRunningTree();
    // Keep the Overview landing's cards live too.
    if (typeof _ovRefreshIfCurrent === 'function') _ovRefreshIfCurrent();
  }, 1000);
}

// Group live terminals by their project folder (skips the home dir — those
// aren't "projects"). Used by the sidebar running-terminals tree.
function _wsRunningByProject() {
  var groups = {}, order = [];
  _wsAllPanes().forEach(function (x) {
    var p = x.pane;
    if (!p.sock || p.exited || p.sock.readyState !== 1) return;
    var cwd = p.cwd || '';
    if (!cwd || /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)\/?$/.test(cwd)) return;
    var key = _wsProjectBasename(cwd);
    if (!groups[key]) { groups[key] = { name: key, items: [] }; order.push(key); }
    groups[key].items.push(x);
  });
  return order.map(function (k) { return groups[k]; });
}

// Render a compact tree at the bottom of the sidebar: each project folder that
// has running terminals, with its terminals underneath — click to jump.
var _wsRunTreeSig = '';
function _wsRenderRunningTree() {
  var el = document.getElementById('wsRunningTree');
  if (!el) return;
  var groups = _wsRunningByProject();
  var sig = groups.map(function (g) {
    return g.name + ':' + g.items.map(function (x) { return x.pane.id + '=' + _wsPaneLabel(x.pane); }).join(',');
  }).join('|');
  if (sig === _wsRunTreeSig) return;   // no change → no rebuild
  _wsRunTreeSig = sig;

  if (!groups.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  var html = '<div class="ws-run-title">Running in projects</div>';
  groups.forEach(function (g) {
    var first = g.items[0];
    html += '<div class="ws-run-proj" title="' + escHtml(g.name) + '" ' +
      'onclick="jumpToWorkspacePane(\'' + escHtml(first.tab.id) + '\',\'' + escHtml(first.pane.id) + '\')">' +
      '<span class="ws-run-dot"></span><span class="ws-run-name">' + escHtml(g.name) + '</span>' +
      '<span class="ws-run-count">' + g.items.length + '</span></div>';
    g.items.forEach(function (x) {
      html += '<div class="ws-run-term" ' +
        'onclick="jumpToWorkspacePane(\'' + escHtml(x.tab.id) + '\',\'' + escHtml(x.pane.id) + '\')">' +
        escHtml(_wsPaneLabel(x.pane)) + '</div>';
    });
  });
  el.innerHTML = html;
  el.style.display = '';
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

  var term = new Terminal({
    cursorBlink: true, fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: { background: '#08090c' }, scrollback: 5000, allowProposedApi: true
  });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  try { fit.fit(); } catch (e) {}
  pane.term = term; pane.fit = fit;

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
        setStatus(_wsPaneLabel(pane));
        _wsAutoNameTab(pane);
        // cmd auto-runs (trailing \r); prefill is typed but NOT executed so the
        // user can review/edit a resume command before pressing Enter.
        if (pane.cmd) setTimeout(function () { if (sock.readyState === 1) sock.send(enc.encode(pane.cmd + '\r')); }, 120);
        else if (pane.prefill) setTimeout(function () { if (sock.readyState === 1) sock.send(enc.encode(pane.prefill)); if (pane.term) pane.term.focus(); }, 120);
      } else if (msg.t === 'exit') { pane.exited = true; setStatus('exited (' + msg.code + ')'); _wsUpdateStatusBar(); }
      else if (msg.t === 'error') { setStatus('error'); term.write('\r\n\x1b[31m' + (msg.message || 'error') + '\x1b[0m\r\n'); }
      return;
    }
    // Raw output: mark the pane active and scan a bounded tail for account-limit
    // cues so the top status bar can flag it.
    pane.lastOutputAt = _wsNow();
    var text = dec.decode(new Uint8Array(ev.data));
    if (WS_LIMIT_RE.test(text)) pane.flaggedLimit = true;
    term.write(new Uint8Array(ev.data));
  };
  sock.onclose = function () { setStatus('disconnected'); pane.exited = true; _wsUpdateStatusBar(); };
  sock.onerror = function () { setStatus('connection error'); };

  term.onData(function (data) { if (sock.readyState === 1) sock.send(enc.encode(data)); });

  var rt = null;
  pane.ro = new ResizeObserver(function () {
    clearTimeout(rt);
    rt = setTimeout(function () {
      try { fit.fit(); } catch (e) {}
      if (sock.readyState === 1) sock.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
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
        '<button class="ws-pane-close" title="Close pane" onclick="closeWorkspacePane(\'' + escHtml(pane.id) + '\')">&times;</button>' +
      '</div>' +
      '<div class="ws-pane-term" id="wsTermHost-' + escHtml(pane.id) + '"></div>' +
    '</div>';
}

function _wsTabMarkup(tab) {
  return '' +
    '<div class="ws-tab' + (tab.id === _wsActiveTabId ? ' active' : '') + '" data-tab-id="' + escHtml(tab.id) + '" ' +
      'onclick="activateWorkspaceTab(\'' + escHtml(tab.id) + '\')" ondblclick="renameWorkspaceTab(\'' + escHtml(tab.id) + '\')" ' +
      'title="Double-click to rename">' +
      '<span class="ws-tab-name">' + escHtml(tab.name) + '</span>' +
      '<button class="ws-tab-rename-btn" title="Rename terminal" aria-label="Rename terminal" onclick="event.stopPropagation();renameWorkspaceTab(\'' + escHtml(tab.id) + '\')">&#9998;</button>' +
      '<button class="ws-tab-close" title="Close tab" onclick="event.stopPropagation();closeWorkspaceTab(\'' + escHtml(tab.id) + '\')">&times;</button>' +
    '</div>';
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
  });

  // Refit the active tab shortly after it becomes visible (0-size while hidden).
  setTimeout(function () { _wsRefitTab(_wsActiveTab()); }, 60);

  // Ensure a focused pane is always highlighted within the active tab.
  var at = _wsActiveTab();
  if (at && at.panes.length) {
    var focusedInTab = _wsFocusedPaneId && at.panes.some(function (p) { return p.id === _wsFocusedPaneId; });
    _wsSetFocusedPane(focusedInTab ? _wsFocusedPaneId : at.panes[0].id);
  }
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

function closeWorkspaceTab(id) {
  var idx = _wsTabs.findIndex(function (t) { return t.id === id; });
  if (idx < 0) return;
  var live = _wsTabs[idx].panes.filter(_wsPaneLive).length;
  if (live > 0 && !confirm('Close this tab and its ' + live + ' running terminal' +
      (live === 1 ? '' : 's') + '?')) return;
  _wsTabs[idx].panes.forEach(_wsTeardownPane);
  _wsTabs.splice(idx, 1);
  if (_wsTabs.length === 0) { addWorkspaceTab(); return; }
  if (_wsActiveTabId === id) _wsActiveTabId = _wsTabs[Math.max(0, idx - 1)].id;
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
  function commit() {
    var v = input.value.trim();
    if (v) { tab.name = v; tab.userNamed = true; }   // manual name wins over auto-naming
    _wsRenderTabbar();
  }
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { _wsRenderTabbar(); }
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

// Snapshot the current workspace into the { tabs:[{name,panes:[{cmd}]}] } shape
// the server expects. A pane with no launched command is stored as cmd:''.
function _wsCaptureLayout() {
  return {
    tabs: _wsTabs.map(function (t) {
      return {
        name: t.name,
        panes: t.panes.map(function (p) { return { cmd: p.cmd || '' }; }),
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
      .map(function (p) { return { id: 'p' + (++_wsPaneSeq), cmd: (p && p.cmd) || null }; });
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
      '<div class="ws-tabbar" id="wsTabbar"></div>' +
      '<div class="workspace-bar">' +
        '<div class="ws-layouts" role="group" aria-label="Split layout">' +
          '<button class="toolbar-btn ws-layout-btn" id="wsLayout-1" title="1 pane" aria-label="1 pane" onclick="setWorkspaceLayout(1)">' + _WS_ICON_1 + '</button>' +
          '<button class="toolbar-btn ws-layout-btn" id="wsLayout-2" title="2 panes" aria-label="2 panes" onclick="setWorkspaceLayout(2)">' + _WS_ICON_2 + '</button>' +
          '<button class="toolbar-btn ws-layout-btn" id="wsLayout-3" title="3 panes" aria-label="3 panes" onclick="setWorkspaceLayout(3)">' + _WS_ICON_3 + '</button>' +
          '<button class="toolbar-btn ws-layout-btn" id="wsLayout-4" title="4 panes (2×2)" aria-label="4 panes" onclick="setWorkspaceLayout(4)">' + _WS_ICON_4 + '</button>' +
        '</div>' +
        '<button class="toolbar-btn" id="wsAddPane" title="Add a pane to this tab" onclick="addWorkspacePane(null)">+ Pane</button>' +
        '<button class="toolbar-btn" title="Manage saved start commands" onclick="openWorkspaceCommands()">Commands</button>' +
        '<span style="flex:1"></span>' +
        '<button class="toolbar-btn" title="Save the current tabs, panes and commands as a reusable layout" onclick="saveWorkspaceLayout()">Save layout</button>' +
        '<select class="ws-pane-launch" id="wsLayoutsMenu" title="Launch a saved workspace layout" ' +
          'onchange="onWorkspaceLayoutsMenu(this.value); this.selectedIndex=0;"><option value="">Layouts ▾</option></select>' +
      '</div>' +
      '<div class="workspace-tabpanes" id="wsTabPanes"></div>' +
    '</div>';

  try { await _loadWorkspaceVendor(); }
  catch (e) { container.innerHTML = '<div class="empty-state">Failed to load terminal assets.</div>'; return; }
  if (!document.getElementById('wsTabPanes')) return; // switched away while loading

  // Remember the root so future view switches detach/re-attach it (never rebuild).
  _wsRoot = container.querySelector('.workspace-wrap');
  // If something asked to open a project/session before the terminal had
  // mounted, seed that tab as the initial one (no throwaway "Tab 1").
  if (_wsPendingOpen) {
    var spec = _wsPendingOpen; _wsPendingOpen = null;
    _wsTabs = [{ id: 't' + (++_wsTabSeq), name: _wsTabName(spec), panes: _wsBuildPanes(spec) }];
  } else {
    _wsTabs = [{ id: 't' + (++_wsTabSeq), name: 'Tab 1', panes: [{ id: 'p' + (++_wsPaneSeq), cmd: null }] }];
  }
  _wsActiveTabId = _wsTabs[0].id;
  _wsRenderAll();
  _wsLoadCommands();
  _wsLoadLayouts();
  _wsStartStatusLoop();
  _wsUpdateStatusBar();
}
