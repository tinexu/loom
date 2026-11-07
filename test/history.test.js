'use strict';
// Unit tests for history storage, shell history import and ranking. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHistory, parseZshHistory, parseBashHistory } = require('../lib/history');
const Fuzzy = require('../renderer/fuzzy');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loom-hist-'));

test('zsh history: extended format, multi-line entries and metafied bytes', () => {
  const text = ': 1700000000:0;git status\n: 1700000005:3;echo one\\\ntwo\\\nthree\nplain line\n: 1700000009:0;ls\n';
  const r = parseZshHistory(text);
  assert.deepStrictEqual(r.map((x) => x.cmd), ['git status', 'echo one\ntwo\nthree', 'plain line', 'ls']);
  assert.strictEqual(r[0].startedAt, 1700000000000);
  assert.strictEqual(r[1].durationMs, 3000);
  assert.strictEqual(r[2].startedAt, 0);
  // é is C3 A9; zsh stores A9 as 83 89 (0xA9 ^ 0x20).
  const meta = Buffer.from([0x3a, 0x20, 0x31, 0x3a, 0x30, 0x3b, 0x65, 0x63, 0x68, 0x6f, 0x20, 0xc3, 0x83, 0x89, 0x0a]);
  assert.strictEqual(parseZshHistory(meta)[0].cmd, 'echo é');
});

test('bash history: timestamps apply to the next line', () => {
  const r = parseBashHistory('#1700000000\nls -la\nmake\n\n');
  assert.deepStrictEqual(r.map((x) => [x.cmd, x.startedAt]), [['ls -la', 1700000000000], ['make', 0]]);
});

test('store: leading space is never recorded, repeats collapse, file persists', () => {
  const dir = tmp();
  const file = path.join(dir, 'history.jsonl');
  const h = createHistory(file);
  assert.strictEqual(h.add({ cmd: ' echo secret', exitCode: 0 }), false);
  h.add({ cmd: 'ls', cwd: '/a', exitCode: 0, startedAt: 1 });
  h.add({ cmd: 'ls', cwd: '/b', exitCode: 1, startedAt: 2 });
  h.add({ cmd: 'pwd', cwd: '/a', exitCode: 0, startedAt: 3 });
  assert.deepStrictEqual(h.all().map((r) => [r.cmd, r.cwd]), [['ls', '/b'], ['pwd', '/a']]);
  const again = createHistory(file);
  assert.deepStrictEqual(again.all().map((r) => r.cmd), ['ls', 'pwd']);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('secret'));
  again.importRecords(parseZshHistory(': 1:0;old one\n:  2:0; leading space\n'));
  assert.deepStrictEqual(again.all().map((r) => r.cmd), ['old one', 'ls', 'pwd']);
});

test('store: keeps the newest records past the cap', () => {
  const dir = tmp();
  const h = createHistory(path.join(dir, 'h.jsonl'), { max: 50 });
  for (let i = 0; i < 200; i++) h.add({ cmd: `echo ${i}`, startedAt: i });
  assert.strictEqual(h.all().length, 50);
  assert.strictEqual(h.all()[0].cmd, 'echo 150');
  assert.strictEqual(createHistory(path.join(dir, 'h.jsonl'), { max: 50 }).all().at(-1).cmd, 'echo 199');
});

test('fuzzy: subsequence with highlights, boundaries score higher', () => {
  const m = Fuzzy.match('chk', 'git checkout feature');
  assert.ok(m);
  assert.deepStrictEqual(m.hl.map((i) => 'git checkout feature'[i]).join(''), 'chk');
  assert.strictEqual(Fuzzy.match('xyz', 'git checkout'), null);
  assert.ok(Fuzzy.match('gco', 'git checkout').score > Fuzzy.match('gco', 'xgxcxo').score);
});

test('rank: fuzzy plus same folder, success and recency', () => {
  const now = Date.now();
  const recs = [
    { cmd: 'git checkout feature', cwd: '/p', exitCode: 0, startedAt: now - 3600e3 },
    { cmd: 'git checkout main', cwd: '/other', exitCode: 1, startedAt: now - 7200e3 },
    { cmd: 'cat notes', cwd: '/p', exitCode: 0, startedAt: now },
    { cmd: 'ls', cwd: '/p', exitCode: 0, startedAt: now },
  ];
  const r = Fuzzy.rank(Fuzzy.aggregate(recs), 'chk', { cwd: '/p', now });
  assert.strictEqual(r[0].entry.cmd, 'git checkout feature');
  assert.ok(!r.some((x) => x.entry.cmd === 'ls'));
  // Frequency counts: a command run often outranks one run once.
  const many = [...Array(8)].map(() => ({ cmd: 'npm test', cwd: '/x', exitCode: 0, startedAt: now - 86400e3 }));
  const r2 = Fuzzy.rank(Fuzzy.aggregate([...many, { cmd: 'npm tst-once', cwd: '/x', exitCode: 0, startedAt: now - 86400e3 }]), 'npm t', { now });
  assert.strictEqual(r2[0].entry.cmd, 'npm test');
});

test('rank stays fast with 20,000 records', () => {
  const words = ['git', 'checkout', 'status', 'npm', 'run', 'build', 'docker', 'compose', 'up', 'kubectl', 'get', 'pods', 'ls', '-la', 'grep', 'feature'];
  const recs = [];
  for (let i = 0; i < 20000; i++) {
    const n = 2 + (i % 5);
    const cmd = Array.from({ length: n }, (_, k) => words[(i * 7 + k * 13) % words.length]).join(' ') + ` ${i}`;
    recs.push({ cmd, cwd: `/p${i % 30}`, exitCode: i % 9 ? 0 : 1, startedAt: Date.now() - i * 60000 });
  }
  const entries = Fuzzy.aggregate(recs);
  const t0 = process.hrtime.bigint();
  for (const q of ['g', 'gi', 'git', 'git c', 'chk', 'dcu', 'kgp']) Fuzzy.rank(entries, q, { cwd: '/p3' });
  const perQuery = Number(process.hrtime.bigint() - t0) / 1e6 / 7;
  assert.ok(perQuery < 40, `${perQuery.toFixed(1)} ms per query`);
});

test('suggest: same folder, success, never "command not found"', () => {
  const recs = [
    { cmd: 'ls -la', cwd: '/demo', exitCode: 0 },
    { cmd: 'ls -R', cwd: '/elsewhere', exitCode: 0 },
    { cmd: 'lsx', cwd: '/demo', exitCode: 127 },
  ];
  assert.strictEqual(Fuzzy.suggest(recs, 'ls', '/demo'), 'ls -la');
  assert.strictEqual(Fuzzy.suggest(recs, 'ls', '/elsewhere'), 'ls -R');
  assert.strictEqual(Fuzzy.suggest(recs, 'lsx', '/demo'), null);
  assert.strictEqual(Fuzzy.suggest([{ cmd: 'lsx --help', exitCode: 127 }], 'ls', '/demo'), null);
  assert.deepStrictEqual(Fuzzy.prefixed([{ cmd: 'git a' }, { cmd: 'ls' }, { cmd: 'git b' }, { cmd: 'git a' }], 'git'), ['git a', 'git b']);
});
