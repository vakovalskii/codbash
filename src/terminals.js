'use strict';

const fs = require('fs');
const { execSync, exec } = require('child_process');

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

function openInTerminal(sessionId, tool, flags, projectDir, terminalId) {
  const skipPerms = flags.includes('skip-permissions');
  let cmd;

  if (tool === 'codex') {
    cmd = `codex resume ${sessionId}`;
  } else if (tool === 'opencode') {
    cmd = `opencode --session ${sessionId}`;
  } else if (tool === 'kilo') {
    cmd = `kilo --session ${sessionId}`;
  } else {
    cmd = `claude --resume ${sessionId}`;
    if (skipPerms) cmd += ' --dangerously-skip-permissions';
  }

  const cdPart = projectDir ? `cd ${JSON.stringify(projectDir)} && ` : '';
  const fullCmd = cdPart + cmd;
  const escapedCmd = fullCmd.replace(/"/g, '\\"');

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

// ── Focus existing terminal by PID ──────────────────────────

function focusTerminalByPid(pid) {
  const platform = process.platform;

  if (platform === 'darwin') {
    // Find which terminal app owns this PID's TTY, then activate it
    try {
      // Get TTY of the process
      const ttyOut = execSync(`ps -p ${pid} -o tty= 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (!ttyOut) throw new Error('no tty');

      // Try iTerm2 first — activate and select session by tty
      try {
        const script = `
          tell application "iTerm"
            activate
            repeat with w in windows
              repeat with t in tabs of w
                repeat with s in sessions of t
                  if tty of s contains "${ttyOut}" then
                    select t
                    return
                  end if
                end repeat
              end repeat
            end repeat
          end tell
        `;
        execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { stdio: 'pipe', timeout: 3000 });
        return true;
      } catch {}

      // Fallback: just activate iTerm2 or Terminal.app
      try {
        execSync(`osascript -e 'tell application "iTerm" to activate'`, { stdio: 'pipe' });
        return true;
      } catch {}
      try {
        execSync(`osascript -e 'tell application "Terminal" to activate'`, { stdio: 'pipe' });
        return true;
      } catch {}
    } catch {}
  }

  // Linux/other: not much we can do without window manager integration
  return false;
}

module.exports = { detectTerminals, openInTerminal, focusTerminalByPid };
