const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadEscapers() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'app.js'), 'utf8');
  const match = source.match(/function escHtml[\s\S]*?\nfunction showToast/);
  assert.ok(match, 'escaper block should be present');
  const block = match[0].replace(/\nfunction showToast[\s\S]*$/, '');
  const ctx = {};
  vm.runInNewContext(block + '\nthis.escJsString = escJsString;', ctx);
  return ctx;
}

test('escJsString preserves Windows backslashes for inline onclick arguments', () => {
  const { escJsString } = loadEscapers();
  assert.equal(escJsString('C:\\projects'), 'C:\\\\projects');
  assert.equal(escJsString("C:\\Users\\O'Neil\\repo"), 'C:\\\\Users\\\\O\\&#39;Neil\\\\repo');
});

test('detail resume button uses JS-string escaping for project paths', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'detail.js'), 'utf8');
  assert.match(source, /var jsProject = escJsString\(s\.project \|\| ''\);/);
  assert.ok(
    source.includes("launchPiSession(\\'' + jsId + '\\',\\'' + jsTool + '\\',\\'' + jsProject + '\\')"),
    'Resume onclick should pass jsProject, not raw escHtml(project)'
  );
});

test('detail Pi resume button routes through launchPiSession for resume_target support', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'detail.js'), 'utf8');
  assert.ok(source.includes("launchPiSession(\\'' + jsId + '\\',\\'' + jsTool + '\\',\\'' + jsProject + '\\')"));
  assert.match(source, /resumeTarget: resumeTarget \|\| ''/);
});

test('frontend Pi resume commands use shell-safe single quotes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'app.js'), 'utf8');
  assert.match(source, /function quoteShellArg\(value\)/);
  assert.match(source, /return getPiCommand\(\) \+ ' --resume ' \+ quoteShellArg\(target\);/);
  assert.doesNotMatch(source, /--resume ' \+ JSON\.stringify\(target\)/);
});

test('project Last resume sends Pi resume target when available', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'app.js'), 'utf8');
  assert.match(source, /resumeTarget: \(function\(\) \{/);
  assert.match(source, /if \(\(tool \|\| ''\) !== 'pi'\) return '';/);
  assert.match(source, /return s && s\.resume_target \? s\.resume_target : '';/);
});
