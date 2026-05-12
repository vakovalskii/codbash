// Agent detection — probes PATH for known CLIs, falls back to /Applications/*.app
// on macOS for agents that ship as an app bundle (notably Cursor.app).
//
// The result is cached for the server lifetime; the server exposes a refresh
// endpoint that calls `detectRealOS({ force: true })` to re-run detection
// after the user installs something new.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Defense-in-depth: the `bin` values come from a constant table, but if a
// future change ever wires user input here, this regex bounds what we will
// pass to a shell. POSIX binary names are letters, digits, ., _, -.
const SAFE_BIN_NAME = /^[A-Za-z0-9._-]{1,64}$/;

// Mapping: agent id → CLI binary name + optional macOS .app bundle name.
// Ordering here defines the preference order returned by detect().
const AGENT_DEFS = Object.freeze([
  { id: 'claude',       label: 'Claude Code',  bin: 'claude' },
  { id: 'codex',        label: 'Codex',        bin: 'codex' },
  { id: 'cursor',       label: 'Cursor',       bin: 'cursor-agent', appBundle: 'Cursor.app' },
  { id: 'qwen',         label: 'Qwen Code',    bin: 'qwen' },
  { id: 'kilo',         label: 'Kilo',         bin: 'kilo' },
  { id: 'kiro',         label: 'Kiro CLI',     bin: 'kiro-cli' },
  { id: 'opencode',     label: 'OpenCode',     bin: 'opencode' },
  { id: 'copilot',      label: 'Copilot CLI',  bin: 'gh' }, // requires `gh copilot`; presence of gh is the proxy
  // copilot-chat is a VS Code extension only — detect via app bundle.
  { id: 'copilot-chat', label: 'Copilot Chat', appBundle: 'Visual Studio Code.app' },
]);

function realWhich(bin) {
  if (!SAFE_BIN_NAME.test(bin)) return null;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where', [bin], { encoding: 'utf8', timeout: 2000, windowsHide: true });
      const first = out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
      return first || null;
    } catch { return null; }
  }
  // Walk $PATH directly — avoids invoking a shell entirely. This is portable
  // across macOS/Linux/WSL and removes any risk that a future change to the
  // bin-name table could surface a shell metacharacter.
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, bin);
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && (st.mode & 0o111)) return candidate;
    } catch { /* not present in this PATH entry */ }
  }
  return null;
}

function realAppBundleExists(name) {
  if (process.platform !== 'darwin') return false;
  // Use os.homedir() instead of process.env.HOME — `HOME` may be missing in
  // sandboxed CI/launchd environments, which would otherwise turn the lookup
  // into a relative path that matches cwd-local directories.
  const candidates = [
    path.join('/Applications', name),
    path.join(os.homedir(), 'Applications', name),
  ];
  return candidates.some(p => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });
}

// Pure detector — accepts a context object so tests can stub PATH and bundle
// lookups deterministically. Real callers should use detectRealOS() below.
async function detect(ctx) {
  const platform = ctx.platform || process.platform;
  const which = ctx.which || realWhich;
  const appBundleExists = ctx.appBundleExists || realAppBundleExists;
  const out = [];
  for (const def of AGENT_DEFS) {
    let detectedVia = null;
    let binPath;
    if (def.bin) {
      const found = which(def.bin);
      if (found) {
        detectedVia = 'path';
        binPath = found;
      }
    }
    if (!detectedVia && def.appBundle && platform === 'darwin') {
      if (appBundleExists(def.appBundle)) {
        detectedVia = 'app-bundle';
      }
    }
    if (detectedVia) {
      const entry = { id: def.id, label: def.label, detectedVia };
      if (binPath) entry.binPath = binPath;
      out.push(entry);
    }
  }
  return { agents: out, refreshedAt: new Date().toISOString() };
}

let _cache = null;
async function detectRealOS({ force } = {}) {
  if (_cache && !force) return _cache;
  _cache = await detect({});
  return _cache;
}

module.exports = {
  detect,
  detectRealOS,
  AGENT_DEFS,
};
