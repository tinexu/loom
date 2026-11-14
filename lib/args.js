'use strict';
// Loom — command-line arguments, from a first launch, a second launch that
// forwards to the running Loom, the `loom` launcher, or a loom:// URL.
//   loom [folder] [--new-tab] [--dropdown] [--cwd <dir>] [-e <command> [args…]]
// -e takes the rest of the line, as xterm's does, so Loom can be Debian's
// x-terminal-emulator: one argument is shell code (`-e "npm test"`), several
// are a program and its arguments (`-e vim notes.txt`). -T <title> is accepted
// and ignored. File managers pass folders as file:// URIs. Unknown switches are
// Chromium's or macOS's (--no-sandbox, -psn_0_123) and are ignored.
const path = require('path');
const os = require('os');

// The arguments a person typed, without the binary and, when running from a
// checkout (`electron .`), the app folder.
function userArgs(argv, { defaultApp = false } = {}) {
  const rest = argv.slice(1);
  if (defaultApp) {
    // electron [switches] <app> [args]: the first non-switch is the app.
    const i = rest.findIndex((a) => !a.startsWith('-'));
    return i < 0 ? [] : rest.slice(i + 1);
  }
  return rest;
}

const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
const expandHome = (p, home) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p);

// loom://open?path=/x&exec=npm%20test&newTab=1&dropdown=1
function parseUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'loom:') return null;
  const action = (u.hostname || u.pathname.replace(/^\/+/, '')).toLowerCase();
  if (action && action !== 'open') return null;
  const q = u.searchParams;
  const on = (k) => ['1', 'true', 'yes'].includes(String(q.get(k)).toLowerCase());
  return { folder: q.get('path') || null, exec: q.get('exec') || null, newTab: on('newTab') || on('new-tab'), dropdown: on('dropdown') };
}

// Returns { folder, newTab, dropdown, exec, cwd }. `folder` is absolute; a
// command or --new-tab with no folder opens the folder Loom was run from.
function parseArgs(args, { cwd = process.cwd(), home = os.homedir() } = {}) {
  const out = { folder: null, newTab: false, dropdown: false, exec: null, cwd };
  const value = (a, i, name) => (a.startsWith(`${name}=`) ? [a.slice(name.length + 1), i] : [args[i + 1], i + 1]);
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--new-tab') out.newTab = true;
    else if (a === '--dropdown') out.dropdown = true;
    else if (a === '-e' || a === '-x' || a === '--exec' || a.startsWith('--exec=')) {
      if (a.startsWith('--exec=')) { out.exec = a.slice(7); continue; }
      const rest = args.slice(i + 1).map(String);
      if (rest.length) out.exec = rest.length === 1 ? rest[0] : rest.map(shq).join(' ');
      break;
    } else if (a === '-T' || a === '--title') i++;
    else if (a.startsWith('file://')) {
      if (!out.folder) { try { out.folder = decodeURIComponent(new URL(a).pathname); } catch { /* not a URL */ } }
    } else if (a === '--cwd' || a.startsWith('--cwd=')) {
      const [v, j] = value(a, i, '--cwd');
      if (v) out.cwd = path.resolve(expandHome(String(v), home));
      i = j;
    } else if (a.startsWith('loom://')) {
      const u = parseUrl(a);
      if (u) {
        if (u.folder) out.folder = u.folder;
        if (u.exec) out.exec = u.exec;
        out.newTab = out.newTab || u.newTab;
        out.dropdown = out.dropdown || u.dropdown;
      }
    } else if (a === '--') {
      // Everything after -- is a folder.
      if (!out.folder && args[i + 1] != null) out.folder = String(args[i + 1]);
      break;
    } else if (a.startsWith('-')) {
      // Someone else's switch.
    } else if (!out.folder) out.folder = a;
  }
  if (out.folder) out.folder = path.resolve(out.cwd, expandHome(out.folder, home));
  else if (out.exec != null || out.newTab) out.folder = out.cwd;
  return out;
}

// Anything to do, beyond bringing Loom to the front?
const hasRequest = (a) => !!(a && (a.folder || a.exec != null || a.newTab || a.dropdown));

module.exports = { parseArgs, parseUrl, userArgs, hasRequest };
