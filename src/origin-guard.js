'use strict';

// Shared same-origin / CSRF logic used by BOTH the HTTP API (server.js) and the
// browser-terminal WebSocket upgrade (terminal.js), so the two can never drift.
//
// A browser attaches `Origin` to cross-origin requests — and to same-origin
// POST/PUT/DELETE in modern engines — so when it is present it must match the
// host we are serving from. `Referer` is a fallback for the rare client/proxy
// that strips `Origin` but keeps `Referer` (OWASP CSRF cheat sheet). Absent
// BOTH headers = a non-browser client (curl, scripts, the desktop shell's
// same-origin fetch) → allowed; a browser CSRF attack always carries at least
// one of the two on a mutating cross-site request. Comparison is host+port only
// (scheme intentionally ignored — codbash serves plain HTTP on loopback/LAN),
// case-normalized because RFC 7230 makes Host case-insensitive.

function _hostOf(value) {
  try { return new URL(value).host.toLowerCase(); } catch (_e) { return null; }
}

// Classify a request by its Origin/Referer vs Host. Returns
// { crossOrigin: boolean, reason: string|null }. `reason` is set only when
// crossOrigin is true, for logging: 'bad origin' | 'origin mismatch' |
// 'bad referer' | 'referer mismatch'.
function checkSameOrigin(headers) {
  const host = String((headers && headers.host) || '').toLowerCase();
  const origin = headers && headers.origin;
  if (origin) {
    const h = _hostOf(origin);
    if (h === null) return { crossOrigin: true, reason: 'bad origin' };
    return h === host ? { crossOrigin: false, reason: null }
                      : { crossOrigin: true, reason: 'origin mismatch' };
  }
  const referer = headers && headers.referer;
  if (referer) {
    const h = _hostOf(referer);
    if (h === null) return { crossOrigin: true, reason: 'bad referer' };
    return h === host ? { crossOrigin: false, reason: null }
                      : { crossOrigin: true, reason: 'referer mismatch' };
  }
  return { crossOrigin: false, reason: null };
}

// HTTP CSRF gate: only state-changing methods are relevant. Returns true when
// the request must be rejected (403).
function isDisallowedCrossOrigin(method, headers) {
  if (method !== 'POST' && method !== 'PUT' && method !== 'DELETE') return false;
  return checkSameOrigin(headers).crossOrigin;
}

module.exports = { checkSameOrigin, isDisallowedCrossOrigin };
