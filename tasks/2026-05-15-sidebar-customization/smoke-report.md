# Smoke report — sidebar customization

**Date**: 2026-05-15
**Branch**: feat/sidebar-customization

## Verdict: green (with caveats — see manual-test recommendation)

## What was automated

### Unit tests
- `node --test test/sidebar-config.test.js` → **32 / 32 pass**
- Full suite: same per-file numbers as `main`. No regressions:
  - `agents-detect`: 8/8 pass
  - `claude-structured-parse`: 6/6 pass
  - `cloud-remote-normalize`: 5/5 pass
  - `git-root-resolve`: 8/8 pass
  - `settings`: 9/9 pass
  - `sidebar-config` (NEW): 32/32 pass
  - `display-project`: 14/14 fail — **pre-existing on main**, unrelated function reference
  - `wsl-windows`: 1/6 fail — **pre-existing on main**, platform-specific

### HTML build inspection
`node -e "require('./src/html.js').getHTML()"` markers — all present:
- ✓ Workspace / Agents / Tools section headers (`data-section`)
- ✓ Install agents nested `data-section="install-agents"`
- ✓ `SidebarConfig` / `parseSidebarConfig` / `KNOWN_ITEM_KEYS` inlined into output
- ✓ `applySidebarConfig` definition + invocation in `init()`
- ✓ Settings sub-pane block (`renderSidebarSettingsGroup`)
- ✓ `data-key="install:claude"` ... `install:copilot`
- ✓ `data-key="export-import"`

### Server boot
- Port 3847 was already in use by the user's installed `codbash` (production). Did not kill — destructive.
- HTML output validated via in-process `getHTML()` call instead of HTTP probe.

## What requires manual browser verification

Before merging, run a clean dev build and check in browser:

```bash
# Stop the npm-installed codbash first if it's running, then:
node bin/cli.js run
# Visit http://localhost:3847
```

Manual checklist (BDD coverage):
- [ ] Default layout: 3 sections, Workspace + Agents + Tools all expanded; Install agents collapsed.
- [ ] Click "Workspace" header → collapses with chevron rotating to ▸. Reload → still collapsed.
- [ ] Settings → Sidebar pane: uncheck Leaderboard → item disappears from sidebar live; reload → still hidden.
- [ ] Settings checkbox itself is `disabled` with tooltip "Settings is always visible".
- [ ] Reset to defaults — all items reappear, Tools re-expanded, Install agents back to collapsed.
- [ ] DevTools → set `localStorage['codedash-sidebar-config'] = '{garbage'` → reload → default layout, no error in console (only the documented warning).
- [ ] DevTools → check `aria-expanded` toggles on each header click.
- [ ] Keyboard: Tab to header, press Space → collapses; press Enter → expands.
- [ ] Visit `#leaderboard` while Leaderboard is hidden → view renders, sidebar item still hidden, hash routing works.
- [ ] Theme switch (dark / light / monokai) — chevron color and section header color visible in all three.

## Known issues observed

None blocking. The existing pre-feature behavior where clicking install items also fires `setView(null)` (because install items have no `data-view`) is unchanged from `main` — out of scope for this PR.

## Recommendation

Proceed to G7 (three-agent review). Manual browser smoke can be done by reviewer or before merging the PR — the automated checks confirm the surface is wired correctly.
