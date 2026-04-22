'use strict';

const { loadSessions, loadSessionDetail, getSessionPreview, findSessionFile, computeSessionCost } = require('./data');

// ── Handoff document generator ────────────────────────────

const VERBOSITY = {
  minimal: 3,
  standard: 10,
  verbose: 20,
  full: 50,
};

function generateHandoff(sessionId, project, options) {
  options = options || {};
  const verbosity = options.verbosity || 'standard';
  const target = options.target || 'any';
  const msgLimit = VERBOSITY[verbosity] || 10;

  // Find session
  const sessions = loadSessions();
  const session = sessions.find(s => s.id === sessionId || s.id.startsWith(sessionId));
  if (!session) return { ok: false, error: 'Session not found' };

  // Load messages
  const detail = loadSessionDetail(session.id, session.project || project);
  const messages = (detail.messages || []).slice(-msgLimit);
  const cost = computeSessionCost(session.id, session.project || project);
  const costLabel = cost.unavailable
    ? `unavailable (${cost.model || 'unknown model'})`
    : `$${cost.cost.toFixed(2)} (${cost.model || 'unknown'})`;

  // Build handoff document
  const lines = [];
  lines.push('# Session Handoff');
  lines.push('');
  lines.push(`> Transferred from **${session.tool}** session \`${session.id}\``);
  lines.push(`> Project: \`${session.project_short || session.project || 'unknown'}\``);
  lines.push(`> Started: ${session.first_time} | Last active: ${session.last_time}`);
  lines.push(`> Messages: ${session.detail_messages || session.messages} | Cost: ${costLabel}`);
  lines.push('');

  // Summary of what was being worked on
  if (messages.length > 0) {
    // First user message = original task
    const firstUser = messages.find(m => m.role === 'user');
    if (firstUser) {
      lines.push('## Original Task');
      lines.push('');
      lines.push(firstUser.content.slice(0, 500));
      lines.push('');
    }

    // Last assistant message = current state
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    if (lastAssistant) {
      lines.push('## Current State (last assistant response)');
      lines.push('');
      lines.push(lastAssistant.content.slice(0, 1000));
      lines.push('');
    }

    // Last user message = latest request
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (lastUser && lastUser !== firstUser) {
      lines.push('## Latest Request');
      lines.push('');
      lines.push(lastUser.content.slice(0, 500));
      lines.push('');
    }
  }

  // Full recent conversation
  lines.push('## Recent Conversation');
  lines.push('');
  for (const m of messages) {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    lines.push(`### ${role}`);
    lines.push('');
    lines.push(m.content.slice(0, verbosity === 'full' ? 3000 : 1000));
    lines.push('');
  }

  // Instructions for target agent
  lines.push('## Instructions for New Agent');
  lines.push('');
  lines.push('This is a handoff from a previous coding session. Please:');
  lines.push('1. Read the context above to understand what was being worked on');
  lines.push('2. Continue from where the previous agent left off');
  lines.push('3. Do not repeat work that was already completed');
  if (session.project) {
    lines.push(`4. The project directory is: \`${session.project}\``);
  }
  lines.push('');

  const markdown = lines.join('\n');

  return {
    ok: true,
    markdown: markdown,
    session: {
      id: session.id,
      tool: session.tool,
      project: session.project_short || session.project,
      messages: messages.length,
    },
    target: target,
  };
}

// ── Quick handoff: find latest session and generate ───────

function quickHandoff(sourceTool, target, options) {
  const sessions = loadSessions();
  const source = sessions.find(s => s.tool === sourceTool);
  if (!source) return { ok: false, error: `No ${sourceTool} sessions found` };
  return generateHandoff(source.id, source.project, { ...options, target });
}

module.exports = { generateHandoff, quickHandoff, VERBOSITY };
