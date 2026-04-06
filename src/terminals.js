'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');

// ── Detect available terminals ──────────────────────────────

function commandExists(cmd) {
  if (!cmd) return false;
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);

  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of extensions) {
      try {
        fs.accessSync(path.join(dir, cmd + ext), fs.constants.X_OK);
        return true;
      } catch {}
    }
  }

  return false;
}

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
    if (commandExists('kitty')) {
      terminals.push({ id: 'kitty', name: 'Kitty', available: true });
    }
    // Check Alacritty
    if (commandExists('alacritty')) {
      terminals.push({ id: 'alacritty', name: 'Alacritty', available: true });
    }
    // Check cmux
    try {
      if (fs.existsSync('/Applications/cmux.app')) {
        terminals.push({ id: 'cmux', name: 'cmux', available: true });
      }
    } catch {}
  } else if (platform === 'linux') {
    const linuxTerms = [
      { id: 'x-terminal-emulator', name: 'Default Terminal', cmd: 'x-terminal-emulator' },
      { id: 'xfce4-terminal', name: 'XFCE Terminal', cmd: 'xfce4-terminal' },
      { id: 'gnome-terminal', name: 'GNOME Terminal', cmd: 'gnome-terminal' },
      { id: 'kgx', name: 'GNOME Console', cmd: 'kgx' },
      { id: 'ptyxis', name: 'Ptyxis', cmd: 'ptyxis' },
      { id: 'konsole', name: 'Konsole', cmd: 'konsole' },
      { id: 'kitty', name: 'Kitty', cmd: 'kitty' },
      { id: 'alacritty', name: 'Alacritty', cmd: 'alacritty' },
      { id: 'tilix', name: 'Tilix', cmd: 'tilix' },
      { id: 'terminator', name: 'Terminator', cmd: 'terminator' },
      { id: 'wezterm', name: 'WezTerm', cmd: 'wezterm' },
      { id: 'foot', name: 'foot', cmd: 'foot' },
      { id: 'xterm', name: 'xterm', cmd: 'xterm' },
    ];
    for (const t of linuxTerms) {
      terminals.push({ ...t, available: commandExists(t.cmd) });
    }
  } else {
    terminals.push({ id: 'cmd', name: 'Command Prompt', available: true });
    terminals.push({ id: 'powershell', name: 'PowerShell', available: true });
    if (commandExists('wt')) {
      terminals.push({ id: 'windows-terminal', name: 'Windows Terminal', available: true });
    }
  }

  return terminals;
}

// ── Terminal launch ─────────────────────────────────────────

function termLog(tag, msg) {
  const ts = new Date().toLocaleTimeString('en-GB');
  const color = tag === 'ERROR' ? '\x1b[31m' : '\x1b[35m';
  console.log(`  ${color}${ts} [${tag}]\x1b[0m ${msg}`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
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
  const platform = process.platform;

  if (platform === 'linux' && !terminalId) {
    const firstAvailable = detectTerminals().find(t => t.available);
    terminalId = firstAvailable ? firstAvailable.id : 'gnome-terminal';
  }

  termLog('TERM', `openInTerminal: terminal=${terminalId || 'default'} tool=${tool} cmd="${fullCmd}"`);

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
      case 'cmux':
        // cmux — just activate it, user manages sessions inside
        execSync(`osascript -e 'tell application "cmux" to activate'`);
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
    const bashCommand = shellQuote(`${fullCmd}; exec bash`);
    switch (terminalId) {
      case 'x-terminal-emulator':
        exec(`x-terminal-emulator -e bash -lc ${bashCommand}`);
        break;
      case 'xfce4-terminal':
        exec(`xfce4-terminal --hold --command ${shellQuote(`bash -lc ${bashCommand}`)}`);
        break;
      case 'kgx':
        exec(`kgx -- bash -lc ${bashCommand}`);
        break;
      case 'ptyxis':
        exec(`ptyxis -- bash -lc ${bashCommand}`);
        break;
      case 'kitty':
        exec(`kitty bash -lc ${bashCommand}`);
        break;
      case 'alacritty':
        exec(`alacritty -e bash -lc ${bashCommand}`);
        break;
      case 'konsole':
        exec(`konsole -e bash -lc ${bashCommand}`);
        break;
      case 'tilix':
        exec(`tilix -e bash -lc ${bashCommand}`);
        break;
      case 'terminator':
        exec(`terminator -x bash -lc ${bashCommand}`);
        break;
      case 'wezterm':
        exec(`wezterm start -- bash -lc ${bashCommand}`);
        break;
      case 'foot':
        exec(`foot bash -lc ${bashCommand}`);
        break;
      case 'xterm':
        exec(`xterm -e bash -lc ${bashCommand}`);
        break;
      case 'gnome-terminal':
      default:
        exec(`gnome-terminal -- bash -lc ${bashCommand}`);
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

      // cmux: activate + flash the surface
      if (detectedTerminal === 'cmux') {
        try {
          execSync(`osascript -e 'tell application "cmux" to activate'`, { stdio: 'pipe', timeout: 2000 });
          try {
            execSync(`cmux trigger-flash --surface ${ttyOut.replace('tty','')} 2>/dev/null`, { stdio: 'pipe', timeout: 2000 });
          } catch {}
          return { ok: true, terminal: 'cmux' };
        } catch {}
      }

      // iTerm2: activate and select the right tab/window by tty
      if (detectedTerminal === 'iTerm2' || !detectedTerminal) {
        try {
          const script = `
            tell application "iTerm"
              activate
              repeat with w in windows
                repeat with t in tabs of w
                  repeat with s in sessions of t
                    set sessionTTY to tty of s
                    if sessionTTY contains "${ttyOut}" or "${ttyOut}" contains sessionTTY then
                      select w
                      tell w to select t
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
