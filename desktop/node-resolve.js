// Locate the Node binary that runs the bundled codbash server.
//
// Extracted from main.js (which requires electron and can't be unit-tested
// under `node --test`). The resolution order is: explicit override → bundled
// node → common install locations → nvm-installed versions → the user's login
// shell → bare "node" as a last resort.
//
// The login-shell probe deliberately mirrors src/shell-path.js: rc files
// freely print to stdout (oh-my-zsh warnings, iTerm2 OSC 1337 escape
// sequences without a trailing newline), so "take the last line of stdout"
// returned the node path glued to escape garbage and the fallback silently
// failed. Wrapping the answer in \x01 sentinels and extracting by regex makes
// the probe immune to any rc noise.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROBE_SCRIPT = 'printf "\\1CBN\\1%s\\1CBE\\1" "$(command -v node 2>/dev/null)"';

function extractProbedNodePath(raw) {
  const m = /\x01CBN\x01([\s\S]*?)\x01CBE\x01/.exec(raw || '');
  if (!m) return '';
  const p = m[1].trim();
  return p && path.isAbsolute(p) ? p : '';
}

// Installed nvm nodes (~/.nvm/versions/node/vX.Y.Z/bin/node), highest version
// first. Numeric compare — lexicographic would rank v8 above v20.
function listNvmNodes(home) {
  const root = path.join(home, '.nvm', 'versions', 'node');
  let entries;
  try { entries = fs.readdirSync(root); } catch (_e) { return []; }
  return entries
    .map((name) => ({ name, parts: /^v(\d+)\.(\d+)\.(\d+)$/.exec(name) }))
    .filter((e) => e.parts)
    .sort((a, b) =>
      (b.parts[1] - a.parts[1]) || (b.parts[2] - a.parts[2]) || (b.parts[3] - a.parts[3]))
    .map((e) => path.join(root, e.name, 'bin', 'node'))
    .filter((p) => { try { return fs.existsSync(p); } catch (_e) { return false; } });
}

// Ask the user's login shell where node lives (picks up nvm/conda/asdf shims a
// plain env misses). Flags and limits follow src/shell-path.js: `-i -l -c` so
// PATH matches a real terminal, SIGKILL because an rc that traps SIGTERM could
// outlive the timeout, stderr ignored so rc noise doesn't leak into our logs.
function probeLoginShellForNode(env) {
  const shell = (env.SHELL && path.isAbsolute(env.SHELL)) ? env.SHELL : '/bin/zsh';
  try {
    const raw = execFileSync(shell, ['-i', '-l', '-c', PROBE_SCRIPT], {
      encoding: 'utf8',
      timeout: 6000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return extractProbedNodePath(raw);
  } catch (_e) {
    return '';
  }
}

// Options exist for tests only; production callers pass the real process/app
// values (see main.js). `existsSync` and `probe` default to the real thing.
function resolveNodeBin(o) {
  o = o || {};
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const exists = o.existsSync || fs.existsSync;

  if (env.CODBASH_NODE) return env.CODBASH_NODE;

  const bundled = path.join(o.resourcesPath || '', platform === 'win32' ? 'node.exe' : 'node');
  try { if (o.isPackaged && exists(bundled)) return bundled; } catch (_e) {}

  if (platform === 'win32') return 'node.exe';

  const home = o.home || os.homedir();
  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    path.join(home, '.local/bin/node'),
    path.join(home, '.volta/bin/node'),
    ...listNvmNodes(home),
  ];
  for (const c of candidates) {
    try { if (exists(c)) return c; } catch (_e) {}
  }

  const probed = (o.probe || probeLoginShellForNode)(env);
  try { if (probed && exists(probed)) return probed; } catch (_e) {}

  return 'node';
}

module.exports = { PROBE_SCRIPT, extractProbedNodePath, listNvmNodes, resolveNodeBin };
