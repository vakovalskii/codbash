# Projects Tab Restructure — design

## Goal

Reshape the Projects view from a single mixed surface (folders + sessions + launchers)
into two clearly separated sub-pages, and add explicit agent selection (default + per-launch).

```
Projects (top-level sidebar item)
├── Projects   (default subtab) — registered project launchers
│                  cards: name + git url + ▶ New / ⟳ Last / ⏷ picker
│                  toolbar: + Add Project · ⚙ Settings (default agent)
│
└── History    (subtab)         — everything Projects shows today
                   group-by-project session list, drawer on click,
                   collapse/expand, "Open >" filter. No behavior change.
```

## Why

Today the Projects tab does three jobs at once:

1. show every folder that has ever held a Claude/Cursor/Codex session,
2. list those sessions grouped under the folder,
3. host the launcher buttons (`▶ New`, `⟳ Last`) we shipped in #210.

Adding agent picker + default-agent settings on top would push the surface
past usability. Splitting into `Projects` (a registry) and `History`
(observation) keeps each surface single-purpose.

## Non-goals

- No change to session loading, search index, drawer, or any current History behavior.
- No change to the existing `/api/launch`, `/api/projects/*`, `/api/github/*` contracts beyond additive fields.
- No removal of the GitHub OAuth or dual-token model from #210.
- No new agents supported. We work with the 7 already in `terminals.js`.

## Data inventory

What we touch today:

| Source | Path | Role | Change |
|---|---|---|---|
| projects.json | `~/.codedash/projects.json` | manual registry of folders | unchanged (additive only via #210 flow) |
| github-profile.json | `~/.codedash/github-profile.json` | OAuth tokens (read:user, repo) | unchanged |
| sessions index | various agent storage | renders History | unchanged |

What we add:

| Source | Path | Role |
|---|---|---|
| settings.json | `~/.codedash/settings.json` | UI-level settings (default agent, picker prefs) |

Auto-register on first launch reads `projects.json` only — no separate state.

## Component map

### Producer (server)

| File | Change |
|---|---|
| `src/settings.js` (new) | atomic 0600 read/write, single-key `defaultAgent`, mutex-serialized like `projects.js` |
| `src/agents-detect.js` (new) | probe PATH + macOS app bundle paths for the 7 known agent binaries; result cached for server lifetime, refresh endpoint exposed |
| `src/server.js` | 4 new routes: `GET /api/settings`, `PUT /api/settings`, `GET /api/agents/installed`, `POST /api/agents/refresh-detect`. `POST /api/launch` gains optional implicit auto-register when `mode:'fresh'` is given an unknown registered path |
| `src/terminals.js` | unchanged (already handles fresh-mode + tool switch) |
| `src/projects.js` | unchanged |

### Consumer (frontend)

| File | Change |
|---|---|
| `src/frontend/index.html` | extend `data-view="projects"` content to render a subtab strip; reuse Add Project modal; add Settings modal markup |
| `src/frontend/app.js` | `currentProjectsSubtab` state ('projects' \| 'history'); two new render fns `renderProjectsLanding` and existing `renderProjects` re-aliased into `renderProjectsHistory`; `agentPicker(projectPath, anchorEl)` popover; `openSettings()` modal; deeplink `?projectFilter=<path>` switches to History with filter applied |
| `src/frontend/styles.css` | subtab strip styles, picker popover, settings modal, split-button on cards |

### Wiring

- App load: fetch `/api/agents/installed`, fetch `/api/settings` → store in `window.codbashSettings`. Both endpoints idempotent and read-only at boot.
- `▶ New` click priority: `lastUsedToolForProject(path)` → `settings.defaultAgent` → first detected → error toast.
- `⏷` click: build popover from `installed` list, click = one-shot launch with that tool, no settings mutation.
- Settings modal save: PUT `/api/settings` body `{ defaultAgent: 'claude' | ... }`; server validates against allow-list = currently detected agents (so the user cannot save an uninstalled default).
- Auto-register: on successful `/api/launch` with `mode:'fresh'`, if `projectDir` matches no project in registry, server adds it with `source:'auto'`. Returns the new project entry. Front shows a toast "Added <name> to Projects". A new `'auto'` value is appended to `ALLOWED_SOURCES`.

## API contracts (additive only)

```ts
// GET /api/settings
type SettingsResponse = {
  defaultAgent: 'claude' | 'codex' | 'cursor' | 'qwen' | 'kilo' | 'kiro' | 'opencode' | 'copilot' | 'copilot-chat' | null;
};

// PUT /api/settings
type SettingsRequest = { defaultAgent: SettingsResponse['defaultAgent'] };
// Returns 400 if defaultAgent is not in current /api/agents/installed.

// GET /api/agents/installed
type InstalledAgent = {
  id: 'claude' | 'codex' | 'cursor' | 'qwen' | 'kilo' | 'kiro' | 'opencode' | 'copilot' | 'copilot-chat';
  label: string;            // human-readable
  detectedVia: 'path' | 'app-bundle';
  binPath?: string;         // if detectedVia === 'path'
};
type InstalledResponse = { agents: InstalledAgent[]; refreshedAt: string };

// POST /api/agents/refresh-detect → re-runs detection, returns same shape

// POST /api/launch (existing) — additive fields:
type LaunchRequest = {
  project: string;
  tool: 'claude' | /* ... */ ;
  mode?: 'fresh' | 'resume';
  sessionId?: string;
  flags?: string[];
  terminal?: string;
  autoRegister?: boolean;   // NEW, default true; when true, fresh-launch in unknown path → addProject
};
type LaunchResponse = {
  ok: boolean;
  registered?: { id: string; name: string; path: string; source: 'auto' };  // NEW
  error?: string;
};
```

All error responses use the existing `{ error: string }` shape with `Content-Type: application/json`. No envelope change.

## Frontend state machine

```
                              user clicks Projects sidebar
                                          │
                                          ▼
                              ┌──────────────────────┐
                              │  subtab = projects   │  (default)
                              └──────────────────────┘
                                          │
                ┌─────────────────────────┼─────────────────────────┐
                ▼                         ▼                         ▼
        click "History" tab      click ▶ New / ⏷            click "View sessions →"
                │                         │                         │
                │                         │                         │
                ▼                         ▼                         ▼
        subtab = history          POST /api/launch          subtab = history,
        render group list,        terminal opens,           gitProjectFilter = path,
        full Projects-today       (auto-register toast      scroll into view
        behavior preserved        if applicable)
                │
                ▼
        click session → drawer (unchanged)
```

Subtab state lives in `window.currentProjectsSubtab`. Persisted to localStorage key `codedash-projects-subtab` so the user returns to the same view across reloads.

## Filesystem layout

```
~/.codedash/
├── projects.json        (existing)
├── github-profile.json  (existing — mode 0600)
└── settings.json        (NEW — mode 0600)
       { "defaultAgent": "claude", "lastUsedByPath": { "<absPath>": "claude" } }
```

`lastUsedByPath` is written by the server when a launch succeeds, so the
"last used for this project" preference survives across sessions even if
the agent's own session storage is wiped.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Subtab introduces a back/forward inconsistency — user expects browser back to flip subtabs | Reflect subtab in `location.hash` (`#projects` / `#history`), wire `hashchange` to update state |
| Auto-register could pollute the registry when user starts ad-hoc sessions in `/tmp` | Only auto-register when `projectDir` is under `$HOME` and is a git repo or has been launched ≥2 times |
| Default agent setting drifts if the binary is uninstalled later | On boot, if `settings.defaultAgent` is not in `installed`, fall back to first installed and silently null the stored value next save |
| Agent detection latency on slow disks | Cache result; only re-detect on explicit refresh or server restart |
| macOS app-bundle detection (`/Applications/Cursor.app`) doesn't mean CLI is on PATH | Distinguish `detectedVia: 'app-bundle'`. For these, launch falls back to `open -a "Cursor"` instead of CLI command — out of scope for this PR; we mark them installed but the launch handler is left to a follow-up. Document in `impl-notes.md` |
| Settings file race with rapid PUTs | Use the same mutex pattern as `projects.js` / `updateGitHubProfile` |

## Test surface

Each scenario from `specs/projects-tab-restructure.feature` becomes a failing test before implementation:

1. Landing renders zero-state when registry is empty.
2. Landing renders cards from `projects.json` with `▶ New` enabled only when ≥1 detected agent.
3. Clicking `▶ New` with no `lastUsed` and `defaultAgent=null` falls back to first installed.
4. Clicking `⏷` opens picker with only installed agents.
5. Picker click launches with that specific tool, does not mutate `defaultAgent`.
6. Settings PUT with uninstalled agent → 400.
7. Auto-register fires when launching from a path not in registry; toast surfaced.
8. `#history` deeplink with query param filter renders only that project's sessions.
9. Tokens never appear in `/api/settings` or `/api/agents/installed` response bodies.

## Migration & rollback

- New files only: `src/settings.js`, `src/agents-detect.js`, `specs/projects-tab-restructure.feature`, `docs/design/projects-tab-restructure.md`.
- Existing files modified additively: `src/server.js`, `src/frontend/{index.html,app.js,styles.css}`, `src/projects.js` (just `ALLOWED_SOURCES` enum extension).
- Rollback = `git revert` of the merge commit; `settings.json` becomes orphaned in `~/.codedash/` but causes no harm (server tolerates its absence).

## Out of scope

- App-bundle launch handler (open -a for Cursor.app etc.) — flagged for a follow-up PR.
- Per-project default agent override (only global default is configurable now).
- Schedule-on-launch / templated launch (env vars, flags) — future work.
- Windows-native detection (we cover macOS, Linux, WSL).
