'use strict';

// The LLM API key (Settings → Integrations → AI titles) must never leave the
// server: GET /api/llm-config vends only { hasKey, keyHint }, matching the
// rule already applied to /api/github/profile ("Never vend raw tokens to the
// browser"). These are source-level contract tests, same style as
// running-agents-external.test.js — the frontend/server files are not
// importable modules, so we assert on the source directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function src(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

// ── Server: GET redacts, POST preserves, file is private ────────────────────

test('GET /api/llm-config never returns the raw apiKey', () => {
  const server = src('src/server.js');
  const route = server.match(/pathname === '\/api\/llm-config'\) \{[\s\S]*?\n    \}/);
  assert.ok(route, 'GET /api/llm-config route should exist');
  assert.doesNotMatch(route[0], /json\(res,\s*config\)/,
    'must not vend the loaded config object verbatim (it contains apiKey)');
  assert.match(route[0], /hasKey/, 'must expose only a boolean hasKey');
  assert.match(route[0], /keyHint/, 'must expose only a short masked hint');
});

test('POST /api/llm-config preserves the stored key when the field is empty', () => {
  const server = src('src/server.js');
  assert.match(server, /config\.apiKey \|\| existing\.apiKey/,
    'an empty apiKey in the POST body must fall back to the stored key');
  assert.match(server, /clearApiKey/,
    'clearing the key must require the explicit clearApiKey flag');
});

test('the LLM config file is written owner-only (0600)', () => {
  const server = src('src/server.js');
  const fn = server.match(/function saveLLMConfig\([\s\S]*?\n\}/);
  assert.ok(fn, 'saveLLMConfig should exist');
  assert.match(fn[0], /0o600/, 'must write the key file with mode 0600');
  assert.match(fn[0], /chmodSync/, 'must also tighten a pre-existing file');
});

// ── Frontend: the secret never lands in the DOM ─────────────────────────────

test('loadLLMSettings never puts a key value into the input', () => {
  const app = src('src/frontend/app.js');
  const fn = app.match(/function loadLLMSettings\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'loadLLMSettings should exist');
  assert.doesNotMatch(fn[0], /\.value = c\.apiKey/,
    'must not populate the password input with the fetched key');
  assert.match(fn[0], /placeholder/, 'must surface the stored-key state via a placeholder hint');
});

// ── Leaderboard: external links cannot reach window.opener ──────────────────

test('every target="_blank" link in leaderboard.js carries rel="noopener noreferrer"', () => {
  const lb = src('src/frontend/leaderboard.js');
  const blanks = lb.match(/target="_blank"/g) || [];
  const guarded = lb.match(/target="_blank" rel="noopener noreferrer"/g) || [];
  assert.ok(blanks.length > 0, 'expected at least one external link');
  assert.equal(guarded.length, blanks.length,
    'every _blank link must include rel="noopener noreferrer"');
});
