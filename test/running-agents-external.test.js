'use strict';

// Running-agents = external terminals. See docs/design/running-agents-external.md
// and specs/running-agents-external.feature.
//
// Core logic under test: _tagLocalAgents — pure ancestry tagging that marks each
// live agent local=true when its process tree reaches a codbash-pty pid, else
// local=false (an agent running in an external native terminal). The Running
// agents tree shows only the external ones and clicking focuses their real
// window (never spawns a blank terminal).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const data = require('../src/data.js').__test;

// ── _tagLocalAgents (pure) ────────────────────────────────────────────────

test('external agent (no codbash-pty ancestor) is tagged local=false', () => {
  const live = new Set([100]); // codbash pane shell pid
  const ppidOf = new Map([
    [200, 150], // agent 200 → iTerm 150
    [150, 1],   // iTerm 150 → launchd
  ]);
  const out = data._tagLocalAgents([{ pid: 200, cwd: '/p/a' }], live, ppidOf);
  assert.equal(out.length, 1);
  assert.equal(out[0].local, false);
});

test('agent descending from a codbash pty is tagged local=true', () => {
  const live = new Set([100]);
  const ppidOf = new Map([
    [300, 100], // agent 300 → codbash pane shell 100 (live)
  ]);
  const out = data._tagLocalAgents([{ pid: 300, cwd: '/p/b' }], live, ppidOf);
  assert.equal(out[0].local, true);
});

test('deep ancestry (grandchild of a codbash pty) is still local=true', () => {
  const live = new Set([100]);
  const ppidOf = new Map([
    [400, 350],
    [350, 100], // → codbash pane shell
  ]);
  const out = data._tagLocalAgents([{ pid: 400 }], live, ppidOf);
  assert.equal(out[0].local, true);
});

test('empty codbash-pty registry → every agent is external (local=false)', () => {
  const live = new Set();
  const ppidOf = new Map([[500, 1]]);
  const out = data._tagLocalAgents([{ pid: 500 }, { pid: 600 }], live, ppidOf);
  assert.deepEqual(out.map(a => a.local), [false, false]);
  assert.equal(out.length, 2, 'all agents are returned, none dropped');
});

test('_tagLocalAgents does not mutate its input objects', () => {
  const input = [{ pid: 700, cwd: '/x' }];
  const out = data._tagLocalAgents(input, new Set([700]), new Map());
  assert.equal(Object.prototype.hasOwnProperty.call(input[0], 'local'), false,
    'input object must stay untouched (immutability)');
  assert.equal(out[0].local, true);
  assert.notEqual(out[0], input[0], 'a new object is returned');
});

test('ancestry walk is bounded (a ppid cycle cannot hang)', () => {
  const live = new Set([100]);
  const ppidOf = new Map([[800, 900], [900, 800]]); // cycle, never reaches 100
  const out = data._tagLocalAgents([{ pid: 800 }], live, ppidOf);
  assert.equal(out[0].local, false);
});

test('all live agents are preserved (external + local together)', () => {
  const live = new Set([100]);
  const ppidOf = new Map([[300, 100], [200, 150], [150, 1]]);
  const out = data._tagLocalAgents(
    [{ pid: 300 }, { pid: 200 }], live, ppidOf);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(a => a.local), [true, false]);
});

// ── Frontend wiring: focus real window, never a blank terminal ─────────────

function wsSource() {
  return fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'workspace.js'), 'utf8');
}

test('running-agents tree excludes codbash-pane agents (local=true)', () => {
  const src = wsSource();
  const fn = src.match(/function _wsRunningByProject\(\)[\s\S]*?\n\}/);
  assert.ok(fn, '_wsRunningByProject should exist');
  assert.match(fn[0], /a\.local/, 'must filter out local (codbash-pane) agents');
});

test('clicking a running agent focuses its window via /api/focus', () => {
  const src = wsSource();
  const fn = src.match(/function jumpToRunningAgent\([\s\S]*?\n\}/);
  assert.ok(fn, 'jumpToRunningAgent should exist');
  assert.match(fn[0], /\/api\/focus/, 'must POST to /api/focus');
});

test('clicking a running agent never opens a blank terminal', () => {
  const src = wsSource();
  const fn = src.match(/function jumpToRunningAgent\([\s\S]*?\n\}/);
  assert.ok(fn, 'jumpToRunningAgent should exist');
  assert.doesNotMatch(fn[0], /openInWorkspace/,
    'must NOT spawn a blank terminal as a stand-in for the running agent');
});

test('the pid is passed to jumpToRunningAgent as a numeric argument', () => {
  const src = wsSource();
  // The tree rows must forward a validated numeric pid (server /api/focus
  // requires Number.isInteger(pid)). We assert jumpToRunningAgent accepts pid.
  const fn = src.match(/function jumpToRunningAgent\(([^)]*)\)/);
  assert.ok(fn, 'jumpToRunningAgent should exist');
  assert.match(fn[1], /pid/, 'signature should accept a pid parameter');
});
