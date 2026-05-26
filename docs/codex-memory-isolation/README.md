# Codex Memory Isolation

This folder tracks the Codbash fork work for Codex-only, project-isolated memory management.

## Goal

Build a local GUI workflow that turns noisy Codex conversation logs into isolated project memory:

- Sessions remain grouped by repository or working directory, not by unreliable generated titles.
- Each project owns its own `.codex-memory/` directory.
- `.codex-memory/` is ignored by git by default.
- OpenAI APIs generate titles, summaries, decisions, open threads, and embeddings.
- Similar sessions are clustered inside a project first; cross-project similarity is only advisory.
- Deletion remains a backed-up delete, using the Codex deletion path added in `034c481`.

## Non-Goals

- Managing Claude, Gemini, Cursor, or other agent histories.
- Storing project memory in `~/.codex/memories` or any global memory folder.
- Auto-merging memory across projects.
- Sending sessions to non-configured external services.
- Replacing Codex's native `resume` and `fork` commands.

## Documents

- `implementation-plan.md` - executable development plan for the next build stages.

## Current Baseline

Branch: `feat/codex-memory-isolation`

Completed:

- Codex session deletion now backs up before deleting.
- Deletion removes Codex session JSONL, `history.jsonl`, `session_index.jsonl`, and attempts to remove the `state_5.sqlite` thread row.
- Test coverage exists in `test/codex-delete.test.js`.

## Desired Project Memory Layout

```text
<project>/.codex-memory/
  manifest.json
  sessions.index.json
  clusters.json
  context.md
  decisions.md
  open-threads.md
  summaries/
    <session-id>.md
  embeddings/
    <session-id>.json
```

## Default Safety Rules

1. Add `.codex-memory/` to the project `.gitignore` during initialization.
2. Keep raw Codex JSONL files out of project memory.
3. Store summaries and embeddings per project, never globally.
4. Before deleting Codex sessions, use the existing backed-up delete path.
5. Treat cross-project similarity as a suggestion, not a merge operation.
