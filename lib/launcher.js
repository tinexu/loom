'use strict';
// Loom — the `loom` command and "Open in Loom" for file managers.
// The launcher is a small sh script that starts Loom in the background with
// the folder it was run from (--cwd) and its arguments, and returns at once.
// A Loom that's already running gets them through the single-instance lock.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARK = '# LOOM-LAUNCHER';
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// app: the binary to run; appDir: the project folder for a checkout
// (`electron <dir>`), or '' for a packaged app.
function launcherScript({ app, appDir = '' }) {
  return `#!/bin/sh
${MARK} v1
# Opens a folder or runs a command in Loom:
#   loom [folder] [--new-tab] [--dropdown] [-e "command"]
# Installed by Loom ("Install 'loom' command in PATH"); its Uninstall entry removes it.
unset ELECTRON_RUN_AS_NODE
APP=${shq(app)}
APPDIR=${shq(appDir)}
if [ ! -x "$APP" ]; then
  echo "loom: Loom isn't at $APP any more. Reinstall the command from Loom." >&2
  exit 1
fi
if [ -n "$APPDIR" ]; then
  nohup "$APP" "$APPDIR" --cwd "$PWD" "$@" >/dev/null 2>&1 &
else
  nohup "$APP" --cwd "$PWD" "$@" >/dev/null 2>&1 &
fi
exit 0
`;
}

// Ours: a script with the mark, or a link to Loom's bundled bin/loom (even one
// left dangling by a moved app).
function isOurs(file) {
  try {
    if (fs.lstatSync(file).isSymbolicLink() && /[\\/]bin[\\/]loom$/.test(fs.readlinkSync(file))) return true;
  } catch { return false; }
  try { return fs.readFileSync(file, 'utf8').includes(MARK); } catch { return false; }
}
const writable = (dir) => { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } };
const expand = (p, home) => (p.startsWith('~/') ? path.join(home, p.slice(2)) : p);

// Puts `loom` in the first of `dirs` that's writable and doesn't hold someone
// else's `loom`: a link to `link` (the installed app's own bin/loom, so an
// update that replaces the app keeps it working), or else `script` written out.
// Returns { file, dir, onPath }.
function install({ script, link = null, dirs = ['/usr/local/bin', '~/.local/bin'], pathEnv = process.env.PATH || '', home = os.homedir() }) {
  const tried = [];
  for (const d of dirs.map((x) => expand(x, home))) {
    const file = path.join(d, 'loom');
    if (!fs.existsSync(d)) {
      if (!d.startsWith(home)) { tried.push(`${d} doesn't exist`); continue; }
      fs.mkdirSync(d, { recursive: true });
    }
    if (!writable(d)) { tried.push(`${d} isn't writable`); continue; }
    if (fs.existsSync(file) && !isOurs(file)) { tried.push(`${file} is another program`); continue; }
    fs.rmSync(file, { force: true });
    if (link) fs.symlinkSync(link, file);
    else {
      fs.writeFileSync(file, script, { mode: 0o755 });
      fs.chmodSync(file, 0o755);
    }
    const onPath = pathEnv.split(path.delimiter).some((p) => p && path.resolve(expand(p, home)) === path.resolve(d));
    return { file, dir: d, onPath };
  }
  throw new Error(`couldn't install the loom command: ${tried.join('; ')}`);
}

function uninstall({ dirs = ['/usr/local/bin', '~/.local/bin'], home = os.homedir() } = {}) {
  const removed = [];
  for (const d of dirs.map((x) => expand(x, home))) {
    const file = path.join(d, 'loom');
    if (isOurs(file)) { try { fs.rmSync(file); removed.push(file); } catch { /* not ours to remove */ } }
  }
  return removed;
}

// Where the launcher is installed, if it is.
function installed({ dirs = ['/usr/local/bin', '~/.local/bin'], home = os.homedir() } = {}) {
  for (const d of dirs.map((x) => expand(x, home))) if (isOurs(path.join(d, 'loom'))) return path.join(d, 'loom');
  return null;
}

// ---------------------------------------------------------------- macOS Finder Quick Action
const plistEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const uuid = () => require('crypto').randomUUID().toUpperCase();

// A Services workflow with one "Run Shell Script" action that passes the
// selected folders to the launcher.
function quickAction(launcher) {
  const command = `for f in "$@"; do ${shq(launcher)} "$f"; done`;
  const info = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSBackgroundColorName</key><string>background</string>
			<key>NSIconName</key><string>NSActionTemplate</string>
			<key>NSMenuItem</key><dict><key>default</key><string>Open in Loom</string></dict>
			<key>NSMessage</key><string>runWorkflowAsService</string>
			<key>NSRequiredContext</key><dict><key>NSApplicationIdentifier</key><string>com.apple.finder</string></dict>
			<key>NSSendFileTypes</key><array><string>public.folder</string></array>
		</dict>
	</array>
</dict>
</plist>
`;
  const doc = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key><string>523</string>
	<key>AMApplicationVersion</key><string>2.10</string>
	<key>AMDocumentVersion</key><string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key><string>List</string>
					<key>Optional</key><true/>
					<key>Types</key><array><string>com.apple.cocoa.string</string></array>
				</dict>
				<key>AMActionVersion</key><string>2.0.3</string>
				<key>AMApplication</key><array><string>Automator</string></array>
				<key>AMParameterProperties</key>
				<dict>
					<key>COMMAND_STRING</key><dict/>
					<key>CheckedForUserDefaultShell</key><dict/>
					<key>inputMethod</key><dict/>
					<key>shell</key><dict/>
					<key>source</key><dict/>
				</dict>
				<key>AMProvides</key>
				<dict>
					<key>Container</key><string>List</string>
					<key>Types</key><array><string>com.apple.cocoa.string</string></array>
				</dict>
				<key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key><string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key><string>${plistEsc(command)}</string>
					<key>CheckedForUserDefaultShell</key><true/>
					<key>inputMethod</key><integer>1</integer>
					<key>shell</key><string>/bin/sh</string>
					<key>source</key><string></string>
				</dict>
				<key>BundleIdentifier</key><string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key><string>2.0.3</string>
				<key>CanShowSelectedItemsWhenRun</key><false/>
				<key>CanShowWhenRun</key><true/>
				<key>Category</key><array><string>AMCategoryUtilities</string></array>
				<key>Class Name</key><string>RunShellScriptAction</string>
				<key>InputUUID</key><string>${uuid()}</string>
				<key>Keywords</key><array><string>Shell</string><string>Script</string></array>
				<key>OutputUUID</key><string>${uuid()}</string>
				<key>UUID</key><string>${uuid()}</string>
				<key>UnlocalizedApplications</key><array><string>Automator</string></array>
				<key>arguments</key><dict/>
				<key>isViewVisible</key><integer>1</integer>
				<key>location</key><string>309.000000:316.000000</string>
				<key>nibPath</key><string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
			</dict>
			<key>isViewVisible</key><integer>1</integer>
		</dict>
	</array>
	<key>connectors</key><dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>applicationBundleIDsByPath</key><dict/>
		<key>applicationPaths</key><array/>
		<key>inputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject</string>
		<key>outputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
		<key>presentationMode</key><integer>15</integer>
		<key>processesInput</key><integer>0</integer>
		<key>serviceApplicationBundleID</key><string>com.apple.finder</string>
		<key>serviceApplicationPath</key><string>/System/Library/CoreServices/Finder.app</string>
		<key>serviceInputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject.folder</string>
		<key>serviceOutputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key><integer>0</integer>
		<key>systemImageName</key><string>NSActionTemplate</string>
		<key>useAutomaticInputType</key><integer>0</integer>
		<key>workflowTypeIdentifier</key><string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>
`;
  return { info, doc };
}

const workflowPath = (home = os.homedir()) => path.join(home, 'Library', 'Services', 'Open in Loom.workflow');

function installQuickAction(launcher, { home = os.homedir() } = {}) {
  const dir = workflowPath(home);
  const { info, doc } = quickAction(launcher);
  fs.mkdirSync(path.join(dir, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Contents', 'Info.plist'), info);
  fs.writeFileSync(path.join(dir, 'Contents', 'document.wflow'), doc);
  return dir;
}
const uninstallQuickAction = ({ home = os.homedir() } = {}) => { const d = workflowPath(home); const had = fs.existsSync(d); fs.rmSync(d, { recursive: true, force: true }); return had ? d : null; };

// ---------------------------------------------------------------- Linux file managers
// `icon` is a theme icon name or a path to a PNG.
function linuxFiles(launcher, home = os.homedir(), icon = 'utilities-terminal') {
  const share = path.join(home, '.local', 'share');
  const script = `#!/bin/sh\n# Open in Loom: the selected folders, or this one.\nif [ "$#" -eq 0 ]; then exec ${shq(launcher)} "$PWD"; fi\nfor f in "$@"; do ${shq(launcher)} "$f"; done\n`;
  return [
    [path.join(share, 'applications', 'loom.desktop'), `[Desktop Entry]
Type=Application
Name=Loom
GenericName=Terminal
Comment=A spatial terminal: every command is a card
Exec=${launcher} %F
Icon=${icon}
Terminal=false
Categories=System;TerminalEmulator;
MimeType=inode/directory;
Actions=new-tab;

[Desktop Action new-tab]
Name=New Tab
Exec=${launcher} --new-tab
`, 0o644],
    [path.join(share, 'nautilus', 'scripts', 'Open in Loom'), script, 0o755],
    [path.join(share, 'nemo', 'scripts', 'Open in Loom'), script, 0o755],
    [path.join(share, 'kio', 'servicemenus', 'open-in-loom.desktop'), `[Desktop Entry]
Type=Service
MimeType=inode/directory;
Actions=openInLoom
X-KDE-ServiceTypes=KonqPopupMenu/Plugin

[Desktop Action openInLoom]
Name=Open in Loom
Icon=utilities-terminal
Exec=${launcher} %f
`, 0o755],
  ];
}
function installLinux(launcher, { home = os.homedir(), icon } = {}) {
  const out = [];
  for (const [file, text, mode] of linuxFiles(launcher, home, icon)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode });
    fs.chmodSync(file, mode);
    out.push(file);
  }
  return out;
}
function uninstallLinux({ home = os.homedir() } = {}) {
  return linuxFiles('loom', home).map(([f]) => f).filter((f) => { const had = fs.existsSync(f); fs.rmSync(f, { force: true }); return had; });
}

module.exports = { launcherScript, install, uninstall, installed, quickAction, installQuickAction, uninstallQuickAction, workflowPath, linuxFiles, installLinux, uninstallLinux, MARK };
