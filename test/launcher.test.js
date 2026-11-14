'use strict';
// Unit tests for lib/launcher.js: the `loom` script, installing it, and the
// file-manager entries. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('../lib/launcher');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loom-launch-'));

test('the script runs the app in the background with --cwd and the arguments', () => {
  const dir = tmp();
  const log = path.join(dir, 'args.txt');
  const fake = path.join(dir, 'fake app');
  fs.writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${log}'\n`, { mode: 0o755 });
  const res = L.install({ script: L.launcherScript({ app: fake, appDir: '/src/loom' }), dirs: [path.join(dir, 'bin')], home: dir, pathEnv: path.join(dir, 'bin') });
  assert.ok(res.onPath);
  const t0 = Date.now();
  const r = spawnSync(res.file, ['.', '-e', 'npm test'], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.ok(Date.now() - t0 < 2000);
  for (let i = 0; i < 50 && !fs.existsSync(log); i++) spawnSync('sleep', ['0.05']);
  assert.deepStrictEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['/src/loom', '--cwd', fs.realpathSync(dir), '.', '-e', 'npm test']);
});

test('install: skips a folder holding someone else’s loom, and says when it isn’t on PATH', () => {
  const dir = tmp();
  const a = path.join(dir, 'a');
  const b = path.join(dir, 'b');
  fs.mkdirSync(a);
  fs.writeFileSync(path.join(a, 'loom'), '#!/bin/sh\necho not ours\n');
  const res = L.install({ script: L.launcherScript({ app: '/bin/true' }), dirs: [a, b], home: dir, pathEnv: '/usr/bin' });
  assert.strictEqual(res.file, path.join(b, 'loom'));
  assert.strictEqual(res.onPath, false);
  assert.strictEqual(L.installed({ dirs: [a, b], home: dir }), path.join(b, 'loom'));
  assert.deepStrictEqual(L.uninstall({ dirs: [a, b], home: dir }), [path.join(b, 'loom')]);
  assert.ok(fs.existsSync(path.join(a, 'loom')), "someone else's loom stays");
});

test('Finder Quick Action and Linux entries call the launcher', () => {
  const qa = L.quickAction("/Users/me/.local/bin/loom");
  assert.ok(qa.doc.includes(`<string>for f in "$@"; do '/Users/me/.local/bin/loom' "$f"; done</string>`));
  assert.match(qa.info, /Open in Loom/);
  assert.match(qa.info, /public\.folder/);
  const files = L.linuxFiles('/home/me/.local/bin/loom', '/home/me');
  const desktop = files.find(([f]) => f.endsWith('applications/loom.desktop'))[1];
  assert.match(desktop, /MimeType=inode\/directory;/);
  assert.match(desktop, /Exec=\/home\/me\/.local\/bin\/loom %F/);
  assert.ok(files.some(([f]) => f.endsWith('nautilus/scripts/Open in Loom')));
});

test('install as a link to the app’s own bin/loom; a dangling one is still ours', () => {
  const dir = tmp();
  const target = path.join(dir, 'Loom.app', 'Contents', 'Resources', 'bin', 'loom');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `#!/bin/sh\n${L.MARK}\n`, { mode: 0o755 });
  const res = L.install({ link: target, dirs: [path.join(dir, 'bin')], home: dir });
  assert.strictEqual(fs.readlinkSync(res.file), target);
  assert.strictEqual(L.installed({ dirs: [path.join(dir, 'bin')], home: dir }), res.file);
  fs.rmSync(path.join(dir, 'Loom.app'), { recursive: true });
  assert.strictEqual(L.installed({ dirs: [path.join(dir, 'bin')], home: dir }), res.file, 'dangling, but ours');
  const again = L.install({ link: target, dirs: [path.join(dir, 'bin')], home: dir });
  assert.strictEqual(again.file, res.file);
});

test('the bundled launcher script finds the app next to it, through links', () => {
  const dir = tmp();
  const res = path.join(dir, 'Loom.app', 'Contents', 'Resources');
  const macos = path.join(dir, 'Loom.app', 'Contents', 'MacOS');
  fs.mkdirSync(path.join(res, 'bin'), { recursive: true });
  fs.mkdirSync(macos, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'build', 'bin', 'loom'), path.join(res, 'bin', 'loom'));
  fs.chmodSync(path.join(res, 'bin', 'loom'), 0o755);
  const log = path.join(dir, 'args.txt');
  fs.writeFileSync(path.join(macos, 'Loom'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${log}'\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'usr-local-bin'));
  fs.symlinkSync(path.join(res, 'bin', 'loom'), path.join(dir, 'usr-local-bin', 'loom'));
  const r = spawnSync(path.join(dir, 'usr-local-bin', 'loom'), ['-e', 'git', 'status'], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  for (let i = 0; i < 50 && !fs.existsSync(log); i++) spawnSync('sleep', ['0.05']);
  assert.deepStrictEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['--cwd', fs.realpathSync(dir), '-e', 'git', 'status']);
});
