'use strict';
// Unit tests for lib/outputs.js: appending, the line index, range reads, rows
// at a width, caps and eviction, and the on-disk index. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOutputs, LINE_MAX, BLOCK } = require('../lib/outputs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loom-out-'));
const K = (n) => `c0000beef.${n}`;
const store = (opts = {}) => createOutputs({ dir: opts.dir || tmp(), ...opts });

test('append: chunks split anywhere, CRLF becomes LF, partial last line counts', async () => {
  const o = store();
  o.begin(K(1));
  for (const c of ['one\r', '\ntw', 'o\r\nthr', 'ee\r\n', 'four']) o.append(K(1), c);
  const info = o.end(K(1));
  assert.strictEqual(info.lines, 4);
  assert.deepStrictEqual((await o.range(K(1), { from: 0, count: 10 })).lines, ['one', 'two', 'three', 'four']);
  assert.strictEqual(fs.readFileSync(o.file(K(1)), 'utf8'), 'one\ntwo\nthree\nfour');
});

test('index: any range of 2,000,000 lines reads exactly, from any block', async () => {
  const o = store();
  o.begin(K(2));
  let chunk = '';
  for (let i = 1; i <= 2000000; i++) {
    chunk += `${i}\r\n`;
    if (chunk.length > 60000) { o.append(K(2), chunk.slice(0, 33333)); o.append(K(2), chunk.slice(33333)); chunk = ''; }
  }
  o.append(K(2), chunk);
  assert.strictEqual(o.end(K(2)).lines, 2000000);
  const r = await o.range(K(2), { from: 999999, count: 11 });
  assert.deepStrictEqual(r.lines, Array.from({ length: 11 }, (_, i) => String(1000000 + i)));
  for (const from of [0, BLOCK - 1, BLOCK, BLOCK + 1, 1999995]) {
    const got = await o.range(K(2), { from, count: 3 });
    assert.strictEqual(got.lines[0], String(from + 1), `from ${from}`);
  }
  assert.deepStrictEqual((await o.range(K(2), { from: 1999998, count: 10 })).lines, ['1999999', '2000000']);
});

test('index: SGR state carries into a range, from the nearest checkpoint', async () => {
  const o = store();
  o.begin(K(3));
  const lines = [];
  for (let i = 0; i < 2000; i++) lines.push(i === 10 ? '\x1b[1;31mred from here' : i === 1500 ? 'x\x1b[0m reset' : `line ${i}`);
  o.append(K(3), `${lines.join('\n')}\n`);
  o.end(K(3));
  assert.strictEqual((await o.range(K(3), { from: 5, count: 1 })).sgr, '');
  assert.strictEqual((await o.range(K(3), { from: 11, count: 1 })).sgr, '1;31');
  assert.strictEqual((await o.range(K(3), { from: 1000, count: 1 })).sgr, '1;31');
  assert.strictEqual((await o.range(K(3), { from: 1600, count: 1 })).sgr, '');
  assert.deepStrictEqual((await o.range(K(3), { from: 10, count: 1, plain: true })).lines, ['red from here']);
});

test('rows: long and wide lines wrap at the card width', async () => {
  const o = store();
  o.begin(K(4));
  o.append(K(4), `short\n${'x'.repeat(250)}\n${'中'.repeat(70)}\nend\n`);
  o.end(K(4));
  // 250 cells at 100 cols: 3 rows. 70 wide chars = 140 cells: 2 rows.
  const v = await o.view(K(4), { cols: 100, row: 0, count: 10 });
  assert.strictEqual(v.totalRows, 1 + 3 + 2 + 1);
  assert.strictEqual(v.totalLines, 4);
  const mid = await o.view(K(4), { cols: 100, row: 2, count: 1 });
  assert.deepStrictEqual([mid.line0, mid.row0], [1, 1]);
  const at = await o.view(K(4), { cols: 100, row: 5, count: 1 });
  assert.deepStrictEqual([at.line0, at.row0], [2, 4]);
  assert.strictEqual(await o.locate(K(4), { cols: 100, line: 3 }), 6);
  // Wider card, fewer rows.
  assert.strictEqual((await o.view(K(4), { cols: 200, row: 0, count: 1 })).totalRows, 1 + 2 + 1 + 1);
});

test('rows: tabs count to the next stop, escapes and CR overwrites count nothing', async () => {
  const o = store();
  o.begin(K(5));
  o.append(K(5), `${'a\t'.repeat(10)}\n\x1b[32m${'y'.repeat(40)}\x1b[0m\n${'z'.repeat(80)}\r${'w'.repeat(10)}\n`);
  o.end(K(5));
  // 10 tabs → 80 cells → 2 rows at 40; the SGR line is 40 cells; the CR line is 10.
  assert.strictEqual((await o.view(K(5), { cols: 40, row: 0, count: 1 })).totalRows, 2 + 1 + 1);
});

test('LINE_MAX: a very long line is split, and the split is marked soft', async () => {
  const o = store();
  o.begin(K(6));
  o.append(K(6), `${'é'.repeat(LINE_MAX)}\nnext\n`);
  o.end(K(6));
  const r = await o.range(K(6), { from: 0, count: 5 });
  assert.strictEqual(r.lines.length, 3);
  assert.deepStrictEqual(r.soft, [0]);
  assert.strictEqual(r.lines[0] + r.lines[1], 'é'.repeat(LINE_MAX));
  assert.ok(!r.lines[0].includes('�'));
});

test('caps: a card stops at its cap; the oldest finished cards go past the total', async () => {
  const capped = [];
  const evicted = [];
  const o = store({ capCard: 1000, capTotal: 2500, onCapped: (id) => capped.push(id), onEvicted: (id) => evicted.push(id) });
  o.begin(K(7));
  o.append(K(7), 'a'.repeat(900));
  o.append(K(7), 'b'.repeat(900));
  assert.strictEqual(o.end(K(7)).bytes, 1000);
  assert.deepStrictEqual(capped, [K(7)]);
  assert.ok((await o.info(K(7))).capped);
  for (const id of [8, 9].map(K)) { o.begin(id); o.append(id, 'c'.repeat(900)); o.end(id); }
  o.begin(K(10));
  await new Promise((r) => setTimeout(r, 1100));
  o.append(K(10), 'd'.repeat(400));
  assert.deepStrictEqual(evicted, [K(7)]);
  assert.ok((await o.info(K(7))).evicted);
  assert.ok(o.totalBytes() <= 2500);
});

test('index file: reloads without rescanning, rebuilds if missing', async () => {
  const dir = tmp();
  const a = store({ dir });
  a.begin(K(11));
  a.append(K(11), Array.from({ length: 5000 }, (_, i) => `row ${i} ${'q'.repeat(i % 90)}`).join('\n'));
  a.end(K(11));
  a.shutdown();
  const b = store({ dir });
  const want = (await b.view(K(11), { cols: 60, row: 3000, count: 5 }));
  fs.rmSync(path.join(dir, `${K(11)}.idx`));
  const c = store({ dir });
  const got = await c.view(K(11), { cols: 60, row: 3000, count: 5 });
  assert.deepStrictEqual(got, want);
  assert.strictEqual(got.totalLines, 5000);
});

test('scanner: cursor movement and the alternate screen are noticed; replay uses \\r\\n', () => {
  const o = store();
  o.begin(K(12));
  o.append(K(12), '\x1b[32mgreen\x1b[0m\n 50%\r100%\x1b[K\n');
  assert.deepStrictEqual(o.state(K(12)), { moved: false, alt: false });
  o.append(K(12), '\x1b[2');
  o.append(K(12), 'A up\n');
  assert.strictEqual(o.state(K(12)).moved, true);
  o.append(K(12), 'x\x1b[?10');
  o.append(K(12), '49hALT');
  assert.strictEqual(o.state(K(12)).alt, true);
  assert.strictEqual(o.replay(K(12)), '\x1b[?1049hALT');
  o.end(K(12));
  o.begin(K(13));
  o.append(K(13), 'a\nb\n');
  assert.strictEqual(o.replay(K(13)), 'a\r\nb\r\n');
});

test('exportPlain: escapes stripped, CR overwrites applied', async () => {
  const o = store();
  o.begin(K(14));
  o.append(K(14), '\x1b[31mred\x1b[0m\r\nprogress 10%\rprogress 100%\r\nplain\r\n');
  o.end(K(14));
  const dest = path.join(tmp(), 'out.txt');
  await o.exportPlain(K(14), dest);
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'red\nprogress 100%\nplain\n');
  const clip = await o.clip(K(14), { head: 4, tail: 6 });
  assert.ok(clip.text.startsWith('red'));
});

test('search: every matching line, in visible text, with line numbers the index uses', async () => {
  const o = store();
  o.begin(K(15));
  let text = '';
  for (let i = 0; i < 300000; i++) text += i === 299990 ? 'the NEEDLE is here\n' : i === 5 ? '\x1b[31mnee\x1b[0mdle in color\n' : `hay ${i}\n`;
  o.append(K(15), `${text}${'x'.repeat(LINE_MAX + 10)}needle\n`);
  o.end(K(15));
  const r = await o.search(K(15), { query: 'needle' });
  assert.deepStrictEqual(r.lines, [5, 299990, 300001]);
  assert.strictEqual(r.count, 3);
  const [line] = (await o.range(K(15), { from: 299990, count: 1, plain: true })).lines;
  assert.strictEqual(line, 'the NEEDLE is here');
  assert.deepStrictEqual((await o.search(K(15), { query: 'NEEDLE', caseSensitive: true })).lines, [299990]);
  assert.strictEqual((await o.search(K(15), { query: 'nothing like it' })).count, 0);
});
