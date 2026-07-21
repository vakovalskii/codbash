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
// When already launched from a terminal (PATH already contains user bin dirs)
// this is a cheap no-op: we never spawn a shell.
//
// Opt out entirely with `CODBASH_NO_PATH_REPAIR=1`. Set `CODBASH_DEBUG=1` to
// log the skip/augment decisions to stderr.

const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

let _done = false;

function debugEnabled() {
  return process.env.CODBASH_DEBUG === '1' || process.env.CODBASH_DEBUG === 'true';
}
function debug(msg) {
  if (debugEnabled()) {
    try { console.error('[codbash] ' + msg); } catch (_) { /* stderr closed */ }
  }
}

// Reject any PATH entry containing a C0/C1 control character, TAB, or DEL. A
// blocklist (rather than a printable-ASCII allowlist) is used deliberately so
// legitimate non-ASCII directory names — e.g. a Unicode home directory — are
// preserved instead of being silently dropped.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

// Does PATH already look like a real terminal session? We treat it as "good"
// only when it contains a bin/shims directory *under the user's home* — the
// kind of entry (`~/.local/bin`, `~/.npm-global/bin`, nvm/fnm shims) that agent
// detection depends on. A lone unrelated home path (e.g. a LaunchServices
// `~/Library/...` entry that some GUI launchers prepend) must NOT suppress the
// repair, so a bare `startsWith($HOME)` test is deliberately avoided — it would
// false-negative and leave detection broken with no shell probe ever running.
function hasUserBinPaths(p, home) {
  const h = home || os.homedir();
  const prefix = h + path.sep;
  return (p || '').split(path.delimiter).some(d => {
    if (!d || !d.startsWith(prefix)) return false;
    return d.endsWith(path.sep + 'bin')
      || d.endsWith(path.sep + 'sbin')
      || d.includes(path.sep + 'shims' + path.sep) || d.endsWith(path.sep + 'shims')
      || d.includes(path.sep + '.nvm' + path.sep)
      || d.includes(path.sep + '.fnm' + path.sep);
  });
}

function captureLoginShellPath() {
  let shell = process.env.SHELL || '';
  // $SHELL is attacker-controllable only by someone who already has env-setting
  // (= code-execution) capability in this process, so this is a robustness
  // guard, not a trust boundary: reject an empty/relative value and fall back
  // to the macOS default login shell (zsh since Catalina; this feature is
  // macOS-focused — cf. terminal.js which defaults to bash for its own path).
  if (!shell || !path.isAbsolute(shell)) shell = '/bin/zsh';

  // Sentinels (SOH-delimited) let us pull PATH out of stdout even when rc files
  // print banners / shell-integration escape sequences on startup. NOTE: this
  // guards against *accidental* banner noise only — it is NOT a trust boundary
  // against a malicious rc file, which already controls $PATH directly.
  const script = 'printf "\\1CBP\\1%s\\1CBE\\1" "$PATH"';

  // Separate flags (not a bundled `-ilc`) for portability across shells with
  // stricter getopt parsing. `-i -l` sources both login (.zprofile/.zlogin) and
  // interactive (.zshrc/.bashrc) config, so PATH matches a real terminal no
  // matter which file the user's exports live in. Cost: this runs the user's rc
  // chain once per app launch — an accepted tradeoff for correct detection.
  // killSignal is SIGKILL because a shell/rc that traps or ignores SIGTERM
  // could otherwise outlive the timeout; SIGKILL is still best-effort (a
  // process blocked in an uninterruptible syscall cannot be reaped until it
  // unblocks), so the 4s bound is a strong guideline, not a hard guarantee.
  let raw;
  try {
    raw = execFileSync(shell, ['-i', '-l', '-c', script], {
      encoding: 'utf8',
      timeout: 4000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    // Surface the failure (rare: bad $SHELL, hung rc file, sentinel timeout) so
    // a field report of "detection still broken" is diagnosable, matching the
    // repo-refresh startup logging convention in bin/cli.js.
    console.error('[codbash] PATH repair: login-shell probe failed: ' + (err && err.message ? err.message : String(err)));
    return '';
  }
  const m = /\x01CBP\x01([\s\S]*?)\x01CBE\x01/.exec(raw);
  return m ? m[1] : '';
}

// Merge the login-shell PATH into process.env.PATH. Existing entries keep
// priority; only previously-absent, control-char-free directories are appended.
// Idempotent (guarded by `_done`; pass `{ force: true }` to re-run). Safe to
// call unconditionally at startup. Returns the list of directories that were
// added (empty when skipped or nothing new).
function augmentPathFromLoginShell(opts) {
  const o = opts || {};
  if (_done && !o.force) return [];
  _done = true;

  // Explicit user opt-out — skips the login-shell spawn entirely.
  if (process.env.CODBASH_NO_PATH_REPAIR === '1') {
    debug('PATH repair disabled via CODBASH_NO_PATH_REPAIR');
    return [];
  }

  const platform = o.platform || process.platform;
  if (platform === 'win32') return []; // Windows GUI PATH is not stripped this way

  const home = o.home || os.homedir();
  const currentPath = o.path != null ? o.path : (process.env.PATH || '');

  // Already a terminal-style PATH → nothing to repair, and no shell spawn.
  if (hasUserBinPaths(currentPath, home)) {
    debug('PATH already contains user bin dirs — skipping login-shell probe');
    return [];
  }

  let captured = '';
  try {
    captured = o.capture ? o.capture() : captureLoginShellPath();
  } catch (_) {
    return []; // fail-safe: keep the existing PATH if the probe throws
  }

  // Trim BOTH sides so a stray-whitespace entry already present in PATH is not
  // re-added as a spurious "new" duplicate.
  const have = new Set(currentPath.split(path.delimiter).map(d => d.trim()).filter(Boolean));
  const added = captured
    .split(path.delimiter)
    .map(d => d.trim())
    .filter(d => d && !have.has(d) && !CONTROL_CHARS.test(d));

  // Precedence is intentional: existing (system) entries stay FIRST and the
  // login-shell dirs are appended AFTER — the opposite of a normal terminal
  // (where user dirs usually win). Chosen so a directory discovered from the
  // login shell can never shadow a base system binary; detection only needs the
  // dir to be *present* on PATH, not first. (Duplicate casings on a
  // case-insensitive filesystem are not normalized — accepted: unlikely and
  // harmless, at worst a redundant PATH entry.)
  if (added.length) {
    const next = [...have, ...added].join(path.delimiter);
    if (o.path == null) process.env.PATH = next;
    debug('PATH augmented with: ' + added.join(', '));
  }
  return added;
}

module.exports = {
  augmentPathFromLoginShell,
  hasUserBinPaths,
  captureLoginShellPath,
};
