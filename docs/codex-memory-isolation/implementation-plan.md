# Codex Memory Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Codex-only project-isolated memory management to Codbash, including project-local memory files, OpenAI summaries, embeddings, clustering, and GUI review actions.

**Architecture:** Reuse Codbash's existing Codex session loader, LLM configuration UI, and backed-up Codex delete path. Add a new backend module that writes memory into the selected project's `.codex-memory/` folder, then expose additive API routes and a GUI view for initialization, summarization, embedding, clustering, and deletion review.

**Tech Stack:** Node.js stdlib, Codbash zero-dependency frontend, existing OpenAI-compatible `chat/completions` client, new OpenAI-compatible `embeddings` client, JSON/Markdown project memory files, `node:test`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/codex-memory.js` | New backend module for project path validation, memory directory initialization, index writing, summary files, embedding files, cluster calculation, and `.gitignore` updates. |
| `src/server.js` | Add `/api/codex-memory/*` routes and reuse existing LLM config loading. |
| `src/data.js` | Export the minimal Codex detail helpers needed by `src/codex-memory.js`; keep session deletion unchanged except for existing backup flow. |
| `src/frontend/app.js` | Add Codex Memory view state, API calls, project selection, summary/embedding/cluster actions, and refresh behavior. |
| `src/frontend/index.html` | Add a sidebar entry or toolbar entry for Codex Memory using the existing sidebar pattern. |
| `src/frontend/styles.css` | Add compact operational UI styles for memory status, clusters, and review rows. |
| `test/codex-memory.test.js` | Unit tests for memory initialization, `.gitignore` update, index writing, summary writing, and clustering. |
| `test/codex-memory-api.test.js` | API tests for init, status, summarize, embeddings, clusters, and write context. |
| `docs/codex-memory-isolation/README.md` | Feature overview and safety rules. |
| `docs/codex-memory-isolation/implementation-plan.md` | This plan. |

## Data Contracts

### `.codex-memory/manifest.json`

```json
{
  "version": 1,
  "projectPath": "/home/kk/example-project",
  "projectKey": "example-project",
  "createdAt": "2026-05-26T00:00:00.000Z",
  "updatedAt": "2026-05-26T00:00:00.000Z",
  "source": "codbash",
  "agent": "codex"
}
```

### `.codex-memory/sessions.index.json`

```json
{
  "version": 1,
  "projectPath": "/home/kk/example-project",
  "updatedAt": "2026-05-26T00:00:00.000Z",
  "sessions": [
    {
      "id": "019e1234-1234-7000-8000-123456789abc",
      "title": "整理 Codex 记忆管理方案",
      "summaryPath": "summaries/019e1234-1234-7000-8000-123456789abc.md",
      "embeddingPath": "embeddings/019e1234-1234-7000-8000-123456789abc.json",
      "firstTs": 1779796800000,
      "lastTs": 1779799800000,
      "messages": 42,
      "decisionCount": 3,
      "openThreadCount": 2,
      "deleteRecommendation": "keep",
      "clusterId": "cluster-001"
    }
  ]
}
```

### `.codex-memory/clusters.json`

```json
{
  "version": 1,
  "projectPath": "/home/kk/example-project",
  "updatedAt": "2026-05-26T00:00:00.000Z",
  "threshold": 0.82,
  "clusters": [
    {
      "id": "cluster-001",
      "label": "Codex memory management",
      "sessionIds": ["019e1234-1234-7000-8000-123456789abc"],
      "deleteCandidates": [],
      "reason": "Sessions describe the same Codbash memory isolation work."
    }
  ]
}
```

### Summary Markdown

```markdown
# 整理 Codex 记忆管理方案

Session: `019e1234-1234-7000-8000-123456789abc`
Project: `/home/kk/codedash`
Recommendation: `keep`

## Summary

- Built the plan for project-isolated Codex memory management.

## Decisions

- Use project-local `.codex-memory/` instead of global Codex memory.

## Open Threads

- Add OpenAI embeddings and same-project clustering.

## Files Mentioned

- `src/data.js`
- `test/codex-delete.test.js`
```

## API Contract

### `GET /api/codex-memory/status?project=<abs-path>`

Response:

```json
{
  "ok": true,
  "initialized": true,
  "projectPath": "/home/kk/codedash",
  "memoryDir": "/home/kk/codedash/.codex-memory",
  "summaryCount": 12,
  "embeddingCount": 10,
  "clusterCount": 4,
  "ignoredByGit": true
}
```

### `POST /api/codex-memory/init`

Request:

```json
{ "project": "/home/kk/codedash" }
```

Response:

```json
{ "ok": true, "memoryDir": "/home/kk/codedash/.codex-memory", "created": true, "gitignoreUpdated": true }
```

### `POST /api/codex-memory/rebuild-index`

Request:

```json
{ "project": "/home/kk/codedash" }
```

Response:

```json
{ "ok": true, "indexed": 58, "path": "/home/kk/codedash/.codex-memory/sessions.index.json" }
```

### `POST /api/codex-memory/summarize`

Request:

```json
{ "project": "/home/kk/codedash", "sessionId": "019e1234-1234-7000-8000-123456789abc" }
```

Response:

```json
{ "ok": true, "summaryPath": "summaries/019e1234-1234-7000-8000-123456789abc.md", "title": "整理 Codex 记忆管理方案" }
```

### `POST /api/codex-memory/embed`

Request:

```json
{ "project": "/home/kk/codedash", "sessionId": "019e1234-1234-7000-8000-123456789abc" }
```

Response:

```json
{ "ok": true, "embeddingPath": "embeddings/019e1234-1234-7000-8000-123456789abc.json", "dimensions": 1536 }
```

### `POST /api/codex-memory/recluster`

Request:

```json
{ "project": "/home/kk/codedash", "threshold": 0.82 }
```

Response:

```json
{ "ok": true, "clusters": 4, "deleteCandidates": 3 }
```

## Task 1: Memory Directory Initialization

**Files:**
- Create: `src/codex-memory.js`
- Modify: `src/server.js`
- Test: `test/codex-memory.test.js`

- [ ] **Step 1: Write failing tests for initialization**

Add tests that create a temp project, initialize memory, and verify the directory layout and `.gitignore` entry.

```js
test('initProjectMemory creates project-local memory files and ignores them in git', () => {
  const project = tmpProject();
  const result = codexMemory.initProjectMemory(project);
  assert.equal(result.created, true);
  assert.equal(fs.existsSync(path.join(project, '.codex-memory', 'manifest.json')), true);
  assert.equal(fs.existsSync(path.join(project, '.codex-memory', 'summaries')), true);
  assert.equal(fs.existsSync(path.join(project, '.codex-memory', 'embeddings')), true);
  assert.match(fs.readFileSync(path.join(project, '.gitignore'), 'utf8'), /^\.codex-memory\/$/m);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
node --test test/codex-memory.test.js
```

Expected: FAIL with `Cannot find module '../src/codex-memory'`.

- [ ] **Step 3: Add `src/codex-memory.js` initialization functions**

Implement these exports:

```js
module.exports = {
  initProjectMemory,
  getProjectMemoryStatus,
  ensureGitignoreEntry,
  memoryPathsForProject,
};
```

Rules:

- `project` must be an absolute path.
- `project` must exist and be a directory.
- Memory files must be created under `<project>/.codex-memory`.
- `.gitignore` must contain exactly one `.codex-memory/` entry.
- JSON writes must use `atomicWriteJson`.

- [ ] **Step 4: Run the initialization test**

Run:

```bash
node --test test/codex-memory.test.js
```

Expected: PASS.

- [ ] **Step 5: Add API route tests**

Create `test/codex-memory-api.test.js` with `POST /api/codex-memory/init` and `GET /api/codex-memory/status` coverage.

- [ ] **Step 6: Add server routes**

Modify `src/server.js` to route:

```text
GET  /api/codex-memory/status
POST /api/codex-memory/init
```

Use the existing `readBody` and `json` helpers.

- [ ] **Step 7: Run API tests**

Run:

```bash
node --test test/codex-memory-api.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/codex-memory.js src/server.js test/codex-memory.test.js test/codex-memory-api.test.js
git commit -m "feat: initialize project-local codex memory"
```

## Task 2: Project Session Index

**Files:**
- Modify: `src/codex-memory.js`
- Modify: `src/data.js`
- Test: `test/codex-memory.test.js`

- [ ] **Step 1: Write failing index test**

Use mocked session objects filtered by `project` or `git_root`.

```js
test('rebuildProjectIndex writes only sessions for the selected project', () => {
  const project = tmpProject();
  codexMemory.initProjectMemory(project);
  const sessions = [
    { id: 'codex-a', tool: 'codex', project, git_root: project, first_ts: 1, last_ts: 2, messages: 3 },
    { id: 'claude-a', tool: 'claude', project, git_root: project, first_ts: 1, last_ts: 2, messages: 3 },
    { id: 'codex-b', tool: 'codex', project: '/elsewhere', git_root: '/elsewhere', first_ts: 1, last_ts: 2, messages: 3 }
  ];
  const result = codexMemory.rebuildProjectIndex(project, sessions);
  assert.equal(result.indexed, 1);
  const index = JSON.parse(fs.readFileSync(path.join(project, '.codex-memory', 'sessions.index.json'), 'utf8'));
  assert.deepEqual(index.sessions.map(s => s.id), ['codex-a']);
});
```

- [ ] **Step 2: Implement `rebuildProjectIndex(project, sessions)`**

Behavior:

- Include only `tool === 'codex'`.
- Match project by `session.git_root === project` or `session.project === project`.
- Keep stable sorted order by `last_ts` descending.
- Preserve existing summary and embedding paths when rebuilding.

- [ ] **Step 3: Export any needed helpers from `src/data.js`**

Keep exports narrow:

```js
module.exports = {
  ...existingExports,
  loadSessions,
  loadSessionDetail,
};
```

`loadSessions` and `loadSessionDetail` already exist; do not expose raw parser internals unless a test requires it.

- [ ] **Step 4: Add API route**

Add:

```text
POST /api/codex-memory/rebuild-index
```

Server reads sessions with `loadSessions()`, passes them to `rebuildProjectIndex`.

- [ ] **Step 5: Run tests**

Run:

```bash
node --test test/codex-memory.test.js test/codex-memory-api.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/codex-memory.js src/data.js src/server.js test/codex-memory.test.js test/codex-memory-api.test.js
git commit -m "feat: index codex sessions per project"
```

## Task 3: OpenAI Summary Generation

**Files:**
- Modify: `src/server.js`
- Modify: `src/codex-memory.js`
- Modify: `src/frontend/app.js`
- Test: `test/codex-memory.test.js`

- [ ] **Step 1: Write summary writer test**

```js
test('writeSessionSummary stores markdown and updates index metadata', () => {
  const project = tmpProject();
  codexMemory.initProjectMemory(project);
  codexMemory.rebuildProjectIndex(project, [{ id: 'codex-a', tool: 'codex', project, first_ts: 1, last_ts: 2, messages: 3 }]);
  const result = codexMemory.writeSessionSummary(project, 'codex-a', {
    title: '整理 Codex 记忆',
    summary: ['Built isolated memory planning.'],
    decisions: ['Use project-local .codex-memory/.'],
    openThreads: ['Add embeddings.'],
    filesMentioned: ['src/data.js'],
    deleteRecommendation: 'keep'
  });
  assert.equal(result.summaryPath, 'summaries/codex-a.md');
  assert.match(fs.readFileSync(path.join(project, '.codex-memory', 'summaries', 'codex-a.md'), 'utf8'), /整理 Codex 记忆/);
});
```

- [ ] **Step 2: Implement summary markdown writer**

Add:

```js
writeSessionSummary(project, sessionId, summary)
```

Accepted `deleteRecommendation` values:

```text
keep
duplicate
low-value
archive
```

- [ ] **Step 3: Split LLM calls into reusable functions**

Current title generation is embedded in `src/server.js`. Extract shared request logic into a server-local helper that supports:

```js
callChatCompletions(config, messages, options)
```

Keep the existing `/api/generate-title` behavior unchanged.

- [ ] **Step 4: Add summary prompt route**

Add:

```text
POST /api/codex-memory/summarize
```

Prompt response JSON shape:

```json
{
  "title": "整理 Codex 记忆管理方案",
  "summary": ["Built a fork plan for Codbash Codex memory isolation."],
  "decisions": ["Use project-local .codex-memory/ directories."],
  "openThreads": ["Add embedding-based clustering."],
  "filesMentioned": ["src/data.js", "test/codex-delete.test.js"],
  "deleteRecommendation": "keep"
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
node --test test/codex-memory.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server.js src/codex-memory.js src/frontend/app.js test/codex-memory.test.js
git commit -m "feat: summarize codex sessions into project memory"
```

## Task 4: Embeddings and Clustering

**Files:**
- Modify: `src/server.js`
- Modify: `src/codex-memory.js`
- Test: `test/codex-memory.test.js`

- [ ] **Step 1: Write cosine similarity test**

```js
test('clusterEmbeddings groups similar sessions above threshold', () => {
  const clusters = codexMemory.clusterEmbeddings([
    { sessionId: 'a', vector: [1, 0, 0], title: 'memory plan' },
    { sessionId: 'b', vector: [0.9, 0.1, 0], title: 'memory summary' },
    { sessionId: 'c', vector: [0, 1, 0], title: 'unrelated' }
  ], 0.8);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0].sessionIds, ['a', 'b']);
});
```

- [ ] **Step 2: Implement embedding file writer**

Add:

```js
writeSessionEmbedding(project, sessionId, vector, model)
```

File shape:

```json
{
  "version": 1,
  "sessionId": "codex-a",
  "model": "text-embedding-3-small",
  "dimensions": 1536,
  "vector": [0.01, 0.02]
}
```

- [ ] **Step 3: Add embeddings API route**

Add:

```text
POST /api/codex-memory/embed
```

Use OpenAI-compatible `/embeddings` with `config.url`, `config.apiKey`, and a model setting. If no embedding model is configured, default to `text-embedding-3-small`.

- [ ] **Step 4: Implement project reclustering**

Add:

```js
reclusterProject(project, threshold)
```

Rules:

- Read only embeddings in `<project>/.codex-memory/embeddings`.
- Write `clusters.json`.
- Update `clusterId` in `sessions.index.json`.
- Mark `deleteCandidates` only inside same-project clusters.

- [ ] **Step 5: Run tests**

Run:

```bash
node --test test/codex-memory.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server.js src/codex-memory.js test/codex-memory.test.js
git commit -m "feat: cluster codex memory with embeddings"
```

## Task 5: Codex Memory GUI

**Files:**
- Modify: `src/frontend/index.html`
- Modify: `src/frontend/app.js`
- Modify: `src/frontend/styles.css`
- Test: `test/frontend-escaping.test.js`

- [ ] **Step 1: Add navigation entry**

Add `codex-memory` to the sidebar using the existing sidebar configuration pattern.

- [ ] **Step 2: Render Codex Memory view**

View sections:

```text
Project selector
Memory status
Unprocessed sessions
Summary queue
Embedding queue
Clusters
Delete candidates
```

- [ ] **Step 3: Wire frontend actions**

Add functions:

```js
initCodexMemory(project)
rebuildCodexMemoryIndex(project)
summarizeCodexMemorySession(project, sessionId)
embedCodexMemorySession(project, sessionId)
reclusterCodexMemory(project)
deleteCodexMemoryCandidates(project, sessionIds)
```

- [ ] **Step 4: Keep deletion routed through existing API**

Use:

```text
DELETE /api/session/<sessionId>
```

The backend already backs up Codex artifacts before deleting.

- [ ] **Step 5: Run frontend syntax checks**

Run:

```bash
node --check src/frontend/app.js
node --test test/frontend-escaping.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/index.html src/frontend/app.js src/frontend/styles.css test/frontend-escaping.test.js
git commit -m "feat: add codex memory review UI"
```

## Task 6: Project Context Export

**Files:**
- Modify: `src/codex-memory.js`
- Modify: `src/server.js`
- Test: `test/codex-memory.test.js`

- [ ] **Step 1: Write context generation test**

```js
test('writeProjectContext creates a concise context markdown file', () => {
  const project = tmpProject();
  codexMemory.initProjectMemory(project);
  const result = codexMemory.writeProjectContext(project, {
    decisions: ['Use .codex-memory/ per project.'],
    openThreads: ['Connect context.md to Codex startup.'],
    recentSummaries: ['Added safe Codex deletion.']
  });
  assert.equal(result.path, 'context.md');
  assert.match(fs.readFileSync(path.join(project, '.codex-memory', 'context.md'), 'utf8'), /Use \.codex-memory\/ per project/);
});
```

- [ ] **Step 2: Implement context writer**

Content sections:

```text
# Codex Project Context
## Project Scope
## Current Decisions
## Open Threads
## Recent Session Summaries
## Cautions
```

- [ ] **Step 3: Add API route**

Add:

```text
POST /api/codex-memory/write-context
```

- [ ] **Step 4: Run tests**

Run:

```bash
node --test test/codex-memory.test.js test/codex-memory-api.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/codex-memory.js src/server.js test/codex-memory.test.js test/codex-memory-api.test.js
git commit -m "feat: export codex project context"
```

## End-to-End Verification

Run:

```bash
node --test test/*.test.js
node bin/cli.js run --port=3847 --no-browser
```

Manual verification:

1. Open `http://localhost:3847`.
2. Open Codex Memory.
3. Select `/home/kk/codedash`.
4. Click `Init Memory`.
5. Confirm `/home/kk/codedash/.codex-memory/manifest.json` exists.
6. Confirm `/home/kk/codedash/.gitignore` contains `.codex-memory/`.
7. Rebuild the index.
8. Summarize one Codex session.
9. Generate its embedding.
10. Recluster.
11. Review delete candidates.
12. Delete one selected candidate and confirm a backup appears under `/home/kk/backup/codex/codbash-deleted/`.

## Rollback

Rollback code:

```bash
git revert <merge-commit-or-feature-commit>
```

Rollback local memory files:

```bash
rm -rf /home/kk/codedash/.codex-memory
```

Rollback is safe because project memory files are isolated from Codex source logs and ignored by git by default.
