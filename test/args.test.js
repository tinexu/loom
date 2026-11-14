'use strict';
// Unit tests for lib/args.js. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const { parseArgs, parseUrl, userArgs, hasRequest } = require('../lib/args');

const env = { cwd: '/work/repo', home: '/home/me' };

test('userArgs: drops the binary, and the app folder from a checkout', () => {
  assert.deepStrictEqual(userArgs(['/Apps/Loom', '/tmp/x', '--new-tab']), ['/tmp/x', '--new-tab']);
  assert.deepStrictEqual(userArgs(['electron', '--inspect=9229', '/src/loom', '.', '-e', 'ls'], { defaultApp: true }), ['.', '-e', 'ls']);
  assert.deepStrictEqual(userArgs(['electron', '/src/loom'], { defaultApp: true }), []);
});

test('a folder: relative, ~, and . resolve against the cwd', () => {
  assert.strictEqual(parseArgs(['.'], env).folder, '/work/repo');
  assert.strictEqual(parseArgs(['../other'], env).folder, '/work/other');
  assert.strictEqual(parseArgs(['~/loom-demo'], env).folder, '/home/me/loom-demo');
  assert.strictEqual(parseArgs(['~'], env).folder, '/home/me');
  assert.strictEqual(parseArgs(['/abs/path', '/second'], env).folder, '/abs/path');
});

test('-e runs a command, in the folder given or the cwd', () => {
  assert.deepStrictEqual(parseArgs(['-e', 'git status'], env), { folder: '/work/repo', newTab: false, dropdown: false, exec: 'git status', cwd: '/work/repo' });
  assert.deepStrictEqual(parseArgs(['~/p', '-e', 'npm test'], env).folder, '/home/me/p');
  assert.strictEqual(parseArgs(['--exec=make -j4'], env).exec, 'make -j4');
  assert.strictEqual(parseArgs(['-e', '-n'], env).exec, '-n');
});

test('-e takes the rest of the line, as x-terminal-emulator does', () => {
  assert.strictEqual(parseArgs(['-e', 'vim', 'my notes.txt'], env).exec, "vim 'my notes.txt'");
  assert.strictEqual(parseArgs(['-T', 'Title', '-e', 'top'], env).exec, 'top');
  assert.strictEqual(parseArgs(['-T', 'Title', '-e', 'top'], env).folder, '/work/repo');
  assert.strictEqual(parseArgs(['~/p', '-e', 'ls', '-la'], env).exec, 'ls -la');
});

test('file:// URIs from file managers', () => {
  assert.strictEqual(parseArgs(['file:///home/me/My%20Project'], env).folder, '/home/me/My Project');
});

test('flags, --cwd, and switches that are not ours', () => {
  const a = parseArgs(['--new-tab', '--dropdown', '--no-sandbox', '-psn_0_4242', '--cwd', '/elsewhere'], env);
  assert.deepStrictEqual(a, { folder: '/elsewhere', newTab: true, dropdown: true, exec: null, cwd: '/elsewhere' });
  assert.strictEqual(parseArgs([], env).folder, null);
  assert.strictEqual(hasRequest(parseArgs([], env)), false);
  assert.strictEqual(hasRequest(parseArgs(['--dropdown'], env)), true);
  assert.strictEqual(parseArgs(['--', '-weird-name'], env).folder, '/work/repo/-weird-name');
});

test('loom:// URLs', () => {
  assert.deepStrictEqual(parseUrl('loom://open?path=%2FUsers%2Fme%2Fx&exec=ls%20-la&newTab=1'), { folder: '/Users/me/x', exec: 'ls -la', newTab: true, dropdown: false });
  assert.strictEqual(parseUrl('loom://delete?path=/x'), null);
  assert.strictEqual(parseUrl('https://x'), null);
  assert.strictEqual(parseArgs(['loom://open?path=/srv/app'], env).folder, '/srv/app');
});
