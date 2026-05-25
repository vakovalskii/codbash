// Tests for src/settings.js — atomic 0600 read/write, mutex, stale-default fallback.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Module under test is loaded after we point SETTINGS_FILE override env var
// at a per-test temp directory. This avoids touching the real ~/.codedash.
function freshSettingsModule(tmpDir) {
  process.env.CODBASH_SETTINGS_DIR = tmpDir;
  delete require.cache[require.resolve('../src/settings')];
  return require('../src/settings');
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codbash-settings-'));
}

test('loadSettings returns defaults when file missing', () => {
  const dir = mkTmp();
  const s = freshSettingsModule(dir);
  const got = s.loadSettings();
  assert.equal(got.defaultAgent, null);
  assert.deepEqual(got.lastUsedByPath, {});
});

test('saveSettings writes mode 0600 and is readable back', async () => {
  const dir = mkTmp();
  const s = freshSettingsModule(dir);
  await s.updateSettings({ defaultAgent: 'claude' });
  const filePath = path.join(dir, 'settings.json');
  assert.ok(fs.existsSync(filePath));
  // POSIX-only assertion; codbash supports macOS/Linux/WSL.
  if (process.platform !== 'win32') {
    const mode = fs.statSync(filePath).mode & 0o777;
    assert.equal(mode, 0o600, 'expected mode 0600, got 0' + mode.toString(8));
  }
  const got = s.loadSettings();
  assert.equal(got.defaultAgent, 'claude');
});

test('updateSettings is a merge, not a replace', async () => {
  const dir = mkTmp();
  const s = freshSettingsModule(dir);
  await s.updateSettings({ defaultAgent: 'claude' });
  await s.updateSettings({ lastUsedByPath: { '/Users/me/a': 'cursor' } });
  const got = s.loadSettings();
  assert.equal(got.defaultAgent, 'claude', 'defaultAgent must survive partial update');
  assert.equal(got.lastUsedByPath['/Users/me/a'], 'cursor');
});

test('rememberLastUsed updates only the requested path entry', async () => {
  const dir = mkTmp();
  const s = freshSettingsModule(dir);
  await s.updateSettings({ lastUsedByPath: { '/a': 'claude', '/b': 'codex' } });
  await s.rememberLastUsed('/a', 'cursor');
  const got = s.loadSettings();
  assert.equal(got.lastUsedByPath['/a'], 'cursor');
  assert.equal(got.lastUsedByPath['/b'], 'codex');
});

test('concurrent updateSettings calls are serialized (no lost writes)', async () => {
  const dir = mkTmp();
  const s = freshSettingsModule(dir);
  const writes = [];
  for (let i = 0; i < 30; i++) {
    writes.push(s.rememberLastUsed('/p' + i, 'claude'));
  }
  await Promise.all(writes);
  const got = s.loadSettings();
  for (let i = 0; i < 30; i++) {
    assert.equal(got.lastUsedByPath['/p' + i], 'claude', 'lost write at /p' + i);
  }
});

test('corrupt settings file does NOT wipe data on next update', async () => {
  const dir = mkTmp();
  const s = freshSettingsModule(dir);
  await s.updateSettings({ defaultAgent: 'claude' });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ not valid json');
  // updateSettings must throw rather than silently overwrite with empty {}
  await assert.rejects(() => s.updateSettings({ defaultAgent: 'codex' }), /parse|json|corrupt/i);
});

test('loadSettings returns defaults on corrupt file (read-side tolerance)', () => {
  const dir = mkTmp();
  const s = freshSettingsModule(dir);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ bad');
  const got = s.loadSettings();
  assert.equal(got.defaultAgent, null);
  assert.deepEqual(got.lastUsedByPath, {});
});

test('validateAgentId rejects unknown agents', () => {
  const dir = mkTmp();
  const s = freshSettingsModule(dir);
  assert.equal(s.isKnownAgent('claude'), true);
  assert.equal(s.isKnownAgent('cursor'), true);
  assert.equal(s.isKnownAgent('codex'), true);
  assert.equal(s.isKnownAgent('opencode'), true);
  assert.equal(s.isKnownAgent('kiro'), true);
  assert.equal(s.isKnownAgent('kilo'), true);
  assert.equal(s.isKnownAgent('qwen'), true);
  assert.equal(s.isKnownAgent('pi'), true);
  assert.equal(s.isKnownAgent('copilot'), true);
  assert.equal(s.isKnownAgent('copilot-chat'), true);
  assert.equal(s.isKnownAgent('bogus'), false);
  assert.equal(s.isKnownAgent(''), false);
  assert.equal(s.isKnownAgent(null), false);
  assert.equal(s.isKnownAgent({ id: 'claude' }), false);
});

test('pickLaunchTool priority: lastUsed > default > first installed', () => {
  const dir = mkTmp();
  const s = freshSettingsModule(dir);
  // lastUsed wins
  assert.equal(
    s.pickLaunchTool({ path: '/a', settings: { defaultAgent: 'codex', lastUsedByPath: { '/a': 'cursor' } }, installed: ['claude', 'cursor', 'codex'] }),
    'cursor'
  );
  // lastUsed not installed → fall through to default
  assert.equal(
    s.pickLaunchTool({ path: '/a', settings: { defaultAgent: 'codex', lastUsedByPath: { '/a': 'cursor' } }, installed: ['claude', 'codex'] }),
    'codex'
  );
  // default not installed → fall through to first installed
  assert.equal(
    s.pickLaunchTool({ path: '/a', settings: { defaultAgent: 'cursor', lastUsedByPath: {} }, installed: ['claude', 'codex'] }),
    'claude'
  );
  // nothing installed → null
  assert.equal(
    s.pickLaunchTool({ path: '/a', settings: { defaultAgent: 'claude', lastUsedByPath: {} }, installed: [] }),
    null
  );
});
