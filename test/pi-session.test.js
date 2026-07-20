const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const data = require('../src/data');
const {
  parsePiSessionFile,
  loadPiDetail,
  scanPiSessions,
  normalizePiUsage,
  leaderboardAgentKey,
  _piSessionDirMtimes,
  extractPiResumeTargetFromCommand,
  findPiSessionByResumeTarget,
} = data.__test;


function withEnv(env, fn) {
  const old = {};
  for (const key of Object.keys(env)) {
    old[key] = process.env[key];
    process.env[key] = env[key];
  }
  try { return fn(); }
  finally {
    for (const key of Object.keys(env)) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
}

function freshModulesWithPiDirs(home, piAgentDir, ompAgentDir) {
  const dataPath = require.resolve('../src/data');
  const handoffPath = require.resolve('../src/handoff');
  delete require.cache[handoffPath];
  delete require.cache[dataPath];
  const oldHome = os.homedir;
  os.homedir = () => home;
  return withEnv({ PI_CODING_AGENT_DIR: piAgentDir, OMP_CODING_AGENT_DIR: ompAgentDir }, () => {
    try {
      const freshData = require('../src/data');
      delete require.cache[handoffPath];
      const freshHandoff = require('../src/handoff');
      return { data: freshData, handoff: freshHandoff };
    } finally {
      os.homedir = oldHome;
    }
  });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codbash-pi-'));
}

function writeJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

test('parsePiSessionFile reads OMP header and message summary', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'sessions', '--tmp--project--', '2026-05-24T10-00-00.000Z_pi-session-1.jsonl');
  writeJsonl(file, [
    { type: 'session', version: 3, id: 'pi-session-1', timestamp: '2026-05-24T10:00:00.000Z', cwd: '/tmp/project', title: 'Fix parser' },
    { type: 'branch', timestamp: '2026-05-24T10:00:01.000Z', note: 'not a message' },
    { type: 'message', timestamp: '2026-05-24T10:00:02.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Please fix this' }] } },
    { type: 'message', timestamp: '2026-05-24T10:00:04.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'Done' }], usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 4, cost: { total: 0.001 } } } },
  ]);

  const summary = parsePiSessionFile(file);
  assert.equal(summary.sessionId, 'pi-session-1');
  assert.equal(summary.projectPath, '/tmp/project');
  assert.equal(summary.title, 'Fix parser');
  assert.equal(summary.msgCount, 2);
  assert.equal(summary.userMsgCount, 1);
  assert.equal(summary.firstMsg, 'Please fix this');
  assert.equal(summary.model, 'claude-sonnet-4-6');
  assert.equal(summary.hasUsage, true);
  assert.equal(summary.explicitCost, true);
  assert.equal(summary.firstTs, Date.parse('2026-05-24T10:00:00.000Z'));
  assert.equal(summary.lastTs, Date.parse('2026-05-24T10:00:04.000Z'));
});

test('parsePiSessionFile reads title line before OMP session header', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'sessions', '--tmp--project--', '2026-05-24T10-00-00.000Z_pi-session-title.jsonl');
  writeJsonl(file, [
    { type: 'title', title: 'brief-improve' },
    { type: 'session', version: 3, id: 'pi-session-title', timestamp: '2026-05-24T10:00:00.000Z', cwd: '/tmp/project' },
    { type: 'message', timestamp: '2026-05-24T10:00:02.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Please fix this' }] } },
  ]);

  const summary = parsePiSessionFile(file);
  assert.equal(summary.sessionId, 'pi-session-title');
  assert.equal(summary.title, 'brief-improve');
});

test('parsePiSessionFile rejects unsafe header ids', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'sessions', '--tmp--project--', 'bad.jsonl');
  writeJsonl(file, [
    { type: 'session', id: '../../claude-session', cwd: '/tmp/project', timestamp: '2026-05-24T10:00:00.000Z' },
    { type: 'message', timestamp: '2026-05-24T10:00:01.000Z', message: { role: 'user', content: 'bad id' } },
  ]);

  assert.equal(parsePiSessionFile(file), null);
});


test('loadPiDetail returns role-compatible display messages with tokens', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'sessions', '--tmp--project--', '2026_pi-session-2.jsonl');
  writeJsonl(file, [
    { type: 'session', id: 'pi-session-2', cwd: '/tmp/project', timestamp: '2026-05-24T10:00:00.000Z' },
    { type: 'message', timestamp: '2026-05-24T10:00:01.000Z', message: { role: 'user', content: 'hello' } },
    { type: 'message', timestamp: '2026-05-24T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } } },
    { type: 'message', timestamp: '2026-05-24T10:00:03.000Z', message: { role: 'tool', content: 'skip' } },
  ]);

  const detail = loadPiDetail('pi-session-2', file, { maxMessages: 10 });
  assert.equal(detail.messages.length, 2);
  assert.deepEqual(detail.messages.map(m => m.role), ['user', 'assistant']);
  assert.equal(detail.messages[0].content, 'hello');
  assert.equal(detail.messages[1].tokens.inputTokens, 1);
  assert.equal(detail.messages[1].tokens.outputTokens, 2);
  assert.equal(detail.messages[1].tokens.cacheReadTokens, 3);
  assert.equal(detail.messages[1].tokens.cacheCreateTokens, 4);
});

test('loadPiDetail starts messages after delayed OMP session header', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'sessions', '--tmp--project--', '2026_pi-session-detail-title.jsonl');
  writeJsonl(file, [
    { type: 'title', title: 'brief-improve' },
    { type: 'session', id: 'pi-session-detail-title', cwd: '/tmp/project', timestamp: '2026-05-24T10:00:00.000Z' },
    { type: 'message', timestamp: '2026-05-24T10:00:01.000Z', message: { role: 'user', content: 'hello' } },
  ]);

  const detail = loadPiDetail('pi-session-detail-title', file, { maxMessages: 10 });
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.messages[0].content, 'hello');
});

test('scanPiSessions ignores malformed and non-OMP files', () => {
  const agentDir = tmpDir();
  const valid = path.join(agentDir, 'sessions', '--tmp--project--', '2026_pi-session-3.jsonl');
  const invalid = path.join(agentDir, 'sessions', '--tmp--project--', 'bad.jsonl');
  writeJsonl(valid, [
    { type: 'session', id: 'pi-session-3', cwd: '/tmp/project', timestamp: '2026-05-24T10:00:00.000Z' },
    { type: 'message', timestamp: '2026-05-24T10:00:01.000Z', message: { role: 'user', content: 'find me' } },
  ]);
  writeJsonl(invalid, [
    { type: 'message', message: { role: 'user', content: 'not omp' } },
  ]);

  const sessions = scanPiSessions(agentDir);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'pi-session-3');
  assert.equal(sessions[0].tool, 'pi');
  assert.equal(sessions[0].project, '/tmp/project');
  assert.equal(sessions[0].first_message, 'find me');
  assert.equal(sessions[0].agent_variant, 'pi');
});

test('scanPiSessions ignores symlinked session files', () => {
  const agentDir = tmpDir();
  const outside = path.join(tmpDir(), 'outside.jsonl');
  writeJsonl(outside, [
    { type: 'session', id: 'pi-symlink', cwd: '/tmp/project', timestamp: '2026-05-24T10:00:00.000Z' },
    { type: 'message', timestamp: '2026-05-24T10:00:01.000Z', message: { role: 'user', content: 'outside' } },
  ]);
  const link = path.join(agentDir, 'sessions', '--tmp--project--', 'link.jsonl');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(outside, link);

  assert.deepEqual(scanPiSessions(agentDir), []);
});

test('scanPiSessions marks OhMyPi variant when scanning omp directory', () => {
  const agentDir = tmpDir();
  const file = path.join(agentDir, 'sessions', '--tmp--project--', '2026_omp-session-1.jsonl');
  writeJsonl(file, [
    { type: 'session', id: 'omp-session-1', cwd: '/tmp/project', timestamp: '2026-05-24T10:00:00.000Z' },
    { type: 'message', timestamp: '2026-05-24T10:00:01.000Z', message: { role: 'user', content: 'hello omp' } },
  ]);

  const sessions = scanPiSessions(agentDir, 'ohmypi');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].tool, 'pi');
  assert.equal(sessions[0].agent_variant, 'ohmypi');
  assert.equal(sessions[0].first_message, 'hello omp');
});

test('scanPiSessions finds canonical nested OMP session directories and exposes resume path', () => {
  const agentDir = tmpDir();
  const file = path.join(agentDir, 'sessions', '-tmp-project', 'nested', '2026_nested-session.jsonl');
  writeJsonl(file, [
    { type: 'session', id: 'nested-session', cwd: '/tmp/project', timestamp: '2026-05-24T10:00:00.000Z' },
    { type: 'message', timestamp: '2026-05-24T10:00:01.000Z', message: { role: 'user', content: 'hello nested' } },
  ]);

  const sessions = scanPiSessions(agentDir, 'ohmypi');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'nested-session');
  assert.equal(sessions[0].resume_target, file);
});

test('Pi mtime fingerprint includes nested session files', () => {
  const agentDir = tmpDir();
  const file = path.join(agentDir, 'sessions', '-tmp-project', 'nested', 'deeper', '2026_nested-cache.jsonl');
  writeJsonl(file, [
    { type: 'session', id: 'nested-cache', cwd: '/tmp/project', timestamp: '2026-05-24T10:00:00.000Z' },
  ]);

  const mtimes = _piSessionDirMtimes([agentDir]);
  assert.ok(Object.prototype.hasOwnProperty.call(mtimes, file));
  assert.match(String(mtimes[file]), /^\d+(\.\d+)?:\d+$/);
});

test('active Pi command parsing maps quoted resume path back to session id', () => {
  const resumeTarget = "/tmp/project with spaces/session'one.jsonl";
  const ompCmd = "omp --resume '/tmp/project with spaces/session'\\''one.jsonl'";
  const piCmd = "pi --session '/tmp/project with spaces/session'\\''one.jsonl'";
  assert.equal(extractPiResumeTargetFromCommand(ompCmd), resumeTarget);
  assert.equal(extractPiResumeTargetFromCommand(piCmd), resumeTarget);

  const session = findPiSessionByResumeTarget(resumeTarget, [
    { id: 'pi-session-quoted', tool: 'pi', resume_target: resumeTarget },
  ]);
  assert.equal(session.id, 'pi-session-quoted');
});

test('normalizePiUsage maps OMP token and cost fields', () => {
  assert.deepEqual(normalizePiUsage({ input: 5, output: 7, cacheRead: 11, cacheWrite: 13, cost: { total: 0.42 } }), {
    inputTokens: 5,
    outputTokens: 7,
    cacheReadTokens: 11,
    cacheCreateTokens: 13,
    totalTokens: 36,
    cost: 0.42,
  });
  assert.equal(normalizePiUsage({}), null);
});

test('leaderboardAgentKey splits Pi and OhMyPi instead of aggregating them', () => {
  assert.equal(leaderboardAgentKey({ tool: 'pi', agent_variant: 'pi' }), 'pi');
  assert.equal(leaderboardAgentKey({ tool: 'pi', agent_variant: 'ohmypi' }), 'ohmypi');
  assert.equal(leaderboardAgentKey({ tool: 'pi' }), 'pi');
  assert.equal(leaderboardAgentKey({ tool: 'codex' }), 'codex');
});

test('Pi sessions support preview, replay, markdown export, handoff, analytics, and leaderboard stats', () => {
  const home = tmpDir();
  const piAgentDir = path.join(home, '.pi', 'agent');
  const ompAgentDir = path.join(home, '.omp', 'agent');
  const project = path.join(home, 'pi-project');
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(piAgentDir, 'sessions', 'pi-project', '2026_pi-parity.jsonl');
  writeJsonl(file, [
    { type: 'session', id: 'pi-parity', cwd: project, timestamp: '2026-05-24T10:00:00.000Z', title: 'Pi parity' },
    { type: 'message', timestamp: '2026-05-24T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Need parity coverage' }] } },
    { type: 'message', timestamp: '2026-05-24T10:00:02.000Z', message: { role: 'assistant', model: 'pi-model', content: [{ type: 'text', text: 'Parity coverage complete' }], usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 4, cost: { total: 0.25 } } } },
  ]);

  const { data: freshData, handoff } = freshModulesWithPiDirs(home, piAgentDir, ompAgentDir);
  const sessions = freshData.loadSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'pi-parity');
  assert.equal(sessions[0].resume_target, file);

  const preview = freshData.getSessionPreview('pi-parity', project, 10);
  assert.deepEqual(preview.map(m => m.content), ['Need parity coverage', 'Parity coverage complete']);

  const replay = freshData.getSessionReplay('pi-parity', project);
  assert.deepEqual(replay.messages.map(m => m.content), ['Need parity coverage', 'Parity coverage complete']);

  const md = freshData.exportSessionMarkdown('pi-parity', project);
  assert.match(md, /Need parity coverage/);
  assert.match(md, /Parity coverage complete/);

  const handoffDoc = handoff.generateHandoff('pi-parity', project, { verbosity: 'full' });
  assert.equal(handoffDoc.ok, true);
  assert.match(handoffDoc.markdown, /Need parity coverage/);
  assert.match(handoffDoc.markdown, /Parity coverage complete/);

  const analytics = freshData.getCostAnalytics(sessions);
  assert.equal(analytics.byAgent.pi.sessions, 1);
  assert.equal(analytics.byAgent.pi.cost, 0.25);

  const stats = freshData.getLeaderboardStats();
  assert.equal(stats.agents.pi, 1);
});

test('Oh My Pi sessions have separate leaderboard stats while sharing Pi analytics coverage', () => {
  const home = tmpDir();
  const piAgentDir = path.join(home, '.pi', 'agent');
  const ompAgentDir = path.join(home, '.omp', 'agent');
  const project = path.join(home, 'omp-project');
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(ompAgentDir, 'sessions', 'omp-project', 'nested', '2026_omp-parity.jsonl');
  writeJsonl(file, [
    { type: 'session', id: 'omp-parity', cwd: project, timestamp: '2026-05-24T10:05:00.000Z', title: 'Oh My Pi parity' },
    { type: 'message', timestamp: '2026-05-24T10:05:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Need Oh My Pi coverage' }] } },
    { type: 'message', timestamp: '2026-05-24T10:05:02.000Z', message: { role: 'assistant', model: 'omp-model', content: [{ type: 'text', text: 'Oh My Pi coverage complete' }], usage: { input: 30, output: 40, cacheRead: 5, cacheWrite: 6, cost: { total: 0.75 } } } },
  ]);

  const { data: freshData } = freshModulesWithPiDirs(home, piAgentDir, ompAgentDir);
  const sessions = freshData.loadSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].agent_variant, 'ohmypi');
  assert.equal(sessions[0].resume_target, file);

  const analytics = freshData.getCostAnalytics(sessions);
  assert.equal(analytics.byAgent.pi.sessions, 1);
  assert.equal(analytics.byAgent.pi.cost, 0.75);

  const stats = freshData.getLeaderboardStats();
  assert.equal(stats.agents.ohmypi, 1);
  assert.equal(stats.agents.pi, undefined);
});
