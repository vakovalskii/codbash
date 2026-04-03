// Assembles the full HTML page by inlining CSS and JS from frontend/ files
const fs = require('fs');
const path = require('path');

const FRONTEND_DIR = path.join(__dirname, 'frontend');

function buildHTML() {
  const template = fs.readFileSync(path.join(FRONTEND_DIR, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(FRONTEND_DIR, 'styles.css'), 'utf8');
  const script = fs.readFileSync(path.join(FRONTEND_DIR, 'app.js'), 'utf8');

  return template
    .replace('{{STYLES}}', styles)
    .replace('{{SCRIPT}}', script);
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
