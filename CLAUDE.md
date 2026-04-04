# CodeDash

## What is this

CodeDash (`codedash-app` on npm) is a zero-dependency Node.js browser dashboard for managing Claude Code and Codex sessions. Single `npx codedash-app run` opens a local web UI.

## Project structure

```
bin/cli.js              CLI entry point (run/list/stats/update/restart/stop/export/import)
src/
  server.js             HTTP server + all API routes
  data.js               Session loading, search index, cost calculation, active detection
  terminals.js          Terminal detection (iTerm2/Terminal.app/Warp/Kitty) + launch/focus
  html.js               Assembles HTML by inlining CSS+JS into template
  migrate.js            Export/import sessions as tar.gz
  frontend/
    index.html          HTML template with {{STYLES}} and {{SCRIPT}} placeholders
    styles.css           All CSS including dark/light/monokai themes
    app.js              All frontend JavaScript (no build step, plain browser JS)
docs/
  README_RU.md          Russian translation
  README_ZH.md          Chinese translation
```

## Key architecture decisions

- **Zero dependencies** — only Node.js stdlib. No npm install needed.
- **Single process** — server + static HTML in one process
- **Template injection** — `html.js` reads CSS/JS files and injects via `split/join` (not `String.replace` which breaks on `$` characters in JS code)
- **Session data** — reads from `~/.claude/` (history.jsonl, projects/*/session.jsonl) and `~/.codex/` (history.jsonl, sessions/)
- **Project key encoding** — paths encoded as `path.replace(/[\/\.]/g, '-')` — both slashes AND dots replaced with dashes
- **Search index** — built in-memory on first query, cached 60 seconds. Do not remove this.
- **Cost calculation** — uses real `usage` data from assistant messages (input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens) with per-model pricing
- **Active session detection** — reads `~/.claude/sessions/<PID>.json`, checks process alive via `ps`
- **Codex message format** — `response_item` type with `payload.role` and `payload.content` (different from Claude's `user`/`assistant` types)

## API routes

```
GET  /                          Dashboard HTML
GET  /api/sessions              All sessions (Claude + Codex)
GET  /api/session/:id           Full session messages
GET  /api/preview/:id           First N messages (lightweight)
GET  /api/replay/:id            Messages with timestamps for replay
GET  /api/cost/:id              Real cost from token usage
GET  /api/analytics/cost        Aggregated cost analytics
GET  /api/active                Running sessions (PID, CPU, memory)
GET  /api/terminals             Available terminal apps
GET  /api/git-commits           Git commits in time range
GET  /api/search?q=             Full-text search across all sessions
GET  /api/version               Current + latest npm version
POST /api/launch                Open session in terminal
POST /api/focus                 Focus terminal window by PID
POST /api/bulk-delete           Delete multiple sessions
DELETE /api/session/:id         Delete single session
GET  /api/session/:id/export    Download session as Markdown
```

## Important conventions

- Frontend JS is plain browser JavaScript — no modules, no build step, no ES6 imports
- Use `var` in frontend code (not `const`/`let`) for maximum compatibility
- CSS themes via `[data-theme="light"]` and `[data-theme="monokai"]` attribute overrides
- localStorage keys: `codedash-stars`, `codedash-tags`, `codedash-terminal`, `codedash-theme`, `codedash-layout`
- System messages from Codex (AGENTS.md, permissions, exit) are filtered via `isSystemMessage()`
- Model pricing table in `data.js` — `MODEL_PRICING` object with per-token costs

## Publishing

```bash
# Bump version in package.json, then:
git add -A && git commit && git push && npm publish --access public
```

Package name: `codedash-app`, binary name: `codedash`
