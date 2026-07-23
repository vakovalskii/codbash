# Codbash

## What is this

Codbash (`codbash-app` on npm) is a zero-dependency Node.js browser dashboard for managing AI coding agent sessions. Supports 7 agents: Claude Code, Codex, Cursor, OpenCode, Kiro CLI, Kilo CLI, Copilot Chat. Single `npm i -g codbash-app && codbash run` opens a local web UI.

It ships in **two channels from one codebase**: the npm CLI (browser UI) and a **signed + notarized macOS desktop app** (Electron shell in `desktop/` wrapping the unmodified server). Latest release: **7.14.7**.

The dashboard has grown into a "super-app": an **Overview** landing view (headline stats + recent sessions + live terminals grouped by project) and an in-browser **Workspace / Terminal** (xterm.js + optional `@lydell/node-pty` over a hand-rolled WebSocket) with tabs, 1–4 splits, saved layouts, and per-project spawning.

## Project structure

```
bin/cli.js              CLI entry point (run/list/stats/search/show/handoff/convert/export/import/update/restart/stop)
src/
  server.js             HTTP server + all API routes + terminal WebSocket
  data.js               Session loading, search index, cost calculation, active detection for all agents
  terminals.js          Native terminal detection (iTerm2/Terminal.app/Warp/Kitty/cmux) + launch/focus
  terminal.js           Browser-terminal pty session (spawn/resolveCwd) for the Workspace view
  workspace-layouts.js  Saved Workspace layouts (panes: cmd/prefill/cwd) persisted to disk
  workspace-commands.js Saved Workspace quick-commands
  shell-path.js         Repairs a stripped PATH from the login shell (GUI-launch agent detection)
  agents-detect.js      Detects which agent CLIs are installed
  projects.js           Project launcher registry (add/list/remove)
  html.js               Assembles HTML by inlining CSS+JS into template
  migrate.js            Export/import sessions as tar.gz (merges history, never overwrites)
  convert.js            Cross-agent session conversion (Claude <-> Codex)
  handoff.js            Generate context documents for session handoff between agents
  changelog.js          In-app changelog data
  frontend/
    index.html          HTML template with {{STYLES}} and {{SCRIPT}} placeholders
    styles.css          All CSS including dark/light/monokai themes
    app.js              Core frontend JS (routing, cards, delete, keyboard nav) — plain browser JS
    overview.js         Overview landing view (default): stats + recent sessions + live terminals
    workspace.js        In-browser Workspace/Terminal (xterm.js, tabs, splits, layouts, running tree)
    calendar.js         Calendar/heatmap sidebar + view routing
    (analytics/detail/cloud/leaderboard/recommended/heatmap/sidebar-config).js
desktop/                Electron desktop app (signed + notarized macOS DMG)
  main.js               Electron main: spawns the unmodified server as a Node child + IPC
  preload.js            contextBridge -> window.codbashDesktop (isDesktop, pickFolder)
  scripts/notarize.js   afterSign notarization hook (keychain profile or APPLE_* env)
  RELEASE.md            Signed-release build/notarize runbook (READ before cutting a DMG)
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
| Kilo CLI | SQLite | `~/.local/share/kilo/kilo.db` | tables: session, message, part, project |
| Copilot Chat | JSON/JSONL | `~/.config/Code/User/workspaceStorage/*/chatSessions/` | `{version, requests: [{message, response}]}` |

## Key architecture decisions

- **Zero dependencies for the core** — dashboard/CLI use only Node.js stdlib + system `sqlite3` CLI for SQLite agents. The optional browser terminal (Workspace) is the sole exception: it lazily loads `@lydell/node-pty` (declared in `optionalDependencies`, prebuilt-only, never runs node-gyp). If it is absent the dashboard still runs and the terminal reports itself disabled. Do NOT add core dependencies.
- **Node >= 18** — minimum supported version
- **Single process** — server + static HTML in one process
- **Template injection** — `html.js` reads CSS/JS files and injects via `split/join` (not `String.replace` which breaks on `$` characters in JS code)
- **Project key encoding** — Claude paths encoded as `path.replace(/[\/\.]/g, '-')` — both slashes AND dots replaced with dashes
- **Search index** — built in-memory on first query, cached 60 seconds. Do NOT remove the search index.
- **Cost calculation** — uses real `usage` data from assistant messages (input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens) with per-model pricing in `MODEL_PRICING` object
- **Active session detection** — reads Claude PID files + scans `ps` for all agent processes (claude, codex, opencode, kiro-cli, cursor-agent)
- **Cursor sessions** — always show "Open in Cursor" button, never "Focus Terminal". Check tool type BEFORE active status.
- **cmux support** — walks parent process chain (up to 6 levels) to detect cmux, then activates via AppleScript
- **Crash-safety** — every HTTP route dispatch is wrapped in try/catch → 500 (one bad session never takes down the server); `findSessionFile` looks up its index with `Object.prototype.hasOwnProperty.call(...)` to avoid prototype-pollution DoS; delete / bulk-delete validate `SAFE_SESSION_ID`
- **Desktop app is a thin shell** — `desktop/main.js` spawns the *unmodified* server as a Node child and points a `BrowserWindow` at it. Keep the server desktop-agnostic; desktop-only capabilities are exposed through `preload.js` (`window.codbashDesktop`) and detected at runtime in the frontend (e.g. the native folder picker is only wired up when `window.codbashDesktop.pickFolder` exists)
- **View-aware chrome** — `render()` stamps `document.body` with `data-view`; the session toolbar is hidden in Overview/Workspace via `body[data-view="workspace"|"overview"] .toolbar { display:none }`
- **Running-agents sidebar tree** (Workspace) is built from `activeSessions` grouped by real `cwd` and labeled by agent — do NOT reconstruct it from static project config
- **Saved layouts round-trip the full pane** — `sanitizePane` preserves `cmd` + `prefill` + `cwd` (not just `cmd`); dropping any of these silently loses the user's launch command on restore
- **No `window.prompt` in Electron** — use `codbashPrompt()` (app.js) for any text input; the native prompt is a no-op in the desktop shell

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

# Workspace / browser terminal
WS   /ws/terminal               Browser-terminal pty (hand-rolled upgrade, no `ws` dep; token-gated)
GET  /api/terminal/status       Terminal availability + per-process WS token
GET/POST/DELETE /api/terminal/layouts[/:id]   Saved Workspace layouts (panes: cmd/prefill/cwd)
GET/POST/DELETE /api/terminal/commands[/:id]  Saved Workspace quick-commands
# Projects launcher
GET/POST/DELETE /api/projects/manual[/:id]    Manually-added project folders
POST /api/projects/clone        git clone into a project folder
# Misc (added this line)
GET  /api/agents/installed      Which agent CLIs are installed
GET  /api/settings              Read/write user settings
# (auth, cloud sync, github, leaderboard, repo-refresh route groups also exist)
```

## Important conventions

- Frontend JS is plain browser JavaScript — no modules, no build step, no ES6 imports
- CSS themes via `[data-theme="light"]` and `[data-theme="monokai"]` attribute overrides
- localStorage keys: `codedash-stars`, `codedash-tags`, `codedash-terminal`, `codedash-theme`, `codedash-layout`, `codedash-last-version`
- System messages from Codex/Kiro (AGENTS.md, permissions, exit) are filtered via `isSystemMessage()`
- Cursor `<user_query>` wrappers are stripped in `loadCursorDetail()`
- **GUI-launch PATH repair** — when the desktop app opens from Finder/Dock macOS hands it a stripped `PATH`, so installed agent CLIs go undetected. `src/shell-path.js` re-derives `PATH` from the user's login shell on startup (opt out: `CODBASH_NO_PATH_REPAIR=1`)
- Session cards carry a native-terminal launch button (resume the agent's last project session; Cursor cards open in Cursor; hidden for copilot-chat)

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

- **Patch** (7.14.x): bug fixes, small CSS tweaks, typos — most changes go here
- **Minor** (7.x.0): new features that don't break existing functionality — new views, new CLI commands, new agent support
- **Major** (x.0.0): breaking changes only — changed API format, removed features, Node version bump, major rewrites

Group multiple small fixes into ONE patch release instead of publishing each fix separately. Aim for 1-3 releases per work session, not 20+.

Before bumping minor/major, ask: "Does this really warrant a version bump, or can it go in the next patch?"

## Publishing

Two independent channels, one codebase. Bump the version once (in `package.json`, `desktop/package.json`, and `src/changelog.js`) on a `release/` branch → PR → merge to main, then publish each channel.

**npm CLI:**
```bash
git checkout main && git pull
npm publish --access public
```
`.github/workflows/publish.yml` is **manual** (`workflow_dispatch`), NOT auto-on-release — it fails early if `NPM_TOKEN` is missing. Never persist the npm publish token: write a transient `.npmrc`, publish, delete it.

**macOS desktop (signed + notarized DMG)** — follow `desktop/RELEASE.md`. Key gotchas:
- Sign with Developer ID (team **A933C2TJXU**); notarize via the macOS keychain profile `codbash-notary` (`notarize.js` reads `APPLE_KEYCHAIN_PROFILE`). Do NOT store Apple credentials in the repo (public) — keychain only.
- **Timestamp gotcha**: `codesign --timestamp` ignores `HTTPS_PROXY` (uses the system network stack), so a corporate proxy blocks `timestamp.apple.com` → "The timestamp service is not available". Build over VPN with proxy env unset (`env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY …`). Apple's TSA also rate-limits per-IP under burst — switch VPN endpoint or wait if throttled.
- electron-builder: the CLI target arg overrides the config `arch` array — pass `--arm64 --x64` explicitly. `identity` must be WITHOUT the `Developer ID Application:` prefix.
- Notarize + `stapler staple` each DMG *after* signing; stapling mutates the DMG, so regenerate blockmaps + `latest-mac.yml` afterward. `spctl -a -t open` on a raw DMG is a false negative (the container isn't code-signed) — verify with a quarantined mount instead.

Package name: `codbash-app`, binary name: `codbash` (legacy alias `codedash` also works)
