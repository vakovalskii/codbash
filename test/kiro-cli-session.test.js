const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Reload src/data with os.homedir() pointed at a temp home so KIRO_SESSIONS_DIR
// (~/.kiro/sessions/cli) resolves inside the fixture.
function freshDataWithHome(home) {
  const dataPath = require.resolve('../src/data');
  const handoffPath = require.resolve('../src/handoff');
  delete require.cache[handoffPath];
  delete require.cache[dataPath];
  const oldHome = os.homedir;
  os.homedir = () => home;
  try {
    return require('../src/data');
  } finally {
    os.homedir = oldHome;
  }
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codbash-kiro-'));
}

// Write a Kiro CLI session pair: <uuid>.json metadata + <uuid>.jsonl events.
function writeKiroCliSession(home, sessionId, meta, events) {
  const dir = path.join(home, '.kiro', 'sessions', 'cli');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sessionId + '.json'), JSON.stringify(meta));
  fs.writeFileSync(
    path.join(dir, sessionId + '.jsonl'),
    events.map(e => JSON.stringify(e)).join('\n') + '\n'
  );
}

const UUID = '12345678-90ab-cdef-1234-567890abcdef';

function sampleMeta(cwd) {
  return {
    session_id: UUID,
    cwd,
    title: 'Fix the parser',
    created_at: '2026-05-24T10:00:00.000Z',
    updated_at: '2026-05-24T10:05:00.000Z',
  };
}

function sampleEvents() {
  return [
    { version: 1, kind: 'Prompt', data: { message_id: 'u1', content: [{ kind: 'text', data: 'Please fix the parser' }] } },
    { version: 1, kind: 'AssistantMessage', data: { message_id: 'a1', content: [{ kind: 'text', data: 'Parser fixed' }] } },
    { version: 1, kind: 'ToolResults', data: { results: [{ ok: true }] } },
  ];
}

test('scanKiroCliSessions reads metadata files into session summaries', () => {
  const home = tmpHome();
  writeKiroCliSession(home, UUID, sampleMeta('/tmp/project'), sampleEvents());

  const data = freshDataWithHome(home);
  const sessions = data.__test.scanKiroCliSessions();

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, UUID);
  assert.equal(sessions[0].tool, 'kiro');
  assert.equal(sessions[0].format, 'kiro-cli');
  assert.equal(sessions[0].project, '/tmp/project');
  assert.equal(sessions[0].first_message, 'Fix the parser');
  assert.equal(sessions[0].has_detail, true);
  assert.equal(sessions[0].first_ts, Date.parse('2026-05-24T10:00:00.000Z'));
  assert.equal(sessions[0].last_ts, Date.parse('2026-05-24T10:05:00.000Z'));
});

test('scanKiroCliSessions ignores non-UUID metadata files', () => {
  const home = tmpHome();
  const dir = path.join(home, '.kiro', 'sessions', 'cli');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'not-a-uuid.json'), JSON.stringify({ title: 'nope' }));

  const data = freshDataWithHome(home);
  assert.deepEqual(data.__test.scanKiroCliSessions(), []);
});

test('loadKiroCliDetail parses Prompt/AssistantMessage and skips ToolResults', () => {
  const home = tmpHome();
  writeKiroCliSession(home, UUID, sampleMeta('/tmp/project'), sampleEvents());

  const data = freshDataWithHome(home);
  const detail = data.__test.loadKiroCliDetail(UUID);

  assert.equal(detail.messages.length, 2);
  assert.deepEqual(detail.messages.map(m => m.role), ['user', 'assistant']);
  assert.equal(detail.messages[0].content, 'Please fix the parser');
  assert.equal(detail.messages[1].content, 'Parser fixed');
});

test('loadKiroCliDetail rejects path-traversal ids before touching the filesystem', () => {
  const home = tmpHome();
  writeKiroCliSession(home, UUID, sampleMeta('/tmp/project'), sampleEvents());

  const data = freshDataWithHome(home);
  // A crafted id would resolve outside KIRO_SESSIONS_DIR without the UUID guard.
  assert.deepEqual(data.__test.loadKiroCliDetail('../../../../etc/passwd'), { messages: [] });
  assert.deepEqual(data.__test.loadKiroCliDetail('..%2f..%2fsecret'), { messages: [] });
  assert.deepEqual(data.__test.loadKiroCliDetail(''), { messages: [] });
});

test('symlinked session files are not followed by scan or detail', () => {
  const home = tmpHome();
  const dir = path.join(home, '.kiro', 'sessions', 'cli');
  fs.mkdirSync(dir, { recursive: true });

  // Targets living OUTSIDE KIRO_SESSIONS_DIR whose content WOULD surface in the
  // dashboard if the symlinks were followed — this is what makes the test bite.
  const outsideMeta = path.join(home, 'outside-meta.json');
  fs.writeFileSync(outsideMeta, JSON.stringify({ title: 'LEAKED-TITLE', cwd: '/secret' }));
  const outsideEvents = path.join(home, 'outside-events.jsonl');
  fs.writeFileSync(outsideEvents, JSON.stringify(
    { version: 1, kind: 'Prompt', data: { message_id: 'x', content: [{ kind: 'text', data: 'LEAKED-CONTENT' }] } }
  ) + '\n');

  // Craft UUID-named symlinks pointing at those out-of-tree files.
  const linkUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  fs.symlinkSync(outsideMeta, path.join(dir, linkUuid + '.json'));
  fs.symlinkSync(outsideEvents, path.join(dir, linkUuid + '.jsonl'));

  const data = freshDataWithHome(home);

  // Scanner must not surface the symlinked session (nor its leaked title).
  const scanned = data.__test.scanKiroCliSessions();
  assert.equal(scanned.some(s => s.id === linkUuid), false);
  assert.equal(scanned.some(s => s.first_message === 'LEAKED-TITLE'), false);

  // Detail loader must refuse to read through the symlinked .jsonl even though
  // its target is a perfectly valid events file.
  const detail = data.__test.loadKiroCliDetail(linkUuid);
  assert.deepEqual(detail, { messages: [] });
});

test('a real .json with a symlinked .jsonl reports no detail and leaks nothing', () => {
  const home = tmpHome();
  const dir = path.join(home, '.kiro', 'sessions', 'cli');
  fs.mkdirSync(dir, { recursive: true });

  // Out-of-tree events file with content that WOULD surface if followed.
  const outsideEvents = path.join(home, 'outside-events.jsonl');
  fs.writeFileSync(outsideEvents, JSON.stringify(
    { version: 1, kind: 'Prompt', data: { message_id: 'x', content: [{ kind: 'text', data: 'LEAKED-CONTENT' }] } }
  ) + '\n');

  // Genuine metadata file, but the events file is a symlink to the out-of-tree file.
  fs.writeFileSync(path.join(dir, UUID + '.json'), JSON.stringify(sampleMeta('/tmp/project')));
  fs.symlinkSync(outsideEvents, path.join(dir, UUID + '.jsonl'));

  const data = freshDataWithHome(home);

  const scanned = data.__test.scanKiroCliSessions();
  const s = scanned.find(x => x.id === UUID);
  assert.ok(s, 'metadata-only session should still be listed');
  assert.equal(s.has_detail, false);
  assert.equal(s.file_size, 0);

  const detail = data.__test.loadKiroCliDetail(UUID);
  assert.deepEqual(detail, { messages: [] });
});

test('findSessionFile resolves file-based Kiro sessions to the kiro-cli format', () => {
  const home = tmpHome();
  writeKiroCliSession(home, UUID, sampleMeta('/tmp/project'), sampleEvents());

  const data = freshDataWithHome(home);
  const found = data.findSessionFile(UUID, '/tmp/project');

  assert.ok(found, 'expected findSessionFile to resolve the kiro-cli session');
  assert.equal(found.format, 'kiro-cli');
  assert.equal(found.sessionId, UUID);
  assert.match(found.file, /\.kiro[\/\\]sessions[\/\\]cli[\/\\]/);
});

test('detail, preview, search, replay, and export are wired end-to-end for kiro-cli', () => {
  const home = tmpHome();
  writeKiroCliSession(home, UUID, sampleMeta('/tmp/project'), sampleEvents());

  const data = freshDataWithHome(home);

  const detail = data.loadSessionDetail(UUID, '/tmp/project');
  assert.deepEqual(detail.messages.map(m => m.content), ['Please fix the parser', 'Parser fixed']);

  const preview = data.getSessionPreview(UUID, '/tmp/project', 10);
  assert.deepEqual(preview.map(m => m.content), ['Please fix the parser', 'Parser fixed']);

  const replay = data.getSessionReplay(UUID, '/tmp/project');
  assert.deepEqual(replay.messages.map(m => m.content), ['Please fix the parser', 'Parser fixed']);

  const md = data.exportSessionMarkdown(UUID, '/tmp/project');
  assert.match(md, /Please fix the parser/);
  assert.match(md, /Parser fixed/);
});
