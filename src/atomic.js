'use strict';

const fs = require('fs');
const path = require('path');

function atomicWriteJson(filePath, obj, opts) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = filePath + '.tmp';
  const data = JSON.stringify(obj);
  if (data === undefined) {
    throw new TypeError('atomicWriteJson: value is not JSON-serializable');
  }
  // Default 0o644 preserves the existing cache-file behaviour. Settings files
  // that may contain a user's project map pass { mode: 0o600 } so other users
  // on a shared machine can't read the toggle state.
  const mode = (opts && typeof opts.mode === 'number') ? opts.mode : 0o644;

  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

module.exports = { atomicWriteJson };
