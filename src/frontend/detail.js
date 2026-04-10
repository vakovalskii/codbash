// ── Detail panel ───────────────────────────────────────────────

async function openDetail(s) {
  var panel = document.getElementById('detailPanel');
  var overlay = document.getElementById('overlay');
  var title = document.getElementById('detailTitle');
  var body = document.getElementById('detailBody');
  if (!panel || !body) return;

  title.textContent = escHtml(getProjectName(s.project)) + ' / ' + s.id.slice(0, 12);

  var cost = estimateCost(s.file_size);
  var costStr = cost > 0 ? '~$' + cost.toFixed(2) : '';
  var isStarred = stars.indexOf(s.id) >= 0;
  var sessionTags = tags[s.id] || [];
  var terminal = localStorage.getItem('codedash-terminal') || '';

  var infoHtml = '<div class="detail-info">';
  // AI Title row
  var aiTitle = sessionTitles[s.id];
  var escProject = escHtml(s.project || '').replace(/'/g, "\\'");
  if (aiTitle) {
    infoHtml += '<div class="detail-row"><span class="detail-label">AI Title</span><span style="font-weight:600;flex:1">' + escHtml(aiTitle) + '</span><button class="toolbar-btn" style="font-size:10px;padding:1px 6px" onclick="generateTitle(\'' + s.id + '\',\'' + escProject + '\')" title="Regenerate">&#8635;</button></div>';
  } else if (s.has_detail) {
    infoHtml += '<div class="detail-row"><span class="detail-label">AI Title</span><button class="toolbar-btn" style="font-size:11px;padding:2px 8px" onclick="generateTitle(\'' + s.id + '\',\'' + escProject + '\')">Generate</button></div>';
  }
  var detailToolLabel = s.tool === 'claude-ext' ? 'claude ext' : s.tool;
  infoHtml += '<div class="detail-row"><span class="detail-label">Tool</span><span class="tool-badge tool-' + s.tool + '">' + escHtml(detailToolLabel) + '</span></div>';
  infoHtml += '<div class="detail-row"><span class="detail-label">Project</span><span>' + escHtml(s.project_short || s.project || '') + '</span></div>';
  infoHtml += '<div class="detail-git-info" id="detail-git-info"></div>';
  infoHtml += '<div class="detail-row"><span class="detail-label">Session ID</span><span class="mono">' + escHtml(s.id) + '</span></div>';
  infoHtml += '<div class="detail-row"><span class="detail-label">First seen</span><span>' + escHtml(s.first_time || '') + '</span></div>';
  infoHtml += '<div class="detail-row"><span class="detail-label">Last seen</span><span>' + escHtml(s.last_time || '') + ' (' + timeAgo(s.last_ts) + ')</span></div>';
  infoHtml += '<div class="detail-row"><span class="detail-label">Messages</span><span>' + (s.detail_messages || s.messages || 0) + '</span></div>';
  infoHtml += '<div class="detail-row"><span class="detail-label">File size</span><span>' + formatBytes(s.file_size) + '</span></div>';
  if (costStr) {
    infoHtml += '<div class="detail-row"><span class="detail-label">Est. cost</span><span class="cost-badge" id="detail-cost">' + costStr + '</span></div>';
  }
  infoHtml += '<div class="detail-row" id="detail-real-cost" style="display:none"><span class="detail-label">Real cost</span><span></span></div>';
  // Tags
  infoHtml += '<div class="detail-row"><span class="detail-label">Tags</span><span class="card-tags">';
  sessionTags.forEach(function(t) {
    infoHtml += '<span class="tag-pill tag-' + escHtml(t) + '" onclick="removeTag(\'' + s.id + '\',\'' + t + '\')">' + escHtml(t) + ' &times;</span>';
  });
  infoHtml += '<button class="tag-add-btn" onclick="showTagDropdown(event, \'' + s.id + '\')">+</button>';
  infoHtml += '</span></div>';
  // MCP servers row
  if (s.mcp_servers && s.mcp_servers.length > 0) {
    infoHtml += '<div class="detail-row"><span class="detail-label">MCP</span><span style="display:flex;gap:4px;flex-wrap:wrap">';
    s.mcp_servers.forEach(function(m) {
      infoHtml += '<span class="tool-badge badge-mcp">' + escHtml(m) + '</span>';
    });
    infoHtml += '</span></div>';
  }
  // Skills row
  if (s.skills && s.skills.length > 0) {
    infoHtml += '<div class="detail-row"><span class="detail-label">Skills</span><span style="display:flex;gap:4px;flex-wrap:wrap">';
    s.skills.forEach(function(sk) {
      infoHtml += '<span class="tool-badge badge-skill">' + escHtml(sk) + '</span>';
    });
    infoHtml += '</span></div>';
  }
  infoHtml += '</div>';

  // Action buttons
  infoHtml += '<div class="detail-actions">';
  // Tool-specific launch buttons
  if (s.tool === 'cursor') {
    infoHtml += '<button class="launch-btn" style="background:#4a9eff" onclick="openInCursor(\'' + escHtml(s.project || '') + '\')">Open in Cursor</button>';
  } else if (activeSessions[s.id]) {
    infoHtml += '<button class="launch-btn" style="background:var(--accent-green);color:#000" onclick="focusSession(\'' + s.id + '\')">Focus Terminal</button>';
  } else {
    infoHtml += '<button class="launch-btn" onclick="launchSession(\'' + s.id + '\',\'' + escHtml(s.tool) + '\',\'' + escHtml(s.project || '') + '\')">Resume</button>';
    if (s.tool === 'claude') {
      infoHtml += '<button class="launch-btn" style="background:var(--accent-orange);color:#000" onclick="launchDangerous(\'' + s.id + '\',\'' + escHtml(s.project || '') + '\')" title="--dangerously-skip-permissions">Resume (skip perms)</button>';
    }
  }
  infoHtml += '<button class="launch-btn btn-secondary" onclick="copyResume(\'' + s.id + '\',\'' + escHtml(s.tool) + '\')">Copy Command</button>';
  if (s.has_detail) {
    infoHtml += '<button class="launch-btn btn-secondary" onclick="closeDetail();openReplay(\'' + s.id + '\',\'' + escHtml(s.project || '') + '\')">Replay</button>';
    infoHtml += '<button class="launch-btn btn-secondary" onclick="exportMd(\'' + s.id + '\',\'' + escHtml(s.project || '') + '\')">Export MD</button>';
    var convertTarget = s.tool === 'codex' ? 'claude' : 'codex';
    infoHtml += '<button class="launch-btn btn-secondary" onclick="convertTo(\'' + s.id + '\',\'' + escHtml(s.project || '') + '\',\'' + convertTarget + '\')">Convert to ' + convertTarget + '</button>';
    infoHtml += '<button class="launch-btn btn-secondary" onclick="downloadHandoff(\'' + s.id + '\',\'' + escHtml(s.project || '') + '\')">Handoff</button>';
  }
  infoHtml += '<button class="star-btn detail-star' + (isStarred ? ' active' : '') + '" onclick="toggleStar(\'' + s.id + '\')">&#9733; ' + (isStarred ? 'Starred' : 'Star') + '</button>';
  infoHtml += '<button class="launch-btn btn-delete" onclick="showDeleteConfirm(\'' + s.id + '\',\'' + escHtml(s.project || '') + '\')">Delete</button>';
  infoHtml += '</div>';

  body.innerHTML = infoHtml + '<div class="detail-messages"><div class="loading">Loading messages...</div></div><div class="detail-commits"></div>';

  panel.classList.add('open');
  overlay.classList.add('open');

  // Load messages
  if (s.has_detail) {
    try {
      var resp = await fetch('/api/session/' + s.id + '?project=' + encodeURIComponent(s.project || ''));
      var data = await resp.json();
      var msgContainer = body.querySelector('.detail-messages');
      if (data.messages && data.messages.length > 0) {
        var msgsHtml = '<h3>Conversation</h3>';
        data.messages.forEach(function(m) {
          var roleClass = m.role === 'user' ? 'msg-user' : 'msg-assistant';
          var roleLabel = m.role === 'user' ? 'You' : 'Assistant';
          var hasTools = m.tools && m.tools.length > 0;
          msgsHtml += '<div class="message ' + roleClass + (hasTools ? ' has-tools' : '') + '">';
          msgsHtml += '<div class="msg-inner">';
          msgsHtml += '<div class="msg-role">' + roleLabel + '</div>';
          msgsHtml += '<div class="msg-content">' + escHtml(m.content) + '</div>';
          msgsHtml += '</div>';
          if (hasTools) {
            msgsHtml += '<div class="msg-tools">';
            m.tools.forEach(function(t) {
              if (t.type === 'mcp') {
                msgsHtml += '<span class="tool-badge badge-mcp">' + escHtml(t.tool) + '</span>';
              } else if (t.type === 'skill') {
                msgsHtml += '<span class="tool-badge badge-skill">' + escHtml(t.skill) + '</span>';
              }
            });
            msgsHtml += '</div>';
          }
          msgsHtml += '</div>';
        });
        msgContainer.innerHTML = msgsHtml;
      } else {
        msgContainer.innerHTML = '<div class="empty-state">No messages found in detail file.</div>';
      }
    } catch (e) {
      body.querySelector('.detail-messages').innerHTML = '<div class="empty-state">Failed to load messages.</div>';
    }
  } else {
    body.querySelector('.detail-messages').innerHTML = '<div class="empty-state">No detail file available for this session.</div>';
  }

  // Load real cost
  loadRealCost(s.id, s.project || '').then(function(costData) {
    if (!costData || !costData.cost) return;
    var row = document.getElementById('detail-real-cost');
    if (row) {
      row.style.display = '';
      var cacheStr = '';
      if ((costData.cacheReadTokens || 0) + (costData.cacheCreateTokens || 0) > 0)
        cacheStr = ' / ' + formatTokens((costData.cacheReadTokens||0) + (costData.cacheCreateTokens||0)) + ' cache';
      row.querySelector('span:last-child').innerHTML =
        '<span class="cost-badge" style="background:rgba(74,222,128,0.2);color:var(--accent-green)">$' + costData.cost.toFixed(2) + '</span>' +
        ' <span style="font-size:11px;color:var(--text-muted)">' +
        formatTokens(costData.inputTokens) + ' in / ' + formatTokens(costData.outputTokens) + ' out' + cacheStr +
        (costData.model ? ' (' + costData.model + ')' : '') + '</span>';
    }
    // Update estimated badge to show it was estimated
    var estBadge = document.getElementById('detail-cost');
    if (estBadge) estBadge.style.opacity = '0.5';
  });

  // Load git info
  if (s.project) {
    fetch('/api/git-info?project=' + encodeURIComponent(s.project))
      .then(function(r) { return r.json(); })
      .then(function(git) {
        var el = document.getElementById('detail-git-info');
        if (!el || git.error) return;
        var html = '';
        if (git.branch) {
          html += '<div class="detail-row"><span class="detail-label">Branch</span><span class="git-branch">' + escHtml(git.branch);
          if (git.isDirty) html += ' <span class="git-dirty">*</span>';
          html += '</span></div>';
        }
        if (git.lastCommit) {
          html += '<div class="detail-row"><span class="detail-label">Last commit</span><span class="mono" style="font-size:11px">';
          if (git.lastCommitHash) html += '<span style="color:var(--accent-blue)">' + escHtml(git.lastCommitHash) + '</span> ';
          html += escHtml(git.lastCommit) + '</span></div>';
        }
        if (git.remoteUrl) {
          var displayUrl = git.remoteUrl.replace(/\.git$/, '').replace(/^https?:\/\//, '').replace(/^git@([^:]+):/, '$1/');
          html += '<div class="detail-row"><span class="detail-label">Remote</span><span class="mono" style="font-size:11px">' + escHtml(displayUrl) + '</span></div>';
        }
        el.innerHTML = html;
      }).catch(function() {});
  }

  // Load git commits
  if (s.project) {
    var commits = await loadGitCommits(s.project, s.first_ts, s.last_ts);
    var commitsContainer = body.querySelector('.detail-commits');
    if (commits && commits.length > 0) {
      var cHtml = '<h3>Related Commits</h3><div class="commits-list">';
      commits.forEach(function(c) {
        cHtml += '<div class="commit-item">';
        cHtml += '<span class="commit-hash">' + escHtml(c.hash) + '</span>';
        cHtml += '<span class="commit-msg">' + escHtml(c.message) + '</span>';
        cHtml += '</div>';
      });
      cHtml += '</div>';
      commitsContainer.innerHTML = cHtml;
    }
  }
}

function closeDetail() {
  var panel = document.getElementById('detailPanel');
  var overlay = document.getElementById('overlay');
  if (panel) panel.classList.remove('open');
  if (overlay) overlay.classList.remove('open');
}

// ── Detail panel resize ───────────────────────────────────────
(function initDetailResize() {
  var handle = document.getElementById('detailResizeHandle');
  var panel = document.getElementById('detailPanel');
  if (!handle || !panel) return;

  var startX, startW;

  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    startX = e.clientX;
    startW = panel.offsetWidth;
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', onStop);
    panel.style.transition = 'none';
  });

  function onDrag(e) {
    var diff = startX - e.clientX;
    var newW = Math.max(320, Math.min(window.innerWidth * 0.85, startW + diff));
    panel.style.width = newW + 'px';
  }

  function onStop() {
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', onStop);
    panel.style.transition = '';
    localStorage.setItem('codedash-detail-width', panel.style.width);
  }

  // Restore saved width
  var saved = localStorage.getItem('codedash-detail-width');
  if (saved) panel.style.width = saved;
})();

async function loadGitCommits(project, fromTs, toTs) {
  try {
    var resp = await fetch('/api/git-commits?project=' + encodeURIComponent(project) + '&from=' + fromTs + '&to=' + toTs);
    return await resp.json();
  } catch (e) {
    return [];
  }
}

function launchDangerous(sessionId, project) {
  launchSession(sessionId, 'claude', project, ['skip-permissions']);
}

function launchSession(sessionId, tool, project, flags) {
  var terminal = localStorage.getItem('codedash-terminal') || '';
  fetch('/api/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: sessionId,
      tool: tool,
      flags: flags || [],
      project: project,
      terminal: terminal
    })
  }).then(function(resp) {
    return resp.json();
  }).then(function(data) {
    if (data.ok) showToast('Launched in terminal');
    else showToast('Launch failed: ' + (data.error || 'unknown'));
  }).catch(function() {
    showToast('Launch failed');
  });
}

function copyResume(sessionId, tool) {
  var s = allSessions.find(function(x) { return x.id === sessionId; });
  var cmd;
  if (tool === 'codex') {
    cmd = 'codex resume ' + sessionId;
  } else if (tool === 'cursor') {
    cmd = 'cursor ' + (s && s.project ? '"' + s.project + '"' : '.');
  } else {
    cmd = 'claude --resume ' + sessionId;
  }
  copyText(cmd, 'Copied: ' + cmd);
}

function exportMd(sessionId, project) {
  window.open('/api/session/' + sessionId + '/export?project=' + encodeURIComponent(project));
}

// ── Session Replay ────────────────────────────────────────────

async function openReplay(sessionId, project) {
  var content = document.getElementById('content');
  content.innerHTML = '<div class="loading">Loading replay...</div>';

  try {
    var resp = await fetch('/api/replay/' + sessionId + '?project=' + encodeURIComponent(project));
    var data = await resp.json();

    if (!data.messages || data.messages.length === 0) {
      content.innerHTML = '<div class="empty-state">No messages to replay.</div>';
      return;
    }

    var msgs = data.messages;
    var html = '<div class="replay-container">';
    html += '<div class="replay-header">';
    html += '<button class="launch-btn btn-secondary" onclick="setView(\'sessions\')">Back</button>';
    html += '<span class="replay-title">Session Replay — ' + sessionId.slice(0, 12) + '</span>';
    html += '<span class="replay-duration">' + formatDuration(data.duration) + '</span>';
    html += '</div>';

    // Timeline slider
    html += '<div class="replay-controls">';
    html += '<button class="replay-play-btn" id="replayPlayBtn" onclick="toggleReplayPlay()">&#9654;</button>';
    html += '<input type="range" class="replay-slider" id="replaySlider" min="0" max="' + (msgs.length - 1) + '" value="0" oninput="seekReplay(this.value)">';
    html += '<span class="replay-counter" id="replayCounter">1 / ' + msgs.length + '</span>';
    html += '</div>';

    // Messages area
    html += '<div class="replay-messages" id="replayMessages"></div>';
    html += '</div>';

    content.innerHTML = html;

    // Store messages for replay
    window._replayMsgs = msgs;
    window._replayPos = 0;
    window._replayPlaying = false;
    window._replayTimer = null;
    seekReplay(0);
  } catch (e) {
    content.innerHTML = '<div class="empty-state">Failed to load replay.</div>';
  }
}

function seekReplay(pos) {
  pos = parseInt(pos);
  var msgs = window._replayMsgs;
  if (!msgs) return;
  window._replayPos = pos;

  var container = document.getElementById('replayMessages');
  var slider = document.getElementById('replaySlider');
  var counter = document.getElementById('replayCounter');
  if (!container) return;

  var html = '';
  for (var i = 0; i <= pos && i < msgs.length; i++) {
    var m = msgs[i];
    var cls = m.role === 'user' ? 'preview-user' : 'preview-assistant';
    var label = m.role === 'user' ? 'You' : 'AI';
    var time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '';
    var isLatest = i === pos;
    html += '<div class="replay-msg ' + cls + (isLatest ? ' replay-latest' : '') + '">';
    html += '<div class="replay-msg-header"><span class="preview-role">' + label + '</span><span class="replay-time">' + time + '</span></div>';
    html += '<div class="replay-msg-content">' + escHtml(m.content) + '</div>';
    html += '</div>';
  }
  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;

  if (slider) slider.value = pos;
  if (counter) counter.textContent = (pos + 1) + ' / ' + msgs.length;
}

function toggleReplayPlay() {
  var btn = document.getElementById('replayPlayBtn');
  if (window._replayPlaying) {
    window._replayPlaying = false;
    clearInterval(window._replayTimer);
    if (btn) btn.innerHTML = '&#9654;';
  } else {
    window._replayPlaying = true;
    if (btn) btn.innerHTML = '&#9646;&#9646;';
    window._replayTimer = setInterval(function() {
      var next = window._replayPos + 1;
      if (next >= window._replayMsgs.length) {
        toggleReplayPlay();
        return;
      }
      seekReplay(next);
    }, 1500);
  }
}

function formatDuration(ms) {
  if (!ms) return '';
  var s = Math.floor(ms / 1000);
  var m = Math.floor(s / 60);
  var h = Math.floor(m / 60);
  if (h > 0) return h + 'h ' + (m % 60) + 'm';
  if (m > 0) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}
