'use strict';

// Saved Workspace layouts — a named snapshot of the whole Workspace view:
// every tab, its panes, and the start command each pane runs. Lets the user
// save "my 4-agent setup" once and relaunch the identical workspace later.
//
// A pane command may embed secrets (proxy credentials), exactly like
// workspace-commands.js, so layouts live server-side in
// <CODBASH_SETTINGS_DIR or ~/.codedash>/workspace-layouts.json at mode 0600
// (NOT localStorage). Atomic tmp+rename writes serialized through a
// promise-chain mutex, mirroring workspace-commands.js / settings.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_LAYOUTS = 50;
const MAX_NAME = 120;
const MAX_TABS = 20;
const MAX_PANES = 4;
const MAX_COMMAND = 8192;
// Reject control chars except tab (\x09). A newline in a pane command would let
// a saved layout inject a second command line silently when typed into a shell.
const CONTROL_CHARS = /[\x00-\x08\x0A-\x1F\x7F]/;

function dir() {
  return process.env.CODBASH_SETTINGS_DIR || path.join(os.homedir(), '.codedash');
}
function file() {
  return path.join(dir(), 'workspace-layouts.json');
}
function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// A pane is { cmd, prefill, cwd }. cmd may be '' (a blank pane, no auto-launch).
// `prefill` is a command typed into the pane but NOT auto-executed (e.g. a
// resume command from a session card); `cwd` is the folder the pane opened in,
// so a restored layout reopens each pane in the same project. Non-empty
// commands are validated like saved commands (no newlines / control chars).
// cwd is validated the same way (a path with a control char is rejected); the
// pty spawn re-gates it through isSafeLaunchPath, so this is belt-and-braces.
function sanitizePane(p) {
  const raw = p && typeof p === 'object' ? p.cmd : p;
  const cmd = typeof raw === 'string' ? raw.trim() : '';
  if (cmd.length > MAX_COMMAND) return null;
  if (cmd && CONTROL_CHARS.test(cmd)) return null;
  const prefillRaw = p && typeof p === 'object' && typeof p.prefill === 'string' ? p.prefill.trim() : '';
  if (prefillRaw.length > MAX_COMMAND) return null;
  if (prefillRaw && CONTROL_CHARS.test(prefillRaw)) return null;
  const cwdRaw = p && typeof p === 'object' && typeof p.cwd === 'string' ? p.cwd.trim() : '';
  if (cwdRaw.length > MAX_COMMAND) return null;
  if (cwdRaw && CONTROL_CHARS.test(cwdRaw)) return null;
  const out = { cmd };
  if (prefillRaw) out.prefill = prefillRaw;
  if (cwdRaw) out.cwd = cwdRaw;
  return out;
}

function sanitizeTab(t, i) {
  if (!t || typeof t !== 'object') return null;
  const name = typeof t.name === 'string' && t.name.trim()
    ? t.name.trim().slice(0, MAX_NAME)
    : 'Tab ' + (i + 1);
  if (CONTROL_CHARS.test(name)) return null;
  // Extra panes beyond MAX are dropped, but any *present* pane that fails
  // validation (e.g. a newline-injection command) rejects the whole tab —
  // silently dropping a bad command would hide the problem from the user.
  const rawPanes = Array.isArray(t.panes) ? t.panes.slice(0, MAX_PANES) : [];
  const panes = rawPanes.map(sanitizePane);
  if (panes.some((p) => p === null)) return null;
  if (!panes.length) panes.push({ cmd: '' }); // a tab always has ≥1 pane
  return { name, panes };
}

function sanitizeLayout(e) {
  if (!e || typeof e !== 'object') return null;
  const name = typeof e.name === 'string' ? e.name.trim().slice(0, MAX_NAME) : '';
  if (!name || CONTROL_CHARS.test(name)) return null;
  const rawTabs = Array.isArray(e.tabs) ? e.tabs.slice(0, MAX_TABS) : [];
  const cleanTabs = rawTabs.map(sanitizeTab);
  if (cleanTabs.some((t) => t === null)) return null; // one bad tab rejects all
  const tabs = cleanTabs.filter(Boolean);
  if (!tabs.length) return null; // a layout with no tabs is meaningless
  const id = typeof e.id === 'string' && /^[a-f0-9]{12}$/.test(e.id) ? e.id : null;
  const now = new Date().toISOString();
  return {
    id: id || crypto.randomBytes(6).toString('hex'),
    name,
    tabs,
    createdAt: typeof e.createdAt === 'string' ? e.createdAt : now,
    updatedAt: now,
  };
}

// Reader tolerates a missing / corrupt file by returning an empty list.
function loadLayouts() {
  let raw;
  try { raw = fs.readFileSync(file(), 'utf8'); } catch { return []; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const list = parsed && Array.isArray(parsed.layouts) ? parsed.layouts : [];
  return list.map(sanitizeLayout).filter(Boolean).slice(0, MAX_LAYOUTS);
}

function writeAtomic(list) {
  const fp = file();
  ensureDir(path.dirname(fp));
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ layouts: list }, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') { try { fs.chmodSync(tmp, 0o600); } catch {} }
  fs.renameSync(tmp, fp);
  if (process.platform !== 'win32') { try { fs.chmodSync(fp, 0o600); } catch {} }
}

let _writeLock = Promise.resolve();
function withWriteLock(fn) {
  const next = _writeLock.then(fn, fn);
  _writeLock = next.catch(() => {});
  return next;
}

// Upsert by name (case-insensitive): saving "My setup" twice overwrites the
// first rather than piling up duplicates — the natural mental model for
// "save this workspace". Preserves the original id/createdAt on overwrite.
function saveLayout(name, tabs) {
  return withWriteLock(() => {
    const list = loadLayouts();
    const clean = sanitizeLayout({ name, tabs });
    if (!clean) throw new Error('invalid layout: a name and at least one tab are required, no newlines');
    const key = clean.name.toLowerCase();
    const idx = list.findIndex((l) => l.name.toLowerCase() === key);
    if (idx >= 0) {
      clean.id = list[idx].id;
      clean.createdAt = list[idx].createdAt;
      list[idx] = clean;
    } else {
      if (list.length >= MAX_LAYOUTS) throw new Error('too many saved layouts');
      list.push(clean);
    }
    writeAtomic(list);
    return clean;
  });
}

function removeLayout(id) {
  return withWriteLock(() => {
    const list = loadLayouts().filter((l) => l.id !== id);
    writeAtomic(list);
    return list;
  });
}

module.exports = {
  loadLayouts,
  saveLayout,
  removeLayout,
  // exported for tests
  sanitizeLayout,
  _file: file,
};
