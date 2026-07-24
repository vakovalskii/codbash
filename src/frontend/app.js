// ── codbash frontend ──────────────────────────────────────────
// Plain browser JS, no modules, no build step.

// ── State ──────────────────────────────────────────────────────

let allSessions = [];
let filteredSessions = [];
let currentView = 'overview';  // overview (landing), sessions, projects, timeline, activity, starred
let grouped = true;
let layout = localStorage.getItem('codedash-layout') || 'grid'; // 'grid' or 'list'
let groupingMode = normalizeGroupingMode(localStorage.getItem('codedash-grouping-mode'));
let searchQuery = '';
let toolFilter = null;  // null, 'claude', 'codex'
let piVariantFilter = null; // null, 'pi', 'ohmypi'
let gitProjectFilter = null; // null or { key, name } — drill-down from Projects view
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

// Projects tab subtab state — persisted across reloads via localStorage and
// reflected in location.hash so back/forward navigates between subtabs.
// Resolution: URL hash wins (so a shared link always opens the right subtab),
// localStorage second (user's last choice), default 'projects'.
let currentProjectsSubtab = (function() {
  var fromHash = (location.hash || '').replace(/^#/, '');
  if (fromHash === 'history') return 'history';
  if (fromHash === 'projects') return 'projects';
  try {
    return localStorage.getItem('codedash-projects-subtab') === 'history' ? 'history' : 'projects';
  } catch (e) { return 'projects'; }
})();

// Agent detection + UI settings — populated on boot from /api/agents/installed
// and /api/settings. Kept on window so deep helpers can read without prop drilling.
window.installedAgents = window.installedAgents || [];
window.codbashSettings = window.codbashSettings || { defaultAgent: null, lastUsedByPath: {} };

// Persisted in localStorage
let stars = JSON.parse(localStorage.getItem('codedash-stars') || '[]');
let tags = JSON.parse(localStorage.getItem('codedash-tags') || '{}');
let sessionTitles = JSON.parse(localStorage.getItem('codedash-titles') || '{}');
let showAITitles = localStorage.getItem('codedash-ai-titles') !== 'false';
let showAllSessionsListBadges = localStorage.getItem('codedash-all-sessions-list-badges') !== 'false';

// ── Repo Auto-Refresh state ────────────────────────────────────

let repoRefreshState = {
  repos: {},
  settings: { version: 1, refreshOnStartup: false, perProject: {} },
};
let repoRefreshLoaded = false;
let repoRefreshPollTimer = null;
let repoRefreshTimeTimer = null;          // re-renders relative timestamps every 30s
const REPO_REFRESH_POLL_MS = 2000;
const REPO_REFRESH_TIME_TICK_MS = 30000;
const _recentToasts = {};                 // de-dupe toast spam: msg → ts

function repoRefreshToast(msg) {
  const now = Date.now();
  if (_recentToasts[msg] && (now - _recentToasts[msg]) < 3000) return;
  _recentToasts[msg] = now;
  // Evict the dedup key after the window so long sessions don't accumulate
  // every distinct error message ever seen.
  setTimeout(function() { delete _recentToasts[msg]; }, 3100);
  showToast(msg);
}

// Shallow-immutable updaters — per ~/.claude/rules/common/coding-style.md
// (Immutability CRITICAL) we never mutate the state object in place.
function setRepoState(gitRoot, partial) {
  const prev = repoRefreshState.repos[gitRoot] || null;
  repoRefreshState = {
    ...repoRefreshState,
    repos: { ...repoRefreshState.repos, [gitRoot]: prev ? { ...prev, ...partial } : { ...partial } },
  };
}
function setPerProjectSetting(gitRoot, value) {
  // Spread the previous per-project config so future fields (e.g. lastUserAcked)
  // survive an optimistic toggle of a single field.
  const prev = repoRefreshState.settings.perProject[gitRoot] || {};
  repoRefreshState = {
    ...repoRefreshState,
    settings: {
      ...repoRefreshState.settings,
      perProject: { ...repoRefreshState.settings.perProject, [gitRoot]: { ...prev, ...value } },
    },
  };
}
function setGlobalRefreshOnStartup(value) {
  repoRefreshState = {
    ...repoRefreshState,
    settings: { ...repoRefreshState.settings, refreshOnStartup: !!value },
  };
}

async function loadRepoRefreshState() {
  try {
    const res = await fetch('/api/repo-refresh/state');
    if (!res.ok) return;
    const data = await res.json();
    repoRefreshState = data;
    repoRefreshLoaded = true;
    refreshRepoRefreshUI();
  } catch (e) {
    // Network errors during polling are silent — would otherwise spam the console.
  }
}

function refreshRepoRefreshUI() {
  document.querySelectorAll('[data-rr-badge]').forEach(function(el) {
    // Skip the innerHTML swap if focus is inside this slot — replacing the
    // DOM would steal keyboard focus and silently send the user to <body>.
    // The next un-focused tick will pick it up.
    if (el.contains(document.activeElement)) return;
    const root = el.getAttribute('data-rr-badge');
    el.innerHTML = renderRepoRefreshBadgeInner(root);
  });
  document.querySelectorAll('[data-rr-toggle]').forEach(function(el) {
    const root = el.getAttribute('data-rr-toggle');
    const enabled = !!(repoRefreshState.settings.perProject[root] && repoRefreshState.settings.perProject[root].autoRefreshOnNewChat);
    el.checked = enabled;
    el.setAttribute('aria-checked', enabled ? 'true' : 'false');
    if (!repoRefreshLoaded) el.disabled = true;
    else if (!el.dataset.rrInflight) el.disabled = false;
  });
  const globalToggle = document.getElementById('repoRefreshGlobalToggle');
  if (globalToggle) {
    const v = !!repoRefreshState.settings.refreshOnStartup;
    globalToggle.checked = v;
    globalToggle.setAttribute('aria-checked', v ? 'true' : 'false');
    if (!repoRefreshLoaded) globalToggle.disabled = true;
    else if (!globalToggle.dataset.rrInflight) globalToggle.disabled = false;
  }
  startRepoRefreshPollingIfNeeded();
  startRepoRefreshTimeTickerIfNeeded();
}

function startRepoRefreshPollingIfNeeded() {
  const anyFetching = Object.values(repoRefreshState.repos).some(function(r) { return r && r.status === 'fetching'; });
  if (!anyFetching || currentView !== 'projects') {
    if (repoRefreshPollTimer) { clearInterval(repoRefreshPollTimer); repoRefreshPollTimer = null; }
    return;
  }
  if (repoRefreshPollTimer) return;
  repoRefreshPollTimer = setInterval(loadRepoRefreshState, REPO_REFRESH_POLL_MS);
}

// Re-render badges every 30s so "Updated 2 min ago" doesn't get stuck.
function startRepoRefreshTimeTickerIfNeeded() {
  const anyOk = Object.values(repoRefreshState.repos).some(function(r) { return r && r.lastSuccessAt; });
  if (!anyOk || currentView !== 'projects') {
    if (repoRefreshTimeTimer) { clearInterval(repoRefreshTimeTimer); repoRefreshTimeTimer = null; }
    return;
  }
  if (repoRefreshTimeTimer) return;
  repoRefreshTimeTimer = setInterval(function() {
    document.querySelectorAll('[data-rr-badge]').forEach(function(el) {
      if (el.contains(document.activeElement)) return; // same focus guard as above
      const root = el.getAttribute('data-rr-badge');
      el.innerHTML = renderRepoRefreshBadgeInner(root);
    });
  }, REPO_REFRESH_TIME_TICK_MS);
}

function repoRelativeTime(ts) {
  if (!ts) return '';
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return secs + 's ago';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + ' min ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.floor(hours / 24) + 'd ago';
}

function _fmtTime(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return new Date(ts).toString(); }
}

// Renders the badge inner HTML. The outer <span data-rr-badge> wrapper carries
// role="status" + aria-live="polite" so transitions are announced without
// destroying the live region on innerHTML replacement.
function renderRepoRefreshBadgeInner(gitRoot) {
  const st = repoRefreshState.repos[gitRoot];
  if (!st) return '';
  if (st.status === 'fetching') {
    return '<span class="repo-refresh-badge fetching" title="Running git fetch for origin">'
      + '<span class="repo-refresh-spinner" aria-hidden="true"></span>'
      + '<span class="repo-refresh-badge-text">Fetching…</span></span>';
  }
  if (st.status === 'error') {
    const err = st.lastError || 'fetch failed';
    const at = st.lastErrorAt ? ' (at ' + _fmtTime(st.lastErrorAt) + ')' : '';
    // Trim at the nearest word boundary so visible truncation doesn't slice
    // mid-word. Reserve "…" for truncation; ASCII ellipsis is fine here.
    let visible = err.slice(0, 60);
    if (err.length > 60) {
      const cut = visible.replace(/\s\S*$/, '');
      visible = (cut.length > 20 ? cut : visible) + '…';
    }
    // aria-describedby points at a visually-hidden full message so SR and
    // keyboard users get the complete error, not just the title tooltip.
    const descId = 'rr-err-desc-' + Math.random().toString(36).slice(2, 9);
    return '<span class="repo-refresh-badge error" tabindex="0" '
      + 'aria-describedby="' + descId + '" title="' + escHtml(err + at) + '">'
      + '<span class="repo-refresh-dot" aria-hidden="true"></span>'
      + '<span class="repo-refresh-badge-text">Refresh failed: ' + escHtml(visible) + '</span>'
      + '<span id="' + descId + '" class="visually-hidden">' + escHtml(err + at) + '</span></span>';
  }
  if (st.lastSuccessAt) {
    return '<span class="repo-refresh-badge ok" title="Last fetched ' + escHtml(_fmtTime(st.lastSuccessAt)) + '">'
      + '<span aria-hidden="true">✓</span>'
      + '<span class="repo-refresh-badge-text">Updated ' + escHtml(repoRelativeTime(st.lastSuccessAt)) + '</span></span>';
  }
  return '';
}

function renderRepoRefreshControls(gitRoot, projName) {
  if (!gitRoot || gitRoot === 'unknown') {
    // Surface the reason controls are missing so users aren't confused.
    return '<span class="repo-refresh-controls disabled" onclick="event.stopPropagation()" title="Not a git repository — no remote to fetch from">'
      + '<span class="repo-refresh-toggle-label">Not a git repo</span></span>';
  }
  const escRoot = escHtml(gitRoot);
  const escName = escHtml(projName);
  const enabled = !!(repoRefreshState.settings.perProject[gitRoot] && repoRefreshState.settings.perProject[gitRoot].autoRefreshOnNewChat);
  // Group the controls so SR users hear them as one cluster, scoped to the project.
  // stopPropagation: this span is nested under .git-project-header whose onclick
  // toggles "collapsed". Clicks on refresh/toggle must NOT bubble there.
  let html = '<span class="repo-refresh-controls" role="group" aria-label="Auto-refresh controls for ' + escName + '" onclick="event.stopPropagation()">';
  // Outer wrapper carries the live region so badge innerHTML replacements
  // don't tear down the announcer on each update.
  html += '<span data-rr-badge="' + escRoot + '" role="status" aria-live="polite" class="repo-refresh-badge-slot">'
    + renderRepoRefreshBadgeInner(gitRoot) + '</span>';
  const isFetching = !!(repoRefreshState.repos[gitRoot] && repoRefreshState.repos[gitRoot].status === 'fetching');
  html += '<button type="button" class="repo-refresh-btn" data-rr-root="' + escRoot + '" '
    + 'aria-label="Fetch ' + escName + ' from origin" title="git fetch ' + escName + '" '
    + (isFetching ? 'aria-busy="true" ' : '')
    + 'onclick="onClickRepoRefresh(this.dataset.rrRoot)"><span aria-hidden="true">↻</span></button>';
  // Native checkbox (no role="switch") keeps reliable aria-checked semantics
  // across screen readers — see ARIA APG `switch` caveats.
  html += '<label class="repo-refresh-toggle" title="Run git fetch automatically before opening a new chat in this project">';
  html += '<input type="checkbox" data-rr-toggle="' + escRoot + '" '
    + 'aria-checked="' + (enabled ? 'true' : 'false') + '" '
    + (enabled ? 'checked ' : '') + (repoRefreshLoaded ? '' : 'disabled ')
    + 'aria-label="Auto-fetch on new chat for ' + escName + '" '
    + 'onchange="onToggleRepoRefreshProject(this.dataset.rrToggle, this.checked)">';
  html += '<span class="repo-refresh-toggle-label">Auto-fetch</span></label>';
  html += '</span>';
  return html;
}

function renderRepoRefreshGlobalToggle() {
  return '<label class="repo-refresh-global-toggle" title="When codbash starts, run git fetch for every repo whose Auto-fetch toggle is on">'
    + '<input type="checkbox" id="repoRefreshGlobalToggle" '
    + 'aria-checked="' + (repoRefreshState.settings.refreshOnStartup ? 'true' : 'false') + '" '
    + (repoRefreshState.settings.refreshOnStartup ? 'checked ' : '')
    + (repoRefreshLoaded ? '' : 'disabled ')
    + 'aria-label="Fetch all enabled repos on codbash start" '
    + 'onchange="onToggleRepoRefreshGlobal(this.checked)">'
    + '<span>Fetch all on codbash start</span></label>';
}

async function onClickRepoRefresh(gitRoot) {
  if (!gitRoot) return;
  try {
    const res = await fetch('/api/repo-refresh/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gitRoot: gitRoot }),
    });
    const data = await res.json();
    if (!res.ok) {
      repoRefreshToast('Refresh failed: ' + (data && data.error || res.status));
      return;
    }
    setRepoState(gitRoot, data.state || { status: 'fetching', startedAt: Date.now() });
    refreshRepoRefreshUI();
    setTimeout(loadRepoRefreshState, 500);
  } catch (e) {
    repoRefreshToast('Refresh failed: ' + e.message);
  }
}

async function onToggleRepoRefreshProject(gitRoot, checked) {
  if (!gitRoot) return;
  const inputEl = document.querySelector('[data-rr-toggle="' + (window.CSS && CSS.escape ? CSS.escape(gitRoot) : gitRoot) + '"]');
  // Disable input for the duration of the POST so a rapid second click can't
  // race the rollback (plan risk I5).
  if (inputEl) { inputEl.disabled = true; inputEl.dataset.rrInflight = '1'; }
  const prev = !!(repoRefreshState.settings.perProject[gitRoot] && repoRefreshState.settings.perProject[gitRoot].autoRefreshOnNewChat);
  setPerProjectSetting(gitRoot, { autoRefreshOnNewChat: !!checked });
  refreshRepoRefreshUI();
  try {
    const body = { perProject: {} };
    body.perProject[gitRoot] = { autoRefreshOnNewChat: !!checked };
    const res = await fetch('/api/repo-refresh/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'save failed');
  } catch (e) {
    setPerProjectSetting(gitRoot, { autoRefreshOnNewChat: prev });
    refreshRepoRefreshUI();
    repoRefreshToast('Failed to save Auto-fetch setting');
  } finally {
    if (inputEl) { delete inputEl.dataset.rrInflight; inputEl.disabled = !repoRefreshLoaded; }
  }
}

async function onToggleRepoRefreshGlobal(checked) {
  const inputEl = document.getElementById('repoRefreshGlobalToggle');
  if (inputEl) { inputEl.disabled = true; inputEl.dataset.rrInflight = '1'; }
  const prev = !!repoRefreshState.settings.refreshOnStartup;
  setGlobalRefreshOnStartup(!!checked);
  refreshRepoRefreshUI();
  try {
    const res = await fetch('/api/repo-refresh/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshOnStartup: !!checked }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'save failed');
  } catch (e) {
    setGlobalRefreshOnStartup(prev);
    refreshRepoRefreshUI();
    repoRefreshToast('Failed to save startup setting');
  } finally {
    if (inputEl) { delete inputEl.dataset.rrInflight; inputEl.disabled = !repoRefreshLoaded; }
  }
}

async function maybeRefreshBeforeLaunch(projectPath, launchBtn) {
  if (!projectPath) return;
  const cfg = repoRefreshState.settings.perProject[projectPath];
  if (!cfg || !cfg.autoRefreshOnNewChat) return;
  // Visible feedback on the actual button — silent 2s wait is a UX foot-gun.
  // Re-entrancy guard: a second click while we're mid-fetch would capture our
  // own "Fetching…" markup as the "previous" text and the button would end up
  // permanently stuck. dataset.rrLaunchInflight short-circuits the duplicate.
  let restoreBtn = null;
  if (launchBtn) {
    if (launchBtn.dataset.rrLaunchInflight) return;
    launchBtn.dataset.rrLaunchInflight = '1';
    const prevDisabled = launchBtn.disabled;
    const prevText = launchBtn.innerHTML;
    launchBtn.disabled = true;
    launchBtn.setAttribute('aria-busy', 'true');
    launchBtn.innerHTML = '<span class="repo-refresh-spinner" aria-hidden="true"></span>&nbsp;Fetching…';
    restoreBtn = function() {
      launchBtn.disabled = prevDisabled;
      launchBtn.removeAttribute('aria-busy');
      launchBtn.innerHTML = prevText;
      delete launchBtn.dataset.rrLaunchInflight;
    };
  }
  try {
    await fetch('/api/repo-refresh/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gitRoot: projectPath }),
    });
    setRepoState(projectPath, { status: 'fetching', startedAt: Date.now() });
    refreshRepoRefreshUI();
    const waitRes = await fetch('/api/repo-refresh/wait', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gitRoot: projectPath, timeoutMs: 2000 }),
    });
    if (waitRes.ok) {
      const data = await waitRes.json();
      if (data && data.state) {
        setRepoState(projectPath, data.state);
        refreshRepoRefreshUI();
        if (data.state.status === 'error') {
          repoRefreshToast('Fetch failed (session opens anyway): ' + (data.state.lastError || 'unknown'));
        }
      }
    }
  } catch (e) {
    repoRefreshToast('Pre-launch fetch failed: ' + e.message);
  } finally {
    if (restoreBtn) restoreBtn();
  }
}

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

function stripRecapSuffix(s) {
  return (s || '').replace(/\s*\(disable recaps in \/config\)\s*$/, '');
}

function getSessionDisplayName(session) {
  if (!session) return '';
  return session.session_name
    || stripRecapSuffix(session.recap)
    || session.first_message
    || '';
}

var TOOL_META = {
  claude: { label: 'Claude Code', shortLabel: 'claude', color: '#60a5fa' },
  'claude-ext': { label: 'Claude Ext', shortLabel: 'claude ext', color: '#60a5fa' },
  codex: { label: 'Codex', shortLabel: 'codex', color: '#22d3ee' },
  qwen: { label: 'Qwen Code', shortLabel: 'qwen', color: '#fbbf24' },
  pi: { label: 'Pi', shortLabel: 'Pi', color: '#a78bfa' },
  ohmypi: { label: 'OhMyPi', shortLabel: 'OhMyPi', color: '#a78bfa' },
  cursor: { label: 'Cursor', shortLabel: 'cursor', color: '#4a9eff' },
  opencode: { label: 'OpenCode', shortLabel: 'opencode', color: '#c084fc' },
  kiro: { label: 'Kiro', shortLabel: 'kiro', color: '#fb923c' },
  kilo: { label: 'Kilo CLI', shortLabel: 'kilo', color: '#34d399' },
  'copilot-chat': { label: 'Copilot Chat', shortLabel: 'copilot', color: '#8b6fc0' },
  copilot: { label: 'Copilot CLI', shortLabel: 'copilot', color: '#7c3aed' }
};

function getToolLabel(tool, shortLabel) {
  var meta = TOOL_META[tool] || { label: tool || 'unknown', shortLabel: tool || 'unknown' };
  return shortLabel ? meta.shortLabel : meta.label;
}

function getToolAliases(tool) {
  var meta = TOOL_META[tool];
  return meta && Array.isArray(meta.aliases) ? meta.aliases : [];
}

function getPiVariantLabel(session) {
  if (!session || session.agent_variant !== 'ohmypi') return 'Pi';
  return 'OhMyPi';
}

function getPiAggregateLabel() {
  var hasPi = false;
  var hasOhMyPi = false;
  for (var i = 0; i < allSessions.length; i++) {
    var s = allSessions[i];
    if (!s || s.tool !== 'pi') continue;
    if (s.agent_variant === 'ohmypi') hasOhMyPi = true;
    else hasPi = true;
    if (hasPi && hasOhMyPi) return 'Pi/OhMyPi';
  }
  if (hasPi) return 'Pi';
  if (hasOhMyPi) return 'OhMyPi';
  return 'Pi/OhMyPi';
}

function getPiDisplayLabel(session) {
  return session ? getPiVariantLabel(session) : getPiAggregateLabel();
}


function renderToolBadges(tool, session) {
  var toolClass = 'tool-' + tool;
  var labels;
  if (tool === 'pi') {
    labels = [getPiDisplayLabel(session)];
  } else {
    labels = [getToolLabel(tool, true)].concat(getToolAliases(tool));
  }
  return labels.map(function(label, idx) {
    var aliasClass = idx === 0 ? '' : ' tool-alias-badge';
    return '<span class="tool-badge ' + toolClass + aliasClass + '">' + escHtml(label) + '</span>';
  }).join('');
}

function getPiCommand() {
  var found = (window.installedAgents || []).find(function(a) { return a.id === 'pi'; });
  return found && found.command === 'omp' ? 'omp' : 'pi';
}

function quoteShellArg(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function getResumeCommand(tool, sessionId, project, session) {
  if (tool === 'codex') return 'codex resume ' + sessionId;
  if (tool === 'qwen') return 'qwen -r ' + sessionId;
  if (tool === 'pi') {
    var target = session && session.resume_target ? session.resume_target : sessionId;
    return session && session.agent_variant === 'ohmypi'
      ? 'omp --resume ' + quoteShellArg(target)
      : 'pi --session ' + quoteShellArg(target);
  }
  if (tool === 'cursor') return 'cursor ' + (project ? '"' + project + '"' : '.');
  return 'claude --resume ' + sessionId;
}

function getConvertTargets(tool) {
  if (tool !== 'claude' && tool !== 'codex' && tool !== 'qwen') return [];
  return ['claude', 'codex', 'qwen'].filter(function(target) { return target !== tool; });
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
  if (s === null || s === undefined) return '';
  // Cover both quote characters so a future onclick string interpolation
  // using single-quoted attributes is still safe. The cost is two extra
  // string replacements; the win is consistent defense-in-depth.
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escJsString(s) {
  if (s === null || s === undefined) return '';
  return escHtml(String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029'));
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

function fallbackCopyText(text) {
  try {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

// A promise-based text prompt that works everywhere — notably in the Electron
// desktop app, where window.prompt() is a no-op (returns undefined). Resolves
// to the entered string, or null if cancelled.
function codbashPrompt(message, defaultValue) {
  return new Promise(function (resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'cb-prompt-overlay';
    overlay.innerHTML =
      '<div class="cb-prompt" role="dialog" aria-modal="true">' +
        '<div class="cb-prompt-msg"></div>' +
        '<input type="text" class="cb-prompt-input" />' +
        '<div class="cb-prompt-actions">' +
          '<button type="button" class="toolbar-btn cb-prompt-cancel">Cancel</button>' +
          '<button type="button" class="toolbar-btn cb-prompt-ok">OK</button>' +
        '</div>' +
      '</div>';
    overlay.querySelector('.cb-prompt-msg').textContent = message || '';
    var input = overlay.querySelector('.cb-prompt-input');
    input.value = defaultValue == null ? '' : String(defaultValue);
    document.body.appendChild(overlay);
    setTimeout(function () { input.focus(); input.select(); }, 20);
    var done = false;
    function close(val) { if (done) return; done = true; overlay.remove(); resolve(val); }
    overlay.querySelector('.cb-prompt-ok').onclick = function () { close(input.value); };
    overlay.querySelector('.cb-prompt-cancel').onclick = function () { close(null); };
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(null); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); close(null); }
    });
  });
}

function copyText(text, successMsg) {
  var done = function() {
    showToast(successMsg || ('Copied: ' + text));
    return true;
  };
  var fail = function() {
    if (fallbackCopyText(text)) return done();
    codbashPrompt('Copy this command:', text);
    showToast(window.isSecureContext ? 'Clipboard copy failed' : 'Clipboard unavailable on non-secure origin');
    return false;
  };

  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    return navigator.clipboard.writeText(text).then(done).catch(fail);
  }
  return Promise.resolve(fail());
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

function getEstimatedSessionCost(session) {
  if (!session || session.tool === 'qwen') return 0;
  return estimateCost(session.file_size);
}

// ── Subscription service plans ─────────────────────────────────
// Pricing verified 2026-05-15 against vendor pages.
// Sources: claude.com/pricing, openai.com/chatgpt/pricing, cursor.com/pricing,
//          github.com/features/copilot/plans + docs.github.com, kiro.dev/pricing,
//          opencode.ai/go + opencode.ai/zen; OhMyPi is API-provider backed.
var SERVICE_PLANS = {
  'Claude Code':   { label: 'Claude Code (Anthropic)', kind: 'subscription', plans: [
    { name: 'Pro', price: 20 },
    { name: 'Max 5×', price: 100 },
    { name: 'Max 20×', price: 200 }
  ]},
  'ChatGPT/Codex': { label: 'ChatGPT / Codex (OpenAI)', kind: 'subscription', plans: [
    { name: 'Go', price: 8 },
    { name: 'Plus', price: 20 },
    { name: 'Pro', price: 200 }
  ]},
  'Cursor':        { label: 'Cursor', kind: 'subscription', plans: [
    { name: 'Pro', price: 20 },
    { name: 'Pro+', price: 60 },
    { name: 'Ultra', price: 200 }
  ]},
  'Copilot':       { label: 'GitHub Copilot', kind: 'subscription', plans: [
    { name: 'Pro', price: 10 },
    { name: 'Pro+', price: 39 },
    { name: 'Business', price: 19 },
    { name: 'Enterprise', price: 39 }
  ]},
  'Kiro':          { label: 'Kiro', kind: 'subscription', plans: [
    { name: 'Pro', price: 20 },
    { name: 'Pro+', price: 40 },
    { name: 'Power', price: 200 }
  ]},
  'OpenCode':      { label: 'OpenCode', kind: 'subscription', plans: [
    { name: 'Go', price: 10 },
    { name: 'Zen', price: 20 }
  ]},
  'Qwen Code':     { label: 'Qwen Code', kind: 'api-only', plans: [],
                     note: 'Free / API-only — use "API (custom)" to track deposits' },
  'OhMyPi':       { label: 'OhMyPi', kind: 'api-only', plans: [],
                     note: 'API-provider backed — use "API (custom)" to track deposits' },
  'Kilo':          { label: 'Kilo', kind: 'api-only', plans: [],
                     note: 'Free / API-only — use "API (custom)" to track deposits' },
  'API (custom)':  { label: 'API (custom)', kind: 'api', plans: [],
                     note: 'Enter provider/balance label and deposit amount manually' }
};

// Rebuild the Plan slot in-place: <select> for normal services, <input> for API (custom).
// Service+plan values come from SERVICE_PLANS constants, but escape on principle (defence in depth).
function renderPlanSlot(cfg) {
  var slot = document.getElementById('sub-plan-slot');
  if (!slot) return;
  if (cfg && cfg.kind === 'api') {
    slot.innerHTML =
      '<label for="sub-new-plan" class="sr-only">Provider / balance label</label>' +
      '<input id="sub-new-plan" type="text" placeholder="Provider / balance label" ' +
      'maxlength="200" aria-describedby="sub-new-hint" ' +
      'oninput="updateAddButtonState()" autocomplete="off" />';
  } else if (cfg && cfg.plans && cfg.plans.length > 0) {
    var opts = '<option value="" disabled selected hidden>Select plan…</option>' + cfg.plans.map(function(p) {
      var nm = escHtml(String(p.name));
      var pr = escHtml(String(parseFloat(p.price) || 0));
      return '<option value="' + nm + '">' + nm + ' — $' + pr + '</option>';
    }).join('');
    slot.innerHTML =
      '<label for="sub-new-plan" class="sr-only">Plan</label>' +
      '<select id="sub-new-plan" aria-describedby="sub-new-hint" onchange="onSubPlanChange()">' + opts + '</select>';
  } else {
    // No service selected, or api-only with no plans → disabled placeholder select
    slot.innerHTML =
      '<label for="sub-new-plan" class="sr-only">Plan</label>' +
      '<select id="sub-new-plan" aria-describedby="sub-new-hint" disabled>' +
      '<option value="" disabled selected hidden>Select plan…</option></select>';
  }
}

function onSubServiceChange() {
  var serviceEl = document.getElementById('sub-new-service');
  var paidEl = document.getElementById('sub-new-paid');
  var service = serviceEl ? serviceEl.value.trim() : '';
  var cfg = SERVICE_PLANS[service];
  if (paidEl) {
    paidEl.value = '';
    paidEl.placeholder = cfg && cfg.kind === 'api' ? '$ deposit' : '$/mo';
  }
  renderPlanSlot(cfg);
  // hint text is fully driven by updateAddButtonState (priority: cfg.note > validation reason)
  updateAddButtonState();
}

function onSubPlanChange() {
  // Plan <select> emits the canonical plan name from SERVICE_PLANS, so a direct lookup is exact.
  var serviceEl = document.getElementById('sub-new-service');
  var planEl = document.getElementById('sub-new-plan');
  var paidEl = document.getElementById('sub-new-paid');
  var service = serviceEl ? serviceEl.value : '';
  var planName = planEl ? planEl.value : '';
  var cfg = SERVICE_PLANS[service];
  if (cfg && planName) {
    var found = cfg.plans.find(function(p) { return p.name === planName; });
    if (found && paidEl) paidEl.value = found.price;
  }
  updateAddButtonState();
}

// Computes the validation gate for the Add button AND surfaces the reason
// to #sub-new-hint so SR/keyboard users learn why submission is blocked.
// All kinds (subscription + api) require a non-empty plan/provider field —
// user-confirmed decision (api deposits need a label like "Anthropic API balance").
function updateAddButtonState() {
  var btn = document.getElementById('sub-add-btn');
  if (!btn) return;
  var serviceEl = document.getElementById('sub-new-service');
  var planEl = document.getElementById('sub-new-plan');
  var paidEl = document.getElementById('sub-new-paid');
  var hintEl = document.getElementById('sub-new-hint');
  var service = serviceEl ? serviceEl.value.trim() : '';
  var paid = parseFloat(paidEl && paidEl.value) || 0;
  var cfg = SERVICE_PLANS[service];
  var apiOnly = cfg && cfg.kind === 'api-only';
  var planFilled = !!(planEl && planEl.value && planEl.value.trim().length > 0);
  btn.disabled = apiOnly || !service || paid <= 0 || !planFilled;
  if (!hintEl) return;
  // Priority: service-level note (free/api-only guidance) > validation reason > empty.
  // cfg.note already covers the api-only case, so we don't repeat it as a reason.
  var msg = '';
  if (cfg && cfg.note) msg = cfg.note;
  else if (!service) msg = '';
  else if (!planFilled) msg = cfg && cfg.kind === 'api' ? 'Enter provider / balance label' : 'Select a plan';
  else if (paid <= 0) msg = 'Enter amount greater than 0';
  hintEl.textContent = msg;
}

// ── Subscription config helpers ──────────────────────────────────
function getSubscriptionConfig() {
  var raw;
  try { raw = JSON.parse(localStorage.getItem('codedash-subscription') || 'null'); }
  catch (e) { raw = null; }
  if (!raw) return { entries: [] };
  // Migrate old single-entry format {plan, paid} → new multi-period {entries: [...]}.
  // Legacy entries are tagged with a "(legacy) " prefix so users see which rows
  // pre-date the service/kind fields (BDD: specs/analytics-subscriptions.feature scenario "Migration from old single-entry format").
  if (!raw.entries) {
    return { entries: [{
      kind: 'subscription',
      service: '',
      plan: '(legacy) ' + (raw.plan || 'Subscription'),
      paid: raw.paid || 0,
      from: ''
    }] };
  }
  // Ensure every entry has a kind (default: subscription). Build immutable copies
  // to avoid sharing mutated references with callers (defence in depth).
  var migrated = [];
  for (var i = 0; i < raw.entries.length; i++) {
    var e = raw.entries[i];
    if (!e || typeof e !== 'object') continue;
    migrated.push({
      kind: e.kind || 'subscription',
      service: e.service || '',
      plan: e.plan || 'Subscription',
      paid: parseFloat(e.paid) || 0,
      from: e.from || ''
    });
  }
  return { entries: migrated };
}
function saveSubscriptionConfig(cfg) { localStorage.setItem('codedash-subscription', JSON.stringify(cfg)); }
function subTotalPaid(entries) { return entries.reduce(function(s,e){return s+(parseFloat(e.paid)||0);},0); }
function addSubEntry() {
  var serviceEl = document.getElementById('sub-new-service');
  var planEl = document.getElementById('sub-new-plan');
  var paidEl = document.getElementById('sub-new-paid');
  var fromEl = document.getElementById('sub-new-from');
  if (!serviceEl || !paidEl) return;
  var service = (serviceEl.value || '').trim();
  var plan = planEl ? planEl.value.trim() : '';
  var paid = parseFloat(paidEl.value) || 0;
  var from = fromEl ? (fromEl.value || '').trim() : '';
  if (!service || paid <= 0 || !plan) return;
  var cfg = SERVICE_PLANS[service];
  if (cfg && cfg.kind === 'api-only') return;
  var kind = cfg && cfg.kind === 'api' ? 'api' : 'subscription';
  _analyticsHtmlCache = null;
  _analyticsCacheUrl = null;
  var sub = getSubscriptionConfig();
  sub.entries.push({ kind: kind, service: service, plan: plan, paid: paid, from: from });
  sub.entries.sort(function(a,b){return (a.from||'').localeCompare(b.from||'');});
  saveSubscriptionConfig(sub);
  // Announce BEFORE render() to keep the live region in DOM when SR reads it.
  // Includes service+plan for context (UX: NN/g status visibility).
  var live = document.getElementById('sub-aria-live');
  if (live) {
    live.textContent = kind === 'api'
      ? service + ' ' + plan + ' deposit added: $' + paid.toFixed(2)
      : service + ' ' + plan + ' subscription added: $' + paid.toFixed(2) + ' per month';
  }
  render();
}
function removeSubEntry(idx) {
  _analyticsHtmlCache = null;
  _analyticsCacheUrl = null;
  var sub = getSubscriptionConfig();
  var removed = sub.entries[idx];
  sub.entries.splice(idx, 1);
  saveSubscriptionConfig(sub);
  // Announce BEFORE render() rebuilds the DOM (BDD: aria-live announces "removed").
  var live = document.getElementById('sub-aria-live');
  if (live && removed) {
    live.textContent = (removed.kind === 'api' ? 'API deposit' : 'Subscription') + ' removed';
  }
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

function toggleAllSessionsListBadges(checked) {
  showAllSessionsListBadges = checked;
  localStorage.setItem('codedash-all-sessions-list-badges', checked ? 'true' : 'false');
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

var _loadSessionsInFlight = false;

async function loadSessions() {
  if (_loadSessionsInFlight) return;
  _loadSessionsInFlight = true;
  try {
    var resp = await fetch('/api/sessions');
    allSessions = await resp.json();
    // Invalidate analytics cache so stale aggregates are not shown
    _analyticsHtmlCache = null;
    _analyticsCacheUrl = null;
    applyFilters();
    // Keep the Overview landing in sync once sessions land (it renders before
    // this fetch resolves on a cold start).
    if (typeof _ovRefreshIfCurrent === 'function') _ovRefreshIfCurrent();
    // Progressive loading: if server is still loading cursor vscdb sessions, auto-refresh
    if (resp.headers.get('X-Loading') === '1') {
      setTimeout(loadSessions, 2000);
    }
  } catch (e) {
    document.getElementById('content').innerHTML = '<div class="empty-state">Failed to load sessions. Is the server running?</div>';
  } finally {
    _loadSessionsInFlight = false;
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

    // Build new state. Entries with an empty sessionId (backend's
    // 'unmatched' source — known cwd but no Codex session matched it yet)
    // are still surfaced under a synthetic 'pid:<pid>' key so the Agent
    // Board can show them honestly instead of dropping them.
    var newActive = {};
    data.forEach(function(a) {
      if (a.sessionId) {
        newActive[a.sessionId] = a;
      } else if (a.pid) {
        newActive['pid:' + a.pid] = a;
      }
    });

    // Check if anything changed — skip DOM work if not. Note: _prevActiveKey is
    // set at the END of this function, not here, because render() (invoked below
    // for the running view, and elsewhere on navigation) resets it to '' to force
    // a badge re-apply; setting it last means that reset can't spin a re-render.
    var newKey = data.map(function(a) { return (a.sessionId || a.pid) + ':' + a.status; }).sort().join(',');
    if (newKey === _prevActiveKey) return;

    activeSessions = newActive;

    // Reflect the new active-agent count on the Overview landing and refresh
    // the sidebar running-agents tree (which is driven by activeSessions now).
    if (typeof _ovRefreshIfCurrent === 'function') _ovRefreshIfCurrent();
    if (typeof _wsRenderRunningTree === 'function') _wsRenderRunningTree();
    // The Running (Agent Board) view is built from activeSessions but isn't a
    // per-card diff, so rebuild it when the active set changes.
    if (currentView === 'running') render();

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

    // Record the applied state last, so a render()-triggered reset above is
    // superseded and the next unchanged poll can early-return.
    _prevActiveKey = newKey;
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
    session.session_name || '',
    session.recap || '',
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
    if (piVariantFilter) {
      if (s.tool !== 'pi') continue;
      var variant = s.agent_variant === 'ohmypi' ? 'ohmypi' : 'pi';
      if (variant !== piVariantFilter) continue;
    }

    // Git project drill-down filter (always uses git-root key, independent of groupingMode)
    if (gitProjectFilter) {
      var sessionProjectKey = getRepoInfo(s.project, s.git_root).key;
      if (sessionProjectKey !== gitProjectFilter.key) continue;
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
  var cost = getEstimatedSessionCost(s);
  var costStr = cost > 0 ? '~$' + cost.toFixed(2) : '';
  var projName = getProjectName(s.project);
  var projColor = getProjectColor(projName);
  var toolClass = 'tool-' + s.tool;
  var toolLabel = getToolLabel(s.tool, true);

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
  html += renderToolBadges(s.tool, s);
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
  var displayName = getSessionDisplayName(s);
  if (aiTitle) {
    html += '<div class="card-title">' + escHtml(aiTitle) + '</div>';
    html += '<div class="card-body card-body-sub">' + escHtml(displayName.slice(0, 80)) + '</div>';
  } else {
    html += '<div class="card-body">' + escHtml(displayName.slice(0, 120)) + '</div>';
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
  // Two launch actions for a session with a known project folder:
  //   • native terminal (iTerm2/Terminal.app/…) via /api/launch — a terminal
  //     icon; resumes CLI agents, "open in Cursor" for Cursor, hidden for the
  //     VS Code-only Copilot Chat (no terminal to resume into).
  //   • in-app Workspace terminal (▶) with the resume command prefilled.
  if (s.git_root || s.project) {
    var _projPath = s.git_root || s.project;
    var _termIcon = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px"><rect x="2" y="3" width="20" height="18" rx="2"/><polyline points="6 8 9 11 6 14"/><line x1="12" y1="15" x2="17" y2="15"/></svg>';
    if (s.tool === 'cursor') {
      html += '<button class="card-gen-btn card-launch-native" onclick="event.stopPropagation();openInCursor(\'' + escJsString(_projPath) + '\')" title="Open project in Cursor">' + _termIcon + '</button>';
    } else if (s.tool !== 'copilot-chat') {
      html += '<button class="card-gen-btn card-launch-native" onclick="event.stopPropagation();resumeLastProjectSession(\'' + escJsString(s.id) + '\',\'' + escJsString(s.tool || '') + '\',\'' + escJsString(_projPath) + '\',this)" title="Resume in native terminal (' + escHtml(agentLabel(s.tool)) + ')">' + _termIcon + '</button>';
    }
    html += '<button class="card-gen-btn card-open-here" onclick="event.stopPropagation();openSessionInWorkspace(\'' + escJsString(s.id) + '\')" title="Open in the in-app terminal (resume prefilled)">&#9654;</button>';
  }
  if (s.has_detail) {
    var btnTitle = sessionTitles[s.id] ? 'Regenerate AI title' : 'Generate AI title';
    var btnIcon = sessionTitles[s.id] ? '&#8635;' : '&#9883;';
    html += '<button class="card-gen-btn" onclick="event.stopPropagation();generateTitle(\'' + escJsString(s.id) + '\',\'' + escJsString(s.project || '') + '\')" title="' + btnTitle + '">' + btnIcon + '</button>';
    html += '<button class="card-expand-btn" onclick="event.stopPropagation();toggleExpand(\'' + escJsString(s.id) + '\',\'' + escJsString(s.project || '') + '\',this)" title="Preview messages">&#9662;</button>';
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
  var showBadges = showAllSessionsListBadges;

  var classes = 'list-row';
  if (isSelected) classes += ' selected';
  if (isFocused) classes += ' focused';

  var html = '<div class="' + classes + '" data-id="' + s.id + '" onclick="onCardClick(\'' + s.id + '\', event)">';
  html += renderToolBadges(s.tool, s);
  if (showBadges && s.mcp_servers && s.mcp_servers.length > 0) {
    s.mcp_servers.forEach(function(m) {
      html += '<span class="tool-badge badge-mcp">' + escHtml(m) + '</span>';
    });
  }
  if (showBadges && s.skills && s.skills.length > 0) {
    s.skills.forEach(function(sk) {
      html += '<span class="tool-badge badge-skill">' + escHtml(sk) + '</span>';
    });
  }
  html += '<span class="list-project" style="color:' + projColor + '">' + escHtml(projName) + '</span>';
  html += '<span class="list-msg">' + escHtml(getSessionDisplayName(s).slice(0, 80)) + '</span>';
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

  // Reflect the active view on <body> so CSS can hide chrome that only makes
  // sense over a session list — e.g. the session toolbar (Search/Group/Select/
  // AI Titles/Refresh + count) is meaningless in the Terminal and Overview views.
  document.body.setAttribute('data-view', currentView);

  // Rebuilding content wipes the live/active badges the active-poll diff added.
  // Reset the diff key so the next poll re-applies them (it otherwise early-
  // returns on an unchanged active set and the badges never come back).
  _prevActiveKey = '';

  // Detach (don't destroy) the live terminal when navigating away from the
  // Workspace view: its panes/ptys keep running in a hidden holder and are
  // re-attached intact on return.
  if (currentView !== 'workspace' && typeof detachWorkspaceIfMounted === 'function') {
    detachWorkspaceIfMounted();
  }

  // Preserve scroll + collapsed state across re-renders
  var scrollTop = content.scrollTop;
  var collapsedGroups = new Set();
  content.querySelectorAll('.group.collapsed, .git-project-group.collapsed').forEach(function(g) {
    var header = g.querySelector('.group-header, .git-project-header');
    if (header) {
      var name = header.querySelector('.group-name, .git-project-name');
      if (name) collapsedGroups.add(name.textContent.trim());
    }
  });

  var sessions = filteredSessions;

  // Stats
  if (stats) {
    var statsText = sessions.length + ' sessions';
    if (piVariantFilter) statsText += ' (' + (piVariantFilter === 'ohmypi' ? 'OhMyPi' : 'Pi') + ')';
    else if (toolFilter) statsText += ' (' + toolFilter + ')';
    if (tagFilter) statsText += ' [' + tagFilter + ']';
    stats.textContent = statsText;
  }

  // Project filter breadcrumb
  var existingBreadcrumb = document.getElementById('gitProjectBreadcrumb');
  if (gitProjectFilter && currentView === 'sessions') {
    if (!existingBreadcrumb) {
      var bc = document.createElement('div');
      bc.id = 'gitProjectBreadcrumb';
      bc.className = 'git-project-breadcrumb';
      var toolbar = document.querySelector('.toolbar');
      if (toolbar) toolbar.parentNode.insertBefore(bc, toolbar.nextSibling);
    }
    document.getElementById('gitProjectBreadcrumb').innerHTML =
      '<span class="bc-label">Project:</span>' +
      '<span class="bc-name">' + escHtml(gitProjectFilter.name) + '</span>' +
      '<button class="bc-clear" onclick="clearGitProjectFilter()" title="Show all projects">&times; Clear filter</button>';
  } else if (existingBreadcrumb) {
    existingBreadcrumb.remove();
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

  if (currentView === 'recommended') {
    renderRecommended(content);
    return;
  }

  if (currentView === 'workspace') {
    renderWorkspace(content);
    return;
  }

  if (currentView === 'overview') {
    renderOverview(content);
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

  // Restore scroll + collapsed state
  if (collapsedGroups.size > 0) {
    content.querySelectorAll('.group, .git-project-group').forEach(function(g) {
      var header = g.querySelector('.group-header, .git-project-header');
      if (header) {
        var name = header.querySelector('.group-name, .git-project-name');
        if (name && collapsedGroups.has(name.textContent.trim())) {
          g.classList.add('collapsed');
        }
      }
    });
  }
  if (scrollTop) content.scrollTop = scrollTop;
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
  var html = '<div style="display:flex;gap:8px;margin-bottom:12px">';
  html += '<button class="toolbar-btn" onclick="document.querySelectorAll(\'.group\').forEach(function(g){g.classList.add(\'collapsed\')})">Collapse All</button>';
  html += '<button class="toolbar-btn" onclick="document.querySelectorAll(\'.group\').forEach(function(g){g.classList.remove(\'collapsed\')})">Expand All</button>';
  html += '</div>';
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
  var toolLabel = getToolLabel(s.tool, true);
  var toolClass = 'tool-' + s.tool;
  var cost = getEstimatedSessionCost(s);
  var costStr = cost > 0 ? '~$' + cost.toFixed(2) : '';
  var classes = 'qa-item' + (selectedIds.has(s.id) ? ' selected' : '');

  var html = '<div class="' + classes + '" data-id="' + s.id + '" onclick="onCardClick(\'' + s.id + '\', event)">';
  html += renderToolBadges(s.tool, s);
  html += '<span class="qa-question">' + escHtml(getSessionDisplayName(s).slice(0, 160)) + '</span>';
  html += '<span class="qa-meta">';
  html += '<span class="qa-msgs">' + s.messages + ' msgs</span>';
  if (costStr) html += '<span class="cost-badge">' + costStr + '</span>';
  html += '<span class="qa-time">' + timeAgo(s.last_ts) + '</span>';
  html += '</span>';
  html += '<button class="star-btn' + (isStarred ? ' active' : '') + '" onclick="event.stopPropagation();toggleStar(\'' + s.id + '\')" title="Star">&#9733;</button>';
  html += '</div>';
  return html;
}

// Dispatcher: routes Projects view to either the launcher landing or the
// History sub-page based on currentProjectsSubtab. Keeps backwards-compat
// callers (renderProjects(container, sessions)) working.
function renderProjects(container, sessions) {
  var subtab = currentProjectsSubtab || 'projects';
  // Keep URL hash in sync with the rendered subtab so copying the URL produces
  // a link to what the user actually sees. replaceState avoids creating an
  // extra history entry on each render.
  var expectedHash = '#' + subtab;
  if (location.hash !== expectedHash) {
    try { history.replaceState(null, '', expectedHash); }
    catch (e) { /* ignore — non-browser test envs */ }
  }
  var stripHtml = renderProjectsSubtabStrip(subtab);
  if (subtab === 'history') {
    container.innerHTML = stripHtml + '<div id="projectsHistoryContent" role="tabpanel" aria-labelledby="projectsSubtabHistory"></div>';
    var historyEl = container.querySelector('#projectsHistoryContent');
    renderProjectsHistory(historyEl, sessions);
  } else {
    container.innerHTML = stripHtml + '<div id="projectsLandingContent" role="tabpanel" aria-labelledby="projectsSubtabProjects"></div>';
    var landingEl = container.querySelector('#projectsLandingContent');
    renderProjectsLanding(landingEl, sessions);
  }
}

function renderProjectsSubtabStrip(active) {
  var safe = active === 'history' ? 'history' : 'projects';
  // WAI-ARIA tab pattern: tablist + tab + tabpanel. The strip is keyboard-
  // reachable via Tab, and left/right arrows are wired in onProjectsKeydown.
  return '<div class="projects-subtabs" role="tablist" aria-label="Projects subtabs" onkeydown="onProjectsSubtabKey(event)">' +
    '<button id="projectsSubtabProjects" class="projects-subtab' + (safe === 'projects' ? ' active' : '') + '" ' +
      'role="tab" aria-selected="' + (safe === 'projects' ? 'true' : 'false') + '" ' +
      'aria-controls="projectsLandingContent" tabindex="' + (safe === 'projects' ? '0' : '-1') + '" ' +
      'onclick="switchProjectsSubtab(\'projects\')">Projects</button>' +
    '<button id="projectsSubtabHistory" class="projects-subtab' + (safe === 'history' ? ' active' : '') + '" ' +
      'role="tab" aria-selected="' + (safe === 'history' ? 'true' : 'false') + '" ' +
      'aria-controls="projectsHistoryContent" tabindex="' + (safe === 'history' ? '0' : '-1') + '" ' +
      'onclick="switchProjectsSubtab(\'history\')">History</button>' +
    '</div>';
}

// Left/Right cycle between the two subtabs, Home/End jump to ends — standard
// WAI-ARIA tablist behavior.
function onProjectsSubtabKey(e) {
  var k = e.key;
  if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End') {
    e.preventDefault();
    var next = (k === 'ArrowRight' || k === 'End') ? 'history' : 'projects';
    setProjectsSubtab(next);
    var focusId = next === 'projects' ? 'projectsSubtabProjects' : 'projectsSubtabHistory';
    var el = document.getElementById(focusId);
    if (el) el.focus();
  }
}

// Single mutator for the subtab — every caller goes through here so the
// localStorage value, the hash, and the variable can never drift apart.
function setProjectsSubtab(next) {
  if (next !== 'projects' && next !== 'history') return;
  if (currentProjectsSubtab === next) {
    // Even when value is unchanged we may need to re-render (e.g. filter
    // changed). Caller is responsible for invoking render() if so.
    return;
  }
  currentProjectsSubtab = next;
  try { localStorage.setItem('codedash-projects-subtab', next); } catch (e) { /* private-mode safe */ }
  // replaceState keeps the URL in sync without creating a fresh history
  // entry on every click — back-button still works between subtabs because
  // hashchange listens for explicit user navigation.
  try { history.replaceState(null, '', '#' + next); }
  catch (e) { location.hash = next; }
  render();
}

function switchProjectsSubtab(next) {
  // Backward-compat name kept for the inline onclick handlers in the strip.
  setProjectsSubtab(next);
}

// Landing page — launcher cards. One per registered project plus, optionally,
// projects that have sessions but no registry entry yet (so the user can still
// resume them with one click).
function renderProjectsLanding(container, sessions) {
  // Projects landing shows ONLY the registry — projects you explicitly added
  // via "+ Add Project", cloned from GitHub, or that got auto-registered on
  // first launch. Session-derived folders (every directory that ever held a
  // Claude/Cursor/Codex session) live exclusively in the History subtab.
  // This keeps the launcher focused on "things I'm actively working on" and
  // not a dump of every workspace I've ever opened.
  var byPath = mergeRegistryWithSessions(sessions);
  // Filter to registry-only entries — `manualId` is set when the project came
  // from projects.json (manual / github-clone / auto). Pure session-derived
  // entries don't have it.
  var registryOnly = {};
  Object.keys(byPath).forEach(function(k) {
    if (byPath[k].manualId) registryOnly[k] = byPath[k];
  });
  var entries = sortMergedEntries(registryOnly);

  // Loading guard — keep the "no agent installed" banner from flashing on
  // first paint while /api/agents/installed is still in flight.
  var agentsLoaded = window._agentsDetectionLoaded === true;
  var installed = (window.installedAgents || []).map(function(a) { return a.id; });
  var canLaunch = installed.length > 0;

  var toolbar = '<div class="projects-toolbar" role="toolbar" aria-label="Projects actions">' +
    '<button class="toolbar-btn toolbar-btn-primary" onclick="openAddProject()" title="Register a local folder or clone from GitHub" aria-label="Add a new project">+ Add Project</button>' +
    '<button class="toolbar-btn" onclick="openProjectsSettings()" aria-label="Open projects settings">⚙ Settings</button>' +
    // Warning is only emitted once detection has actually completed — otherwise
    // a first-paint user sees the warning flash, then disappear half a second
    // later when the fetch resolves.
    (agentsLoaded && !canLaunch
      ? '<span class="projects-toolbar-warning" role="status">⚠ <span>Warning: no agent CLI detected on this machine — </span><a href="#install-agents" onclick="scrollToInstallAgents();return false;">install one</a> to launch sessions.</span>'
      : '') +
    '</div>';

  // Pre-detection skeleton — keeps the layout stable while the agents list
  // is loading and prevents disabled-button flicker.
  if (!agentsLoaded) {
    container.innerHTML = toolbar +
      '<div class="projects-launcher-grid" aria-busy="true">' +
      '<div class="launcher-card-skel"></div><div class="launcher-card-skel"></div><div class="launcher-card-skel"></div>' +
      '</div>';
    return;
  }

  if (entries.length === 0) {
    container.innerHTML = toolbar +
      '<div class="projects-empty">No registered projects yet.<br>' +
      '<button class="toolbar-btn toolbar-btn-primary" onclick="openAddProject()" style="margin:12px 0">+ Add Project</button><br>' +
      '<span style="font-size:12px">Register a local folder or clone one from GitHub. ' +
      'You can also start a fresh session in any git repo under your home directory ' +
      '— it will be auto-registered.<br><br>' +
      'Previous sessions are still available in the <strong>History</strong> subtab above.</span></div>';
    return;
  }

  var cardsHtml = '<div class="projects-launcher-grid">';
  entries.forEach(function(entry) {
    cardsHtml += renderLauncherCard(entry[0], entry[1]);
  });
  cardsHtml += '</div>';
  container.innerHTML = toolbar + cardsHtml;
}

function scrollToInstallAgents() {
  // Best-effort — there's no dedicated view, but the sidebar has an "Install
  // Agents" section the user can scroll the sidebar to.
  var section = Array.from(document.querySelectorAll('.sidebar-section'))
    .find(function(el) { return el.textContent && el.textContent.indexOf('Install Agents') >= 0; });
  if (section && section.scrollIntoView) section.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Anchored GitHub-remote check, matching the server's cloneRepo regex
// (src/projects.js). Used to decide whether to offer "Re-clone" — an unanchored
// substring test would show the button for a spoofed URL like
// https://evil.com/github.com/... that the server would then reject.
function isGithubRemote(url) {
  return typeof url === 'string' && /^(https:\/\/github\.com\/|git@github\.com:)/.test(url);
}

// Live Workspace panes whose resolved cwd is this project folder.
function _projectLiveTerminals(projPath) {
  if (!projPath || typeof _wsAllPanes !== 'function') return [];
  return _wsAllPanes().filter(function (x) {
    return x.pane && !x.pane.exited && x.pane.cwd === projPath;
  });
}

function renderLauncherCard(projKey, projInfo) {
  var projName = projInfo.name;
  var projPath = projInfo.path;
  var color = getProjectColor(projName);
  // Sort by last_ts desc so lastSession is reliably the most recent — the
  // upstream sessions feed doesn't guarantee insertion order matches recency.
  var list = (projInfo.list || []).slice().sort(function(a, b) { return (b.last_ts || 0) - (a.last_ts || 0); });
  var lastSession = list[0];
  var totalSessions = list.length;

  var sourceTag = '';
  if (projInfo.source === 'github-clone') sourceTag = '<span class="launcher-card-tag" title="Cloned from GitHub">github</span>';
  else if (projInfo.source === 'manual') sourceTag = '<span class="launcher-card-tag" title="Manually added">added</span>';
  else if (projInfo.source === 'auto') sourceTag = '<span class="launcher-card-tag" title="Auto-registered on first launch">auto</span>';

  var preferredTool = pickPreferredTool(projPath, lastSession);
  var installed = window.installedAgents || [];
  // A registered folder can be deleted from disk at any time; `_exists === false`
  // comes from the server's on-disk check. When missing, we suppress the launch
  // controls (they'd fail) and surface a re-clone/remove path instead.
  var exists = projInfo._exists !== false;
  var remoteUrl = projInfo._remoteUrl || '';
  var canReclone = !exists && isGithubRemote(remoteUrl);
  var canLaunch = installed.length > 0 && !!projPath && exists;

  var html = '<div class="launcher-card' + (exists ? '' : ' launcher-card-missing') + '">';
  html += '<div class="launcher-card-header">';
  html += '<span class="launcher-card-dot" style="background:' + color + '"></span>';
  html += '<span class="launcher-card-name" title="' + escHtml(projName) + '">' + escHtml(projName) + '</span>';
  html += sourceTag;
  html += '</div>';
  if (projPath) html += '<div class="launcher-card-path" title="' + escHtml(projPath) + '">' + escHtml(projPath) + '</div>';
  html += '<div class="launcher-card-meta">';
  html += '<span>' + (totalSessions === 0 ? 'no sessions yet' : (totalSessions + ' session' + (totalSessions === 1 ? '' : 's'))) + '</span>';
  if (exists && preferredTool) html += '<span>· next: ' + escHtml(agentLabel(preferredTool)) + '</span>';
  html += '</div>';

  // Disclaimer for a deleted/moved folder — persistent descriptive content, so
  // role="note" (not a live region: it's present on render, not a transient
  // status update — the launch-fail case is announced via toast instead).
  if (!exists) {
    html += '<div class="launcher-card-warning" role="note">' +
      '⚠ Folder is missing on disk — it was moved or deleted. ' +
      (canReclone
        ? 'Re-clone the latest version from GitHub.'
        : 'Restore the folder, or remove it from the list.') +
      '</div>';
  }

  if (!exists) {
    // Missing folder: no launch controls. Offer Re-clone (when we have a GitHub
    // remote) and Remove-from-registry. Only emit the actions row if at least
    // one control will render, so an edge-case card isn't left with an empty box.
    var missingActions = '';
    if (canReclone) {
      var recloneAria = 'Re-clone ' + projName + ' from GitHub';
      missingActions += '<button class="git-project-launch-btn primary reclone-btn" ' +
        'data-proj-id="' + escHtml(projInfo.manualId || '') + '" data-proj-name="' + escHtml(projName) + '" ' +
        'onclick="recloneProject(this.dataset.projId, this.dataset.projName, this)" ' +
        'title="' + escHtml('Re-download the latest version from GitHub into ' + projPath) + '" ' +
        'aria-label="' + escHtml(recloneAria) + '">↓ Re-clone</button>';
    }
    if (projInfo.manualId) {
      missingActions += '<button class="git-project-launch-btn" data-proj-id="' + escHtml(projInfo.manualId) + '" data-proj-name="' + escHtml(projName) + '" onclick="unregisterProject(this.dataset.projId,this.dataset.projName)" title="Remove from registry (does not delete files)" aria-label="Remove ' + escHtml(projName) + ' from the list">× Remove</button>';
    }
    if (missingActions) html += '<div class="launcher-card-actions">' + missingActions + '</div>';
    // Keep History drill-in available even when the folder is gone (sessions
    // live in the agent history dirs, not the repo).
    if (totalSessions > 0) {
      html += '<button class="launcher-card-link" data-proj-key="' + escHtml(projKey) + '" data-proj-name="' + escHtml(projName) + '" onclick="viewProjectInHistory(this.dataset.projKey,this.dataset.projName)">View ' + totalSessions + ' session' + (totalSessions === 1 ? '' : 's') + ' →</button>';
    }
    html += '</div>';
    return html;
  }
  if (canLaunch && preferredTool) {
    var newAria = 'Start new ' + agentLabel(preferredTool) + ' session in ' + projName;
    var pickerAria = 'Pick a different agent for ' + projName;
    html += '<span class="split-btn" role="group" aria-label="Launch ' + escHtml(projName) + '">';
    html += '<button class="git-project-launch-btn primary new-btn" ' +
      'data-proj-path="' + escHtml(projPath) + '" data-tool="' + escHtml(preferredTool) + '" ' +
      'onclick="launchNewProjectSession(this.dataset.projPath, this.dataset.tool)" ' +
      'title="' + escHtml(newAria) + '" aria-label="' + escHtml(newAria) + '">&#9654; New</button>';
    html += '<button class="git-project-launch-btn primary picker-btn" ' +
      'data-proj-path="' + escHtml(projPath) + '" ' +
      'onclick="openAgentPicker(event, this.dataset.projPath)" ' +
      'aria-label="' + escHtml(pickerAria) + '" aria-haspopup="menu" aria-expanded="false" ' +
      'title="' + escHtml(pickerAria) + '">&#9662;</button>';
    html += '</span>';
  } else if (projPath && !canLaunch) {
    // Make the disabled button actionable for keyboard/touch users — click
    // routes to the Install Agents sidebar section.
    html += '<button class="git-project-launch-btn" onclick="scrollToInstallAgents()" ' +
      'aria-label="Install an agent first" ' +
      'title="No agent installed — click to scroll to Install Agents">&#9654; Install an agent →</button>';
  }
  if (lastSession && canLaunch) {
    var lastId = lastSession.id || '';
    var sessTool = lastSession.tool || '';
    // If the session's original tool is no longer installed we still let the
    // user resume — but warn them; the server will surface the failure if
    // the tool can't actually be invoked.
    var installedSet = new Set(installed);
    var toolMissing = sessTool && !installedSet.has(sessTool);
    var lastTool = sessTool && installedSet.has(sessTool) ? sessTool : (preferredTool || 'claude');
    var lastTitle = toolMissing
      ? 'Resume last session (' + lastId.slice(0,8) + ') — original tool "' + sessTool + '" not detected, falling back to ' + agentLabel(lastTool)
      : 'Resume last session (' + lastId.slice(0,8) + ')';
    html += '<button class="git-project-launch-btn"' + (toolMissing ? ' aria-describedby="toolMissingHint"' : '') + ' data-sess-id="' + escHtml(lastId) + '" data-sess-tool="' + escHtml(lastTool) + '" data-proj-path="' + escHtml(projPath) + '" onclick="resumeLastProjectSession(this.dataset.sessId,this.dataset.sessTool,this.dataset.projPath)" title="' + escHtml(lastTitle) + '" aria-label="' + escHtml(lastTitle) + '">&#x21bb; Last</button>';
  }
  // Open in-app terminals (Workspace) pre-cd'd into this project folder (1-4).
  if (projPath) {
    html += '<select class="git-project-launch-btn ws-proj-term" title="Open terminals in this folder (in-app Workspace)" ' +
      'data-proj-path="' + escHtml(projPath) + '" ' +
      'onchange="spawnProjectTerminals(this.dataset.projPath, this.value); this.selectedIndex=0;">' +
      '<option value="">&#8862; Terminal &#9662;</option>' +
      '<option value="1">1 pane</option><option value="2">2 panes</option>' +
      '<option value="3">3 panes</option><option value="4">4 panes</option>' +
      '</select>';
  }
  if (projInfo.manualId) {
    html += '<button class="git-project-launch-btn" data-proj-id="' + escHtml(projInfo.manualId) + '" data-proj-name="' + escHtml(projName) + '" onclick="unregisterProject(this.dataset.projId,this.dataset.projName)" title="Remove from registry (does not delete files)">&times;</button>';
  }
  html += '</div>';

  // Show terminals already running in this folder, with a jump-to link.
  var liveT = _projectLiveTerminals(projPath);
  if (liveT.length) {
    var first = liveT[0];
    html += '<button class="launcher-card-link launcher-card-term" ' +
      'data-tab="' + escHtml(first.tab.id) + '" data-pane="' + escHtml(first.pane.id) + '" ' +
      'onclick="jumpToWorkspacePane(this.dataset.tab, this.dataset.pane)">&#9679; ' +
      liveT.length + ' terminal' + (liveT.length === 1 ? '' : 's') + ' running &rarr;</button>';
  }

  if (totalSessions > 0) {
    html += '<button class="launcher-card-link" data-proj-key="' + escHtml(projKey) + '" data-proj-name="' + escHtml(projName) + '" onclick="viewProjectInHistory(this.dataset.projKey,this.dataset.projName)">View ' + totalSessions + ' session' + (totalSessions === 1 ? '' : 's') + ' →</button>';
  }
  html += '</div>';
  return html;
}

function mergeRegistryWithSessions(sessions) {
  var byGit = {};
  sessions.forEach(function(s) {
    var info = getRepoInfo(s.project, s.git_root);
    if (!byGit[info.key]) byGit[info.key] = { name: info.name, list: [], path: info.key !== 'unknown' ? info.key : '', source: 'session', manualId: '' };
    byGit[info.key].list.push(s);
  });
  (window.manualProjects || []).forEach(function(p) {
    // `exists` is undefined for older payloads / session-derived merges — treat
    // absence as "present" so we never falsely flag a folder as missing.
    var exists = p.exists !== false;
    if (!byGit[p.path]) {
      byGit[p.path] = { name: p.name, list: [], path: p.path, source: p.source || 'manual', manualId: p.id, _git: p.git, _lastAdded: p.addedAt, _exists: exists, _remoteUrl: p.remoteUrl || '' };
    } else {
      // When a registry entry overlaps a session-derived entry, the registry's
      // `source` (manual / github-clone / auto) is the authoritative one — only
      // `session` is a placeholder we replace. This prevents auto-registered
      // projects from being silently relabeled as `manual` after their first
      // session appears.
      var existing = byGit[p.path];
      var keepRegistrySource = p.source && p.source !== 'session';
      var resolvedSource = keepRegistrySource
        ? p.source
        : ((!existing.source || existing.source === 'session') ? 'manual' : existing.source);
      byGit[p.path] = { ...existing, manualId: p.id, source: resolvedSource, _exists: exists, _remoteUrl: p.remoteUrl || existing._remoteUrl || '' };
    }
  });
  return byGit;
}

// Shared sort: most-recent session timestamp first; falls back to the
// registry add date when no session exists yet.
// Most-recent timestamp across all of a project's sessions; falls back to the
// registry add date when there are no sessions yet. Used to sort the launcher
// grid by activity (desc) so the project you used most recently is on top.
function projectActivityTs(projInfo) {
  if (projInfo.list && projInfo.list.length) {
    var maxTs = 0;
    for (var i = 0; i < projInfo.list.length; i++) {
      var t = projInfo.list[i].last_ts;
      if (t && t > maxTs) maxTs = t;
    }
    if (maxTs) return maxTs;
  }
  return projInfo._lastAdded ? Date.parse(projInfo._lastAdded) : 0;
}

function sortMergedEntries(byPath) {
  return Object.entries(byPath).sort(function(a, b) {
    return projectActivityTs(b[1]) - projectActivityTs(a[1]);
  });
}

function pickPreferredTool(projectPath, lastSession) {
  var settings = window.codbashSettings || {};
  var installed = (window.installedAgents || []).map(function(a) { return a.id; });
  var installedSet = new Set(installed);
  // 1. Server-tracked last-used (survives across machines if settings sync)
  var fromSettings = settings.lastUsedByPath ? settings.lastUsedByPath[projectPath] : null;
  if (fromSettings && installedSet.has(fromSettings)) return fromSettings;
  // 2. Most recent session in this project (local observation)
  if (lastSession && lastSession.tool && installedSet.has(lastSession.tool)) return lastSession.tool;
  // 3. Configured default
  if (settings.defaultAgent && installedSet.has(settings.defaultAgent)) return settings.defaultAgent;
  // 4. First installed
  return installed.length > 0 ? installed[0] : null;
}

// Hard-coded labels so we can render a friendly name even when /api/agents/installed
// has not returned yet (or when the tool is no longer detected on this box).
const _AGENT_LABEL_FALLBACK = {
  claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', qwen: 'Qwen Code', pi: 'Pi/OhMyPi',
  kilo: 'Kilo', kiro: 'Kiro CLI', opencode: 'OpenCode',
  copilot: 'Copilot CLI', 'copilot-chat': 'Copilot Chat',
};
function agentLabel(id) {
  var found = (window.installedAgents || []).find(function(a) { return a.id === id; });
  return found ? found.label : (_AGENT_LABEL_FALLBACK[id] || id);
}

// History-scoped filter — kept separate from the global gitProjectFilter so
// that clicking "View N sessions →" on a launcher card never leaves the
// Projects view. The legacy drillIntoGitProject() filter pushes the user to
// the Sessions sidebar item and clobbers the subtab context.
let historyProjectFilter = null;

function viewProjectInHistory(projKey, projName) {
  historyProjectFilter = { key: projKey, name: projName };
  setProjectsSubtab('history');
}

function clearHistoryProjectFilter() {
  if (!historyProjectFilter) return;
  historyProjectFilter = null;
  if (currentView === 'projects') render();
}

// History subtab — preserves the exact behavior of the old Projects view.
// Only addition: if `historyProjectFilter` is set (via "View N sessions →"
// from a launcher card), the merged map is filtered to just that project so
// the user lands on a focused list instead of the full registry.
function renderProjectsHistory(container, sessions) {
  var byGit = mergeRegistryWithSessions(sessions);

  // Apply the History-scoped filter if a card pushed us here.
  if (historyProjectFilter && historyProjectFilter.key) {
    var filtered = {};
    if (Object.prototype.hasOwnProperty.call(byGit, historyProjectFilter.key)) {
      filtered[historyProjectFilter.key] = byGit[historyProjectFilter.key];
    }
    byGit = filtered;
  }

  var sorted = sortMergedEntries(byGit);

  var html = '';
  if (historyProjectFilter) {
    html += '<div class="history-filter-bar" role="status">' +
      'Filtered to <strong>' + escHtml(historyProjectFilter.name) + '</strong> ' +
      '<button class="toolbar-btn" onclick="clearHistoryProjectFilter()" aria-label="Clear project filter">&times; Clear filter</button>' +
      '</div>';
  }
  html += '<div style="display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap">';
  html += '<button class="toolbar-btn" onclick="openAddProject()" title="Register a local folder or clone from GitHub" style="background:#3b82f6;color:#fff;border-color:#3b82f6">+ Add Project</button>';
  html += '<button class="toolbar-btn" onclick="document.querySelectorAll(\'.git-project-group\').forEach(function(g){g.classList.add(\'collapsed\')})">Collapse All</button>';
  html += '<button class="toolbar-btn" onclick="document.querySelectorAll(\'.git-project-group\').forEach(function(g){g.classList.remove(\'collapsed\')})">Expand All</button>';
  if (sorted.length > 0) html += renderRepoRefreshGlobalToggle();
  html += '</div>';

  if (sorted.length === 0) {
    var msg = historyProjectFilter
      ? 'No sessions for <strong>' + escHtml(historyProjectFilter.name) + '</strong>.'
      : 'No sessions yet. Launch a session from the <strong>Projects</strong> subtab and it will appear here.';
    container.innerHTML = html + '<div class="empty-state">' + msg + '</div>';
    return;
  }

  var globalIdx = 0;
  html += '<div class="git-projects">';
  sorted.forEach(function(entry) {
    var projKey = entry[0];
    var projInfo = entry[1];
    var projName = projInfo.name;
    var projPath = projInfo.path;
    var list = projInfo.list.slice().sort(function(a, b) { return b.last_ts - a.last_ts; });
    var color = getProjectColor(projName);
    var totalMsgs = list.reduce(function(s, e) { return s + (e.messages || 0); }, 0);
    var totalCost = list.reduce(function(s, e) { return s + getEstimatedSessionCost(e); }, 0);
    var costLabel = totalCost > 0 ? ' · ~$' + totalCost.toFixed(2) : '';
    var lastSession = list[0]; // most recent

    var sourceTag = '';
    if (projInfo.source === 'github-clone') sourceTag = '<span class="git-project-source-tag" title="Cloned from GitHub">github</span>';
    else if (projInfo.source === 'manual') sourceTag = '<span class="git-project-source-tag" title="Manually added">added</span>';

    var statsLine = list.length === 0
      ? 'no sessions yet'
      : (list.length + ' sessions · ' + totalMsgs + ' msgs' + costLabel);

    html += '<div class="git-project-group' + (list.length === 0 ? ' collapsed' : '') + '">';
    html += '<div class="git-project-header" onclick="this.parentElement.classList.toggle(\'collapsed\')">';
    html += '<span class="group-dot" style="background:' + color + '"></span>';
    html += '<span class="git-project-name">' + escHtml(projName) + sourceTag + '</span>';
    html += '<span class="git-project-stats">' + escHtml(statsLine) + '</span>';

    // Launch buttons — fresh + resume last. Only render if we know the local path.
    if (projPath) {
      // Prefer the tool the user actually worked with in this project; default
      // to claude for brand-new entries with no sessions yet.
      var preferredTool = lastSession && lastSession.tool ? lastSession.tool : 'claude';
      html += '<button class="git-project-launch-btn primary" data-proj-path="' + escHtml(projPath) + '" data-tool="' + escHtml(preferredTool) + '" onclick="event.stopPropagation();launchNewProjectSession(this.dataset.projPath, this.dataset.tool, this)" title="Start a new ' + escHtml(preferredTool) + ' session in this folder">&#9654; New</button>';
      if (lastSession) {
        var lastId = lastSession.id || '';
        var lastTool = lastSession.tool || 'claude';
        html += '<button class="git-project-launch-btn" data-sess-id="' + escHtml(lastId) + '" data-sess-tool="' + escHtml(lastTool) + '" data-proj-path="' + escHtml(projPath) + '" onclick="event.stopPropagation();resumeLastProjectSession(this.dataset.sessId,this.dataset.sessTool,this.dataset.projPath, this)" title="Resume last session (' + escHtml(lastId.slice(0,8)) + ')">&#x21bb; Last</button>';
      }
    }

    if (projInfo.manualId) {
      html += '<button class="git-project-launch-btn" data-proj-id="' + escHtml(projInfo.manualId) + '" data-proj-name="' + escHtml(projName) + '" onclick="event.stopPropagation();unregisterProject(this.dataset.projId,this.dataset.projName)" title="Remove from registry (does not delete files)">&times;</button>';
    }

    html += '<button class="git-project-open-btn" data-proj-key="' + escHtml(projKey) + '" data-proj-name="' + escHtml(projName) + '" onclick="event.stopPropagation();drillIntoGitProject(this.dataset.projKey,this.dataset.projName)" title="Show only this project\'s sessions">Open &rsaquo;</button>';
    html += renderRepoRefreshControls(projPath, projName);
    html += '<span class="group-chevron">&#9660;</span>';
    html += '</div>';
    html += '<div class="qa-list">';
    if (list.length === 0) {
      html += '<div class="empty-state" style="padding:16px;font-size:12px">No sessions yet. Click <strong>&#9654; New</strong> above to start one.</div>';
    } else {
      list.forEach(function(s) { html += renderQACard(s, globalIdx++); });
    }
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
  // Capture the target now: pendingDelete is a mutable global that Escape
  // (closeConfirm) nulls, so reading it after the awaits below would throw and
  // surface a false "Delete failed" if the user dismissed mid-request.
  var target = pendingDelete;
  try {
    var resp = await fetch('/api/session/' + target.id, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: target.project })
    });
    var data = await resp.json();
    if (data.ok) {
      showToast('Session deleted');
      allSessions = allSessions.filter(function(s) { return s.id !== target.id; });
      // Clear search if no more results
      if (searchQuery) {
        var remaining = allSessions.filter(function(s) {
          return (s.project || '').toLowerCase().indexOf(searchQuery.toLowerCase()) >= 0 ||
                 (s.session_name || '').toLowerCase().indexOf(searchQuery.toLowerCase()) >= 0 ||
                 (s.recap || '').toLowerCase().indexOf(searchQuery.toLowerCase()) >= 0 ||
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

    // Warn if some selected sessions are hidden by the current filter
    var visibleIds = new Set((filteredSessions || []).map(function(s) { return s.id; }));
    var hiddenCount = 0;
    selectedIds.forEach(function(id) { if (!visibleIds.has(id)) hiddenCount++; });
    var warning = document.getElementById('bulkHiddenWarning');
    var deleteBtn = document.getElementById('bulkDeleteBtn');
    if (hiddenCount > 0) {
      document.getElementById('bulkHiddenCount').textContent = hiddenCount;
      if (warning) warning.style.display = 'inline';
      if (deleteBtn) { deleteBtn.disabled = true; deleteBtn.title = 'Clear or deselect hidden sessions first'; }
    } else {
      if (warning) warning.style.display = 'none';
      if (deleteBtn) { deleteBtn.disabled = false; deleteBtn.title = ''; }
    }
  } else {
    bar.style.display = 'none';
  }
}

function clearHiddenSelections(event) {
  if (event) event.preventDefault();
  var visibleIds = new Set((filteredSessions || []).map(function(s) { return s.id; }));
  selectedIds.forEach(function(id) { if (!visibleIds.has(id)) selectedIds.delete(id); });
  updateBulkBar();
  render();
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

function drillIntoGitProject(key, name) {
  gitProjectFilter = { key: key, name: name };
  currentView = 'sessions';
  // Reset other filters so they don't silently suppress results
  searchQuery = '';
  tagFilter = '';
  dateFrom = '';
  dateTo = '';
  var searchBox = document.querySelector('.search-box');
  if (searchBox) searchBox.value = '';
  var tagSel = document.getElementById('tagFilter');
  if (tagSel) tagSel.value = '';
  updateDateBtn();
  document.querySelectorAll('.sidebar-item').forEach(function(el) {
    el.classList.toggle('active', el.getAttribute('data-view') === 'sessions');
  });
  applyFilters();
}

function clearGitProjectFilter() {
  gitProjectFilter = null;
  currentView = 'projects';
  document.querySelectorAll('.sidebar-item').forEach(function(el) {
    el.classList.toggle('active', el.getAttribute('data-view') === 'projects');
  });
  applyFilters();
}

// ── Themes ─────────────────────────────────────────────────────

function setTheme(theme) {
  // Add transition class briefly so theme swap cross-fades smoothly.
  // Removing it afterward keeps individual hover/click transitions snappy.
  document.documentElement.classList.add('theme-transition');
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
  setTimeout(function () {
    document.documentElement.classList.remove('theme-transition');
  }, 220);
}

function saveThemePref(val) {
  setTheme(val);
}

// ── Sidebar customization ─────────────────────────────────────
// Persisted via SidebarConfig helpers (sidebar-config.js).
// Runtime state mirrors localStorage; mutations go through setItemHidden /
// setSectionCollapsed (immutable) and then a single applySidebarConfig() pass
// reconciles the DOM. See specs/sidebar-customization.feature.

var _sidebarConfig = null;

function _storage() {
  try { return window.localStorage; } catch (e) { return null; }
}

function _initSidebarConfig() {
  if (_sidebarConfig) return _sidebarConfig;
  _sidebarConfig = SidebarConfig.loadFromStorage(_storage());
  return _sidebarConfig;
}

function applySidebarConfig() {
  var cfg = _initSidebarConfig();

  // Section groups always start collapsed (see markup); expanding a section is
  // a transient, per-session choice handled directly in the header click. We
  // deliberately do NOT drive .collapsed from stored config here, so the app
  // always opens tidy with the Overview in focus.

  // Items: hide based on data-key (preferred) or data-view (legacy fallback).
  // Settings is force-visible by isItemHidden.
  document.querySelectorAll('.sidebar-item').forEach(function(el) {
    var key = el.getAttribute('data-key') || el.getAttribute('data-view');
    if (!key) return;
    el.hidden = SidebarConfig.isItemHidden(cfg, key);
  });

  _updateSidebarEmptySectionHints();
}

// Attach a one-line "what it is & why" tooltip to every sidebar item, keyed by
// data-key (preferred) or data-view. The sidebar has overflow-x:hidden, so a
// pure-CSS ::after tooltip would be clipped — instead we render a single shared
// element appended to <body> and position it fixed on hover (same approach as
// the agent-picker popover). aria-label keeps it accessible to screen readers.
var _navTooltipEl = null;
var _navTooltipTimer = null;

function _getNavTooltipEl() {
  if (_navTooltipEl) return _navTooltipEl;
  var el = document.createElement('div');
  el.className = 'nav-tooltip';
  el.setAttribute('role', 'tooltip');
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  _navTooltipEl = el;
  return el;
}

function _hideNavTooltip() {
  clearTimeout(_navTooltipTimer);
  if (!_navTooltipEl) return;
  _navTooltipEl.classList.remove('visible');
  _navTooltipEl.setAttribute('aria-hidden', 'true');
}

function _onNavItemEnter(e) {
  var item = e.currentTarget;
  var help = item.getAttribute('data-tooltip');
  if (!help) return;
  clearTimeout(_navTooltipTimer);
  _navTooltipTimer = setTimeout(function() {
    var tip = _getNavTooltipEl();
    tip.textContent = help;
    // Show invisibly first to measure height, then clamp within the viewport.
    tip.style.visibility = 'hidden';
    tip.classList.add('visible');
    var r = item.getBoundingClientRect();
    var th = tip.offsetHeight;
    var top = r.top + (r.height - th) / 2;
    top = Math.max(8, Math.min(top, window.innerHeight - th - 8));
    tip.style.top = top + 'px';
    tip.style.left = (r.right + 10) + 'px';
    tip.style.visibility = '';
    tip.setAttribute('aria-hidden', 'false');
  }, 350);
}

function applyNavTooltips() {
  if (typeof SidebarConfig === 'undefined' || !SidebarConfig.navHelpFor) return;
  document.querySelectorAll('.sidebar-item').forEach(function(el) {
    var key = el.getAttribute('data-key') || el.getAttribute('data-view');
    var help = SidebarConfig.navHelpFor(key);
    if (!help) return;
    el.setAttribute('data-tooltip', help);
    if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', help);
    el.addEventListener('mouseenter', _onNavItemEnter);
    el.addEventListener('mouseleave', _hideNavTooltip);
    el.addEventListener('click', _hideNavTooltip);
  });
}

// When a user hides every togglable item inside a section the body becomes
// visually empty. Inject a small inline hint so the section doesn't look
// broken. The hint is removed automatically when any item becomes visible
// again. Sub-sections (install-agents) get their own hint independently.
function _updateSidebarEmptySectionHints() {
  document.querySelectorAll('.sidebar-section-body').forEach(function(body) {
    var hasVisibleItem = false;
    var items = body.querySelectorAll(':scope > .sidebar-item, :scope > .sidebar-subgroup .sidebar-item');
    for (var i = 0; i < items.length; i++) {
      if (!items[i].hidden) { hasVisibleItem = true; break; }
    }
    var existingHint = body.querySelector(':scope > .sidebar-empty-section-hint');
    if (hasVisibleItem) {
      if (existingHint) existingHint.parentNode.removeChild(existingHint);
    } else if (!existingHint) {
      var hint = document.createElement('div');
      hint.className = 'sidebar-empty-section-hint';
      hint.textContent = 'All items hidden — manage in Settings.';
      body.appendChild(hint);
    }
  });
}

function _onSidebarSectionHeaderClick(event) {
  var target = event.target.closest('[data-role="section-header"]');
  if (!target) return;
  event.stopPropagation();
  // Expansion is transient (per-session) — toggle the DOM directly rather than
  // persisting, so a reload always returns to the tidy all-collapsed start.
  var group = target.closest('.sidebar-group[data-section]');
  if (!group) return;
  var collapsed = group.classList.toggle('collapsed');
  target.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function _bindSidebarHeaders() {
  document.querySelectorAll('[data-role="section-header"]').forEach(function(btn) {
    btn.addEventListener('click', _onSidebarSectionHeaderClick);
  });
}

// Called from Settings → Sidebar checkboxes.
function toggleSidebarItem(key, visible) {
  if (key === SidebarConfig.SETTINGS_KEY) return; // refuse on UI side as well
  var cfg = _initSidebarConfig();
  _sidebarConfig = SidebarConfig.setItemHidden(cfg, key, !visible);
  SidebarConfig.saveToStorage(_storage(), _sidebarConfig);
  applySidebarConfig();
}

// Collapse/expand the entire sidebar to give the content full width. State is
// persisted so it survives reloads (applied pre-paint in index.html too).
function toggleSidebar(force) {
  var hide = (typeof force === 'boolean') ? force : !document.body.classList.contains('sidebar-hidden');
  document.body.classList.toggle('sidebar-hidden', hide);
  var st = _storage();
  try { if (st) { if (hide) st.setItem('codedash-sidebar-hidden', '1'); else st.removeItem('codedash-sidebar-hidden'); } } catch (e) {}
  // Terminals need a refit when the viewport width changes.
  if (typeof _wsRefitTab === 'function') setTimeout(function () { try { _wsRefitTab(_wsActiveTab()); } catch (e) {} }, 260);
}

function resetSidebarConfig() {
  _sidebarConfig = SidebarConfig.resetConfig();
  SidebarConfig.clearStorage(_storage());
  applySidebarConfig();
  // Re-render Settings so checkboxes reflect the cleared state.
  var content = document.getElementById('content');
  if (content && currentView === 'settings') renderSettings(content);
}

// Labels shown in Settings → Sidebar checklist. The map mirrors the visible
// text in the sidebar so the user matches what they see. Group label drives
// the visual section break in the Settings pane.
var SIDEBAR_ITEM_META = [
  { group: 'Workspace', items: [
    ['sessions', 'All Sessions'], ['projects', 'Projects'], ['timeline', 'Timeline'],
    ['activity', 'Activity'], ['running', 'Running'], ['analytics', 'Analytics'],
    ['starred', 'Starred'], ['leaderboard', 'Leaderboard'], ['cloud', 'Cloud Sync']
  ]},
  { group: 'Agents', items: [
    ['claude-only', 'Claude Code'], ['codex-only', 'Codex'], ['qwen-only', 'Qwen Code'],
    ['pi-original-only', 'Pi'], ['ohmypi-only', 'Oh My Pi'], ['kiro-only', 'Kiro'], ['cursor-only', 'Cursor'],
    ['copilot-chat-only', 'Copilot Chat'], ['copilot-only', 'Copilot CLI'], ['opencode-only', 'OpenCode'], ['kilo-only', 'Kilo']
  ]},
  { group: 'Tools', items: [
    ['export-import', 'Export / Import'], ['changelog', 'Changelog'],
    ['settings', 'Settings']   // rendered as disabled
  ]},
  { group: 'Install agents', items: [
    ['install:claude', 'Claude Code'], ['install:codex', 'Codex CLI'], ['install:qwen', 'Qwen Code'],
    ['install:pi', 'Pi'], ['install:ohmypi', 'Oh My Pi'], ['install:kiro', 'Kiro CLI'],
    ['install:opencode', 'OpenCode'], ['install:kilo', 'Kilo CLI'], ['install:copilot', 'Copilot CLI']
  ]}
];

function renderSidebarSettingsGroup() {
  var cfg = _initSidebarConfig();
  var html = '<div class="settings-group" id="settingsSidebarGroup">';
  html += '<label class="settings-label">Sidebar</label>';
  html += '<p class="settings-sidebar-description">Choose which entries appear in the left rail. Settings is always visible.</p>';

  SIDEBAR_ITEM_META.forEach(function(group) {
    html += '<div class="settings-sidebar-group-label">' + escHtml(group.group) + '</div>';
    html += '<div class="settings-sidebar-list">';
    group.items.forEach(function(pair) {
      var key = pair[0];
      var label = pair[1];
      var isSettings = key === SidebarConfig.SETTINGS_KEY;
      var visible = !SidebarConfig.isItemHidden(cfg, key);
      var rowClass = 'settings-sidebar-row' + (isSettings ? ' is-locked' : '');
      var title = isSettings ? ' title="Settings is always visible"' : '';
      var lockedLabel = isSettings ? ' aria-disabled="true"' : '';
      var disabledAttr = isSettings ? ' disabled aria-disabled="true"' : '';
      var checkedAttr = (visible || isSettings) ? ' checked' : '';
      // No inline onchange — single delegated listener is wired by
      // _bindSidebarSettingsDelegate() right after innerHTML is set. This
      // avoids attribute-context escaping concerns with string keys.
      var dataAttr = isSettings ? '' : ' data-sidebar-key="' + escHtml(key) + '"';
      html += '<label class="' + rowClass + '"' + title + lockedLabel + '>';
      html += '<input type="checkbox"' + disabledAttr + checkedAttr + dataAttr + '>';
      html += '<span>' + escHtml(label) + '</span>';
      html += '</label>';
    });
    html += '</div>';
  });

  html += '<div class="settings-sidebar-hint">';
  html += 'Click a section header in the sidebar to collapse it — the state is saved. ';
  html += 'Hidden items stay reachable: try <a href="#leaderboard">#leaderboard</a> in the address bar.';
  html += '</div>';

  html += '<div class="settings-sidebar-reset" id="sidebarResetWrap">';
  html += '<button type="button" class="settings-sidebar-reset-btn" data-stage="initial" onclick="onResetSidebarClick(event)">Reset to defaults</button>';
  html += '</div>';

  html += '</div>';
  return html;
}

// Two-stage reset: first click arms the button (highlights it red and changes
// label), second click within ~6s actually resets. Cancel button shown while
// armed. Prevents accidental wipeout per WCAG/NN/g destructive-action guidance.
var _resetArmedAt = 0;
var _resetArmedTimer = null;
var RESET_ARM_WINDOW_MS = 6000;

function onResetSidebarClick(event) {
  var btn = event.currentTarget;
  var now = Date.now();
  if (btn.getAttribute('data-stage') === 'armed' && (now - _resetArmedAt) < RESET_ARM_WINDOW_MS) {
    _disarmReset();
    resetSidebarConfig();
    _announceSidebar('Sidebar reset to defaults');
    return;
  }
  // Arm
  _resetArmedAt = now;
  btn.setAttribute('data-stage', 'armed');
  btn.classList.add('confirming');
  btn.textContent = 'Click again to confirm';
  var wrap = document.getElementById('sidebarResetWrap');
  if (wrap && !wrap.querySelector('.settings-sidebar-reset-cancel')) {
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'settings-sidebar-reset-cancel';
    cancel.textContent = 'Cancel';
    cancel.onclick = _disarmReset;
    wrap.appendChild(cancel);
  }
  if (_resetArmedTimer) clearTimeout(_resetArmedTimer);
  _resetArmedTimer = setTimeout(_disarmReset, RESET_ARM_WINDOW_MS);
}

function _disarmReset() {
  if (_resetArmedTimer) { clearTimeout(_resetArmedTimer); _resetArmedTimer = null; }
  _resetArmedAt = 0;
  var btn = document.querySelector('.settings-sidebar-reset-btn');
  if (btn) {
    btn.setAttribute('data-stage', 'initial');
    btn.classList.remove('confirming');
    btn.textContent = 'Reset to defaults';
  }
  var cancel = document.querySelector('.settings-sidebar-reset-cancel');
  if (cancel && cancel.parentNode) cancel.parentNode.removeChild(cancel);
}

function _bindSidebarSettingsDelegate() {
  var group = document.getElementById('settingsSidebarGroup');
  if (!group || group._delegateBound) return;
  group._delegateBound = true;
  group.addEventListener('change', function (e) {
    var input = e.target;
    if (!input || input.tagName !== 'INPUT' || input.type !== 'checkbox') return;
    var key = input.getAttribute('data-sidebar-key');
    if (!key) return;
    toggleSidebarItem(key, input.checked);
    _announceSidebar((input.checked ? 'Shown: ' : 'Hidden: ') + _labelForKey(key));
  });
}

function _labelForKey(key) {
  for (var i = 0; i < SIDEBAR_ITEM_META.length; i++) {
    var items = SIDEBAR_ITEM_META[i].items;
    for (var j = 0; j < items.length; j++) {
      if (items[j][0] === key) return items[j][1];
    }
  }
  return key;
}

function _announceSidebar(msg) {
  var region = document.getElementById('sidebarStatus');
  if (!region) return;
  // Forcing a content change inside aria-live="polite" triggers SR announcement.
  region.textContent = '';
  region.textContent = msg;
}

// ── Keyboard navigation ────────────────────────────────────────

function isInput(e) {
  var tag = document.activeElement ? document.activeElement.tagName : '';
  return ['INPUT', 'SELECT', 'TEXTAREA'].indexOf(tag) >= 0;
}

function moveFocus(delta) {
  var cards = document.querySelectorAll('.card, .list-row');
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
  var cards = document.querySelectorAll('.card, .list-row');
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
  var cards = document.querySelectorAll('.card, .list-row');
  if (focusedIndex < 0 || focusedIndex >= cards.length) return;
  var id = cards[focusedIndex].getAttribute('data-id');
  if (id) toggleStar(id);
}

function deleteFocused() {
  var cards = document.querySelectorAll('.card, .list-row');
  if (focusedIndex < 0 || focusedIndex >= cards.length) return;
  var id = cards[focusedIndex].getAttribute('data-id');
  if (!id) return;
  var s = allSessions.find(function(x) { return x.id === id; });
  if (s) showDeleteConfirm(s.id, s.project || '');
}

document.addEventListener('keydown', function(e) {
  // Cmd+D (macOS) / Ctrl+Shift+D → new terminal tab. Cmd is safe in the app
  // (the shell uses Ctrl+D for EOF, which we never intercept).
  if ((e.key === 'd' || e.key === 'D') && (e.metaKey || (e.ctrlKey && e.shiftKey)) && !e.altKey) {
    e.preventDefault();
    if (typeof setView === 'function' && currentView !== 'workspace') setView('workspace');
    var openTab = function () { if (typeof addWorkspaceTab === 'function') addWorkspaceTab(); };
    if (currentView === 'workspace' && window._wsRoot) openTab(); else setTimeout(openTab, 120);
    return;
  }
  if (e.key === 'Escape') {
    // Close the confirm overlay whenever it's on screen — it's shared by the
    // delete dialog (sets pendingDelete) AND the "project folder is missing"
    // re-clone dialog (does not), so keying off pendingDelete alone left the
    // latter undismissable.
    var confirmOverlay = document.getElementById('confirmOverlay');
    var confirmOpen = confirmOverlay && confirmOverlay.style.display === 'flex';
    if (pendingDelete || confirmOpen) {
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
  // Use the same synthetic 'pid:<pid>' key the activeSessions map uses for
  // unmatched entries so Focus lookup keeps working.
  var sid = a.sessionId || ('pid:' + a.pid);

  var html = '<div class="running-card ' + statusClass + '">';
  html += '<div class="running-card-header">';
  html += '<span class="live-badge live-' + a.status + '">' + (a.status === 'waiting' ? 'WAITING' : 'LIVE') + '</span>';
  html += '<span class="running-project" style="color:' + projColor + '">' + escHtml(projName) + '</span>';
  html += '<span class="running-tool">' + escHtml(getToolLabel(a.entrypoint || a.kind || 'claude')) + '</span>';
  html += '</div>';
  html += '<div class="running-stats">';
  html += '<div class="running-stat"><span class="running-stat-val">' + a.cpu.toFixed(1) + '%</span><span class="running-stat-label">CPU</span></div>';
  html += '<div class="running-stat"><span class="running-stat-val">' + a.memoryMB + 'MB</span><span class="running-stat-label">MEM</span></div>';
  if (uptime) html += '<div class="running-stat"><span class="running-stat-val">' + uptime + '</span><span class="running-stat-label">Uptime</span></div>';
  html += '</div>';
  var displayName = getSessionDisplayName(s);
  if (displayName) html += '<div class="running-msg">' + escHtml(displayName.slice(0, 120)) + '</div>';
  html += '<div class="running-actions">';
  html += '<button class="launch-btn" style="background:var(--accent-green);color:#000" onclick="focusSession(\'' + sid + '\')">Focus</button>';
  if (s) {
    html += '<button class="launch-btn btn-secondary" onclick="var ss=allSessions.find(function(x){return x.id===\'' + sid + '\'});if(ss)openDetail(ss);">Details</button>';
    html += '<button class="launch-btn btn-secondary" onclick="closeDetail();openReplay(\'' + escJsString(sid) + '\',\'' + escJsString(s.project || '') + '\')">Replay</button>';
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
  html += '<span class="running-tool tool-' + (s.tool || 'claude') + '">' + escHtml(getToolLabel(s.tool || 'claude', true)) + '</span>';
  html += '</div>';
  var displayName = getSessionDisplayName(s);
  if (displayName) html += '<div class="running-msg">' + escHtml(displayName.slice(0, 120)) + '</div>';
  html += '<div class="running-stats">';
  html += '<div class="running-stat"><span class="running-stat-val">' + (s.messages || 0) + '</span><span class="running-stat-label">msgs</span></div>';
  if (s.last_time) html += '<div class="running-stat"><span class="running-stat-val">' + s.last_time.slice(11) + '</span><span class="running-stat-label">ended</span></div>';
  html += '</div>';
  html += '<div class="running-actions">';
  html += '<button class="launch-btn btn-secondary" onclick="openDetail({id:\'' + escJsString(s.id) + '\',project:\'' + escJsString(s.project || '') + '\',tool:\'' + escJsString(s.tool || '') + '\'})">Details</button>';
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
    container.innerHTML = '<div class="empty-state">No running sessions detected.<br><span style="font-size:12px;color:var(--text-muted)">Start a supported agent session and it will appear here.</span></div>';
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
    body: JSON.stringify({ pid: a.pid, sessionId: sessionId })
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

// Sub-tabs grouping for the Settings page. Order matches visual left-to-right.
// Adding a new setting => decide which tab it belongs to and add it to the right
// _settingsTab* renderer below.
var SETTINGS_TABS = [
  { id: 'appearance',   label: 'Appearance' },
  { id: 'sidebar',      label: 'Sidebar' },
  { id: 'sessions',     label: 'Sessions' },
  { id: 'integrations', label: 'Integrations' }
];

function _getSettingsTab() {
  try {
    var saved = localStorage.getItem('codedash-settings-tab');
    if (saved && SETTINGS_TABS.some(function(t) { return t.id === saved; })) return saved;
  } catch (e) { /* private mode */ }
  return 'appearance';
}

function setSettingsTab(id) {
  if (!SETTINGS_TABS.some(function(t) { return t.id === id; })) return;
  try { localStorage.setItem('codedash-settings-tab', id); } catch (e) { /* private mode */ }
  var content = document.getElementById('content');
  if (content) renderSettings(content);
}

function renderSettings(container) {
  var activeTab = _getSettingsTab();
  var panelId = 'settingsPanel-' + activeTab;

  var html = '<div class="settings-page">';
  html += '<h2 style="margin:0 0 16px;font-size:18px;font-weight:600">Settings</h2>';

  // Tab strip (reuses .ap-tabs visual pattern from the Add Project modal)
  html += '<div class="ap-tabs settings-tabs" role="tablist" aria-label="Settings categories" onkeydown="onSettingsTabKey(event)">';
  SETTINGS_TABS.forEach(function(t) {
    var isActive = t.id === activeTab;
    var tabId = 'settingsTab-' + t.id;
    var ariaControls = isActive ? panelId : ('settingsPanel-' + t.id);
    html += '<button type="button" class="ap-tab' + (isActive ? ' active' : '') + '"' +
      ' id="' + escHtml(tabId) + '"' +
      ' role="tab" aria-selected="' + (isActive ? 'true' : 'false') + '"' +
      ' aria-controls="' + escHtml(ariaControls) + '"' +
      ' tabindex="' + (isActive ? '0' : '-1') + '"' +
      ' data-tab-id="' + escHtml(t.id) + '"' +
      ' onclick="setSettingsTab(\'' + escHtml(t.id) + '\')">' + escHtml(t.label) + '</button>';
  });
  html += '</div>';

  html += '<div class="settings-tab-body" role="tabpanel" id="' + escHtml(panelId) + '"' +
    ' aria-labelledby="' + escHtml('settingsTab-' + activeTab) + '">';
  if (activeTab === 'appearance')        html += _renderSettingsAppearance();
  else if (activeTab === 'sidebar')      html += renderSidebarSettingsGroup();
  else if (activeTab === 'sessions')     html += _renderSettingsSessions();
  else if (activeTab === 'integrations') html += _renderSettingsIntegrations();
  html += '</div>';

  html += '</div>';
  container.innerHTML = html;

  // LLM inputs need post-render hydration when the Integrations tab is open.
  if (activeTab === 'integrations') loadLLMSettings();
  // Wire the delegated checkbox listener (avoids inline attribute-context risk).
  if (activeTab === 'sidebar') _bindSidebarSettingsDelegate();
}

// Arrow-key navigation across the Settings tablist per WAI-ARIA Authoring
// Practices. Left/Right cycle; Home/End jump. Activates the focused tab
// (NN/g "automatic activation" — the panels are cheap to render).
function onSettingsTabKey(event) {
  var key = event.key;
  var navKeys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (navKeys.indexOf(key) === -1) return;
  event.preventDefault();
  var current = _getSettingsTab();
  var idx = SETTINGS_TABS.findIndex(function (t) { return t.id === current; });
  if (idx < 0) idx = 0;
  var next = idx;
  if (key === 'ArrowLeft')  next = (idx - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
  if (key === 'ArrowRight') next = (idx + 1) % SETTINGS_TABS.length;
  if (key === 'Home')       next = 0;
  if (key === 'End')        next = SETTINGS_TABS.length - 1;
  if (next === idx) return;
  setSettingsTab(SETTINGS_TABS[next].id);
  // After re-render, move focus to the now-active tab so keyboard flow stays
  // inside the strip. setSettingsTab calls renderSettings synchronously.
  var nextEl = document.getElementById('settingsTab-' + SETTINGS_TABS[next].id);
  if (nextEl) nextEl.focus();
}

function _renderSettingsAppearance() {
  var savedTheme = localStorage.getItem('codedash-theme') || 'dark';
  var html = '<div class="settings-group">';
  html += '<label class="settings-label">Theme</label>';
  html += '<div class="settings-theme-btns">';
  ['dark', 'light', 'system'].forEach(function(t) {
    var active = savedTheme === t ? ' active' : '';
    html += '<button class="theme-btn' + active + '" onclick="saveThemePref(\'' + t + '\');renderSettings(document.getElementById(\'content\'))">' + t.charAt(0).toUpperCase() + t.slice(1) + '</button>';
  });
  html += '</div>';
  html += '</div>';
  return html;
}

function _renderSettingsSessions() {
  var aiTitlesOn = localStorage.getItem('codedash-ai-titles') === 'true';
  var allSessionsListBadgesOn = localStorage.getItem('codedash-all-sessions-list-badges') !== 'false';
  var savedGroupingMode = normalizeGroupingMode(localStorage.getItem('codedash-grouping-mode'));
  var savedMsgSort = localStorage.getItem('codedash-msg-sort') || 'asc';

  var html = '';

  // AI Titles
  html += '<div class="settings-group">';
  html += '<label class="settings-label">AI Titles</label>';
  html += '<div class="settings-checkbox">';
  html += '<input type="checkbox" id="settingsAiToggle"' + (aiTitlesOn ? ' checked' : '') + ' onchange="toggleAITitles(this.checked)">';
  html += '<span style="font-size:13px;color:var(--text-secondary)">Show generated titles</span>';
  html += '</div>';
  html += '</div>';

  // Session List Badges
  html += '<div class="settings-group">';
  html += '<label class="settings-label">Session List Badges</label>';
  html += '<div class="settings-checkbox">';
  html += '<input type="checkbox" id="settingsAllSessionsBadgesToggle"' + (allSessionsListBadgesOn ? ' checked' : '') + ' onchange="toggleAllSessionsListBadges(this.checked)">';
  html += '<span style="font-size:13px;color:var(--text-secondary)">Show MCP and Skills badges in list-view session rows</span>';
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

  // Message Sort Order
  html += '<div class="settings-group">';
  html += '<label class="settings-label">Message Sort Order</label>';
  html += '<p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">Default order for messages in session drawer</p>';
  html += '<div class="settings-theme-btns">';
  [['asc', '&#8593; Oldest first'], ['desc', '&#8595; Newest first']].forEach(function(pair) {
    var active = savedMsgSort === pair[0] ? ' active' : '';
    html += '<button class="theme-btn' + active + '" onclick="localStorage.setItem(\'codedash-msg-sort\',\'' + pair[0] + '\');renderSettings(document.getElementById(\'content\'))">' + pair[1] + '</button>';
  });
  html += '</div>';
  html += '</div>';

  return html;
}

function _renderSettingsIntegrations() {
  var savedTerminal = localStorage.getItem('codedash-terminal') || '';

  var html = '';

  // Terminal
  html += '<div class="settings-group">';
  html += '<label class="settings-label">Terminal</label>';
  html += '<p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">Binary name or full path (e.g. kitty, /usr/bin/alacritty)</p>';
  html += '<input type="text" class="settings-select" list="terminal-suggestions" value="' + escHtml(savedTerminal) + '" onchange="saveTerminalPref(this.value)" placeholder="x-terminal-emulator">';
  html += '<datalist id="terminal-suggestions">';
  if (Array.isArray(availableTerminals)) {
    availableTerminals.forEach(function(t) {
      if (!t.available) return;
      html += '<option value="' + escHtml(t.id) + '">' + escHtml(t.name) + '</option>';
    });
  }
  html += '</datalist>';
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

  return html;
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

function openInVSCode(project) {
  if (!project) { showToast('No project path'); return; }
  fetch('/api/open-ide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ide: 'code', project: project })
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data.ok) showToast('Opening project in VS Code...');
    else showToast('Failed: ' + (data.error || 'unknown'));
  }).catch(function() { showToast('Failed to open VS Code'); });
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
  qwen: {
    name: 'Qwen Code',
    cmd: 'npm i -g @qwen-code/qwen-code',
    alt: null,
    url: 'https://github.com/QwenLM/qwen-code',
  },
  pi: {
    name: 'Pi',
    cmd: 'npm i -g @earendil-works/pi-coding-agent',
    alt: 'npm install -g @earendil-works/pi-coding-agent',
    url: 'https://github.com/earendil-works/pi-mono',
  },
  ohmypi: {
    name: 'Oh My Pi',
    cmd: 'curl -fsSL https://omp.sh/install | sh',
    alt: 'bun install -g @oh-my-pi/pi-coding-agent',
    url: 'https://github.com/can1357/oh-my-pi',
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
  kilo: {
    name: 'Kilo CLI',
    cmd: 'npm i -g @kilocode/cli',
    alt: null,
    url: 'https://kilo.ai',
  },
  'copilot-chat': {
    name: 'Copilot Chat (VS Code)',
    cmd: null,
    alt: null,
    url: 'https://github.com/features/copilot',
  },
  copilot: {
    name: 'Copilot CLI',
    cmd: 'npm i -g @github/copilot',
    alt: 'brew install github/tap/copilot',
    url: 'https://github.com/features/copilot',
  },
};

function installAgent(agent) {
  var info = AGENT_INSTALL[agent];
  if (!info) return;

  var overlay = document.getElementById('confirmOverlay');
  document.getElementById('confirmTitle').textContent = 'Install ' + info.name;
  var html = '<code style="display:block;margin:8px 0;padding:10px;background:var(--bg-card);border-radius:6px;font-size:13px;cursor:pointer" onclick="copyText(\'' + info.cmd.replace(/'/g, "\\'") + '\', \'Copied!\')">' + escHtml(info.cmd) + '</code>';
  if (info.alt) {
    html += '<span style="font-size:11px;color:var(--text-muted)">or: <code>' + escHtml(info.alt) + '</code></span><br>';
  }
  html += '<br><a href="' + info.url + '" target="_blank" style="color:var(--accent-blue);font-size:12px">' + info.url + '</a>';
  document.getElementById('confirmText').innerHTML = html;
  document.getElementById('confirmId').textContent = '';
  document.getElementById('confirmAction').textContent = 'Copy Install Command';
  document.getElementById('confirmAction').className = 'launch-btn btn-primary';
  document.getElementById('confirmAction').onclick = function() {
    copyText(info.cmd, 'Copied: ' + info.cmd);
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
    '<code style="display:block;margin:8px 0;padding:8px;background:var(--bg-card);border-radius:6px;font-size:12px">codbash export</code>' +
    'Creates a tar.gz with all Claude &amp; Codex session data.<br><br>' +
    '<strong>Import</strong> on the new machine:<br>' +
    '<code style="display:block;margin:8px 0;padding:8px;background:var(--bg-card);border-radius:6px;font-size:12px">codbash import &lt;file.tar.gz&gt;</code>' +
    '<br><em style="color:var(--text-muted);font-size:12px">Don\'t forget to clone your git repos separately.</em>';
  document.getElementById('confirmId').textContent = '';
  document.getElementById('confirmAction').textContent = 'Copy Export Command';
  document.getElementById('confirmAction').className = 'launch-btn btn-primary';
  document.getElementById('confirmAction').onclick = function() {
    copyText('codbash export', 'Copied: codbash export');
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
      // DEV badge: when running from source (NODE_ENV=development), flag it so
      // it's obvious you're looking at the live-editing build with the latest
      // changes — not the installed DMG. Removed automatically in a real build.
      if (data.dev) {
        badge.textContent = 'v' + data.current + ' · DEV';
        badge.classList.add('dev-build');
        badge.title = 'Running from source — live changes (not the installed app)';
      } else {
        badge.classList.remove('dev-build');
      }
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
        badge.title = 'Click to update';
        badge.onclick = function() { selfUpdate(); };
      }
      var banner = document.getElementById('updateBanner');
      var text = document.getElementById('updateText');
      if (banner && text) {
        // Build via textContent/DOM nodes — never interpolate the npm-supplied
        // version string into innerHTML, otherwise a tampered registry response
        // can inject arbitrary HTML into our update banner.
        text.textContent = '';
        var strong = document.createElement('strong');
        strong.textContent = 'v' + String(data.latest || '');
        text.appendChild(strong);
        text.appendChild(document.createTextNode(' available'));
        banner.style.display = 'flex';
      }
    }
  } catch {}
}

async function selfUpdate() {
  if (!confirm('Update codbash to latest version? The page will reload.')) return;
  showToast('Updating...');
  try {
    await fetch('/api/update', { method: 'POST' });
    showToast('Updated! Reloading in 5s...');
    setTimeout(function() { location.reload(); }, 5000);
  } catch (e) {
    showToast('Update failed: ' + e.message);
  }
}

function copyUpdate() {
  copyText('npm i -g codbash-app@latest && codbash restart', 'Copied update command');
}

function dismissUpdate() {
  var banner = document.getElementById('updateBanner');
  if (banner) banner.style.display = 'none';
}

// ── Project launcher: manual registry, New/Last session, Add Project modal ──

window.manualProjects = window.manualProjects || [];
var _githubReposCache = { owned: null, contributing: null };

async function loadManualProjects() {
  try {
    var resp = await fetch('/api/projects/manual');
    var data = await resp.json();
    window.manualProjects = Array.isArray(data) ? data : [];
    if (currentView === 'projects') render();
  } catch (e) {
    // Silent failure — bootstrap continues with an empty registry. Errors
    // surface through subsequent user actions if they ever matter.
  }
}

function _currentTerminalId() {
  return localStorage.getItem('codedash-terminal') || '';
}

async function launchNewProjectSession(projectPath, tool, btn) {
  if (!projectPath) { showToast('No project path'); return; }
  var installed = (window.installedAgents || []).map(function(a) { return a.id; });
  if (installed.length === 0) {
    showToast('No agent installed — see Install Agents in the sidebar');
    return;
  }
  // Tool resolution: caller hint → settings.lastUsedByPath → settings.defaultAgent
  // → first installed. Caller hint may be stale; we still validate against the
  // installed list so we never try to spawn a non-existent binary.
  var t = tool && installed.indexOf(tool) >= 0 ? tool : null;
  if (!t) t = pickPreferredTool(projectPath, null);
  if (!t) { showToast('No agent installed'); return; }
  await maybeRefreshBeforeLaunch(projectPath, btn);
  try {
    var resp = await fetch('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'fresh',
        tool: t,
        flags: [],
        project: projectPath,
        terminal: _currentTerminalId(),
      }),
    });
    var data = await resp.json();
    if (data.ok) {
      // Single toast — calling showToast twice in a row replaces the message
      // before the user can read the first one. Merge auto-register info into
      // the same line when present.
      var name = projectPath.split('/').pop();
      var msg = 'Started ' + agentLabel(t) + ' in ' + name;
      if (data.registered) msg += ' — added to Projects';
      showToast(msg);
      if (data.registered) await loadManualProjects();
      // Optimistically remember the chosen tool client-side so the next ▶ New
      // defaults to it before the next fetch of /api/settings.
      if (window.codbashSettings) {
        window.codbashSettings.lastUsedByPath = window.codbashSettings.lastUsedByPath || {};
        window.codbashSettings.lastUsedByPath[projectPath] = t;
      }
    } else if (data.missing) {
      handleMissingProjectLaunch(data, projectPath.split('/').pop());
    } else {
      showToast('Launch failed: ' + (data.error || 'unknown'));
    }
  } catch (e) {
    showToast('Launch failed: ' + e.message);
  }
}

// ── Per-launch agent picker popover ───────────────────────────

// Picker width must agree with the CSS min-width so the viewport clamp can
// keep the popover on-screen.
const _PICKER_WIDTH = 180;
let _pickerAnchor = null;

function openAgentPicker(event, projectPath) {
  if (event) { event.preventDefault(); event.stopPropagation(); }
  var anchor = event && event.currentTarget ? event.currentTarget : null;
  var picker = document.getElementById('agentPicker');
  if (!picker || !anchor) return;
  _pickerAnchor = anchor;
  var agents = window.installedAgents || [];
  if (agents.length === 0) {
    picker.innerHTML = '<div class="agent-picker-empty">No agents installed</div>';
  } else {
    picker.setAttribute('role', 'menu');
    picker.setAttribute('aria-label', 'Pick an agent for this launch');
    picker.innerHTML = agents.map(function(a, i) {
      return '<div class="agent-picker-item" role="menuitem" tabindex="' + (i === 0 ? '0' : '-1') + '" ' +
        'data-tool="' + escHtml(a.id) + '" data-proj-path="' + escHtml(projectPath) + '" ' +
        'onclick="pickerLaunch(this.dataset.projPath, this.dataset.tool)" ' +
        'onkeydown="onPickerKey(event, this.dataset.projPath, this.dataset.tool)">' +
        escHtml(a.label) + '</div>';
    }).join('');
  }
  // position: fixed against the viewport — works regardless of what ancestor
  // is positioned and survives page scroll. We re-clamp on resize via the
  // scroll handler that just closes the picker, which is the common pattern.
  picker.classList.add('open');
  var rect = anchor.getBoundingClientRect();
  var viewportW = document.documentElement.clientWidth;
  var clampedLeft = Math.max(8, Math.min(viewportW - _PICKER_WIDTH - 8, rect.right - _PICKER_WIDTH));
  picker.style.top = (rect.bottom + 4) + 'px';
  picker.style.left = clampedLeft + 'px';
  if (anchor.setAttribute) anchor.setAttribute('aria-expanded', 'true');
  // Focus first item so keyboard users can act.
  setTimeout(function() {
    var first = picker.querySelector('.agent-picker-item');
    if (first && first.focus) first.focus();
    document.addEventListener('click', _closeAgentPickerOnOutsideClick, true);
    document.addEventListener('keydown', _closeAgentPickerOnEscape, true);
    window.addEventListener('scroll', _closeAgentPickerOnScroll, { capture: true, passive: true });
  }, 0);
}

function _closePicker() {
  var picker = document.getElementById('agentPicker');
  if (!picker) return;
  picker.classList.remove('open');
  if (_pickerAnchor && _pickerAnchor.setAttribute) _pickerAnchor.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', _closeAgentPickerOnOutsideClick, true);
  document.removeEventListener('keydown', _closeAgentPickerOnEscape, true);
  window.removeEventListener('scroll', _closeAgentPickerOnScroll, true);
  // Return focus to the chevron that opened the picker so keyboard users
  // don't get dropped on body.
  if (_pickerAnchor && _pickerAnchor.focus) {
    try { _pickerAnchor.focus(); } catch (e) {}
  }
  _pickerAnchor = null;
}

function _closeAgentPickerOnOutsideClick(e) {
  var picker = document.getElementById('agentPicker');
  if (!picker) return;
  if (picker.contains(e.target)) return;
  _closePicker();
}

function _closeAgentPickerOnEscape(e) {
  if (e.key === 'Escape') { e.stopPropagation(); _closePicker(); }
}

function _closeAgentPickerOnScroll() {
  // Re-positioning the popover during scroll is jittery — closing is the
  // commonly accepted UX and matches the picker's transient nature.
  _closePicker();
}

function onPickerKey(e, projectPath, tool) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    pickerLaunch(projectPath, tool);
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    var items = Array.from(document.querySelectorAll('.agent-picker-item'));
    var idx = items.indexOf(e.currentTarget);
    var nextIdx = e.key === 'ArrowDown'
      ? Math.min(items.length - 1, idx + 1)
      : Math.max(0, idx - 1);
    if (items[nextIdx]) items[nextIdx].focus();
  }
}

function pickerLaunch(projectPath, tool) {
  _closePicker();
  // Per-launch override — does mutate lastUsedByPath (this project's
  // preference legitimately shifts to the explicit choice) but never touches
  // settings.defaultAgent.
  launchNewProjectSession(projectPath, tool);
}

// ── Projects settings modal ───────────────────────────────────

let _modalFocusReturn = null;
let _modalTrapFn = null;

// Focus-trap helper — keeps Tab/Shift+Tab cycling inside the modal so
// keyboard users can't accidentally tab onto the page behind the overlay.
function _installModalFocusTrap(overlay) {
  if (!overlay) return;
  _modalFocusReturn = document.activeElement;
  var focusableSel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  var nodes = Array.from(overlay.querySelectorAll(focusableSel))
    .filter(function(el) { return !el.disabled && el.offsetParent !== null; });
  if (nodes.length === 0) return;
  var first = nodes[0];
  var last = nodes[nodes.length - 1];
  _modalTrapFn = function(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      // Both modals route close through the same callback chain.
      if (overlay.id === 'projectsSettingsOverlay') closeProjectsSettings();
      else if (overlay.id === 'addProjectOverlay' && typeof closeAddProject === 'function') closeAddProject();
      return;
    }
    if (e.key !== 'Tab') return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', _modalTrapFn, true);
  setTimeout(function() { try { first.focus(); } catch (e) {} }, 0);
}

function _uninstallModalFocusTrap() {
  if (_modalTrapFn) {
    document.removeEventListener('keydown', _modalTrapFn, true);
    _modalTrapFn = null;
  }
  if (_modalFocusReturn && _modalFocusReturn.focus) {
    try { _modalFocusReturn.focus(); } catch (e) {}
  }
  _modalFocusReturn = null;
}

// Full agent catalogue (id + label + how it's detected) — used to render the
// "Detected agents" list including the not-installed entries, so the user can
// see why a given agent is missing and what install method we expected.
const _ALL_AGENT_META = [
  { id: 'claude',       label: 'Claude Code',  expects: 'claude on PATH' },
  { id: 'codex',        label: 'Codex',        expects: 'codex on PATH' },
  { id: 'cursor',       label: 'Cursor',       expects: 'cursor-agent on PATH, or Cursor.app on macOS' },
  { id: 'qwen',         label: 'Qwen Code',    expects: 'qwen on PATH' },
  { id: 'pi',           label: 'Pi/OhMyPi',     expects: 'pi or omp on PATH' },
  { id: 'kilo',         label: 'Kilo',         expects: 'kilo on PATH' },
  { id: 'kiro',         label: 'Kiro CLI',     expects: 'kiro-cli on PATH' },
  { id: 'opencode',     label: 'OpenCode',     expects: 'opencode on PATH' },
  { id: 'copilot',      label: 'Copilot CLI',  expects: '~/.local/share/gh/extensions/gh-copilot' },
  { id: 'copilot-chat', label: 'Copilot Chat', expects: '~/.vscode/extensions/github.copilot-chat-*' },
];

function renderDetectedAgentsList(targetEl) {
  if (!targetEl) return;
  var installed = window.installedAgents || [];
  var installedById = {};
  installed.forEach(function(a) { installedById[a.id] = a; });

  var html = '';
  _ALL_AGENT_META.forEach(function(meta) {
    var hit = installedById[meta.id];
    if (hit) {
      var viaLabel = hit.detectedVia === 'path' ? 'PATH'
        : hit.detectedVia === 'app-bundle' ? 'macOS .app'
        : hit.detectedVia === 'gh-extension' ? 'gh extension'
        : hit.detectedVia === 'vscode-extension' ? 'VS Code extension'
        : String(hit.detectedVia || 'detected');
      html += '<div class="ps-detected-item installed">'
        + '<span class="ps-detected-status installed" aria-label="Installed">✓ Installed</span>'
        + '<span class="ps-detected-name">' + escHtml(meta.label) + '</span>'
        + '<span class="ps-detected-via" title="Detected via ' + escHtml(viaLabel) + '">' + escHtml(viaLabel) + '</span>'
        + '</div>';
    } else {
      html += '<div class="ps-detected-item missing">'
        + '<span class="ps-detected-status missing" aria-label="Not installed">— Not installed</span>'
        + '<span class="ps-detected-name">' + escHtml(meta.label) + '</span>'
        + '<span class="ps-detected-via" title="Expected: ' + escHtml(meta.expects) + '">' + escHtml(meta.expects) + '</span>'
        + '</div>';
    }
  });
  targetEl.innerHTML = html;
}

function openProjectsSettings() {
  var overlay = document.getElementById('projectsSettingsOverlay');
  if (!overlay) return;
  var select = document.getElementById('psDefaultAgent');
  var agents = window.installedAgents || [];
  var current = (window.codbashSettings && window.codbashSettings.defaultAgent) || '';
  var html = '<option value="">(none — fall back to first installed)</option>';
  agents.forEach(function(a) {
    var sel = a.id === current ? ' selected' : '';
    html += '<option value="' + escHtml(a.id) + '"' + sel + '>' + escHtml(a.label) + '</option>';
  });
  if (select) select.innerHTML = html;
  var err = document.getElementById('psError'); if (err) err.textContent = '';
  var status = document.getElementById('psDetectStatus');
  if (status) status.textContent = agents.length + ' of ' + _ALL_AGENT_META.length + ' agents installed';
  renderDetectedAgentsList(document.getElementById('psDetectedList'));
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  _installModalFocusTrap(overlay);
}

function closeProjectsSettings() {
  var overlay = document.getElementById('projectsSettingsOverlay');
  if (overlay) {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
  }
  _uninstallModalFocusTrap();
}

async function saveProjectsSettings() {
  var select = document.getElementById('psDefaultAgent');
  var err = document.getElementById('psError');
  var saveBtn = document.getElementById('psSaveBtn');
  var pick = select ? select.value : '';
  var body = { defaultAgent: pick || null };
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
  try {
    var resp = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    var data = await resp.json().catch(function() { return {}; });
    if (!resp.ok) {
      var detail = data && data.error
        ? data.error
        : 'Save failed — server returned HTTP ' + resp.status;
      if (err) err.textContent = detail;
      return;
    }
    // Re-fetch authoritative settings instead of trusting the PUT response
    // body. If the server ever returns a partial shape (e.g. {ok:true}) we'd
    // otherwise clobber lastUsedByPath in memory and lose per-project state.
    try {
      var sResp = await fetch('/api/settings');
      var sData = await sResp.json();
      if (sData && typeof sData === 'object' && 'defaultAgent' in sData) {
        window.codbashSettings = sData;
      }
    } catch (_) { /* keep the optimistic in-memory state */ }
    showToast('Settings saved');
    closeProjectsSettings();
    if (currentView === 'projects') render();
  } catch (e) {
    if (err) err.textContent = 'Save failed: ' + (e && e.message);
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  }
}

async function refreshAgentsDetection() {
  var status = document.getElementById('psDetectStatus');
  if (status) status.textContent = 'detecting…';
  try {
    var resp = await fetch('/api/agents/refresh-detect', { method: 'POST' });
    var data = await resp.json();
    window.installedAgents = (data && data.agents) || [];
    openProjectsSettings(); // re-render select with fresh list
    if (currentView === 'projects') render();
  } catch (e) {
    if (status) status.textContent = 'refresh failed';
  }
}

async function resumeLastProjectSession(sessionId, tool, projectPath, btn) {
  if (!sessionId) { showToast('No previous session to resume'); return; }
  await maybeRefreshBeforeLaunch(projectPath, btn);
  try {
    var resp = await fetch('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionId,
        resumeTarget: (function() {
          if ((tool || '') !== 'pi') return '';
          var s = (window.allSessions || allSessions || []).find(function(x) { return x.id === sessionId; });
          return s && s.resume_target ? s.resume_target : '';
        })(),
        tool: tool || 'claude',
        flags: [],
        project: projectPath || '',
        terminal: _currentTerminalId(),
      }),
    });
    var data = await resp.json();
    if (data.ok) showToast('Resuming ' + sessionId.slice(0, 8) + '…');
    else if (data.missing) handleMissingProjectLaunch(data, (projectPath || '').split('/').pop());
    else showToast('Resume failed: ' + (data.error || 'unknown'));
  } catch (e) {
    showToast('Resume failed: ' + e.message);
  }
}

async function unregisterProject(id, name) {
  if (!id) return;
  // Use the same confirm-overlay pattern that showDeleteConfirm uses for
  // sessions, instead of the native confirm() dialog — keeps the look
  // consistent and avoids confusing the user with two different prompt styles.
  // Project name is trimmed of control characters before display so a
  // crafted name can't produce a misleading multi-line dialog.
  var safeName = String(name || '').replace(/[\r\n\t\x00-\x1f]/g, ' ').slice(0, 200);
  var overlay = document.getElementById('confirmOverlay');
  if (!overlay) return;
  document.getElementById('confirmTitle').textContent = 'Remove from project registry?';
  document.getElementById('confirmText').textContent = 'Removes "' + safeName + '" from your project list. Files on disk are not touched.';
  document.getElementById('confirmId').textContent = '';
  var btn = document.getElementById('confirmAction');
  btn.textContent = 'Remove';
  btn.className = 'btn-delete';
  btn.onclick = async function() {
    overlay.style.display = 'none';
    try {
      var resp = await fetch('/api/projects/manual/' + encodeURIComponent(id), { method: 'DELETE' });
      var data = await resp.json();
      if (data.ok) {
        showToast('Removed ' + safeName);
        await loadManualProjects();
      } else {
        showToast('Remove failed');
      }
    } catch (e) {
      showToast('Remove failed: ' + (e && e.message));
    }
  };
  overlay.style.display = 'flex';
}

// ── Add Project modal ─────────────────────────────────────────

// Offer the folders codbash already knows about (from every session's git
// root / project path) as autocomplete options, so "Add project" is a pick
// rather than typing a full path from memory.
function _populateProjectPathSuggestions() {
  var dl = document.getElementById('apPathSuggestions');
  if (!dl) return;
  var seen = {};
  (typeof allSessions !== 'undefined' && allSessions ? allSessions : []).forEach(function (s) {
    var p = s.git_root || s.project;
    if (p && p.charAt(0) === '/' && !seen[p]) seen[p] = true;
  });
  var paths = Object.keys(seen).sort();
  dl.innerHTML = paths.map(function (p) { return '<option value="' + escHtml(p) + '"></option>'; }).join('');
}

function openAddProject() {
  var overlay = document.getElementById('addProjectOverlay');
  if (!overlay) return;
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  addProjectSwitchTab('local');
  _populateProjectPathSuggestions();
  var input = document.getElementById('apLocalPath');
  if (input) { input.value = ''; setTimeout(function() { input.focus(); }, 50); }
  var err = document.getElementById('apLocalError'); if (err) err.textContent = '';
  // Desktop app only: reveal the native "Browse…" folder picker (the browser
  // has no way to open a Finder folder dialog and return an absolute path).
  var browse = document.getElementById('apBrowseBtn');
  if (browse) browse.style.display =
    (window.codbashDesktop && typeof window.codbashDesktop.pickFolder === 'function') ? '' : 'none';
  _installModalFocusTrap(overlay);
}

// Open the OS folder picker (Finder) in the desktop app and drop the chosen
// absolute path into the input. No-op in the browser (button stays hidden).
function browseForProjectFolder() {
  if (!(window.codbashDesktop && typeof window.codbashDesktop.pickFolder === 'function')) return;
  window.codbashDesktop.pickFolder().then(function (dir) {
    if (!dir) return;
    var input = document.getElementById('apLocalPath');
    if (input) { input.value = dir; input.focus(); }
    var err = document.getElementById('apLocalError'); if (err) err.textContent = '';
  }).catch(function () {});
}

function closeAddProject() {
  var overlay = document.getElementById('addProjectOverlay');
  if (overlay) {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
  }
  _uninstallModalFocusTrap();
  // Stop any in-flight device-code polling when the user dismisses the modal.
  _stopRepoScopePolling();
  _repoScopeDeviceCode = '';
}

function addProjectSwitchTab(tab) {
  ['local', 'owned', 'contributing'].forEach(function(t) {
    var btn = document.querySelector('.ap-tab[data-tab="' + t + '"]');
    if (btn) btn.classList.toggle('active', t === tab);
  });
  document.getElementById('apPaneLocal').style.display = tab === 'local' ? '' : 'none';
  document.getElementById('apPaneOwned').style.display = tab === 'owned' ? '' : 'none';
  document.getElementById('apPaneContrib').style.display = tab === 'contributing' ? '' : 'none';
  var addBtn = document.getElementById('apLocalAddBtn');
  if (addBtn) addBtn.style.display = tab === 'local' ? '' : 'none';

  if (tab === 'owned' || tab === 'contributing') {
    var apiType = tab === 'owned' ? 'owned' : 'contributing';
    if (!_githubReposCache[apiType]) loadGithubRepos(apiType);
    else renderRepoList(apiType);
  }
}

async function submitAddLocalProject() {
  var input = document.getElementById('apLocalPath');
  var err = document.getElementById('apLocalError');
  var addBtn = document.getElementById('apLocalAddBtn');
  if (err) err.textContent = '';
  var p = input ? input.value.trim() : '';
  if (!p) { if (err) err.textContent = 'Path required'; return; }
  if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'Adding…'; }
  try {
    var resp = await fetch('/api/projects/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p, source: 'manual' }),
    });
    var data = await resp.json();
    if (data.ok) {
      showToast('Added ' + (data.project.name || p));
      closeAddProject();
      await loadManualProjects();
    } else {
      if (err) err.textContent = data.error || 'Failed to add';
    }
  } catch (e) {
    if (err) err.textContent = e.message;
  } finally {
    if (addBtn) { addBtn.disabled = false; addBtn.textContent = 'Add'; }
  }
}

async function loadGithubRepos(apiType) {
  var containerId = apiType === 'owned' ? 'apOwnedRepos' : 'apContribRepos';
  var container = document.getElementById(containerId);
  if (!container) return;
  // Re-entering this view cancels any stale polling that was running for a
  // previous device-code flow.
  _stopRepoScopePolling();
  container.innerHTML = '<div class="ap-loading">Loading repos…</div>';
  try {
    var resp = await fetch('/api/github/repos?type=' + apiType);
    if (resp.status === 401) {
      var data401 = await resp.json().catch(function() { return {}; });
      if (data401.needsRepoScope) {
        renderRepoScopeConnectPanel(containerId, apiType);
      } else {
        container.innerHTML = '<div class="ap-loading">GitHub not connected. Open <strong>Cloud</strong> view → connect GitHub, then return here.</div>';
      }
      return;
    }
    if (!resp.ok) {
      var errBody = await resp.json().catch(function() { return {}; });
      container.innerHTML = '<div class="ap-loading">' + escHtml(errBody.error || ('HTTP ' + resp.status)) + '</div>';
      return;
    }
    var data = await resp.json();
    if (!Array.isArray(data)) {
      container.innerHTML = '<div class="ap-loading">' + escHtml(data.error || 'Failed to load') + '</div>';
      return;
    }
    _githubReposCache[apiType] = data;
    renderRepoList(apiType);
  } catch (e) {
    container.innerHTML = '<div class="ap-loading">Failed to load: ' + escHtml(e.message) + '</div>';
  }
}

// ── Repo-scope connect panel + device-code polling ──────────────

var _repoScopePolling = null;
var _repoScopeInterval = 0;       // current poll interval in ms (mutable on slow_down)
var _repoScopeDeadline = 0;
var _repoScopeDeviceCode = '';
var _repoScopeApiType = '';
var _repoScopeErrorStreak = 0;

function _stopRepoScopePolling() {
  if (_repoScopePolling) { clearInterval(_repoScopePolling); _repoScopePolling = null; }
}

function renderRepoScopeConnectPanel(containerId, apiType) {
  // A user re-entering the connect panel cancels any prior in-flight polling.
  _stopRepoScopePolling();
  var container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = ''
    + '<div class="ap-connect">'
    + '  <div class="ap-connect-title">Repo access not granted yet</div>'
    + '  <div class="ap-connect-body">'
    + '    To list your repositories the dashboard needs a separate GitHub authorization. The new token is stored locally and is <strong>never</strong> sent to the leaderboard — it is used only here in the project launcher.'
    + '  </div>'
    + '  <label class="ap-connect-toggle">'
    + '    <input type="checkbox" id="apPublicOnlyToggle" /> <span>Public repos only (skips private/collaborator listings)</span>'
    + '  </label>'
    + '  <div style="display:flex;gap:8px;align-items:center;margin-top:10px">'
    + '    <button class="ap-repo-clone" id="apConnectBtn" data-api-type="' + escHtml(apiType) + '" onclick="startRepoScopeConnect(this.dataset.apiType, this)">Connect GitHub for repo access</button>'
    + '  </div>'
    + '  <div class="ap-connect-status" id="apConnectStatus"></div>'
    + '</div>';
}

async function startRepoScopeConnect(apiType, btn) {
  if (btn) btn.disabled = true; // prevent double-clicks racing two device flows
  var status = document.getElementById('apConnectStatus');
  if (status) status.textContent = 'Requesting device code…';
  var publicOnly = !!(document.getElementById('apPublicOnlyToggle') && document.getElementById('apPublicOnlyToggle').checked);
  try {
    var resp = await fetch('/api/github/repo-scope/device-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicOnly: publicOnly }),
    });
    var data = await resp.json();
    if (data.error) {
      if (status) status.textContent = 'Failed: ' + data.error;
      if (btn) btn.disabled = false;
      return;
    }
    showDeviceCodePanel(data, apiType);
  } catch (e) {
    if (status) status.textContent = 'Failed: ' + e.message;
    showToast('Connect failed: ' + e.message);
    if (btn) btn.disabled = false;
  }
}

function showDeviceCodePanel(deviceData, apiType) {
  var status = document.getElementById('apConnectStatus');
  if (!status) return;
  // user_code goes into innerHTML via escHtml AND into a data-attribute on the
  // Copy button — the click handler reads from `dataset.code` instead of the
  // attribute being interpolated into an inline JS string, so any quote
  // characters in a future user_code value cannot break out of the handler.
  // verification_uri is hard-bounded to https:// so a tampered upstream
  // response can't smuggle a javascript: scheme into the `href`.
  var rawUri = String(deviceData.verification_uri || '');
  var safeUri = /^https:\/\//i.test(rawUri) ? rawUri : '#';
  status.innerHTML = ''
    + '<div class="ap-device-code">'
    + '  <div>1. Open <a href="' + escHtml(safeUri) + '" target="_blank" rel="noopener noreferrer">' + escHtml(safeUri) + '</a></div>'
    + '  <div>2. Enter code: <code class="ap-code">' + escHtml(deviceData.user_code) + '</code> '
    + '<button class="ap-copy" data-code="' + escHtml(deviceData.user_code) + '" onclick="copyText(this.dataset.code, &quot;Copied code&quot;)">Copy</button></div>'
    + '  <div class="ap-poll-status" id="apPollStatus">Waiting for authorization…</div>'
    + '</div>';
  _stopRepoScopePolling();
  _repoScopeDeadline = Date.now() + (deviceData.expires_in || 900) * 1000;
  _repoScopeInterval = (deviceData.interval || 5) * 1000;
  _repoScopeDeviceCode = deviceData.device_code;
  _repoScopeApiType = apiType;
  _repoScopeErrorStreak = 0;
  _repoScopePolling = setInterval(_repoScopeTick, _repoScopeInterval);
}

function _repoScopeTick() {
  if (Date.now() > _repoScopeDeadline) {
    _stopRepoScopePolling();
    var st = document.getElementById('apPollStatus');
    if (st) st.textContent = 'Code expired. Click Connect to try again.';
    return;
  }
  pollRepoScopeOnce();
}

async function pollRepoScopeOnce() {
  var deviceCode = _repoScopeDeviceCode;
  var apiType = _repoScopeApiType;
  try {
    var resp = await fetch('/api/github/repo-scope/poll-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    });
    var data = await resp.json();
    // Bail out if a different flow took over while this poll was in flight.
    if (deviceCode !== _repoScopeDeviceCode) return;
    if (data.error) {
      var st = document.getElementById('apPollStatus');
      if (st) st.textContent = 'Error: ' + data.error;
      _stopRepoScopePolling();
      return;
    }
    if (data.status === 'pending') {
      _repoScopeErrorStreak = 0;
      return;
    }
    if (data.status === 'slow_down') {
      // RFC 8628 §3.5: add at least 5s on slow_down and wait the new interval.
      _stopRepoScopePolling();
      _repoScopeInterval = _repoScopeInterval + 5000;
      _repoScopePolling = setInterval(_repoScopeTick, _repoScopeInterval);
      return;
    }
    if (data.status === 'expired') {
      var st2 = document.getElementById('apPollStatus');
      if (st2) st2.textContent = 'Code expired. Click Connect to try again.';
      _stopRepoScopePolling();
      return;
    }
    if (data.status === 'ok') {
      _stopRepoScopePolling();
      showToast('GitHub repo access granted');
      _githubReposCache.owned = null;
      _githubReposCache.contributing = null;
      loadGithubRepos(apiType);
    }
  } catch (e) {
    // Transient network failures shouldn't kill the flow. Persistent failures
    // (3 in a row) surface to the user instead of polling silently forever.
    _repoScopeErrorStreak += 1;
    if (_repoScopeErrorStreak >= 3) {
      _stopRepoScopePolling();
      var st3 = document.getElementById('apPollStatus');
      if (st3) st3.textContent = 'Connection error. Please retry.';
    }
  }
}

async function disconnectRepoScope() {
  if (!confirm('Disconnect repo-scope GitHub access locally? You can re-connect any time. To fully revoke the OAuth authorization you must also visit github.com → Settings → Applications.')) return;
  // Cancel any in-flight polling first — otherwise a poll could race the
  // disconnect and silently restore the token if GitHub returns ok at the
  // same moment.
  _stopRepoScopePolling();
  _repoScopeDeviceCode = '';
  try {
    var resp = await fetch('/api/github/repo-scope/disconnect', { method: 'POST' });
    var data = await resp.json().catch(function() { return {}; });
    _githubReposCache.owned = null;
    _githubReposCache.contributing = null;
    showToast('Repo access disconnected locally');
    if (data.revokeUrl) {
      // Nudge the user toward fully revoking on github.com, since clearing
      // locally does not invalidate the token at GitHub.
      var go = confirm('Also fully revoke the GitHub OAuth authorization?\n\nThis opens github.com so you can disconnect the app there too.');
      if (go) window.open(data.revokeUrl, '_blank', 'noopener');
    }
    var tab = document.querySelector('.ap-tab.active');
    if (tab) addProjectSwitchTab(tab.getAttribute('data-tab'));
  } catch (e) {
    showToast('Disconnect failed: ' + e.message);
  }
}

function renderRepoList(apiType) {
  var containerId = apiType === 'owned' ? 'apOwnedRepos' : 'apContribRepos';
  var filterId = apiType === 'owned' ? 'apOwnedFilter' : 'apContribFilter';
  var container = document.getElementById(containerId);
  var filter = document.getElementById(filterId);
  if (!container) return;
  var repos = _githubReposCache[apiType] || [];
  var q = filter ? filter.value.trim().toLowerCase() : '';
  var filtered = q
    ? repos.filter(function(r) {
        return (r.fullName || '').toLowerCase().indexOf(q) >= 0
          || (r.description || '').toLowerCase().indexOf(q) >= 0;
      })
    : repos;

  if (filtered.length === 0) {
    container.innerHTML = '<div class="ap-loading">' + (q ? 'No repos match "' + escHtml(q) + '"' : 'No repos found') + '</div>';
    return;
  }
  var registeredPaths = (window.manualProjects || []).map(function(p) { return p.remoteUrl; }).filter(Boolean);
  var html = ''
    + '<div style="padding:6px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text-muted)">'
    + '<span>Showing ' + filtered.length + ' repos</span>'
    + '<button class="ap-disconnect" onclick="disconnectRepoScope()">Disconnect repo access</button>'
    + '</div>';
  // No client-side truncation: the backend already caps at 300 repos and the
  // filter has narrowed the list. Truncating here would hide matching repos
  // when the user has many.
  filtered.forEach(function(r) {
    var already = registeredPaths.indexOf(r.cloneUrl) >= 0;
    var meta = (r.private ? 'private · ' : '') + (r.description ? r.description : (r.htmlUrl || ''));
    html += '<div class="ap-repo">';
    html += '<div class="ap-repo-info">';
    html += '<div class="ap-repo-name">' + escHtml(r.fullName) + '</div>';
    html += '<div class="ap-repo-meta" title="' + escHtml(meta) + '">' + escHtml(meta) + '</div>';
    html += '</div>';
    html += '<button class="ap-repo-clone" data-full-name="' + escHtml(r.fullName) + '" data-clone-url="' + escHtml(r.cloneUrl) + '" data-ssh-url="' + escHtml(r.sshUrl || '') + '" data-default-branch="' + escHtml(r.defaultBranch || '') + '" ' + (already ? 'disabled' : '') + ' onclick="cloneRepoAndAdd(this)">' + (already ? 'Added' : 'Clone &amp; Add') + '</button>';
    html += '</div>';
  });
  container.innerHTML = html;
}

async function cloneRepoAndAdd(btn) {
  var fullName = btn.getAttribute('data-full-name');
  var cloneUrl = btn.getAttribute('data-clone-url');
  var sshUrl = btn.getAttribute('data-ssh-url');
  var defaultBranch = btn.getAttribute('data-default-branch');
  btn.disabled = true;
  btn.textContent = 'Cloning…';
  try {
    var resp = await fetch('/api/projects/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName: fullName, cloneUrl: cloneUrl, sshUrl: sshUrl, defaultBranch: defaultBranch }),
    });
    var data = await resp.json();
    if (data.ok) {
      showToast(data.alreadyExisted ? 'Linked existing clone of ' + fullName : 'Cloned ' + fullName);
      btn.textContent = 'Added';
      await loadManualProjects();
    } else {
      btn.disabled = false;
      btn.textContent = 'Retry';
      showToast('Clone failed: ' + (data.error || 'unknown'));
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Retry';
    showToast('Clone failed: ' + e.message);
  }
}

// Re-clone a registered project whose folder was deleted, restoring it at its
// original path. Driven by the "Re-clone" button on a missing launcher card and
// by the re-clone confirm offered after a launch hits a missing folder.
async function recloneProject(id, name, btn) {
  if (!id) { showToast('Missing project id'); return; }
  var safeName = name || 'project';
  if (btn) {
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = '↓ Cloning…';
  } else {
    // Driven from the confirm dialog (no button to relabel) — give immediate
    // feedback so the multi-second clone isn't silent.
    showToast('Cloning ' + safeName + ' from GitHub…');
  }
  try {
    var resp = await fetch('/api/projects/reclone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id }),
    });
    var data = await resp.json();
    if (data.ok) {
      showToast(data.alreadyExisted ? 'Folder already present for ' + safeName : 'Re-cloned ' + safeName + ' from GitHub');
      await loadManualProjects();
    } else {
      if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.innerHTML = '↓ Retry'; }
      showToast('Re-clone failed: ' + (data.error || 'unknown'));
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.innerHTML = '↓ Retry'; }
    showToast('Re-clone failed: ' + (e && e.message));
  }
}

// Shared handler for a launch that failed because the project folder is gone.
// Refreshes the registry (so the tile flips to its missing state) and, when we
// know a GitHub remote, offers a one-click re-clone via the confirm overlay.
function handleMissingProjectLaunch(data, name) {
  var safeName = String(name || 'This project').replace(/[\r\n\t\x00-\x1f]/g, ' ').slice(0, 200);
  loadManualProjects();
  var overlay = document.getElementById('confirmOverlay');
  var canReclone = data && data.projectId && isGithubRemote(data.remoteUrl);
  if (!canReclone || !overlay) {
    // No re-clone possible (or no overlay in the DOM) — a plain toast with the
    // recovery hint is the fallback.
    showToast('"' + safeName + '" folder is missing on disk — restore it or remove it from Projects');
    return;
  }
  document.getElementById('confirmTitle').textContent = 'Project folder is missing';
  document.getElementById('confirmText').textContent =
    '"' + safeName + '" was moved or deleted from disk. Re-clone the latest version from GitHub?';
  document.getElementById('confirmId').textContent = '';
  var btn = document.getElementById('confirmAction');
  btn.textContent = 'Re-clone';
  btn.className = 'launch-btn btn-primary';
  btn.onclick = function() {
    overlay.style.display = 'none';
    recloneProject(data.projectId, safeName, null);
  };
  overlay.style.display = 'flex';
  // Move focus into the dialog so keyboard/SR users land on the primary action.
  setTimeout(function() { if (btn && btn.focus) btn.focus(); }, 0);
}

// ── Initialization ─────────────────────────────────────────────

async function loadAgentsAndSettings() {
  // allSettled so a partial failure (e.g. /api/agents/installed errors while
  // /api/settings succeeds) doesn't wipe both pieces of state.
  var results = await Promise.allSettled([
    fetch('/api/agents/installed').then(function(r) { return r.json(); }),
    fetch('/api/settings').then(function(r) { return r.json(); }),
  ]);
  var aData = results[0].status === 'fulfilled' ? results[0].value : null;
  var sData = results[1].status === 'fulfilled' ? results[1].value : null;
  if (aData && Array.isArray(aData.agents)) {
    window.installedAgents = aData.agents;
    window._agentsDetectionLoaded = true;
  }
  if (sData && typeof sData === 'object' && 'defaultAgent' in sData) {
    window.codbashSettings = sData;
  }
  // Re-render any Projects subtab — both History (button selection depends
  // on installed agents) and Projects landing need agent info.
  if (currentView === 'projects') render();
}

function _onProjectsHashChange() {
  if (currentView !== 'projects') return;
  var h = (location.hash || '').replace(/^#/, '');
  // Empty hash → fall back to user's persisted preference rather than keeping
  // whatever we last rendered. If neither is set we land on 'projects'.
  var next;
  if (h === 'history' || h === 'projects') {
    next = h;
  } else {
    try { next = localStorage.getItem('codedash-projects-subtab') === 'history' ? 'history' : 'projects'; }
    catch (e) { next = 'projects'; }
  }
  if (next !== currentProjectsSubtab) {
    currentProjectsSubtab = next;
    try { localStorage.setItem('codedash-projects-subtab', next); } catch (e) {}
    render();
  }
}

(function init() {
  // Sidebar customization — apply persisted config before any other init so the
  // user never sees a flash of hidden items.
  applySidebarConfig();
  _bindSidebarHeaders();
  applyNavTooltips();

  // Load data
  loadSessions();
  loadTerminals();
  loadManualProjects();
  loadAgentsAndSettings();
  window.addEventListener('hashchange', _onProjectsHashChange);
  loadRepoRefreshState();
  checkForUpdates();
  setInterval(checkForUpdates, 10000); // check every 10s
  setInterval(loadSessions, 60000);    // refresh sessions + invalidate analytics cache every 60s
  startActivePolling();

  // Terminal-first landing (Chrome-like): if a previous workspace session was
  // saved, open straight into Terminal and restore its tabs/panes instead of
  // the Overview dashboard. Read localStorage directly so this doesn't depend on
  // workspace.js having initialized yet. First run (no session) keeps Overview.
  try {
    if (localStorage.getItem('codbash-workspace-session')) currentView = 'workspace';
  } catch (e) { /* localStorage unavailable */ }

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
