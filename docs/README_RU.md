# CodeDash

Дашборд + CLI для сессий AI-агентов. 6 агентов: Claude Code, Codex, Cursor, GitHub Copilot (VS Code), OpenCode, Kiro.

[English](../README.md) | [Chinese / 中文](README_ZH.md)

## Быстрый старт

```bash
npm i -g codedash-app && codedash run
```

## Поддерживаемые агенты

| Агент | Формат | Статус | Конвертация | Запуск |
|-------|--------|--------|-------------|--------|
| Claude Code | JSONL | LIVE/WAITING | Да | Терминал / cmux |
| Codex CLI | JSONL | LIVE/WAITING | Да | Терминал |
| Cursor | JSONL | LIVE/WAITING | - | Open in Cursor |
| GitHub Copilot (VS Code) | JSONL | - | - | Open in VS Code |
| OpenCode | SQLite | LIVE/WAITING | - | Терминал |
| Kiro CLI | SQLite | LIVE/WAITING | - | Терминал |

## Возможности

- Grid/List, группировка по проектам, trigram поиск + deep search
- GitHub-стиль SVG heatmap активности со стриками
- LIVE/WAITING бейджи для локальных agent-процессов, анимированная рамка
- Session Replay с ползунком, hover превью, раскрытие карточек
- Аналитика стоимости из реальных usage данных
- Конвертация сессий Claude <-> Codex, Handoff между агентами
- Export/Import для миграции на другой ПК
- Темы: Dark, Light, System

## CLI

```bash
codedash run | search | show | handoff | convert | list | stats | export | import | update | restart | stop
```

## Требования

- Node.js >= 18, macOS / Linux / Windows

## Лицензия

MIT
