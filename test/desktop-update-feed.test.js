// Unit tests for the pure YAML transforms in desktop/scripts/regenerate-latest-mac.js.
// These cover the risky part (schema-preserving rewrite of electron-updater's
// mac feed) without needing a real signed build on disk.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseFeedEntries, rewriteFeedYaml } = require('../desktop/scripts/regenerate-latest-mac.js');

// A representative electron-builder mac feed: two zip entries (arm64 + x64),
// top-level path pointing at the x64 zip, and its sha512 mirrored top-level.
const SAMPLE = [
  'version: 7.16.0',
  'files:',
  '  - url: codbash-7.16.0-arm64-mac.zip',
  '    sha512: OLD_ARM_SHA',
  '    size: 111',
  '    blockMapSize: 11',
  '  - url: codbash-7.16.0-mac.zip',
  '    sha512: OLD_X64_SHA',
  '    size: 222',
  '    blockMapSize: 22',
  'path: codbash-7.16.0-mac.zip',
  'sha512: OLD_X64_SHA',
  "releaseDate: '2026-07-24T00:00:00.000Z'",
  '',
].join('\n');

test('parseFeedEntries reads every files[] entry with typed numbers', () => {
  const entries = parseFeedEntries(SAMPLE);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { url: 'codbash-7.16.0-arm64-mac.zip', sha512: 'OLD_ARM_SHA', size: 111, blockMapSize: 11 });
  assert.deepEqual(entries[1], { url: 'codbash-7.16.0-mac.zip', sha512: 'OLD_X64_SHA', size: 222, blockMapSize: 22 });
});

test('rewriteFeedYaml refreshes only the changed entry and syncs top-level sha512 to path', () => {
  // Only the x64 zip changed; the arm64 entry must be left untouched.
  const out = rewriteFeedYaml(SAMPLE, {
    'codbash-7.16.0-mac.zip': { sha512: 'NEW_X64_SHA', size: 999, blockMapSize: 99 },
  });
  const entries = parseFeedEntries(out);
  const arm = entries.find((e) => e.url.includes('arm64'));
  const x64 = entries.find((e) => !e.url.includes('arm64'));

  // Changed entry refreshed
  assert.deepEqual(x64, { url: 'codbash-7.16.0-mac.zip', sha512: 'NEW_X64_SHA', size: 999, blockMapSize: 99 });
  // Untouched entry preserved
  assert.deepEqual(arm, { url: 'codbash-7.16.0-arm64-mac.zip', sha512: 'OLD_ARM_SHA', size: 111, blockMapSize: 11 });
  // Top-level sha512 follows `path` (the x64 zip) → must be the new value
  assert.match(out, /^sha512: NEW_X64_SHA$/m);
  // Non-checksum metadata is preserved verbatim
  assert.match(out, /^version: 7\.16\.0$/m);
  assert.match(out, /^path: codbash-7\.16\.0-mac\.zip$/m);
  assert.match(out, /^releaseDate: '2026-07-24T00:00:00\.000Z'$/m);
});

test('rewriteFeedYaml is a no-op when nothing is supplied for a url', () => {
  const out = rewriteFeedYaml(SAMPLE, {});
  assert.equal(out.trim(), SAMPLE.trim());
});
