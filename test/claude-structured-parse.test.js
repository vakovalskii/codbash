const test = require('node:test');
const assert = require('node:assert/strict');

const data = require('../src/data');

const {
  parseClaudeStructuredMessage,
  parseClaudeTaskNotification,
  parseStructuredMessage,
  isFilteredClaudeStructuredMessage,
} = data.__test;

test('parses each Claude structured message type happy path', () => {
  assert.deepEqual(
    parseClaudeStructuredMessage({}, '<command-name>/review</command-name><command-message>Run checks</command-message><command-args>--full</command-args>'),
    {
      agent: 'claude',
      kind: 'slash_command',
      fields: {
        command_name: '/review',
        command_message: 'Run checks',
        command_args: '--full',
      },
    }
  );

  assert.deepEqual(
    parseClaudeStructuredMessage({}, '<bash-input>npm test</bash-input>'),
    {
      agent: 'claude',
      kind: 'bash_input',
      fields: {
        input: 'npm test',
      },
    }
  );

  assert.deepEqual(
    parseClaudeStructuredMessage({}, '<bash-stdout>ok</bash-stdout><bash-stderr>warn</bash-stderr>'),
    {
      agent: 'claude',
      kind: 'bash_result',
      fields: {
        stdout: 'ok',
        stderr: 'warn',
      },
    }
  );

  assert.deepEqual(
    parseClaudeStructuredMessage({}, '<local-command-stdout>command output</local-command-stdout>'),
    {
      agent: 'claude',
      kind: 'local_command_stdout',
      fields: {
        output: 'command output',
      },
    }
  );

  assert.deepEqual(
    parseClaudeStructuredMessage({}, [
      '<task-notification>',
      '<task-id>task-1</task-id>',
      '<tool-use-id>tool-1</tool-use-id>',
      '<output-file>/tmp/out.txt</output-file>',
      '<status>completed</status>',
      '<summary>Done</summary>',
      '<result>Wrote file</result>',
      '<usage><total_tokens>42</total_tokens><tool_uses>1</tool_uses><duration_ms>99</duration_ms></usage>',
      '</task-notification>',
    ].join('')),
    {
      agent: 'claude',
      kind: 'task_notification',
      fields: {
        task_id: 'task-1',
        tool_use_id: 'tool-1',
        output_file: '/tmp/out.txt',
        status: 'completed',
        summary: 'Done',
        result: 'Wrote file',
        usage: {
          total_tokens: '42',
          tool_uses: '1',
          duration_ms: '99',
        },
      },
    }
  );
});

test('missing required field returns null', () => {
  assert.equal(
    parseStructuredMessage('claude', 'user', '<command-name>/review</command-name>', {}),
    null
  );
});

test('optional fields can be absent without failing parse', () => {
  assert.deepEqual(
    parseClaudeStructuredMessage({}, '<command-name>/review</command-name><command-message>Run checks</command-message>'),
    {
      agent: 'claude',
      kind: 'slash_command',
      fields: {
        command_name: '/review',
        command_message: 'Run checks',
        command_args: '',
      },
    }
  );

  assert.deepEqual(
    parseClaudeTaskNotification([
      '<task-notification>',
      '<task-id>task-1</task-id>',
      '<tool-use-id>tool-1</tool-use-id>',
      '<output-file>/tmp/out.txt</output-file>',
      '<status>completed</status>',
      '<summary>Done</summary>',
      '</task-notification>',
    ].join('')),
    {
      agent: 'claude',
      kind: 'task_notification',
      fields: {
        task_id: 'task-1',
        tool_use_id: 'tool-1',
        output_file: '/tmp/out.txt',
        status: 'completed',
        summary: 'Done',
        result: '',
        usage: '',
      },
    }
  );
});

test('malformed wrapper returns null', () => {
  assert.equal(parseClaudeStructuredMessage({}, '<bash-input>npm test'), null);
});

test('task notification keeps parsed fields when nested usage is malformed', () => {
  assert.deepEqual(
    parseClaudeTaskNotification([
      '<task-notification>',
      '<task-id>task-1</task-id>',
      '<tool-use-id>tool-1</tool-use-id>',
      '<output-file>/tmp/out.txt</output-file>',
      '<status>ok" onmouseover="alert(1)</status>',
      '<summary>Done</summary>',
      '<usage><total_tokens>42</total_tokens><broken></usage>',
      '</task-notification>',
    ].join('')),
    {
      agent: 'claude',
      kind: 'task_notification',
      fields: {
        task_id: 'task-1',
        tool_use_id: 'tool-1',
        output_file: '/tmp/out.txt',
        status: 'ok" onmouseover="alert(1)',
        summary: 'Done',
        result: '',
        usage: null,
      },
    }
  );
});

test('filtered Claude structured messages are matched through the shared tag set', () => {
  assert.equal(
    isFilteredClaudeStructuredMessage('<local-command-caveat>Heads up</local-command-caveat>'),
    true
  );
  assert.equal(
    isFilteredClaudeStructuredMessage('<bash-input>npm test</bash-input>'),
    false
  );
});
