// Repair PATH for GUI launches on macOS/Linux.
//
// When codbash.app is launched from Finder/Dock/Spotlight, macOS gives the
// process a minimal PATH (typically `/usr/bin:/bin:/usr/sbin:/sbin`) that does
// NOT include user bin directories such as `~/.local/bin`, `~/.npm-global/bin`,
// nvm/fnm shims, or Homebrew. CLIs like `claude` and `codex` are usually
// installed there, so PATH-based agent detection (see agents-detect.js) misses
// them — even though they are installed and their history is present. Agents
// that ship as a `.app` bundle (Cursor) still detect, which is why a GUI launch
// often shows only Cursor while the terminal-launched CLI shows everything.
//
// We repair `process.env.PATH` once at startup by asking the user's login shell
// for its PATH — mirroring exactly what a terminal-launched process would see.
// When already launched from a terminal (PATH already contains user dirs) this
// is a cheap no-op: we never spawn a shell.

const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

let _done = false;

// A login-shell PATH almost always contains at least one directory under the
// user's home (nvm, ~/.local/bin, ~/.npm-global/bin, ...). The Finder-stripped
// GUI PATH never does. This is a more robust signal than matching the exact
// four-entry minimal PATH, which can vary slightly between macOS versions.
function hasUserPaths(p, home) {
  const h = home || os.homedir();
  return (p || '')
    .split(path.delimiter)
    .some(d => d && d.startsWith(h + path.sep));
}

// Control characters we refuse to accept as part of a PATH entry. rc files on
// an interactive login shell can emit banners / shell-integration escape
// sequences; the sentinels below isolate the PATH, and this guard drops any
// stray entry that still carries control bytes.
const CONTROL_CHARS = /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/;

function captureLoginShellPath() {
  const shell = process.env.SHELL || '/bin/zsh';
  // Sentinels (SOH-delimited) let us extract PATH cleanly even if rc files
  // print output on startup (e.g. iTerm/VS Code shell integration).
  const script = 'printf "\\1CBP\\1%s\\1CBE\\1" "$PATH"';
  // -i -l -c loads the user's login + interactive profile so PATH matches a
  // real terminal session. Time-boxed so a slow/hanging rc file cannot wedge
  // startup; stderr is discarded so banners never reach us.
  const raw = execFileSync(shell, ['-ilc', script], {
    encoding: 'utf8',
    timeout: 4000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const m = /\x01CBP\x01([\s\S]*?)\x01CBE\x01/.exec(raw);
  return m ? m[1] : '';
}

// Merge the login-shell PATH into process.env.PATH. Existing entries keep
// priority; only previously-absent, control-char-free directories are appended.
// Idempotent and safe to call unconditionally at startup. Returns the list of
// directories that were added (empty when skipped or nothing new).
function augmentPathFromLoginShell(opts) {
  const o = opts || {};
  if (_done && !o.force) return [];
  _done = true;

  const platform = o.platform || process.platform;
  if (platform === 'win32') return []; // Windows GUI PATH is not stripped this way

  const home = o.home || os.homedir();
  const currentPath = o.path != null ? o.path : (process.env.PATH || '');

  // Already a terminal-style PATH → nothing to repair, and no shell spawn.
  if (hasUserPaths(currentPath, home)) return [];

  let captured = '';
  try {
    captured = o.capture ? o.capture() : captureLoginShellPath();
  } catch (_) {
    return []; // keep the existing PATH if the shell probe fails
  }

  const have = new Set(currentPath.split(path.delimiter).filter(Boolean));
  const added = captured
    .split(path.delimiter)
    .map(d => d.trim())
    .filter(d => d && !have.has(d) && !CONTROL_CHARS.test(d));

  if (added.length) {
    const next = [...have, ...added].join(path.delimiter);
    if (o.path == null) process.env.PATH = next;
  }
  return added;
}

module.exports = {
  augmentPathFromLoginShell,
  hasUserPaths,
  captureLoginShellPath,
};
