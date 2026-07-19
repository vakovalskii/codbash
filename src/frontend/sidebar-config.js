// Sidebar customization config — pure helpers.
// Works in the browser (attached to window via the inline <script> below)
// and in Node (required by test/sidebar-config.test.js).
//
// Schema (localStorage key "codedash-sidebar-config"):
//   { v: 1, hidden: { [itemKey]: true }, collapsed: { [sectionId]: boolean } }
// Absence of a hidden key === visible. Absence of a collapsed key === default
// (expanded for top sections, collapsed for install-agents sub-section).

(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SidebarConfig = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

  var STORAGE_KEY = 'codedash-sidebar-config';
  var CURRENT_VERSION = 1;
  var SETTINGS_KEY = 'settings';
  // Safety net against self-DoS via DevTools-injected megabyte payloads. JSON
  // for a normal config is < 1 KB; even with every key set the payload is
  // ~1.5 KB. 64 KB leaves plenty of room for forward-compat unknown keys.
  var MAX_RAW_BYTES = 65536;
  // Block keys that would land on Object.prototype semantics — harmless today
  // (consumers iterate config maps, not __proto__), but explicit is safer than
  // relying on Object.keys + assignment-via-setter behavior.
  var BLOCKED_KEYS = { '__proto__': true, 'constructor': true, 'prototype': true };

  var KNOWN_ITEM_KEYS = [
    // Workspace
    'sessions', 'projects', 'timeline', 'activity', 'running',
    'analytics', 'starred', 'leaderboard', 'cloud',
    // Agents
    'claude-only', 'codex-only', 'qwen-only', 'pi-original-only', 'ohmypi-only', 'kiro-only', 'cursor-only',
    'copilot-chat-only', 'copilot-only', 'opencode-only', 'kilo-only',
    // Tools (Settings is intentionally absent — always visible)
    'export-import', 'changelog',
    // Install agents
    'install:claude', 'install:codex', 'install:qwen', 'install:pi', 'install:ohmypi',
    'install:kiro', 'install:opencode', 'install:kilo', 'install:copilot'
  ];

  var DEFAULT_COLLAPSED = {
    'install-agents': true
  };

  // One-line "what it is & why" help for each sidebar item, keyed by the item's
  // data-key (preferred) or data-view (fallback). Surfaced as a hover tooltip
  // in the browser (see applyNavTooltips in app.js). Kept here so it's covered
  // by the sidebar-config unit test (every KNOWN_ITEM_KEY must have help).
  var NAV_HELP = {
    // Workspace
    'sessions': 'Every AI coding session across all agents, in one place',
    'projects': 'Browse sessions grouped by project folder',
    'timeline': 'Your sessions laid out on a chronological timeline',
    'activity': 'GitHub-style heatmap of your coding activity and streaks',
    'running': 'Live sessions right now — CPU, memory, uptime',
    'analytics': 'Token cost & usage broken down by day, project and agent',
    'starred': 'Sessions you’ve pinned for quick access',
    'leaderboard': 'Ranking of projects and agents by activity',
    'cloud': 'Sync your sessions across machines',
    // Agents (filter the session list to one agent)
    'claude-only': 'Show only Claude Code sessions',
    'codex-only': 'Show only Codex sessions',
    'qwen-only': 'Show only Qwen Code sessions',
    'pi-original-only': 'Show only Pi sessions',
    'ohmypi-only': 'Show only Oh My Pi sessions',
    'kiro-only': 'Show only Kiro sessions',
    'cursor-only': 'Show only Cursor sessions',
    'copilot-chat-only': 'Show only Copilot Chat sessions',
    'copilot-only': 'Show only Copilot CLI sessions',
    'opencode-only': 'Show only OpenCode sessions',
    'kilo-only': 'Show only Kilo sessions',
    // Tools
    'export-import': 'Back up or restore your sessions as an archive',
    'changelog': 'What’s new in each codbash release',
    'settings': 'Themes, sidebar layout and other preferences',
    // Install agents (copy the install command)
    'install:claude': 'Copy the install command for Claude Code',
    'install:codex': 'Copy the install command for Codex CLI',
    'install:qwen': 'Copy the install command for Qwen Code',
    'install:pi': 'Copy the install command for Pi',
    'install:ohmypi': 'Copy the install command for Oh My Pi',
    'install:kiro': 'Copy the install command for Kiro CLI',
    'install:opencode': 'Copy the install command for OpenCode',
    'install:kilo': 'Copy the install command for Kilo CLI',
    'install:copilot': 'Copy the install command for Copilot CLI'
  };

  function navHelpFor(key) {
    if (typeof key !== 'string') return '';
    return Object.prototype.hasOwnProperty.call(NAV_HELP, key) ? NAV_HELP[key] : '';
  }

  function defaults() {
    return { v: CURRENT_VERSION, hidden: {}, collapsed: {} };
  }

  function isPlainObject(x) {
    return x !== null && typeof x === 'object' && !Array.isArray(x);
  }

  // omitFalsy: when true, falsy values are dropped (used for `hidden` where
  // absence === visible — keeps the payload compact and the convention clean).
  // When false, falsy values are stored as `false` (used for `collapsed` where
  // we must distinguish "user explicitly expanded" from "use the default").
  function sanitizeMap(input, omitFalsy) {
    var out = {};
    if (!isPlainObject(input)) return out;
    Object.keys(input).forEach(function (key) {
      if (typeof key !== 'string' || key === '') return;
      if (BLOCKED_KEYS[key]) return;
      var raw = input[key];
      if (omitFalsy) {
        if (raw) out[key] = true;
      } else {
        out[key] = !!raw;
      }
    });
    return out;
  }

  function parseSidebarConfig(raw) {
    if (raw === null || raw === undefined || raw === '') return defaults();
    if (typeof raw !== 'string' || raw.length > MAX_RAW_BYTES) return defaults();
    var data;
    try {
      data = JSON.parse(raw);
    } catch (_e) {
      return defaults();
    }
    if (!isPlainObject(data)) return defaults();
    if (data.v !== CURRENT_VERSION) return defaults();
    return {
      v: CURRENT_VERSION,
      hidden: sanitizeMap(data.hidden, true),
      collapsed: sanitizeMap(data.collapsed, false)
    };
  }

  function isItemHidden(cfg, key) {
    if (key === SETTINGS_KEY) return false;
    if (!cfg || !cfg.hidden) return false;
    return cfg.hidden[key] === true;
  }

  function isSectionCollapsed(cfg, sectionId) {
    if (cfg && cfg.collapsed && Object.prototype.hasOwnProperty.call(cfg.collapsed, sectionId)) {
      return cfg.collapsed[sectionId] === true;
    }
    return DEFAULT_COLLAPSED[sectionId] === true;
  }

  function setItemHidden(cfg, key, hidden) {
    if (key === SETTINGS_KEY) return cfg;
    var nextHidden = {};
    Object.keys(cfg.hidden || {}).forEach(function (k) {
      if (k !== key) nextHidden[k] = cfg.hidden[k];
    });
    if (hidden) nextHidden[key] = true;
    return { v: CURRENT_VERSION, hidden: nextHidden, collapsed: cfg.collapsed };
  }

  function setSectionCollapsed(cfg, sectionId, collapsed) {
    var nextCollapsed = {};
    Object.keys(cfg.collapsed || {}).forEach(function (k) {
      if (k !== sectionId) nextCollapsed[k] = cfg.collapsed[k];
    });
    nextCollapsed[sectionId] = !!collapsed;
    return { v: CURRENT_VERSION, hidden: cfg.hidden, collapsed: nextCollapsed };
  }

  function serializeSidebarConfig(cfg) {
    return JSON.stringify({
      v: CURRENT_VERSION,
      hidden: cfg && cfg.hidden ? cfg.hidden : {},
      collapsed: cfg && cfg.collapsed ? cfg.collapsed : {}
    });
  }

  function loadFromStorage(storage) {
    if (!storage) return defaults();
    var raw;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch (_e) {
      return defaults();
    }
    return parseSidebarConfig(raw);
  }

  function saveToStorage(storage, cfg) {
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, serializeSidebarConfig(cfg));
    } catch (_e) {
      // private mode / quota / SecurityError — best-effort persistence.
    }
  }

  function clearStorage(storage) {
    if (!storage) return;
    try {
      storage.removeItem(STORAGE_KEY);
    } catch (_e) {
      // ignored on purpose
    }
  }

  function resetConfig() {
    return defaults();
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    KNOWN_ITEM_KEYS: KNOWN_ITEM_KEYS,
    NAV_HELP: NAV_HELP,
    navHelpFor: navHelpFor,
    SETTINGS_KEY: SETTINGS_KEY,
    parseSidebarConfig: parseSidebarConfig,
    serializeSidebarConfig: serializeSidebarConfig,
    isItemHidden: isItemHidden,
    isSectionCollapsed: isSectionCollapsed,
    setItemHidden: setItemHidden,
    setSectionCollapsed: setSectionCollapsed,
    loadFromStorage: loadFromStorage,
    saveToStorage: saveToStorage,
    clearStorage: clearStorage,
    resetConfig: resetConfig
  };
});
