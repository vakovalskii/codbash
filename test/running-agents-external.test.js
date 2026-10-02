'use strict';

// Running-agents tree = every currently-running agent, local (inside codbash)
// and external (native terminal) alike. See
// docs/design/running-agents-external.md and specs/running-agents-external.feature.
//
// Core logic under test: _tagLocalAgents — pure ancestry tagging that marks each
// live agent local=true when its process tree reaches a codbash-pty pid, else
// local=false (an agent running in an external native terminal). The Running
// agents tree shows BOTH, colored by which, and dispatches clicks differently:
// local → jump to the matching Workspace tab/pane, external → focus the real
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

test('running-agents tree includes both local and external agents', () => {
  const src = wsSource();
  const fn = src.match(/function _wsRunningTree\(mode\)[\s\S]*?\n\}/);
  assert.ok(fn, '_wsRunningTree should exist');
  assert.doesNotMatch(fn[0], /if\s*\(a\.local/, 'must not filter out local (codbash-pane) agents');
  assert.doesNotMatch(fn[0], /return;\s*\/\/.*local/i, 'must not early-return on local agents');
});

test('_wsRunningTree supports grouping by project or by agent kind, 3 levels deep', () => {
  const src = wsSource();
  const fn = src.match(/function _wsRunningTree\(mode\)[\s\S]*?\n\}/);
  assert.ok(fn, '_wsRunningTree should exist');
  assert.match(fn[0], /mode === 'agent'/, 'must branch on the agent grouping mode');
  assert.match(fn[0], /subgroups/, 'must nest an inner group under the outer group (3-level tree)');
  assert.match(fn[0], /sessions:/, 'each subgroup must carry its individual sessions, not just a flat label');
});

test('a subgroup with a single session collapses instead of adding a redundant leaf row', () => {
  const src = wsSource();
  assert.match(src, /ws-run-leaf/, 'single-session subgroups must render with the collapsed leaf style');
  assert.match(src, /sg\.sessions\.length === 1/, 'render must special-case the single-session subgroup');
});

// ── Accordion (L1 groups collapsed by default) ──────────────────────────────

test('top-level groups render collapsed by default', () => {
  const src = wsSource();
  const fn = src.match(/function _wsRenderRunningTree\(\)[\s\S]*?\n\}/);
  assert.ok(fn, '_wsRenderRunningTree should exist');
  assert.match(fn[0], /_wsRunExpanded\[key\] === true/, 'a group must be expanded only when explicitly recorded true — collapsed is the default');
});

test('the L1 header toggles the accordion instead of jumping to a session', () => {
  const src = wsSource();
  const fn = src.match(/function _wsRenderRunningTree\(\)[\s\S]*?\n\}/);
  assert.ok(fn, '_wsRenderRunningTree should exist');
  const l1Row = fn[0].match(/<div class="ws-run-l1"[\s\S]*?<\/div>/);
  assert.ok(l1Row, 'the L1 row markup should exist');
  assert.match(l1Row[0], /_wsToggleRunGroup\(this\)/, 'clicking the L1 header must toggle expand/collapse');
  assert.doesNotMatch(l1Row[0], /jumpToRunningAgent/, 'the L1 header must not jump — that action lives on leaf rows');
});

test('_wsToggleRunGroup flips the collapsed class and records the choice', () => {
  const src = wsSource();
  const fn = src.match(/function _wsToggleRunGroup\([\s\S]*?\n\}/);
  assert.ok(fn, '_wsToggleRunGroup should exist');
  assert.match(fn[0], /classList\.toggle\('collapsed'\)/, 'must toggle the collapsed class on the group wrapper');
  assert.match(fn[0], /_wsRunExpanded\[key\]/, 'must record the expand choice for later rebuilds');
});

test('the grouping mode preference persists to localStorage', () => {
  const src = wsSource();
  assert.match(src, /function _wsSetRunningGroupMode/, '_wsSetRunningGroupMode should exist');
  assert.match(src, /localStorage\.setItem\(WS_RUN_GROUP_KEY/, 'must persist the chosen mode');
});

test('clicking a local running agent jumps to its Workspace pane, not /api/focus', () => {
  const src = wsSource();
  const fn = src.match(/function jumpToRunningAgent\([\s\S]*?\n\}/);
  assert.ok(fn, 'jumpToRunningAgent should exist');
  assert.match(fn[0], /if \(local\)/, 'must branch on the local flag');
  assert.match(fn[0], /jumpToWorkspacePane/, 'local agents must jump to their pane');
});

test('clicking an external running agent focuses its window via /api/focus', () => {
  const src = wsSource();
  const fn = src.match(/function jumpToRunningAgent\([\s\S]*?\n\}/);
  assert.ok(fn, 'jumpToRunningAgent should exist');
  assert.match(fn[0], /\/api\/focus/, 'must POST to /api/focus for external agents');
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

test('local agent carries ptyPid of the pane shell it descends from', () => {
  // Two panes (100, 110) in the same cwd: each agent must map to ITS pane.
  const live = new Set([100, 110]);
  const ppidOf = new Map([[200, 100], [210, 205], [205, 110], [300, 1]]);
  const out = data._tagLocalAgents(
    [{ pid: 200, cwd: '/p' }, { pid: 210, cwd: '/p' }, { pid: 300, cwd: '/p' }], live, ppidOf);
  assert.deepEqual(out.map(a => a.ptyPid), [100, 110, undefined]);
});
