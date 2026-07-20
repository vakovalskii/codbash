'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CODEX_DIR = path.join(os.homedir(), '.codex');

// Read a .jsonl file into a line array (missing/unreadable → []).
function readJsonlLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); }
  catch { return []; }
}

// Merge a just-extracted history.jsonl with the lines that were present locally
// BEFORE extraction (which overwrote the file), deduped by sessionId+timestamp.
// `priorLines` come first so local entries win on tie. Without this, import
// silently discards the machine's own history despite the "merge" promise.
function mergeHistoryFile(file, priorLines) {
  const merged = priorLines.concat(readJsonlLines(file));
  if (!merged.length) return;
  const seen = new Set();
  const out = [];
  for (const line of merged) {
    let key;
    try { const d = JSON.parse(line); key = d.sessionId + ':' + d.timestamp; }
    catch { key = 'raw:' + line; }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  fs.writeFileSync(file, out.join('\n') + '\n');
}

function exportArchive(outPath) {
  const absOut = path.resolve(outPath);

  // Build list of paths to include
  const paths = [];

  // Claude data
  if (fs.existsSync(CLAUDE_DIR)) {
    paths.push('.claude/history.jsonl');
    paths.push('.claude/settings.json');

    // All project session files
    const projectsDir = path.join(CLAUDE_DIR, 'projects');
    if (fs.existsSync(projectsDir)) {
      paths.push('.claude/projects');
    }

    // Session env
    const envDir = path.join(CLAUDE_DIR, 'session-env');
    if (fs.existsSync(envDir)) {
      paths.push('.claude/session-env');
    }

    // CLAUDE.md files
    const claudeMd = path.join(CLAUDE_DIR, 'CLAUDE.md');
    if (fs.existsSync(claudeMd)) {
      paths.push('.claude/CLAUDE.md');
    }

    // Memory
    const projectMemoryDirs = [];
    if (fs.existsSync(projectsDir)) {
      for (const proj of fs.readdirSync(projectsDir)) {
        const memDir = path.join(projectsDir, proj, 'memory');
        if (fs.existsSync(memDir)) {
          projectMemoryDirs.push(path.join('.claude/projects', proj, 'memory'));
        }
      }
    }
  }

  // Codex data
  if (fs.existsSync(CODEX_DIR)) {
    const codexHistory = path.join(CODEX_DIR, 'history.jsonl');
    if (fs.existsSync(codexHistory)) {
      paths.push('.codex/history.jsonl');
    }
    const codexSessions = path.join(CODEX_DIR, 'sessions');
    if (fs.existsSync(codexSessions)) {
      paths.push('.codex/sessions');
    }
    const codexConfig = path.join(CODEX_DIR, 'config.toml');
    if (fs.existsSync(codexConfig)) {
      paths.push('.codex/config.toml');
    }
  }

  if (paths.length === 0) {
    console.log('  Nothing to export. No ~/.claude or ~/.codex data found.');
    return;
  }

  // Calculate sizes
  let totalSize = 0;
  let totalFiles = 0;
  for (const p of paths) {
    const full = path.join(os.homedir(), p);
    if (fs.existsSync(full)) {
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        const output = execSync(`find "${full}" -type f | wc -l`, { encoding: 'utf8' }).trim();
        totalFiles += parseInt(output) || 0;
        const sizeOut = execSync(`du -sb "${full}" 2>/dev/null || du -sk "${full}"`, { encoding: 'utf8' }).trim();
        totalSize += parseInt(sizeOut) || 0;
      } else {
        totalFiles++;
        totalSize += stat.size;
      }
    }
  }

  console.log('');
  console.log('  \x1b[36m\x1b[1mCodBash Export\x1b[0m');
  console.log(`  Files: ${totalFiles}`);
  console.log(`  Paths: ${paths.length} directories/files`);
  console.log(`  Includes: ${paths.map(p => p.split('/')[0]).filter((v,i,a) => a.indexOf(v) === i).join(', ')}`);
  console.log('');
  console.log('  Creating archive...');

  // Create tar.gz from home directory. execFileSync with an argument array
  // (not a shell string) so an output path containing quotes/backticks/$ can't
  // break quoting or inject a command.
  try {
    execFileSync('tar', ['-czf', absOut, ...paths], {
      cwd: os.homedir(),
      stdio: 'pipe',
    });
    const archiveSize = fs.statSync(absOut).size;
    const sizeMB = (archiveSize / 1048576).toFixed(1);
    console.log(`  \x1b[32mDone!\x1b[0m ${absOut} (${sizeMB} MB)`);
    console.log('');
    console.log('  To import on another machine:');
    console.log(`  \x1b[2mnpx codbash import ${path.basename(absOut)}\x1b[0m`);
    console.log('');
  } catch (e) {
    console.error('  \x1b[31mFailed to create archive:\x1b[0m', e.message);
    process.exit(1);
  }
}

function importArchive(archivePath) {
  const absPath = path.resolve(archivePath);

  if (!fs.existsSync(absPath)) {
    console.error(`  File not found: ${absPath}`);
    process.exit(1);
  }

  console.log('');
  console.log('  \x1b[36m\x1b[1mCodBash Import\x1b[0m');
  console.log(`  Archive: ${absPath}`);

  // List contents (execFileSync — no shell, so the archive path is safe).
  const contents = execFileSync('tar', ['-tzf', absPath], { encoding: 'utf8' }).trim();
  const lines = contents.split('\n').slice(0, 20);
  const dirs = lines.map(l => l.split('/')[0]).filter((v,i,a) => a.indexOf(v) === i);

  console.log(`  Contains: ${dirs.join(', ')}`);
  console.log(`  Files: ${lines.length}${lines.length >= 20 ? '+' : ''}`);
  console.log('');

  // Check for existing data
  const hasExisting = fs.existsSync(path.join(CLAUDE_DIR, 'history.jsonl')) ||
                      fs.existsSync(path.join(CODEX_DIR, 'history.jsonl'));

  if (hasExisting) {
    console.log('  \x1b[33mWarning:\x1b[0m Existing session data found.');
    console.log('  History files are \x1b[1mmerged\x1b[0m (deduped); other files are overwritten.');
    console.log('');
  }

  const claudeHistory = path.join(CLAUDE_DIR, 'history.jsonl');
  const codexHistory = path.join(CODEX_DIR, 'history.jsonl');
  // Stash the local history lines BEFORE extraction — tar will overwrite these
  // files, so we must capture them now to merge them back afterwards.
  const priorClaude = readJsonlLines(claudeHistory);
  const priorCodex = readJsonlLines(codexHistory);

  // Extract to home directory (execFileSync — no shell, path-injection safe).
  try {
    execFileSync('tar', ['-xzf', absPath], { cwd: os.homedir(), stdio: 'pipe' });

    // Merge both history files with what was here before, so the machine's own
    // sessions survive the import (previously Claude history was overwritten
    // then only self-deduped, and Codex history was overwritten with no merge).
    mergeHistoryFile(claudeHistory, priorClaude);
    mergeHistoryFile(codexHistory, priorCodex);

    console.log('  \x1b[32mImport complete!\x1b[0m');
    console.log('  Run \x1b[2mcodbash run\x1b[0m to see your sessions.');
    console.log('');
  } catch (e) {
    console.error('  \x1b[31mFailed to import:\x1b[0m', e.message);
    process.exit(1);
  }
}

module.exports = { exportArchive, importArchive };
