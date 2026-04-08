'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const zlib = require('zlib');

const CLOUD_API = 'https://cloud.neuraldeep.ru';
const CLOUD_KEY_FILE = path.join(os.homedir(), '.codedash', 'cloud-key.json');
const GITHUB_PROFILE_FILE = path.join(os.homedir(), '.codedash', 'github-profile.json');

// ── Encryption ───────────────────────────────

function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha512');
}

function encrypt(data, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: [1B version][12B iv][16B auth tag][...ciphertext]
  const result = Buffer.alloc(1 + 12 + 16 + encrypted.length);
  result[0] = 1; // version
  iv.copy(result, 1);
  tag.copy(result, 13);
  encrypted.copy(result, 29);
  return result;
}

function decrypt(buf, key) {
  if (buf[0] !== 1) throw new Error('Unsupported encryption version');
  const iv = buf.subarray(1, 13);
  const tag = buf.subarray(13, 29);
  const ciphertext = buf.subarray(29);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function loadCloudKey() {
  try {
    return JSON.parse(fs.readFileSync(CLOUD_KEY_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveCloudKey(data) {
  const dir = path.dirname(CLOUD_KEY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CLOUD_KEY_FILE, JSON.stringify(data, null, 2));
  try { fs.chmodSync(CLOUD_KEY_FILE, 0o600); } catch {}
}

// ── GitHub Auth ──────────────────────────────

function loadProfile() {
  try {
    const p = JSON.parse(fs.readFileSync(GITHUB_PROFILE_FILE, 'utf8'));
    return p.authenticated ? p : null;
  } catch {
    return null;
  }
}

// ── HTTP Client ──────────────────────────────

function cloudRequest(method, reqPath, token, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(CLOUD_API + reqPath);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: {
        'User-Agent': 'codedash',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      timeout: 30000,
    };

    if (body && !headers?.['Content-Type']) {
      options.headers['Content-Type'] = 'application/json';
    }
    if (body) {
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const ct = res.headers['content-type'] || '';
        if (ct.includes('application/json')) {
          try { resolve({ status: res.statusCode, data: JSON.parse(raw.toString()), headers: res.headers }); }
          catch { resolve({ status: res.statusCode, data: { raw: raw.toString() }, headers: res.headers }); }
        } else {
          resolve({ status: res.statusCode, data: raw, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Cloud API timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// ── Session Serialization ────────────────────

function serializeSession(sessionId, sessions) {
  // Find session in loaded sessions
  const session = sessions[sessionId];
  if (!session) return null;

  const { loadSessionDetail, findSessionFile } = require('./data');
  const found = findSessionFile(sessionId, session.project);
  if (!found) return null;

  // For JSONL-based agents, read raw lines
  let rawMessages = null;
  if (found.format === 'claude' || found.format === 'codex') {
    try {
      rawMessages = fs.readFileSync(found.file, 'utf8').split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch {}
  }

  // For all agents, get parsed messages as fallback
  if (!rawMessages) {
    const detail = loadSessionDetail(sessionId, session.project);
    rawMessages = detail.messages || [];
  }

  const canonical = {
    version: 1,
    agent: session.tool,
    sessionId: sessionId,
    project: session.project || '',
    projectShort: session.project_short || '',
    firstMessage: session.first_message || '',
    firstTs: session.first_ts || 0,
    lastTs: session.last_ts || 0,
    messageCount: session.messages || 0,
    userMessages: session.user_messages || 0,
    messages: rawMessages,
  };

  return canonical;
}

function encryptSession(canonical, key) {
  const json = JSON.stringify(canonical);
  const compressed = zlib.gzipSync(json);
  return encrypt(compressed, key);
}

function decryptSession(blob, key) {
  const compressed = decrypt(blob, key);
  const json = zlib.gunzipSync(compressed);
  return JSON.parse(json.toString());
}

// ── Session Deserialization (Import) ─────────

function deserializeSession(canonical) {
  const { CLAUDE_DIR, CODEX_DIR, PROJECTS_DIR } = require('./data');
  const agent = canonical.agent;
  const sid = canonical.sessionId;

  if (agent === 'claude') {
    // Write to ~/.claude/projects/{key}/{sid}.jsonl
    const projectKey = (canonical.project || 'unknown').replace(/[^a-zA-Z0-9-]/g, '-');
    const dir = path.join(PROJECTS_DIR, projectKey);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sid}.jsonl`);
    if (fs.existsSync(file)) return { skipped: true, file };

    const lines = canonical.messages.map(m => JSON.stringify(m)).join('\n') + '\n';
    fs.writeFileSync(file, lines);

    // Append to history.jsonl
    const historyFile = path.join(CLAUDE_DIR, 'history.jsonl');
    const historyEntry = {
      sessionId: sid,
      project: projectKey,
      timestamp: new Date(canonical.lastTs || Date.now()).toISOString(),
      summary: canonical.firstMessage?.slice(0, 200) || '',
    };
    fs.appendFileSync(historyFile, JSON.stringify(historyEntry) + '\n');
    return { ok: true, file };
  }

  if (agent === 'codex') {
    // Write to ~/.codex/sessions/{YYYY}/{MM}/{DD}/{sid}.jsonl
    const date = new Date(canonical.lastTs || Date.now());
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const dir = path.join(CODEX_DIR, 'sessions', String(y), m, d);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-${Date.now()}-${sid}.jsonl`);

    const lines = canonical.messages.map(m => JSON.stringify(m)).join('\n') + '\n';
    fs.writeFileSync(file, lines);

    // Append to history.jsonl
    const historyFile = path.join(CODEX_DIR, 'history.jsonl');
    const historyEntry = { id: sid, title: canonical.firstMessage?.slice(0, 200) || '', timestamp: date.toISOString() };
    fs.appendFileSync(historyFile, JSON.stringify(historyEntry) + '\n');
    return { ok: true, file };
  }

  if (agent === 'cursor') {
    // Write to ~/.cursor/projects/{key}/agent-transcripts/{sid}/{sid}.jsonl
    const cursorProjects = path.join(os.homedir(), '.cursor', 'projects');
    const projectKey = (canonical.project || 'unknown').replace(/[^a-zA-Z0-9-]/g, '-');
    const dir = path.join(cursorProjects, projectKey, 'agent-transcripts', sid);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sid}.jsonl`);
    if (fs.existsSync(file)) return { skipped: true, file };

    const lines = canonical.messages.map(m => JSON.stringify(m)).join('\n') + '\n';
    fs.writeFileSync(file, lines);
    return { ok: true, file };
  }

  // OpenCode and Kiro — store as JSONL in ~/.codedash/cloud-imports/
  const importDir = path.join(os.homedir(), '.codedash', 'cloud-imports', agent);
  if (!fs.existsSync(importDir)) fs.mkdirSync(importDir, { recursive: true });
  const file = path.join(importDir, `${sid}.json`);
  if (fs.existsSync(file)) return { skipped: true, file };
  fs.writeFileSync(file, JSON.stringify(canonical, null, 2));
  return { ok: true, file, note: `Saved to cloud-imports (${agent} uses SQLite, manual import needed)` };
}

// ── CLI Cloud Commands ───────────────────────

async function ensureAuth() {
  const profile = loadProfile();
  if (!profile) {
    console.error('\n  Not connected to GitHub. Run: codedash run → connect in dashboard\n');
    process.exit(1);
  }

  const res = await cloudRequest('POST', '/api/auth/verify', profile.token);
  if (res.status !== 200) {
    console.error('\n  GitHub token invalid or expired. Reconnect in dashboard.\n');
    process.exit(1);
  }
  return { profile, user: res.data.user };
}

async function ensureEncryptionKey(user) {
  let keyData = loadCloudKey();

  if (keyData && keyData.salt) {
    // Prompt for passphrase (read from stdin)
    const passphrase = await promptPassphrase('Enter cloud passphrase: ');
    const salt = Buffer.from(keyData.salt, 'hex');
    const key = deriveKey(passphrase, salt);

    // Verify
    try {
      const dec = decrypt(Buffer.from(keyData.verifier, 'hex'), key);
      if (dec.toString() === 'codedash-verify') return key;
    } catch {}

    console.error('  Wrong passphrase.\n');
    process.exit(1);
  }

  // First time setup
  console.log('\n  Cloud Encryption Setup');
  console.log('  Choose a passphrase to encrypt your sessions.');
  console.log('  You will need this same passphrase on other devices.\n');

  const passphrase = await promptPassphrase('Create cloud passphrase: ');
  if (passphrase.length < 4) {
    console.error('  Passphrase too short (min 4 chars).\n');
    process.exit(1);
  }

  const salt = crypto.randomBytes(16);
  const key = deriveKey(passphrase, salt);
  const verifier = encrypt(Buffer.from('codedash-verify'), key);

  // Save locally
  saveCloudKey({ salt: salt.toString('hex'), verifier: verifier.toString('hex') });

  // Sync salt to server
  const profile = loadProfile();
  await cloudRequest('PUT', '/api/auth/salt', profile.token, JSON.stringify({ salt: salt.toString('hex') }));

  console.log('  Encryption configured.\n');
  return key;
}

function promptPassphrase(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';
    const onData = (ch) => {
      if (ch === '\n' || ch === '\r' || ch === '\u0004') {
        if (stdin.isTTY) stdin.setRawMode(wasRaw || false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (ch === '\u0003') {
        process.exit(0);
      } else if (ch === '\u007f' || ch === '\b') {
        input = input.slice(0, -1);
      } else {
        input += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// ── Cloud CLI entry point ────────────────────

async function cloudCLI(args) {
  const action = args[0];

  if (!action || action === 'help') {
    console.log(`
  \x1b[36m\x1b[1mcodedash cloud\x1b[0m — Cloud Session Sync

  \x1b[1mCommands:\x1b[0m
    codedash cloud setup              Set encryption passphrase
    codedash cloud push <id>          Upload session to cloud
    codedash cloud push --all         Upload all sessions
    codedash cloud pull <id>          Download session from cloud
    codedash cloud pull --all         Download all new sessions
    codedash cloud list               List cloud sessions
    codedash cloud delete <id>        Delete cloud session
    codedash cloud status             Show account stats
`);
    return;
  }

  if (action === 'setup') {
    const { user } = await ensureAuth();

    // If server has a salt but we don't, sync it
    if (user.encryption_salt && !loadCloudKey()) {
      console.log('\n  Found existing encryption salt from another device.');
      console.log('  Enter the same passphrase you used before.\n');
      const passphrase = await promptPassphrase('Enter cloud passphrase: ');
      const salt = Buffer.from(user.encryption_salt, 'hex');
      const key = deriveKey(passphrase, salt);

      // We can't verify without a verifier, just save it
      const verifier = encrypt(Buffer.from('codedash-verify'), key);
      saveCloudKey({ salt: salt.toString('hex'), verifier: verifier.toString('hex') });
      console.log('  Encryption configured (synced from cloud).\n');
      return;
    }

    await ensureEncryptionKey(user);
    return;
  }

  if (action === 'push') {
    const { profile, user } = await ensureAuth();
    const key = await ensureEncryptionKey(user);

    const { loadSessions } = require('./data');
    const sessions = loadSessions();
    const target = args[1];

    if (target === '--all') {
      const ids = Object.keys(sessions);
      console.log(`\n  Uploading ${ids.length} sessions...\n`);
      let ok = 0, skip = 0, fail = 0;
      for (const id of ids) {
        const result = await pushOne(id, sessions, key, profile.token);
        if (result === 'ok') ok++;
        else if (result === 'skip') skip++;
        else fail++;
        process.stdout.write(`\r  Progress: ${ok + skip + fail}/${ids.length} (${ok} uploaded, ${skip} skipped, ${fail} failed)`);
      }
      console.log(`\n\n  Done: ${ok} uploaded, ${skip} unchanged, ${fail} failed\n`);
      return;
    }

    if (!target) {
      console.error('  Usage: codedash cloud push <session-id> or --all\n');
      process.exit(1);
    }

    // Find session by prefix match
    const match = Object.keys(sessions).find(id => id.startsWith(target));
    if (!match) {
      console.error(`  Session not found: ${target}\n`);
      process.exit(1);
    }

    const result = await pushOne(match, sessions, key, profile.token);
    if (result === 'ok') console.log(`  Uploaded: ${match}\n`);
    else if (result === 'skip') console.log(`  Already up to date: ${match}\n`);
    else console.error(`  Failed to upload: ${match}\n`);
    return;
  }

  if (action === 'pull') {
    const { profile, user } = await ensureAuth();
    const key = await ensureEncryptionKey(user);
    const target = args[1];

    if (target === '--all') {
      const res = await cloudRequest('GET', '/api/sessions?limit=500', profile.token);
      if (res.status !== 200) { console.error('  Failed to list sessions\n'); return; }
      const remoteSessions = res.data.sessions || [];
      console.log(`\n  Downloading ${remoteSessions.length} sessions...\n`);
      let ok = 0, skip = 0, fail = 0;
      for (const rs of remoteSessions) {
        const result = await pullOne(rs.session_id, key, profile.token);
        if (result === 'ok') ok++;
        else if (result === 'skip') skip++;
        else fail++;
        process.stdout.write(`\r  Progress: ${ok + skip + fail}/${remoteSessions.length} (${ok} downloaded, ${skip} skipped, ${fail} failed)`);
      }
      console.log(`\n\n  Done: ${ok} downloaded, ${skip} already exist, ${fail} failed\n`);
      return;
    }

    if (!target) {
      console.error('  Usage: codedash cloud pull <session-id> or --all\n');
      process.exit(1);
    }

    const result = await pullOne(target, key, profile.token);
    if (result === 'ok') console.log(`  Downloaded: ${target}\n`);
    else if (result === 'skip') console.log(`  Already exists locally: ${target}\n`);
    else console.error(`  Failed to download: ${target}\n`);
    return;
  }

  if (action === 'list') {
    const { profile } = await ensureAuth();
    const agentFilter = args[1] ? `?agent=${args[1]}` : '';
    const res = await cloudRequest('GET', `/api/sessions${agentFilter}&limit=100`, profile.token);
    if (res.status !== 200) { console.error('  Failed to list\n'); return; }

    const { sessions, total } = res.data;
    console.log(`\n  Cloud Sessions (${total} total)\n`);
    if (sessions.length === 0) {
      console.log('  No sessions in cloud yet. Use: codedash cloud push <id>\n');
      return;
    }

    for (const s of sessions) {
      const date = s.last_ts ? new Date(s.last_ts).toISOString().slice(0, 16).replace('T', ' ') : '?';
      const size = s.blob_size ? `${(s.blob_size / 1024).toFixed(0)}KB` : '?';
      console.log(`  ${s.agent.padEnd(8)} ${date}  ${String(s.message_count).padStart(4)} msgs  ${size.padStart(6)}  ${s.session_id.slice(0, 12)}  ${(s.project_short || '').slice(0, 40)}`);
    }
    console.log();
    return;
  }

  if (action === 'delete') {
    const target = args[1];
    if (!target) { console.error('  Usage: codedash cloud delete <session-id>\n'); return; }
    const { profile } = await ensureAuth();
    const res = await cloudRequest('DELETE', `/api/sessions/${encodeURIComponent(target)}`, profile.token);
    if (res.status === 200) console.log(`  Deleted: ${target}\n`);
    else console.error(`  Failed: ${res.data?.error || res.status}\n`);
    return;
  }

  if (action === 'status') {
    const { profile, user } = await ensureAuth();
    const res = await cloudRequest('GET', '/api/sessions/stats', profile.token);
    if (res.status !== 200) { console.error('  Failed to get stats\n'); return; }
    const { total_sessions, total_size, by_agent } = res.data;
    console.log(`\n  Cloud Status for @${user.username}`);
    console.log(`  Sessions: ${total_sessions}`);
    console.log(`  Total size: ${(total_size / 1024 / 1024).toFixed(1)} MB`);
    if (by_agent && Object.keys(by_agent).length > 0) {
      console.log(`  By agent: ${Object.entries(by_agent).map(([a, c]) => `${a}: ${c}`).join(', ')}`);
    }
    console.log();
    return;
  }

  console.error(`  Unknown command: cloud ${action}. Run: codedash cloud help\n`);
}

// ── Push / Pull helpers ──────────────────────

async function pushOne(sessionId, sessions, key, token) {
  try {
    const canonical = serializeSession(sessionId, sessions);
    if (!canonical) return 'fail';

    const blob = encryptSession(canonical, key);
    const checksum = crypto.createHash('sha256').update(blob).digest('hex');

    const res = await cloudRequest('POST', '/api/sessions/upload', token, blob, {
      'Content-Type': 'application/octet-stream',
      'X-Session-Id': sessionId,
      'X-Agent': canonical.agent,
      'X-Project-Short': encodeURIComponent(canonical.projectShort || ''),
      'X-First-Message': encodeURIComponent((canonical.firstMessage || '').slice(0, 200)),
      'X-First-Ts': String(canonical.firstTs || 0),
      'X-Last-Ts': String(canonical.lastTs || 0),
      'X-Message-Count': String(canonical.messageCount || 0),
      'X-Checksum': checksum,
    });

    if (res.status === 200) return 'ok';
    if (res.status === 429) {
      // Wait and retry once
      const wait = (res.data?.retryAfter || 5) * 1000;
      await new Promise(r => setTimeout(r, wait));
      const retry = await cloudRequest('POST', '/api/sessions/upload', token, blob, {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': sessionId,
        'X-Agent': canonical.agent,
        'X-Project-Short': encodeURIComponent(canonical.projectShort || ''),
        'X-First-Message': encodeURIComponent((canonical.firstMessage || '').slice(0, 200)),
        'X-First-Ts': String(canonical.firstTs || 0),
        'X-Last-Ts': String(canonical.lastTs || 0),
        'X-Message-Count': String(canonical.messageCount || 0),
        'X-Checksum': checksum,
      });
      return retry.status === 200 ? 'ok' : 'fail';
    }
    return 'fail';
  } catch (e) {
    return 'fail';
  }
}

async function pullOne(sessionId, key, token) {
  try {
    // Check if already exists locally
    const { findSessionFile } = require('./data');
    const existing = findSessionFile(sessionId);
    if (existing) return 'skip';

    const res = await cloudRequest('GET', `/api/sessions/${encodeURIComponent(sessionId)}/download`, token);
    if (res.status !== 200) return 'fail';

    const blob = res.data; // Buffer
    const canonical = decryptSession(blob, key);
    const result = deserializeSession(canonical);
    return result.skipped ? 'skip' : 'ok';
  } catch {
    return 'fail';
  }
}

// ── Server-side helpers (for dashboard proxy) ─

function getCloudAPI() { return CLOUD_API; }

module.exports = {
  cloudCLI,
  encrypt,
  decrypt,
  deriveKey,
  serializeSession,
  encryptSession,
  decryptSession,
  deserializeSession,
  loadCloudKey,
  saveCloudKey,
  loadProfile,
  cloudRequest,
  getCloudAPI,
  CLOUD_API,
};
