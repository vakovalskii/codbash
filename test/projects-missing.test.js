// Tests for missing-project detection (pathExists) + re-clone guardrails.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projects = require('../src/projects');

function mkTmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test('pathExists returns true for an existing directory', () => {
  const dir = mkTmpDir('codbash-exists-');
  try {
    assert.equal(projects.pathExists(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pathExists returns false after the directory is deleted', () => {
  const dir = mkTmpDir('codbash-gone-');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(projects.pathExists(dir), false);
});

test('pathExists returns false for a regular file (not a directory)', () => {
  const dir = mkTmpDir('codbash-file-');
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'x');
  try {
    assert.equal(projects.pathExists(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pathExists returns false for empty / non-string input', () => {
  assert.equal(projects.pathExists(''), false);
  assert.equal(projects.pathExists(null), false);
  assert.equal(projects.pathExists(undefined), false);
  assert.equal(projects.pathExists(42), false);
});

test('cloneRepo rejects a non-GitHub remote (re-clone guardrail)', async () => {
  await assert.rejects(
    () => projects.cloneRepo('https://gitlab.com/me/repo.git', path.join(os.homedir(), 'code', 'x')),
    /only GitHub remotes/i
  );
});

test('cloneRepo rejects a destination outside the home directory', async () => {
  await assert.rejects(
    () => projects.cloneRepo('https://github.com/me/repo.git', '/tmp/not-home-target'),
    /must be under your home directory/i
  );
});

test('cloneRepo rejects a destination whose ancestor is a symlink pointing outside home', async (t) => {
  if (process.platform === 'win32') return; // symlink perms differ on Windows
  // Plant a symlinked ancestor under $HOME that resolves outside it, then aim a
  // clone at a (missing) child path — the textual startsWith check passes but the
  // realpath-of-nearest-ancestor guard must catch the escape.
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codbash-outside-')));
  const homeBase = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.codbash-symlink-test-')));
  const linkDir = path.join(homeBase, 'link');
  t.after(() => {
    fs.rmSync(homeBase, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.symlinkSync(outside, linkDir);
  await assert.rejects(
    () => projects.cloneRepo('https://github.com/me/repo.git', path.join(linkDir, 'repo')),
    /symlinked parent|home directory/i
  );
});

test('cloneRepo rejects a remote with control characters in the suffix', async () => {
  await assert.rejects(
    () => projects.cloneRepo('https://github.com/me/repo\n.git', path.join(os.homedir(), 'code', 'x')),
    /only GitHub remotes/i
  );
});

test('pathExists follows a directory symlink (documented behavior)', (t) => {
  if (process.platform === 'win32') return;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codbash-symtgt-')));
  const target = path.join(base, 'real');
  const link = path.join(base, 'link');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(target);
  fs.symlinkSync(target, link);
  assert.equal(projects.pathExists(link), true);
});

test('cloneRepo treats an already-present same-remote clone as success (idempotent re-clone)', async () => {
  // Build a real git repo under $HOME whose origin matches, so cloneRepo takes
  // the "alreadyExisted" fast path with no network.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.codbash-reclone-test-')));
  const repo = path.join(base, 'repo');
  const remote = 'https://github.com/me/repo.git';
  const { execFileSync } = require('child_process');
  try {
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['-C', repo, 'init', '-q'], { timeout: 5000 });
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', remote], { timeout: 5000 });
    const result = await projects.cloneRepo(remote, repo);
    assert.equal(result.alreadyExisted, true);
    assert.equal(result.path, fs.realpathSync(repo));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
