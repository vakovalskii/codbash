# Card Footer for MCP/Skills + Settings View

## Card redesign — MCP/Skills footer

Currently MCP/Skill badges render in `card-top` alongside the tool badge, project, time, and cost. This makes the header row cluttered.

### New card structure

```
card-top:    [CLAUDE] [project] [time] [~$cost] [star]
card-body:   message text
card-footer: [msgs] [size] [date] [id] [tags] [expand]
card-tools:  [LIGHTPANDA] [SUPERPOWERS]   ← NEW, only if badges exist
```

`card-tools` is a new div below `card-footer` with `border-top`. It only renders when `s.mcp_servers.length > 0 || s.skills.length > 0`. Sessions without MCP/Skills look unchanged.

### Changes

**app.js — renderCard():**
- Remove MCP/Skill badge rendering from after `tool-badge` line
- Add `card-tools` div after `card-footer`, before `card-preview-area`

**app.js — renderListCard():**
- Remove MCP/Skill badge rendering from after `tool-badge` line
- Add badges after the main list content (inline, same row or wrap)

**styles.css:**
```css
.card-tools {
    padding: 8px 16px;
    border-top: 1px solid var(--border);
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}
```

## Settings view

Move Theme and Terminal selectors from sidebar bottom to a new Settings page.

### Sidebar changes

**index.html:**
- Remove `sidebar-settings` div (label + select for Theme and Terminal)
- Add new sidebar-item with gear icon and `data-view="settings"` after Changelog

**app.js — render():**
- Add `settings` case that renders the settings page into `#content`
- Settings page contains:
  - Theme selector (3 buttons: Dark / Light / System) — same functionality as current select
  - Terminal selector (select dropdown) — same as current
  - Version info at bottom

**styles.css:**
- `.settings-page` container with padding
- `.settings-group` for each setting block (label + control)
- `.theme-btn` toggle buttons (active state matches current theme)

### Data flow

No backend changes. Settings are stored in localStorage (same keys: `codedash-theme`, `codedash-terminal`). The Settings view reads and writes to the same localStorage keys. Theme changes apply immediately via `setTheme()`. Terminal changes save via `saveTerminalPref()`.

## Scope

- No new API endpoints
- No new dependencies
- Frontend-only changes (app.js, styles.css, index.html)
