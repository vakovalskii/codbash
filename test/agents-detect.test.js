// Tests for src/agents-detect.js — PATH probing + macOS .app bundle fallback.
//
// Strategy: pass an injected detector context so we can fake fs/exec without
// monkey-patching the real OS. The module exports a pure `detect(ctx)` helper
// alongside the cached real-OS variant.
const test = require('node:test');
const assert = require('node:assert/strict');

function loadFresh() {
  delete require.cache[require.resolve('../src/agents-detect')];
  return require('../src/agents-detect');
}

// Default stub for custom detectors so tests don't probe the real filesystem.
const NO_CUSTOM = { ghCopilotExtension: () => null, vscodeCopilotChatExtension: () => null, piPath: () => null };

test('detect picks up an agent found on PATH', async () => {
  const { detect } = loadFresh();
  const got = await detect({
    platform: 'darwin',
    which: (bin) => bin === 'claude' ? '/usr/local/bin/claude' : null,
    appBundleExists: () => false,
    customChecks: NO_CUSTOM,
  });
  const claude = got.agents.find(a => a.id === 'claude');
  assert.ok(claude, 'claude should be detected');
  assert.equal(claude.detectedVia, 'path');
  assert.equal(claude.binPath, '/usr/local/bin/claude');
});

test('detect falls back to macOS app bundle when CLI is missing', async () => {
  const { detect } = loadFresh();
  const got = await detect({
    platform: 'darwin',
    which: () => null,
    appBundleExists: (name) => name === 'Cursor.app',
    customChecks: NO_CUSTOM,
  });
  const cursor = got.agents.find(a => a.id === 'cursor');
  assert.ok(cursor, 'cursor should be detected via app bundle');
  assert.equal(cursor.detectedVia, 'app-bundle');
});

test('detect ignores app-bundle lookup on non-darwin', async () => {
  const { detect } = loadFresh();
  const got = await detect({
    platform: 'linux',
    which: () => null,
    appBundleExists: () => true, // would-be hit, must be ignored
    customChecks: NO_CUSTOM,
  });
  assert.equal(got.agents.length, 0);
});

test('detect prefers PATH binary over app bundle for the same agent', async () => {
  const { detect } = loadFresh();
  const got = await detect({
    platform: 'darwin',
    which: (bin) => bin === 'cursor-agent' ? '/opt/homebrew/bin/cursor-agent' : null,
    appBundleExists: () => true,
    customChecks: NO_CUSTOM,
  });
  const cursor = got.agents.find(a => a.id === 'cursor');
  assert.ok(cursor);
  assert.equal(cursor.detectedVia, 'path', 'PATH should win over app-bundle');
});

test('detect uses customCheck only when PATH and app-bundle miss', async () => {
  const { detect } = loadFresh();
  const got = await detect({
    platform: 'linux',
    which: () => null,
    appBundleExists: () => false,
    customChecks: {
      ghCopilotExtension: () => ({ ok: true, detectedVia: 'gh-extension' }),
      vscodeCopilotChatExtension: () => null,
    },
  });
  const copilot = got.agents.find(a => a.id === 'copilot');
  assert.ok(copilot, 'copilot should be detected via gh extension');
  assert.equal(copilot.detectedVia, 'gh-extension');
  const chat = got.agents.find(a => a.id === 'copilot-chat');
  assert.equal(chat, undefined, 'copilot-chat should NOT be detected when extension is missing');
});

test('detect prefers pi and falls back to omp for Pi', async () => {
  const { detect } = loadFresh();
  const pi = await detect({
    platform: 'linux',
    which: (bin) => bin === 'pi' ? '/usr/local/bin/pi' : (bin === 'omp' ? '/usr/local/bin/omp' : null),
    appBundleExists: () => false,
  });
  const detectedPi = pi.agents.find(a => a.id === 'pi');
  assert.ok(detectedPi, 'Pi should be detected when pi exists');
  assert.equal(detectedPi.detectedVia, 'path');
  assert.equal(detectedPi.binPath, '/usr/local/bin/pi');
  assert.equal(detectedPi.command, 'pi');
  assert.deepEqual(detectedPi.commands, ['pi', 'omp']);

  const fallback = await detect({
    platform: 'linux',
    which: (bin) => bin === 'omp' ? '/usr/local/bin/omp' : null,
    appBundleExists: () => false,
  });
  const fallbackPi = fallback.agents.find(a => a.id === 'pi');
  assert.ok(fallbackPi, 'Pi should be detected by omp fallback binary');
  assert.equal(fallbackPi.binPath, '/usr/local/bin/omp');
  assert.equal(fallbackPi.command, 'omp');
  assert.deepEqual(fallbackPi.commands, ['omp']);
});

test('detect labels each agent with a human-readable string', async () => {
  const { detect } = loadFresh();
  const got = await detect({
    platform: 'darwin',
    which: (bin) => '/usr/bin/' + bin,
    appBundleExists: () => false,
    customChecks: Object.assign({}, NO_CUSTOM, { piPath: ({ which }) => ({ ok: true, detectedVia: 'path', binPath: which('pi'), command: 'pi', commands: ['pi', 'omp'] }) }),
  });
  // All 7 agents from terminals.js plus the synthetic copilot-chat alias.
  const ids = got.agents.map(a => a.id).sort();
  assert.ok(ids.includes('claude'));
  assert.ok(ids.includes('codex'));
  assert.ok(ids.includes('cursor'));
  assert.ok(ids.includes('qwen'));
  assert.ok(ids.includes('pi'));
  assert.ok(ids.includes('kilo'));
  assert.ok(ids.includes('kiro'));
  assert.ok(ids.includes('opencode'));
  for (const a of got.agents) {
    assert.ok(typeof a.label === 'string' && a.label.length > 0, 'missing label for ' + a.id);
  }
});

test('detect.refreshedAt is an ISO timestamp', async () => {
  const { detect } = loadFresh();
  const got = await detect({
    platform: 'linux',
    which: () => null,
    appBundleExists: () => false,
    customChecks: NO_CUSTOM,
  });
  assert.match(got.refreshedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('detect response never contains a "token" or "repoToken" field', async () => {
  const { detect } = loadFresh();
  const got = await detect({
    platform: 'darwin',
    which: () => '/usr/local/bin/claude',
    appBundleExists: () => false,
    customChecks: NO_CUSTOM,
  });
  const json = JSON.stringify(got);
  assert.equal(json.includes('token'), false, 'response must not leak token field');
  assert.equal(json.includes('repoToken'), false, 'response must not leak repoToken field');
  assert.equal(json.includes('gho_'), false, 'response must not contain GitHub token prefix');
});
