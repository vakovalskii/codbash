const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const data = require('../src/data');
const displayProject = data.__test && data.__test.displayProject;

test('displayProject is exported via __test', () => {
  assert.equal(typeof displayProject, 'function',
    'displayProject must be exported from src/data.js via __test');
});

test('basename for absolute path', () => {
  assert.equal(displayProject({ project: '/Users/x/code/codbash' }), 'codbash');
});

test('basename for tilde path', () => {
  assert.equal(displayProject({ project: '~/code/codbash' }), 'codbash');
});

test('basename for nested tilde path', () => {
  assert.equal(displayProject({ project: '~/work/api' }), 'api');
});

test('(home) for absolute homedir path', () => {
  assert.equal(displayProject({ project: os.homedir() }), '(home)');
});

test('(home) for bare tilde', () => {
  assert.equal(displayProject({ project: '~' }), '(home)');
});

test('falls back to project_short when project missing', () => {
  assert.equal(displayProject({ project_short: '~/code/foo' }), 'foo');
});

test('prefers project over project_short when both present', () => {
  assert.equal(
    displayProject({ project: '/Users/x/code/codbash', project_short: '~/old/path' }),
    'codbash'
  );
});

test('returns "unknown" for empty input', () => {
  assert.equal(displayProject({}), 'unknown');
  assert.equal(displayProject({ project: '', project_short: '' }), 'unknown');
  assert.equal(displayProject({ project: null }), 'unknown');
});

test('returns "unknown" for null/undefined session', () => {
  assert.equal(displayProject(null), 'unknown');
  assert.equal(displayProject(undefined), 'unknown');
});

test('basename collision: two paths with same last segment merge to same key', () => {
  // Accepted collision per SDD decision (basename-only display)
  assert.equal(displayProject({ project: '/a/b/api' }), 'api');
  assert.equal(displayProject({ project: '/c/d/api' }), 'api');
});

test('trailing slash does not produce empty basename', () => {
  // path.basename('/Users/x/code/codbash/') === 'codbash' in node
  assert.equal(displayProject({ project: '/Users/x/code/codbash/' }), 'codbash');
});

test('Windows-style path basename', () => {
  // Windows paths may appear in WSL/cross-platform data
  const result = displayProject({ project: 'C:\\Users\\x\\code\\myproj' });
  // Either basename('myproj') or treated as full string — we want a sane name, not the full path
  assert.ok(result === 'myproj' || result.length < 'C:\\Users\\x\\code\\myproj'.length,
    'Windows path should be reduced to a readable name, got: ' + result);
});

test('whitespace-only project returns unknown', () => {
  assert.equal(displayProject({ project: '   ' }), 'unknown');
});
