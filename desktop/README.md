# codbash desktop (Electron)

A native window around the **unmodified** codbash server. This is an *addition*:
the npm CLI (`codbash run`) and the zero-dependency core are untouched — Electron
lives entirely in this folder with its own `package.json`.

## How it works

`main.js` (Electron main process):

1. picks a free loopback port,
2. spawns the real codbash server as a **Node child process**
   (`node ../bin/cli.js run --port=<p> --host=127.0.0.1 --no-browser`),
3. waits until `http://127.0.0.1:<p>/` answers,
4. opens a `BrowserWindow` pointed at it.

The server runs under a normal Node runtime (not Electron's), so the prebuilt
native `@lydell/node-pty` loads with no rebuild — **the browser terminal keeps
working**. External `http(s)` links open in the user's real browser.

## Run in development

```bash
# from the repo root, make sure core deps (incl. the optional terminal) are present
npm install

cd desktop
npm install          # fetches electron + electron-builder (dev-only)
npm start            # launches the app window
```

Smoke test (launches, verifies server+window, auto-quits):

```bash
npm run smoke
```

Override the Node binary used for the server child (rarely needed):

```bash
CODBASH_NODE=/usr/local/bin/node npm start
```

## Build a macOS app

```bash
cd desktop
npm run dist:mac     # → dist/codbash-<version>.dmg  (universal arm64 + x64)
```

### Before you ship it

- **Icon**: drop a `build/icon.icns` (1024×1024 source). Without it Electron uses a default icon.
- **Bundled Node**: the packaged app spawns `node` from `PATH`. For a self-contained
  DMG, place a `node` binary in the app resources (electron-builder `extraResources`)
  and `resolveNodeBin()` will prefer it. Most codbash users already have Node, so
  PATH works out of the box for a dev/internal build.
- **node_modules**: `@lydell/node-pty` is copied into the packaged resources
  (see `extraResources`). If you add other optional runtime deps, copy them too.
- **Signing + notarization** (for Gatekeeper / distribution outside the App Store):
  set `CSC_LINK`/`CSC_KEY_PASSWORD` (Developer ID cert) and configure notarization
  in `build.mac`. Do **not** target the Mac App Store — codbash spawns processes,
  drives Terminal.app via AppleScript, and reads across the filesystem, which the
  App Store sandbox forbids.

## What is NOT cut

Nothing functional. A desktop app has the same (local) privileges the CLI relies
on, so sessions, cost, the browser terminal, project launch, terminal detection,
etc. all work. The only *replacements* for a packaged build are: self-update
(use an Electron updater instead of `npm i -g`) and not assuming a system
`sqlite3` on PATH under a sandbox (codbash shells out to it for the SQLite-backed
agents; macOS ships `sqlite3`, so unsandboxed builds are fine).
