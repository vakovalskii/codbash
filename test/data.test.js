const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const data = require('../src/data');

const {
  parseWslDistroList,
  buildWslUncPath,
  normalizeProjectPath,
  shortenHomePath,
  mergeClaudeSessionDetail,
  computeCodexCostFromJsonlLines,
  mergeCodexSession,
  parseSessionIdFromCommandLine,
  parseWindowsCwdFromCommandLine,
} = data.__test;

function readFixtureLines(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').split(/\r?\n/).filter(Boolean);
}

function tokenCountLine({
  timestamp = '2026-03-11T09:13:22.441Z',
  last = {},
  total = null,
  contextWindow = 258400,
}) {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: total === null && last === null ? null : {
        total_token_usage: total,
        last_token_usage: last,
        model_context_window: contextWindow,
      },
      rate_limits: null,
    },
  });
}

test('computeCodexCostFromJsonlLines uses real token_count usage', () => {
  const line = tokenCountLine({
    last: {
      input_tokens: 1000,
      cached_input_tokens: 400,
      output_tokens: 200,
      reasoning_output_tokens: 50,
    },
    total: {
      input_tokens: 1000,
      cached_input_tokens: 400,
      output_tokens: 200,
      reasoning_output_tokens: 50,
    },
  });

  const result = computeCodexCostFromJsonlLines([line], 0);
  assert.equal(result.estimated, false);
  assert.equal(result.model, 'codex-mini-latest');
  assert.equal(result.inputTokens, 600);
  assert.equal(result.cacheReadTokens, 400);
  assert.equal(result.outputTokens, 250);
  assert.equal(result.contextTurnCount, 1);
  assert.ok(result.cost > 0);
});

test('computeCodexCostFromJsonlLines parses real new-format Codex fixture', () => {
  const lines = readFixtureLines('codex-new-format.jsonl');
  const result = computeCodexCostFromJsonlLines(lines, 0);
  assert.equal(result.estimated, false);
  assert.equal(result.model, 'codex-mini-latest');
  assert.equal(result.inputTokens, 33102);
  assert.equal(result.cacheReadTokens, 38784);
  assert.equal(result.outputTokens, 1727);
  assert.equal(result.contextTurnCount, 2);
  assert.ok(result.contextPctSum > 27 && result.contextPctSum < 28);
});

test('computeCodexCostFromJsonlLines dedupes exact duplicate token_count events', () => {
  const line = tokenCountLine({
    last: {
      input_tokens: 900,
      cached_input_tokens: 300,
      output_tokens: 100,
      reasoning_output_tokens: 25,
    },
    total: {
      input_tokens: 900,
      cached_input_tokens: 300,
      output_tokens: 100,
      reasoning_output_tokens: 25,
    },
  });

  const once = computeCodexCostFromJsonlLines([line], 0);
  const duped = computeCodexCostFromJsonlLines([line, line], 0);
  assert.deepEqual(duped, once);
});

test('computeCodexCostFromJsonlLines counts distinct events with same last usage but different totals', () => {
  const first = tokenCountLine({
    timestamp: '2026-03-11T09:13:22.441Z',
    last: {
      input_tokens: 500,
      cached_input_tokens: 100,
      output_tokens: 80,
      reasoning_output_tokens: 20,
    },
    total: {
      input_tokens: 1000,
      cached_input_tokens: 500,
      output_tokens: 80,
      reasoning_output_tokens: 20,
    },
  });
  const second = tokenCountLine({
    timestamp: '2026-03-11T09:13:22.441Z',
    last: {
      input_tokens: 500,
      cached_input_tokens: 100,
      output_tokens: 80,
      reasoning_output_tokens: 20,
    },
    total: {
      input_tokens: 1500,
      cached_input_tokens: 600,
      output_tokens: 160,
      reasoning_output_tokens: 40,
    },
  });

  const result = computeCodexCostFromJsonlLines([first, second], 0);
  assert.equal(result.inputTokens, 800);
  assert.equal(result.cacheReadTokens, 200);
  assert.equal(result.outputTokens, 200);
  assert.equal(result.contextTurnCount, 2);
});

test('computeCodexCostFromJsonlLines does not dedupe same-timestamp events when total usage is absent', () => {
  const first = tokenCountLine({
    timestamp: '2026-03-11T09:13:22.441Z',
    last: {
      input_tokens: 500,
      cached_input_tokens: 100,
      output_tokens: 80,
      reasoning_output_tokens: 20,
    },
    total: null,
  });
  const second = tokenCountLine({
    timestamp: '2026-03-11T09:13:22.441Z',
    last: {
      input_tokens: 500,
      cached_input_tokens: 100,
      output_tokens: 80,
      reasoning_output_tokens: 20,
    },
    total: null,
  });

  const result = computeCodexCostFromJsonlLines([first, second], 0);
  assert.equal(result.inputTokens, 800);
  assert.equal(result.cacheReadTokens, 200);
  assert.equal(result.outputTokens, 200);
  assert.equal(result.contextTurnCount, 2);
});

test('computeCodexCostFromJsonlLines dedupes interleaved duplicate signatures only once', () => {
  const duplicate = tokenCountLine({
    timestamp: '2026-03-11T09:13:22.441Z',
    last: {
      input_tokens: 700,
      cached_input_tokens: 200,
      output_tokens: 60,
      reasoning_output_tokens: 10,
    },
    total: {
      input_tokens: 1700,
      cached_input_tokens: 700,
      output_tokens: 60,
      reasoning_output_tokens: 10,
    },
  });
  const distinct = tokenCountLine({
    timestamp: '2026-03-11T09:13:23.111Z',
    last: {
      input_tokens: 900,
      cached_input_tokens: 400,
      output_tokens: 50,
      reasoning_output_tokens: 0,
    },
    total: {
      input_tokens: 2600,
      cached_input_tokens: 1100,
      output_tokens: 110,
      reasoning_output_tokens: 10,
    },
  });

  const result = computeCodexCostFromJsonlLines([duplicate, distinct, duplicate, duplicate], 0);
  assert.equal(result.inputTokens, 1000);
  assert.equal(result.cacheReadTokens, 600);
  assert.equal(result.outputTokens, 120);
  assert.equal(result.contextTurnCount, 2);
});

test('computeCodexCostFromJsonlLines falls back to estimate when token_count is absent', () => {
  const result = computeCodexCostFromJsonlLines([], 400);
  assert.equal(result.estimated, true);
  assert.equal(result.model, 'codex-mini-latest-estimated');
  assert.equal(result.inputTokens, 30);
  assert.equal(result.outputTokens, 70);
  assert.ok(result.cost > 0);
});

test('computeCodexCostFromJsonlLines falls back on real old-format Codex fixture without token_count', () => {
  const lines = readFixtureLines('codex-old-format.jsonl');
  const totalSize = fs.statSync(path.join(__dirname, 'fixtures', 'codex-old-format.jsonl')).size;
  const result = computeCodexCostFromJsonlLines(lines, totalSize);
  assert.equal(result.estimated, true);
  assert.equal(result.model, 'codex-mini-latest-estimated');
  assert.ok(result.cost > 0);
});

test('computeCodexCostFromJsonlLines clamps cached_input_tokens above input_tokens', () => {
  const line = tokenCountLine({
    last: {
      input_tokens: 100,
      cached_input_tokens: 150,
      output_tokens: 10,
      reasoning_output_tokens: 5,
    },
    total: {
      input_tokens: 100,
      cached_input_tokens: 150,
      output_tokens: 10,
      reasoning_output_tokens: 5,
    },
  });

  const result = computeCodexCostFromJsonlLines([line], 0);
  assert.equal(result.inputTokens, 0);
  assert.equal(result.cacheReadTokens, 150);
  assert.equal(result.outputTokens, 15);
});

test('mergeCodexSession keeps primary precedence when rank is 0', () => {
  const existing = {
    id: 'same',
    project: 'C:\\primary',
    first_message: 'primary',
    _session_file: 'primary.jsonl',
    _codex_root: 'primary-root',
    codex_source: 'primary',
    _codex_source_rank: 0,
    mcp_servers: ['a'],
    skills: ['one'],
  };
  const candidate = {
    id: 'same',
    project: 'C:\\archive',
    first_message: 'archive',
    _session_file: 'archive.jsonl',
    _codex_root: 'archive-root',
    codex_source: 'archive',
    _codex_source_rank: 1,
    mcp_servers: ['b'],
    skills: ['two'],
  };

  const merged = mergeCodexSession(existing, candidate);
  assert.equal(merged.project, 'C:\\primary');
  assert.equal(merged.first_message, 'primary');
  assert.equal(merged._session_file, 'primary.jsonl');
  assert.equal(merged.codex_source, 'primary');
  assert.equal(merged._codex_source_rank, 0);
  assert.deepEqual(merged.mcp_servers.sort(), ['a', 'b']);
  assert.deepEqual(merged.skills.sort(), ['one', 'two']);
});

test('mergeCodexSession does not replace existing session file with empty candidate file', () => {
  const existing = {
    _session_file: 'primary.jsonl',
    _codex_source_rank: 1,
    project: '',
    project_short: '',
    first_message: '',
  };
  const candidate = {
    _session_file: '',
    _codex_source_rank: 0,
    project: 'C:\\primary',
    project_short: 'C:\\primary',
    first_message: 'newer',
  };

  const merged = mergeCodexSession(existing, candidate);
  assert.equal(merged._session_file, 'primary.jsonl');
  assert.equal(merged.project, 'C:\\primary');
  assert.equal(merged.first_message, 'newer');
});

test('parseSessionIdFromCommandLine extracts resume UUID', () => {
  const cmd = 'cmd /k "cd C:\\1_Projects && codex resume 019d6dc8-03d4-72e0-8239-bda72acb65fb"';
  assert.equal(parseSessionIdFromCommandLine(cmd), '019d6dc8-03d4-72e0-8239-bda72acb65fb');
});

test('parseWindowsCwdFromCommandLine extracts cwd from cmd wrapper', () => {
  const cmd = 'cmd /k "cd C:\\1_Projects\\codedash && codex resume 019d6dc8-03d4-72e0-8239-bda72acb65fb"';
  assert.equal(parseWindowsCwdFromCommandLine(cmd), 'C:\\1_Projects\\codedash');
});

test('normalizeProjectPath strips Windows extended-length prefixes', () => {
  assert.equal(normalizeProjectPath('\\\\?\\C:\\1_Projects\\codedash'), 'C:\\1_Projects\\codedash');
  assert.equal(normalizeProjectPath('\\\\?\\UNC\\server\\share\\repo'), '\\\\server\\share\\repo');
});

test('shortenHomePath matches normalized home roots', () => {
  const value = '\\\\?\\C:\\Users\\JurijsBaranovs\\Projects\\codedash';
  const homes = ['C:\\Users\\JurijsBaranovs'];
  assert.equal(shortenHomePath(value, homes), '~\\Projects\\codedash');
});

test('shortenHomePath does not shorten sibling prefixes', () => {
  assert.equal(shortenHomePath('C:\\Users\\JurijsBaranovs2\\Projects', ['C:\\Users\\JurijsBaranovs']), 'C:\\Users\\JurijsBaranovs2\\Projects');
  assert.equal(shortenHomePath('/home/jurijs2/project', ['/home/jurijs']), '/home/jurijs2/project');
});

test('shortenHomePath shortens Windows paths against WSL-style homes', () => {
  const value = 'C:\\Users\\JurijsBaranovs\\Projects\\codedash';
  const homes = ['/mnt/c/Users/JurijsBaranovs'];
  assert.equal(shortenHomePath(value, homes), '~\\Projects\\codedash');
});

test('parseWslDistroList strips empty lines and null separators', () => {
  const raw = Buffer.from('Ubuntu-24.04\r\ndocker-desktop\r\n\r\n', 'utf16le');
  assert.deepEqual(parseWslDistroList(raw), ['Ubuntu-24.04', 'docker-desktop']);
});

test('buildWslUncPath converts linux home to UNC path', () => {
  assert.equal(buildWslUncPath('Ubuntu-24.04', '/home/dius'), '\\\\wsl$\\Ubuntu-24.04\\home\\dius');
  assert.equal(buildWslUncPath('', '/home/dius'), '');
});

test('shortenHomePath shortens linux paths against WSL UNC homes', () => {
  const value = '/home/dius/projects/codedash';
  const homes = ['\\\\wsl$\\Ubuntu-24.04\\home\\dius'];
  assert.equal(shortenHomePath(value, homes), '~/projects/codedash');
});

test('shortenHomePath shortens UNC WSL paths against UNC WSL homes', () => {
  const value = '\\\\wsl$\\Ubuntu-24.04\\home\\dius\\projects\\codedash';
  const homes = ['\\\\wsl$\\Ubuntu-24.04\\home\\dius'];
  assert.equal(shortenHomePath(value, homes), '~\\projects\\codedash');
});

test('shortenHomePath shortens root-based linux paths against UNC WSL homes', () => {
  const value = '/root/projects/codedash';
  const homes = ['\\\\wsl$\\Ubuntu-24.04\\root'];
  assert.equal(shortenHomePath(value, homes), '~/projects/codedash');
});

test('mergeClaudeSessionDetail normalizes and shortens project paths', () => {
  const session = {
    tool: 'claude',
    project: '',
    project_short: '',
  };
  const summary = {
    tool: 'claude',
    fileSize: 123,
    msgCount: 4,
    userMsgCount: 2,
    mcpServers: ['graph'],
    skills: ['review'],
    projectPath: '\\\\?\\C:\\Users\\JurijsBaranovs\\Projects\\codedash',
    worktreeOriginalCwd: '\\\\?\\C:\\Users\\JurijsBaranovs\\Projects\\codedash',
    customTitle: '',
  };

  mergeClaudeSessionDetail(session, summary, 'session.jsonl', ['C:\\Users\\JurijsBaranovs']);
  assert.equal(session.project, 'C:\\Users\\JurijsBaranovs\\Projects\\codedash');
  assert.equal(session.project_short, '~\\Projects\\codedash');
  assert.equal(session.worktree_original_cwd, 'C:\\Users\\JurijsBaranovs\\Projects\\codedash');
});
