'use strict';

const fs = require('fs');
const { execSync, exec } = require('child_process');

// Run cmux CLI command via osascript — needed because codedash runs as a detached server
// and cmux rejects direct socket connections from processes not inside a cmux terminal
function cmuxExec(args) {
  const escaped = args.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return execSync(`osascript -e 'do shell script "cmux ${escaped}"'`, { encoding: 'utf8', timeout: 5000 }).trim();
}

// ── Detect available terminals ──────────────────────────────

function detectTerminals() {
  const terminals = [];
  const platform = process.platform;

  if (platform === 'darwin') {
    // Check iTerm2
    try {
      execSync('osascript -e \'application id "com.googlecode.iterm2"\'', { stdio: 'pipe' });
      terminals.push({ id: 'iterm2', name: 'iTerm2', available: true });
    } catch {
      terminals.push({ id: 'iterm2', name: 'iTerm2', available: false });
    }
    // Terminal.app always available on macOS
    terminals.push({ id: 'terminal', name: 'Terminal.app', available: true });
    // Check Warp
    try {
      if (fs.existsSync('/Applications/Warp.app')) {
        terminals.push({ id: 'warp', name: 'Warp', available: true });
      }
    } catch {}
    // Check Kitty
    try {
      execSync('which kitty', { stdio: 'pipe' });
      terminals.push({ id: 'kitty', name: 'Kitty', available: true });
    } catch {}
    // Check Alacritty
    try {
      execSync('which alacritty', { stdio: 'pipe' });
      terminals.push({ id: 'alacritty', name: 'Alacritty', available: true });
    } catch {}
    // Check cmux
    try {
      if (fs.existsSync('/Applications/cmux.app')) {
        terminals.push({ id: 'cmux', name: 'cmux', available: true });
      }
    } catch {}
  } else if (platform === 'linux') {
    const linuxTerms = [
      { id: 'gnome-terminal', name: 'GNOME Terminal', cmd: 'gnome-terminal' },
      { id: 'konsole', name: 'Konsole', cmd: 'konsole' },
      { id: 'kitty', name: 'Kitty', cmd: 'kitty' },
      { id: 'alacritty', name: 'Alacritty', cmd: 'alacritty' },
      { id: 'xterm', name: 'xterm', cmd: 'xterm' },
    ];
    for (const t of linuxTerms) {
      try {
        execSync(`which ${t.cmd}`, { stdio: 'pipe' });
        terminals.push({ ...t, available: true });
      } catch {
        terminals.push({ ...t, available: false });
      }
    }
  } else {
    terminals.push({ id: 'cmd', name: 'Command Prompt', available: true });
    terminals.push({ id: 'powershell', name: 'PowerShell', available: true });
    try {
      execSync('where wt', { stdio: 'pipe' });
      terminals.push({ id: 'windows-terminal', name: 'Windows Terminal', available: true });
    } catch {}
  }

  return terminals;
}

// ── Terminal launch ─────────────────────────────────────────

function termLog(tag, msg) {
  const ts = new Date().toLocaleTimeString('en-GB');
  const color = tag === 'ERROR' ? '\x1b[31m' : '\x1b[35m';
  console.log(`  ${color}${ts} [${tag}]\x1b[0m ${msg}`);
}

function openInTerminal(sessionId, tool, flags, projectDir, terminalId) {
  const skipPerms = flags.includes('skip-permissions');
  let cmd;

  if (tool === 'codex') {
    cmd = `codex resume ${sessionId}`;
  } else {
    cmd = `claude --resume ${sessionId}`;
    if (skipPerms) cmd += ' --dangerously-skip-permissions';
  }

  const cdPart = projectDir ? `cd ${JSON.stringify(projectDir)} && ` : '';
  const fullCmd = cdPart + cmd;
  const escapedCmd = fullCmd.replace(/"/g, '\\"');
  termLog('TERM', `openInTerminal: terminal=${terminalId || 'default'} tool=${tool} cmd="${fullCmd}"`);

  const platform = process.platform;

  if (platform === 'darwin') {
    switch (terminalId) {
      case 'terminal':
        execSync(`osascript -e 'tell application "Terminal"
          activate
          do script "${escapedCmd}"
        end tell'`);
        break;
      case 'warp':
        execSync(`osascript -e 'tell application "Warp"
          activate
        end tell'`);
        // Warp doesn't have great AppleScript support, use open
        setTimeout(() => exec(`osascript -e 'tell application "System Events" to keystroke "${fullCmd}" & return'`), 500);
        break;
      case 'kitty':
        exec(`kitty --single-instance bash -c '${fullCmd}; exec bash'`);
        break;
      case 'alacritty':
        exec(`alacritty -e bash -c '${fullCmd}; exec bash'`);
        break;
      case 'cmux': {
        // cmux — open new workspace with resume command, then switch to it
        try {
          const cwdArg = projectDir ? ` --cwd ${JSON.stringify(projectDir)}` : '';
          const cmdArg = ` --command ${JSON.stringify(cmd)}`;
          const out = cmuxExec(`new-workspace${cwdArg}${cmdArg}`);
          const wsMatch = out.match(/workspace:\d+/);
          if (wsMatch) {
            cmuxExec(`select-workspace --workspace ${wsMatch[0]}`);
          }
          execSync(`osascript -e 'tell application "cmux" to activate'`, { stdio: 'pipe', timeout: 2000 });
        } catch {
          execSync(`osascript -e 'tell application "cmux" to activate'`);
        }
        break;
      }
      case 'iterm2':
      default: {
        const script = `
          tell application "iTerm"
            activate
            set newWindow to (create window with default profile)
            tell current session of newWindow
              write text "${escapedCmd}"
            end tell
          end tell
        `;
        try {
          execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { stdio: 'pipe' });
        } catch {
          // Fallback to Terminal.app
          execSync(`osascript -e 'tell application "Terminal" to do script "${escapedCmd}"'`);
        }
        break;
      }
    }
  } else if (platform === 'linux') {
    switch (terminalId) {
      case 'kitty':
        exec(`kitty bash -c '${fullCmd}; exec bash'`);
        break;
      case 'alacritty':
        exec(`alacritty -e bash -c '${fullCmd}; exec bash'`);
        break;
      case 'konsole':
        exec(`konsole -e bash -c '${fullCmd}; exec bash'`);
        break;
      case 'xterm':
        exec(`xterm -e bash -c '${fullCmd}; exec bash'`);
        break;
      case 'gnome-terminal':
      default:
        exec(`gnome-terminal -- bash -c "${fullCmd}; exec bash"`);
        break;
    }
  } else {
    switch (terminalId) {
      case 'powershell':
        exec(`start powershell -NoExit -Command "${fullCmd}"`);
        break;
      case 'windows-terminal':
        exec(`wt new-tab cmd /k "${fullCmd}"`);
        break;
      default:
        exec(`start cmd /k "${fullCmd}"`);
        break;
    }
  }
}

// ── Focus cmux workspace by PID → env var ───────────────────

function focusCmuxWorkspace(pid) {
  if (pid) {
    try {
      const psEnv = execSync(`ps eww -p ${pid} 2>/dev/null`, { encoding: 'utf8', timeout: 2000 });
      const wsMatch = psEnv.match(/CMUX_WORKSPACE_ID=([0-9A-F-]{36})/i);
      if (wsMatch) {
        cmuxExec(`select-workspace --workspace ${wsMatch[1]}`);
        execSync(`osascript -e 'tell application "cmux" to activate'`, { stdio: 'pipe', timeout: 2000 });
        return { ok: true, terminal: 'cmux' };
      }
    } catch {}
  }
  execSync(`osascript -e 'tell application "cmux" to activate'`, { stdio: 'pipe', timeout: 2000 });
  return { ok: true, terminal: 'cmux' };
}

// ── Focus existing terminal by PID ──────────────────────────

function focusTerminalByPid(pid) {
  const platform = process.platform;
  termLog('FOCUS', `focusTerminalByPid: pid=${pid} platform=${platform}`);

  if (platform === 'darwin') {
    // Find which terminal app owns this PID's TTY, then activate it
    try {
      // Get TTY of the process
      const ttyOut = execSync(`ps -p ${pid} -o tty= 2>/dev/null`, { encoding: 'utf8' }).trim();
      termLog('FOCUS', `tty=${ttyOut || '(empty)'}`);
      if (!ttyOut) throw new Error('no tty');

      // Walk parent chain to detect the actual terminal app
      let detectedTerminal = '';
      try {
        let checkPid = pid;
        for (let depth = 0; depth < 6; depth++) {
          const ppid = execSync(`ps -p ${checkPid} -o ppid= 2>/dev/null`, { encoding: 'utf8' }).trim();
          if (!ppid || ppid === '0' || ppid === '1') break;
          const parentCmd = execSync(`ps -p ${ppid} -o comm= 2>/dev/null`, { encoding: 'utf8' }).trim();
          termLog('FOCUS', `parent chain: depth=${depth} ppid=${ppid} cmd=${parentCmd}`);
          if (parentCmd.includes('cmux')) { detectedTerminal = 'cmux'; break; }
          if (parentCmd.includes('iTerm')) { detectedTerminal = 'iTerm2'; break; }
          if (parentCmd.includes('Terminal')) { detectedTerminal = 'Terminal.app'; break; }
          if (parentCmd.includes('Warp')) { detectedTerminal = 'Warp'; break; }
          if (parentCmd.includes('kitty')) { detectedTerminal = 'kitty'; break; }
          if (parentCmd.includes('alacritty')) { detectedTerminal = 'Alacritty'; break; }
          checkPid = ppid;
        }
      } catch {}

      termLog('FOCUS', `detected terminal from parent chain: ${detectedTerminal || '(none)'}`);

      // cmux: select workspace by PID's CMUX_WORKSPACE_ID env var
      if (detectedTerminal === 'cmux') {
        return focusCmuxWorkspace(pid);
      }

      // iTerm2: activate and select the right tab/window/session by tty
      if (detectedTerminal === 'iTerm2' || !detectedTerminal) {
        try {
          // Normalize tty: "ttys005" → "ttys005", "/dev/ttys005" → "ttys005"
          const ttyNorm = ttyOut.replace('/dev/', '');
          const script = `
            tell application "iTerm"
              activate
              repeat with w in windows
                repeat with t in tabs of w
                  repeat with s in sessions of t
                    set sessionTTY to tty of s
                    if sessionTTY contains "${ttyNorm}" then
                      select w
                      tell w to select t
                      tell t to select s
                      return "found"
                    end if
                  end repeat
                end repeat
              end repeat
            end tell
            return "not found"
          `;
          const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf8', timeout: 3000 }).trim();
          if (result === 'found') {
            return { ok: true, terminal: 'iTerm2' };
          }
          // If we specifically detected iTerm2 but couldn't find the tab, still activate it
          if (detectedTerminal === 'iTerm2') {
            return { ok: true, terminal: 'iTerm2' };
          }
        } catch {}
      }

      // Terminal.app: activate and select the right window by tty
      if (detectedTerminal === 'Terminal.app' || !detectedTerminal) {
        try {
          const script = `
            tell application "Terminal"
              activate
              repeat with w in windows
                repeat with t in tabs of w
                  if tty of t contains "${ttyOut}" or "${ttyOut}" contains tty of t then
                    set selected tab of w to t
                    set index of w to 1
                    return "found"
                  end if
                end repeat
              end repeat
            end tell
            return "not found"
          `;
          execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: 'utf8', timeout: 3000 });
          return { ok: true, terminal: 'Terminal.app' };
        } catch {}
      }

      // Warp
      if (detectedTerminal === 'Warp') {
        try {
          execSync(`osascript -e 'tell application "Warp" to activate'`, { stdio: 'pipe', timeout: 2000 });
          return { ok: true, terminal: 'Warp' };
        } catch {}
      }

      // Fallback: activate whatever terminal we detected, or try both
      if (detectedTerminal) {
        try {
          execSync(`osascript -e 'tell application "${detectedTerminal}" to activate'`, { stdio: 'pipe' });
          return { ok: true, terminal: detectedTerminal };
        } catch {}
      }
      try {
        execSync(`osascript -e 'tell application "iTerm" to activate'`, { stdio: 'pipe' });
        return { ok: true, terminal: 'iTerm2' };
      } catch {}
      try {
        execSync(`osascript -e 'tell application "Terminal" to activate'`, { stdio: 'pipe' });
        return { ok: true, terminal: 'Terminal.app' };
      } catch {}
    } catch {}
  }

  // Linux/other: not much we can do without window manager integration
  return { ok: false };
}

module.exports = { detectTerminals, openInTerminal, focusTerminalByPid };
