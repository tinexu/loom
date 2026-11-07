'use strict';
// Unit tests for renderer/wrap.js: cell widths and rows per line. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const Wrap = require('../renderer/wrap');

test('wcwidth: narrow, wide, zero-width, control', () => {
  const w = (s) => Wrap.wcwidth(s.codePointAt(0));
  assert.strictEqual(w('a'), 1);
  assert.strictEqual(w('é'), 1);
  assert.strictEqual(w('中'), 2);
  assert.strictEqual(w('한'), 2);
  assert.strictEqual(w('ｱ'), 1); // halfwidth katakana
  assert.strictEqual(w('Ａ'), 2); // fullwidth A
  assert.strictEqual(w('😀'), 2);
  assert.strictEqual(w('́'), 0); // combining acute
  assert.strictEqual(w('‍'), 0); // zero-width joiner
  assert.strictEqual(w('\x07'), 0);
});

test('extent: tabs stop every 8, wide characters take 2, combining marks none', () => {
  assert.strictEqual(Wrap.extent(''), 0);
  assert.strictEqual(Wrap.extent('abc'), 3);
  assert.strictEqual(Wrap.extent('a\tb'), 9);
  assert.strictEqual(Wrap.extent('\t'), 1);
  assert.strictEqual(Wrap.extent('中文'), 3); // the last character starts at cell 2
  assert.strictEqual(Wrap.extent('é'), 1);
  assert.strictEqual(Wrap.extent('👍🏽ok'), 4);
});

test('rows: wraps at the column count, and a wide character overhangs instead of opening a row', () => {
  assert.strictEqual(Wrap.rows(0, 80), 1);
  assert.strictEqual(Wrap.rows(80, 80), 1);
  assert.strictEqual(Wrap.rows(81, 80), 2);
  // 39 narrow, then a wide character starting in the last column of 40.
  const line = `${'a'.repeat(39)}中`;
  assert.strictEqual(Wrap.rows(Wrap.extent(line), 40), 1);
  assert.strictEqual(Wrap.rows(Wrap.extent(`${line}b`), 40), 2);
});

test('visible: escapes go, CR starts the line over, backspace removes', () => {
  assert.strictEqual(Wrap.visible('\x1b[1;32mok\x1b[0m'), 'ok');
  assert.strictEqual(Wrap.visible(' 10%\r 55%\r100%'), '100%');
  assert.strictEqual(Wrap.visible('done\r'), 'done');
  assert.strictEqual(Wrap.visible('N\bNA\bAM\bME\bE'), 'NAME');
  assert.strictEqual(Wrap.visible('\x1b]8;;http://x\x07link\x1b]8;;\x07'), 'link');
});

test('layout agrees with rows for any mix of text', () => {
  const pool = ['a', 'b', ' ', '\t', '中', '😀', 'é', 'ｱ', '-'];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let k = 0; k < 2000; k++) {
    const n = Math.floor(rnd() * 300);
    let s = '';
    for (let i = 0; i < n; i++) s += pool[Math.floor(rnd() * pool.length)];
    const cols = 32 + Math.floor(rnd() * 100);
    const got = [];
    Wrap.layout(s, cols, (a, b) => got.push(s.slice(a, b)));
    assert.strictEqual(got.length, Wrap.rows(Wrap.extent(s), cols), JSON.stringify([s, cols]));
    assert.strictEqual(got.join(''), s);
  }
});
