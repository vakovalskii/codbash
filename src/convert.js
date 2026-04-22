'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { findSessionFile, extractContent, isSystemMessage } = require('./data');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CODEX_DIR = path.join(os.homedir(), '.codex');
const QWEN_DIR = path.join(os.homedir(), '.qwen');

function extractQwenText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .map(part => {
      if (!part || typeof part !== 'object' || part.thought) return '';
      return typeof part.text === 'string' ? part.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

// ── Read session into canonical format ────────────────────

function readSession(sessionId, project) {
  const found = findSessionFile(sessionId, project);
  if (!found) return null;

  const messages = [];
  const lines = fs.readFileSync(found.file, 'utf8').split('\n').filter(Boolean);
  let sessionMeta = {};

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      if (found.format === 'claude') {
        if (entry.type === 'permission-mode') {
          sessionMeta.permissionMode = entry.permissionMode;
          sessionMeta.originalSessionId = entry.sessionId;
        }
        if (entry.type === 'user' || entry.type === 'assistant') {
          const msg = entry.message || {};
          let content = '';
          if (typeof msg.content === 'string') {
            content = msg.content;
          } else if (Array.isArray(msg.content)) {
            content = msg.content
              .filter(b => b.type === 'text')
              .map(b => b.text)
              .join('\n');
          }
          if (!content || isSystemMessage(content)) continue;

          messages.push({
            role: entry.type === 'user' ? 'user' : 'assistant',
            content: content,
            timestamp: entry.timestamp || '',
            model: msg.model || '',
          });
        }
      } else if (found.format === 'qwen') {
        if (!sessionMeta.cwd && entry.cwd) sessionMeta.cwd = entry.cwd;
        if (!sessionMeta.version && entry.version) sessionMeta.version = entry.version;
        if (!sessionMeta.gitBranch && entry.gitBranch) sessionMeta.gitBranch = entry.gitBranch;
        if (!sessionMeta.originalSessionId && entry.sessionId) sessionMeta.originalSessionId = entry.sessionId;

        if (entry.type !== 'user' && entry.type !== 'assistant') continue;
        const content = extractQwenText(((entry.message || {}).parts));
        if (!content || isSystemMessage(content)) continue;

        messages.push({
          role: entry.type === 'assistant' ? 'assistant' : 'user',
          content: content,
          timestamp: entry.timestamp || '',
          model: entry.type === 'assistant' ? (entry.model || '') : '',
        });
      } else {
        // Codex
        if (entry.type === 'session_meta' && entry.payload) {
          sessionMeta.cwd = entry.payload.cwd;
          sessionMeta.originalSessionId = entry.payload.id;
        }
        if (entry.type === 'response_item' && entry.payload) {
          const role = entry.payload.role;
          if (role !== 'user' && role !== 'assistant') continue;
          const content = extractContent(entry.payload.content);
          if (!content || isSystemMessage(content)) continue;

          messages.push({
            role: role,
            content: content,
            timestamp: entry.timestamp || '',
            model: '',
          });
        }
      }
    } catch {}
  }

  return {
    sourceFormat: found.format,
    sourceFile: found.file,
    sessionId: sessionId,
    meta: sessionMeta,
    messages: messages,
  };
}

// ── Write as Claude Code session ──────────────────────────

function writeClaude(canonical, targetProject) {
  const newSessionId = crypto.randomUUID();
  const projectKey = (targetProject || os.homedir()).replace(/[\/\.]/g, '-');
  const projectDir = path.join(CLAUDE_DIR, 'projects', projectKey);

  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }

  const outFile = path.join(projectDir, `${newSessionId}.jsonl`);
  const cwd = targetProject || canonical.meta.cwd || os.homedir();
  const lines = [];

  // Permission mode entry
  lines.push(JSON.stringify({
    type: 'permission-mode',
    permissionMode: 'default',
    sessionId: newSessionId,
  }));

  let prevUuid = null;

  for (const msg of canonical.messages) {
    const uuid = crypto.randomUUID();
    const entry = {
      parentUuid: prevUuid,
      isSidechain: false,
      type: msg.role === 'user' ? 'user' : 'assistant',
      uuid: uuid,
      timestamp: msg.timestamp || new Date().toISOString(),
      userType: 'external',
      entrypoint: 'cli',
      cwd: cwd,
      sessionId: newSessionId,
      version: '2.1.91',
      gitBranch: 'main',
    };

    if (msg.role === 'user') {
      entry.message = { role: 'user', content: msg.content };
      entry.promptId = crypto.randomUUID();
    } else {
      entry.message = {
        model: msg.model || 'claude-sonnet-4-6',
        id: 'msg_converted_' + uuid.slice(0, 8),
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: msg.content }],
        stop_reason: 'end_turn',
      };
    }

    lines.push(JSON.stringify(entry));
    prevUuid = uuid;
  }

  // Write atomically
  const tmpFile = outFile + '.tmp';
  fs.writeFileSync(tmpFile, lines.join('\n') + '\n');
  fs.renameSync(tmpFile, outFile);

  // Add to history.jsonl
  const historyFile = path.join(CLAUDE_DIR, 'history.jsonl');
  const historyEntry = JSON.stringify({
    sessionId: newSessionId,
    project: cwd,
    timestamp: Date.now(),
    display: `[Converted from ${canonical.sourceFormat}] ${canonical.messages[0]?.content?.slice(0, 100) || ''}`,
    pastedContents: {},
  });
  fs.appendFileSync(historyFile, historyEntry + '\n');

  return {
    sessionId: newSessionId,
    file: outFile,
    format: 'claude',
    messages: canonical.messages.length,
    resumeCmd: `claude --resume ${newSessionId}`,
  };
}

// ── Write as Codex session ────────────────────────────────

function writeCodex(canonical, targetProject) {
  const newSessionId = crypto.randomUUID();
  const now = new Date();
  const dateDir = path.join(
    CODEX_DIR, 'sessions',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  );

  if (!fs.existsSync(dateDir)) {
    fs.mkdirSync(dateDir, { recursive: true });
  }

  const fileName = `rollout-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${newSessionId}.jsonl`;
  const outFile = path.join(dateDir, fileName);
  const cwd = targetProject || canonical.meta.cwd || os.homedir();
  const lines = [];

  // Session meta
  lines.push(JSON.stringify({
    timestamp: now.toISOString(),
    type: 'session_meta',
    payload: {
      id: newSessionId,
      timestamp: now.toISOString(),
      cwd: cwd,
      originator: 'codex_cli_rs',
      cli_version: '0.101.0',
      source: 'cli',
      model_provider: 'openai',
    },
  }));

  // Messages
  for (const msg of canonical.messages) {
    lines.push(JSON.stringify({
      timestamp: msg.timestamp || now.toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: msg.role,
        content: [{ type: 'input_text', text: msg.content }],
      },
    }));
  }

  // Write atomically
  const tmpFile = outFile + '.tmp';
  fs.writeFileSync(tmpFile, lines.join('\n') + '\n');
  fs.renameSync(tmpFile, outFile);

  // Add to codex history
  const historyFile = path.join(CODEX_DIR, 'history.jsonl');
  if (!fs.existsSync(path.dirname(historyFile))) {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
  }
  const historyEntry = JSON.stringify({
    session_id: newSessionId,
    ts: Math.floor(Date.now() / 1000),
    text: `[Converted from ${canonical.sourceFormat}] ${canonical.messages[0]?.content?.slice(0, 100) || ''}`,
  });
  fs.appendFileSync(historyFile, historyEntry + '\n');

  return {
    sessionId: newSessionId,
    file: outFile,
    format: 'codex',
    messages: canonical.messages.length,
    resumeCmd: `codex resume ${newSessionId}`,
  };
}

function writeQwen(canonical, targetProject) {
  const newSessionId = crypto.randomUUID();
  const cwd = targetProject || canonical.meta.cwd || os.homedir();
  const projectKey = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
  const chatsDir = path.join(QWEN_DIR, 'projects', projectKey, 'chats');

  if (!fs.existsSync(chatsDir)) {
    fs.mkdirSync(chatsDir, { recursive: true });
  }

  const outFile = path.join(chatsDir, `${newSessionId}.jsonl`);
  const nowIso = new Date().toISOString();
  const version = canonical.meta.version || '0.14.0';
  const gitBranch = canonical.meta.gitBranch || 'main';
  const lines = [];
  let prevUuid = null;

  for (const msg of canonical.messages) {
    const uuid = crypto.randomUUID();
    const entry = {
      uuid,
      parentUuid: prevUuid,
      sessionId: newSessionId,
      timestamp: msg.timestamp || nowIso,
      type: msg.role === 'assistant' ? 'assistant' : 'user',
      cwd,
      version,
      gitBranch,
      message: {
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      },
    };

    if (msg.role === 'assistant') {
      entry.model = msg.model || canonical.meta.model || 'converted-session';
    }

    lines.push(JSON.stringify(entry));
    prevUuid = uuid;
  }

  const tmpFile = outFile + '.tmp';
  fs.writeFileSync(tmpFile, lines.join('\n') + '\n');
  fs.renameSync(tmpFile, outFile);

  return {
    sessionId: newSessionId,
    file: outFile,
    format: 'qwen',
    messages: canonical.messages.length,
    resumeCmd: `qwen -r ${newSessionId}`,
  };
}

// ── Main convert function ─────────────────────────────────

function convertSession(sessionId, project, targetFormat) {
  const canonical = readSession(sessionId, project);
  if (!canonical) {
    return { ok: false, error: 'Session not found' };
  }

  if (canonical.sourceFormat === targetFormat) {
    return { ok: false, error: `Session is already in ${targetFormat} format` };
  }

  if (canonical.messages.length === 0) {
    return { ok: false, error: 'Session has no messages to convert' };
  }

  let result;
  if (targetFormat === 'claude') {
    result = writeClaude(canonical, project);
  } else if (targetFormat === 'codex') {
    result = writeCodex(canonical, project);
  } else if (targetFormat === 'qwen') {
    result = writeQwen(canonical, project);
  } else {
    return { ok: false, error: `Unknown target format: ${targetFormat}` };
  }

  return {
    ok: true,
    source: { format: canonical.sourceFormat, sessionId: sessionId, messages: canonical.messages.length },
    target: result,
  };
}

module.exports = { convertSession, readSession };
