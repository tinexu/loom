'use strict';
// Loom — a finished card's output, virtualized. Only the rows in view (plus
// overscan) are in the DOM. Rows come from main.js (`out:view`) in chunks,
// and a small cache keeps recently viewed chunks across cards and remounts.
// Wrapping is computed here and in lib/outputs.js with the same rules
// (renderer/wrap.js), so the scroll height is exact without reading the file.
// Scrolling is our own (wheel, keys, a drawn scrollbar), because a browser
// can't scroll an element billions of pixels tall.
(function (g) {
  const { Wrap, Ansi } = g;
  const CHUNK = 128;
  const OVER = 40;
  const CACHE_MAX = 240;
  const cache = new Map(); // `${id}:${cols}:${k}` -> chunk, in LRU order
  const SGR_ONLY = /^\x1b\[([0-9;:]*)m$/;

  const esc = (s) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

  function cacheGet(key) {
    const v = cache.get(key);
    if (v) { cache.delete(key); cache.set(key, v); }
    return v;
  }
  function cachePut(key, v) {
    cache.set(key, v);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  // A card's output changed (rerun, replaced, removed).
  function forget(id) {
    for (const k of [...cache.keys()]) if (k.startsWith(`${id}:`)) cache.delete(k);
  }

  // A raw line into visible text and style changes ([index, css]), carrying
  // SGR state in `st` from line to line.
  function parse(raw, st) {
    const line = Wrap.normalize(raw);
    let vis = '';
    const sty = [[0, Ansi.styleOf(st)]];
    let last = 0;
    const re = new RegExp(Wrap.ESC_RE.source, 'g');
    let m;
    while ((m = re.exec(line))) {
      vis += line.slice(last, m.index);
      last = re.lastIndex;
      const sgr = SGR_ONLY.exec(m[0]);
      if (!sgr) continue;
      Ansi.applySGR(st, sgr[1]);
      const css = Ansi.styleOf(st);
      const top = sty[sty.length - 1];
      if (top[1] === css) continue;
      if (top[0] === vis.length) top[1] = css; else sty.push([vis.length, css]);
    }
    vis += line.slice(last);
    return { vis, sty };
  }

  // Rows of a chunk: { l: line, a, b: indexes into the line's text, ln: line model }.
  function buildChunk(res, cols, k) {
    const rows = [];
    const st = {};
    if (res.sgr) Ansi.applySGR(st, res.sgr);
    let r = res.row0;
    const lo = k * CHUNK;
    const hi = lo + CHUNK;
    const soft = new Set(res.soft);
    for (let i = 0; i < res.lines.length && r < hi; i++) {
      const ln = parse(res.lines[i], st);
      ln.soft = soft.has(i);
      ln.tabs = null;
      const lineNo = res.line0 + i;
      Wrap.layout(ln.vis, cols, (a, b) => {
        if (r >= lo && r < hi) rows[r - lo] = { l: lineNo, a, b, ln };
        r++;
      }, (idx, col, w) => { if (ln.vis.charCodeAt(idx) === 9) (ln.tabs || (ln.tabs = new Map())).set(idx, w); });
    }
    return { rows, totalRows: res.totalRows, totalLines: res.totalLines };
  }

  // One row's HTML, with search hits marked.
  function rowHtml(row, hits, cur) {
    const { ln, a, b } = row;
    let out = '';
    let si = 0;
    while (si + 1 < ln.sty.length && ln.sty[si + 1][0] <= a) si++;
    let i = a;
    while (i < b) {
      const nextSty = si + 1 < ln.sty.length ? ln.sty[si + 1][0] : Infinity;
      let end = Math.min(b, nextSty);
      let hit = null;
      if (hits) {
        for (const h of hits) {
          if (h[1] <= i) continue;
          if (h[0] <= i) { hit = h; end = Math.min(end, h[1]); break; }
          end = Math.min(end, h[0]);
          break;
        }
      }
      let text = '';
      for (let j = i; j < end; j++) {
        const c = ln.vis[j];
        if (c === '\t') text += `<span class="vt-tab">${' '.repeat((ln.tabs && ln.tabs.get(j)) || 1)}</span>`;
        else text += c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c;
      }
      const css = ln.sty[si][1];
      if (css) text = `<span style="${css}">${text}</span>`;
      if (hit) text = `<mark class="vt-hit${cur ? ' cur' : ''}">${text}</mark>`;
      out += text;
      i = end;
      if (i >= nextSty) si++;
    }
    return out;
  }

  // opts: api, id, host (element), lineH, charW, maxHeight() px, onLayout(),
  // atEnd: start scrolled to the end, top: a row to start at.
  function create(opts) {
    const { api, id, lineH } = opts;
    const root = document.createElement('div');
    root.className = 'vt';
    root.tabIndex = -1;
    root.innerHTML = `<div class="vt-find" hidden><input class="vt-q" placeholder="Find in output" spellcheck="false"><span class="vt-count"></span>
      <button class="vt-prev" title="Previous (Shift+Enter)">↑</button><button class="vt-next" title="Next (Enter)">↓</button><button class="vt-close" title="Close (Esc)">×</button></div>
      <div class="vt-view"><div class="vt-rows"></div></div><div class="vt-bar"><div class="vt-thumb"></div></div>`;
    opts.host.append(root);
    const q = (s) => root.querySelector(s);
    const view = q('.vt-view');
    const rowsEl = q('.vt-rows');
    const bar = q('.vt-bar');
    const thumb = q('.vt-thumb');
    const find = { box: q('.vt-find'), input: q('.vt-q'), count: q('.vt-count'), lines: [], total: 0, i: -1, query: '', seq: 0, lc: '' };

    let cols = 0;
    let top = 0; // first visible row, fractional
    let totalRows = 0;
    let totalLines = 0;
    let viewH = 0;
    let base = 0;
    let frame = 0;
    let destroyed = false;
    const els = new Map(); // row -> element
    const pending = new Set();
    let seq = 0;

    const viewRows = () => viewH / lineH;
    const maxTop = () => Math.max(0, totalRows - viewRows());
    const key = (k) => `${id}:${cols}:${k}`;

    function setHeight() {
      const max = Math.max(lineH, opts.maxHeight() - (find.box.hidden ? 0 : 34));
      const h = Math.min(Math.max(1, totalRows) * lineH, max);
      if (h !== viewH) { viewH = h; view.style.height = `${h}px`; opts.onLayout(); }
      bar.hidden = totalRows * lineH <= viewH + 0.5;
    }

    async function fetchChunk(k) {
      const kk = key(k);
      if (cacheGet(kk) || pending.has(kk)) return;
      pending.add(kk);
      const mine = seq;
      try {
        const res = await api.outView({ id, cols, row: k * CHUNK, count: CHUNK });
        if (!res || destroyed || mine !== seq) return;
        const chunk = buildChunk(res, cols, k);
        cachePut(kk, chunk);
        if (chunk.totalRows !== totalRows) { totalRows = chunk.totalRows; totalLines = chunk.totalLines; setHeight(); }
        schedule();
      } finally { pending.delete(kk); }
    }

    function rowAt(r) {
      const c = cacheGet(key(Math.floor(r / CHUNK)));
      return c ? c.rows[r - Math.floor(r / CHUNK) * CHUNK] : null;
    }

    function hitsFor(row) {
      if (!find.query) return null;
      const lc = row.ln.lc || (row.ln.lc = row.ln.vis.toLowerCase());
      const out = [];
      let at = lc.indexOf(find.lc);
      while (at >= 0) {
        const e = at + find.lc.length;
        if (e > row.a && at < row.b) out.push([Math.max(at, row.a), Math.min(e, row.b)]);
        at = lc.indexOf(find.lc, e);
      }
      return out.length ? out : null;
    }

    // Rows holding the selection's ends stay, so a selection survives scrolling.
    function pinned() {
      const s = document.getSelection();
      const out = new Set();
      if (!s || !s.rangeCount) return out;
      for (const node of [s.anchorNode, s.focusNode]) {
        const el = node && (node.nodeType === 1 ? node : node.parentElement);
        const row = el && el.closest('.vt-row');
        if (row && rowsEl.contains(row)) out.add(Number(row.dataset.r));
      }
      return out;
    }

    function render() {
      frame = 0;
      if (destroyed) return;
      top = Math.max(0, Math.min(top, maxTop()));
      const first = Math.floor(top);
      const lo = Math.max(0, first - OVER);
      const hi = Math.min(Math.max(totalRows, 1), first + Math.ceil(viewRows()) + OVER);
      for (let k = Math.floor(lo / CHUNK); k <= Math.floor((hi - 1) / CHUNK); k++) if (!cacheGet(key(k))) fetchChunk(k);
      const keep = pinned();
      for (const [r, el] of els) if ((r < lo || r >= hi) && !keep.has(r)) { el.remove(); els.delete(r); }
      const moved = base !== lo;
      base = lo;
      const curLine = find.i >= 0 ? find.lines[find.i] : -1;
      let prev = null;
      for (let r = lo; r < hi; r++) {
        let el = els.get(r);
        const row = rowAt(r);
        const sig = row ? `${row.l}:${row.a}:${find.query}:${curLine === row.l}` : '';
        if (!el) {
          el = document.createElement('div');
          el.className = 'vt-row';
          el.dataset.r = r;
          els.set(r, el);
          el.style.top = `${(r - base) * lineH}px`;
          if (prev) prev.after(el); else rowsEl.prepend(el);
        } else if (moved) el.style.top = `${(r - base) * lineH}px`;
        if (el.sig !== sig) {
          el.sig = sig;
          if (row) {
            el.dataset.l = row.l;
            el.dataset.a = row.a;
            el.innerHTML = rowHtml(row, hitsFor(row), curLine === row.l);
          } else el.textContent = '';
        }
        prev = el;
      }
      for (const r of keep) { const el = els.get(r); if (el && (r < lo || r >= hi)) el.style.top = `${(r - base) * lineH}px`; }
      rowsEl.style.transform = `translateY(${(base - top) * lineH}px)`;
      // Scrollbar.
      const th = Math.max(20, viewH * (viewH / Math.max(viewH, totalRows * lineH)));
      thumb.style.height = `${th}px`;
      thumb.style.transform = `translateY(${maxTop() ? (top / maxTop()) * (viewH - th) : 0}px)`;
      opts.onScroll && opts.onScroll(top);
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };

    async function start() {
      const mine = ++seq;
      els.forEach((el) => el.remove());
      els.clear();
      // The last chunk tells the total; a card that just finished starts at its end.
      const res = await api.outView({ id, cols, row: opts.atEnd ? Number.MAX_SAFE_INTEGER : Math.max(0, opts.top || 0), count: 1 });
      if (!res || destroyed || mine !== seq) return;
      totalRows = res.totalRows;
      totalLines = res.totalLines;
      setHeight();
      top = opts.atEnd ? maxTop() : Math.min(opts.top || 0, maxTop());
      render();
    }

    // ---------------------------------------------------------------- input
    function scrollBy(rows) {
      const t = Math.max(0, Math.min(top + rows, maxTop()));
      if (t === top) return false;
      top = t;
      schedule();
      return true;
    }
    root.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const px = e.deltaMode === 1 ? e.deltaY * lineH : e.deltaMode === 2 ? e.deltaY * viewH : e.deltaY;
      if (scrollBy(px / lineH)) { e.preventDefault(); e.stopPropagation(); }
    }, { passive: false });
    root.addEventListener('keydown', (e) => {
      if (e.target.closest('.vt-find')) return;
      const page = Math.max(1, viewRows() - 2);
      const moves = { PageDown: page, PageUp: -page, ArrowDown: 3, ArrowUp: -3, End: Infinity, Home: -Infinity };
      if (!(e.key in moves) || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      const m = moves[e.key];
      if (m === Infinity) top = maxTop(); else if (m === -Infinity) top = 0; else scrollBy(m);
      schedule();
    });
    // The scrollbar.
    thumb.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      thumb.setPointerCapture(e.pointerId);
      const y0 = e.clientY;
      const t0 = top;
      const k = opts.zoom ? opts.zoom() : 1;
      const th = thumb.offsetHeight;
      const move = (ev) => { top = t0 + ((ev.clientY - y0) / k / Math.max(1, viewH - th)) * maxTop(); schedule(); };
      const up = () => { thumb.removeEventListener('pointermove', move); thumb.removeEventListener('pointerup', up); };
      thumb.addEventListener('pointermove', move);
      thumb.addEventListener('pointerup', up);
    });
    bar.addEventListener('pointerdown', (e) => {
      if (e.target !== bar) return;
      e.stopPropagation();
      const r = thumb.getBoundingClientRect();
      scrollBy((e.clientY < r.top ? -1 : 1) * Math.max(1, viewRows() - 2));
    });
    // Dragging a selection past the edge scrolls.
    view.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      let timer = 0;
      let dy = 0;
      const tick = () => { if (dy) scrollBy(dy / lineH / 2); timer = dy ? requestAnimationFrame(tick) : 0; };
      const move = (ev) => {
        const r = view.getBoundingClientRect();
        dy = ev.clientY < r.top ? ev.clientY - r.top : ev.clientY > r.bottom ? ev.clientY - r.bottom : 0;
        if (dy && !timer) timer = requestAnimationFrame(tick);
      };
      const up = () => { dy = 0; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    // ---------------------------------------------------------------- copy
    // Where a DOM point is in the output: [line, index into its visible text].
    function pointOf(node, offset) {
      const el = node.nodeType === 1 ? node : node.parentElement;
      const row = el && el.closest('.vt-row');
      if (!row || !rowsEl.contains(row) || row.dataset.l == null) return null;
      const range = document.createRange();
      range.setStart(row, 0);
      range.setEnd(node, offset);
      const frag = range.cloneContents();
      let n = 0;
      const walk = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) n += walk.currentNode.parentElement && walk.currentNode.parentElement.classList.contains('vt-tab') ? Math.min(1, walk.currentNode.length) : walk.currentNode.length;
      return [Number(row.dataset.l), Number(row.dataset.a) + n];
    }

    // The selected text, from main, so lines scrolled out of the DOM count too.
    async function selectionText() {
      const s = document.getSelection();
      if (!s || s.isCollapsed) return null;
      let a = pointOf(s.anchorNode, s.anchorOffset);
      let b = pointOf(s.focusNode, s.focusOffset);
      if (!a || !b) return null;
      if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) [a, b] = [b, a];
      return copyRange(a, b);
    }
    async function copyRange([l0, i0], [l1, i1]) {
      let out = '';
      for (let from = l0; from <= l1; from += 20000) {
        const res = await api.outRange({ id, from, count: Math.min(20000, l1 - from + 1), plain: true });
        const soft = new Set(res.soft);
        res.lines.forEach((t, k) => {
          const l = from + k;
          let s = t;
          if (l === l1) s = s.slice(0, i1);
          if (l === l0) s = s.slice(i0);
          out += s;
          if (l !== l1 && !soft.has(k)) out += '\n';
        });
      }
      return out;
    }

    // ---------------------------------------------------------------- find
    async function runFind() {
      const query = find.input.value;
      const mine = ++find.seq;
      find.query = query;
      find.lc = query.toLowerCase();
      if (!query) { find.lines = []; find.total = 0; find.i = -1; find.count.textContent = ''; els.forEach((el) => { el.sig = null; }); schedule(); return; }
      find.count.textContent = '…';
      const res = await api.outSearch({ id, query });
      if (!res || mine !== find.seq) return;
      find.lines = res.lines;
      find.total = res.count;
      // The first match at or after what's on screen.
      const atLine = (rowAt(Math.floor(top)) || { l: 0 }).l;
      find.i = find.lines.length ? Math.max(0, find.lines.findIndex((l) => l >= atLine)) : -1;
      els.forEach((el) => { el.sig = null; });
      await jump();
    }
    async function jump() {
      if (find.i < 0) { find.count.textContent = find.query ? 'No matches' : ''; schedule(); return; }
      find.count.textContent = `${(find.i + 1).toLocaleString()} / ${find.total.toLocaleString()}${find.total > find.lines.length ? '+' : ''}`;
      const row = await api.outLocate({ id, cols, line: find.lines[find.i] });
      top = Math.max(0, Math.min(row - Math.floor(viewRows() / 3), maxTop()));
      schedule();
    }
    const step = (d) => { if (!find.lines.length) return; find.i = (find.i + d + find.lines.length) % find.lines.length; jump(); };
    let findTimer = 0;
    find.input.addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(runFind, 150); });
    find.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); if (find.query !== find.input.value) runFind(); else step(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });
    q('.vt-next').onclick = () => step(1);
    q('.vt-prev').onclick = () => step(-1);
    q('.vt-close').onclick = () => closeFind();
    function openFind() {
      find.box.hidden = false;
      setHeight();
      find.input.focus();
      find.input.select();
      schedule();
    }
    function closeFind() {
      find.box.hidden = true;
      find.input.value = '';
      runFind();
      setHeight();
      root.focus();
    }

    return {
      el: root,
      setCols(c) {
        c = Math.max(Wrap.LONG, c | 0);
        if (c === cols) return;
        // Keep the line at the top in place.
        const row = cols ? rowAt(Math.floor(top)) : null;
        cols = c;
        if (row) {
          opts.atEnd = false;
          api.outLocate({ id, cols, line: row.l }).then((r) => { opts.top = r; start(); });
        } else start();
      },
      refresh: () => { forget(id); start(); },
      layout: () => { setHeight(); schedule(); },
      openFind,
      selectionText,
      copyRange,
      scrollToEnd: () => { top = maxTop(); schedule(); },
      scrollTo: (row) => { top = row; schedule(); },
      canScroll: (dy) => (dy > 0 ? top < maxTop() : top > 0),
      top: () => top,
      destroy() { destroyed = true; cancelAnimationFrame(frame); root.remove(); },
      // For the e2e run.
      stats: () => ({ top, totalRows, totalLines, cols, rows: els.size, viewH, find: { total: find.total, i: find.i, line: find.lines[find.i] } }),
    };
  }

  g.VLines = { create, forget };
})(window);
