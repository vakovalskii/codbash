# claude-sessions-dash

Termius-style browser dashboard for your Claude Code (and Codex) sessions.

![Dashboard](https://img.shields.io/badge/UI-Dark%20Theme-1a1d23?style=flat-square) ![Node](https://img.shields.io/badge/node-%3E%3D16-green?style=flat-square) ![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

## Quick Start

```bash
npx claude-sessions-dash
```

Opens `http://localhost:3847` with your sessions dashboard.

Custom port:

```bash
npx claude-sessions-dash 4000
```

## Features

**Sessions**
- View all Claude Code and Codex sessions in a card grid
- Group by project, view as timeline, or filter by tool
- Full-text search across session names and projects
- Preview conversation history in a side panel

**Launch**
- Resume any session directly in your terminal (iTerm2, Terminal.app, Warp, Kitty, Alacritty)
- One-click launch with `--dangerously-skip-permissions` option
- Auto `cd` into the correct project directory
- Copy resume command to clipboard
- Terminal preference saved between sessions

**Manage**
- Delete sessions (file + history + env cleanup)
- Confirmation dialog to prevent accidents
- Refresh data without restarting

**Keyboard Shortcuts**
- `/` — Focus search
- `Escape` — Close panels

## How It Works

Reads session data from `~/.claude/`:
- `history.jsonl` — session index with timestamps and projects
- `projects/*/\<session-id\>.jsonl` — full conversation data
- `session-env/` — session environment files

Zero dependencies. Single Node.js file. Everything runs on `localhost`.

## Requirements

- Node.js >= 16
- Claude Code installed (`~/.claude/` directory exists)
- macOS / Linux / Windows

## License

MIT
