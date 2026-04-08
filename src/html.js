// Assembles the full HTML page by inlining CSS and JS from frontend/ files
const fs = require('fs');
const path = require('path');

const FRONTEND_DIR = path.join(__dirname, 'frontend');

// JS files inlined in order (later files can use globals from earlier ones)
const JS_FILES = [
  'app.js',
  'calendar.js',
  'detail.js',
  'heatmap.js',
  'analytics.js',
  'leaderboard.js',
  'cloud.js',
];

function buildHTML() {
  const template = fs.readFileSync(path.join(FRONTEND_DIR, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(FRONTEND_DIR, 'styles.css'), 'utf8');

  const scripts = JS_FILES.map(function(f) {
    const file = path.join(FRONTEND_DIR, f);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  }).join('\n\n');

  return template
    .split('{{STYLES}}').join(styles)
    .split('{{SCRIPT}}').join(scripts);
}

// Cache in production
let cached = null;
function getHTML() {
  if (process.env.NODE_ENV === 'development' || !cached) {
    cached = buildHTML();
  }
  return cached;
}

module.exports = { getHTML };
