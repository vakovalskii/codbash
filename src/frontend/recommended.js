// "Recommended tools" view — curated companion apps that pair well with
// codbash. Ported from TermDeck's "useful links" section. The list is a plain
// config array so new tools are trivial to add. "Installed" ticks are a
// per-browser preference stored in localStorage (no server state).

var RECOMMENDED_TOOLS = [
  {
    id: 'copyosity',
    name: 'Copyosity',
    tagline: 'Native macOS clipboard manager with on-device intelligence — history, OCR, voice, and a command palette from a hotkey.',
    url: 'https://github.com/vakovalskii/copyosity',
    platform: 'macOS',
    category: 'Productivity'
  },
  {
    id: 'ccstatusline',
    name: 'ccstatusline',
    tagline: 'Highly customizable status line for Claude Code — model, git branch, token usage and more, with powerline styling.',
    url: 'https://github.com/sirmalloc/ccstatusline',
    platform: 'Cross-platform',
    category: 'Claude Code'
  },
  {
    id: 'rustdesk',
    name: 'RustDesk',
    tagline: 'Open-source remote desktop — a self-hostable alternative to TeamViewer / AnyDesk.',
    url: 'https://rustdesk.com',
    platform: 'Windows · macOS · Linux',
    category: 'Remote access'
  },
  {
    id: 'iterm2',
    name: 'iTerm2',
    tagline: 'Powerful terminal emulator for macOS with splits, profiles, search and shell integration.',
    url: 'https://iterm2.com',
    platform: 'macOS',
    category: 'Terminal'
  }
];

var RECOMMENDED_INSTALLED_KEY = 'codedash-tools-installed';

function _loadInstalledTools() {
  try {
    var raw = localStorage.getItem(RECOMMENDED_INSTALLED_KEY);
    if (!raw) return {};
    var obj = JSON.parse(raw);
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch (e) {
    return {};
  }
}

function _saveInstalledTools(map) {
  try {
    localStorage.setItem(RECOMMENDED_INSTALLED_KEY, JSON.stringify(map));
  } catch (e) {
    // private mode / quota — best-effort persistence.
  }
}

// Toggle the "installed" tick for a tool and update just that card in place
// (no full re-render, so scroll position and other cards are untouched).
function toggleToolInstalled(id) {
  var map = _loadInstalledTools();
  if (map[id]) { delete map[id]; } else { map[id] = true; }
  _saveInstalledTools(map);

  var on = !!map[id];
  var card = document.querySelector('.tool-card[data-tool-id="' + id + '"]');
  if (!card) return;
  card.classList.toggle('installed', on);
  var chk = card.querySelector('.tool-installed-check');
  if (chk) chk.setAttribute('aria-checked', on ? 'true' : 'false');
  var lbl = card.querySelector('.tool-installed-label');
  if (lbl) lbl.textContent = on ? 'Installed' : 'Mark installed';
}

function renderRecommended(container) {
  var installed = _loadInstalledTools();
  var html = '<div class="tools-container">';
  html += '<h2 class="heatmap-title">Recommended tools</h2>';
  html += '<p class="tools-intro">Handpicked companion apps that pair well with codbash. Tick the ones you already have.</p>';
  html += '<div class="tools-grid">';

  RECOMMENDED_TOOLS.forEach(function(t) {
    var on = !!installed[t.id];
    html += '<div class="tool-card' + (on ? ' installed' : '') + '" data-tool-id="' + escHtml(t.id) + '">';
    html += '<div class="tool-card-head">';
    html += '<span class="tool-name">' + escHtml(t.name) + '</span>';
    html += '<span class="tool-platform">' + escHtml(t.platform) + '</span>';
    html += '</div>';
    html += '<div class="tool-tagline">' + escHtml(t.tagline) + '</div>';
    html += '<div class="tool-card-foot">';
    html += '<a class="tool-link" href="' + escHtml(t.url) + '" target="_blank" rel="noopener noreferrer">Open ↗</a>';
    html += '<button type="button" class="tool-installed-check" role="checkbox" aria-checked="' + (on ? 'true' : 'false') +
            '" onclick="toggleToolInstalled(\'' + escHtml(t.id) + '\')">';
    html += '<span class="tool-check-box" aria-hidden="true"></span>';
    html += '<span class="tool-installed-label">' + (on ? 'Installed' : 'Mark installed') + '</span>';
    html += '</button>';
    html += '</div>';
    html += '</div>';
  });

  html += '</div></div>';
  container.innerHTML = html;
}
