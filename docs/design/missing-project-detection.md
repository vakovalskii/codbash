# Missing-project detection + re-clone offer

## Цель
Когда зарегистрированный проект удалён/перемещён на диске, Projects-лаунчер должен
это заметить: показать дисклеймер на плитке и, при попытке запуска, вернуть понятную
ошибку «папка отсутствует» с предложением заново скачать актуальную версию с GitHub.

## Проблема
`projects.json` хранит путь проекта. Если пользователь удалил репо (`rm -rf`),
плитка остаётся, а запуск (`POST /api/launch`) падает с общей ошибкой
`invalid or unsafe project path` — пользователь не понимает причину.

## Данные
- Реестр: `~/.codedash/projects.json` — `{ id, name, path, source, remoteUrl, defaultBranch }`.
- Признак существования на диске выводится динамически (`fs.statSync().isDirectory()`),
  в файл не пишется — состояние диска может меняться между запросами.

## Изменения API
- `GET /api/projects/manual` — к каждому проекту добавляется `exists: boolean`.
  `git` вычисляется только когда `exists === true`.
- `POST /api/launch` — если `project` передан и папки нет на диске, вернуть
  `400 { ok:false, error:'project folder is missing on disk', missing:true,
  remoteUrl, projectId }` вместо общей ошибки. Проверка идёт до `isSafeLaunchPath`,
  чтобы отличить «удалено» от «небезопасный путь».
- `POST /api/projects/reclone` — новый маршрут. Тело `{ id }`. Находит проект в
  реестре, требует непустой `remoteUrl`, клонирует `remoteUrl` в **исходный** `path`
  (не в свежий `~/code/<repo>`), чтобы восстановить папку ровно там, где она была.
  Переиспользует `cloneRepo` (та же защита: только GitHub-remote, назначение под `$HOME`,
  существующий-тот-же-repo → успех).

## Стыки
- `src/projects.js` — новый экспорт `pathExists(p)`; `cloneRepo` переиспользуется.
- `src/server.js` — GET manual enrich, launch guard, новый reclone-маршрут.
- `src/frontend/app.js` — `mergeRegistryWithSessions` пробрасывает `_exists`/`_remoteUrl`;
  `renderLauncherCard` рисует missing-состояние; `recloneProject()`; launch-функции
  обрабатывают `data.missing`.
- `src/frontend/styles.css` — `.launcher-card-missing`, `.launcher-card-warning`.

## UX & Accessibility
**Required UI states:**
- [x] Normal — папка на месте: обычные кнопки запуска.
- [x] Missing — папка удалена: дисклеймер `role="status"`, кнопки «Re-clone» (если есть
      GitHub-remote) и «Remove»; кнопки запуска скрыты.
- [x] Loading — кнопка Re-clone: `disabled` + текст «Cloning…».
- [x] Error — reclone/launch fail: toast с текстом ошибки, кнопка возвращается в исходное.
- [x] Success — toast «Re-cloned … from GitHub», перезагрузка реестра → плитка снова обычная.

**Keyboard/SR:** дисклеймер — `role="status"` (объявляется screen reader'ом); кнопки
имеют `aria-label`; фокус-ринг наследуется от `.git-project-launch-btn:focus-visible`.

## Риски
- TOCTOU (папку удалили между рендером и кликом) — `addressed_in`: launch-guard в
  `/api/launch` возвращает `missing:true`; `handleMissingProjectLaunch` предлагает reclone.
- `missing:true` глобален для `/api/launch`, поэтому обрабатывается на ВСЕХ трёх точках
  запуска — `addressed_in`: `app.js launchNewProjectSession`/`resumeLastProjectSession` и
  `detail.js launchSession` (session-detail «Resume»).
- Symlink-ancestor обход home-containment в `cloneRepo` (окно «папка отсутствует») —
  `addressed_in`: `projects.js realpathOfNearestAncestor` + `isUnderHome` перед `git clone`.
- reclone для manual-проекта вне `$HOME` или с non-GitHub remote — `cloneRepo` вернёт
  понятную ошибку, показываем toast (`addressed`: сообщение об ошибке).
- Проект без `remoteUrl` (локальная папка) — кнопка Re-clone не рисуется, только Remove.
- Параллельные reclone одного id — `addressed_in`: `_inFlightReclone` Set в `server.js` (409).
- HTTP-уровневые тесты новых маршрутов (`/api/launch missing`, `/api/projects/reclone`) —
  `deferred_to`: follow-up. `startServer` не имеет teardown-seam (интервалы autoSync/heartbeat
  держат event loop), поэтому route-тест требует рефактора извлечения маршрутов. Interim
  evidence: scratchpad smoke (register → delete → `exists:false` → `missing:true` → reclone
  guardrails) — GREEN. Unit-тесты `pathExists`/`cloneRepo` покрыты.
- Systemic (pre-existing, не в этом PR): mutating POST-маршруты не проверяют `Origin` —
  `deferred_to`: отдельный follow-up (repo-wide CSRF hardening).
