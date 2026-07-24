// Manual project registry + GitHub repo discovery + clone helper.
//
// Storage: ~/.codedash/projects.json
//   { projects: [{ id, name, path, source, remoteUrl, defaultBranch, addedAt }] }
//
// "source" is one of: 'manual' | 'github-clone'

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

const PROJECTS_FILE = path.join(os.homedir(), '.codedash', 'projects.json');
const DEFAULT_CLONE_ROOT = path.join(os.homedir(), 'code');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadProjects() {
  try {
    const data = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    return Array.isArray(data.projects) ? data.projects : [];
  } catch {
    return [];
  }
}

// Atomic write — temp file + rename so a crashed write never leaves a partial
// file behind. The mutex below serializes read-modify-write operations to
// prevent the classic interleaved-load lost-update race.
// File mode 0600 — contains the user's local workspace layout which is mildly
// sensitive on shared machines. Double-chmod (tmp + final) defends against
// rename-preserves-destination-mode quirks on some Linux filesystems.
function saveProjects(list) {
  ensureDir(path.dirname(PROJECTS_FILE));
  const tmp = PROJECTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ projects: list }, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(tmp, 0o600); } catch {}
  }
  fs.renameSync(tmp, PROJECTS_FILE);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(PROJECTS_FILE, 0o600); } catch {}
  }
}

let _writeLock = Promise.resolve();
function withWriteLock(fn) {
  const next = _writeLock.then(fn, fn);
  _writeLock = next.catch(() => {}); // never break the chain on error
  return next;
}

function normalizePath(p) {
  if (!p) return '';
  // Expand ~ and strip trailing slash
  let out = p;
  if (out.startsWith('~')) out = path.join(os.homedir(), out.slice(1));
  out = path.resolve(out);
  return out;
}

function validatePath(p) {
  if (!p || typeof p !== 'string') throw new Error('path required');
  const abs = normalizePath(p);
  if (!fs.existsSync(abs)) throw new Error('path does not exist: ' + abs);
  // Use lstat first so symlink-to-directory cannot smuggle a hidden target in;
  // realpath then resolves the actual on-disk location for storage.
  const lst = fs.lstatSync(abs);
  if (lst.isSymbolicLink()) throw new Error('symlinks are not allowed as project paths');
  if (!lst.isDirectory()) throw new Error('path is not a directory: ' + abs);
  return fs.realpathSync(abs);
}

// Sanity-check a path string that will be embedded in a shell command later
// (terminals.js builds a `cd "..." && ...` line on macOS/Linux). We refuse
// characters that have meaning to bash inside double-quoted strings even after
// JSON.stringify quoting, and additionally require that the path resolve to an
// existing directory on disk — a real filesystem entry cannot contain `$()` or
// backticks so the check doubles as injection defense.
const UNSAFE_PATH_CHARS = /[$`\n\r;|&<>()*?{}\[\]"']/;
function isSafeLaunchPath(p) {
  if (!p || typeof p !== 'string') return false;
  if (p.length > 1024) return false;
  if (UNSAFE_PATH_CHARS.test(p)) return false;
  try {
    const abs = normalizePath(p);
    if (!fs.existsSync(abs)) return false;
    // lstat first so a symlink pointing to e.g. /opt cannot smuggle a path
    // out of $HOME past the auto-register boundary check. validatePath
    // applies the same defense for the registry-write path.
    const lst = fs.lstatSync(abs);
    if (lst.isSymbolicLink()) return false;
    if (!lst.isDirectory()) return false;
  } catch {
    return false;
  }
  return true;
}

// Cheap "does this registered folder still exist on disk?" check. Registry
// entries persist a path; the user can delete the folder (rm -rf) at any time,
// so existence is derived per-request, never stored. Follows symlinks (statSync)
// on purpose — a still-resolvable symlinked directory counts as present; the
// stricter no-symlink rule only applies when a path is first registered.
function pathExists(p) {
  if (!p || typeof p !== 'string') return false;
  if (p.length > 1024) return false; // match isSafeLaunchPath's cap
  try {
    return fs.statSync(normalizePath(p)).isDirectory();
  } catch {
    return false;
  }
}

// True when `abs` is the home directory or lives under it.
function isUnderHome(abs) {
  return abs === os.homedir() || abs.startsWith(os.homedir() + path.sep);
}

// Resolve the realpath of the nearest existing ancestor of `abs` (including
// `abs` itself if it exists). Used to detect a symlinked parent that would
// redirect a write outside its apparent location. Returns '' if nothing
// resolves (e.g. an unreadable ancestor).
function realpathOfNearestAncestor(abs) {
  let cur = abs;
  // Walk up until we hit an existing path or the filesystem root.
  for (let i = 0; i < 4096; i++) {
    if (fs.existsSync(cur)) {
      try { return fs.realpathSync(cur); } catch { return ''; }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break; // reached root
    cur = parent;
  }
  return '';
}

const ALLOWED_SOURCES = new Set(['manual', 'github-clone', 'auto']);

function addProject({ name, path: projectPath, source, remoteUrl, defaultBranch }) {
  const abs = validatePath(projectPath);
  return withWriteLock(() => {
    const list = loadProjects();
    const existing = list.find(p => p.path === abs);
    if (existing) return existing;

    const project = {
      id: crypto.randomBytes(8).toString('hex'),
      name: String(name || path.basename(abs)).slice(0, 200),
      path: abs,
      source: ALLOWED_SOURCES.has(source) ? source : 'manual',
      remoteUrl: String(remoteUrl || '').slice(0, 500),
      defaultBranch: String(defaultBranch || '').slice(0, 100),
      addedAt: new Date().toISOString(),
    };
    const next = list.concat([project]);
    saveProjects(next);
    return project;
  });
}

function removeProject(id) {
  return withWriteLock(() => {
    const list = loadProjects();
    const next = list.filter(p => p.id !== id);
    if (next.length === list.length) return false;
    saveProjects(next);
    return true;
  });
}

// ── GitHub API helpers ─────────────────────────────────────────

function githubApiGet(token, reqPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: reqPath,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'codbash',
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          let msg = 'HTTP ' + res.statusCode;
          try { const j = JSON.parse(data); if (j.message) msg += ' — ' + j.message; } catch {}
          return reject(new Error(msg));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function mapRepo(repo) {
  return {
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description || '',
    private: !!repo.private,
    htmlUrl: repo.html_url,
    cloneUrl: repo.clone_url,
    sshUrl: repo.ssh_url,
    defaultBranch: repo.default_branch || 'main',
    updatedAt: repo.updated_at,
    pushedAt: repo.pushed_at,
    owner: repo.owner ? repo.owner.login : '',
    permissions: repo.permissions || null,
  };
}

// type: 'owned' (the user is the owner) or 'contributing' (collaborator/org member)
async function listGithubRepos(token, type) {
  if (!token) throw new Error('GitHub not connected');
  const safeType = type === 'contributing' ? 'contributing' : 'owned';
  const affiliation = safeType === 'owned'
    ? 'owner'
    : 'collaborator,organization_member';
  // Page through up to 3 pages = 300 repos. Plenty for most users.
  const all = [];
  for (let page = 1; page <= 3; page++) {
    const data = await githubApiGet(
      token,
      `/user/repos?affiliation=${affiliation}&sort=updated&per_page=100&page=${page}`
    );
    if (!Array.isArray(data) || data.length === 0) break;
    for (const r of data) all.push(mapRepo(r));
    if (data.length < 100) break;
  }
  return all;
}

// ── Clone helper ───────────────────────────────────────────────

function isSafeRepoName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(name);
}

function suggestCloneDir(repoName, cloneRoot) {
  if (!isSafeRepoName(repoName)) throw new Error('invalid repo name');
  return path.join(cloneRoot || DEFAULT_CLONE_ROOT, repoName);
}

// Returns a Promise<{ path, alreadyExisted }>
// If destDir exists and is a git repo with the same remote → treat as success (alreadyExisted=true).
// If destDir exists and is something else → throw.
function cloneRepo(remoteUrl, destDir) {
  return new Promise((resolve, reject) => {
    if (!remoteUrl || typeof remoteUrl !== 'string') {
      return reject(new Error('remoteUrl required'));
    }
    // Anchor the whole URL (not just the prefix) and forbid control characters
    // in the suffix — defence-in-depth over the argv-form execFile below.
    if (!/^(https:\/\/github\.com\/|git@github\.com:)[A-Za-z0-9._/-]+$/.test(remoteUrl)) {
      return reject(new Error('only GitHub remotes are supported'));
    }
    const abs = path.resolve(destDir);
    if (!isUnderHome(abs)) {
      return reject(new Error('clone destination must be under your home directory'));
    }
    // The textual startsWith check above can be defeated if an ANCESTOR of the
    // (currently-missing) destination is a symlink pointing outside $HOME — the
    // exact window the re-clone flow opens ("folder is missing"). Resolve the
    // nearest existing ancestor's realpath and re-assert containment so a
    // planted symlink can't redirect the clone (and its git write) out of home.
    const resolvedAncestor = realpathOfNearestAncestor(abs);
    if (resolvedAncestor && !isUnderHome(resolvedAncestor)) {
      return reject(new Error('clone destination escapes your home directory via a symlinked parent'));
    }
    ensureDir(path.dirname(abs));

    if (fs.existsSync(abs)) {
      // If it's already the same repo, accept it.
      const gitDir = path.join(abs, '.git');
      if (fs.existsSync(gitDir)) {
        try {
          const existing = execFileSync('git', ['-C', abs, 'config', '--get', 'remote.origin.url'], {
            encoding: 'utf8', timeout: 3000, windowsHide: true,
          }).trim();
          if (existing === remoteUrl || existing.replace(/\.git$/, '') === remoteUrl.replace(/\.git$/, '')) {
            return resolve({ path: abs, alreadyExisted: true });
          }
        } catch {}
        return reject(new Error('directory exists with a different git remote: ' + abs));
      }
      const entries = fs.readdirSync(abs).filter(n => !n.startsWith('.DS_Store'));
      if (entries.length > 0) {
        return reject(new Error('destination already exists and is not empty: ' + abs));
      }
    }

    execFile('git', ['clone', '--', remoteUrl, abs], { timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error('git clone failed: ' + (stderr || err.message).trim().slice(0, 500)));
      resolve({ path: abs, alreadyExisted: false });
    });
  });
}

module.exports = {
  PROJECTS_FILE,
  DEFAULT_CLONE_ROOT,
  loadProjects,
  addProject,
  removeProject,
  validatePath,
  normalizePath,
  listGithubRepos,
  cloneRepo,
  suggestCloneDir,
  isSafeRepoName,
  isSafeLaunchPath,
  pathExists,
};
