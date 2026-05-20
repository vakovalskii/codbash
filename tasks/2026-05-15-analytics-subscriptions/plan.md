# Plan: analytics-subscriptions

**Branch**: `feat/analytics-subscriptions` (off `main`)
**Estimated**: M (~3–4h with tests + review fixes)
**Risk**: low (localStorage + display logic; no server-side state changes)

## Phase 0 — Branch setup

```bash
git fetch origin
git checkout -b feat/analytics-subscriptions origin/main
```

(Currently on `feat/sidebar-customization` — clean; switch is safe. SDD + BDD files already created on current branch; they'll be carried over via cherry-pick or just re-staged on new branch.)

**Carry-over files** (already written, need to land on new branch):
- `docs/design/analytics-subscriptions.md`
- `specs/analytics-subscriptions.feature`
- `tasks/2026-05-15-analytics-subscriptions/plan.md` (this file)

## Phase 1 — Verify pricing (G4-only research)

Before writing prices into code, run WebSearch for current marketing pages:
- anthropic.com/pricing (Claude Pro / Max plans)
- openai.com/chatgpt/pricing (Plus / Pro)
- cursor.com/pricing (Pro / Pro+ / Ultra)
- github.com/features/copilot (individual / business)
- kiro.dev/pricing
- opencode.ai

For each: record `{ plan_name, price_usd_month, source_url, verified_date: 2026-05-15 }` in a code comment block above `SERVICE_PLANS`. If a price has changed since SDD, update SDD + ask user before hardcoding (one comment line, no new gate).

## Phase 2 — Backend: displayProject() helper

**File**: `src/data.js`

### 2.1 Add helper (top of file, near other helpers, ~line 10–30 area)

```js
const path = require('path');
// existing const os = require('os');

function displayProject(s) {
  const home = os.homedir();
  let raw = (s && (s.project || s.project_short)) || '';
  if (!raw) return 'unknown';
  // Normalize: "~/code/foo" -> "/Users/x/code/foo" so we can compare to home
  if (raw === '~' || raw === home) return '(home)';
  if (raw.startsWith('~/')) raw = path.join(home, raw.slice(2));
  if (raw === home) return '(home)';
  const base = path.basename(raw);
  return base || 'unknown';
}
```

### 2.2 Use helper in aggregation (line 4873)

Replace:
```js
const proj = s.project_short || s.project || 'unknown';
```
With:
```js
const proj = displayProject(s);
```

### 2.3 Use helper for topSessions (line 4879)

Replace:
```js
sessionCosts.push({ id: s.id, cost, project: proj, date: s.date, last_ts: s.last_ts || 0 });
```

Already correct since `proj` is now `displayProject(s)`. No additional change.

### 2.4 Export displayProject for testing

Add to `module.exports` block at end of file.

## Phase 3 — Frontend: SERVICE_PLANS expansion

**File**: `src/frontend/app.js` (lines 250–274)

Replace `SERVICE_PLANS` with 9 services + `API (custom)`:

```js
// Subscription plans verified 2026-05-15 against vendor pricing pages.
// Source URLs in docs/design/analytics-subscriptions.md.
var SERVICE_PLANS = {
  'Claude Code':   { label: 'Claude Code (Anthropic)', kind: 'subscription', plans: [
    { name: 'Pro', price: 20 },
    { name: 'Max 5×', price: 100 },
    { name: 'Max 20×', price: 200 }
  ]},
  'ChatGPT/Codex': { label: 'ChatGPT / Codex (OpenAI)', kind: 'subscription', plans: [
    { name: 'Plus', price: 20 },
    { name: 'Pro', price: 200 }
  ]},
  'Cursor':        { label: 'Cursor', kind: 'subscription', plans: [
    { name: 'Pro', price: 20 },
    { name: 'Pro+', price: 60 },
    { name: 'Ultra', price: 200 }
  ]},
  'Copilot':       { label: 'GitHub Copilot', kind: 'subscription', plans: [
    { name: 'Pro', price: 10 },
    { name: 'Pro+', price: 39 },
    { name: 'Business', price: 19 }
  ]},
  'Kiro':          { label: 'Kiro', kind: 'subscription', plans: [
    { name: 'Pro', price: 20 },
    { name: 'Pro+', price: 40 },
    { name: 'Power', price: 200 }
  ]},
  'OpenCode':      { label: 'OpenCode', kind: 'subscription', plans: [
    { name: 'Go', price: 10 }
  ]},
  'Qwen Code':     { label: 'Qwen Code', kind: 'api-only', plans: [],
                     note: 'Free / API-only — use "API (custom)" to track deposits' },
  'Kilo':          { label: 'Kilo', kind: 'api-only', plans: [],
                     note: 'Free / API-only — use "API (custom)" to track deposits' },
  'API (custom)':  { label: 'API (custom)', kind: 'api', plans: [],
                     note: 'Enter provider/balance label and deposit amount manually' }
};
```

## Phase 4 — Frontend: form behaviour

**File**: `src/frontend/app.js`

### 4.1 onSubServiceChange (line 276)

```js
function onSubServiceChange() {
  var serviceEl = document.getElementById('sub-new-service');
  var planEl = document.getElementById('sub-new-plan');
  var planOpts = document.getElementById('sub-plan-opts');
  var paidEl = document.getElementById('sub-new-paid');
  var hintEl = document.getElementById('sub-new-hint');
  var service = serviceEl ? serviceEl.value.trim() : '';
  if (!planOpts || !planEl || !paidEl) return;
  planOpts.innerHTML = '';
  paidEl.value = '';
  planEl.value = '';
  if (hintEl) hintEl.textContent = '';
  var cfg = SERVICE_PLANS[service];
  if (cfg) {
    if (cfg.kind === 'api') {
      planEl.placeholder = 'Provider / balance label';
    } else {
      planEl.placeholder = 'Plan';
    }
    cfg.plans.forEach(function(p) {
      var opt = document.createElement('option');
      opt.value = p.name;
      planOpts.appendChild(opt);
    });
    if (cfg.note && hintEl) hintEl.textContent = cfg.note;
  }
  updateAddButtonState();
}
```

### 4.2 onSubPlanChange (line 293)

Add `updateAddButtonState()` at end. Otherwise unchanged.

### 4.3 New: updateAddButtonState

```js
function updateAddButtonState() {
  var btn = document.getElementById('sub-add-btn');
  var serviceEl = document.getElementById('sub-new-service');
  var paidEl = document.getElementById('sub-new-paid');
  var planEl = document.getElementById('sub-new-plan');
  if (!btn) return;
  var service = serviceEl ? serviceEl.value.trim() : '';
  var paid = parseFloat(paidEl && paidEl.value) || 0;
  var cfg = SERVICE_PLANS[service];
  var apiOnly = cfg && cfg.kind === 'api-only';
  var planRequired = cfg && cfg.kind !== 'api';
  var planOk = !planRequired || (planEl && planEl.value.trim().length > 0);
  btn.disabled = apiOnly || !service || paid <= 0 || !planOk;
}
```

### 4.4 addSubEntry (line 316)

```js
function addSubEntry() {
  var service = (document.getElementById('sub-new-service').value || '').trim();
  var planEl = document.getElementById('sub-new-plan');
  var plan = planEl ? planEl.value.trim() : '';
  var paid = parseFloat(document.getElementById('sub-new-paid').value) || 0;
  var from = (document.getElementById('sub-new-from').value || '').trim();
  if (!service || paid <= 0) return;
  var cfg = SERVICE_PLANS[service];
  if (cfg && cfg.kind === 'api-only') return;
  var kind = cfg && cfg.kind === 'api' ? 'api' : 'subscription';
  _analyticsHtmlCache = null;
  _analyticsCacheUrl = null;
  var sub = getSubscriptionConfig();
  sub.entries.push({ kind: kind, service: service, plan: plan || 'Subscription', paid: paid, from: from });
  sub.entries.sort(function(a,b){return (a.from||'').localeCompare(b.from||'');});
  saveSubscriptionConfig(sub);
  // a11y: announce
  var live = document.getElementById('sub-aria-live');
  if (live) live.textContent = 'Subscription added: $' + paid.toFixed(2) + (kind === 'api' ? ' API deposit' : '/month');
  render();
}
```

### 4.5 getSubscriptionConfig migration (line 307)

```js
function getSubscriptionConfig() {
  var raw;
  try { raw = JSON.parse(localStorage.getItem('codedash-subscription') || 'null'); }
  catch (e) { raw = null; }
  if (!raw) return { entries: [] };
  if (!raw.entries) return { entries: [{ kind: 'subscription', service: '', plan: raw.plan || 'Subscription', paid: raw.paid || 0, from: '' }] };
  // Ensure each entry has kind
  raw.entries = raw.entries.map(function(e) {
    if (!e.kind) e.kind = 'subscription';
    return e;
  });
  return raw;
}
```

## Phase 5 — Frontend: render

**File**: `src/frontend/analytics.js`

### 5.1 Split entries by kind (line 218)

```js
var subEntries_subs = subEntries.filter(function(e){return (e.kind||'subscription')==='subscription';});
var subEntries_api  = subEntries.filter(function(e){return e.kind==='api';});
var totalSubs = subTotalPaid(subEntries_subs);
var totalApi  = subTotalPaid(subEntries_api);
```

Use `totalSubs` for subscription bar comparison vs API rates (don't mix API deposits into ROI calculation — they're orthogonal).

### 5.2 Render with subtotals (line 236)

```js
html += '<div class="sub-entries">';
if (subEntries_subs.length > 0) {
  html += '<div class="sub-group-header">Subscriptions · $' + totalSubs.toFixed(2) + '/mo</div>';
  subEntries_subs.forEach(function(e, i){ /* row */ });
}
if (subEntries_api.length > 0) {
  html += '<div class="sub-group-header">API deposits · $' + totalApi.toFixed(2) + ' total</div>';
  subEntries_api.forEach(function(e, i){ /* row */ });
}
if (subEntries.length === 0) {
  html += '<p class="sub-empty">Add your first subscription to see total monthly spend</p>';
}
html += '</div>';
```

Index passed to `removeSubEntry` must match the original combined array — pass original index, not group index.

### 5.3 Form additions (line 255)

```js
html += '<div class="sub-add-form">';
html += '<div id="sub-aria-live" aria-live="polite" class="sr-only"></div>';
html += '<label for="sub-new-service" class="sr-only">Service</label>';
// existing datalists
html += '<input id="sub-new-service" ... oninput="onSubServiceChange()" />';
html += '<label for="sub-new-plan" class="sr-only">Plan</label>';
html += '<input id="sub-new-plan" ... oninput="onSubPlanChange()" />';
html += '<label for="sub-new-paid" class="sr-only">Monthly price</label>';
html += '<input id="sub-new-paid" ... oninput="updateAddButtonState()" onkeydown="if(event.key==\'Enter\'){addSubEntry();}" />';
html += '<input id="sub-new-from" ... />';
html += '<button id="sub-add-btn" disabled onclick="addSubEntry()">+ Add</button>';
html += '<div id="sub-new-hint" class="sub-hint-line"></div>';
html += '</div>';
```

### 5.4 CSS additions

**File**: `src/frontend/styles.css`

```css
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
.sub-group-header { font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px; margin-top:8px; padding-bottom:4px; border-bottom:1px solid var(--border); }
.sub-empty { color:var(--text-secondary); font-style:italic; padding:8px 0; }
.sub-hint-line { grid-column:1/-1; font-size:11px; color:var(--text-secondary); min-height:14px; }
.sub-entry-plan { max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#sub-add-btn:disabled { opacity:0.4; cursor:not-allowed; }
```

## Phase 6 — Tests

**File**: `test/displayProject.test.js` (new — node:test, zero-dep)

```js
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { displayProject } = require('../src/data.js');

test('basename for full path', () => {
  assert.strictEqual(displayProject({ project: '/Users/x/code/codbash' }), 'codbash');
});
test('basename for tilde path', () => {
  assert.strictEqual(displayProject({ project: '~/code/codbash' }), 'codbash');
});
test('(home) for homedir', () => {
  assert.strictEqual(displayProject({ project: os.homedir() }), '(home)');
});
test('(home) for bare tilde', () => {
  assert.strictEqual(displayProject({ project: '~' }), '(home)');
});
test('unknown for empty', () => {
  assert.strictEqual(displayProject({}), 'unknown');
});
test('falls back to project_short', () => {
  assert.strictEqual(displayProject({ project_short: '~/code/foo' }), 'foo');
});
test('basename collision is accepted (same name → same key)', () => {
  assert.strictEqual(displayProject({ project: '/a/b/api' }), 'api');
  assert.strictEqual(displayProject({ project: '/c/d/api' }), 'api');
});
```

Run: `node --test test/displayProject.test.js`

For frontend behaviour (`onSubServiceChange`, `addSubEntry`, migration) — manual smoke via dev server (no Playwright in this repo per CLAUDE.md zero-deps constraint), checklist in smoke-report.md.

## Phase 7 — Smoke (feature-smoke skill)

Per `~/.claude/skills/feature-smoke/SKILL.md`:
1. Boot codbash on ephemeral port (`PORT=0 codbash run --no-open`)
2. curl `/` and verify HTML renders
3. curl `/api/analytics/cost` and verify `byProject` keys do not contain `~/` or `$HOME`
4. UI handoff to `e2e-runner` for: select Claude Code → verify plan dropdown populates; select Max 5× → verify paid=100; select API → verify plan placeholder changes; add 2 entries → verify both render; corrupt localStorage → verify no console error; tab through form → verify focus visible
5. Write `tasks/2026-05-15-analytics-subscriptions/smoke-report.md` with verdict.

## Risks specific to implementation

| Risk | Mitigation | Status field |
|------|-----------|--------------|
| `path.basename('/Users/x')` returns `'x'` not `(home)` | Compare to `os.homedir()` BEFORE basename | addressed_in: `src/data.js displayProject` + test `(home) for homedir` |
| Datalist `<input list>` allows free text not in list → user types "Max 5x" (ASCII x, not ×) → no price autofill | Match case-insensitive AND normalize × ↔ x in `onSubPlanChange` | addressed_in: `onSubPlanChange` (existing toLowerCase already there; add `.replace(/x/g, '×')` symmetric match) |
| Old localStorage entry without `kind` field after Phase 4.5 migration is in-memory only — if user removes one entry, save persists migrated form → fine, but if user has 2 tabs open and one tab pre-migration writes back, kind is lost | Tab-collision rare; on next read we re-migrate. Accept. | accepted_because: rare edge case, no data loss possible |
| `removeSubEntry(i)` uses combined-array index; after splitting render into 2 groups, group-loop index ≠ combined index | Pass original index from filter loop, not enumeration of filtered array | addressed_in: Phase 5.2 (explicit comment in code) |
| Datalist plan dropdown does not "open like a select" on click — only on typing in some browsers | Acceptable UX trade-off; documented; if user complains we switch to `<select>` later | accepted_because: matches existing form pattern, less invasive |
| 100+ subscription entries render unbatched DOM | Pre-aggregate into 2 subtotals; entries list is fast (<200ms for 100 rows in plain HTML) | accepted_because: realistic max is ~20 entries; if exceeded, add virtualization in later PR |
| Hardcoded prices stale within 6 months | Comment "verified 2026-05-15" + user can override paid value manually | accepted_because: prices change rarely, code is single source of truth and easy to edit |
| Credential / token leakage in pricing fetch | N/A — WebSearch is read-only on public pages, no auth | accepted_because: no auth boundary touched |

## Acceptance criteria (mapped to BDD)

- [x] BDD Cat-1: 3 scenarios — `onSubServiceChange` + `onSubPlanChange` + new `addSubEntry` with `kind`
- [x] BDD Cat-2: empty state in render
- [x] BDD Cat-3: loading skeleton (already implemented; verify not regressed)
- [x] BDD Cat-4: `updateAddButtonState` + validation + Qwen/Kilo helper + corrupted-JSON guard
- [x] BDD Cat-5: tab order (no JS changes — use existing flex DOM order), Enter→submit handler, aria-label on remove (existing)
- [x] BDD Cat-6: `displayProject` covers all path cases; ellipsis CSS for long plans; legacy migration

## Files changed (final count)

| File | Lines changed |
|------|---------------|
| `src/data.js` | +20 (helper) / -1 (replace line 4873) |
| `src/frontend/app.js` | +35 (SERVICE_PLANS extension, new updateAddButtonState, migration, kind in addSubEntry) / -20 (replaced SERVICE_PLANS, addSubEntry) |
| `src/frontend/analytics.js` | +25 (subgroup rendering, labels, aria-live, hint line) / -5 |
| `src/frontend/styles.css` | +15 |
| `test/displayProject.test.js` | new, ~30 |
| `docs/design/analytics-subscriptions.md` | already written |
| `specs/analytics-subscriptions.feature` | already written |
| `tasks/2026-05-15-analytics-subscriptions/plan.md` | this file |
| `tasks/2026-05-15-analytics-subscriptions/smoke-report.md` | written at Phase 7 |

**Total**: 4 source files modified, 1 test file new, ~120 net LOC.
