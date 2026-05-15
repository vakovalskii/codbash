# Implementation Plan — Repo Auto-Refresh (v1)

> Branch: `feat/repo-auto-refresh`
> SDD: `/Users/pavelnovak/code/codbash/docs/design/repo-auto-refresh.md`
> BDD: `/Users/pavelnovak/code/codbash/specs/repo-auto-refresh.feature`

## Goal

Ship per-project background `git fetch --all --prune` driven by a manual button, a per-project "auto-refresh on new chat" toggle, and a global "refresh on startup" toggle — with atomic settings persistence and the existing disk caches retrofitted onto the same atomic helper.

---

## File-by-file change list

| File | New / Mod | One-line summary |
|------|-----------|------------------|
| `src/atomic.js` | new | `atomicWriteJson(filePath, obj)` — tmp + fsync + rename helper, stdlib only. |
| `src/repo-refresh.js` | new | `RepoRefreshManager` singleton: state map, single-flight, semaphore (max 4), settings I/O, fetch worker. |
| `src/data.js` | mod | Replace `fs.writeFileSync(...)` in `_saveParsedDiskCache`, `_saveGitRootDiskCache`, `_saveCostDiskCache`, `_saveDailyStatsDiskCache` with `atomicWriteJson`. |
| `src/server.js` | mod | +4 routes under `/api/repo-refresh/*` (state, trigger, wait, settings GET/POST). |
| `bin/cli.js` | mod | After `startServer(...)` call `RepoRefreshManager.initOnStartup()` (non-blocking). |
| `src/frontend/app.js` | mod | Project-card toggle + refresh button + spinner/badge + 2s polling + new-chat hook + header global toggle. |
| `src/frontend/styles.css` | mod | `.repo-refresh-spinner`, `.repo-refresh-badge-error`, `.repo-refresh-badge-ok`, focus ring, mobile collapse. |
| `docs/ARCHITECTURE.md` | mod | New "Repo Auto-Refresh" section (state machine + endpoints). |
| `test/atomic.test.js` | new | Atomic write semantics: rename, partial-write protection, EACCES propagation. |
| `test/repo-refresh.test.js` | new | Manager: single-flight, semaphore=4, timeout=60s, error mapping, settings round-trip, corrupt-file fallback. |
| `test/repo-refresh-api.test.js` | new | Server routes: `/state`, `/trigger`, `/wait` (with `timedOut`), `/settings` GET+POST validation. |

No new dependencies. Stdlib only (`child_process`, `fs`, `path`, `os`, `crypto`).

---

## Phase 1 — `atomic.js` helper + tests + retrofit existing caches

**Type:** implementation + test + wiring

**Files:**
- `src/atomic.js` (new)
- `src/data.js` (mod — 4 call sites)
- `test/atomic.test.js` (new)

**Signatures (TS-style):**
```ts
// src/atomic.js
export function atomicWriteJson(filePath: string, obj: unknown): void
// Steps: ensure dir exists, write to `${filePath}.tmp`, fsync the fd,
//        close, rename(tmp → filePath). Throws on failure.
```

**BDD scenarios satisfied:**
- "Settings write is atomic — crash mid-write leaves the file consistent"
- "Existing git-root cache file uses the same atomic write helper"

**Tests (`node --test test/atomic.test.js`):**
- `atomicWriteJson writes valid JSON and the target file matches input`
- `atomicWriteJson creates the parent directory if missing`
- `atomicWriteJson removes the .tmp file after successful rename`
- `atomicWriteJson throws on EACCES of the tmp file`
- `atomicWriteJson does not leave partial data if rename fails (mock fs.renameSync to throw)`

**Manual verification:**
```
node -e "require('./src/atomic').atomicWriteJson('/tmp/foo.json', {a:1})"
cat /tmp/foo.json
ls /tmp/foo.json*    # no .tmp left behind
```
Then start codbash, let it touch the existing caches; confirm files remain valid JSON and no `*.tmp` leftovers in `~/.codedash/`.

**Size:** S

---

## Phase 2 — `RepoRefreshManager` core (no HTTP, no UI)

**Type:** implementation + test

**Files:**
- `src/repo-refresh.js` (new)
- `test/repo-refresh.test.js` (new)

**Signatures (TS-style):**
```ts
// src/repo-refresh.js
interface RepoState {
  status: 'idle' | 'fetching' | 'error'
  startedAt: number | null
  lastSuccessAt: number | null
  lastError: string | null
  lastErrorAt: number | null
}

interface RefreshSettings {
  version: 1
  refreshOnStartup: boolean
  perProject: Record<string, { autoRefreshOnNewChat: boolean }>
}

class RepoRefreshManager {
  // module-level singleton via `module.exports = new RepoRefreshManager()`
  triggerRefresh(gitRoot: string): Promise<RepoState>
  triggerAllEnabled(): Promise<void>
  waitForRefreshOrTimeout(gitRoot: string, timeoutMs: number): Promise<{ state: RepoState, timedOut: boolean }>
  getState(): { repos: Record<string, RepoState>, settings: RefreshSettings }
  updateSettings(partial: Partial<RefreshSettings>): RefreshSettings    // debounced 500ms save
  loadSettings(): void                                                  // sync, called from ctor
  initOnStartup(): void                                                 // async fire-and-forget
}

// Internal:
// _semaphore = { running: 0, queue: [], max: 4 }
// _inflight  = Map<gitRoot, Promise<RepoState>>
// _runFetch(gitRoot): Promise<RepoState>   // execFile('git', ['-C', gitRoot, 'fetch', '--all', '--prune'], { timeout: 60_000 })
// _truncateErr(msg): string                // ~200 chars
// _saveSettingsDebounced()                 // calls atomicWriteJson
```

**Settings path:** `path.join(os.homedir(), '.codedash', 'refresh-settings.json')`. `ensureDir` on first save (legacy code already creates `~/.codedash/`).

**BDD scenarios satisfied:**
- "Service start with refreshOnStartup=true triggers all enabled repos"
- "Fetch fails because SSH agent is not running"
- "Fetch exceeds the 60-second timeout"
- "Corrupt settings file on startup falls back to defaults"
- "Saving settings fails (disk full, permission error)"
- "Repeated trigger while a fetch is in flight is single-flight"
- "Five simultaneous triggers respect the max-concurrency of 4"
- "gitRoot path with spaces or special characters in settings file"
- "Project exists but has no remote configured" (fetch exits 0)
- "Bare repo skipped without error" (invariant — manager only acts on gitRoots provided)

**Tests (`node --test test/repo-refresh.test.js`):**
- `triggerRefresh transitions idle → fetching → idle on success` (stub `execFile`)
- `triggerRefresh single-flight: 2 concurrent calls share the same promise, 1 child process spawned`
- `semaphore caps concurrent fetches at 4; 5th queues until one finishes`
- `60s timeout: child killed (SIGTERM then SIGKILL grace), state=error with "timeout" in lastError, inflight cleared`
- `non-zero exit propagates as state=error with truncated stderr (≤200 chars)`
- `corrupt settings file → loadSettings logs warning, sets defaults, leaves file on disk untouched`
- `updateSettings round-trips through atomicWriteJson (mock the helper); debounced save`
- `gitRoot with spaces is passed as a single argv element (snapshot the execFile args)`
- `initOnStartup with refreshOnStartup=true triggers only autoRefreshOnNewChat=true repos and does not block`

**Manual verification:**
```
node -e "const m=require('./src/repo-refresh'); m.triggerRefresh(process.cwd()).then(s=>console.log(s))"
ls ~/.codedash/refresh-settings.json
```

**Size:** L

---

## Phase 3 — HTTP routes wired into `server.js`

**Type:** wiring + test

**Files:**
- `src/server.js` (mod — +4 routes)
- `test/repo-refresh-api.test.js` (new)

**Routes:**
```ts
GET  /api/repo-refresh/state
  → 200 { repos: Record<gitRoot, RepoState>, settings: RefreshSettings }

POST /api/repo-refresh/trigger
  body: { gitRoot: string }
  → 200 { status, state }
  → 404 { error, code: 'not_found' }                // unknown gitRoot (not in known projects)
  → 400 { error, code: 'invalid_payload' }          // missing gitRoot

POST /api/repo-refresh/wait
  body: { gitRoot: string, timeoutMs?: number /* default 2000, max 10_000 */ }
  → 200 { state, timedOut }

GET  /api/repo-refresh/settings  → 200 RefreshSettings
POST /api/repo-refresh/settings
  body: Partial<RefreshSettings>
  → 200 RefreshSettings
  → 400 { error, code: 'invalid_payload' }          // unknown gitRoot in perProject
  → 500 { error, code: 'write_failed' }             // atomicWriteJson threw
```

Validation: each `gitRoot` in `perProject` must be present in the set of known gitRoots (collected from `loadSessions()` + `loadProjects()` from `projects.js`).

**BDD scenarios satisfied:**
- "User clicks the Refresh button on a project card" (backend half)
- "First-ever launch — no projects discovered yet" (returns `{ repos: {}, settings: defaults }`)
- "Slow fetch shows persistent spinner without blocking other UI" (server stays responsive — relies on async execFile)
- "Saving settings fails" (500 response shape)

**Tests (`node --test test/repo-refresh-api.test.js`):**
- Spin up `http.createServer` via `startServer` on an ephemeral port, hit each route with `http.request`.
- `POST /trigger { gitRoot: <known> }` returns 200 with `status: "fetching"` immediately.
- `POST /trigger { gitRoot: <unknown> }` returns 404 + code.
- `POST /trigger { }` returns 400 + code.
- `POST /wait` returns `{ timedOut: true }` after `timeoutMs` when the fetch is mocked to never finish.
- `GET /state` returns `{ repos: {}, settings: <defaults> }` on a fresh service.
- `POST /settings` with unknown gitRoot → 400.
- `POST /settings` persists; subsequent `GET /settings` returns the saved value.

**Manual verification:**
```
curl -s http://localhost:3847/api/repo-refresh/state | jq
curl -s -X POST http://localhost:3847/api/repo-refresh/trigger \
  -H 'content-type: application/json' \
  -d '{"gitRoot":"/Users/pavelnovak/code/codbash"}' | jq
curl -s http://localhost:3847/api/sessions -w '\n%{time_total}s\n' >/dev/null
# event loop check: time_total < 0.1s while a fetch is mid-flight
```

**Size:** M

---

## Phase 4 — Startup hook in `bin/cli.js`

**Type:** wiring

**Files:**
- `bin/cli.js` (mod)

**Change:** in the `run` / `start` case, immediately after `startServer(host, port, !noBrowser);`, call:

```ts
const { repoRefreshManager } = require('../src/repo-refresh')
process.nextTick(() => repoRefreshManager.initOnStartup())
```

`initOnStartup` reads settings; if `refreshOnStartup === true`, it iterates `perProject` entries where `autoRefreshOnNewChat === true` and calls `triggerRefresh(gitRoot)` for each (semaphore caps to 4). Errors are swallowed and recorded in the per-repo `RepoState`.

**BDD scenarios satisfied:**
- "Service start with refreshOnStartup=true triggers all enabled repos" (full end-to-end)
- "Corrupt settings file on startup falls back to defaults" (no fetches launched)

**Tests:** Covered indirectly by Phase 2's `initOnStartup` test (no new file).

**Manual verification:**
```
echo '{"version":1,"refreshOnStartup":true,"perProject":{"'$PWD'":{"autoRefreshOnNewChat":true}}}' \
  > ~/.codedash/refresh-settings.json
make restart && sleep 1
curl -s localhost:3847/api/repo-refresh/state | jq '.repos'
# expect repos["<pwd>"].status to be "fetching" or "idle" with lastSuccessAt set
```

**Size:** S

---

## Phase 5 — Frontend: card UI, polling, new-chat hook

**Type:** frontend

**Files:**
- `src/frontend/app.js` (mod)
- `src/frontend/styles.css` (mod)

**Functions added (plain browser JS, no modules):**
```js
// Module-scope state
let repoRefreshState = { repos: {}, settings: { refreshOnStartup: false, perProject: {} } }
let repoRefreshLoaded = false        // gates the "loading" state from BDD
let repoRefreshPollTimer = null

async function loadRepoRefreshState()                // GET /state — called on first render
function renderRepoRefreshControls(projKey, projName) // returns HTML: toggle + refresh button + badge
function renderGlobalRefreshToggle()                 // header HTML for "Refresh on startup"
async function onClickRefresh(gitRoot)               // POST /trigger, kick polling
async function onTogglePerProject(gitRoot, checked)  // optimistic flip → POST /settings → rollback+toast on fail
async function onToggleGlobalStartup(checked)        // same pattern
function startRepoRefreshPollingIfNeeded()           // setInterval(2000) only while any visible repo === 'fetching'
function stopRepoRefreshPolling()
async function maybeRefreshBeforeLaunch(gitRoot)     // called from existing /api/launch click path:
  //   if (!autoRefresh) return;
  //   showInlineSpinner(); await trigger; await wait({timeoutMs:2000}); hideInlineSpinner();
```

Integration points in existing code:
- `renderProjects()` (around line 1248): inject controls + badge into each card; render header global toggle once.
- Existing "New chat" click handler that calls `POST /api/launch` (~ lines 2183 / 2205): wrap with `await maybeRefreshBeforeLaunch(gitRoot)` ahead of the launch fetch.
- Initial bootstrap: call `loadRepoRefreshState()` once at app init.

A11y:
- Toggle: `<input type="checkbox" role="switch" aria-checked="..." aria-label="Auto-refresh on new chat for <name>">`
- Refresh button: `aria-label="Refresh <name>"`, `<span class="visually-hidden">` for the icon.
- Status badge: `<span role="status" aria-live="polite">Fetching <name></span>` / `Updated` / `Refresh failed: <err>`.
- Focus ring on all controls (no `outline:none` without replacement).

Mobile: at `<640px`, refresh button always visible (no hover state), toggle on its own row beneath the title. Truncate long names with `text-overflow: ellipsis` + `title="<full path>"`.

**BDD scenarios satisfied:**
- "User clicks the Refresh button on a project card" (UI half)
- "New-chat click on a project with auto-refresh toggle on, fetch completes within 2s"
- "New-chat trigger times out at 2s, session opens with stale refs"
- "First page load — frontend renders before /state responds"
- "Slow fetch shows persistent spinner without blocking other UI"
- "Saving settings fails" (toast + optimistic rollback)
- "Toggling auto-refresh with keyboard only"
- "Triggering Refresh with keyboard only"
- "Screen reader announces state transitions"
- "Project with a very long name renders the card without overflow"
- "First-ever launch — no projects discovered yet" (no controls rendered)

**Tests:** No automated frontend tests in this project (zero-dep, no Playwright). Manual + screen-reader verification.

**Manual verification:**
1. Open dashboard → Projects view; confirm header toggle and per-card controls render.
2. Toggle off → controls disabled, no badge.
3. Click "↻ Refresh" → spinner appears, polling starts at 2s, transitions to "Updated just now" within ~1s for a healthy repo.
4. Disconnect network + click "↻ Refresh" → after ≤60s, red badge with truncated error; "Retry" re-triggers.
5. Enable auto-refresh + click "New chat" → spinner shows then session window opens within 2s.
6. Tab through controls — all reachable with visible focus, Space toggles, Enter triggers.
7. VoiceOver: focus the badge during a fetch → hears "Fetching <name>"; after success → "Updated".
8. Resize to 375px width → button visible, toggle on its own row, long names truncated with tooltip.

**Size:** L

---

## Phase 6 — Docs

**Type:** wiring (docs)

**Files:**
- `docs/ARCHITECTURE.md` (mod)

**Content:** new section "Repo Auto-Refresh" with:
- State machine diagram (copied from SDD)
- Endpoint table (copied from SDD § "API contract")
- Reference to `src/atomic.js` as the canonical write helper for all codbash JSON caches.

**BDD scenarios satisfied:** none directly — documentation.

**Manual verification:** read it.

**Size:** S

---

## Order of phases — rationale

| # | Phase | Why this order |
|---|-------|----------------|
| 1 | `atomic.js` + retrofit | Foundation. Pure stdlib helper with no dependents. Retrofitting now closes PR #212's deferred MEDIUM in the same PR (per D9) and exercises the helper before settings depend on it. |
| 2 | `RepoRefreshManager` core | Pure-Node logic, fully testable without HTTP or UI. Catches the hardest semantics (single-flight, semaphore, timeout, debounce) before they're wrapped in network code. |
| 3 | HTTP routes | Thin wrapper over Phase 2. Lets manual curl-driven testing validate the manager before the frontend lands. |
| 4 | Startup hook | One-liner that depends on Phase 2's `initOnStartup` being reliable; trivial after Phase 3 because we can already curl `/state` to verify. |
| 5 | Frontend | Reaches a working backend behind real endpoints; can be iterated visually without churning the backend. |
| 6 | Docs | Last, because endpoint shapes and helper names are now stable. |

Each phase is independently reviewable: 1 leaves the app functionally identical (retrofit + new helper); 2 adds dormant code; 3 makes it curl-testable; 4 wires startup; 5 ships UX; 6 documents.

---

## Risks specific to implementation (beyond SDD risk table)

| # | Risk | Mitigation at code-writing time |
|---|------|----------------------------------|
| I1 | Circular dep between `bin/cli.js` → `src/server.js` → `src/repo-refresh.js` → `src/data.js` (for `resolveGitRoot`) | `repo-refresh.js` must `require('./data')` lazily inside `getKnownGitRoots()` to avoid load-order issues, or accept `resolveGitRoot` as an injected dep. Recommend lazy `require` inside the function. |
| I2 | `atomicWriteJson` retrofit in `data.js` runs on hot paths (`_saveCostDiskCache` is called often) | Confirm `renameSync` cost is acceptable on macOS APFS / Linux ext4 (single syscall, ~1ms). If it shows up in profiling, switch to async `atomicWriteJson` for non-settings call sites. Out of scope for v1 unless tests show regression. |
| I3 | `execFile('git', ['-C', gitRoot, 'fetch', '--all', '--prune'], { timeout })` does not kill on Windows with SIGKILL | Use `{ timeout: 60_000, killSignal: 'SIGTERM' }` and a manual 2s grace `setTimeout` → `child.kill('SIGKILL')`. macOS/Linux only matters for v1; Windows degrades to SIGTERM only — acceptable. |
| I4 | Frontend polling not stopped when user leaves Projects view → wasted requests | Track `currentView` (already in app.js); in the 2s tick, exit early if `currentView !== 'projects'`. |
| I5 | Optimistic toggle rollback races with a second toggle click | Disable the input while the POST is inflight; re-enable on response. Keep last-committed value in a side map for rollback. |
| I6 | `~/.codedash/` directory does not exist on first run | `atomicWriteJson` must `mkdirSync(path.dirname(filePath), { recursive: true })` before writing the tmp file. |
| I7 | Settings file shares `~/.codedash/` with existing legacy disk caches | Per resolved Open Question 1: co-locate. New `refresh-settings.json` sits alongside `gitroot-cache-v2.json` and friends. `mkdirSync(~/.codedash, {recursive:true})` already happens via legacy code; we reuse the same dir. |
| I8 | Server already buffered JSON body parsing pattern — re-use it for the new POST routes | Audit `src/server.js` for the existing helper that reads `req` to a string and `JSON.parse`s it; re-use to keep style consistent. Do not introduce a new pattern. |
| I9 | `node --test test/wsl-windows.test.js` already fails on macOS | Pre-existing and unrelated; don't gate the PR on it. CI matrix is unaffected. |

---

## Estimated effort per phase

| Phase | Size |
|-------|------|
| 1 — `atomic.js` + retrofit + tests | S |
| 2 — `RepoRefreshManager` core + tests | L |
| 3 — HTTP routes + tests | M |
| 4 — Startup hook | S |
| 5 — Frontend (UI + polling + new-chat hook + a11y + CSS) | L |
| 6 — Docs | S |

Total: roughly two days of focused work, dominated by Phases 2 and 5.

---

## Out of scope for this plan (deferred from SDD)

- Periodic scheduler (5/10/15/30/60 min) — SDD § Out of scope.
- Page-refresh trigger from the browser — SDD § Out of scope.
- Full settings modal with extended options — SDD § Out of scope.
- "Behind by N commits" notifications when `origin/<tracking>` has moved ahead — SDD § Out of scope.
- Discovery of repos without sessions — SDD § Out of scope (a card appears only after the first session in it).
- Migration of legacy `~/.codedash/` cache file names — Phase 1 only retrofits the write path through `atomicWriteJson`; file names are unchanged.
- Windows-specific SIGKILL escalation logic — degraded to SIGTERM via Node default; acceptable for v1.
- Frontend automated tests (Playwright / jsdom) — project is zero-dep with no test runner for browser JS; manual verification only.

---

## Open questions — resolved

1. **Settings file location** → `~/.codedash/refresh-settings.json` (co-located with legacy caches). SDD's earlier mention of a separate `~/.codbash/` directory is **superseded** by this answer; both the SDD and this plan now consistently use `~/.codedash/`. Settings file lives next to the existing `_save*DiskCache` outputs — one directory for all codbash state.
2. **`maybeRefreshBeforeLaunch` on fetch failure** → open the session anyway; show a non-blocking toast `Fetch failed: <truncated err>`; the project card's red dot badge already reflects the error state. Don't block the user's primary action because of an auxiliary feature.
3. **Orphan entries in `POST /settings`** → accept silently. On every `initOnStartup`, sweep `perProject` keys: any key for which `!fs.existsSync(gitRoot) || resolveGitRoot(gitRoot) === ''` is dropped, then `atomicWriteJson` persists the cleaned settings. This means a user who renames or deletes a project keeps the toggle history if they recreate the path at the same location.
