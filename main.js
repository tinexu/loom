'use strict';
// Loom — main process.
// Routes commands to long-lived shell sessions (lib/sessions.js), or to one
// child process per card where those aren't available, and brokers file-system,
// git and Claude calls for the renderer. The renderer never touches Node directly.

const { app, BrowserWindow, ipcMain, safeStorage, shell, nativeTheme, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { createSessions } = require('./lib/sessions');
const { createShellInfo } = require('./lib/shellinfo');
const { createHistory, parseZshHistory, parseBashHistory } = require('./lib/history');
const completer = require('./lib/complete');

const isWin = process.platform === 'win32';
const SMOKE = process.env.LOOM_SMOKE || '';
const MAX_OUTPUT = 5 * 1024 * 1024; // per command
const DEFAULT_MODEL = 'claude-sonnet-5-5';

if (SMOKE) {
  // A fixed LOOM_SMOKE_USERDATA lets the e2e run restart Loom over its own session.
  app.setPath('userData', process.env.LOOM_SMOKE_USERDATA || path.join(os.tmpdir(), `loom-smoke-${process.pid}`));
  app.disableHardwareAcceleration();
}

let win = null;
let loginPath = process.env.PATH || '';
let sessions = null;
let shellInfo = null;
let history = null;
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
    onData: (id, chunks) => send('cmd:data', { id, chunks }),
    onExit: (msg) => send('cmd:exit', msg),
    fallback: runSpawned,
  });
}

ipcMain.handle('cmd:run', (_e, req) => (sessions ? sessions.run(req) : runSpawned(req)));

function runSpawned({ id, command, cwd, stdin }) {
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
        if (isDir(target)) send('cmd:exit', { id, code: 0, signal: null, cwd: target });
        else {
          send('cmd:data', { id, chunks: [[1, `cd: no such directory: ${target}\n`]] });
          send('cmd:exit', { id, code: 1, signal: null, cwd: dir });
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

  const p = { child, buf: [], timer: null, bytes: 0, truncated: false };
  procs.set(id, p);

  const flush = () => {
    clearTimeout(p.timer);
    p.timer = null;
    if (p.buf.length) { send('cmd:data', { id, chunks: p.buf }); p.buf = []; }
  };
  const push = (stream) => {
    const decoder = new StringDecoder('utf8');
    return (data) => {
      if (p.truncated) return;
      p.bytes += data.length;
      let text = decoder.write(data);
      if (p.bytes > MAX_OUTPUT) {
        p.truncated = true;
        stream = 1;
        text = `\n[loom: output truncated after ${MAX_OUTPUT / 1048576} MB]\n`;
      }
      const last = p.buf[p.buf.length - 1];
      text = text.replace(/\r?\n/g, '\r\n'); // the renderer's terminal model expects a TTY's line endings
      if (last && last[0] === stream) last[1] += text; else p.buf.push([stream, text]);
      if (!p.timer) p.timer = setTimeout(flush, 24);
    };
  };

  child.stdout.on('data', push(0));
  child.stderr.on('data', push(1));
  child.stdin.on('error', () => {});
  if (typeof stdin === 'string') child.stdin.end(stdin);

  let done = false;
  const finish = (code, signal) => {
    if (done) return;
    done = true;
    flush();
    procs.delete(id);
    const finalCwd = cwdOut && isDir(cwdOut) ? cwdOut : dir;
    send('cmd:exit', { id, code, signal, cwd: finalCwd, truncated: p.truncated });
  };
  child.on('error', (err) => {
    p.buf.push([1, `loom: ${err.message}\n`]);
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
ipcMain.handle('cmd:ack', (_e, { id, bytes }) => { if (sessions) sessions.ack(id, bytes); });
ipcMain.handle('cmd:forget', (_e, id) => { if (sessions) sessions.forget(id); });

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
ipcMain.handle('fs:list', async (_e, { cwd, target, hidden }) => {
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
});

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

ipcMain.handle('git:log', async (_e, { cwd, args }) => {
  const fmt = '%H%x1f%P%x1f%an%x1f%ar%x1f%s%x1f%D%x1e';
  const a = ['log', `--format=${fmt}`, '--topo-order', ...args];
  if (!args.some((x) => /^(-n\d*|--max-count.*|-\d+)$/.test(x))) a.push('-n', '300');
  const out = await git(cwd, a);
  if (out == null) return null;
  const commits = out.split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [hash, parents, author, date, subject, refs] = r.split('\x1f');
    return {
      hash, author, date, subject,
      parents: parents ? parents.split(' ') : [],
      refs: refs ? refs.split(', ').filter(Boolean) : [],
    };
  });
  return { commits };
});

ipcMain.handle('git:status', async (_e, { cwd }) => {
  const out = await git(cwd, ['status', '--porcelain=v1', '-b']);
  if (out == null) return null;
  let branch = '';
  const files = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    if (line.startsWith('## ')) { branch = line.slice(3); continue; }
    const x = line[0]; const y = line[1];
    let p = line.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ').pop();
    files.push({ x, y, path: p.replace(/^"|"$/g, '') });
  }
  return { branch, files };
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
  writeJSON(file('settings.json'), s);
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

const persistSession = !SMOKE || !!process.env.LOOM_SMOKE_USERDATA;
ipcMain.handle('session:load', () => {
  if (!persistSession) return null;
  const saved = readJSON(file('session.json'), null);
  pruneSnapshots(saved);
  if (sessions) sessions.resetFlow();
  return saved;
});
ipcMain.handle('session:save', (_e, data) => {
  if (!persistSession) return true;
  try { writeJSON(file('session.json'), data); return true; } catch { return false; }
});

ipcMain.handle('sys:info', () => ({
  platform: process.platform,
  home: SMOKE && process.env.LOOM_SMOKE_CWD ? process.env.LOOM_SMOKE_CWD : os.homedir(),
  realHome: os.homedir(),
  user: os.userInfo().username,
  shell: path.basename(pickShell()),
  smoke: !!SMOKE,
  smokeResume: !!process.env.LOOM_SMOKE_RESUME,
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

ipcMain.handle('smoke:resize', (_e, { width, height }) => { if (SMOKE && win) win.setSize(width, height); });

// A real paste, through the clipboard and the page's paste event.
ipcMain.handle('smoke:paste', (_e, text) => {
  if (!SMOKE || !win) return;
  clipboard.writeText(text);
  win.webContents.paste();
});

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
  if (sessions) sessions.shutdown();
  for (const p of procs.values()) {
    try { isWin ? p.child.kill() : process.kill(-p.child.pid, 'SIGTERM'); } catch { /* gone */ }
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || SMOKE) app.quit(); });
