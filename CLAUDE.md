# CodeDash

## What is this

CodeDash (`codedash-app` on npm) is a zero-dependency Node.js browser dashboard for managing AI coding agent sessions. Supports 5 agents: Claude Code, Codex, Cursor, OpenCode, Kiro CLI. Single `npm i -g codedash-app && codedash run` opens a local web UI.

## Project structure

```
bin/cli.js              CLI entry point (run/list/stats/search/show/handoff/convert/export/import/update/restart/stop)
src/
  server.js             HTTP server + all API routes
  data.js               Session loading, search index, cost calculation, active detection for all 5 agents
  terminals.js          Terminal detection (iTerm2/Terminal.app/Warp/Kitty/cmux) + launch/focus
  html.js               Assembles HTML by inlining CSS+JS into template
  migrate.js            Export/import sessions as tar.gz
  convert.js            Cross-agent session conversion (Claude <-> Codex)
  handoff.js            Generate context documents for session handoff between agents
  changelog.js          In-app changelog data
  frontend/
    index.html          HTML template with {{STYLES}} and {{SCRIPT}} placeholders
    styles.css          All CSS including dark/light/monokai themes
    app.js              All frontend JavaScript (no build step, plain browser JS)
docs/
  README_RU.md          Russian translation
  README_ZH.md          Chinese translation
  ARCHITECTURE.md       Data flow, file formats, diagrams
```

## Supported agents and data sources

| Agent | Storage | Location | Format |
|-------|---------|----------|--------|
| Claude Code | JSONL | `~/.claude/projects/*/`, `~/.claude/history.jsonl` | `{type, message, timestamp}` |
| Codex CLI | JSONL | `~/.codex/sessions/`, `~/.codex/history.jsonl` | `{type: "response_item", payload}` |
| Cursor | JSONL | `~/.cursor/projects/*/agent-transcripts/` | `{role, message: {content}}` |
| OpenCode | SQLite | `~/.local/share/opencode/opencode.db` | tables: session, message, part |
| Kiro CLI | SQLite | `~/Library/Application Support/kiro-cli/data.sqlite3` | table: conversations_v2 |

## Key architecture decisions

- **Zero dependencies** — only Node.js stdlib + system `sqlite3` CLI for SQLite agents
- **Node >= 18** — minimum supported version
- **Single process** — server + static HTML in one process
- **Template injection** — `html.js` reads CSS/JS files and injects via `split/join` (not `String.replace` which breaks on `$` characters in JS code)
- **Project key encoding** — Claude paths encoded as `path.replace(/[\/\.]/g, '-')` — both slashes AND dots replaced with dashes
- **Search index** — built in-memory on first query, cached 60 seconds. Do NOT remove the search index.
- **Cost calculation** — uses real `usage` data from assistant messages (input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens) with per-model pricing in `MODEL_PRICING` object
- **Active session detection** — reads Claude PID files + scans `ps` for all agent processes (claude, codex, opencode, kiro-cli, cursor-agent)
- **Cursor sessions** — always show "Open in Cursor" button, never "Focus Terminal". Check tool type BEFORE active status.
- **cmux support** — walks parent process chain (up to 6 levels) to detect cmux, then activates via AppleScript

## API routes

```
GET  /                          Dashboard HTML
GET  /favicon.ico               SVG favicon
GET  /api/sessions              All sessions (all 5 agents)
GET  /api/session/:id           Full session messages
GET  /api/preview/:id           First N messages (lightweight)
GET  /api/replay/:id            Messages with timestamps for replay
GET  /api/cost/:id              Real cost from token usage
GET  /api/analytics/cost        Aggregated cost analytics (supports ?from=&to= date filters)
GET  /api/active                Running sessions (all agents — PID, CPU, memory, status)
GET  /api/terminals             Available terminal apps
GET  /api/git-commits           Git commits in time range
GET  /api/search?q=             Full-text search across all sessions
GET  /api/version               Current + latest npm version
GET  /api/changelog             Changelog data
GET  /api/handoff/:id           Generate handoff markdown document
POST /api/launch                Open session in terminal
POST /api/focus                 Focus terminal window by PID
POST /api/open-ide              Open project in Cursor/VS Code
POST /api/convert               Convert session between agents
POST /api/bulk-delete           Delete multiple sessions
DELETE /api/session/:id         Delete single session
GET  /api/session/:id/export    Download session as Markdown
```

## Important conventions

- Frontend JS is plain browser JavaScript — no modules, no build step, no ES6 imports
- CSS themes via `[data-theme="light"]` and `[data-theme="monokai"]` attribute overrides
- localStorage keys: `codedash-stars`, `codedash-tags`, `codedash-terminal`, `codedash-theme`, `codedash-layout`, `codedash-last-version`
- System messages from Codex/Kiro (AGENTS.md, permissions, exit) are filtered via `isSystemMessage()`
- Cursor `<user_query>` wrappers are stripped in `loadCursorDetail()`

## Git workflow

**`main` branch is protected.** All changes go through feature branches + pull requests.

```bash
# 1. Create a feature branch
git checkout -b feat/my-feature    # or fix/bug-name, chore/cleanup

# 2. Make changes, commit
git add <files> && git commit -m "feat: description"

# 3. Push and create PR
git push -u origin feat/my-feature
gh pr create --title "feat: description" --body "..."

# 4. After review/approval, merge via GitHub
gh pr merge <number> --squash
```

**Branch naming:**
- `feat/` — new features
- `fix/` — bug fixes
- `chore/` — refactoring, docs, CI
- `release/` — version bumps + publish

**Commit messages:** Use conventional format: `feat:`, `fix:`, `chore:`, `docs:`, `perf:`.

**PR rules:**
- 1 approval required to merge into main
- Keep PRs small and focused — one feature/fix per PR
- Large PRs touching 5+ files should be split

## Versioning rules

**IMPORTANT: Do not bump versions aggressively.**

- **Patch** (6.0.x): bug fixes, small CSS tweaks, typos — most changes go here
- **Minor** (6.x.0): new features that don't break existing functionality — new views, new CLI commands, new agent support
- **Major** (x.0.0): breaking changes only — changed API format, removed features, Node version bump, major rewrites

Group multiple small fixes into ONE patch release instead of publishing each fix separately. Aim for 1-3 releases per work session, not 20+.

Before bumping minor/major, ask: "Does this really warrant a version bump, or can it go in the next patch?"

## Publishing

```bash
# From a release branch:
git checkout -b release/6.x.x
# Bump version in package.json, commit, push, create PR
# After merge to main:
git checkout main && git pull
npm publish --access public
```

Package name: `codedash-app`, binary name: `codedash`
