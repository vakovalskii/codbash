// UI-level settings: default agent + last-used-by-path map.
//
// Storage: <CODBASH_SETTINGS_DIR or ~/.codedash>/settings.json, mode 0600.
//
// Writes are serialized through a promise-chain mutex and made atomic via
// tmp-file + rename, mirroring the pattern in projects.js. Reads tolerate a
// missing or corrupt file by returning defaults — writes do NOT, so a corrupt
// file is loud rather than silently overwritten.

const fs = require('fs');
const os = require('os');
const path = require('path');

const KNOWN_AGENTS = Object.freeze([
  'claude', 'codex', 'cursor', 'qwen',
  'kilo', 'kiro', 'opencode', 'copilot', 'copilot-chat',
]);
const KNOWN_AGENT_SET = new Set(KNOWN_AGENTS);

// Cap the lastUsedByPath map so a long-running install over hundreds of
// ephemeral worktree paths doesn't grow settings.json without bound. 500 is
// generous — typical users have <50 active projects.
const MAX_LAST_USED = 500;
// Reject path keys that are absurdly long or look like prototype-pollution
// attempts (__proto__, constructor) — these can't appear in legitimate
// absolute paths on any supported OS.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isSafePathKey(k) {
  if (typeof k !== 'string' || k.length === 0 || k.length > 1024) return false;
  if (FORBIDDEN_KEYS.has(k)) return false;
  return true;
}

function settingsDir() {
  return process.env.CODBASH_SETTINGS_DIR || path.join(os.homedir(), '.codedash');
}
function settingsFile() {
  return path.join(settingsDir(), 'settings.json');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function emptySettings() {
  return { defaultAgent: null, lastUsedByPath: {} };
}

// Reader tolerates absent / corrupt file — callers always get a usable object.
function loadSettings() {
  const fp = settingsFile();
  let raw;
  try { raw = fs.readFileSync(fp, 'utf8'); }
  catch { return emptySettings(); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return emptySettings(); }
  return {
    defaultAgent: typeof parsed.defaultAgent === 'string' && KNOWN_AGENT_SET.has(parsed.defaultAgent)
      ? parsed.defaultAgent
      : null,
    lastUsedByPath: sanitizeLastUsed(parsed.lastUsedByPath),
  };
}

// Internal read used inside the mutex; throws on corrupt JSON so updates don't
// silently obliterate a file we couldn't parse. Use loadSettings() for soft reads.
// Both `defaultAgent` and the `lastUsedByPath` entries are validated against
// the known-agent set so a tampered file can't smuggle untrusted strings into
// future writes.
function readForUpdate() {
  const fp = settingsFile();
  if (!fs.existsSync(fp)) return emptySettings();
  const raw = fs.readFileSync(fp, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('settings.json is corrupt — refusing to overwrite. Move it aside and retry.'); }
  return {
    defaultAgent: typeof parsed.defaultAgent === 'string' && KNOWN_AGENT_SET.has(parsed.defaultAgent)
      ? parsed.defaultAgent
      : null,
    lastUsedByPath: sanitizeLastUsed(parsed.lastUsedByPath),
  };
}

// Filter a lastUsedByPath candidate down to safe key/value pairs. Used by
// both the reader (sanitises on-disk data) and the writer (sanitises caller
// input before merging into the persisted object).
function sanitizeLastUsed(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = Object.create(null);
  for (const [k, v] of Object.entries(obj)) {
    if (!isSafePathKey(k)) continue;
    if (typeof v !== 'string' || !KNOWN_AGENT_SET.has(v)) continue;
    out[k] = v;
  }
  return out;
}

function writeAtomic(obj) {
  const fp = settingsFile();
  ensureDir(path.dirname(fp));
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(tmp, 0o600); } catch {}
  }
  fs.renameSync(tmp, fp);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(fp, 0o600); } catch {}
  }
}

let _writeLock = Promise.resolve();
// Promise-chain mutex. The `then(fn, fn)` shape is deliberate (same pattern as
// in projects.js): we want the queue to keep moving even if a previous step
// rejected. `fn` is re-invoked on rejection but it will re-throw if the
// underlying file is still corrupt, so the rejection surfaces to that
// specific caller, not the entire queue.
function withWriteLock(fn) {
  const next = _writeLock.then(fn, fn);
  _writeLock = next.catch(() => {});
  return next;
}

// Merge update — caller passes a partial; we shallow-merge into the on-disk
// object. `lastUsedByPath` is merged key-by-key so per-project entries are
// not wiped by an update that only sets `defaultAgent`. Caller input is run
// through `sanitizeLastUsed` so a buggy or malicious caller can't smuggle in
// prototype-pollution keys, oversized strings, or non-agent values.
function updateSettings(partial) {
  return withWriteLock(() => {
    const current = readForUpdate();
    const next = { ...current };
    if (Object.prototype.hasOwnProperty.call(partial, 'defaultAgent')) {
      next.defaultAgent = partial.defaultAgent === null
        ? null
        : (KNOWN_AGENT_SET.has(partial.defaultAgent) ? partial.defaultAgent : current.defaultAgent);
    }
    if (partial.lastUsedByPath && typeof partial.lastUsedByPath === 'object') {
      const sanitized = sanitizeLastUsed(partial.lastUsedByPath);
      const merged = { ...current.lastUsedByPath, ...sanitized };
      // Cap map size — drop oldest keys (insertion order) once over MAX_LAST_USED.
      const entries = Object.entries(merged);
      next.lastUsedByPath = entries.length > MAX_LAST_USED
        ? Object.fromEntries(entries.slice(entries.length - MAX_LAST_USED))
        : merged;
    }
    writeAtomic(next);
    return next;
  });
}

function rememberLastUsed(projectPath, tool) {
  if (!projectPath || typeof projectPath !== 'string') return Promise.resolve();
  if (!KNOWN_AGENT_SET.has(tool)) return Promise.resolve();
  return updateSettings({ lastUsedByPath: { [projectPath]: tool } });
}

function isKnownAgent(id) {
  return typeof id === 'string' && KNOWN_AGENT_SET.has(id);
}

// Pure selection helper that mirrors the client's `pickPreferredTool` priority
// order (lastUsed > default > first installed). Currently consumed only by the
// unit tests — kept on the server module so server-side callers can adopt the
// same priority order without re-deriving it. Replaces the older inline
// `isKnownAgent(tool) ? tool : 'claude'` fallback in `/api/launch` if/when we
// move that path here.
function pickLaunchTool({ path: projectPath, settings, installed }) {
  const installedSet = new Set(Array.isArray(installed) ? installed : []);
  const last = settings && settings.lastUsedByPath ? settings.lastUsedByPath[projectPath] : null;
  if (last && installedSet.has(last)) return last;
  const def = settings ? settings.defaultAgent : null;
  if (def && installedSet.has(def)) return def;
  if (installedSet.size === 0) return null;
  // Return the first agent in the installed list — caller is expected to pass
  // an array ordered by preference (currently KNOWN_AGENTS order).
  for (const id of (Array.isArray(installed) ? installed : [])) {
    if (KNOWN_AGENT_SET.has(id)) return id;
  }
  return null;
}

module.exports = {
  KNOWN_AGENTS,
  loadSettings,
  updateSettings,
  rememberLastUsed,
  isKnownAgent,
  pickLaunchTool,
};
