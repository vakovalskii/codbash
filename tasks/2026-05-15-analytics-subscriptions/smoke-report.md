# Smoke report — analytics-subscriptions

**Date**: 2026-05-15
**Branch**: feat/analytics-subscriptions
**Verdict**: 🟢 GREEN

## Setup

```bash
node bin/cli.js run --no-open --port=8765
```

## Checks

### 1. Syntax / load

| Check | Result |
|-------|--------|
| `node --check src/data.js` | OK |
| `node --check src/frontend/app.js` | OK |
| `node --check src/frontend/analytics.js` | OK |
| `node --test test/*.test.js` | 94 / 95 pass (1 pre-existing wsl-windows fail on macOS, unrelated) |
| `node --test test/display-project.test.js` | 14 / 14 pass |

### 2. HTTP endpoints

| Endpoint | Result |
|----------|--------|
| `GET /` | HTTP 200, 371677 bytes |
| `GET /api/analytics/cost` | HTTP 200, 8366 bytes |

### 3. Project name display (bug fix)

```
byProject keys count: 23
Sample keys: ["codbash","(home)","flow-tasks","sad-vaughan-5bb9f8",
              "trusting-feynman-9b2403","vibrant-bartik-093fac","window",
              "reverent-franklin-b9ae0e","tasktime-mvp","outputs"]
Tilde/path leakage:  CLEAN (no "~/", no "/Users/...", no "$HOME")
(home) group:        present
topSessions[0..2]:   ['(home)', '(home)', '(home)']
```

✓ Real git repos display as basename (`codbash`, `flow-tasks`, `tasktime-mvp`).
✓ Sessions with project path == $HOME merge into a single `(home)` row.
✓ Cursor-style project hashes (`sad-vaughan-5bb9f8`) pass through unchanged — they were already basenames.

### 4. Frontend integration

| Check | Result |
|-------|--------|
| SERVICE_PLANS keys in served HTML | 13 mentions (Claude Code, ChatGPT/Codex, Cursor, Copilot, Kiro, OpenCode, Qwen Code, Kilo, API (custom)) |
| `displayProject` leaked to frontend | 0 (correctly server-only) |
| A11y/UX hooks present | 10 mentions (sr-only / sub-aria-live / sub-group-header) |

### 5. Manual UI checks (deferred to user)

Items I cannot exercise without a real browser session — recommended manual smoke before merge:

- [ ] Open `/`, switch to Analytics → History tab.
- [ ] Type "Claude Code" in Service input → Plan datalist shows Pro / Max 5× / Max 20×.
- [ ] Pick "Max 5×" → Paid auto-fills to 100.
- [ ] Pick "API (custom)" → Plan placeholder changes to "Provider / balance label"; Paid empty; can type freely.
- [ ] Pick "Qwen Code" → hint "Free / API-only — use 'API (custom)' instead"; Add disabled.
- [ ] Add 2 entries (1 sub + 1 API) → see two subtotals "Subscriptions $X/mo" + "API deposits $Y total".
- [ ] Tab through form → focus ring visible on every input + button.
- [ ] Press Enter in Paid (with valid values) → entry added.
- [ ] Inspect Cost by Project chart → labels are short (no `~/`, no `$HOME`).

## Risks closed

| Risk (from plan.md) | Status |
|---------------------|--------|
| `path.basename('/Users/x')` returns `'x'` not `(home)` | addressed_in: `displayProject` — homedir compared BEFORE basename. Test: `(home) for absolute homedir path` (display-project.test.js:30) |
| Datalist allows "Max 5x" (ASCII x) — no autofill | addressed_in: `normalizePlanName()` in app.js — × ↔ x normalized symmetrically |
| `removeSubEntry(i)` index mismatch after splitting groups | addressed_in: `subIndexed` annotates each entry with original index; passed to onclick |
| Corrupted localStorage JSON throws on load | addressed_in: `getSubscriptionConfig` wraps JSON.parse in try/catch (BDD cat-4) |
| Long plan name overflow | addressed_in: CSS `.sub-entry-plan { max-width:280px; text-overflow:ellipsis; title attr for tooltip }` |
| 100+ entries DOM slowness | accepted_because: realistic ~20; pre-aggregated subtotals |
| Hardcoded prices stale | accepted_because: verified 2026-05-15 with source URLs; user can override `paid` manually |
| Tab-collision on legacy migration | accepted_because: rare, re-migration on next read, no data loss |
| Datalist not opening on click like `<select>` | accepted_because: matches existing form pattern |
