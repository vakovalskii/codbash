// ── Cloud Sync View ─────────────────────────
var cloudSessions = null;
var cloudStats = null;
var cloudLocalSessions = null;
var cloudLoading = false;
var cloudUnlocked = false;
var cloudConfigured = false;
var cloudSessionIds = new Set();
var CLOUD_LIMIT = 10;

async function renderCloud(container) {
  var profile = null;
  try {
    var resp = await fetch('/api/github/profile');
    profile = await resp.json();
  } catch (e) {}

  var html = '<div class="cloud-container">';
  html += '<h2 class="cloud-title">Cloud Sync</h2>';

  // Explanation
  html += '<div class="cloud-info">';
  html += '<p>Sync your coding sessions between devices. Sessions are <strong>encrypted</strong> with your GitHub account — only you can read them.</p>';
  html += '<p>Free tier: up to <strong>' + CLOUD_LIMIT + ' sessions</strong>. Connect the same GitHub account on another PC to pull sessions there.</p>';
  html += '</div>';

  if (!profile || !profile.authenticated) {
    html += '<div class="cloud-connect">';
    html += '<p>Connect GitHub to enable Cloud Sync:</p>';
    html += '<button class="lb-github-btn" onclick="githubConnect()"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg> Connect GitHub</button>';
    html += '</div>';
    container.innerHTML = html + '</div>';
    return;
  }

  // Profile + status bar
  html += '<div class="cloud-status">';
  html += '<img src="' + escHtml(profile.avatar) + '" class="cloud-avatar">';
  html += '<div class="cloud-user"><strong>' + escHtml(profile.name || profile.username) + '</strong><br><span class="dim">@' + escHtml(profile.username) + '</span></div>';

  // Auto-setup if needed
  if (!cloudConfigured) {
    try {
      await fetch('/api/cloud/setup', { method: 'POST' });
      await checkCloudLockState();
    } catch {}
  }

  var syncedCount = cloudSessions ? cloudSessions.length : 0;
  var totalSize = cloudStats ? (cloudStats.total_size / 1024 / 1024).toFixed(1) : '0';
  html += '<div class="cloud-counter">';
  html += '<span class="cloud-count">' + syncedCount + '/' + CLOUD_LIMIT + '</span>';
  html += '<span class="dim">sessions in cloud</span>';
  html += '<span class="dim">' + totalSize + ' MB</span>';
  html += '</div>';
  html += '<button class="toolbar-btn" onclick="loadCloudData()" style="margin-left:auto">Refresh</button>';
  html += '</div>';

  // Sessions list — merged view
  html += '<div class="cloud-sessions">';

  if (cloudLoading) {
    html += '<div class="cloud-empty">Loading...</div>';
  } else if (!cloudLocalSessions) {
    html += '<div class="cloud-empty">Loading sessions...</div>';
  } else {
    // Build merged list: local sessions with cloud status
    var localById = {};
    cloudLocalSessions.forEach(function(s) { localById[s.id] = s; });

    // Cloud-only sessions (pulled from other device)
    var cloudOnly = [];
    if (cloudSessions) {
      cloudSessions.forEach(function(cs) {
        if (!localById[cs.session_id]) cloudOnly.push(cs);
      });
    }

    // Sorted: synced first, then local-only, then cloud-only
    var synced = cloudLocalSessions.filter(function(s) { return cloudSessionIds.has(s.id); });
    var localOnly = cloudLocalSessions.filter(function(s) { return !cloudSessionIds.has(s.id); })
      .sort(function(a, b) { return b.last_ts - a.last_ts; })
      .slice(0, 20); // show top 20 local

    if (synced.length > 0) {
      html += '<div class="cloud-section-title">&#9745; Synced (' + synced.length + ')</div>';
      synced.forEach(function(s) {
        html += cloudSessionRow(s, 'synced');
      });
    }

    if (cloudOnly.length > 0) {
      html += '<div class="cloud-section-title">&#9729; Cloud Only (' + cloudOnly.length + ')</div>';
      cloudOnly.forEach(function(cs) {
        html += cloudRemoteRow(cs);
      });
    }

    var canPush = CLOUD_LIMIT - syncedCount;
    html += '<div class="cloud-section-title">&#128187; Local Only' + (canPush > 0 ? ' — ' + canPush + ' slots available' : ' — limit reached') + '</div>';
    if (localOnly.length === 0) {
      html += '<div class="cloud-empty">All sessions are synced!</div>';
    } else {
      localOnly.forEach(function(s) {
        html += cloudSessionRow(s, canPush > 0 ? 'pushable' : 'full');
      });
    }
  }

  html += '</div></div>';
  container.innerHTML = html;

  if (!cloudSessions && !cloudLoading) loadCloudData();
}

function cloudSessionRow(s, status) {
  var name = (s.session_name || s.first_message || s.id).substring(0, 70);
  var sub = (s.tool || '') + ' · ' + (s.project_short || '') + ' · ' + (s.messages || 0) + ' msgs';
  var btn = '';
  if (status === 'synced') {
    btn = '<span class="cloud-badge cloud-synced">&#9745; synced</span>';
  } else if (status === 'pushable') {
    btn = '<button class="cloud-push-btn" onclick="cloudPushOne(\'' + s.id + '\',this)">&#9650; Push</button>';
  } else {
    btn = '<span class="cloud-badge cloud-full">limit</span>';
  }
  return '<div class="cloud-row">' +
    '<span class="tool-badge tool-' + (s.tool || 'claude') + '" style="font-size:10px;padding:2px 6px">' + (s.tool || '') + '</span>' +
    '<div class="cloud-row-info"><div class="cloud-row-name">' + escHtml(name) + '</div><div class="cloud-row-sub">' + escHtml(sub) + '</div></div>' +
    btn + '</div>';
}

function cloudRemoteRow(cs) {
  var name = (cs.session_name || cs.first_message || cs.session_id).substring(0, 70);
  var sub = (cs.agent || '') + ' · ' + (cs.project_short || '') + ' · ' + (cs.message_count || 0) + ' msgs';
  return '<div class="cloud-row">' +
    '<span class="tool-badge tool-' + (cs.agent || 'claude') + '" style="font-size:10px;padding:2px 6px">' + (cs.agent || '') + '</span>' +
    '<div class="cloud-row-info"><div class="cloud-row-name">' + escHtml(name) + '</div><div class="cloud-row-sub">' + escHtml(sub) + '</div></div>' +
    '<button class="cloud-pull-btn" onclick="cloudPullOne(\'' + cs.session_id + '\',this)">&#9660; Pull</button>' +
    '<button class="cloud-del-btn" onclick="deleteCloudSession(\'' + cs.session_id + '\')">&times;</button>' +
    '</div>';
}

async function checkCloudLockState() {
  try {
    var resp = await fetch('/api/cloud/locked');
    var data = await resp.json();
    cloudConfigured = data.configured;
    cloudUnlocked = data.unlocked;
  } catch (e) {}
}

async function loadCloudData() {
  cloudLoading = true;
  applyFilters();
  try {
    await checkCloudLockState();
    // Auto-setup if GitHub connected but not configured
    if (!cloudConfigured) {
      await fetch('/api/cloud/setup', { method: 'POST' });
      await checkCloudLockState();
    }
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
    if (statsResp.ok) cloudStats = await statsResp.json();
    if (localResp.ok) {
      cloudLocalSessions = await localResp.json();
      if (!Array.isArray(cloudLocalSessions)) cloudLocalSessions = [];
    }
  } catch (e) {
    showToast('Cloud: ' + e.message);
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
      showToast('Pushed (' + ((data.size || 0) / 1024).toFixed(0) + ' KB)');
      cloudSessionIds.add(sessionId);
      if (btn) btn.outerHTML = '<span class="cloud-badge cloud-synced">&#9745; synced</span>';
    } else {
      showToast(data.error || 'Push failed');
      if (btn) { btn.disabled = false; btn.textContent = '▲ Push'; }
    }
  } catch (e) {
    showToast('Error: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = '▲ Push'; }
  }
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
      showToast(data.error || 'Pull failed');
      if (btn) { btn.disabled = false; btn.textContent = '▼ Pull'; }
    }
  } catch (e) {
    showToast('Error: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = '▼ Pull'; }
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
      showToast('Delete failed');
    }
  } catch (e) {
    showToast('Error: ' + e.message);
  }
}
