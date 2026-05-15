'use strict';

// HTTP routes for repo-refresh under /api/repo-refresh/*.
//
// Exposes a single dispatcher: handleRepoRefreshRoute(req, res, { manager, getKnownGitRoots })
//   returns true if the request matched a known route (and was responded to),
//   false otherwise so the caller can fall through to other routes.

const MAX_WAIT_MS = 10_000;
const MAX_BODY_BYTES = 1 << 20; // 1 MiB — settings payloads are tiny; reject anything larger

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req, cb) {
  let buf = '';
  let aborted = false;
  function safeCb(err, val) {
    if (aborted) return;
    aborted = true; // exactly-once
    cb(err, val);
  }
  req.on('data', (chunk) => {
    if (aborted) return;
    buf += chunk;
    if (buf.length > MAX_BODY_BYTES) {
      try { req.destroy(); } catch {}
      safeCb(new Error('payload_too_large'));
    }
  });
  req.on('end', () => {
    if (aborted) return;
    if (!buf) return safeCb(null, {});
    try { safeCb(null, JSON.parse(buf)); }
    catch { safeCb(new Error('invalid_payload')); }
  });
  req.on('error', (err) => safeCb(err));
}

// Wrap an async handler so any throw lands in a 500 response instead of an
// unhandled-rejection log line. Returns a non-async function suitable for the
// `readJsonBody` callback contract.
function asyncHandler(res, handler) {
  return (err, body) => {
    Promise.resolve()
      .then(() => handler(err, body))
      .catch((e) => {
        try {
          // eslint-disable-next-line no-console
          console.error('[repo-refresh] handler threw:', e && e.stack || e);
        } catch {}
        // If we already responded, the socket is closed — don't double-send.
        if (!res.writableEnded) {
          try { sendJson(res, 500, { error: 'internal_error', code: 'internal_error' }); } catch {}
        }
      });
  };
}

function validateSettingsInput(input, knownGitRoots) {
  if (!input || typeof input !== 'object') return 'invalid_payload';
  if ('refreshOnStartup' in input && typeof input.refreshOnStartup !== 'boolean') {
    return 'invalid_payload';
  }
  if ('perProject' in input) {
    if (!input.perProject || typeof input.perProject !== 'object') return 'invalid_payload';
    for (const [k, v] of Object.entries(input.perProject)) {
      if (!knownGitRoots.has(k)) return 'invalid_payload';
      if (!v || typeof v !== 'object' || typeof v.autoRefreshOnNewChat !== 'boolean') {
        return 'invalid_payload';
      }
    }
  }
  return null;
}

function handleRepoRefreshRoute(req, res, deps) {
  if (!req.url) return false;
  // Strip query string for simple prefix matching.
  const queryIdx = req.url.indexOf('?');
  const pathname = queryIdx === -1 ? req.url : req.url.slice(0, queryIdx);
  if (!pathname.startsWith('/api/repo-refresh/')) return false;

  const { manager, getKnownGitRoots } = deps;

  // ── GET /state ────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/repo-refresh/state') {
    sendJson(res, 200, manager.getState());
    return true;
  }

  // ── GET /settings ─────────────────────────────
  if (req.method === 'GET' && pathname === '/api/repo-refresh/settings') {
    sendJson(res, 200, manager.getState().settings);
    return true;
  }

  // ── POST /trigger ─────────────────────────────
  if (req.method === 'POST' && pathname === '/api/repo-refresh/trigger') {
    readJsonBody(req, asyncHandler(res, (err, body) => {
      if (err) return sendJson(res, 400, { error: err.message, code: 'invalid_payload' });
      const gitRoot = body && body.gitRoot;
      if (typeof gitRoot !== 'string' || !gitRoot) {
        return sendJson(res, 400, { error: 'gitRoot is required', code: 'invalid_payload' });
      }
      const known = getKnownGitRoots();
      if (!known.has(gitRoot)) {
        return sendJson(res, 404, { error: 'unknown gitRoot', code: 'not_found' });
      }
      // Fire and forget on the backend — return immediately with current state.
      manager.triggerRefresh(gitRoot).catch(() => {});
      const state = manager.getState().repos[gitRoot];
      sendJson(res, 200, { status: state ? state.status : 'fetching', state });
    }));
    return true;
  }

  // ── POST /wait ────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/repo-refresh/wait') {
    readJsonBody(req, asyncHandler(res, async (err, body) => {
      if (err) return sendJson(res, 400, { error: err.message, code: 'invalid_payload' });
      const gitRoot = body && body.gitRoot;
      if (typeof gitRoot !== 'string' || !gitRoot) {
        return sendJson(res, 400, { error: 'gitRoot is required', code: 'invalid_payload' });
      }
      // Same known-roots gate as /trigger: prevents timing-side-channel
      // enumeration of unknown paths and refuses to long-poll on arbitrary
      // strings.
      const known = getKnownGitRoots();
      if (!known.has(gitRoot)) {
        return sendJson(res, 404, { error: 'unknown gitRoot', code: 'not_found' });
      }
      const requested = Number(body && body.timeoutMs);
      const timeoutMs = Number.isFinite(requested) && requested > 0
        ? Math.min(requested, MAX_WAIT_MS)
        : 2000;
      try {
        const result = await manager.waitForRefreshOrTimeout(gitRoot, timeoutMs);
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 500, { error: e.message || 'wait_failed' });
      }
    }));
    return true;
  }

  // ── POST /settings ────────────────────────────
  if (req.method === 'POST' && pathname === '/api/repo-refresh/settings') {
    readJsonBody(req, asyncHandler(res, (err, body) => {
      if (err) return sendJson(res, 400, { error: err.message, code: 'invalid_payload' });
      const knownGitRoots = getKnownGitRoots();
      const validationError = validateSettingsInput(body, knownGitRoots);
      if (validationError) {
        return sendJson(res, 400, { error: 'invalid settings payload', code: validationError });
      }
      try {
        const merged = manager.updateSettings(body);
        sendJson(res, 200, merged);
      } catch (e) {
        sendJson(res, 500, { error: e.message || 'write_failed', code: 'write_failed' });
      }
    }));
    return true;
  }

  // Matched the prefix but no specific route — return 404 so the caller
  // doesn't blindly send the request elsewhere.
  sendJson(res, 404, { error: 'unknown repo-refresh route', code: 'not_found' });
  return true;
}

module.exports = { handleRepoRefreshRoute };
