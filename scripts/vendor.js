'use strict';
// Copies xterm and its addons to renderer/vendor/, so the page can load them
// with plain <script> tags under script-src 'self'. Runs from postinstall.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'renderer', 'vendor');
fs.mkdirSync(out, { recursive: true });
const copy = (from, name) => fs.copyFileSync(path.join(root, 'node_modules', '@xterm', from), path.join(out, name));

copy('xterm/lib/xterm.js', 'xterm.js');
copy('xterm/css/xterm.css', 'xterm.css');
for (const addon of ['fit', 'webgl', 'unicode11', 'web-links', 'search']) {
  copy(`addon-${addon}/lib/addon-${addon}.js`, `addon-${addon}.js`);
}
