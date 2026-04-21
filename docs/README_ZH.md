# Codbash

AI 编程代理会话仪表板 + CLI。支持 7 个代理：Claude Code、Codex、Cursor、OpenCode、Kiro、Kilo、Copilot Chat。

[English](../README.md) | [Russian / Русский](README_RU.md)

## 快速开始

```bash
npm i -g codbash-app && codbash run
```

## 支持的代理

| 代理 | 格式 | 实时状态 | 转换 | 启动 |
|------|------|----------|------|------|
| Claude Code | JSONL | LIVE/WAITING | 是 | 终端 / cmux |
| Codex CLI | JSONL | LIVE/WAITING | 是 | 终端 |
| Cursor | JSONL | LIVE/WAITING | - | 在 Cursor 中打开 |
| OpenCode | SQLite | LIVE/WAITING | - | 终端 |
| Kiro CLI | SQLite | LIVE/WAITING | - | 终端 |
| Copilot Chat | JSON/JSONL | - | - | - |

## 功能

- 网格/列表视图、项目分组、Trigram 搜索 + 深度搜索
- GitHub 风格 SVG 活动热力图
- 所有代理的 LIVE/WAITING 徽章
- 会话回放、成本分析、跨代理转换和交接
- 导出/导入迁移、Dark/Light/System 主题

## CLI

```bash
codbash run | search | show | handoff | convert | list | stats | export | import | update | restart | stop
```

## 要求

- Node.js >= 18, macOS / Linux / Windows

## 许可证

MIT
