const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeGitRemote, slugifyRemoteForDir } = require('../src/cloud').__test;

test('normalizeGitRemote maps https/ssh/git URLs to same canonical form', () => {
  const expected = 'github.com/user/repo';
  assert.equal(normalizeGitRemote('https://github.com/user/repo.git'), expected);
  assert.equal(normalizeGitRemote('http://github.com/user/repo'), expected);
  assert.equal(normalizeGitRemote('git@github.com:user/repo.git'), expected);
  assert.equal(normalizeGitRemote('ssh://git@github.com/user/repo.git'), expected);
  assert.equal(normalizeGitRemote('git://github.com/user/repo'), expected);
  assert.equal(normalizeGitRemote('https://Github.com/User/Repo.GIT'), expected);
});

test('normalizeGitRemote strips embedded credentials', () => {
  assert.equal(
    normalizeGitRemote('https://user:token@github.com/org/repo.git'),
    'github.com/org/repo'
  );
  assert.equal(
    normalizeGitRemote('ssh://deploy@gitlab.example.com/group/repo.git'),
    'gitlab.example.com/group/repo'
  );
});

test('normalizeGitRemote strips trailing slashes and .git', () => {
  assert.equal(normalizeGitRemote('https://github.com/a/b.git/'), 'github.com/a/b');
  assert.equal(normalizeGitRemote('https://github.com/a/b///'), 'github.com/a/b');
});

test('normalizeGitRemote returns empty on falsy or non-string input', () => {
  assert.equal(normalizeGitRemote(''), '');
  assert.equal(normalizeGitRemote(null), '');
  assert.equal(normalizeGitRemote(undefined), '');
  assert.equal(normalizeGitRemote(123), '');
  assert.equal(normalizeGitRemote('   '), '');
});

test('slugifyRemoteForDir produces filesystem-safe identifier', () => {
  assert.equal(slugifyRemoteForDir('github.com/user/repo'), 'github-com-user-repo');
  assert.equal(slugifyRemoteForDir('gitlab.example.com/group/sub/repo'), 'gitlab-example-com-group-sub-repo');
  assert.equal(slugifyRemoteForDir(''), 'unknown');
  assert.equal(slugifyRemoteForDir('---'), 'unknown');
});
