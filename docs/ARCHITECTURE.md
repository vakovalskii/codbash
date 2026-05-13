# CodeDash Architecture

## Overview

CodeDash is a zero-dependency Node.js dashboard for AI coding agent sessions. Supports 8 agents: Claude Code, Claude Extension, Codex, Cursor, OpenCode, Kiro, Kilo, Copilot Chat. Single process serves a web UI at `localhost:3847`.

```
Browser (localhost:3847)            Node.js Server
+-----------------------------+     +-------------------------------+
|  index.html                 |     |  server.js (HTTP, 20+ routes) |
|  +-- styles.css (inlined)   |     |    |                          |
|  +-- app.js (inlined)       | <-->|    +-- data.js                |
|                             |     |    |   (sessions, search,      |
|  Sidebar | Content | Detail |     |    |    cost, active)          |
+-----------------------------+     |    +-- terminals.js            |
                                    |    |   (detect, launch, focus) |
       bin/cli.js (CLI)             |    +-- html.js (assembly)      |
       +-------------------+        |    +-- handoff.js              |
       | run/list/search/  |        |    +-- convert.js              |
       | show/handoff/     |------->|    +-- migrate.js              |
       | convert/export/   |        |    +-- changelog.js            |
       | import/update     |        +-------------------------------+
       +-------------------+                    |
                                   reads from 6 locations:
                              ~/.claude/  ~/.codex/  ~/.cursor/
                              ~/.local/share/opencode/opencode.db
                              ~/Library/Application Support/kiro-cli/data.sqlite3
                              ~/.config/Code/User/workspaceStorage/*/chatSessions/
```

## Project Structure

```
bin/cli.js              (12 KB)  CLI entry point — all commands
src/
  server.js             (12 KB)  HTTP server + API routes
  data.js               (46 KB)  Core: session loading, search index, cost, active detection
  terminals.js          (8.8 KB) Terminal detection + launch/focus
  html.js               (754 B)  Template injection (CSS+JS into HTML)
  handoff.js            (4 KB)   Handoff document generation
  convert.js            (8.3 KB) Cross-agent session conversion
  migrate.js            (5.9 KB) Export/import as tar.gz
  changelog.js          (6.7 KB) In-app changelog
  frontend/
    index.html          (10 KB)  HTML template with {{STYLES}} / {{SCRIPT}} placeholders
    styles.css          (52 KB)  All CSS (dark/light/monokai themes)
    app.js              (77 KB)  All frontend logic (plain browser JS, no build step)
docs/
  ARCHITECTURE.md       This file
  README_RU.md          Russian translation
  README_ZH.md          Chinese translation
```

Total source: ~235 KB. Zero npm dependencies — only Node.js stdlib + system `sqlite3` CLI.

---

## Session Storage by Agent

### 1. Claude Code (CLI)

| Item | Location |
|------|----------|
| History index | `~/.claude/history.jsonl` |
| Session data | `~/.claude/projects/<PROJECT_KEY>/<SESSION_ID>.jsonl` |
| PID files | `~/.claude/sessions/<SESSION_ID>.json` |

**PROJECT_KEY** encoding: full path with `/` and `.` replaced by `-`.
Example: `/Users/v.kovalskii/myproject` → `-Users-v-kovalskii-myproject`

**history.jsonl** — one line per user message (index, no full content):
```json
{"sessionId": "uuid", "project": "/Users/v.kovalskii/myproject", "timestamp": 1712345678000, "display": "fix the login bug", "pastedContents": {}}
```

**Session JSONL** — full conversation, one JSON object per line:
```json
{"type": "permission-mode", "permissionMode": "default", "sessionId": "uuid"}
{"type": "user", "uuid": "uuid", "timestamp": "2026-04-06T10:00:00Z", "message": {"role": "user", "content": "fix the bug"}, "cwd": "/path", "entrypoint": "cli", "userType": "external"}
{"type": "assistant", "uuid": "uuid", "timestamp": "2026-04-06T10:00:05Z", "message": {"role": "assistant", "model": "claude-opus-4-6", "content": [...], "usage": {"input_tokens": 1500, "output_tokens": 800, "cache_creation_input_tokens": 500, "cache_read_input_tokens": 200}}}
```

Key fields in user messages: `entrypoint` ("cli" or "claude-vscode"), `cwd`, `userType`.
Key fields in assistant messages: `model`, `usage` (for cost calculation).

**PID files** — active session tracking:
```json
{"pid": 12345, "sessionId": "uuid", "cwd": "/path", "startedAt": 1712345678000, "kind": "interactive"}
```

### 2. Claude Extension (VS Code / Cursor IDE)

Same storage as Claude Code — files go to `~/.claude/projects/<KEY>/<SID>.jsonl`. The difference:

- **No entry in `history.jsonl`** — Extension sessions are "orphan" (exist only as project session files)
- **`entrypoint` field = `"claude-vscode"`** instead of `"cli"` in user messages
- CodeDash scans all project dirs for `.jsonl` files not found in history, reads `entrypoint` from first user message, and assigns `tool: "claude-ext"` if not "cli"

Detection logic in `data.js`:
```
1. Load sessions from history.jsonl (all get tool: "claude")
2. Enrich with detail files — if entrypoint !== "cli", change to "claude-ext"
3. Scan project dirs for orphan .jsonl files not in history
4. Read entrypoint from first user message → "claude-ext" if not "cli"
5. Read cwd from user messages for correct project path
```

### 3. Codex CLI

| Item | Location |
|------|----------|
| History index | `~/.codex/history.jsonl` |
| Session data | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TIMESTAMP>-<UUID>.jsonl` |

**history.jsonl**:
```json
{"session_id": "uuid", "ts": 1712345678, "text": "user prompt", "display": "...", "project": "/path", "cwd": "/path"}
```
Note: `ts` is in **seconds** (not milliseconds like Claude).

**Session JSONL** — first line is metadata, rest are messages:
```json
{"type": "session_meta", "payload": {"id": "uuid", "cwd": "/path", "timestamp": "2026-04-06T10:00:00Z"}}
{"type": "response_item", "payload": {"role": "user", "content": [{"type": "input_text", "text": "fix the bug"}]}}
{"type": "response_item", "payload": {"role": "assistant", "content": [{"type": "text", "text": "I'll fix..."}]}}
```

Session ID extracted from filename: `rollout-20260406-<UUID>.jsonl` → UUID part.

### 4. Cursor (Agent Mode)

| Item | Location |
|------|----------|
| Projects format | `~/.cursor/projects/<PROJECT_KEY>/agent-transcripts/<SESSION_ID>/<SESSION_ID>.jsonl` |
| Chats format | `~/.cursor/chats/<CHAT_ID>/<CHAT_ID>.jsonl` or `.json` |

**Two storage formats** — "projects" (macOS) and "chats" (Linux alternative).

**PROJECT_KEY decoding**: ambiguous (`-` could be `/`, `.`, or literal `-`). CodeDash tries progressive path resolution — testing filesystem existence with different separator combinations.

**Session JSONL**:
```json
{"role": "user", "message": {"content": [{"type": "text", "text": "<user_query>fix the bug</user_query>"}]}}
{"role": "assistant", "message": {"content": [{"type": "text", "text": "I'll fix..."}]}}
```

User messages wrapped in `<user_query>...</user_query>` tags — stripped during parsing.

### 5. OpenCode

| Item | Location |
|------|----------|
| Database | `~/.local/share/opencode/opencode.db` (SQLite) |

Accessed via system `sqlite3` CLI (no Node driver):

**Sessions scan**:
```sql
SELECT s.id, s.title, s.directory, s.time_created, s.time_updated, COUNT(m.id)
FROM session s LEFT JOIN message m ON m.session_id = s.id
GROUP BY s.id ORDER BY s.time_updated DESC
```

**Message loading**:
```sql
SELECT m.data, GROUP_CONCAT(p.data, '|||')
FROM message m LEFT JOIN part p ON p.message_id = m.id
WHERE m.session_id = ?
GROUP BY m.id ORDER BY m.time_created
```

Tables: `session`, `message`, `part`. Message `data` is JSON with `{role, tokens, model}`. Part `data` is JSON with `{type, text}`.

### 6. Kiro CLI

| Item | Location |
|------|----------|
| Database | `~/Library/Application Support/kiro-cli/data.sqlite3` (SQLite) |

**Sessions scan**:
```sql
SELECT key, conversation_id, created_at, updated_at, substr(value, 1, 500)
FROM conversations_v2 ORDER BY updated_at DESC
```
- `key` = project directory
- `conversation_id` = session ID
- `value` = full conversation JSON (truncated for scan, full for detail)

**Conversation JSON structure**:
```json
{
  "history": [
    {
      "user": {"content": {"Prompt": {"prompt": "fix the bug"}}},
      "assistant": {"Response": {"content": "I'll fix...", "message_id": "uuid"}}
    }
  ]
}
```

### 7. Copilot (VS Code Extension)

| Item | Location |
|------|----------|
| Sessions | `~/.config/Code/User/workspaceStorage/[hash]/chatSessions/` (JSON/JSONL) |

**Storage formats**: Two file formats coexist in `chatSessions/`:
- **`.json`** — complete session state as a single JSON object
- **`.jsonl`** — mutation-based format (kind:0 init, kind:1 set, kind:2 splice)

**Session JSON structure**:
```json
{
  "version": 3,
  "creationDate": 1772452223289,
  "requests": [
    {
      "requestId": "request_uuid",
      "message": {"text": "user prompt"},
      "response": [
        {"kind": "text", "value": "assistant response"},
        {"kind": "thinking", "value": "..."},
        {"kind": "toolInvocationSerialized", "value": {...}}
      ],
      "modelId": "copilot/claude-sonnet-4.6"
    }
  ]
}
```

**Project mapping**: `workspaceStorage/[hash]/workspace.json` contains `folder` URI → decoded to local path.

**Cost**: No token usage stored locally — returns empty cost.

---

## Data Flow

### Session Loading (`data.js:loadSessions()`)

```
1. Read ~/.claude/history.jsonl → sessions{} keyed by sessionId (tool: "claude")
2. scanCodexSessions() → merge into sessions{} (tool: "codex")
3. scanOpenCodeSessions() → merge (tool: "opencode")
4. scanCursorSessions() → merge (tool: "cursor")
5. scanKiroSessions() → merge (tool: "kiro")
5a. scanCopilotSessions() → merge (tool: "copilot-chat")
6. Enrich Claude sessions with detail files:
   - Count messages, get file size
   - Check entrypoint → change tool to "claude-ext" if not "cli"
7. Scan orphan sessions from ~/.claude/projects/ (Claude Extension)
8. Sort by last_ts DESC, format dates
```

### Search Index

- Built in-memory on first `/api/search` call
- Reads all session detail files, extracts lowercased full text
- Cached 60 seconds (rebuild on expiry)
- Substring match on `fullText.indexOf(query)`, returns up to 3 snippets per session with +-50 char context

### Cost Calculation

Uses `usage` data from Claude assistant messages:
```
cost = input_tokens * input_price
     + cache_creation_input_tokens * cache_create_price
     + cache_read_input_tokens * cache_read_price
     + output_tokens * output_price
```

Model pricing in `MODEL_PRICING` object (per-token rates for opus, sonnet, haiku, codex-mini, gpt-5).
Codex fallback: estimate from file size (~4 bytes per token).

### Active Session Detection

```
1. Read ~/.claude/sessions/*.json → PID-to-session map
2. ps aux | grep "claude|codex|opencode|kiro-cli|cursor-agent"
3. For each process: parse PID, CPU%, memory, state
4. Status: "active" (CPU >= 1%) or "waiting" (sleeping/stopped)
5. Map PID → sessionId via PID files
6. Frontend polls /api/active every 5 seconds
```

---

## HTML Assembly

`html.js` reads three files and injects CSS+JS into HTML:
```javascript
template.split('{{STYLES}}').join(css).split('{{SCRIPT}}').join(js)
```
Uses `split/join` instead of `String.replace` — avoids `$` character issues in JS code.
Result cached in memory (refreshed in `NODE_ENV=development`).

Final page: ~130 KB (single HTML, no external requests).

---

## Frontend Architecture

Plain browser JavaScript — no modules, no build step, no ES6 imports. Uses `var` for compatibility.

**State**: global variables (`allSessions`, `filteredSessions`, `currentView`, `toolFilter`, etc.)
**Persistence**: `localStorage` for stars, tags, theme, layout, terminal preference.
**Rendering**: string concatenation → `innerHTML`. No virtual DOM.

Key features:
- Trigram fuzzy search (client-side, instant) + deep search (server-side, 600ms debounce)
- Grid/list layout toggle
- Group by project
- Active session polling with animated borders
- Inline message preview (expand) and hover tooltips
- Tag system (6 predefined: bug, feature, research, infra, deploy, review)
- Star system
- Dark/light/monokai themes
- Session replay with timeline slider
- Cost analytics charts

---

## API Routes

### Sessions
```
GET  /api/sessions              All sessions (all agents)
GET  /api/session/:id           Full messages
GET  /api/preview/:id?limit=N   First N messages
GET  /api/replay/:id            Messages with timestamps
GET  /api/cost/:id              Token usage + real cost
DELETE /api/session/:id         Delete session
POST /api/bulk-delete           Delete multiple sessions
GET  /api/session/:id/export    Download as Markdown
```

### Search & Analytics
```
GET  /api/search?q=QUERY        Full-text search (min 2 chars)
GET  /api/analytics/cost        Aggregated cost by day/week/project
GET  /api/active                Running agent processes
GET  /api/git-commits           Git commits in time range
```

### Actions
```
POST /api/launch                Open session in terminal
POST /api/focus                 Focus terminal window by PID
POST /api/open-ide              Open project in Cursor/VS Code
POST /api/convert               Convert session between formats
GET  /api/handoff/:id           Generate handoff document
```

### System
```
GET  /                          Dashboard HTML (inlined CSS+JS)
GET  /favicon.ico               SVG favicon
GET  /api/version               Current + latest npm version
GET  /api/changelog             Changelog entries
GET  /api/terminals             Available terminal apps
```

### Repo Auto-Refresh
```
GET  /api/repo-refresh/state              Per-repo state + current settings
POST /api/repo-refresh/trigger            Start `git fetch --all --prune` for one repo
POST /api/repo-refresh/wait               Long-poll until a fetch finishes (or timeoutMs, default 2000, max 10000)
GET  /api/repo-refresh/settings           Read settings
POST /api/repo-refresh/settings           Update settings (partial; merged + atomically persisted)
```

---

## Repo Auto-Refresh

Keeps local clones of connected repositories in sync with their remote so the
LLM in a fresh session sees current `origin/<branch>` and doesn't drift into
branch divergence. The work runs in the background, never touches the working
tree, and never blocks the HTTP server.

### Triggers (v1)

1. **Manual** — click the `↻` button on a project card.
2. **New chat** — when a project has its "Auto-refresh on new chat" toggle on,
   `launchNewProjectSession` / `resumeLastProjectSession` issue a fetch and
   wait up to 2 s before opening the terminal session.
3. **Service start** — when the global "Refresh on startup" toggle is on,
   `bin/cli.js` calls `repoRefreshManager.initOnStartup()` after the HTTP
   server has bound.

Deferred to a future PR: periodic scheduler (5/10/15/30/60 min), page-refresh
trigger, and "behind by N commits" indicators.

### Per-repo state machine

```
       ┌───────────┐
       │   idle    │  (lastSuccessAt: null | epoch)
       └─────┬─────┘
             │ trigger()
             ▼
       ┌───────────┐
       │ fetching  │  (startedAt: epoch; single-flight per gitRoot)
       └─┬───────┬─┘
   ok    │       │   error / 60 s timeout
         ▼       ▼
       ┌───────┐ ┌────────┐
       │ idle  │ │ error  │ (lastError truncated to ≤200 chars)
       └───────┘ └────────┘
```

### Backend (`src/repo-refresh.js`)

- Singleton manager built via `createRepoRefreshManager(opts)` — opts allow
  test-time DI of `execFile`, timers, `atomicWriteJson`, `resolveGitRoot`,
  `existsSync`, and `logger`.
- **Single-flight** per `gitRoot` through an `inflight` Map — concurrent
  triggers return the existing promise; no second child process is spawned.
- **Concurrency cap** = 4 parallel `git fetch` processes; the 5th waits in a
  FIFO queue. Sync fast path when capacity is available so the child process
  starts before `triggerRefresh()` returns.
- **Timeout** = 60 s. On expiry the manager sends `SIGTERM`, waits a 2 s
  grace, then sends `SIGKILL`. State transitions to `error` with
  `lastError = "timeout after 60000ms"`.
- **Settings** live at `~/.codedash/refresh-settings.json`. Loaded on
  construction; saved through `atomicWriteJson` with a 500 ms debounce so
  rapid toggle clicks coalesce into one disk write.
- **Orphan GC** — on every `initOnStartup`, perProject keys with
  `!existsSync(gitRoot) || resolveGitRoot(gitRoot) === ''` are dropped and the
  cleaned settings are persisted.

### HTTP routes (`src/repo-refresh-routes.js`)

Pure dispatcher function `handleRepoRefreshRoute(req, res, deps)` that returns
`true` if it handled the request — mounted in `src/server.js` before the
Sessions API. Validation rejects:

- `POST /trigger` / `POST /settings` referencing a `gitRoot` not in the known
  set (`loadProjects()` ∪ `loadSessions().git_root`, cached 5 s) → 404 / 400.
- `POST /settings` body with the wrong shape → 400 `invalid_payload`.
- `POST /trigger` body > 1 MiB → 400 `invalid_payload`.
- `POST /wait timeoutMs` clamped to `[0, 10000]`.

### Frontend (`src/frontend/app.js`)

- Module-level `repoRefreshState` mirrors what the backend serves.
- `loadRepoRefreshState()` runs once at init and after manual triggers; a
  `setInterval(2000)` polls only while at least one visible repo is in
  `fetching` and the user is on the Projects view.
- Project card markup uses `data-rr-badge="<gitRoot>"` and
  `data-rr-toggle="<gitRoot>"` attributes so `refreshRepoRefreshUI()` can
  update badges and toggles in place without re-rendering the whole view
  (preserves scroll position and group collapse state).
- Toggle clicks are **optimistic**: the visual flips immediately, the POST
  fires, and a failure rolls the visual back with a toast.
- `maybeRefreshBeforeLaunch(gitRoot)` issues `/trigger` + `/wait` (timeoutMs:
  2000) before invoking `/api/launch`. If the wait times out the session
  opens with whatever refs are currently on disk; if the fetch errors the
  user sees a toast but the launch proceeds.

### Atomic JSON writes (`src/atomic.js`)

`atomicWriteJson(filePath, obj)` is the canonical write helper for every
codbash JSON cache. Steps: ensure parent dir, write to `<path>.tmp`, fsync,
rename. On rename failure the temp file is unlinked and the original target
is left untouched. The legacy disk caches (`_saveParsedDiskCache`,
`_saveGitRootDiskCache`, `_saveCostDiskCache`, `_saveDailyStatsDiskCache` in
`src/data.js`) all flow through this helper.

---

## Contributing

### Git Workflow

`main` is protected. All changes require a pull request with 1 approval.

```
main (protected)
  ├── feat/session-titles    → PR → merge
  ├── fix/cursor-path        → PR → merge
  └── release/6.4.0          → PR → merge + npm publish
```

**Branch naming:** `feat/`, `fix/`, `chore/`, `release/`

**Commit format:** Conventional — `feat:`, `fix:`, `chore:`, `docs:`, `perf:`

### PR Guidelines

- One feature or fix per PR
- Keep PRs under 5 files when possible
- Large features should be split into incremental PRs
- Test locally with `node -e "require('./src/server')"` before pushing
