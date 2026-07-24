'use strict';

// Rebuild electron-updater's mac feed after DMG notarization/stapling.
// Stapling mutates the DMG bytes, so sha512, size, and blockmaps must match the
// final containers that are uploaded to GitHub Releases.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const pkg = require(path.join(root, 'package.json'));
const version = pkg.version;

function findAppBuilder() {
  const pkgPath = require.resolve('app-builder-bin/package.json', { paths: [root] });
  const dir = path.dirname(pkgPath);
  const candidates = process.platform === 'darwin'
    ? [
        path.join(dir, 'mac', process.arch === 'arm64' ? 'app-builder_arm64' : 'app-builder_x64'),
        path.join(dir, 'mac', 'app-builder'),
        path.join(dir, 'mac', 'app-builder_arm64'),
      ]
    : [
        path.join(dir, process.platform === 'win32' ? 'win' : 'linux', process.platform === 'win32' ? 'app-builder.exe' : 'app-builder'),
      ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('app-builder binary not found under ' + dir);
  return found;
}

function sha512(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

function rebuildBlockmap(appBuilder, dmg) {
  const blockmap = dmg + '.blockmap';
  execFileSync(appBuilder, ['blockmap', '--input', dmg, '--output', blockmap], { stdio: 'inherit' });
  return blockmap;
}

function fileInfo(appBuilder, filename) {
  const dmg = path.join(dist, filename);
  if (!fs.existsSync(dmg)) throw new Error('missing DMG: ' + dmg);
  const blockmap = rebuildBlockmap(appBuilder, dmg);
  return {
    url: filename,
    sha512: sha512(dmg),
    size: fs.statSync(dmg).size,
    blockMapSize: fs.statSync(blockmap).size,
  };
}

function yamlString(files) {
  const preferred = process.arch === 'arm64'
    ? files.find((f) => /-arm64\.dmg$/.test(f.url)) || files[0]
    : files.find((f) => !/-arm64\.dmg$/.test(f.url)) || files[0];
  const lines = [
    'version: ' + version,
    'files:',
  ];
  for (const f of files) {
    lines.push('  - url: ' + f.url);
    lines.push('    sha512: ' + f.sha512);
    lines.push('    size: ' + f.size);
    lines.push('    blockMapSize: ' + f.blockMapSize);
  }
  lines.push('path: ' + preferred.url);
  lines.push('sha512: ' + preferred.sha512);
  lines.push('releaseDate: ' + new Date().toISOString());
  lines.push('');
  return lines.join('\n');
}

const appBuilder = findAppBuilder();
const files = [
  fileInfo(appBuilder, 'codbash-' + version + '-arm64.dmg'),
  fileInfo(appBuilder, 'codbash-' + version + '.dmg'),
];
const target = path.join(dist, 'latest-mac.yml');
fs.writeFileSync(target, yamlString(files));
console.log('[release] wrote ' + target);
