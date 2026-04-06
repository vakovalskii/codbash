// ── codedash frontend ──────────────────────────────────────────
// Plain browser JS, no modules, no build step.

// ── State ──────────────────────────────────────────────────────

let allSessions = [];
let filteredSessions = [];
let currentView = 'sessions';  // sessions, projects, timeline, activity, starred
let grouped = true;
let layout = localStorage.getItem('codedash-layout') || 'grid'; // 'grid' or 'list'
let searchQuery = '';
let toolFilter = null;  // null, 'claude', 'codex'
let tagFilter = '';
let dateFrom = '';
let dateTo = '';
let selectMode = false;
let selectedIds = new Set();
let focusedIndex = -1;
let availableTerminals = [];
let pendingDelete = null;
let activeSessions = {}; // sessionId -> {status, cpu, memoryMB, pid}
let renderLimit = 60; // pagination — render at most this many cards
const RENDER_PAGE_SIZE = 60;

// Persisted in localStorage
let stars = JSON.parse(localStorage.getItem('codedash-stars') || '[]');
let tags = JSON.parse(localStorage.getItem('codedash-tags') || '{}');
let sessionTitles = JSON.parse(localStorage.getItem('codedash-titles') || '{}');
let showAITitles = localStorage.getItem('codedash-ai-titles') !== 'false';

// ── Color palette for projects ─────────────────────────────────

const PROJECT_COLORS = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
  '#f43f5e', '#ef4444', '#f97316', '#eab308', '#84cc16',
  '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6', '#2563eb',
  '#7c3aed', '#c026d3', '#e11d48', '#ea580c', '#65a30d',
];
const projectColorMap = {};
let colorIdx = 0;

function getProjectColor(project) {
  if (!project) return '#6b7280';
  if (!projectColorMap[project]) {
    projectColorMap[project] = PROJECT_COLORS[colorIdx % PROJECT_COLORS.length];
    colorIdx++;
  }
  return projectColorMap[project];
}

function getProjectName(fullPath) {
  if (!fullPath) return 'unknown';
  const cleaned = fullPath.replace(/\/+$/, '');
  const parts = cleaned.split('/');
  return parts[parts.length - 1] || 'unknown';
}

// ── Utilities ──────────────────────────────────────────────────

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const now = Date.now();
  const ts = typeof dateStr === 'number' ? dateStr : new Date(dateStr).getTime();
  const diff = now - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  if (days < 30) return days + 'd ago';
  const months = Math.floor(days / 30);
  if (months < 12) return months + 'mo ago';
  return Math.floor(months / 12) + 'y ago';
}

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return (bytes || 0) + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function estimateCost(fileSize) {
  if (!fileSize) return 0;
  var tokens = fileSize / 4;
  // Quick card badge estimate (Sonnet 4.6: $3/M in, $15/M out)
  return tokens * 0.3 * (3.0 / 1e6) + tokens * 0.7 * (15.0 / 1e6);
}

async function loadRealCost(sessionId, project) {
  try {
    var resp = await fetch('/api/cost/' + sessionId + '?project=' + encodeURIComponent(project));
    return await resp.json();
  } catch (e) { return null; }
}

// ── Tag system ─────────────────────────────────────────────────

const TAG_OPTIONS = ['bug', 'feature', 'research', 'infra', 'deploy', 'review'];

function showTagDropdown(event, sessionId) {
  event.stopPropagation();
  document.querySelectorAll('.tag-dropdown').forEach(function(el) { el.remove(); });
  var dd = document.createElement('div');
  dd.className = 'tag-dropdown';
  var existingTags = tags[sessionId] || [];
  dd.innerHTML = TAG_OPTIONS.map(function(t) {
    var has = existingTags.indexOf(t) >= 0;
    return '<div class="tag-dropdown-item" onclick="event.stopPropagation();' +
      (has ? 'removeTag' : 'addTag') + '(\'' + sessionId + '\',\'' + t + '\')">' +
      (has ? '&#10003; ' : '') + t + '</div>';
  }).join('');

  // Position near the button
  var rect = event.target.getBoundingClientRect();
  dd.style.top = (rect.bottom + 4) + 'px';
  dd.style.left = rect.left + 'px';

  document.body.appendChild(dd);
  setTimeout(function() {
    document.addEventListener('click', function() { dd.remove(); }, { once: true });
  }, 0);
}

function addTag(sessionId, tag) {
  if (!tags[sessionId]) tags[sessionId] = [];
  if (!tags[sessionId].includes(tag)) tags[sessionId].push(tag);
  localStorage.setItem('codedash-tags', JSON.stringify(tags));
  document.querySelectorAll('.tag-dropdown').forEach(function(el) { el.remove(); });
  render();
}

function removeTag(sessionId, tag) {
  if (tags[sessionId]) {
    tags[sessionId] = tags[sessionId].filter(function(t) { return t !== tag; });
    if (!tags[sessionId].length) delete tags[sessionId];
    localStorage.setItem('codedash-tags', JSON.stringify(tags));
    render();
  }
}

// ── Stars ──────────────────────────────────────────────────────

function toggleStar(id) {
  var idx = stars.indexOf(id);
  if (idx >= 0) stars.splice(idx, 1);
  else stars.push(id);
  localStorage.setItem('codedash-stars', JSON.stringify(stars));
  render();
}

// ── AI Titles ─────────────────────────────────────────────────

function toggleAITitles(checked) {
  showAITitles = checked;
  localStorage.setItem('codedash-ai-titles', checked ? 'true' : 'false');
  render();
}

function openLLMSettings() {
  document.getElementById('llmSettingsOverlay').style.display = 'flex';
  fetch('/api/llm-config').then(function(r) { return r.json(); }).then(function(c) {
    document.getElementById('llmUrl').value = c.url || '';
    document.getElementById('llmApiKey').value = c.apiKey || '';
    document.getElementById('llmModel').value = c.model || '';
  });
}

function closeLLMSettings() {
  document.getElementById('llmSettingsOverlay').style.display = 'none';
}

function saveLLMSettings() {
  var config = {
    url: document.getElementById('llmUrl').value.trim(),
    apiKey: document.getElementById('llmApiKey').value.trim(),
    model: document.getElementById('llmModel').value.trim(),
  };
  fetch('/api/llm-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  }).then(function() {
    closeLLMSettings();
    showToast('LLM settings saved');
  });
}

function testLLMConnection() {
  // Generate title for the first available session as a test
  var testSession = allSessions.find(function(s) { return s.has_detail && s.messages > 2; });
  if (!testSession) { showToast('No sessions to test with'); return; }
  showToast('Testing LLM connection...');
  fetch('/api/generate-title', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: testSession.id, project: testSession.project }),
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.ok) {
      showToast('OK: "' + d.title + '"');
    } else {
      showToast('Error: ' + d.error);
    }
  }).catch(function(e) { showToast('Connection failed: ' + e.message); });
}

function generateTitle(sessionId, project) {
  fetch('/api/generate-title', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: sessionId, project: project }),
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.ok && d.title) {
      sessionTitles[sessionId] = d.title;
      localStorage.setItem('codedash-titles', JSON.stringify(sessionTitles));
      render();
    } else {
      showToast('Title generation failed: ' + (d.error || 'unknown'));
    }
  }).catch(function(e) { showToast('Error: ' + e.message); });
}

function generateAllTitles() {
  var sessions = filteredSessions.filter(function(s) {
    return s.has_detail && s.messages > 2 && !sessionTitles[s.id];
  }).slice(0, 20); // batch of 20
  if (!sessions.length) { showToast('All sessions already have titles'); return; }
  showToast('Generating titles for ' + sessions.length + ' sessions...');
  var done = 0;
  sessions.forEach(function(s) {
    fetch('/api/generate-title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: s.id, project: s.project }),
    }).then(function(r) { return r.json(); }).then(function(d) {
      done++;
      if (d.ok && d.title) {
        sessionTitles[s.id] = d.title;
        localStorage.setItem('codedash-titles', JSON.stringify(sessionTitles));
      }
      if (done === sessions.length) {
        render();
        showToast('Generated ' + done + ' titles');
      }
    }).catch(function() { done++; });
  });
}

// ── Data loading ───────────────────────────────────────────────

async function loadSessions() {
  try {
    var resp = await fetch('/api/sessions');
    allSessions = await resp.json();
    applyFilters();
  } catch (e) {
    document.getElementById('content').innerHTML = '<div class="empty-state">Failed to load sessions. Is the server running?</div>';
  }
}

function refreshData() {
  loadSessions();
  showToast('Refreshed');
}

async function loadTerminals() {
  try {
    var resp = await fetch('/api/terminals');
    availableTerminals = await resp.json();
    var sel = document.getElementById('terminalSelect');
    if (!sel) return;
    sel.innerHTML = '';
    var saved = localStorage.getItem('codedash-terminal') || '';
    availableTerminals.forEach(function(t) {
      if (!t.available) return;
      var opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      if (t.id === saved) opt.selected = true;
      sel.appendChild(opt);
    });
    if (!saved && availableTerminals.length > 0) {
      var first = availableTerminals.find(function(t) { return t.available; });
      if (first) sel.value = first.id;
    }
  } catch (e) {
    // terminals not available
  }
}

function saveTerminalPref(val) {
  localStorage.setItem('codedash-terminal', val);
}

// ── Active sessions polling ───────────────────────────────────

var _prevActiveKey = '';

async function pollActiveSessions() {
  try {
    var resp = await fetch('/api/active');
    var data = await resp.json();

    // Build new state
    var newActive = {};
    data.forEach(function(a) {
      if (a.sessionId) newActive[a.sessionId] = a;
    });

    // Check if anything changed — skip DOM work if not
    var newKey = data.map(function(a) { return (a.sessionId || a.pid) + ':' + a.status; }).sort().join(',');
    if (newKey === _prevActiveKey) return;
    _prevActiveKey = newKey;

    activeSessions = newActive;

    // Only touch cards that changed
    document.querySelectorAll('.card').forEach(function(card) {
      var id = card.getAttribute('data-id');
      var existing = card.querySelector('.live-badge');
      var parent = card.parentElement;
      var wasActive = parent && parent.classList.contains('card-live-wrap');
      var isActive = !!activeSessions[id];

      // No change — skip
      if (!wasActive && !isActive && !existing) return;

      // Remove old badge
      if (existing) existing.remove();

      // Remove wrapper if no longer active
      if (wasActive && !isActive) {
        parent.replaceWith(card);
        card.style.border = '';
        return;
      }

      if (isActive) {
        var a = activeSessions[id];

        // Add badge
        var badge = document.createElement('span');
        badge.className = 'live-badge live-' + a.status;
        badge.textContent = a.status === 'waiting' ? 'WAITING' : 'LIVE';
        badge.title = 'PID ' + a.pid + ' | CPU ' + a.cpu.toFixed(1) + '% | ' + a.memoryMB + 'MB';
        var top = card.querySelector('.card-top');
        if (top) top.insertBefore(badge, top.firstChild);

        // Wrapper
        if (wasActive) {
          parent.className = 'card-live-wrap' + (a.status === 'waiting' ? ' live-waiting' : '');
          parent.style.setProperty('--live-color', a.status === 'waiting'
            ? 'rgba(251, 191, 36, 0.5)' : 'rgba(74, 222, 128, 0.7)');
        } else {
          var wrap = document.createElement('div');
          wrap.className = 'card-live-wrap' + (a.status === 'waiting' ? ' live-waiting' : '');
          wrap.style.setProperty('--live-color', a.status === 'waiting'
            ? 'rgba(251, 191, 36, 0.5)' : 'rgba(74, 222, 128, 0.7)');
          var borderDiv = document.createElement('div');
          borderDiv.className = 'live-border';
          card.parentNode.insertBefore(wrap, card);
          wrap.appendChild(borderDiv);
          wrap.appendChild(card);
        }
      }
    });
  } catch {}
}

var activeInterval = null;
function startActivePolling() {
  pollActiveSessions();
  activeInterval = setInterval(pollActiveSessions, 5000);
}
function stopActivePolling() {
  if (activeInterval) clearInterval(activeInterval);
}

// ── Trigram search ─────────────────────────────────────────────

function trigrams(str) {
  var s = '  ' + str.toLowerCase() + '  ';
  var t = {};
  for (var i = 0; i < s.length - 2; i++) {
    var tri = s.substring(i, i + 3);
    t[tri] = (t[tri] || 0) + 1;
  }
  return t;
}

function trigramScore(query, text) {
  if (!query || !text) return 0;
  var qt = trigrams(query);
  var tt = trigrams(text);
  var matches = 0;
  var total = 0;
  for (var k in qt) {
    total += qt[k];
    if (tt[k]) matches += Math.min(qt[k], tt[k]);
  }
  return total > 0 ? matches / total : 0;
}

function searchScore(query, session) {
  var q = query.toLowerCase();
  var fields = [
    session.first_message || '',
    session.project_short || '',
    session.project || '',
    session.id || '',
    session.tool || ''
  ];
  var haystack = fields.join(' ').toLowerCase();

  // Exact substring match = highest score
  if (haystack.indexOf(q) >= 0) return 1;

  // Trigram fuzzy match
  var best = 0;
  for (var i = 0; i < fields.length; i++) {
    var score = trigramScore(q, fields[i]);
    if (score > best) best = score;
  }
  // Also score against full haystack
  var fullScore = trigramScore(q, haystack);
  if (fullScore > best) best = fullScore;

  return best;
}

// ── Filtering ──────────────────────────────────────────────────

var SEARCH_THRESHOLD = 0.3;

function applyFilters() {
  renderLimit = RENDER_PAGE_SIZE; // reset pagination on filter change
  var scored = [];
  for (var i = 0; i < allSessions.length; i++) {
    var s = allSessions[i];

    // Tool filter
    if (toolFilter) {
      // claude-ext sessions show under both 'claude' and 'cursor' filters
      var toolMatch = s.tool === toolFilter || (s.tool === 'claude-ext' && (toolFilter === 'cursor' || toolFilter === 'claude'));
      if (!toolMatch) continue;
    }

    // Tag filter
    if (tagFilter) {
      var sessionTags = tags[s.id] || [];
      if (sessionTags.indexOf(tagFilter) === -1) continue;
    }

    // Date range
    if (dateFrom && s.date < dateFrom) continue;
    if (dateTo && s.date > dateTo) continue;

    // Search with trigram scoring
    var score = 1;
    if (searchQuery) {
      score = searchScore(searchQuery, s);
      if (score < SEARCH_THRESHOLD) continue;
    }

    scored.push({ session: s, score: score });
  }

  // Sort: starred first, then by search score (if searching), then by time
  scored.sort(function(a, b) {
    var aStarred = stars.indexOf(a.session.id) >= 0 ? 1 : 0;
    var bStarred = stars.indexOf(b.session.id) >= 0 ? 1 : 0;
    if (aStarred !== bStarred) return bStarred - aStarred;
    if (searchQuery && a.score !== b.score) return b.score - a.score;
    return b.session.last_ts - a.session.last_ts;
  });

  filteredSessions = scored.map(function(x) { return x.session; });

  render();

}

function onSearch(val) {
  searchQuery = val;
  applyFilters();

  // Trigger deep search after debounce
  clearTimeout(deepSearchTimeout);
  if (val && val.length >= 3) {
    deepSearchTimeout = setTimeout(function() { deepSearch(val); }, 600);
  }
}

function onTagFilter(val) {
  tagFilter = val;
  applyFilters();
}

function onDateFilter() {
  dateFrom = document.getElementById('dateFrom').value || '';
  dateTo = document.getElementById('dateTo').value || '';
  applyFilters();
}

function toggleGroup() {
  grouped = !grouped;
  var btn = document.getElementById('groupBtn');
  if (btn) btn.classList.toggle('active', grouped);
  render();
}

function setView(view) {
  // Handle tool filter views
  if (view === 'claude-only') {
    toolFilter = toolFilter === 'claude' ? null : 'claude';
    currentView = 'sessions';
  } else if (view === 'codex-only') {
    toolFilter = toolFilter === 'codex' ? null : 'codex';
    currentView = 'sessions';
  } else if (view === 'cursor-only') {
    toolFilter = toolFilter === 'cursor' ? null : 'cursor';
    currentView = 'sessions';
  } else if (view === 'kiro-only') {
    toolFilter = toolFilter === 'kiro' ? null : 'kiro';
    currentView = 'sessions';
  } else if (view === 'opencode-only') {
    toolFilter = toolFilter === 'opencode' ? null : 'opencode';
    currentView = 'sessions';
  } else {
    toolFilter = null;
    currentView = view;
  }

  // Update sidebar active state
  document.querySelectorAll('.sidebar-item').forEach(function(el) {
    el.classList.toggle('active', el.getAttribute('data-view') === view);
  });

  applyFilters();
}

// Wire up sidebar clicks
document.querySelectorAll('.sidebar-item').forEach(function(el) {
  el.addEventListener('click', function() {
    setView(el.getAttribute('data-view'));
  });
});

// ── Rendering: Card ────────────────────────────────────────────

function renderCard(s, idx) {
  var isStarred = stars.indexOf(s.id) >= 0;
  var isSelected = selectedIds.has(s.id);
  var isFocused = focusedIndex === idx;
  var sessionTags = tags[s.id] || [];
  var cost = estimateCost(s.file_size);
  var costStr = cost > 0 ? '~$' + cost.toFixed(2) : '';
  var projName = getProjectName(s.project);
  var projColor = getProjectColor(projName);
  var toolClass = 'tool-' + s.tool;
  var toolLabel = s.tool === 'claude-ext' ? 'claude ext' : s.tool;

  var classes = 'card';
  if (isSelected) classes += ' selected';
  if (isFocused) classes += ' focused';

  var checkboxStyle = selectMode ? 'display:inline-block' : '';

  var tagHtml = sessionTags.map(function(t) {
    return '<span class="tag-pill tag-' + escHtml(t) + '" onclick="event.stopPropagation();removeTag(\'' + s.id + '\',\'' + t + '\')">' + escHtml(t) + ' &times;</span>';
  }).join('');

  var html = '<div class="' + classes + '" data-id="' + s.id + '" onclick="onCardClick(\'' + s.id + '\', event)">';
  html += '<div class="card-top">';
  html += '<input type="checkbox" class="card-checkbox" style="' + checkboxStyle + '" ' + (isSelected ? 'checked' : '') + ' onclick="toggleSelect(\'' + s.id + '\', event)">';
  html += '<span class="tool-badge ' + toolClass + '">' + escHtml(toolLabel) + '</span>';
  html += '<span class="card-project" style="color:' + projColor + '">' + escHtml(projName) + '</span>';
  html += '<span class="card-time">' + timeAgo(s.last_ts) + '</span>';
  if (costStr) {
    html += '<span class="cost-badge">' + costStr + '</span>';
  }
  html += '<button class="star-btn' + (isStarred ? ' active' : '') + '" onclick="event.stopPropagation();toggleStar(\'' + s.id + '\')" title="Star">&#9733;</button>';
  html += '</div>';
  var aiTitle = showAITitles && sessionTitles[s.id];
  if (aiTitle) {
    html += '<div class="card-title">' + escHtml(aiTitle) + '</div>';
    html += '<div class="card-body card-body-sub">' + escHtml((s.first_message || '').slice(0, 80)) + '</div>';
  } else {
    html += '<div class="card-body">' + escHtml((s.first_message || '').slice(0, 120)) + '</div>';
  }
  html += '<div class="card-footer">';
  html += '<span class="card-meta">' + s.messages + ' msgs</span>';
  if (s.file_size) {
    html += '<span class="card-meta">' + formatBytes(s.file_size) + '</span>';
  }
  html += '<span class="card-meta">' + escHtml(s.last_time || '') + '</span>';
  html += '<span class="card-id">' + s.id.slice(0, 8) + '</span>';
  // Tags
  html += '<span class="card-tags">' + tagHtml;
  html += '<button class="tag-add-btn" onclick="showTagDropdown(event, \'' + s.id + '\')" title="Add tag">+</button>';
  html += '</span>';
  if (s.has_detail) {
    if (!sessionTitles[s.id]) {
      html += '<button class="card-gen-btn" onclick="event.stopPropagation();generateTitle(\'' + s.id + '\',\'' + escHtml(s.project || '').replace(/'/g, "\\'") + '\')" title="Generate AI title">&#9883;</button>';
    }
    html += '<button class="card-expand-btn" onclick="event.stopPropagation();toggleExpand(\'' + s.id + '\',\'' + escHtml(s.project || '').replace(/'/g, "\\'") + '\',this)" title="Preview messages">&#9662;</button>';
  }
  html += '</div>';
  // Expandable preview area (hidden by default)
  html += '<div class="card-preview-area" id="preview-' + s.id + '"></div>';
  html += '</div>';
  return html;
}

function toggleLayout() {
  layout = layout === 'grid' ? 'list' : 'grid';
  localStorage.setItem('codedash-layout', layout);
  var btn = document.getElementById('layoutBtn');
  if (btn) btn.classList.toggle('active', layout === 'list');
  var icon = document.getElementById('layoutIcon');
  if (icon) {
    icon.innerHTML = layout === 'list'
      ? '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>'
      : '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>';
  }
  render();
}

function renderListCard(s, idx) {
  var isStarred = stars.indexOf(s.id) >= 0;
  var isSelected = selectedIds.has(s.id);
  var isFocused = focusedIndex === idx;
  var projName = getProjectName(s.project);
  var projColor = getProjectColor(projName);

  var classes = 'list-row';
  if (isSelected) classes += ' selected';
  if (isFocused) classes += ' focused';

  var html = '<div class="' + classes + '" data-id="' + s.id + '" onclick="onCardClick(\'' + s.id + '\', event)">';
  var listToolLabel = s.tool === 'claude-ext' ? 'claude ext' : s.tool;
  html += '<span class="tool-badge tool-' + s.tool + '">' + escHtml(listToolLabel) + '</span>';
  html += '<span class="list-project" style="color:' + projColor + '">' + escHtml(projName) + '</span>';
  html += '<span class="list-msg">' + escHtml((s.first_message || '').slice(0, 80)) + '</span>';
  html += '<span class="list-meta">' + s.messages + ' msgs</span>';
  html += '<span class="list-time">' + timeAgo(s.last_ts) + '</span>';
  html += '<button class="star-btn' + (isStarred ? ' active' : '') + '" onclick="event.stopPropagation();toggleStar(\'' + s.id + '\')">&#9733;</button>';
  html += '</div>';
  return html;
}

// ── Card expand (inline preview) ──────────────────────────────

async function toggleExpand(sessionId, project, btn) {
  var area = document.getElementById('preview-' + sessionId);
  if (!area) return;

  if (area.classList.contains('open')) {
    area.classList.remove('open');
    area.innerHTML = '';
    btn.innerHTML = '&#9662;';
    return;
  }

  btn.innerHTML = '&#8987;';
  area.innerHTML = '<div class="loading">Loading...</div>';
  area.classList.add('open');

  try {
    var resp = await fetch('/api/preview/' + sessionId + '?project=' + encodeURIComponent(project) + '&limit=10');
    var messages = await resp.json();

    if (messages.length === 0) {
      area.innerHTML = '<div class="preview-empty">No messages</div>';
    } else {
      var html = '';
      messages.forEach(function(m) {
        var cls = m.role === 'user' ? 'preview-user' : 'preview-assistant';
        var label = m.role === 'user' ? 'You' : 'AI';
        html += '<div class="preview-msg ' + cls + '">';
        html += '<span class="preview-role">' + label + '</span> ';
        var text = m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content;
        html += escHtml(text);
        html += '</div>';
      });
      area.innerHTML = html;
    }
    btn.innerHTML = '&#9652;';
  } catch (e) {
    area.innerHTML = '<div class="preview-empty">Failed to load</div>';
    btn.innerHTML = '&#9662;';
  }
}


// ── Deep search (full-text across session content) ────────────

var deepSearchCache = {};
var deepSearchTimeout = null;

async function deepSearch(query) {
  if (!query || query.length < 3) return;
  if (deepSearchCache[query]) {
    applyDeepSearchResults(deepSearchCache[query]);
    return;
  }

  try {
    var resp = await fetch('/api/search?q=' + encodeURIComponent(query));
    var results = await resp.json();
    deepSearchCache[query] = results;
    applyDeepSearchResults(results);
  } catch {}
}

function applyDeepSearchResults(results) {
  if (!results || results.length === 0) return;

  // Highlight matching session IDs in filtered list
  var matchIds = results.map(function(r) { return r.sessionId; });

  // Boost matching sessions to top if not already visible
  var boosted = [];
  var rest = [];
  filteredSessions.forEach(function(s) {
    if (matchIds.indexOf(s.id) >= 0) {
      s._deepMatch = results.find(function(r) { return r.sessionId === s.id; });
      boosted.push(s);
    } else {
      rest.push(s);
    }
  });

  // Also add sessions that weren't in filteredSessions but match
  matchIds.forEach(function(id) {
    if (!boosted.find(function(s) { return s.id === id; }) && !rest.find(function(s) { return s.id === id; })) {
      var s = allSessions.find(function(x) { return x.id === id; });
      if (s) {
        s._deepMatch = results.find(function(r) { return r.sessionId === id; });
        boosted.push(s);
      }
    }
  });

  filteredSessions = boosted.concat(rest);
  render();

  // Show deep search indicator
  var stats = document.getElementById('stats');
  if (stats && boosted.length > 0) {
    stats.textContent += ' | ' + boosted.length + ' deep matches';
  }
}

function onCardClick(id, event) {
  if (selectMode) {
    toggleSelect(id, event);
  } else {
    var s = allSessions.find(function(x) { return x.id === id; });
    if (s) openDetail(s);
  }
}

// ── Rendering: Main ────────────────────────────────────────────

function render() {
  var content = document.getElementById('content');
  var stats = document.getElementById('stats');
  if (!content) return;

  var sessions = filteredSessions;

  // Stats
  if (stats) {
    stats.textContent = sessions.length + ' sessions' +
      (toolFilter ? ' (' + toolFilter + ')' : '') +
      (tagFilter ? ' [' + tagFilter + ']' : '');
  }

  // Route to view
  if (currentView === 'activity') {
    renderHeatmap(content);
    return;
  }

  if (currentView === 'analytics') {
    renderAnalytics(content);
    return;
  }

  if (currentView === 'changelog') {
    renderChangelog(content);
    return;
  }

  if (currentView === 'running') {
    renderRunning(content, sessions);
    return;
  }

  if (currentView === 'starred') {
    var starredSessions = sessions.filter(function(s) { return stars.indexOf(s.id) >= 0; });
    if (starredSessions.length === 0) {
      content.innerHTML = '<div class="empty-state">No starred sessions. Click the star on any session to bookmark it.</div>';
      return;
    }
    var idx = 0;
    content.innerHTML = starredSessions.map(function(s) { return renderCard(s, idx++); }).join('');
    return;
  }

  if (currentView === 'timeline') {
    renderTimeline(content, sessions);
    return;
  }

  if (currentView === 'projects') {
    renderProjects(content, sessions);
    return;
  }

  // Default: sessions view
  if (sessions.length === 0) {
    content.innerHTML = '<div class="empty-state">No sessions found.' +
      (searchQuery ? ' Try a different search.' : '') + '</div>';
    return;
  }

  var renderFn = layout === 'list' ? renderListCard : renderCard;
  var visible = sessions.slice(0, renderLimit);
  var hasMore = sessions.length > renderLimit;

  if (grouped) {
    renderGrouped(content, visible, renderFn);
  } else {
    var idx2 = 0;
    var wrapClass = layout === 'list' ? 'list-view' : 'grid-view';
    content.innerHTML = '<div class="' + wrapClass + '">' + visible.map(function(s) { return renderFn(s, idx2++); }).join('') + '</div>';
  }

  if (hasMore) {
    content.innerHTML += '<div style="text-align:center;padding:20px"><button class="toolbar-btn" onclick="loadMoreCards()" style="padding:8px 24px">Load more (' + (sessions.length - renderLimit) + ' remaining)</button></div>';
  }
}

function loadMoreCards() {
  renderLimit += RENDER_PAGE_SIZE;
  render();
}

function renderGrouped(container, sessions, renderFn) {
  renderFn = renderFn || renderCard;
  var groups = {};
  sessions.forEach(function(s) {
    var key = getProjectName(s.project);
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  });

  var sortedKeys = Object.keys(groups).sort(function(a, b) {
    return groups[b][0].last_ts - groups[a][0].last_ts;
  });

  var globalIdx = 0;
  var html = '';
  sortedKeys.forEach(function(key) {
    var color = getProjectColor(key);
    html += '<div class="group">';
    html += '<div class="group-header" onclick="this.parentElement.classList.toggle(\'collapsed\')">';
    html += '<span class="group-dot" style="background:' + color + '"></span>';
    html += '<span class="group-name">' + escHtml(key) + '</span>';
    html += '<span class="group-count">' + groups[key].length + '</span>';
    html += '<span class="group-chevron">&#9660;</span>';
    html += '</div>';
    var bodyClass = layout === 'list' ? 'group-body group-body-list' : 'group-body';
    html += '<div class="' + bodyClass + '">';
    groups[key].forEach(function(s) {
      html += renderFn(s, globalIdx++);
    });
    html += '</div></div>';
  });
  container.innerHTML = html;
}

function renderTimeline(container, sessions) {
  // Group by date
  var byDate = {};
  sessions.forEach(function(s) {
    var d = s.date || 'unknown';
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(s);
  });

  var dates = Object.keys(byDate).sort().reverse();
  if (dates.length === 0) {
    container.innerHTML = '<div class="empty-state">No sessions to display in timeline.</div>';
    return;
  }

  var renderFn = layout === 'list' ? renderListCard : renderCard;
  var globalIdx = 0;
  var html = '<div class="timeline">';
  dates.forEach(function(d) {
    html += '<div class="timeline-date">';
    html += '<div class="timeline-date-label">' + escHtml(d) + ' <span class="timeline-count">' + byDate[d].length + ' sessions</span></div>';
    var wrapClass = layout === 'list' ? 'list-view' : 'grid-view';
    html += '<div class="' + wrapClass + '">';
    byDate[d].forEach(function(s) {
      html += renderFn(s, globalIdx++);
    });
    html += '</div></div>';
  });
  html += '</div>';
  container.innerHTML = html;
}

function renderProjects(container, sessions) {
  var byProject = {};
  sessions.forEach(function(s) {
    var p = getProjectName(s.project);
    if (!byProject[p]) byProject[p] = { sessions: [], project: s.project };
    byProject[p].sessions.push(s);
  });

  var sorted = Object.entries(byProject).sort(function(a, b) {
    return b[1].sessions.length - a[1].sessions.length;
  });

  if (sorted.length === 0) {
    container.innerHTML = '<div class="empty-state">No projects found.</div>';
    return;
  }

  var html = '<div class="projects-grid">';
  sorted.forEach(function(entry) {
    var name = entry[0];
    var info = entry[1];
    var color = getProjectColor(name);
    var totalMsgs = info.sessions.reduce(function(sum, s) { return sum + (s.messages || 0); }, 0);
    var totalSize = info.sessions.reduce(function(sum, s) { return sum + (s.file_size || 0); }, 0);
    var latest = info.sessions[0];

    html += '<div class="project-card" onclick="openProject(\'' + escHtml(name).replace(/'/g, "\\'") + '\')">';
    html += '<div class="project-card-header">';
    html += '<span class="group-dot" style="background:' + color + '"></span>';
    html += '<span class="project-card-name">' + escHtml(name) + '</span>';
    html += '</div>';
    html += '<div class="project-card-stats">';
    html += '<span>' + info.sessions.length + ' sessions</span>';
    html += '<span>' + totalMsgs + ' msgs</span>';
    html += '<span>' + formatBytes(totalSize) + '</span>';
    html += '</div>';
    html += '<div class="project-card-time">Last: ' + timeAgo(latest.last_ts) + '</div>';
    html += '</div>';
  });
  html += '</div>';
  container.innerHTML = html;
}

// ── Activity Heatmap ───────────────────────────────────────────

function localISO(date) {
  var y = date.getFullYear();
  var m = String(date.getMonth() + 1).padStart(2, '0');
  var d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function renderHeatmap(container) {
  var now = new Date();
  var oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());

  // Count sessions per day + by tool
  var counts = {};
  var toolCounts = {};
  allSessions.forEach(function(s) {
    var d = s.date;
    if (!d) return;
    counts[d] = (counts[d] || 0) + 1;
    if (!toolCounts[d]) toolCounts[d] = {};
    toolCounts[d][s.tool] = (toolCounts[d][s.tool] || 0) + 1;
  });

  // Build weeks array — GitHub style: columns are weeks, rows are days
  var d = new Date(oneYearAgo);
  d.setDate(d.getDate() - d.getDay()); // align to Sunday

  var endDate = new Date(now);
  endDate.setDate(endDate.getDate() + (6 - endDate.getDay()));

  var weeks = [];
  var week = [];
  while (d <= endDate) {
    var iso = localISO(d);
    var count = counts[iso] || 0;
    var level = count >= 8 ? 4 : count >= 4 ? 3 : count >= 2 ? 2 : count >= 1 ? 1 : 0;
    var tools = toolCounts[iso] || {};
    var toolTip = Object.keys(tools).map(function(t) { return t + ': ' + tools[t]; }).join(', ');
    week.push({ date: iso, count: count, level: level, day: d.getDay(), toolTip: toolTip });
    if (week.length === 7) { weeks.push(week); week = []; }
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  }
  if (week.length) weeks.push(week);

  // SVG dimensions — GitHub exact sizes
  var cell = 11;
  var gap = 3;
  var step = cell + gap;
  var labelW = 36;
  var headerH = 20;
  var svgW = labelW + weeks.length * step + 10;
  var svgH = headerH + 7 * step + 5;

  // Month labels
  var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var monthLabels = [];
  var lastMonth = -1;
  weeks.forEach(function(w, wi) {
    var m = parseInt(w[0].date.slice(5, 7)) - 1;
    if (m !== lastMonth) {
      monthLabels.push({ x: labelW + wi * step, label: monthNames[m] });
      lastMonth = m;
    }
  });

  // Summary stats
  var yearStart = localISO(oneYearAgo);
  var totalThisYear = 0;
  var maxDay = '';
  var maxCount = 0;
  var activeDays = 0;
  Object.keys(counts).forEach(function(d) {
    if (d >= yearStart) {
      totalThisYear += counts[d];
      activeDays++;
      if (counts[d] > maxCount) { maxCount = counts[d]; maxDay = d; }
    }
  });

  // Streaks
  var currentStreak = 0;
  var longestStreak = 0;
  var tempStreak = 0;
  var checkDate = new Date(now);
  while (true) {
    var ciso = localISO(checkDate);
    if (counts[ciso] && counts[ciso] > 0) {
      currentStreak++;
      checkDate = new Date(checkDate.getFullYear(), checkDate.getMonth(), checkDate.getDate() - 1);
    } else break;
  }
  // Longest streak
  var streakD = new Date(oneYearAgo);
  while (streakD <= now) {
    if (counts[localISO(streakD)]) { tempStreak++; if (tempStreak > longestStreak) longestStreak = tempStreak; }
    else { tempStreak = 0; }
    streakD = new Date(streakD.getFullYear(), streakD.getMonth(), streakD.getDate() + 1);
  }

  // Colors
  var colors = ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'];

  // Build SVG
  var svg = '<svg width="' + svgW + '" height="' + svgH + '" xmlns="http://www.w3.org/2000/svg">';

  // Month labels
  monthLabels.forEach(function(ml) {
    svg += '<text x="' + ml.x + '" y="12" fill="#8b949e" font-size="11" font-family="-apple-system,BlinkMacSystemFont,sans-serif">' + ml.label + '</text>';
  });

  // Day labels
  var dayLabels = [{row: 1, label: 'Mon'}, {row: 3, label: 'Wed'}, {row: 5, label: 'Fri'}];
  dayLabels.forEach(function(dl) {
    svg += '<text x="0" y="' + (headerH + dl.row * step + cell - 1) + '" fill="#8b949e" font-size="10" font-family="-apple-system,BlinkMacSystemFont,sans-serif">' + dl.label + '</text>';
  });

  // Cells
  weeks.forEach(function(w, wi) {
    w.forEach(function(day, di) {
      var x = labelW + wi * step;
      var y = headerH + di * step;
      var fill = colors[day.level];
      var rx = 2;
      svg += '<rect x="' + x + '" y="' + y + '" width="' + cell + '" height="' + cell + '" rx="' + rx + '" fill="' + fill + '" data-date="' + day.date + '" data-count="' + day.count + '">';
      svg += '<title>' + day.count + ' sessions on ' + day.date + (day.toolTip ? ' (' + day.toolTip + ')' : '') + '</title>';
      svg += '</rect>';
    });
  });

  svg += '</svg>';

  // Full page
  var html = '<div class="gh-activity">';
  html += '<div class="gh-header">';
  html += '<span class="gh-total">' + totalThisYear + ' sessions in the last year</span>';
  html += '</div>';
  html += '<div class="gh-graph">' + svg + '</div>';

  // Legend
  html += '<div class="gh-footer">';
  html += '<a href="#" onclick="event.preventDefault()" class="gh-link">Learn how we count sessions</a>';
  html += '<div class="gh-legend">';
  html += '<span>Less</span>';
  colors.forEach(function(c) {
    html += '<span class="gh-legend-cell" style="background:' + c + '"></span>';
  });
  html += '<span>More</span>';
  html += '</div></div>';

  // Stats grid
  html += '<div class="gh-stats">';
  html += '<div class="gh-stat-card">';
  html += '<div class="gh-stat-num">' + totalThisYear + '</div>';
  html += '<div class="gh-stat-label">Total sessions</div>';
  html += '</div>';
  html += '<div class="gh-stat-card">';
  html += '<div class="gh-stat-num">' + activeDays + '</div>';
  html += '<div class="gh-stat-label">Active days</div>';
  html += '</div>';
  html += '<div class="gh-stat-card">';
  html += '<div class="gh-stat-num">' + currentStreak + '</div>';
  html += '<div class="gh-stat-label">Current streak</div>';
  html += '</div>';
  html += '<div class="gh-stat-card">';
  html += '<div class="gh-stat-num">' + longestStreak + '</div>';
  html += '<div class="gh-stat-label">Longest streak</div>';
  html += '</div>';
  html += '<div class="gh-stat-card">';
  html += '<div class="gh-stat-num">' + maxCount + '</div>';
  html += '<div class="gh-stat-label">Best day (' + (maxDay || '-') + ')</div>';
  html += '</div>';
  html += '<div class="gh-stat-card">';
  html += '<div class="gh-stat-num">' + (totalThisYear / Math.max(activeDays, 1)).toFixed(1) + '</div>';
  html += '<div class="gh-stat-label">Avg per active day</div>';
  html += '</div>';
  html += '</div>';

  // Per-tool breakdown
  var toolTotals = {};
  allSessions.forEach(function(s) { if (s.date >= yearStart) { toolTotals[s.tool] = (toolTotals[s.tool] || 0) + 1; } });
  var toolColors = { claude: '#60a5fa', codex: '#22d3ee', opencode: '#c084fc', kiro: '#fb923c' };
  html += '<div class="gh-tools">';
  Object.keys(toolTotals).sort(function(a,b) { return toolTotals[b] - toolTotals[a]; }).forEach(function(tool) {
    var pct = (toolTotals[tool] / Math.max(totalThisYear, 1) * 100).toFixed(0);
    var color = toolColors[tool] || '#6b7280';
    html += '<div class="gh-tool-row">';
    html += '<span class="gh-tool-name" style="color:' + color + '">' + tool + '</span>';
    html += '<div class="gh-tool-bar"><div class="gh-tool-fill" style="width:' + pct + '%;background:' + color + '"></div></div>';
    html += '<span class="gh-tool-val">' + toolTotals[tool] + ' (' + pct + '%)</span>';
    html += '</div>';
  });
  html += '</div>';

  html += '</div>';
  container.innerHTML = html;
}

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
  if (aiTitle) {
    infoHtml += '<div class="detail-row"><span class="detail-label">AI Title</span><span style="font-weight:600">' + escHtml(aiTitle) + '</span></div>';
  } else if (s.has_detail) {
    infoHtml += '<div class="detail-row"><span class="detail-label">AI Title</span><button class="toolbar-btn" style="font-size:11px;padding:2px 8px" onclick="generateTitle(\'' + s.id + '\',\'' + escHtml(s.project || '').replace(/'/g, "\\'") + '\')">Generate</button></div>';
  }
  var detailToolLabel = s.tool === 'claude-ext' ? 'claude ext' : s.tool;
  infoHtml += '<div class="detail-row"><span class="detail-label">Tool</span><span class="tool-badge tool-' + s.tool + '">' + escHtml(detailToolLabel) + '</span></div>';
  infoHtml += '<div class="detail-row"><span class="detail-label">Project</span><span>' + escHtml(s.project_short || s.project || '') + '</span></div>';
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
          msgsHtml += '<div class="message ' + roleClass + '">';
          msgsHtml += '<div class="msg-role">' + roleLabel + '</div>';
          msgsHtml += '<div class="msg-content">' + escHtml(m.content) + '</div>';
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
  navigator.clipboard.writeText(cmd).then(function() {
    showToast('Copied: ' + cmd);
  }).catch(function() {
    // Fallback
    prompt('Copy this command:', cmd);
  });
}

function exportMd(sessionId, project) {
  window.open('/api/session/' + sessionId + '/export?project=' + encodeURIComponent(project));
}

// ── Delete ─────────────────────────────────────────────────────

function showDeleteConfirm(sessionId, project) {
  pendingDelete = { id: sessionId, project: project };
  var overlay = document.getElementById('confirmOverlay');
  if (overlay) overlay.style.display = 'flex';
  document.getElementById('confirmTitle').textContent = 'Delete Session?';
  document.getElementById('confirmText').textContent = 'This will permanently delete the session file, history entries, and env data.';
  document.getElementById('confirmId').textContent = sessionId;
  var btn = document.getElementById('confirmAction');
  btn.textContent = 'Delete';
  btn.className = 'btn-delete';
  btn.onclick = function() { confirmDelete(); };
}

function closeConfirm() {
  pendingDelete = null;
  var overlay = document.getElementById('confirmOverlay');
  if (overlay) overlay.style.display = 'none';
}

async function confirmDelete() {
  if (!pendingDelete) return;
  try {
    var resp = await fetch('/api/session/' + pendingDelete.id, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: pendingDelete.project })
    });
    var data = await resp.json();
    if (data.ok) {
      showToast('Session deleted');
      allSessions = allSessions.filter(function(s) { return s.id !== pendingDelete.id; });
      // Clear search if no more results
      if (searchQuery) {
        var remaining = allSessions.filter(function(s) {
          return (s.project || '').toLowerCase().indexOf(searchQuery.toLowerCase()) >= 0 ||
                 (s.first_message || '').toLowerCase().indexOf(searchQuery.toLowerCase()) >= 0;
        });
        if (remaining.length === 0) {
          searchQuery = '';
          document.querySelector('.search-box').value = '';
        }
      }
      closeConfirm();
      closeDetail();
      applyFilters();
    } else {
      showToast('Delete failed: ' + (data.error || 'unknown'));
    }
  } catch (e) {
    showToast('Delete failed');
  }
  closeConfirm();
}

// ── Bulk actions ───────────────────────────────────────────────

function toggleSelectMode() {
  selectMode = !selectMode;
  if (!selectMode) selectedIds.clear();
  var btn = document.getElementById('selectBtn');
  if (btn) btn.classList.toggle('active', selectMode);
  var content = document.getElementById('content');
  if (content) content.classList.toggle('select-mode', selectMode);
  updateBulkBar();
  render();
}

function toggleSelect(id, event) {
  if (event) event.stopPropagation();
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  updateBulkBar();
  render();
}

function updateBulkBar() {
  var bar = document.getElementById('bulkBar');
  if (!bar) return;
  if (selectedIds.size > 0) {
    bar.style.display = 'flex';
    document.getElementById('bulkCount').textContent = selectedIds.size + ' selected';
  } else {
    bar.style.display = 'none';
  }
}

function clearSelection() {
  selectedIds.clear();
  selectMode = false;
  var btn = document.getElementById('selectBtn');
  if (btn) btn.classList.remove('active');
  updateBulkBar();
  render();
}

async function bulkDelete() {
  if (!confirm('Delete ' + selectedIds.size + ' sessions? This cannot be undone.')) return;
  var sessions = [];
  selectedIds.forEach(function(id) {
    var s = allSessions.find(function(x) { return x.id === id; });
    sessions.push({ id: id, project: s ? s.project : '' });
  });
  try {
    var resp = await fetch('/api/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessions: sessions })
    });
    var data = await resp.json();
    if (data.ok) {
      showToast('Deleted ' + sessions.length + ' sessions');
      allSessions = allSessions.filter(function(s) { return !selectedIds.has(s.id); });
      clearSelection();
      applyFilters();
    }
  } catch (e) {
    showToast('Bulk delete failed');
  }
}

// ── Project actions ────────────────────────────────────────────

function openProject(name) {
  currentView = 'sessions';
  searchQuery = name;
  document.querySelector('.search-box').value = name;
  document.querySelectorAll('.sidebar-item').forEach(function(el) {
    el.classList.toggle('active', el.getAttribute('data-view') === 'sessions');
  });
  applyFilters();
}

// ── Themes ─────────────────────────────────────────────────────

function setTheme(theme) {
  if (theme === 'dark') {
    document.body.removeAttribute('data-theme');
  } else if (theme === 'system') {
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark) {
      document.body.removeAttribute('data-theme');
    } else {
      document.body.setAttribute('data-theme', 'light');
    }
  } else {
    document.body.setAttribute('data-theme', theme);
  }
  localStorage.setItem('codedash-theme', theme);
}

function saveThemePref(val) {
  setTheme(val);
}

// ── Keyboard navigation ────────────────────────────────────────

function isInput(e) {
  var tag = document.activeElement ? document.activeElement.tagName : '';
  return ['INPUT', 'SELECT', 'TEXTAREA'].indexOf(tag) >= 0;
}

function moveFocus(delta) {
  var cards = document.querySelectorAll('.card');
  if (cards.length === 0) return;
  focusedIndex = Math.max(0, Math.min(cards.length - 1, focusedIndex + delta));
  cards.forEach(function(c, i) {
    c.classList.toggle('focused', i === focusedIndex);
  });
  if (cards[focusedIndex]) {
    cards[focusedIndex].scrollIntoView({ block: 'nearest' });
  }
}

function openFocusedCard() {
  var cards = document.querySelectorAll('.card');
  if (focusedIndex < 0 || focusedIndex >= cards.length) return;
  var id = cards[focusedIndex].getAttribute('data-id');
  if (!id) return;
  var s = allSessions.find(function(x) { return x.id === id; });
  if (s) {
    if (selectMode) {
      toggleSelect(id);
    } else {
      openDetail(s);
    }
  }
}

function toggleStarFocused() {
  var cards = document.querySelectorAll('.card');
  if (focusedIndex < 0 || focusedIndex >= cards.length) return;
  var id = cards[focusedIndex].getAttribute('data-id');
  if (id) toggleStar(id);
}

function deleteFocused() {
  var cards = document.querySelectorAll('.card');
  if (focusedIndex < 0 || focusedIndex >= cards.length) return;
  var id = cards[focusedIndex].getAttribute('data-id');
  if (!id) return;
  var s = allSessions.find(function(x) { return x.id === id; });
  if (s) showDeleteConfirm(s.id, s.project || '');
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    if (pendingDelete) {
      closeConfirm();
    } else {
      closeDetail();
    }
    return;
  }
  if (e.key === '/' && !isInput(e)) {
    e.preventDefault();
    var searchBox = document.querySelector('.search-box');
    if (searchBox) searchBox.focus();
    return;
  }
  if (e.key === 'j' && !isInput(e)) {
    e.preventDefault();
    moveFocus(1);
    return;
  }
  if (e.key === 'k' && !isInput(e)) {
    e.preventDefault();
    moveFocus(-1);
    return;
  }
  if (e.key === 'Enter' && !isInput(e) && focusedIndex >= 0) {
    e.preventDefault();
    openFocusedCard();
    return;
  }
  if (e.key === 'x' && !isInput(e) && focusedIndex >= 0) {
    e.preventDefault();
    toggleStarFocused();
    return;
  }
  if (e.key === 'd' && !isInput(e) && focusedIndex >= 0) {
    e.preventDefault();
    deleteFocused();
    return;
  }
  if (e.key === 'r' && !isInput(e)) {
    e.preventDefault();
    refreshData();
    return;
  }
  if (e.key === 'g' && !isInput(e)) {
    e.preventDefault();
    toggleGroup();
    return;
  }
  if (e.key === 's' && !isInput(e)) {
    e.preventDefault();
    toggleSelectMode();
    return;
  }
});

// ── Running Sessions View ──────────────────────────────────────

function renderRunning(container, sessions) {
  var activeIds = Object.keys(activeSessions);

  if (activeIds.length === 0) {
    container.innerHTML = '<div class="empty-state">No running sessions detected.<br><span style="font-size:12px;color:var(--text-muted)">Start a Claude Code or Codex session and it will appear here.</span></div>';
    return;
  }

  // Running cards at top
  var html = '<div class="running-container">';
  html += '<h2 class="heatmap-title">Running Sessions (' + activeIds.length + ')</h2>';
  html += '<div class="running-grid">';

  activeIds.forEach(function(sid) {
    var a = activeSessions[sid];
    var s = allSessions.find(function(x) { return x.id === sid; });
    var projName = s ? getProjectName(s.project) : (a.cwd ? a.cwd.split('/').pop() : 'unknown');
    var projColor = getProjectColor(projName);
    var statusClass = a.status === 'waiting' ? 'running-waiting' : 'running-active';
    var uptime = a.startedAt ? formatDuration(Date.now() - a.startedAt) : '';

    html += '<div class="running-card ' + statusClass + '">';
    html += '<div class="running-card-header">';
    html += '<span class="live-badge live-' + a.status + '">' + (a.status === 'waiting' ? 'WAITING' : 'LIVE') + '</span>';
    html += '<span class="running-project" style="color:' + projColor + '">' + escHtml(projName) + '</span>';
    html += '<span class="running-tool">' + escHtml(a.entrypoint || a.kind || 'claude') + '</span>';
    html += '</div>';

    html += '<div class="running-stats">';
    html += '<div class="running-stat"><span class="running-stat-val">' + a.cpu.toFixed(1) + '%</span><span class="running-stat-label">CPU</span></div>';
    html += '<div class="running-stat"><span class="running-stat-val">' + a.memoryMB + 'MB</span><span class="running-stat-label">Memory</span></div>';
    html += '<div class="running-stat"><span class="running-stat-val">' + a.pid + '</span><span class="running-stat-label">PID</span></div>';
    if (uptime) {
      html += '<div class="running-stat"><span class="running-stat-val">' + uptime + '</span><span class="running-stat-label">Uptime</span></div>';
    }
    html += '</div>';

    if (s && s.first_message) {
      html += '<div class="running-msg">' + escHtml(s.first_message.slice(0, 150)) + '</div>';
    }

    html += '<div class="running-actions">';
    html += '<button class="launch-btn" style="background:var(--accent-green);color:#000" onclick="focusSession(\'' + sid + '\')">Focus</button>';
    if (s) {
      html += '<button class="launch-btn btn-secondary" onclick="var ss=allSessions.find(function(x){return x.id===\'' + sid + '\'});if(ss)openDetail(ss);">Details</button>';
      html += '<button class="launch-btn btn-secondary" onclick="closeDetail();openReplay(\'' + sid + '\',\'' + escHtml((s.project || '').replace(/'/g, "\\'")) + '\')">Replay</button>';
    }
    html += '</div>';
    html += '</div>';
  });

  html += '</div>';

  // Also show recent non-active sessions below
  var recentInactive = sessions.filter(function(s) { return !activeSessions[s.id]; }).slice(0, 6);
  if (recentInactive.length > 0) {
    html += '<h3 style="margin:24px 0 12px;font-size:14px;color:var(--text-secondary)">Recently Inactive</h3>';
    html += '<div class="grid-view">';
    var idx = 0;
    recentInactive.forEach(function(s) { html += renderCard(s, idx++); });
    html += '</div>';
  }

  html += '</div>';
  container.innerHTML = html;
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

// ── Cost Analytics ────────────────────────────────────────────

async function renderAnalytics(container) {
  container.innerHTML = '<div class="loading">Loading analytics...</div>';

  try {
    var url = '/api/analytics/cost';
    var params = [];
    if (dateFrom) params.push('from=' + dateFrom);
    if (dateTo) params.push('to=' + dateTo);
    if (params.length) url += '?' + params.join('&');
    var resp = await fetch(url);
    var data = await resp.json();

    var html = '<div class="analytics-container">';
    html += '<h2 class="heatmap-title">Cost Analytics</h2>';

    // ── Summary cards ──────────────────────────────────────────
    html += '<div class="analytics-summary">';
    html += '<div class="analytics-card"><span class="analytics-val">$' + data.totalCost.toFixed(2) + '</span><span class="analytics-label">Total cost (API-equivalent)</span></div>';
    html += '<div class="analytics-card"><span class="analytics-val">' + formatTokens(data.totalTokens) + '</span><span class="analytics-label">Total tokens</span></div>';
    html += '<div class="analytics-card"><span class="analytics-val">$' + (data.dailyRate || 0).toFixed(2) + '</span><span class="analytics-label">Avg per day (' + (data.days || 1) + ' days)</span></div>';
    html += '<div class="analytics-card"><span class="analytics-val">' + data.totalSessions + '</span><span class="analytics-label">Sessions</span></div>';
    html += '</div>';

    // ── Data coverage note ────────────────────────────────────
    if (data.byAgent || data.agentNoCostData) {
      var coverageparts = [];
      var byAgent = data.byAgent || {};
      var noCost = data.agentNoCostData || {};
      if (byAgent['claude'] && byAgent['claude'].sessions > 0)
        coverageparts.push('<span class="coverage-ok">Claude Code \u2713</span>');
      if (byAgent['claude-ext'] && byAgent['claude-ext'].sessions > 0)
        coverageparts.push('<span class="coverage-ok">Claude Extension \u2713</span>');
      if (byAgent['codex'] && byAgent['codex'].sessions > 0)
        coverageparts.push('<span class="coverage-est">Codex ~est.</span>');
      if (byAgent['opencode'] && byAgent['opencode'].sessions > 0)
        coverageparts.push(byAgent['opencode'].estimated
          ? '<span class="coverage-est">OpenCode ~est.</span>'
          : '<span class="coverage-ok">OpenCode \u2713</span>');
      ['cursor', 'kiro'].forEach(function(a) {
        if (noCost[a] > 0)
          coverageparts.push('<span class="coverage-none">' + a + ' \u2717 (no token data)</span>');
      });
      if (noCost['opencode'] > 0 && !(byAgent['opencode'] && byAgent['opencode'].sessions > 0))
        coverageparts.push('<span class="coverage-none">opencode \u2717 (no token data)</span>');
      if (coverageparts.length > 0) {
        html += '<div class="analytics-coverage">Cost data: ' + coverageparts.join(' \u00b7 ') + '</div>';
      }
    }

    // ── Token breakdown ────────────────────────────────────────
    if (data.totalInputTokens !== undefined) {
      var totalTok = data.totalInputTokens + data.totalOutputTokens + data.totalCacheReadTokens + data.totalCacheCreateTokens;
      var pctOf = function(n) { return totalTok > 0 ? Math.round(n / totalTok * 100) : 0; };
      html += '<div class="chart-section analytics-token-breakdown">';
      html += '<h3>Token Breakdown</h3>';
      html += '<div class="token-breakdown-grid">';
      html += '<div class="token-type-card"><span class="token-type-val">' + formatTokens(data.totalInputTokens) + '</span><span class="token-type-label">Input</span><span class="token-type-pct">' + pctOf(data.totalInputTokens) + '%</span></div>';
      html += '<div class="token-type-card"><span class="token-type-val">' + formatTokens(data.totalOutputTokens) + '</span><span class="token-type-label">Output</span><span class="token-type-pct">' + pctOf(data.totalOutputTokens) + '%</span></div>';
      html += '<div class="token-type-card token-cache-read"><span class="token-type-val">' + formatTokens(data.totalCacheReadTokens) + '</span><span class="token-type-label">Cache read</span><span class="token-type-pct">' + pctOf(data.totalCacheReadTokens) + '%</span></div>';
      html += '<div class="token-type-card token-cache-create"><span class="token-type-val">' + formatTokens(data.totalCacheCreateTokens) + '</span><span class="token-type-label">Cache write</span><span class="token-type-pct">' + pctOf(data.totalCacheCreateTokens) + '%</span></div>';
      if (data.avgContextPct > 0) {
        html += '<div class="token-type-card token-context"><span class="token-type-val">' + data.avgContextPct + '%</span><span class="token-type-label">Avg context used</span><span class="token-type-pct">of 200K</span></div>';
      }
      html += '</div>';
      html += '</div>';
    }

    // ── Daily cost chart ───────────────────────────────────────
    var dayKeys = Object.keys(data.byDay).sort();
    var last30 = dayKeys.slice(-30);
    if (last30.length > 0) {
      var maxCost = Math.max.apply(null, last30.map(function(d) { return data.byDay[d].cost; }));
      html += '<div class="chart-section"><h3>Daily Cost (last 30 days)</h3>';
      html += '<div class="bar-chart">';
      last30.forEach(function(d) {
        var c = data.byDay[d];
        var pct = maxCost > 0 ? (c.cost / maxCost * 100) : 0;
        var label = d.slice(5); // MM-DD
        html += '<div class="bar-col" title="' + d + ': $' + c.cost.toFixed(2) + ' (' + c.sessions + ' sessions)">';
        html += '<div class="bar-fill" style="height:' + pct + '%"></div>';
        html += '<div class="bar-label">' + label + '</div>';
        html += '</div>';
      });
      html += '</div></div>';
    }

    // ── Cost by project ────────────────────────────────────────
    var projects = Object.entries(data.byProject).sort(function(a, b) { return b[1].cost - a[1].cost; });
    var topProjects = projects.slice(0, 10);
    if (topProjects.length > 0) {
      var maxProjCost = topProjects[0][1].cost;
      html += '<div class="chart-section"><h3>Cost by Project</h3>';
      html += '<div class="hbar-chart">';
      topProjects.forEach(function(entry) {
        var name = entry[0];
        var info = entry[1];
        var pct = maxProjCost > 0 ? (info.cost / maxProjCost * 100) : 0;
        html += '<div class="hbar-row">';
        html += '<span class="hbar-name">' + escHtml(name) + '</span>';
        html += '<div class="hbar-track"><div class="hbar-fill" style="width:' + pct + '%"></div></div>';
        html += '<span class="hbar-val">$' + info.cost.toFixed(2) + '</span>';
        html += '</div>';
      });
      html += '</div></div>';
    }

    // ── Top expensive sessions ─────────────────────────────────
    if (data.topSessions && data.topSessions.length > 0) {
      html += '<div class="chart-section"><h3>Most Expensive Sessions</h3>';
      html += '<div class="top-sessions">';
      data.topSessions.forEach(function(s) {
        html += '<div class="top-session-row" onclick="onCardClick(\'' + s.id + '\', event)">';
        html += '<span class="top-session-cost">$' + s.cost.toFixed(2) + '</span>';
        html += '<span class="top-session-project">' + escHtml(s.project) + '</span>';
        html += '<span class="top-session-date">' + (s.date || '') + '</span>';
        html += '<span class="top-session-id">' + s.id.slice(0, 8) + '</span>';
        html += '</div>';
      });
      html += '</div></div>';
    }

    // ── Cost by agent ──────────────────────────────────────────
    var agentEntries = Object.entries(data.byAgent || {}).filter(function(e) { return e[1].sessions > 0; });
    if (agentEntries.length > 1) {
      agentEntries.sort(function(a, b) { return b[1].cost - a[1].cost; });
      html += '<div class="chart-section"><h3>Cost by Agent</h3>';
      html += '<div class="hbar-chart">';
      var maxAgentCost = agentEntries[0][1].cost || 1;
      agentEntries.forEach(function(entry) {
        var name = entry[0]; var info = entry[1];
        var pct = maxAgentCost > 0 ? (info.cost / maxAgentCost * 100) : 0;
        var label = { 'claude': 'Claude Code', 'claude-ext': 'Claude Ext', 'codex': 'Codex', 'opencode': 'OpenCode', 'cursor': 'Cursor', 'kiro': 'Kiro' }[name] || name;
        var estMark = info.estimated ? ' <span style="font-size:10px;opacity:0.6">~est.</span>' : '';
        html += '<div class="hbar-row">';
        html += '<span class="hbar-name">' + label + estMark + '</span>';
        html += '<div class="hbar-track"><div class="hbar-fill" style="width:' + pct + '%"></div></div>';
        html += '<span class="hbar-val">$' + info.cost.toFixed(2) + ' <span style="font-size:10px;opacity:0.6">(' + info.sessions + ' sess.)</span></span>';
        html += '</div>';
      });
      html += '</div></div>';
    }

    html += '</div>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = '<div class="empty-state">Failed to load analytics.</div>';
  }
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
  return String(n);
}

// ── Focus active session (switch to terminal) ─────────────────

function focusSession(sessionId) {
  var a = activeSessions[sessionId];
  if (!a) { showToast('Session not active'); return; }

  fetch('/api/focus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid: a.pid })
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data.ok) {
      var hint = data.terminal || 'terminal';
      var cwd = a.cwd ? a.cwd.split('/').pop() : '';
      showToast('Switched to ' + hint + (cwd ? ' — look for: ' + cwd : '') + ' (PID ' + a.pid + ')');
    } else {
      showToast('Could not focus — try clicking the terminal manually');
    }
  }).catch(function() {
    showToast('Focus failed');
  });
}

// ── Changelog view ────────────────────────────────────────────

async function renderChangelog(container) {
  container.innerHTML = '<div class="loading">Loading changelog...</div>';
  try {
    var resp = await fetch('/api/changelog');
    var log = await resp.json();

    var html = '<div class="changelog-container">';
    html += '<h2 class="heatmap-title">Changelog</h2>';

    log.forEach(function(entry, i) {
      var isNew = i === 0;
      html += '<div class="changelog-entry' + (isNew ? ' changelog-latest' : '') + '">';
      html += '<div class="changelog-header">';
      html += '<span class="changelog-version">v' + escHtml(entry.version) + '</span>';
      if (isNew) html += '<span class="changelog-new">NEW</span>';
      html += '<span class="changelog-date">' + escHtml(entry.date) + '</span>';
      html += '</div>';
      html += '<div class="changelog-title">' + escHtml(entry.title) + '</div>';
      html += '<ul class="changelog-list">';
      entry.changes.forEach(function(c) {
        html += '<li>' + escHtml(c) + '</li>';
      });
      html += '</ul></div>';
    });

    html += '</div>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = '<div class="empty-state">Failed to load changelog.</div>';
  }
}

// ── Convert session ───────────────────────────────────────────

async function convertTo(sessionId, project, targetFormat) {
  if (!confirm('Convert this session to ' + targetFormat + '? A new session will be created.')) return;
  showToast('Converting...');
  try {
    var resp = await fetch('/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId, project: project, targetFormat: targetFormat }),
    });
    var data = await resp.json();
    if (data.ok) {
      showToast('Converted! New session: ' + data.target.sessionId.slice(0, 12));
      // Refresh to show new session
      await loadSessions();
      closeDetail();
    } else {
      showToast('Error: ' + (data.error || 'unknown'));
    }
  } catch (e) {
    showToast('Convert failed: ' + e.message);
  }
}

// ── Open in IDE ───────────────────────────────────────────────

function openInCursor(project) {
  if (!project) { showToast('No project path'); return; }
  fetch('/api/open-ide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ide: 'cursor', project: project })
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data.ok) showToast('Opening project in Cursor...');
    else showToast('Failed: ' + (data.error || 'unknown'));
  }).catch(function() { showToast('Failed to open Cursor'); });
}

// ── Handoff ───────────────────────────────────────────────────

function downloadHandoff(sessionId, project) {
  window.open('/api/handoff/' + sessionId + '?project=' + encodeURIComponent(project) + '&verbosity=standard');
}

// ── Install agents ────────────────────────────────────────────

var AGENT_INSTALL = {
  claude: {
    name: 'Claude Code',
    cmd: 'curl -fsSL https://claude.ai/install.sh | bash',
    alt: 'npm i -g @anthropic-ai/claude-code',
    url: 'https://code.claude.com',
  },
  codex: {
    name: 'Codex CLI',
    cmd: 'npm i -g @openai/codex',
    alt: 'brew install --cask codex',
    url: 'https://github.com/openai/codex',
  },
  kiro: {
    name: 'Kiro CLI',
    cmd: 'curl -fsSL https://cli.kiro.dev/install | bash',
    alt: null,
    url: 'https://kiro.dev/docs/cli/installation/',
  },
  opencode: {
    name: 'OpenCode',
    cmd: 'curl -fsSL https://opencode.ai/install | bash',
    alt: 'npm i -g opencode-ai@latest',
    url: 'https://opencode.ai',
  },
};

function installAgent(agent) {
  var info = AGENT_INSTALL[agent];
  if (!info) return;

  var overlay = document.getElementById('confirmOverlay');
  document.getElementById('confirmTitle').textContent = 'Install ' + info.name;
  var html = '<code style="display:block;margin:8px 0;padding:10px;background:var(--bg-card);border-radius:6px;font-size:13px;cursor:pointer" onclick="navigator.clipboard.writeText(\'' + info.cmd.replace(/'/g, "\\'") + '\');document.querySelector(\'#toast\').textContent=\'Copied!\';document.querySelector(\'#toast\').classList.add(\'show\');setTimeout(function(){document.querySelector(\'#toast\').classList.remove(\'show\')},1500)">' + escHtml(info.cmd) + '</code>';
  if (info.alt) {
    html += '<span style="font-size:11px;color:var(--text-muted)">or: <code>' + escHtml(info.alt) + '</code></span><br>';
  }
  html += '<br><a href="' + info.url + '" target="_blank" style="color:var(--accent-blue);font-size:12px">' + info.url + '</a>';
  document.getElementById('confirmText').innerHTML = html;
  document.getElementById('confirmId').textContent = '';
  document.getElementById('confirmAction').textContent = 'Copy Install Command';
  document.getElementById('confirmAction').className = 'launch-btn btn-primary';
  document.getElementById('confirmAction').onclick = function() {
    navigator.clipboard.writeText(info.cmd).then(function() {
      showToast('Copied: ' + info.cmd);
    });
    closeConfirm();
  };
  if (overlay) overlay.style.display = 'flex';
}

// ── Export/Import dialog ──────────────────────────────────────

function showExportDialog() {
  var overlay = document.getElementById('confirmOverlay');
  document.getElementById('confirmTitle').textContent = 'Export / Import Sessions';
  document.getElementById('confirmText').innerHTML =
    '<strong>Export</strong> all sessions to migrate to another PC:<br>' +
    '<code style="display:block;margin:8px 0;padding:8px;background:var(--bg-card);border-radius:6px;font-size:12px">codedash export</code>' +
    'Creates a tar.gz with all Claude &amp; Codex session data.<br><br>' +
    '<strong>Import</strong> on the new machine:<br>' +
    '<code style="display:block;margin:8px 0;padding:8px;background:var(--bg-card);border-radius:6px;font-size:12px">codedash import &lt;file.tar.gz&gt;</code>' +
    '<br><em style="color:var(--text-muted);font-size:12px">Don\'t forget to clone your git repos separately.</em>';
  document.getElementById('confirmId').textContent = '';
  document.getElementById('confirmAction').textContent = 'Copy Export Command';
  document.getElementById('confirmAction').className = 'launch-btn btn-primary';
  document.getElementById('confirmAction').onclick = function() {
    navigator.clipboard.writeText('codedash export').then(function() {
      showToast('Copied: codedash export');
    });
    closeConfirm();
  };
  if (overlay) overlay.style.display = 'flex';
}

// ── Update check ──────────────────────────────────────────────

async function checkForUpdates() {
  try {
    var resp = await fetch('/api/version');
    var data = await resp.json();
    var badge = document.getElementById('versionBadge');

    if (badge) {
      badge.textContent = 'v' + data.current;
    }

    // Show "what's new" if version changed since last visit
    var lastSeenVersion = localStorage.getItem('codedash-last-version');
    if (lastSeenVersion && lastSeenVersion !== data.current) {
      showToast('Updated to v' + data.current + ' — check Changelog!');
    }
    localStorage.setItem('codedash-last-version', data.current);

    if (data.updateAvailable) {
      if (badge) {
        badge.textContent = 'v' + data.current + ' → v' + data.latest;
        badge.classList.add('update-available');
        badge.title = 'Click to copy update command';
        badge.onclick = function() {
          navigator.clipboard.writeText('npm i -g codedash-app@latest').then(function() {
            showToast('Copied: npm i -g codedash-app@latest');
          });
        };
      }
      var banner = document.getElementById('updateBanner');
      var text = document.getElementById('updateText');
      if (banner && text) {
        text.textContent = 'v' + data.latest + ' available — run: npm i -g codedash-app@latest';
        banner.style.display = 'flex';
        banner.dataset.cmd = 'npm i -g codedash-app@latest';
      }
    }
  } catch {}
}

function copyUpdate() {
  var cmd = 'codedash update && codedash restart';
  navigator.clipboard.writeText(cmd).then(function() {
    showToast('Copied: ' + cmd + '  (run in terminal)');
  });
}

function dismissUpdate() {
  var banner = document.getElementById('updateBanner');
  if (banner) banner.style.display = 'none';
}

// ── Initialization ─────────────────────────────────────────────

(function init() {
  // Load data
  loadSessions();
  loadTerminals();
  checkForUpdates();
  startActivePolling();

  // Apply saved theme
  var savedTheme = localStorage.getItem('codedash-theme') || 'dark';
  setTheme(savedTheme);

  // Set saved theme in selector
  var themeSel = document.getElementById('themeSelect');
  if (themeSel) themeSel.value = savedTheme;

  // Set group button state
  var groupBtn = document.getElementById('groupBtn');
  if (groupBtn) groupBtn.classList.toggle('active', grouped);

  // Set AI titles toggle
  var aiToggle = document.getElementById('aiTitlesToggle');
  if (aiToggle) aiToggle.checked = showAITitles;
})();
