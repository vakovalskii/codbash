'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./atomic');

const MEMORY_DIR_NAME = '.codex-memory';
const GITIGNORE_ENTRY = '.codex-memory/';

function validateProjectPath(project) {
  if (typeof project !== 'string' || project.length === 0) {
    throw new Error('project path is required');
  }
  if (!path.isAbsolute(project)) {
    throw new Error('project path must be an absolute path');
  }

  const projectPath = path.resolve(project);
  let stat;
  try {
    stat = fs.statSync(projectPath);
  } catch {
    throw new Error('project path does not exist');
  }
  if (!stat.isDirectory()) {
    throw new Error('project path must be a directory');
  }
  return projectPath;
}

function memoryPathsForProject(project) {
  const projectPath = validateProjectPath(project);
  const memoryDir = path.join(projectPath, MEMORY_DIR_NAME);
  return {
    projectPath,
    projectKey: path.basename(projectPath),
    memoryDir,
    manifest: path.join(memoryDir, 'manifest.json'),
    sessionsIndex: path.join(memoryDir, 'sessions.index.json'),
    clusters: path.join(memoryDir, 'clusters.json'),
    decisions: path.join(memoryDir, 'decisions.md'),
    openThreads: path.join(memoryDir, 'open-threads.md'),
    summariesDir: path.join(memoryDir, 'summaries'),
    embeddingsDir: path.join(memoryDir, 'embeddings'),
    gitignore: path.join(projectPath, '.gitignore'),
  };
}

function pathIsDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function pathIsFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function writeJsonIfMissing(filePath, value) {
  if (!fs.existsSync(filePath)) {
    atomicWriteJson(filePath, value);
  }
}

function writeTextIfMissing(filePath, value) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, value, 'utf8');
  }
}

function initProjectMemory(project) {
  const paths = memoryPathsForProject(project);
  const alreadyInitialized = pathIsDirectory(paths.memoryDir) && pathIsFile(paths.manifest);
  const now = new Date().toISOString();

  if (fs.existsSync(paths.memoryDir) && !pathIsDirectory(paths.memoryDir)) {
    throw new Error('memory path exists and is not a directory');
  }

  fs.mkdirSync(paths.memoryDir, { recursive: true });
  fs.mkdirSync(paths.summariesDir, { recursive: true });
  fs.mkdirSync(paths.embeddingsDir, { recursive: true });

  writeJsonIfMissing(paths.manifest, {
    version: 1,
    projectPath: paths.projectPath,
    projectKey: paths.projectKey,
    createdAt: now,
    updatedAt: now,
    source: 'codbash',
    agent: 'codex',
  });

  writeJsonIfMissing(paths.sessionsIndex, {
    version: 1,
    projectPath: paths.projectPath,
    updatedAt: now,
    sessions: [],
  });

  writeJsonIfMissing(paths.clusters, {
    version: 1,
    projectPath: paths.projectPath,
    updatedAt: now,
    clusters: [],
  });

  writeTextIfMissing(paths.decisions, '# Decisions\n\n');
  writeTextIfMissing(paths.openThreads, '# Open Threads\n\n');

  const gitignore = ensureGitignoreEntry(paths.projectPath);

  return {
    ok: true,
    projectPath: paths.projectPath,
    memoryDir: paths.memoryDir,
    created: !alreadyInitialized,
    gitignoreUpdated: gitignore.updated,
  };
}

function ensureGitignoreEntry(project) {
  const paths = memoryPathsForProject(project);
  let current = '';

  if (fs.existsSync(paths.gitignore)) {
    if (!pathIsFile(paths.gitignore)) {
      throw new Error('.gitignore exists and is not a file');
    }
    current = fs.readFileSync(paths.gitignore, 'utf8');
  }

  const next = normalizeGitignore(current);
  const updated = next !== current;
  if (updated) {
    fs.writeFileSync(paths.gitignore, next, 'utf8');
  }

  return {
    gitignorePath: paths.gitignore,
    ignoredByGit: hasGitignoreEntry(paths.projectPath),
    updated,
  };
}

function normalizeGitignore(content) {
  const lines = content.split(/\r?\n/);
  if (content.endsWith('\n')) lines.pop();

  let found = false;
  const nextLines = [];
  for (const line of lines) {
    if (line.trim() === GITIGNORE_ENTRY) {
      if (!found) {
        nextLines.push(GITIGNORE_ENTRY);
        found = true;
      }
      continue;
    }
    if (line !== '' || content !== '') {
      nextLines.push(line);
    }
  }

  if (!found) {
    nextLines.push(GITIGNORE_ENTRY);
  }

  return nextLines.join('\n') + '\n';
}

function hasGitignoreEntry(project) {
  const paths = memoryPathsForProject(project);
  if (!pathIsFile(paths.gitignore)) return false;
  const content = fs.readFileSync(paths.gitignore, 'utf8');
  return content.split(/\r?\n/).some(line => line.trim() === GITIGNORE_ENTRY);
}

function getProjectMemoryStatus(project) {
  const paths = memoryPathsForProject(project);
  const initialized = pathIsDirectory(paths.memoryDir) && pathIsFile(paths.manifest);
  return {
    ok: true,
    initialized,
    projectPath: paths.projectPath,
    memoryDir: paths.memoryDir,
    summaryCount: countFiles(paths.summariesDir),
    embeddingCount: countFiles(paths.embeddingsDir),
    clusterCount: countClusters(paths.clusters),
    ignoredByGit: hasGitignoreEntry(paths.projectPath),
  };
}

function countFiles(dirPath) {
  if (!pathIsDirectory(dirPath)) return 0;
  return fs.readdirSync(dirPath, { withFileTypes: true }).filter(entry => entry.isFile()).length;
}

function countClusters(filePath) {
  if (!pathIsFile(filePath)) return 0;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data.clusters) ? data.clusters.length : 0;
  } catch {
    return 0;
  }
}

module.exports = {
  initProjectMemory,
  getProjectMemoryStatus,
  ensureGitignoreEntry,
  memoryPathsForProject,
};
