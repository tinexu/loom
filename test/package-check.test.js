'use strict';
// Unit tests for lib/package-check.js: what must never ship. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const { check } = require('../lib/package-check');

const file = (path, text = '') => ({ path, read: () => Buffer.from(text) });

test('a clean app passes', () => {
  assert.deepStrictEqual(check([
    file('main.js', 'require("./lib/env")'), file('lib/env.js'), file('renderer/index.html'), file('package.json'),
    file('node_modules/node-pty/lib/index.js'), file('node_modules/@xterm/xterm/lib/xterm.js'),
    file('node_modules/some-dep/test-helpers.js'), file('themes/nord.json'),
  ]), []);
});

test('.env files anywhere, however named', () => {
  const p = check([file('.env'), file('.env.local'), file('node_modules/x/.env.production'), file('lib/.env')]);
  assert.strictEqual(p.length, 4);
  assert.ok(p.every((x) => /\.env file/.test(x)));
  assert.deepStrictEqual(check([file('lib/env.js'), file('renderer/environment.js')]), []);
});

test('anything holding "sk-ant-"', () => {
  const p = check([file('renderer/settings-page.js', 'placeholder="sk-ant-api03-abc"'), file('node_modules/x/readme.txt', 'key: sk-ant-')]);
  assert.strictEqual(p.length, 2);
  assert.ok(p[0].includes('sk-ant-'));
});

test('tests, fixtures, bench, dev scripts, screenshots, logs', () => {
  const p = check([
    file('test/e2e.js'), file('test/fixtures/home/.zshrc'), file('renderer/bench.js'), file('bench-results.json'),
    file('scripts/dist.js'), file('build/icon.svg'), file('smoke-zoom.png'), file('npm-debug.log'), file('.github/workflows/ci.yml'),
    file('views.js'),
  ]);
  for (const want of ['test/e2e.js', 'test/fixtures', 'renderer/bench.js', 'bench-results.json', 'scripts/dist.js', 'build/icon.svg', 'smoke-zoom.png', 'npm-debug.log', '.github', 'views.js']) {
    assert.ok(p.some((x) => x.includes(want)), want);
  }
});
