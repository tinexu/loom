'use strict';
// Loom — what the command bar knows about a branch's shell: the executables
// on its PATH, its aliases, functions and builtins, and its exported variables.
// Executables are cached per PATH and rescanned every 60 s. Variables come from
// the card's env snapshot, so a venv's PATH counts on the cards that use it.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { infoScript, parseInfo } = require('./sessions');

const PATH_TTL = 60000;

function createShellInfo({ shell, env: baseEnv, sessions }) {
  const kind = path.basename(shell);
  const execs = new Map(); // PATH -> { at, names, pending }
  const snaps = new Map(); // snapshot file -> { mtime, env }
  let base = null; // the rc files' aliases etc., for cards without a live shell

  async function scanPath(PATH) {
    const names = new Map();
    const dirs = [...new Set(String(PATH || '').split(path.delimiter).filter((d) => d && path.isAbsolute(d)))];
    const win = process.platform === 'win32';
    const lists = await Promise.all(dirs.map(async (dir) => {
      try {
        const ents = await fs.promises.readdir(dir, { withFileTypes: true });
        const found = await Promise.all(ents.map(async (d) => {
          if (d.isDirectory()) return null;
          try {
            if (win) return /\.(exe|cmd|bat|com|ps1)$/i.test(d.name) ? d.name.replace(/\.[^.]+$/, '') : null;
            const st = await fs.promises.stat(path.join(dir, d.name));
            return st.isFile() && (st.mode & 0o111) ? d.name : null;
          } catch { return null; }
        }));
        return [dir, found.filter(Boolean)];
      } catch { return [dir, []]; }
    }));
    for (const [dir, list] of lists) for (const name of list) if (!names.has(name)) names.set(name, dir);
    return names;
  }

  function executables(PATH) {
    const hit = execs.get(PATH);
    if (hit && Date.now() - hit.at < PATH_TTL) return hit.pending || Promise.resolve(hit);
    const entry = { at: Date.now(), names: hit ? hit.names : new Map(), pending: null };
    entry.pending = scanPath(PATH).then((names) => {
      entry.names = names;
      entry.pending = null;
      return entry;
    });
    execs.set(PATH, entry);
    if (execs.size > 16) execs.delete(execs.keys().next().value);
    // A stale list answers at once while the rescan runs.
    return hit ? Promise.resolve(entry) : entry.pending;
  }

  function parseEnv0(out) {
    const env = {};
    for (const kv of String(out || '').split('\0')) {
      const eq = kv.indexOf('=');
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    return env;
  }

  // Source the snapshot in a bare shell with an empty environment and print
  // what it exports. Snapshots are only ever files Loom wrote.
  function snapshotEnv(file) {
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return Promise.resolve(null); }
    const hit = snaps.get(file);
    if (hit && hit.mtime === mtime) return hit.env;
    const args = kind === 'zsh' ? ['-f', '-c', '. "$1" 2>/dev/null; /usr/bin/env -0', 'loom', file]
      : ['--norc', '--noprofile', '-c', '. "$1" 2>/dev/null; /usr/bin/env -0', 'loom', file];
    const p = new Promise((resolve) => {
      execFile(shell, args, { env: {}, timeout: 3000, maxBuffer: 4 << 20 }, (_err, out) => resolve(out ? parseEnv0(out) : null));
    });
    snaps.set(file, { mtime, env: p });
    if (snaps.size > 64) snaps.delete(snaps.keys().next().value);
    return p;
  }

  // An interactive shell outside any PTY, once, for the rc files' definitions.
  function probeBase() {
    if (base) return base;
    if (process.platform === 'win32') {
      base = Promise.resolve({ info: parseInfo(''), env: baseEnv() });
      return base;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-info-'));
    const out = path.join(tmp, 'info');
    const envOut = path.join(tmp, 'env');
    const script = `${infoScript(kind, out)}\n/usr/bin/env -0 >| '${envOut}' 2>/dev/null\n`;
    base = new Promise((resolve) => {
      execFile(shell, ['-i', '-c', script], { env: baseEnv(), timeout: 8000, cwd: os.homedir() }, () => {
        const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
        const info = parseInfo(read(out));
        const env = parseEnv0(read(envOut));
        fs.rm(tmp, { recursive: true, force: true }, () => {});
        resolve({ info, env: Object.keys(env).length ? env : baseEnv() });
      });
    });
    return base;
  }

  // Everything the command bar needs for one card. `key` changes whenever
  // the command list could have, so the renderer can skip a resend.
  async function forCard({ cardId = null, envFile = null } = {}) {
    const b = await probeBase();
    const [live, snapEnv] = await Promise.all([
      cardId != null && sessions ? sessions.info(cardId) : null,
      envFile ? snapshotEnv(envFile) : null,
    ]);
    const info = live || b.info;
    const env = snapEnv || b.env;
    const ex = await executables(env.PATH || '');
    const commands = {};
    for (const name of ex.names.keys()) commands[name] = 'command';
    for (const name of info.builtins) commands[name] = 'builtin';
    for (const name of info.functions) commands[name] = 'function';
    for (const name of info.aliases) commands[name] = 'alias';
    const key = crypto.createHash('sha1')
      .update(`${env.PATH}\0${ex.names.size}\0${ex.at}\0${info.aliases.join(',')}\0${info.functions.join(',')}\0${info.builtins.length}`)
      .digest('hex').slice(0, 16);
    return { key, commands, env };
  }

  return { forCard, executables, snapshotEnv, probeBase };
}

module.exports = { createShellInfo };
