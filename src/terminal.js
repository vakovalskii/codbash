'use strict';

// ── Browser terminal (Workspace) — B-0 walking skeleton ─────────────────────
//
// Optional feature. The core dashboard stays dependency-free; this module lazily
// loads @lydell/node-pty (prebuilt-only, never invokes node-gyp) and, if it is
// unavailable, reports the feature as disabled instead of crashing.
//
// Transport is a hand-rolled WebSocket on the stdlib http.Server 'upgrade' event
// (so `ws` is NOT a dependency). Framing convention:
//   • binary frames  = raw terminal bytes (stdin from client, stdout to client)
//   • text frames    = JSON control messages ({t:'resize'|'exit'|'ready'|...})
//
// Security: a per-process token (printed nowhere the network can see) must be
// supplied on the upgrade request. A WebSocket to this endpoint is a shell, so
// this is mandatory — see verifyUpgradeAuth().

const crypto = require('crypto');
const os = require('os');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_PATH = '/ws/terminal';

// ── Lazy node-pty loader ────────────────────────────────────────────────────
let _pty = null;
let _ptyTried = false;
let _ptyError = null;

function getPty() {
  if (_ptyTried) return _pty;
  _ptyTried = true;
  try {
    _pty = require('@lydell/node-pty');
  } catch (err) {
    _ptyError = err && err.message ? err.message : String(err);
    _pty = null;
  }
  return _pty;
}

function isTerminalAvailable() {
  return !!getPty();
}

function terminalStatus() {
  return {
    available: isTerminalAvailable(),
    error: _pty ? null : (_ptyError || 'node-pty not installed'),
    hint: _pty ? null : 'Install @lydell/node-pty to enable the browser terminal (npm i -g codbash-app pulls it automatically when a prebuilt binary exists for your platform).'
  };
}

// ── Auth token (per process) ────────────────────────────────────────────────
let _token = null;

function getToken() {
  if (!_token) _token = crypto.randomBytes(32).toString('hex');
  return _token;
}

// Constant-time compare to avoid leaking the token via timing.
function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ── WebSocket frame codec ───────────────────────────────────────────────────

// Encode a single unmasked server->client frame. opcode 0x1 text, 0x2 binary.
function encodeFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    // High 32 bits assumed 0 for any realistic terminal payload.
    header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
  return Buffer.concat([header, payload]);
}

// Stateful decoder: feed it chunks, get back complete frames.
function createFrameDecoder(onFrame) {
  let buf = Buffer.alloc(0);
  return function feed(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    // Parse as many complete frames as are buffered.
    // Returns when a partial frame remains.
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        // Only the low 32 bits are honored (payloads never exceed 4 GB).
        len = buf.readUInt32BE(6);
        offset = 10;
      }
      let maskKey = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.slice(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + len) return; // wait for full payload
      let payload = buf.slice(offset, offset + len);
      if (masked && maskKey) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
        payload = out;
      }
      buf = buf.slice(offset + len);
      onFrame(opcode, payload);
    }
  };
}

// ── Upgrade auth ────────────────────────────────────────────────────────────

// Only same-origin loopback connections carrying the correct token may open a
// terminal. Returns { ok, reason }.
function verifyUpgradeAuth(req, url) {
  const token = url.searchParams.get('token');
  if (!tokensMatch(token, getToken())) {
    return { ok: false, reason: 'bad token' };
  }
  // Reject cross-origin upgrades (defense against a malicious page in the
  // browser reaching the loopback socket). Origin, when present, must be the
  // same host we are serving from.
  const origin = req.headers.origin;
  if (origin) {
    let originHost;
    try { originHost = new URL(origin).host; } catch (_e) { return { ok: false, reason: 'bad origin' }; }
    if (originHost !== req.headers.host) return { ok: false, reason: 'origin mismatch' };
  }
  return { ok: true };
}

// ── Connection handling ─────────────────────────────────────────────────────

function sendText(socket, obj) {
  try { socket.write(encodeFrame(Buffer.from(JSON.stringify(obj)), 0x1)); } catch (_e) {}
}
function sendBinary(socket, buf) {
  try { socket.write(encodeFrame(buf, 0x2)); } catch (_e) {}
}
function sendClose(socket) {
  try { socket.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch (_e) {}
}

// Validate/normalize the requested cwd. `isSafeCwd(dir)` is injected by the
// server so we reuse the dashboard's known-git-roots trust boundary.
function resolveCwd(url, isSafeCwd) {
  const requested = url.searchParams.get('cwd');
  if (requested && typeof isSafeCwd === 'function' && isSafeCwd(requested)) {
    return requested;
  }
  return os.homedir();
}

// Attach the upgrade handler + spawn a pty per connection.
// opts: { isSafeCwd, log }
function handleUpgrade(req, socket, head, opts) {
  opts = opts || {};
  const log = opts.log || function () {};

  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (_e) {
    socket.destroy();
    return;
  }
  if (url.pathname !== WS_PATH) {
    // Not ours — let the socket close (no other upgrade consumer today).
    socket.destroy();
    return;
  }

  const auth = verifyUpgradeAuth(req, url);
  if (!auth.ok) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    log('WARN', 'terminal upgrade rejected: ' + auth.reason);
    return;
  }

  const pty = getPty();
  if (!pty) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n' +
    '\r\n'
  );

  const cwd = resolveCwd(url, opts.isSafeCwd);
  const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash');
  const cols = parseInt(url.searchParams.get('cols'), 10) || 80;
  const rows = parseInt(url.searchParams.get('rows'), 10) || 24;

  let term;
  try {
    term = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: cols,
      rows: rows,
      cwd: cwd,
      env: process.env
    });
  } catch (err) {
    sendText(socket, { t: 'error', message: 'Failed to start shell: ' + (err && err.message) });
    sendClose(socket);
    socket.destroy();
    return;
  }

  log('TERM', 'pty spawned pid=' + term.pid + ' cwd=' + cwd);
  sendText(socket, { t: 'ready', pid: term.pid, cwd: cwd, shell: shell });

  // pty -> client (raw bytes as binary frames)
  const onData = term.onData(function (data) {
    sendBinary(socket, Buffer.from(data, 'utf8'));
  });
  const onExit = term.onExit(function (e) {
    sendText(socket, { t: 'exit', code: e ? e.exitCode : 0 });
    sendClose(socket);
    try { socket.end(); } catch (_e) {}
  });

  let closed = false;
  function cleanup() {
    if (closed) return;
    closed = true;
    try { onData.dispose(); } catch (_e) {}
    try { onExit.dispose(); } catch (_e) {}
    try { term.kill(); } catch (_e) {}
    log('TERM', 'pty closed pid=' + term.pid);
  }

  const decode = createFrameDecoder(function (opcode, payload) {
    if (opcode === 0x8) { // close
      sendClose(socket);
      cleanup();
      try { socket.end(); } catch (_e) {}
      return;
    }
    if (opcode === 0x9) { // ping -> pong
      try { socket.write(encodeFrame(payload, 0xA)); } catch (_e) {}
      return;
    }
    if (opcode === 0x2) { // binary: raw stdin
      try { term.write(payload.toString('utf8')); } catch (_e) {}
      return;
    }
    if (opcode === 0x1) { // text: JSON control
      let msg;
      try { msg = JSON.parse(payload.toString('utf8')); } catch (_e) { return; }
      if (msg && msg.t === 'resize') {
        const c = parseInt(msg.cols, 10);
        const r = parseInt(msg.rows, 10);
        if (c > 0 && r > 0) { try { term.resize(c, r); } catch (_e) {} }
      } else if (msg && msg.t === 'input' && typeof msg.data === 'string') {
        try { term.write(msg.data); } catch (_e) {}
      }
    }
  });

  socket.on('data', function (chunk) {
    try { decode(chunk); } catch (_e) {}
  });
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

module.exports = {
  WS_PATH: WS_PATH,
  isTerminalAvailable: isTerminalAvailable,
  terminalStatus: terminalStatus,
  getToken: getToken,
  handleUpgrade: handleUpgrade,
  // exported for unit tests
  encodeFrame: encodeFrame,
  createFrameDecoder: createFrameDecoder,
  tokensMatch: tokensMatch
};
