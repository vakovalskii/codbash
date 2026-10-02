'use strict';

// Two backlog items from the UX/server audit:
//
//  1. The leaderboard's GitHub device-code modal was a bare div — no dialog
//     semantics, no Escape, no focus handling — and its poll loop swallowed
//     every network error in a bare `catch {}`, leaving the user staring at
//     "Waiting for authorization..." forever. app.js's repo-scope flow
//     (pollRepoScopeOnce) already had the right shape; this brings parity.
//
//  2. Three exec sites interpolated values into a shell string instead of
//     using the argv form the rest of the codebase documents as the
//     injection-safe pattern (see the tar call in migrate.js).
//
// Source-level contract tests, matching the style of the other frontend
// tests here (the browser files aren't importable modules).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function src(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function fn(source, name) {
  const m = source.match(new RegExp('(?:async )?function ' + name + '\\([\\s\\S]*?\\n\\}'));
  assert.ok(m, name + ' should exist');
  return m[0];
}

// ── 1. GitHub auth modal ────────────────────────────────────────────────────

test('the auth modal is a real dialog', () => {
  const body = fn(src('src/frontend/leaderboard.js'), '_lbBuildAuthModal');
  assert.match(body, /'role', 'dialog'/, 'must be role="dialog"');
  assert.match(body, /'aria-modal', 'true'/, 'must be aria-modal');
  assert.match(body, /aria-labelledby/, 'must point at its own title');
});

test('the auth modal handles Escape and traps Tab', () => {
  const body = fn(src('src/frontend/leaderboard.js'), '_lbBuildAuthModal');
  assert.match(body, /e\.key === 'Escape'/, 'Escape must close the dialog');
  assert.match(body, /e\.key !== 'Tab'/, 'Tab must be handled for focus trapping');
  assert.match(body, /shiftKey/, 'Shift+Tab must wrap backwards');
});

test('closing the modal returns focus to whatever opened it', () => {
  const source = src('src/frontend/leaderboard.js');
  const body = fn(source, '_lbCloseAuthModal');
  assert.match(body, /_lbAuthFocusReturn/, 'must restore the saved focus target');
  assert.match(body, /document\.body\.contains/,
    'must not focus a node that render() has since replaced');
  assert.match(fn(source, 'githubConnect'), /_lbAuthFocusReturn = document\.activeElement/,
    'must capture the opener before showing the dialog');
});

test('the status line is announced to screen readers', () => {
  const body = fn(src('src/frontend/leaderboard.js'), '_lbBuildAuthModal');
  assert.match(body, /aria-live/, 'status updates must be announced, not just painted');
});

test('the poll loop surfaces failures instead of swallowing them', () => {
  const body = fn(src('src/frontend/leaderboard.js'), 'githubConnect');
  assert.doesNotMatch(body, /\}\s*catch\s*\{\s*\}/, 'no bare catch {} may remain');
  assert.match(body, /errorStreak/, 'repeated network failures must be counted');
  assert.match(body, /Connection error/, 'a persistent failure must be shown to the user');
  assert.match(body, /pollData\.error/, 'an error field from the server must be surfaced');
});

test('the poll loop honours slow_down (RFC 8628 §3.5)', () => {
  const body = fn(src('src/frontend/leaderboard.js'), 'githubConnect');
  assert.match(body, /slow_down/, 'must handle the slow_down status');
  assert.match(body, /interval \+= 5000/, 'must back off by at least 5s, per the RFC');
});

test('the cancel button is wired in JS, not by walking parentElement', () => {
  const body = fn(src('src/frontend/leaderboard.js'), '_lbBuildAuthModal');
  assert.doesNotMatch(body, /parentElement\.parentElement/,
    'brittle DOM walking in an inline onclick should be a real handler');
  assert.match(body, /githubAuthCancel/, 'the cancel button should be addressed by id');
});

// ── 2. No interpolated shell strings at the flagged exec sites ───────────────

// Matches execSync(`...${x}...`) — a template literal carrying an
// interpolation, i.e. a value being spliced into a shell command line.
const INTERPOLATED_EXEC = /execSync\(\s*`[^`]*\$\{/;

// The Qwen lsof lookup moved off the event loop into _refreshQwenOpenFiles
// (#289); it must still pass the pid as argv, never a shell string.
test('Qwen open-file lookup runs lsof via argv, not a shell string', () => {
  const source = src('src/data.js');
  for (const name of ['findQwenSessionByPid', '_refreshQwenOpenFiles']) {
    assert.doesNotMatch(fn(source, name), INTERPOLATED_EXEC, name + ' must not interpolate the pid into a shell command');
  }
  assert.match(fn(source, '_refreshQwenOpenFiles'), /_execFileAsync\('lsof', \['-a', '-p', String\(pid\), '-Fn'\]/,
    'must pass the pid as a separate argv entry');
});

test('migrate.js no longer builds shell commands from home paths', () => {
  const source = src('src/migrate.js');
  assert.doesNotMatch(source, INTERPOLATED_EXEC, 'no interpolated shell command may remain');
  assert.doesNotMatch(source, /execSync/, 'migrate.js should not need execSync at all now');
  assert.match(source, /execFileSync\('find', \[full, '-type', 'f'\]/,
    'find must take the path as an argv entry');
});

// Comments deliberately describe the removed `du` call and why — assert on
// the code itself, not the explanation of it.
function stripComments(source) {
  return source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

test('the dead du total is gone (it was also wrong on macOS)', () => {
  const code = stripComments(src('src/migrate.js'));
  assert.doesNotMatch(code, /du -s/, 'the du call was dead code');
  assert.doesNotMatch(code, /totalSize/,
    'totalSize was computed and never printed — and summed KB as bytes on BSD du');
  assert.match(code, /totalFiles/, 'the file count is still reported');
});
