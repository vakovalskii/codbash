// Tests for src/frontend/sidebar-config.js — pure config helpers used by
// the sidebar customization feature. Run with `node --test test/sidebar-config.test.js`.
//
// The module must work both in the browser (loaded via <script>) and in Node
// (loaded via require). The Node branch is what these tests exercise.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function loadModule() {
  delete require.cache[require.resolve('../src/frontend/sidebar-config')];
  return require('../src/frontend/sidebar-config');
}

// ── parseSidebarConfig ──────────────────────────────────────────

test('parseSidebarConfig returns defaults when input is null', () => {
  const m = loadModule();
  const got = m.parseSidebarConfig(null);
  assert.equal(got.v, 1);
  assert.deepEqual(got.hidden, {});
  assert.deepEqual(got.collapsed, {});
});

test('parseSidebarConfig returns defaults when input is undefined', () => {
  const m = loadModule();
  const got = m.parseSidebarConfig(undefined);
  assert.equal(got.v, 1);
});

test('parseSidebarConfig returns defaults when input is empty string', () => {
  const m = loadModule();
  const got = m.parseSidebarConfig('');
  assert.deepEqual(got.hidden, {});
  assert.deepEqual(got.collapsed, {});
});

test('parseSidebarConfig returns defaults on invalid JSON', () => {
  const m = loadModule();
  const got = m.parseSidebarConfig('{not valid json');
  assert.equal(got.v, 1);
  assert.deepEqual(got.hidden, {});
});

test('parseSidebarConfig returns defaults when version is in the future', () => {
  const m = loadModule();
  const future = JSON.stringify({ v: 999, hidden: { leaderboard: true }, collapsed: {} });
  const got = m.parseSidebarConfig(future);
  // forward-compat fallback: unknown version => trust nothing, use defaults
  assert.deepEqual(got.hidden, {}, 'future version must not leak hidden into runtime config');
});

test('parseSidebarConfig accepts a valid v:1 payload', () => {
  const m = loadModule();
  const stored = JSON.stringify({
    v: 1,
    hidden: { leaderboard: true, starred: true },
    collapsed: { tools: true }
  });
  const got = m.parseSidebarConfig(stored);
  assert.equal(got.hidden.leaderboard, true);
  assert.equal(got.hidden.starred, true);
  assert.equal(got.collapsed.tools, true);
});

test('parseSidebarConfig preserves unknown hidden keys (forward-compat)', () => {
  // A future codbash version may add a new sidebar item. When that user
  // downgrades briefly and we save, we must not destroy the unknown key.
  const m = loadModule();
  const stored = JSON.stringify({
    v: 1,
    hidden: { 'leaderboard': true, 'future-view-xyz': true },
    collapsed: {}
  });
  const got = m.parseSidebarConfig(stored);
  assert.equal(got.hidden['future-view-xyz'], true,
    'unknown keys must be preserved through parse so they survive a save');
});

test('parseSidebarConfig coerces non-boolean values to booleans', () => {
  const m = loadModule();
  const stored = JSON.stringify({
    v: 1,
    hidden: { leaderboard: 'yes', starred: 1, activity: 0, cloud: null },
    collapsed: {}
  });
  const got = m.parseSidebarConfig(stored);
  assert.equal(typeof got.hidden.leaderboard, 'boolean');
  assert.equal(got.hidden.leaderboard, true);
  assert.equal(got.hidden.starred, true);
  // falsy values either become false OR the key is dropped — both are fine, just no crashes
});

test('parseSidebarConfig rejects when hidden is not an object', () => {
  const m = loadModule();
  const stored = JSON.stringify({ v: 1, hidden: 'evil-string', collapsed: {} });
  const got = m.parseSidebarConfig(stored);
  assert.deepEqual(got.hidden, {}, 'malformed hidden must fall back to empty');
});

test('parseSidebarConfig rejects array-as-object attack', () => {
  // Arrays are typeof 'object' in JS — make sure we explicitly require a plain object.
  const m = loadModule();
  const stored = JSON.stringify({ v: 1, hidden: ['leaderboard'], collapsed: {} });
  const got = m.parseSidebarConfig(stored);
  assert.deepEqual(got.hidden, {});
});

test('parseSidebarConfig ignores non-string keys defensively', () => {
  // JSON.parse can't produce non-string keys, but be paranoid: anything
  // that ends up in DOM-derived contexts must be a real string.
  const m = loadModule();
  const got = m.parseSidebarConfig('{"v":1,"hidden":{"":true},"collapsed":{}}');
  assert.equal(got.hidden[''], undefined, 'empty-string key has no meaningful target, drop it');
});

test('parseSidebarConfig rejects payloads larger than 64KB (self-DoS guard)', () => {
  // Synthesize a 65KB JSON blob. Cap is 64KB (65536 bytes).
  const m = loadModule();
  const fat = '{"v":1,"hidden":{' +
    Array.from({length: 10000}, (_, i) => '"longkey' + i + '":true').join(',') +
    '},"collapsed":{}}';
  assert.ok(fat.length > 65536, 'test payload must exceed cap, got ' + fat.length);
  const got = m.parseSidebarConfig(fat);
  assert.deepEqual(got.hidden, {}, 'oversized payload falls back to defaults');
});

test('parseSidebarConfig blocks __proto__, constructor, prototype keys', () => {
  const m = loadModule();
  const malicious = JSON.stringify({
    v: 1,
    hidden: { '__proto__': true, 'constructor': true, 'prototype': true, 'leaderboard': true },
    collapsed: {}
  });
  const got = m.parseSidebarConfig(malicious);
  assert.equal(got.hidden.leaderboard, true, 'legit key still preserved');
  // Use hasOwn to avoid the __proto__ getter — direct access returns the proto.
  assert.ok(!Object.prototype.hasOwnProperty.call(got.hidden, '__proto__'));
  assert.ok(!Object.prototype.hasOwnProperty.call(got.hidden, 'constructor'));
  assert.ok(!Object.prototype.hasOwnProperty.call(got.hidden, 'prototype'));
});

// ── isItemHidden ────────────────────────────────────────────────

test('isItemHidden returns false for keys not in config (default visible)', () => {
  const m = loadModule();
  const cfg = m.parseSidebarConfig(null);
  assert.equal(m.isItemHidden(cfg, 'leaderboard'), false);
  assert.equal(m.isItemHidden(cfg, 'anything-unknown'), false);
});

test('isItemHidden returns true when key is hidden', () => {
  const m = loadModule();
  const cfg = m.parseSidebarConfig(JSON.stringify({
    v: 1, hidden: { leaderboard: true }, collapsed: {}
  }));
  assert.equal(m.isItemHidden(cfg, 'leaderboard'), true);
});

test('isItemHidden never reports Settings as hidden, even if config says so', () => {
  // Safety: protect the user from locking themselves out.
  const m = loadModule();
  const cfg = m.parseSidebarConfig(JSON.stringify({
    v: 1, hidden: { settings: true }, collapsed: {}
  }));
  assert.equal(m.isItemHidden(cfg, 'settings'), false);
});

// ── isSectionCollapsed ──────────────────────────────────────────

test('isSectionCollapsed returns false for sections by default', () => {
  const m = loadModule();
  const cfg = m.parseSidebarConfig(null);
  assert.equal(m.isSectionCollapsed(cfg, 'workspace'), false);
  assert.equal(m.isSectionCollapsed(cfg, 'agents'), false);
  assert.equal(m.isSectionCollapsed(cfg, 'tools'), false);
});

test('isSectionCollapsed defaults install-agents sub-section to collapsed', () => {
  const m = loadModule();
  const cfg = m.parseSidebarConfig(null);
  assert.equal(m.isSectionCollapsed(cfg, 'install-agents'), true,
    'install-agents is default-collapsed per design');
});

test('isSectionCollapsed honors stored value over default', () => {
  const m = loadModule();
  const cfg = m.parseSidebarConfig(JSON.stringify({
    v: 1, hidden: {}, collapsed: { 'install-agents': false, tools: true }
  }));
  assert.equal(m.isSectionCollapsed(cfg, 'install-agents'), false);
  assert.equal(m.isSectionCollapsed(cfg, 'tools'), true);
});

// ── setItemHidden / setSectionCollapsed (immutability) ──────────

test('setItemHidden returns a new config object (immutability)', () => {
  const m = loadModule();
  const cfg = m.parseSidebarConfig(null);
  const next = m.setItemHidden(cfg, 'leaderboard', true);
  assert.notStrictEqual(next, cfg, 'must not mutate the input config');
  assert.equal(cfg.hidden.leaderboard, undefined, 'input unchanged');
  assert.equal(next.hidden.leaderboard, true);
});

test('setItemHidden(false) removes the key (does not set to false)', () => {
  // Smaller storage payload + the "absence === visible" convention stays clean.
  const m = loadModule();
  const cfg = m.parseSidebarConfig(JSON.stringify({
    v: 1, hidden: { leaderboard: true }, collapsed: {}
  }));
  const next = m.setItemHidden(cfg, 'leaderboard', false);
  assert.equal(next.hidden.leaderboard, undefined);
});

test('setItemHidden refuses to hide Settings (returns config unchanged)', () => {
  const m = loadModule();
  const cfg = m.parseSidebarConfig(null);
  const next = m.setItemHidden(cfg, 'settings', true);
  assert.equal(next.hidden.settings, undefined,
    'Settings must never be persistable as hidden');
});

test('setSectionCollapsed returns a new config object (immutability)', () => {
  const m = loadModule();
  const cfg = m.parseSidebarConfig(null);
  const next = m.setSectionCollapsed(cfg, 'tools', true);
  assert.notStrictEqual(next, cfg);
  assert.equal(next.collapsed.tools, true);
  assert.equal(cfg.collapsed.tools, undefined);
});

// ── KNOWN_ITEM_KEYS allow-list ──────────────────────────────────

test('KNOWN_ITEM_KEYS includes all current sidebar entries', () => {
  const m = loadModule();
  const keys = new Set(m.KNOWN_ITEM_KEYS);
  // Workspace
  ['sessions','projects','timeline','activity','running','analytics',
   'starred','leaderboard','cloud'].forEach(k => {
    assert.ok(keys.has(k), 'workspace key missing: ' + k);
  });
  // Agents
  ['claude-only','codex-only','qwen-only','kiro-only','cursor-only',
   'copilot-chat-only','copilot-only','opencode-only','kilo-only'].forEach(k => {
    assert.ok(keys.has(k), 'agent key missing: ' + k);
  });
  // Tools
  ['export-import','changelog'].forEach(k => {
    assert.ok(keys.has(k), 'tools key missing: ' + k);
  });
  // Install
  ['install:claude','install:codex','install:qwen','install:kiro',
   'install:opencode','install:kilo','install:copilot'].forEach(k => {
    assert.ok(keys.has(k), 'install key missing: ' + k);
  });
});

test('KNOWN_ITEM_KEYS does NOT include "settings" (it is always visible)', () => {
  const m = loadModule();
  assert.ok(!m.KNOWN_ITEM_KEYS.includes('settings'),
    'settings must not be a togglable key');
});

// ── serializeSidebarConfig ──────────────────────────────────────

test('serializeSidebarConfig produces JSON with v:1 envelope', () => {
  const m = loadModule();
  const cfg = m.parseSidebarConfig(null);
  const next = m.setItemHidden(cfg, 'leaderboard', true);
  const json = m.serializeSidebarConfig(next);
  const round = JSON.parse(json);
  assert.equal(round.v, 1);
  assert.equal(round.hidden.leaderboard, true);
});

test('serializeSidebarConfig round-trips unknown keys preserved by parse', () => {
  const m = loadModule();
  const parsed = m.parseSidebarConfig(JSON.stringify({
    v: 1, hidden: { 'future-view-xyz': true }, collapsed: {}
  }));
  const json = m.serializeSidebarConfig(parsed);
  const round = JSON.parse(json);
  assert.equal(round.hidden['future-view-xyz'], true,
    'unknown keys must survive parse → serialize round-trip');
});

// ── loadFromStorage / saveToStorage with throwing storage ───────

test('loadFromStorage returns defaults when storage.getItem throws', () => {
  const m = loadModule();
  const throwingStorage = {
    getItem() { throw new Error('SecurityError: storage disabled'); }
  };
  const got = m.loadFromStorage(throwingStorage);
  assert.equal(got.v, 1);
  assert.deepEqual(got.hidden, {});
});

test('loadFromStorage handles null storage gracefully', () => {
  const m = loadModule();
  const got = m.loadFromStorage(null);
  assert.equal(got.v, 1);
});

test('saveToStorage swallows errors when storage.setItem throws', () => {
  const m = loadModule();
  const throwingStorage = {
    setItem() { throw new Error('QuotaExceededError'); }
  };
  const cfg = m.parseSidebarConfig(null);
  // Must not throw — calling site relies on this being safe.
  assert.doesNotThrow(() => m.saveToStorage(throwingStorage, cfg));
});

test('saveToStorage uses the documented localStorage key', () => {
  const m = loadModule();
  let writtenKey = null;
  let writtenValue = null;
  const fakeStorage = {
    setItem(k, v) { writtenKey = k; writtenValue = v; }
  };
  const cfg = m.parseSidebarConfig(null);
  m.saveToStorage(fakeStorage, m.setItemHidden(cfg, 'leaderboard', true));
  assert.equal(writtenKey, 'codedash-sidebar-config');
  assert.ok(writtenValue.includes('"leaderboard":true'));
});

// ── resetConfig ─────────────────────────────────────────────────

test('resetConfig returns a fresh empty config', () => {
  const m = loadModule();
  const reset = m.resetConfig();
  assert.equal(reset.v, 1);
  assert.deepEqual(reset.hidden, {});
  assert.deepEqual(reset.collapsed, {});
});

test('clearStorage removes the sidebar config key', () => {
  const m = loadModule();
  let removedKey = null;
  const fakeStorage = {
    removeItem(k) { removedKey = k; }
  };
  m.clearStorage(fakeStorage);
  assert.equal(removedKey, 'codedash-sidebar-config');
});

test('clearStorage tolerates a throwing removeItem', () => {
  const m = loadModule();
  const throwingStorage = { removeItem() { throw new Error('boom'); } };
  assert.doesNotThrow(() => m.clearStorage(throwingStorage));
});
