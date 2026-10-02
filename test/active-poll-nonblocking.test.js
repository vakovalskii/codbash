// Guards the /api/active path (polled every 5s by the dashboard) against
// synchronous subprocess calls.
//
// Why this matters: the server, the HTTP API and the browser-terminal
// WebSocket all share ONE process and ONE event loop. Anything synchronous on a
// polled path stalls the pty data pump, so typing in the terminal freezes.
// `findQwenSessionByPid` used to run `execSync('lsof …')` — with a 2000ms
// timeout, per pid — right inside `getActiveSessions()`. lsof is still the only
// precise signal for which transcript a pid has open, so it is kept, but the
// lookup now reads a cache refreshed off the loop.
//
// A timing assertion would be useless here (a dev machine usually has zero
// running Qwen agents, so the hot loop never executes and any measurement comes
// back green regardless). Instead this asserts the property structurally.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'data.js'), 'utf8');

// Exact function body by brace matching — slicing "up to the next `function`"
// is not reliable here (neighbours are declared as `const x = …`, so the slice
// ran on for several functions), and comments must be stripped or a mere
// *mention* of execSync in prose trips the assertions.
function sliceFn(name) {
  const start = SRC.indexOf('function ' + name);
  assert.notEqual(start, -1, name + ' not found in data.js');
  let i = SRC.indexOf('{', start);
  assert.notEqual(i, -1, name + ' has no body');
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) { i++; break; }
  }
  return SRC.slice(start, i)
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/^[ \t]*\/\/.*$/gm, '');   // line comments
}

test('findQwenSessionByPid never shells out synchronously', () => {
  const body = sliceFn('findQwenSessionByPid');
  assert.equal(/execSync|execFileSync|spawnSync/.test(body), false,
    'no synchronous subprocess call may run on the 5s /api/active path');
});

test('the lsof lookup runs off the event loop and is cached', () => {
  const body = sliceFn('_refreshQwenOpenFiles');
  assert.match(body, /_execFileAsync\(/, 'lsof must be invoked asynchronously');
  assert.match(body, /lsof/, 'still uses lsof — it is the only precise signal');
  // argv form, not a shell string: the pid is interpolated into the command.
  assert.match(body, /\[\s*'-a'\s*,\s*'-p'/, 'lsof args must be passed as argv');
  assert.match(SRC, /_qwenOpenFileCache\s*=\s*new Map\(\)/, 'results must be cached per pid');
});

test('an in-flight lsof refresh is not started twice for the same pid', () => {
  const body = sliceFn('_refreshQwenOpenFiles');
  assert.match(body, /_qwenOpenFileInflight\.has\(pid\)/);
  assert.match(body, /_qwenOpenFileInflight\.add\(pid\)/);
  assert.match(body, /_qwenOpenFileInflight\.delete\(pid\)/);
});

test('the pid cache is bounded so it cannot grow without limit', () => {
  const body = sliceFn('_refreshQwenOpenFiles');
  assert.match(body, /_qwenOpenFileCache\.size\s*>/, 'must cap the cache');
  assert.match(body, /_qwenOpenFileCache\.delete\(/, 'must evict stale entries');
});

test('getActiveSessions itself stays free of synchronous subprocess calls', () => {
  const body = sliceFn('getActiveSessions');
  assert.equal(/execSync\(|execFileSync\(|spawnSync\(/.test(body), false,
    'getActiveSessions is polled every 5s — it must not block the loop');
});
