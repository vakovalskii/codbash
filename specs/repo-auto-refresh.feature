Feature: Repo Auto-Refresh
  As a codbash user with many connected repositories
  I want background `git fetch` for selected repos before I start working
  So that my AI sessions see current `origin/<branch>` and I don't drift into divergence

  Background:
    Given codbash is running with at least one connected project at "/repos/myproj"
    And "/repos/myproj" has a working `origin` remote
    And the refresh-settings file is fresh (defaults: refreshOnStartup=false, no per-project entries)

  # ─────────────────────────────────────────────────────────────────────
  # 1. HAPPY PATH
  # ─────────────────────────────────────────────────────────────────────

  Scenario: User clicks the Refresh button on a project card
    Given the project card for "/repos/myproj" is rendered with status "idle"
    When the user clicks the "↻ Refresh" button on that card
    Then the backend receives POST /api/repo-refresh/trigger with gitRoot="/repos/myproj"
    And the response returns immediately with status="fetching"
    And the card shows the inline spinner with text "Updating…"
    And `git fetch --all --prune` is launched as a child process for "/repos/myproj"
    And when the fetch completes the card shows "Updated just now"
    And subsequent GET /state returns status="idle" with lastSuccessAt set

  Scenario: New-chat click on a project with auto-refresh toggle on, fetch completes within 2s
    Given the project at "/repos/myproj" has perProject.autoRefreshOnNewChat=true
    And the next `git fetch` will complete in ~500 ms
    When the user clicks "New chat" on that project card
    Then the inline spinner shows on the card
    And POST /api/repo-refresh/trigger fires with gitRoot="/repos/myproj"
    And the frontend calls POST /api/repo-refresh/wait with timeoutMs=2000
    And when fetch completes (~500 ms later) /wait returns { timedOut: false }
    And the session is launched after fetch finishes
    And the spinner is hidden before the session window opens

  Scenario: Service start with refreshOnStartup=true triggers all enabled repos
    Given settings has refreshOnStartup=true
    And perProject has autoRefreshOnNewChat=true for "/repos/a" and "/repos/b"
    And perProject has autoRefreshOnNewChat=false for "/repos/c"
    When the codbash service is started
    Then within 1 second `git fetch` is launched for "/repos/a" and "/repos/b"
    And `git fetch` is NOT launched for "/repos/c"
    And the HTTP server is accepting connections during these background fetches

  # ─────────────────────────────────────────────────────────────────────
  # 2. EMPTY STATE
  # ─────────────────────────────────────────────────────────────────────

  Scenario: First-ever launch — no projects discovered yet
    Given codbash is launched on a clean machine with no AI sessions ever recorded
    When the user opens the Projects view
    Then the view shows the existing empty-state explanation
    And no repo-refresh UI is rendered (no toggles, no spinners, no refresh button)
    And GET /api/repo-refresh/state returns { repos: {}, settings: <defaults> }

  Scenario: Project exists but has no remote configured
    Given a project at "/repos/local-only" with `.git` but no `origin` remote
    When the user clicks the "↻ Refresh" button for it
    Then `git fetch --all --prune` runs and exits cleanly (no remotes to fetch from)
    And status returns to "idle"
    And no error is shown — fetching with zero remotes is not an error

  # ─────────────────────────────────────────────────────────────────────
  # 3. LOADING STATE
  # ─────────────────────────────────────────────────────────────────────

  Scenario: First page load — frontend renders before /state responds
    Given the user opens the dashboard for the first time this session
    When the page is rendering and GET /api/repo-refresh/state has not yet returned
    Then per-project toggles are disabled and dim
    And the "↻ Refresh" button is hidden
    And no spinner is shown (we don't know fetch state yet)
    And once /state returns within 200 ms the controls become interactive

  Scenario: Slow fetch shows persistent spinner without blocking other UI
    Given the user clicked Refresh on "/repos/myproj"
    And `git fetch` is taking ~10 seconds (slow remote)
    Then the card spinner stays visible for the full duration
    And the user can scroll, click other cards, and open unrelated sessions
    And GET /api/sessions during this fetch responds in under 100 ms
    And POST /api/repo-refresh/trigger for a different repo is accepted in parallel

  # ─────────────────────────────────────────────────────────────────────
  # 4. ERROR STATE
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Fetch fails because SSH agent is not running
    Given the project at "/repos/private-repo" requires SSH auth
    And no SSH agent is available in the codbash process environment
    When the user clicks Refresh
    Then `git fetch` exits with a non-zero status
    And the backend stores status="error" with lastError containing "Permission denied" (truncated to ~200 chars)
    And the card shows a red dot badge with a tooltip showing the error
    And the card shows a "Retry" affordance (re-triggers the same endpoint)
    And clicking Retry transitions status back to "fetching"

  Scenario: Fetch exceeds the 60-second timeout
    Given `git fetch` for "/repos/myproj" is hanging (unreachable remote)
    When 60 seconds elapse since the fetch started
    Then the child process is terminated (SIGTERM, then SIGKILL after 2s grace)
    And status becomes "error" with lastError mentioning "timeout"
    And the inflight Map no longer contains "/repos/myproj"
    And a subsequent trigger starts a fresh fetch (not stuck)

  Scenario: Corrupt settings file on startup falls back to defaults
    Given ~/.codedash/refresh-settings.json contains invalid JSON ("{ not json")
    When the codbash service is started
    Then a warning is logged ("Failed to parse refresh settings, using defaults")
    And the service starts successfully with settings = defaults (refreshOnStartup=false, perProject={})
    And no startup fetches are triggered
    And the file is left untouched (we don't auto-overwrite — user may want to recover)

  Scenario: Saving settings fails (disk full, permission error)
    Given the user toggles autoRefreshOnNewChat for "/repos/myproj"
    And the atomic write fails (e.g., EACCES on the tmp file)
    Then POST /api/repo-refresh/settings returns 500 with { error: "...", code: "..." }
    And the frontend shows a toast "Failed to save setting"
    And the toggle visual reverts to its previous state (optimistic rollback)

  # ─────────────────────────────────────────────────────────────────────
  # 5. KEYBOARD-ONLY NAVIGATION
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Toggling auto-refresh with keyboard only
    Given the Projects view is open
    When the user presses Tab repeatedly until focus lands on the auto-refresh toggle for "/repos/myproj"
    Then the toggle has a visible focus ring
    And the toggle announces "Auto-refresh on new chat for myproj, not checked" to screen readers
    When the user presses Space
    Then the toggle flips to checked
    And aria-checked becomes "true"
    And POST /api/repo-refresh/settings is sent with the updated value

  Scenario: Triggering Refresh with keyboard only
    Given focus is on the project card for "/repos/myproj"
    When the user presses Tab to reach the "↻ Refresh" button
    Then the button has aria-label="Refresh myproj" and a visible focus ring
    When the user presses Enter
    Then the trigger fires (same flow as a mouse click)
    And focus stays on the button (does not jump)

  Scenario: Screen reader announces state transitions
    Given the user has focus on the project card for "/repos/myproj"
    When a fetch transitions from idle to fetching
    Then the status badge (role="status", aria-live="polite") announces "Fetching myproj"
    When the fetch completes successfully
    Then it announces "Updated"
    When the fetch fails
    Then it announces "Refresh failed: <error message>"

  # ─────────────────────────────────────────────────────────────────────
  # 6. EDGE DATA / CONCURRENCY
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Repeated trigger while a fetch is in flight is single-flight
    Given a fetch for "/repos/myproj" is in progress (state="fetching")
    When the user clicks Refresh again
    Then no new child process is spawned
    And POST /trigger returns the existing { status: "fetching", state: <same startedAt> }
    And the same applies to a concurrent new-chat trigger for the same repo

  Scenario: Five simultaneous triggers respect the max-concurrency of 4
    Given there are 5 enabled repos with no active fetches
    When the service starts with refreshOnStartup=true
    Then exactly 4 `git fetch` processes are running concurrently
    And the 5th is queued and starts when any of the first 4 finishes
    And the inflight Map at any moment contains at most 4 entries actively executing

  Scenario: Project with a very long name renders the card without overflow
    Given a project gitRoot with a 200-character path and a 100-character basename
    When the card is rendered
    Then the project name truncates with ellipsis at the card width
    And the refresh button, status badge, and toggle remain reachable and clickable
    And the tooltip on the truncated name shows the full path

  Scenario: gitRoot path with spaces or special characters in settings file
    Given a project at "/repos/My Project (legacy)" with auto-refresh enabled
    When POST /api/repo-refresh/settings persists this entry
    Then the JSON file contains the exact string "/repos/My Project (legacy)" (not URL-encoded, not escaped beyond JSON rules)
    And on next service start the entry round-trips correctly
    And `git fetch -C "/repos/My Project (legacy)" --all --prune` is invoked as a single argv element (no shell-splitting)

  Scenario: New-chat trigger times out at 2s, session opens with stale refs
    Given the project at "/repos/myproj" has autoRefreshOnNewChat=true
    And the next `git fetch` will take ~5 seconds (slow remote)
    When the user clicks "New chat"
    Then the spinner shows for 2 seconds
    And POST /wait returns { timedOut: true } at 2s
    And the session opens with whatever refs are currently on disk
    And the fetch continues in the background — when it finishes the card updates to "Updated just now"

  Scenario: Bare repo skipped without error
    Given a project gitRoot resolved earlier that happens to be a bare repo "/repos/origin.git"
    When refresh is triggered for it
    # Note: resolveGitRoot already returns "" for bare repos (PR #212) — so the gitRoot
    # never appears in the projects list. This scenario is here to lock that invariant.
    Then no /trigger request is ever sent for "/repos/origin.git" from a normal UI flow

  # ─────────────────────────────────────────────────────────────────────
  # CROSS-CUTTING — ATOMIC SETTINGS WRITE (D9 retrofit)
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Settings write is atomic — crash mid-write leaves the file consistent
    Given the user is rapidly toggling auto-refresh on multiple projects
    And the process is killed (SIGKILL) during a debounced settings save
    When the service starts again
    Then refresh-settings.json is either fully the previous version or fully the new version
    And it never contains partial JSON
    And ~/.codedash/refresh-settings.json.tmp is cleaned up or ignored

  Scenario: Existing git-root cache file uses the same atomic write helper
    Given a fresh service start with no cache file
    When `resolveGitRoot` populates and saves the on-disk cache
    Then the write goes through atomicWriteJson (tmp + rename)
    And the file is valid JSON after every persisted write
    And the prior bug (truncated file on crash) cannot occur
