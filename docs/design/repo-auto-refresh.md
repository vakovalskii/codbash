# Repo Auto-Refresh (v1)

## Goal

Keep local clones of connected repositories in sync with their remotes so that when a session starts, the LLM works against current history and doesn't drift into branch divergence. Done in the background, without blocking the UI, without touching the working tree.

## Context

Codbash shows "projects" = git roots bound to a remote. Sessions are created by Claude/Codex/etc. inside these repos. When the remote moves forward (PR merged on GitHub), the local clone doesn't know until the user runs `git fetch` manually. The result:
- A new session sees a stale `git log` / `origin/main`.
- Branches created from `origin/main` start from an outdated base.
- Continuing an old session can produce commits on top of stale state.

## In scope (v1 — minimum useful core)

1. **Per-project toggle** "Auto-refresh on new chat" in the Projects view.
2. **Manual "Refresh" button** on the project card — fetch now.
3. **Global toggle** "Refresh enabled repos on service start" (default off).
4. Background worker on the backend running `git fetch --all --prune`.
5. **Triggers**:
   - Manual refresh button click → fetch this repo.
   - New-chat click on a project with the toggle on → fetch + wait up to 2s before opening the session.
   - Service start → fetch all enabled repos if the global toggle is on.
6. **Status indicator** on the card: idle / fetching (spinner) / error (red dot + tooltip) / last-success timestamp.

## Out of scope (deferred to v2)

- Periodic scheduler (5/10/15/30/60 min).
- Page-refresh trigger from the browser.
- Full settings modal with extended options.
- Notifications when `origin/<tracking>` has moved ahead.
- Discovery of repos that have no existing sessions — a project shows up only after the first session in it.

## Never in scope

- `git pull`, `merge`, `rebase` — fetch only. Working tree is never touched.
- `push` to the remote.
- Branch management.
- Authentication — private repos via SSH agent already work; we don't add new credential flows.

## Decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | `git fetch --all --prune` | Safe — doesn't touch the working tree. User decides when to merge. |
| D2 | Persistence: backend file `~/.codedash/refresh-settings.json` only (atomic write). Frontend reads via API on every load. | Single source of truth, no sync logic. Cost: one extra API call on page load. |
| D3 | New-chat trigger: wait for fetch up to 2 s (with UI indicator), then open the session | Half of the value is the LLM seeing fresh refs in its first turn. 2 s balances "fresh" vs "responsive". |
| D4 | Subtle inline spinner instead of modal-style warning banner | Fetch can't diverge the working copy (see R3). A banner would frighten the user without cause. |
| D5 | Max concurrency = 4 parallel fetches | Doesn't hammer the system, doesn't block the event loop. |
| D6 | Single-flight per gitRoot | A second trigger while a fetch is running returns the existing promise. Simple semantics. |
| D7 | Per-fetch timeout = 60 s | Covers slow remotes/networks. Kill subprocess on timeout → state=error. |
| D8 | Frontend polling = 2 s, only while at least one visible repo is `fetching` | Zero-dep, acceptable latency. Otherwise 0 requests. |
| D9 | `atomicWriteJson(path, obj)` shared helper. Used for new settings **and** retrofitted into existing disk caches (`codedash-gitroot-cache-v2.json` and other `_save*DiskCache` callers) | Closes the deferred MEDIUM from PR #212. Adds ~15 LoC to scope, saves a separate PR. |

## Architecture

### Backend

#### New module `src/repo-refresh.js`

```
RepoRefreshManager (singleton)
  state: Map<gitRoot, RepoState>
  settings: RefreshSettings
  inflight: Map<gitRoot, Promise<RepoState>>
  semaphore: { running, queue, max: 4 }

  triggerRefresh(gitRoot): Promise<RepoState>
  triggerAllEnabled(): Promise<void>
  waitForRefreshOrTimeout(gitRoot, timeoutMs): Promise<RepoState>
  getState(): { repos, settings }
  updateSettings(partial): RefreshSettings
  loadSettings(): void
  initOnStartup(): void
```

#### Per-repo state machine

```
       ┌───────────┐
       │   idle    │ (lastSuccessAt: null | epoch)
       └─────┬─────┘
             │ trigger()
             ▼
       ┌───────────┐
       │ fetching  │ (startedAt: epoch; single-flight)
       └─┬───────┬─┘
  ok     │       │   error / timeout
         ▼       ▼
       ┌───────┐ ┌────────┐
       │ idle  │ │ error  │ (lastError, lastErrorAt)
       └───────┘ └────────┘
```

#### Concurrency

- `child_process.execFile` (async) with `timeout: 60_000`.
- Semaphore: max 4 in flight. The 5th call queues.
- Single-flight: if `inflight.has(gitRoot)`, return the existing promise.
- The main thread is never blocked — fetches run in a child process via libuv.

#### Shared helper in `src/atomic.js` (new)

```
atomicWriteJson(filePath, obj): void
  // Write to <path>.tmp, fsync, rename to <path>. Throws on failure.
```

Used by `_saveGitRootDiskCache`, any other `_save*DiskCache` callers, and the new `RepoRefreshManager.saveSettings`.

### Frontend (`src/frontend/app.js` + `styles.css`)

- On each project card:
  - Inline spinner badge when `status === 'fetching'`.
  - Red dot + tooltip when `status === 'error'`.
  - Subtle check-mark + relative time when `lastSuccessAt` is set.
  - "↻ Refresh" button (visible on hover, focusable).
  - Per-project toggle "Auto-refresh on new chat".
- In the Projects view header: global toggle "Refresh on startup".
- Polling: `setInterval(2000)` while any visible repo is `fetching`. Cleared otherwise.
- New-chat click handler:
  ```
  if (project.autoRefresh) {
    showInlineSpinner(project)
    await fetch('/api/repo-refresh/trigger', { gitRoot })
    await waitForIdleOrTimeout(gitRoot, 2000)
    hideInlineSpinner(project)
  }
  openSession(...)
  ```

### Persistence

`~/.codedash/refresh-settings.json`:

```json
{
  "version": 1,
  "refreshOnStartup": false,
  "perProject": {
    "/Users/pavelnovak/code/codbash": { "autoRefreshOnNewChat": true },
    "/Users/pavelnovak/code/Flow-Universe": { "autoRefreshOnNewChat": false }
  }
}
```

- Corrupt JSON → warning log, defaults (everything off).
- Writes go through `atomicWriteJson` (tmp + fsync + rename).
- Debounced 500 ms — settings change frequently when the user clicks toggles.

## API contract

### GET /api/repo-refresh/state

```typescript
interface RepoState {
  status: 'idle' | 'fetching' | 'error';
  startedAt: number | null;        // epoch ms
  lastSuccessAt: number | null;
  lastError: string | null;        // truncated message
  lastErrorAt: number | null;
}

interface StateResponse {
  repos: Record<string /* gitRoot */, RepoState>;
  settings: RefreshSettings;
}
```

### POST /api/repo-refresh/trigger

```typescript
// request
{ gitRoot: string }

// response (immediate)
{ status: 'fetching' | 'idle' | 'error', state: RepoState }
```

Unknown `gitRoot` → 404. Already `fetching` → returns the current state without starting a second process.

### POST /api/repo-refresh/wait

```typescript
// request
{ gitRoot: string, timeoutMs?: number /* default 2000 */ }

// response (returns when fetch finishes or timeout)
{ state: RepoState, timedOut: boolean }
```

Long-poll style. Convenient for the new-chat handler on the frontend.

### GET /api/repo-refresh/settings, POST /api/repo-refresh/settings

```typescript
interface RefreshSettings {
  refreshOnStartup: boolean;
  perProject: Record<string /* gitRoot */, { autoRefreshOnNewChat: boolean }>;
}
```

POST accepts a partial, merges, validates (every gitRoot must resolve via `resolveGitRoot`), saves.

### Error format

```typescript
{ error: string, code?: 'not_found' | 'invalid_payload' | 'git_unavailable' }
```

## Component map

| File | Change |
|------|--------|
| `src/repo-refresh.js` | **new** — manager + fetch worker + settings I/O |
| `src/atomic.js` | **new** — `atomicWriteJson` helper |
| `src/data.js` | replace direct `writeFileSync` in `_saveGitRootDiskCache` (and any other `_save*DiskCache`) with `atomicWriteJson` |
| `src/server.js` | +4 routes under `/api/repo-refresh/*` |
| `bin/cli.js` | call `RepoRefreshManager.initOnStartup()` after the server boots |
| `src/frontend/app.js` | UI: toggle, spinner, refresh button, polling, new-chat hook |
| `src/frontend/styles.css` | status styles |
| `docs/ARCHITECTURE.md` | new section "Repo Auto-Refresh" |

## Touchpoints with existing code

- `resolveGitRoot(projectPath)` (from PR #212) → Map key.
- `getProjectGitInfo` → remote URL for the UI.
- New-chat button — wrap `POST /api/launch` in a helper `maybeRefreshBeforeLaunch(gitRoot)`.

## Risks

| # | Risk | Mitigation |
|---|------|------------|
| R1 | Slow fetch (slow remote, large repo) | 60 s timeout, max-concurrency 4, fire-and-forget in UI with a 2 s wait for new-chat |
| R2 | SSH agent not running | state=error, badge with tooltip, user sees what's wrong |
| R3 | Divergence during active fetch + concurrent user work | `fetch` doesn't touch the working tree → impossible. Divergence only happens on a subsequent `merge`/`rebase` — that's the user's responsibility. |
| R4 | Memory leak in `inflight` Map | `try/finally` always clears the entry |
| R5 | `atomicWriteJson` breaks existing cache files during retrofit | Tests on rename semantics + smoke test that the cache is readable after write/restart |
| R6 | 2 s wait on new-chat feels slow | Spinner + "Updating…" text gives visible feedback. If fetch completes in <100 ms, the session opens immediately. |

## UX & Accessibility

**Target WCAG level**: AA.

**Affected surfaces**:
1. Projects view — project card with status indicator, refresh button, per-project toggle.
2. Projects view header — global "Refresh on startup" toggle.

### Required UI states (per project card)

- [x] **Loading** — until the first `GET /state` returns: toggle disabled+dim, refresh button hidden.
- [x] **Empty** — N/A (a card appears only when a git root + sessions exist).
- [x] **Error** — `status === 'error'`. Red dot badge, tooltip `Last fetch failed: <error>`. "Retry" button (= same `/trigger` endpoint).
- [x] **Success/Confirmation** — `lastSuccessAt` set, `status === 'idle'`. Subtle check-mark with relative time `Updated 2 min ago`. No toast — we don't distract.
- [x] **Disabled** — toggle off. No status badges, clean card.
- [x] **Partial/Stale** — N/A in v1 (no scheduler → no "expected interval" concept).
- [x] **Optimistic/Pending** — clicking a toggle flips the visual immediately; rollback if POST fails + toast "Failed to save setting".

### Inline spinner while fetching

- `role="status"` + `aria-live="polite"` — screen reader announces `Fetching <project name>` → `Updated`.
- Visible spinner + "Updating…" text near the name.
- Doesn't block card clicks; the session can still be opened.

### Keyboard

- Per-project toggle: Tab → focus → Space toggles. `aria-checked`.
- Refresh button: Tab → focus → Enter triggers. `aria-label="Refresh <project name>"`.
- Visible focus ring on every control (never strip `outline:none` without a replacement).
- Header global toggle — same behavior.

### Screen reader

- Toggle: `<input type="checkbox">` paired with a `<label>` reading `Auto-refresh on new chat for <project>`.
- Status badge: `role="status"`, `aria-live="polite"`. Announces transitions `idle → fetching → idle/error`.
- Error tooltip: `aria-describedby` from the badge icon.

### Touch targets

- Toggle and refresh button: hit area at least 44×44 even when the visual is smaller.

### Responsive

- Mobile (<640 px): refresh button always visible (no hover state), status badge more compact.
- Toggle moves below the project name.

### Performance budget

- `POST /trigger` responds in <100 ms (enqueue only).
- `GET /state` <50 ms (in-memory read).
- `POST /wait` responds when the fetch finishes or after `timeoutMs` — the client knows what to expect.
- Polling overhead: 1 req/2 s while a visible fetch is running, otherwise 0.

## Acceptance criteria

- [ ] Per-project toggle survives browser sessions and service restarts.
- [ ] When the service starts with `refreshOnStartup: true`, every enabled repo begins fetching within 1 s.
- [ ] Clicking the "Refresh" button starts a fetch; status flips to `fetching`.
- [ ] Clicking "new chat" on a project with the toggle on: spinner shows → fetch (or 2 s timeout) → session opens.
- [ ] `curl /api/sessions` during an active fetch responds in <100 ms (event loop is not blocked).
- [ ] Max 4 parallel fetches.
- [ ] Fetch timeout 60 s; on timeout the subprocess is killed and state=error.
- [ ] Corrupt settings file → start with defaults + warning log.
- [ ] Settings are written atomically via `atomicWriteJson` (tmp + rename).
- [ ] Existing cache files are migrated to `atomicWriteJson`.
- [ ] Every UI state in the checklist is implemented.
- [ ] Keyboard navigation works for every control.
- [ ] Screen reader correctly announces state transitions.
