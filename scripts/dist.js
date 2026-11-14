'use strict';
// npm run dist [-- <electron-builder args>]: builds installable apps for this
// machine's platform and architecture (or what the args ask for).
//
// macOS signing is decided from the environment:
//   CSC_LINK + CSC_KEY_PASSWORD (or CSC_NAME, a keychain identity): sign with
//     the hardened runtime and build/entitlements.mac.plist.
//   …plus APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or
//     APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER: also notarize.
//   none of those: an ad-hoc signed app (Apple Silicon won't run anything less)
//     that Gatekeeper blocks until it's opened with right-click → Open.
// Windows signs only when CSC_LINK / WIN_CSC_LINK is set.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const env = { ...process.env };
const has = (...names) => names.every((n) => env[n]);
const target = args.includes('--mac') || args.includes('-m') ? 'darwin'
  : args.includes('--linux') || args.includes('-l') ? 'linux'
    : args.includes('--win') || args.includes('-w') ? 'win32' : process.platform;
const extra = [];

// The page's xterm files are copied from node_modules by postinstall.
if (!fs.existsSync(path.join(root, 'renderer', 'vendor', 'xterm.js'))) {
  spawnSync(process.execPath, [path.join(__dirname, 'vendor.js')], { stdio: 'inherit' });
}

if (target === 'darwin') {
  require('./helper-app').build('com.tinexu.loom');
  const signing = has('CSC_LINK') || has('CSC_NAME');
  const notarizing = signing && (has('APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID') || has('APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'));
  if (signing) {
    if (notarizing) extra.push('-c.mac.notarize=true');
    else console.warn('\n⚠  Signing without notarizing: set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID (or an App Store Connect API key) to notarize.\n');
  } else {
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    extra.push('-c.mac.identity=-', '-c.mac.hardenedRuntime=false');
    console.warn([
      '',
      '⚠  No signing certificate (CSC_LINK or CSC_NAME): building an UNSIGNED Loom (ad-hoc signature).',
      '   It runs, but macOS blocks the first launch of a downloaded copy. To open it:',
      '     right-click Loom.app → Open → Open, or',
      '     xattr -dr com.apple.quarantine /Applications/Loom.app',
      '   Auto-update needs a signed app, so this build will point at the release page instead.',
      '',
    ].join('\n'));
  }
}
if (target === 'win32' && !has('CSC_LINK') && !has('WIN_CSC_LINK')) {
  console.warn('\n⚠  No Windows signing certificate (CSC_LINK / WIN_CSC_LINK): the installer will be unsigned and SmartScreen will warn.\n');
}

const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
const r = spawnSync(bin, [...args, ...extra], { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) process.exit(r.status || 1);
// Nothing goes out without the package check.
const c = spawnSync(process.execPath, [path.join(__dirname, 'check-package.js')], { cwd: root, stdio: 'inherit' });
process.exit(c.status || 0);
