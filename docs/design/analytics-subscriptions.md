# Analytics — Subscriptions & Project Name Display

> Scope: расширение управления подписками на вкладке Analytics + фикс отображения имени проекта в Cost by Project / Most Expensive Sessions.

## Цель

1. **Subscriptions UI**: пользователь добавляет запись о платной подписке через два связанных выпадающих списка — «Service» → «Plan». При выборе плана поле «Paid ($)» автозаполняется. Поддерживаются все 7 агентов из codbash + опция `API (custom)` для учёта пополнений баланса API.
2. **API deposits**: тот же UI, но при выборе `API (custom)` план превращается в свободный ввод (название провайдера) и сумма вводится вручную. MVP — только пополнения; учёт реального расхода API против баланса — отдельная задача.
3. **Project name fix**: в `Cost by Project` и `Most Expensive Sessions` отображать basename папки (`codbash` вместо `~/code/codbash`). Сессии с `projectPath === $HOME` группировать как `(home)`.

## Инвентаризация данных

| Где | Что |
|-----|-----|
| `src/frontend/app.js:251` | `SERVICE_PLANS` — нужно расширить с 5 до 9 сервисов + API |
| `src/frontend/app.js:276` | `onSubServiceChange` — добавить ветку для `API` (план = свободный input) |
| `src/frontend/app.js:293` | `onSubPlanChange` — автоподстановка цены (без изменений по логике, расширяется через SERVICE_PLANS) |
| `src/frontend/app.js:307` | `getSubscriptionConfig` / `saveSubscriptionConfig` — формат записи нужно расширить (`kind: 'subscription' \| 'api'`) с обратной совместимостью |
| `src/frontend/analytics.js:285` | Cost by Project — рендер `data.byProject`; имя берётся из ключа |
| `src/frontend/analytics.js:309` | Most Expensive Sessions — `s.project` (приходит из API как `project_short`) |
| `src/data.js:4873` | Где формируется `byProject` — `proj = s.project_short \|\| s.project \|\| 'unknown'` |
| `src/data.js` (~20 мест) | Где выставляется `project_short` через `.replace(os.homedir(), '~')` |

## Карта компонентов

```
Analytics tab
└─ Subscription section (existing)
   ├─ Service dropdown      ← расширяется (9 опций + "API (custom)")
   ├─ Plan dropdown         ← перерисовывается на основе SERVICE_PLANS[service]
   ├─ Paid ($) input        ← autopulls на основе SERVICE_PLANS[service].plans[plan].price
   ├─ From date
   └─ Add → addSubEntry() → localStorage codedash-subscription

Analytics tab
└─ History pane
   ├─ Cost by Project       ← key из byProject (server side)
   └─ Most Expensive Sessions ← s.project из топ-сессий

Server (data.js)
└─ build*Analytics() → byProject{} keyed by displayProject()
   └─ displayProject(s) helper (NEW) — единая логика basename / (home) / unknown
```

## Модель данных

### LocalStorage `codedash-subscription`

**Текущая версия (с миграцией поддерживается)**:
```js
{ entries: [{ service, plan, paid, from }] }
```

**Новая версия (обратно-совместима)**:
```js
{
  entries: [
    {
      kind: 'subscription' | 'api',  // NEW; default 'subscription' для старых записей
      service: 'Claude Code',         // existing
      plan: 'Max 5×',                 // existing; для kind='api' — произвольная строка ("Anthropic API balance")
      paid: 100,                      // existing
      from: '2026-05-01'              // existing; для API трактуется как "deposit date"
    }
  ]
}
```

Миграция: запись без `kind` считается `subscription` (read-time fallback в `getSubscriptionConfig`). Существующий код `addSubEntry` пишет с `kind`.

### `SERVICE_PLANS` (расширенный)

```js
// Verified 2026-05-15 against vendor pricing pages (see sources below).
var SERVICE_PLANS = {
  'Claude Code':  { plans: [
    { name: 'Pro', price: 20 },
    { name: 'Max 5×', price: 100 },
    { name: 'Max 20×', price: 200 }
  ]},
  'ChatGPT/Codex':{ plans: [
    { name: 'Go', price: 8 },
    { name: 'Plus', price: 20 },
    { name: 'Pro', price: 200 }
  ]},
  'Cursor':       { plans: [
    { name: 'Pro', price: 20 },
    { name: 'Pro+', price: 60 },
    { name: 'Ultra', price: 200 }
  ]},
  'Copilot':      { plans: [
    { name: 'Pro', price: 10 },
    { name: 'Pro+', price: 39 },
    { name: 'Business', price: 19 },
    { name: 'Enterprise', price: 39 }
  ]},
  'Kiro':         { plans: [
    { name: 'Pro', price: 20 },
    { name: 'Pro+', price: 40 },
    { name: 'Power', price: 200 }
  ]},
  'OpenCode':     { plans: [
    { name: 'Go', price: 10 },
    { name: 'Zen', price: 20 }
  ]},
  'Qwen Code':    { plans: [], note: 'free / API-only' },
  'Kilo':         { plans: [], note: 'free / API-only' },
  'API (custom)': { plans: [], note: 'enter provider name and deposit amount' }
};
```

**Sources (verified 2026-05-15)**:
- Claude: `claude.com/pricing` — Pro $20, Max plans starting $100
- ChatGPT: `openai.com/chatgpt/pricing` — Go $8, Plus $20, Pro $200
- Cursor: `cursor.com/pricing` — Pro $20 / Pro+ $60 / Ultra $200
- Copilot: `github.com/features/copilot/plans` + `docs.github.com` — Pro $10, Pro+ $39, Business $19, Enterprise $39
- Kiro: `kiro.dev/pricing` — Pro $20, Pro+ $40, Power $200
- OpenCode: `opencode.ai/go` + `opencode.ai/zen` — Go $10, Zen $20

### `displayProject(session)` — серверный хелпер (новый)

```js
function displayProject(s) {
  const raw = s.project || s.project_short || '';
  if (!raw || raw === os.homedir() || raw === '~') return '(home)';
  // Если уже сокращено до ~/foo/bar — берём последний сегмент
  // Если полный путь /Users/x/code/foo — тоже последний сегмент
  return path.basename(raw) || 'unknown';
}
```

Используется в `data.js:4873` вместо `s.project_short || s.project || 'unknown'`. Также в формировании `sessionCosts` для `topSessions`.

## API контракт

`/api/analytics/cost` — без изменений по форме, меняется только содержимое:
- ключи `byProject` теперь basenames (`codbash`) или `(home)` или `unknown`
- `topSessions[].project` — тот же displayProject()

## UX & Accessibility

**Целевой WCAG-уровень**: AA.

**Required UI states** (для subscription form):
- [x] **Loading** — N/A, всё локально через localStorage
- [x] **Empty** — если нет записей: показывать `<empty-state>` с пояснением "Add your first subscription to see total monthly spend"
- [x] **Error** — `paid <= 0` или `service не выбран` → inline error возле кнопки Add; кнопка disabled пока поля невалидны
- [x] **Success** — после Add: запись появляется в таблице, total пересчитывается, форма очищается
- [x] **Disabled** — кнопка Add disabled когда поля невалидны; Plan disabled пока не выбран Service
- [x] **Partial/Stale** — N/A
- [x] **Optimistic** — N/A (localStorage синхронен)

**Клавиатурный сценарий**:
- Tab order: Service → Plan → Paid → From → Add
- Enter в Paid срабатывает как Add (если форма валидна)
- Visible focus ring на всех контролах (используем existing styles.css :focus-visible)
- На existing удалить-кнопках записи — `aria-label="Remove subscription entry"`

**Screen reader**:
- `<label for="sub-new-service">Service</label>` — для всех инпутов (сейчас часть без label)
- При Add: aria-live polite сообщение "Subscription added: $100 total/month"
- Empty-state — обычный текст в визибл блоке (не aria-hidden)

**Touch targets**: 44×44 (уже соблюдено в existing dropdown стилях, проверить новые).

**Responsive**: dropdown форма уже в flex-wrap; новый длинный список Service не должен ломать mobile — проверить на 375px.

**Performance**: N/A (никаких heavy operations не добавляется).

## Стыки (файлы к изменению)

| Файл | Изменение | Размер |
|------|-----------|--------|
| `src/frontend/app.js` | Расширить SERVICE_PLANS; обновить onSubServiceChange/onSubPlanChange для kind='api'; обновить addSubEntry для kind; миграция в getSubscriptionConfig | ~50 строк |
| `src/frontend/analytics.js` | Subscription-form: добавить labels, aria-live, empty-state. Validation/disabled-state. Опционально — разделение subscriptions/API в выводе. | ~30 строк |
| `src/data.js` | Новый helper `displayProject()` + использование в `byProject` агрегации (~3-4 точки) | ~15 строк |
| `specs/analytics-subscriptions.feature` | BDD сценарии (G3) | новый |
| `tasks/<id>/plan.md` | Implementation plan (G4) | новый |

Никаких новых внешних зависимостей. Backend остаётся zero-deps (codbash CLAUDE.md constraint).

## Риски

| Риск | Mitigation |
|------|-----------|
| Сломать существующие записи в localStorage у пользователей | Read-time миграция: запись без `kind` трактуется как `kind:'subscription'`. Не пишем в storage при чтении. |
| Цены в SERVICE_PLANS устареют | Прокомментировать дату в коде; user всё равно может переписать `paid` руками. Не критично. |
| `path.basename('/Users/x')` → 'x' (имя юзера) на macOS вместо `(home)` | Сравнивать с `os.homedir()` ДО basename. Покрывается тестом. |
| `byProject` ключи теперь могут конфликтовать (`api` папка из work/api и personal/api) | Принято — basename выбран сознательно. Если станет проблемой — switch на parent/basename. Документировано. |
| Длинный список из 9 сервисов на mobile (375px) | Проверить визуально в G6; уже flex-wrap. |
| Пользователь выбрал `Qwen Code` / `Kilo` (нет планов) | План dropdown пустой → форма disabled с подсказкой "This service is free / API-only — use 'API (custom)' instead". |

## Ветка и PR

Новая ветка: `feat/jack-analytics-subscriptions` (соответствует ~/CLAUDE.md namespace для NovakPAai → но в codbash CLAUDE.md использует `feat/` без префикса автора; следую codbash-конвенции → `feat/analytics-subscriptions`).

PR одним коммитом или 2 (feat + fix)? **Предлагаю один PR** — fix для project names тесно связан с UX обновлением Analytics; отдельный fix-PR создаст two-round review.
