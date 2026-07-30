'use strict';

// Refresh electron-updater's macOS feed (dist/latest-mac.yml) after the DMG
// containers are notarized + stapled.
//
// Why: stapling mutates the DMG bytes, so any feed entry pointing at a file that
// changed on disk needs a fresh sha512/size/blockMapSize or the updater rejects
// the download. With the zip target #272 ships, the *.zip entries (the actual
// mac update artifact) are NOT touched by stapling, so this is a no-op for them
// — only a changed file (e.g. a stapled DMG that appears in the feed) is
// refreshed. Detection is by sha512 mismatch, so re-running is idempotent.
//
// Unlike a hand-authored feed, this PARSES electron-builder's own latest-mac.yml
// and only rewrites the numbers in place — it never invents the schema, the arch
// mapping, or the `path` choice, so it can't silently produce a broken feed.
// Generalises the idea from PR #271 (thanks @indapublic) to the zip+dmg feed.
//
// ⚠️ Validate on the next real signed build: run `npm run refresh-update-feed`
// after stapling and confirm `dist/latest-mac.yml` still matches the uploaded
// artifacts (electron-updater 404s / checksum-fails loudly if it doesn't).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const FEED = path.join(DIST, 'latest-mac.yml');

function sha512Base64(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

function findAppBuilder() {
  const pkgPath = require.resolve('app-builder-bin/package.json', { paths: [ROOT] });
  const dir = path.dirname(pkgPath);
  const candidates = [
    path.join(dir, 'mac', process.arch === 'arm64' ? 'app-builder_arm64' : 'app-builder_x64'),
    path.join(dir, 'mac', 'app-builder'),
    path.join(dir, 'mac', 'app-builder_arm64'),
    path.join(dir, 'mac', 'app-builder_x64'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('app-builder binary not found under ' + dir);
  return found;
}

function regenerateBlockmap(appBuilder, file) {
  const blockmap = file + '.blockmap';
  execFileSync(appBuilder, ['blockmap', '--input', file, '--output', blockmap], { stdio: 'inherit' });
  return fs.statSync(blockmap).size;
}

// ── Pure helpers (unit-tested; no disk/electron-builder needed) ───────────────

// Parse the files[] entries of a latest-mac.yml into [{url, sha512, size,
// blockMapSize}]. Tolerant of key order; a top-level (column-0) key ends a block.
function parseFeedEntries(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let cur = null;
  let itemIndent = -1;
  for (const line of lines) {
    const item = line.match(/^(\s*)-\s*url:\s*(.+?)\s*$/);
    if (item) {
      cur = { url: item[2] };
      itemIndent = item[1].length;
      entries.push(cur);
      continue;
    }
    if (/^\S/.test(line)) { cur = null; continue; } // column-0 key ends the block
    if (!cur) continue;
    const kv = line.match(/^(\s*)(sha512|size|blockMapSize):\s*(.+?)\s*$/);
    if (kv && kv[1].length > itemIndent) {
      if (kv[2] === 'size' || kv[2] === 'blockMapSize') cur[kv[2]] = Number(kv[3]);
      else cur[kv[2]] = kv[3];
    }
  }
  return entries;
}

// Rewrite sha512/size/blockMapSize for each url present in infoByUrl, and sync
// the top-level `sha512:` to the file named by the top-level `path:`. Any field
// left undefined in infoByUrl[url] is preserved as-is.
function rewriteFeedYaml(text, infoByUrl) {
  const eol = text.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let curUrl = null;
  let itemIndent = -1;
  let pathUrl = null;
  const out = lines.map((line) => {
    const item = line.match(/^(\s*)-\s*url:\s*(.+?)\s*$/);
    if (item) { curUrl = item[2]; itemIndent = item[1].length; return line; }
    const topKey = line.match(/^(\S[^:]*):\s*(.*)$/);
    if (topKey) {
      curUrl = null;
      if (topKey[1] === 'path') { pathUrl = topKey[2].trim(); return line; }
      if (topKey[1] === 'sha512' && pathUrl && infoByUrl[pathUrl] && infoByUrl[pathUrl].sha512 != null) {
        return 'sha512: ' + infoByUrl[pathUrl].sha512;
      }
      return line;
    }
    if (curUrl && infoByUrl[curUrl]) {
      const kv = line.match(/^(\s*)(sha512|size|blockMapSize):\s*(.+?)\s*$/);
      if (kv && kv[1].length > itemIndent) {
        const info = infoByUrl[curUrl];
        if (kv[2] === 'sha512' && info.sha512 != null) return kv[1] + 'sha512: ' + info.sha512;
        if (kv[2] === 'size' && info.size != null) return kv[1] + 'size: ' + info.size;
        if (kv[2] === 'blockMapSize' && info.blockMapSize != null) return kv[1] + 'blockMapSize: ' + info.blockMapSize;
      }
    }
    return line;
  });
  return out.join(eol);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(FEED)) {
    throw new Error('missing ' + FEED + ' — build the mac targets first (dmg + zip)');
  }
  const text = fs.readFileSync(FEED, 'utf8');
  const entries = parseFeedEntries(text);
  if (!entries.length) throw new Error('no files[] entries found in ' + FEED);

  let appBuilder = null;
  const infoByUrl = {};
  let changed = 0;
  for (const e of entries) {
    const file = path.join(DIST, e.url);
    if (!fs.existsSync(file)) throw new Error('feed references a missing artifact: ' + file);
    const sha = sha512Base64(file);
    const size = fs.statSync(file).size;
    const info = { sha512: sha, size };
    if (sha !== e.sha512) {
      // Bytes changed since build (e.g. a stapled DMG) — its blockmap is stale too.
      const bm = file + '.blockmap';
      if (fs.existsSync(bm)) {
        appBuilder = appBuilder || findAppBuilder();
        info.blockMapSize = regenerateBlockmap(appBuilder, file);
      }
      changed++;
      console.log('[feed] refreshed ' + e.url + ' (bytes changed)');
    } else {
      console.log('[feed] unchanged ' + e.url);
    }
    infoByUrl[e.url] = info;
  }

  fs.writeFileSync(FEED, rewriteFeedYaml(text, infoByUrl));
  console.log('[feed] wrote ' + FEED + ' (' + changed + '/' + entries.length + ' entries refreshed)');
}

module.exports = { parseFeedEntries, rewriteFeedYaml };

if (require.main === module) {
  try { main(); } catch (e) { console.error('[feed] ' + ((e && e.message) || e)); process.exit(1); }
}
