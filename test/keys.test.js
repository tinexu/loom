'use strict';
// Unit tests for renderer/keys.js: parsing, `when` contexts, overrides,
// removals and conflicts. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const K = require('../renderer/keys');

const commands = new Map([
  ['view.fit', { defaultKeys: ['Mod+0'], when: 'canvas || commandBar' }],
  ['view.map', { defaultKeys: ['Mod+B'], when: 'canvas || commandBar' }],
  ['tab.close', { defaultKeys: ['Mod+W'] }],
  ['palette.open', { defaultKeys: ['Mod+Shift+P'], global: true }],
  ['history.search', { defaultKeys: ['Ctrl+R'], when: 'canvas || commandBar' }],
  ['card.find', { defaultKeys: ['Mod+F'], when: 'canvas || commandBar' }],
  ['card.navUp', { defaultKeys: ['Alt+Up'], when: 'canvas || commandBar' }],
  ['terminal.release', { defaultKeys: ['Mod+Shift+E'], when: 'liveTerminal || overlay', global: true }],
]);

test('normalize: aliases, Mod per platform, modifier order', () => {
  assert.strictEqual(K.normalize('mod+shift+p', true), 'Shift+Cmd+P');
  assert.strictEqual(K.normalize('mod+shift+p', false), 'Ctrl+Shift+P');
  assert.strictEqual(K.normalize('shift+ctrl+tab', false), 'Ctrl+Shift+Tab');
  assert.strictEqual(K.normalize('Command+Option+up', true), 'Alt+Cmd+ArrowUp');
  assert.strictEqual(K.normalize('ctrl+`', true), 'Ctrl+`');
  assert.strictEqual(K.normalize('Mod+Shift+=', true), 'Shift+Cmd+=');
  assert.strictEqual(K.normalize('Ctrl++', false), 'Ctrl++');
});

test('fromEvent: codes beat layouts, modifiers alone are nothing', () => {
  assert.strictEqual(K.fromEvent({ code: 'KeyP', key: 'π', metaKey: true, shiftKey: true }), 'Shift+Cmd+P');
  assert.strictEqual(K.fromEvent({ code: 'Digit3', key: '#', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+3');
  assert.strictEqual(K.fromEvent({ code: 'Backquote', key: '`', ctrlKey: true }), 'Ctrl+`');
  assert.strictEqual(K.fromEvent({ code: 'Equal', key: '+', metaKey: true, shiftKey: true }), 'Shift+Cmd+=');
  assert.strictEqual(K.fromEvent({ code: 'ArrowUp', key: 'ArrowUp', altKey: true }), 'Alt+ArrowUp');
  assert.strictEqual(K.fromEvent({ code: 'ShiftLeft', key: 'Shift', shiftKey: true }), '');
  assert.strictEqual(K.format('Shift+Cmd+P', true), '⇧⌘P');
  assert.strictEqual(K.format('Ctrl+Shift+P', false), 'Ctrl+Shift+P');
});

test('resolve: when contexts', () => {
  const b = K.build(commands, [], false);
  assert.strictEqual(K.resolve(b, 'Ctrl+0', { canvas: true }, commands, false), 'view.fit');
  assert.strictEqual(K.resolve(b, 'Ctrl+0', { dialog: true }, commands, false), null);
  assert.strictEqual(K.resolve(b, 'Ctrl+Shift+P', { dialog: true }, commands, false), 'palette.open');
  assert.strictEqual(K.resolve(b, 'Ctrl+Shift+E', { canvas: true }, commands, false), null);
  assert.strictEqual(K.resolve(b, 'Alt+ArrowUp', { commandBar: true }, commands, false), 'card.navUp');
});

test('resolve: a live terminal gets every key but global ones (and ⌘ on macOS)', () => {
  const linux = K.build(commands, [], false);
  // Ctrl+W, Ctrl+R and Ctrl+B are vim's, bash's and tmux's.
  assert.strictEqual(K.resolve(linux, 'Ctrl+W', { liveTerminal: true }, commands, false), null);
  assert.strictEqual(K.resolve(linux, 'Ctrl+R', { liveTerminal: true }, commands, false), null);
  assert.strictEqual(K.resolve(linux, 'Ctrl+Shift+P', { liveTerminal: true }, commands, false), 'palette.open');
  assert.strictEqual(K.resolve(linux, 'Ctrl+Shift+E', { liveTerminal: true }, commands, false), 'terminal.release');
  const mac = K.build(commands, [], true);
  assert.strictEqual(K.resolve(mac, 'Cmd+W', { liveTerminal: true }, commands, true), 'tab.close');
  assert.strictEqual(K.resolve(mac, 'Ctrl+W', { liveTerminal: true }, commands, true), null);
  assert.strictEqual(K.resolve(mac, 'Ctrl+R', { liveTerminal: true }, commands, true), null);
});

test('overrides: add, rebind, remove one default, remove all, bad entries', () => {
  const { list, errors } = K.build(commands, [
    { key: 'Mod+Shift+F', command: 'view.fit' },
    { key: 'Mod+F', command: '-card.find' },
    { command: '-view.map' },
    { key: 'Mod+J', command: 'no.such' },
    { command: 'view.fit' },
  ], true);
  const b = { list };
  assert.strictEqual(K.resolve(b, 'Shift+Cmd+F', { canvas: true }, commands, true), 'view.fit');
  assert.strictEqual(K.resolve(b, 'Cmd+0', { canvas: true }, commands, true), 'view.fit');
  assert.strictEqual(K.resolve(b, 'Cmd+F', { canvas: true }, commands, true), null);
  assert.deepStrictEqual(K.keysFor(b, 'view.map'), []);
  assert.deepStrictEqual(K.keysFor(b, 'view.fit'), ['Shift+Cmd+F', 'Cmd+0']);
  assert.strictEqual(errors.length, 2);
  assert.match(errors[0], /no command "no.such"/);
});

test('overrides: the person’s binding wins over a default on the same key', () => {
  const b = K.build(commands, [{ key: 'Mod+B', command: 'view.fit' }], true);
  assert.strictEqual(K.resolve(b, 'Cmd+B', { canvas: true }, commands, true), 'view.fit');
});

test('conflicts: same key, overlapping contexts, different commands', () => {
  const b = K.build(commands, [{ key: 'Mod+0', command: 'card.find' }, { key: 'Mod+Shift+E', command: 'view.map' }], true);
  const c = K.conflicts(b, commands, true);
  const fit = c.find((x) => x.key === 'Cmd+0');
  assert.ok(fit && fit.commands.includes('view.fit') && fit.winner === 'card.find');
  // view.map is canvas-only and terminal.release is terminal-only: no overlap.
  assert.ok(!c.some((x) => x.key === 'Shift+Cmd+E'));
  assert.deepStrictEqual(K.conflicts(K.build(commands, [], true), commands, true), []);
});
