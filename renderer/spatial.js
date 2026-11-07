'use strict';
// Loom — a uniform grid of buckets over card rectangles, for overlap checks
// when placing a card, viewport culling and minimap hit-testing. Loaded by the
// page as window.Spatial and by the tests with require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Spatial = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const BIAS = 1 << 15;

  function createGrid(cell = 512) {
    const buckets = new Map(); // cell key -> Set of ids
    const items = new Map(); // id -> { x, y, w, h, x0, y0, x1, y1 }
    let stamp = 0;
    const seen = new Map();
    const key = (cx, cy) => (cx + BIAS) * 65536 + (cy + BIAS);
    const span = (x, y, w, h) => [Math.floor(x / cell), Math.floor(y / cell), Math.floor((x + Math.max(0, w)) / cell), Math.floor((y + Math.max(0, h)) / cell)];

    function each(it, fn) {
      for (let cx = it.x0; cx <= it.x1; cx++) for (let cy = it.y0; cy <= it.y1; cy++) fn(key(cx, cy));
    }

    function remove(id) {
      const it = items.get(id);
      if (!it) return;
      each(it, (k) => { const b = buckets.get(k); if (b) { b.delete(id); if (!b.size) buckets.delete(k); } });
      items.delete(id);
    }

    function set(id, x, y, w, h) {
      const [x0, y0, x1, y1] = span(x, y, w, h);
      const it = items.get(id);
      if (it && it.x0 === x0 && it.y0 === y0 && it.x1 === x1 && it.y1 === y1) { Object.assign(it, { x, y, w, h }); return; }
      remove(id);
      const n = { x, y, w, h, x0, y0, x1, y1 };
      items.set(id, n);
      each(n, (k) => { let b = buckets.get(k); if (!b) { b = new Set(); buckets.set(k, b); } b.add(id); });
    }

    // Ids whose rectangle overlaps the given one.
    function query(x, y, w, h) {
      const [x0, y0, x1, y1] = span(x, y, w, h);
      const out = [];
      stamp++;
      // Very large areas: scanning items beats scanning empty cells.
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > items.size * 2) {
        for (const [id, it] of items) if (it.x < x + w && it.x + it.w > x && it.y < y + h && it.y + it.h > y) out.push(id);
        return out;
      }
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const b = buckets.get(key(cx, cy));
          if (!b) continue;
          for (const id of b) {
            if (seen.get(id) === stamp) continue;
            seen.set(id, stamp);
            const it = items.get(id);
            if (it.x < x + w && it.x + it.w > x && it.y < y + h && it.y + it.h > y) out.push(id);
          }
        }
      }
      return out;
    }

    const at = (x, y) => query(x, y, 0.001, 0.001);
    const clear = () => { buckets.clear(); items.clear(); seen.clear(); };

    return { set, remove, query, at, clear, get: (id) => items.get(id), get size() { return items.size; } };
  }

  return { createGrid };
}));
