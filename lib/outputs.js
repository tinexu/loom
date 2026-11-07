'use strict';
// Loom — card output storage. Each card's output goes to its own file,
// userData/outputs/<id>.log, as it streams in, with an in-memory index:
//   - the byte offset of every BLOCK-th line, so any line range is one seek away
//   - the SGR (color) state at each of those lines, so a range renders in color
//     without reading what came before it
//   - the extent of every line wider than Wrap.LONG cells (2 bytes a line, only
//     in blocks that have one), so the rows of the whole output at any card
//     width are known without reading it
// Line endings are stored as \n. Lines longer than LINE_MAX bytes are split
// (the extra line is "soft", and copy joins it back).
// An index is written next to the log when a card finishes (<id>.idx) and
// rebuilt from the log if it's missing or stale.

const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { Worker } = require('worker_threads');
const Wrap = require('../renderer/wrap');

const LINE_MAX = 16384;
const BLOCK = 256;
const WRITE_BUF = 256 * 1024;
const READ_CHUNK = 256 * 1024;
const REBUILD_CHUNK = 4 * 1024 * 1024;
const IDX_MEM = 96 * 1024 * 1024; // finished cards' indexes kept in memory
const REPLAY_TAIL = 256 * 1024;
const REPLAY_ALT = 2 * 1024 * 1024;
const GB = 1024 ** 3;

// ---------------------------------------------------------------- small pieces
class Grow {
  constructor(T, n = 256) { this.T = T; this.a = new T(n); this.n = 0; }
  push(v) {
    if (this.n === this.a.length) { const b = new this.T(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  static from(T, arr) { const g = new Grow(T, Math.max(256, arr.length)); g.a.set(arr); g.n = arr.length; return g; }
  view() { return this.a.subarray(0, this.n); }
}

// SGR state, kept as the parameter strings that rebuild it: '1;38;5;196'.
function sgrApply(st, params) {
  const c = params === '' ? ['0'] : params.split(/[;:]/);
  for (let i = 0; i < c.length; i++) {
    const n = parseInt(c[i] || '0', 10);
    if (n === 0) { st.b = st.d = st.i = st.u = st.v = false; st.fg = st.bg = null; }
    else if (n === 1) st.b = true;
    else if (n === 2) st.d = true;
    else if (n === 3) st.i = true;
    else if (n === 4) st.u = true;
    else if (n === 7) st.v = true;
    else if (n === 22) st.b = st.d = false;
    else if (n === 23) st.i = false;
    else if (n === 24) st.u = false;
    else if (n === 27) st.v = false;
    else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) st.fg = String(n);
    else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) st.bg = String(n);
    else if (n === 39) st.fg = null;
    else if (n === 49) st.bg = null;
    else if (n === 38 || n === 48) {
      const key = n === 38 ? 'fg' : 'bg';
      if (c[i + 1] === '5') { st[key] = `${n};5;${c[i + 2] | 0}`; i += 2; }
      else if (c[i + 1] === '2') { st[key] = `${n};2;${c[i + 2] | 0};${c[i + 3] | 0};${c[i + 4] | 0}`; i += 4; }
    }
  }
}
function sgrString(st) {
  const p = [];
  if (st.b) p.push(1);
  if (st.d) p.push(2);
  if (st.i) p.push(3);
  if (st.u) p.push(4);
  if (st.v) p.push(7);
  if (st.fg) p.push(st.fg);
  if (st.bg) p.push(st.bg);
  return p.join(';');
}
const sgrParse = (s) => { const st = {}; if (s) sgrApply(st, s); return st; };
const SGR_RE = /\x1b\[([0-9;:]*)m/g;
function sgrLine(st, latin1) {
  SGR_RE.lastIndex = 0;
  let m;
  while ((m = SGR_RE.exec(latin1))) sgrApply(st, m[1]);
}

// ASCII with no escape, CR, BS or tab: a line's extent is its length.
function isSimple(buf, start = 0, end = buf.length) {
  for (let i = start; i < end; i++) {
    const b = buf[i];
    if (b >= 0x80 || b === 27 || b === 13 || b === 9 || b === 8) return false;
  }
  return true;
}

// Splits bytes into lines: at \n, and at LINE_MAX bytes (moved forward to a
// UTF-8 character boundary). onLine(start, end, next, soft) gets offsets into
// `buf`; the part of a line carried over from earlier chunks is in st.parts.
// Returning true from onLine stops early.
function split(st, buf, onLine) {
  let pos = 0;
  const len = buf.length;
  while (pos < len) {
    const nl = buf.indexOf(10, pos);
    const end = nl < 0 ? len : nl;
    const room = LINE_MAX - st.curLen;
    if (end - pos > room) {
      let cut = pos + Math.max(0, room);
      while (cut < end && (buf[cut] & 0xc0) === 0x80) cut++;
      if (cut < end) {
        const stop = onLine(pos, cut, cut, true);
        st.parts = []; st.curLen = 0; st.curSimple = true;
        pos = cut;
        if (stop) return pos;
        continue;
      }
    }
    if (nl < 0) {
      st.parts.push(Buffer.from(buf.subarray(pos)));
      st.curLen += len - pos;
      return len;
    }
    const stop = onLine(pos, nl, nl + 1, false);
    st.parts = []; st.curLen = 0; st.curSimple = true;
    pos = nl + 1;
    if (stop) return pos;
  }
  return pos;
}
const lineBytes = (st, buf, start, end) => (st.parts.length ? Buffer.concat([...st.parts, buf.subarray(start, end)]) : buf.subarray(start, end));

// ---------------------------------------------------------------- index
function newIndex() {
  const offsets = new Grow(Float64Array);
  offsets.push(0);
  return {
    lines: 0, bytes: 0, offsets, ext: [], extBlocks: 0, huge: new Map(), checkpoints: new Map(),
    curLen: 0, parts: [], curSimple: true, ended: false,
    held: null, sgr: {}, alt: false, altStart: -1, moved: false, hasEsc: false,
    rowCache: null,
  };
}
const lineCount = (ix) => ix.lines + (ix.curLen > 0 ? 1 : 0);
const indexBytes = (ix) => ix.offsets.a.byteLength + ix.extBlocks * BLOCK * 2;

// Escape sequences in a chunk: SGR changes (with their positions, for the
// checkpoints), the alternate screen, and anything that moves the cursor, which
// means the text alone isn't what the screen showed.
function scan(ix, buf, base) {
  const held = ix.held;
  ix.held = null;
  const s = held ? Buffer.concat([held, buf]) : buf;
  const off = held ? held.length : 0;
  const events = [];
  let i = s.indexOf(27);
  while (i >= 0) {
    ix.hasEsc = true;
    if (i + 1 >= s.length) { ix.held = Buffer.from(s.subarray(i)); break; }
    const c = s[i + 1];
    if (c === 0x5b) {
      let j = i + 2;
      while (j < s.length && s[j] >= 0x30 && s[j] <= 0x3f) j++;
      const pEnd = j;
      while (j < s.length && s[j] >= 0x20 && s[j] <= 0x2f) j++;
      if (j >= s.length) { if (s.length - i < 256) ix.held = Buffer.from(s.subarray(i)); break; }
      const fin = s[j];
      const params = s.toString('latin1', i + 2, pEnd);
      const priv = params[0] === '?' || params[0] === '>' || params[0] === '<' || params[0] === '=';
      if (fin === 0x6d && !priv) events.push({ pos: i - off, params });
      else if ((fin === 0x68 || fin === 0x6c) && params[0] === '?') {
        if (/(^|;)(1049|1047|47)(;|$)/.test(params.slice(1))) {
          const on = fin === 0x68;
          if (on && !ix.alt) ix.altStart = base + i - off;
          ix.alt = on;
          ix.moved = true;
        }
      } else if (fin !== 0x4b && !(fin === 0x68 || fin === 0x6c)) ix.moved = true; // EL is fine with \r
      i = s.indexOf(27, j + 1);
    } else if (c === 0x5d) {
      let end = -1;
      for (let j = i + 2; j < s.length; j++) if (s[j] === 7 || s[j] === 27) { end = j; break; }
      if (end < 0) { if (s.length - i < 4096) ix.held = Buffer.from(s.subarray(i)); break; }
      i = s[end] === 27 && s[end + 1] === 0x5c ? s.indexOf(27, end + 2) : s[end] === 7 ? s.indexOf(27, end + 1) : end;
    } else {
      if (c === 0x37 || c === 0x38 || c === 0x44 || c === 0x45 || c === 0x4d || c === 0x63) ix.moved = true;
      i = s.indexOf(27, i + 2);
    }
  }
  return events;
}

function hasTab(st, buf, start, end) {
  const t = buf.indexOf(9, start);
  if (t >= 0 && t < end) return true;
  return st.parts.some((p) => p.includes(9));
}

// Extents of lines wider than Wrap.LONG, per block of BLOCK lines: a
// Uint16Array made only for blocks that have one (2 bytes a line), with 0 for
// short lines and HUGE meaning "look in ix.huge".
const HUGE = 65535;
function setExt(ix, line, ext) {
  const b = Math.floor(line / BLOCK);
  let a = ix.ext[b];
  if (!a) { a = new Uint16Array(BLOCK); ix.ext[b] = a; ix.extBlocks++; }
  if (ext >= HUGE) { a[line % BLOCK] = HUGE; ix.huge.set(line, ext); } else a[line % BLOCK] = ext;
}
function extOf(ix, line) {
  const a = ix.ext[Math.floor(line / BLOCK)];
  if (!a) return 0;
  const v = a[line % BLOCK];
  return v === HUGE ? ix.huge.get(line) : v;
}
const rowsOfLine = (ix, cols, line) => { const e = extOf(ix, line); return e > cols ? Math.ceil(e / cols) : 1; };

// Adds a chunk (already stored at ix.bytes) to the index.
function feed(ix, buf, simple) {
  const base = ix.bytes;
  const events = buf.indexOf(27) >= 0 || ix.held ? scan(ix, buf, base) : null;
  let ev = 0;
  const applyUpTo = (p) => { if (events) while (ev < events.length && events[ev].pos < p) sgrApply(ix.sgr, events[ev++].params); };
  if (!simple) ix.curSimple = false;
  split(ix, buf, (start, end, next) => {
    const L = ix.curLen + (end - start);
    const plain = simple && ix.curSimple;
    if (L > Wrap.LONG || (!plain && hasTab(ix, buf, start, end))) {
      const ext = plain ? L : Wrap.extent(Wrap.visible(lineBytes(ix, buf, start, end).toString('utf8')));
      if (ext > Wrap.LONG) setExt(ix, ix.lines, ext);
    }
    ix.lines++;
    if (ix.lines % BLOCK === 0) {
      applyUpTo(next);
      ix.offsets.push(base + next);
      const s = sgrString(ix.sgr);
      if (s) ix.checkpoints.set(ix.lines / BLOCK, s);
    }
    return false;
  });
  if (!simple) ix.curSimple = ix.curLen === 0;
  applyUpTo(Infinity);
  ix.bytes += buf.length;
  ix.rowCache = null;
}

// The last line has no newline: count it.
function endIndex(ix) {
  if (ix.ended) return;
  ix.ended = true;
  if (ix.curLen > 0) {
    const all = Buffer.concat(ix.parts);
    const ext = ix.curSimple ? all.length : Wrap.extent(Wrap.visible(all.toString('utf8')));
    if (ext > Wrap.LONG) setExt(ix, ix.lines, ext);
    ix.lines++;
    ix.parts = []; ix.curLen = 0;
  }
  ix.rowCache = null;
}

// Rows at a card width: where each block of lines starts.
function rowsAt(ix, cols) {
  if (ix.rowCache && ix.rowCache.cols === cols) return ix.rowCache;
  const total = lineCount(ix);
  const nb = Math.max(1, Math.ceil(total / BLOCK));
  const starts = new Float64Array(nb + 1);
  let row = 0;
  for (let b = 0; b < nb; b++) {
    starts[b] = row;
    const n = Math.min(BLOCK, total - b * BLOCK);
    row += Math.max(0, n);
    const a = ix.ext[b];
    if (!a) continue;
    for (let i = 0; i < n; i++) {
      const v = a[i];
      if (v > cols) row += Math.ceil((v === HUGE ? ix.huge.get(b * BLOCK + i) : v) / cols) - 1;
    }
  }
  starts[nb] = row;
  ix.rowCache = { cols, starts, nb, total: row, lines: total };
  return ix.rowCache;
}
function rowOfLine(ix, cols, line) {
  const rc = rowsAt(ix, cols);
  if (line >= rc.lines) return rc.total + (line - rc.lines);
  const b = Math.floor(line / BLOCK);
  let row = rc.starts[b];
  for (let l = b * BLOCK; l < line; l++) row += rowsOfLine(ix, cols, l);
  return row;
}
function lineOfRow(ix, cols, row) {
  const rc = rowsAt(ix, cols);
  if (row >= rc.total) return { line: rc.lines + (row - rc.total), off: 0 };
  let lo = 0; let hi = rc.nb - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (rc.starts[m] <= row) lo = m; else hi = m - 1; }
  let r = rc.starts[lo];
  for (let line = lo * BLOCK; line < rc.lines; line++) {
    const k = rowsOfLine(ix, cols, line);
    if (row < r + k) return { line, off: row - r };
    r += k;
  }
  return { line: rc.lines, off: 0 };
}

// ---------------------------------------------------------------- index files
function writeIdx(file, ix, capped = false) {
  const blocks = [];
  for (let b = 0; b < ix.ext.length; b++) if (ix.ext[b]) blocks.push(b);
  const head = Buffer.from(JSON.stringify({
    v: 2, bytes: ix.bytes, capped, lines: ix.lines, nOff: ix.offsets.n, blocks, huge: [...ix.huge],
    checkpoints: [...ix.checkpoints], hasEsc: ix.hasEsc, moved: ix.moved, alt: ix.alt, altStart: ix.altStart,
    sgr: sgrString(ix.sgr),
  }));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(head.length);
  const pad = Buffer.alloc((8 - ((4 + head.length) % 8)) % 8);
  const bufs = [len, head, pad, Buffer.from(ix.offsets.view().slice().buffer), ...blocks.map((b) => Buffer.from(ix.ext[b].buffer))];
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, Buffer.concat(bufs));
  fs.renameSync(tmp, file);
}
function readIdx(file, size) {
  const buf = fs.readFileSync(file);
  const hl = buf.readUInt32LE(0);
  const h = JSON.parse(buf.toString('utf8', 4, 4 + hl));
  if (h.v !== 2 || h.bytes !== size) return null;
  let p = 4 + hl;
  p += (8 - (p % 8)) % 8;
  const take = (T, n) => { const bytes = n * T.BYTES_PER_ELEMENT; const a = new T(buf.buffer.slice(buf.byteOffset + p, buf.byteOffset + p + bytes)); p += bytes; return a; };
  const ix = newIndex();
  ix.offsets = Grow.from(Float64Array, take(Float64Array, h.nOff));
  for (const b of h.blocks) ix.ext[b] = take(Uint16Array, BLOCK);
  ix.extBlocks = h.blocks.length;
  ix.huge = new Map(h.huge);
  ix.capped = !!h.capped;
  Object.assign(ix, { lines: h.lines, bytes: h.bytes, checkpoints: new Map(h.checkpoints), hasEsc: h.hasEsc, moved: h.moved, alt: h.alt, altStart: h.altStart, sgr: sgrParse(h.sgr), ended: true });
  return ix;
}

// ---------------------------------------------------------------- store
// onCapped(id, cap) when a card hits its cap; onEvicted(id) when a finished
// card's output is removed to stay under the total.
function createOutputs({ dir, capCard = GB, capTotal = 5 * GB, onCapped = () => {}, onEvicted = () => {} }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const recs = new Map(); // id -> rec
  let caps = { card: capCard, total: capTotal };
  let total = 0;
  let order = 0;
  let flushTimer = null;

  const logFile = (id) => path.join(dir, `${id}.log`);
  const idxFile = (id) => path.join(dir, `${id}.idx`);
  const richFile = (id) => path.join(dir, `${id}.rich.json`);
  const goneFile = (id) => path.join(dir, `${id}.evicted`);

  // What's on disk from earlier runs. Oldest first, for eviction.
  for (const name of fs.readdirSync(dir)) {
    const m = /^(\d+)\.log$/.exec(name);
    if (!m) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      recs.set(Number(m[1]), { id: Number(m[1]), size: st.size, ix: null, fd: null, running: false, capped: false, order: st.mtimeMs, used: 0, wbuf: [], wlen: 0, cr: '', loading: null });
      total += st.size;
    } catch { /* raced with a removal */ }
  }
  order = Date.now();

  function rec(id) {
    let r = recs.get(id);
    if (!r) {
      r = { id, size: 0, ix: null, fd: null, running: false, capped: false, order: ++order, used: 0, wbuf: [], wlen: 0, cr: '', loading: null };
      recs.set(id, r);
    }
    return r;
  }

  function flushWrite(r) {
    if (!r.wlen || r.fd == null) return;
    const buf = r.wbuf.length === 1 ? r.wbuf[0] : Buffer.concat(r.wbuf, r.wlen);
    r.wbuf = []; r.wlen = 0;
    try { fs.writeSync(r.fd, buf); } catch (err) { console.warn(`output ${r.id}: ${err.message}`); }
  }
  function flushSoon() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; for (const r of recs.values()) flushWrite(r); }, 100);
  }

  function closeFd(r) {
    flushWrite(r);
    if (r.fd != null) { try { fs.closeSync(r.fd); } catch { /* closed */ } r.fd = null; }
  }

  // A new run of a card: its old output goes.
  function begin(id) {
    const r = rec(id);
    closeFd(r);
    total -= r.size;
    r.size = 0;
    r.capped = false;
    r.cr = '';
    r.running = true;
    r.order = ++order;
    r.ix = newIndex();
    r.loading = null;
    for (const f of [idxFile(id), richFile(id), goneFile(id)]) fs.rmSync(f, { force: true });
    r.fd = fs.openSync(logFile(id), 'w+', 0o600);
    return r;
  }

  // Text from the PTY. Line endings become \n; a CR at the end of a chunk
  // waits for the next one, which may start with its \n.
  function append(id, text) {
    const r = recs.get(id);
    if (!r || !r.running || r.capped) return;
    text = r.cr + text;
    r.cr = '';
    if (text.endsWith('\r')) { r.cr = '\r'; text = text.slice(0, -1); }
    if (text.includes('\r\n') || text.includes('\r\r')) text = text.replace(/\r+\n/g, '\n');
    if (!text) return;
    let buf = Buffer.from(text, 'utf8');
    let simple = buf.length === text.length && buf.indexOf(27) < 0 && buf.indexOf(13) < 0 && buf.indexOf(9) < 0 && buf.indexOf(8) < 0;
    if (r.size + buf.length > caps.card) {
      let cut = Math.max(0, caps.card - r.size);
      while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
      buf = buf.subarray(0, cut);
      if (!simple) simple = isSimple(buf);
      r.capped = true;
      onCapped(id, caps.card);
    }
    if (buf.length) {
      feed(r.ix, buf, simple);
      r.wbuf.push(buf);
      r.wlen += buf.length;
      r.size += buf.length;
      total += buf.length;
      if (r.wlen >= WRITE_BUF) flushWrite(r); else flushSoon();
    }
    if (total > caps.total && Date.now() - lastEvict > 1000) evict();
  }

  // Oldest finished cards go first. Running cards are never evicted.
  let lastEvict = 0;
  function evict() {
    lastEvict = Date.now();
    const list = [...recs.values()].filter((r) => !r.running && r.size > 0).sort((a, b) => a.order - b.order);
    for (const r of list) {
      if (total <= caps.total * 0.95) break;
      remove(r.id, { keepRec: true });
      fs.writeFileSync(goneFile(r.id), '');
      onEvicted(r.id);
    }
  }

  function end(id) {
    const r = recs.get(id);
    if (!r || !r.running) return info0(r);
    if (r.cr) { const cr = r.cr; r.cr = ''; append(id, cr); }
    r.running = false;
    endIndex(r.ix);
    closeFd(r);
    try { writeIdx(idxFile(id), r.ix, r.capped); } catch (err) { console.warn(`index ${id}: ${err.message}`); }
    trimMemory();
    return info0(r);
  }

  // A whole output at once: migration from old sessions, and the screen text
  // of a card whose program moved the cursor.
  function put(id, text) {
    begin(id);
    append(id, text);
    return end(id);
  }

  // Finished indexes are reloaded from disk when needed again.
  function trimMemory() {
    let used = 0;
    const loaded = [...recs.values()].filter((r) => r.ix && !r.running).sort((a, b) => b.used - a.used);
    for (const r of loaded) {
      used += indexBytes(r.ix);
      if (used > IDX_MEM) { r.ix = null; r.loading = null; }
    }
  }

  // The index of a card, loading or rebuilding it if needed.
  function load(id) {
    const r = recs.get(id);
    if (!r) return Promise.resolve(null);
    r.used = Date.now();
    if (r.ix) return Promise.resolve(r);
    if (r.loading) return r.loading;
    r.loading = (async () => {
      let size = 0;
      try { size = fs.statSync(logFile(id)).size; } catch { return null; }
      try { const ix = readIdx(idxFile(id), size); if (ix) { r.ix = ix; r.size = size; r.capped = ix.capped; return r; } } catch { /* rebuild */ }
      const ix = newIndex();
      const fh = await fs.promises.open(logFile(id), 'r');
      try {
        let pos = 0;
        while (pos < size) {
          const buf = Buffer.allocUnsafe(Math.min(REBUILD_CHUNK, size - pos));
          const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
          if (!bytesRead) break;
          const b = buf.subarray(0, bytesRead);
          feed(ix, b, isSimple(b));
          pos += bytesRead;
        }
      } finally { await fh.close(); }
      endIndex(ix);
      r.ix = ix;
      r.size = ix.bytes;
      try { writeIdx(idxFile(id), ix); } catch { /* read-only is fine */ }
      trimMemory();
      return r;
    })();
    return r.loading;
  }

  function info0(r) {
    if (!r) return null;
    const ix = r.ix;
    return {
      lines: ix ? lineCount(ix) : 0, bytes: r.size, capped: r.capped, running: r.running,
      moved: ix ? ix.moved : false, alt: ix ? ix.alt : false, hasEsc: ix ? ix.hasEsc : false,
    };
  }

  async function info(id) {
    if (fs.existsSync(goneFile(id))) return { lines: 0, bytes: 0, evicted: true };
    const r = await load(id);
    if (!r) return { lines: 0, bytes: 0, missing: true };
    return info0(r);
  }

  // Reads `count` lines from `from`. Returns raw lines (with SGR) or visible
  // text, which lines are soft-split, and the SGR state where `from` starts.
  function readLines(r, from, count, { plain = false } = {}) {
    flushWrite(r);
    const ix = r.ix;
    const total0 = lineCount(ix);
    const out = { from, lines: [], soft: [], sgr: '' };
    if (from >= total0 || count <= 0) return out;
    count = Math.min(count, total0 - from);
    const block = Math.min(Math.floor(from / BLOCK), ix.offsets.n - 1);
    let pos = ix.offsets.a[block];
    let lineNo = block * BLOCK;
    const st = sgrParse(ix.checkpoints.get(block) || '');
    const sp = { curLen: 0, parts: [], curSimple: true };
    let fd = r.fd;
    const own = fd == null;
    if (own) fd = fs.openSync(logFile(r.id), 'r');
    const take = (bytes, soft) => {
      if (lineNo < from) {
        if (bytes.includes(27)) sgrLine(st, bytes.toString('latin1'));
      } else {
        if (!out.lines.length) out.sgr = sgrString(st);
        const s = bytes.toString('utf8');
        out.lines.push(plain ? Wrap.visible(s) : s);
        if (soft) out.soft.push(out.lines.length - 1);
      }
      lineNo++;
      return out.lines.length >= count;
    };
    try {
      const buf = Buffer.allocUnsafe(READ_CHUNK);
      let done = false;
      while (!done) {
        const n = fs.readSync(fd, buf, 0, READ_CHUNK, pos);
        if (!n) break;
        const b = buf.subarray(0, n);
        const used = split(sp, b, (s, e, _next, soft) => (done = take(lineBytes(sp, b, s, e), soft)));
        pos += used;
        if (used < n && !done) break;
      }
      if (!done && sp.curLen > 0 && lineNo < total0) take(Buffer.concat(sp.parts), false);
    } finally { if (own) fs.closeSync(fd); }
    return out;
  }

  async function range(id, { from = 0, count = 200, plain = false } = {}) {
    const r = await load(id);
    if (!r || !r.ix) return { from, lines: [], soft: [], sgr: '' };
    return readLines(r, Math.max(0, from), Math.min(count, 20000), { plain });
  }

  // Lines covering `count` rows from `row`, at `cols` columns.
  async function view(id, { cols, row = 0, count = 100 }) {
    const r = await load(id);
    if (!r || !r.ix) return null;
    const ix = r.ix;
    cols = Math.max(Wrap.LONG, cols | 0);
    const rc = rowsAt(ix, cols);
    const totalLines = lineCount(ix);
    row = Math.max(0, Math.min(row, rc.total - 1));
    const { line, off } = lineOfRow(ix, cols, row);
    let rows = 0;
    let n = 0;
    while (line + n < totalLines && rows - off < count) {
      rows += rowsOfLine(ix, cols, line + n);
      n++;
    }
    const res = readLines(r, line, n);
    return { ...res, totalRows: rc.total, totalLines, row0: row - off, line0: line };
  }

  async function locate(id, { cols, line }) {
    const r = await load(id);
    if (!r || !r.ix) return 0;
    return rowOfLine(r.ix, Math.max(Wrap.LONG, cols | 0), line);
  }

  function readBytes(r, start, len) {
    flushWrite(r);
    const fd = r.fd != null ? r.fd : fs.openSync(logFile(r.id), 'r');
    try {
      const buf = Buffer.allocUnsafe(len);
      const n = fs.readSync(fd, buf, 0, len, start);
      return buf.subarray(0, n);
    } finally { if (r.fd == null) fs.closeSync(fd); }
  }

  // The first `bytes` of output, cut at a line end when there is one.
  async function head(id, { bytes = 4 * 1024 * 1024, lines = 0 } = {}) {
    const r = recs.get(id);
    if (!r || !r.size) return { text: '', more: false };
    if (lines) {
      const res = await range(id, { from: 0, count: lines, plain: true });
      return { text: res.lines.join('\n'), more: (r.ix ? lineCount(r.ix) : Infinity) > lines };
    }
    let buf = readBytes(r, 0, Math.min(bytes, r.size));
    const more = r.size > buf.length;
    if (more) { const nl = buf.lastIndexOf(10); if (nl > 0) buf = buf.subarray(0, nl + 1); }
    return { text: new StringDecoder('utf8').write(buf), more };
  }

  // The last `bytes`, starting at a line.
  function tailBuf(r, bytes) {
    const start = Math.max(0, r.size - bytes);
    let buf = readBytes(r, start, r.size - start);
    if (start > 0) { const nl = buf.indexOf(10); if (nl >= 0) buf = buf.subarray(nl + 1); }
    return buf;
  }

  // For a terminal model opened on a running card: the alternate screen from
  // where it was entered, or else the last lines, with a terminal's \r\n.
  function replay(id, { full = false } = {}) {
    const r = recs.get(id);
    if (!r || !r.size) return '';
    const ix = r.ix;
    let text;
    if (full && r.size <= REPLAY_ALT * 2) text = readBytes(r, 0, r.size).toString('utf8');
    else if (ix && ix.alt && ix.altStart >= 0 && r.size - ix.altStart <= REPLAY_ALT) text = readBytes(r, ix.altStart, r.size - ix.altStart).toString('utf8');
    else if (ix && ix.alt) text = `\x1b[?1049h${tailBuf(r, REPLAY_ALT).toString('utf8')}`;
    else text = tailBuf(r, REPLAY_TAIL).toString('utf8');
    return text.replace(/\n/g, '\r\n');
  }

  // Head and tail as plain text, for Claude.
  async function clip(id, { head: h = 4000, tail: t = 8000 } = {}) {
    const r = await load(id);
    if (!r || !r.size) return { text: '', omitted: 0 };
    const plain = (buf) => buf.toString('utf8').split('\n').map(Wrap.visible).join('\n');
    if (r.size <= (h + t) * 2) {
      const all = plain(readBytes(r, 0, r.size));
      if (all.length <= h + t + 2000) return { text: all, omitted: 0 };
      return { text: `${all.slice(0, h)}\n…[${(all.length - h - t).toLocaleString()} characters omitted]…\n${all.slice(-t)}`, omitted: all.length - h - t };
    }
    const a = plain(readBytes(r, 0, h * 2)).slice(0, h);
    const b = plain(tailBuf(r, t * 2)).slice(-t);
    const omitted = r.size - Buffer.byteLength(a) - Buffer.byteLength(b);
    return { text: `${a}\n…[${omitted.toLocaleString()} bytes omitted]…\n${b}`, omitted };
  }

  // Visible text into a file, streamed: pipes between cards, Save output…,
  // Open in editor, Copy.
  async function exportPlain(id, dest, { max = Infinity } = {}) {
    const r = await load(id);
    const out = await fs.promises.open(dest, 'w', 0o600);
    let written = 0;
    let truncated = false;
    try {
      if (!r || !r.size) return { bytes: 0, truncated: false };
      flushWrite(r);
      const fh = await fs.promises.open(logFile(id), 'r');
      try {
        const sp = { curLen: 0, parts: [], curSimple: true };
        const buf = Buffer.allocUnsafe(REBUILD_CHUNK);
        let pos = 0;
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
          if (!bytesRead) break;
          const b = buf.subarray(0, bytesRead);
          const pieces = [];
          // Plain ASCII passes through as it is, line splits and all.
          if (isSimple(b) && !sp.parts.length) pieces.push(Buffer.from(b));
          else {
            split(sp, b, (s, e, _n, soft) => {
              const bytes = lineBytes(sp, b, s, e);
              const t = bytes.includes(27) || bytes.includes(13) || bytes.includes(8) ? Buffer.from(Wrap.visible(bytes.toString('utf8'))) : Buffer.from(bytes);
              pieces.push(t);
              if (!soft) pieces.push(Buffer.from('\n'));
              return false;
            });
          }
          let chunk = Buffer.concat(pieces);
          if (written + chunk.length > max) { chunk = chunk.subarray(0, max - written); truncated = true; }
          await out.write(chunk);
          written += chunk.length;
          pos += bytesRead;
          if (truncated) break;
        }
        if (!truncated && sp.curLen > 0) {
          const t = Buffer.from(Wrap.visible(Buffer.concat(sp.parts).toString('utf8')));
          await out.write(t);
          written += t.length;
        }
      } finally { await fh.close(); }
    } finally { await out.close(); }
    return { bytes: written, truncated };
  }

  function remove(id, { keepRec = false } = {}) {
    const r = recs.get(id);
    if (r) { closeFd(r); total -= r.size; r.size = 0; r.ix = null; r.loading = null; r.running = false; }
    if (!keepRec) recs.delete(id);
    for (const f of [logFile(id), idxFile(id), richFile(id), ...(keepRec ? [] : [goneFile(id)])]) fs.rmSync(f, { force: true });
  }

  // Files no card points at any more.
  function prune(keep) {
    for (const name of fs.readdirSync(dir)) {
      const m = /^(\d+)\./.exec(name);
      if (m && !keep.has(Number(m[1]))) {
        const id = Number(m[1]);
        if (recs.has(id)) remove(id); else fs.rmSync(path.join(dir, name), { force: true });
      }
    }
  }

  // Full-file search in a worker thread. A new search of a card cancels the
  // one in flight, which resolves to null.
  const searches = new Map();
  function search(id, { query, caseSensitive = false, limit = 50000 } = {}) {
    const r = recs.get(id);
    if (!r || !r.size || !query) return Promise.resolve({ count: 0, lines: [], truncated: false });
    flushWrite(r);
    const prev = searches.get(id);
    if (prev) prev.terminate();
    return new Promise((resolve) => {
      const w = new Worker(path.join(__dirname, 'search-worker.js'), { workerData: { file: logFile(id), query, caseSensitive, limit } });
      searches.set(id, w);
      w.once('message', resolve);
      w.once('error', (err) => resolve({ count: 0, lines: [], truncated: false, error: err.message }));
      w.once('exit', () => { if (searches.get(id) === w) searches.delete(id); resolve(null); });
    });
  }

  function putRich(id, value) {
    try { fs.writeFileSync(richFile(id), JSON.stringify(value), { mode: 0o600 }); } catch { /* optional */ }
  }
  function getRich(id) {
    try { return JSON.parse(fs.readFileSync(richFile(id), 'utf8')); } catch { return null; }
  }

  return {
    begin, append, end, put, info, range, view, locate, head, replay, clip, exportPlain, remove, prune, search,
    putRich, getRich, load,
    file: logFile,
    state: (id) => { const r = recs.get(id); return r && r.ix ? { moved: r.ix.moved, alt: r.ix.alt } : { moved: false, alt: false }; },
    setCaps: (c) => { caps = { card: c.card || caps.card, total: c.total || caps.total }; if (total > caps.total) evict(); },
    capped: (id) => { const r = recs.get(id); return !!(r && r.capped); },
    caps: () => ({ ...caps }),
    totalBytes: () => total,
    flushAll: () => { for (const r of recs.values()) flushWrite(r); },
    shutdown: () => { for (const r of recs.values()) closeFd(r); },
  };
}

module.exports = { createOutputs, split, isSimple, newIndex, feed, endIndex, lineCount, rowsAt, rowOfLine, lineOfRow, LINE_MAX, BLOCK };
