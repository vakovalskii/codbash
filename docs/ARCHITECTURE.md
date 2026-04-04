# CodeDash Architecture

## Overview

```
Browser (localhost:3847)          Node.js Server
+---------------------------+     +---------------------------+
|  index.html               |     |  server.js (HTTP)         |
|  +-- styles.css (inlined) |     |    |                      |
|  +-- app.js (inlined)     | <-->|    +-- data.js            |
|                           |     |    |   (sessions, search,  |
|  Sidebar | Content | Panel|     |    |    cost, active)      |
+---------------------------+     |    +-- terminals.js        |
                                  |    |   (detect, launch)    |
                                  |    +-- html.js             |
                                  |    |   (template assembly) |
                                  |    +-- migrate.js          |
                                  |        (export/import)     |
                                  +---------------------------+
                                            |
                              +-------------+-------------+
                              |                           |
                        ~/.claude/                  ~/.codex/
                        history.jsonl               history.jsonl
                        projects/                   sessions/
                          <project>/                  2026/04/03/
                            <session>.jsonl              <session>.jsonl
                        sessions/
                          <PID>.json
```

## Data Flow

### Session Loading
1. `loadSessions()` reads `~/.claude/history.jsonl` — aggregates by sessionId
2. `scanCodexSessions()` reads `~/.codex/history.jsonl` + walks `~/.codex/sessions/`
3. Claude sessions enriched with file size + message count from project JSONL files
4. Codex sessions enriched with `cwd` from `session_meta` in session files

### Search
1. User types 3+ chars in search box
2. Frontend: trigram fuzzy search on metadata (instant, client-side)
3. After 600ms debounce: deep search via `/api/search`
4. Backend: in-memory index built on first query (263ms for 32 sessions), cached 60s
5. Index contains lowercased full text per session for O(1) substring check
6. Matching sessions boosted to top of results

### Cost Calculation
1. Each assistant message in Claude sessions contains `usage` object
2. Fields: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`
3. Model name from `message.model` (e.g. `claude-opus-4-6`)
4. Real cost = sum per message of (input * input_price + cache_create * create_price + cache_read * read_price + output * output_price)
5. Codex fallback: estimate from file size (no usage data in session files)

### Active Session Detection
1. Read `~/.claude/sessions/<PID>.json` files — contain `{pid, sessionId, cwd, startedAt}`
2. Check if process alive: `ps -p PID -o pid=,%cpu=,rss=,stat=`
3. Status: `active` (CPU >= 1%) or `waiting` (idle/sleeping)
4. Also scan `ps aux | grep codex` for Codex processes
5. Frontend polls `/api/active` every 5 seconds
6. Live sessions get animated border (conic-gradient spin) + LIVE/WAITING badge

### Session Replay
1. Load all messages with timestamps from session file
2. Frontend renders timeline slider + play/pause
3. Messages appear progressively as slider moves
4. Auto-play at 1.5s per message

## File Formats

### Claude history.jsonl
```json
{"sessionId": "uuid", "project": "/path", "timestamp": 1234, "display": "user message"}
```

### Claude session JSONL
```json
{"type": "user", "message": {"role": "user", "content": "..."}, "timestamp": "ISO"}
{"type": "assistant", "message": {"model": "claude-opus-4-6", "content": [...], "usage": {...}}, "timestamp": "ISO"}
```

### Codex history.jsonl
```json
{"session_id": "uuid", "ts": 1234, "text": "user message"}
```

### Codex session JSONL
```json
{"type": "session_meta", "payload": {"id": "uuid", "cwd": "/path"}}
{"type": "response_item", "payload": {"role": "user", "content": [{"type": "input_text", "text": "..."}]}}
```

### Active session PID file (~/.claude/sessions/PID.json)
```json
{"pid": 12345, "sessionId": "uuid", "cwd": "/path", "startedAt": 1234, "kind": "interactive"}
```
