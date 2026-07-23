// Overview — the landing "workspace at a glance": headline stats, running
// terminals (live status), recent sessions, and quick actions (new terminal,
// launch a saved layout / command). Reuses globals + helpers from app.js and
// the live workspace state from workspace.js (both loaded before this file).

function _ovPanes() {
  if (typeof _wsAllPanes !== 'function') return [];
  return _wsAllPanes().filter(function (x) { return x.pane.sock || x.pane.exited; });
}

function _ovProjectKey(cwd) {
  if (!cwd) return 'no folder';
  var base = (typeof _wsProjectBasename === 'function') ? _wsProjectBasename(cwd) : cwd;
  return base || cwd;
}

function _ovGreeting() {
  var h = new Date().getHours();
  var g = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  var d = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  return g + ' — ' + d;
}

// Cost is fetched once and cached (60s) so the live re-render doesn't flicker
// or hammer the endpoint on every status tick.
var _ovCost = null, _ovCostAt = 0, _ovCostInFlight = false;
function _ovEnsureCost() {
  var now = Date.now();
  if (_ovCostInFlight) return;
  if (_ovCost && (now - _ovCostAt) < 60000) return;
  _ovCostInFlight = true;
  fetch('/api/analytics/cost').then(function (r) { return r.json(); }).then(function (d) {
    _ovCost = d; _ovCostAt = Date.now(); _ovCostInFlight = false;
    _ovRefreshIfCurrent();
  }).catch(function () { _ovCostInFlight = false; });
}
function _ovFmtMoney(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '$0';
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'k';
  if (n >= 100) return '$' + n.toFixed(0);
  return '$' + n.toFixed(2);
}

function _ovStat(num, label, sub) {
  return '<div class="ov-stat"><div class="ov-stat-num">' + num + '</div>' +
    '<div class="ov-stat-label">' + escHtml(label) + '</div>' +
    (sub ? '<div class="ov-stat-sub">' + escHtml(sub) + '</div>' : '') + '</div>';
}

function renderOverview(container) {
  // Make sure the data we lean on is available even on a cold landing. Fire the
  // fetch exactly ONCE (guarded by a request flag) — NOT "when the list is
  // empty": renderOverview runs once per second, and a user with zero saved
  // layouts/commands has a permanently-empty [] which made the old "if empty"
  // guard re-fetch /api/terminal/{layouts,commands} every single second. Saving
  // a layout/command calls the loader directly, so it still refreshes.
  if (typeof _wsLoadCommands === 'function' && !window._ovCommandsRequested) { window._ovCommandsRequested = true; _wsLoadCommands(); }
  if (typeof _wsLoadLayouts === 'function' && !window._ovLayoutsRequested) { window._ovLayoutsRequested = true; _wsLoadLayouts(); }
  if (typeof _wsStartStatusLoop === 'function') _wsStartStatusLoop();
  var sessions = (typeof allSessions !== 'undefined' && allSessions) ? allSessions : [];
  if (!sessions.length && typeof loadSessions === 'function') loadSessions();
  _ovEnsureCost();

  var panes = _ovPanes();
  var liveTerms = panes.filter(function (x) { return !x.pane.exited; }).length;
  var activeAgents = (typeof activeSessions !== 'undefined' && activeSessions) ? Object.keys(activeSessions).length : 0;

  var html = '<div class="ov-wrap" id="ovWrap">';
  html += '<div class="ov-head">' +
    '<div><h2 class="heatmap-title">Overview</h2>' +
    '<div class="ov-sub">' + escHtml(_ovGreeting()) + '</div></div>' +
    '<button class="toolbar-btn ov-primary" onclick="overviewNewTerminal()">+ New terminal</button>' +
    '</div>';

  // ── Headline stats ──
  var todayCost = _ovCost ? _ovFmtMoney(_ovCost.todayCost) : '…';
  var totalCost = _ovCost ? _ovFmtMoney(_ovCost.totalCost) : '…';
  var costSub = _ovCost ? ('today ' + _ovFmtMoney(_ovCost.todayCost)) : '';
  html += '<div class="ov-stats">' +
    _ovStat(sessions.length, 'Sessions', '') +
    _ovStat(activeAgents, 'Active agents', activeAgents ? 'running now' : '') +
    _ovStat(liveTerms, 'Terminals', liveTerms ? 'in workspace' : '') +
    _ovStat(totalCost, 'Total spend', costSub) +
    '</div>';

  // ── Terminals ──
  html += '<div class="ov-section-title">Terminals</div>';
  if (!panes.length) {
    html += '<div class="empty-state" style="text-align:left;max-width:460px;margin:0">' +
      'No terminals running yet. Open one to run shells and agents right here — ' +
      'sessions survive switching views.<br><br>' +
      '<button class="toolbar-btn ov-primary" onclick="overviewNewTerminal()">Open a terminal</button></div>';
  } else {
    // Group the live terminals by their project folder so you see, at a glance,
    // which projects have terminals running.
    var groups = {};
    var order = [];
    panes.forEach(function (x) {
      var key = _ovProjectKey(x.pane.cwd);
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(x);
    });
    order.forEach(function (key) {
      html += '<div class="ov-proj-label">' + escHtml(key) + '</div><div class="ov-grid">';
      groups[key].forEach(function (x) {
        var st = (typeof _wsPaneStatus === 'function') ? _wsPaneStatus(x.pane) : 'idle';
        var meta = (window.WS_STATUS_META && WS_STATUS_META[st]) || { label: st, cls: st };
        // Clean, human label ("claude") — _wsPaneLabel strips leading VAR=value
        // env assignments (e.g. HTTPS_PROXY='http://user:pass@host') so we never
        // surface a raw proxy string, and masks any remaining secrets.
        var masked = (typeof _wsPaneLabel === 'function')
          ? _wsPaneLabel(x.pane)
          : ((typeof _wsMaskSecrets === 'function') ? _wsMaskSecrets(x.pane.cmd || 'shell') : (x.pane.cmd || 'shell'));
        html += '<button class="ov-card ' + meta.cls + '" ' +
          'onclick="jumpToWorkspacePane(\'' + escHtml(x.tab.id) + '\',\'' + escHtml(x.pane.id) + '\')">' +
          '<div class="ov-card-top"><span class="ov-dot"></span>' +
          '<span class="ov-tab">' + escHtml(x.tab.name) + '</span>' +
          '<span class="ov-st">' + escHtml(meta.label) + '</span></div>' +
          '<div class="ov-cmd">' + escHtml(masked) + '</div>' +
          '<div class="ov-cwd">' + escHtml(x.pane.cwd || '~') + '</div>' +
          '</button>';
      });
      html += '</div>';
    });
  }

  // ── Recent sessions ──
  var recent = sessions.slice().sort(function (a, b) { return (b.last_ts || 0) - (a.last_ts || 0); }).slice(0, 6);
  if (recent.length) {
    html += '<div class="ov-section-title">Recent sessions</div><div class="ov-grid">';
    recent.forEach(function (s) {
      var badge = (typeof getToolLabel === 'function') ? getToolLabel(s.tool, true) : (s.tool || '');
      var proj = s.project_short || ((typeof getProjectName === 'function') ? getProjectName(s.project) : s.project) || '~';
      var txt = (s.recap || s.first_message || '').slice(0, 130);
      var when = (typeof timeAgo === 'function') ? timeAgo(s.last_ts) : '';
      html += '<button class="ov-card ov-session" onclick="ovOpenSession(\'' + escJsString(s.id) + '\')">' +
        '<div class="ov-card-top">' +
        '<span class="ov-badge tool-' + escHtml(s.tool) + '">' + escHtml(badge) + '</span>' +
        '<span class="ov-tab">' + escHtml(proj) + '</span>' +
        '<span class="ov-st">' + escHtml(when) + '</span></div>' +
        '<div class="ov-desc">' + escHtml(txt) + '</div>' +
        '<div class="ov-cwd">' + escHtml(String(s.messages || 0)) + ' msgs</div>' +
        '</button>';
    });
    html += '</div>';
  }

  // ── Quick actions ──
  if (window._wsSavedLayouts && _wsSavedLayouts.length) {
    html += '<div class="ov-section-title">Saved layouts</div><div class="ov-chips">';
    _wsSavedLayouts.forEach(function (l) {
      html += '<button class="toolbar-btn" onclick="overviewLaunchLayout(\'' + escHtml(l.id) + '\')">▸ ' + escHtml(l.name) + '</button>';
    });
    html += '</div>';
  }

  if (window._wsSavedCommands && _wsSavedCommands.length) {
    html += '<div class="ov-section-title">Saved commands</div><div class="ov-chips">';
    _wsSavedCommands.forEach(function (c) {
      var masked = (typeof _wsMaskSecrets === 'function') ? _wsMaskSecrets(c.command) : c.command;
      html += '<button class="toolbar-btn" title="' + escHtml(masked) + '" onclick="overviewRunCommand(\'' + escHtml(c.id) + '\')">▸ ' + escHtml(c.name) + '</button>';
    });
    html += '</div>';
  }

  html += '</div>';
  container.innerHTML = html;
}

// Live refresh: re-render while Overview is the current view (cheap — reads
// cached data). Called from the workspace status loop.
function _ovRefreshIfCurrent() {
  if (typeof currentView !== 'undefined' && currentView === 'overview') {
    var c = document.getElementById('content');
    if (c && document.getElementById('ovWrap')) renderOverview(c);
  }
}

function ovOpenSession(id) {
  var list = (typeof allSessions !== 'undefined' && allSessions) ? allSessions : [];
  var s = list.find(function (x) { return x.id === id; });
  if (s && typeof openDetail === 'function') openDetail(s);
}

function overviewNewTerminal() {
  var had = (window._wsTabs && _wsTabs.length) || 0;
  if (typeof setView === 'function') setView('workspace');
  setTimeout(function () { if (had && typeof addWorkspaceTab === 'function') addWorkspaceTab(); }, 90);
}

function overviewLaunchLayout(id) {
  if (typeof setView === 'function') setView('workspace');
  setTimeout(function () { if (typeof applyWorkspaceLayout === 'function') applyWorkspaceLayout(id); }, 90);
}

function overviewRunCommand(id) {
  if (typeof setView === 'function') setView('workspace');
  setTimeout(function () {
    var c = (window._wsSavedCommands || []).find(function (x) { return x.id === id; });
    if (!c || !_wsTabs.length) return;
    var pid = (typeof _wsActivePaneId === 'function') ? _wsActivePaneId() : null;
    if (pid && typeof launchAgentInPane === 'function') launchAgentInPane(pid, c.command);
  }, 160);
}
