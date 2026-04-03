#!/usr/bin/env node

const { loadSessions } = require('../src/data');
const { startServer } = require('../src/server');

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
      const tool = s.tool === 'codex' ? '\x1b[36mcodex\x1b[0m' : '\x1b[34mclaude\x1b[0m';
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
    console.log(`\n  \x1b[1mTop projects:\x1b[0m`);
    const sorted = Object.entries(projects).sort((a, b) => b[1].count - a[1].count).slice(0, 10);
    for (const [name, info] of sorted) {
      console.log(`    ${String(info.count).padStart(3)} sessions  ${name}`);
    }
    console.log('');
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
  \x1b[36m\x1b[1mcodedash\x1b[0m — Claude & Codex Sessions Dashboard

  \x1b[1mUsage:\x1b[0m
    codedash run [port] [--no-browser]   Start the dashboard server
    codedash list [limit]                List sessions in terminal
    codedash stats                       Show session statistics
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
