const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

// ── Constants ──────────────────────────────────────────────

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CODEX_DIR = path.join(os.homedir(), '.codex');
const OPENCODE_DB = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
const KILO_DIR = path.join(os.homedir(), '.local', 'share', 'kilo');
const KILO_STORAGE_DIR = path.join(KILO_DIR, 'storage');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

let searchIndex = null;
let searchIndexBuiltAt = 0;
let searchIndexSignature = '';
const INDEX_TTL = 60000;

// ── Helpers ────────────────────────────────────────────────

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function getProjectKey(project) {
  return (project || '').replace(/[\/\.]/g, '-');
}

function collectJsonFiles(dir) {
  const files = [];
  if (!dir || !fs.existsSync(dir)) return files;

  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push(full);
      }
    }
  };

  walk(dir);
  return files;
}

function runSqliteJson(dbPath, sql, params = []) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare(sql).all(...params);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function inferOpenCodeTool(version, sourceHint) {
  if (sourceHint === 'kilo') return 'kilo';
  if (typeof version === 'string' && version.toLowerCase().includes('kilo')) return 'kilo';
  return 'opencode';
}

function loadOpenCodeSessionsFromDb(dbPath, sourceHint) {
  const rows = runSqliteJson(dbPath, `
    select
      s.id as id,
      s.title as title,
      s.directory as directory,
      s.version as version,
      s.time_created as first_ts,
      s.time_updated as last_ts,
      coalesce(p.worktree, s.directory) as project,
      coalesce(p.name, '') as project_name,
      (
        select coalesce(group_concat(text, char(10)), '')
        from (
          select coalesce(json_extract(p2.data, '$.text'), '') as text
          from message m2
          join part p2 on p2.message_id = m2.id
          where m2.session_id = s.id
            and json_extract(m2.data, '$.role') = 'user'
            and m2.id = (
              select id
              from message
              where session_id = s.id and json_extract(data, '$.role') = 'user'
              order by time_created asc
              limit 1
            )
            and json_extract(p2.data, '$.type') = 'text'
          order by p2.time_created asc, p2.id asc
        )
      ) as first_message,
      (
        select count(*)
        from message m
        where m.session_id = s.id and json_extract(m.data, '$.role') in ('user', 'assistant')
      ) as messages,
      (
        (select coalesce(sum(length(m.data)), 0) from message m where m.session_id = s.id)
        +
        (select coalesce(sum(length(pt.data)), 0) from message m join part pt on pt.message_id = m.id where m.session_id = s.id)
      ) as file_size
    from session s
    left join project p on p.id = s.project_id
    order by s.time_updated desc;
  `);

  return rows.map(row => ({
    id: row.id,
    tool: inferOpenCodeTool(row.version, sourceHint),
    project: row.project || row.directory || '',
    project_short: (row.project || row.directory || '').replace(os.homedir(), '~'),
    first_ts: row.first_ts || 0,
    last_ts: row.last_ts || row.first_ts || 0,
    messages: row.messages || 0,
    first_message: (row.first_message || row.title || '').slice(0, 200),
    has_detail: true,
    file_size: row.file_size || 0,
    detail_messages: row.messages || 0,
    title: row.title || '',
    app_version: row.version || '',
    source: sourceHint,
  }));
}

function loadOpenCodeDetailFromDb(dbPath, sessionId) {
  const rows = runSqliteJson(dbPath, `
    select
      m.id as id,
      m.time_created as time_created,
      json_extract(m.data, '$.role') as role,
      coalesce((
        select group_concat(text, char(10))
        from (
          select coalesce(json_extract(p.data, '$.text'), '') as text
          from part p
          where p.message_id = m.id and json_extract(p.data, '$.type') in ('text', 'reasoning')
          order by p.time_created asc, p.id asc
        )
      ), '') as content
    from message m
    where m.session_id = ?
    order by m.time_created asc;
  `, [sessionId]);

  const messages = [];
  for (const row of rows) {
    if (row.role === 'user' || row.role === 'assistant') {
      messages.push({
        role: row.role,
        content: (row.content || '').slice(0, 2000),
        uuid: row.id || '',
        timestamp: row.time_created || '',
      });
    }
  }
  return messages;
}

function deleteOpenCodeSessionFromDb(dbPath, sessionId) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: false });
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const result = db.prepare('DELETE FROM session WHERE id = ?').run(sessionId);
    if (result.changes > 0) return ['session record'];
  } finally {
    db.close();
  }
  return [];
}

function loadKiloSessionMessages(sessionId) {
  const messageDir = path.join(KILO_STORAGE_DIR, 'message', sessionId);
  if (!fs.existsSync(messageDir)) {
    return { messages: [], fileSize: 0 };
  }

  const entries = [];
  let fileSize = 0;

  for (const entry of fs.readdirSync(messageDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(messageDir, entry.name);
    const meta = readJsonFile(filePath);
    if (!meta) continue;
    const stat = fs.statSync(filePath);
    fileSize += stat.size;
    entries.push({ filePath, meta, created: meta.time?.created || stat.mtimeMs });
  }

  entries.sort((a, b) => a.created - b.created);

  const messages = [];
  for (const entry of entries) {
    if (entry.meta.role !== 'user' && entry.meta.role !== 'assistant') continue;

    let content = '';
    const partDir = path.join(KILO_STORAGE_DIR, 'part', entry.meta.id);
    if (fs.existsSync(partDir)) {
      const partEntries = [];
      for (const partEntry of fs.readdirSync(partDir, { withFileTypes: true })) {
        if (!partEntry.isFile() || !partEntry.name.endsWith('.json')) continue;
        const partPath = path.join(partDir, partEntry.name);
        const part = readJsonFile(partPath);
        if (!part) continue;
        const stat = fs.statSync(partPath);
        fileSize += stat.size;
        partEntries.push({ partPath, part });
      }

      partEntries.sort((a, b) => a.partPath.localeCompare(b.partPath));
      for (const { part } of partEntries) {
        if (part.type !== 'text' && part.type !== 'reasoning') continue;
        const text = typeof part.text === 'string' ? part.text : '';
        if (text) {
          content += (content ? '\n' : '') + text;
        }
      }
    }

    messages.push({
      role: entry.meta.role,
      content: content.slice(0, 2000),
      uuid: entry.meta.id || '',
      timestamp: entry.meta.time?.created || '',
    });
  }

  return { messages, fileSize };
}

function loadKiloProjectMap() {
  const projects = new Map();
  const projectDir = path.join(KILO_STORAGE_DIR, 'project');
  for (const filePath of collectJsonFiles(projectDir)) {
    const project = readJsonFile(filePath);
    if (project && project.id) {
      projects.set(project.id, project);
    }
  }
  return projects;
}

function loadKiloSessions() {
  const sessions = [];
  const sessionDir = path.join(KILO_STORAGE_DIR, 'session');
  if (!fs.existsSync(sessionDir)) return sessions;

  const projectMap = loadKiloProjectMap();

  for (const filePath of collectJsonFiles(sessionDir)) {
    const session = readJsonFile(filePath);
    if (!session || !session.id) continue;

    const stat = fs.statSync(filePath);
    const projectMeta = session.projectID ? projectMap.get(session.projectID) : null;
    const project = (projectMeta && projectMeta.worktree && projectMeta.worktree !== '/')
      ? projectMeta.worktree
      : (session.directory || projectMeta?.worktree || '');
    const { messages, fileSize } = loadKiloSessionMessages(session.id);
    const firstMessage = messages.find(m => m.role === 'user') || messages[0] || null;

    sessions.push({
      id: session.id,
      tool: 'kilo',
      project: project || '',
      project_short: (project || '').replace(os.homedir(), '~'),
      first_ts: session.time?.created || stat.mtimeMs,
      last_ts: session.time?.updated || session.time?.created || stat.mtimeMs,
      messages: messages.length,
      first_message: (firstMessage?.content || session.title || session.slug || '').slice(0, 200),
      has_detail: messages.length > 0,
      file_size: stat.size + fileSize,
      detail_messages: messages.length,
      title: session.title || '',
      app_version: session.version || '',
      source: 'kilo',
    });
  }

  return sessions;
}

function deleteKiloSessionFromStore(sessionId) {
  const deleted = [];
  const sessionDir = path.join(KILO_STORAGE_DIR, 'session');
  const messageDir = path.join(KILO_STORAGE_DIR, 'message', sessionId);
  const partDir = path.join(KILO_STORAGE_DIR, 'part');
  const diffDir = path.join(KILO_STORAGE_DIR, 'session_diff');

  for (const filePath of collectJsonFiles(sessionDir)) {
    const session = readJsonFile(filePath);
    if (session && session.id === sessionId) {
      fs.unlinkSync(filePath);
      deleted.push('session file');
      break;
    }
  }

  if (fs.existsSync(messageDir)) {
    for (const entry of fs.readdirSync(messageDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const message = readJsonFile(path.join(messageDir, entry.name));
      if (!message) continue;
      const messagePartDir = path.join(partDir, message.id || '');
      if (fs.existsSync(messagePartDir)) {
        fs.rmSync(messagePartDir, { recursive: true, force: true });
        deleted.push('message parts');
      }
    }
    fs.rmSync(messageDir, { recursive: true, force: true });
    deleted.push('message files');
  }

  const diffFile = path.join(diffDir, `${sessionId}.json`);
  if (fs.existsSync(diffFile)) {
    fs.unlinkSync(diffFile);
    deleted.push('session diff');
  }

  return deleted;
}

function scanCodexSessions() {
  const sessions = [];
  const codexHistory = path.join(CODEX_DIR, 'history.jsonl');
  if (fs.existsSync(codexHistory)) {
    const lines = fs.readFileSync(codexHistory, 'utf8').split('\n').filter(Boolean);
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
            first_message: d.text || d.display || d.prompt || '',
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
        const stat = fs.statSync(f);
        // Extract session ID from filename (rollout-DATE-UUID.jsonl)
        const basename = path.basename(f, '.jsonl');
        const uuidMatch = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
        if (!uuidMatch) continue;
        const sid = uuidMatch[1];
        // Try to extract cwd from session_meta
        let cwd = '';
        try {
          const firstLine = fs.readFileSync(f, 'utf8').split('\n')[0];
          const meta = JSON.parse(firstLine);
          if (meta.type === 'session_meta' && meta.payload && meta.payload.cwd) {
            cwd = meta.payload.cwd;
          }
        } catch {}

        const existing = sessions.find(s => s.id === sid);
        if (existing) {
          existing.has_detail = true;
          existing.file_size = stat.size;
          if (cwd && !existing.project) {
            existing.project = cwd;
            existing.project_short = cwd.replace(os.homedir(), '~');
          }
        } else {
          sessions.push({
            id: sid,
            tool: 'codex',
            project: cwd,
            project_short: cwd ? cwd.replace(os.homedir(), '~') : '',
            first_ts: stat.mtimeMs,
            last_ts: stat.mtimeMs,
            messages: 0,
            first_message: '',
            has_detail: true,
            file_size: stat.size,
            detail_messages: 0,
          });
        }
      }
    } catch {}
  }

  return sessions;
}

// ── Public API ─────────────────────────────────────────────

function loadSessions() {
  const sessions = {};

  // Load Claude Code sessions
  if (fs.existsSync(HISTORY_FILE)) {
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
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

  // Load OpenCode sessions from the shared SQLite store.
  if (fs.existsSync(OPENCODE_DB)) {
    try {
      const openCodeSessions = loadOpenCodeSessionsFromDb(OPENCODE_DB, 'opencode');
      for (const oc of openCodeSessions) {
        const existing = sessions[oc.id];
        if (!existing || (oc.last_ts || 0) > (existing.last_ts || 0)) {
          sessions[oc.id] = oc;
        }
      }
    } catch {}
  }

  // Load Kilo sessions from its file-based storage.
  try {
    const kiloSessions = loadKiloSessions();
    for (const ks of kiloSessions) {
      const existing = sessions[ks.id];
      if (!existing || (ks.last_ts || 0) > (existing.last_ts || 0)) {
        sessions[ks.id] = ks;
      }
    }
  } catch {}

  // Enrich sessions with detail file info for the relevant storage format.
  for (const [sid, s] of Object.entries(sessions)) {
    if (s.tool === 'claude') {
      const projectKey = getProjectKey(s.project);
      const sessionFile = path.join(PROJECTS_DIR, projectKey, `${sid}.jsonl`);
      if (fs.existsSync(sessionFile)) {
        s.has_detail = true;
        s.file_size = fs.statSync(sessionFile).size;
        try {
          let msgCount = 0;
          const sLines = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
          for (const sl of sLines) {
            try {
              const entry = JSON.parse(sl);
              if (entry.type === 'user' || entry.type === 'assistant') msgCount++;
            } catch {}
          }
          s.detail_messages = msgCount;
        } catch { s.detail_messages = 0; }
      } else {
        s.has_detail = false;
        s.file_size = 0;
        s.detail_messages = 0;
      }
      continue;
    }

    if (s.tool === 'opencode' || s.tool === 'kilo') {
      try {
        const messages = s.tool === 'kilo'
          ? (() => {
              const loaded = loadKiloSessionMessages(sid);
              if (loaded.messages.length > 0) return loaded.messages;
              if (fs.existsSync(OPENCODE_DB)) return loadOpenCodeDetailFromDb(OPENCODE_DB, sid);
              return [];
            })()
          : (fs.existsSync(OPENCODE_DB) ? loadOpenCodeDetailFromDb(OPENCODE_DB, sid) : []);
        s.has_detail = messages.length > 0;
        s.file_size = s.file_size || 0;
        s.detail_messages = messages.length;
      } catch {
        s.has_detail = false;
        s.file_size = 0;
        s.detail_messages = 0;
      }
    }
  }

  const result = Object.values(sessions).sort((a, b) => b.last_ts - a.last_ts);

  for (const s of result) {
    s.first_time = new Date(s.first_ts).toLocaleString('sv-SE').slice(0, 16);
    s.last_time = new Date(s.last_ts).toLocaleString('sv-SE').slice(0, 16);
    s.date = new Date(s.last_ts).toISOString().slice(0, 10);
  }

  return result;
}

function loadSessionDetail(sessionId, project, tool) {
  if (tool === 'opencode') {
    if (!fs.existsSync(OPENCODE_DB)) {
      return { error: 'Session store not found', messages: [] };
    }
    return { messages: loadOpenCodeDetailFromDb(OPENCODE_DB, sessionId).slice(0, 200) };
  }

  if (tool === 'kilo') {
    const { messages } = loadKiloSessionMessages(sessionId);
    if (messages.length > 0) {
      return { messages: messages.slice(0, 200) };
    }
    if (fs.existsSync(OPENCODE_DB)) {
      return { messages: loadOpenCodeDetailFromDb(OPENCODE_DB, sessionId).slice(0, 200) };
    }
    return { error: 'Session file not found', messages: [] };
  }

  const found = findSessionFile(sessionId, project);
  if (!found) return { error: 'Session file not found', messages: [] };

  const messages = [];
  const lines = fs.readFileSync(found.file, 'utf8').split('\n').filter(Boolean);

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

function deleteSession(sessionId, project, tool) {
  const deleted = [];

  if (tool === 'opencode') {
    if (fs.existsSync(OPENCODE_DB)) {
      try {
        deleted.push(...deleteOpenCodeSessionFromDb(OPENCODE_DB, sessionId));
      } catch {}
    }
    return deleted;
  }

  if (tool === 'kilo') {
    try {
      deleted.push(...deleteKiloSessionFromStore(sessionId));
      if (deleted.length === 0 && fs.existsSync(OPENCODE_DB)) {
        deleted.push(...deleteOpenCodeSessionFromDb(OPENCODE_DB, sessionId));
      }
    } catch {}
    return deleted;
  }

  // 1. Remove session JSONL file from project dir
  const projectKey = getProjectKey(project);
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
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
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

    const output = execSync(
      `git log --oneline --after="${afterDate}" --before="${beforeDate}"`,
      { cwd: projectDir, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

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

function exportSessionMarkdown(sessionId, project, tool) {
  if (tool === 'opencode') {
    if (!fs.existsSync(OPENCODE_DB)) {
      return `# Session ${sessionId}\n\nSession store not found.\n`;
    }

    const messages = loadOpenCodeDetailFromDb(OPENCODE_DB, sessionId);
    const currentSessions = loadSessions();
    const session = currentSessions.find(s => s.id === sessionId);
    const parts = [`# Session ${sessionId}\n\n**Project:** ${session?.project || project || ''}\n`];
    for (const msg of messages) {
      const header = msg.role === 'user' ? '## User' : '## Assistant';
      parts.push(`\n${header}\n\n${msg.content}\n`);
    }
    return parts.join('');
  }

  if (tool === 'kilo') {
    let { messages } = loadKiloSessionMessages(sessionId);
    if (messages.length === 0 && fs.existsSync(OPENCODE_DB)) {
      messages = loadOpenCodeDetailFromDb(OPENCODE_DB, sessionId);
    }
    const currentSessions = loadSessions();
    const session = currentSessions.find(s => s.id === sessionId);
    const parts = [`# Session ${sessionId}\n\n**Project:** ${session?.project || project || ''}\n`];
    for (const msg of messages) {
      const header = msg.role === 'user' ? '## User' : '## Assistant';
      parts.push(`\n${header}\n\n${msg.content}\n`);
    }
    return parts.join('');
  }

  const projectKey = getProjectKey(project);
  const sessionFile = path.join(PROJECTS_DIR, projectKey, `${sessionId}.jsonl`);

  if (!fs.existsSync(sessionFile)) {
    return `# Session ${sessionId}\n\nSession file not found.\n`;
  }

  const lines = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
  const parts = [`# Session ${sessionId}\n\n**Project:** ${project}\n`];

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
    const projectKey = getProjectKey(project);
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

function getSessionPreview(sessionId, project, limit, tool) {
  const data = loadSessionDetail(sessionId, project || '', tool || '');
  if (!data || !data.messages) return [];
  return data.messages.slice(0, limit || 10).map(m => ({
    role: m.role,
    content: (m.content || '').slice(0, 300),
  }));
}

function buildSearchIndex(sessions) {
  const startMs = Date.now();
  const index = [];

  for (const s of sessions || []) {
    if (!s || !s.id) continue;

    const detail = loadSessionDetail(s.id, s.project || '', s.tool || '');
    const messages = (detail && detail.messages && detail.messages.length > 0)
      ? detail.messages
      : [{ role: 'session', content: `${s.first_message || ''} ${s.project || ''} ${s.id || ''}`.trim() }];

    const texts = [];
    for (const message of messages) {
      const content = String(message.content || '').trim();
      if (!content) continue;
      texts.push({ role: message.role || 'session', content: content.slice(0, 500) });
    }

    if (texts.length > 0) {
      index.push({
        sessionId: s.id,
        texts,
        fullText: texts.map(t => t.content).join(' ').toLowerCase(),
      });
    }
  }

  const elapsed = Date.now() - startMs;
  console.log(`  \x1b[2mSearch index: ${index.length} sessions, ${elapsed}ms\x1b[0m`);
  return index;
}

function getSearchIndex(sessions) {
  const now = Date.now();
  const signature = (sessions || [])
    .map(s => `${s.id}:${s.last_ts || 0}:${s.tool || ''}:${s.project || ''}`)
    .join('|');

  if (!searchIndex || (now - searchIndexBuiltAt) > INDEX_TTL || signature !== searchIndexSignature) {
    searchIndex = buildSearchIndex(sessions);
    searchIndexBuiltAt = now;
    searchIndexSignature = signature;
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

function getSessionReplay(sessionId, project, tool) {
  let messages = [];

  if (tool === 'opencode') {
    messages = loadOpenCodeDetailFromDb(OPENCODE_DB, sessionId).map(m => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp || '',
      ms: m.timestamp ? new Date(m.timestamp).getTime() : 0,
    }));
  } else if (tool === 'kilo') {
    const loaded = loadKiloSessionMessages(sessionId);
    messages = loaded.messages.map(m => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp || '',
      ms: m.timestamp ? new Date(m.timestamp).getTime() : 0,
    }));
    if (messages.length === 0 && fs.existsSync(OPENCODE_DB)) {
      messages = loadOpenCodeDetailFromDb(OPENCODE_DB, sessionId).map(m => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp || '',
        ms: m.timestamp ? new Date(m.timestamp).getTime() : 0,
      }));
    }
  } else {
    const found = findSessionFile(sessionId, project);
    if (!found) return { messages: [], duration: 0 };

    const lines = fs.readFileSync(found.file, 'utf8').split('\n').filter(Boolean);
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
  }

  const startMs = messages.length > 0 ? messages[0].ms : 0;
  const endMs = messages.length > 0 ? messages[messages.length - 1].ms : 0;

  return {
    messages,
    startMs,
    endMs,
    duration: endMs - startMs,
  };
}

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
  if (!found) return { cost: 0, inputTokens: 0, outputTokens: 0, model: '' };

  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let model = '';

  try {
    const lines = fs.readFileSync(found.file, 'utf8').split('\n').filter(Boolean);
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

          totalInput += inp + cacheCreate + cacheRead;
          totalOutput += out;
          totalCost += inp * pricing.input
                     + cacheCreate * pricing.cache_create
                     + cacheRead * pricing.cache_read
                     + out * pricing.output;
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

  return { cost: totalCost, inputTokens: totalInput, outputTokens: totalOutput, model };
}

// ── Cost analytics ────────────────────────────────────────

function getCostAnalytics(sessions) {
  const byDay = {};
  const byProject = {};
  const byWeek = {};
  let totalCost = 0;
  let totalTokens = 0;
  const sessionCosts = [];

  for (const s of sessions) {
    const costData = computeSessionCost(s.id, s.project);
    const cost = costData.cost;
    const tokens = costData.inputTokens + costData.outputTokens;
    if (cost === 0 && tokens === 0) continue;
    totalCost += cost;
    totalTokens += tokens;

    // By day
    const day = s.date || 'unknown';
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

  return {
    totalCost,
    totalTokens,
    totalSessions: sessions.length,
    byDay,
    byWeek,
    byProject,
    topSessions: sessionCosts.slice(0, 10),
  };
}

// ── Active sessions detection ─────────────────────────────

function getActiveSessions() {
  const active = [];
  const sessionsDir = path.join(CLAUDE_DIR, 'sessions');

  // Read ~/.claude/sessions/<PID>.json files
  if (fs.existsSync(sessionsDir)) {
    for (const file of fs.readdirSync(sessionsDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
        const pid = data.pid;
        if (!pid) continue;

        // Check if process is alive + get CPU
        try {
          const psOut = execSync(`ps -p ${pid} -o pid=,%cpu=,rss=,stat= 2>/dev/null`, { encoding: 'utf8', timeout: 2000 }).trim();
          if (!psOut) continue;

          const parts = psOut.trim().split(/\s+/);
          const cpu = parseFloat(parts[1]) || 0;
          const rss = parseInt(parts[2]) || 0; // KB
          const stat = parts[3] || '';

          // Determine status
          let status = 'active';
          if (cpu < 1 && (stat.includes('S') || stat.includes('T'))) {
            status = 'waiting'; // idle/sleeping — likely waiting for user input
          }

          active.push({
            pid: pid,
            sessionId: data.sessionId,
            cwd: data.cwd || '',
            startedAt: data.startedAt || 0,
            kind: data.kind || 'interactive',
            entrypoint: data.entrypoint || '',
            status: status,
            cpu: cpu,
            memoryMB: Math.round(rss / 1024),
          });
        } catch {
          // Process not found — stale file, skip
        }
      } catch {}
    }
  }

  // Also check Codex processes
  try {
    const codexPs = execSync('ps aux 2>/dev/null | grep "[c]odex" || true', { encoding: 'utf8', timeout: 2000 });
    for (const line of codexPs.split('\n').filter(Boolean)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;
      const pid = parseInt(parts[1]);
      const cpu = parseFloat(parts[2]) || 0;
      const rss = parseInt(parts[5]) || 0;

      // Skip if already found via claude sessions
      if (active.find(a => a.pid === pid)) continue;

      // Try to get cwd
      let cwd = '';
      try {
        const lsofOut = execSync(`lsof -d cwd -p ${pid} -Fn 2>/dev/null`, { encoding: 'utf8', timeout: 2000 });
        const match = lsofOut.match(/\nn(\/[^\n]+)/);
        if (match) cwd = match[1];
      } catch {}

      active.push({
        pid: pid,
        sessionId: '',
        cwd: cwd,
        startedAt: 0,
        kind: 'codex',
        entrypoint: 'codex',
        status: cpu < 1 ? 'waiting' : 'active',
        cpu: cpu,
        memoryMB: Math.round(rss / 1024),
      });
    }
  } catch {}

  return active;
}

module.exports = {
  loadSessions,
  loadSessionDetail,
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
  CLAUDE_DIR,
  CODEX_DIR,
  OPENCODE_DB,
  KILO_DIR,
  KILO_STORAGE_DIR,
  HISTORY_FILE,
  PROJECTS_DIR,
};
