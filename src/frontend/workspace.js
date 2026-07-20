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
function teardownWorkspaceIfActive() {
  if (!_wsTabs.length) return;
  _wsTabs.forEach(function (t) { t.panes.forEach(_wsTeardownPane); });
  _wsTabs = []; _wsActiveTabId = null;
}

// ── pane connection ─────────────────────────────────────────────────────────
function _wsShortCwd(cwd) {
  if (!cwd) return 'ready';
  return cwd.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
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

  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var url = proto + '//' + location.host + '/ws/terminal' +
    '?token=' + encodeURIComponent(_wsToken) + '&cols=' + term.cols + '&rows=' + term.rows;
  var sock = new WebSocket(url);
  sock.binaryType = 'arraybuffer';
  pane.sock = sock;

  var enc = new TextEncoder();
  function setStatus(txt) { var el = document.getElementById('wsStatus-' + pane.id); if (el) el.textContent = txt; }

  sock.onopen = function () { setStatus('connected'); };
  sock.onmessage = function (ev) {
    if (typeof ev.data === 'string') {
      var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === 'ready') {
        setStatus(_wsShortCwd(msg.cwd));
        if (pane.cmd) setTimeout(function () { if (sock.readyState === 1) sock.send(enc.encode(pane.cmd + '\r')); }, 120);
      } else if (msg.t === 'exit') { setStatus('exited (' + msg.code + ')'); }
      else if (msg.t === 'error') { setStatus('error'); term.write('\r\n\x1b[31m' + (msg.message || 'error') + '\x1b[0m\r\n'); }
      return;
    }
    term.write(new Uint8Array(ev.data));
  };
  sock.onclose = function () { setStatus('disconnected'); };
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
  var opts = '<option value="">Launch ▾</option>';
  WORKSPACE_AGENTS.forEach(function (a) { opts += '<option value="' + escHtml(a.cmd) + '">' + escHtml(a.label) + '</option>'; });
  return '' +
    '<div class="ws-pane" data-pane-id="' + escHtml(pane.id) + '">' +
      '<div class="ws-pane-bar">' +
        '<span class="ws-pane-status" id="wsStatus-' + escHtml(pane.id) + '">connecting…</span>' +
        '<select class="ws-pane-launch" title="Launch an agent in this pane" ' +
          'onchange="launchAgentInPane(\'' + escHtml(pane.id) + '\', this.value); this.selectedIndex=0;">' + opts + '</select>' +
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
  input.className = 'ws-tab-rename';
  input.value = tab.name;
  el.replaceWith(input);
  input.focus(); input.select();
  function commit() {
    var v = input.value.trim();
    if (v) tab.name = v;
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
function setWorkspaceLayout(n) {
  var tab = _wsActiveTab();
  if (!tab) return;
  n = Math.max(1, Math.min(MAX_WS_PANES, n));
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
  pane.sock.send(new TextEncoder().encode(cmd + '\r'));
  if (pane.term) pane.term.focus();
}

// ── mount ───────────────────────────────────────────────────────────────────
async function renderWorkspace(container) {
  // Idempotent: background refreshes call render() while on this view.
  if (_wsTabs.length && document.getElementById('wsTabPanes')) return;

  teardownWorkspaceIfActive();
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
          '<button class="toolbar-btn" id="wsLayout-1" title="1 pane" onclick="setWorkspaceLayout(1)">▯</button>' +
          '<button class="toolbar-btn" id="wsLayout-2" title="2 panes" onclick="setWorkspaceLayout(2)">▯▯</button>' +
          '<button class="toolbar-btn" id="wsLayout-3" title="3 panes" onclick="setWorkspaceLayout(3)">▯▯▯</button>' +
          '<button class="toolbar-btn" id="wsLayout-4" title="4 panes (2×2)" onclick="setWorkspaceLayout(4)">⊞</button>' +
        '</div>' +
        '<button class="toolbar-btn" id="wsAddPane" title="Add a pane to this tab" onclick="addWorkspacePane(null)">+ Pane</button>' +
        '<span style="flex:1"></span>' +
        '<span class="workspace-hint">Double-click a tab to rename</span>' +
      '</div>' +
      '<div class="workspace-tabpanes" id="wsTabPanes"></div>' +
    '</div>';

  try { await _loadWorkspaceVendor(); }
  catch (e) { container.innerHTML = '<div class="empty-state">Failed to load terminal assets.</div>'; return; }
  if (!document.getElementById('wsTabPanes')) return; // switched away while loading

  _wsTabs = [{ id: 't' + (++_wsTabSeq), name: 'Tab 1', panes: [{ id: 'p' + (++_wsPaneSeq), cmd: null }] }];
  _wsActiveTabId = _wsTabs[0].id;
  _wsRenderAll();
}
