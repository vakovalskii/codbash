const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ── Constants ──────────────────────────────────────────────

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CODEX_DIR = path.join(os.homedir(), '.codex');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// ── Helpers ────────────────────────────────────────────────

function scanCodexSessions() {
  const sessions = [];
  const codexHistory = path.join(CODEX_DIR, 'history.jsonl');
  if (fs.existsSync(codexHistory)) {
    const lines = fs.readFileSync(codexHistory, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        const sid = d.sessionId || d.id;
        if (!sid) continue;
        if (!sessions.find(s => s.id === sid)) {
          sessions.push({
            id: sid,
            tool: 'codex',
            project: d.project || d.cwd || '',
            project_short: (d.project || d.cwd || '').replace(os.homedir(), '~'),
            first_ts: d.timestamp || Date.now(),
            last_ts: d.timestamp || Date.now(),
            messages: 1,
            first_message: d.display || d.prompt || '',
            has_detail: false,
            file_size: 0,
            detail_messages: 0,
          });
        }
      } catch {}
    }
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

  // Enrich Claude sessions with detail file info
  for (const [sid, s] of Object.entries(sessions)) {
    if (s.tool !== 'claude') continue;
    const projectKey = s.project.replace(/\//g, '-').replace(/^-/, '');
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
  }

  const result = Object.values(sessions).sort((a, b) => b.last_ts - a.last_ts);

  for (const s of result) {
    s.first_time = new Date(s.first_ts).toLocaleString('sv-SE').slice(0, 16);
    s.last_time = new Date(s.last_ts).toLocaleString('sv-SE').slice(0, 16);
    s.date = new Date(s.last_ts).toISOString().slice(0, 10);
  }

  return result;
}

function loadSessionDetail(sessionId, project) {
  const projectKey = project.replace(/\//g, '-').replace(/^-/, '');
  const sessionFile = path.join(PROJECTS_DIR, projectKey, `${sessionId}.jsonl`);

  if (!fs.existsSync(sessionFile)) {
    return { error: 'Session file not found', messages: [] };
  }

  const messages = [];
  const lines = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);

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
        messages.push({
          role: entry.type,
          content: content.slice(0, 2000),
          uuid: entry.uuid || '',
        });
      }
    } catch {}
  }

  return { messages: messages.slice(0, 200) };
}

function deleteSession(sessionId, project) {
  const deleted = [];

  // 1. Remove session JSONL file from project dir
  const projectKey = project.replace(/\//g, '-').replace(/^-/, '');
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

function exportSessionMarkdown(sessionId, project) {
  const projectKey = project.replace(/\//g, '-').replace(/^-/, '');
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

// ── Exports ────────────────────────────────────────────────

module.exports = {
  loadSessions,
  loadSessionDetail,
  deleteSession,
  getGitCommits,
  exportSessionMarkdown,
  // Expose constants for consumers that need them
  CLAUDE_DIR,
  CODEX_DIR,
  HISTORY_FILE,
  PROJECTS_DIR,
};
