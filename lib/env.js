'use strict';
// Loom — the environment an app launched from Finder, the Dock or a desktop
// launcher doesn't get: the login shell's PATH (with a fallback when rc files
// are slow or broken), a UTF-8 locale, and .env values.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ---------------------------------------------------------------- .env
// KEY=value lines; `export`, quotes, escapes in double quotes, and # comments.
function parseDotenv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"')) {
      const end = v.indexOf('"', 1);
      v = (end > 0 ? v.slice(1, end) : v.slice(1)).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (v.startsWith("'")) {
      const end = v.indexOf("'", 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
}

// Where .env lives: the project folder from a checkout, userData when packaged
// (an app never reads a .env from inside its own bundle).
const dotenvPath = ({ packaged, appPath, userData }) => (packaged ? path.join(userData, '.env') : path.join(appPath, '.env'));

function readDotenv(file) {
  try { return parseDotenv(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

const DOTENV_TEMPLATE = `# Loom reads this file when it starts and whenever it needs a key.
# Values here stay with Loom: they aren't passed to the shells in your tabs.
#
# ANTHROPIC_API_KEY=your-key-here
`;

// ---------------------------------------------------------------- PATH
// Folders where tools usually live, for when the login shell can't be asked.
function fallbackDirs(home, { exists = fs.existsSync, platform = process.platform } = {}) {
  const dirs = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin',
    path.join(home, '.local', 'bin'), path.join(home, 'bin'), path.join(home, '.cargo', 'bin'),
    path.join(home, '.pyenv', 'shims'), path.join(home, '.pyenv', 'bin'), path.join(home, '.rbenv', 'shims'),
    path.join(home, '.volta', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.deno', 'bin'),
    path.join(home, 'go', 'bin'), path.join(home, '.asdf', 'shims'), path.join(home, '.nix-profile', 'bin'),
    ...(platform === 'linux' ? ['/snap/bin', '/home/linuxbrew/.linuxbrew/bin'] : []),
  ];
  // nvm: the newest installed node.
  try {
    const versions = path.join(home, '.nvm', 'versions', 'node');
    const parts = (v) => v.slice(1).split('.').map(Number);
    const newer = (a, b) => { const x = parts(a); const y = parts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (y[i] || 0) - (x[i] || 0); return 0; };
    const list = fs.readdirSync(versions).filter((v) => /^v\d/.test(v)).sort(newer);
    if (list[0]) dirs.push(path.join(versions, list[0], 'bin'));
  } catch { /* no nvm */ }
  return dirs.filter((d) => exists(d));
}

// The probed PATH first, then what the process had, then the fallbacks; no repeats.
function mergePath(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const d of (Array.isArray(list) ? list : String(list || '').split(':'))) {
      if (d && !seen.has(d)) { seen.add(d); out.push(d); }
    }
  }
  return out.join(':');
}

// Asks the login shell for its PATH. Interactive and plain login shells run at
// once, and the first good answer wins; a shell that hangs on its rc files is
// killed at `timeout` and the fallbacks are used.
function probeLoginPath(shell, { timeout = 4000, env = process.env } = {}) {
  const mark = '__LOOM_PATH__';
  const probe = (flags) => new Promise((resolve) => {
    const child = execFile(shell, [flags, `printf '${mark}%s${mark}' "$PATH"`], { timeout, env, killSignal: 'SIGKILL' }, (_err, out) => {
      const m = new RegExp(`${mark}(.*?)${mark}`, 's').exec(out || '');
      resolve(m && m[1].includes('/') ? m[1] : null);
    });
    if (child.stdin) child.stdin.end(); // an rc that reads stdin gets EOF, not a hang
  });
  const interactive = probe('-ilc');
  const login = probe('-lc');
  // The interactive one sees what a terminal would (nvm and pyenv init live
  // in .zshrc and .bashrc); a login shell is the fallback.
  return interactive.then((p) => p || login);
}

// A UTF-8 locale when the app was launched without one (macOS apps are).
function localeEnv(env, { platform = process.platform } = {}) {
  if (env.LANG || env.LC_ALL || env.LC_CTYPE) return {};
  return { LANG: platform === 'darwin' || platform === 'linux' ? 'en_US.UTF-8' : 'C.UTF-8' };
}

module.exports = { parseDotenv, readDotenv, dotenvPath, DOTENV_TEMPLATE, fallbackDirs, mergePath, probeLoginPath, localeEnv };
