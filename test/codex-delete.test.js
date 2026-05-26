const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codbash-codex-delete-')));
}

function writeJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function freshDataModule(home, backupDir) {
  const dataPath = require.resolve('../src/data');
  delete require.cache[dataPath];
  const oldHome = os.homedir;
  const oldBackup = process.env.CODEBASH_DELETE_BACKUP_DIR;
  os.homedir = () => home;
  process.env.CODEBASH_DELETE_BACKUP_DIR = backupDir;
  try {
    return require('../src/data');
  } finally {
    os.homedir = oldHome;
    if (oldBackup === undefined) delete process.env.CODEBASH_DELETE_BACKUP_DIR;
    else process.env.CODEBASH_DELETE_BACKUP_DIR = oldBackup;
  }
}

test('deleteSession removes Codex artifacts after creating a backup', () => {
  const home = tmpDir();
  const backupRoot = path.join(home, 'backup', 'codex');
  const project = path.join(home, 'work', 'demo');
  fs.mkdirSync(project, { recursive: true });

  const sid = '019e1234-1234-7000-8000-123456789abc';
  const otherSid = '019e9999-1234-7000-8000-123456789abc';
  const codexDir = path.join(home, '.codex');
  const sessionFile = path.join(codexDir, 'sessions', '2026', '05', '26', `rollout-20260526-${sid}.jsonl`);
  writeJsonl(sessionFile, [
    { type: 'session_meta', payload: { id: sid, cwd: project, timestamp: '2026-05-26T12:00:00Z' } },
    { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: '整理 Codex 记忆' }] } },
  ]);
  writeJsonl(path.join(codexDir, 'history.jsonl'), [
    { session_id: sid, ts: 1779796800, text: '整理 Codex 记忆', cwd: project },
    { session_id: otherSid, ts: 1779796900, text: 'keep me', cwd: project },
  ]);
  writeJsonl(path.join(codexDir, 'session_index.jsonl'), [
    { id: sid, thread_name: 'messy generated title', updated_at: 1779796800000 },
    { id: otherSid, thread_name: 'keep title', updated_at: 1779796900000 },
  ]);

  const data = freshDataModule(home, backupRoot);
  const deleted = data.deleteSession(sid, project);

  assert.equal(fs.existsSync(sessionFile), false);
  assert.match(deleted.join('\n'), /backup:/);
  assert.match(deleted.join('\n'), /codex session file/);
  assert.match(deleted.join('\n'), /1 codex history entries/);
  assert.match(deleted.join('\n'), /1 codex index entries/);

  const history = fs.readFileSync(path.join(codexDir, 'history.jsonl'), 'utf8');
  assert.equal(history.includes(sid), false);
  assert.equal(history.includes(otherSid), true);

  const index = fs.readFileSync(path.join(codexDir, 'session_index.jsonl'), 'utf8');
  assert.equal(index.includes(sid), false);
  assert.equal(index.includes(otherSid), true);

  const backupLine = deleted.find(x => x.startsWith('backup: '));
  const backupDir = backupLine.slice('backup: '.length);
  assert.equal(fs.existsSync(path.join(backupDir, 'manifest.json')), true);
  assert.equal(fs.existsSync(path.join(backupDir, 'session.jsonl')), true);
  assert.equal(fs.readFileSync(path.join(backupDir, 'history.jsonl'), 'utf8').includes(sid), true);
  assert.equal(fs.readFileSync(path.join(backupDir, 'session_index.jsonl'), 'utf8').includes(sid), true);
});

test('deleteSession handles Codex history-only sessions', () => {
  const home = tmpDir();
  const backupRoot = path.join(home, 'backup', 'codex');
  const project = path.join(home, 'work', 'demo');
  fs.mkdirSync(project, { recursive: true });

  const sid = '019e2234-1234-7000-8000-123456789abc';
  const codexDir = path.join(home, '.codex');
  writeJsonl(path.join(codexDir, 'history.jsonl'), [
    { session_id: sid, ts: 1779796800, text: 'history only', cwd: project },
  ]);

  const data = freshDataModule(home, backupRoot);
  const deleted = data.deleteSession(sid, project);

  assert.equal(fs.readFileSync(path.join(codexDir, 'history.jsonl'), 'utf8'), '');
  assert.match(deleted.join('\n'), /backup:/);
  assert.match(deleted.join('\n'), /1 codex history entries/);
});
