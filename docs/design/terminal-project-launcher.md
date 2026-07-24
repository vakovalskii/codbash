# Terminal Project Launcher

## Цель

Дать возможность из вкладки **«Терминал» (Workspace)** одним контролом выбрать
зарегистрированный проект и открыть в его папке in-app терминал — либо чистый
(без агента), либо с автозапуском последнего/выбранного агента — по той же
модели, что и лаунчер на вкладке **Projects**.

## Проблема (текущее состояние)

- Новая вкладка терминала открывает pane в **домашней папке** пользователя.
- Per-pane меню `Launch ▾` (`launchAgentInPane`) запускает агента, но **в текущей
  папке pane** — то есть для свежей вкладки агент стартует в `~`, а не в проекте
  (агенты кёйят историю по `cwd`, поэтому диалог «теряется» — известная ловушка,
  см. `msg.cwdFellBack` guard в `workspace.js`).
- Чтобы открыть терминал в папке проекта, надо уйти на вкладку **Projects** и
  использовать select «⊞ Terminal ▾» (`spawnProjectTerminals`) — но он открывает
  **только чистые** панели, без агента.
- Единого «выбрать проект + (опц.) запустить агента» прямо в Терминале нет.

## Инвентаризация данных (переиспользуем, ничего нового на бэкенде)

| Источник | Что даёт |
|----------|----------|
| `window.manualProjects` (`GET /api/projects/manual`) | реестр проектов: `{id,name,path,source,exists,git,remoteUrl}` |
| `window.installedAgents` (`GET /api/agents/installed`) | установленные агенты `{id,label}` |
| `window.codbashSettings` (`GET /api/settings`) | `defaultAgent`, `lastUsedByPath` |
| `pickPreferredTool(path,null)` (app.js) | last-used → default → первый установленный |
| `agentLabel(id)` (app.js) | человекочитаемое имя агента |
| `WORKSPACE_AGENTS` (workspace.js) | команда запуска агента (`claude`, `codex`, …) |
| `openInWorkspace({name,cwd,cmd})` (workspace.js) | открыть вкладку в папке; `cmd` **авто-запускается** только если папка открылась (иначе fallback в `~` без запуска) |

Все глобальные символы доступны в общем scope (frontend без модулей — app.js и
workspace.js инлайнятся в одну страницу).

## Карта компонентов

- **Потребитель**: только фронтенд вкладки Workspace (`src/frontend/workspace.js`).
- **Бэкенд**: изменений нет — запуск идёт через уже существующий in-app pty
  (`openInWorkspace` → WS `/ws/terminal`).
- **Покрытие деплоев**: правка чисто во фронте → одинаково работает в npm-CLI
  (браузер) и в подписанном desktop-app (Electron оборачивает тот же сервер).

## Контракт (внутренние функции workspace.js)

```
openWorkspaceProjectLauncher(event)          // открыть popover, якорь = кнопка
filterWorkspaceProjectLauncher(value)        // перерисовать строки по фильтру
_wsProjectLauncherRowsHtml(filter)           // HTML строк проектов
wsLaunchProjectTerminal(projPath, projName)  // чистый терминал в папке (без агента)
wsLaunchProjectAgent(projPath, projName, tool) // терминал в папке + автозапуск агента
_wsCloseProjectLauncher()                    // закрыть + вернуть фокус
```

`tool` → команда через lookup в `WORKSPACE_AGENTS` (по `cmd`/`id`); если агента
нет в списке — используем сам `id` как команду (best-effort, как per-pane launch).

## Поведение выбора агента

- «▶ ‹agent›» использует `pickPreferredTool(projPath, null)` (last-used → default
  → первый установленный).
- Select «Agent ▾» — явный выбор из `window.installedAgents`; при выборе обновляем
  **in-memory** `window.codbashSettings.lastUsedByPath[projPath] = tool`, чтобы
  метка «▶ ‹agent›» в этой сессии отражала выбор.

  > **assumption**: серверную персистентность last-used для Workspace-запусков не
  > делаем — `PUT /api/settings` принимает только `defaultAgent`, а `lastUsedByPath`
  > пишется сервером лишь через `/api/launch` (нативный терминал). In-app запуски
  > эфемерны. Персистентность — follow-up (потребует расширения `PUT /api/settings`).

## Стыки (какие файлы менять)

- `src/frontend/workspace.js` — кнопка «＋ Project» в тулбаре `.ws-tools`, popover,
  хендлеры запуска. Переиспользует `openInWorkspace`.
- `src/frontend/styles.css` — стили popover (переиспользуем токены `.agent-picker`
  / launcher-карточек для консистентности).

## Риски

| Риск | Митигация |
|------|-----------|
| Агент, запущенный в отсутствующей папке, миспишет историю | `openInWorkspace` уже не авто-запускает `cmd` при `cwdFellBack`; отсутствующие проекты (`exists===false`) показываем disabled |
| Popover перекрывает терминал / не закрывается | Escape + outside-click + close-on-scroll (паттерн `openAgentPicker`) |
| Много проектов — длинный список | Фильтр по имени/пути + скролл-контейнер |
| Нет установленных агентов | Прятать ▶/select, оставлять только ⊞ Terminal |
| XSS через имя/путь проекта | Всё через `escHtml` (как в остальном UI) |

## UX & Accessibility

**Целевой WCAG-уровень**: AA.

**Required UI states**:
- [x] Loading — данные (`manualProjects`/`installedAgents`) уже загружены при init;
      если пусто на момент открытия — показываем empty/hint, не спиннер.
- [x] Empty — нет зарегистрированных проектов → «No projects yet — add them on the
      Projects tab» + ссылка-переход на Projects.
- [x] Error — папка проекта отсутствует (`exists===false`) → строка disabled с
      пометкой «missing»; запуск в fallback-папку не происходит (guard в pty ready).
- [x] Success — новая вкладка терминала открывается и активируется; агент виден в
      статус-баре pane.
- [x] Disabled — нет агентов → только ⊞ Terminal; отсутствующая папка → без действий.
- [ ] Partial/Stale — N/A (список читается синхронно из уже загруженного стейта).
- [ ] Optimistic — N/A.

**Клавиатура**:
- Кнопка «＋ Project» — обычный таб-стоп; открытие по Enter/Space.
- При открытии фокус уходит в поле фильтра.
- Tab/Shift+Tab циклит по строкам/кнопкам; Escape закрывает и возвращает фокус на
  кнопку-якорь.
- Native `<select>` для выбора агента — доступен с клавиатуры из коробки.
- Visible focus ring не убираем.

**Screen reader**:
- Popover — `role="dialog"` `aria-label="Launch in a project"`.
- Список — `role="list"`, строки — `role="listitem"`.
- Кнопки запуска имеют `aria-label` вида «Open terminal in ‹project›» / «Launch
  ‹agent› in ‹project›».
- Поле фильтра — `<label>`/`aria-label="Filter projects"`.

**Touch targets**: кнопки/строки ≥ 44×44 (используем существующие размеры кнопок).

**Responsive**: popover с `max-width`/`max-height` + внутренний скролл; на узком
экране клампится к вьюпорту (как `agentPicker`).
