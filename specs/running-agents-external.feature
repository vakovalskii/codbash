Feature: Running agents lists external terminals and focuses their real window

  The Workspace "Running agents" tree shows agents that are actually running in
  external native terminals (iTerm, Terminal.app, Warp, cmux). Codbash's own
  browser-pty panes are excluded — they are already visible as tabs. Clicking a
  running agent raises its real terminal window; it never spawns a blank shell.

  Background:
    Given codbash is running with the Workspace view available

  # 1. Happy path — external agent shows and focuses its window
  Scenario: An agent launched in iTerm appears and clicking focuses the window
    Given "claude" is running in iTerm in "/Users/me/proj-a"
    And no codbash browser-pty pane descends from that process
    When /api/active is polled
    Then the agent is returned with local=false
    And it appears under project "proj-a" in the Running agents tree
    When the user clicks that running-agent row
    Then a POST /api/focus is sent with the agent's pid
    And no new terminal pane is opened

  # 2. Empty state — nothing external running
  Scenario: No external agents running
    Given the only live agents descend from codbash browser-pty panes
    When /api/active is polled
    Then every returned agent has local=true
    And the Running agents tree is hidden

  # 3. Negative / error — focus fails
  Scenario: Focusing an external agent's window fails
    Given an external agent whose host terminal app cannot be focused by pid
    When the user clicks its running-agent row
    And the /api/focus call returns an error
    Then a toast explains the window could not be focused
    And no blank terminal is spawned as a fallback

  # 4. Edge — codbash-launched-into-native-terminal is still external
  Scenario: Agent launched by codbash into a native terminal counts as external
    Given codbash launched "codex" into Terminal.app via /api/launch
    And that process descends from Terminal.app, not from a codbash pty
    When /api/active is polled
    Then the agent is returned with local=false
    And it appears in the Running agents tree

  # 5. Edge — codbash browser-pane agent is excluded from the tree
  Scenario: An agent running inside a codbash Workspace pane is not in the tree
    Given "claude" is running inside a codbash browser-pty pane in "/Users/me/proj-b"
    When /api/active is polled
    Then that agent is returned with local=true
    And it does NOT appear in the Running agents tree
    But it remains visible as its Workspace pane

  # 6. Edge — fail-open when ancestry cannot be resolved
  Scenario: ps ancestry lookup is unavailable
    Given the ppid process listing cannot be read
    When /api/active is tagged
    Then every agent is returned with local=false
    And all live agents remain visible rather than being hidden
