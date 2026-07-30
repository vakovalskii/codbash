Feature: Missing-project detection and re-clone offer on the Projects launcher

  Background:
    Given a project "my-repo" is registered with remoteUrl "https://github.com/me/my-repo.git"

  Scenario: Happy path — folder present renders normal launch controls
    Given the folder for "my-repo" exists on disk
    When I open the Projects landing
    Then the tile shows the ▶ New / Last / Terminal launch controls
    And no "folder is missing" disclaimer is shown

  Scenario: Empty/missing state — deleted folder shows disclaimer
    Given the folder for "my-repo" was deleted from disk
    When I open the Projects landing
    Then the tile is marked as missing
    And a disclaimer says the folder is missing and can be re-cloned from GitHub
    And the ▶ New / Last launch controls are hidden
    And a "Re-clone" and a "Remove" button are shown

  Scenario: Loading state — re-clone in progress
    Given the folder for "my-repo" is missing
    When I click "Re-clone"
    Then the button is disabled and shows "Cloning…"

  Scenario: Success — re-clone restores the folder and normal controls
    Given the folder for "my-repo" is missing
    When I click "Re-clone" and the clone succeeds
    Then a toast confirms the folder was re-cloned from GitHub
    And the registry is refreshed and the tile returns to the normal launch state

  Scenario: Error — launch of a deleted folder returns an actionable response
    Given the folder for "my-repo" was deleted after the page loaded
    When I click ▶ New on the tile
    Then the server responds 400 with missing=true and the project's remoteUrl
    And the UI tells me the folder is missing and offers to re-clone it

  Scenario: Negative — local project without a GitHub remote cannot be re-cloned
    Given a project "local-only" is registered with no remoteUrl
    And its folder is missing on disk
    When I open the Projects landing
    Then the disclaimer tells me to restore the folder or remove it from the list
    And no "Re-clone" button is shown, only "Remove"

  Scenario: Edge — re-clone into a path outside the home directory fails cleanly
    Given a project whose stored path is outside the home directory is missing
    When I click "Re-clone"
    Then a toast shows the clone error and the button returns to "Re-clone"

  # N/A: keyboard-only — reuses existing .git-project-launch-btn focus-ring and aria-labels;
  # no new focus-trap or shortcut introduced.
