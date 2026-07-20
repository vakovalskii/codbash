// Tests for src/terminal.js — the WebSocket frame codec and token comparison.
// These are pure functions (no pty / no sockets), safe to run anywhere.
// Run with `node --test test/terminal.test.js`.

const test = require('node:test');
const assert = require('node:assert/strict');
const terminal = require('../src/terminal');

// Build a client-style (masked) frame the way a browser would send it.
function maskedFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  }
  header[0] = 0x80 | opcode;
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

test('encodeFrame sets FIN + opcode and a small length', () => {
  const frame = terminal.encodeFrame(Buffer.from('hi'), 0x1);
  assert.equal(frame[0], 0x81);      // FIN + text
  assert.equal(frame[1], 2);         // unmasked, len 2
  assert.equal(frame.slice(2).toString(), 'hi');
});

test('encodeFrame uses 16-bit extended length for payloads >= 126', () => {
  const payload = Buffer.alloc(1000, 0x41);
  const frame = terminal.encodeFrame(payload, 0x2);
  assert.equal(frame[0], 0x82);      // FIN + binary
  assert.equal(frame[1], 126);
  assert.equal(frame.readUInt16BE(2), 1000);
  assert.equal(frame.length, 4 + 1000);
});

test('decoder unmasks a client frame and yields opcode + payload', () => {
  const frames = [];
  const feed = terminal.createFrameDecoder((op, p) => frames.push([op, p.toString()]));
  feed(maskedFrame(Buffer.from('ls -la'), 0x2));
  assert.deepEqual(frames, [[0x2, 'ls -la']]);
});

test('decoder reassembles a frame split across multiple chunks', () => {
  const frames = [];
  const feed = terminal.createFrameDecoder((op, p) => frames.push(p.toString()));
  const full = maskedFrame(Buffer.from('hello world'), 0x2);
  feed(full.slice(0, 3));
  assert.deepEqual(frames, []);      // nothing complete yet
  feed(full.slice(3, 8));
  assert.deepEqual(frames, []);
  feed(full.slice(8));
  assert.deepEqual(frames, ['hello world']);
});

test('decoder parses several frames delivered in one chunk', () => {
  const frames = [];
  const feed = terminal.createFrameDecoder((op, p) => frames.push(p.toString()));
  const a = maskedFrame(Buffer.from('aaa'), 0x2);
  const b = maskedFrame(Buffer.from('bbb'), 0x1);
  feed(Buffer.concat([a, b]));
  assert.deepEqual(frames, ['aaa', 'bbb']);
});

test('encodeFrame -> decoder round-trips an unmasked (server-style) frame', () => {
  const frames = [];
  const feed = terminal.createFrameDecoder((op, p) => frames.push([op, p.toString()]));
  feed(terminal.encodeFrame(Buffer.from('output bytes'), 0x2));
  assert.deepEqual(frames, [[0x2, 'output bytes']]);
});

test('tokensMatch is true only for identical strings', () => {
  assert.equal(terminal.tokensMatch('abc123', 'abc123'), true);
  assert.equal(terminal.tokensMatch('abc123', 'abc124'), false);
  assert.equal(terminal.tokensMatch('abc', 'abcd'), false);
  assert.equal(terminal.tokensMatch('', ''), true);
  assert.equal(terminal.tokensMatch(null, 'x'), false);
  assert.equal(terminal.tokensMatch(undefined, undefined), false);
});

test('getToken returns a stable 64-char hex token', () => {
  const t1 = terminal.getToken();
  const t2 = terminal.getToken();
  assert.equal(t1, t2);
  assert.match(t1, /^[0-9a-f]{64}$/);
});
