'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CODEX_DIR = path.join(os.homedir(), '.codex');
const OPENCODE_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');
const KILO_DIR = path.join(os.homedir(), '.local', 'share', 'kilo');

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

  // OpenCode data
  if (fs.existsSync(OPENCODE_DIR)) {
    const dbFile = path.join(OPENCODE_DIR, 'opencode.db');
    if (fs.existsSync(dbFile)) {
      paths.push('.local/share/opencode/opencode.db');
    }
  }

  // Kilo data
  if (fs.existsSync(KILO_DIR)) {
    const storageDir = path.join(KILO_DIR, 'storage');
    if (fs.existsSync(storageDir)) {
      paths.push('.local/share/kilo/storage');
    }
  }

  if (paths.length === 0) {
    console.log('  Nothing to export. No ~/.claude, ~/.codex, ~/.local/share/opencode, or ~/.local/share/kilo data found.');
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
  console.log('  \x1b[36m\x1b[1mCodeDash Export\x1b[0m');
  console.log(`  Files: ${totalFiles}`);
  console.log(`  Paths: ${paths.length} directories/files`);
  console.log(`  Includes: ${paths.map(p => p.split('/')[0]).filter((v,i,a) => a.indexOf(v) === i).join(', ')}`);
  console.log('');
  console.log('  Creating archive...');

  // Create tar.gz from home directory
  const pathArgs = paths.map(p => `"${p}"`).join(' ');
  try {
    execSync(`cd "${os.homedir()}" && tar -czf "${absOut}" ${pathArgs}`, {
      stdio: 'pipe',
    });
    const archiveSize = fs.statSync(absOut).size;
    const sizeMB = (archiveSize / 1048576).toFixed(1);
    console.log(`  \x1b[32mDone!\x1b[0m ${absOut} (${sizeMB} MB)`);
    console.log('');
    console.log('  To import on another machine:');
    console.log(`  \x1b[2mnpx codedash-app import ${path.basename(absOut)}\x1b[0m`);
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
  console.log('  \x1b[36m\x1b[1mCodeDash Import\x1b[0m');
  console.log(`  Archive: ${absPath}`);

  // List contents
  const contents = execSync(`tar -tzf "${absPath}" | head -20`, { encoding: 'utf8' }).trim();
  const lines = contents.split('\n');
  const dirs = lines.map(l => l.split('/')[0]).filter((v,i,a) => a.indexOf(v) === i);

  console.log(`  Contains: ${dirs.join(', ')}`);
  console.log(`  Files: ${lines.length}${lines.length >= 20 ? '+' : ''}`);
  console.log('');

  // Check for existing data
  const hasExisting = fs.existsSync(path.join(CLAUDE_DIR, 'history.jsonl')) ||
                      fs.existsSync(path.join(CODEX_DIR, 'history.jsonl')) ||
                      fs.existsSync(path.join(OPENCODE_DIR, 'opencode.db')) ||
                      fs.existsSync(path.join(KILO_DIR, 'storage'));

  if (hasExisting) {
    console.log('  \x1b[33mWarning:\x1b[0m Existing session data found.');
    console.log('  Import will \x1b[1mmerge\x1b[0m — existing files will be overwritten.');
    console.log('');
  }

  // Extract to home directory
  try {
    execSync(`cd "${os.homedir()}" && tar -xzf "${absPath}"`, { stdio: 'pipe' });

    // Merge history.jsonl if both exist
    const importedHistory = path.join(CLAUDE_DIR, 'history.jsonl');
    if (fs.existsSync(importedHistory)) {
      // Deduplicate by sessionId+timestamp
      const lines = fs.readFileSync(importedHistory, 'utf8').split('\n').filter(Boolean);
      const seen = new Set();
      const deduped = [];
      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          const key = d.sessionId + ':' + d.timestamp;
          if (!seen.has(key)) {
            seen.add(key);
            deduped.push(line);
          }
        } catch {
          deduped.push(line);
        }
      }
      fs.writeFileSync(importedHistory, deduped.join('\n') + '\n');
    }

    console.log('  \x1b[32mImport complete!\x1b[0m');
    console.log('  Run \x1b[2mcodedash run\x1b[0m to see your sessions.');
    console.log('');
  } catch (e) {
    console.error('  \x1b[31mFailed to import:\x1b[0m', e.message);
    process.exit(1);
  }
}

module.exports = { exportArchive, importArchive };
