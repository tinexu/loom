'use strict';
// Unit tests for the completion providers, against a temp fixture directory.
// Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { complete, listPaths, quoteName } = require('../lib/complete');

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'loom-comp-'));
const home = path.join(root, 'home');
const cwd = path.join(root, 'proj');
for (const d of ['src/lib', 'scripts', 'with space', '.hidden']) fs.mkdirSync(path.join(cwd, d), { recursive: true });
fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
fs.mkdirSync(path.join(home, '.ssh'));
for (const f of ['my file.txt', 'README.md', 'src/index.js', "it's.txt"]) fs.writeFileSync(path.join(cwd, f), '');
fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { build: 'tsc -p .', test: 'node --test', 'lint:fix': 'eslint --fix .' } }));
fs.writeFileSync(path.join(cwd, 'Makefile'), 'all: build\nbuild test: deps\n\techo\n.PHONY: all\n%.o: %.c\n');
fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host devbox staging\n  HostName 10.0.0.1\nHost *.internal\n');
fs.writeFileSync(path.join(home, '.ssh', 'known_hosts'), 'github.com,140.82.1.1 ssh-ed25519 AAA\n[gitlab.local]:2222 ssh-rsa BBB\n|1|hashed= ssh-rsa CCC\n');
const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd });
git('init', '-q', '-b', 'main');
git('add', '.');
git('commit', '-qm', 'first');
git('branch', 'feature');
git('tag', 'v1.0');
fs.writeFileSync(path.join(cwd, 'README.md'), 'changed');
fs.writeFileSync(path.join(cwd, 'new.txt'), '');

const run = (text, caret = text.length, extra = {}) => complete({ text, caret, cwd, home, env: { HOME: home, PATH: process.env.PATH, PROJECT: cwd }, ...extra });
const labels = (r) => r.items.map((i) => i.label);
const apply = (text, r, item) => text.slice(0, item.start) + item.insert + text.slice(r.end);

test('paths: files and dirs, dirs end with / and reopen', async () => {
  const r = await run('cd sr');
  assert.deepStrictEqual(labels(r), ['src/']);
  assert.strictEqual(apply('cd sr', r, r.items[0]), 'cd src/');
  assert.strictEqual(r.items[0].reopen, true);
  const inner = await run('ls src/');
  assert.deepStrictEqual(labels(inner).sort(), ['index.js', 'lib/']);
  assert.strictEqual(apply('ls src/', inner, inner.items.find((i) => i.label === 'index.js')), 'ls src/index.js ');
});

test('paths: cd lists directories only, hidden files only on a dot', async () => {
  const r = await run('cd ');
  assert.deepStrictEqual(labels(r).sort(), ['scripts/', 'src/', 'with space/']);
  assert.deepStrictEqual(labels(await run('cd .h')), ['.hidden/']);
});

test('paths: spaces and quotes are escaped on insert', async () => {
  let r = await run('cat my');
  assert.strictEqual(apply('cat my', r, r.items[0]), 'cat my\\ file.txt ');
  r = await run('cat "my');
  assert.strictEqual(apply('cat "my', r, r.items[0]), 'cat "my file.txt" ');
  r = await run("cat 'it");
  assert.strictEqual(apply("cat 'it", r, r.items[0]), "cat 'it'\\''s.txt' ");
  r = await run('cd with\\ ');
  assert.strictEqual(apply('cd with\\ ', r, r.items[0]), 'cd with\\ space/');
  r = await run('ls "with space/');
  assert.deepStrictEqual(labels(r), []);
  assert.strictEqual(quoteName('a b$c', null, true), 'a\\ b\\$c');
});

test('paths: ~ and $VAR prefixes stay as typed', async () => {
  let r = await run('ls ~/Doc');
  assert.strictEqual(apply('ls ~/Doc', r, r.items[0]), 'ls ~/Documents/');
  r = await run('ls $PROJECT/sr');
  assert.strictEqual(apply('ls $PROJECT/sr', r, r.items[0]), 'ls $PROJECT/src/');
  assert.deepStrictEqual((await listPaths(cwd, '~', { home })).map((i) => i.label), ['~/']);
});

test('paths: fast enough to feel instant', async () => {
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) await run('cat s');
  assert.ok((Date.now() - t0) / 20 < 50);
});

test('commands at command position', async () => {
  const r = await run('gi', 2, { commands: { git: 'command', gist: 'alias', grep: 'command', ls: 'command' } });
  assert.deepStrictEqual(labels(r), ['gist', 'git']);
  assert.strictEqual(r.items.find((i) => i.label === 'gist').desc, 'alias');
});

test('git: branches and tags for checkout, changed files for add', async () => {
  const r = await run('git checkout ');
  assert.ok(['feature', 'main', 'v1.0'].every((b) => labels(r).includes(b)), labels(r));
  assert.strictEqual(r.items.find((i) => i.label === 'main').desc, 'current branch');
  const add = await run('git add ');
  assert.deepStrictEqual(labels(add).sort(), ['README.md', 'new.txt']);
  const del = await run('git branch -d ');
  assert.ok(labels(del).includes('feature') && !labels(del).includes('v1.0'));
});

test('git: subcommands with descriptions from the Fig spec', async () => {
  const r = await run('git chec');
  assert.strictEqual(r.items[0].label, 'checkout');
  assert.ok(r.items[0].desc.length > 5);
});

test('npm run lists package.json scripts; make lists targets', async () => {
  const r = await run('npm run ');
  assert.deepStrictEqual(labels(r).sort(), ['build', 'lint:fix', 'test']);
  assert.strictEqual(r.items.find((i) => i.label === 'build').desc, 'tsc -p .');
  assert.deepStrictEqual(labels(await run('make ')).sort(), ['all', 'build', 'test']);
});

test('ssh hosts from config and known_hosts', async () => {
  assert.deepStrictEqual(labels(await run('ssh ')).sort(), ['devbox', 'github.com', 'gitlab.local', 'staging', '140.82.1.1'].sort());
});

test('flags with descriptions from Fig: tar -', async () => {
  const r = await run('tar -');
  assert.ok(r.items.length > 10);
  const x = r.items.find((i) => i.label === '-x' || i.alt.split(' ').includes('-x'));
  assert.ok(x && /extract/i.test(x.desc), JSON.stringify(x));
});

test('variables after $', async () => {
  const r = await run('echo $PRO');
  assert.deepStrictEqual(labels(r), ['$PROJECT']);
  assert.strictEqual(apply('echo $PRO', r, r.items[0]), 'echo $PROJECT');
});
