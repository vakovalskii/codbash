# Releasing the codbash macOS app (sign · notarize · publish)

The build is **signed** with a Developer ID Application cert, **notarized** by
the `afterSign` hook (`scripts/notarize.js`) + a follow-up pass for the DMG
containers, and **published** to GitHub Releases where the in-app notify-updater
picks it up. Releases since **v7.14.4** are signed + notarized (arm64 + x64) and
open with no Gatekeeper warning. With no credentials the build still succeeds and
produces an unsigned DMG for local smoke-testing (the notarize hook no-ops).

## 0. One-time setup

### Apple Developer account
- Enroll in the Apple Developer Program (~$99/yr).
- In **Certificates, IDs & Profiles**, create a **Developer ID Application**
  certificate. Download and double-click it to install into your **login keychain**.
  (Do *not* use a Mac App Store cert — codbash spawns processes, drives
  Terminal.app via AppleScript and reads across the filesystem, so it ships
  **outside** the App Store.)
- Find your **Team ID** (10 chars) at the top-right of the developer portal.

### App-specific password (for notarytool)
- Go to https://appleid.apple.com → **Sign-In & Security → App-Specific Passwords**.
- Generate one (e.g. label it `codbash-notarize`). Copy the `xxxx-xxxx-xxxx-xxxx` value.

## 1. Notarization credentials

**Preferred — a keychain profile** (no secret in env/shell history/CI logs):

```bash
xcrun notarytool store-credentials "codbash-notary" \
  --apple-id "you@example.com" \
  --team-id  "A933C2TJXU"
# prompts (hidden) for the app-specific password; stored in the login keychain.
```

The build reads it via `APPLE_KEYCHAIN_PROFILE` (see `scripts/notarize.js`).

**Alternative — env vars** (e.g. CI):

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="A933C2TJXU"
# and, only if the Developer ID cert is NOT already in the login keychain:
export CSC_LINK="/absolute/path/DeveloperIDApplication.p12"
export CSC_KEY_PASSWORD="<p12 export password>"
```

## 2. Build (signed + notarized, both arches)

```bash
cd desktop
npm install                 # once, or after dependency changes

# ⚠️ Build over a VPN with proxy env vars UNSET (see the timestamp note below).
env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY -u https_proxy -u http_proxy -u all_proxy \
  APPLE_KEYCHAIN_PROFILE=codbash-notary CSC_IDENTITY_AUTO_DISCOVERY=true \
  ./node_modules/.bin/electron-builder --mac --arm64 --x64
```

- Pass `--arm64 --x64` explicitly. Passing a target on the CLI (`… dmg`)
  **overrides** the `arch` array in `package.json`, so `npm run dist:mac`
  builds only the host arch.
- The `mac.target` array now builds **both `dmg` and `zip`** for each arch. The
  DMG is the first-install download; the **`.zip` is what electron-updater
  installs from** (Squirrel.Mac can't apply a DMG). `latest-mac.yml` must
  reference the zips, so ship the zips + their blockmaps in the Release too.
- The signing identity is pinned in `package.json` → `build.mac.identity` as
  `"Valeriy Kovalsky (A933C2TJXU)"` — **without** the `Developer ID Application:`
  prefix (electron-builder rejects the prefix).
- The `afterSign` hook (`scripts/notarize.js`) notarizes and staples **each
  `.app`**. The DMG *containers* are notarized + stapled separately (step 2b),
  since electron-builder builds the DMG after the hook runs.

**2b. Notarize + staple the DMG containers, then regenerate the update feed**
(the staple mutates the DMG, so blockmaps + `latest-mac.yml` must be recomputed):

```bash
for dmg in dist/codbash-<ver>-arm64.dmg dist/codbash-<ver>.dmg; do
  xcrun notarytool submit "$dmg" --keychain-profile codbash-notary --wait
  xcrun stapler staple "$dmg"
  ./node_modules/app-builder-bin/mac/app-builder_arm64 blockmap \
    --input "$dmg" --output "$dmg.blockmap"   # prints the {size,sha512} for latest-mac.yml
done
# then rewrite dist/latest-mac.yml with the new size+sha512 for both DMGs.
```

Publish (include the **zips + their blockmaps** — electron-updater installs from
the zip, and `latest-mac.yml` points at it; a Release with only the DMGs makes
in-app update fail with a 404 for the zip):

```bash
gh release create v<ver> --title "codbash <ver> (macOS desktop)" --target main \
  dist/codbash-<ver>-arm64.dmg        dist/codbash-<ver>-arm64.dmg.blockmap \
  dist/codbash-<ver>.dmg              dist/codbash-<ver>.dmg.blockmap \
  dist/codbash-<ver>-arm64-mac.zip    dist/codbash-<ver>-arm64-mac.zip.blockmap \
  dist/codbash-<ver>-mac.zip          dist/codbash-<ver>-mac.zip.blockmap \
  dist/latest-mac.yml
```

> Keep `version` in both `package.json` and `desktop/package.json` in step, and
> tag `v<ver>` so the release lines up.

## 3. Verify

```bash
# App: notarized + stapled + Gatekeeper-accepted
xcrun stapler validate "dist/mac-arm64/codbash.app"
spctl -a -vvv -t exec  "dist/mac-arm64/codbash.app"      # → accepted, source=Notarized Developer ID
# DMG: notarized ticket stapled (spctl on the raw DMG is a false negative — the
# container isn't code-signed; Gatekeeper checks the notarization ticket)
xcrun stapler validate "dist/codbash-<ver>-arm64.dmg"
# Real-world check: mount a QUARANTINED copy and assess the app inside
cp dist/codbash-<ver>-arm64.dmg /tmp/q.dmg && xattr -w com.apple.quarantine "0083;0;Safari;" /tmp/q.dmg
hdiutil attach /tmp/q.dmg -nobrowse; spctl -a -vvv -t exec "/Volumes/codbash <ver>/codbash.app"
```

## 4. Updates

- **Current model — in-app update via `electron-updater`** (`main.js` →
  `initAutoUpdater` / IPC handlers in `registerIpc`, driven by the dashboard's
  update banner in `src/frontend/app.js`). On launch and every 6h the app checks
  GitHub Releases (`latest-mac.yml` / `latest.yml`). Flow: **available → user
  clicks Download → progress → downloaded → user clicks Restart → relaunch onto
  the new version.** No manual DMG download. `autoDownload` is off so the user
  controls when the download starts.
- **What the Release MUST contain for it to work:**
  - macOS: the **zips + blockmaps** and a `latest-mac.yml` that references them
    (see step 2b / publish). The app must be **signed + notarized** (it is since
    v7.14.4) — Squirrel.Mac refuses an unsigned in-place update.
  - Windows: the **NSIS `*.exe`** (+ blockmap) and `latest.yml` (electron-builder
    emits these for the `nsis` target). Without a Windows code-signing cert the
    update still applies but SmartScreen warns on first run.
- **Fallback:** if the in-place update can't apply (unsigned/dev/download error),
  the app emits an `error` state and the banner switches to **"Open download
  page"** (`codbash:open-releases` → GitHub releases). The user is never stuck.
- **The web self-update route (`POST /api/update` → `npm i -g`) is disabled in
  the desktop app** — `desktop/main.js` sets `CODBASH_DESKTOP=1` and the server
  refuses it (returns 400). That route is only for the npm CLI (`codbash run`).

### Windows build (NSIS)

```bash
cd desktop
npm install
./node_modules/.bin/electron-builder --win nsis   # or: npm run dist:win
# emits dist/codbash Setup <ver>.exe (+ .blockmap) and dist/latest.yml
gh release upload v<ver> \
  "dist/codbash Setup <ver>.exe" "dist/codbash Setup <ver>.exe.blockmap" \
  dist/latest.yml
```

> The `nsis` target (not `portable`) is required for electron-updater.
>
> **⚠️ Security — do not ship Windows *auto-update* to real users unsigned.**
> electron-updater's `verifyUpdateCodeSignature` compares the running app's
> Authenticode publisher against the downloaded installer's; with no Windows
> code-signing cert on either side that check is a no-op, leaving only the
> `sha512` in `latest.yml` (which comes from the same release pipeline an
> attacker would compromise). An unsigned *in-place auto-updater* is strictly
> worse than a manual download-and-run, because it removes the last human
> checkpoint. Until an OV/EV cert is in place, keep Windows on the notify-only
> fallback (open the releases page) rather than enabling silent download+install.
> `allowDowngrade` and `allowPrerelease` are pinned `false` in `main.js` so a
> mistagged or rolled-back release can't reach stable users regardless.

## CI note

Tracked workflows live in `.github/workflows/`: `ci.yml` (tests on push/PR) and
`publish.yml` (npm publish — **manual** `workflow_dispatch`, not on release, so a
desktop DMG release never triggers a CLI publish). There is **no** CI job for the
DMG: notarization needs a macOS runner plus the signing cert + notary creds, and
the signed build must run over a VPN with the proxy unset (see step 2 / the
timestamp note), so the DMG is built and published locally with the commands above.

## Troubleshooting

- **`The timestamp service is not available`** (repeated `signing … retrying`,
  build aborts) → `codesign --timestamp` hits `timestamp.apple.com` via the
  system network stack and **ignores** the `HTTPS_PROXY` env var. If the network
  needs a proxy for outbound HTTPS, every nested file fails. **Fix: turn on a VPN
  and build with the proxy env vars unset** (`env -u HTTPS_PROXY …`, as in step 2).
  Apple's secure timestamp is mandatory for notarization — you can't swap the TSA.
  Pre-flight: sign a throwaway file 5× and expect 5/5 OK before the full build.
- **"app is damaged / unidentified developer"** → not notarized or not stapled;
  confirm the notary credentials (keychain profile or `APPLE_*` vars) were
  available during the build, and that step 2b stapled the DMG.
- **node-pty / terminal fails in the packaged app** → ensure
  `../node_modules/@lydell` is present at build time (it is copied via
  `extraResources`); run `npm install` at the repo root first.
- **`node` not found when the app launches** → the packaged app runs the server
  with `node` from `PATH`. For a fully self-contained DMG, drop a `node` binary
  into the app resources (electron-builder `extraResources`) — `resolveNodeBin()`
  prefers it. Most codbash users already have Node installed.
