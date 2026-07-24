# Running Agents = agents in external terminals (focus, don't spawn)

## Goal

The Workspace "Running agents" sidebar should list agents actually running in
**external** native terminals (iTerm/Terminal.app/Warp/cmux…), and a click on a
row should **raise that real window** — not open a blank terminal in the folder.
codbash's own browser-pty panes are removed from this list — they are already
visible as Workspace tabs and in Overview → Terminals.

## Motivation

Release 7.15.0 introduced the rule "Running Agents lists only agents launched
from codbash" via `_scopeToCodbashAgents` (`src/data.js`) + `pty-registry`: the
list is scoped to agents whose process tree descends from a codbash pty. Side
effects:

- An agent that **codbash itself** launched in iTerm via `POST /api/launch`
  descends from iTerm, not from a codbash pty → it drops out of the list.
  codbash opened the window and then pretends nothing is running.
- An agent launched **by hand** in iTerm in the project folder is invisible too.
- And clicking a running-agent row in the current code (`jumpToRunningAgent`),
  when no live codbash pane exists for that cwd, calls `openInWorkspace(...)` —
  opening a **blank shell** in the folder. A blank shell is not that agent.

External agents are exactly the ones with no other representation in the UI —
those are the ones to show.

## Data inventory

- `getActiveSessions()` (`src/data.js`) scans `ps`, builds an array of live
  agents `{pid, sessionId, cwd, kind, status, cpu, memoryMB, _sessionSource}`
  and finally passes it through `_scopeToCodbashAgents(...)`, which **drops** the
  external ones.
- `pty-registry.js` — a Set of live pty pids codbash itself spawned (one per
  Workspace pane). Populated in `terminal.js`.
- Frontend: `activeSessions` (global, from `GET /api/active`) → used by
  `_wsRunningByProject()` / `_wsRenderRunningTree()` (the tree), by Overview
  (the "Active agents" count), and by the active-badge on session cards.

## Component map (consumers of /api/active)

| Consumer | File | Effect of the change |
|---|---|---|
| Running-agents tree | `workspace.js` | Shows external agents only (`!a.local`) |
| Overview "Active agents" stat | `overview.js` | Counts all live agents (external ones visible again) |
| Session-card active badge | `app.js` | More sessions may light up as active — more correct |

## Data model (contract)

`_scopeToCodbashAgents` → renamed to `_tagCodbashAgents`. Instead of a filter, a
**tag**: each entry gets a boolean field.

```
local: boolean   // true if the process descends from a codbash pty (browser pane)
                 // false — an agent in an external native terminal
```

- **All** detected agents are returned (external ones are in the list again).
- Fail-open: if `ps` for the ppid map is unavailable, tag everyone as
  `local:false` (showing "something is running" is more honest than hiding it).
- If the pty-registry is empty (no panes open), every live agent is external →
  `local:false` for all. This is the desired behavior (previously the list was
  empty).

## Click behavior (state machine)

A "Running agents" row is always an external agent (`!a.local`), so:

```
click(pid, sessionId, cwd)
  → POST /api/focus { pid, sessionId }     // raise the real window by PID
     ok            → window brought to front (reuses focusTerminalByPid)
     focus failed  → toast "Couldn't focus its terminal window" (NOT a blank shell)
```

Forbidden transition: opening a new blank terminal/pane as a "stand-in" for the
agent.

## Touch points (files to change)

- `src/data.js` — `_scopeToCodbashAgents` → `_tagCodbashAgents` (tag instead of
  filter), call site at line 6062.
- `src/frontend/workspace.js` — `_wsRunningByProject` (filter `!a.local`),
  `_wsRenderRunningTree` (forward `pid`, "native terminal" heading/tooltip),
  `jumpToRunningAgent` (focus by PID instead of openInWorkspace).
- `src/frontend/overview.js` — no changes (the count simply sees external agents
  again).

## Risks

| Risk | Handling |
|---|---|
| Noise: "every claude on the machine" back in the list | Grouped by project + tagged; the user explicitly wants this. This reverses 7.15.0 (owner-approved PR) |
| `focusTerminalByPid` doesn't know the agent's app (not iTerm/Terminal/Warp/cmux) | Returns an error → toast, not a blank shell. `addressed_in: jumpToRunningAgent focus-then-toast` |
| Immutability: don't mutate input objects | `map` → new objects `{...a, local}` |
| Prototype pollution via pid/ppid | pids coerced to Number; ppid map built from `ps`; keys are not user input |
| Duplicate external+codbash entry for one agent | Dedup already happens in `getActiveSessions` before tagging; the tag creates no new entries |

## Review findings — triage (code + security review)

| Finding | Severity | Resolution |
|---|---|---|
| `jumpToRunningAgent`: `cwd`/`kind` now unused | LOW | Fixed — comment noting the vestigial params |
| `_wsPidArg` would round a float via `parseInt` | LOW | Fixed — `Number.isInteger` (parity with the server) |
| Windows: no ppid scan → everyone `local:false`, so codbash panes also land in the external tree (redundant with their tab) | LOW | `accepted_because:` pre-existing win32 limitation (the old code also didn't filter on win32); macOS/Linux is codbash's primary platform; cosmetic redundancy, not a bug |
| Dropping the codbash-only scope → `/api/active` again returns cwd/pid/sessionId for **all** agents of all users on the host; wider over LAN with `--host=0.0.0.0` | LOW | `addressed_in:` warning in the LAN banner (`server.js` listen). `accepted_because:` default is loopback (same-machine); LAN-bind is a deliberate opt-in advanced flag; `ps` was always system-wide. Narrowing the scope by bind address is a follow-up, not bundled into this PR |
| `/api/focus` (and other POSTs) have no Origin/CSRF check; `JSON.parse` regardless of Content-Type | INFO | `deferred_to:` a separate PR — pre-existing (route unchanged), cross-cutting (all state-changing POSTs). Mirror the WS-upgrade same-origin pattern |
| INFO log of pid/sessionId/cwd in `/api/focus`/`ACTIVE` | INFO | No action — no secrets |

## UX & Accessibility

The list is not a form; it is a micro-interaction (clicks on list rows).

**Required UI states:**
- [x] Empty — no external agents → the "Running agents" block is hidden (as today).
- [x] Success — click raised the window; the OS app switch is the feedback (the
      window coming forward). No extra toast needed on success.
- [x] Error — focus failed → `showToast(...)` with a clear message.
- [ ] Loading — N/A: focus is instant (osascript), a spinner would be noise.

**Keyboard:** rows are clickable `div`s. The existing markup is not
keyboard-focusable; this change does not make it worse (scope: introduce no
regression; a full keyboard-navigable list is a follow-up, `deferred_to: issue`).

**Screen reader:** keep the `title` on rows; add a clear label that a click
raises the native terminal window.

**Touch targets:** tree rows keep their existing height (unchanged).
