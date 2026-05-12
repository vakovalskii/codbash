Feature: Projects tab restructure with launcher landing + History subtab

  Background:
    Given codbash is running locally on http://localhost:8765
    And the registry file at ~/.codedash/projects.json exists
    And the settings file at ~/.codedash/settings.json may or may not exist

  # ─── Subtab navigation ────────────────────────────────────────

  Scenario: Default landing on Projects subtab (happy)
    Given the user has 2 registered projects
    When the user clicks "Projects" in the sidebar
    Then the URL hash becomes "#projects"
    And the subtab strip shows "Projects" active and "History" inactive
    And the page renders 2 launcher cards
    And the page does NOT render grouped session lists

  Scenario: Switch to History subtab preserves all today's behavior (happy)
    Given the user is on Projects subtab
    When the user clicks the "History" subtab
    Then the URL hash becomes "#history"
    And the page renders the same grouped-by-project session list that the
        current Projects view renders today, with no behavioral change
    And clicking any session opens the existing detail drawer
    And the collapse/expand buttons still work

  Scenario: Subtab choice persists across reload (edge)
    Given the user is on the History subtab
    When the user reloads the page
    Then the History subtab is still active
    And localStorage key "codedash-projects-subtab" equals "history"

  Scenario: Deeplink from a launcher card to History filtered (happy)
    Given the user is on Projects subtab
    And the user has a registered project at "/Users/me/code/flow-tasks"
    When the user clicks "View sessions →" on that card
    Then the active subtab becomes History
    And the History view is filtered to project path "/Users/me/code/flow-tasks"
    And the URL hash includes both "history" and the filter

  # ─── Launcher landing — default agent flow ────────────────────

  Scenario: ▶ New uses last-used tool for that project (happy)
    Given the user has launched flow-tasks with Claude Code previously
    And settings.defaultAgent is "cursor"
    When the user clicks "▶ New" on the flow-tasks card
    Then /api/launch is POSTed with tool="claude" and mode="fresh"
    And the terminal opens a Claude Code session
    # last-used wins over default

  Scenario: ▶ New falls back to default when no last-used (happy)
    Given the user has never launched a session for "my-project"
    And settings.defaultAgent is "cursor"
    When the user clicks "▶ New" on the my-project card
    Then /api/launch is POSTed with tool="cursor" and mode="fresh"

  Scenario: ▶ New falls back to first installed when no last-used and no default (edge)
    Given the user has never launched a session for "my-project"
    And settings.defaultAgent is null
    And the installed-agents list returns ["claude", "codex"] in that order
    When the user clicks "▶ New"
    Then /api/launch is POSTed with tool="claude"

  Scenario: ▶ New fails gracefully when no agents are installed (negative)
    Given the installed-agents list is empty
    When the user clicks "▶ New" on any card
    Then no /api/launch request is sent
    And a toast appears with text containing "No agent installed"
    And a link "Install agents →" points to the sidebar Install Agents section

  # ─── Per-launch override picker ───────────────────────────────

  Scenario: ⏷ picker shows only installed agents (happy)
    Given the installed-agents list is ["claude", "cursor"]
    When the user clicks "⏷" next to "▶ New" on a project card
    Then a popover opens with exactly 2 items: "Claude Code" and "Cursor"
    And no other agent ids appear in the popover DOM

  Scenario: Picker launch does not mutate default (happy)
    Given settings.defaultAgent is "claude"
    When the user clicks "⏷" and selects "Cursor"
    Then /api/launch is POSTed with tool="cursor"
    And /api/settings is NOT called
    And settings.defaultAgent remains "claude" after reload

  Scenario: Picker dismisses on outside click (edge)
    Given the picker popover is open
    When the user clicks anywhere outside the popover
    Then the popover closes without launching anything

  # ─── Settings modal ───────────────────────────────────────────

  Scenario: Settings modal lists installed agents only (happy)
    Given the installed-agents list is ["claude", "codex", "cursor"]
    When the user clicks the "⚙ Settings" button in the Projects toolbar
    Then the Settings modal opens
    And the "Default agent" select offers exactly: (none), Claude Code, Codex, Cursor

  Scenario: Save default agent persists (happy)
    Given the Settings modal is open
    When the user selects "Cursor" and clicks Save
    Then PUT /api/settings is called with {"defaultAgent":"cursor"}
    And the response is 200
    And ~/.codedash/settings.json contains "defaultAgent": "cursor"
    And the file mode is 0600

  Scenario: Cannot save an uninstalled agent as default (negative)
    Given the installed-agents list is ["claude"]
    When a client PUTs /api/settings with {"defaultAgent":"cursor"}
    Then the response is HTTP 400
    And the response body contains "not installed"
    And ~/.codedash/settings.json is not modified

  Scenario: Stale default falls back on boot (edge)
    Given settings.defaultAgent is "cursor" but cursor was uninstalled
    When codbash starts
    Then GET /api/settings returns defaultAgent: null
    And on next save the stale value is cleared from disk

  # ─── Agent detection ──────────────────────────────────────────

  Scenario: Detection finds CLI on PATH (happy)
    Given /usr/local/bin/claude exists and is executable
    When GET /api/agents/installed is called
    Then the response contains an agent with id="claude", detectedVia="path"
    And binPath is "/usr/local/bin/claude"

  Scenario: Detection finds macOS app bundle (happy)
    Given /Applications/Cursor.app exists
    And cursor is not on PATH
    When GET /api/agents/installed is called
    Then the response contains an agent with id="cursor", detectedVia="app-bundle"

  Scenario: Refresh re-runs detection (happy)
    Given GET /api/agents/installed returned 1 agent at boot
    And the user installs a second agent
    When POST /api/agents/refresh-detect is called
    Then the next GET /api/agents/installed returns 2 agents
    And refreshedAt is newer

  # ─── Auto-register on first launch ────────────────────────────

  Scenario: Auto-register adds unknown path to registry (happy)
    Given ~/.codedash/projects.json contains 0 projects
    And the user has a git repo at "$HOME/code/new-thing"
    When POST /api/launch is called with project="$HOME/code/new-thing", mode="fresh"
    Then the launch succeeds
    And the response body contains registered.source="auto"
    And ~/.codedash/projects.json now contains 1 project at that path
    And the frontend shows a toast "Added new-thing to Projects"

  Scenario: Auto-register declines paths outside HOME (negative)
    Given a fresh launch is requested for "/tmp/throwaway"
    When the launch succeeds
    Then the response body does NOT contain a "registered" field
    And ~/.codedash/projects.json is unchanged

  Scenario: Auto-register opt-out via flag (edge)
    Given POST /api/launch is called with autoRegister=false
    And the project is unknown
    When the launch succeeds
    Then no entry is added to projects.json
    And no toast is shown

  # ─── Security ─────────────────────────────────────────────────

  Scenario: GitHub tokens never appear in new responses (negative)
    Given ~/.codedash/github-profile.json contains a valid OAuth token
    When the client calls /api/settings, /api/agents/installed, /api/agents/refresh-detect
    Then none of the response bodies contain the substring "gho_"
    And none contain a "token" or "repoToken" field

  Scenario: settings.json is written with mode 0600 (happy)
    Given /api/settings is PUT for the first time
    When the write completes
    Then ~/.codedash/settings.json has file mode 0600
    And concurrent PUTs are serialized (last write wins, no partial file)
