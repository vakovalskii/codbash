// ── codedash frontend ──────────────────────────────────────────
// Plain browser JS, no modules, no build step.

// ── State ──────────────────────────────────────────────────────

let allSessions = [];
let filteredSessions = [];
let currentView = 'sessions';  // sessions, projects, timeline, activity, starred
let grouped = true;
let layout = localStorage.getItem('codedash-layout') || 'grid'; // 'grid' or 'list'
let groupingMode = normalizeGroupingMode(localStorage.getItem('codedash-grouping-mode'));
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

function normalizeGroupingMode(mode) {
  return mode === 'repo' ? 'repo' : 'folder';
}

function getRepoInfo(fullPath, gitRoot) {
  var repoRoot = '';
  if (gitRoot) {
    repoRoot = gitRoot.replace(/\/+$/, '');
  } else if (fullPath) {
    var cleaned = fullPath.replace(/\/+$/, '');
    var wt = cleaned.match(/^(.*?)\/.claude\/worktrees\//);
    var codex = cleaned.match(/^(.*?)\/.codex\//);
    repoRoot = wt ? wt[1] : (codex ? codex[1] : cleaned);
  }

  var name = repoRoot ? repoRoot.split('/').pop() : 'unknown';
  return {
    key: repoRoot || 'unknown',
    name: name || 'unknown'
  };
}

function getGitProjectName(fullPath, gitRoot) {
  return getRepoInfo(fullPath, gitRoot).name;
}

function getSessionGroupInfo(session) {
  if (groupingMode === 'repo') {
    return getRepoInfo(session.project, session.git_root);
  }
  var name = getProjectName(session.project);
  return { key: name, name: name };
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

// ── Subscription service plans (pricing as of 2025) ─────────────
var SERVICE_PLANS = {
  'Claude': { label: 'Claude (Anthropic)', plans: [
    { name: 'Pro', price: 20 },
    { name: 'Max 5×', price: 100 },
    { name: 'Max 20×', price: 200 }
  ]},
  'OpenAI': { label: 'OpenAI (ChatGPT)', plans: [
    { name: 'Plus', price: 20 },
    { name: 'Pro', price: 200 }
  ]},
  'Cursor': { label: 'Cursor', plans: [
    { name: 'Pro', price: 20 },
    { name: 'Pro+', price: 60 },
    { name: 'Ultra', price: 200 }
  ]},
  'Kiro': { label: 'Kiro', plans: [
    { name: 'Pro', price: 20 },
    { name: 'Pro+', price: 40 },
    { name: 'Power', price: 200 }
  ]},
  'OpenCode': { label: 'OpenCode', plans: [
    { name: 'Go', price: 10 }
  ]}
};

function onSubServiceChange() {
  var serviceEl = document.getElementById('sub-new-service');
  var planEl = document.getElementById('sub-new-plan');
  var paidEl = document.getElementById('sub-new-paid');
  var service = serviceEl ? serviceEl.value : '';
  if (!planEl) return;
  planEl.innerHTML = '<option value="">— select plan —</option>';
  paidEl.value = '';
  if (service && SERVICE_PLANS[service]) {
    SERVICE_PLANS[service].plans.forEach(function(p) {
      var opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name + ' ($' + p.price + '/mo)';
      planEl.appendChild(opt);
    });
  }
}

function onSubPlanChange() {
  var serviceEl = document.getElementById('sub-new-service');
  var planEl = document.getElementById('sub-new-plan');
  var paidEl = document.getElementById('sub-new-paid');
  var service = serviceEl ? serviceEl.value : '';
  var planName = planEl ? planEl.value : '';
  if (service && planName && SERVICE_PLANS[service]) {
    var found = SERVICE_PLANS[service].plans.find(function(p) { return p.name === planName; });
    if (found && paidEl) paidEl.value = found.price;
  }
}

// ── Subscription config helpers ──────────────────────────────────
function getSubscriptionConfig() {
  var raw = JSON.parse(localStorage.getItem('codedash-subscription') || 'null');
  if (!raw) return { entries: [] };
  // Migrate old single-entry format {plan, paid} → new multi-period {entries: [...]}
  if (!raw.entries) return { entries: [{ plan: raw.plan || 'Subscription', paid: raw.paid || 0, from: '' }] };
  return raw;
}
function saveSubscriptionConfig(cfg) { localStorage.setItem('codedash-subscription', JSON.stringify(cfg)); }
function subTotalPaid(entries) { return entries.reduce(function(s,e){return s+(parseFloat(e.paid)||0);},0); }
function addSubEntry() {
  var service = (document.getElementById('sub-new-service').value || '').trim();
  var planEl = document.getElementById('sub-new-plan');
  var plan = planEl ? planEl.value.trim() : '';
  var paid = parseFloat(document.getElementById('sub-new-paid').value) || 0;
  var from = (document.getElementById('sub-new-from').value || '').trim();
  if (!paid) return;
  var cfg = getSubscriptionConfig();
  cfg.entries.push({ service: service || '', plan: plan || 'Subscription', paid: paid, from: from });
  cfg.entries.sort(function(a,b){return (a.from||'').localeCompare(b.from||'');});
  saveSubscriptionConfig(cfg);
  render();
}
function removeSubEntry(idx) {
  var cfg = getSubscriptionConfig();
  cfg.entries.splice(idx, 1);
  saveSubscriptionConfig(cfg);
  render();
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
  var detailBtn = document.querySelector('.detail-star');
  if (detailBtn) {
    var nowStarred = stars.indexOf(id) >= 0;
    detailBtn.className = 'star-btn detail-star' + (nowStarred ? ' active' : '');
    detailBtn.innerHTML = '&#9733; ' + (nowStarred ? 'Starred' : 'Star');
  }
}

// ── AI Titles ─────────────────────────────────────────────────

function toggleAITitles(checked) {
  showAITitles = checked;
  localStorage.setItem('codedash-ai-titles', checked ? 'true' : 'false');
  render();
}

function saveGroupingMode(mode) {
  groupingMode = normalizeGroupingMode(mode);
  localStorage.setItem('codedash-grouping-mode', groupingMode);
  render();
}

function loadLLMSettings() {
  fetch('/api/llm-config').then(function(r) { return r.json(); }).then(function(c) {
    var u = document.getElementById('llmUrl');
    var k = document.getElementById('llmApiKey');
    var m = document.getElementById('llmModel');
    if (u) u.value = c.url || '';
    if (k) k.value = c.apiKey || '';
    if (m) m.value = c.model || '';
  });
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
    // Progressive loading: if server is still loading cursor vscdb sessions, auto-refresh
    if (resp.headers.get('X-Loading') === '1') {
      setTimeout(loadSessions, 2000);
    }
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
      var toolMatch = s.tool === toolFilter || (s.tool === 'claude-ext' && toolFilter === 'claude');
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
  applyFilters();
  updateDateBtn();
}

// → moved to calendar.js

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
  if (cloudUnlocked) {
    var inCloud = cloudSessionIds.has(s.id);
    html += '<button class="star-btn' + (inCloud ? ' active' : '') + '" onclick="event.stopPropagation();cloudPushOne(\'' + s.id + '\',this)" title="' + (inCloud ? 'In cloud' : 'Push to cloud') + '" style="font-size:12px;">&#9729;</button>';
  }
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
    var btnTitle = sessionTitles[s.id] ? 'Regenerate AI title' : 'Generate AI title';
    var btnIcon = sessionTitles[s.id] ? '&#8635;' : '&#9883;';
    html += '<button class="card-gen-btn" onclick="event.stopPropagation();generateTitle(\'' + s.id + '\',\'' + escHtml(s.project || '').replace(/'/g, "\\'") + '\')" title="' + btnTitle + '">' + btnIcon + '</button>';
    html += '<button class="card-expand-btn" onclick="event.stopPropagation();toggleExpand(\'' + s.id + '\',\'' + escHtml(s.project || '').replace(/'/g, "\\'") + '\',this)" title="Preview messages">&#9662;</button>';
  }
  html += '</div>';
  // MCP/Skills footer
  if ((s.mcp_servers && s.mcp_servers.length > 0) || (s.skills && s.skills.length > 0)) {
    html += '<div class="card-tools">';
    if (s.mcp_servers) {
      s.mcp_servers.forEach(function(m) {
        html += '<span class="tool-badge badge-mcp">' + escHtml(m) + '</span>';
      });
    }
    if (s.skills) {
      s.skills.forEach(function(sk) {
        html += '<span class="tool-badge badge-skill">' + escHtml(sk) + '</span>';
      });
    }
    html += '</div>';
  }
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
  if (s.mcp_servers && s.mcp_servers.length > 0) {
    s.mcp_servers.forEach(function(m) {
      html += '<span class="tool-badge badge-mcp">' + escHtml(m) + '</span>';
    });
  }
  if (s.skills && s.skills.length > 0) {
    s.skills.forEach(function(sk) {
      html += '<span class="tool-badge badge-skill">' + escHtml(sk) + '</span>';
    });
  }
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

  if (currentView === 'leaderboard') {
    renderLeaderboard(content);
    return;
  }

  if (currentView === 'cloud') {
    renderCloud(content);
    return;
  }

  if (currentView === 'settings') {
    renderSettings(content);
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
    var group = getSessionGroupInfo(s);
    if (!groups[group.key]) groups[group.key] = { name: group.name, sessions: [] };
    groups[group.key].sessions.push(s);
  });

  var sortedKeys = Object.keys(groups).sort(function(a, b) {
    return groups[b].sessions[0].last_ts - groups[a].sessions[0].last_ts;
  });

  var globalIdx = 0;
  var html = '';
  sortedKeys.forEach(function(key) {
    var group = groups[key];
    var color = getProjectColor(key);
    html += '<div class="group">';
    html += '<div class="group-header" onclick="this.parentElement.classList.toggle(\'collapsed\')">';
    html += '<span class="group-dot" style="background:' + color + '"></span>';
    html += '<span class="group-name">' + escHtml(group.name) + '</span>';
    html += '<span class="group-count">' + group.sessions.length + '</span>';
    html += '<span class="group-chevron">&#9660;</span>';
    html += '</div>';
    var bodyClass = layout === 'list' ? 'group-body group-body-list' : 'group-body';
    html += '<div class="' + bodyClass + '">';
    group.sessions.forEach(function(s) {
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

function renderQACard(s, idx) {
  var isStarred = stars.indexOf(s.id) >= 0;
  var toolLabel = s.tool === 'claude-ext' ? 'claude ext' : s.tool;
  var toolClass = 'tool-' + s.tool;
  var cost = estimateCost(s.file_size);
  var costStr = cost > 0 ? '~$' + cost.toFixed(2) : '';
  var classes = 'qa-item' + (selectedIds.has(s.id) ? ' selected' : '');

  var html = '<div class="' + classes + '" data-id="' + s.id + '" onclick="onCardClick(\'' + s.id + '\', event)">';
  html += '<span class="tool-badge ' + toolClass + '">' + escHtml(toolLabel) + '</span>';
  html += '<span class="qa-question">' + escHtml((s.first_message || '').slice(0, 160)) + '</span>';
  html += '<span class="qa-meta">';
  html += '<span class="qa-msgs">' + s.messages + ' msgs</span>';
  if (costStr) html += '<span class="cost-badge">' + costStr + '</span>';
  html += '<span class="qa-time">' + timeAgo(s.last_ts) + '</span>';
  html += '</span>';
  html += '<button class="star-btn' + (isStarred ? ' active' : '') + '" onclick="event.stopPropagation();toggleStar(\'' + s.id + '\')" title="Star">&#9733;</button>';
  html += '</div>';
  return html;
}

function renderProjects(container, sessions) {
  var byGit = {};
  sessions.forEach(function(s) {
    var name = getGitProjectName(s.project, s.git_root);
    if (!byGit[name]) byGit[name] = [];
    byGit[name].push(s);
  });

  var sorted = Object.entries(byGit).sort(function(a, b) {
    return b[1][0].last_ts - a[1][0].last_ts;
  });

  if (sorted.length === 0) {
    container.innerHTML = '<div class="empty-state">No projects found.</div>';
    return;
  }

  var globalIdx = 0;
  var html = '<div class="git-projects">';
  sorted.forEach(function(entry) {
    var name = entry[0];
    var list = entry[1].slice().sort(function(a, b) { return b.last_ts - a.last_ts; });
    var color = getProjectColor(name);
    var totalMsgs = list.reduce(function(s, e) { return s + (e.messages || 0); }, 0);
    var totalCost = list.reduce(function(s, e) { return s + estimateCost(e.file_size); }, 0);
    var costLabel = totalCost > 0 ? ' · ~$' + totalCost.toFixed(2) : '';

    html += '<div class="git-project-group">';
    html += '<div class="git-project-header" onclick="this.parentElement.classList.toggle(\'collapsed\')">';
    html += '<span class="group-dot" style="background:' + color + '"></span>';
    html += '<span class="git-project-name">' + escHtml(name) + '</span>';
    html += '<span class="git-project-stats">' + list.length + ' sessions · ' + totalMsgs + ' msgs' + escHtml(costLabel) + '</span>';
    html += '<span class="group-chevron">&#9660;</span>';
    html += '</div>';
    html += '<div class="qa-list">';
    list.forEach(function(s) { html += renderQACard(s, globalIdx++); });
    html += '</div>';
    html += '</div>';
  });
  html += '</div>';
  container.innerHTML = html;
}

// → moved to heatmap.js

// → moved to detail.js

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

// ── Running Sessions View (Kanban) ─────────────────────────────

function renderRunningCard(a, s) {
  var projName = s ? getProjectName(s.project) : (a.cwd ? a.cwd.split('/').pop() : 'unknown');
  var projColor = getProjectColor(projName);
  var statusClass = a.status === 'waiting' ? 'running-waiting' : 'running-active';
  var uptime = a.startedAt ? formatDuration(Date.now() - a.startedAt) : '';
  var sid = a.sessionId;

  var html = '<div class="running-card ' + statusClass + '">';
  html += '<div class="running-card-header">';
  html += '<span class="live-badge live-' + a.status + '">' + (a.status === 'waiting' ? 'WAITING' : 'LIVE') + '</span>';
  html += '<span class="running-project" style="color:' + projColor + '">' + escHtml(projName) + '</span>';
  html += '<span class="running-tool">' + escHtml(a.entrypoint || a.kind || 'claude') + '</span>';
  html += '</div>';
  html += '<div class="running-stats">';
  html += '<div class="running-stat"><span class="running-stat-val">' + a.cpu.toFixed(1) + '%</span><span class="running-stat-label">CPU</span></div>';
  html += '<div class="running-stat"><span class="running-stat-val">' + a.memoryMB + 'MB</span><span class="running-stat-label">MEM</span></div>';
  if (uptime) html += '<div class="running-stat"><span class="running-stat-val">' + uptime + '</span><span class="running-stat-label">Uptime</span></div>';
  html += '</div>';
  if (s && s.first_message) html += '<div class="running-msg">' + escHtml(s.first_message.slice(0, 120)) + '</div>';
  html += '<div class="running-actions">';
  html += '<button class="launch-btn" style="background:var(--accent-green);color:#000" onclick="focusSession(\'' + sid + '\')">Focus</button>';
  if (s) {
    html += '<button class="launch-btn btn-secondary" onclick="var ss=allSessions.find(function(x){return x.id===\'' + sid + '\'});if(ss)openDetail(ss);">Details</button>';
    html += '<button class="launch-btn btn-secondary" onclick="closeDetail();openReplay(\'' + sid + '\',\'' + escHtml((s.project || '').replace(/'/g, "\\'")) + '\')">Replay</button>';
  }
  html += '</div>';
  html += '</div>';
  return html;
}

function renderDoneCard(s) {
  var projName = getProjectName(s.project);
  var projColor = getProjectColor(projName);
  var html = '<div class="running-card running-done">';
  html += '<div class="running-card-header">';
  html += '<span class="live-badge live-done">DONE</span>';
  html += '<span class="running-project" style="color:' + projColor + '">' + escHtml(projName) + '</span>';
  html += '<span class="running-tool tool-' + (s.tool || 'claude') + '">' + escHtml(s.tool || 'claude') + '</span>';
  html += '</div>';
  if (s.first_message) html += '<div class="running-msg">' + escHtml(s.first_message.slice(0, 120)) + '</div>';
  html += '<div class="running-stats">';
  html += '<div class="running-stat"><span class="running-stat-val">' + (s.messages || 0) + '</span><span class="running-stat-label">msgs</span></div>';
  if (s.last_time) html += '<div class="running-stat"><span class="running-stat-val">' + s.last_time.slice(11) + '</span><span class="running-stat-label">ended</span></div>';
  html += '</div>';
  html += '<div class="running-actions">';
  html += '<button class="launch-btn btn-secondary" onclick="openDetail(' + JSON.stringify({id: s.id, project: s.project || '', tool: s.tool || ''}) + ')">Details</button>';
  html += '</div>';
  html += '</div>';
  return html;
}

function renderRunning(container, sessions) {
  var allActiveIds = Object.keys(activeSessions);
  var running = allActiveIds.filter(function(sid) { return activeSessions[sid].status !== 'waiting'; });
  var waiting = allActiveIds.filter(function(sid) { return activeSessions[sid].status === 'waiting'; });
  var cutoff = Date.now() - 4 * 3600 * 1000;
  var done = sessions.filter(function(s) {
    return !activeSessions[s.id] && s.last_ts >= cutoff;
  }).slice(0, 8);

  if (allActiveIds.length === 0 && done.length === 0) {
    container.innerHTML = '<div class="empty-state">No running sessions detected.<br><span style="font-size:12px;color:var(--text-muted)">Start a Claude Code or Codex session and it will appear here.</span></div>';
    return;
  }

  var html = '<div class="running-container">';
  html += '<h2 class="heatmap-title">Agent Board</h2>';
  html += '<div class="kanban-board">';

  // ── Running column ──────────────────────────────────────────
  html += '<div class="kanban-col">';
  html += '<div class="kanban-col-header kanban-running"><span class="kanban-col-title">Running</span><span class="kanban-col-count">' + running.length + '</span></div>';
  if (running.length === 0) {
    html += '<div class="kanban-empty">No active sessions</div>';
  } else {
    running.forEach(function(sid) {
      var a = activeSessions[sid];
      var s = allSessions.find(function(x) { return x.id === sid; });
      html += renderRunningCard(a, s);
    });
  }
  html += '</div>';

  // ── Waiting column ──────────────────────────────────────────
  html += '<div class="kanban-col">';
  html += '<div class="kanban-col-header kanban-waiting"><span class="kanban-col-title">Waiting for input</span><span class="kanban-col-count">' + waiting.length + '</span></div>';
  if (waiting.length === 0) {
    html += '<div class="kanban-empty">No sessions waiting</div>';
  } else {
    waiting.forEach(function(sid) {
      var a = activeSessions[sid];
      var s = allSessions.find(function(x) { return x.id === sid; });
      html += renderRunningCard(a, s);
    });
  }
  html += '</div>';

  // ── Done column ─────────────────────────────────────────────
  html += '<div class="kanban-col">';
  html += '<div class="kanban-col-header kanban-done"><span class="kanban-col-title">Done (last 4h)</span><span class="kanban-col-count">' + done.length + '</span></div>';
  if (done.length === 0) {
    html += '<div class="kanban-empty">No recent sessions</div>';
  } else {
    done.forEach(function(s) { html += renderDoneCard(s); });
  }
  html += '</div>';

  html += '</div>'; // kanban-board
  html += '</div>'; // running-container
  container.innerHTML = html;
}

// → moved to detail.js (Session Replay)

// → moved to analytics.js

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

function renderSettings(container) {
  var savedTheme = localStorage.getItem('codedash-theme') || 'dark';
  var savedTerminal = localStorage.getItem('codedash-terminal') || '';
  var aiTitlesOn = localStorage.getItem('codedash-ai-titles') === 'true';
  var savedGroupingMode = normalizeGroupingMode(localStorage.getItem('codedash-grouping-mode'));

  var html = '<div class="settings-page">';
  html += '<h2 style="margin:0 0 24px;font-size:18px;font-weight:600">Settings</h2>';

  // Theme
  html += '<div class="settings-group">';
  html += '<label class="settings-label">Theme</label>';
  html += '<div class="settings-theme-btns">';
  ['dark', 'light', 'system'].forEach(function(t) {
    var active = savedTheme === t ? ' active' : '';
    html += '<button class="theme-btn' + active + '" onclick="saveThemePref(\'' + t + '\');renderSettings(document.getElementById(\'content\'))">' + t.charAt(0).toUpperCase() + t.slice(1) + '</button>';
  });
  html += '</div>';
  html += '</div>';

  // Terminal
  html += '<div class="settings-group">';
  html += '<label class="settings-label">Terminal</label>';
  html += '<select class="settings-select" onchange="saveTerminalPref(this.value)">';
  if (Array.isArray(availableTerminals)) {
    availableTerminals.forEach(function(t) {
      if (!t.available) return;
      var sel = t.id === savedTerminal ? ' selected' : '';
      html += '<option value="' + t.id + '"' + sel + '>' + escHtml(t.name) + '</option>';
    });
  }
  html += '</select>';
  html += '</div>';

  // AI Titles
  html += '<div class="settings-group">';
  html += '<label class="settings-label">AI Titles</label>';
  html += '<div class="settings-checkbox">';
  html += '<input type="checkbox" id="settingsAiToggle"' + (aiTitlesOn ? ' checked' : '') + ' onchange="toggleAITitles(this.checked)">';
  html += '<span style="font-size:13px;color:var(--text-secondary)">Show generated titles</span>';
  html += '</div>';
  html += '</div>';

  // Grouping
  html += '<div class="settings-group">';
  html += '<label class="settings-label">Grouping</label>';
  html += '<div class="settings-theme-btns">';
  ['folder', 'repo'].forEach(function(mode) {
    var active = savedGroupingMode === mode ? ' active' : '';
    var label = mode === 'repo' ? 'Repository' : 'Folder';
    html += '<button class="theme-btn' + active + '" onclick="saveGroupingMode(\'' + mode + '\')">' + label + '</button>';
  });
  html += '</div>';
  html += '<p style="font-size:12px;color:var(--text-muted);margin:10px 0 0">Applies to grouped session views like All Sessions and Claude Code. Projects always stay repository-based.</p>';
  html += '</div>';

  // LLM Configuration
  html += '<div class="settings-group">';
  html += '<label class="settings-label">LLM Configuration</label>';
  html += '<p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">OpenAI-compatible API for session title generation</p>';
  html += '<div style="display:flex;flex-direction:column;gap:8px">';
  html += '<input type="text" id="llmUrl" class="settings-select" placeholder="http://host:port/v1">';
  html += '<input type="password" id="llmApiKey" class="settings-select" placeholder="API Key (sk-...)">';
  html += '<input type="text" id="llmModel" class="settings-select" placeholder="Model (gpt-4o-mini)">';
  html += '</div>';
  html += '<div style="display:flex;gap:8px;margin-top:12px">';
  html += '<button class="theme-btn active" onclick="saveLLMSettings()">Save</button>';
  html += '<button class="theme-btn" onclick="testLLMConnection()">Test Connection</button>';
  html += '</div>';
  html += '</div>';

  html += '</div>';
  container.innerHTML = html;

  // Load LLM config into the inputs
  loadLLMSettings();
}

// → moved to leaderboard.js

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

// → moved to cloud.js
