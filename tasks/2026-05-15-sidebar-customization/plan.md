# Plan — Sidebar customization

**Task ID**: 2026-05-15-sidebar-customization
**Branch**: `feat/sidebar-customization`
**Type**: feat / ui
**Complexity**: M (3 files touched, no API changes, isolated to frontend + 1 test file)
**Risk**: low–medium (no data loss possible; worst case = visual regression in sidebar layout)

## Inputs

- `docs/design/sidebar-customization.md` — SDD (G2 ✅)
- `specs/sidebar-customization.feature` — 13 BDD scenarios (G3 ✅)

## Approach (high level)

Pure frontend change. New `localStorage` key `codedash-sidebar-config` (JSON). Three new helpers in `app.js`: `loadSidebarConfig() / saveSidebarConfig() / applySidebarConfig()`. HTML restructured into 3 `<section>` blocks with `<button>` headers. Settings page gets a new "Sidebar" sub-pane. CSS adds collapsing behavior + nested sub-section indent.

Implementation order (each commit independently functional):

| # | Step | Files | Outcome |
|---|---|---|---|
| 1 | Extract pure config helpers + write unit tests first (TDD) | `src/frontend/sidebar-config.js` (new), `test/sidebar-config.test.js` (new) | Helpers covered: parse, defaults, validation, future-version fallback, unknown-key preservation |
| 2 | Restructure sidebar HTML into 3 sections + nested Install agents | `src/frontend/index.html` | Visual default state unchanged; new `data-section`, `data-key` attrs in place |
| 3 | Inline `sidebar-config.js` into `app.js` (project has no module bundler — plain script tags) OR include it via `<script>` after `app.js` | `src/frontend/app.js`, `src/frontend/index.html`, `src/html.js` (template inliner) | Helpers available at runtime |
| 4 | Add `applySidebarConfig()` + section-header click handler + run on DOMContentLoaded | `src/frontend/app.js` | Sections collapse/expand and persist; hidden items disappear |
| 5 | Extend `renderSettings()` with "Sidebar" sub-pane | `src/frontend/app.js` | Checklist UI + Reset to defaults works |
| 6 | CSS: section headers, chevron, nested indent, focus-visible | `src/frontend/styles.css` | Visual polish + a11y |
| 7 | Manual smoke (skill `feature-smoke` — frontend variant) + node:test run | — | Green tests + clean smoke report |

Step 1 is mandatory **before** step 2 (TDD). Steps 2–6 can be a single commit if they're tightly coupled, or split by step for clarity — I'll decide after step 1.

## Files touched

| File | Change | Approx LOC |
|---|---|---|
| `src/frontend/sidebar-config.js` | NEW — pure functions | ~80 |
| `src/frontend/index.html` | Replace lines 11–141 with sectioned structure | ~140 (mostly rearranged) |
| `src/frontend/app.js` | Add `applySidebarConfig`, section header handler, Settings sub-pane | ~120 added |
| `src/frontend/styles.css` | Section header / chevron / nested indent / focus styles | ~40 added |
| `src/html.js` | Inline new JS file into template (if needed — depends on step 3 decision) | ~5 |
| `test/sidebar-config.test.js` | NEW — node:test unit tests | ~120 |

Total approx: +500 LOC across 6 files. Net of HTML rearrangement (mostly same content), real new logic ~350 LOC.

## Risks specific to implementation

| # | Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|---|
| R1 | Inlining strategy in `src/html.js` breaks if file contains `$` chars (existing bug-prone area per CLAUDE.md note) | Medium | Medium | `addressed_in: src/html.js — use existing split/join inliner pattern, not String.replace. test_name: render-html-no-dollar-mangling check (manual smoke step verifies)` |
| R2 | Click handler on section header triggers item click (event bubbling) | Medium | Low | `addressed_in: app.js — stopPropagation in section-header handler. test_name: keyboard scenario covers Enter/Space behavior` |
| R3 | Hash routing still mounts the view, but no sidebar item to highlight | Low | Low | `accepted_because: documented in SDD as feature; hint added to Settings sub-pane` |
| R4 | Theme variables `--text-muted` etc. may not cover chevron color in all 3 themes (dark/light/monokai) | Medium | Low | `addressed_in: styles.css — reuse existing .sidebar-item color cascade for chevron; visual smoke in all 3 themes is part of step 7` |
| R5 | `localStorage` throws in private mode → init crash | Low | High (crash kills whole app.js init) | `addressed_in: sidebar-config.js — try/catch around get/set, fall back to in-memory object. test_name: parse-and-save-with-throwing-storage` |
| R6 | Active view hidden + no other way to find it | Low | Medium | `addressed_in: Settings → Sidebar pane hint text; Reset to defaults visible as escape hatch. test_name: BDD scenario "Active view is hidden but still reachable by hash"` |
| R7 | XSS via stored config (user/extension manipulates localStorage to inject HTML when rendering Settings) | Low | High | `addressed_in: renderSettings uses escHtml for any user-derived content; item keys themselves come from a hardcoded allow-list in sidebar-config.js, not from storage. test_name: parse-rejects-non-string-keys + manual review` |
| R8 | `data-section` attribute collides with existing markup | None | — | `addressed_in: verified via grep — no existing usage. Decision: safe.` |
| R9 | install-agents inner items are detected as section-header click targets | Low | Low | `addressed_in: app.js — click handler matches only [data-role="section-header"], not any descendant. test_name: keyboard scenario` |
| R10 | Existing global click delegate for `.sidebar-item` fires when clicking inside section header | Low | Medium | `addressed_in: section header is a <button>, not .sidebar-item — different selector, no overlap. Verify in step 4.` |

All R-items have `addressed_in` or `accepted_because`. None deferred. → **G7 pre-check #2 passes when implementation lands.**

## Threat model (R5, R7 — security-relevant)

- **Input boundary**: `localStorage` is browser-controlled but assumed adversarial (user can edit DevTools → Application).
- **Trust**: never `eval` config; only `JSON.parse` with try/catch.
- **Output boundary**: any string from config that ends up in DOM goes through `escHtml`. But the simpler defense: config only stores **boolean values**; keys come from a hardcoded allow-list. So even adversarial config can't inject HTML — at worst it hides extra items or stores junk we ignore.
- **No secrets** involved; nothing PII; nothing transmitted off-machine. Surface area is small.

## Pre-G7 smoke plan

Frontend-only feature, no new endpoints. Smoke per `feature-smoke` skill (UI variant):
1. `npm start` → `http://localhost:3847`
2. Verify default layout matches current visual baseline (3 sections, Install agents collapsed).
3. Toggle Leaderboard off → check it disappears → reload → still hidden.
4. Collapse Tools → reload → still collapsed.
5. Reset → all default.
6. Hand off to `e2e-runner` for Vercel Agent Browser run of the BDD scenarios that are testable end-to-end (happy paths + keyboard).
7. Manually test in all 3 themes (dark / light / monokai).
8. DevTools: corrupt `codedash-sidebar-config` value → reload → default layout, no error toast, console warning present.
9. Artifact: `tasks/2026-05-15-sidebar-customization/smoke-report.md` with verdict `green`.

`no-smoke` skip: not applicable (this is a UI feature).

## Estimate

- Step 1 (TDD helpers): 30 min
- Step 2 (HTML restructure): 30 min
- Step 3 (inline strategy): 15 min
- Step 4 (apply + handlers): 45 min
- Step 5 (Settings sub-pane): 45 min
- Step 6 (CSS polish): 30 min
- Step 7 (smoke + fixes): 30 min
- Three-agent review + fixes: 60 min

Total: ~5 hours, single sitting feasible.

## Verification gate before commit

- [ ] All tests in `test/sidebar-config.test.js` pass (`node --test`).
- [ ] `npm test` — full suite passes (no regression in `agents-detect`, `settings`, etc.).
- [ ] Manual smoke green in dark/light/monokai.
- [ ] All severities from three-agent review addressed or `deferred_to:` documented.
- [ ] Commit message follows conventional format: `feat(sidebar): group + customize sidebar items`.

## Out of scope (explicit non-goals — for future PRs)

- Activity heatmap counts cursor heavily (separate PR — user request).
- Drag-and-drop reordering of items within a section.
- Per-section "hide all in this section" shortcut.
- Sync sidebar config between devices.
- Right-click context menu on sidebar items (hide from there).
