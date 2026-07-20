// Workspace — browser terminal (B-0 walking skeleton).
//
// Lazily loads the vendored xterm.js bundle (so the base dashboard never pays
// for it), fetches the per-process WS token from /api/terminal/status, then
// opens a single pty over a WebSocket to /ws/terminal.
//
// Wire protocol (mirror of src/terminal.js):
//   • binary frames = raw terminal bytes (stdin up / stdout down)
//   • text frames   = JSON control ({t:'resize'|'ready'|'exit'|'error'})

var _wsTerm = null;   // xterm Terminal instance
var _wsSock = null;   // WebSocket
var _wsFit = null;    // FitAddon
var _wsResizeHandler = null;
var _wsVendorLoaded = false;

function _loadWorkspaceVendor() {
  if (_wsVendorLoaded) return Promise.resolve();
  return new Promise(function (resolve, reject) {
    // CSS
    if (!document.querySelector('link[data-xterm]')) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/vendor/xterm.css';
      link.setAttribute('data-xterm', '1');
      document.head.appendChild(link);
    }
    function loadScript(src) {
      return new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = src;
        s.onload = res;
        s.onerror = function () { rej(new Error('failed to load ' + src)); };
        document.head.appendChild(s);
      });
    }
    loadScript('/vendor/xterm.js')
      .then(function () { return loadScript('/vendor/addon-fit.js'); })
      .then(function () { _wsVendorLoaded = true; resolve(); })
      .catch(reject);
  });
}

// Called from render() when leaving the Workspace view.
function teardownWorkspaceIfActive() {
  if (_wsSock || _wsTerm) _teardownWorkspace();
}

function _teardownWorkspace() {
  if (_wsResizeHandler) { window.removeEventListener('resize', _wsResizeHandler); _wsResizeHandler = null; }
  if (_wsSock) {
    try { _wsSock.onclose = null; _wsSock.close(); } catch (e) {}
    _wsSock = null;
  }
  if (_wsTerm) {
    try { _wsTerm.dispose(); } catch (e) {}
    _wsTerm = null;
  }
  _wsFit = null;
}

async function renderWorkspace(container) {
  _teardownWorkspace();
  container.innerHTML = '<div class="loading">Loading terminal…</div>';

  var status;
  try {
    var resp = await fetch('/api/terminal/status');
    status = await resp.json();
  } catch (e) {
    container.innerHTML = '<div class="empty-state">Could not reach the terminal service.</div>';
    return;
  }

  if (!status.available) {
    container.innerHTML =
      '<div class="empty-state" style="max-width:520px;line-height:1.6">' +
      '<strong>Terminal not available</strong><br>' +
      escHtml(status.hint || 'The optional terminal dependency is not installed.') +
      (status.error ? '<br><span style="opacity:0.6;font-size:12px">' + escHtml(status.error) + '</span>' : '') +
      '</div>';
    return;
  }

  container.innerHTML =
    '<div class="workspace-wrap">' +
      '<div class="workspace-bar">' +
        '<span class="workspace-title">Workspace</span>' +
        '<span class="workspace-status" id="wsStatus">connecting…</span>' +
        '<button class="toolbar-btn" onclick="renderWorkspace(document.getElementById(\'content\'))">Reconnect</button>' +
      '</div>' +
      '<div class="workspace-term" id="wsTerm"></div>' +
    '</div>';

  try {
    await _loadWorkspaceVendor();
  } catch (e) {
    container.innerHTML = '<div class="empty-state">Failed to load terminal assets.</div>';
    return;
  }

  var host = document.getElementById('wsTerm');
  if (!host) return; // view switched away while loading

  var term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: { background: '#08090c' },
    scrollback: 5000,
    allowProposedApi: true
  });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  try { fit.fit(); } catch (e) {}
  _wsTerm = term;
  _wsFit = fit;

  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var url = proto + '//' + location.host + '/ws/terminal' +
    '?token=' + encodeURIComponent(status.token) +
    '&cols=' + term.cols + '&rows=' + term.rows;
  var sock = new WebSocket(url);
  sock.binaryType = 'arraybuffer';
  _wsSock = sock;

  var statusEl = document.getElementById('wsStatus');
  function setStatus(txt) { if (statusEl) statusEl.textContent = txt; }

  var enc = new TextEncoder();
  var dec = new TextDecoder();

  sock.onopen = function () {
    setStatus('connected');
    term.focus();
  };
  sock.onmessage = function (ev) {
    if (typeof ev.data === 'string') {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === 'ready') { setStatus(msg.cwd || 'ready'); }
      else if (msg.t === 'exit') { setStatus('exited (' + msg.code + ')'); }
      else if (msg.t === 'error') { setStatus('error'); term.write('\r\n\x1b[31m' + (msg.message || 'error') + '\x1b[0m\r\n'); }
      return;
    }
    // binary: raw terminal bytes
    term.write(new Uint8Array(ev.data));
  };
  sock.onclose = function () { setStatus('disconnected'); };
  sock.onerror = function () { setStatus('connection error'); };

  // stdin -> server (binary)
  term.onData(function (data) {
    if (sock.readyState === WebSocket.OPEN) sock.send(enc.encode(data));
  });

  // resize -> server (text control), debounced
  var resizeTimer = null;
  function doResize() {
    try { fit.fit(); } catch (e) {}
    if (sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
    }
  }
  _wsResizeHandler = function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(doResize, 120);
  };
  window.addEventListener('resize', _wsResizeHandler);
}
