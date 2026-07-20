// Tests for src/workspace-layouts.js — the saved whole-workspace layout store.
// Uses a temp CODBASH_SETTINGS_DIR so it never touches the real ~/.codedash.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codbash-wl-'));
  process.env.CODBASH_SETTINGS_DIR = dir;
  delete require.cache[require.resolve('../src/workspace-layouts')];
  return { m: require('../src/workspace-layouts'), dir };
}

const SAMPLE_TABS = [
  { name: 'Agents', panes: [{ cmd: 'claude' }, { cmd: 'codex' }] },
  { name: 'Scratch', panes: [{ cmd: '' }] },
];

test('sanitizeLayout accepts a multi-tab, multi-pane layout', () => {
  const { m } = freshModule();
  const l = m.sanitizeLayout({ name: 'my setup', tabs: SAMPLE_TABS });
  assert.ok(l);
  assert.equal(l.name, 'my setup');
  assert.match(l.id, /^[a-f0-9]{12}$/);
  assert.equal(l.tabs.length, 2);
  assert.equal(l.tabs[0].panes.length, 2);
  assert.equal(l.tabs[0].panes[0].cmd, 'claude');
  assert.equal(l.tabs[1].panes[0].cmd, '');
});

test('sanitizeLayout rejects no-name, no-tabs, and newline injection', () => {
  const { m } = freshModule();
  assert.equal(m.sanitizeLayout({ name: '', tabs: SAMPLE_TABS }), null);
  assert.equal(m.sanitizeLayout({ name: 'x', tabs: [] }), null);
  assert.equal(m.sanitizeLayout({ name: 'x', tabs: 'nope' }), null);
  assert.equal(
    m.sanitizeLayout({ name: 'x', tabs: [{ name: 't', panes: [{ cmd: 'claude\nrm -rf /' }] }] }),
    null,
  );
});

test('sanitizeLayout caps tabs at 20 and panes at 4', () => {
  const { m } = freshModule();
  const bigTabs = Array.from({ length: 30 }, (_, i) => ({
    name: 'T' + i,
    panes: Array.from({ length: 8 }, () => ({ cmd: 'claude' })),
  }));
  const l = m.sanitizeLayout({ name: 'big', tabs: bigTabs });
  assert.equal(l.tabs.length, 20);
  assert.equal(l.tabs[0].panes.length, 4);
});

test('a tab with no valid panes still gets one blank pane', () => {
  const { m } = freshModule();
  const l = m.sanitizeLayout({ name: 'x', tabs: [{ name: 't', panes: [] }] });
  assert.equal(l.tabs[0].panes.length, 1);
  assert.equal(l.tabs[0].panes[0].cmd, '');
});

test('saveLayout persists and loadLayouts returns it', async () => {
  const { m } = freshModule();
  const saved = await m.saveLayout('setup one', SAMPLE_TABS);
  const list = m.loadLayouts();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, saved.id);
  assert.equal(list[0].tabs.length, 2);
});

test('saveLayout upserts by name (case-insensitive), preserving id/createdAt', async () => {
  const { m } = freshModule();
  const first = await m.saveLayout('My Setup', SAMPLE_TABS);
  const second = await m.saveLayout('my setup', [{ name: 'Solo', panes: [{ cmd: 'qwen' }] }]);
  const list = m.loadLayouts();
  assert.equal(list.length, 1, 'overwrite, not duplicate');
  assert.equal(second.id, first.id, 'id preserved on overwrite');
  assert.equal(second.createdAt, first.createdAt, 'createdAt preserved');
  assert.equal(list[0].tabs.length, 1, 'content replaced');
  assert.equal(list[0].tabs[0].panes[0].cmd, 'qwen');
});

test('saveLayout rejects an invalid layout', async () => {
  const { m } = freshModule();
  await assert.rejects(() => m.saveLayout('', SAMPLE_TABS));
  await assert.rejects(() => m.saveLayout('x', []));
});

test('removeLayout deletes by id', async () => {
  const { m } = freshModule();
  const a = await m.saveLayout('a', SAMPLE_TABS);
  await m.saveLayout('b', SAMPLE_TABS);
  const after = await m.removeLayout(a.id);
  assert.equal(after.length, 1);
  assert.equal(after[0].name, 'b');
});

test('the store file is written 0600 (POSIX)', async () => {
  if (process.platform === 'win32') return;
  const { m } = freshModule();
  await m.saveLayout('a', SAMPLE_TABS);
  const mode = fs.statSync(m._file()).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('loadLayouts tolerates a corrupt file', () => {
  const { m, dir } = freshModule();
  fs.writeFileSync(path.join(dir, 'workspace-layouts.json'), '{ not json');
  assert.deepEqual(m.loadLayouts(), []);
});
