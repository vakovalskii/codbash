Feature: Sidebar customization
  As a codbash user
  I want to group, collapse, and hide sidebar entries
  So that my left rail matches the tools and views I actually use

  Background:
    Given the codbash dashboard is open in a browser
    And the sidebar has three sections: Workspace, Agents, Tools
    And the Tools section contains a nested "Install agents" sub-section
    And local storage starts empty unless a scenario sets it otherwise

  # ── 1. Happy path ────────────────────────────────────────────────
  Scenario: First-time user sees default layout
    Given local storage has no "codedash-sidebar-config" key
    When the dashboard finishes loading
    Then the Workspace, Agents, and Tools section headers are visible
    And Workspace and Agents and Tools sections are expanded
    And the "Install agents" sub-section is collapsed by default
    And every legacy sidebar item from the previous version is reachable
      (either visible or under an expanded section)

  Scenario: User hides Leaderboard via Settings, change persists across reload
    Given the user is on the Settings page
    And the Settings page shows a "Sidebar" sub-pane with a checkbox for every item
    When the user unchecks the "Leaderboard" checkbox
    Then the "Leaderboard" item disappears from the Workspace section immediately
    And local storage "codedash-sidebar-config" stores hidden.leaderboard = true
    When the user reloads the page
    Then the "Leaderboard" item is still hidden
    And the checkbox in Settings → Sidebar is still unchecked

  Scenario: Section collapse state persists
    Given the Agents section is expanded
    When the user clicks the "Agents" section header
    Then the Agents section body collapses (its items are not visible)
    And the chevron rotates from ▾ to ▸
    And local storage "codedash-sidebar-config" stores collapsed.agents = true
    When the user reloads the page
    Then the Agents section is still collapsed

  Scenario: Reset to defaults clears all customization
    Given the user has hidden Leaderboard, Starred, and Cloud Sync
    And the user has collapsed the Tools section
    When the user clicks "Reset to defaults" in Settings → Sidebar
    Then all previously hidden items reappear
    And the Tools section is expanded again
    And the "Install agents" sub-section returns to its default collapsed state
    And local storage "codedash-sidebar-config" is cleared

  # ── 2. Empty state ───────────────────────────────────────────────
  Scenario: User hides every togglable Workspace item
    Given Settings is always visible regardless of toggles
    When the user unchecks every checkbox in the Workspace group
    Then the Workspace section body is visually empty
    And the Workspace section header remains visible
    And the Settings, Changelog, Export/Import items remain reachable
    # the user can recover by checking any box again

  # ── 3. Loading state ─────────────────────────────────────────────
  Scenario: Sidebar applies config before first paint flicker
    Given local storage has hidden.starred = true
    When the dashboard loads
    Then the Starred item is not visible at any point during initial render
    # rationale: applySidebarConfig runs synchronously on DOMContentLoaded
    # so no "starred briefly appears then disappears" flicker

  # ── 4. Error state ───────────────────────────────────────────────
  Scenario: Corrupted local storage JSON is recovered silently
    Given local storage "codedash-sidebar-config" is set to "{not valid json"
    When the dashboard loads
    Then the sidebar renders with the default layout
    And no user-facing error message is shown
    And a console warning is logged
    And the next save overwrites the corrupted value with valid JSON

  Scenario: Settings toggle cannot be unchecked
    Given the user opens Settings → Sidebar
    Then the checkbox for "Settings" is rendered as disabled
    And hovering it shows the tooltip "Settings is always visible"
    When the user attempts to click the disabled Settings checkbox
    Then the checkbox state does not change
    And local storage is not written

  Scenario: localStorage unavailable (private mode) does not crash
    Given localStorage.getItem throws a SecurityError
    When the dashboard loads
    Then the sidebar renders with the default layout
    And no exception bubbles up to the global error handler
    And in-memory config still allows toggling within the session
      (changes are lost on reload, which is acceptable)

  # ── 5. Keyboard-only navigation ──────────────────────────────────
  Scenario: User collapses a section using only the keyboard
    Given keyboard focus is on the "Workspace" section header button
    Then aria-expanded is "true"
    When the user presses Space
    Then the Workspace section collapses
    And aria-expanded becomes "false"
    When the user presses Enter
    Then the Workspace section expands again
    And aria-expanded returns to "true"

  Scenario: Focus ring is visible on section headers
    When the user tabs through the sidebar
    Then each section header receives a visible :focus-visible outline
    And the outline color comes from the active theme variable, not from a removed default

  # ── 6. Edge data ─────────────────────────────────────────────────
  Scenario: Future schema version is treated as opaque
    Given local storage "codedash-sidebar-config" is {"v": 999, "hidden": {}, "collapsed": {}}
    When the dashboard loads
    Then the sidebar renders with the default layout
    # forward-compat: unknown version → don't trust the payload, reset on next save

  Scenario: Unknown item key in stored config is ignored
    Given local storage stores hidden = {"nonexistent-view": true, "leaderboard": true}
    When the dashboard loads
    Then only "Leaderboard" is hidden
    And the unknown key is preserved in storage (kept on save) so a forward-version key is not destroyed
    # rationale: a future codbash release may add new keys we don't recognize yet

  Scenario: Active view is hidden but still reachable by hash
    Given the user navigated to "#leaderboard" and then hid the Leaderboard item
    When the page reloads at "#leaderboard"
    Then the Leaderboard view content renders correctly
    And the (hidden) Leaderboard sidebar item is not visible
    And Settings → Sidebar shows a hint explaining hash-based access still works

  # N/A categories (intentionally documented):
  # - Loading async — applySidebarConfig is synchronous, no async fetch involved
  # - Optimistic UI — no server round-trip
  # - Touch-only specific — not a touch-targeted feature, but section headers ≥36px
