'use strict';
// Writes a session.json with many cards for `npm run bench`, in the old format
// that kept output inline (`segs`), so starting Loom over it also exercises the
// migration to output files.
// Usage: node scripts/gen-fixture.js <userDataDir> <cwd> [cards=1000] [--light]
// --light gives every card one line of output, for sessions too big to fill.
// The layout has branches, pipes and tall cards, and is the same every run.
const fs = require('fs');
const path = require('path');

const CARD_W = 620;
const GAP_X = 72;
const GAP_Y = 64;
const LINE_H = 19;

// Small deterministic PRNG, so runs compare.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS = [
  ['ls -la', (r) => Array.from({ length: 20 + Math.floor(r() * 30) }, (_, i) => `-rw-r--r--   1 me  staff   ${String(Math.floor(r() * 99999)).padStart(6)} Nov  6 10:${String(i % 60).padStart(2, '0')} \x1b[34mfile-${i}.txt\x1b[0m`)],
  ['git log --oneline', (r) => Array.from({ length: 40 + Math.floor(r() * 80) }, (_, i) => `\x1b[33m${Math.floor(r() * 0xfffffff).toString(16).padStart(7, '0')}\x1b[0m commit message number ${i} that says what changed`)],
  ['npm test', (r) => Array.from({ length: 60 + Math.floor(r() * 140) }, (_, i) => (i % 7 ? `  \x1b[32m✓\x1b[0m test case ${i} (${Math.floor(r() * 90)}ms)` : `\x1b[1m suite ${i / 7}\x1b[0m`))],
  ['cat server.log', (r) => Array.from({ length: 100 + Math.floor(r() * 300) }, (_, i) => `2026-11-06T10:${String(i % 60).padStart(2, '0')}:00Z INFO request id=${Math.floor(r() * 1e9)} path=/api/v1/items/${i} status=200 duration=${Math.floor(r() * 400)}ms user-agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"`)],
  ['echo done', () => ['done']],
  ['pwd', () => ['/Users/me/project']],
];

function main() {
  const [dir, cwd, countArg] = process.argv.slice(2);
  if (!dir || !cwd) { console.error('usage: gen-fixture.js <userDataDir> <cwd> [cards]'); process.exit(2); }
  const count = Number(countArg) || 1000;
  const light = process.argv.includes('--light');
  const r = rng(42);
  const nodes = [];
  const kids = new Map();
  const now = Date.now();
  let id = 0;

  const make = (parent) => {
    id++;
    const tall = r() < 0.05;
    let cmd; let lines;
    if (light) { cmd = KINDS[Math.floor(r() * KINDS.length)][0]; lines = [`${cmd} done`]; }
    else if (tall) { const n = 2000 + Math.floor(r() * 3000); cmd = `seq 1 ${n}`; lines = Array.from({ length: n }, (_, i) => String(i + 1)); }
    else { const [c, gen] = KINDS[Math.floor(r() * KINDS.length)]; cmd = c; lines = gen(r); }
    const failed = r() < 0.08;
    const n = {
      id, cmd, cwd, cwdAfter: cwd, parentId: parent ? parent.id : null,
      pipeFrom: parent && r() < 0.06 ? parent.id : null,
      x: 0, y: 0, w: CARD_W, bodyH: tall ? 1200 : 300,
      status: failed ? 'error' : 'ok', exitCode: failed ? 1 : 0,
      startedAt: now - (count - id) * 60000, endedAt: now - (count - id) * 60000 + Math.floor(r() * 4000),
      view: 'rich', ai: null, collapsed: false, envFile: null, noHistory: false,
      segs: [[0, lines.join('\n')]], rich: null,
    };
    n.h = 62 + Math.min(lines.length * LINE_H + 22, n.bodyH);
    nodes.push(n);
    if (parent) { if (!kids.has(parent.id)) kids.set(parent.id, []); kids.get(parent.id).push(n); }
    return n;
  };

  // Roots with chains that fork now and then.
  const roots = [];
  while (id < count) {
    const root = make(null);
    roots.push(root);
    const frontier = [root];
    const size = 15 + Math.floor(r() * 25);
    for (let i = 1; i < size && id < count; i++) {
      const from = r() < 0.75 ? frontier[frontier.length - 1] : frontier[Math.floor(r() * frontier.length)];
      frontier.push(make(from));
    }
  }

  // Lay out like Loom does: children below, later siblings to the right.
  let rootX = 0;
  const place = (n, x, y) => {
    n.x = x; n.y = y;
    let right = x + n.w;
    let cx = x;
    for (const c of kids.get(n.id) || []) {
      const r2 = place(c, cx, y + n.h + GAP_Y);
      right = Math.max(right, r2);
      cx = r2 + GAP_X;
    }
    return right;
  };
  for (const root of roots) rootX = place(root, rootX, 0) + 160;

  const session = { v: 1, nextId: id + 1, view: { x: 120, y: 90, k: 1 }, activeId: roots[0].id, rootCwd: cwd, sidebar: false, nodes };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(session));
  const bytes = fs.statSync(path.join(dir, 'session.json')).size;
  console.log(`wrote ${nodes.length} cards (${roots.length} roots, ${nodes.filter((n) => n.pipeFrom).length} pipes, ${nodes.filter((n) => n.bodyH > 300).length} tall) to ${dir}/session.json, ${(bytes / 1048576).toFixed(1)} MB`);
}

main();
