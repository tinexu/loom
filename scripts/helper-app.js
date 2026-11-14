'use strict';
// Builds "Open in Loom.app" (macOS only), a tiny AppleScript applet for the
// Finder toolbar: Cmd-drag it there, and clicking it opens the folder of the
// front Finder window in Loom. Dropping folders on it opens them too.
// Ships in the dmg next to Loom. Run by scripts/dist.js before electron-builder.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = path.join(root, 'build', 'helper', 'Open in Loom.app');

function build(appId) {
  if (process.platform !== 'darwin') return null;
  const source = `-- Open in Loom: drag this app into a Finder window's toolbar.
on run
	set target to missing value
	tell application "Finder"
		try
			if (count of Finder windows) > 0 then set target to (target of front Finder window) as alias
		end try
		if target is missing value then set target to (path to desktop folder)
	end tell
	openInLoom(POSIX path of target)
end run

on open theItems
	repeat with anItem in theItems
		openInLoom(POSIX path of anItem)
	end repeat
end open

on openInLoom(p)
	do shell script "open -b ${appId} " & quoted form of p
end openInLoom
`;
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const src = path.join(path.dirname(out), 'open-in-loom.applescript');
  fs.writeFileSync(src, source);
  execFileSync('osacompile', ['-o', out, src]);
  fs.rmSync(src);
  const plist = path.join(out, 'Contents', 'Info.plist');
  const set = (key, type, value) => {
    try { execFileSync('plutil', ['-remove', key, plist], { stdio: 'ignore' }); } catch { /* wasn't there */ }
    execFileSync('plutil', ['-insert', key, `-${type}`, value, plist]);
  };
  set('CFBundleIdentifier', 'string', `${appId}.open-helper`);
  set('CFBundleName', 'string', 'Open in Loom');
  set('NSAppleEventsUsageDescription', 'string', 'Open in Loom asks Finder for the folder in its front window, to open it in Loom.');
  set('LSUIElement', 'bool', 'YES');
  fs.copyFileSync(path.join(root, 'build', 'icon.icns'), path.join(out, 'Contents', 'Resources', 'applet.icns'));
  // Editing Info.plist broke osacompile's ad-hoc signature, and Apple Silicon
  // won't run an unsigned app. Sign again (ad hoc, or with LOOM_HELPER_IDENTITY).
  execFileSync('codesign', ['--force', '--deep', '--sign', process.env.LOOM_HELPER_IDENTITY || '-', out], { stdio: 'ignore' });
  return out;
}

module.exports = { build, out };
if (require.main === module) console.log(build(process.argv[2] || 'com.tinexu.loom') || 'not macOS: skipped');
