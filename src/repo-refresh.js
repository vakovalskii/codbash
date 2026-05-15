'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_SETTINGS_PATH = path.join(os.homedir(), '.codedash', 'refresh-settings.json');

const DEFAULT_SETTINGS = {
  version: 1,
  refreshOnStartup: false,
  perProject: {},
};

function defaultRepoState() {
  return {
    status: 'idle',
    startedAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastErrorAt: null,
  };
}

function defaultLogger() {
  return {
    warn: (msg) => { try { console.warn('[repo-refresh]', msg); } catch {} },
    error: (msg) => { try { console.error('[repo-refresh]', msg); } catch {} },
  };
}

function createRepoRefreshManager(opts = {}) {
  const execFile = opts.execFile || require('child_process').execFile;
  const atomicWriteJson = opts.atomicWriteJson || require('./atomic').atomicWriteJson;
  const settingsPath = opts.settingsPath || DEFAULT_SETTINGS_PATH;
  const maxConcurrency = opts.maxConcurrency ?? 4;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? 60_000;
  const sigkillGraceMs = opts.sigkillGraceMs ?? 2_000;
  const debounceMs = opts.debounceMs ?? 500;
  const resolveGitRoot = opts.resolveGitRoot || ((p) => p);
  const existsSync = opts.existsSync || fs.existsSync;
  const logger = opts.logger || defaultLogger();
  // Optional: when set, initOnStartup only fires for gitRoots also present in
  // the known set — so a settings-file injection cannot make codbash fetch
  // arbitrary user paths on next launch. Callable from outside via
  // `setKnownGitRootsProvider` so the host can wire it after construction.
  let getKnownGitRoots = opts.getKnownGitRoots || null;
  function setKnownGitRootsProvider(fn) { getKnownGitRoots = typeof fn === 'function' ? fn : null; }

  const state = new Map();       // gitRoot -> RepoState
  const inflight = new Map();    // gitRoot -> Promise<RepoState>
  const waiters = new Map();     // gitRoot -> Set<(state)=>void> for waitForRefreshOrTimeout
  let settings = { ...DEFAULT_SETTINGS };
  let saveTimer = null;
  // Track every manager-owned setTimeout so shutdown() can cancel them.
  // We deliberately do NOT .unref() these timers — node:test treats unref'd
  // timers as if they don't keep the event loop alive, so awaiting a Promise
  // whose only "alive" handle is an unref'd timer reports as
  // "Promise resolution is still pending but the event loop has already
  // resolved" (observed on macOS/ubuntu CI runners). Hosts should call
  // shutdown() at process exit instead to release timers gracefully.
  const pendingTimers = new Set();
  // Track spawned children so shutdown() can SIGTERM them on host teardown.
  const inflightChildren = new Set();
  // Track each in-flight runFetch finalizer so shutdown() can resolve the
  // promise. Without this, an unresolved fetch leaves a pending promise that
  // node:test flags as "Promise resolution is still pending" on stricter
  // hosts (e.g. macOS CI runners), even after timers are cancelled.
  const activeFinalizers = new Set();
  let isShutdown = false;

  // ── Semaphore ────────────────────────────────────────────
  // Synchronous when capacity is available so triggerRefresh can spawn the
  // child process before returning (tests rely on this).
  const sem = { running: 0, queue: [] };
  function tryAcquireSync() {
    if (sem.running < maxConcurrency) { sem.running++; return true; }
    return false;
  }
  function acquireAsync() {
    return new Promise(resolve => {
      sem.queue.push(() => { sem.running++; resolve(); });
    });
  }
  function release() {
    sem.running--;
    const next = sem.queue.shift();
    if (next) next();
  }

  // ── State management ─────────────────────────────────────
  function setState(gitRoot, partial) {
    const prev = state.get(gitRoot) || defaultRepoState();
    const next = { ...prev, ...partial };
    state.set(gitRoot, next);
    return next;
  }

  // Strip credentials from URLs of the form https://user:token@host so that
  // git's "Authentication failed for 'https://USER:TOKEN@host'" stderr never
  // ends up in /api/repo-refresh/state (which the browser polls).
  function redactCredentials(msg) {
    if (!msg) return '';
    return String(msg).replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1<redacted>@');
  }

  function truncateErr(msg) {
    if (!msg) return '';
    const s = redactCredentials(msg).trim();
    return s.length > 200 ? s.slice(0, 200) : s;
  }

  // ── Fetch runner ─────────────────────────────────────────
  function runFetch(gitRoot) {
    return new Promise((resolve) => {
      let timeoutFired = false;
      let killTimer = null;
      let timeoutTimer = null;
      let settled = false;

      const finalize = (next) => {
        if (settled) return;
        settled = true;
        activeFinalizers.delete(finalize);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        resolve(next);
      };
      activeFinalizers.add(finalize);

      const cleanupTimers = () => {
        if (timeoutTimer) { pendingTimers.delete(timeoutTimer); clearTimeout(timeoutTimer); timeoutTimer = null; }
        if (killTimer) { pendingTimers.delete(killTimer); clearTimeout(killTimer); killTimer = null; }
      };

      const child = execFile('git', ['-C', gitRoot, 'fetch', '--all', '--prune'], {
        timeout: 0, // we manage timeout manually for SIGTERM → SIGKILL escalation
        windowsHide: true,
      }, (err, stdout, stderr) => {
        inflightChildren.delete(child);
        if (timeoutFired) {
          cleanupTimers();
          finalize(setState(gitRoot, {
            status: 'error',
            startedAt: null,
            lastError: truncateErr('timeout after ' + fetchTimeoutMs + 'ms'),
            lastErrorAt: Date.now(),
          }));
          return;
        }
        if (err) {
          cleanupTimers();
          const errStderr = err.stderr || stderr || '';
          const msg = errStderr || err.message || 'git fetch failed';
          finalize(setState(gitRoot, {
            status: 'error',
            startedAt: null,
            lastError: truncateErr(msg),
            lastErrorAt: Date.now(),
          }));
          return;
        }
        cleanupTimers();
        finalize(setState(gitRoot, {
          status: 'idle',
          startedAt: null,
          lastSuccessAt: Date.now(),
          lastError: null,
          lastErrorAt: null,
        }));
      });
      inflightChildren.add(child);

      timeoutTimer = setTimeout(() => {
        pendingTimers.delete(timeoutTimer);
        timeoutFired = true;
        try { child.kill('SIGTERM'); } catch {}
        killTimer = setTimeout(() => {
          pendingTimers.delete(killTimer);
          try { child.kill('SIGKILL'); } catch {}
        }, sigkillGraceMs);
        pendingTimers.add(killTimer);
      }, fetchTimeoutMs);
      pendingTimers.add(timeoutTimer);
    });
  }

  // ── Public API ───────────────────────────────────────────
  function triggerRefresh(gitRoot) {
    const existing = inflight.get(gitRoot);
    if (existing) return existing;

    setState(gitRoot, { status: 'fetching', startedAt: Date.now(), lastError: null, lastErrorAt: null });

    const startFetch = () => runFetch(gitRoot).then((finalState) => {
      release();
      return finalState;
    }, (err) => {
      release();
      throw err;
    });

    const promise = tryAcquireSync()
      ? startFetch()
      : acquireAsync().then(startFetch);

    inflight.set(gitRoot, promise);
    promise.then((finalState) => {
      if (inflight.get(gitRoot) === promise) inflight.delete(gitRoot);
      const ws = waiters.get(gitRoot);
      if (ws) {
        for (const w of ws) w(finalState);
        waiters.delete(gitRoot);
      }
    }, () => {
      // runFetch never rejects, but guard anyway.
      if (inflight.get(gitRoot) === promise) inflight.delete(gitRoot);
    });

    return promise;
  }

  function triggerAllEnabled() {
    const promises = [];
    for (const [gitRoot, cfg] of Object.entries(settings.perProject)) {
      if (cfg && cfg.autoRefreshOnNewChat) {
        promises.push(triggerRefresh(gitRoot));
      }
    }
    return Promise.all(promises).then(() => {});
  }

  function waitForRefreshOrTimeout(gitRoot, timeoutMs) {
    return new Promise((resolve) => {
      const current = inflight.get(gitRoot);
      if (!current) {
        resolve({ state: state.get(gitRoot) || defaultRepoState(), timedOut: false });
        return;
      }

      let settled = false;
      let to = null;

      const onDone = (finalState) => {
        if (settled) return;
        settled = true;
        if (to) clearTimeout(to);
        resolve({ state: finalState, timedOut: false });
      };

      let bucket = waiters.get(gitRoot);
      if (!bucket) { bucket = new Set(); waiters.set(gitRoot, bucket); }
      bucket.add(onDone);

      to = setTimeout(() => {
        pendingTimers.delete(to);
        if (settled) return;
        settled = true;
        bucket.delete(onDone);
        if (bucket.size === 0) waiters.delete(gitRoot);
        resolve({ state: state.get(gitRoot) || defaultRepoState(), timedOut: true });
      }, timeoutMs);
      pendingTimers.add(to);
    });
  }

  function getState() {
    const repos = {};
    for (const [k, v] of state) repos[k] = v;
    return { repos, settings };
  }

  // ── Settings ─────────────────────────────────────────────
  // Note: we read the settings file via fs.readFileSync directly (not the
  // injected existsSync) — `existsSync` is reserved for orphan-cleanup of
  // perProject keys, where a test may scope it to specific gitRoots.
  function loadSettings() {
    let raw;
    try {
      raw = fs.readFileSync(settingsPath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        settings = { ...DEFAULT_SETTINGS };
        return;
      }
      logger.warn('Failed to read refresh settings, using defaults: ' + err.message);
      settings = { ...DEFAULT_SETTINGS };
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      settings = {
        ...DEFAULT_SETTINGS,
        ...parsed,
        perProject: (parsed && parsed.perProject && typeof parsed.perProject === 'object') ? parsed.perProject : {},
      };
    } catch (err) {
      logger.warn('Failed to parse refresh settings, using defaults: ' + err.message);
      settings = { ...DEFAULT_SETTINGS };
    }
  }

  function scheduleSave() {
    if (saveTimer) { clearTimeout(saveTimer); pendingTimers.delete(saveTimer); }
    saveTimer = setTimeout(() => {
      pendingTimers.delete(saveTimer);
      saveTimer = null;
      try {
        // 0o600 — settings include the user's project list; keep them
        // readable only by the owner on shared machines.
        atomicWriteJson(settingsPath, settings, { mode: 0o600 });
      } catch (err) {
        logger.error('Failed to save refresh settings: ' + err.message);
      }
    }, debounceMs);
    pendingTimers.add(saveTimer);
  }

  function updateSettings(partial) {
    const next = { ...settings };
    if (Object.prototype.hasOwnProperty.call(partial, 'refreshOnStartup')) {
      next.refreshOnStartup = !!partial.refreshOnStartup;
    }
    if (partial.perProject && typeof partial.perProject === 'object') {
      next.perProject = { ...settings.perProject, ...partial.perProject };
    }
    settings = next;
    scheduleSave();
    return settings;
  }

  function gcOrphans() {
    const cleaned = {};
    let changed = false;
    for (const [key, value] of Object.entries(settings.perProject)) {
      let alive = false;
      try {
        // existsSync is the cheap, reliable check. resolveGitRoot may throw
        // for transient reasons (timeout, EAGAIN) — treat a thrown
        // resolveGitRoot as "still alive" so we don't nuke valid settings.
        if (existsSync(key)) {
          try {
            alive = resolveGitRoot(key) !== '';
          } catch (e) {
            logger.warn('gcOrphans: resolveGitRoot threw for ' + key + ': ' + e.message + ' (keeping entry)');
            alive = true;
          }
        }
      } catch (e) {
        logger.warn('gcOrphans: existsSync threw for ' + key + ': ' + e.message + ' (keeping entry)');
        alive = true;
      }
      if (alive) cleaned[key] = value;
      else changed = true;
    }
    if (changed) {
      settings = { ...settings, perProject: cleaned };
      scheduleSave();
    }
  }

  function initOnStartup() {
    gcOrphans();
    if (!settings.refreshOnStartup) return;
    // If the host wired a known-roots resolver, require every entry to be
    // present there before firing. Defense against settings-file injection.
    let known = null;
    if (getKnownGitRoots) {
      try { known = getKnownGitRoots(); } catch { known = null; }
    }
    for (const [gitRoot, cfg] of Object.entries(settings.perProject)) {
      if (!cfg || !cfg.autoRefreshOnNewChat) continue;
      // When `known` is null the gate isn't wired — open mode for backward
      // compatibility. When `known` is a Set (even empty) we're in gated mode:
      // empty means "no paths are trusted", NOT "all paths are trusted".
      if (known !== null && !known.has(gitRoot)) {
        logger.warn('initOnStartup: skipping ' + path.basename(gitRoot) + ' (not in known projects)');
        continue;
      }
      // Fire and forget — errors land in per-repo state, not as unhandled rejection.
      triggerRefresh(gitRoot).catch(() => {});
    }
  }

  // Cancel every manager-owned timer and signal SIGTERM to any in-flight git
  // fetch children. Safe to call multiple times. Intended for test teardown
  // and host process shutdown — once called, the manager should not be used
  // for new operations (no internal flag enforces this; callers decide).
  function shutdown() {
    if (isShutdown) return;
    isShutdown = true;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    for (const t of pendingTimers) clearTimeout(t);
    pendingTimers.clear();
    for (const child of inflightChildren) {
      try { child.kill('SIGTERM'); } catch {}
    }
    inflightChildren.clear();
    // Resolve every in-flight fetch with a synthetic "cancelled" error state
    // so callers awaiting the promise don't hang and node:test does not flag
    // pending promises at teardown. Snapshot first — finalize mutates the Set.
    const pending = [...activeFinalizers];
    activeFinalizers.clear();
    for (const fin of pending) {
      try {
        fin({
          status: 'error',
          startedAt: null,
          lastError: 'cancelled (manager shutdown)',
          lastErrorAt: Date.now(),
        });
      } catch {}
    }
  }

  // Load settings synchronously on construction.
  loadSettings();

  return {
    triggerRefresh,
    waitForRefreshOrTimeout,
    getState,
    updateSettings,
    initOnStartup,
    setKnownGitRootsProvider,
    shutdown,
    // Exposed for tests only — production callers should never invoke these
    // directly (loadSettings can drop in-flight debounced changes;
    // triggerAllEnabled duplicates initOnStartup minus the known-roots gate).
    __test: { loadSettings, triggerAllEnabled },
  };
}

const repoRefreshManager = createRepoRefreshManager();

module.exports = {
  createRepoRefreshManager,
  repoRefreshManager,
  DEFAULT_SETTINGS_PATH,
};
