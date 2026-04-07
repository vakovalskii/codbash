const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');

// ── Constants ──────────────────────────────────────────────

// Detect WSL and find Windows user home for cross-OS data access
function detectHomes() {
  const homes = [os.homedir()];
  // WSL: also check Windows-side home dirs
  if (process.platform === 'linux' && fs.existsSync('/mnt/c/Users')) {
    try {
      const winUser = execSync('cmd.exe /C "echo %USERPROFILE%" 2>/dev/null', { encoding: 'utf8', timeout: 3000 }).trim();
      if (winUser && winUser.includes('\\')) {
        // Convert C:\Users\foo to /mnt/c/Users/foo
        const drive = winUser[0].toLowerCase();
        const winPath = '/mnt/' + drive + winUser.slice(2).replace(/\\/g, '/');
        if (fs.existsSync(winPath) && !homes.includes(winPath)) {
          homes.push(winPath);
        }
      }
    } catch {
      // Fallback: scan /mnt/c/Users/ for directories with .claude
      try {
        for (const u of fs.readdirSync('/mnt/c/Users')) {
          const candidate = '/mnt/c/Users/' + u;
          if (fs.existsSync(path.join(candidate, '.claude'))) {
            if (!homes.includes(candidate)) homes.push(candidate);
          }
        }
      } catch {}
    }
  }
  return homes;
}

const ALL_HOMES = detectHomes();
const IS_WSL = ALL_HOMES.length > 1;

const CLAUDE_DIR = path.join(ALL_HOMES[0], '.claude');
const CODEX_DIR = path.join(ALL_HOMES[0], '.codex');
const OPENCODE_DB = path.join(ALL_HOMES[0], '.local', 'share', 'opencode', 'opencode.db');
const KIRO_DB = path.join(ALL_HOMES[0], 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3');
const CURSOR_DIR = path.join(ALL_HOMES[0], '.cursor');
const CURSOR_PROJECTS = path.join(CURSOR_DIR, 'projects');
const CURSOR_CHATS = path.join(CURSOR_DIR, 'chats');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// On WSL, collect all alternative data dirs
const EXTRA_CLAUDE_DIRS = ALL_HOMES.slice(1).map(h => path.join(h, '.claude')).filter(d => fs.existsSync(d));
const EXTRA_CODEX_DIRS = ALL_HOMES.slice(1).map(h => path.join(h, '.codex')).filter(d => fs.existsSync(d));
const EXTRA_CURSOR_DIRS = ALL_HOMES.slice(1).map(h => path.join(h, '.cursor')).filter(d => fs.existsSync(d));

// Extra OpenCode/Kiro DBs on Windows side
const EXTRA_OPENCODE_DBS = ALL_HOMES.slice(1).map(h => path.join(h, 'AppData', 'Local', 'opencode', 'opencode.db')).filter(d => fs.existsSync(d));
const EXTRA_KIRO_DBS = ALL_HOMES.slice(1).map(h => path.join(h, 'AppData', 'Roaming', 'kiro-cli', 'data.sqlite3')).filter(d => fs.existsSync(d));

if (IS_WSL) {
  console.log('  \x1b[36m[WSL]\x1b[0m Detected Windows homes:', ALL_HOMES.slice(1).join(', '));
  if (EXTRA_CLAUDE_DIRS.length) console.log('  \x1b[36m[WSL]\x1b[0m Extra Claude dirs:', EXTRA_CLAUDE_DIRS.join(', '));
  if (EXTRA_CODEX_DIRS.length) console.log('  \x1b[36m[WSL]\x1b[0m Extra Codex dirs:', EXTRA_CODEX_DIRS.join(', '));
  if (EXTRA_CURSOR_DIRS.length) console.log('  \x1b[36m[WSL]\x1b[0m Extra Cursor dirs:', EXTRA_CURSOR_DIRS.join(', '));
}

// ── Helpers ────────────────────────────────────────────────

// Read file lines handling \r\n (Windows/WSL)
function readLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split('\n').map(l => l.replace(/\r$/, '')).filter(Boolean);
}

function parseClaudeSessionFile(sessionFile) {
  if (!fs.existsSync(sessionFile)) return null;

  let stat;
  let lines;
  try {
    stat = fs.statSync(sessionFile);
    lines = readLines(sessionFile);
  } catch {
    return null;
  }
  let projectPath = '';
  let tool = 'claude';
  let msgCount = 0;
  let firstMsg = '';
  let customTitle = '';
  let firstTs = stat.mtimeMs;
  let lastTs = stat.mtimeMs;
  let entrypointFound = false;
  let worktreeOriginalCwd = '';

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' || entry.type === 'assistant') msgCount++;
      if (entry.timestamp) {
        if (entry.timestamp < firstTs) firstTs = entry.timestamp;
        if (entry.timestamp > lastTs) lastTs = entry.timestamp;
      }
      if (!projectPath && entry.type === 'user' && entry.cwd) {
        projectPath = entry.cwd;
      }
      // worktree-state is written by Claude Code when a session runs inside a git worktree.
      // originalCwd is the main checkout directory — safe to use in containers (no git needed).
      if (!worktreeOriginalCwd && entry.type === 'worktree-state' && entry.worktreeSession && entry.worktreeSession.originalCwd) {
        worktreeOriginalCwd = entry.worktreeSession.originalCwd;
      }
      if (!entrypointFound && entry.type === 'user' && entry.entrypoint) {
        entrypointFound = true;
        if (entry.entrypoint !== 'cli') tool = 'claude-ext';
      }
      if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
        const title = entry.customTitle.trim();
        if (title) customTitle = title.slice(0, 200);
      }
      if (!firstMsg && entry.type === 'user' && entry.message && entry.message.content) {
        const content = extractContent(entry.message.content).trim();
        if (content) firstMsg = content.slice(0, 200);
      }
    } catch {}
  }

  return {
    projectPath,
    tool,
    msgCount,
    firstMsg,
    customTitle,
    firstTs,
    lastTs,
    fileSize: stat.size,
    worktreeOriginalCwd,
  };
}

function mergeClaudeSessionDetail(session, summary, sessionFile) {
  if (!session || !summary) return;

  session.tool = summary.tool || session.tool;
  session.has_detail = true;
  session.file_size = summary.fileSize;
  session.detail_messages = summary.msgCount;
  session._session_file = sessionFile;

  if (!session.project && summary.projectPath) {
    session.project = summary.projectPath;
    session.project_short = summary.projectPath.replace(os.homedir(), '~');
  }

  if (summary.worktreeOriginalCwd) {
    session.worktree_original_cwd = summary.worktreeOriginalCwd;
  }

  if (summary.customTitle) {
    session.first_message = summary.customTitle;
  }
}

function parseCodexSessionIndex(codexDir) {
  const titles = {};
  const titleMeta = {};
  const indexFile = path.join(codexDir, 'session_index.jsonl');
  if (!fs.existsSync(indexFile)) return titles;

  const parseUpdatedAt = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return NaN;
      if (/^\d+$/.test(trimmed)) return Number(trimmed);
      return Date.parse(trimmed);
    }
    return NaN;
  };

  let lines;
  try {
    lines = readLines(indexFile);
  } catch {
    return titles;
  }

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const sid = entry.id || entry.session_id || entry.sessionId;
      if (!sid || typeof entry.thread_name !== 'string') continue;
      const title = entry.thread_name.trim();
      if (!title) continue;

      const updatedAt = parseUpdatedAt(entry.updated_at);
      const hasUpdatedAt = Number.isFinite(updatedAt);
      const existing = titleMeta[sid];

      if (!existing) {
        titles[sid] = title.slice(0, 200);
        titleMeta[sid] = { updatedAt, hasUpdatedAt };
        continue;
      }

      if (
        (hasUpdatedAt && !existing.hasUpdatedAt) ||
        (hasUpdatedAt && existing.hasUpdatedAt && updatedAt >= existing.updatedAt) ||
        (!hasUpdatedAt && !existing.hasUpdatedAt)
      ) {
        titles[sid] = title.slice(0, 200);
        titleMeta[sid] = { updatedAt, hasUpdatedAt };
      }
    } catch {}
  }

  return titles;
}

function scanOpenCodeSessions() {
  const sessions = [];
  if (!fs.existsSync(OPENCODE_DB)) return sessions;

  try {
    // Use sqlite3 CLI with tab separator — session titles can contain pipes
    // (e.g. "review changes [commit|branch|pr]") which break the default | separator
    const rows = execFileSync('sqlite3', [
      '-separator', '\t',
      OPENCODE_DB,
      'SELECT s.id, s.title, s.directory, s.time_created, s.time_updated, COUNT(m.id) as msg_count FROM session s LEFT JOIN message m ON m.session_id = s.id GROUP BY s.id ORDER BY s.time_updated DESC'
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();

    if (!rows) return sessions;

    for (const row of rows.split('\n')) {
      const parts = row.split('\t');
      if (parts.length < 6) continue;
      const [id, title, directory, timeCreated, timeUpdated, msgCount] = parts;

      sessions.push({
        id: id,
        tool: 'opencode',
        project: directory || '',
        project_short: (directory || '').replace(os.homedir(), '~'),
        first_ts: parseInt(timeCreated) || Date.now(),
        last_ts: parseInt(timeUpdated) || Date.now(),
        messages: parseInt(msgCount) || 0,
        first_message: title || '',
        has_detail: true,
        file_size: 0,
        detail_messages: parseInt(msgCount) || 0,
      });
    }
  } catch {}

  return sessions;
}

function loadOpenCodeDetail(sessionId) {
  if (!fs.existsSync(OPENCODE_DB)) return { messages: [] };

  try {
    // Get messages with parts joined
    const rows = execFileSync('sqlite3', [
      OPENCODE_DB,
      `SELECT m.data, GROUP_CONCAT(p.data, '|||') FROM message m LEFT JOIN part p ON p.message_id = m.id WHERE m.session_id = '${sessionId.replace(/'/g, "''")}' GROUP BY m.id ORDER BY m.time_created`
    ], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();

    if (!rows) return { messages: [] };

    const messages = [];
    for (const row of rows.split('\n')) {
      const sepIdx = row.indexOf('|');
      if (sepIdx < 0) continue;

      // Parse message data (first column)
      // Find the JSON boundary - message data ends where part data starts
      let msgJson, partsRaw;
      try {
        // Try to find where message JSON ends
        let braceCount = 0;
        let jsonEnd = 0;
        for (let i = 0; i < row.length; i++) {
          if (row[i] === '{') braceCount++;
          if (row[i] === '}') { braceCount--; if (braceCount === 0) { jsonEnd = i + 1; break; } }
        }
        msgJson = row.slice(0, jsonEnd);
        partsRaw = row.slice(jsonEnd + 1); // skip |
      } catch { continue; }

      let msgData;
      try { msgData = JSON.parse(msgJson); } catch { continue; }

      const role = msgData.role;
      if (role !== 'user' && role !== 'assistant') continue;

      // Extract text from parts
      let content = '';
      if (partsRaw) {
        for (const partStr of partsRaw.split('|||')) {
          try {
            const part = JSON.parse(partStr);
            if (part.type === 'text' && part.text) {
              content += part.text + '\n';
            }
          } catch {}
        }
      }

      content = content.trim();
      if (!content) continue;

      const tokens = msgData.tokens || {};

      messages.push({
        role: role,
        content: content.slice(0, 2000),
        uuid: '',
        model: msgData.modelID || msgData.model?.modelID || '',
        tokens: tokens,
      });
    }

    return { messages: messages.slice(0, 200) };
  } catch {
    return { messages: [] };
  }
}

function scanKiroSessions() {
  const sessions = [];
  if (!fs.existsSync(KIRO_DB)) return sessions;

  try {
    const rows = execFileSync('sqlite3', [
      '-separator', '\t',
      KIRO_DB,
      'SELECT key, conversation_id, created_at, updated_at, substr(value, 1, 500), length(value) FROM conversations_v2 ORDER BY updated_at DESC'
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();

    if (!rows) return sessions;

    for (const row of rows.split('\n')) {
      const parts = row.split('\t');
      if (parts.length < 5) continue;
      const [directory, convId, createdAt, updatedAt, valuePeek, valueLen] = parts;

      // Extract first user prompt and estimate message count from JSON peek
      let firstMsg = '';
      let msgCount = 0;
      try {
        const promptMatch = valuePeek.match(/"prompt":"([^"]{1,100})"/);
        if (promptMatch) firstMsg = promptMatch[1];
        // Count "prompt" occurrences as rough message estimate (each turn has user+assistant)
        const promptCount = (valuePeek.match(/"prompt"/g) || []).length;
        msgCount = promptCount * 2; // user + assistant per turn
        if (msgCount === 0 && parseInt(valueLen) > 100) msgCount = Math.max(2, Math.floor(parseInt(valueLen) / 2000));
      } catch {}

      sessions.push({
        id: convId,
        tool: 'kiro',
        project: directory || '',
        project_short: (directory || '').replace(os.homedir(), '~'),
        first_ts: parseInt(createdAt) || Date.now(),
        last_ts: parseInt(updatedAt) || Date.now(),
        messages: msgCount,
        first_message: firstMsg,
        has_detail: true,
        file_size: parseInt(valueLen) || 0,
        detail_messages: msgCount,
      });
    }
  } catch {}

  return sessions;
}

function loadKiroDetail(conversationId) {
  if (!fs.existsSync(KIRO_DB)) return { messages: [] };

  try {
    const raw = execFileSync('sqlite3', [
      KIRO_DB,
      `SELECT value FROM conversations_v2 WHERE conversation_id = '${conversationId.replace(/'/g, "''")}';`
    ], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();

    if (!raw) return { messages: [] };

    const data = JSON.parse(raw);
    const messages = [];

    for (const entry of (data.history || [])) {
      if (entry.user) {
        const prompt = (entry.user.content || {}).Prompt || {};
        const text = prompt.prompt || '';
        if (text) messages.push({ role: 'user', content: text.slice(0, 2000), uuid: '' });
      }
      if (entry.assistant) {
        const resp = entry.assistant.Response || entry.assistant.response || {};
        const text = resp.content || '';
        if (text) messages.push({ role: 'assistant', content: text.slice(0, 2000), uuid: resp.message_id || '' });
      }
    }

    return { messages: messages.slice(0, 200) };
  } catch {
    return { messages: [] };
  }
}

// Cursor stores each workspace under ~/.cursor/projects/<key>/ where <key> is the
// absolute path with / and . replaced by -. Hyphens inside a directory name are
// preserved, so splitting <key> on "-" cannot recover the path. Decode by
// greedily matching the longest real child directory name at each level.
function decodeCursorProjectFolderKey(proj) {
  if (!proj) return '';
  let enc = proj;
  let cwd = '';
  while (enc.length > 0) {
    const parent = cwd || '/';
    let dirs;
    try {
      dirs = fs.readdirSync(parent, { withFileTypes: true })
        .filter(function (e) { return e.isDirectory(); })
        .map(function (e) { return e.name; });
    } catch {
      return cwd || ('/' + proj.replace(/-/g, '/'));
    }
    dirs.sort(function (a, b) { return b.length - a.length; });
    var matched = null;
    for (var j = 0; j < dirs.length; j++) {
      var d = dirs[j];
      // Cursor encodes both / and . as -, so compare against encoded dir name
      var encoded = d.replace(/[^a-zA-Z0-9-]/g, '-');
      if (enc === encoded || (enc.startsWith(encoded) && (enc.length === encoded.length || enc[encoded.length] === '-'))) {
        matched = d;
        break;
      }
    }
    if (!matched) {
      var idx = enc.indexOf('-');
      var part = idx === -1 ? enc : enc.slice(0, idx);
      var next = cwd ? path.join(cwd, part) : path.join('/', part);
      if (fs.existsSync(next)) {
        cwd = next;
        enc = idx === -1 ? '' : enc.slice(idx + 1);
      } else {
        return cwd || ('/' + proj.replace(/-/g, '/'));
      }
      continue;
    }
    cwd = cwd ? path.join(cwd, matched) : path.join('/', matched);
    enc = enc.length === matched.length ? '' : enc.slice(matched.length + 1);
  }
  return cwd;
}

function scanCursorSessions() {
  const sessions = [];

  // Scan ~/.cursor/projects/*/agent-transcripts/*/*.jsonl
  if (fs.existsSync(CURSOR_PROJECTS)) {
    try {
      for (const proj of fs.readdirSync(CURSOR_PROJECTS)) {
        const transcriptsDir = path.join(CURSOR_PROJECTS, proj, 'agent-transcripts');
        if (!fs.existsSync(transcriptsDir)) continue;

        const projectPath = decodeCursorProjectFolderKey(proj) || ('/' + proj.replace(/-/g, '/'));

        for (const sessDir of fs.readdirSync(transcriptsDir)) {
          const sessFile = path.join(transcriptsDir, sessDir, sessDir + '.jsonl');
          if (!fs.existsSync(sessFile)) continue;

          const stat = fs.statSync(sessFile);
          let firstMsg = '';
          let msgCount = 0;
          try {
            const firstLine = fs.readFileSync(sessFile, 'utf8').split('\n')[0].replace(/\r$/, '');
            const d = JSON.parse(firstLine);
            const content = (d.message || {}).content;
            if (Array.isArray(content)) {
              for (const part of content) {
                if (part.type === 'text' && part.text) {
                  // Strip <user_query> wrapper
                  firstMsg = part.text.replace(/<\/?user_query>/g, '').trim().slice(0, 200);
                  break;
                }
              }
            }
            // Count lines
            msgCount = readLines(sessFile).length;
          } catch {}

          sessions.push({
            id: sessDir,
            tool: 'cursor',
            project: projectPath,
            project_short: projectPath.replace(os.homedir(), '~'),
            first_ts: stat.mtimeMs - (msgCount * 60000), // rough estimate
            last_ts: stat.mtimeMs,
            messages: msgCount,
            first_message: firstMsg,
            has_detail: true,
            file_size: stat.size,
            detail_messages: msgCount,
            _file: sessFile,
          });
        }
      }
    } catch {}
  }

  // Also scan ~/.cursor/chats/*/ (Linux format)
  if (fs.existsSync(CURSOR_CHATS)) {
    try {
      for (const chatDir of fs.readdirSync(CURSOR_CHATS)) {
        const fullDir = path.join(CURSOR_CHATS, chatDir);
        if (!fs.statSync(fullDir).isDirectory()) continue;

        // Look for .jsonl or .json inside
        for (const f of fs.readdirSync(fullDir)) {
          if (!f.endsWith('.jsonl') && !f.endsWith('.json')) continue;
          const filePath = path.join(fullDir, f);
          const stat = fs.statSync(filePath);

          let firstMsg = '';
          let msgCount = 0;
          try {
            const firstLine = fs.readFileSync(filePath, 'utf8').split('\n')[0].replace(/\r$/, '');
            const d = JSON.parse(firstLine);
            if (d.role === 'user') {
              const content = (d.message || {}).content || d.content;
              if (typeof content === 'string') firstMsg = content.slice(0, 200);
              else if (Array.isArray(content)) {
                for (const p of content) {
                  if (p.text) { firstMsg = p.text.replace(/<\/?user_query>/g, '').trim().slice(0, 200); break; }
                }
              }
            }
            msgCount = readLines(filePath).length;
          } catch {}

          sessions.push({
            id: chatDir,
            tool: 'cursor',
            project: '',
            project_short: '',
            first_ts: stat.mtimeMs - (msgCount * 60000),
            last_ts: stat.mtimeMs,
            messages: msgCount,
            first_message: firstMsg,
            has_detail: true,
            file_size: stat.size,
            detail_messages: msgCount,
            _file: filePath,
          });
          break; // one file per chat dir
        }
      }
    } catch {}
  }

  return sessions;
}

function loadCursorDetail(sessionId) {
  // Find the file
  let filePath = null;

  // Search in projects
  if (fs.existsSync(CURSOR_PROJECTS)) {
    for (const proj of fs.readdirSync(CURSOR_PROJECTS)) {
      const f = path.join(CURSOR_PROJECTS, proj, 'agent-transcripts', sessionId, sessionId + '.jsonl');
      if (fs.existsSync(f)) { filePath = f; break; }
    }
  }

  // Search in chats
  if (!filePath && fs.existsSync(CURSOR_CHATS)) {
    const chatDir = path.join(CURSOR_CHATS, sessionId);
    if (fs.existsSync(chatDir)) {
      for (const f of fs.readdirSync(chatDir)) {
        if (f.endsWith('.jsonl') || f.endsWith('.json')) {
          filePath = path.join(chatDir, f);
          break;
        }
      }
    }
  }

  if (!filePath) return { messages: [] };

  const messages = [];
  const lines = readLines(filePath);

  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      const role = d.role;
      if (role !== 'user' && role !== 'assistant') continue;

      const content = (d.message || {}).content || d.content || '';
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter(function(p) { return p.type === 'text' && p.text; })
          .map(function(p) { return p.text; })
          .join('\n');
      }

      // Strip Cursor wrappers
      text = text.replace(/<\/?user_query>/g, '').replace(/<\/?tool_call>/g, '').trim();
      if (!text) continue;

      messages.push({ role: role, content: text.slice(0, 2000), uuid: '' });
    } catch {}
  }

  return { messages: messages.slice(0, 200) };
}

function parseCodexSessionFile(sessionFile) {
  if (!fs.existsSync(sessionFile)) return null;

  let stat;
  let lines;
  try {
    stat = fs.statSync(sessionFile);
    lines = readLines(sessionFile);
  } catch {
    return null;
  }

  const parseTimestamp = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return NaN;
      if (/^\d+$/.test(trimmed)) return Number(trimmed);
      return Date.parse(trimmed);
    }
    return NaN;
  };

  let projectPath = '';
  let msgCount = 0;
  let firstMsg = '';
  let firstTs = stat.mtimeMs;
  let lastTs = stat.mtimeMs;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const ts = parseTimestamp(entry.timestamp || entry.ts);
      if (Number.isFinite(ts)) {
        if (ts < firstTs) firstTs = ts;
        if (ts > lastTs) lastTs = ts;
      }

      if (entry.type === 'session_meta' && entry.payload && entry.payload.cwd && !projectPath) {
        projectPath = entry.payload.cwd;
        continue;
      }

      if (entry.type !== 'response_item' || !entry.payload) continue;
      const role = entry.payload.role;
      if (role !== 'user' && role !== 'assistant') continue;

      const content = extractContent(entry.payload.content);
      if (!content || isSystemMessage(content)) continue;

      msgCount++;
      if (!firstMsg) firstMsg = content.slice(0, 200);
    } catch {}
  }

  return {
    projectPath,
    msgCount,
    firstMsg,
    firstTs,
    lastTs,
    fileSize: stat.size,
  };
}

function scanCodexSessions() {
  const sessions = [];
  const codexTitles = parseCodexSessionIndex(CODEX_DIR);
  const codexHistory = path.join(CODEX_DIR, 'history.jsonl');
  if (fs.existsSync(codexHistory)) {
    const lines = readLines(codexHistory);
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        // Codex uses session_id, ts (seconds), text
        const sid = d.session_id || d.sessionId || d.id;
        if (!sid) continue;
        const ts = d.ts ? d.ts * 1000 : (d.timestamp || Date.now());
        if (!sessions.find(s => s.id === sid)) {
          sessions.push({
            id: sid,
            tool: 'codex',
            project: d.project || d.cwd || '',
            project_short: (d.project || d.cwd || '').replace(os.homedir(), '~'),
            first_ts: ts,
            last_ts: ts,
            messages: 1,
            first_message: codexTitles[sid] || d.text || d.display || d.prompt || '',
            has_detail: false,
            file_size: 0,
            detail_messages: 0,
          });
        }
      } catch {}
    }
  }

  // Enrich with session files from ~/.codex/sessions/
  const codexSessionsDir = path.join(CODEX_DIR, 'sessions');
  if (fs.existsSync(codexSessionsDir)) {
    try {
      // Walk year/month/day directories
      const files = [];
      const walkDir = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walkDir(full);
          else if (entry.name.endsWith('.jsonl')) files.push(full);
        }
      };
      walkDir(codexSessionsDir);

      for (const f of files) {
        // Extract session ID from filename (rollout-DATE-UUID.jsonl)
        const basename = path.basename(f, '.jsonl');
        const uuidMatch = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
        if (!uuidMatch) continue;
        const sid = uuidMatch[1];
        const summary = parseCodexSessionFile(f);
        if (!summary) continue;

        const existing = sessions.find(s => s.id === sid);
        if (existing) {
          existing.has_detail = true;
          existing.file_size = summary.fileSize;
          existing.messages = summary.msgCount;
          existing.detail_messages = summary.msgCount;
          if (codexTitles[sid]) {
            existing.first_message = codexTitles[sid];
          } else if (summary.firstMsg && !existing.first_message) {
            existing.first_message = summary.firstMsg;
          }
          if (summary.projectPath && !existing.project) {
            existing.project = summary.projectPath;
            existing.project_short = summary.projectPath.replace(os.homedir(), '~');
          }
          existing.first_ts = Math.min(existing.first_ts, summary.firstTs);
          existing.last_ts = Math.max(existing.last_ts, summary.lastTs);
        } else {
          sessions.push({
            id: sid,
            tool: 'codex',
            project: summary.projectPath,
            project_short: summary.projectPath ? summary.projectPath.replace(os.homedir(), '~') : '',
            first_ts: summary.firstTs,
            last_ts: summary.lastTs,
            messages: summary.msgCount,
            first_message: codexTitles[sid] || summary.firstMsg || '',
            has_detail: true,
            file_size: summary.fileSize,
            detail_messages: summary.msgCount,
          });
        }
      }
    } catch {}
  }

  return sessions;
}

// ── Git root resolver ───────────────────────────────────────
//
// Priority order for determining the git root of a session:
//   1. worktree-state.originalCwd — written by Claude Code into the JSONL when
//      the session runs inside a git worktree. Container-safe: no git required.
//   2. git rev-parse --show-toplevel — resolves the root at runtime. Fails
//      gracefully (returns '') in containerized setups where git repos are not
//      mounted; the try/catch ensures it never crashes the server.
//   3. Path heuristic in the frontend (getGitProjectName) — parses /.claude/worktrees/
//      from the session cwd string. Works without git for standard worktree layouts.

const _gitRootCache = {};

function resolveGitRoot(projectPath) {
  if (!projectPath) return '';
  if (_gitRootCache[projectPath] !== undefined) return _gitRootCache[projectPath];
  try {
    const root = execFileSync('git', ['-C', projectPath, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    _gitRootCache[projectPath] = root;
    return root;
  } catch {
    // git not available or project path not mounted (e.g. containerised env) — fall back gracefully
    _gitRootCache[projectPath] = '';
    return '';
  }
}

const _gitInfoCache = {};
const GIT_INFO_CACHE_TTL = 30000; // 30 seconds

function getProjectGitInfo(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) return null;
  if (process.platform === 'win32') return null;

  const now = Date.now();
  const cached = _gitInfoCache[projectPath];
  if (cached && (now - cached._ts) < GIT_INFO_CACHE_TTL) return cached;

  const gitRoot = resolveGitRoot(projectPath);
  if (!gitRoot) return null;

  const cwd = gitRoot;
  const opts = { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
  const info = { gitRoot, branch: '', remoteUrl: '', lastCommit: '', lastCommitDate: '', isDirty: false, _ts: now };

  try { info.branch = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], opts).trim(); } catch {}
  try { info.remoteUrl = execFileSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], opts).trim(); } catch {}
  try {
    const log = execFileSync('git', ['-C', cwd, 'log', '-1', '--format=%h %s'], opts).trim();
    if (log) {
      const sp = log.indexOf(' ');
      info.lastCommit = sp > 0 ? log.slice(sp + 1).slice(0, 80) : log;
      info.lastCommitHash = sp > 0 ? log.slice(0, sp) : '';
    }
  } catch {}
  try { info.lastCommitDate = execFileSync('git', ['-C', cwd, 'log', '-1', '--format=%ci'], opts).trim(); } catch {}
  try {
    const status = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], opts).trim();
    info.isDirty = status.length > 0;
  } catch {}

  _gitInfoCache[projectPath] = info;
  return info;
}

// ── Public API ─────────────────────────────────────────────

let _sessionsCache = null;
let _sessionsCacheTs = 0;
const SESSIONS_CACHE_TTL = 10000; // 10 seconds

function loadSessions() {
  const now = Date.now();
  if (_sessionsCache && (now - _sessionsCacheTs) < SESSIONS_CACHE_TTL) {
    return _sessionsCache;
  }
  const sessions = {};

  // Load Claude Code sessions
  if (fs.existsSync(HISTORY_FILE)) {
    const lines = readLines(HISTORY_FILE);
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        const sid = d.sessionId;
        if (!sid) continue;

        if (!sessions[sid]) {
          sessions[sid] = {
            id: sid,
            tool: 'claude',
            project: d.project || '',
            project_short: (d.project || '').replace(os.homedir(), '~'),
            first_ts: d.timestamp,
            last_ts: d.timestamp,
            messages: 0,
            first_message: '',
            _claude_dir: CLAUDE_DIR,
          };
        }

        const s = sessions[sid];
        s.last_ts = Math.max(s.last_ts, d.timestamp);
        s.first_ts = Math.min(s.first_ts, d.timestamp);
        s.messages++;

        if (d.display && d.display !== 'exit' && !s.first_message) {
          s.first_message = d.display.slice(0, 200);
        }
      } catch {}
    }
  }

  // Load Codex sessions
  if (fs.existsSync(CODEX_DIR)) {
    try {
      const codexSessions = scanCodexSessions();
      for (const cs of codexSessions) {
        sessions[cs.id] = cs;
      }
    } catch {}
  }

  // Load OpenCode sessions
  try {
    const opencodeSessions = scanOpenCodeSessions();
    for (const ocs of opencodeSessions) {
      sessions[ocs.id] = ocs;
    }
  } catch {}

  // Load Cursor sessions
  try {
    const cursorSessions = scanCursorSessions();
    for (const cs of cursorSessions) {
      sessions[cs.id] = cs;
    }
  } catch {}

  // Load Kiro sessions
  try {
    const kiroSessions = scanKiroSessions();
    for (const ks of kiroSessions) {
      sessions[ks.id] = ks;
    }
  } catch {}

  // WSL: also load from Windows-side dirs
  for (const extraClaudeDir of EXTRA_CLAUDE_DIRS) {
    try {
      const extraHistory = path.join(extraClaudeDir, 'history.jsonl');
      if (fs.existsSync(extraHistory)) {
        const lines = readLines(extraHistory);
        for (const line of lines) {
          let d;
          try {
            d = JSON.parse(line);
            const sid = d.sessionId;
            if (!sid) continue;
            if (!sessions[sid]) {
              sessions[sid] = {
                id: sid, tool: 'claude',
                project: d.project || '', project_short: (d.project || '').replace(os.homedir(), '~'),
                first_ts: d.timestamp, last_ts: d.timestamp,
                messages: 0, first_message: '',
                _claude_dir: extraClaudeDir,
              };
            }
          } catch {}
          if (!d || !d.sessionId) continue;
          const s = sessions[d.sessionId];
          if (s) { s.last_ts = Math.max(s.last_ts, d.timestamp); s.first_ts = Math.min(s.first_ts, d.timestamp); s.messages++; if (d.display && d.display !== 'exit' && !s.first_message) s.first_message = d.display.slice(0, 200); }
        }
      }
      // Scan extra projects dirs
      const extraProjects = path.join(extraClaudeDir, 'projects');
      if (fs.existsSync(extraProjects)) {
        for (const proj of fs.readdirSync(extraProjects)) {
          const projDir = path.join(extraProjects, proj);
          if (!fs.statSync(projDir).isDirectory()) continue;
          for (const file of fs.readdirSync(projDir)) {
            if (!file.endsWith('.jsonl')) continue;
            const sid = file.replace('.jsonl', '');
            const fp = path.join(projDir, file);
            if (sessions[sid]) {
              const summary = parseClaudeSessionFile(fp);
              if (summary) mergeClaudeSessionDetail(sessions[sid], summary, fp);
              else if (!sessions[sid].has_detail) {
                sessions[sid].has_detail = true;
                sessions[sid].file_size = fs.statSync(fp).size;
                sessions[sid]._session_file = fp;
              }
              continue;
            }
            const summary = parseClaudeSessionFile(fp);
            if (!summary) continue;
            sessions[sid] = {
              id: sid,
              tool: summary.tool,
              project: summary.projectPath,
              project_short: summary.projectPath.replace(os.homedir(), '~'),
              first_ts: summary.firstTs,
              last_ts: summary.lastTs,
              messages: summary.msgCount,
              first_message: summary.customTitle || summary.firstMsg,
              has_detail: true,
              file_size: summary.fileSize,
              detail_messages: summary.msgCount,
              _claude_dir: extraClaudeDir,
              _session_file: fp,
              worktree_original_cwd: summary.worktreeOriginalCwd || '',
            };
          }
        }
      }
    } catch {}
  }

  // Enrich Claude sessions with detail file info
  for (const [sid, s] of Object.entries(sessions)) {
    if (s.tool !== 'claude' && s.tool !== 'claude-ext') continue;
    let sessionFile = '';
    if (s._session_file && fs.existsSync(s._session_file)) {
      sessionFile = s._session_file;
    } else if (s.project) {
      const claudeDir = s._claude_dir || CLAUDE_DIR;
      const projectsDir = path.join(claudeDir, 'projects');
      const projectKey = s.project.replace(/[^a-zA-Z0-9-]/g, '-');
      const candidate = path.join(projectsDir, projectKey, `${sid}.jsonl`);
      if (fs.existsSync(candidate)) sessionFile = candidate;
    }
    if (!sessionFile) {
      const found = findSessionFile(sid, s.project);
      if (found && found.format === 'claude') sessionFile = found.file;
    }

    if (fs.existsSync(sessionFile)) {
      const summary = parseClaudeSessionFile(sessionFile);
      if (summary) mergeClaudeSessionDetail(s, summary, sessionFile);
      else {
        s.has_detail = true;
        s.file_size = fs.statSync(sessionFile).size;
        s._session_file = sessionFile;
      }
    } else if (!s.has_detail) {
      s.has_detail = false;
      s.file_size = 0;
      s.detail_messages = 0;
    }
  }

  // Scan project dirs for orphan sessions (e.g. Claude Extension sessions not in history.jsonl)
  if (fs.existsSync(PROJECTS_DIR)) {
    try {
      for (const proj of fs.readdirSync(PROJECTS_DIR)) {
        const projDir = path.join(PROJECTS_DIR, proj);
        if (!fs.statSync(projDir).isDirectory()) continue;
        for (const file of fs.readdirSync(projDir)) {
          if (!file.endsWith('.jsonl')) continue;
          const sid = file.replace('.jsonl', '');
          const filePath = path.join(projDir, file);
          if (sessions[sid]) {
            const summary = parseClaudeSessionFile(filePath);
            if (summary) mergeClaudeSessionDetail(sessions[sid], summary, filePath);
            continue;
          }
          const summary = parseClaudeSessionFile(filePath);
          if (!summary) continue;
          sessions[sid] = {
            id: sid,
            tool: summary.tool,
            project: summary.projectPath,
            project_short: summary.projectPath.replace(os.homedir(), '~'),
            first_ts: summary.firstTs,
            last_ts: summary.lastTs,
            messages: summary.msgCount,
            first_message: summary.customTitle || summary.firstMsg,
            has_detail: true,
            file_size: summary.fileSize,
            detail_messages: summary.msgCount,
            _claude_dir: CLAUDE_DIR,
            _session_file: filePath,
            worktree_original_cwd: summary.worktreeOriginalCwd || '',
          };
        }
      }
    } catch {}
  }

  const result = Object.values(sessions).sort((a, b) => b.last_ts - a.last_ts);

  // Collect unique project paths and resolve git roots in one pass
  const uniquePaths = [...new Set(result.map(s => s.project).filter(Boolean))];
  for (const p of uniquePaths) resolveGitRoot(p);

  for (const s of result) {
    s.first_time = new Date(s.first_ts).toLocaleString('sv-SE').slice(0, 16);
    s.last_time = new Date(s.last_ts).toLocaleString('sv-SE').slice(0, 16);
    const dt = new Date(s.last_ts);
    s.date = dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
    // Priority: worktree-state.originalCwd (container-safe) > git rev-parse > path heuristic (frontend)
    s.git_root = s.worktree_original_cwd || (s.project ? (_gitRootCache[s.project] || '') : '');
  }

  _sessionsCache = result;
  _sessionsCacheTs = Date.now();
  return result;
}

function loadSessionDetail(sessionId, project) {
  const found = findSessionFile(sessionId, project);
  if (!found) return { error: 'Session file not found', messages: [] };

  // OpenCode uses SQLite
  if (found.format === 'opencode') {
    return loadOpenCodeDetail(sessionId);
  }

  // Cursor
  if (found.format === 'cursor') {
    return loadCursorDetail(sessionId);
  }

  // Kiro uses SQLite
  if (found.format === 'kiro') {
    return loadKiroDetail(sessionId);
  }

  const messages = [];
  const lines = readLines(found.file);

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      if (found.format === 'claude') {
        if (entry.type === 'user' || entry.type === 'assistant') {
          const content = extractContent((entry.message || {}).content);
          if (content) {
            messages.push({ role: entry.type, content: content.slice(0, 2000), uuid: entry.uuid || '' });
          }
        }
      } else {
        if (entry.type === 'response_item' && entry.payload) {
          const role = entry.payload.role;
          if (role === 'user' || role === 'assistant') {
            const content = extractContent(entry.payload.content);
            if (content && !isSystemMessage(content)) {
              messages.push({ role: role, content: content.slice(0, 2000), uuid: '' });
            }
          }
        }
      }
    } catch {}
  }

  return { messages: messages.slice(0, 200) };
}

function deleteSession(sessionId, project) {
  const deleted = [];

  // 1. Remove session JSONL file from project dir
  const projectKey = project.replace(/[^a-zA-Z0-9-]/g, '-');
  const sessionFile = path.join(PROJECTS_DIR, projectKey, `${sessionId}.jsonl`);
  if (fs.existsSync(sessionFile)) {
    fs.unlinkSync(sessionFile);
    deleted.push('session file');
  }

  // Also remove companion directory if exists (some sessions have one)
  const sessionDir = path.join(PROJECTS_DIR, projectKey, sessionId);
  if (fs.existsSync(sessionDir) && fs.statSync(sessionDir).isDirectory()) {
    fs.rmSync(sessionDir, { recursive: true });
    deleted.push('session dir');
  }

  // 2. Remove entries from history.jsonl
  if (fs.existsSync(HISTORY_FILE)) {
    const lines = readLines(HISTORY_FILE);
    const filtered = lines.filter(line => {
      try {
        const d = JSON.parse(line);
        return d.sessionId !== sessionId;
      } catch { return true; }
    });
    if (filtered.length < lines.length) {
      fs.writeFileSync(HISTORY_FILE, filtered.join('\n') + '\n');
      deleted.push(`${lines.length - filtered.length} history entries`);
    }
  }

  // 3. Remove session-env file if exists
  const envFile = path.join(CLAUDE_DIR, 'session-env', `${sessionId}.json`);
  if (fs.existsSync(envFile)) {
    fs.unlinkSync(envFile);
    deleted.push('env file');
  }

  return deleted;
}

function getGitCommits(projectDir, fromTs, toTs) {
  try {
    if (!projectDir || !fs.existsSync(projectDir)) {
      return [];
    }

    const afterDate = new Date(fromTs).toISOString();
    const beforeDate = new Date(toTs).toISOString();

    const output = execFileSync('git', [
      'log', '--oneline', `--after=${afterDate}`, `--before=${beforeDate}`
    ], { cwd: projectDir, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();

    if (!output) return [];

    return output.split('\n').map(line => {
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx === -1) return { hash: line, message: '' };
      return {
        hash: line.slice(0, spaceIdx),
        message: line.slice(spaceIdx + 1),
      };
    });
  } catch {
    return [];
  }
}

function exportSessionMarkdown(sessionId, project) {
  const found = findSessionFile(sessionId, project);
  if (!found || found.format !== 'claude' || !fs.existsSync(found.file)) {
    return `# Session ${sessionId}\n\nSession file not found.\n`;
  }

  const sessionFile = found.file;
  const summary = parseClaudeSessionFile(sessionFile);
  const lines = readLines(sessionFile);
  const projectLabel = project || (summary && summary.projectPath) || '(none)';
  const parts = [`# Session ${sessionId}\n\n**Project:** ${projectLabel}\n`];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' || entry.type === 'assistant') {
        const msg = entry.message || {};
        let content = msg.content || '';
        if (Array.isArray(content)) {
          content = content
            .map(b => (typeof b === 'string' ? b : (b.type === 'text' ? b.text : '')))
            .filter(Boolean)
            .join('\n');
        }
        const header = entry.type === 'user' ? '## User' : '## Assistant';
        parts.push(`\n${header}\n\n${content}\n`);
      }
    } catch {}
  }

  return parts.join('');
}

// ── Session Preview (first N messages, lightweight) ────────

function findSessionFile(sessionId, project) {
  // Try Claude projects dir
  if (project) {
    const projectKey = project.replace(/[^a-zA-Z0-9-]/g, '-');
    const claudeFile = path.join(PROJECTS_DIR, projectKey, `${sessionId}.jsonl`);
    if (fs.existsSync(claudeFile)) return { file: claudeFile, format: 'claude' };
  }

  // Try all Claude project dirs
  if (fs.existsSync(PROJECTS_DIR)) {
    for (const proj of fs.readdirSync(PROJECTS_DIR)) {
      const f = path.join(PROJECTS_DIR, proj, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return { file: f, format: 'claude' };
    }
  }

  // WSL: try extra Claude dirs
  for (const extraDir of EXTRA_CLAUDE_DIRS) {
    const extraProjects = path.join(extraDir, 'projects');
    if (fs.existsSync(extraProjects)) {
      for (const proj of fs.readdirSync(extraProjects)) {
        const f = path.join(extraProjects, proj, `${sessionId}.jsonl`);
        if (fs.existsSync(f)) return { file: f, format: 'claude' };
      }
    }
  }

  // Try Codex sessions dir (walk year/month/day)
  const codexSessionsDir = path.join(CODEX_DIR, 'sessions');
  if (fs.existsSync(codexSessionsDir)) {
    const walkDir = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const result = walkDir(full);
          if (result) return result;
        } else if (entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
          return full;
        }
      }
      return null;
    };
    const codexFile = walkDir(codexSessionsDir);
    if (codexFile) return { file: codexFile, format: 'codex' };
  }

  // Try OpenCode (SQLite — return special marker)
  if (fs.existsSync(OPENCODE_DB) && sessionId.startsWith('ses_')) {
    return { file: OPENCODE_DB, format: 'opencode', sessionId: sessionId };
  }

  // Try Cursor
  if (fs.existsSync(CURSOR_PROJECTS) || fs.existsSync(CURSOR_CHATS)) {
    // Check projects
    if (fs.existsSync(CURSOR_PROJECTS)) {
      for (const proj of fs.readdirSync(CURSOR_PROJECTS)) {
        const f = path.join(CURSOR_PROJECTS, proj, 'agent-transcripts', sessionId, sessionId + '.jsonl');
        if (fs.existsSync(f)) return { file: f, format: 'cursor' };
      }
    }
    // Check chats
    if (fs.existsSync(CURSOR_CHATS)) {
      const chatDir = path.join(CURSOR_CHATS, sessionId);
      if (fs.existsSync(chatDir)) {
        for (const f of fs.readdirSync(chatDir)) {
          if (f.endsWith('.jsonl') || f.endsWith('.json')) {
            return { file: path.join(chatDir, f), format: 'cursor' };
          }
        }
      }
    }
  }

  // Try Kiro (SQLite)
  if (fs.existsSync(KIRO_DB)) {
    try {
      const check = execFileSync('sqlite3', [
        KIRO_DB,
        `SELECT COUNT(*) FROM conversations_v2 WHERE conversation_id = '${sessionId.replace(/'/g, "''")}';`
      ], { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim();
      if (parseInt(check) > 0) {
        return { file: KIRO_DB, format: 'kiro', sessionId: sessionId };
      }
    } catch {}
  }

  return null;
}

function isSystemMessage(text) {
  if (!text) return true;
  var t = text.trim();
  if (t === 'exit' || t === 'quit' || t === '/exit') return true;
  if (t.startsWith('<permissions')) return true;
  if (t.startsWith('<environment_context')) return true;
  if (t.startsWith('<collaboration_mode')) return true;
  if (t.startsWith('# AGENTS.md')) return true;
  if (t.startsWith('<INSTRUCTIONS>')) return true;
  // Codex developer role system prompts
  if (t.startsWith('You are Codex')) return true;
  if (t.startsWith('Filesystem sandboxing')) return true;
  return false;
}

function extractContent(raw) {
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map(b => (typeof b === 'string' ? b : (b.text || b.input_text || '')))
      .filter(Boolean)
      .join('\n');
  }
  return String(raw);
}

function getSessionPreview(sessionId, project, limit) {
  limit = limit || 10;
  const found = findSessionFile(sessionId, project);
  if (!found) return [];

  // Cursor
  if (found.format === 'cursor') {
    var detail = loadCursorDetail(sessionId);
    return detail.messages.slice(0, limit).map(function(m) {
      return { role: m.role, content: m.content.slice(0, 300) };
    });
  }

  // Kiro: use loadKiroDetail and slice
  if (found.format === 'kiro') {
    var detail = loadKiroDetail(sessionId);
    return detail.messages.slice(0, limit).map(function(m) {
      return { role: m.role, content: m.content.slice(0, 300) };
    });
  }

  // OpenCode: use loadOpenCodeDetail and slice
  if (found.format === 'opencode') {
    const detail = loadOpenCodeDetail(sessionId);
    return detail.messages.slice(0, limit).map(function(m) {
      return { role: m.role, content: m.content.slice(0, 300) };
    });
  }

  const messages = [];
  const lines = readLines(found.file);

  for (const line of lines) {
    if (messages.length >= limit) break;
    try {
      const entry = JSON.parse(line);

      if (found.format === 'claude') {
        // Claude: {type: "user"|"assistant", message: {content: ...}}
        if (entry.type === 'user' || entry.type === 'assistant') {
          const content = extractContent((entry.message || {}).content);
          if (content) {
            messages.push({ role: entry.type, content: content.slice(0, 300) });
          }
        }
      } else {
        // Codex: {type: "response_item", payload: {role: "user"|"assistant", content: [...]}}
        if (entry.type === 'response_item' && entry.payload) {
          const role = entry.payload.role;
          if (role === 'user' || role === 'assistant') {
            const content = extractContent(entry.payload.content);
            // Skip system-like messages
            if (content && !isSystemMessage(content)) {
              messages.push({ role: role, content: content.slice(0, 300) });
            }
          }
        }
      }
    } catch {}
  }

  return messages;
}

// ── Full-text search index ─────────────────────────────────
//
// Built once on first search, then cached in memory.
// Each entry: { sessionId, texts: [{role, content}] }
// Total text is kept lowercase for fast substring matching.

let searchIndex = null;
let searchIndexBuiltAt = 0;
const INDEX_TTL = 60000; // rebuild every 60s

function buildSearchIndex(sessions) {
  const startMs = Date.now();
  const index = [];

  for (const s of sessions) {
    if (!s.has_detail) continue;

    const found = findSessionFile(s.id, s.project);
    if (!found) continue;

    try {
      const lines = readLines(found.file);
      const texts = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          let role, content;

          if (found.format === 'claude') {
            if (entry.type !== 'user' && entry.type !== 'assistant') continue;
            role = entry.type;
            content = extractContent((entry.message || {}).content);
          } else {
            if (entry.type !== 'response_item' || !entry.payload) continue;
            role = entry.payload.role;
            if (role !== 'user' && role !== 'assistant') continue;
            content = extractContent(entry.payload.content);
          }

          if (content && !isSystemMessage(content)) {
            texts.push({ role, content: content.slice(0, 500) });
          }
        } catch {}
      }

      if (texts.length > 0) {
        // Pre-compute lowercase full text for fast matching
        const fullText = texts.map(t => t.content).join(' ').toLowerCase();
        index.push({ sessionId: s.id, texts, fullText });
      }
    } catch {}
  }

  const elapsed = Date.now() - startMs;
  console.log(`  \x1b[2mSearch index: ${index.length} sessions, ${elapsed}ms\x1b[0m`);
  return index;
}

function getSearchIndex(sessions) {
  const now = Date.now();
  if (!searchIndex || (now - searchIndexBuiltAt) > INDEX_TTL) {
    searchIndex = buildSearchIndex(sessions);
    searchIndexBuiltAt = now;
  }
  return searchIndex;
}

function searchFullText(query, sessions) {
  if (!query || query.length < 2) return [];
  const q = query.toLowerCase();
  const index = getSearchIndex(sessions);
  const results = [];

  for (const entry of index) {
    if (entry.fullText.indexOf(q) === -1) continue;

    // Find matching messages with snippets
    const matches = [];
    for (const t of entry.texts) {
      if (matches.length >= 3) break;
      const idx = t.content.toLowerCase().indexOf(q);
      if (idx >= 0) {
        const start = Math.max(0, idx - 50);
        const end = Math.min(t.content.length, idx + q.length + 50);
        matches.push({
          role: t.role,
          snippet: (start > 0 ? '...' : '') + t.content.slice(start, end) + (end < t.content.length ? '...' : ''),
        });
      }
    }

    if (matches.length > 0) {
      results.push({ sessionId: entry.sessionId, matches });
    }
  }

  return results;
}

// ── Exports ────────────────────────────────────────────────

// ── Session replay data (with timestamps) ─────────────────

function getSessionReplay(sessionId, project) {
  const found = findSessionFile(sessionId, project);
  if (!found) return { messages: [], duration: 0 };

  const messages = [];
  const lines = readLines(found.file);

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      let role, content, ts;

      if (found.format === 'claude') {
        if (entry.type !== 'user' && entry.type !== 'assistant') continue;
        role = entry.type;
        content = extractContent((entry.message || {}).content);
        ts = entry.timestamp || '';
      } else {
        if (entry.type !== 'response_item' || !entry.payload) continue;
        role = entry.payload.role;
        if (role !== 'user' && role !== 'assistant') continue;
        content = extractContent(entry.payload.content);
        ts = entry.timestamp || '';
      }

      if (!content || isSystemMessage(content)) continue;

      messages.push({
        role,
        content: content.slice(0, 3000),
        timestamp: ts,
        ms: ts ? new Date(ts).getTime() : 0,
      });
    } catch {}
  }

  // Calculate duration
  const startMs = messages.length > 0 ? messages[0].ms : 0;
  const endMs = messages.length > 0 ? messages[messages.length - 1].ms : 0;

  return {
    messages,
    startMs,
    endMs,
    duration: endMs - startMs,
  };
}

const CONTEXT_WINDOW = 200_000; // Claude's max context window (tokens)

// ── Pricing per model (per token, April 2026) ─────────────

const MODEL_PRICING = {
  'claude-opus-4-6':   { input: 5.00 / 1e6, output: 25.00 / 1e6, cache_read: 0.50 / 1e6, cache_create: 6.25 / 1e6 },
  'claude-opus-4-5':   { input: 5.00 / 1e6, output: 25.00 / 1e6, cache_read: 0.50 / 1e6, cache_create: 6.25 / 1e6 },
  'claude-sonnet-4-6': { input: 3.00 / 1e6, output: 15.00 / 1e6, cache_read: 0.30 / 1e6, cache_create: 3.75 / 1e6 },
  'claude-sonnet-4-5': { input: 3.00 / 1e6, output: 15.00 / 1e6, cache_read: 0.30 / 1e6, cache_create: 3.75 / 1e6 },
  'claude-haiku-4-5':  { input: 1.00 / 1e6, output: 5.00 / 1e6,  cache_read: 0.10 / 1e6, cache_create: 1.25 / 1e6 },
  'codex-mini-latest': { input: 1.50 / 1e6, output: 6.00 / 1e6,  cache_read: 0.375 / 1e6, cache_create: 1.875 / 1e6 },
  'gpt-5':             { input: 1.25 / 1e6, output: 10.00 / 1e6, cache_read: 0.625 / 1e6, cache_create: 1.25 / 1e6 },
};

function getModelPricing(model) {
  if (!model) return MODEL_PRICING['claude-sonnet-4-6']; // default
  for (const key in MODEL_PRICING) {
    if (model.includes(key) || model.startsWith(key)) return MODEL_PRICING[key];
  }
  // Fallback: try partial match
  if (model.includes('opus')) return MODEL_PRICING['claude-opus-4-6'];
  if (model.includes('haiku')) return MODEL_PRICING['claude-haiku-4-5'];
  if (model.includes('sonnet')) return MODEL_PRICING['claude-sonnet-4-6'];
  if (model.includes('codex')) return MODEL_PRICING['codex-mini-latest'];
  return MODEL_PRICING['claude-sonnet-4-6'];
}

// ── Compute real cost from session file token usage ────────

function computeSessionCost(sessionId, project) {
  const found = findSessionFile(sessionId, project);
  if (!found) return { cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, contextPctSum: 0, contextTurnCount: 0, model: '' };

  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreate = 0;
  let contextPctSum = 0;
  let contextTurnCount = 0;
  let model = '';

  // OpenCode: query SQLite directly for token data
  if (found.format === 'opencode') {
    const safeId = /^[a-zA-Z0-9_-]+$/.test(found.sessionId) ? found.sessionId : '';
    if (!safeId) return { cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, contextPctSum: 0, contextTurnCount: 0, model: '' };
    try {
      const rows = execFileSync('sqlite3', [
        OPENCODE_DB,
        `SELECT data FROM message WHERE session_id = '${safeId}' AND json_extract(data, '$.role') = 'assistant' ORDER BY time_created`
      ], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
      if (rows) {
        for (const row of rows.split('\n')) {
          try {
            const msgData = JSON.parse(row);
            const t = msgData.tokens || {};
            if (!model && msgData.modelID) model = msgData.modelID;
            const inp = t.input || 0;
            const out = (t.output || 0) + (t.reasoning || 0);
            const cacheRead = (t.cache && t.cache.read) || 0;
            const cacheCreate = (t.cache && t.cache.write) || 0;
            if (inp === 0 && out === 0) continue;

            const pricing = getModelPricing(msgData.modelID || model);
            totalInput += inp;
            totalOutput += out;
            totalCacheRead += cacheRead;
            totalCacheCreate += cacheCreate;
            totalCost += inp * pricing.input
                       + cacheCreate * pricing.cache_create
                       + cacheRead * pricing.cache_read
                       + out * pricing.output;

            const contextThisTurn = inp + cacheCreate + cacheRead;
            if (contextThisTurn > 0) {
              contextPctSum += (contextThisTurn / CONTEXT_WINDOW) * 100;
              contextTurnCount++;
            }
          } catch {}
        }
      }
    } catch {}
    return { cost: totalCost, inputTokens: totalInput, outputTokens: totalOutput, cacheReadTokens: totalCacheRead, cacheCreateTokens: totalCacheCreate, contextPctSum, contextTurnCount, model };
  }

  try {
    const lines = readLines(found.file);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (found.format === 'claude' && entry.type === 'assistant') {
          const msg = entry.message || {};
          if (!model && msg.model) model = msg.model;
          const u = msg.usage;
          if (!u) continue;

          const pricing = getModelPricing(msg.model || model);
          const inp = u.input_tokens || 0;
          const cacheCreate = u.cache_creation_input_tokens || 0;
          const cacheRead = u.cache_read_input_tokens || 0;
          const out = u.output_tokens || 0;

          totalInput += inp;
          totalOutput += out;
          totalCacheRead += cacheRead;
          totalCacheCreate += cacheCreate;
          totalCost += inp * pricing.input
                     + cacheCreate * pricing.cache_create
                     + cacheRead * pricing.cache_read
                     + out * pricing.output;

          // Track per-turn context window usage (average, not peak)
          const contextThisTurn = inp + cacheCreate + cacheRead;
          if (contextThisTurn > 0) {
            contextPctSum += (contextThisTurn / CONTEXT_WINDOW) * 100;
            contextTurnCount++;
          }
        }
        // Codex: estimate from file size (no token usage in session files)
      } catch {}
    }
  } catch {}

  // Fallback for Codex or sessions without usage data
  if (totalCost === 0 && found.format === 'codex') {
    try {
      const size = fs.statSync(found.file).size;
      const tokens = size / 4;
      const pricing = MODEL_PRICING['codex-mini-latest'];
      totalInput = Math.round(tokens * 0.3);
      totalOutput = Math.round(tokens * 0.7);
      totalCost = totalInput * pricing.input + totalOutput * pricing.output;
    } catch {}
  }

  return { cost: totalCost, inputTokens: totalInput, outputTokens: totalOutput, cacheReadTokens: totalCacheRead, cacheCreateTokens: totalCacheCreate, contextPctSum, contextTurnCount, model };
}

// ── Cost analytics ────────────────────────────────────────

function getCostAnalytics(sessions) {
  const byDay = {};
  const byProject = {};
  const byWeek = {};
  const byAgent = {};
  let totalCost = 0;
  let totalTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreateTokens = 0;
  let globalContextPctSum = 0;
  let globalContextTurnCount = 0;
  let firstDate = null;
  let lastDate = null;
  let sessionsWithData = 0;
  const agentNoCostData = {};
  for (const s of sessions) {
    if (!byAgent[s.tool]) byAgent[s.tool] = { cost: 0, sessions: 0, tokens: 0, estimated: false };
  }
  const sessionCosts = [];

  // Pre-compute OpenCode costs in one batch query (avoids O(n) execSync calls)
  const opencodeCostCache = {};
  const opencodeSessions = sessions.filter(s => s.tool === 'opencode');
  if (opencodeSessions.length > 0 && fs.existsSync(OPENCODE_DB)) {
    try {
      const batchRows = execFileSync('sqlite3', [
        OPENCODE_DB,
        `SELECT session_id, data FROM message WHERE json_extract(data, '$.role') = 'assistant' ORDER BY time_created`
      ], { encoding: 'utf8', timeout: 30000, windowsHide: true }).trim();
      if (batchRows) {
        for (const row of batchRows.split('\n')) {
          const sepIdx = row.indexOf('|');
          if (sepIdx < 0) continue;
          const sessId = row.slice(0, sepIdx);
          const jsonStr = row.slice(sepIdx + 1);
          try {
            const msgData = JSON.parse(jsonStr);
            const t = msgData.tokens || {};
            const inp = t.input || 0;
            const out = (t.output || 0) + (t.reasoning || 0);
            const cacheRead = (t.cache && t.cache.read) || 0;
            const cacheCreate = (t.cache && t.cache.write) || 0;
            if (inp === 0 && out === 0) continue;
            if (!opencodeCostCache[sessId]) opencodeCostCache[sessId] = { cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, contextPctSum: 0, contextTurnCount: 0, model: '' };
            const c = opencodeCostCache[sessId];
            if (!c.model && msgData.modelID) c.model = msgData.modelID;
            const pricing = getModelPricing(msgData.modelID || c.model);
            c.inputTokens += inp;
            c.outputTokens += out;
            c.cacheReadTokens += cacheRead;
            c.cacheCreateTokens += cacheCreate;
            c.cost += inp * pricing.input + cacheCreate * pricing.cache_create + cacheRead * pricing.cache_read + out * pricing.output;
            const ctx = inp + cacheCreate + cacheRead;
            if (ctx > 0) { c.contextPctSum += (ctx / CONTEXT_WINDOW) * 100; c.contextTurnCount++; }
          } catch {}
        }
      }
    } catch {}
  }

  for (const s of sessions) {
    const costData = (s.tool === 'opencode' && opencodeCostCache[s.id])
      ? opencodeCostCache[s.id]
      : computeSessionCost(s.id, s.project);
    const cost = costData.cost;
    const tokens = costData.inputTokens + costData.outputTokens + costData.cacheReadTokens + costData.cacheCreateTokens;
    if (cost === 0 && tokens === 0) {
      if (!agentNoCostData[s.tool]) agentNoCostData[s.tool] = 0;
      agentNoCostData[s.tool]++;
      continue;
    }
    sessionsWithData++;
    totalCost += cost;
    totalTokens += tokens;
    totalInputTokens += costData.inputTokens;
    totalOutputTokens += costData.outputTokens;
    totalCacheReadTokens += costData.cacheReadTokens;
    totalCacheCreateTokens += costData.cacheCreateTokens;

    // Per-agent breakdown
    const agent = s.tool || 'unknown';
    if (!byAgent[agent]) byAgent[agent] = { cost: 0, sessions: 0, tokens: 0, estimated: false };
    byAgent[agent].cost += cost;
    byAgent[agent].sessions++;
    byAgent[agent].tokens += tokens;
    if (agent === 'codex') byAgent[agent].estimated = true;
    if (agent === 'opencode' && !costData.model) byAgent[agent].estimated = true;

    // Context % across all turns
    globalContextPctSum += costData.contextPctSum;
    globalContextTurnCount += costData.contextTurnCount;

    // Date range
    const day = s.date || 'unknown';
    if (s.date) {
      if (!firstDate || s.date < firstDate) firstDate = s.date;
      if (!lastDate || s.date > lastDate) lastDate = s.date;
    }
    if (!byDay[day]) byDay[day] = { cost: 0, sessions: 0, tokens: 0 };
    byDay[day].cost += cost;
    byDay[day].sessions++;
    byDay[day].tokens += tokens;

    // By week
    if (s.date) {
      const d = new Date(s.date);
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay());
      const weekKey = weekStart.toISOString().slice(0, 10);
      if (!byWeek[weekKey]) byWeek[weekKey] = { cost: 0, sessions: 0 };
      byWeek[weekKey].cost += cost;
      byWeek[weekKey].sessions++;
    }

    // By project
    const proj = s.project_short || s.project || 'unknown';
    if (!byProject[proj]) byProject[proj] = { cost: 0, sessions: 0, tokens: 0 };
    byProject[proj].cost += cost;
    byProject[proj].sessions++;
    byProject[proj].tokens += tokens;

    sessionCosts.push({ id: s.id, cost, project: proj, date: s.date });
  }

  // Sort top sessions by cost
  sessionCosts.sort((a, b) => b.cost - a.cost);

  const days = firstDate && lastDate
    ? Math.max(1, Math.round((new Date(lastDate) - new Date(firstDate)) / 86400000) + 1)
    : 1;

  return {
    totalCost,
    totalTokens,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheCreateTokens,
    avgContextPct: globalContextTurnCount > 0 ? Math.round(globalContextPctSum / globalContextTurnCount) : 0,
    dailyRate: totalCost / days,
    firstDate,
    lastDate,
    days,
    totalSessions: sessionsWithData,
    byDay,
    byWeek,
    byProject,
    topSessions: sessionCosts.slice(0, 10),
    byAgent,
    agentNoCostData,
  };
}

// ── Active sessions detection ─────────────────────────────

function getActiveSessions() {
  const active = [];
  const seenPids = new Set();

  // 1. Claude Code — read PID files for session ID mapping
  const sessionsDir = path.join(CLAUDE_DIR, 'sessions');
  const claudePidMap = {}; // pid → {sessionId, cwd, startedAt}
  if (fs.existsSync(sessionsDir)) {
    for (const file of fs.readdirSync(sessionsDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
        if (data.pid) claudePidMap[data.pid] = data;
      } catch {}
    }
  }

  // 2. Scan ALL agent processes via ps
  const agentPatterns = [
    { pattern: 'claude', tool: 'claude', match: /\bclaude\b/ },
    { pattern: 'codex', tool: 'codex', match: /\bcodex\b/ },
    { pattern: 'opencode', tool: 'opencode', match: /\bopencode\b/ },
    { pattern: 'kiro', tool: 'kiro', match: /kiro-cli/ },
    { pattern: 'cursor-agent', tool: 'cursor', match: /cursor-agent/ },
  ];

  // Skip process scanning on Windows (no ps/grep)
  if (process.platform === 'win32') return active;

  try {
    const psOut = execSync(
      'ps aux 2>/dev/null | grep -E "claude|codex|opencode|kiro-cli|cursor-agent" | grep -v grep || true',
      { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    for (const line of psOut.split('\n').filter(Boolean)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;

      const pid = parseInt(parts[1]);
      if (seenPids.has(pid)) continue;

      const cpu = parseFloat(parts[2]) || 0;
      const rss = parseInt(parts[5]) || 0;
      const stat = parts[7] || '';
      const cmd = parts.slice(10).join(' ');

      // Determine tool
      let tool = '';
      for (const ap of agentPatterns) {
        if (ap.match.test(cmd)) { tool = ap.tool; break; }
      }
      if (!tool) continue;

      // Skip node/npm/shell wrappers — only main processes
      if (cmd.includes('node bin/cli') || cmd.includes('npm') || cmd.includes('grep')) continue;

      seenPids.add(pid);

      // Get session ID from Claude PID files
      let sessionId = '';
      let cwd = '';
      let startedAt = 0;
      let sessionSource = '';
      if (claudePidMap[pid]) {
        sessionId = claudePidMap[pid].sessionId || '';
        cwd = claudePidMap[pid].cwd || '';
        startedAt = claudePidMap[pid].startedAt || 0;
        if (sessionId) sessionSource = 'pid-file';
      }

      // Try to get cwd from lsof if not from PID file
      if (!cwd) {
        try {
          const lsofOut = execSync(`lsof -d cwd -p ${pid} -Fn 2>/dev/null`, { encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] });
          const match = lsofOut.match(/\nn(\/[^\n]+)/);
          if (match) cwd = match[1];
        } catch {}
      }

      // Try to find session ID by matching cwd + tool to loaded sessions
      if (!sessionId) {
        const allS = loadSessions();
        const match = allS.find(s => s.tool === tool && s.project === cwd);
        if (match) {
          sessionId = match.id;
          sessionSource = 'cwd-match';
        }
        // If still no match, find latest session of this tool
        if (!sessionId) {
          const latest = allS.filter(s => s.tool === tool).sort((a,b) => b.last_ts - a.last_ts)[0];
          if (latest) {
            sessionId = latest.id;
            sessionSource = 'fallback-latest';
          }
        }
      }

      const status = cpu < 1 && (stat.includes('S') || stat.includes('T')) ? 'waiting' : 'active';

      active.push({
        pid: pid,
        sessionId: sessionId,
        cwd: cwd,
        startedAt: startedAt,
        kind: tool,
        entrypoint: tool,
        status: status,
        cpu: cpu,
        memoryMB: Math.round(rss / 1024),
        _sessionSource: sessionSource,
      });
    }
  } catch {}

  return active;
}

module.exports = {
  loadSessions,
  loadSessionDetail,
  getProjectGitInfo,
  deleteSession,
  getGitCommits,
  exportSessionMarkdown,
  getSessionPreview,
  searchFullText,
  getActiveSessions,
  getSessionReplay,
  getCostAnalytics,
  computeSessionCost,
  MODEL_PRICING,
  findSessionFile,
  extractContent,
  isSystemMessage,
  loadOpenCodeDetail,
  CLAUDE_DIR,
  CODEX_DIR,
  OPENCODE_DB,
  KIRO_DB,
  HISTORY_FILE,
  PROJECTS_DIR,
};
