// ── codedash frontend ──────────────────────────────────────────
// Plain browser JS, no modules, no build step.

// ── State ──────────────────────────────────────────────────────

let allSessions = [];
let filteredSessions = [];
let currentView = 'sessions';  // sessions, projects, timeline, activity, starred
let grouped = true;
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

// Persisted in localStorage
let stars = JSON.parse(localStorage.getItem('codedash-stars') || '[]');
let tags = JSON.parse(localStorage.getItem('codedash-tags') || '{}');

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
  const tokens = fileSize / 4;
  // Rough estimate: 30% input tokens, 70% output tokens
  return tokens * 0.000015 * 0.3 + tokens * 0.000075 * 0.7;
}

// ── Tag system ─────────────────────────────────────────────────

const TAG_OPTIONS = ['bug', 'feature', 'research', 'infra', 'deploy', 'review'];

function showTagDropdown(event, sessionId) {
  event.stopPropagation();
  document.querySelectorAll('.tag-dropdown').forEach(function(el) { el.remove(); });
  var dd = document.createElement('div');
  dd.className = 'tag-dropdown';
  dd.innerHTML = TAG_OPTIONS.map(function(t) {
    return '<div class="tag-dropdown-item" onclick="event.stopPropagation();addTag(\'' + sessionId + '\',\'' + t + '\')">' + t + '</div>';
  }).join('');
  event.target.parentElement.appendChild(dd);
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

// ── Filtering ──────────────────────────────────────────────────

function applyFilters() {
  filteredSessions = allSessions.filter(function(s) {
    // Tool filter
    if (toolFilter && s.tool !== toolFilter) return false;

    // Search
    if (searchQuery) {
      var q = searchQuery.toLowerCase();
      var haystack = (
        (s.first_message || '') + ' ' +
        (s.project || '') + ' ' +
        (s.project_short || '') + ' ' +
        (s.id || '') + ' ' +
        (s.tool || '')
      ).toLowerCase();
      if (haystack.indexOf(q) === -1) return false;
    }

    // Tag filter
    if (tagFilter) {
      var sessionTags = tags[s.id] || [];
      if (sessionTags.indexOf(tagFilter) === -1) return false;
    }

    // Date range
    if (dateFrom && s.date < dateFrom) return false;
    if (dateTo && s.date > dateTo) return false;

    return true;
  });

  render();
}

function onSearch(val) {
  searchQuery = val;
  applyFilters();
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
  var toolClass = s.tool === 'codex' ? 'tool-codex' : 'tool-claude';

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
  html += '<span class="tool-badge ' + toolClass + '">' + escHtml(s.tool) + '</span>';
  html += '<span class="card-project" style="color:' + projColor + '">' + escHtml(projName) + '</span>';
  html += '<span class="card-time">' + timeAgo(s.last_ts) + '</span>';
  if (costStr) {
    html += '<span class="cost-badge">' + costStr + '</span>';
  }
  html += '<button class="star-btn' + (isStarred ? ' active' : '') + '" onclick="event.stopPropagation();toggleStar(\'' + s.id + '\')" title="Star">&#9733;</button>';
  html += '</div>';
  html += '<div class="card-body">' + escHtml((s.first_message || '').slice(0, 120)) + '</div>';
  html += '<div class="card-footer">';
  html += '<span class="card-meta">' + s.messages + ' msgs</span>';
  if (s.file_size) {
    html += '<span class="card-meta">' + formatBytes(s.file_size) + '</span>';
  }
  html += '<span class="card-meta">' + escHtml(s.last_time || '') + '</span>';
  html += '<span class="card-id">' + s.id.slice(0, 8) + '</span>';
  // Tags
  if (tagHtml || true) {
    html += '<span class="card-tags">' + tagHtml;
    html += '<button class="tag-add-btn" onclick="showTagDropdown(event, \'' + s.id + '\')" title="Add tag">+</button>';
    html += '</span>';
  }
  html += '</div>';
  html += '</div>';
  return html;
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

  if (grouped) {
    renderGrouped(content, sessions);
  } else {
    var idx2 = 0;
    content.innerHTML = sessions.map(function(s) { return renderCard(s, idx2++); }).join('');
  }
}

function renderGrouped(container, sessions) {
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
    html += '<div class="group-body">';
    groups[key].forEach(function(s) {
      html += renderCard(s, globalIdx++);
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

  var globalIdx = 0;
  var html = '<div class="timeline">';
  dates.forEach(function(d) {
    html += '<div class="timeline-date">';
    html += '<div class="timeline-date-label">' + escHtml(d) + ' <span class="timeline-count">' + byDate[d].length + ' sessions</span></div>';
    byDate[d].forEach(function(s) {
      html += renderCard(s, globalIdx++);
    });
    html += '</div>';
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

    html += '<div class="project-card" onclick="onSearch(\'' + escHtml(name) + '\');document.querySelector(\'.search-box\').value=\'' + escHtml(name) + '\'">';
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

function renderHeatmap(container) {
  var now = new Date();
  var oneYearAgo = new Date(now);
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

  // Count sessions per day
  var counts = {};
  allSessions.forEach(function(s) {
    var d = s.date;
    if (!d) return;
    counts[d] = (counts[d] || 0) + 1;
  });

  // Build day array for last 365 days
  var days = [];
  var d = new Date(oneYearAgo);
  // Start from the most recent Sunday before or on oneYearAgo
  d.setDate(d.getDate() - d.getDay());

  var endDate = new Date(now);
  endDate.setDate(endDate.getDate() + (6 - endDate.getDay())); // end on Saturday

  while (d <= endDate) {
    var iso = d.toISOString().slice(0, 10);
    var count = counts[iso] || 0;
    var level = 0;
    if (count >= 6) level = 4;
    else if (count >= 4) level = 3;
    else if (count >= 2) level = 2;
    else if (count >= 1) level = 1;
    days.push({ date: iso, count: count, level: level, day: d.getDay() });
    d = new Date(d);
    d.setDate(d.getDate() + 1);
  }

  // Build weeks (columns)
  var weeks = [];
  var currentWeek = [];
  days.forEach(function(day, i) {
    currentWeek.push(day);
    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  });
  if (currentWeek.length > 0) {
    weeks.push(currentWeek);
  }

  // Month labels
  var monthLabels = [];
  var lastMonth = -1;
  var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  weeks.forEach(function(week, wi) {
    var firstDay = week[0];
    var m = parseInt(firstDay.date.slice(5, 7)) - 1;
    if (m !== lastMonth) {
      monthLabels.push({ week: wi, label: monthNames[m] });
      lastMonth = m;
    }
  });

  // Summary stats
  var totalThisYear = 0;
  var maxDay = '';
  var maxCount = 0;
  Object.keys(counts).forEach(function(d) {
    if (d >= oneYearAgo.toISOString().slice(0, 10)) {
      totalThisYear += counts[d];
      if (counts[d] > maxCount) {
        maxCount = counts[d];
        maxDay = d;
      }
    }
  });

  // Current streak
  var streak = 0;
  var checkDate = new Date(now);
  while (true) {
    var iso = checkDate.toISOString().slice(0, 10);
    if (counts[iso] && counts[iso] > 0) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  // Render
  var html = '<div class="heatmap-container">';
  html += '<h2 class="heatmap-title">Activity</h2>';

  // Month labels row
  html += '<div class="heatmap-months">';
  html += '<div class="heatmap-day-label"></div>'; // spacer for day labels
  var monthPositions = {};
  monthLabels.forEach(function(ml) { monthPositions[ml.week] = ml.label; });
  for (var wi = 0; wi < weeks.length; wi++) {
    if (monthPositions[wi]) {
      html += '<div class="heatmap-month-label">' + monthPositions[wi] + '</div>';
    } else {
      html += '<div class="heatmap-month-spacer"></div>';
    }
  }
  html += '</div>';

  // Grid with day labels
  var dayLabels = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
  for (var row = 0; row < 7; row++) {
    html += '<div class="heatmap-row">';
    html += '<div class="heatmap-day-label">' + dayLabels[row] + '</div>';
    for (var col = 0; col < weeks.length; col++) {
      var cell = weeks[col][row];
      if (cell) {
        html += '<div class="heatmap-cell level-' + cell.level + '" title="' + cell.date + ': ' + cell.count + ' sessions"></div>';
      } else {
        html += '<div class="heatmap-cell level-0"></div>';
      }
    }
    html += '</div>';
  }

  html += '</div>';

  // Summary
  html += '<div class="heatmap-summary">';
  html += '<div class="heatmap-stat"><span class="heatmap-stat-val">' + totalThisYear + '</span><span class="heatmap-stat-label">sessions this year</span></div>';
  html += '<div class="heatmap-stat"><span class="heatmap-stat-val">' + (maxDay || 'N/A') + '</span><span class="heatmap-stat-label">most active day (' + maxCount + ')</span></div>';
  html += '<div class="heatmap-stat"><span class="heatmap-stat-val">' + streak + '</span><span class="heatmap-stat-label">day streak</span></div>';
  html += '</div>';

  // Legend
  html += '<div class="heatmap-legend">';
  html += '<span>Less</span>';
  for (var l = 0; l <= 4; l++) {
    html += '<div class="heatmap-cell level-' + l + '"></div>';
  }
  html += '<span>More</span>';
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
  infoHtml += '<div class="detail-row"><span class="detail-label">Tool</span><span class="tool-badge tool-' + s.tool + '">' + escHtml(s.tool) + '</span></div>';
  infoHtml += '<div class="detail-row"><span class="detail-label">Project</span><span>' + escHtml(s.project_short || s.project || '') + '</span></div>';
  infoHtml += '<div class="detail-row"><span class="detail-label">Session ID</span><span class="mono">' + escHtml(s.id) + '</span></div>';
  infoHtml += '<div class="detail-row"><span class="detail-label">First seen</span><span>' + escHtml(s.first_time || '') + '</span></div>';
  infoHtml += '<div class="detail-row"><span class="detail-label">Last seen</span><span>' + escHtml(s.last_time || '') + ' (' + timeAgo(s.last_ts) + ')</span></div>';
  infoHtml += '<div class="detail-row"><span class="detail-label">Messages</span><span>' + (s.detail_messages || s.messages || 0) + '</span></div>';
  infoHtml += '<div class="detail-row"><span class="detail-label">File size</span><span>' + formatBytes(s.file_size) + '</span></div>';
  if (costStr) {
    infoHtml += '<div class="detail-row"><span class="detail-label">Est. cost</span><span class="cost-badge">' + costStr + '</span></div>';
  }
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
  infoHtml += '<button class="launch-btn" onclick="launchSession(\'' + s.id + '\',\'' + escHtml(s.tool) + '\',\'' + escHtml(s.project || '') + '\')">Resume in Terminal</button>';
  infoHtml += '<button class="launch-btn btn-secondary" onclick="copyResume(\'' + s.id + '\',\'' + escHtml(s.tool) + '\')">Copy Command</button>';
  if (s.has_detail) {
    infoHtml += '<button class="launch-btn btn-secondary" onclick="exportMd(\'' + s.id + '\',\'' + escHtml(s.project || '') + '\')">Export MD</button>';
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

function launchSession(sessionId, tool, project) {
  var terminal = localStorage.getItem('codedash-terminal') || '';
  fetch('/api/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: sessionId,
      tool: tool,
      flags: [],
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
  var cmd = tool === 'codex'
    ? 'codex --resume ' + sessionId
    : 'claude --resume ' + sessionId;
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
  var idEl = document.getElementById('confirmId');
  if (overlay) overlay.style.display = 'flex';
  if (idEl) idEl.textContent = sessionId;
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

// ── Initialization ─────────────────────────────────────────────

(function init() {
  // Load data
  loadSessions();
  loadTerminals();

  // Apply saved theme
  var savedTheme = localStorage.getItem('codedash-theme') || 'dark';
  setTheme(savedTheme);

  // Set saved theme in selector
  var themeSel = document.getElementById('themeSelect');
  if (themeSel) themeSel.value = savedTheme;

  // Set group button state
  var groupBtn = document.getElementById('groupBtn');
  if (groupBtn) groupBtn.classList.toggle('active', grouped);
})();
