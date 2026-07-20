'use strict';

// Saved Workspace commands — user-defined start commands for coding agents,
// e.g. a proxied launch:
//   HTTPS_PROXY='http://user:pass@host:port' claude --dangerously-skip-permissions
//
// These often embed secrets (proxy credentials), so they live server-side in
// <CODBASH_SETTINGS_DIR or ~/.codedash>/workspace-commands.json at mode 0600
// (NOT localStorage, which is readable by any script/extension on the page).
// Atomic tmp+rename writes serialized through a promise-chain mutex, mirroring
// settings.js / projects.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_COMMANDS = 100;
const MAX_NAME = 120;
const MAX_COMMAND = 8192;
// Reject control chars except tab (\x09). A newline would let one saved entry
// inject a second command line silently when typed into the shell.
const CONTROL_CHARS = /[\x00-\x08\x0A-\x1F\x7F]/;

function dir() {
  return process.env.CODBASH_SETTINGS_DIR || path.join(os.homedir(), '.codedash');
}
function file() {
  return path.join(dir(), 'workspace-commands.json');
}
function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function sanitizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const name = typeof e.name === 'string' ? e.name.trim().slice(0, MAX_NAME) : '';
  const command = typeof e.command === 'string' ? e.command.trim() : '';
  if (!name || !command || command.length > MAX_COMMAND) return null;
  if (CONTROL_CHARS.test(command) || CONTROL_CHARS.test(name)) return null;
  const id = typeof e.id === 'string' && /^[a-f0-9]{12}$/.test(e.id) ? e.id : null;
  return {
    id: id || crypto.randomBytes(6).toString('hex'),
    name: name,
    command: command,
    createdAt: typeof e.createdAt === 'string' ? e.createdAt : new Date().toISOString(),
  };
}

// Reader tolerates a missing / corrupt file by returning an empty list.
function loadCommands() {
  let raw;
  try { raw = fs.readFileSync(file(), 'utf8'); } catch { return []; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const list = parsed && Array.isArray(parsed.commands) ? parsed.commands : [];
  return list.map(sanitizeEntry).filter(Boolean).slice(0, MAX_COMMANDS);
}

function writeAtomic(list) {
  const fp = file();
  ensureDir(path.dirname(fp));
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ commands: list }, null, 2), { mode: 0o600 });
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

function addCommand(name, command) {
  return withWriteLock(() => {
    const entry = sanitizeEntry({ name: name, command: command });
    if (!entry) throw new Error('invalid command: name and command required, no newlines');
    const list = loadCommands();
    if (list.length >= MAX_COMMANDS) throw new Error('too many saved commands');
    list.push(entry);
    writeAtomic(list);
    return entry;
  });
}

function removeCommand(id) {
  return withWriteLock(() => {
    const list = loadCommands().filter((c) => c.id !== id);
    writeAtomic(list);
    return list;
  });
}

module.exports = {
  loadCommands,
  addCommand,
  removeCommand,
  // exported for tests
  sanitizeEntry,
  _file: file,
};
