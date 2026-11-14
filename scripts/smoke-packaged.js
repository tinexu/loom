'use strict';
// Smoke-tests an installed Loom, started the way a person starts it.
//   macOS: node scripts/smoke-packaged.js dist/Loom-<version>-arm64.dmg
//     mounts the dmg, checks what's in it, copies Loom.app out, and starts it
//     with `open`, so it gets launchd's bare environment as from Finder.
//   Linux: node scripts/smoke-packaged.js dist/Loom-<version>-x86_64.AppImage
//     starts it under xvfb-run with a desktop launcher's minimal environment.
// The app runs its LOOM_SMOKE_PACKAGED checks (renderer/app.js smokePackaged),
// writes them to a report file, and this script answers its STEP lines by
// running `loom .`, `open -a Loom <folder>` and a loom:// URL.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const artifact = path.resolve(process.argv[2] || '');
if (!fs.existsSync(artifact)) { console.error('usage: smoke-packaged.js <dmg or AppImage>'); process.exit(2); }
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-pkg-')));
const report = path.join(root, 'report.txt');
const userData = path.join(root, 'userData');
const bin = path.join(root, 'bin');
const folders = { one: path.join(root, 'one'), two: path.join(root, 'two'), three: path.join(root, 'three') };
for (const d of [userData, bin, ...Object.values(folders)]) fs.mkdirSync(d, { recursive: true });
// A key that isn't one: the API refuses it, which shows it was read and sent.
fs.writeFileSync(path.join(userData, '.env'), 'ANTHROPIC_API_KEY=sk-ant-loom-smoke-not-a-real-key\n', { mode: 0o600 });
fs.writeFileSync(report, '');

let failed = 0;
const result = (ok, name, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` :: ${detail}`}`); if (!ok) failed++; };
const smokeEnv = {
  LOOM_SMOKE: path.join(root, 'smoke.png'), LOOM_SMOKE_PACKAGED: '1', LOOM_SMOKE_USERDATA: userData,
  LOOM_SMOKE_REPORT: report, LOOM_SMOKE_CWD: folders.one, LOOM_BIN_DIRS: bin,
};

let app;
let launch;
let openFolder;
if (process.platform === 'darwin') {
  const mount = path.join(root, 'mnt');
  fs.mkdirSync(mount);
  execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, artifact], { stdio: 'ignore' });
  try {
    const items = fs.readdirSync(mount);
    result(items.includes('Loom.app') && items.includes('Applications') && items.includes('Open in Loom.app'), 'dmg: Loom.app, an Applications link and the Finder helper', items.join(', '));
    result(fs.readlinkSync(path.join(mount, 'Applications')) === '/Applications', 'dmg: the Applications link points at /Applications');
    fs.mkdirSync(path.join(root, 'Applications'));
    execFileSync('ditto', [path.join(mount, 'Loom.app'), path.join(root, 'Applications', 'Loom.app')]);
  } finally { spawnSync('hdiutil', ['detach', mount, '-quiet']); }
  app = path.join(root, 'Applications', 'Loom.app');
  const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')]).toString());
  result((plist.CFBundleDocumentTypes || []).some((t) => (t.LSItemContentTypes || []).includes('public.folder')), 'Info.plist: Loom opens folders (Open With, the Dock)');
  result((plist.CFBundleURLTypes || []).some((t) => (t.CFBundleURLSchemes || []).includes('loom')), 'Info.plist: loom:// URLs');
  result(spawnSync('codesign', ['--verify', '--deep', app]).status === 0, 'the app\'s signature verifies (ad hoc when unsigned)');
  // `open` hands the app to LaunchServices, which starts it with launchd's
  // environment and these variables only: like a Dock launch.
  launch = () => spawn('open', ['-n', ...Object.entries(smokeEnv).flatMap(([k, v]) => ['--env', `${k}=${v}`]), app], { stdio: 'ignore' });
  openFolder = (dir) => spawnSync('open', ['-a', app, dir]);
} else {
  app = artifact;
  fs.chmodSync(app, 0o755);
  const minimal = { HOME: os.homedir(), USER: os.userInfo().username, PATH: '/usr/bin:/bin', DISPLAY: process.env.DISPLAY || '', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '', ...smokeEnv };
  launch = () => spawn('xvfb-run', ['-a', app, '--no-sandbox'], { env: minimal, stdio: 'ignore' });
  openFolder = (dir) => spawnSync(app, ['--no-sandbox', dir], { env: { ...minimal } });
}

const steps = {
  'STEP loom': () => {
    const loom = path.join(bin, 'loom');
    // With the test's userData, so it finds the running test app (and never
    // starts a real Loom over the real one).
    const r = spawnSync('/bin/sh', ['-c', `'${loom}' .`], { cwd: folders.one, env: { ...process.env, ...smokeEnv, PATH: `${bin}:/usr/bin:/bin` } });
    result(r.status === 0, '`loom .` returns at once', r.stderr && r.stderr.toString());
  },
  'STEP open-with': () => openFolder(folders.two),
  'STEP url': () => (process.platform === 'darwin'
    ? spawnSync('open', ['-a', app, `loom://open?path=${encodeURIComponent(folders.three)}`])
    : openFolder(`loom://open?path=${encodeURIComponent(folders.three)}`)),
};

(async () => {
  const t0 = Date.now();
  const child = launch();
  let seen = 0;
  let ended = false;
  while (!ended && Date.now() - t0 < 180000) {
    await new Promise((r) => setTimeout(r, 200));
    const lines = fs.readFileSync(report, 'utf8').split('\n');
    for (const line of lines.slice(seen, lines.length - 1)) {
      const step = Object.keys(steps).find((k) => line.includes(k));
      if (step) steps[step]();
      if (/^\[e2e\] (PASS|FAIL|INFO)/.test(line)) console.log(line.slice(6));
      if (/^\[e2e\] FAIL/.test(line)) failed++;
      if (/^\[renderer\] (ERR|REJ|SMOKE)/.test(line)) { console.log(line); failed++; }
      if (line.startsWith('[e2e] END')) ended = true;
    }
    seen = lines.length - 1;
  }
  if (!ended) { console.log('FAIL the app never finished its checks'); failed++; }
  child.kill();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  if (!process.env.KEEP) fs.rmSync(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
