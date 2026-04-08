'use strict';

const CHANGELOG = [
  {
    version: '6.14.6',
    date: '2026-04-08',
    title: 'Cursor sessions + massive performance boost',
    changes: [
      'Scan 400+ Cursor sessions from globalStorage state.vscdb',
      'Progressive loading: fast sessions first, Cursor vscdb in background',
      'Disk cache for sessions, costs, git roots, daily stats, workspace map',
      'Session file index eliminates 15K+ filesystem calls',
      'Analytics/leaderboard: was hanging 5-10 min, now loads in ~2s',
    ],
  },
  {
    version: '6.0.4',
    date: '2026-04-06',
    title: '5 agents: Cursor + live detection for all',
    changes: [
      'Cursor support: read sessions from ~/.cursor/projects/*/agent-transcripts/',
      'LIVE/WAITING detection for ALL agents (Claude, Codex, Cursor, OpenCode, Kiro)',
      'Open in Cursor button (opens project in Cursor IDE)',
      'Detects Claude Code extension running inside Cursor (claude-vscode entrypoint)',
      'GitHub-style SVG activity heatmap with streak stats and tool breakdown',
      'Smart Cursor project path decoding from filesystem',
    ],
  },
  {
    version: '5.3.0',
    date: '2026-04-06',
    title: 'Kiro CLI support',
    changes: [
      '4 agents: Claude Code, Codex, OpenCode, Kiro CLI',
      'Kiro sessions from SQLite (~/Library/Application Support/kiro-cli/)',
      'Orange badge for Kiro in sidebar filter',
    ],
  },
  {
    version: '5.2.0',
    date: '2026-04-06',
    title: 'Heatmap fix, Agents section, cmux',
    changes: [
      'Fix heatmap: scrollable grid, all months visible',
      'Sidebar: "TOOLS" renamed to "AGENTS"',
      'cmux terminal support with trigger-flash',
    ],
  },
  {
    version: '5.1.0',
    date: '2026-04-05',
    title: 'Bug fixes (#7 #8 #9), cmux focus',
    changes: [
      'Fix: delete dialog showing Install Kiro instead of delete',
      'Fix: analytics respects date range filter',
      'Fix: timeline grid/list toggle working',
      'cmux focus walks full parent process chain',
    ],
  },
  {
    version: '5.0.0',
    date: '2026-04-05',
    title: 'Session handoff between agents',
    changes: [
      'codedash handoff <id> [target] — generate context document',
      'Quick handoff: codedash handoff claude codex',
      'Verbosity levels: minimal, standard, verbose, full',
      'Handoff button in detail panel',
      'Node >= 18',
    ],
  },
  {
    version: '4.2.0',
    date: '2026-04-05',
    title: 'OpenCode support',
    changes: [
      'Read sessions from ~/.local/share/opencode/opencode.db',
      'SQLite parsing via sqlite3 CLI (no Node deps)',
      'Purple badge for OpenCode',
    ],
  },
  {
    version: '4.1.0',
    date: '2026-04-04',
    title: 'In-app Changelog',
    changes: [
      'Changelog view with timeline design',
      '"What\'s new" toast after updates',
    ],
  },
  {
    version: '4.0.0',
    date: '2026-04-04',
    title: 'Cross-agent session conversion',
    changes: [
      'Convert sessions between Claude Code and Codex CLI',
      'CLI: codedash convert <id> claude/codex',
      'Convert button in session detail panel',
      'Atomic writes for safety',
    ],
  },
  {
    version: '3.4.0',
    date: '2026-04-04',
    title: 'CLI search, show, docs',
    changes: [
      'codedash search <query> — full-text search from terminal',
      'codedash show <id> — session details with cost and messages',
      'CLAUDE.md and architecture documentation',
    ],
  },
  {
    version: '3.3.0',
    date: '2026-04-04',
    title: 'Install Agents, author credit',
    changes: [
      'Install Agents section: Claude Code, Codex, Kiro, OpenCode',
      'One-click copy install commands',
      'Author credit in sidebar',
    ],
  },
  {
    version: '3.2.0',
    date: '2026-04-04',
    title: 'Real cost calculation',
    changes: [
      'Real cost from actual token usage (not file size estimates)',
      'Model-specific pricing: Opus, Sonnet, Haiku, Codex, GPT-5',
      'Cache pricing: cache_read 90% discount, cache_create 25% premium',
      'Detail panel shows real cost with model and token breakdown',
    ],
  },
  {
    version: '3.1.0',
    date: '2026-04-04',
    title: 'Running sessions view',
    changes: [
      'New "Running" sidebar view with grid layout',
      'CPU, Memory, PID, Uptime for each active session',
      'Focus, Details, Replay buttons',
      'Recently inactive sessions shown below',
    ],
  },
  {
    version: '3.0.0',
    date: '2026-04-04',
    title: 'Session Replay, Cost Analytics',
    changes: [
      'Session Replay: timeline slider, play/pause, progressive messages',
      'Cost Analytics dashboard: daily chart, project bars, top sessions',
      'Focus Terminal button for active sessions',
    ],
  },
  {
    version: '2.1.0',
    date: '2026-04-04',
    title: 'Animated border on live cards',
    changes: [
      'Conic gradient border spins around LIVE cards',
      'WAITING cards: static border',
      'Pulsing dot + LIVE/WAITING badges',
    ],
  },
  {
    version: '2.0.0',
    date: '2026-04-04',
    title: 'Live session detection',
    changes: [
      'Detect running Claude/Codex processes via PID files',
      'LIVE (green) and WAITING (yellow) badges with pulse animation',
      'CPU%, Memory, PID shown on hover',
      'Polling every 5 seconds',
    ],
  },
  {
    version: '1.9.0',
    date: '2026-04-03',
    title: 'Tags fix, search index, Export/Import UI',
    changes: [
      'Fixed tag dropdown positioning',
      'In-memory search index (263ms build, 60s cache)',
      'Export/Import dialog in sidebar',
      'codedash update/restart/stop commands',
    ],
  },
  {
    version: '1.6.0',
    date: '2026-04-03',
    title: 'Message extraction fix',
    changes: [
      'Fixed message extraction for both Claude and Codex',
      'Hover preview and expand cards working',
      'Version badge in sidebar',
    ],
  },
  {
    version: '1.5.0',
    date: '2026-04-03',
    title: 'Deep search, hover preview, expandable cards',
    changes: [
      'Full-text search across all session messages',
      'Hover tooltip with first 6 messages',
      'Expand cards inline with first 10 messages',
    ],
  },
  {
    version: '1.4.0',
    date: '2026-04-03',
    title: 'Export/Import for PC migration',
    changes: [
      'codedash export — archive all sessions as tar.gz',
      'codedash import — restore on new machine',
    ],
  },
  {
    version: '1.3.0',
    date: '2026-04-03',
    title: 'Trigram fuzzy search',
    changes: [
      'Fuzzy search with trigram scoring',
      'Results ranked by relevance',
    ],
  },
  {
    version: '1.1.0',
    date: '2026-04-03',
    title: 'Grid/List toggle, Codex support',
    changes: [
      'Grid/List layout switcher',
      'Codex session parsing fixed',
      'Project navigation from Projects view',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-04-03',
    title: 'Initial release',
    changes: [
      'Session dashboard with dark theme',
      'Group by project, timeline, activity heatmap',
      'Star, tag, delete sessions',
      'Resume in iTerm2/Terminal.app',
      'Terminal selector, theme switcher',
    ],
  },
];

module.exports = { CHANGELOG };
