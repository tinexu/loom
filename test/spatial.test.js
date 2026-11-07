'use strict';
// Unit tests for renderer/spatial.js, against a brute-force check. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const { createGrid } = require('../renderer/spatial');

const overlaps = (a, x, y, w, h) => a.x < x + w && a.x + a.w > x && a.y < y + h && a.y + a.h > y;

test('query, at, move and remove agree with brute force', () => {
  const g = createGrid(256);
  const rects = new Map();
  let seed = 3;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * n; };
  for (let id = 1; id <= 1000; id++) {
    const r = { x: rnd(40000) - 5000, y: rnd(20000) - 2000, w: 360 + rnd(1000), h: 60 + rnd(1500) };
    rects.set(id, r);
    g.set(id, r.x, r.y, r.w, r.h);
  }
  // Move some, remove some.
  for (let id = 1; id <= 1000; id += 7) {
    const r = rects.get(id);
    r.x += rnd(3000) - 1500; r.y += rnd(3000);
    g.set(id, r.x, r.y, r.w, r.h);
  }
  for (let id = 5; id <= 1000; id += 11) { rects.delete(id); g.remove(id); }
  assert.strictEqual(g.size, rects.size);
  for (let k = 0; k < 300; k++) {
    const x = rnd(45000) - 6000; const y = rnd(25000) - 3000; const w = rnd(6000); const h = rnd(4000);
    const want = [...rects].filter(([, r]) => overlaps(r, x, y, w, h)).map(([id]) => id).sort((a, b) => a - b);
    assert.deepStrictEqual(g.query(x, y, w, h).sort((a, b) => a - b), want);
  }
  const [id, r] = [...rects][10];
  assert.ok(g.at(r.x + 1, r.y + 1).includes(id));
  // A query bigger than everything still works.
  assert.strictEqual(g.query(-1e6, -1e6, 2e6, 2e6).length, rects.size);
});

test('placing a card: overlap checks only touch nearby cards', () => {
  const g = createGrid();
  for (let i = 0; i < 1000; i++) g.set(i, (i % 40) * 700, Math.floor(i / 40) * 500, 620, 400);
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < 10000; k++) g.query((k % 40) * 700 + 10, 200, 620, 160);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 100, `${ms.toFixed(1)} ms for 10,000 queries`);
  assert.deepStrictEqual(g.query(10, 10, 100, 100), [0]);
});
