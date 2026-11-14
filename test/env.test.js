'use strict';
// Unit tests for lib/env.js: .env parsing and where it's read from, the PATH
// fallback for apps launched outside a terminal. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../lib/env');

test('.env: export, quotes, comments, escapes', () => {
  const v = E.parseDotenv('# comment\nexport A=1\nB = "two words" \nC=\'single # not a comment\'\nD=plain # trailing\nE="line\\nbreak"\nnot a line\n_F=\n');
  assert.deepStrictEqual(v, { A: '1', B: 'two words', C: 'single # not a comment', D: 'plain', E: 'line\nbreak', _F: '' });
});

test('.env: the project folder from a checkout, userData when packaged', () => {
  assert.strictEqual(E.dotenvPath({ packaged: false, appPath: '/src/loom', userData: '/u' }), '/src/loom/.env');
  assert.strictEqual(E.dotenvPath({ packaged: true, appPath: '/Applications/Loom.app/Contents/Resources/app.asar', userData: '/u' }), '/u/.env');
  assert.deepStrictEqual(E.readDotenv('/no/such/file'), {});
});

test('PATH: probed first, then the process, then fallbacks, no repeats', () => {
  assert.strictEqual(E.mergePath('/a:/b', '/usr/bin:/b', ['/opt/homebrew/bin', '/a']), '/a:/b:/usr/bin:/opt/homebrew/bin');
  assert.strictEqual(E.mergePath(null, '/usr/bin:/bin', []), '/usr/bin:/bin');
});

test('PATH fallbacks: Homebrew, cargo, pyenv and the newest nvm node, when they exist', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-env-'));
  for (const d of ['.cargo/bin', '.pyenv/shims', '.nvm/versions/node/v18.20.0/bin', '.nvm/versions/node/v22.3.1/bin', '.nvm/versions/node/v9.11.2/bin']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const dirs = E.fallbackDirs(home, { exists: (d) => d.startsWith(home) || d === '/opt/homebrew/bin' });
  assert.ok(dirs.includes('/opt/homebrew/bin'));
  assert.ok(dirs.includes(path.join(home, '.cargo', 'bin')));
  assert.ok(dirs.includes(path.join(home, '.pyenv', 'shims')));
  assert.ok(dirs.includes(path.join(home, '.nvm/versions/node/v22.3.1/bin')));
  assert.ok(!dirs.some((d) => d.includes('v18') || d.includes('v9.')));
});

test('PATH probe: a shell whose rc hangs is given up on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sh-'));
  const sh = path.join(dir, 'slowsh');
  fs.writeFileSync(sh, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  const t0 = Date.now();
  assert.strictEqual(await E.probeLoginPath(sh, { timeout: 300 }), null);
  assert.ok(Date.now() - t0 < 3000);
  const p = await E.probeLoginPath('/bin/sh', { timeout: 3000 });
  assert.ok(p && p.includes('/'), p);
});

test('locale: UTF-8 when the app got none', () => {
  assert.deepStrictEqual(E.localeEnv({}), { LANG: 'en_US.UTF-8' });
  assert.deepStrictEqual(E.localeEnv({ LANG: 'de_DE.UTF-8' }), {});
});
