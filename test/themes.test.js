'use strict';
// Unit tests for lib/themes.js: import, derived tokens, contrast. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const T = require('../lib/themes');

const comp = (r, g, b) => `<dict>
  <key>Alpha Component</key><real>1</real>
  <key>Blue Component</key><real>${b}</real>
  <key>Color Space</key><string>sRGB</string>
  <key>Green Component</key><real>${g}</real>
  <key>Red Component</key><real>${r}</real>
</dict>`;
function itermcolors() {
  let body = '';
  for (let i = 0; i < 16; i++) body += `<key>Ansi ${i} Color</key>${comp(i / 15, 0.5, 1 - i / 15)}\n`;
  body += `<key>Background Color</key>${comp(0, 0, 0)}<key>Foreground Color</key>${comp(1, 1, 1)}<key>Cursor Color</key>${comp(1, 0, 0)}<key>Selection Color</key>${comp(0.2, 0.2, 0.2)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>`;
}

test('contrast: the WCAG numbers', () => {
  assert.strictEqual(Math.round(T.contrast('#000000', '#ffffff')), 21);
  assert.strictEqual(T.contrast('#777777', '#777777'), 1);
  assert.ok(Math.abs(T.contrast('#767676', '#ffffff') - 4.54) < 0.02);
  // A translucent color is laid over the background first.
  assert.ok(T.contrast('rgba(0, 0, 0, 0.5)', '#ffffff') < 5);
});

test('check: flags each pair under 4.5:1', () => {
  const ok = T.normalize({ name: 'Plain', background: '#ffffff', foreground: '#111111', ansi: Array(16).fill('#336699') });
  assert.deepStrictEqual(ok.contrast, []);
  const low = T.normalize({ name: 'Low', background: '#fdf6e3', foreground: '#93a1a1', ansi: Array(16).fill('#268bd2') });
  assert.ok(low.contrast.some((c) => c.what === 'Text on cards' && c.ratio < 4.5));
  assert.strictEqual(low.type, 'light');
});

test('built-ins: six, all complete, Loom’s own pass AA', () => {
  const { themes, errors } = T.loadAll(path.join(__dirname, '..', 'themes'), '/nonexistent');
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual([...themes.keys()].sort(), ['gruvbox-dark', 'loom-dark', 'loom-light', 'nord', 'solarized-dark', 'solarized-light']);
  for (const t of themes.values()) for (const k of T.UI_TOKENS) assert.ok(t.ui[k], `${t.id} ${k}`);
  assert.deepStrictEqual(themes.get('loom-dark').contrast, []);
  assert.deepStrictEqual(themes.get('loom-light').contrast, []);
});

test('import: .itermcolors', () => {
  const raw = T.parseItermcolors(itermcolors(), 'My Scheme');
  assert.strictEqual(raw.ansi.length, 16);
  assert.strictEqual(raw.ansi[0], '#0080ff');
  assert.strictEqual(raw.ansi[15], '#ff8000');
  assert.strictEqual(raw.background, '#000000');
  assert.strictEqual(raw.cursor, '#ff0000');
  const t = T.normalize(raw);
  assert.strictEqual(t.type, 'dark');
  assert.strictEqual(t.ui['--card'], '#000000');
  assert.throws(() => T.parseItermcolors('<plist><dict></dict></plist>'), /Ansi/);
  assert.strictEqual(T.importFile('/x/Night Owl.itermcolors', itermcolors())[0].name, 'Night Owl');
});

test('import: Windows Terminal schemes, single or from settings.json', () => {
  const scheme = {
    name: 'Campbell', background: '#0C0C0C', foreground: '#CCCCCC', cursorColor: '#FFFFFF', selectionBackground: '#FFFFFF',
    black: '#0C0C0C', red: '#C50F1F', green: '#13A10E', yellow: '#C19C00', blue: '#0037DA', purple: '#881798', cyan: '#3A96DD', white: '#CCCCCC',
    brightBlack: '#767676', brightRed: '#E74856', brightGreen: '#16C60C', brightYellow: '#F9F1A5', brightBlue: '#3B78FF', brightPurple: '#B4009E', brightCyan: '#61D6D6', brightWhite: '#F2F2F2',
  };
  const [one] = T.parseWindowsTerminal(scheme);
  assert.strictEqual(one.name, 'Campbell');
  assert.strictEqual(one.ansi[5], '#881798');
  assert.strictEqual(one.ansi[13], '#B4009E');
  const many = T.importFile('/x/settings.json', `// comment\n${JSON.stringify({ profiles: {}, schemes: [scheme, { ...scheme, name: 'Two' }] })}`);
  assert.deepStrictEqual(many.map((s) => s.name), ['Campbell', 'Two']);
  assert.throws(() => T.parseWindowsTerminal({ name: 'Broken', black: '#000' }), /missing colors/);
  assert.ok(T.normalize(one).ui['--accent']);
});
