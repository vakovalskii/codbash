#!/usr/bin/env node

const { loadSessions, searchFullText, getSessionPreview, computeSessionCost } = require('../src/data');
const { startServer } = require('../src/server');
const { exportArchive, importArchive } = require('../src/migrate');
const { convertSession } = require('../src/convert');
const { generateHandoff, quickHandoff } = require('../src/handoff');

const DEFAULT_PORT = 3847;
const DEFAULT_HOST = 'localhost';
const args = process.argv.slice(2);
const command = args[0] || 'help';

switch (command) {
  case 'run':
  case 'start': {
    const portArg = args.find(a => a.startsWith('--port='));
    const port = portArg ? parseInt(portArg.split('=')[1]) : (parseInt(args[1]) || DEFAULT_PORT);
    const hostArg = args.find(a => a.startsWith('--host='));
    const host = hostArg ? hostArg.split('=')[1] : (process.env.CODEDASH_HOST || DEFAULT_HOST);
    const noBrowser = args.includes('--no-browser');
    startServer(host, port, !noBrowser);
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

  case 'search':
  case 'find': {
    const query = args.slice(1).join(' ');
    if (!query) {
      console.error('  Usage: codedash search <query>');
      process.exit(1);
    }
    const sessions = loadSessions();
    const results = searchFullText(query, sessions);
    if (results.length === 0) {
      console.log(`\n  No results for "${query}"\n`);
    } else {
      console.log(`\n  \x1b[36m\x1b[1m${results.length} sessions\x1b[0m matching "${query}"\n`);
      for (const r of results.slice(0, 15)) {
        const s = sessions.find(x => x.id === r.sessionId);
        const proj = s ? (s.project_short || '') : '';
        const tool = s ? s.tool : '?';
        const date = s ? s.last_time : '';
        console.log(`  \x1b[1m${r.sessionId.slice(0, 12)}\x1b[0m  ${tool}  ${date}  \x1b[2m${proj}\x1b[0m`);
        for (const m of r.matches.slice(0, 2)) {
          const role = m.role === 'user' ? '\x1b[34mYOU\x1b[0m' : '\x1b[32mAI \x1b[0m';
          console.log(`    ${role} ${m.snippet.replace(/\n/g, ' ').slice(0, 100)}`);
        }
      }
      if (results.length > 15) console.log(`\n  \x1b[2m... and ${results.length - 15} more\x1b[0m`);
      console.log('');
    }
    break;
  }

  case 'show': {
    const sid = args[1];
    if (!sid) {
      console.error('  Usage: codedash show <session-id>');
      process.exit(1);
    }
    const allS = loadSessions();
    const session = allS.find(s => s.id === sid || s.id.startsWith(sid));
    if (!session) {
      console.error(`  Session not found: ${sid}`);
      process.exit(1);
    }
    const preview = getSessionPreview(session.id, session.project, 20);
    const cost = computeSessionCost(session.id, session.project);

    console.log('');
    console.log(`  \x1b[36m\x1b[1mSession ${session.id}\x1b[0m`);
    console.log(`  Tool:    ${session.tool}`);
    console.log(`  Project: ${session.project_short || session.project || 'unknown'}`);
    console.log(`  Started: ${session.first_time}`);
    console.log(`  Last:    ${session.last_time}`);
    console.log(`  Msgs:    ${session.messages} inputs, ${session.detail_messages || 0} total`);
    if (cost.cost > 0) {
      console.log(`  Cost:    $${cost.cost.toFixed(2)} (${cost.model || 'unknown'})`);
      console.log(`  Tokens:  ${(cost.inputTokens/1000).toFixed(0)}K in / ${(cost.outputTokens/1000).toFixed(0)}K out`);
    }
    console.log('');

    if (preview.length > 0) {
      console.log('  \x1b[1mConversation:\x1b[0m');
      for (const m of preview) {
        const role = m.role === 'user' ? '\x1b[34mYOU\x1b[0m' : '\x1b[32mAI \x1b[0m';
        const text = m.content.replace(/\n/g, ' ').slice(0, 120);
        console.log(`  ${role} ${text}`);
      }
      console.log('');
    }

    console.log(`  Resume: \x1b[2m${session.tool === 'codex' ? 'codex resume' : 'claude --resume'} ${session.id}\x1b[0m`);
    console.log('');
    break;
  }

  case 'handoff':
  case 'continue': {
    const sid = args[1];
    const target = args[2] || 'any';
    const verbFlag = args.find(a => a.startsWith('--verbosity='));
    const verbosity = verbFlag ? verbFlag.split('=')[1] : 'standard';
    const outFlag = args.find(a => a.startsWith('--out='));

    if (!sid) {
      console.log(`
  \x1b[36m\x1b[1mHandoff session to another agent\x1b[0m

  Usage: codedash handoff <session-id> [target] [options]

  Generates a context document for continuing a session in another tool.

  Targets: claude, codex, opencode, any (default)
  Options:
    --verbosity=minimal|standard|verbose|full
    --out=file.md  (save to file instead of stdout)

  Examples:
    codedash handoff 13ae5748                    Print handoff doc
    codedash handoff 13ae5748 codex              For Codex specifically
    codedash handoff 13ae5748 --verbosity=full   Include more context
    codedash handoff 13ae5748 --out=handoff.md   Save to file

  Quick handoff (latest session):
    codedash handoff claude codex                Latest Claude → Codex
`);
      break;
    }

    // Check if sid is a tool name (quick handoff)
    let result;
    if (['claude', 'codex', 'opencode'].includes(sid)) {
      result = quickHandoff(sid, target, { verbosity });
    } else {
      const allH = loadSessions();
      const match = allH.find(s => s.id === sid || s.id.startsWith(sid));
      if (!match) {
        console.error(`  Session not found: ${sid}`);
        process.exit(1);
      }
      result = generateHandoff(match.id, match.project, { verbosity, target });
    }

    if (!result.ok) {
      console.error(`  \x1b[31mError:\x1b[0m ${result.error}\n`);
      process.exit(1);
    }

    if (outFlag) {
      const outPath = outFlag.split('=')[1];
      require('fs').writeFileSync(outPath, result.markdown);
      console.log(`\n  \x1b[32mHandoff saved to ${outPath}\x1b[0m`);
      console.log(`  Source: ${result.session.tool} (${result.session.id.slice(0, 12)})`);
      console.log(`  Messages: ${result.session.messages}\n`);
    } else {
      console.log(result.markdown);
    }
    break;
  }

  case 'convert': {
    const sid = args[1];
    const target = args[2]; // 'claude' or 'codex'
    if (!sid || !target) {
      console.log(`
  \x1b[36m\x1b[1mConvert session between agents\x1b[0m

  Usage: codedash convert <session-id> <target-format>

  Formats: claude, codex

  Examples:
    codedash convert 019d54ed codex     Convert Claude session to Codex
    codedash convert 13ae5748 claude    Convert Codex session to Claude
`);
      break;
    }
    // Find full session ID
    const allConv = loadSessions();
    const match = allConv.find(s => s.id === sid || s.id.startsWith(sid));
    if (!match) {
      console.error(`  Session not found: ${sid}`);
      process.exit(1);
    }
    console.log(`\n  Converting ${match.tool} session \x1b[1m${match.id.slice(0, 12)}\x1b[0m → ${target}...`);
    const result = convertSession(match.id, match.project, target);
    if (!result.ok) {
      console.error(`  \x1b[31mError:\x1b[0m ${result.error}\n`);
      process.exit(1);
    }
    console.log(`  \x1b[32mDone!\x1b[0m`);
    console.log(`  New session: ${result.target.sessionId}`);
    console.log(`  Messages:    ${result.target.messages}`);
    console.log(`  File:        ${result.target.file}`);
    console.log(`  Resume:      \x1b[2m${result.target.resumeCmd}\x1b[0m\n`);
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
    const hostArg = args.find(a => a.startsWith('--host='));
    const host = hostArg ? hostArg.split('=')[1] : (process.env.CODEDASH_HOST || DEFAULT_HOST);
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
      startServer(host, port, !noBrowser);
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
  \x1b[36m\x1b[1mcodedash\x1b[0m — Claude & Codex Sessions Dashboard

  \x1b[1mUsage:\x1b[0m
    codedash run [port] [--no-browser]   Start the dashboard server
    codedash search <query>              Search across all session messages
    codedash show <session-id>           Show session details + messages
    codedash list [limit]                List sessions in terminal
    codedash stats                       Show session statistics
    codedash handoff <id> [target]       Generate handoff document
    codedash convert <id> <format>       Convert session (claude/codex)
    codedash export [file.tar.gz]        Export all sessions to archive
    codedash import <file.tar.gz>        Import sessions from archive
    codedash update                      Update to latest version
    codedash restart [--port=N]          Restart the server
    codedash stop [--port=N]             Stop the server
    codedash help                        Show this help
    codedash version                     Show version

  \x1b[1mServer options:\x1b[0m
    --port=N                             Listen on port N (default: ${DEFAULT_PORT})
    --host=ADDR                          Bind to address (default: localhost)
    --no-browser                         Don't open browser on start

  \x1b[1mEnvironment variables:\x1b[0m
    CODEDASH_HOST                        Bind address (same as --host)

  \x1b[1mExamples:\x1b[0m
    codedash run                         Start on port ${DEFAULT_PORT}
    codedash run --port=4000             Start on port 4000
    codedash run --host=0.0.0.0          Listen on all interfaces
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
