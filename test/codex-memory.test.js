const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const codexMemory = require('../src/codex-memory');

function makeProject() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codbash-memory-')));
  const project = path.join(root, 'demo-project');
  fs.mkdirSync(project);
  return { root, project: fs.realpathSync(project) };
}

function countIgnoreEntries(project) {
  const gitignore = fs.readFileSync(path.join(project, '.gitignore'), 'utf8');
  return gitignore.split(/\r?\n/).filter(line => line.trim() === '.codex-memory/').length;
}

test('initProjectMemory creates the complete project-local memory structure', () => {
  const { root, project } = makeProject();
  try {
    const result = codexMemory.initProjectMemory(project);
    const paths = codexMemory.memoryPathsForProject(project);

    assert.equal(result.created, true);
    assert.equal(result.memoryDir, path.join(project, '.codex-memory'));
    assert.equal(fs.statSync(paths.memoryDir).isDirectory(), true);
    assert.equal(fs.statSync(paths.summariesDir).isDirectory(), true);
    assert.equal(fs.statSync(paths.embeddingsDir).isDirectory(), true);
    assert.equal(fs.existsSync(paths.manifest), true);
    assert.equal(fs.existsSync(paths.sessionsIndex), true);
    assert.equal(fs.existsSync(paths.clusters), true);
    assert.equal(fs.existsSync(paths.decisions), true);
    assert.equal(fs.existsSync(paths.openThreads), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('initProjectMemory writes the required manifest fields', () => {
  const { root, project } = makeProject();
  try {
    codexMemory.initProjectMemory(project);
    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.codex-memory', 'manifest.json'), 'utf8'));

    assert.equal(manifest.version, 1);
    assert.equal(manifest.projectPath, project);
    assert.equal(manifest.projectKey, 'demo-project');
    assert.equal(manifest.source, 'codbash');
    assert.equal(manifest.agent, 'codex');
    assert.equal(typeof manifest.createdAt, 'string');
    assert.equal(Number.isNaN(Date.parse(manifest.createdAt)), false);
    assert.equal(manifest.updatedAt, manifest.createdAt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('initProjectMemory writes and deduplicates the .gitignore entry without overwriting existing content', () => {
  const { root, project } = makeProject();
  try {
    fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules/\n.env\n.codex-memory/\n.codex-memory/\n', 'utf8');

    const first = codexMemory.initProjectMemory(project);
    const second = codexMemory.initProjectMemory(project);
    const gitignore = fs.readFileSync(path.join(project, '.gitignore'), 'utf8');

    assert.equal(first.gitignoreUpdated, true);
    assert.equal(second.gitignoreUpdated, false);
    assert.equal(countIgnoreEntries(project), 1);
    assert.match(gitignore, /^node_modules\/$/m);
    assert.match(gitignore, /^\.env$/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('initProjectMemory preserves existing memory files on repeated initialization', () => {
  const { root, project } = makeProject();
  try {
    const first = codexMemory.initProjectMemory(project);
    const decisions = path.join(first.memoryDir, 'decisions.md');
    const manifest = path.join(first.memoryDir, 'manifest.json');
    const originalManifest = fs.readFileSync(manifest, 'utf8');
    fs.writeFileSync(decisions, 'Existing decision\n', 'utf8');

    const second = codexMemory.initProjectMemory(project);

    assert.equal(second.created, false);
    assert.equal(fs.readFileSync(decisions, 'utf8'), 'Existing decision\n');
    assert.equal(fs.readFileSync(manifest, 'utf8'), originalManifest);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project path validation rejects empty, relative, missing, and file paths', () => {
  const { root, project } = makeProject();
  try {
    const filePath = path.join(project, 'not-a-directory.txt');
    fs.writeFileSync(filePath, 'nope\n', 'utf8');
    const missing = path.join(root, 'missing-project');

    assert.throws(() => codexMemory.initProjectMemory(''), /project path is required/);
    assert.throws(() => codexMemory.initProjectMemory('relative/path'), /absolute path/);
    assert.throws(() => codexMemory.initProjectMemory(missing), /does not exist/);
    assert.throws(() => codexMemory.initProjectMemory(filePath), /must be a directory/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getProjectMemoryStatus reports uninitialized projects without creating memory', () => {
  const { root, project } = makeProject();
  try {
    const status = codexMemory.getProjectMemoryStatus(project);

    assert.equal(status.ok, true);
    assert.equal(status.initialized, false);
    assert.equal(status.projectPath, project);
    assert.equal(status.memoryDir, path.join(project, '.codex-memory'));
    assert.equal(status.summaryCount, 0);
    assert.equal(status.embeddingCount, 0);
    assert.equal(status.clusterCount, 0);
    assert.equal(status.ignoredByGit, false);
    assert.equal(fs.existsSync(status.memoryDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getProjectMemoryStatus reports initialized projects with empty counts', () => {
  const { root, project } = makeProject();
  try {
    codexMemory.initProjectMemory(project);
    const status = codexMemory.getProjectMemoryStatus(project);

    assert.equal(status.ok, true);
    assert.equal(status.initialized, true);
    assert.equal(status.summaryCount, 0);
    assert.equal(status.embeddingCount, 0);
    assert.equal(status.clusterCount, 0);
    assert.equal(status.ignoredByGit, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
