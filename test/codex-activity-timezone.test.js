// Must be set before loading src/data so local-day helpers use this timezone.
process.env.TZ = 'Europe/Moscow';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const data = require('../src/data');

function mkTmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeJsonl(file, entries) {
  fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
}

function codexUser(timestamp, text) {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  };
}

function codexUserEntry(fields, text) {
  return Object.assign({
    type: 'response_item',
    payload: {
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  }, fields);
}

test('parseCodexSessionFile uses embedded timestamps instead of file mtime', () => {
  const tmp = mkTmp('codbash-codex-');
  try {
    const file = path.join(tmp, 'rollout-2026-02-10T10-00-00-000Z-11111111-1111-1111-1111-111111111111.jsonl');
    writeJsonl(file, [
      { type: 'session_meta', payload: { cwd: tmp } },
      codexUser('2026-02-10T10:00:00.000Z', 'first prompt'),
      {
        ts: Date.parse('2026-02-10T12:30:00.000Z') / 1000,
        type: 'response_item',
        payload: { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      },
    ]);
    fs.utimesSync(file, new Date('2026-04-15T00:00:00.000Z'), new Date('2026-04-15T00:00:00.000Z'));

    const summary = data.__test.parseCodexSessionFile(file);
    assert.equal(summary.firstTs, Date.parse('2026-02-10T10:00:00.000Z'));
    assert.equal(summary.lastTs, Date.parse('2026-02-10T12:30:00.000Z'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('parseCodexSessionFile falls back from invalid timestamp to valid ts', () => {
  const tmp = mkTmp('codbash-codex-');
  try {
    const file = path.join(tmp, 'rollout-2026-02-10T10-00-00-000Z-33333333-3333-3333-3333-333333333333.jsonl');
    writeJsonl(file, [
      codexUserEntry({ timestamp: 'not-a-date', ts: Date.parse('2026-02-10T11:00:00.000Z') / 1000 }, 'prompt'),
      codexUserEntry({ timestamp: 0, ts: Date.parse('2026-02-10T12:00:00.000Z') / 1000 }, 'next prompt'),
    ]);
    fs.utimesSync(file, new Date('2026-04-15T00:00:00.000Z'), new Date('2026-04-15T00:00:00.000Z'));

    const summary = data.__test.parseCodexSessionFile(file);
    assert.equal(summary.firstTs, Date.parse('2026-02-10T11:00:00.000Z'));
    assert.equal(summary.lastTs, Date.parse('2026-02-10T12:00:00.000Z'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Codex daily breakdown uses each user entry timestamp and local day', () => {
  const tmp = mkTmp('codbash-codex-');
  try {
    const file = path.join(tmp, 'rollout-2026-05-15T00-00-00-000Z-22222222-2222-2222-2222-222222222222.jsonl');
    writeJsonl(file, [
      codexUser('2026-05-14T21:30:00.000Z', 'local May 15 prompt'),
      codexUser('2026-05-15T10:00:00.000Z', 'same local day prompt'),
      codexUserEntry({ timestamp: 'not-a-date', ts: Date.parse('2026-05-15T22:30:00.000Z') / 1000 }, 'local May 16 prompt'),
    ]);

    const breakdown = data.__test._computeSessionDailyBreakdown(
      {
        first_ts: Date.parse('2026-05-16T20:00:00.000Z'),
        last_ts: Date.parse('2026-05-16T20:00:00.000Z'),
        date: '2026-05-16',
      },
      { format: 'codex', file },
    );

    assert.equal(breakdown.msgsByDay['2026-05-15'], 2);
    assert.equal(breakdown.msgsByDay['2026-05-16'], 1);
    assert.equal(breakdown.msgsByDay['2026-05-17'], undefined);
    assert.equal(breakdown.tsByDay['2026-05-15'].first, Date.parse('2026-05-14T21:30:00.000Z'));
    assert.equal(breakdown.tsByDay['2026-05-15'].last, Date.parse('2026-05-15T10:00:00.000Z'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Codex daily breakdown never stores NaN timestamps', () => {
  const tmp = mkTmp('codbash-codex-');
  try {
    const file = path.join(tmp, 'rollout-2026-05-15T00-00-00-000Z-44444444-4444-4444-4444-444444444444.jsonl');
    writeJsonl(file, [
      codexUserEntry({ timestamp: 'not-a-date' }, 'count me without a timestamp'),
    ]);

    const breakdown = data.__test._computeSessionDailyBreakdown(
      {
        first_ts: 0,
        last_ts: NaN,
        date: '2026-05-15',
      },
      { format: 'codex', file },
    );

    assert.equal(breakdown.msgsByDay['2026-05-15'], 1);
    assert.equal(breakdown.tsByDay['2026-05-15'], undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('local day helpers do not use UTC date slicing for Moscow boundary', () => {
  const ts = Date.parse('2026-05-23T21:30:00.000Z');
  assert.equal(new Date(ts).toISOString().slice(0, 10), '2026-05-23');
  assert.equal(data.__test.fmtLocalDay(ts), '2026-05-24');
  assert.equal(data.__test.getLocalTimezone(), 'Europe/Moscow');
  assert.equal(data.__test.getUtcOffsetMinutes(Date.parse('2026-05-24T00:00:00.000Z')), 180);
});

test('current streak walks local calendar days', () => {
  const daily = [
    { date: '2026-05-24' },
    { date: '2026-05-23' },
    { date: '2026-05-22' },
    { date: '2026-05-20' },
  ];

  assert.equal(data.__test.computeCurrentStreak(daily, '2026-05-24'), 3);
});

test('cost analytics keeps malformed session dates out of date buckets and ranges', () => {
  const sessions = [{
    id: 'bad-date-cursor',
    tool: 'cursor',
    project: '/tmp/bad-date-project',
    date: '2026-99-99',
    first_ts: Date.parse('2026-05-24T10:00:00.000Z'),
    last_ts: Date.parse('2026-05-24T10:30:00.000Z'),
    messages: 2,
    _cursor_input_tokens: 1000,
    _cursor_output_tokens: 500,
    _cursor_model: 'claude-sonnet-4-6',
  }];

  const analytics = data.getCostAnalytics(sessions);
  assert.equal(analytics.firstDate, null);
  assert.equal(analytics.lastDate, null);
  assert.equal(analytics.days, 1);
  assert.equal(analytics.todayCost, 0);
  assert.deepEqual(Object.keys(analytics.byWeek), []);
  assert.equal(analytics.byDay.unknown.sessions, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(analytics.byDay, '2026-99-99'), false);
  assert.equal(analytics.topSessions[0].date, '');
});
