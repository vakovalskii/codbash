const test = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../src/terminals');

test('Windows cmd launcher uses WorkingDirectory instead of nested cd quoting', () => {
  const cmd = __test.buildAgentCommand('019e2039-7e0d-7582-9116-39d0d2713e36', 'codex', [], 'resume');
  const args = __test.buildWindowsCmdStartArgs(cmd, 'C:\\projects');
  const script = args[2];

  assert.equal(cmd, 'codex resume 019e2039-7e0d-7582-9116-39d0d2713e36');
  assert.deepEqual(args.slice(0, 2), ['-NoProfile', '-Command']);
  assert.match(script, /Start-Process -FilePath 'cmd\.exe'/);
  assert.match(script, /-WorkingDirectory 'C:\\projects'/);
  assert.match(script, /-ArgumentList @\('\/k','codex resume 019e2039-7e0d-7582-9116-39d0d2713e36'\)/);
  assert.equal(script.includes('cd "C:\\projects" &&'), false);
});

test('Windows Terminal launcher passes cwd as startingDirectory', () => {
  const cmd = __test.buildAgentCommand('abc123', 'codex', [], 'resume');
  assert.deepEqual(
    __test.buildWindowsTerminalArgs(cmd, 'C:\\projects\\codbash'),
    ['new-tab', '--startingDirectory', 'C:\\projects\\codbash', 'cmd.exe', '/k', 'codex resume abc123']
  );
});

test('Windows PowerShell launcher also uses WorkingDirectory', () => {
  const cmd = __test.buildAgentCommand('abc123', 'claude', ['skip-permissions'], 'resume');
  const script = __test.buildWindowsPowerShellStartArgs(cmd, 'C:\\projects\\codbash')[2];

  assert.match(script, /Start-Process -FilePath 'powershell\.exe'/);
  assert.match(script, /-WorkingDirectory 'C:\\projects\\codbash'/);
  assert.match(script, /'-NoExit','-NoProfile','-Command','claude --resume abc123 --dangerously-skip-permissions'/);
  assert.equal(script.includes('&&'), false);
});

test('Pi launch commands use variant-specific resume syntax and quote targets', () => {
  assert.equal(__test.buildAgentCommand('', 'pi', [], 'fresh'), 'pi');
  assert.equal(__test.buildAgentCommand('pi-session-1', 'pi', [], 'resume'), "pi --session 'pi-session-1'");
  assert.equal(__test.buildAgentCommand('', 'pi', [], 'fresh', 'omp'), 'omp');
  assert.equal(__test.buildAgentCommand('safe-session-id', 'pi', [], 'resume', 'omp', "/tmp/session file's.jsonl"), "omp --resume '/tmp/session file'\\''s.jsonl'");
});
