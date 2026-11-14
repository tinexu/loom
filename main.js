'use strict';
// Loom — main process.
// Routes commands to long-lived shell sessions (lib/sessions.js), or to one
// child process per card where those aren't available, and brokers file-system,
// git and Claude calls for the renderer. The renderer never touches Node directly.
// Every card's output is recorded here (lib/outputs.js); the renderer asks for
// the lines it shows, and only watched running cards stream to it (lib/relay.js).
// Cards are keyed "<canvas>.<card>": each tab is a canvas, saved on its own
// (lib/tabs.js), and its cards' events go to the window that shows it.

const {
  app, BrowserWindow, ipcMain, safeStorage, shell, nativeTheme, clipboard, dialog, MessageChannelMain,
  Menu, Notification, globalShortcut, screen, session: electronSession, nativeImage,
} = require('electron');
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
const { createTabStore, migrateLegacy } = require('./lib/tabs');
const { parseArgs, userArgs, hasRequest } = require('./lib/args');
const Settings = require('./lib/settings');
const Themes = require('./lib/themes');
const Launcher = require('./lib/launcher');
const Env = require('./lib/env');
const completer = require('./lib/complete');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const SMOKE = process.env.LOOM_SMOKE || '';
const BENCH = SMOKE ? process.env.LOOM_BENCH || '' : '';
const PROC_START = Date.now() - process.uptime() * 1000;
const GB = 1024 ** 3;
const COPY_MAX = 32 * 1024 * 1024;
const REPO = 'tinexu/loom';
const REPO_URL = `https://github.com/${REPO}`;

if (SMOKE) {
  // A fixed LOOM_SMOKE_USERDATA lets the e2e run restart Loom over its own session.
  app.setPath('userData', process.env.LOOM_SMOKE_USERDATA || path.join(os.tmpdir(), `loom-smoke-${process.pid}`));
  // The bench measures frame rates, so it keeps the GPU.
  if (!BENCH) app.disableHardwareAcceleration();
}

// ---------------------------------------------------------------- single instance
// A second `loom` hands its arguments to this one and exits.
const launchArgs = parseArgs(userArgs(process.argv, { defaultApp: !!process.defaultApp }), { cwd: process.cwd() });
const primary = app.requestSingleInstanceLock({ args: launchArgs });
if (!primary) app.quit();

let mainWin = null;
let dropWin = null;
let loginPath = process.env.PATH || '';
let sessions = null;
let shellInfo = null;
let history = null;
let outputs = null;
let relay = null;
let tabs = null;
const procs = new Map();
const owners = new Map(); // canvas id -> webContents of the window showing it
const runningCards = new Map(); // key -> { command, startedAt }

// ---------------------------------------------------------------- storage
const file = (name) => path.join(app.getPath('userData'), name);

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJSON(p, value, pretty = false) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, pretty ? 2 : 0));
  fs.renameSync(tmp, p);
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ---------------------------------------------------------------- settings
// settings.json is validated on every read; errors go to the Settings page.
let conf = { value: { ...Settings.DEFAULTS }, errors: [] };
let confText = '';
const settings = () => conf.value;

function readSettings() {
  conf = Settings.load(file('settings.json'), conf.value);
  try { confText = fs.readFileSync(file('settings.json'), 'utf8'); } catch { confText = ''; }
}
function writeSettings(value) {
  const text = `${JSON.stringify(Settings.toFile(value), null, 2)}\n`;
  writeJSON(file('settings.json'), Settings.toFile(value), true);
  confText = text;
  conf = { value, errors: [] };
}
// The file changed, from Loom or from an editor: apply it everywhere.
function applySettings(prev = {}) {
  const s = settings();
  if (outputs) outputs.setCaps(capsFromSettings());
  if (sessions) {
    if (s.realPager !== prev.realPager) sessions.dropIdle();
    sessions.setShell(pickShell(), s.shellArgs);
  }
  if (s.dropdownHotkey !== prev.dropdownHotkey) registerHotkey();
  broadcast('settings:changed', pageSettings());
}
function watchSettings() {
  const dir = app.getPath('userData');
  try {
    fs.watch(dir, debounce(() => {
      let text = '';
      try { text = fs.readFileSync(file('settings.json'), 'utf8'); } catch { /* removed */ }
      if (text === confText) return;
      const prev = settings();
      readSettings();
      applySettings(prev);
    }, 150));
  } catch { /* no watching: changes apply from the Settings page */ }
}

// .env: the project's when running from a checkout, userData/.env in an
// installed app (never one inside the app bundle). Its values stay with Loom;
// they don't go into the environment of the shells in your tabs.
const dotenvFile = () => Env.dotenvPath({ packaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData') });
const dotenv = () => Env.readDotenv(dotenvFile());

function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const fromFile = dotenv().ANTHROPIC_API_KEY;
  if (fromFile) return fromFile;
  const s = settings();
  if (!s.apiKey) return null;
  try {
    return s.keyEncrypted ? safeStorage.decryptString(Buffer.from(s.apiKey, 'base64')) : s.apiKey;
  } catch { return null; }
}

function pageSettings() {
  return {
    settings: Settings.forPage(settings()),
    errors: conf.errors,
    hasKey: !!getApiKey(),
    keyFromEnv: !!(process.env.ANTHROPIC_API_KEY || dotenv().ANTHROPIC_API_KEY),
    keySource: process.env.ANTHROPIC_API_KEY ? 'environment' : dotenv().ANTHROPIC_API_KEY ? dotenvFile() : null,
    dotenv: dotenvFile(),
    shell: pickShell(),
    hotkey: hotkeyStatus,
    file: file('settings.json'),
  };
}

// ---------------------------------------------------------------- shell
function pickShell() {
  if (isWin) return 'powershell.exe';
  const s = settings().shell || process.env.SHELL || '/bin/bash';
  // The cwd-tracking wrapper uses POSIX syntax; fish/nu etc. fall back to bash.
  return ['bash', 'zsh', 'sh', 'dash', 'ksh'].includes(path.basename(s)) ? s : '/bin/bash';
}

// Apps launched from Finder, the Dock or a desktop launcher get a minimal
// PATH. Ask the user's login shell for theirs (4 s at most: a slow or broken
// rc file falls back), and add the folders tools usually live in (Homebrew,
// nvm, pyenv, cargo…) that exist. Also a UTF-8 locale, which apps don't get.
async function resolveLoginPath() {
  if (isWin) return;
  Object.assign(process.env, Env.localeEnv(process.env));
  const probed = await Env.probeLoginPath(pickShell(), { timeout: 4000 });
  if (!probed) console.warn('loom: the login shell didn\'t report its PATH in time; using the usual folders');
  loginPath = Env.mergePath(probed, process.env.PATH, Env.fallbackDirs(os.homedir()));
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

// ---------------------------------------------------------------- windows and messages
const windows = () => [mainWin, dropWin].filter((w) => w && !w.isDestroyed());
function broadcast(channel, msg) {
  for (const w of windows()) w.webContents.send(channel, msg);
}
const cidOf = (key) => String(key).split('.')[0];
// A card's events go to the window showing its canvas.
function sendCard(key, channel, msg) {
  const wc = owners.get(cidOf(key)) || (mainWin && !mainWin.isDestroyed() ? mainWin.webContents : null);
  if (!wc || wc.isDestroyed()) return false;
  wc.send(channel, msg);
  return true;
}
const kindOf = (wc) => (dropWin && !dropWin.isDestroyed() && wc === dropWin.webContents ? 'dropdown' : 'main');
const winOf = (wc) => BrowserWindow.fromWebContents(wc);

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
    shellArgs: settings().shellArgs,
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
const capsFromSettings = () => ({ card: settings().outputCapGB * GB, total: settings().outputTotalGB * GB });

function startOutputs() {
  const c = capsFromSettings();
  outputs = createOutputs({
    dir: file('outputs'),
    capCard: c.card,
    capTotal: c.total,
    onCapped: (id, cap) => sendCard(id, 'out:capped', { id, cap }),
    onEvicted: (id) => sendCard(id, 'out:evicted', { id }),
  });
  relay = createRelay({
    send: (id, data) => sendCard(id, 'cmd:data', { id, data }),
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
  runningCards.delete(msg.id);
  const out = outputs.end(msg.id);
  sendCard(msg.id, 'cmd:exit', { ...msg, out });
}

const tmpFile = (name) => path.join(os.tmpdir(), `loom-${process.pid}-${name}`);
const validKey = (k) => typeof k === 'string' && /^c[0-9a-f]{8}\.\d+$/.test(k);

ipcMain.handle('cmd:run', async (e, req) => {
  if (!validKey(req.id)) throw new Error('bad card key');
  owners.set(cidOf(req.id), e.sender);
  outputs.begin(req.id);
  relay.start(req.id, { watch: req.watch !== false });
  runningCards.set(req.id, { command: req.command, startedAt: Date.now() });
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

function killCard(id) {
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
}
ipcMain.handle('cmd:kill', (_e, id) => killCard(id));

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
  const c = canvases.get(cidOf(id));
  if (c) c.nodes.delete(Number(String(id).split('.')[1]));
});

// The renderer starts or stops watching a running card. Starting returns what
// its new terminal model needs to show the screen as it is.
ipcMain.handle('out:subscribe', (e, { id, on }) => {
  owners.set(cidOf(id), e.sender);
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

ipcMain.handle('out:save', async (e, { id, name }) => {
  const base = String(name || 'output').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'output';
  const res = await dialog.showSaveDialog(winOf(e.sender), { defaultPath: path.join(app.getPath('downloads'), `${base}.txt`) });
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
  return shellInfo.forCard({ cardId: validKey(cardId) ? cardId : null, envFile: snapshotPath(envFile) });
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
  if (settings().historyOffered) return null;
  const found = shellHistories();
  if (!found.length) return null;
  writeSettings({ ...settings(), historyOffered: true });
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

ipcMain.handle('fs:isDir', (_e, p) => typeof p === 'string' && isDir(expandHome(p)));
ipcMain.handle('fs:pickFolder', async (e) => {
  const res = await dialog.showOpenDialog(winOf(e.sender), { properties: ['openDirectory', 'createDirectory'] });
  return res.canceled ? null : res.filePaths[0];
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
  const model = settings().model || Settings.DEFAULTS.model;
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

// ---------------------------------------------------------------- settings IPC
ipcMain.handle('settings:get', () => pageSettings());

// A partial change from the Settings page. The API key is encrypted with the
// OS keychain when it can be.
ipcMain.handle('settings:set', (_e, patch = {}) => {
  const prev = settings();
  const next = { ...prev };
  const errors = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'apiKey') continue;
    if (!Settings.SCHEMA[k] || Settings.SCHEMA[k].hidden) { errors.push(`"${k}" isn't a setting`); continue; }
    const err = Settings.check(k, v);
    if (err) errors.push(`${k} ${err}`); else next[k] = v;
  }
  if (typeof patch.apiKey === 'string') {
    if (!patch.apiKey) { next.apiKey = ''; next.keyEncrypted = false; }
    else if (safeStorage.isEncryptionAvailable()) {
      next.apiKey = safeStorage.encryptString(patch.apiKey).toString('base64');
      next.keyEncrypted = true;
    } else { next.apiKey = patch.apiKey; next.keyEncrypted = false; }
  }
  writeSettings(next);
  applySettings(prev);
  return { ok: !errors.length, errors };
});

// Opens settings.json in the default editor; Loom picks up the changes.
ipcMain.handle('settings:edit', async () => {
  if (!fs.existsSync(file('settings.json'))) writeJSON(file('settings.json'), Settings.toFile(settings()), true);
  return shell.openPath(file('settings.json'));
});

// ---------------------------------------------------------------- themes
let themeSet = { themes: new Map(), errors: [] };
const themeDir = () => file('themes');
function loadThemes() {
  themeSet = Themes.loadAll(path.join(__dirname, 'themes'), themeDir());
}
function watchThemes() {
  fs.mkdirSync(themeDir(), { recursive: true });
  try {
    fs.watch(themeDir(), debounce(() => { loadThemes(); broadcast('themes:changed', themeList()); }, 150));
  } catch { /* no watching */ }
}
const themeList = () => ({
  themes: [...themeSet.themes.values()].map((t) => ({ id: t.id, name: t.name, type: t.type, builtin: t.builtin, contrast: t.contrast })),
  errors: themeSet.errors,
  system: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
});
ipcMain.handle('themes:list', () => themeList());
ipcMain.handle('themes:get', (_e, id) => themeSet.themes.get(id) || themeSet.themes.get('loom-dark'));
// .itermcolors, Windows Terminal JSON or a Loom theme, into userData/themes.
async function importThemes(files) {
  const added = [];
  for (const f of files) {
    for (const raw of Themes.importFile(f)) {
      const t = Themes.normalize(raw);
      const out = { name: t.name, type: t.type, background: t.background, foreground: t.foreground, cursor: t.cursor, selection: t.selection, ansi: t.ansi, ...(raw.ui ? { ui: raw.ui } : {}) };
      writeJSON(path.join(themeDir(), `${t.id}.json`), out, true);
      added.push({ id: t.id, name: t.name, contrast: t.contrast });
    }
  }
  loadThemes();
  broadcast('themes:changed', themeList());
  return added;
}
ipcMain.handle('themes:import', async (e, { files } = {}) => {
  let list = files;
  if (!list) {
    const res = await dialog.showOpenDialog(winOf(e.sender), { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Themes', extensions: ['itermcolors', 'json'] }] });
    if (res.canceled) return null;
    list = res.filePaths;
  }
  try { return { added: await importThemes(list) }; } catch (err) { return { error: err.message }; }
});
ipcMain.handle('themes:folder', () => { fs.mkdirSync(themeDir(), { recursive: true }); return shell.openPath(themeDir()); });

// ---------------------------------------------------------------- keybindings
// userData/keybindings.json: [{ key, command, when? }]; "-command" removes a default.
const keysFile = () => file('keybindings.json');
function readKeys() {
  let text = '';
  try { text = fs.readFileSync(keysFile(), 'utf8'); } catch { return { list: [], error: null }; }
  try {
    const list = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '') || '[]');
    return Array.isArray(list) ? { list, error: null } : { list: [], error: 'keybindings.json should be a list' };
  } catch (err) { return { list: [], error: `keybindings.json isn't valid JSON: ${err.message}` }; }
}
let keysText = '';
function watchKeys() {
  try {
    fs.watch(app.getPath('userData'), debounce(() => {
      let t = '';
      try { t = fs.readFileSync(keysFile(), 'utf8'); } catch { /* none */ }
      if (t === keysText) return;
      keysText = t;
      broadcast('keys:changed', readKeys());
    }, 150));
  } catch { /* no watching */ }
}
ipcMain.handle('keys:get', () => readKeys());
ipcMain.handle('keys:set', (_e, list) => {
  const text = `${JSON.stringify(list, null, 2)}\n`;
  fs.writeFileSync(keysFile(), text);
  keysText = text;
  broadcast('keys:changed', readKeys());
  return true;
});
ipcMain.handle('keys:edit', () => {
  if (!fs.existsSync(keysFile())) fs.writeFileSync(keysFile(), '[]\n');
  return shell.openPath(keysFile());
});

// ---------------------------------------------------------------- tabs and canvases
// Each canvas: { meta, nodes: Map id -> node }, written debounced, atomically,
// and only when it changed.
const persist = !SMOKE || !!process.env.LOOM_SMOKE_USERDATA;
const canvases = new Map();

function canvasJSON(c) { return JSON.stringify({ ...c.meta, v: 3, nodes: [...c.nodes.values()] }); }
function writeCanvas(cid) {
  const c = canvases.get(cid);
  if (!c) return;
  clearTimeout(c.timer);
  c.timer = null;
  const json = canvasJSON(c);
  if (json === c.written) return;
  try { tabs.saveCanvas(cid, json); c.written = json; } catch (err) { console.warn(`canvas ${cid} not saved: ${err.message}`); }
}
function canvas(cid) {
  let c = canvases.get(cid);
  if (!c) {
    const saved = tabs.loadCanvas(cid);
    const meta = saved ? { ...saved } : {};
    delete meta.nodes;
    c = { meta, nodes: new Map(((saved && saved.nodes) || []).map((n) => [n.id, n])), timer: null, written: saved ? '' : null };
    canvases.set(cid, c);
    if (saved) c.written = canvasJSON(c);
  }
  return c;
}

// A tab's files go when it falls off the closed list.
function dropCanvas(cid) {
  canvases.delete(cid);
  tabs.removeCanvas(cid);
  outputs.prune((key) => !key.startsWith(`${cid}.`));
  try { for (const n of fs.readdirSync(envDir())) if (n.startsWith(`card-${cid}.`)) fs.rmSync(path.join(envDir(), n), { force: true }); } catch { /* none */ }
}

// Output files and env snapshots no kept card points at.
function prune() {
  const keep = new Set();
  const envs = new Set();
  for (const cid of tabs.allIds()) {
    for (const n of canvas(cid).nodes.values()) {
      keep.add(`${cid}.${n.id}`);
      if (n.envFile) envs.add(path.basename(n.envFile));
    }
  }
  outputs.prune((key) => keep.has(key));
  let names = [];
  try { names = fs.readdirSync(envDir()); } catch { /* none yet */ }
  for (const name of names) if (!envs.has(name)) fs.rm(path.join(envDir(), name), { force: true }, () => {});
}

function startTabs() {
  // The session.json from before tabs becomes the first tab.
  if (!fs.existsSync(file('tabs.json'))) {
    const res = migrateLegacy({ dir: app.getPath('userData'), putOutput: (k, t) => outputs.put(k, t), putRich: (k, v) => outputs.putRich(k, v) });
    if (res && res.history) for (const cmd of res.history) if (typeof cmd === 'string') history.add({ cmd, cwd: null, exitCode: null, startedAt: 0 });
  }
  tabs = createTabStore({ dir: app.getPath('userData'), onDrop: dropCanvas, persist });
  prune();
}

ipcMain.handle('tabs:get', (e) => {
  const kind = kindOf(e.sender);
  const t = tabs.get(kind);
  if (!t.order.length) {
    const folder = settings().defaultFolder && isDir(expandHome(settings().defaultFolder)) ? expandHome(settings().defaultFolder) : null;
    tabs.create(kind, { title: folder ? path.basename(folder) : 'Home', folder });
    return { ...tabs.get(kind), restored: false };
  }
  // Not restoring tabs: one fresh tab, the old ones closed (and reopenable).
  if (!settings().restoreTabs && !e.sender.loomLoaded) {
    for (const cid of t.order) tabs.close(kind, cid);
    tabs.create(kind, { title: 'Home' });
    return { ...tabs.get(kind), restored: false };
  }
  return { ...t, restored: true };
});
ipcMain.handle('tabs:create', (e, meta) => tabs.create(kindOf(e.sender), meta || {}));
ipcMain.handle('tabs:set', (e, data) => { tabs.set(kindOf(e.sender), data || {}); return true; });
// Closing a tab ends its shells and running commands; its cards and output are
// kept for "reopen closed tab".
ipcMain.handle('tabs:close', (e, cid) => {
  writeCanvas(cid);
  if (sessions) sessions.forgetCanvas(cid);
  for (const key of procs.keys()) if (key.startsWith(`${cid}.`)) killCard(key);
  tabs.close(kindOf(e.sender), cid);
  return true;
});
ipcMain.handle('tabs:reopen', (e) => tabs.reopen(kindOf(e.sender)));

ipcMain.handle('canvas:load', (e, cid) => {
  if (!tabs.tab(cid)) return null;
  owners.set(cid, e.sender);
  const c = canvas(cid);
  return { ...c.meta, v: 3, nodes: [...c.nodes.values()] };
});
// { cid, meta, nodes: { id: node | null } }: only what changed.
ipcMain.handle('canvas:patch', (_e, { cid, meta, nodes }) => {
  if (!tabs.tab(cid)) return false;
  const c = canvas(cid);
  if (meta) Object.assign(c.meta, meta);
  for (const [id, n] of Object.entries(nodes || {})) {
    if (n) c.nodes.set(Number(id), n); else c.nodes.delete(Number(id));
  }
  if (persist && !c.timer) c.timer = setTimeout(() => writeCanvas(cid), 500);
  return true;
});
// A whole canvas at once (the e2e run, and before quitting).
ipcMain.handle('canvas:save', (_e, { cid, data }) => {
  if (!tabs.tab(cid)) return false;
  const meta = { ...data };
  delete meta.nodes;
  canvases.set(cid, { meta, nodes: new Map((data.nodes || []).map((n) => [n.id, n])), timer: null, written: (canvases.get(cid) || {}).written || '' });
  if (persist) writeCanvas(cid);
  return true;
});
function flushCanvases() { for (const cid of canvases.keys()) writeCanvas(cid); if (tabs) tabs.flush(); }

// ---------------------------------------------------------------- open requests
// From the command line, a second launch, the Dock, a loom:// URL or Finder.
const pendingOpens = [];
function handleOpen(args) {
  if (!app.isReady() || !mainWin) { pendingOpens.push(args); return; }
  const target = args.dropdown ? showDropdown() : showMain();
  if (!target) return;
  if (!hasRequest(args) || (args.dropdown && !args.folder)) return;
  const req = { folder: args.folder && isDir(args.folder) ? args.folder : null, missing: args.folder && !isDir(args.folder) ? args.folder : null, newTab: !!args.newTab, exec: args.exec };
  if (target.loomReady) target.webContents.send('open:request', req);
  else (target.loomQueue = target.loomQueue || []).push(req);
}
ipcMain.handle('renderer:ready', (e) => {
  const w = winOf(e.sender);
  if (!w) return null;
  w.loomReady = true;
  e.sender.loomLoaded = true;
  const q = w.loomQueue || [];
  w.loomQueue = [];
  return q;
});

app.on('second-instance', (_e, argv, cwd, data) => {
  const args = data && data.args ? data.args : parseArgs(userArgs(argv, { defaultApp: !!process.defaultApp }), { cwd });
  if (SMOKE) console.log(`[loom] second instance: ${JSON.stringify(args)}`);
  handleOpen(args);
});
// macOS: folders dropped on the Dock icon, and loom:// URLs.
app.on('open-file', (e, p) => { e.preventDefault(); handleOpen(parseArgs([p], { cwd: os.homedir() })); });
app.on('open-url', (e, url) => { e.preventDefault(); handleOpen(parseArgs([url], { cwd: os.homedir() })); });

// ---------------------------------------------------------------- the main window
// Size, position, maximized and full-screen state and display, restored on a
// display that still exists (the primary one otherwise).
const winState = () => readJSON(file('window.json'), null);
function restoreBounds() {
  const saved = winState();
  const fallback = { width: 1480, height: 920 };
  if (!saved || !saved.bounds) return { bounds: fallback, saved };
  const displays = screen.getAllDisplays();
  const d = displays.find((x) => x.id === saved.displayId)
    || displays.find((x) => { const a = x.workArea; const b = saved.bounds; return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y; });
  if (!d) {
    const wa = screen.getPrimaryDisplay().workArea;
    const w = Math.min(saved.bounds.width, wa.width); const h = Math.min(saved.bounds.height, wa.height);
    return { bounds: { x: wa.x + Math.round((wa.width - w) / 2), y: wa.y + Math.round((wa.height - h) / 2), width: w, height: h }, saved };
  }
  const wa = d.workArea;
  const b = { ...saved.bounds };
  b.width = Math.min(b.width, wa.width);
  b.height = Math.min(b.height, wa.height);
  b.x = Math.max(wa.x, Math.min(b.x, wa.x + wa.width - b.width));
  b.y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - b.height));
  return { bounds: b, saved };
}
function saveWinState() {
  if (!mainWin || mainWin.isDestroyed() || !persist) return;
  const prev = winState() || {};
  const normal = mainWin.isMaximized() || mainWin.isFullScreen() ? prev.bounds || mainWin.getBounds() : mainWin.getBounds();
  writeJSON(file('window.json'), {
    bounds: normal, maximized: mainWin.isMaximized(), fullscreen: mainWin.isFullScreen(),
    displayId: screen.getDisplayMatching(mainWin.getBounds()).id,
  });
}
const saveWinStateSoon = debounce(saveWinState, 400);

const webPreferences = () => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  backgroundThrottling: !SMOKE,
});
function wireWindow(w) {
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  if (SMOKE) w.webContents.on('console-message', (e, _l, msg) => smokeLog(`[renderer${w === dropWin ? ':dropdown' : ''}] ${e.message || msg}`));
  // A reloaded page acknowledges nothing it was sent before.
  w.webContents.on('did-start-loading', () => { w.loomReady = false; });
}

let quitting = false;
function createMainWindow() {
  const { bounds, saved } = restoreBounds();
  mainWin = new BrowserWindow({
    ...bounds,
    minWidth: 820,
    minHeight: 560,
    title: 'Loom',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0c0e11' : '#f3f2ee',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    webPreferences: webPreferences(),
  });
  wireWindow(mainWin);
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { window: 'main' } });
  mainWin.once('ready-to-show', () => {
    if (saved && saved.maximized) mainWin.maximize();
    if (saved && saved.fullscreen) mainWin.setFullScreen(true);
    mainWin.show();
  });
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) mainWin.on(ev, saveWinStateSoon);
  // macOS keeps Loom (and its tabs' running commands) when the window closes.
  mainWin.on('close', (e) => {
    saveWinState();
    if (isMac && !quitting && !SMOKE) { e.preventDefault(); mainWin.hide(); }
  });
  mainWin.on('closed', () => { mainWin = null; if (!isMac || SMOKE) app.quit(); });
  mainWin.on('focus', () => mainWin.webContents.send('window:focus', true));
  mainWin.on('blur', () => mainWin && !mainWin.isDestroyed() && mainWin.webContents.send('window:focus', false));
}
function showMain() {
  if (!mainWin) createMainWindow();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
  return mainWin;
}

// ---------------------------------------------------------------- the dropdown window
// A frameless window that slides down from the top of the display the mouse
// is on, toggled by a global hotkey. Its tabs are its own.
let dropPinned = false;
let dropReturnFocus = false;
let hotkeyStatus = { key: '', ok: false, error: null };

function createDropdown() {
  dropWin = new BrowserWindow({
    show: false, frame: false, resizable: true, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: true, roundedCorners: false, title: 'Loom',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0c0e11' : '#f3f2ee',
    ...(isMac ? { type: 'panel' } : {}),
    webPreferences: webPreferences(),
  });
  wireWindow(dropWin);
  dropWin.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { window: 'dropdown' } });
  if (isMac) dropWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  else dropWin.setVisibleOnAllWorkspaces(true);
  dropWin.setAlwaysOnTop(true, isMac ? 'pop-up-menu' : 'screen-saver');
  dropWin.on('blur', () => {
    if (settings().dropdownHideOnBlur && !dropPinned && dropWin.isVisible() && !dropAnimating) hideDropdown();
  });
  // Resizing from the bottom edge sets the height for next time.
  dropWin.on('resized', () => {
    const wa = screen.getDisplayMatching(dropWin.getBounds()).workArea;
    const ratio = Math.round((dropWin.getBounds().height / wa.height) * 100) / 100;
    if (Math.abs(ratio - settings().dropdownHeight) > 0.01) {
      const prev = settings();
      writeSettings({ ...prev, dropdownHeight: Math.max(0.15, Math.min(1, ratio)) });
      broadcast('settings:changed', pageSettings());
    }
  });
  dropWin.on('closed', () => { dropWin = null; });
}

let dropAnimating = false;
function slide(from, to, done) {
  dropAnimating = true;
  const steps = 8;
  let i = 0;
  const tick = () => {
    if (!dropWin || dropWin.isDestroyed()) return;
    i++;
    const t = 1 - (1 - i / steps) ** 3;
    dropWin.setBounds({ ...to, y: Math.round(from.y + (to.y - from.y) * t) });
    if (i < steps) setTimeout(tick, 12); else { dropAnimating = false; done && done(); }
  };
  tick();
}
function showDropdown() {
  if (!dropWin) createDropdown();
  if (dropWin.isVisible()) { dropWin.focus(); return dropWin; }
  dropReturnFocus = !BrowserWindow.getFocusedWindow();
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = d.workArea;
  const height = Math.round(wa.height * settings().dropdownHeight);
  const to = { x: wa.x, y: wa.y, width: wa.width, height };
  dropWin.setBounds({ ...to, y: wa.y - height });
  dropWin.show();
  dropWin.focus();
  slide({ y: wa.y - height }, to, () => dropWin.focus());
  dropWin.webContents.send('dropdown:shown');
  return dropWin;
}
function hideDropdown() {
  if (!dropWin || !dropWin.isVisible()) return;
  const b = dropWin.getBounds();
  slide({ y: b.y }, { ...b, y: b.y - b.height }, () => {
    if (!dropWin) return;
    dropWin.hide();
    // Back to whatever app was in front.
    if (isMac && dropReturnFocus && !(mainWin && mainWin.isFocused())) app.hide();
  });
}
const toggleDropdown = () => (dropWin && dropWin.isVisible() && dropWin.isFocused() ? hideDropdown() : showDropdown());
ipcMain.handle('dropdown:hide', () => hideDropdown());
ipcMain.handle('dropdown:toggle', () => { toggleDropdown(); return true; });
ipcMain.handle('dropdown:pin', (_e, on) => { dropPinned = !!on; return dropPinned; });

function registerHotkey() {
  if (hotkeyStatus.key) { try { globalShortcut.unregister(hotkeyStatus.key); } catch { /* not ours */ } }
  const key = SMOKE ? process.env.LOOM_SMOKE_HOTKEY || '' : settings().dropdownHotkey;
  hotkeyStatus = { key, ok: false, error: null };
  if (!key) { hotkeyStatus.error = SMOKE ? 'not registered in the e2e run' : 'no hotkey set'; broadcast('settings:changed', pageSettings()); return; }
  if (process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY)) {
    hotkeyStatus.error = 'Wayland doesn\'t let apps register global shortcuts. Bind a key in your desktop\'s settings to run: loom --dropdown';
  } else {
    try {
      hotkeyStatus.ok = globalShortcut.register(key, toggleDropdown);
      if (!hotkeyStatus.ok) hotkeyStatus.error = `${key} is taken by another app (or the system). Pick another one.`;
    } catch (err) { hotkeyStatus.error = `"${key}" isn't a shortcut Electron understands: ${err.message}`; }
  }
  broadcast('settings:changed', pageSettings());
}

// ---------------------------------------------------------------- notifications
// A long command that finished while Loom wasn't in front. Clicking it brings
// back its tab and card.
const notified = [];
let smokeFocus = null;
const loomFocused = () => (smokeFocus != null ? smokeFocus : !!BrowserWindow.getFocusedWindow());
ipcMain.handle('app:focused', () => loomFocused());
ipcMain.handle('notify', (e, { title, body, cid, id }) => {
  if (!settings().notifications || loomFocused()) return false;
  const w = winOf(e.sender);
  notified.push({ title, body, cid, id });
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => {
    if (!w || w.isDestroyed()) return;
    if (w === dropWin) showDropdown(); else showMain();
    w.webContents.send('notify:click', { cid, id });
  });
  n.show();
  return true;
});

// ---------------------------------------------------------------- integrations
const binDirs = () => (process.env.LOOM_BIN_DIRS ? process.env.LOOM_BIN_DIRS.split(path.delimiter) : SMOKE ? ['~/.local/bin'] : ['/usr/local/bin', '~/.local/bin']);
// The installed app links `loom` to its own Resources/bin/loom, which finds
// the app from where it is; an AppImage gets a script that runs the AppImage
// file (its path stays put across updates). A checkout gets a script that
// runs Electron on the project folder.
function launcherSpec() {
  if (app.isPackaged && process.env.APPIMAGE) return { script: Launcher.launcherScript({ app: process.env.APPIMAGE }) };
  if (app.isPackaged) return { link: path.join(process.resourcesPath, 'bin', 'loom') };
  return { script: Launcher.launcherScript({ app: process.execPath, appDir: app.getAppPath() }) };
}
function integrationStatus() {
  const launcher = Launcher.installed({ dirs: binDirs() });
  return {
    platform: process.platform,
    launcher,
    onPath: launcher ? loginPath.split(':').includes(path.dirname(launcher)) : false,
    quickAction: isMac && fs.existsSync(Launcher.workflowPath()),
    linux: process.platform === 'linux' && fs.existsSync(path.join(os.homedir(), '.local', 'share', 'applications', 'loom.desktop')),
  };
}
ipcMain.handle('integrations:status', () => integrationStatus());

// The app's icon as a file, for Linux .desktop entries.
function linuxIcon() {
  const src = app.isPackaged ? path.join(process.resourcesPath, 'icons', 'loom.png') : path.join(__dirname, 'build', 'icons', '512x512.png');
  const dest = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor', '512x512', 'apps', 'loom.png');
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest); return 'loom'; } catch { return 'utilities-terminal'; }
}

// An AppImage isn't in the applications menu until something adds it. Loom
// offers once (AppImageLauncher users already have it).
ipcMain.handle('appimage:offer', () => {
  if (!process.env.APPIMAGE || settings().appImageOffered) return null;
  writeSettings({ ...settings(), appImageOffered: true });
  if (fs.existsSync(path.join(os.homedir(), '.local', 'share', 'applications', 'loom.desktop'))) return null;
  return { path: process.env.APPIMAGE };
});
ipcMain.handle('appimage:integrate', async () => {
  try {
    const launcher = Launcher.installed({ dirs: binDirs() }) || (await installIntegration('launcher')).file;
    const files = Launcher.installLinux(launcher, { icon: linuxIcon() });
    execFile('update-desktop-database', [path.join(os.homedir(), '.local', 'share', 'applications')], () => {});
    return { ok: true, files };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---------------------------------------------------------------- .env, about, debug info
ipcMain.handle('env:open', async () => {
  const f = dotenvFile();
  if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Env.DOTENV_TEMPLATE, { mode: 0o600 }); }
  // .env has no app of its own: macOS's default text editor, else the system's choice.
  if (isMac) { execFile('open', ['-t', f], () => {}); return ''; }
  return shell.openPath(f);
});

let shellVersion = '';
function debugInfo() {
  const osName = isMac ? `macOS ${process.getSystemVersion()}` : isWin ? `Windows ${os.release()}` : `${os.type()} ${os.release()}`;
  return [
    `Loom ${app.getVersion()} (${app.isPackaged ? (process.env.APPIMAGE ? 'AppImage' : 'installed') : 'from source'})`,
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node} · V8 ${process.versions.v8}`,
    `OS: ${osName} (${process.arch})`,
    `Shell: ${pickShell()}${shellVersion ? ` — ${shellVersion}` : ''}${sessions ? '' : ' (one process per card)'}`,
  ].join('\n');
}
function readShellVersion() {
  if (isWin) return;
  execFile(pickShell(), ['--version'], { timeout: 3000 }, (_e, out) => { shellVersion = String(out || '').split('\n')[0].trim(); });
}
// A new GitHub issue with the versions filled in. Nothing is sent by itself.
function issueUrl(title = '', extra = '') {
  const body = `**What happened**\n\n\n**What you expected**\n\n\n**Steps to reproduce**\n1. \n\n${extra}**Environment**\n\`\`\`\n${debugInfo()}\n\`\`\`\n`;
  return `${REPO_URL}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}
function showAbout(w) {
  const icon = (() => { try { return nativeImage.createFromPath(app.isPackaged ? path.join(process.resourcesPath, 'icons', 'loom.png') : path.join(__dirname, 'build', 'icons', '256x256.png')); } catch { return undefined; } })();
  dialog.showMessageBox(w || null, {
    type: 'info', icon, title: 'About Loom', message: `Loom ${app.getVersion()}`,
    detail: `A spatial terminal: every command is a card.\n\nElectron ${process.versions.electron}\nChromium ${process.versions.chrome}\nNode ${process.versions.node}\n\n${REPO_URL}`,
    buttons: ['OK', 'Open on GitHub', 'Copy Debug Info'], defaultId: 0, cancelId: 0,
  }).then(({ response }) => {
    if (response === 1) shell.openExternal(REPO_URL);
    if (response === 2) clipboard.writeText(debugInfo());
  });
}
// Automatic updates arrive with signed releases; until then, the release page.
function checkForUpdates(w) {
  dialog.showMessageBox(w || null, {
    type: 'info', title: 'Check for Updates', message: `You have Loom ${app.getVersion()}.`,
    detail: `Updates are available at ${REPO_URL}/releases`, buttons: ['OK', 'Open Releases'], defaultId: 1, cancelId: 0,
  }).then(({ response }) => { if (response === 1) shell.openExternal(`${REPO_URL}/releases`); });
}
ipcMain.handle('app:debugInfo', () => debugInfo());
ipcMain.handle('app:about', (e) => showAbout(winOf(e.sender)));
ipcMain.handle('app:reportIssue', () => shell.openExternal(issueUrl()));
async function installIntegration(what) {
  if (what === 'launcher') {
    const res = Launcher.install({ ...launcherSpec(), dirs: binDirs(), pathEnv: loginPath });
    return { ...res, message: res.onPath ? `Installed ${res.file}. Run \`loom .\` in any folder.` : `Installed ${res.file}, but ${res.dir} isn't on your PATH. Add it in your shell's rc file: export PATH="${res.dir}:$PATH"` };
  }
  const launcher = Launcher.installed({ dirs: binDirs() }) || (await installIntegration('launcher')).file;
  if (what === 'finder') {
    if (!isMac) throw new Error('the Finder Quick Action is macOS only');
    const dir = Launcher.installQuickAction(launcher);
    execFile('/System/Library/CoreServices/pbs', ['-flush'], () => {});
    return { file: dir, message: 'Added "Open in Loom" to Finder\'s Quick Actions and Services menus (right-click a folder).' };
  }
  if (what === 'linux') {
    if (process.platform !== 'linux') throw new Error('these are for Linux file managers');
    const files = Launcher.installLinux(launcher, { icon: linuxIcon() });
    execFile('update-desktop-database', [path.join(os.homedir(), '.local', 'share', 'applications')], () => {});
    return { files, message: 'Added "Open in Loom" for Files (Nautilus), Nemo and Dolphin, and Loom as a folder handler.' };
  }
  throw new Error(`nothing called ${what}`);
}
ipcMain.handle('integrations:install', async (_e, what) => {
  try { return { ok: true, ...(await installIntegration(what)), status: integrationStatus() }; } catch (err) { return { ok: false, error: err.message, status: integrationStatus() }; }
});
ipcMain.handle('integrations:uninstall', (_e, what) => {
  let removed = [];
  if (what === 'launcher') removed = Launcher.uninstall({ dirs: binDirs() });
  if (what === 'finder') removed = [Launcher.uninstallQuickAction()].filter(Boolean);
  if (what === 'linux') removed = Launcher.uninstallLinux();
  return { ok: true, removed, status: integrationStatus() };
});

// ---------------------------------------------------------------- application menu
// Items run renderer commands, so a rebinding shows here too. The keys are
// the renderer's to handle (registerAccelerator: false), which keeps them
// away from programs in live terminals that own them.
let menuKeys = {};
ipcMain.handle('menu:keys', (_e, keys) => { menuKeys = keys || {}; buildMenu(); return true; });
function buildMenu() {
  const run = (id) => (_item, w) => {
    const target = w && !w.isDestroyed() ? w : (BrowserWindow.getFocusedWindow() || showMain());
    target.webContents.send('command:run', id);
  };
  const item = (id, label) => ({ label, click: run(id), ...(menuKeys[id] ? { accelerator: menuKeys[id], registerAccelerator: false } : {}) });
  const editRole = (role) => (isMac ? { role } : { role, registerAccelerator: false });
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { label: 'About Loom', click: (_i, w) => showAbout(w) },
        { label: 'Check for Updates…', click: (_i, w) => checkForUpdates(w) },
        { type: 'separator' },
        item('settings.open', 'Settings…'),
        item('loom.installCommand', "Install 'loom' command in PATH"),
        item('loom.uninstallCommand', "Uninstall 'loom' command"),
        { type: 'separator' }, { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        item('tab.new', 'New Tab'), item('tab.openFolder', 'Open Folder in New Tab…'), item('tab.reopen', 'Reopen Closed Tab'),
        item('canvas.newRoot', 'New Root'), { type: 'separator' }, item('tab.close', 'Close Tab'),
        ...(isMac ? [] : [{ type: 'separator' }, item('settings.open', 'Settings…'), item('loom.installCommand', "Install 'loom' command in PATH"), { label: 'Check for Updates…', click: (_i, w) => checkForUpdates(w) }, { role: 'quit' }]),
      ],
    },
    { label: 'Edit', submenu: ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].map(editRole) },
    {
      label: 'View',
      submenu: [
        item('palette.open', 'Command Palette…'), item('view.map', 'History Map'), { type: 'separator' },
        item('view.fit', 'Fit Everything'), item('view.zoomIn', 'Zoom In'), item('view.zoomOut', 'Zoom Out'), { type: 'separator' },
        item('font.bigger', 'Bigger Text'), item('font.smaller', 'Smaller Text'), item('font.reset', 'Default Text Size'), { type: 'separator' },
        item('dropdown.toggle', 'Dropdown Terminal'), { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Window',
      submenu: [item('tab.next', 'Next Tab'), item('tab.prev', 'Previous Tab'), { type: 'separator' }, { role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [])],
    },
    {
      role: 'help',
      submenu: [
        item('palette.open', 'All Commands…'),
        { type: 'separator' },
        { label: 'Report an Issue…', click: () => shell.openExternal(issueUrl()) },
        { label: 'Copy Debug Info', click: () => clipboard.writeText(debugInfo()) },
        { label: 'Loom on GitHub', click: () => shell.openExternal(REPO_URL) },
        ...(isMac ? [] : [{ type: 'separator' }, { label: 'About Loom', click: (_i, w) => showAbout(w) }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- quitting
// Asks first when commands are still running, in any tab.
function quitPrompt() {
  const list = [...runningCards.values()];
  if (!list.length || !settings().confirmQuit) return null;
  return {
    message: `${list.length} command${list.length === 1 ? ' is' : 's are'} still running`,
    detail: `Quitting stops ${list.length === 1 ? 'it' : 'them'}:\n${list.slice(0, 12).map((c) => `  ${c.command.split('\n')[0].slice(0, 80)}`).join('\n')}${list.length > 12 ? `\n  …and ${list.length - 12} more` : ''}`,
  };
}
app.on('before-quit', (e) => {
  if (!quitting && !SMOKE) {
    const p = quitPrompt();
    if (p) {
      const choice = dialog.showMessageBoxSync(mainWin && mainWin.isVisible() ? mainWin : null, { type: 'warning', buttons: ['Quit', 'Cancel'], defaultId: 1, cancelId: 1, message: p.message, detail: p.detail });
      if (choice !== 0) { e.preventDefault(); return; }
    }
  }
  quitting = true;
  flushCanvases();
  saveWinState();
  if (outputs) outputs.shutdown();
  if (sessions) sessions.shutdown();
  for (const p of procs.values()) {
    try { isWin ? p.child.kill() : process.kill(-p.child.pid, 'SIGTERM'); } catch { /* gone */ }
  }
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (!isMac || SMOKE) app.quit(); });

// ---------------------------------------------------------------- sys
ipcMain.handle('sys:info', (e) => ({
  platform: process.platform,
  window: kindOf(e.sender),
  home: SMOKE && process.env.LOOM_SMOKE_CWD ? process.env.LOOM_SMOKE_CWD : os.homedir(),
  realHome: os.homedir(),
  user: os.userInfo().username,
  shell: path.basename(pickShell()),
  smoke: !!SMOKE,
  bench: BENCH,
  procStart: PROC_START,
  smokeResume: !!process.env.LOOM_SMOKE_RESUME,
  smokeMigrate: !!process.env.LOOM_SMOKE_MIGRATE,
  smokeLauncher: !!process.env.LOOM_SMOKE_LAUNCHER,
  smokePackaged: !!process.env.LOOM_SMOKE_PACKAGED,
  packaged: app.isPackaged,
  appImage: !!process.env.APPIMAGE,
  e2e: SMOKE ? { sudoPass: process.env.E2E_SUDO_PASS || '', ssh: !!process.env.E2E_SSH } : null,
  sessions: !!sessions,
}));

// ---------------------------------------------------------------- e2e and bench
const smokeWin = (e) => winOf(e.sender);
// Real keyboard input for the e2e run. Each key is a character or a keyCode,
// optionally with modifiers, so it goes through the page's focus and key handlers.
ipcMain.handle('smoke:keys', async (e, keys) => {
  const w = smokeWin(e);
  if (!SMOKE || !w) return;
  w.webContents.focus();
  for (const k of keys) {
    const { key, modifiers = /^[A-Z]$/.test(k) ? ['shift'] : [] } = typeof k === 'string' ? { key: k } : k;
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
    if (key.length === 1 && !modifiers.includes('control') && !modifiers.includes('meta')) {
      w.webContents.sendInputEvent({ type: 'char', keyCode: key, modifiers });
    }
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
    await new Promise((r) => setTimeout(r, 15));
  }
});
ipcMain.handle('smoke:mouse', (e, ev) => { if (SMOKE) smokeWin(e).webContents.sendInputEvent(ev); });

ipcMain.handle('smoke:copy', (e) => { if (SMOKE) smokeWin(e).webContents.copy(); });
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

ipcMain.handle('smoke:resize', (e, { width, height }) => { if (SMOKE) smokeWin(e).setSize(width, height); });

// A real paste, through the clipboard and the page's paste event.
ipcMain.handle('smoke:paste', (e, text) => {
  if (!SMOKE) return;
  clipboard.writeText(text);
  smokeWin(e).webContents.paste();
});
ipcMain.handle('smoke:theme', (_e, source) => { if (SMOKE) nativeTheme.themeSource = source; });
ipcMain.handle('smoke:focus', (_e, focused) => { if (SMOKE) smokeFocus = focused; });
ipcMain.handle('smoke:state', () => SMOKE && {
  notified, quit: quitPrompt(), hotkey: hotkeyStatus,
  dropdown: dropWin ? { visible: dropWin.isVisible(), animating: dropAnimating, bounds: dropWin.getBounds(), workArea: screen.getDisplayMatching(dropWin.getBounds()).workArea } : null,
  windows: windows().length,
});
ipcMain.handle('smoke:hotkey', () => { if (SMOKE) toggleDropdown(); });
// Writes settings.json as an editor would, for the validation check.
ipcMain.handle('smoke:writeSettings', (_e, text) => { if (SMOKE) fs.writeFileSync(file('settings.json'), text); });
ipcMain.handle('smoke:quit', () => { if (SMOKE) { quitting = true; app.quit(); } });
ipcMain.handle('smoke:dropdownRun', async (_e, cmd) => {
  if (!SMOKE || !dropWin) return null;
  return dropWin.webContents.executeJavaScript(`window.__loomSmoke && window.__loomSmoke(${JSON.stringify(cmd)})`);
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

// test/e2e.js reads these lines, from stdout or, for an app started with
// `open`, from LOOM_SMOKE_REPORT.
const smokeLog = (line) => {
  console.log(line);
  if (process.env.LOOM_SMOKE_REPORT) fs.appendFileSync(process.env.LOOM_SMOKE_REPORT, `${line}\n`);
};
ipcMain.handle('smoke:report', (_e, results) => {
  if (!SMOKE) return;
  for (const r of results) smokeLog(`[e2e] ${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ` :: ${r.detail}`}`);
  smokeLog(`[e2e] END ${results.length}`);
});
ipcMain.handle('smoke:log', (_e, line) => { if (SMOKE) smokeLog(String(line)); });
ipcMain.handle('smoke:packaged', () => SMOKE && {
  packaged: app.isPackaged, loginPath, dotenv: dotenvFile(), resources: process.resourcesPath, exe: process.execPath, debug: debugInfo(),
});

ipcMain.handle('smoke:done', async (e, opts = {}) => {
  const w = smokeWin(e);
  if (!SMOKE || !w) return;
  const img = await w.webContents.capturePage();
  fs.writeFileSync(opts.suffix ? SMOKE.replace(/\.png$/, `-${opts.suffix}.png`) : SMOKE, img.toPNG());
  if (!opts.keep) { quitting = true; app.quit(); }
});

// ---------------------------------------------------------------- start
if (!SMOKE && primary) {
  if (process.defaultApp) app.setAsDefaultProtocolClient('loom', process.execPath, [path.resolve(process.argv[1] || '.')]);
  else app.setAsDefaultProtocolClient('loom');
}

app.whenReady().then(async () => {
  if (!primary) return;
  readSettings();
  watchSettings();
  history = createHistory(file('history.jsonl'));
  startOutputs();
  startTabs();
  loadThemes();
  watchThemes();
  keysText = (() => { try { return fs.readFileSync(keysFile(), 'utf8'); } catch { return ''; } })();
  watchKeys();
  // Local font access, for the font picker.
  const allowed = ['local-fonts', 'notifications', 'clipboard-sanitized-write'];
  electronSession.defaultSession.setPermissionCheckHandler((_wc, perm) => allowed.includes(perm));
  electronSession.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(allowed.includes(perm)));
  nativeTheme.on('updated', () => broadcast('themes:changed', themeList()));
  if (SMOKE && process.env.LOOM_THEME) nativeTheme.themeSource = process.env.LOOM_THEME;
  await resolveLoginPath();
  readShellVersion();
  startSessions();
  shellInfo = createShellInfo({ shell: pickShell(), env: () => cmdEnv({ plain: true }), sessions });
  if (!isWin) shellInfo.probeBase();
  buildMenu();
  createMainWindow();
  registerHotkey();
  // The dropdown loads in the background, so the hotkey shows it at once.
  if (!BENCH) setTimeout(() => { if (!dropWin) createDropdown(); }, SMOKE ? 0 : 1500);
  if (hasRequest(launchArgs)) handleOpen(launchArgs);
  for (const a of pendingOpens.splice(0)) handleOpen(a);
  // Warm the specs people reach for first.
  setTimeout(() => { for (const n of ['git', 'npm', 'docker']) completer.loadSpec(n); }, 3000);
  app.on('activate', () => showMain());
});
