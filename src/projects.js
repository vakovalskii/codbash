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
function saveProjects(list) {
  ensureDir(path.dirname(PROJECTS_FILE));
  const tmp = PROJECTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ projects: list }, null, 2));
  fs.renameSync(tmp, PROJECTS_FILE);
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
    if (!fs.statSync(abs).isDirectory()) return false;
  } catch {
    return false;
  }
  return true;
}

const ALLOWED_SOURCES = new Set(['manual', 'github-clone']);

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
    if (!/^(https:\/\/github\.com\/|git@github\.com:)/.test(remoteUrl)) {
      return reject(new Error('only GitHub remotes are supported'));
    }
    const abs = path.resolve(destDir);
    if (!abs.startsWith(os.homedir() + path.sep) && abs !== os.homedir()) {
      return reject(new Error('clone destination must be under your home directory'));
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
};
