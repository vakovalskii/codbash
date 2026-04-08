// ── Cloud Sync View ─────────────────────────
var cloudSessions = null;
var cloudStats = null;
var cloudLocalSessions = null;
var cloudLoading = false;
var cloudUnlocked = false;
var cloudConfigured = false;
var cloudServerHasSalt = false;
var cloudSessionIds = new Set();

var inputStyle = 'padding:7px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-card-hover);color:var(--text-primary);width:200px;font-size:13px;-webkit-text-security:disc;';
var inputAttrs = 'autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-1p-ignore data-lpignore="true"';
var rowStyle = 'display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;margin-bottom:4px;';
var panelStyle = 'flex:1;min-width:0;overflow-y:auto;max-height:60vh;';

function cloudRow(badge, text, sub, btns) {
  var h = '<div style="' + rowStyle + '">';
  h += '<span class="tool-badge tool-' + badge + '" style="font-size:10px;padding:2px 6px;">' + badge + '</span>';
  h += '<div style="flex:1;min-width:0;">';
  h += '<div style="font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(text) + '</div>';
  if (sub) h += '<div class="dim" style="font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(sub) + '</div>';
  h += '</div>' + btns + '</div>';
  return h;
}

async function renderCloud(container) {
  var profile = null;
  try {
    var resp = await fetch('/api/github/profile');
    profile = await resp.json();
  } catch (e) {}

  var html = '<div class="view-header"><h2>Cloud Sync</h2></div>';

  if (!profile || !profile.authenticated) {
    html += '<div class="empty-state">';
    html += '<p>Connect GitHub to sync sessions to the cloud.</p>';
    html += '<button class="launch-btn btn-primary" onclick="githubConnect()">Connect GitHub</button>';
    html += '</div>';
    container.innerHTML = html;
    return;
  }

  // Header bar
  html += '<div style="margin-bottom:12px;padding:12px 16px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">';
  html += '<img src="' + profile.avatar + '" style="width:32px;height:32px;border-radius:50%;border:2px solid var(--border);">';
  html += '<div><strong style="font-size:13px;">' + escHtml(profile.name || profile.username) + '</strong> <span class="dim" style="font-size:11px;">@' + escHtml(profile.username) + '</span></div>';
  html += '<div style="margin-left:auto;display:flex;gap:8px;align-items:center;">';

  var needsPassphrase = !cloudConfigured && !cloudServerHasSalt;
  var needsEnter = !cloudConfigured && cloudServerHasSalt;

  if (needsPassphrase) {
    html += '<input type="text" id="cloudPassInput" placeholder="Create passphrase (min 4)" ' + inputAttrs + ' style="' + inputStyle + '" onkeydown="if(event.key===\'Enter\')setupCloud()">';
    html += '<button class="launch-btn btn-primary" onclick="setupCloud()">Setup</button>';
  } else if (!cloudUnlocked) {
    html += '<input type="text" id="cloudPassInput" placeholder="Enter passphrase" ' + inputAttrs + ' style="' + inputStyle + '" onkeydown="if(event.key===\'Enter\')' + (needsEnter ? 'setupCloud()' : 'unlockCloud()') + '">';
    html += '<button class="launch-btn btn-primary" onclick="' + (needsEnter ? 'setupCloud()' : 'unlockCloud()') + '">Unlock</button>';
  } else {
    html += '<span style="color:var(--accent-green,#3fb950);font-size:12px;font-weight:600;">&#10003; Unlocked</span>';
    html += '<button class="launch-btn btn-secondary" style="padding:5px 10px;font-size:11px;" onclick="lockCloud()">Lock</button>';
  }
  html += '<button class="launch-btn btn-secondary" style="padding:5px 10px;font-size:11px;" onclick="loadCloudData()">Refresh</button>';
  html += '</div></div>';

  if (!cloudUnlocked) {
    container.innerHTML = html;
    if (!cloudLoading && cloudSessions === null) loadCloudData();
    return;
  }

  // Two-panel layout
  html += '<div style="display:flex;gap:12px;align-items:flex-start;">';

  // LEFT: Local sessions
  html += '<div style="flex:1;min-width:0;">';
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">';
  html += '<strong style="font-size:13px;">This PC</strong>';
  html += '<span class="dim" style="font-size:11px;">' + (cloudLocalSessions ? cloudLocalSessions.length : '...') + ' sessions</span>';
  html += '</div>';
  html += '<div style="margin-bottom:8px;"><button class="launch-btn btn-primary" style="padding:6px 14px;font-size:12px;width:100%;" onclick="cloudPushAll()" id="cloudPushAllBtn">Push All &rarr;</button></div>';
  html += '<div style="' + panelStyle + '">';

  if (cloudLocalSessions) {
    for (var i = 0; i < cloudLocalSessions.length; i++) {
      var ls = cloudLocalSessions[i];
      var inCloud = cloudSessionIds.has(ls.id);
      var sub = (ls.project_short || '') + ' \u00b7 ' + (ls.messages || 0) + ' msgs';
      var btnHtml = inCloud
        ? '<span class="dim" style="font-size:10px;white-space:nowrap;">in cloud</span>'
        : '<button class="launch-btn btn-primary" style="padding:3px 8px;font-size:10px;" onclick="cloudPushOne(\'' + ls.id + '\',this)">Push</button>';
      html += cloudRow(ls.tool, (ls.first_message || ls.id).substring(0, 60), sub, btnHtml);
    }
  } else {
    html += '<div class="dim" style="text-align:center;padding:20px;font-size:12px;">Loading...</div>';
  }
  html += '</div></div>';

  // RIGHT: Cloud sessions
  html += '<div style="flex:1;min-width:0;">';
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">';
  html += '<strong style="font-size:13px;">Cloud</strong>';
  html += '<span class="dim" style="font-size:11px;">' + (cloudSessions ? cloudSessions.length : '...') + ' sessions' + (cloudStats ? ' \u00b7 ' + ((cloudStats.total_size || 0) / 1024 / 1024).toFixed(1) + ' MB' : '') + '</span>';
  html += '</div>';
  html += '<div style="margin-bottom:8px;"><button class="launch-btn btn-secondary" style="padding:6px 14px;font-size:12px;width:100%;" onclick="cloudPullAll()" id="cloudPullAllBtn">&larr; Pull All</button></div>';
  html += '<div style="' + panelStyle + '">';

  if (cloudLoading) {
    html += '<div class="dim" style="text-align:center;padding:20px;font-size:12px;">Loading...</div>';
  } else if (!cloudSessions || cloudSessions.length === 0) {
    html += '<div class="dim" style="text-align:center;padding:20px;font-size:12px;">Empty</div>';
  } else {
    for (var j = 0; j < cloudSessions.length; j++) {
      var cs = cloudSessions[j];
      var csDate = cs.last_ts ? new Date(cs.last_ts).toLocaleDateString() : '';
      var csSub = (cs.project_short || '') + ' \u00b7 ' + cs.message_count + ' msgs \u00b7 ' + csDate;
      var csBtns = '<button class="launch-btn btn-secondary" style="padding:3px 8px;font-size:10px;" onclick="cloudPullOne(\'' + cs.session_id + '\',this)">Pull</button>';
      csBtns += '<button class="launch-btn btn-delete" style="padding:3px 6px;font-size:10px;" onclick="deleteCloudSession(\'' + cs.session_id + '\')">&times;</button>';
      html += cloudRow(cs.agent, (cs.first_message || cs.session_id).substring(0, 60), csSub, csBtns);
    }
  }
  html += '</div></div>';

  html += '</div>'; // end two-panel

  container.innerHTML = html;

  if (!cloudSessions && !cloudLoading) loadCloudData();
}

async function setupCloud() {
  var input = document.getElementById('cloudPassInput');
  if (!input || !input.value) return;
  if (input.value.length < 4) { showToast('Passphrase too short (min 4)', 'error'); return; }
  try {
    var resp = await fetch('/api/cloud/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: input.value }),
    });
    var data = await resp.json();
    if (data.ok) {
      cloudConfigured = true;
      cloudUnlocked = true;
      showToast(data.isNew === false ? 'Cloud unlocked' : 'Cloud encryption configured!');
      loadCloudData();
    } else {
      showToast(data.error || 'Setup failed', 'error');
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function checkCloudLockState() {
  try {
    var resp = await fetch('/api/cloud/locked');
    var data = await resp.json();
    cloudConfigured = data.configured;
    cloudServerHasSalt = data.serverHasSalt;
    cloudUnlocked = data.unlocked;
  } catch (e) {}
}

async function unlockCloud() {
  var input = document.getElementById('cloudPassInput');
  if (!input || !input.value) return;
  try {
    var resp = await fetch('/api/cloud/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: input.value }),
    });
    var data = await resp.json();
    if (data.ok) {
      cloudUnlocked = true;
      showToast('Cloud unlocked');
      loadCloudData();
    } else {
      showToast(data.error || 'Wrong passphrase', 'error');
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

function lockCloud() {
  fetch('/api/cloud/lock', { method: 'POST' }).catch(function() {});
  cloudUnlocked = false;
  showToast('Cloud locked');
  applyFilters();
}

async function loadCloudData() {
  cloudLoading = true;
  applyFilters();

  try {
    await checkCloudLockState();
    var [listResp, statsResp, localResp] = await Promise.all([
      fetch('/api/cloud/list'),
      fetch('/api/cloud/status'),
      fetch('/api/sessions'),
    ]);
    if (listResp.ok) {
      var listData = await listResp.json();
      cloudSessions = listData.sessions || [];
      cloudSessionIds = new Set(cloudSessions.map(function(s) { return s.session_id; }));
    }
    if (statsResp.ok) {
      cloudStats = await statsResp.json();
    }
    if (localResp.ok) {
      cloudLocalSessions = await localResp.json();
      if (!Array.isArray(cloudLocalSessions)) cloudLocalSessions = [];
    }
  } catch (e) {
    showToast('Cloud: ' + e.message, 'error');
  }

  cloudLoading = false;
  applyFilters();
}

async function cloudPushOne(sessionId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  try {
    var resp = await fetch('/api/cloud/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId }),
    });
    var data = await resp.json();
    if (data.ok) {
      showToast('Pushed (' + (data.size / 1024).toFixed(0) + ' KB)');
      cloudSessionIds.add(sessionId);
      if (btn) { btn.textContent = 'Done'; btn.disabled = true; }
    } else {
      showToast(data.error || 'Push failed', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Push'; }
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Push'; }
  }
}

async function cloudPushAll() {
  var btn = document.getElementById('cloudPushAllBtn');
  if (btn) { btn.disabled = true; }
  if (!cloudLocalSessions) { showToast('Loading...', 'error'); return; }

  var ids = cloudLocalSessions.map(function(s) { return s.id; });
  var ok = 0, fail = 0;
  for (var i = 0; i < ids.length; i++) {
    if (btn) btn.textContent = 'Pushing ' + (i + 1) + '/' + ids.length + '...';
    try {
      var r = await fetch('/api/cloud/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: ids[i] }),
      });
      var d = await r.json();
      if (d.ok) ok++; else fail++;
    } catch (e) { fail++; }
  }
  showToast('Pushed ' + ok + (fail > 0 ? ', ' + fail + ' failed' : ''));
  if (btn) { btn.disabled = false; btn.textContent = 'Push All \u2192'; }
  loadCloudData();
}

async function cloudPullAll() {
  var btn = document.getElementById('cloudPullAllBtn');
  if (btn) { btn.disabled = true; }
  if (!cloudSessions) { showToast('Load cloud data first', 'error'); return; }

  var ok = 0, skip = 0, fail = 0;
  for (var i = 0; i < cloudSessions.length; i++) {
    if (btn) btn.textContent = 'Pulling ' + (i + 1) + '/' + cloudSessions.length + '...';
    try {
      var r = await fetch('/api/cloud/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: cloudSessions[i].session_id }),
      });
      var d = await r.json();
      if (d.ok) ok++;
      else if (d.skipped) skip++;
      else fail++;
    } catch (e) { fail++; }
  }
  showToast('Pulled ' + ok + ', skipped ' + skip + (fail > 0 ? ', failed ' + fail : ''));
  if (btn) { btn.disabled = false; btn.textContent = '\u2190 Pull All'; }
}

async function cloudPullOne(sessionId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  try {
    var resp = await fetch('/api/cloud/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId }),
    });
    var data = await resp.json();
    if (data.ok) {
      showToast('Pulled');
      if (btn) btn.textContent = 'Done';
    } else if (data.skipped) {
      if (btn) btn.textContent = 'Local';
    } else {
      showToast(data.error || 'Pull failed', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Pull'; }
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Pull'; }
  }
}

async function deleteCloudSession(sessionId) {
  if (!confirm('Delete from cloud?')) return;
  try {
    var resp = await fetch('/api/cloud/' + encodeURIComponent(sessionId), { method: 'DELETE' });
    if (resp.ok) {
      showToast('Deleted');
      cloudSessions = null;
      loadCloudData();
    } else {
      showToast('Delete failed', 'error');
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}
