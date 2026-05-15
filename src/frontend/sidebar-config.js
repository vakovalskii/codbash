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
    'claude-only', 'codex-only', 'qwen-only', 'kiro-only', 'cursor-only',
    'copilot-chat-only', 'copilot-only', 'opencode-only', 'kilo-only',
    // Tools (Settings is intentionally absent — always visible)
    'export-import', 'changelog',
    // Install agents
    'install:claude', 'install:codex', 'install:qwen', 'install:kiro',
    'install:opencode', 'install:kilo', 'install:copilot'
  ];

  var DEFAULT_COLLAPSED = {
    'install-agents': true
  };

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
