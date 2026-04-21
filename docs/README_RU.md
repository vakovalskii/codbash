# Codbash

Дашборд + CLI для сессий AI-агентов. 7 агентов: Claude Code, Codex, Cursor, OpenCode, Kiro, Kilo, Copilot Chat.

[English](../README.md) | [Chinese / 中文](README_ZH.md)

## Быстрый старт

```bash
npm i -g codbash-app && codbash run
```

## Поддерживаемые агенты

| Агент | Формат | Статус | Конвертация | Запуск |
|-------|--------|--------|-------------|--------|
| Claude Code | JSONL | LIVE/WAITING | Да | Терминал / cmux |
| Codex CLI | JSONL | LIVE/WAITING | Да | Терминал |
| Cursor | JSONL | LIVE/WAITING | - | Open in Cursor |
| OpenCode | SQLite | LIVE/WAITING | - | Терминал |
| Kiro CLI | SQLite | LIVE/WAITING | - | Терминал |
| Copilot Chat | JSON/JSONL | - | - | - |

## Возможности

- Grid/List, группировка по проектам, trigram поиск + deep search
- GitHub-стиль SVG heatmap активности со стриками
- LIVE/WAITING бейджи для всех агентов, анимированная рамка
- Session Replay с ползунком, hover превью, раскрытие карточек
- Аналитика стоимости из реальных usage данных
- Конвертация сессий Claude <-> Codex, Handoff между агентами
- Export/Import для миграции на другой ПК
- Темы: Dark, Light, System

## CLI

```bash
codbash run | search | show | handoff | convert | list | stats | export | import | update | restart | stop
```

## Требования

- Node.js >= 18, macOS / Linux / Windows

## Лицензия

MIT
