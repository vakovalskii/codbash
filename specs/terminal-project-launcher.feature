Feature: Launch a project (with or without an agent) from the Terminal tab

  As a user on the Terminal (Workspace) tab
  I want to pick a registered project and open an in-app terminal in its folder,
  optionally auto-running the last-used or a chosen agent,
  So that I don't have to leave the Terminal tab or manually cd into the project.

  Background:
    Given the Terminal (Workspace) view is open
    And the "＋ Project" launcher button is visible in the toolbar

  # 1. Happy path — open a plain terminal in a project
  Scenario: Open a plain terminal in a project folder (no agent)
    Given at least one registered project whose folder exists
    When I open the project launcher and click "⊞ Terminal" on that project
    Then a new terminal tab opens named after the project
    And the pane's shell starts in the project folder
    And no agent command is auto-run

  # 1b. Happy path — launch the preferred/last-used agent
  Scenario: Launch a project with the last-used agent
    Given a registered project whose folder exists
    And at least one agent is installed
    When I open the project launcher and click the "▶ <agent>" button on that project
    Then a new terminal tab opens in the project folder
    And the preferred/last-used agent command is auto-run in that folder

  # 1c. Happy path — pick a specific agent
  Scenario: Launch a project with an explicitly chosen agent
    Given a registered project whose folder exists
    And two or more agents are installed
    When I open the project launcher and choose a specific agent from the "Agent ▾" select on that project
    Then a new terminal tab opens in the project folder
    And the chosen agent command is auto-run there
    And that agent becomes the shown preferred agent for the project this session

  # 2. Empty state
  Scenario: No registered projects
    Given the projects registry is empty
    When I open the project launcher
    Then it shows an empty-state message inviting me to add projects on the Projects tab
    And no project rows are rendered

  # 3. Loading / not-yet-ready data
  Scenario: Agent list not loaded yet
    Given the installed-agents data has not loaded
    When I open the project launcher
    Then each existing project still shows the "⊞ Terminal" action
    And the agent launch actions are hidden or disabled until agents are known

  # 4. Error state — missing folder
  Scenario: Project folder was moved or deleted
    Given a registered project whose folder no longer exists on disk
    When I open the project launcher
    Then that project row is shown as disabled with a "missing" note
    And it offers no launch actions
    And clicking elsewhere never spawns a terminal in a fallback home folder for it

  # 4b. Error state — no agents installed
  Scenario: No agent CLI is installed
    Given no agents are installed
    When I open the project launcher
    Then existing projects show only the "⊞ Terminal" action
    And no agent launch controls are shown

  # 5. Keyboard-only navigation
  Scenario: Operate the launcher with the keyboard only
    Given the project launcher is closed
    When I focus the "＋ Project" button and press Enter
    Then the launcher opens and focus moves into the filter field
    And Tab / Shift+Tab cycles through the project rows and their actions
    And pressing Escape closes the launcher and returns focus to the "＋ Project" button

  # 6. Edge data
  Scenario: Long project names, many projects, and special characters
    Given a project whose name is very long and contains "<script>" and emoji
    And more registered projects than fit on screen
    When I open the project launcher and type into the filter field
    Then the list scrolls within the popover without breaking the page layout
    And the name is rendered as text (escaped), never as markup
    And the filter narrows the visible rows by name or path
