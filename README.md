# CodeDash

Browser dashboard for Claude Code & Codex sessions. View, search, resume, and manage all your AI coding sessions.

https://github.com/user-attachments/assets/15c45659-365b-49f8-86a3-9005fa155ca6

![npm](https://img.shields.io/npm/v/codedash-app?style=flat-square) ![Node](https://img.shields.io/badge/node-%3E%3D16-green?style=flat-square) ![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

## Quick Start

```bash
npx codedash-app run
```

Opens `http://localhost:3847` in your browser.

```bash
npx codedash-app run --port=4000    # custom port
npx codedash-app run --no-browser   # don't auto-open
npx codedash-app list               # list sessions in terminal
npx codedash-app stats              # show statistics
```

## Features

**Sessions**
- Grid and List view with project grouping
- Trigram fuzzy search across session content and projects
- Filter by tool (Claude/Codex), tags, date range
- Star/pin important sessions (always shown first)
- Tag sessions: bug, feature, research, infra, deploy, review
- Activity heatmap (GitHub-style)
- Cost estimation per session

**Launch**
- Resume sessions in iTerm2, Terminal.app, Warp, Kitty, Alacritty
- Auto `cd` into the correct project directory
- Copy resume command to clipboard
- Terminal preference saved between sessions

**Manage**
- Delete sessions (file + history + env cleanup)
- Bulk select and delete
- Export conversations as Markdown
- Related git commits shown per session
- Auto-update notifications

**Themes**
- Dark (default), Light, System

**Keyboard Shortcuts**
- `/` focus search, `j/k` navigate, `Enter` open
- `x` star, `d` delete, `s` select mode, `g` toggle groups
- `r` refresh, `Escape` close panels

## How It Works

Reads session data from `~/.claude/` and `~/.codex/`:
- `history.jsonl` — session index
- `projects/*/<session-id>.jsonl` — conversation data
- `sessions/` — Codex session files

Zero dependencies. Everything runs on `localhost`.

## Requirements

- Node.js >= 16
- Claude Code or Codex CLI installed
- macOS / Linux / Windows

## License

MIT
