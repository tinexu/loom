'use strict';
// Loom — rich-view detection and parsing, off the page's thread. The page
// hands this worker a MessagePort to main.js, so the output it parses comes
// from main and never passes through the page. Parsed JSON documents and
// tables stay here; the page asks for the part it shows (a JSON node's
// children, a range of sorted table rows).
/* global importScripts */
importScripts('ansi.js');
const { strip } = self.Ansi;

const HEAD_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 500000;
const JSON_CHILDREN = 500;

// ---------------------------------------------------------------- main.js over the port
let main = null;
const mainWaiting = new Map();
const mainQueue = [];
let mainRid = 0;
function callMain(op, arg) {
  return new Promise((resolve, reject) => {
    const rid = ++mainRid;
    mainWaiting.set(rid, { resolve, reject });
    if (main) main.postMessage({ rid, op, arg }); else mainQueue.push({ rid, op, arg });
  });
}
function setMain(port) {
  main = port;
  main.onmessage = (e) => {
    const { rid, ok, value, error } = e.data;
    const w = mainWaiting.get(rid);
    if (!w) return;
    mainWaiting.delete(rid);
    if (ok) w.resolve(value); else w.reject(new Error(error));
  };
  for (const m of mainQueue.splice(0)) main.postMessage(m);
}

// ---------------------------------------------------------------- parsing
// Splits a command into words. `simple` is false when it contains shell
// control characters outside quotes (pipes, redirects, substitutions…).
function tokenize(cmd) {
  const tokens = [];
  let cur = '';
  let has = false;
  let q = null;
  let simple = true;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (has) { tokens.push(cur); cur = ''; has = false; } continue; }
    if ('|;&<>`$(){}*?'.includes(c)) simple = false;
    cur += c; has = true;
  }
  if (has) tokens.push(cur);
  return { tokens, simple: simple && !q };
}

function parseDelimited(text, d, max = MAX_ROWS) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === d) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
      if (rows.length > max) break;
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function detectDelimited(text, cmd) {
  const hint = /\.(csv|tsv)\b/i.test(cmd);
  for (const d of ['\t', ',']) {
    if (!text.includes(d)) continue;
    // Decide on a sample, then parse the whole thing.
    const sample = parseDelimited(text.slice(0, 64 * 1024), d, 60);
    if (sample.length < 2) continue;
    const w = sample[0].length;
    if (w < 2 || !sample.slice(0, -1).every((r) => r.length === w)) continue;
    if (d === ',' && !hint && (w < 3 || sample.length < 3)) continue;
    const rows = parseDelimited(text, d);
    return { headers: rows[0], rows: rows.slice(1) };
  }
  return null;
}

// Whitespace-aligned tables (ps, df, docker ps, kubectl get…): find
// character columns that are blank on every line and split there.
const COLUMN_CMDS = new Set(['ps', 'df', 'docker', 'podman', 'kubectl', 'lsof', 'netstat', 'free', 'launchctl', 'who', 'w', 'jobs', 'ss', 'brew', 'pip', 'pip3', 'helm', 'gcloud', 'aws']);
function detectColumns(text, cmd) {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2 || lines.length > MAX_ROWS) return null;
  const head = lines[0];
  const first = cmd.trim().split(/\s+/)[0];
  const letters = head.replace(/[^A-Za-z]/g, '');
  const caps = letters && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7;
  if (!COLUMN_CMDS.has(first) && !caps) return null;
  if (!/^[\sA-Z%#]/.test(head) || /[.!?]$/.test(head.trim())) return null;
  const sample = lines.slice(0, 200);
  const gap = [];
  for (let i = 0; i < head.length; i++) gap[i] = sample.every((l) => i >= l.length || l[i] === ' ');
  const starts = [];
  for (let i = 0; i < head.length; i++) if (!gap[i] && (i === 0 || gap[i - 1])) starts.push(i);
  if (starts.length < 3) return null;
  const cut = (l) => starts.map((s, j) => l.slice(s, j + 1 < starts.length ? starts[j + 1] : undefined).trim());
  const headers = cut(head);
  if (headers.some((h) => !h)) return null;
  return { headers, rows: lines.slice(1).map(cut) };
}

function parseGitLog(out) {
  const commits = out.split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [hash, parents, author, date, subject, refs] = r.split('\x1f');
    return { hash, author, date, subject, parents: parents ? parents.split(' ') : [], refs: refs ? refs.split(', ').filter(Boolean) : [] };
  });
  return { commits: commits.slice(0, 400) };
}

function parseGitStatus(out) {
  let branch = '';
  const files = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    if (line.startsWith('## ')) { branch = line.slice(3); continue; }
    let p = line.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ').pop();
    files.push({ x: line[0], y: line[1], path: p.replace(/^"|"$/g, '') });
  }
  return { branch, files };
}

// ---------------------------------------------------------------- documents
const docs = new Map();
let docSeq = 0;

function summary(v) {
  if (v === null) return { t: 'z' };
  if (Array.isArray(v)) return { t: 'a', n: v.length };
  if (typeof v === 'object') return { t: 'o', n: Object.keys(v).length };
  if (typeof v === 'string') return { t: 's', v: v.length > 2000 ? `${v.slice(0, 2000)}…` : v };
  return { t: typeof v === 'number' ? 'n' : 'b', v };
}

const NUM_RE = /^-?[\d,.]+(?:\s*([KMGTP])i?B?)?%?$/i;
function num(s) {
  const m = String(s).trim().match(NUM_RE);
  if (!m) return null;
  const n = parseFloat(String(s).replace(/,/g, ''));
  const mult = { K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 }[(m[1] || '').toUpperCase()] || 1;
  return Number.isFinite(n) ? n * mult : null;
}

function tableDoc(t, more) {
  const doc = ++docSeq;
  docs.set(doc, { kind: 'table', headers: t.headers, rows: t.rows, sorts: new Map() });
  const sample = t.rows.slice(0, 200);
  const widths = t.headers.map((h, i) => Math.min(40, Math.max(String(h).length + 2, 4, ...sample.map((r) => String(r[i] ?? '').length))));
  const numeric = t.headers.map((_, i) => sample.length > 0 && sample.every((r) => r[i] == null || r[i] === '' || num(r[i]) != null));
  return { doc, headers: t.headers, total: t.rows.length, widths, numeric, more };
}

function sortedOrder(d, col, dir) {
  if (col < 0) return null;
  const key = `${col}:${dir}`;
  if (d.sorts.has(key)) return d.sorts.get(key);
  const idx = Array.from({ length: d.rows.length }, (_, i) => i);
  const vals = d.rows.map((r) => r[col] ?? '');
  const nums = vals.map(num);
  idx.sort((a, b) => {
    const nx = nums[a]; const ny = nums[b];
    if (nx != null && ny != null) return (nx - ny) * dir;
    return String(vals[a]).localeCompare(String(vals[b]), undefined, { numeric: true }) * dir;
  });
  d.sorts.clear();
  d.sorts.set(key, idx);
  return idx;
}

// ---------------------------------------------------------------- detection
const NO_RICH_LOG = /^(-p|--patch|--stat|--shortstat|--numstat|--name-only|--name-status|-L.*|--follow|--graph)$/;
const DROP_LOG = /^(--oneline|--decorate.*|--color.*|--no-color|--pretty=.*|--format=.*|--abbrev-commit|--no-decorate|--date=.*)$/;

// Views from the file system or git, which are worth keeping with the card.
async function detectLive({ cmd, cwd, cwdAfter }) {
  cmd = cmd.trim();
  let lsCmd = cmd;
  let base = cwd;
  const cd = cmd.match(/^cd\s+(.+?)\s*&&\s*(ls(?:\s.*)?)$/);
  if (cd) { lsCmd = cd[2]; base = cwdAfter || cwd; }
  const lt = tokenize(lsCmd);
  if (lt.simple && lt.tokens[0] === 'ls') {
    const args = lt.tokens.slice(1);
    const flags = args.filter((a) => a.startsWith('-')).join('');
    const targets = args.filter((a) => !a.startsWith('-'));
    if (targets.length <= 1 && !/R|d/.test(flags)) {
      const res = await callMain('listDir', { cwd: base, target: targets[0] || '.', hidden: /a|A/.test(flags) });
      if (res) return { kind: 'files', data: res };
    }
  }
  const t = tokenize(cmd);
  if (t.simple && t.tokens[0] === 'git') {
    const sub = t.tokens[1];
    const rest = t.tokens.slice(2);
    if (sub === 'log' && !rest.some((a) => NO_RICH_LOG.test(a)) && !rest.includes('--')) {
      const out = await callMain('gitLog', { cwd, args: rest.filter((a) => !DROP_LOG.test(a)) });
      if (out != null) { const res = parseGitLog(out); if (res.commits.length) return { kind: 'gitlog', data: res }; }
    }
    if (sub === 'status' && rest.every((a) => /^-(s|b|sb|-short|-branch)$/.test(a))) {
      const out = await callMain('gitStatus', { cwd });
      if (out != null) return { kind: 'gitstatus', data: parseGitStatus(out) };
    }
  }
  return null;
}

// Views parsed from the output itself.
async function detectText({ id, cmd }) {
  const { text: raw, more } = await callMain('head', { id, bytes: HEAD_BYTES });
  const text = strip(raw).trim();
  if (!text) return null;
  if (/^[[{]/.test(text) && !more) {
    try {
      const value = JSON.parse(text);
      const doc = ++docSeq;
      docs.set(doc, { kind: 'json', value });
      return { kind: 'json', data: { doc, root: summary(value) } };
    } catch { /* maybe NDJSON */ }
  }
  if (/^[[{]/.test(text)) {
    const lines = text.split('\n').filter((l) => l.trim());
    if (lines.length >= 2) {
      try {
        const value = lines.map((l) => JSON.parse(l));
        const doc = ++docSeq;
        docs.set(doc, { kind: 'json', value });
        return { kind: 'json', data: { doc, root: summary(value), more } };
      } catch { /* not JSON */ }
    }
  }
  const delim = detectDelimited(text, cmd);
  if (delim) return { kind: 'table', data: tableDoc(delim, more) };
  const cols = detectColumns(text, cmd);
  if (cols) return { kind: 'table', data: tableDoc(cols, more) };
  return null;
}

const ops = {
  async detect(arg) {
    const live = await detectLive(arg);
    if (live) { callMain('richPut', { id: arg.id, value: live }).catch(() => {}); return live; }
    return detectText(arg);
  },
  // A card from an earlier launch: its saved view, or the output parsed again.
  async restore(arg) {
    if (['files', 'gitlog', 'gitstatus'].includes(arg.kind)) {
      const saved = await callMain('richGet', { id: arg.id });
      if (saved && saved.kind === arg.kind) return saved;
    }
    return ops.detect(arg);
  },
  children({ doc, path }) {
    const d = docs.get(doc);
    if (!d || d.kind !== 'json') return null;
    let v = d.value;
    for (const k of path) v = v == null ? v : v[k];
    if (!v || typeof v !== 'object') return { entries: [], more: 0 };
    const keys = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
    return { entries: keys.slice(0, JSON_CHILDREN).map((k) => ({ k, ...summary(v[k]) })), more: Math.max(0, keys.length - JSON_CHILDREN) };
  },
  rows({ doc, sort = -1, dir = 1, from = 0, count = 100 }) {
    const d = docs.get(doc);
    if (!d || d.kind !== 'table') return null;
    const order = sortedOrder(d, sort, dir);
    const out = [];
    for (let i = from; i < Math.min(d.rows.length, from + count); i++) out.push(d.rows[order ? order[i] : i]);
    return { from, rows: out, total: d.rows.length };
  },
  release({ doc }) { docs.delete(doc); return true; },
};

self.onmessage = async (e) => {
  const m = e.data;
  if (m && m.port) { setMain(m.port); return; }
  const { rid, op, arg } = m;
  try {
    if (!ops[op]) throw new Error(`no op ${op}`);
    self.postMessage({ rid, ok: true, value: await ops[op](arg || {}) });
  } catch (err) { self.postMessage({ rid, ok: false, error: err.message }); }
};
