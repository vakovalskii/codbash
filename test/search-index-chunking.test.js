'use strict';

// The search index is built from EVERY session with detail — a findSessionFile
// lookup plus a full detail load (sync fs + JSON.parse per line) each. Doing
// that in one synchronous tick froze the event loop for seconds on a large
// history, stalling other requests and the terminal WebSocket data pump.
// buildSearchIndex now chunks with setImmediate yields (same shape as
// _scheduleAnalyticsRecompute) and getSearchIndex serves stale-while-revalidate.
//
// Source-level contract tests, same style as running-agents-external.test.js:
// data.js reaches into the real ~/.claude tree on load, so we assert on the
// source rather than driving the real indexer.

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

// ── Chunked build, yielding to the event loop ───────────────────────────────

test('buildSearchIndex is async and yields between chunks', () => {
  const body = fn(src('src/data.js'), 'buildSearchIndex');
  assert.match(body, /^async function/, 'must be async so it can yield mid-build');
  assert.match(body, /setImmediate/, 'must yield to the event loop between chunks');
  assert.match(body, /CHUNK/, 'must process sessions in bounded chunks');
});

test('getSearchIndex serves a stale index instead of blocking on rebuild', () => {
  const body = fn(src('src/data.js'), 'getSearchIndex');
  assert.match(body, /^async function/, 'must be async');
  // Only the cold path (no index at all) awaits; a stale index is returned
  // immediately while the rebuild runs in the background.
  assert.match(body, /if \(!searchIndex\) return await/,
    'cold start must await the first build');
  assert.match(body, /return searchIndex/,
    'a stale index must be returned without awaiting the refresh');
});

test('concurrent rebuilds are deduped into one in-flight job', () => {
  const source = src('src/data.js');
  assert.match(source, /_searchIndexBuilding/, 'must track the in-flight build');
  const body = fn(source, '_rebuildSearchIndex');
  assert.match(body, /if \(_searchIndexBuilding\) return _searchIndexBuilding/,
    'a second caller must join the in-flight build, not start another');
});

test('callers await the now-async search', () => {
  assert.match(fn(src('src/data.js'), 'searchFullText'), /await getSearchIndex/,
    'searchFullText must await the index');
  assert.match(src('src/server.js'), /searchFullText\(q, sessions\)\s*\n\s*\.then/,
    '/api/search must resolve the promise before responding');
  assert.match(src('bin/cli.js'), /await searchFullText/,
    'the CLI search command must await too');
});

// ── Per-format dispatch collapsed to a lookup table ─────────────────────────

test('bespoke per-format loaders live in one table, not copy-pasted branches', () => {
  const source = src('src/data.js');
  assert.match(source, /const SEARCH_DETAIL_LOADERS = \{/, 'loader table should exist');
  const table = source.match(/const SEARCH_DETAIL_LOADERS = \{[\s\S]*?\n\};/)[0];
  // Every format that previously had its own if/else branch must still resolve.
  for (const format of ['qwen', 'kilo', 'opencode', 'kiro', 'kiro-cli', 'cursor', 'pi', 'copilot', 'copilot-chat']) {
    assert.ok(
      table.includes("'" + format + "'") || new RegExp('(^|\\s)' + format + ':').test(table),
      'format ' + format + ' must still have a loader'
    );
  }
  // Kilo and Kiro are different agents with different loaders — an easy
  // one-character mixup when collapsing the branches.
  assert.match(table, /kilo:\s*\(id\)\s*=>\s*loadKiloCliDetail/, 'kilo must map to the Kilo loader');
  assert.match(table, /'kiro-cli':\s*\(id\)\s*=>\s*loadKiroCliDetail/, 'kiro-cli must map to the Kiro loader');
});

test('snippet length is one named constant, not repeated magic numbers', () => {
  const source = src('src/data.js');
  assert.match(source, /const SEARCH_SNIPPET_LEN = 500/, 'snippet cap should be a named constant');
  for (const name of ['_searchTextsFromMessages', '_searchTextFromJsonlLine']) {
    assert.match(fn(source, name), /SEARCH_SNIPPET_LEN/, name + ' must use the constant');
  }
});

test('the generic JSONL path still distinguishes claude from codex', () => {
  const body = fn(src('src/data.js'), '_searchTextFromJsonlLine');
  assert.match(body, /format === 'claude'/, 'claude entries are typed user/assistant');
  assert.match(body, /response_item/, 'codex entries are wrapped in response_item payloads');
});

// ── Oversized transcripts stream instead of blocking ────────────────────────

test('a large JSONL session is streamed, not slurped whole', () => {
  const source = src('src/data.js');
  assert.match(source, /const SEARCH_STREAM_THRESHOLD/, 'a size threshold should be named');
  const body = fn(source, '_indexSession');
  assert.match(body, /SEARCH_STREAM_THRESHOLD/, 'must branch on file size');
  assert.match(body, /_searchTextsFromJsonlStreaming/, 'oversized files take the streaming path');
});

test('the streaming reader yields mid-file so one huge session cannot freeze the loop', () => {
  const body = fn(src('src/data.js'), '_searchTextsFromJsonlStreaming');
  assert.match(body, /^async function/, 'must be async');
  assert.match(body, /createReadStream/, 'must stream rather than readFileSync the whole file');
  assert.match(body, /setImmediate/, 'must yield to the event loop while reading');
});

test('both JSONL readers share one line parser so they cannot drift', () => {
  const source = src('src/data.js');
  for (const name of ['_searchTextsFromJsonl', '_searchTextsFromJsonlStreaming']) {
    assert.match(fn(source, name), /_searchTextFromJsonlLine/,
      name + ' must delegate to the shared per-line parser');
  }
});

test('_indexSession is awaited by the builder', () => {
  assert.match(fn(src('src/data.js'), 'buildSearchIndex'), /await _indexSession/,
    'the builder must await the now-async per-session indexer');
});
