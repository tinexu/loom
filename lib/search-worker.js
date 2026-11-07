'use strict';
// Loom — searches one card's output file, off the main process's thread.
// Lines are split exactly as lib/outputs.js indexes them, so the line numbers
// it reports are the ones the card body scrolls to. A match is per line, in
// the visible text (escapes stripped, carriage-return overwrites applied).
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const { split } = require('./outputs');
const Wrap = require('../renderer/wrap');

const CHUNK = 4 * 1024 * 1024;

function run({ file, query, caseSensitive, limit }) {
  const fold = !caseSensitive && query.toLowerCase() !== query.toUpperCase();
  const q = fold ? query.toLowerCase() : query;
  // The query as it appears in raw bytes read as latin1, for the fast path.
  let qRaw = Buffer.from(query, 'utf8').toString('latin1');
  if (fold) qRaw = qRaw.toLowerCase();
  const lines = [];
  let count = 0;
  let lineNo = 0;
  const fd = fs.openSync(file, 'r');
  const sp = { curLen: 0, parts: [], curSimple: true };
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = 0;
    let carry = Buffer.alloc(0);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (!n) break;
      pos += n;
      // Whole lines only: the unfinished one waits for the next chunk.
      const b = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const starts = [];
      const ends = [];
      sp.curLen = 0; sp.parts = [];
      const used = split(sp, b, (s, e) => { starts.push(s); ends.push(e); return false; });
      const whole = sp.curLen ? b.length - sp.curLen : used;
      carry = Buffer.from(b.subarray(whole));
      const special = b.indexOf(27) >= 0 || b.indexOf(13) >= 0 || b.indexOf(8) >= 0;
      if (!special) {
        let text = b.toString('latin1', 0, whole);
        if (fold) text = text.toLowerCase();
        let li = 0;
        let at = text.indexOf(qRaw);
        while (at >= 0) {
          while (li < ends.length && ends[li] < at + qRaw.length) li++;
          if (li >= ends.length) break;
          if (starts[li] <= at) {
            count++;
            if (lines.length < limit) lines.push(lineNo + li);
            at = text.indexOf(qRaw, ends[li]);
            li++;
          } else at = text.indexOf(qRaw, starts[li]);
        }
      } else {
        for (let i = 0; i < starts.length; i++) {
          let t = b.toString('utf8', starts[i], ends[i]);
          if (t.includes('\x1b') || t.includes('\r') || t.includes('\b')) t = Wrap.visible(t);
          if (fold) t = t.toLowerCase();
          if (t.includes(q)) { count++; if (lines.length < limit) lines.push(lineNo + i); }
        }
      }
      lineNo += starts.length;
    }
    if (carry.length) {
      let t = Wrap.visible(carry.toString('utf8'));
      if (fold) t = t.toLowerCase();
      if (t.includes(q)) { count++; if (lines.length < limit) lines.push(lineNo); }
    }
  } finally { fs.closeSync(fd); }
  return { count, lines, truncated: count > lines.length };
}

parentPort.postMessage(run(workerData));
