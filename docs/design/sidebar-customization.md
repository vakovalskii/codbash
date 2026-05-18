# Sidebar Customization — design

## Goal

Let users group, collapse, and hide sidebar entries so the left rail matches how they actually work. Default behavior is unchanged for first-time users; preferences persist locally.

```
Sidebar (after change)
├── Workspace      (collapsible section, default expanded)
│     All Sessions · Projects · Timeline · Activity · Running
│     Analytics · Starred · Leaderboard · Cloud Sync
├── Agents         (collapsible, default expanded)
│     Claude · Codex · Qwen · Kiro · Cursor · Copilot Chat · Copilot CLI · OpenCode · Kilo
└── Tools          (collapsible, default expanded)
      ├── Install agents   (nested collapsible, default collapsed)
      │     Claude · Codex · Qwen · Kiro · OpenCode · Kilo · Copilot CLI
      ├── Export / Import
      ├── Changelog
      └── Settings   (gains new "Sidebar" sub-pane)
```

## Why

Сейчас сайдбар — 30+ пунктов одним списком, в нём есть редко используемые (Leaderboard, Cloud Sync, Starred) и шумная «Install Agents» секция с 7 повторяющимися записями. У разных пользователей разные интересы (только Claude + Projects + Running у одного, Cursor + Activity + Analytics у другого). Группировка + видимость каждого пункта решают это без удаления функциональности.

## Non-goals

- Не меняем поведение самих вкладок (Activity bug — отдельный PR, см. CLAUDE.md TODO).
- Не добавляем drag-and-drop переупорядочивания (вне scope этого PR).
- Не трогаем серверные API, файлы сессий, формат `~/.codedash/settings.json`.
- Не добавляем синхронизацию настроек между устройствами — все только в `localStorage`.
- Не делаем «скрытый пункт остаётся доступен через URL hash» как UX-фичу — но `data-view` атрибуты остаются на месте, поэтому хеш-роутинг (`#leaderboard`) технически продолжит работать; в навигации просто не будет ссылки.

## Data inventory

Где читаются/пишутся sidebar items сейчас:

| Источник | Файл | Роль |
|---|---|---|
| HTML | `src/frontend/index.html:11-141` | статичная разметка `<div class="sidebar">` с `.sidebar-item[data-view]` |
| Click handler | `src/frontend/app.js` | делегированный listener на `.sidebar-item`, читает `data-view`, выставляет `currentView` |
| Hash routing | `src/frontend/app.js` (`hashchange` / `onload`) | `window.location.hash` → `currentView` |
| Style | `src/frontend/styles.css` | `.sidebar`, `.sidebar-item`, `.sidebar-section`, `.sidebar-divider` |
| Settings page | `src/frontend/app.js:2173` (`renderSettings`) | в неё добавим **Sidebar** sub-pane |

Что добавляем:

| Ключ `localStorage` | Тип | Default | Назначение |
|---|---|---|---|
| `codedash-sidebar-config` | JSON-string | см. ниже | видимость пунктов + collapsed-состояния секций |

Схема `codedash-sidebar-config`:

```ts
interface SidebarConfig {
  // Visibility map: data-view (для верхних/agents/Settings/Changelog) или install-key (для install) → true/false.
  // Отсутствие ключа === видимый (default-on). Только явный false скрывает.
  hidden: { [itemKey: string]: true };

  // Collapsed sections. Key = section id ("workspace" | "agents" | "tools" | "install-agents").
  // Отсутствие === default expanded state из таблицы выше.
  collapsed: { [sectionId: string]: boolean };

  // Schema version for future migrations.
  v: 1;
}
```

Префикс ключа — `codedash-` (legacy, как у всех остальных настроек проекта).

### Item keys

| Key | Source | Default visible |
|---|---|---|
| `sessions`, `projects`, `timeline`, `activity`, `running`, `analytics`, `starred`, `leaderboard`, `cloud` | data-view of Workspace items | yes |
| `claude-only`, `codex-only`, `qwen-only`, `kiro-only`, `cursor-only`, `copilot-chat-only`, `copilot-only`, `opencode-only`, `kilo-only` | data-view of Agents items | yes |
| `install:claude`, `install:codex`, `install:qwen`, `install:kiro`, `install:opencode`, `install:kilo`, `install:copilot` | composite key (no data-view today) | yes |
| `export-import`, `changelog`, `settings` | new (we add `data-view`/key to existing items) | yes |

Settings is **always** visible regardless of config — это safety: иначе пользователь скрыл Settings и не может вернуть видимость. Toggle для Settings в UI просто не показываем.

## Component map

| Файл | Изменение |
|---|---|
| `src/frontend/index.html` | Разметка переписывается под 3 секции `<div class="sidebar-section" data-section="<id>">` с заголовком `<button class="sidebar-section-header">…</button>` и контейнером `.sidebar-section-body`. Install agents — вложенный аналогичный блок внутри Tools. На каждом item, у которого его нет — добавить `data-key` (для install-кнопок) и `data-view="changelog/settings"` (уже есть). У `Export / Import` добавляем `data-key="export-import"`. |
| `src/frontend/app.js` | (a) `loadSidebarConfig()` / `saveSidebarConfig()` — read/write `localStorage`. (b) `applySidebarConfig()` — на старте и после изменений: проходит по `.sidebar-item[data-view],[data-key]`, ставит `style.display='none'` для скрытых; на `.sidebar-section[data-section]` выставляет `.collapsed` класс. (c) Делегированный click на `.sidebar-section-header` — toggle collapsed, save, applySidebarConfig. (d) В `renderSettings` добавить группу «Sidebar» с чек-листом всех item keys по секциям + кнопку «Reset to defaults». (e) Hash-router не меняем. |
| `src/frontend/styles.css` | `.sidebar-section[data-section]` — flex column; `.sidebar-section-header` — кликабельный заголовок с chevron (▾/▸); `.sidebar-section.collapsed > .sidebar-section-body { display: none }`. Вложенная секция `[data-section="install-agents"]` — отступ слева на 8px. Sub-pane Sidebar в Settings: список с чекбоксами. |

## API/IPC contract

Серверные API не трогаем. Все изменения — фронт.

## State machine

```
Sidebar-config lifecycle:
  page load
    └─ loadSidebarConfig() → applySidebarConfig() → render

  user clicks section header
    └─ toggle collapsed[id] → saveSidebarConfig() → CSS update via class

  user toggles item in Settings → Sidebar pane
    └─ flip hidden[key] → saveSidebarConfig() → applySidebarConfig()

  user clicks "Reset to defaults"
    └─ remove `codedash-sidebar-config` → applySidebarConfig() (now no-op)
       → re-render Settings to reflect cleared checkboxes
```

Запрещённые переходы:
- Settings нельзя скрыть (UI просто не предлагает toggle).
- Скрыть текущую active view допустимо, но при следующем рендере active-индикатор не показывается (вкладка работает по hash, доступ остаётся).

## UX & Accessibility

**Целевой WCAG-уровень**: AA.

**Required UI states** на новой Sidebar sub-pane:
- [x] Loading — N/A: чтение из localStorage синхронно.
- [x] Empty — N/A: список item-ов фиксированный, всегда непустой.
- [x] Error — JSON.parse fail → silently reset to defaults + console.warn (не показываем ошибку пользователю, это безопасный fallback).
- [x] Success / Confirmation — клик по чекбоксу мгновенно скрывает/показывает пункт в сайдбаре, изменение видно сразу (= встроенный confirmation).
- [x] Disabled — Settings toggle помечен `disabled` + tooltip «Settings is always visible».
- [x] Partial / Stale — N/A.
- [x] Optimistic / Pending — N/A (всё локально, синхронно).

**Клавиатура**:
- Заголовки секций — `<button>` с реальным `aria-expanded="true|false"`, `aria-controls="<body-id>"`. Tab по ним работает по умолчанию.
- Enter/Space — toggle (нативное поведение `<button>`).
- Чекбоксы в Settings — нативные `<input type="checkbox">`, label кликабелен.
- Visible focus ring сохраняем — `:focus-visible` не убираем.

**Screen reader**:
- `aria-expanded` на section header — анонс при раскрытии.
- `aria-controls` связывает кнопку с телом секции.
- Каждый чекбокс в Settings имеет `<label>` с человекочитаемым текстом ("All Sessions", "Leaderboard", ...) и hint (например "Hidden — accessible via URL hash").

**Touch targets**: section header ≥ 36px (как `.sidebar-item` сейчас); чекбоксы со своими label обёрнуты в кликабельную область высотой 32px.

**Responsive**: сайдбар уже фиксированной ширины; не трогаем breakpoints.

**Performance budget**: одна-две `localStorage` операции на toggle (<1ms). Перерисовка Settings — небольшая. LCP не затрагивается, потому что код инициализации (applySidebarConfig) выполняется только над уже отрендеренным DOM.

## Стыки (existing files we touch)

1. `src/frontend/index.html` (11–141) — рерайт sidebar.
2. `src/frontend/app.js` — добавить ~120 строк (config + apply + settings sub-pane).
3. `src/frontend/styles.css` — добавить ~40 строк CSS.
4. `test/` — новый файл `test/sidebar-config.test.js` (node:test) для pure-funcs (`loadSidebarConfig`, `applyHiddenToItems`).

## Risks

| Риск | Mitigation |
|---|---|
| Пользователь скрыл Settings → не может вернуть видимость | Settings всегда видим, toggle для него `disabled` + объяснение |
| Невалидный JSON в `localStorage` (ручная правка) | `JSON.parse` в `try/catch` → fallback на дефолты + `localStorage.removeItem` |
| `applySidebarConfig` запускается до того, как DOM готов | Запускаем из existing `DOMContentLoaded` блока (он уже есть для других init-функций) |
| Скрытие active view ломает индикацию | Active class остаётся в HTML, но раз пункт `display:none`, юзер просто не видит. Hash-роутер всё ещё переключает контент. Документируем в hint в Sidebar sub-pane. |
| Конфликт ключа `claude-only` vs install-кнопки Claude | Install items получают префикс `install:claude` (key namespace), нет коллизии |
| Сломанная вёрстка в light/monokai темах | CSS использует CSS-переменные (`var(--text-muted)` и т.п.), как и существующие sidebar-классы |
| LocalStorage недоступен (приватный режим) | Try/catch вокруг `getItem`/`setItem`; на ошибке — конфиг живёт только в памяти, не падаем |
| `data-section` уже используется в репозитории | Проверить grep'ом перед стартом имплементации (отметить в плане) |

## Open questions (для тебя)

1. **Имя "Install agents" как сабсекции** — оставляем как есть, или укоротить до **"Install"**? (короче = чище в раскрытом виде)
2. **Default-collapsed для Install agents** — да (как написано), или раскрыто по умолчанию? Скрытие по умолчанию — потому что у большинства пользователей агенты уже стоят и эта секция нужна редко.
3. **Reset to defaults** — кнопка-ссылка в Sidebar sub-pane, или confirm-dialog? Я предлагаю просто кнопку: настройка локальная, дёшево вернуть.

## Acceptance criteria

- [ ] Существующие пункты не пропадают, default state визуально совпадает с текущим (минус группировка).
- [ ] Заголовки Workspace/Agents/Tools кликабельны, состояние collapsed/expanded переживает reload.
- [ ] Settings → Sidebar pane перечисляет все item keys с чекбоксами; toggle мгновенно скрывает/показывает в навигации.
- [ ] Settings toggle сам по себе disabled.
- [ ] Перезагрузка страницы сохраняет все скрытые пункты.
- [ ] Reset to defaults — возвращает всё к видимому + все секции expanded (кроме Install agents).
- [ ] Hash-роутинг (`#leaderboard`) продолжает работать даже если Leaderboard скрыт.
- [ ] Тесты `test/sidebar-config.test.js` зелёные.
