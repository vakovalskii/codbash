// ── Leaderboard ───────────────────────────────────────────────

async function syncLeaderboard() {
  var btn = document.getElementById('syncBtn');
  if (btn) btn.textContent = 'Syncing...';
  try {
    var resp = await fetch('/api/leaderboard/sync', { method: 'POST' });
    var data = await resp.json();
    if (data.ok) {
      showToast('Stats synced to global leaderboard!');
      loadGlobalLeaderboard();
    } else {
      showToast('Sync failed: ' + (data.error || 'unknown'));
    }
  } catch (e) { showToast('Sync error: ' + e.message); }
  if (btn) btn.textContent = 'Sync to Global Leaderboard';
}

var _lbRemoteData = null;
var _lbCurrentTab = 'today';
var _lbSortBy = 'messages'; // messages, hours, cost

function switchLbTab(tab, btn) {
  _lbCurrentTab = tab;
  document.querySelectorAll('.lb-tab:not(.lb-sort)').forEach(function(t) { t.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  renderGlobalBoard();
}

function switchLbSort(sortBy, btn) {
  _lbSortBy = sortBy;
  document.querySelectorAll('.lb-sort').forEach(function(t) { t.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  renderGlobalBoard();
}

function renderGlobalBoard() {
  var board = document.getElementById('globalBoard');
  if (!board || !_lbRemoteData) return;
  var data = _lbRemoteData;
  if (!data.users || data.users.length === 0) {
    board.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">No one here yet. Sync your stats to be first!</div>';
    return;
  }

  // Sort by tab + sort criterion
  var sorted = data.users.slice();
  var getVal = function(u) {
    var s = _lbCurrentTab === 'today' ? (u.stats?.today||{}) : _lbCurrentTab === 'week' ? (u.stats?.week||{}) : (u.stats?.totals||{});
    return s[_lbSortBy] || 0;
  };
  sorted.sort(function(a,b) { return getVal(b) - getVal(a); });

  var html = '';
  sorted.forEach(function(u, i) {
    var t = u.stats?.today || {};
    var w = u.stats?.week || {};
    var tot = u.stats?.totals || {};

    // Pick values based on tab
    var msgs, interactions, hours, cost, label;
    if (_lbCurrentTab === 'today') { msgs = t.messages||0; interactions = t.interactions||msgs; hours = t.hours||0; cost = t.cost||0; label = 'today'; }
    else if (_lbCurrentTab === 'week') { msgs = w.messages||0; interactions = w.interactions||msgs; hours = w.hours||0; cost = w.cost||0; label = 'this week'; }
    else { msgs = tot.messages||0; interactions = tot.interactions||msgs; hours = tot.hours||0; cost = tot.cost||0; label = 'all time'; }
    var autoRatio = msgs > 0 ? interactions / msgs : 0;

    html += '<div class="lb-global-row">';
    html += '<span class="lb-rank' + (i < 3 ? ' lb-rank-' + (i+1) : '') + '">#' + (i+1) + '</span>';
    html += '<img class="lb-global-avatar" src="' + escHtml(u.avatar || '') + '" alt="">';
    html += '<div class="lb-global-info">';
    html += '<div class="lb-global-name"><a href="https://github.com/' + escHtml(u.username) + '" target="_blank">' + escHtml(u.name || u.username) + '</a>';
    if (u.verified) html += ' <span class="lb-verified">&#10003;</span>';
    html += '</div>';
    html += '<div class="lb-global-handle"><a href="https://github.com/' + escHtml(u.username) + '" target="_blank" style="color:var(--text-muted);text-decoration:none">@' + escHtml(u.username) + '</a>';
    if (u.deviceCount > 1) html += ' <span class="lb-devices">' + u.deviceCount + ' devices</span>';
    html += '</div>';
    // Top agents
    var agents = Object.entries(u.stats?.agents || {}).sort(function(a,b){return b[1]-a[1]}).slice(0,3);
    if (agents.length) {
      html += '<div class="lb-global-agents">';
      agents.forEach(function(a) { html += '<span class="lb-agent-mini tool-' + a[0] + '">' + escHtml(getToolLabel(a[0], true)) + '</span>'; });
      html += '</div>';
    }
    html += '</div>';
    html += '<div class="lb-global-stats">';
    html += '<span title="Prompts ' + label + '"><strong>' + msgs.toLocaleString() + '</strong> prompts</span>';
    if (interactions > msgs) html += '<span title="Total interactions (incl. sub-agents) ' + label + '" style="color:var(--accent-purple,#a78bfa)"><strong>' + interactions.toLocaleString() + '</strong> interactions</span>';
    html += '<span title="Agent hours ' + label + '"><strong>' + hours.toFixed(1) + 'h</strong> coded</span>';
    html += '<span title="API cost ' + label + '"><strong>$' + cost.toFixed(0) + '</strong> spent</span>';
    if (u.stats?.streak > 1) html += '<span class="lb-streak-badge" title="Coding streak — days in a row with activity">&#128293; ' + u.stats.streak + 'd streak</span>';
    if (autoRatio >= 5) html += '<span style="background:rgba(167,139,250,0.15);color:#a78bfa;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;white-space:nowrap" title="5x+ automation ratio">&#9889; GOD OF AUTOMATION</span>';
    html += '</div></div>';
  });
  board.innerHTML = html;
}

async function loadGlobalLeaderboard() {
  var board = document.getElementById('globalBoard');
  if (!board) return;
  try {
    var resp = await fetch('/api/leaderboard/remote');
    _lbRemoteData = await resp.json();
    // Show network stats
    var net = _lbRemoteData.network || {};
    var netEl = document.getElementById('networkStats');
    if (netEl) {
      netEl.innerHTML = '<span>' + (_lbRemoteData.totalUsers || 0) + ' on leaderboard</span>' +
        '<span>' + (net.totalInstalls || 0) + ' vibe coders online</span>' +
        '<span>' + (net.todayActive || 0) + ' active today</span>';
    }
    renderGlobalBoard();
  } catch { if (board) board.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">Could not load global leaderboard</div>'; }
}

async function githubConnect() {
  try {
    showToast('Starting GitHub auth...');
    var resp = await fetch('/api/github/device-code', { method: 'POST' });
    var data = await resp.json();
    if (data.error) { showToast('Error: ' + data.error); return; }

    // Show modal with code
    var modal = document.getElementById('githubAuthModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'githubAuthModal';
      modal.className = 'confirm-overlay';
      modal.style.display = 'flex';
      modal.innerHTML = '<div class="confirm-box" style="max-width:380px;text-align:center">' +
        '<h3>Connect GitHub</h3>' +
        '<p style="font-size:13px;margin:12px 0">Copy this code and enter it at:</p>' +
        '<div class="lb-auth-code" id="githubAuthCode"></div>' +
        '<a id="githubAuthLink" href="" target="_blank" class="lb-github-btn" style="display:inline-flex;margin:12px 0">Open GitHub</a>' +
        '<p style="font-size:12px;color:var(--text-muted)" id="githubAuthStatus">Waiting for authorization...</p>' +
        '<button class="btn-cancel" onclick="this.parentElement.parentElement.style.display=\'none\'" style="margin-top:8px">Cancel</button>' +
        '</div>';
      document.body.appendChild(modal);
    } else {
      modal.style.display = 'flex';
    }
    document.getElementById('githubAuthCode').textContent = data.user_code;
    document.getElementById('githubAuthLink').href = data.verification_uri;

    copyText(data.user_code, 'Copied GitHub code');

    // Poll for token
    var interval = (data.interval || 5) * 1000;
    var maxTries = Math.ceil((data.expires_in || 900) / (interval / 1000));
    for (var i = 0; i < maxTries; i++) {
      await new Promise(function(r) { setTimeout(r, interval); });
      if (modal.style.display === 'none') return; // cancelled
      try {
        var pollResp = await fetch('/api/github/poll-token', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ device_code: data.device_code })
        });
        var pollData = await pollResp.json();
        if (pollData.status === 'ok') {
          modal.style.display = 'none';
          showToast('Connected as @' + pollData.profile.username);
          render();
          return;
        } else if (pollData.status === 'expired') {
          document.getElementById('githubAuthStatus').textContent = 'Code expired. Try again.';
          return;
        }
      } catch {}
    }
  } catch (e) { showToast('Auth error: ' + e.message); }
}

async function githubLogout() {
  await fetch('/api/github/logout', { method: 'POST' });
  showToast('GitHub disconnected');
  render();
}

async function renderLeaderboard(container) {
  container.innerHTML = '<div class="loading">Loading stats...</div>';
  try {
    var resp = await fetch('/api/leaderboard');
    var data = await resp.json();
    var ghResp = await fetch('/api/github/profile');
    var gh = await ghResp.json();

    // Guard: if user navigated away during fetch, don't overwrite
    if (currentView !== 'leaderboard') return;

    var html = '<div class="leaderboard-container">';

    // Header card — GitHub profile or anonymous
    html += '<div class="lb-hero">';
    if (gh.authenticated) {
      html += '<img class="lb-avatar-img" src="' + escHtml(gh.avatar) + '" alt="">';
      html += '<div class="lb-hero-info">';
      html += '<div class="lb-name">' + escHtml(gh.name || gh.username) + '</div>';
      html += '<div class="lb-username">@' + escHtml(gh.username) + '</div>';
      html += '<div class="lb-streak">&#128293; ' + data.streak + ' day streak — coding days in a row</div>';
      html += '</div>';
      html += '<button class="toolbar-btn" style="margin-left:auto;font-size:11px" onclick="githubLogout()">Disconnect</button>';
    } else {
      html += '<div class="lb-avatar">' + escHtml(data.anon.name.split('-').map(function(w){return w[0].toUpperCase()}).join('')) + '</div>';
      html += '<div class="lb-hero-info">';
      html += '<div class="lb-name">' + escHtml(data.anon.name) + '</div>';
      html += '<div class="lb-streak">&#128293; ' + data.streak + ' day streak — coding days in a row</div>';
      html += '</div>';
      html += '<button class="lb-github-btn" onclick="githubConnect()"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg> Connect GitHub</button>';
    }
    html += '</div>';

    // Today stats
    html += '<div class="lb-section-title">Today</div>';
    html += '<div class="lb-stats-grid">';
    html += '<div class="lb-stat"><div class="lb-stat-value">' + data.today.messages + '</div><div class="lb-stat-label">prompts</div></div>';
    html += '<div class="lb-stat"><div class="lb-stat-value">' + data.today.hours.toFixed(1) + 'h</div><div class="lb-stat-label">agent time</div></div>';
    html += '<div class="lb-stat"><div class="lb-stat-value">' + data.today.sessions + '</div><div class="lb-stat-label">sessions</div></div>';
    html += '<div class="lb-stat"><div class="lb-stat-value">$' + data.today.cost.toFixed(2) + '</div><div class="lb-stat-label">cost</div></div>';
    html += '</div>';

    // All time
    html += '<div class="lb-section-title">All Time</div>';
    html += '<div class="lb-stats-grid">';
    html += '<div class="lb-stat"><div class="lb-stat-value">' + data.totals.messages.toLocaleString() + '</div><div class="lb-stat-label">prompts</div></div>';
    if (data.totals.interactions > data.totals.messages) {
      html += '<div class="lb-stat"><div class="lb-stat-value" style="color:var(--accent-purple,#a78bfa)">' + data.totals.interactions.toLocaleString() + '</div><div class="lb-stat-label">interactions</div></div>';
    }
    html += '<div class="lb-stat"><div class="lb-stat-value">' + data.totals.hours.toFixed(0) + 'h</div><div class="lb-stat-label">agent time</div></div>';
    html += '<div class="lb-stat"><div class="lb-stat-value">' + data.totals.sessions + '</div><div class="lb-stat-label">sessions</div></div>';
    html += '<div class="lb-stat"><div class="lb-stat-value">$' + data.totals.cost.toFixed(2) + '</div><div class="lb-stat-label">cost</div></div>';
    html += '</div>';

    // Agents breakdown
    html += '<div class="lb-section-title">Agents</div>';
    html += '<div class="lb-agents">';
    var agentEntries = Object.entries(data.agents).sort(function(a,b){return b[1]-a[1]});
    agentEntries.forEach(function(e) {
      var pct = data.totals.sessions > 0 ? Math.round(e[1] / data.totals.sessions * 100) : 0;
      html += '<div class="lb-agent-row">';
      html += '<span class="tool-badge tool-' + e[0] + '">' + escHtml(getToolLabel(e[0], true)) + '</span>';
      html += '<div class="lb-agent-bar"><div class="lb-agent-bar-fill" style="width:' + pct + '%"></div></div>';
      html += '<span class="lb-agent-count">' + e[1] + ' (' + pct + '%)</span>';
      html += '</div>';
    });
    html += '</div>';

    // Daily chart (last 14 days)
    html += '<div class="lb-section-title">Last 14 Days</div>';
    html += '<div class="lb-daily-chart">';
    var last14 = data.daily.slice(0, 14).reverse();
    var maxMsg = Math.max.apply(null, last14.map(function(d){return d.messages})) || 1;
    last14.forEach(function(d) {
      var h = Math.max(4, Math.round(d.messages / maxMsg * 120));
      var dayLabel = d.date.slice(5); // MM-DD
      html += '<div class="lb-bar-col">';
      html += '<div class="lb-bar" style="height:' + h + 'px" title="' + d.date + ': ' + d.messages + ' msgs, ' + d.hours.toFixed(1) + 'h, $' + d.cost.toFixed(2) + '"></div>';
      html += '<div class="lb-bar-label">' + dayLabel + '</div>';
      html += '</div>';
    });
    html += '</div>';

    // Sync button + Global leaderboard
    if (gh.authenticated) {
      html += '<div class="lb-sync-bar">';
      html += '<button class="lb-sync-btn" onclick="syncLeaderboard()" id="syncBtn">Sync Stats</button>';
      html += '</div>';
    }

    // Global leaderboard
    // Network stats
    html += '<div class="lb-network" id="networkStats"><span>Loading network...</span></div>';

    // Global leaderboard with tabs
    html += '<div class="lb-section-title">Global Leaderboard</div>';
    html += '<div class="lb-tabs">';
    html += '<button class="lb-tab active" onclick="switchLbTab(\'today\',this)">Today</button>';
    html += '<button class="lb-tab" onclick="switchLbTab(\'week\',this)">Week</button>';
    html += '<button class="lb-tab" onclick="switchLbTab(\'alltime\',this)">All Time</button>';
    html += '<span style="margin-left:auto;display:flex;gap:4px;">';
    html += '<button class="lb-tab lb-sort' + (_lbSortBy==='messages'?' active':'') + '" onclick="switchLbSort(\'messages\',this)" style="font-size:11px;padding:4px 8px;">Msgs</button>';
    html += '<button class="lb-tab lb-sort' + (_lbSortBy==='hours'?' active':'') + '" onclick="switchLbSort(\'hours\',this)" style="font-size:11px;padding:4px 8px;">Hours</button>';
    html += '<button class="lb-tab lb-sort' + (_lbSortBy==='cost'?' active':'') + '" onclick="switchLbSort(\'cost\',this)" style="font-size:11px;padding:4px 8px;">Cost</button>';
    html += '</span>';
    html += '</div>';
    html += '<div id="globalBoard"><div class="loading">Loading...</div></div>';

    html += '<div class="lb-footer">Active days: ' + data.activeDays + ' | <a href="https://leaderboard.neuraldeep.ru" target="_blank" style="color:var(--accent-blue)">View public leaderboard</a></div>';
    html += '</div>';

    container.innerHTML = html;

    // Load global leaderboard async
    loadGlobalLeaderboard();
  } catch (e) {
    container.innerHTML = '<div class="empty-state">Failed to load stats: ' + escHtml(e.message) + '</div>';
  }
}
