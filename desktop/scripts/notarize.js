// electron-builder afterSign hook — notarizes the signed .app with Apple.
//
// It runs automatically after signing during `electron-builder --mac`. It is a
// no-op unless the three Apple env vars are set, so an unsigned/local build
// still succeeds:
//
//   APPLE_ID                  your Apple ID email
//   APPLE_APP_SPECIFIC_PASSWORD  app-specific password (appleid.apple.com → Sign-In & Security)
//   APPLE_TEAM_ID             your 10-char Developer Team ID
//
// Signing itself is handled by electron-builder when a "Developer ID Application"
// cert is available (in the login keychain, or via CSC_LINK + CSC_KEY_PASSWORD).
'use strict';

const path = require('path');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('[notarize] skipped — set APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID to enable.');
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

  await notarize({
    tool: 'notarytool',
    appPath: appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  console.log('[notarize] done — ' + appName + '.app is notarized.');
};
