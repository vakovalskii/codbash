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
// Cursor global DB path varies by OS: macOS ~/Library/Application Support, Linux ~/.config, Windows %APPDATA%
const CURSOR_APP_DATA = process.platform === 'darwin'
  ? path.join(ALL_HOMES[0], 'Library', 'Application Support', 'Cursor')
  : process.platform === 'win32'
    ? path.join(ALL_HOMES[0], 'AppData', 'Roaming', 'Cursor')
    : path.join(ALL_HOMES[0], '.config', 'Cursor');
const CURSOR_GLOBAL_DB = path.join(CURSOR_APP_DATA, 'User', 'globalStorage', 'state.vscdb');
const CURSOR_WORKSPACE_STORAGE = path.join(CURSOR_APP_DATA, 'User', 'workspaceStorage');
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

// OpenCode built-in tools that should NOT be treated as MCP servers
const OPENCODE_BUILTIN_TOOLS = new Set([
  'read', 'write', 'edit', 'bash', 'glob', 'grep', 'task', 'todowrite',
  'delegate_task', 'apply_patch', 'webfetch', 'websearch', 'slashcommand',
  'question', 'background_task', 'background_output', 'background_cancel',
  'lsp_diagnostics', 'ast_grep_search', 'ast_grep_replace', 'session_read',
  'skill', 'skill_mcp', 'call_omo_agent',
]);

// OpenCode tool names like "chrome-devtools_take_screenshot" → server "chrome-devtools"
// Returns null if it's a built-in tool, otherwise the server name (first segment).
function parseOpenCodeMcpServer(toolName) {
  if (!toolName || OPENCODE_BUILTIN_TOOLS.has(toolName)) return null;
  // Match server_tool or server-with-dashes_tool
  const idx = toolName.indexOf('_');
  if (idx <= 0) return null;
  return toolName.slice(0, idx);
}

// Persistent cache dir (survives tmpdir cleanup and process kills)
const CODEDASH_CACHE_DIR = path.join(os.homedir(), '.codedash', 'cache');
try { fs.mkdirSync(CODEDASH_CACHE_DIR, { recursive: true }); } catch {}

// Disk cache for parsed Claude session files (keyed by path + mtime + size)
const PARSED_CACHE_FILE = path.join(CODEDASH_CACHE_DIR, 'parsed-cache.json');
// Legacy tmpdir path (migration: read once, then ignore)
const LEGACY_PARSED_CACHE_FILE = path.join(os.tmpdir(), 'codedash-parsed-cache.json');
let _parsedDiskCache = null;
let _parsedDiskCacheDirty = false;
let _parsedDiskCacheEntriesSinceFlush = 0;
const PARSED_CACHE_FLUSH_EVERY = 50; // flush after every N new entries
// Reverse index: file path -> cache key (avoids repeated fs.statSync)
const _fileCacheKeyIndex = {};

function _loadParsedDiskCache() {
  if (_parsedDiskCache) return;
  try {
    if (fs.existsSync(PARSED_CACHE_FILE)) {
      _parsedDiskCache = JSON.parse(fs.readFileSync(PARSED_CACHE_FILE, 'utf8'));
    } else if (fs.existsSync(LEGACY_PARSED_CACHE_FILE)) {
      // Migrate from tmpdir once
      _parsedDiskCache = JSON.parse(fs.readFileSync(LEGACY_PARSED_CACHE_FILE, 'utf8'));
      _parsedDiskCacheDirty = true;
    }
  } catch {}
  if (!_parsedDiskCache) _parsedDiskCache = {};
}

function _saveParsedDiskCache(force) {
  if (!_parsedDiskCacheDirty || !_parsedDiskCache) return;
  if (!force && _parsedDiskCacheEntriesSinceFlush < PARSED_CACHE_FLUSH_EVERY) return;
  try {
    // Atomic write: write to .tmp then rename
    const tmp = PARSED_CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_parsedDiskCache));
    fs.renameSync(tmp, PARSED_CACHE_FILE);
    _parsedDiskCacheDirty = false;
    _parsedDiskCacheEntriesSinceFlush = 0;
  } catch {}
}

// ── Disk cache for computed session cost (path+mtime+size → cost) ─────────
const COST_CACHE_FILE = path.join(CODEDASH_CACHE_DIR, 'cost-cache.json');
let _costDiskCache = null;
let _costDiskCacheDirty = false;
let _costDiskCacheEntriesSinceFlush = 0;
const COST_CACHE_FLUSH_EVERY = 50;

function _loadCostDiskCache() {
  if (_costDiskCache) return;
  try {
    if (fs.existsSync(COST_CACHE_FILE)) {
      _costDiskCache = JSON.parse(fs.readFileSync(COST_CACHE_FILE, 'utf8'));
    }
  } catch {}
  if (!_costDiskCache) _costDiskCache = {};
}

function _saveCostDiskCache(force) {
  if (!_costDiskCacheDirty || !_costDiskCache) return;
  if (!force && _costDiskCacheEntriesSinceFlush < COST_CACHE_FLUSH_EVERY) return;
  try {
    const tmp = COST_CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_costDiskCache));
    fs.renameSync(tmp, COST_CACHE_FILE);
    _costDiskCacheDirty = false;
    _costDiskCacheEntriesSinceFlush = 0;
  } catch {}
}

// ── Background parse warming state ────────────────────────
// Populated by sync loadSessions() with file paths whose parse cache is stale.
// A singleton background task drains this set with setImmediate yielding so
// the HTTP event loop stays responsive. UI can read _warmingStatus for progress.
const _pendingParseFiles = new Set();
let _warmingRunning = false;
const _warmingStatus = {
  running: false,
  done: 0,
  total: 0,
  phase: 'idle',
  startedAt: 0,
  finishedAt: 0,
};

// ── SQLite ingest helper ────────────────────────────────────
// Parse a single Claude session file fully (messages + metadata) and push
// a batch row into the SQLite index. Used by the background warmer after
// the parsed-cache entry has been created. Cheap when already indexed.
let _sqliteIngestBatch = [];
const _SQLITE_INGEST_FLUSH_EVERY = 5;

function _ingestClaudeFileToSqlite(filePath) {
  let sqliteIndex;
  try { sqliteIndex = require('./sqlite-index'); } catch { return; }
  try {
    if (sqliteIndex.isFileCurrent(filePath)) return; // already indexed
  } catch { return; }

  let stat;
  try { stat = fs.statSync(filePath); } catch { return; }

  // Full read — at ingest time we need messages for FTS. Streaming for big
  // files would be nicer but the warmer yields between files already.
  let lines;
  try { lines = readLines(filePath); } catch { return; }

  const sid = path.basename(filePath, '.jsonl');
  let projectPath = '';
  let tool = 'claude';
  let firstTs = stat.mtimeMs;
  let lastTs = stat.mtimeMs;
  let firstMsg = '';
  let userMsgCount = 0;
  let totalMsgCount = 0;
  const msgs = [];
  const dayMsgs = {};  // day → {messages, first_ts, last_ts}
  let seq = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;
      const role = entry.type;
      const content = extractContent((entry.message || {}).content);
      if (!content) continue;
      const ts = entry.timestamp ? (typeof entry.timestamp === 'number' ? entry.timestamp : new Date(entry.timestamp).getTime()) : 0;
      if (ts) {
        if (ts < firstTs) firstTs = ts;
        if (ts > lastTs) lastTs = ts;
      }
      if (!projectPath && entry.cwd) projectPath = entry.cwd;
      totalMsgCount++;
      if (role === 'user') {
        userMsgCount++;
        if (!firstMsg && content) firstMsg = content.slice(0, 200);
      }
      msgs.push({ seq: seq++, role, ts, content: content.slice(0, 8000) });
      // Day breakdown for user messages only
      if (role === 'user' && ts > 1000000000000) {
        const d = new Date(ts);
        const day = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        if (!dayMsgs[day]) dayMsgs[day] = { messages: 0, first_ts: ts, last_ts: ts };
        dayMsgs[day].messages++;
        if (ts < dayMsgs[day].first_ts) dayMsgs[day].first_ts = ts;
        if (ts > dayMsgs[day].last_ts) dayMsgs[day].last_ts = ts;
      }
    } catch {}
  }

  // Convert dayMsgs to daily_stats rows
  const daily = {};
  for (const day in dayMsgs) {
    const dm = dayMsgs[day];
    daily[day] = {
      messages: dm.messages,
      hours: Math.min((dm.last_ts - dm.first_ts) / 3600000, 16),
    };
  }

  _sqliteIngestBatch.push({
    filePath,
    session: {
      id: sid,
      tool,
      project: projectPath,
      project_short: projectPath.replace(os.homedir(), '~'),
      first_ts: firstTs,
      last_ts: lastTs,
      messages: totalMsgCount,
      user_messages: userMsgCount,
      file_size: stat.size,
      first_message: firstMsg,
      source_mtime: stat.mtimeMs,
      source_size: stat.size,
    },
    messages: msgs,
    daily,
  });

  // Don't flush here — backfill loop awaits the flush between files.
}

// Ingest a single Codex rollout JSONL into SQLite.
function _ingestCodexFileToSqlite(filePath) {
  let sqliteIndex;
  try { sqliteIndex = require('./sqlite-index'); } catch { return; }
  try { if (sqliteIndex.isFileCurrent(filePath)) return; } catch { return; }

  let stat;
  try { stat = fs.statSync(filePath); } catch { return; }

  // Extract session id from filename
  const basename = path.basename(filePath, '.jsonl');
  const uuidMatch = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  if (!uuidMatch) return;
  const sid = uuidMatch[1];

  let lines;
  try { lines = readLines(filePath); } catch { return; }

  let projectPath = '';
  let firstTs = stat.mtimeMs;
  let lastTs = stat.mtimeMs;
  let firstMsg = '';
  let userMsgCount = 0;
  let totalMsgCount = 0;
  const msgs = [];
  const dayMsgs = {};
  let seq = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'session_meta' && entry.payload && entry.payload.cwd && !projectPath) {
        projectPath = entry.payload.cwd;
        continue;
      }
      if (entry.type !== 'response_item' || !entry.payload) continue;
      const role = entry.payload.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const content = extractContent(entry.payload.content);
      if (!content || isSystemMessage(content)) continue;
      let ts = 0;
      const tsVal = entry.timestamp || entry.ts;
      if (typeof tsVal === 'number') ts = tsVal;
      else if (typeof tsVal === 'string') ts = Date.parse(tsVal) || 0;
      if (ts && ts < firstTs) firstTs = ts;
      if (ts && ts > lastTs) lastTs = ts;

      totalMsgCount++;
      if (role === 'user') {
        userMsgCount++;
        if (!firstMsg) firstMsg = content.slice(0, 200);
      }
      msgs.push({ seq: seq++, role, ts, content: content.slice(0, 8000) });
      if (role === 'user' && ts > 1000000000000) {
        const d = new Date(ts);
        const day = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        if (!dayMsgs[day]) dayMsgs[day] = { messages: 0, first_ts: ts, last_ts: ts };
        dayMsgs[day].messages++;
        if (ts < dayMsgs[day].first_ts) dayMsgs[day].first_ts = ts;
        if (ts > dayMsgs[day].last_ts) dayMsgs[day].last_ts = ts;
      }
    } catch {}
  }

  const daily = {};
  for (const day in dayMsgs) {
    const dm = dayMsgs[day];
    daily[day] = {
      messages: dm.messages,
      hours: Math.min((dm.last_ts - dm.first_ts) / 3600000, 16),
    };
  }

  _sqliteIngestBatch.push({
    filePath,
    session: {
      id: sid,
      tool: 'codex',
      project: projectPath,
      project_short: projectPath.replace(os.homedir(), '~'),
      first_ts: firstTs,
      last_ts: lastTs,
      messages: totalMsgCount,
      user_messages: userMsgCount,
      file_size: stat.size,
      first_message: firstMsg,
      source_mtime: stat.mtimeMs,
      source_size: stat.size,
    },
    messages: msgs,
    daily,
  });

  // Don't flush here — backfill loop awaits the flush between files.
}

async function _flushSqliteIngestBatch() {
  if (_sqliteIngestBatch.length === 0) return;
  const batch = _sqliteIngestBatch;
  _sqliteIngestBatch = [];  // take ownership before the async call
  try {
    const sqliteIndex = require('./sqlite-index');
    await sqliteIndex.indexBatchAsync(batch);
  } catch (e) {
    try { console.error('sqlite ingest flush failed:', e.message); } catch {}
  }
}

// ── SQLite backfill ────────────────────────────────────────
// One-shot background task that iterates all existing Claude session files
// and ingests them into SQLite (if not already there, matched by mtime+size
// via files_seen). Yields between files.
let _sqliteBackfillRunning = false;
const _sqliteBackfillStatus = {
  running: false,
  done: 0,
  total: 0,
  phase: 'idle',
  startedAt: 0,
  finishedAt: 0,
};

function getSqliteBackfillStatus() {
  return Object.assign({}, _sqliteBackfillStatus);
}

function _ensureSqliteBackfillRunning() {
  if (_sqliteBackfillRunning) return;
  let sqliteIndex;
  try { sqliteIndex = require('./sqlite-index'); } catch { return; }

  _sqliteBackfillRunning = true;
  _sqliteBackfillStatus.running = true;
  _sqliteBackfillStatus.startedAt = Date.now();
  _sqliteBackfillStatus.phase = 'scanning';
  _sqliteBackfillStatus.done = 0;

  setImmediate(async () => {
    try {
      sqliteIndex.ensureSchema();

      // Enumerate all Claude JSONL files + Codex session files
      const allFiles = []; // array of {file, kind}
      const walkClaude = (dir) => {
        try {
          for (const proj of fs.readdirSync(dir)) {
            const pDir = path.join(dir, proj);
            try {
              if (!fs.statSync(pDir).isDirectory()) continue;
              for (const f of fs.readdirSync(pDir)) {
                if (f.endsWith('.jsonl')) allFiles.push({ file: path.join(pDir, f), kind: 'claude' });
              }
            } catch {}
          }
        } catch {}
      };
      if (fs.existsSync(PROJECTS_DIR)) walkClaude(PROJECTS_DIR);
      for (const extra of EXTRA_CLAUDE_DIRS) {
        const ep = path.join(extra, 'projects');
        if (fs.existsSync(ep)) walkClaude(ep);
      }
      // Codex session files (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
      const codexSessDir = path.join(CODEX_DIR, 'sessions');
      if (fs.existsSync(codexSessDir)) {
        const walkCodex = (dir) => {
          try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) walkCodex(full);
              else if (entry.name.endsWith('.jsonl')) allFiles.push({ file: full, kind: 'codex' });
            }
          } catch {}
        };
        walkCodex(codexSessDir);
      }

      _sqliteBackfillStatus.total = allFiles.length;
      _sqliteBackfillStatus.phase = 'ingesting';

      // Sort newest first so fresh sessions hit the index sooner
      allFiles.sort((a, b) => {
        try { return fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs; } catch { return 0; }
      });

      // Single bulk read of files_seen — avoids N sync SQL calls
      const filesSeen = sqliteIndex.loadAllFilesSeen();

      for (const item of allFiles) {
        try {
          let stat;
          try { stat = fs.statSync(item.file); } catch { _sqliteBackfillStatus.done++; continue; }
          const seen = filesSeen.get(item.file);
          const isCurrent = seen && seen.mtime === stat.mtimeMs && seen.size === stat.size;
          if (!isCurrent) {
            if (item.kind === 'codex') {
              _ingestCodexFileToSqlite(item.file);
            } else {
              _ingestClaudeFileToSqlite(item.file);
            }
            if (_sqliteIngestBatch.length >= _SQLITE_INGEST_FLUSH_EVERY) {
              await _flushSqliteIngestBatch();
            }
          }
        } catch {}
        _sqliteBackfillStatus.done++;
        // Yield every 10 files so HTTP requests can slot in
        if (_sqliteBackfillStatus.done % 10 === 0) {
          await new Promise(r => setImmediate(r));
        }
      }
      await _flushSqliteIngestBatch();

      _sqliteBackfillStatus.phase = 'done';
      _sqliteBackfillStatus.finishedAt = Date.now();
    } catch (e) {
      _sqliteBackfillStatus.phase = 'error: ' + (e && e.message || 'unknown');
      _sqliteBackfillStatus.finishedAt = Date.now();
    } finally {
      _sqliteBackfillStatus.running = false;
      _sqliteBackfillRunning = false;
    }
  });
}

function _ensureWarmingRunning() {
  if (_warmingRunning) return;
  if (_pendingParseFiles.size === 0 && _pendingCodexFiles.size === 0) return;
  _warmingRunning = true;
  _warmingStatus.running = true;
  _warmingStatus.startedAt = Date.now();
  _warmingStatus.done = 0;
  _warmingStatus.total = _pendingParseFiles.size + _pendingCodexFiles.size;
  _warmingStatus.phase = 'parsing session files';
  setImmediate(async () => {
    try {
      while (_pendingParseFiles.size > 0 || _pendingCodexFiles.size > 0) {
        // Claude batch (newest-first)
        if (_pendingParseFiles.size > 0) {
          const batch = Array.from(_pendingParseFiles);
          batch.sort((a, b) => {
            try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
          });
          _warmingStatus.total = _warmingStatus.done + batch.length + _pendingCodexFiles.size;
          for (const file of batch) {
            _pendingParseFiles.delete(file);
            try {
              let stat;
              try { stat = fs.statSync(file); } catch { _warmingStatus.done++; continue; }
              if (stat.size >= 5 * 1024 * 1024) {
                await parseClaudeSessionFileAsync(file);
              } else {
                parseClaudeSessionFile(file);
                await new Promise(r => setImmediate(r));
              }
              // Also push into persistent SQLite index (batched)
              try { _ingestClaudeFileToSqlite(file); } catch {}
            } catch {}
            _warmingStatus.done++;
          }
          _flushSqliteIngestBatch();
        }
        // Codex batch
        if (_pendingCodexFiles.size > 0) {
          const batch = Array.from(_pendingCodexFiles);
          batch.sort((a, b) => {
            try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
          });
          _warmingStatus.total = _warmingStatus.done + batch.length + _pendingParseFiles.size;
          for (const file of batch) {
            _pendingCodexFiles.delete(file);
            try {
              parseCodexSessionFile(file);
              await new Promise(r => setImmediate(r));
            } catch {}
            _warmingStatus.done++;
          }
        }
        // Invalidate session cache so next /api/sessions picks up new detail
        _sessionsCache = null;
        _sessionsCacheTs = 0;
      }
      _saveParsedDiskCache(true);
      _flushSqliteIngestBatch();
      _warmingStatus.phase = 'done';
      _warmingStatus.finishedAt = Date.now();
    } catch (e) {
      _warmingStatus.phase = 'error: ' + (e && e.message || 'unknown');
      _warmingStatus.finishedAt = Date.now();
    } finally {
      _warmingStatus.running = false;
      _warmingRunning = false;
    }
  });
}

function getWarmingStatus() {
  return Object.assign({}, _warmingStatus, {
    pending: _pendingParseFiles.size,
  });
}

// Flush all caches on process exit / signals so partial progress isn't lost
let _flushHandlersInstalled = false;
let _flushInProgress = null;
function _installFlushHandlers() {
  if (_flushHandlersInstalled) return;
  _flushHandlersInstalled = true;
  const flushAllSync = () => {
    try { _saveParsedDiskCache(true); } catch {}
    try { _saveCostDiskCache(true); } catch {}
    try { if (typeof _saveDailyStatsDiskCache === 'function') _saveDailyStatsDiskCache(); } catch {}
    try { if (typeof _saveGitRootDiskCache === 'function') _saveGitRootDiskCache(); } catch {}
  };
  const flushAll = async () => {
    flushAllSync();
    try {
      if (typeof _flushSqliteIngestBatch === 'function') {
        await _flushSqliteIngestBatch();
      }
    } catch {}
  };
  const handleSignal = async () => {
    if (!_flushInProgress) {
      _flushInProgress = flushAll();
    }
    try {
      await _flushInProgress;
    } finally {
      process.exit(0);
    }
  };
  process.on('exit', flushAllSync);
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
}
_installFlushHandlers();

function parseClaudeSessionFile(sessionFile, opts) {
  if (!fs.existsSync(sessionFile)) return null;

  let stat;
  try {
    stat = fs.statSync(sessionFile);
  } catch {
    return null;
  }

  // Check disk cache (keyed by file path + mtime + size)
  _loadParsedDiskCache();
  const cacheKey = sessionFile + '|' + stat.mtimeMs + '|' + stat.size;
  _fileCacheKeyIndex[sessionFile] = cacheKey;
  if (_parsedDiskCache[cacheKey]) return _parsedDiskCache[cacheKey];

  // Cache-only mode: skip actual file read when not cached. Caller gets
  // null-ish placeholder and the real parse happens in a background job.
  // This is what keeps the sync loadSessions() fast on cold caches.
  if (opts && opts.cacheOnly) {
    _pendingParseFiles.add(sessionFile);
    return null;
  }

  let lines;
  try {
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
  let userMsgCount = 0;
  let entrypointFound = false;
  let worktreeOriginalCwd = '';
  const mcpSet = new Set();
  const skillSet = new Set();

  // Helper: is this `type=user` entry a REAL user prompt, not a tool_result?
  // In Claude Code JSONL, tool_result messages are stored as type='user' with
  // content=[{type:'tool_result', ...}]. We want to count only messages whose
  // content contains real text from the human.
  const isRealUserPrompt = (entry) => {
    const c = (entry.message || {}).content;
    if (typeof c === 'string') return c.trim().length > 0;
    if (Array.isArray(c)) {
      for (const p of c) {
        if (p && p.type === 'text' && p.text && p.text.trim()) return true;
      }
      return false;
    }
    return false;
  };

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' || entry.type === 'assistant') msgCount++;
      if (entry.type === 'user' && isRealUserPrompt(entry)) userMsgCount++;
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
      // MCP/Skill extraction from assistant tool_use blocks
      if (entry.type === 'assistant') {
        const aContent = (entry.message || {}).content;
        if (Array.isArray(aContent)) {
          for (const block of aContent) {
            if (!block || block.type !== 'tool_use') continue;
            const name = block.name || '';
            if (name.startsWith('mcp__')) {
              const parts = name.split('__');
              if (parts.length >= 3) mcpSet.add(parts[1]);
            } else if (name === 'Skill') {
              const sk = (block.input || {}).skill;
              if (sk) skillSet.add(sk.includes(':') ? sk.split(':')[0] : sk);
            }
          }
        }
      }
    } catch {}
  }

  const result = {
    projectPath,
    tool,
    msgCount,
    userMsgCount,
    firstMsg,
    customTitle,
    firstTs,
    lastTs,
    fileSize: stat.size,
    worktreeOriginalCwd,
    mcpServers: Array.from(mcpSet),
    skills: Array.from(skillSet),
  };

  // Cache to disk
  _parsedDiskCache[cacheKey] = result;
  _parsedDiskCacheDirty = true;
  _parsedDiskCacheEntriesSinceFlush++;
  // Periodic flush so long operations don't lose progress on kill
  if (_parsedDiskCacheEntriesSinceFlush >= PARSED_CACHE_FLUSH_EVERY) {
    _saveParsedDiskCache(true);
  }
  return result;
}

// Async variant: for large files (>5 MB) reads in chunks with setImmediate
// between chunks so the Node event loop can handle other requests. Same
// result shape and cache as sync version.
async function parseClaudeSessionFileAsync(sessionFile) {
  if (!fs.existsSync(sessionFile)) return null;
  let stat;
  try { stat = fs.statSync(sessionFile); } catch { return null; }

  _loadParsedDiskCache();
  const cacheKey = sessionFile + '|' + stat.mtimeMs + '|' + stat.size;
  _fileCacheKeyIndex[sessionFile] = cacheKey;
  if (_parsedDiskCache[cacheKey]) return _parsedDiskCache[cacheKey];

  // Small files: use sync path (faster, avoids Promise overhead)
  const BIG_THRESHOLD = 5 * 1024 * 1024; // 5 MB
  if (stat.size < BIG_THRESHOLD) return parseClaudeSessionFile(sessionFile);

  // Big file: stream read + parse line by line with periodic yielding.
  let projectPath = '';
  let tool = 'claude';
  let msgCount = 0;
  let firstMsg = '';
  let customTitle = '';
  let firstTs = stat.mtimeMs;
  let lastTs = stat.mtimeMs;
  let userMsgCount = 0;
  let entrypointFound = false;
  let worktreeOriginalCwd = '';
  const mcpSet = new Set();
  const skillSet = new Set();

  const readline = require('readline');
  const stream = fs.createReadStream(sessionFile, { encoding: 'utf8', highWaterMark: 1 << 20 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const isRealUserPromptAsync = (entry) => {
    const c = (entry.message || {}).content;
    if (typeof c === 'string') return c.trim().length > 0;
    if (Array.isArray(c)) {
      for (const p of c) {
        if (p && p.type === 'text' && p.text && p.text.trim()) return true;
      }
      return false;
    }
    return false;
  };

  let linesSinceYield = 0;
  for await (const line of rl) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' || entry.type === 'assistant') msgCount++;
      if (entry.type === 'user' && isRealUserPromptAsync(entry)) userMsgCount++;
      const rawTimestamp = entry.timestamp;
      const normalizedTimestamp =
        typeof rawTimestamp === 'number'
          ? rawTimestamp
          : (typeof rawTimestamp === 'string' ? Date.parse(rawTimestamp) : NaN);
      if (Number.isFinite(normalizedTimestamp)) {
        if (normalizedTimestamp < firstTs) firstTs = normalizedTimestamp;
        if (normalizedTimestamp > lastTs) lastTs = normalizedTimestamp;
      }
      if (!projectPath && entry.type === 'user' && entry.cwd) projectPath = entry.cwd;
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
      if (entry.type === 'assistant') {
        const aContent = (entry.message || {}).content;
        if (Array.isArray(aContent)) {
          for (const block of aContent) {
            if (!block || block.type !== 'tool_use') continue;
            const name = block.name || '';
            if (name.startsWith('mcp__')) {
              const parts = name.split('__');
              if (parts.length >= 3) mcpSet.add(parts[1]);
            } else if (name === 'Skill') {
              const sk = (block.input || {}).skill;
              if (sk) skillSet.add(sk.includes(':') ? sk.split(':')[0] : sk);
            }
          }
        }
      }
    } catch {}
    if (++linesSinceYield >= 2000) {
      linesSinceYield = 0;
      await new Promise(r => setImmediate(r));
    }
  }

  const result = {
    projectPath, tool, msgCount, userMsgCount,
    firstMsg, customTitle, firstTs, lastTs,
    fileSize: stat.size, worktreeOriginalCwd,
    mcpServers: Array.from(mcpSet), skills: Array.from(skillSet),
  };
  _parsedDiskCache[cacheKey] = result;
  _parsedDiskCacheDirty = true;
  _parsedDiskCacheEntriesSinceFlush++;
  if (_parsedDiskCacheEntriesSinceFlush >= PARSED_CACHE_FLUSH_EVERY) {
    _saveParsedDiskCache(true);
  }
  return result;
}

function mergeClaudeSessionDetail(session, summary, sessionFile) {
  if (!session || !summary) return;

  session.tool = summary.tool || session.tool;
  session.has_detail = true;
  session.file_size = summary.fileSize;
  session.detail_messages = summary.msgCount;
  session.user_messages = summary.userMsgCount || 0;
  session._session_file = sessionFile;
  session.mcp_servers = summary.mcpServers || [];
  session.skills = summary.skills || [];

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

    // Get MCP/Skills usage per session in one query
    const sessionMcp = {};
    const sessionSkills = {};
    try {
      const toolRows = execSync(
        `sqlite3 -separator $'\\t' "${OPENCODE_DB}" "SELECT session_id, json_extract(data, '\\$.tool'), json_extract(data, '\\$.state.input.name') FROM part WHERE json_extract(data, '\\$.type') = 'tool'"`,
        { encoding: 'utf8', timeout: 10000, maxBuffer: 50 * 1024 * 1024 }
      ).trim();
      if (toolRows) {
        for (const tr of toolRows.split('\n')) {
          const cols = tr.split('\t');
          if (cols.length < 2) continue;
          const sid = cols[0];
          const toolName = cols[1];
          const skillName = cols[2];
          if (!sid || !toolName) continue;
          // Skill tool: collect skill name
          if (toolName === 'skill' || toolName === 'skill_mcp') {
            if (skillName) {
              if (!sessionSkills[sid]) sessionSkills[sid] = new Set();
              // Plugin prefix: "superpowers:writing-plans" -> "superpowers"
              // For OpenCode keep full name (e.g. "openspec-propose", "chrome-devtools")
              const sk = skillName.includes(':') ? skillName.split(':')[0] : skillName;
              sessionSkills[sid].add(sk);
            }
            continue;
          }
          // MCP tool: extract server name
          const server = parseOpenCodeMcpServer(toolName);
          if (server) {
            if (!sessionMcp[sid]) sessionMcp[sid] = new Set();
            sessionMcp[sid].add(server);
          }
        }
      }
    } catch {}

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
        mcp_servers: sessionMcp[id] ? Array.from(sessionMcp[id]) : [],
        skills: sessionSkills[id] ? Array.from(sessionSkills[id]) : [],
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

      // Extract text + tools from parts
      let content = '';
      const tools = [];
      const toolSeen = new Set();
      if (partsRaw) {
        for (const partStr of partsRaw.split('|||')) {
          try {
            const part = JSON.parse(partStr);
            if (part.type === 'text' && part.text) {
              content += part.text + '\n';
            } else if (part.type === 'tool' && part.tool) {
              const toolName = part.tool;
              if (toolName === 'skill' || toolName === 'skill_mcp') {
                const skillRaw = part.state && part.state.input && part.state.input.name;
                if (skillRaw) {
                  const sk = skillRaw.includes(':') ? skillRaw.split(':')[0] : skillRaw;
                  const key = 'skill:' + sk;
                  if (!toolSeen.has(key)) {
                    toolSeen.add(key);
                    tools.push({ type: 'skill', skill: sk });
                  }
                }
              } else {
                const server = parseOpenCodeMcpServer(toolName);
                if (server) {
                  const tool = toolName.slice(server.length + 1);
                  const key = 'mcp:' + server + ':' + tool;
                  if (!toolSeen.has(key)) {
                    toolSeen.add(key);
                    tools.push({ type: 'mcp', server: server, tool: tool });
                  }
                }
              }
            }
          } catch {}
        }
      }

      content = content.trim();
      if (!content) continue;

      const tokens = msgData.tokens || {};

      const msg = {
        role: role,
        content: content.slice(0, 2000),
        uuid: '',
        model: msgData.modelID || msgData.model?.modelID || '',
        tokens: tokens,
      };
      if (tools.length > 0) msg.tools = tools;
      messages.push(msg);
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

// Build composerId -> project path mapping from Cursor workspace storage
// Uses disk cache to avoid querying 190+ SQLite files on every startup
let _cursorWsMapCache = null;
const CURSOR_WS_MAP_CACHE_FILE = path.join(os.tmpdir(), 'codedash-cursor-ws-map.json');
const CURSOR_WS_MAP_TTL = 600000; // 10 minutes

function buildCursorWorkspaceMap() {
  if (_cursorWsMapCache) return _cursorWsMapCache;

  // Try loading from disk cache first (~1ms vs ~1500ms full rebuild)
  try {
    if (fs.existsSync(CURSOR_WS_MAP_CACHE_FILE)) {
      const cached = JSON.parse(fs.readFileSync(CURSOR_WS_MAP_CACHE_FILE, 'utf8'));
      if (cached._ts && (Date.now() - cached._ts) < CURSOR_WS_MAP_TTL) {
        delete cached._ts;
        _cursorWsMapCache = cached;
        return cached;
      }
    }
  } catch {}

  const map = {}; // composerId -> projectPath
  if (!fs.existsSync(CURSOR_WORKSPACE_STORAGE)) return map;

  try {
    // Step 1: Read all workspace.json files (fast fs reads, ~10ms)
    const hashToFolder = {};
    for (const hash of fs.readdirSync(CURSOR_WORKSPACE_STORAGE)) {
      const wsJson = path.join(CURSOR_WORKSPACE_STORAGE, hash, 'workspace.json');
      try {
        const wsData = JSON.parse(fs.readFileSync(wsJson, 'utf8'));
        let folder = wsData.folder || '';
        if (folder.startsWith('file://')) {
          folder = decodeURIComponent(folder.replace('file://', ''));
        } else if (folder.startsWith('vscode-remote://')) {
          const m = folder.match(/vscode-remote:\/\/[^/]+(\/.*)/);
          folder = m ? decodeURIComponent(m[1]) : '';
        }
        if (folder) hashToFolder[hash] = folder;
      } catch {}
    }

    // Step 2: Query workspace state.vscdb files for composer IDs
    for (const hash of Object.keys(hashToFolder)) {
      const wsDb = path.join(CURSOR_WORKSPACE_STORAGE, hash, 'state.vscdb');
      if (!fs.existsSync(wsDb)) continue;
      try {
        const raw = execFileSync('sqlite3', [
          wsDb,
          "SELECT value FROM ItemTable WHERE key = 'composer.composerData'"
        ], { encoding: 'utf8', timeout: 2000, windowsHide: true }).trim();
        if (!raw) continue;
        const data = JSON.parse(raw);
        for (const c of (data.allComposers || [])) {
          if (c.composerId) map[c.composerId] = hashToFolder[hash];
        }
      } catch {}
    }
  } catch {}

  _cursorWsMapCache = map;

  // Save to disk cache for fast startup next time
  try {
    fs.writeFileSync(CURSOR_WS_MAP_CACHE_FILE, JSON.stringify(Object.assign({ _ts: Date.now() }, map)));
  } catch {}

  return map;
}

function scanCursorSessions() {
  const sessions = [];
  const seenIds = new Set();

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

          seenIds.add(sessDir);
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

          seenIds.add(chatDir);
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

  // Cursor vscdb sessions are loaded via background task (see _loadCursorVscdbInBackground)
  // and merged into loadSessions() result when ready

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

  // Try loading from global vscdb (Cursor stores most sessions here)
  if (!filePath && fs.existsSync(CURSOR_GLOBAL_DB)) {
    return loadCursorVscdbDetail(sessionId);
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

// Load Cursor session detail from global state.vscdb (composerData + bubbleId entries)
function loadCursorVscdbDetail(sessionId) {
  const messages = [];

  try {
    // Get bubble order from composerData
    const cleanId = sessionId.replace(/'/g, "''");
    const composerRaw = execFileSync('sqlite3', [
      CURSOR_GLOBAL_DB,
      "SELECT value FROM cursorDiskKV WHERE key = 'composerData:" + cleanId + "'"
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();

    if (!composerRaw) return { messages: [] };

    const composer = JSON.parse(composerRaw);
    const bubbleHeaders = composer.fullConversationHeadersOnly || [];
    if (bubbleHeaders.length === 0) return { messages: [] };

    // Query all bubbles for this composer in one go
    const bubbleRows = execFileSync('sqlite3', [
      '-separator', '\t',
      CURSOR_GLOBAL_DB,
      "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:" + cleanId + ":%'"
    ], { encoding: 'utf8', timeout: 10000, maxBuffer: 50 * 1024 * 1024, windowsHide: true }).trim();

    if (!bubbleRows) return { messages: [] };

    // Build bubbleId -> data map
    const bubbleMap = {};
    for (const row of bubbleRows.split('\n')) {
      const tabIdx = row.indexOf('\t');
      if (tabIdx < 0) continue;
      const key = row.slice(0, tabIdx);
      const value = row.slice(tabIdx + 1);
      // key format: bubbleId:<composerId>:<bubbleId>
      const parts = key.split(':');
      const bubbleId = parts[2];
      if (!bubbleId) continue;
      try {
        bubbleMap[bubbleId] = JSON.parse(value);
      } catch {}
    }

    // Iterate in conversation order
    for (const header of bubbleHeaders) {
      const bubble = bubbleMap[header.bubbleId];
      if (!bubble) continue;

      // type 1 = user, type 2 = assistant
      const bType = bubble.type;
      if (bType !== 1 && bType !== 2) continue;

      const role = bType === 1 ? 'user' : 'assistant';
      let text = bubble.text || '';
      text = text.replace(/<\/?user_query>/g, '').replace(/<\/?tool_call>/g, '').trim();
      if (!text) continue;

      messages.push({ role: role, content: text.slice(0, 2000), uuid: '' });
    }
  } catch {}

  return { messages: messages.slice(0, 200) };
}

function parseCodexSessionFile(sessionFile, opts) {
  if (!fs.existsSync(sessionFile)) return null;

  let stat;
  try { stat = fs.statSync(sessionFile); } catch { return null; }

  // Reuse the same parsed-cache keyed by path+mtime+size
  _loadParsedDiskCache();
  const cacheKey = 'codex:' + sessionFile + '|' + stat.mtimeMs + '|' + stat.size;
  if (_parsedDiskCache[cacheKey]) return _parsedDiskCache[cacheKey];

  // Cache-only mode: queue for background parsing, don't block
  if (opts && opts.cacheOnly) {
    _pendingCodexFiles.add(sessionFile);
    return null;
  }

  let lines;
  try {
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
  let userMsgCount = 0;
  let firstMsg = '';
  let firstTs = stat.mtimeMs;
  let lastTs = stat.mtimeMs;
  // Detect sub-agent/scripted codex sessions. Multiple signals:
  //  1. originator='codex_exec' or source='exec' (standard `codex exec`)
  //  2. first user prompt matches known auto-script patterns (team scripts
  //     that spawn codex without the exec flag). Covers: "You are in /path.
  //     Task: X", "Read-only task. Inspect ...", "Work in /path", "Pair-local
  //     <name> lane", "## Memory Writing Agent", etc.
  let isHelper = false;
  // Regexes checked against the first user prompt (see after the loop)
  const AUTO_SCRIPT_PATTERNS = [
    /^You are in \//,
    /^Read-only task\./,
    /^Work (only )?in \//,
    /^Pair-local [^\n]{1,60} lane/,
    /^## [A-Z][a-z]+ [A-Z][a-z]+ Agent/,   // "## Memory Writing Agent:..."
    /^Read \/[^\s]+\/AGENTS\.md/,
    /^Read \$[A-Z_]+\//,
    /^\[Sub-agent results\]/,
    /^You are OMX /,
  ];
  const mcpSet = new Set();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const ts = parseTimestamp(entry.timestamp || entry.ts);
      if (Number.isFinite(ts)) {
        if (ts < firstTs) firstTs = ts;
        if (ts > lastTs) lastTs = ts;
      }

      if (entry.type === 'session_meta' && entry.payload) {
        if (entry.payload.cwd && !projectPath) projectPath = entry.payload.cwd;
        const originator = entry.payload.originator || '';
        const source = entry.payload.source || '';
        if (originator === 'codex_exec' || source === 'exec') isHelper = true;
        continue;
      }

      if (entry.type !== 'response_item' || !entry.payload) continue;

      // MCP function_call extraction
      if (entry.payload.type === 'function_call') {
        const name = entry.payload.name || '';
        if (name.startsWith('mcp__')) {
          const parts = name.split('__');
          if (parts.length >= 3) mcpSet.add(parts[1]);
        }
        continue;
      }

      const role = entry.payload.role;
      if (role !== 'user' && role !== 'assistant') continue;

      const content = extractContent(entry.payload.content);
      if (!content || isSystemMessage(content)) continue;

      msgCount++;
      if (role === 'user') userMsgCount++;
      if (!firstMsg) firstMsg = content.slice(0, 200);
    } catch {}
  }

  // Secondary helper detection by first user prompt pattern
  if (!isHelper && firstMsg) {
    for (const re of AUTO_SCRIPT_PATTERNS) {
      if (re.test(firstMsg)) { isHelper = true; break; }
    }
  }

  const result = {
    projectPath,
    msgCount,
    userMsgCount,
    firstMsg,
    firstTs,
    lastTs,
    fileSize: stat.size,
    mcpServers: Array.from(mcpSet),
    isHelper,
  };
  _parsedDiskCache[cacheKey] = result;
  _parsedDiskCacheDirty = true;
  _parsedDiskCacheEntriesSinceFlush++;
  if (_parsedDiskCacheEntriesSinceFlush >= PARSED_CACHE_FLUSH_EVERY) {
    _saveParsedDiskCache(true);
  }
  return result;
}

// Queue for background codex file parsing (drained by ensureWarmingRunning)
const _pendingCodexFiles = new Set();

function scanCodexSessions() {
  // Map for O(1) session lookups (was O(n²) with .find)
  const sessionsById = new Map();
  const codexTitles = parseCodexSessionIndex(CODEX_DIR);
  const codexHistory = path.join(CODEX_DIR, 'history.jsonl');
  if (fs.existsSync(codexHistory)) {
    const lines = readLines(codexHistory);
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        const sid = d.session_id || d.sessionId || d.id;
        if (!sid) continue;
        const ts = d.ts ? d.ts * 1000 : (d.timestamp || Date.now());
        if (!sessionsById.has(sid)) {
          sessionsById.set(sid, {
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
  // Cache-only: uses the parse cache; uncached files go to background queue.
  const codexSessionsDir = path.join(CODEX_DIR, 'sessions');
  if (fs.existsSync(codexSessionsDir)) {
    try {
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
        const basename = path.basename(f, '.jsonl');
        const uuidMatch = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
        if (!uuidMatch) continue;
        const sid = uuidMatch[1];
        const summary = parseCodexSessionFile(f, { cacheOnly: true });
        if (!summary) {
          // No cached summary yet — create a minimal placeholder from stat
          // so the session still shows in the list. Background job will enrich.
          let size = 0, mtimeMs = 0;
          try { const st = fs.statSync(f); size = st.size; mtimeMs = st.mtimeMs; } catch {}
          const existing = sessionsById.get(sid);
          if (existing) {
            existing.has_detail = true;
            existing.file_size = size;
            existing._detail_pending = true;
          } else {
            sessionsById.set(sid, {
              id: sid,
              tool: 'codex',
              project: '',
              project_short: '',
              first_ts: mtimeMs,
              last_ts: mtimeMs,
              messages: 0,
              first_message: codexTitles[sid] || '',
              has_detail: true,
              file_size: size,
              detail_messages: 0,
              user_messages: 0,
              mcp_servers: [],
              skills: [],
              _detail_pending: true,
            });
          }
          continue;
        }
        const existing = sessionsById.get(sid);
        if (existing) {
          existing.has_detail = true;
          existing.file_size = summary.fileSize;
          existing.messages = summary.msgCount;
          existing.detail_messages = summary.msgCount;
          existing.user_messages = summary.userMsgCount || 0;
          if (summary.isHelper) existing.is_helper = true;
          if (codexTitles[sid]) existing.first_message = codexTitles[sid];
          else if (summary.firstMsg && !existing.first_message) existing.first_message = summary.firstMsg;
          if (summary.projectPath && !existing.project) {
            existing.project = summary.projectPath;
            existing.project_short = summary.projectPath.replace(os.homedir(), '~');
          }
          existing.first_ts = Math.min(existing.first_ts, summary.firstTs);
          existing.last_ts = Math.max(existing.last_ts, summary.lastTs);
          if (summary.mcpServers && summary.mcpServers.length > 0) existing.mcp_servers = summary.mcpServers;
        } else {
          sessionsById.set(sid, {
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
            user_messages: summary.userMsgCount || 0,
            mcp_servers: summary.mcpServers || [],
            skills: [],
            is_helper: summary.isHelper || false,
          });
        }
      }
    } catch {}
  }

  return Array.from(sessionsById.values());
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
// Persistent dir (survives /tmp cleanup). Legacy file in tmpdir migrated once.
const GIT_ROOT_CACHE_FILE = path.join(CODEDASH_CACHE_DIR, 'git-root-cache.json');
const LEGACY_GIT_ROOT_CACHE_FILE = path.join(os.tmpdir(), 'codedash-gitroot-cache.json');
let _gitRootDiskCache = null;
let _gitRootDirty = false;
// Queue of project paths that still need git resolution. Filled by sync
// loadSessions() when a path is uncached, drained in background by
// _ensureGitRootResolverRunning() so the sync path returns immediately.
const _pendingGitRoots = new Set();
let _gitRootResolverRunning = false;

function _loadGitRootDiskCache() {
  if (_gitRootDiskCache) return;
  try {
    if (fs.existsSync(GIT_ROOT_CACHE_FILE)) {
      _gitRootDiskCache = JSON.parse(fs.readFileSync(GIT_ROOT_CACHE_FILE, 'utf8'));
    } else if (fs.existsSync(LEGACY_GIT_ROOT_CACHE_FILE)) {
      _gitRootDiskCache = JSON.parse(fs.readFileSync(LEGACY_GIT_ROOT_CACHE_FILE, 'utf8'));
      _gitRootDirty = true;
    }
    if (_gitRootDiskCache) Object.assign(_gitRootCache, _gitRootDiskCache);
  } catch {}
  if (!_gitRootDiskCache) _gitRootDiskCache = {};
}

function _saveGitRootDiskCache() {
  if (!_gitRootDirty) return;
  try {
    const tmp = GIT_ROOT_CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_gitRootCache));
    fs.renameSync(tmp, GIT_ROOT_CACHE_FILE);
    _gitRootDirty = false;
  } catch {}
}

// Sync resolver: never shells out from the hot path. Uses cache; queues
// unknown paths for background resolution.
// ── Conversation group key ─────────────────────────────────
// Two sessions belong to the same conversation group if they share the same
// project AND the same initial user prompt (first ~200 chars). This dedupes
// `codex exec` retries, `codex resume` chains, and sub-agent re-runs that
// would otherwise show as N separate cards in the UI. Helper sessions
// (is_helper=true) all collapse into their own single bucket per project.
function computeSessionGroupKey(s) {
  const proj = (s.project || 'unknown').trim();
  // Normalize first message: collapse whitespace, trim, truncate
  let msg = (s.first_message || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (s.is_helper) {
    // All helpers in the same project collapse into one group.
    return 'helper::' + proj;
  }
  if (!msg) return s.tool + '::' + proj + '::' + s.id; // no prompt — unique
  return s.tool + '::' + proj + '::' + msg;
}

function resolveGitRoot(projectPath) {
  if (!projectPath) return '';
  _loadGitRootDiskCache();
  if (_gitRootCache[projectPath] !== undefined) return _gitRootCache[projectPath];
  // Fast skip: non-existent paths can never be git roots, record & done.
  if (!fs.existsSync(projectPath)) {
    _gitRootCache[projectPath] = '';
    _gitRootDirty = true;
    return '';
  }
  // Queue for background resolver — sync path returns '' for now
  _pendingGitRoots.add(projectPath);
  _ensureGitRootResolverRunning();
  return '';
}

function _ensureGitRootResolverRunning() {
  if (_gitRootResolverRunning) return;
  if (_pendingGitRoots.size === 0) return;
  _gitRootResolverRunning = true;
  setImmediate(async () => {
    try {
      while (_pendingGitRoots.size > 0) {
        const snapshot = Array.from(_pendingGitRoots);
        for (const p of snapshot) {
          _pendingGitRoots.delete(p);
          if (_gitRootCache[p] !== undefined) continue;
          let root = '';
          try {
            root = execFileSync('git', ['-C', p, 'rev-parse', '--show-toplevel'], {
              encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
          } catch {}
          _gitRootCache[p] = root;
          _gitRootDirty = true;
          // Yield between shell-outs so HTTP stays responsive
          await new Promise(r => setImmediate(r));
        }
        _saveGitRootDiskCache();
      }
    } finally {
      _gitRootResolverRunning = false;
    }
  });
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
const SESSIONS_CACHE_TTL = 60000; // 60 seconds — hot cache, extended if no file changes

// Track history/projects mtime so we only rescan when files actually changed.
// Lets loadSessions() extend the cache window past TTL when nothing happened.
let _historyMtime = 0;
let _historySize = 0;
let _projectsDirMtime = 0;

function _sessionsNeedRescan() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const st = fs.statSync(HISTORY_FILE);
      if (st.mtimeMs !== _historyMtime || st.size !== _historySize) return true;
    }
    if (fs.existsSync(PROJECTS_DIR)) {
      const st = fs.statSync(PROJECTS_DIR);
      if (st.mtimeMs !== _projectsDirMtime) return true;
    }
  } catch {}
  return false;
}

function _updateScanMarkers() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const st = fs.statSync(HISTORY_FILE);
      _historyMtime = st.mtimeMs;
      _historySize = st.size;
    }
    if (fs.existsSync(PROJECTS_DIR)) {
      _projectsDirMtime = fs.statSync(PROJECTS_DIR).mtimeMs;
    }
  } catch {}
}

// Progressive loading: cursor vscdb sessions load in background
let _cursorVscdbSessions = null;
let _cursorVscdbLoading = false;

function _loadCursorVscdbInBackground() {
  if (_cursorVscdbLoading || _cursorVscdbSessions) return;
  if (!fs.existsSync(CURSOR_GLOBAL_DB)) { _cursorVscdbSessions = []; return; }
  _cursorVscdbLoading = true;

  // Workspace map from disk cache is instant (~1ms), only global DB query is slow
  const wsMap = buildCursorWorkspaceMap();
  const homedir = os.homedir();

  // Async sqlite3 queries — do NOT block the event loop
  // Query 1: session metadata, Query 2: exact user bubble count per composer
  const query = "SELECT json_extract(value, '$.composerId'), json_extract(value, '$.name'), json_extract(value, '$.createdAt'), json_extract(value, '$.lastUpdatedAt'), json_array_length(json_extract(value, '$.fullConversationHeadersOnly')) FROM cursorDiskKV WHERE key LIKE 'composerData:%'";

  const cp = require('child_process');
  cp.execFile('sqlite3', [
    '-separator', '\t', CURSOR_GLOBAL_DB, query
  ], { encoding: 'utf8', timeout: 15000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
  function(err, stdout) {
    // Query 2: user bubble counts + token totals per composer (combined for efficiency)
    const statsQuery = "SELECT substr(key, 10, 36) as cid, " +
      "sum(CASE WHEN json_extract(value, '$.type') = 1 THEN 1 ELSE 0 END), " +
      "sum(CASE WHEN json_extract(value, '$.tokenCount.inputTokens') > 0 THEN json_extract(value, '$.tokenCount.inputTokens') ELSE 0 END), " +
      "sum(CASE WHEN json_extract(value, '$.tokenCount.outputTokens') > 0 THEN json_extract(value, '$.tokenCount.outputTokens') ELSE 0 END) " +
      "FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' GROUP BY cid";

    cp.execFile('sqlite3', [
      '-separator', '\t', CURSOR_GLOBAL_DB, statsQuery
    ], { encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
    function(err2, stdout2) {
    // Build per-composer stats from query 2
    const composerStats = {}; // { userCount, inputTokens, outputTokens }
    if (stdout2) {
      for (const row of stdout2.trim().split('\n')) {
        const cols = row.split('\t');
        if (cols.length < 4) continue;
        composerStats[cols[0]] = {
          userCount: parseInt(cols[1]) || 0,
          inputTokens: parseInt(cols[2]) || 0,
          outputTokens: parseInt(cols[3]) || 0,
        };
      }
    }

    // Build model map from composerData (query 1 already has this via the main query)
    // We need to add model to the main query — for now extract from sessions metadata
    // Query 3: models per composer (lightweight)
    const modelQuery = "SELECT json_extract(value, '$.composerId'), json_extract(value, '$.modelConfig.modelName') FROM cursorDiskKV WHERE key LIKE 'composerData:%'";

    cp.execFile('sqlite3', [
      '-separator', '\t', CURSOR_GLOBAL_DB, modelQuery
    ], { encoding: 'utf8', timeout: 10000, maxBuffer: 5 * 1024 * 1024, windowsHide: true },
    function(err3, stdout3) {
    const composerModels = {};
    if (stdout3) {
      for (const row of stdout3.trim().split('\n')) {
        const tabIdx = row.indexOf('\t');
        if (tabIdx > 0) composerModels[row.slice(0, tabIdx)] = row.slice(tabIdx + 1) || '';
      }
    }

    try {
      const results = [];
      const rows = (stdout || '').trim();
      if (rows) {
        for (const row of rows.split('\n')) {
          const cols = row.split('\t');
          if (cols.length < 5) continue;
          const composerId = cols[0];
          if (!composerId) continue;
          const msgCount = parseInt(cols[4]) || 0;
          if (msgCount === 0) continue;
          const projectPath = wsMap[composerId] || '';
          const stats = composerStats[composerId] || {};
          results.push({
            id: composerId,
            tool: 'cursor',
            project: projectPath,
            project_short: projectPath ? projectPath.replace(homedir, '~') : '',
            first_ts: parseInt(cols[2]) || 0,
            last_ts: parseInt(cols[3]) || parseInt(cols[2]) || 0,
            messages: msgCount,
            first_message: (cols[1] || '').slice(0, 200),
            has_detail: true,
            file_size: 0,
            detail_messages: msgCount,
            user_messages: stats.userCount || 0,
            _cursor_vscdb: true,
            _cursor_input_tokens: stats.inputTokens || 0,
            _cursor_output_tokens: stats.outputTokens || 0,
            _cursor_model: composerModels[composerId] || '',
          });
        }
      }
      _cursorVscdbSessions = results;
    } catch {
      _cursorVscdbSessions = [];
    }
    _cursorVscdbLoading = false;
    // Merge into existing cache instead of full invalidation
    if (_sessionsCache && _cursorVscdbSessions && _cursorVscdbSessions.length > 0) {
      const existingIds = new Set(_sessionsCache.map(function(s) { return s.id; }));
      const newSessions = [];
      for (var i = 0; i < _cursorVscdbSessions.length; i++) {
        var cs = _cursorVscdbSessions[i];
        if (existingIds.has(cs.id)) continue;
        cs.first_time = new Date(cs.first_ts).toLocaleString('sv-SE').slice(0, 16);
        cs.last_time = new Date(cs.last_ts).toLocaleString('sv-SE').slice(0, 16);
        var dt = new Date(cs.last_ts);
        cs.date = dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
        cs.git_root = '';
        if (!cs.mcp_servers) cs.mcp_servers = [];
        if (!cs.skills) cs.skills = [];
        newSessions.push(cs);
      }
      if (newSessions.length > 0) {
        _sessionsCache = _sessionsCache.concat(newSessions).sort(function(a, b) { return b.last_ts - a.last_ts; });
        // Keep the same cache timestamp — no full rebuild needed
      }
    } else {
      _sessionsCache = null;
      _sessionsCacheTs = 0;
    }
    }); // end execFile query 3 (models)
    }); // end execFile query 2 (stats)
  }); // end execFile query 1 (sessions)
}

function loadSessions() {
  const now = Date.now();
  if (_sessionsCache) {
    // Hot cache: return immediately within TTL window
    if ((now - _sessionsCacheTs) < SESSIONS_CACHE_TTL) return _sessionsCache;
    // Extended cache: after TTL, only rescan if files actually changed
    if (!_sessionsNeedRescan()) {
      _sessionsCacheTs = now;
      return _sessionsCache;
    }
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
  // Build file index once to avoid O(sessions*projects) existsSync scans
  _buildSessionFileIndex();
  for (const [sid, s] of Object.entries(sessions)) {
    if (s.tool !== 'claude' && s.tool !== 'claude-ext') continue;
    let sessionFile = '';
    if (s._session_file) {
      sessionFile = s._session_file;
    } else {
      // Use pre-built index instead of scanning dirs
      const indexed = _sessionFileIndex[sid];
      if (indexed && indexed.format === 'claude') sessionFile = indexed.file;
    }

    if (sessionFile) {
      // Cache-only: never read disk from the sync path. Uncached files are
      // queued for background warming — subsequent calls will see full data.
      const summary = parseClaudeSessionFile(sessionFile, { cacheOnly: true });
      if (summary) mergeClaudeSessionDetail(s, summary, sessionFile);
      else {
        // Placeholder: session exists on disk, actual details pending
        s.has_detail = true;
        s._session_file = sessionFile;
        s._detail_pending = true;
        try { s.file_size = fs.statSync(sessionFile).size; } catch { s.file_size = 0; }
        if (s.detail_messages === undefined) s.detail_messages = 0;
        if (!s.mcp_servers) s.mcp_servers = [];
        if (!s.skills) s.skills = [];
      }
    } else if (!s.has_detail) {
      s.has_detail = false;
      s.file_size = 0;
      s.detail_messages = 0;
      s.mcp_servers = [];
      s.skills = [];
    }
  }

  // Scan project dirs for orphan sessions (e.g. Claude Extension sessions not in history.jsonl)
  // Cache-only in sync path; uncached files get queued and background job parses them.
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
            const summary = parseClaudeSessionFile(filePath, { cacheOnly: true });
            if (summary) mergeClaudeSessionDetail(sessions[sid], summary, filePath);
            else sessions[sid]._detail_pending = true;
            continue;
          }
          const summary = parseClaudeSessionFile(filePath, { cacheOnly: true });
          if (!summary) {
            // Create a placeholder from stat + history of same sid (none here)
            let size = 0;
            let placeholderTs = 0;
            try {
              const stat = fs.statSync(filePath);
              size = stat.size;
              if (Number.isFinite(stat.mtimeMs) && stat.mtimeMs > 0) {
                placeholderTs = Math.floor(stat.mtimeMs);
              } else if (Number.isFinite(stat.ctimeMs) && stat.ctimeMs > 0) {
                placeholderTs = Math.floor(stat.ctimeMs);
              }
            } catch {}
            sessions[sid] = {
              id: sid,
              tool: 'claude',
              project: '',
              project_short: '',
              first_ts: placeholderTs,
              last_ts: placeholderTs,
              messages: 0,
              first_message: '',
              has_detail: true,
              file_size: size,
              detail_messages: 0,
              mcp_servers: [],
              skills: [],
              _claude_dir: CLAUDE_DIR,
              _session_file: filePath,
              _detail_pending: true,
              worktree_original_cwd: '',
            };
            continue;
          }
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
            mcp_servers: summary.mcpServers,
            skills: summary.skills,
            _claude_dir: CLAUDE_DIR,
            _session_file: filePath,
            worktree_original_cwd: summary.worktreeOriginalCwd || '',
          };
        }
      }
    } catch {}
  }

  // If any Claude files were uncached, _pendingParseFiles has been populated
  // by parseClaudeSessionFile(cacheOnly: true). Kick off the warmer.
  _ensureWarmingRunning();
  // Kick off one-shot SQLite backfill (noop if already running/done)
  _ensureSqliteBackfillRunning();

  // Ensure all sessions have mcp_servers/skills (defaults for non-Claude)
  for (const s of Object.values(sessions)) {
    if (!s.mcp_servers) s.mcp_servers = [];
    if (!s.skills) s.skills = [];
  }

  // Merge background-loaded Cursor vscdb sessions (progressive loading)
  const existingIds = new Set(Object.keys(sessions));
  if (_cursorVscdbSessions) {
    for (const cs of _cursorVscdbSessions) {
      if (!existingIds.has(cs.id)) sessions[cs.id] = cs;
    }
  } else {
    // Kick off background loading if not started yet
    _loadCursorVscdbInBackground();
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
    // Conversation group key — sessions with the same project + initial
    // prompt are treated as retries/resumes of the same conversation. Used
    // by the shared groupSessions() helper in all views (Timeline, All
    // Sessions, Cloud Sync) so we don't render 50 duplicate cards.
    s.group_key = computeSessionGroupKey(s);
  }

  // Flag for frontend: true = cursor vscdb still loading, will have more data soon
  result._loading = !_cursorVscdbSessions && _cursorVscdbLoading;
  // Warming state: true when background parse of session files is in progress
  result._warming = _warmingStatus.running;
  if (_warmingStatus.running || _warmingStatus.pending > 0) {
    result._warmingProgress = {
      done: _warmingStatus.done,
      total: _warmingStatus.total,
      phase: _warmingStatus.phase,
      pending: _pendingParseFiles.size,
    };
  }

  // Flush disk caches (non-force: only writes if dirty beyond threshold)
  _saveParsedDiskCache();
  _saveGitRootDiskCache();
  _updateScanMarkers();

  _sessionsCache = result;
  _sessionsCacheTs = Date.now();
  return result;
}

// ── Async pre-warm of parse cache + incremental change detection ─────────
// Lists all Claude session JSONL files and parses those whose cache entry
// is stale (mtime or size changed) or missing. Yields between files so the
// HTTP event loop stays responsive. Reports progress via callback.
async function loadSessionsAsync(progressCb) {
  _loadParsedDiskCache();
  _loadCostDiskCache();

  const report = (phase, done, total, extra) => {
    if (typeof progressCb === 'function') {
      try { progressCb({ phase, done, total, ...(extra || {}) }); } catch {}
    }
  };

  // Phase 1: enumerate all Claude JSONL files (fast, just readdir)
  report('scanning files', 0, 0);
  const allClaudeFiles = [];
  const walkClaude = (dir) => {
    try {
      for (const proj of fs.readdirSync(dir)) {
        const projDir = path.join(dir, proj);
        try {
          if (!fs.statSync(projDir).isDirectory()) continue;
          for (const file of fs.readdirSync(projDir)) {
            if (!file.endsWith('.jsonl')) continue;
            allClaudeFiles.push(path.join(projDir, file));
          }
        } catch {}
      }
    } catch {}
  };
  if (fs.existsSync(PROJECTS_DIR)) walkClaude(PROJECTS_DIR);
  for (const extra of EXTRA_CLAUDE_DIRS) {
    const ep = path.join(extra, 'projects');
    if (fs.existsSync(ep)) walkClaude(ep);
  }

  // Phase 2: figure out which files need (re)parsing — incremental path
  const toParse = [];
  let cachedCount = 0;
  for (const f of allClaudeFiles) {
    let stat;
    try { stat = fs.statSync(f); } catch { continue; }
    const key = f + '|' + stat.mtimeMs + '|' + stat.size;
    if (_parsedDiskCache[key]) {
      _fileCacheKeyIndex[f] = key;
      cachedCount++;
    } else {
      toParse.push({ file: f, size: stat.size });
    }
  }
  // Parse newest (largest mtime) first so dashboards reflect fresh data fastest
  toParse.sort((a, b) => {
    try { return fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs; } catch { return 0; }
  });

  const total = allClaudeFiles.length;
  report('parsing session files', cachedCount, total, { cached: cachedCount, toParse: toParse.length });

  // Phase 3: parse uncached files with yielding
  let done = cachedCount;
  for (const { file, size } of toParse) {
    try {
      if (size >= 5 * 1024 * 1024) {
        await parseClaudeSessionFileAsync(file);
      } else {
        parseClaudeSessionFile(file);
        // Tiny yield so poll requests can slot in between files
        await new Promise(r => setImmediate(r));
      }
    } catch {}
    done++;
    report('parsing session files', done, total, { cached: cachedCount, toParse: toParse.length });
  }
  _saveParsedDiskCache(true);

  // Phase 4: invalidate any stale in-memory session cache, then build full
  // sessions list from now-warm parse cache (sync call, fast)
  _sessionsCache = null;
  _sessionsCacheTs = 0;
  report('aggregating sessions', total, total);
  const sessions = loadSessions();
  return sessions;
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
            const msg = { role: entry.type, content: content.slice(0, 2000), uuid: entry.uuid || '' };
            if (entry.type === 'assistant') {
              const rawContent = (entry.message || {}).content;
              if (Array.isArray(rawContent)) {
                const tools = extractTools(rawContent);
                if (tools.length > 0) msg.tools = tools;
              }
            }
            messages.push(msg);
          }
        }
      } else {
        // Codex format: response_item with payload
        if (entry.type === 'response_item' && entry.payload) {
          const pType = entry.payload.type;
          const role = entry.payload.role;
          if (role === 'user' || role === 'assistant') {
            const content = extractContent(entry.payload.content);
            if (content && !isSystemMessage(content)) {
              messages.push({ role: role, content: content.slice(0, 2000), uuid: '' });
            }
          }
          // Codex function_call → attach as tool to last assistant message
          if (pType === 'function_call') {
            const name = entry.payload.name || '';
            if (name.startsWith('mcp__')) {
              const parts = name.split('__');
              if (parts.length >= 3) {
                const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
                if (lastMsg && lastMsg.role === 'assistant') {
                  if (!lastMsg.tools) lastMsg.tools = [];
                  if (!lastMsg._toolSeen) lastMsg._toolSeen = new Set();
                  const tool = parts.slice(2).join('__');
                  const key = 'mcp:' + parts[1] + ':' + tool;
                  if (!lastMsg._toolSeen.has(key)) {
                    lastMsg._toolSeen.add(key);
                    lastMsg.tools.push({ type: 'mcp', server: parts[1], tool: tool });
                  }
                }
              }
            }
          }
        }
      }
    } catch {}
  }

  // Clean up internal markers from Codex
  for (const m of messages) {
    if (m._toolSeen) delete m._toolSeen;
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

  // For non-Claude formats, use the detail loader for markdown export
  if (found && found.format !== 'claude') {
    const detail =
      found.format === 'cursor' ? loadCursorDetail(sessionId) :
      found.format === 'opencode' ? loadOpenCodeDetail(sessionId) :
      found.format === 'kiro' ? loadKiroDetail(sessionId) :
      null;
    if (detail && detail.messages && detail.messages.length > 0) {
      const parts = [`# Session ${sessionId}\n\n**Project:** ${project || '(none)'}\n`];
      for (const msg of detail.messages) {
        const header = msg.role === 'user' ? '## User' : '## Assistant';
        parts.push(`\n${header}\n\n${msg.content}\n`);
      }
      return parts.join('');
    }
  }

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

// Session file index: sessionId -> file path (built once, avoids O(sessions*projects) scans)
let _sessionFileIndex = null;
let _sessionFileIndexTs = 0;
const SESSION_FILE_INDEX_TTL = 30000; // 30 seconds

function _buildSessionFileIndex() {
  const now = Date.now();
  if (_sessionFileIndex && (now - _sessionFileIndexTs) < SESSION_FILE_INDEX_TTL) return;

  _sessionFileIndex = {};
  // Index Claude project files
  const allProjectDirs = [PROJECTS_DIR];
  for (const extraDir of EXTRA_CLAUDE_DIRS) {
    allProjectDirs.push(path.join(extraDir, 'projects'));
  }
  for (const projDir of allProjectDirs) {
    if (!fs.existsSync(projDir)) continue;
    try {
      for (const proj of fs.readdirSync(projDir)) {
        const dir = path.join(projDir, proj);
        try {
          if (!fs.statSync(dir).isDirectory()) continue;
          for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith('.jsonl')) continue;
            const sid = file.replace('.jsonl', '');
            if (!_sessionFileIndex[sid]) {
              _sessionFileIndex[sid] = { file: path.join(dir, file), format: 'claude' };
            }
          }
        } catch {}
      }
    } catch {}
  }

  // Index Cursor transcript files
  if (fs.existsSync(CURSOR_PROJECTS)) {
    try {
      for (const proj of fs.readdirSync(CURSOR_PROJECTS)) {
        const transcriptsDir = path.join(CURSOR_PROJECTS, proj, 'agent-transcripts');
        if (!fs.existsSync(transcriptsDir)) continue;
        try {
          for (const sessDir of fs.readdirSync(transcriptsDir)) {
            const f = path.join(transcriptsDir, sessDir, sessDir + '.jsonl');
            if (fs.existsSync(f)) _sessionFileIndex[sessDir] = { file: f, format: 'cursor' };
          }
        } catch {}
      }
    } catch {}
  }

  // Index Cursor chat files
  if (fs.existsSync(CURSOR_CHATS)) {
    try {
      for (const chatDir of fs.readdirSync(CURSOR_CHATS)) {
        const fullDir = path.join(CURSOR_CHATS, chatDir);
        try {
          if (!fs.statSync(fullDir).isDirectory()) continue;
          for (const f of fs.readdirSync(fullDir)) {
            if (f.endsWith('.jsonl') || f.endsWith('.json')) {
              _sessionFileIndex[chatDir] = { file: path.join(fullDir, f), format: 'cursor' };
              break;
            }
          }
        } catch {}
      }
    } catch {}
  }

  _sessionFileIndexTs = now;
}

function findSessionFile(sessionId, project) {
  _buildSessionFileIndex();

  // Fast index lookup
  if (_sessionFileIndex[sessionId]) return _sessionFileIndex[sessionId];

  // Try Claude projects dir (direct path if project known)
  if (project) {
    const projectKey = project.replace(/[^a-zA-Z0-9-]/g, '-');
    const claudeFile = path.join(PROJECTS_DIR, projectKey, `${sessionId}.jsonl`);
    if (fs.existsSync(claudeFile)) return { file: claudeFile, format: 'claude' };
  }

  // Extra Claude dirs and Cursor files are already in the index.
  // Only Codex (date tree) and SQLite agents need fallback lookup.

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

  // Cursor JSONL files are already in the index. Only check vscdb fallback.

  // Try Cursor global vscdb
  if (fs.existsSync(CURSOR_GLOBAL_DB)) {
    try {
      const cleanId = sessionId.replace(/'/g, "''");
      const check = execFileSync('sqlite3', [
        CURSOR_GLOBAL_DB,
        "SELECT COUNT(*) FROM cursorDiskKV WHERE key = 'composerData:" + cleanId + "'"
      ], { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim();
      if (parseInt(check) > 0) {
        return { file: CURSOR_GLOBAL_DB, format: 'cursor', sessionId: sessionId };
      }
    } catch {}
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
  // XML-wrapped injected context (Claude Code + Codex)
  if (t.startsWith('<permissions')) return true;
  if (t.startsWith('<environment_context')) return true;
  if (t.startsWith('<collaboration_mode')) return true;
  if (t.startsWith('<INSTRUCTIONS>')) return true;
  if (t.startsWith('<cwd>')) return true;
  if (t.startsWith('<turn_aborted>')) return true;
  if (t.startsWith('<ide_selection>')) return true;
  if (t.startsWith('<command_output>')) return true;
  // Agent instruction docs and skill metadata
  if (t.startsWith('# AGENTS.md')) return true;
  if (t.startsWith('# CLAUDE.md')) return true;
  // Codex developer/system prompts
  if (t.startsWith('You are Codex')) return true;
  if (t.startsWith('Filesystem sandboxing')) return true;
  // Codex runtime nudges / auto-steering (not real user prompts)
  if (t.startsWith('Warning: The maximum number of unified exec')) return true;
  if (t.indexOf('AUTOSTEERING:') >= 0 && t.length < 400) return true;
  // Sub-agent delegate result injection
  if (t.startsWith('[Sub-agent results]')) return true;
  if (t.startsWith('[sub-agent result]')) return true;
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

// Extract MCP/Skill tool_use blocks from a Claude assistant message content array.
// Returns deduplicated array of { type, server, tool } or { type, skill }.
function extractTools(contentBlocks) {
  if (!Array.isArray(contentBlocks)) return [];
  const tools = [];
  const seen = new Set();
  for (const block of contentBlocks) {
    if (!block || block.type !== 'tool_use') continue;
    const name = block.name || '';
    if (name.startsWith('mcp__')) {
      const parts = name.split('__');
      if (parts.length >= 3) {
        const tool = parts.slice(2).join('__');
        const key = 'mcp:' + parts[1] + ':' + tool;
        if (!seen.has(key)) {
          seen.add(key);
          tools.push({ type: 'mcp', server: parts[1], tool: tool });
        }
      }
    } else if (name === 'Skill') {
      const skillRaw = (block.input || {}).skill;
      if (skillRaw) {
        // Use plugin name only (e.g. "superpowers:writing-plans" -> "superpowers")
        const skill = skillRaw.includes(':') ? skillRaw.split(':')[0] : skillRaw;
        const key = 'skill:' + skill;
        if (!seen.has(key)) {
          seen.add(key);
          tools.push({ type: 'skill', skill: skill });
        }
      }
    }
  }
  return tools;
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

  // Prefer the persistent SQLite FTS5 index — O(log n), no RAM bloat.
  try {
    const sqliteIndex = require('./sqlite-index');
    const rows = sqliteIndex.search(query, 200);
    if (rows && rows.length > 0) {
      // Group by session_id, keep up to 3 snippets per session
      const bySession = {};
      for (const r of rows) {
        if (!bySession[r.session_id]) bySession[r.session_id] = [];
        if (bySession[r.session_id].length >= 3) continue;
        bySession[r.session_id].push({
          role: r.role,
          snippet: (r.snippet || '').replace(/<</g, '').replace(/>>/g, ''),
        });
      }
      return Object.keys(bySession).map(sid => ({ sessionId: sid, matches: bySession[sid] }));
    }
  } catch (e) {
    // Fall through to in-memory fallback
  }

  // Fallback: in-memory scan (pre-SQLite ingest completion)
  const q = query.toLowerCase();
  const index = getSearchIndex(sessions);
  const results = [];
  for (const entry of index) {
    if (entry.fullText.indexOf(q) === -1) continue;
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
    if (matches.length > 0) results.push({ sessionId: entry.sessionId, matches });
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
// (COST_CACHE_FILE/_costDiskCache/_loadCostDiskCache/_saveCostDiskCache defined at top)

const EMPTY_COST = { cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, contextPctSum: 0, contextTurnCount: 0, model: '' };

// In-memory cost cache (reset when sessions cache resets)
const _costMemCache = {};

function computeSessionCost(sessionId, project) {
  // Fast in-memory cache (same session never changes within request cycle)
  if (_costMemCache[sessionId] !== undefined) return _costMemCache[sessionId];

  const found = findSessionFile(sessionId, project);
  if (!found) { _costMemCache[sessionId] = EMPTY_COST; return EMPTY_COST; }

  // Skip formats that never have cost data
  if (found.format === 'cursor' || found.format === 'kiro') { _costMemCache[sessionId] = EMPTY_COST; return EMPTY_COST; }

  // Check disk cache (keyed by file path + mtime + size for JSONL, sessionId for SQLite)
  _loadCostDiskCache();
  let cacheKey = '';
  if (found.format === 'opencode') {
    cacheKey = 'opencode:' + sessionId;
  } else if (found.file) {
    // Use file stat lookup (reuse from parsed cache index if available)
    const cached = _fileCacheKeyIndex[found.file];
    if (cached) {
      cacheKey = cached;
    } else {
      try {
        const stat = fs.statSync(found.file);
        cacheKey = found.file + '|' + stat.mtimeMs + '|' + stat.size;
        _fileCacheKeyIndex[found.file] = cacheKey;
      } catch {}
    }
  }
  if (cacheKey && _costDiskCache[cacheKey]) return _costDiskCache[cacheKey];

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

  const result = { cost: totalCost, inputTokens: totalInput, outputTokens: totalOutput, cacheReadTokens: totalCacheRead, cacheCreateTokens: totalCacheCreate, contextPctSum, contextTurnCount, model };
  if (cacheKey) {
    _costDiskCache[cacheKey] = result;
    _costDiskCacheDirty = true;
    _costDiskCacheEntriesSinceFlush++;
    if (_costDiskCacheEntriesSinceFlush >= COST_CACHE_FLUSH_EVERY) {
      _saveCostDiskCache(true);
    }
  }
  _costMemCache[sessionId] = result;
  return result;
}

// ── Cost analytics ────────────────────────────────────────

// ── Incremental cost aggregator ───────────────────────────────
// Streaming version of getCostAnalytics: create an aggregator, feed sessions
// one at a time via merge(), read a snapshot at any point via finalize().
// Lets the background job expose live partial results to the UI.
function createCostAggregator() {
  const state = {
    byDay: {}, byProject: {}, byWeek: {}, byAgent: {},
    totalCost: 0, totalTokens: 0,
    totalInputTokens: 0, totalOutputTokens: 0,
    totalCacheReadTokens: 0, totalCacheCreateTokens: 0,
    globalContextPctSum: 0, globalContextTurnCount: 0,
    firstDate: null, lastDate: null,
    sessionsWithData: 0,
    sessionCosts: [],
    agentNoCostData: {},
    seenAgents: new Set(),
    processedCount: 0,
  };
  return {
    state,
    merge(session, costData) {
      state.processedCount++;
      if (!state.seenAgents.has(session.tool)) {
        state.seenAgents.add(session.tool);
        if (!state.byAgent[session.tool]) state.byAgent[session.tool] = { cost: 0, sessions: 0, tokens: 0, estimated: false };
      }
      const cost = costData.cost;
      const tokens = costData.inputTokens + costData.outputTokens + costData.cacheReadTokens + costData.cacheCreateTokens;
      if (cost === 0 && tokens === 0) {
        if (!state.agentNoCostData[session.tool]) state.agentNoCostData[session.tool] = 0;
        state.agentNoCostData[session.tool]++;
        return;
      }
      state.sessionsWithData++;
      state.totalCost += cost;
      state.totalTokens += tokens;
      state.totalInputTokens += costData.inputTokens;
      state.totalOutputTokens += costData.outputTokens;
      state.totalCacheReadTokens += costData.cacheReadTokens;
      state.totalCacheCreateTokens += costData.cacheCreateTokens;

      const agent = session.tool || 'unknown';
      if (!state.byAgent[agent]) state.byAgent[agent] = { cost: 0, sessions: 0, tokens: 0, estimated: false };
      state.byAgent[agent].cost += cost;
      state.byAgent[agent].sessions++;
      state.byAgent[agent].tokens += tokens;
      if (agent === 'codex') state.byAgent[agent].estimated = true;
      if (agent === 'cursor' && costData.model && costData.model.includes('-estimated')) state.byAgent[agent].estimated = true;
      if (agent === 'opencode' && !costData.model) state.byAgent[agent].estimated = true;

      state.globalContextPctSum += costData.contextPctSum;
      state.globalContextTurnCount += costData.contextTurnCount;

      const day = session.date || 'unknown';
      if (session.date) {
        if (!state.firstDate || session.date < state.firstDate) state.firstDate = session.date;
        if (!state.lastDate || session.date > state.lastDate) state.lastDate = session.date;
      }
      if (!state.byDay[day]) state.byDay[day] = { cost: 0, sessions: 0, tokens: 0 };
      state.byDay[day].cost += cost;
      state.byDay[day].sessions++;
      state.byDay[day].tokens += tokens;

      if (session.date) {
        const d = new Date(session.date);
        const weekStart = new Date(d);
        weekStart.setDate(d.getDate() - d.getDay());
        const weekKey = weekStart.toISOString().slice(0, 10);
        if (!state.byWeek[weekKey]) state.byWeek[weekKey] = { cost: 0, sessions: 0 };
        state.byWeek[weekKey].cost += cost;
        state.byWeek[weekKey].sessions++;
      }

      const proj = session.project_short || session.project || 'unknown';
      if (!state.byProject[proj]) state.byProject[proj] = { cost: 0, sessions: 0, tokens: 0 };
      state.byProject[proj].cost += cost;
      state.byProject[proj].sessions++;
      state.byProject[proj].tokens += tokens;

      state.sessionCosts.push({ id: session.id, cost, project: proj, date: session.date, last_ts: session.last_ts || 0 });
    },
    finalize() {
      // Sort top sessions by cost (snapshot a shallow copy so partials stay consistent)
      const topCopy = state.sessionCosts.slice().sort((a, b) => b.cost - a.cost);
      const days = state.firstDate && state.lastDate
        ? Math.max(1, Math.round((new Date(state.lastDate) - new Date(state.firstDate)) / 86400000) + 1)
        : 1;
      const now = Date.now();
      const todayStr = new Date().toISOString().slice(0, 10);
      const hoursElapsedToday = (now - new Date(todayStr).getTime()) / 3600000;
      let last1hCost = 0;
      let todayCost = 0;
      for (const sc of topCopy) {
        if (sc.last_ts >= now - 3600000) last1hCost += sc.cost;
        if (sc.date === todayStr) todayCost += sc.cost;
      }
      return {
        totalCost: state.totalCost,
        totalTokens: state.totalTokens,
        totalInputTokens: state.totalInputTokens,
        totalOutputTokens: state.totalOutputTokens,
        totalCacheReadTokens: state.totalCacheReadTokens,
        totalCacheCreateTokens: state.totalCacheCreateTokens,
        avgContextPct: state.globalContextTurnCount > 0 ? Math.round(state.globalContextPctSum / state.globalContextTurnCount) : 0,
        dailyRate: state.totalCost / days,
        firstDate: state.firstDate,
        lastDate: state.lastDate,
        days,
        totalSessions: state.sessionsWithData,
        byDay: state.byDay,
        byWeek: state.byWeek,
        byProject: state.byProject,
        topSessions: topCopy.slice(0, 10),
        byAgent: state.byAgent,
        agentNoCostData: state.agentNoCostData,
        last1hCost,
        todayCost,
        hoursElapsedToday: Math.max(1, hoursElapsedToday),
        processedCount: state.processedCount,
      };
    },
  };
}

// Compute per-session cost respecting special per-tool paths used by
// getCostAnalytics (opencode batch, cursor vscdb tokens, ...).
function computeSessionCostForAnalytics(session, opencodeCostCache) {
  if (session.tool === 'opencode' && opencodeCostCache && opencodeCostCache[session.id]) {
    return opencodeCostCache[session.id];
  }
  if (session.tool === 'cursor') {
    const inp = session._cursor_input_tokens || 0;
    const out = session._cursor_output_tokens || 0;
    if (inp > 0 || out > 0) {
      const model = session._cursor_model || '';
      const pricing = getModelPricing(model);
      return { cost: inp * pricing.input + out * pricing.output, inputTokens: inp, outputTokens: out, cacheReadTokens: 0, cacheCreateTokens: 0, contextPctSum: 0, contextTurnCount: 0, model: model };
    }
    if (session.user_messages > 0 || session.messages > 0) {
      const userMsgs = session.user_messages || Math.ceil((session.messages || 0) * 0.07);
      const model = session._cursor_model || 'claude-sonnet';
      const pricing = getModelPricing(model);
      const estInput = userMsgs * 2000;
      const estOutput = userMsgs * 1000;
      return { cost: estInput * pricing.input + estOutput * pricing.output, inputTokens: estInput, outputTokens: estOutput, cacheReadTokens: 0, cacheCreateTokens: 0, contextPctSum: 0, contextTurnCount: 0, model: model + '-estimated' };
    }
    return EMPTY_COST;
  }
  return computeSessionCost(session.id, session.project);
}

// Pre-compute OpenCode costs in one batch SQL — used by the streaming path
function buildOpencodeCostCache(sessions) {
  const cache = {};
  const opencodeSessions = sessions.filter(s => s.tool === 'opencode');
  if (opencodeSessions.length === 0 || !fs.existsSync(OPENCODE_DB)) return cache;
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
          if (!cache[sessId]) cache[sessId] = { cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, contextPctSum: 0, contextTurnCount: 0, model: '' };
          const c = cache[sessId];
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
  return cache;
}

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
    let costData;
    if (s.tool === 'opencode' && opencodeCostCache[s.id]) {
      costData = opencodeCostCache[s.id];
    } else if (s.tool === 'cursor') {
      // Use real token data from Cursor vscdb if available
      const inp = s._cursor_input_tokens || 0;
      const out = s._cursor_output_tokens || 0;
      if (inp > 0 || out > 0) {
        const model = s._cursor_model || '';
        const pricing = getModelPricing(model);
        costData = { cost: inp * pricing.input + out * pricing.output, inputTokens: inp, outputTokens: out, cacheReadTokens: 0, cacheCreateTokens: 0, contextPctSum: 0, contextTurnCount: 0, model: model };
      } else if (s.user_messages > 0 || s.messages > 0) {
        // Fallback: estimate from user prompt count
        const userMsgs = s.user_messages || Math.ceil((s.messages || 0) * 0.07);
        const model = s._cursor_model || 'claude-sonnet';
        const pricing = getModelPricing(model);
        const estInput = userMsgs * 2000;
        const estOutput = userMsgs * 1000;
        costData = { cost: estInput * pricing.input + estOutput * pricing.output, inputTokens: estInput, outputTokens: estOutput, cacheReadTokens: 0, cacheCreateTokens: 0, contextPctSum: 0, contextTurnCount: 0, model: model + '-estimated' };
      } else {
        costData = EMPTY_COST;
      }
    } else {
      costData = computeSessionCost(s.id, s.project);
    }
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
    if (agent === 'cursor' && costData.model && costData.model.includes('-estimated')) byAgent[agent].estimated = true;
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

    sessionCosts.push({ id: s.id, cost, project: proj, date: s.date, last_ts: s.last_ts || 0 });
  }

  // Sort top sessions by cost
  sessionCosts.sort((a, b) => b.cost - a.cost);

  const days = firstDate && lastDate
    ? Math.max(1, Math.round((new Date(lastDate) - new Date(firstDate)) / 86400000) + 1)
    : 1;

  // Burn rate: derived from already-computed sessionCosts — no extra IO
  const now = Date.now();
  const todayStr = new Date().toISOString().slice(0, 10);
  const hoursElapsedToday = (now - new Date(todayStr).getTime()) / 3600000;
  let last1hCost = 0;
  let todayCost = 0;
  for (const sc of sessionCosts) {
    if (sc.last_ts >= now - 3600000) last1hCost += sc.cost;
    if (sc.date === todayStr) todayCost += sc.cost;
  }

  _saveCostDiskCache(true);
  _saveParsedDiskCache(true);

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
    last1hCost,
    todayCost,
    hoursElapsedToday: Math.max(1, hoursElapsedToday),
  };
}

// ── Active sessions detection ─────────────────────────────

// ── Active sessions (cached, non-blocking) ──────────────────
// getActiveSessions() is called from /api/active which the browser polls on
// a timer. The previous version shelled out to `ps` + `lsof` synchronously
// once per matching process, doing an O(N) sync scan that blocked the event
// loop for tens of seconds when many processes had "codex"/"claude" in their
// cmdline (e.g. codex-up-exec wrapper spawned by Claude Code tooling).
//
// New design:
//   1. Cached result served for up to 3 seconds.
//   2. Tighter cmd matching — must be a real agent CLI, not a substring hit.
//   3. pid→cwd is remembered across calls (pids are stable for the process
//      lifetime). We only look up cwd for pids we've never seen.
//   4. lsof is run ONCE as a single batch call for all unknown pids, with
//      a hard 2-second total timeout.
//   5. No inner loadSessions() calls; session matching uses the in-memory
//      sessions cache if it already exists, otherwise cwd-match is skipped
//      and a background refresh fires.
let _activeCache = null;
let _activeCacheTs = 0;
const ACTIVE_CACHE_TTL = 3000; // 3 seconds
const _pidCwdCache = new Map(); // pid → cwd (stable for process lifetime)

// Real agent CLI invocations — tighter than a substring match.
// Matches the binary name at the START of cmd (or after a /path/).
// Includes codex-up variants (user wrapper that spawns codex exec).
const AGENT_CLI_MATCHERS = [
  { tool: 'claude',  re: /(^|\/)claude(\s|$)/ },
  { tool: 'codex',   re: /(^|\/)codex(-up(-exec)?)?(\s|$)/ },
  { tool: 'opencode',re: /(^|\/)opencode(\s|$)/ },
  { tool: 'kiro',    re: /(^|\/)kiro-cli(\s|$)/ },
  { tool: 'cursor',  re: /(^|\/)cursor-agent(\s|$)/ },
];

function _matchAgentCli(cmd) {
  for (const m of AGENT_CLI_MATCHERS) {
    if (m.re.test(cmd)) return m.tool;
  }
  return '';
}

function getActiveSessions() {
  const now = Date.now();
  if (_activeCache && (now - _activeCacheTs) < ACTIVE_CACHE_TTL) {
    return _activeCache;
  }
  const active = [];

  // Skip on Windows
  if (process.platform === 'win32') {
    _activeCache = active;
    _activeCacheTs = now;
    return active;
  }

  // 1. Read Claude Code PID files (provides cwd + sessionId directly)
  const sessionsDir = path.join(CLAUDE_DIR, 'sessions');
  const claudePidMap = {};
  if (fs.existsSync(sessionsDir)) {
    for (const file of fs.readdirSync(sessionsDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
        if (data.pid) claudePidMap[data.pid] = data;
      } catch {}
    }
  }

  // 2. Single `ps` call
  let psOut = '';
  try {
    psOut = execSync(
      'ps -eo pid=,pcpu=,rss=,stat=,command= 2>/dev/null',
      { encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 }
    );
  } catch {
    _activeCache = active;
    _activeCacheTs = now;
    return active;
  }

  // 3. Parse + filter with strict agent CLI matching
  const matches = [];
  const livePids = new Set();
  for (const line of psOut.split('\n')) {
    if (!line) continue;
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = parseInt(m[1]);
    if (!pid) continue;
    livePids.add(pid);
    const cpu = parseFloat(m[2]) || 0;
    const rss = parseInt(m[3]) || 0;
    const stat = m[4] || '';
    const cmd = m[5] || '';

    // Skip wrappers
    if (cmd.includes('node bin/cli') || cmd.includes('/codedash') || cmd.includes('npm ')) continue;
    if (cmd.startsWith('grep ') || cmd.includes(' grep ')) continue;

    const tool = _matchAgentCli(cmd);
    if (!tool) continue;

    matches.push({ pid, cpu, rss, stat, cmd, tool });
  }

  // Drop stale pids from cwd cache
  for (const pid of Array.from(_pidCwdCache.keys())) {
    if (!livePids.has(pid)) _pidCwdCache.delete(pid);
  }

  // 4. Collect unknown pids (not in PID files, not in cache). Look up cwd
  //    via a SINGLE batch lsof call with a hard 1-second timeout.
  const unknownPids = [];
  for (const m of matches) {
    if (claudePidMap[m.pid] && claudePidMap[m.pid].cwd) continue;
    if (_pidCwdCache.has(m.pid)) continue;
    unknownPids.push(m.pid);
  }
  if (unknownPids.length > 0) {
    try {
      // -a ANDs the -d/-p conditions (without it, lsof ORs and returns cwd for
      // all processes, not just the requested pids).
      const out = execSync(
        `lsof -a -d cwd -Fpn -p ${unknownPids.join(',')} 2>/dev/null`,
        { encoding: 'utf8', timeout: 1500, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 * 1024 * 1024 }
      );
      // lsof -Fpn output: p<PID>\nn<CWD>\np<PID>\nn<CWD>...
      let curPid = 0;
      for (const line of out.split('\n')) {
        if (line.startsWith('p')) {
          curPid = parseInt(line.slice(1)) || 0;
        } else if (line.startsWith('n') && curPid) {
          _pidCwdCache.set(curPid, line.slice(1));
        }
      }
      // Mark pids we asked about but didn't get cwd for — empty string so we
      // don't keep asking on every poll.
      for (const pid of unknownPids) {
        if (!_pidCwdCache.has(pid)) _pidCwdCache.set(pid, '');
      }
    } catch {
      // Timeout / error: mark all as unknown so we don't retry each poll
      for (const pid of unknownPids) _pidCwdCache.set(pid, '');
    }
  }

  // 5. Assemble results using only already-loaded sessions cache for cwd-match.
  //    Never call loadSessions() here — it may invalidate and re-parse.
  const cachedSessions = _sessionsCache || [];

  for (const m of matches) {
    let sessionId = '';
    let cwd = '';
    let startedAt = 0;
    let sessionSource = '';

    if (claudePidMap[m.pid]) {
      sessionId = claudePidMap[m.pid].sessionId || '';
      cwd = claudePidMap[m.pid].cwd || '';
      startedAt = claudePidMap[m.pid].startedAt || 0;
      if (sessionId) sessionSource = 'pid-file';
    }
    if (!cwd) cwd = _pidCwdCache.get(m.pid) || '';

    if (!sessionId && cachedSessions.length > 0) {
      const match = cachedSessions.find(s => s.tool === m.tool && s.project === cwd);
      if (match) {
        sessionId = match.id;
        sessionSource = 'cwd-match';
      }
    }

    const status = m.cpu < 1 && (m.stat.includes('S') || m.stat.includes('T')) ? 'waiting' : 'active';

    active.push({
      pid: m.pid,
      sessionId,
      cwd,
      startedAt,
      kind: m.tool,
      entrypoint: m.tool,
      status,
      cpu: m.cpu,
      memoryMB: Math.round(m.rss / 1024),
      _sessionSource: sessionSource,
    });
  }

  _activeCache = active;
  _activeCacheTs = Date.now();
  return active;
}

// ── Leaderboard stats ─────────────────────────────────────

const ANON_NAMES_ADJ = ['brave','swift','calm','bold','keen','wise','cool','fast','wild','epic','rare','pure','warm','dark','deep','fair','free','glad','gold','iron'];
const ANON_NAMES_NOUN = ['fox','owl','cat','wolf','bear','hawk','lion','deer','hare','crow','lynx','moth','seal','wren','dove','frog','newt','crab','swan','kite'];

function getOrCreateAnonId() {
  const configDir = path.join(os.homedir(), '.codedash');
  const idFile = path.join(configDir, 'anon-id.json');
  try {
    const data = JSON.parse(fs.readFileSync(idFile, 'utf8'));
    if (data.id && data.name) return data;
  } catch {}
  // Generate new
  const id = require('crypto').randomUUID();
  const adj = ANON_NAMES_ADJ[Math.floor(Math.random() * ANON_NAMES_ADJ.length)];
  const noun = ANON_NAMES_NOUN[Math.floor(Math.random() * ANON_NAMES_NOUN.length)];
  const num = Math.floor(Math.random() * 100);
  const name = adj + '-' + noun + '-' + num;
  const data = { id, name, createdAt: new Date().toISOString() };
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(idFile, JSON.stringify(data, null, 2));
  return data;
}

const fmtLocalDay = (ts) => {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
};

// Disk cache for per-session daily message breakdown
const DAILY_STATS_CACHE_FILE = path.join(CODEDASH_CACHE_DIR, 'daily-stats-cache.json');
const LEGACY_DAILY_STATS_CACHE_FILE = path.join(os.tmpdir(), 'codedash-daily-stats-cache.json');
let _dailyStatsDiskCache = null;

function _loadDailyStatsDiskCache() {
  if (_dailyStatsDiskCache) return;
  try {
    if (fs.existsSync(DAILY_STATS_CACHE_FILE)) {
      _dailyStatsDiskCache = JSON.parse(fs.readFileSync(DAILY_STATS_CACHE_FILE, 'utf8'));
    } else if (fs.existsSync(LEGACY_DAILY_STATS_CACHE_FILE)) {
      _dailyStatsDiskCache = JSON.parse(fs.readFileSync(LEGACY_DAILY_STATS_CACHE_FILE, 'utf8'));
    }
  } catch {}
  if (!_dailyStatsDiskCache) _dailyStatsDiskCache = {};
}

function _saveDailyStatsDiskCache() {
  if (!_dailyStatsDiskCache) return;
  try {
    const tmp = DAILY_STATS_CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_dailyStatsDiskCache));
    fs.renameSync(tmp, DAILY_STATS_CACHE_FILE);
  } catch {}
}

function _computeSessionDailyBreakdown(s, found) {
  const msgsByDay = {};
  const tsByDay = {};
  try {
    const lines = readLines(found.file);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        let isUser = false;
        let hasText = false;
        let ts = 0;

        if (found.format === 'claude') {
          if (entry.type !== 'user') continue;
          isUser = true;
          if (entry.timestamp) ts = typeof entry.timestamp === 'number' ? entry.timestamp : new Date(entry.timestamp).getTime();
          const c = entry.message && entry.message.content;
          if (typeof c === 'string' && c.trim()) hasText = true;
          else if (Array.isArray(c)) { for (const p of c) { if (p.type === 'text' && p.text && p.text.trim()) { hasText = true; break; } } }
        } else if (found.format === 'cursor') {
          if (entry.role !== 'user') continue;
          isUser = true;
          ts = s.first_ts;
          const c = (entry.message || {}).content;
          if (Array.isArray(c)) { for (const p of c) { if (p.type === 'text' && p.text && p.text.replace(/<\/?user_query>/g,'').trim()) { hasText = true; break; } } }
          else if (typeof c === 'string' && c.trim()) hasText = true;
        } else if (found.format === 'codex') {
          if (entry.type === 'response_item' && entry.payload && entry.payload.role === 'user') {
            isUser = true;
            ts = s.first_ts;
            const c = entry.payload.content;
            if (Array.isArray(c)) { for (const p of c) { if ((p.text || '').trim()) { hasText = true; break; } } }
          } else continue;
        }

        if (!isUser || !hasText) continue;
        if (!ts || ts < 1000000000000) ts = s.first_ts;
        const day = (found.format === 'claude' && ts) ? fmtLocalDay(ts) : (s.date || fmtLocalDay(s.last_ts));
        msgsByDay[day] = (msgsByDay[day] || 0) + 1;
        if (!tsByDay[day]) tsByDay[day] = { first: ts, last: ts };
        if (ts < tsByDay[day].first) tsByDay[day].first = ts;
        if (ts > tsByDay[day].last) tsByDay[day].last = ts;
      } catch {}
    }
  } catch {}
  return { msgsByDay, tsByDay };
}

function getDailyStats(sessions) {
  const byDay = {};
  const ensureDay = (date) => {
    if (!byDay[date]) byDay[date] = { date, sessions: 0, messages: 0, hours: 0, cost: 0, agents: {} };
    return byDay[date];
  };

  _loadDailyStatsDiskCache();

  for (const s of sessions) {
    if (!s.first_ts || !s.last_ts) continue;
    const tool = s.tool || 'unknown';

    // Cost per session
    const costData = computeSessionCost(s.id, s.project);
    const sessionCost = (costData && costData.cost) || 0;

    // For sessions with detail files — read actual message timestamps
    const found = s.has_detail ? findSessionFile(s.id, s.project) : null;
    if (found && found.format !== 'opencode' && found.format !== 'kiro' && found.format !== 'cursor' && fs.existsSync(found.file)) {
      // Check disk cache for daily breakdown
      let breakdown;
      let dailyCacheKey = '';
      try {
        const stat = fs.statSync(found.file);
        dailyCacheKey = found.file + '|' + stat.mtimeMs + '|' + stat.size;
      } catch {}
      if (dailyCacheKey && _dailyStatsDiskCache[dailyCacheKey]) {
        breakdown = _dailyStatsDiskCache[dailyCacheKey];
      } else {
        breakdown = _computeSessionDailyBreakdown(s, found);
        if (dailyCacheKey) _dailyStatsDiskCache[dailyCacheKey] = breakdown;
      }
      const { msgsByDay, tsByDay } = breakdown;

      const dayKeys = Object.keys(msgsByDay);
      if (dayKeys.length > 0) {
        const totalMsgs = dayKeys.reduce((a, k) => a + msgsByDay[k], 0) || 1;
        for (const day of dayKeys) {
          const d = ensureDay(day);
          d.sessions++;
          d.messages += msgsByDay[day];
          const dayHours = tsByDay[day] ? Math.min((tsByDay[day].last - tsByDay[day].first) / 3600000, 16) : 0;
          d.hours += dayHours;
          d.cost += sessionCost * (msgsByDay[day] / totalMsgs); // cost proportional to messages
          d.agents[tool] = (d.agents[tool] || 0) + 1;
        }
        continue; // done with this session
      }
    }

    // Fallback for non-Claude or sessions without detail: single-day attribution
    const day = s.date || fmtLocalDay(s.last_ts);
    const d = ensureDay(day);
    d.sessions++;
    // Only count EXACT user_messages. The 0.5 estimate was wildly wrong
    // because Claude type=user entries include tool_results (up to 28x inflation).
    if (s.user_messages > 0) {
      d.messages += s.user_messages;
    }
    d.hours += Math.min((s.last_ts - s.first_ts) / 3600000, 16);
    d.cost += sessionCost;
    d.agents[tool] = (d.agents[tool] || 0) + 1;
  }

  // Round
  for (const d of Object.values(byDay)) {
    d.hours = Math.round(d.hours * 10) / 10;
    d.cost = Math.round(d.cost * 100) / 100;
  }
  _saveDailyStatsDiskCache();
  _saveCostDiskCache(true);
  _saveParsedDiskCache(true);
  return Object.values(byDay).sort((a, b) => b.date.localeCompare(a.date));
}

let _lbCache = null;
let _lbCacheTs = 0;
const LB_CACHE_TTL = 60000; // 60 seconds

function getLeaderboardStats() {
  const now = Date.now();
  if (_lbCache && (now - _lbCacheTs) < LB_CACHE_TTL) return _lbCache;

  const sessions = loadSessions();
  const anon = getOrCreateAnonId();
  const daily = getDailyStats(sessions);

  // Totals
  let totalMessages = 0, totalHours = 0, totalCost = 0, totalSessions = sessions.length;
  const agentTotals = {};
  for (const d of daily) {
    totalMessages += d.messages;
    totalHours += d.hours;
    totalCost += d.cost;
    for (const [agent, count] of Object.entries(d.agents)) {
      agentTotals[agent] = (agentTotals[agent] || 0) + count;
    }
  }

  // Today
  const today = new Date().toISOString().slice(0, 10);
  const todayStats = daily.find(d => d.date === today) || { sessions: 0, messages: 0, hours: 0, cost: 0, agents: {} };

  // Streak (consecutive days with sessions)
  let streak = 0;
  const dt = new Date();
  for (let i = 0; i < 365; i++) {
    const day = dt.toISOString().slice(0, 10);
    if (daily.find(d => d.date === day)) {
      streak++;
      dt.setDate(dt.getDate() - 1);
    } else {
      break;
    }
  }

  const result = {
    anon,
    today: todayStats,
    totals: { sessions: totalSessions, messages: totalMessages, hours: Math.round(totalHours * 10) / 10, cost: Math.round(totalCost * 100) / 100 },
    agents: agentTotals,
    streak,
    daily: daily.slice(0, 30), // last 30 days
    activeDays: daily.length,
  };
  _lbCache = result;
  _lbCacheTs = Date.now();
  return result;
}

module.exports = {
  loadSessions,
  loadSessionsAsync,
  getWarmingStatus,
  getSqliteBackfillStatus,
  createCostAggregator,
  computeSessionCostForAnalytics,
  buildOpencodeCostCache,
  loadSessionDetail,
  getProjectGitInfo,
  getLeaderboardStats,
  getOrCreateAnonId,
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
