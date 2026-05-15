Feature: Analytics — Subscriptions management & project name display
  As a codbash user
  I want to track my paid subscriptions and API deposits across all agents
  And see clean project names in cost breakdowns
  So that I can understand my actual monthly AI spend

  Background:
    Given I have opened codbash dashboard
    And I am on the "Analytics" tab
    And localStorage key "codedash-subscription" is empty

  # ── Category 1: Happy path ────────────────────────────────────

  Scenario: Add a Claude Max 5× subscription via dropdowns
    When I select "Claude Code" from the Service dropdown
    Then the Plan dropdown is populated with "Pro", "Max 5×", "Max 20×"
    And the Plan dropdown is enabled
    When I select "Max 5×" from the Plan dropdown
    Then the Paid field auto-fills with "100"
    When I enter "2026-05-01" in the From field
    And I click "Add"
    Then a new subscription row appears: "Claude Code · Max 5× · $100 · 2026-05-01"
    And the total monthly spend shows "$100"
    And the form is cleared

  Scenario: Switching service repopulates plans and resets paid
    Given I have selected "Claude Code" and "Max 5×" (paid auto-filled to $100)
    When I change the Service to "Cursor"
    Then the Plan dropdown is repopulated with "Pro", "Pro+", "Ultra"
    And the Paid field is cleared
    And the previously selected Plan is no longer shown

  Scenario: Add an API deposit (custom)
    When I select "API (custom)" from the Service dropdown
    Then the Plan field becomes a free-text input with placeholder "Provider / balance label"
    And the Paid field is empty and editable
    When I type "Anthropic API balance" in the Plan field
    And I enter "50" in the Paid field
    And I enter "2026-05-10" in the From field
    And I click "Add"
    Then a new row appears: "API · Anthropic API balance · $50 · 2026-05-10"
    And the row is visually grouped under an "API deposits" subtotal

  # ── Category 2: Empty state ────────────────────────────────────

  Scenario: No subscriptions configured shows empty state
    Given localStorage key "codedash-subscription" is empty
    When I view the Subscriptions section
    Then I see the empty-state message "Add your first subscription to see total monthly spend"
    And the empty-state has a visible Add form below it
    And the total monthly spend shows "$0"

  Scenario: All API deposits removed leaves only subscription subtotal
    Given I have one subscription entry "Claude Code · Pro · $20"
    And no API deposit entries
    When I view the Subscriptions section
    Then the "API deposits" subtotal is hidden
    And only the "Subscriptions" subtotal is shown

  # ── Category 3: Loading state ──────────────────────────────────

  Scenario: Slow /api/analytics/cost shows loading state for Cost by Project
    Given /api/analytics/cost takes longer than 500ms to respond
    When I switch to Analytics tab
    Then a loading skeleton is shown for "Cost by Project"
    And the Subscriptions section is interactive (does not block on the API)

  # N/A: subscription form itself — localStorage is synchronous, no loading state needed

  # ── Category 4: Error state ────────────────────────────────────

  Scenario: Add button is disabled with no service selected
    Given the form is empty
    Then the Add button is disabled
    And the Plan dropdown is disabled

  Scenario: Add button is disabled when paid is zero or negative
    Given I have selected "Claude Code" and "Max 5×"
    When I clear the Paid field
    Then the Add button is disabled
    When I enter "-10" in the Paid field
    Then the Add button is disabled
    And inline validation message reads "Paid amount must be greater than 0"

  Scenario: Selecting a free / API-only service shows guidance
    When I select "Qwen Code" from the Service dropdown
    Then the Plan dropdown is empty and disabled
    And a helper text reads "This service is free / API-only — use 'API (custom)' instead"
    And the Add button is disabled

  Scenario: Corrupted localStorage value falls back to empty entries
    Given localStorage key "codedash-subscription" contains invalid JSON
    When I view the Subscriptions section
    Then I see the empty-state
    And no JavaScript error is thrown to the console

  # ── Category 5: Keyboard-only navigation ──────────────────────

  Scenario: Tab order through Subscriptions form
    Given I focus the Service dropdown
    When I press Tab
    Then focus moves to the Plan dropdown
    When I press Tab
    Then focus moves to the Paid input
    When I press Tab
    Then focus moves to the From input
    When I press Tab
    Then focus moves to the Add button
    And every focused element has a visible focus ring

  Scenario: Enter in Paid submits the form when valid
    Given I have selected "Claude Code", "Max 5×", paid="100"
    When I focus the Paid input and press Enter
    Then the entry is added (same as clicking Add)

  Scenario: Tab through subscription rows reaches the Remove button
    Given there are 2 subscription entries
    When I tab through the rows
    Then each Remove button is focusable
    And each Remove button has aria-label="Remove subscription entry"
    When I press Enter on a focused Remove button
    Then that entry is deleted and aria-live announces "Subscription removed"

  # ── Category 6: Edge data ──────────────────────────────────────

  Scenario: Cost by Project shows basename, not full path
    Given a session exists with projectPath "/Users/pavelnovak/code/codbash"
    When I view "Cost by Project"
    Then the row label is "codbash"
    And the row label is NOT "~/code/codbash"
    And the row label does NOT contain "$HOME"

  Scenario: Session with projectPath equal to $HOME shows "(home)"
    Given a session exists with projectPath equal to os.homedir()
    When I view "Cost by Project"
    Then the row label is "(home)"
    And the row label is NOT "~"

  Scenario: Two projects with the same basename merge into one row
    Given a session exists with projectPath "/Users/x/work/api"
    And a session exists with projectPath "/Users/x/personal/api"
    When I view "Cost by Project"
    Then there is exactly one row labelled "api"
    And the cost is the sum of both sessions
    # Accepted collision per SDD decision (basename only)

  Scenario: Most Expensive Sessions uses displayProject
    Given the most expensive session has projectPath "/Users/x/code/codbash"
    When I view "Most Expensive Sessions"
    Then the project label shows "codbash"

  Scenario: Subscription with very long custom plan name does not break layout
    When I add an API entry with plan "Anthropic API balance for billing account ACME-12345-prod"
    Then the row text truncates with ellipsis at the table edge
    And the full text is available via tooltip / title attribute

  Scenario: Subscription with 100+ entries renders without freezing
    Given localStorage contains 100 subscription entries
    When I open the Analytics tab
    Then the Subscriptions section renders within 200ms
    And no virtualization is needed (entries are pre-aggregated to a subtotal)

  Scenario: Migration from old single-entry format
    Given localStorage "codedash-subscription" = {"plan":"Pro","paid":20}
    When I open the Analytics tab
    Then the entry is shown as "(legacy) · Pro · $20"
    And no data is lost
    And no error is thrown
