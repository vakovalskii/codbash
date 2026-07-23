'use strict';

// Live registry of the pty (shell) PIDs that codbash itself spawned — one per
// Workspace pane. getActiveSessions() uses it to scope RUNNING AGENTS to ONLY
// the agents whose process tree descends from a codbash terminal, instead of
// every claude/codex process on the machine. When no pane is open the registry
// is empty and RUNNING AGENTS is correctly empty too.
//
// Deliberately dependency-free and decoupled from terminal.js so requiring it
// from data.js never risks pulling in the lazy node-pty native module.

const _live = new Set();

function add(pid) { if (pid && Number.isFinite(pid)) _live.add(pid); }
function remove(pid) { _live.delete(pid); }
function has(pid) { return _live.has(pid); }
function all() { return Array.from(_live); }
function size() { return _live.size; }

module.exports = { add, remove, has, all, size };
