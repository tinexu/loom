'use strict';
// Loom — Tab completion for the command bar, run in the main process with the
// active card's directory and environment. Specific providers come first:
// paths, commands, git refs and changed files, package.json scripts, Makefile
// targets, ssh hosts, docker containers, PIDs and variables. Flags and
// subcommands for everything else come from Fig's autocomplete specs.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const ShellLex = require('../renderer/shell-lex');
const Fuzzy = require('../renderer/fuzzy');

const FIG_DIR = path.join(__dirname, '..', 'node_modules', '@withfig', 'autocomplete', 'build');
const GEN_TIMEOUT = 2000;
const MAX_ITEMS = 200;
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

// ---------------------------------------------------------------- quoting
const SPECIAL = /[\s'"\\$`!&;|<>()*?[\]{}]/g;
function quoteName(name, quote, close) {
  if (quote === '"') return name.replace(/["\\$`]/g, '\\$&') + (close ? '"' : '');
  if (quote === "'") return name.replace(/'/g, "'\\''") + (close ? "'" : '');
  return name.replace(SPECIAL, '\\$&').replace(/^[#~]/, '\\$&');
}

function expand(p, home, env) {
  return p.replace(/^~(?=\/|$)/, home)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => (env && env[a || b]) || '');
}

// ---------------------------------------------------------------- matching
// Prefix matches first, then a case-insensitive prefix. Fuzzy matches only
// count when nothing matches the prefix, so `cd sr` doesn't offer scripts/.
function filterItems(items, typed) {
  const out = [];
  const lower = typed.toLowerCase();
  for (const it of items) {
    const label = it.match || it.label;
    let score;
    let hl;
    if (!typed) { score = 0; hl = []; }
    else if (label.startsWith(typed)) { score = 1000; hl = [...Array(typed.length).keys()]; }
    else if (label.toLowerCase().startsWith(lower)) { score = 900; hl = [...Array(typed.length).keys()]; }
    else {
      const m = Fuzzy.match(typed, label);
      if (!m) continue;
      score = m.score;
      hl = m.hl;
    }
    out.push({ ...it, score: score + (it.priority || 0), hl: it.match && it.match !== it.label ? [] : hl });
  }
  out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return out.length && out[0].score >= 900 ? out.filter((x) => x.score >= 900) : out;
}

// ---------------------------------------------------------------- processes
function run(cmd, args, { cwd, env, signal, timeout = GEN_TIMEOUT }) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { cwd, env, timeout, maxBuffer: 8 << 20, ...(signal ? { signal } : {}) },
        (err, out) => resolve(err && !out ? null : String(out)));
    } catch { resolve(null); }
  });
}

// ---------------------------------------------------------------- providers
async function listPaths(cwd, partial, { dirsOnly = false, home = os.homedir(), env = null } = {}) {
  if (partial === '~') return [{ label: '~/', value: '~/', kind: 'dir', dir: true, raw: true }];
  const slash = partial.lastIndexOf('/');
  const dirPart = slash >= 0 ? partial.slice(0, slash + 1) : '';
  const base = partial.slice(slash + 1);
  const abs = path.resolve(cwd, expand(dirPart || '.', home, env));
  let ents;
  try { ents = await fs.promises.readdir(abs, { withFileTypes: true }); } catch { return []; }
  const hidden = base.startsWith('.');
  const items = await Promise.all(ents.slice(0, 5000).map(async (d) => {
    if (!hidden && d.name.startsWith('.')) return null;
    let dir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try { dir = (await fs.promises.stat(path.join(abs, d.name))).isDirectory(); } catch { /* broken link */ }
    }
    if (dirsOnly && !dir) return null;
    return { label: dir ? `${d.name}/` : d.name, match: d.name, value: dir ? `${d.name}/` : d.name, kind: dir ? 'dir' : 'file', dir };
  }));
  return items.filter(Boolean);
}

function findUp(dir, name) {
  for (let d = dir; ; d = path.dirname(d)) {
    const f = path.join(d, name);
    if (fs.existsSync(f)) return f;
    if (path.dirname(d) === d) return null;
  }
}

function npmScripts(cwd) {
  const f = findUp(cwd, 'package.json');
  if (!f) return [];
  try {
    const scripts = JSON.parse(fs.readFileSync(f, 'utf8')).scripts || {};
    return Object.entries(scripts).map(([name, body]) => ({ label: name, desc: String(body), kind: 'script' }));
  } catch { return []; }
}

function makeTargets(cwd) {
  const f = ['GNUmakefile', 'makefile', 'Makefile'].map((n) => path.join(cwd, n)).find((p) => fs.existsSync(p));
  if (!f) return [];
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch { return []; }
  const seen = new Set();
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^([^\s:#=][^:#=]*?)\s*::?(?!=)/.exec(line);
    if (!m) continue;
    for (const t of m[1].split(/\s+/)) {
      if (!t || t.startsWith('.') || /[%$]/.test(t) || seen.has(t)) continue;
      seen.add(t);
      out.push({ label: t, desc: 'target', kind: 'target' });
    }
  }
  return out;
}

function sshHosts(home) {
  const hosts = new Map();
  const read = (f) => { try { return fs.readFileSync(path.join(home, '.ssh', f), 'utf8'); } catch { return ''; } };
  for (const line of read('config').split('\n')) {
    const m = /^\s*Host\s+(.+)$/i.exec(line);
    if (m) for (const h of m[1].split(/\s+/)) if (h && !/[*?!]/.test(h)) hosts.set(h, 'ssh config');
  }
  for (const line of read('known_hosts').split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('|') || line.startsWith('@')) continue;
    for (let h of line.split(/\s/)[0].split(',')) {
      h = h.replace(/^\[([^\]]+)\]:\d+$/, '$1');
      if (h && !hosts.has(h)) hosts.set(h, 'known host');
    }
  }
  return [...hosts].map(([label, desc]) => ({ label, desc, kind: 'host' }));
}

async function dockerContainers(cwd, env, signal) {
  const out = await run('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}'], { cwd, env, signal });
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((l) => {
    const [label, desc] = l.split('\t');
    return { label, desc, kind: 'container' };
  });
}

async function processes(cwd, env, signal) {
  const args = ['-o', 'pid=', '-o', 'comm='];
  if (process.getuid) args.unshift('-u', String(process.getuid()));
  const out = await run('ps', args, { cwd, env, signal });
  if (!out) return [];
  return out.split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .filter((m) => Number(m[1]) !== process.pid)
    .map((m) => ({ label: m[1], desc: path.basename(m[2]), match: `${m[1]} ${path.basename(m[2])}`, kind: 'process' }));
}

const DOCKER_CONTAINER_CMDS = new Set(['exec', 'logs', 'stop', 'start', 'restart', 'rm', 'kill', 'attach', 'inspect', 'top', 'stats', 'pause', 'unpause', 'port', 'commit', 'rename', 'wait', 'diff', 'export', 'cp', 'update']);

async function gitItems(ctx, cwd, env, signal) {
  const [sub, ...rest] = ctx.args;
  if (ctx.argIndex === 1 || ctx.word.startsWith('-')) return null; // subcommands and flags come from Fig
  const positional = rest.filter((a) => !a.startsWith('-'));
  const git = (...a) => run('git', a, { cwd, env, signal });
  const refs = async (kinds) => {
    const out = await git('for-each-ref', '--format=%(HEAD)%09%(refname)', ...kinds.map((k) => `refs/${k}`));
    if (!out) return [];
    const items = [];
    for (const line of out.split('\n')) {
      const [head, ref] = line.split('\t');
      if (!ref || ref.endsWith('/HEAD')) continue;
      const m = /^refs\/(heads|tags|remotes)\/(.+)$/.exec(ref);
      if (!m) continue;
      const kind = { heads: 'branch', tags: 'tag', remotes: 'remote' }[m[1]];
      items.push({ label: m[2], desc: head === '*' ? 'current branch' : { branch: 'branch', tag: 'tag', remote: 'remote branch' }[kind], kind, priority: kind === 'branch' ? 2 : 0 });
    }
    return items;
  };
  const remotes = async () => {
    const out = await git('remote', '-v');
    const seen = new Map();
    for (const l of (out || '').split('\n')) { const [name, url] = l.split(/\s+/); if (name && !seen.has(name)) seen.set(name, url); }
    return [...seen].map(([label, desc]) => ({ label, desc, kind: 'remote' }));
  };
  const changed = async (which) => {
    const [top, out] = await Promise.all([git('rev-parse', '--show-toplevel'), git('status', '--porcelain=v1', '-z', '--untracked-files=all')]);
    if (!top || out == null) return [];
    const root = top.trim();
    const parts = out.split('\0');
    const items = [];
    const staged = rest.includes('--staged') || rest.includes('--cached');
    for (let k = 0; k < parts.length; k++) {
      const e = parts[k];
      if (e.length < 4) continue;
      const x = e[0];
      const y = e[1];
      if (x === 'R' || x === 'C') k++; // the old name follows
      const untracked = x === '?';
      const ok = which === 'add' ? untracked || y !== ' '
        : which === 'restore' ? !untracked && (staged ? x !== ' ' : true)
          : !untracked && (staged ? x !== ' ' : y !== ' ');
      if (!ok) continue;
      const rel = path.relative(cwd, path.join(root, e.slice(3))) || '.';
      const what = untracked ? 'untracked' : ({ M: 'modified', A: 'added', D: 'deleted', R: 'renamed', U: 'conflict' })[y !== ' ' ? y : x] || 'changed';
      items.push({ label: rel, desc: what, kind: 'file' });
    }
    return items;
  };
  switch (sub) {
    case 'checkout': case 'switch': case 'merge': case 'rebase': case 'cherry-pick':
      return refs(['heads', 'tags', 'remotes']);
    case 'branch':
      return rest.some((a) => /^(-[a-zA-Z]*[dD][a-zA-Z]*|--delete)$/.test(a)) ? refs(['heads']) : null;
    case 'push':
      return positional.length === 0 ? remotes() : refs(['heads']);
    case 'add': case 'restore': case 'diff':
      return changed(sub);
    default:
      return null;
  }
}

// ---------------------------------------------------------------- Fig specs
const specs = new Map();
function loadSpec(name) {
  if (typeof name !== 'string' || !/^[@\w][\w.+@/-]*$/.test(name) || name.includes('..')) return Promise.resolve(null);
  if (specs.has(name)) return specs.get(name);
  const file = path.join(FIG_DIR, `${name}.js`);
  const p = fs.promises.access(file)
    .then(() => import(pathToFileURL(file).href))
    .then((m) => (m.default && typeof m.default === 'object' ? m.default : null))
    .catch(() => null);
  specs.set(name, p);
  return p;
}

const names = (o) => arr(o && o.name).filter((x) => typeof x === 'string');

async function resolveSub(sub) {
  if (typeof sub.loadSpec !== 'string') return sub;
  const loaded = await loadSpec(sub.loadSpec);
  return loaded ? { ...loaded, name: sub.name } : sub;
}

const genCache = new Map();
// A generator either runs a script and parses its output, or is `custom`:
// arbitrary async JS that drives its own shell commands. Those are skipped.
async function runGenerator(g, tokens, { cwd, env, signal }) {
  if (!g || typeof g !== 'object' || g.custom) return { items: [] };
  if (g.template) return { items: [], template: arr(g.template) };
  let script = g.script;
  if (typeof script === 'function') { try { script = script(tokens); } catch { return { items: [] }; } }
  let cmd;
  let args;
  if (Array.isArray(script) && script.length) [cmd, ...args] = script;
  else if (typeof script === 'string' && script) { cmd = '/bin/sh'; args = ['-c', script]; }
  else if (script && typeof script === 'object' && script.command) { cmd = script.command; args = script.args || []; }
  else return { items: [] };
  const key = JSON.stringify([cwd, cmd, args]);
  const hit = genCache.get(key);
  let out;
  if (hit && Date.now() - hit.at < 5000) out = hit.out;
  else {
    out = await run(cmd, args.map(String), { cwd, env, signal, timeout: GEN_TIMEOUT });
    if (out != null) genCache.set(key, { at: Date.now(), out });
    if (genCache.size > 200) genCache.delete(genCache.keys().next().value);
  }
  if (out == null) return { items: [] };
  let list;
  try {
    if (typeof g.postProcess === 'function') list = await g.postProcess(out, tokens);
    else list = out.split(typeof g.splitOn === 'string' ? g.splitOn : '\n').filter((s) => s.trim()).map((name) => ({ name: name.trim() }));
  } catch { return { items: [] }; }
  return { items: suggestionItems(arr(list), 'value') };
}

function suggestionItems(list, kind) {
  const out = [];
  for (const s of list) {
    if (typeof s === 'string') { out.push({ label: s, kind }); continue; }
    if (!s || s.hidden) continue;
    for (const nm of names(s)) {
      const value = typeof s.insertValue === 'string' ? s.insertValue.replace(/\{cursor\}/g, '').replace(/\n$/, '') : nm;
      out.push({ label: nm, value, desc: s.description || '', kind: s.type === 'folder' ? 'dir' : s.type === 'file' ? 'file' : kind, priority: typeof s.priority === 'number' ? (s.priority - 50) / 50 : 0 });
    }
  }
  return out;
}

async function argItems(a, tokens, opts) {
  if (!a) return { items: [], paths: null };
  const items = suggestionItems(arr(a.suggestions), 'value');
  let templates = arr(a.template);
  const gens = await Promise.all(arr(a.generators).map((g) => runGenerator(g, tokens, opts)));
  for (const g of gens) { items.push(...g.items); if (g.template) templates = templates.concat(g.template); }
  let paths = templates.includes('filepaths') ? 'all' : templates.includes('folders') ? 'dirs' : null;
  // An argument the spec says nothing about is most often a file.
  if (!paths && !items.length && !arr(a.generators).length && !arr(a.suggestions).length) paths = 'all';
  return { items, paths };
}

async function figItems(spec, ctx, opts) {
  let node = spec;
  const persistent = [];
  const used = new Set();
  let argPos = 0;
  let pending = null;
  let endOpts = false;
  const all = () => [...arr(node.options), ...persistent];
  const findOpt = (a) => {
    const key = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    return all().find((o) => names(o).includes(key));
  };
  for (const a of ctx.args) {
    if (pending) { if (--pending.left <= 0) pending = null; continue; }
    if (!endOpts && a === '--') { endOpts = true; continue; }
    if (!endOpts && a.startsWith('-') && a.length > 1) {
      const o = findOpt(a);
      if (o) {
        used.add(o);
        const need = arr(o.args).filter((x) => !x.isOptional).length;
        if (need && !a.includes('=')) pending = { opt: o, left: need };
      }
      continue;
    }
    const sub = argPos === 0 && arr(node.subcommands).find((s) => names(s).includes(a));
    if (sub) {
      persistent.push(...arr(node.options).filter((o) => o.isPersistent));
      node = await resolveSub(sub);
      continue;
    }
    argPos++;
  }
  const tokens = [ctx.command, ...ctx.args, ctx.word];
  if (pending) return argItems(arr(pending.opt.args)[0], tokens, opts);
  const items = [];
  if (ctx.word.startsWith('-') && !endOpts) {
    // Some specs (tar) model modes like -x as subcommands with dashed names.
    const dashedSubs = argPos === 0 ? arr(node.subcommands).filter((sc) => names(sc).some((nm) => nm.startsWith('-'))) : [];
    for (const o of [...all(), ...dashedSubs]) {
      if (o.hidden || (used.has(o) && !o.isRepeatable)) continue;
      const dash = names(o).filter((nm) => nm.startsWith('-'));
      if (!dash.length) continue;
      const pick = (ctx.word.startsWith('--') && dash.find((nm) => nm.startsWith(ctx.word)))
        || dash.find((nm) => nm.startsWith(ctx.word)) || dash[0];
      const eq = o.requiresEquals || o.requiresSeparator;
      items.push({
        label: pick, alt: dash.filter((nm) => nm !== pick).join(' '), value: eq ? `${pick}=` : pick, noSpace: !!eq,
        desc: o.description || '', kind: 'flag', priority: typeof o.priority === 'number' ? (o.priority - 50) / 50 : 0,
      });
    }
    return { items, paths: null };
  }
  if (argPos === 0) {
    for (const s of arr(node.subcommands)) {
      if (s.hidden) continue;
      for (const nm of names(s)) items.push({ label: nm, desc: s.description || '', kind: 'sub', priority: 0.5 });
    }
  }
  const list = arr(node.args);
  const a = argPos < list.length ? list[argPos] : list.length && list[list.length - 1].isVariadic ? list[list.length - 1] : null;
  if (a) {
    const r = await argItems(a, tokens, opts);
    return { items: items.concat(r.items), paths: r.paths };
  }
  return { items, paths: !items.length && !arr(node.subcommands).length ? 'all' : null };
}

// ---------------------------------------------------------------- entry point
// Returns { start, end, items } where each item replaces text[item.start, end).
async function complete({ text, caret, cwd, commands = {}, env = {}, home = os.homedir(), signal = null }) {
  const ctx = ShellLex.contextAt(text, caret);
  const opts = { cwd, env: { ...env, NO_COLOR: '1', GIT_PAGER: 'cat', PAGER: 'cat', TERM: 'dumb' }, signal };
  const groups = []; // [items, mode]
  const word = ctx.word;
  const cmd = ctx.command ? path.basename(ctx.command) : null;
  const paths = async (o) => groups.push([await listPaths(cwd, word, { home, env, ...o }), 'path']);

  if (ctx.variable) {
    const items = Object.keys(env).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      .map((k) => ({ label: `$${k}`, match: k, value: ctx.variable.brace ? `\${${k}}` : `$${k}`, kind: 'var', noSpace: true, desc: 'variable' }));
    groups.push([items, 'var']);
  } else if (ctx.inCommand) {
    if (/[/~]/.test(word) || word.startsWith('.')) await paths();
    else {
      const kinds = { alias: 'alias', function: 'function', builtin: 'builtin', command: '' };
      groups.push([Object.entries(commands).map(([label, k]) => ({ label, desc: kinds[k] || '', kind: k === 'command' ? 'cmd' : k })), 'word']);
    }
  } else if (ctx.redirect) {
    await paths();
  } else if (cmd) {
    let handled = false;
    const flag = word.startsWith('-');
    const sub = ctx.args[0];
    if ((cmd === 'cd' || cmd === 'pushd') && !flag) { await paths({ dirsOnly: true }); handled = true; }
    if (cmd === 'git') {
      const items = await gitItems(ctx, cwd, opts.env, signal);
      if (items) { groups.push([items, 'word']); handled = true; }
    }
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(cmd) && !flag) {
      if ((sub === 'run' || sub === 'run-script') && ctx.argIndex === 2) { groups.push([npmScripts(cwd), 'word']); handled = true; }
      else if (cmd !== 'npm' && ctx.argIndex === 1) groups.push([npmScripts(cwd), 'word']);
    }
    if ((cmd === 'make' || cmd === 'gmake') && !flag) { groups.push([makeTargets(cwd), 'word']); handled = true; }
    if (cmd === 'ssh' && !flag) { groups.push([sshHosts(home), 'word']); handled = true; }
    if ((cmd === 'scp' || cmd === 'rsync') && !flag && !word.includes(':')) {
      groups.push([sshHosts(home).map((h) => ({ ...h, label: `${h.label}:`, noSpace: true })), 'word']);
      await paths();
      handled = true;
    }
    if (cmd === 'docker' && !flag && ctx.argIndex >= 2 && DOCKER_CONTAINER_CMDS.has(sub)) {
      groups.push([await dockerContainers(cwd, opts.env, signal), 'word']);
      handled = true;
    }
    if (cmd === 'kill' && !flag) { groups.push([await processes(cwd, opts.env, signal), 'word']); handled = true; }
    if (!handled) {
      const spec = await loadSpec(cmd);
      if (spec) {
        const r = await figItems(spec, ctx, opts);
        groups.push([r.items, 'word']);
        if (r.paths) await paths({ dirsOnly: r.paths === 'dirs' });
      } else if (!flag) await paths();
    }
  }
  if (signal && signal.aborted) return null;

  const typedFor = (mode) => (mode === 'path' ? word.slice(word.lastIndexOf('/') + 1) : mode === 'var' ? ctx.variable.name : word);
  const slash = ctx.raw.lastIndexOf('/');
  const pathStart = ctx.wordStart + slash + 1;
  const rawBase = ctx.raw.slice(slash + 1);
  const q = ctx.quote;
  const items = [];
  const seen = new Set();
  for (const [list, mode] of groups) {
    for (const it of filterItems(list, typedFor(mode))) {
      const value = it.value || it.label;
      let start;
      let insert;
      if (mode === 'var') { start = ctx.variable.start; insert = value; }
      else if (mode === 'path') {
        start = pathStart;
        insert = it.raw ? value : (q && rawBase.includes(q) ? q : '') + quoteName(value, q, !it.dir) + (it.dir ? '' : ' ');
      } else {
        start = ctx.wordStart;
        insert = (q || '') + quoteName(value, q, !it.noSpace) + (it.noSpace ? '' : ' ');
      }
      const k = `${start}\0${insert}`;
      if (seen.has(k)) continue;
      seen.add(k);
      items.push({ label: it.label, alt: it.alt || '', desc: it.desc || '', kind: it.kind, hl: it.hl, start, insert, reopen: !!it.dir, score: it.score });
    }
  }
  items.sort((a, b) => b.score - a.score);
  return { start: Math.min(...items.map((i) => i.start), caret), end: ctx.wordEnd, items: items.slice(0, MAX_ITEMS) };
}

module.exports = { complete, listPaths, filterItems, quoteName, loadSpec, figItems, npmScripts, makeTargets, sshHosts, FIG_DIR };
