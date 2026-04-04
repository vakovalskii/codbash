#!/usr/bin/env node

const { loadSessions } = require('../src/data');
const { startServer } = require('../src/server');
const { exportArchive, importArchive } = require('../src/migrate');

const DEFAULT_PORT = 3847;
const args = process.argv.slice(2);
const command = args[0] || 'help';

switch (command) {
  case 'run':
  case 'start': {
    const portArg = args.find(a => a.startsWith('--port='));
    const port = portArg ? parseInt(portArg.split('=')[1]) : (parseInt(args[1]) || DEFAULT_PORT);
    const noBrowser = args.includes('--no-browser');
    startServer(port, !noBrowser);
    break;
  }

  case 'list':
  case 'ls': {
    const sessions = loadSessions();
    const limit = parseInt(args[1]) || 20;
    console.log(`\n  \x1b[36m\x1b[1m${sessions.length} sessions\x1b[0m across ${new Set(sessions.map(s => s.project)).size} projects\n`);
    for (const s of sessions.slice(0, limit)) {
      const tool = s.tool === 'codex'
        ? '\x1b[36mcodex\x1b[0m'
        : s.tool === 'opencode'
          ? '\x1b[35mopencode\x1b[0m'
          : s.tool === 'kilo'
            ? '\x1b[33mkilo\x1b[0m'
            : '\x1b[34mclaude\x1b[0m';
      const msg = (s.first_message || '').slice(0, 50).padEnd(50);
      const proj = s.project_short || '';
      console.log(`  ${tool}  ${s.id.slice(0, 12)}  ${s.last_time}  ${msg}  \x1b[2m${proj}\x1b[0m`);
    }
    if (sessions.length > limit) console.log(`\n  \x1b[2m... and ${sessions.length - limit} more (codedash list ${limit + 20})\x1b[0m`);
    console.log('');
    break;
  }

  case 'stats': {
    const sessions = loadSessions();
    const projects = {};
    for (const s of sessions) {
      const p = s.project_short || 'unknown';
      if (!projects[p]) projects[p] = { count: 0, messages: 0 };
      projects[p].count++;
      projects[p].messages += s.messages;
    }
    console.log(`\n  \x1b[36m\x1b[1mSession Stats\x1b[0m\n`);
    console.log(`  Total sessions:  ${sessions.length}`);
    console.log(`  Total projects:  ${Object.keys(projects).length}`);
    console.log(`  Claude sessions: ${sessions.filter(s => s.tool === 'claude').length}`);
    console.log(`  Codex sessions:  ${sessions.filter(s => s.tool === 'codex').length}`);
    console.log(`  OpenCode sessions: ${sessions.filter(s => s.tool === 'opencode').length}`);
    console.log(`  Kilo sessions:    ${sessions.filter(s => s.tool === 'kilo').length}`);
    console.log(`\n  \x1b[1mTop projects:\x1b[0m`);
    const sorted = Object.entries(projects).sort((a, b) => b[1].count - a[1].count).slice(0, 10);
    for (const [name, info] of sorted) {
      console.log(`    ${String(info.count).padStart(3)} sessions  ${name}`);
    }
    console.log('');
    break;
  }

  case 'update':
  case 'upgrade': {
    const { execSync: execU } = require('child_process');
    console.log('\n  \x1b[36m\x1b[1mUpdating codedash-app...\x1b[0m\n');
    try {
      execU('npm i -g codedash-app@latest', { stdio: 'inherit' });
      const newPkg = require('../package.json');
      console.log(`\n  \x1b[32mUpdated to v${newPkg.version}!\x1b[0m`);
      console.log('  Run \x1b[2mcodedash restart\x1b[0m to apply.\n');
    } catch (e) {
      console.error('  \x1b[31mUpdate failed.\x1b[0m Try: npm i -g codedash-app@latest\n');
    }
    break;
  }

  case 'restart': {
    const { execSync } = require('child_process');
    const portArg = args.find(a => a.startsWith('--port='));
    const port = portArg ? parseInt(portArg.split('=')[1]) : DEFAULT_PORT;
    console.log(`\n  Stopping codedash on port ${port}...`);
    try {
      execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null`, { stdio: 'pipe' });
      console.log('  Stopped.');
    } catch {
      console.log('  No running instance found.');
    }
    setTimeout(() => {
      console.log('  Starting...\n');
      const noBrowser = args.includes('--no-browser');
      startServer(port, !noBrowser);
    }, 500);
    break;
  }

  case 'stop': {
    const { execSync: execS } = require('child_process');
    const pArg = args.find(a => a.startsWith('--port='));
    const p = pArg ? parseInt(pArg.split('=')[1]) : DEFAULT_PORT;
    try {
      execS(`lsof -ti:${p} | xargs kill -9 2>/dev/null`, { stdio: 'pipe' });
      console.log(`\n  codedash stopped (port ${p})\n`);
    } catch {
      console.log(`\n  No codedash running on port ${p}\n`);
    }
    break;
  }

  case 'export': {
    const outPath = args[1] || `codedash-export-${new Date().toISOString().slice(0,10)}.tar.gz`;
    exportArchive(outPath);
    break;
  }

  case 'import': {
    const archivePath = args[1];
    if (!archivePath) {
      console.error('  Usage: codedash import <archive.tar.gz>');
      process.exit(1);
    }
    importArchive(archivePath);
    break;
  }

  case 'version':
  case '-v':
  case '--version': {
    const pkg = require('../package.json');
    console.log(pkg.version);
    break;
  }

  case 'help':
  case '-h':
  case '--help':
  default:
    console.log(`
  \x1b[36m\x1b[1mcodedash\x1b[0m — Claude, Codex, OpenCode & Kilo Sessions Dashboard

  \x1b[1mUsage:\x1b[0m
    codedash run [port] [--no-browser]   Start the dashboard server
    codedash update                      Update to latest version
    codedash restart [--port=N]          Restart the server
    codedash stop [--port=N]             Stop the server
    codedash list [limit]                List sessions in terminal
    codedash stats                       Show session statistics
    codedash export [file.tar.gz]        Export all sessions to archive
    codedash import <file.tar.gz>        Import sessions from archive
    codedash help                        Show this help
    codedash version                     Show version

  \x1b[1mExamples:\x1b[0m
    codedash run                         Start on port ${DEFAULT_PORT}
    codedash run --port=4000             Start on port 4000
    codedash run --no-browser            Start without opening browser
    codedash list 50                     Show last 50 sessions
    codedash ls                          Alias for list
`);
    if (!['help', '-h', '--help'].includes(command)) {
      console.log(`  Unknown command: ${command}\n`);
      process.exit(1);
    }
    break;
}
