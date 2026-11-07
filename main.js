'use strict';
// Loom — main process.
// Routes commands to long-lived shell sessions (lib/sessions.js), or to one
// child process per card where those aren't available, and brokers file-system,
// git and Claude calls for the renderer. The renderer never touches Node directly.
// Every card's output is recorded here (lib/outputs.js); the renderer asks for
// the lines it shows, and only watched running cards stream to it (lib/relay.js).

const { app, BrowserWindow, ipcMain, safeStorage, shell, nativeTheme, clipboard, dialog, MessageChannelMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { createSessions } = require('./lib/sessions');
const { createShellInfo } = require('./lib/shellinfo');
const { createHistory, parseZshHistory, parseBashHistory } = require('./lib/history');
const { createOutputs } = require('./lib/outputs');
const { createRelay } = require('./lib/relay');
const completer = require('./lib/complete');

const isWin = process.platform === 'win32';
const SMOKE = process.env.LOOM_SMOKE || '';
const BENCH = SMOKE ? process.env.LOOM_BENCH || '' : '';
const PROC_START = Date.now() - process.uptime() * 1000;
const GB = 1024 ** 3;
const COPY_MAX = 32 * 1024 * 1024;
const DEFAULT_MODEL = 'claude-sonnet-5-5';

if (SMOKE) {
  // A fixed LOOM_SMOKE_USERDATA lets the e2e run restart Loom over its own session.
  app.setPath('userData', process.env.LOOM_SMOKE_USERDATA || path.join(os.tmpdir(), `loom-smoke-${process.pid}`));
  // The bench measures frame rates, so it keeps the GPU.
  if (!BENCH) app.disableHardwareAcceleration();
}

let win = null;
let loginPath = process.env.PATH || '';
let sessions = null;
let shellInfo = null;
let history = null;
let outputs = null;
let relay = null;
const procs = new Map();

// ---------------------------------------------------------------- storage
const file = (name) => path.join(app.getPath('userData'), name);

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJSON(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, p);
}
const settings = () => readJSON(file('settings.json'), {});

function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const s = settings();
  if (!s.apiKey) return null;
  try {
    return s.keyEncrypted ? safeStorage.decryptString(Buffer.from(s.apiKey, 'base64')) : s.apiKey;
  } catch { return null; }
}

// ---------------------------------------------------------------- shell
function pickShell() {
  if (isWin) return 'powershell.exe';
  const s = settings().shell || process.env.SHELL || '/bin/bash';
  // The cwd-tracking wrapper uses POSIX syntax; fish/nu etc. fall back to bash.
  return ['bash', 'zsh', 'sh', 'dash', 'ksh'].includes(path.basename(s)) ? s : '/bin/bash';
}

// Apps launched from the Dock/Finder get a minimal PATH. Ask the user's
// shell for the real one once at startup.
function resolveLoginPath() {
  if (isWin) return Promise.resolve();
  const probe = (flags) => new Promise((resolve) => {
    execFile(pickShell(), [flags, 'printf "__LOOM__%s__LOOM__" "$PATH"'],
      { timeout: 6000, env: process.env }, (_err, out) => {
        const m = /__LOOM__(.*?)__LOOM__/s.exec(out || '');
        resolve(m && m[1].includes('/') ? m[1] : null);
      });
  });
  return probe('-ilc').then((p) => p || probe('-lc')).then((p) => {
    if (p) {
      const merged = new Set([...p.split(':'), ...(process.env.PATH || '').split(':')].filter(Boolean));
      loginPath = [...merged].join(':');
    }
  });
}

const envDir = () => file('envs');

function cmdEnv({ plain = false } = {}) {
  const env = {
    ...process.env,
    PATH: loginPath,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    CLICOLOR: '1',
    COLUMNS: '120',
    LINES: '40',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  // Commands run on pipes, not a TTY, so tools default to plain output.
  // Forcing color looks nicer but leaks escape codes into in-command pipes.
  if (!plain && settings().forceColor) {
    Object.assign(env, {
      FORCE_COLOR: '1', CLICOLOR_FORCE: '1',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'color.ui', GIT_CONFIG_VALUE_0: 'always',
    });
  }
  return env;
}

const send = (channel, msg) => {
  if (!win || win.isDestroyed()) return false;
  win.webContents.send(channel, msg);
  return true;
};

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Windows and shells without integration hooks run one child process per card.
function startSessions() {
  if (isWin || !['bash', 'zsh'].includes(path.basename(pickShell()))) return;
  let pty;
  try { pty = require('node-pty'); } catch (err) {
    console.warn(`node-pty unavailable, using one process per card: ${err.message}`);
    return;
  }
  sessions = createSessions({
    pty,
    shell: pickShell(),
    envDir: envDir(),
    env: () => {
      const env = { ...cmdEnv({ plain: true }), TERM_PROGRAM: 'Loom' };
      delete env.COLUMNS; // the PTY's size is the source of truth
      delete env.LINES;
      if (settings().realPager) {
        delete env.PAGER;
        delete env.GIT_PAGER;
        env.__LOOM_REAL_PAGER = '1';
      }
      return env;
    },
    onOutput: cardOutput,
    onExit: cardExit,
    fallback: runSpawned,
  });
}

// ---------------------------------------------------------------- output
const capsFromSettings = () => {
  const s = settings();
  return { card: (Number(s.outputCapGB) || 1) * GB, total: (Number(s.outputTotalGB) || 5) * GB };
};

function startOutputs() {
  outputs = createOutputs({
    dir: file('outputs'),
    ...(() => { const c = capsFromSettings(); return { capCard: c.card, capTotal: c.total }; })(),
    onCapped: (id, cap) => send('out:capped', { id, cap }),
    onEvicted: (id) => send('out:evicted', { id }),
  });
  relay = createRelay({
    send: (id, data) => send('cmd:data', { id, data }),
    pause: (id, on) => {
      if (sessions && sessions.owns(id)) { sessions.pause(id, on); return; }
      const p = procs.get(id);
      if (!p) return;
      for (const st of [p.child.stdout, p.child.stderr]) { if (on) st.pause(); else st.resume(); }
    },
    plain: (id) => !outputs.state(id).moved,
  });
}

// Every byte is recorded; the renderer gets it only if it's watching the card.
function cardOutput(id, text) {
  outputs.append(id, text);
  relay.data(id, text);
}

// What's left for the renderer goes first, then the exit with the output's shape.
function cardExit(msg) {
  relay.end(msg.id);
  const out = outputs.end(msg.id);
  send('cmd:exit', { ...msg, out });
}

const tmpFile = (name) => path.join(os.tmpdir(), `loom-${process.pid}-${name}`);

ipcMain.handle('cmd:run', async (_e, req) => {
  outputs.begin(req.id);
  relay.start(req.id, { watch: req.watch !== false });
  // A card-to-card pipe: the source's visible text, streamed to a file.
  if (req.stdinFrom != null) {
    const dest = tmpFile(`stdin-${req.id}-${Date.now()}`);
    await outputs.exportPlain(req.stdinFrom, dest);
    req.stdinPath = dest;
  }
  return sessions ? sessions.run(req) : runSpawned(req);
});

function runSpawned({ id, command, cwd, stdin, stdinPath }) {
  const dir = cwd && isDir(cwd) ? cwd : os.homedir();
  const env = cmdEnv();
  let child;
  let cwdOut = '';

  if (isWin) {
    // PowerShell can't report its final location through an extra fd, so
    // handle a bare `cd` here and run everything else as-is.
    const m = command.trim().match(/^cd(?:\s+(.+))?$/i);
    if (m) {
      const target = path.resolve(dir, expandHome((m[1] || '~').replace(/^["']|["']$/g, '')));
      setImmediate(() => {
        if (isDir(target)) cardExit({ id, code: 0, signal: null, cwd: target });
        else {
          cardOutput(id, `cd: no such directory: ${target}\r\n`);
          cardExit({ id, code: 1, signal: null, cwd: dir });
        }
      });
      return { pid: null };
    }
    child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { cwd: dir, env, windowsHide: true });
  } else {
    // fd 3 carries the shell's final $PWD back, so `cd` persists to the next card.
    const script = `${command}\n__loom_ec=$?\nprintf '%s' "$PWD" >&3 2>/dev/null\nexit $__loom_ec\n`;
    child = spawn(pickShell(), ['-c', script], {
      cwd: dir, env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    child.stdio[3].on('data', (d) => { cwdOut += d.toString(); });
    child.stdio[3].on('error', () => {});
  }

  const p = { child };
  procs.set(id, p);

  const push = () => {
    const decoder = new StringDecoder('utf8');
    return (data) => {
      // The renderer's terminal model expects a TTY's line endings.
      const text = decoder.write(data).replace(/\r?\n/g, '\r\n');
      if (text) cardOutput(id, text);
    };
  };

  child.stdout.on('data', push());
  child.stderr.on('data', push());
  child.stdin.on('error', () => {});
  if (stdinPath) {
    const rs = fs.createReadStream(stdinPath);
    rs.on('error', () => child.stdin.end());
    rs.on('close', () => fs.rm(stdinPath, { force: true }, () => {}));
    rs.pipe(child.stdin);
  } else if (typeof stdin === 'string') child.stdin.end(stdin);

  let done = false;
  const finish = (code, signal) => {
    if (done) return;
    done = true;
    procs.delete(id);
    const finalCwd = cwdOut && isDir(cwdOut) ? cwdOut : dir;
    cardExit({ id, code, signal, cwd: finalCwd });
  };
  child.on('error', (err) => {
    cardOutput(id, `loom: ${err.message}\r\n`);
    finish(127, null);
  });
  child.on('close', (code, signal) => finish(code, signal));
  // A background job can hold the pipes open forever; don't wait on it.
  child.on('exit', (code, signal) => setTimeout(() => finish(code, signal), 500));
  return { pid: child.pid };
}

ipcMain.handle('cmd:kill', (_e, id) => {
  if (sessions && sessions.owns(id)) return sessions.kill(id);
  const p = procs.get(id);
  if (!p) return false;
  const pid = p.child.pid;
  if (isWin) {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
    return true;
  }
  const sig = (s) => { try { process.kill(-pid, s); } catch { /* already gone */ } };
  sig('SIGINT');
  setTimeout(() => procs.has(id) && sig('SIGTERM'), 1000);
  setTimeout(() => procs.has(id) && sig('SIGKILL'), 2500);
  return true;
});

ipcMain.handle('cmd:stdin', (_e, { id, data, eof }) => {
  if (sessions && sessions.owns(id)) return sessions.stdin(id, data, eof);
  const p = procs.get(id);
  if (!p || !p.child.stdin.writable) return false;
  if (data) p.child.stdin.write(data);
  if (eof) p.child.stdin.end();
  return true;
});

ipcMain.handle('cmd:resize', (_e, { id, cols, rows }) => { if (sessions) sessions.resize(id, cols, rows); });
ipcMain.on('cmd:ack', (_e, { id, bytes }) => relay.ack(id, bytes));
ipcMain.handle('cmd:forget', (_e, id) => {
  if (sessions) sessions.forget(id);
  outputs.remove(id);
  if (session) session.nodes.delete(id);
});

// The renderer starts or stops watching a running card. Starting returns what
// its new terminal model needs to show the screen as it is.
ipcMain.handle('out:subscribe', (_e, { id, on }) => {
  if (!relay.subscribe(id, on)) return null;
  return on ? { replay: outputs.replay(id) } : {};
});
ipcMain.handle('out:replay', async (_e, { id, full }) => { await outputs.load(id); return { replay: outputs.replay(id, { full }) }; });
ipcMain.handle('out:info', (_e, id) => outputs.info(id));
ipcMain.handle('out:view', (_e, req) => outputs.view(req.id, req));
ipcMain.handle('out:range', (_e, req) => outputs.range(req.id, req));
ipcMain.handle('out:locate', (_e, req) => outputs.locate(req.id, req));
ipcMain.handle('out:head', (_e, req) => outputs.head(req.id, req));
ipcMain.handle('out:clip', (_e, req) => outputs.clip(req.id, req));
ipcMain.handle('out:search', async (_e, req) => {
  const res = await outputs.search(req.id, { query: String(req.query || ''), caseSensitive: !!req.caseSensitive });
  return res && { ...res, lines: Array.from(res.lines) };
});
// The screen text of a card whose program moved the cursor, from its terminal.
ipcMain.handle('out:replace', (_e, { id, text }) => outputs.put(id, String(text)));

ipcMain.handle('clip:write', (_e, text) => { clipboard.writeText(String(text)); return true; });
ipcMain.handle('out:copy', async (_e, { id }) => {
  const tmp = tmpFile(`copy-${id}`);
  try {
    const res = await outputs.exportPlain(id, tmp, { max: COPY_MAX });
    clipboard.writeText(await fs.promises.readFile(tmp, 'utf8'));
    return res;
  } finally { fs.rm(tmp, { force: true }, () => {}); }
});

ipcMain.handle('out:save', async (_e, { id, name }) => {
  const base = String(name || 'output').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'output';
  const res = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), `${base}.txt`) });
  if (res.canceled || !res.filePath) return null;
  const out = await outputs.exportPlain(id, res.filePath);
  return { path: res.filePath, ...out };
});

// Opens the output in the default editor for .txt files. A log with no
// escapes is linked rather than copied; one with colors is exported as text.
ipcMain.handle('out:open', async (_e, { id }) => {
  const info = await outputs.info(id);
  if (!info || !info.bytes) return 'no output';
  const txt = path.join(file('outputs'), `${id}.txt`);
  fs.rmSync(txt, { force: true });
  try {
    if (info.hasEsc) throw new Error('export');
    fs.linkSync(outputs.file(id), txt);
  } catch { await outputs.exportPlain(id, txt); }
  return shell.openPath(txt);
});

// ---------------------------------------------------------------- command bar
// A snapshot path from the renderer is only used if it's one Loom wrote.
function snapshotPath(p) {
  if (typeof p !== 'string') return null;
  const full = path.resolve(p);
  return path.dirname(full) === path.resolve(envDir()) ? full : null;
}

function cardInfo({ cardId, envFile }) {
  return shellInfo.forCard({ cardId: Number.isFinite(cardId) ? cardId : null, envFile: snapshotPath(envFile) });
}

// Only command names cross to the renderer, never the environment's values.
ipcMain.handle('shell:info', async (_e, req = {}) => {
  const info = await cardInfo(req);
  return info.key === req.have ? { key: info.key } : { key: info.key, commands: info.commands };
});

let completing = null;
ipcMain.handle('complete:run', async (_e, req) => {
  if (completing) completing.abort();
  const ctl = new AbortController();
  completing = ctl;
  try {
    const cwd = req.cwd && isDir(req.cwd) ? req.cwd : os.homedir();
    const info = await cardInfo(req);
    if (ctl.signal.aborted) return null;
    return await completer.complete({
      text: String(req.text || ''), caret: req.caret, cwd, commands: info.commands, env: info.env,
      home: os.homedir(), signal: ctl.signal,
    });
  } catch (err) {
    console.warn('completion failed', err);
    return null;
  } finally {
    if (completing === ctl) completing = null;
  }
});

ipcMain.handle('fs:exists', async (_e, { cwd, paths }) => {
  const base = cwd && isDir(cwd) ? cwd : os.homedir();
  return Promise.all((paths || []).slice(0, 200).map(async (p) => {
    try {
      const st = await fs.promises.stat(path.resolve(base, expandHome(String(p))));
      return { e: true, d: st.isDirectory(), x: st.isFile() && !!(st.mode & 0o111) };
    } catch { return { e: false }; }
  }));
});

ipcMain.handle('history:load', () => history.all());
ipcMain.handle('history:add', (_e, rec) => history.add(rec));

// The shell's own history files are only ever read.
function shellHistories() {
  const home = os.homedir();
  const read = (name) => { try { return fs.readFileSync(path.join(home, name)); } catch { return null; } };
  const out = [];
  const zsh = read('.zsh_history');
  if (zsh && zsh.length) out.push({ name: '~/.zsh_history', records: parseZshHistory(zsh) });
  const bash = read('.bash_history');
  if (bash && bash.length) out.push({ name: '~/.bash_history', records: parseBashHistory(bash.toString('utf8')) });
  return out.filter((h) => h.records.length);
}

// Offered once, on the first launch that finds a history file.
ipcMain.handle('history:offer', () => {
  const s = settings();
  if (s.historyOffered) return null;
  const found = shellHistories();
  if (!found.length) return null;
  s.historyOffered = true;
  writeJSON(file('settings.json'), s);
  return { sources: found.map((h) => ({ name: h.name, count: h.records.length })) };
});

ipcMain.handle('history:import', () => {
  const found = shellHistories();
  const list = [];
  for (const h of found) list.push(...h.records);
  list.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  return { added: history.importRecords(list), sources: found.map((h) => h.name) };
});

// ---------------------------------------------------------------- structured data for rich views
async function listDir({ cwd, target, hidden }) {
  const dir = path.resolve(cwd || os.homedir(), expandHome(target || '.'));
  try {
    if (!(await fs.promises.stat(dir)).isDirectory()) return null;
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    const visible = dirents.filter((d) => hidden || !d.name.startsWith('.')).slice(0, 3000);
    const entries = await Promise.all(visible.map(async (d) => {
      let s = null;
      try { s = await fs.promises.stat(path.join(dir, d.name)); } catch { /* broken link */ }
      return {
        name: d.name,
        dir: s ? s.isDirectory() : d.isDirectory(),
        link: d.isSymbolicLink(),
        size: s ? s.size : 0,
        mtime: s ? s.mtimeMs : 0,
        exec: !!(s && s.isFile() && (s.mode & 0o111)),
      };
    }));
    return { path: dir, entries, total: dirents.length };
  } catch { return null; }
}

ipcMain.handle('fs:open', async (_e, p) => {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !fs.existsSync(p)) return 'not found';
  return shell.openPath(p);
});

ipcMain.handle('fs:names', async (_e, cwd) => {
  try {
    const d = await fs.promises.readdir(cwd, { withFileTypes: true });
    return d.slice(0, 80).map((x) => (x.isDirectory() ? `${x.name}/` : x.name));
  } catch { return []; }
});

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: cmdEnv({ plain: true }), maxBuffer: 32 << 20, timeout: 15000 },
      (err, out) => resolve(err ? null : out));
  });
}

// git's own output for the rich-view worker, which parses it.
function gitLogRaw({ cwd, args }) {
  const fmt = '%H%x1f%P%x1f%an%x1f%ar%x1f%s%x1f%D%x1e';
  const a = ['log', `--format=${fmt}`, '--topo-order', ...args.map(String)];
  if (!args.some((x) => /^(-n\d*|--max-count.*|-\d+)$/.test(x))) a.push('-n', '300');
  return git(cwd, a);
}
const gitStatusRaw = ({ cwd }) => git(cwd, ['status', '--porcelain=v1', '-b']);

// ---------------------------------------------------------------- rich-view worker
// The renderer's Web Worker talks to main over its own MessagePort, so the data
// it parses never passes through the page's thread.
const workerOps = {
  head: ({ id, bytes }) => outputs.head(id, { bytes }),
  listDir: (q) => listDir(q),
  gitLog: (q) => gitLogRaw(q),
  gitStatus: (q) => gitStatusRaw(q),
  richGet: ({ id }) => outputs.getRich(id),
  richPut: ({ id, value }) => outputs.putRich(id, value),
};
ipcMain.handle('worker:port', (e) => {
  const { port1, port2 } = new MessageChannelMain();
  port1.on('message', async ({ data }) => {
    const { rid, op, arg } = data || {};
    try {
      if (!workerOps[op]) throw new Error(`no op ${op}`);
      port1.postMessage({ rid, ok: true, value: await workerOps[op](arg || {}) });
    } catch (err) { port1.postMessage({ rid, ok: false, error: err.message }); }
  });
  port1.start();
  e.sender.postMessage('worker-port', null, [port2]);
  return true;
});

// ---------------------------------------------------------------- Claude
ipcMain.handle('ai:complete', async (_e, { system, prompt, maxTokens }) => {
  const key = getApiKey();
  if (!key) return { ok: false, error: 'NO_KEY' };
  const model = settings().model || DEFAULT_MODEL;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens || 1024,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(90000),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: (j && j.error && j.error.message) || `HTTP ${res.status}` };
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'Request timed out' : err.message };
  }
});

// ---------------------------------------------------------------- settings / session
ipcMain.handle('settings:get', () => {
  const s = settings();
  return {
    model: s.model || DEFAULT_MODEL,
    hasKey: !!getApiKey(),
    keyFromEnv: !!process.env.ANTHROPIC_API_KEY,
    forceColor: !!s.forceColor,
    realPager: !!s.realPager,
    outputCapGB: Number(s.outputCapGB) || 1,
    outputTotalGB: Number(s.outputTotalGB) || 5,
    shell: pickShell(),
  };
});

ipcMain.handle('settings:set', (_e, patch) => {
  const s = settings();
  if (typeof patch.model === 'string' && patch.model.trim()) s.model = patch.model.trim();
  if (typeof patch.forceColor === 'boolean') s.forceColor = patch.forceColor;
  const pagerChanged = typeof patch.realPager === 'boolean' && patch.realPager !== !!s.realPager;
  if (pagerChanged) s.realPager = patch.realPager;
  if (typeof patch.apiKey === 'string') {
    if (!patch.apiKey) { delete s.apiKey; delete s.keyEncrypted; }
    else if (safeStorage.isEncryptionAvailable()) {
      s.apiKey = safeStorage.encryptString(patch.apiKey).toString('base64');
      s.keyEncrypted = true;
    } else { s.apiKey = patch.apiKey; s.keyEncrypted = false; }
  }
  for (const k of ['outputCapGB', 'outputTotalGB']) {
    const v = Number(patch[k]);
    if (Number.isFinite(v) && v > 0) s[k] = Math.min(v, 1024);
  }
  writeJSON(file('settings.json'), s);
  outputs.setCaps(capsFromSettings());
  if (pagerChanged && sessions) sessions.dropIdle();
  return true;
});

// Snapshots hold exported env vars, so don't keep any no card points at.
function pruneSnapshots(saved) {
  const keep = new Set(((saved && saved.nodes) || []).map((n) => n.envFile && path.basename(n.envFile)));
  let names = [];
  try { names = fs.readdirSync(envDir()); } catch { /* none yet */ }
  for (const name of names) if (!keep.has(name)) fs.rm(path.join(envDir(), name), { force: true }, () => {});
}

// session.json holds card metadata only; output lives in userData/outputs.
// main keeps the session in memory, the renderer sends what changed, and the
// file is written debounced, atomically, and only when its contents changed.
const persistSession = !SMOKE || !!process.env.LOOM_SMOKE_USERDATA;
let session = null; // { meta, nodes: Map id -> node }
let sessionWritten = '';
let sessionTimer = null;

function sessionJSON() {
  return JSON.stringify({ ...session.meta, v: 2, nodes: [...session.nodes.values()] });
}
function writeSession() {
  clearTimeout(sessionTimer);
  sessionTimer = null;
  if (!persistSession || !session) return;
  const json = sessionJSON();
  if (json === sessionWritten) return;
  try {
    const p = file('session.json');
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, p);
    sessionWritten = json;
  } catch (err) { console.warn(`session not saved: ${err.message}`); }
}
const writeSessionSoon = () => { if (!sessionTimer) sessionTimer = setTimeout(writeSession, 500); };

// Sessions from before output files kept each card's output tail inline.
function migrate(saved) {
  let changed = false;
  for (const n of saved.nodes || []) {
    if (Array.isArray(n.segs)) {
      const text = n.segs.map((x) => x[1]).join('');
      if (text) {
        const out = outputs.put(n.id, text);
        if (n.h == null) n.h = 62 + Math.min(out.lines * 19 + 22, n.bodyH || 300);
      }
      delete n.segs;
      changed = true;
    }
    if (n.rich) {
      if (['files', 'gitlog', 'gitstatus'].includes(n.rich.kind)) outputs.putRich(n.id, n.rich);
      n.richKind = n.rich.kind;
      delete n.rich;
      changed = true;
    }
  }
  if (changed) {
    try { fs.copyFileSync(file('session.json'), file('session.v1.json')); } catch { /* nothing to keep */ }
  }
  return changed;
}

ipcMain.handle('session:load', () => {
  relay.reset();
  if (!persistSession) { session = { meta: {}, nodes: new Map() }; return null; }
  const saved = readJSON(file('session.json'), null);
  pruneSnapshots(saved);
  const changed = saved ? migrate(saved) : false;
  const nodes = (saved && saved.nodes) || [];
  outputs.prune(new Set(nodes.map((n) => n.id)));
  const meta = saved ? { ...saved } : {};
  delete meta.nodes;
  session = { meta, nodes: new Map(nodes.map((n) => [n.id, n])) };
  if (changed) writeSession(); else sessionWritten = saved ? sessionJSON() : '';
  return saved ? { ...meta, v: 2, nodes } : null;
});
// { meta, nodes: { id: node | null } }: only what changed.
ipcMain.handle('session:patch', (_e, patch) => {
  if (!session) session = { meta: {}, nodes: new Map() };
  if (patch.meta) Object.assign(session.meta, patch.meta);
  for (const [id, n] of Object.entries(patch.nodes || {})) {
    if (n) session.nodes.set(Number(id), n); else session.nodes.delete(Number(id));
  }
  writeSessionSoon();
  return true;
});
// The whole session at once (the e2e run, and before quitting).
ipcMain.handle('session:save', (_e, data) => {
  const meta = { ...data };
  delete meta.nodes;
  session = { meta, nodes: new Map((data.nodes || []).map((n) => [n.id, n])) };
  writeSession();
  return true;
});

ipcMain.handle('sys:info', () => ({
  platform: process.platform,
  home: SMOKE && process.env.LOOM_SMOKE_CWD ? process.env.LOOM_SMOKE_CWD : os.homedir(),
  realHome: os.homedir(),
  user: os.userInfo().username,
  shell: path.basename(pickShell()),
  smoke: !!SMOKE,
  bench: BENCH,
  procStart: PROC_START,
  smokeResume: !!process.env.LOOM_SMOKE_RESUME,
  smokeMigrate: !!process.env.LOOM_SMOKE_MIGRATE,
  e2e: SMOKE ? { sudoPass: process.env.E2E_SUDO_PASS || '', ssh: !!process.env.E2E_SSH } : null,
  sessions: !!sessions,
}));

// Real keyboard input for the e2e run. Each key is a character or a keyCode,
// optionally with modifiers, so it goes through the page's focus and key handlers.
ipcMain.handle('smoke:keys', async (_e, keys) => {
  if (!SMOKE || !win) return;
  win.webContents.focus();
  for (const k of keys) {
    const { key, modifiers = /^[A-Z]$/.test(k) ? ['shift'] : [] } = typeof k === 'string' ? { key: k } : k;
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
    if (key.length === 1 && !modifiers.includes('control') && !modifiers.includes('meta')) {
      win.webContents.sendInputEvent({ type: 'char', keyCode: key, modifiers });
    }
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
    await new Promise((r) => setTimeout(r, 15));
  }
});

ipcMain.handle('smoke:copy', () => { if (SMOKE && win) win.webContents.copy(); });
ipcMain.handle('smoke:clipboard', (_e, { write } = {}) => {
  if (!SMOKE) return null;
  if (typeof write === 'string') { clipboard.writeText(write); return write; }
  return clipboard.readText();
});

// The whole output as text, for the e2e checks.
ipcMain.handle('smoke:out', async (_e, { id, raw }) => {
  if (!SMOKE) return null;
  await outputs.load(id);
  outputs.flushAll();
  try {
    const t = fs.readFileSync(outputs.file(id), 'utf8');
    return raw ? t : t.split('\n').map(require('./renderer/wrap').visible).join('\n');
  } catch { return ''; }
});

ipcMain.handle('smoke:resize', (_e, { width, height }) => { if (SMOKE && win) win.setSize(width, height); });

// A real paste, through the clipboard and the page's paste event.
ipcMain.handle('smoke:paste', (_e, text) => {
  if (!SMOKE || !win) return;
  clipboard.writeText(text);
  win.webContents.paste();
});

// ---------------------------------------------------------------- bench
// Peak working set per process type, sampled until the next mark.
const benchPeak = { main: 0, renderer: 0, all: 0 };
function sampleMemory() {
  let main = 0; let renderer = 0; let all = 0;
  for (const m of app.getAppMetrics()) {
    const mb = m.memory.workingSetSize / 1024;
    all += mb;
    if (m.type === 'Browser') main += mb;
    else if (m.type === 'Tab') renderer += mb;
  }
  benchPeak.main = Math.max(benchPeak.main, main);
  benchPeak.renderer = Math.max(benchPeak.renderer, renderer);
  benchPeak.all = Math.max(benchPeak.all, all);
}
if (SMOKE) app.whenReady().then(() => setInterval(sampleMemory, 200));
ipcMain.handle('bench:mem', (_e, { reset } = {}) => {
  sampleMemory();
  const out = { ...benchPeak };
  if (reset) Object.assign(benchPeak, { main: 0, renderer: 0, all: 0 });
  return out;
});
// scripts/bench.js reads these lines.
ipcMain.handle('bench:report', (_e, result) => { if (BENCH) console.log(`[bench] ${JSON.stringify(result)}`); });

// test/e2e.js reads these lines.
ipcMain.handle('smoke:report', (_e, results) => {
  if (!SMOKE) return;
  for (const r of results) console.log(`[e2e] ${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ` :: ${r.detail}`}`);
  console.log(`[e2e] END ${results.length}`);
});

ipcMain.handle('smoke:done', async (_e, opts = {}) => {
  if (!SMOKE || !win) return;
  const img = await win.webContents.capturePage();
  fs.writeFileSync(opts.suffix ? SMOKE.replace(/\.png$/, `-${opts.suffix}.png`) : SMOKE, img.toPNG());
  if (!opts.keep) app.quit();
});

// ---------------------------------------------------------------- window
function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 820,
    minHeight: 560,
    title: 'Loom',
    backgroundColor: '#0c0e11',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !SMOKE,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  if (SMOKE) {
    win.webContents.on('console-message', (e, _l, msg) => console.log(`[renderer] ${e.message || msg}`));
    if (process.env.LOOM_THEME) nativeTheme.themeSource = process.env.LOOM_THEME;
  }
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  history = createHistory(file('history.jsonl'));
  startOutputs();
  await resolveLoginPath();
  startSessions();
  shellInfo = createShellInfo({ shell: pickShell(), env: () => cmdEnv({ plain: true }), sessions });
  if (!isWin) shellInfo.probeBase();
  createWindow();
  // Warm the specs people reach for first.
  setTimeout(() => { for (const n of ['git', 'npm', 'docker']) completer.loadSpec(n); }, 3000);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('before-quit', () => {
  writeSession();
  if (outputs) outputs.shutdown();
  if (sessions) sessions.shutdown();
  for (const p of procs.values()) {
    try { isWin ? p.child.kill() : process.kill(-p.child.pid, 'SIGTERM'); } catch { /* gone */ }
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || SMOKE) app.quit(); });
