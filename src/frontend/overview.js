// Overview — the landing "workspace at a glance": running terminals (with live
// status) + quick actions (new terminal, launch a saved layout / command).
// Reads the live workspace state from workspace.js (loaded before this file).

function _ovPanes() {
  if (typeof _wsAllPanes !== 'function') return [];
  return _wsAllPanes().filter(function (x) { return x.pane.sock || x.pane.exited; });
}

function renderOverview(container) {
  // Make sure saved lists are available even if the terminal was never opened.
  if (typeof _wsLoadCommands === 'function' && (!window._wsSavedCommands || !_wsSavedCommands.length)) _wsLoadCommands();
  if (typeof _wsLoadLayouts === 'function' && (!window._wsSavedLayouts || !_wsSavedLayouts.length)) _wsLoadLayouts();
  // Keep the status loop ticking so cards refresh even before Workspace mounts.
  if (typeof _wsStartStatusLoop === 'function') _wsStartStatusLoop();

  var panes = _ovPanes();
  var html = '<div class="ov-wrap" id="ovWrap">';
  html += '<div class="ov-head">' +
    '<h2 class="heatmap-title">Workspace</h2>' +
    '<button class="toolbar-btn ov-primary" onclick="overviewNewTerminal()">+ New terminal</button>' +
    '</div>';

  html += '<div class="ov-section-title">Terminals</div>';
  if (!panes.length) {
    html += '<div class="empty-state" style="text-align:left;max-width:460px">' +
      'No terminals running yet. Open one to run shells and agents right here — ' +
      'sessions survive switching views.<br><br>' +
      '<button class="toolbar-btn ov-primary" onclick="overviewNewTerminal()">Open a terminal</button></div>';
  } else {
    html += '<div class="ov-grid">';
    panes.forEach(function (x) {
      var st = (typeof _wsPaneStatus === 'function') ? _wsPaneStatus(x.pane) : 'idle';
      var meta = (window.WS_STATUS_META && WS_STATUS_META[st]) || { label: st, cls: st };
      var cmd = x.pane.cmd || 'shell';
      var masked = (typeof _wsMaskSecrets === 'function') ? _wsMaskSecrets(cmd) : cmd;
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
  }

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

// Live refresh: re-render while Overview is the current view (cheap — a few
// cards). Called from the workspace status loop.
function _ovRefreshIfCurrent() {
  if (typeof currentView !== 'undefined' && currentView === 'overview') {
    var c = document.getElementById('content');
    if (c && document.getElementById('ovWrap')) renderOverview(c);
  }
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
