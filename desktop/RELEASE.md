# Releasing the codbash macOS app (sign · notarize · publish)

The build is **signed** with a Developer ID Application cert, **notarized** by
the `afterSign` hook (`scripts/notarize.js`) + a follow-up pass for the DMG
containers, and **published** to GitHub Releases where `electron-updater` picks
it up. Releases since **v7.14.4** are signed + notarized (arm64 + x64) and
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
done
npm run refresh-update-feed
```

Publish:

```bash
gh release create v<ver> --title "codbash <ver> (macOS desktop)" --target main \
  dist/codbash-<ver>-arm64.dmg dist/codbash-<ver>-arm64.dmg.blockmap \
  dist/codbash-<ver>.dmg       dist/codbash-<ver>.dmg.blockmap \
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

- **Current model — desktop OTA.** On launch and every 6h the app asks
  `electron-updater` to check GitHub Releases, downloads a newer signed DMG in
  the background, then prompts the user to restart and install. The bundled
  server is marked with `CODBASH_DESKTOP=1`, so the web UI does not run the npm
  self-updater inside a packaged app.
- **Required release assets.** Upload both DMGs, both `.blockmap` files, and the
  regenerated `latest-mac.yml`. The feed must be regenerated after stapling
  because stapling changes the DMG bytes and therefore the updater checksums.
- **CLI remains separate.** `codbash update` and `/api/update` still update the
  global npm install when codbash is run as the CLI/source server. Packaged
  desktop builds are updated only through Electron OTA.

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
