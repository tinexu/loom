'use strict';
// Loom — settings.json: the schema, defaults and validation. A file that
// doesn't parse, or a value of the wrong kind, is reported and the default
// (or the last good value) is used, so a typo never stops Loom from starting.
const fs = require('fs');

// type: string | number | boolean | enum | strings. `secret` values never go to the page.
const SCHEMA = {
  // General
  defaultFolder: { type: 'string', default: '', label: 'Default folder for new tabs' },
  restoreTabs: { type: 'boolean', default: true },
  notifications: { type: 'boolean', default: true },
  confirmQuit: { type: 'boolean', default: true },
  // Appearance
  themeMode: { type: 'enum', values: ['system', 'light', 'dark'], default: 'system' },
  themeLight: { type: 'string', default: 'loom-light' },
  themeDark: { type: 'string', default: 'loom-dark' },
  fontFamily: { type: 'string', default: '' },
  fontSize: { type: 'number', min: 8, max: 32, default: 12.5 },
  lineHeight: { type: 'number', min: 1, max: 2.5, default: 1.55 },
  fontWeight: { type: 'number', min: 100, max: 900, default: 400 },
  ligatures: { type: 'boolean', default: false },
  // Terminal
  shell: { type: 'string', default: '' },
  shellArgs: { type: 'strings', default: [] },
  cursorStyle: { type: 'enum', values: ['block', 'bar', 'underline'], default: 'block' },
  cursorBlink: { type: 'boolean', default: true },
  scrollback: { type: 'number', min: 100, max: 200000, default: 10000, integer: true },
  outputCapGB: { type: 'number', min: 0.01, max: 1024, default: 1 },
  outputTotalGB: { type: 'number', min: 0.01, max: 4096, default: 5 },
  realPager: { type: 'boolean', default: false },
  forceColor: { type: 'boolean', default: false },
  // Dropdown
  dropdownHotkey: { type: 'string', default: 'Control+`' },
  dropdownHeight: { type: 'number', min: 0.15, max: 1, default: 0.45 },
  dropdownHideOnBlur: { type: 'boolean', default: true },
  // Claude
  model: { type: 'string', default: 'claude-sonnet-5-5' },
  apiKey: { type: 'string', default: '', secret: true },
  keyEncrypted: { type: 'boolean', default: false, hidden: true },
  // Loom's own bookkeeping
  historyOffered: { type: 'boolean', default: false, hidden: true },
  appImageOffered: { type: 'boolean', default: false, hidden: true },
};

const DEFAULTS = Object.fromEntries(Object.entries(SCHEMA).map(([k, s]) => [k, s.default]));

function check(key, v) {
  const s = SCHEMA[key];
  switch (s.type) {
    case 'string': return typeof v === 'string' ? null : 'should be text';
    case 'boolean': return typeof v === 'boolean' ? null : 'should be true or false';
    case 'enum': return s.values.includes(v) ? null : `should be one of ${s.values.map((x) => `"${x}"`).join(', ')}`;
    case 'strings': return Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : 'should be a list of text';
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'should be a number';
      if (s.integer && !Number.isInteger(v)) return 'should be a whole number';
      if (v < s.min || v > s.max) return `should be between ${s.min} and ${s.max}`;
      return null;
    default: return null;
  }
}

// { value, errors }: every known key valid (bad ones fall back to `previous`,
// then the default); unknown keys are kept, with a note.
function validate(raw, previous = DEFAULTS) {
  const errors = [];
  const value = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: { ...previous }, errors: ['settings.json should be a JSON object'] };
  for (const [k, v] of Object.entries(raw)) {
    if (!SCHEMA[k]) { value[k] = v; errors.push(`"${k}" isn't a setting Loom knows`); continue; }
    const err = check(k, v);
    if (err) { errors.push(`"${k}" ${err}; using ${JSON.stringify(previous[k] ?? DEFAULTS[k])}`); value[k] = previous[k] ?? DEFAULTS[k]; } else value[k] = v;
  }
  return { value, errors };
}

// Reads the file. A missing file is the defaults; a broken one keeps `previous`.
function load(file, previous = DEFAULTS) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { value: { ...DEFAULTS }, errors: [] }; }
  if (!text.trim()) return { value: { ...DEFAULTS }, errors: [] };
  let raw;
  try { raw = JSON.parse(text); } catch (err) { return { value: { ...previous }, errors: [`settings.json isn't valid JSON: ${err.message}`] }; }
  return validate(raw, previous);
}

// What's written: only values that differ from the defaults, plus anything unknown.
function toFile(value) {
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SCHEMA[k] && JSON.stringify(v) === JSON.stringify(SCHEMA[k].default) && !['model'].includes(k)) continue;
    out[k] = v;
  }
  return out;
}

// What the page may see.
function forPage(value) {
  const out = {};
  for (const [k, v] of Object.entries(value)) if (!(SCHEMA[k] && (SCHEMA[k].secret || SCHEMA[k].hidden))) out[k] = v;
  return out;
}

module.exports = { SCHEMA, DEFAULTS, validate, load, toFile, forPage, check };
