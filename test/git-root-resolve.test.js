const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { _parseMainWorktree, resolveGitRoot, ALL_HOMES } = require('../src/data').__test;

test('_parseMainWorktree returns first worktree path', () => {
  const porcelain = [
    'worktree /repos/myproj',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /repos/myproj-feature',
    'HEAD def456',
    'branch refs/heads/feature',
    '',
  ].join('\n');
  assert.equal(_parseMainWorktree(porcelain), '/repos/myproj');
});

test('_parseMainWorktree handles empty input', () => {
  assert.equal(_parseMainWorktree(''), '');
  assert.equal(_parseMainWorktree(null), '');
});

test('_parseMainWorktree ignores lines that look like worktree but are not records', () => {
  const porcelain = 'HEAD abc\nworktree /a\n';
  assert.equal(_parseMainWorktree(porcelain), '/a');
});

test('resolveGitRoot collapses linked worktree to main repo', () => {
  // git resolves symlinks (macOS /var → /private/var), so use realpath upfront.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codbash-wt-')));
  try {
    const main = path.join(tmp, 'main');
    fs.mkdirSync(main, { recursive: true });
    const gitOpts = { cwd: main, stdio: 'ignore', timeout: 5000 };
    execFileSync('git', ['init', '-q', '-b', 'main'], gitOpts);
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], gitOpts);
    const wt = path.join(tmp, 'wt-feature');
    execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'feature'], gitOpts);

    // Both the main checkout and the linked worktree must resolve to the main path.
    assert.equal(resolveGitRoot(main), main);
    assert.equal(resolveGitRoot(wt), main);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveGitRoot ignores $HOME-as-git-root', (t) => {
  const home = ALL_HOMES[0];
  if (!home || !fs.existsSync(path.join(home, '.git'))) {
    t.skip('home is not a git repo on this machine');
    return;
  }
  assert.equal(resolveGitRoot(home), '');
});

test('resolveGitRoot returns empty for bare repos', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codbash-bare-')));
  try {
    const bare = path.join(tmp, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore', timeout: 5000 });
    assert.equal(resolveGitRoot(bare), '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveGitRoot normalizes symlinked paths to a single key', () => {
  // Simulates macOS /var -> /private/var: two input paths for the same dir
  // must produce the same git root, not two cache entries.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codbash-sym-')));
  try {
    const real = path.join(tmp, 'real');
    fs.mkdirSync(real);
    const link = path.join(tmp, 'link');
    fs.symlinkSync(real, link);
    const gitOpts = { cwd: real, stdio: 'ignore', timeout: 5000 };
    execFileSync('git', ['init', '-q', '-b', 'main'], gitOpts);
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], gitOpts);
    assert.equal(resolveGitRoot(real), real);
    assert.equal(resolveGitRoot(link), real);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
