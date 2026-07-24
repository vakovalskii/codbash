'use strict';

// CSRF defense for state-changing API calls. A browser sends `Origin` on every
// cross-origin request (and on same-origin POST/PUT/DELETE in modern engines),
// so when Origin is present it must match our own Host. Absent Origin = a
// non-browser client (curl, the desktop shell's same-origin fetch) → allowed;
// CSRF needs a browser, which always sends Origin on mutating requests.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isDisallowedCrossOrigin, checkSameOrigin } = require('../src/origin-guard.js');

const H = (origin, host) => ({ origin, host });

test('cross-origin POST (Origin host ≠ Host) is blocked', () => {
  assert.equal(isDisallowedCrossOrigin('POST', H('https://evil.example', 'localhost:8842')), true);
});

test('same-origin POST (Origin host === Host) is allowed', () => {
  assert.equal(isDisallowedCrossOrigin('POST', H('http://localhost:8842', 'localhost:8842')), false);
});

test('POST with no Origin header is allowed (non-browser client)', () => {
  assert.equal(isDisallowedCrossOrigin('POST', H(undefined, 'localhost:8842')), false);
});

test('opaque "Origin: null" mutating request is blocked', () => {
  assert.equal(isDisallowedCrossOrigin('POST', H('null', 'localhost:8842')), true);
});

test('malformed Origin on a mutating request is blocked', () => {
  assert.equal(isDisallowedCrossOrigin('DELETE', H('http://[bad', 'localhost:8842')), true);
});

test('PUT and DELETE are gated like POST', () => {
  assert.equal(isDisallowedCrossOrigin('PUT', H('https://evil.example', 'localhost:8842')), true);
  assert.equal(isDisallowedCrossOrigin('DELETE', H('https://evil.example', 'localhost:8842')), true);
});

test('GET is never gated, even cross-origin', () => {
  assert.equal(isDisallowedCrossOrigin('GET', H('https://evil.example', 'localhost:8842')), false);
});

test('IPv6 loopback host matches its own Origin', () => {
  assert.equal(isDisallowedCrossOrigin('POST', H('http://[::1]:8842', '[::1]:8842')), false);
});

test('127.0.0.1 page fetching a localhost:port host is treated as cross-origin', () => {
  // Different host token → blocked. The frontend always fetches its own origin,
  // so this only fires for a genuinely foreign page.
  assert.equal(isDisallowedCrossOrigin('POST', H('http://127.0.0.1:8842', 'localhost:8842')), true);
});

test('same-origin is allowed regardless of Host header casing', () => {
  // RFC 7230: Host is case-insensitive. A proxy that forwards "LocalHost" must
  // not trigger a false-positive 403 on a legitimate same-origin request.
  assert.equal(isDisallowedCrossOrigin('POST', H('http://localhost:8842', 'LocalHost:8842')), false);
});

test('Origin present but Host header missing is blocked (fail closed)', () => {
  assert.equal(isDisallowedCrossOrigin('POST', { origin: 'https://evil.example', host: undefined }), true);
});

test('Referer fallback: cross-site Referer (no Origin) on a mutating request is blocked', () => {
  assert.equal(isDisallowedCrossOrigin('POST', { referer: 'https://evil.example/x', host: 'localhost:8842' }), true);
});

test('Referer fallback: same-origin Referer (no Origin) is allowed', () => {
  assert.equal(isDisallowedCrossOrigin('POST', { referer: 'http://localhost:8842/', host: 'localhost:8842' }), false);
});

test('Origin takes precedence over Referer when both are present', () => {
  // A matching Origin allows even if Referer looks foreign (Origin is the
  // stronger signal); a mismatched Origin blocks even with a matching Referer.
  assert.equal(isDisallowedCrossOrigin('POST', { origin: 'http://localhost:8842', referer: 'https://evil.example/', host: 'localhost:8842' }), false);
  assert.equal(isDisallowedCrossOrigin('POST', { origin: 'https://evil.example', referer: 'http://localhost:8842/', host: 'localhost:8842' }), true);
});

test('checkSameOrigin reports a reason for logging (used by the WS upgrade)', () => {
  assert.deepEqual(checkSameOrigin({ origin: 'https://evil.example', host: 'localhost:8842' }),
    { crossOrigin: true, reason: 'origin mismatch' });
  assert.deepEqual(checkSameOrigin({ origin: 'http://[bad', host: 'localhost:8842' }),
    { crossOrigin: true, reason: 'bad origin' });
  assert.deepEqual(checkSameOrigin({ referer: 'https://evil.example/', host: 'localhost:8842' }),
    { crossOrigin: true, reason: 'referer mismatch' });
  assert.deepEqual(checkSameOrigin({ host: 'localhost:8842' }),
    { crossOrigin: false, reason: null });
});
