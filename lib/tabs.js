'use strict';
// Loom — tabs on disk. Each tab is a canvas saved in
// userData/canvases/<id>.json (card metadata; output is in outputs/). A small
// userData/tabs.json has, for each window (the main one and the dropdown),
// its tab order, active tab and recently closed tabs, and for each tab its
// title, color and folder. Card output files and shell snapshots are keyed
// "<canvas>.<card>".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CLOSED_MAX = 10;
const KINDS = ['main', 'dropdown'];
const newId = () => `c${crypto.randomBytes(4).toString('hex')}`;
const ID_RE = /^c[0-9a-f]{8}$/;

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeAtomic(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}

const emptyState = () => ({ v: 1, windows: Object.fromEntries(KINDS.map((k) => [k, { order: [], active: null, closed: [] }])), tabs: {} });

// The session.json from before tabs becomes the first tab. Its cards' output
// files (outputs/<card>.*) are renamed to the new canvas's keys, and output
// kept inline by even older sessions (`segs`) is written out with
// putOutput(key, text) -> { lines }. The old file is kept as session.pre-tabs.json.
function migrateLegacy({ dir, putOutput = () => ({ lines: 0 }), putRich = () => {}, id = newId() }) {
  const file = path.join(dir, 'session.json');
  const saved = readJSON(file, null);
  if (!saved || !Array.isArray(saved.nodes)) return null;
  const outDir = path.join(dir, 'outputs');
  let names = [];
  try { names = fs.readdirSync(outDir); } catch { /* no outputs yet */ }
  for (const name of names) {
    const m = /^(\d+)\.(.+)$/.exec(name);
    if (m) fs.renameSync(path.join(outDir, name), path.join(outDir, `${id}.${m[1]}.${m[2]}`));
  }
  for (const n of saved.nodes) {
    if (Array.isArray(n.segs)) {
      const text = n.segs.map((x) => x[1]).join('');
      if (text) {
        const out = putOutput(`${id}.${n.id}`, text) || { lines: 0 };
        if (n.h == null) n.h = 62 + Math.min(out.lines * 19 + 22, n.bodyH || 300);
      }
      delete n.segs;
    }
    if (n.rich) {
      if (['files', 'gitlog', 'gitstatus'].includes(n.rich.kind)) putRich(`${id}.${n.id}`, n.rich);
      n.richKind = n.rich.kind;
      delete n.rich;
    }
  }
  const meta = { ...saved };
  delete meta.nodes;
  delete meta.history;
  writeAtomic(path.join(dir, 'canvases', `${id}.json`), JSON.stringify({ ...meta, v: 3, nodes: saved.nodes }));
  const state = emptyState();
  state.windows.main.order = [id];
  state.windows.main.active = id;
  state.tabs[id] = { title: path.basename(saved.rootCwd || '') || 'Home', color: null, folder: null, window: 'main' };
  writeAtomic(path.join(dir, 'tabs.json'), JSON.stringify(state, null, 1));
  if (saved.v === 1) fs.copyFileSync(file, path.join(dir, 'session.v1.json'));
  fs.renameSync(file, path.join(dir, 'session.pre-tabs.json'));
  return { state, id, history: Array.isArray(saved.history) ? saved.history : null };
}

// onDrop(cid) when a closed tab falls off the end of its window's closed list,
// so its files can go.
function createTabStore({ dir, onDrop = () => {}, persist = true }) {
  const file = path.join(dir, 'tabs.json');
  const canvasFile = (cid) => path.join(dir, 'canvases', `${cid}.json`);
  let state = readJSON(file, null);
  if (!state || state.v !== 1 || !state.windows || !state.tabs) state = emptyState();
  for (const k of KINDS) if (!state.windows[k]) state.windows[k] = { order: [], active: null, closed: [] };
  let timer = null;

  function save() {
    clearTimeout(timer);
    timer = null;
    if (persist) writeAtomic(file, JSON.stringify(state, null, 1));
  }
  const saveSoon = () => { if (!timer) timer = setTimeout(save, 300); };

  const win = (kind) => state.windows[KINDS.includes(kind) ? kind : 'main'];
  const tabOf = (cid) => (state.tabs[cid] ? { id: cid, ...state.tabs[cid] } : null);

  return {
    // What a window shows.
    get(kind) {
      const w = win(kind);
      w.order = w.order.filter((cid) => state.tabs[cid]);
      return { order: w.order.slice(), active: w.order.includes(w.active) ? w.active : w.order[0] || null, tabs: w.order.map(tabOf), closed: w.closed.length };
    },
    create(kind, meta = {}) {
      const cid = newId();
      state.tabs[cid] = { title: meta.title || 'Home', color: meta.color || null, folder: meta.folder || null, window: kind };
      const w = win(kind);
      const at = meta.after && w.order.includes(meta.after) ? w.order.indexOf(meta.after) + 1 : w.order.length;
      w.order.splice(at, 0, cid);
      w.active = cid;
      saveSoon();
      return tabOf(cid);
    },
    // Order, active tab, and each tab's title, color and folder.
    set(kind, { order, active, tabs }) {
      const w = win(kind);
      if (Array.isArray(order)) w.order = order.filter((cid) => state.tabs[cid]);
      if (active !== undefined) w.active = active;
      for (const t of tabs || []) {
        if (!state.tabs[t.id]) continue;
        for (const k of ['title', 'color', 'folder']) if (t[k] !== undefined) state.tabs[t.id][k] = t[k];
      }
      saveSoon();
    },
    // A closed tab keeps its files until ten more have been closed after it.
    close(kind, cid) {
      const w = win(kind);
      w.order = w.order.filter((x) => x !== cid);
      if (w.active === cid) w.active = w.order[0] || null;
      w.closed = [cid, ...w.closed.filter((x) => x !== cid)];
      for (const gone of w.closed.splice(CLOSED_MAX)) { delete state.tabs[gone]; onDrop(gone); }
      saveSoon();
    },
    reopen(kind) {
      const w = win(kind);
      const cid = w.closed.shift();
      if (!cid || !state.tabs[cid]) { saveSoon(); return null; }
      w.order.push(cid);
      w.active = cid;
      saveSoon();
      return tabOf(cid);
    },
    loadCanvas: (cid) => (ID_RE.test(cid) ? readJSON(canvasFile(cid), null) : null),
    saveCanvas(cid, text) { if (persist && ID_RE.test(cid)) writeAtomic(canvasFile(cid), text); },
    removeCanvas(cid) { if (ID_RE.test(cid)) fs.rmSync(canvasFile(cid), { force: true }); },
    // Every canvas still kept: open or recently closed, in any window.
    allIds: () => Object.keys(state.tabs),
    tab: tabOf,
    kindOf: (cid) => (state.tabs[cid] ? state.tabs[cid].window || 'main' : null),
    replace(next) { state = next; save(); },
    flush: save,
  };
}

module.exports = { createTabStore, migrateLegacy, newId, ID_RE, CLOSED_MAX };
