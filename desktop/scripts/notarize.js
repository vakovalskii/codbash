// electron-builder afterSign hook — notarizes the signed .app with Apple.
//
// It runs automatically after signing during `electron-builder --mac`. It is a
// no-op unless notarization credentials are provided, so an unsigned/local
// build still succeeds. Two credential modes are supported:
//
//   1. Keychain profile (preferred — no secret in env/transcript):
//        APPLE_KEYCHAIN_PROFILE   name of a profile stored via
//                                 `xcrun notarytool store-credentials <name>`
//
//   2. Explicit env vars (e.g. for CI):
//        APPLE_ID                     your Apple ID email
//        APPLE_APP_SPECIFIC_PASSWORD  app-specific password (appleid.apple.com)
//        APPLE_TEAM_ID                your 10-char Developer Team ID
//
// Signing itself is handled by electron-builder when a "Developer ID Application"
// cert is available (in the login keychain, or via CSC_LINK + CSC_KEY_PASSWORD).
'use strict';

const path = require('path');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_KEYCHAIN_PROFILE, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;

  let creds;
  if (APPLE_KEYCHAIN_PROFILE) {
    creds = { tool: 'notarytool', keychainProfile: APPLE_KEYCHAIN_PROFILE };
  } else if (APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID) {
    creds = {
      tool: 'notarytool',
      appleId: APPLE_ID,
      appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
      teamId: APPLE_TEAM_ID,
    };
  } else {
    console.log('[notarize] skipped — set APPLE_KEYCHAIN_PROFILE (preferred) or ' +
      'APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID to enable.');
    return;
  }

  let notarize;
  try {
    notarize = require('@electron/notarize').notarize;
  } catch (e) {
    console.log('[notarize] @electron/notarize not installed — run `npm install` in desktop/.');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, appName + '.app');
  console.log('[notarize] submitting ' + appName + '.app to Apple (this can take a few minutes)…');

  await notarize(Object.assign({ appPath: appPath }, creds));

  console.log('[notarize] done — ' + appName + '.app is notarized.');
};
