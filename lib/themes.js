'use strict';
// Loom — themes. A theme is JSON: a name, light or dark, a terminal scheme
// (background, foreground, cursor, selection, 16 ANSI colors) and optional
// UI tokens (the CSS variables in renderer/styles.css). Tokens a theme leaves
// out are derived from its scheme, so an imported terminal scheme is a whole
// theme. Built-ins live in themes/, a person's in userData/themes/.
const fs = require('fs');
const path = require('path');

const UI_TOKENS = ['--bg', '--grid', '--panel', '--card', '--card-2', '--hover', '--line', '--line-2', '--text', '--muted', '--faint',
  '--accent', '--accent-soft', '--accent-ink', '--err', '--err-soft', '--err-text', '--warn', '--info', '--shadow', '--mm-ok', '--mm-view',
  '--tk-cmd', '--tk-bad', '--tk-flag', '--tk-str', '--tk-var', '--tk-op', '--tk-comment', '--tk-glob', '--tk-heredoc', '--ghost'];

// ---------------------------------------------------------------- colors
function parseColor(c) {
  if (typeof c !== 'string') return null;
  let m = /^#([0-9a-f]{3,8})$/i.exec(c.trim());
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(c.trim());
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] };
  return null;
}
const hex2 = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
const toHex = ({ r, g, b }) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const rgba = (c, a) => { const p = parseColor(c); return `rgba(${p.r}, ${p.g}, ${p.b}, ${a})`; };
// `t` of the way from a to b.
function mix(a, b, t) {
  const x = parseColor(a); const y = parseColor(b);
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}
function luminance(c) {
  const p = parseColor(c);
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(p.r) + 0.7152 * lin(p.g) + 0.0722 * lin(p.b);
}
// WCAG contrast ratio, 1 to 21. A translucent foreground is laid over the background first.
function contrast(fg, bg) {
  const f = parseColor(fg); const b = parseColor(bg);
  if (!f || !b) return 0;
  const over = f.a < 1 ? toHex({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a) }) : fg;
  const l1 = luminance(over); const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ---------------------------------------------------------------- themes
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'theme';

// Fills in the UI tokens a theme doesn't set, from its terminal scheme.
function derive(t) {
  const dark = t.type !== 'light';
  const bg = t.background; const fg = t.foreground; const a = t.ansi;
  const canvas = dark ? mix(bg, '#000000', 0.28) : mix(bg, '#000000', 0.04);
  const accent = a[2];
  const ui = {
    '--bg': canvas,
    '--grid': rgba(fg, dark ? 0.06 : 0.09),
    '--panel': mix(canvas, bg, 0.5),
    '--card': bg,
    '--card-2': mix(bg, fg, dark ? 0.05 : 0.035),
    '--hover': rgba(fg, 0.06),
    '--line': mix(bg, fg, dark ? 0.13 : 0.12),
    '--line-2': mix(bg, fg, dark ? 0.22 : 0.2),
    '--text': fg,
    // Secondary text gets as close to the background as AA allows.
    '--muted': [0.28, 0.2, 0.13, 0.06, 0].map((k) => mix(fg, bg, k)).find((c) => contrast(c, bg) >= 4.5) || fg,
    '--faint': mix(fg, bg, 0.5),
    '--accent': accent,
    '--accent-soft': rgba(accent, 0.13),
    '--accent-ink': contrast('#ffffff', accent) >= contrast('#000000', accent) ? '#ffffff' : mix(bg, '#000000', 0.6),
    '--err': a[1],
    '--err-soft': rgba(a[1], 0.1),
    '--err-text': dark ? a[9] : a[1],
    '--warn': a[3],
    '--info': a[4],
    '--shadow': dark ? '0 1px 0 rgba(255, 255, 255, 0.03) inset, 0 14px 34px -14px rgba(0, 0, 0, 0.7)' : '0 1px 2px rgba(20, 24, 30, 0.05), 0 12px 28px -14px rgba(20, 24, 30, 0.22)',
    '--mm-ok': mix(bg, fg, 0.3),
    '--mm-view': rgba(accent, 0.85),
    '--tk-cmd': fg,
    '--tk-bad': a[1],
    '--tk-flag': a[4],
    '--tk-str': a[2],
    '--tk-var': a[3],
    '--tk-op': a[5],
    '--tk-comment': mix(fg, bg, 0.5),
    '--tk-glob': a[9],
    '--tk-heredoc': a[6],
    '--ghost': mix(fg, bg, 0.55),
  };
  return { ...ui, ...(t.ui || {}) };
}

// Checks and completes a theme. Throws with a reason if it can't be used.
function normalize(raw, { id, builtin = false, file = null } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('not a JSON object');
  const name = String(raw.name || '').trim();
  if (!name) throw new Error('no "name"');
  if (!Array.isArray(raw.ansi) || raw.ansi.length !== 16 || !raw.ansi.every(parseColor)) throw new Error('"ansi" must be 16 colors');
  for (const k of ['background', 'foreground']) if (!parseColor(raw[k])) throw new Error(`"${k}" must be a color`);
  const type = raw.type === 'light' || raw.type === 'dark' ? raw.type : luminance(raw.background) > 0.4 ? 'light' : 'dark';
  const t = {
    id: id || slug(name), name, type, builtin, file,
    background: raw.background, foreground: raw.foreground,
    cursor: parseColor(raw.cursor) ? raw.cursor : raw.foreground,
    cursorAccent: parseColor(raw.cursorAccent) ? raw.cursorAccent : raw.background,
    selection: parseColor(raw.selection) ? raw.selection : rgba(raw.ansi[4], 0.3),
    ansi: raw.ansi.slice(),
    ui: raw.ui && typeof raw.ui === 'object' ? raw.ui : {},
  };
  t.ui = derive(t);
  t.contrast = check(t);
  return t;
}

// WCAG AA (4.5:1) for body text: text on cards and the canvas, secondary
// text, the command bar, and the terminal's own foreground.
function check(t) {
  const ui = t.ui;
  const pairs = [
    ['Text on cards', ui['--text'], ui['--card']],
    ['Text on the canvas', ui['--text'], ui['--bg']],
    ['Secondary text', ui['--muted'], ui['--card']],
    ['Command bar', ui['--tk-cmd'], ui['--card-2']],
    ['Terminal text', t.foreground, t.background],
  ];
  return pairs.map(([what, fg, bg]) => ({ what, fg, bg, ratio: Math.round(contrast(fg, bg) * 100) / 100, ok: contrast(fg, bg) >= 4.5 }))
    .filter((p) => !p.ok);
}

// ---------------------------------------------------------------- import
// iTerm2 .itermcolors: an XML plist of color dictionaries.
function parseItermcolors(xml, name = 'Imported') {
  const text = String(xml);
  if (!/<plist/.test(text)) throw new Error('not an .itermcolors plist');
  const color = (key) => {
    const re = new RegExp(`<key>\\s*${key.replace(/ /g, '\\s+')}\\s*</key>\\s*<dict>([\\s\\S]*?)</dict>`, 'i');
    const m = re.exec(text);
    if (!m) return null;
    const comp = (c) => {
      const r = new RegExp(`<key>\\s*${c}\\s+Component\\s*</key>\\s*<(?:real|integer)>\\s*([-\\d.eE]+)\\s*</(?:real|integer)>`, 'i').exec(m[1]);
      return r ? Math.max(0, Math.min(1, parseFloat(r[1]))) * 255 : 0;
    };
    return toHex({ r: comp('Red'), g: comp('Green'), b: comp('Blue') });
  };
  const ansi = Array.from({ length: 16 }, (_, i) => color(`Ansi ${i} Color`));
  if (ansi.some((c) => !c)) throw new Error('missing Ansi 0–15 colors');
  const background = color('Background Color');
  const foreground = color('Foreground Color');
  if (!background || !foreground) throw new Error('missing Background or Foreground Color');
  const sel = color('Selection Color');
  return { name, background, foreground, cursor: color('Cursor Color') || foreground, cursorAccent: color('Cursor Text Color') || background, selection: sel || undefined, ansi };
}

// Windows Terminal: a scheme object, an array of them, or a whole
// settings.json with "schemes".
function parseWindowsTerminal(json) {
  const data = typeof json === 'string' ? JSON.parse(json.replace(/^\s*\/\/.*$/gm, '')) : json;
  const list = Array.isArray(data) ? data : Array.isArray(data.schemes) ? data.schemes : [data];
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white'];
  const keys = [...names, ...names.map((n) => `bright${n[0].toUpperCase()}${n.slice(1)}`)];
  const out = list.map((s) => {
    if (!s || !keys.every((k) => parseColor(s[k]))) throw new Error(`scheme ${s && s.name ? `"${s.name}" ` : ''}is missing colors`);
    return {
      name: s.name || 'Imported', background: s.background, foreground: s.foreground,
      cursor: s.cursorColor || s.foreground, selection: s.selectionBackground || undefined, ansi: keys.map((k) => s[k]),
    };
  });
  if (!out.length) throw new Error('no color schemes');
  return out;
}

// Whatever the file is: a Loom theme, .itermcolors or Windows Terminal JSON.
function importFile(file, text = fs.readFileSync(file, 'utf8')) {
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  if (/\.itermcolors$/i.test(file) || /<plist/.test(text)) return [parseItermcolors(text, base)];
  const data = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
  if (Array.isArray(data.ansi)) return [data];
  return parseWindowsTerminal(data);
}

// ---------------------------------------------------------------- the set
// Built-ins, then user themes (which may replace a built-in by id). Bad user
// files are reported, not fatal.
function loadAll(builtinDir, userDir) {
  const themes = new Map();
  const errors = [];
  const read = (dir, builtin) => {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return; }
    for (const n of names) {
      const file = path.join(dir, n);
      try {
        const t = normalize(JSON.parse(fs.readFileSync(file, 'utf8')), { id: builtin ? n.replace(/\.json$/, '') : undefined, builtin, file });
        themes.set(t.id, t);
      } catch (err) { errors.push(`${n}: ${err.message}`); }
    }
  };
  read(builtinDir, true);
  read(userDir, false);
  return { themes, errors };
}

module.exports = { UI_TOKENS, parseColor, mix, contrast, luminance, derive, normalize, check, parseItermcolors, parseWindowsTerminal, importFile, loadAll, slug };
