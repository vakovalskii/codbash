// Tests for src/workspace-commands.js — the saved-command store.
// Uses a temp CODBASH_SETTINGS_DIR so it never touches the real ~/.codedash.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codbash-wc-'));
  process.env.CODBASH_SETTINGS_DIR = dir;
  delete require.cache[require.resolve('../src/workspace-commands')];
  return { m: require('../src/workspace-commands'), dir };
}

test('sanitizeEntry accepts a proxied launch command', () => {
  const { m } = freshModule();
  const e = m.sanitizeEntry({ name: 'proxy claude', command: "HTTPS_PROXY='http://u:p@1.2.3.4:48921' claude --dangerously-skip-permissions" });
  assert.ok(e);
  assert.equal(e.name, 'proxy claude');
  assert.match(e.id, /^[a-f0-9]{12}$/);
});

test('sanitizeEntry rejects newlines (command injection), empties, and control chars', () => {
  const { m } = freshModule();
  assert.equal(m.sanitizeEntry({ name: 'x', command: 'claude\nrm -rf /' }), null);
  assert.equal(m.sanitizeEntry({ name: '', command: 'claude' }), null);
  assert.equal(m.sanitizeEntry({ name: 'x', command: '' }), null);
  assert.equal(m.sanitizeEntry({ name: 'x', command: 'a\x07b' }), null);
});

test('addCommand persists and loadCommands returns it', async () => {
  const { m } = freshModule();
  const saved = await m.addCommand('cmd one', 'claude');
  const list = m.loadCommands();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, saved.id);
  assert.equal(list[0].command, 'claude');
});

test('addCommand rejects an invalid command', async () => {
  const { m } = freshModule();
  await assert.rejects(() => m.addCommand('bad', 'a\nb'));
});

test('removeCommand deletes by id', async () => {
  const { m } = freshModule();
  const a = await m.addCommand('a', 'claude');
  await m.addCommand('b', 'codex');
  const after = await m.removeCommand(a.id);
  assert.equal(after.length, 1);
  assert.equal(after[0].name, 'b');
});

test('the store file is written 0600 (POSIX)', async () => {
  if (process.platform === 'win32') return;
  const { m } = freshModule();
  await m.addCommand('a', 'claude');
  const mode = fs.statSync(m._file()).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('loadCommands tolerates a missing / corrupt file', () => {
  const { m, dir } = freshModule();
  assert.deepEqual(m.loadCommands(), []);
  fs.writeFileSync(path.join(dir, 'workspace-commands.json'), 'not json{');
  assert.deepEqual(m.loadCommands(), []);
});
