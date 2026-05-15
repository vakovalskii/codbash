const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { atomicWriteJson } = require('../src/atomic');

function mkTmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test('atomicWriteJson writes valid JSON matching the input object', () => {
  const tmp = mkTmp('codbash-atomic-');
  try {
    const target = path.join(tmp, 'data.json');
    const obj = { a: 1, b: 'two', c: [3, 4], d: { nested: true } };
    atomicWriteJson(target, obj);
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.deepEqual(parsed, obj);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('atomicWriteJson creates the parent directory if missing', () => {
  const tmp = mkTmp('codbash-atomic-');
  try {
    const target = path.join(tmp, 'sub', 'nested', 'data.json');
    assert.equal(fs.existsSync(path.dirname(target)), false);
    atomicWriteJson(target, { ok: true });
    assert.equal(fs.existsSync(target), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { ok: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('atomicWriteJson cleans up the .tmp file after a successful rename', () => {
  const tmp = mkTmp('codbash-atomic-');
  try {
    const target = path.join(tmp, 'data.json');
    atomicWriteJson(target, { a: 1 });
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.existsSync(target + '.tmp'), false, '.tmp file must not linger');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('atomicWriteJson throws when the target directory is not writable (EACCES)', () => {
  // Skip if running as root — chmod 555 won't deny root.
  if (process.getuid && process.getuid() === 0) return;
  const tmp = mkTmp('codbash-atomic-');
  try {
    fs.chmodSync(tmp, 0o555); // read+exec only — no write
    const target = path.join(tmp, 'data.json');
    assert.throws(
      () => atomicWriteJson(target, { a: 1 }),
      /EACCES|EPERM|permission denied/i,
    );
  } finally {
    try { fs.chmodSync(tmp, 0o755); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('atomicWriteJson never leaves the target file in a partial-write state', () => {
  // If rename fails, the original target (or absence) must be preserved.
  // We simulate by writing valid v1 first, then making rename fail on v2.
  const tmp = mkTmp('codbash-atomic-');
  const origRename = fs.renameSync;
  try {
    const target = path.join(tmp, 'data.json');
    atomicWriteJson(target, { version: 1 });
    const v1Contents = fs.readFileSync(target, 'utf8');

    // Force the next rename to throw.
    fs.renameSync = () => { throw new Error('simulated rename failure'); };
    assert.throws(
      () => atomicWriteJson(target, { version: 2 }),
      /simulated rename failure/,
    );

    // Target file must still be the old, valid v1 — never half-written.
    fs.renameSync = origRename;
    assert.equal(fs.readFileSync(target, 'utf8'), v1Contents);
    // And no .tmp leftover.
    assert.equal(fs.existsSync(target + '.tmp'), false);
  } finally {
    fs.renameSync = origRename;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
