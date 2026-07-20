# Releasing the codbash macOS app (sign · notarize · publish)

The build is **signed** by electron-builder, **notarized** by the `afterSign`
hook (`scripts/notarize.js`), and **published** to GitHub Releases so the
in-app auto-updater (`electron-updater`) can pick it up. Every step degrades
gracefully: with no credentials you still get a working (unsigned) DMG for
local testing.

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

## 1. Environment variables

```bash
# Signing (only if the Developer ID cert is NOT already in your login keychain):
export CSC_LINK="/absolute/path/DeveloperIDApplication.p12"
export CSC_KEY_PASSWORD="<p12 export password>"

# Notarization:
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="ABCDE12345"

# Publishing to GitHub Releases (needs repo write):
export GH_TOKEN="<github personal access token, repo scope>"
```

## 2. Build

```bash
cd desktop
npm install                 # once, or after dependency changes

# Local unsigned DMG (no credentials needed) — for smoke-testing the package:
npm run dist:mac            # → dist/codbash-<version>.dmg

# Signed + notarized + published to GitHub Releases:
npm run release:mac         # electron-builder --mac dmg --publish always
```

`release:mac` will:
1. compile the app and **sign** it with your Developer ID cert,
2. run the `afterSign` hook → **notarize** with `notarytool` (a few minutes),
3. **staple** the ticket to the app/DMG,
4. **upload** the DMG + `latest-mac.yml` to a GitHub Release for the current tag.

> Keep `version` in `desktop/package.json` in step with the codbash release
> (and create a matching git tag, e.g. `v7.14.0`) so the release/auto-update
> line up.

## 3. Verify

```bash
# Notarization ticket is stapled:
xcrun stapler validate "dist/mac-arm64/codbash.app"
# Gatekeeper accepts it:
spctl -a -vvv -t install "dist/mac-arm64/codbash.app"
```

## 4. Updates

Two models, depending on whether the build is signed:

- **Now (unsigned): notify-only.** On launch and every 6h the app queries the
  GitHub `releases/latest` API and, if a newer version exists, offers to open
  the download page (`main.js` → `checkForUpdates`). This works without signing.
  Just publish each release (`gh release create v<x> dist/*.dmg …` or
  `--publish always`) and users get notified.
- **Later (signed): silent auto-update.** Once a Developer ID cert is in place,
  swap `checkForUpdates` for `electron-updater`: `npm i electron-updater`, call
  `autoUpdater.checkForUpdatesAndNotify()`, and publish with `--publish always`
  so `latest-mac.yml` + the signed DMG land in the Release. macOS silent
  in-place update **requires** the signature, which is why it's gated on the cert.

The first desktop release (v7.13.0, unsigned, arm64) is published at
`https://github.com/vakovalskii/codbash/releases/tag/v7.13.0`.

## CI note

`.github/` is git-ignored in this repo, so there is no tracked GitHub Actions
workflow. To automate, add a macOS runner job that sets the env vars above from
repository secrets and runs `npm --prefix desktop ci && npm --prefix desktop run release:mac`
on tag push. Notarization requires a macOS runner.

## Troubleshooting

- **"app is damaged / unidentified developer"** → not notarized or not stapled;
  confirm the three `APPLE_*` vars were set during the build.
- **node-pty / terminal fails in the packaged app** → ensure
  `../node_modules/@lydell` is present at build time (it is copied via
  `extraResources`); run `npm install` at the repo root first.
- **`node` not found when the app launches** → the packaged app runs the server
  with `node` from `PATH`. For a fully self-contained DMG, drop a `node` binary
  into the app resources (electron-builder `extraResources`) — `resolveNodeBin()`
  prefers it. Most codbash users already have Node installed.
