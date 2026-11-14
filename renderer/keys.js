'use strict';
// Loom — keys and keybindings, without the DOM: parsing "Mod+Shift+P",
// turning a keydown into the same form, resolving a key to a command in a
// context, applying keybindings.json, and finding conflicts. Loaded by the
// page as window.Keys and by the tests with require().
//
// A key is "Ctrl+Alt+Shift+Cmd+K", modifiers in that order. "Mod" means Cmd
// on macOS and Ctrl elsewhere.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Keys = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const MODS = ['Ctrl', 'Alt', 'Shift', 'Cmd'];
  const ALIAS = {
    cmd: 'Cmd', command: 'Cmd', meta: 'Cmd', super: 'Cmd', win: 'Cmd', '⌘': 'Cmd',
    ctrl: 'Ctrl', control: 'Ctrl', '⌃': 'Ctrl',
    alt: 'Alt', option: 'Alt', opt: 'Alt', '⌥': 'Alt',
    shift: 'Shift', '⇧': 'Shift',
  };
  const NAMES = {
    esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter', tab: 'Tab', space: 'Space', backspace: 'Backspace',
    delete: 'Delete', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
    home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', plus: '=', minus: '-', backquote: '`', comma: ',',
  };
  const CODES = {
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
    Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'Space', NumpadAdd: '=', NumpadSubtract: '-',
  };

  function keyName(k) {
    const s = String(k);
    const low = s.toLowerCase();
    if (NAMES[low]) return NAMES[low];
    if (/^f\d{1,2}$/i.test(s)) return s.toUpperCase();
    if (s.length === 1) return s.toUpperCase();
    return s[0].toUpperCase() + s.slice(1);
  }

  // "mod+shift+p" -> "Shift+Cmd+P" on macOS, "Ctrl+Shift+P" elsewhere.
  function normalize(str, mac) {
    if (!str) return '';
    const parts = String(str).replace(/\s+/g, '').split(/\+(?!$)/);
    const mods = new Set();
    let key = '';
    for (const p of parts) {
      const low = p.toLowerCase();
      if (low === 'mod' || low === 'cmdorctrl' || low === 'commandorcontrol') mods.add(mac ? 'Cmd' : 'Ctrl');
      else if (ALIAS[low] || ALIAS[p]) mods.add(ALIAS[low] || ALIAS[p]);
      else key = keyName(p);
    }
    return [...MODS.filter((m) => mods.has(m)), key].filter(Boolean).join('+');
  }

  // A keydown in the same form. Layout-independent where the key has a code.
  function fromEvent(e) {
    let key;
    if (e.code && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
    else if (e.code && /^(Digit|Numpad)\d$/.test(e.code)) key = e.code.slice(-1);
    else if (e.code && CODES[e.code]) key = CODES[e.code];
    else key = keyName(e.key === ' ' ? 'Space' : e.key || '');
    if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(key)) return '';
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Cmd');
    return [...mods, key].join('+');
  }

  // "Shift+Cmd+P" -> "⇧⌘P" on macOS, "Ctrl+Shift+P" elsewhere.
  function format(key, mac) {
    if (!key) return '';
    const parts = key.split(/\+(?!$)/);
    const k = parts.pop();
    const pretty = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Enter: mac ? '↩' : 'Enter', Backspace: mac ? '⌫' : 'Backspace', Space: 'Space' }[k] || k;
    if (mac) return parts.map((m) => ({ Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘' }[m])).join('') + pretty;
    return [...parts.map((m) => (m === 'Cmd' ? 'Win' : m)), pretty].join('+');
  }

  // For Electron menus: "Shift+Cmd+P" -> "Shift+Command+P".
  const toAccelerator = (key) => key.split(/\+(?!$)/).map((p) => ({ Cmd: 'Command', Ctrl: 'Control', Escape: 'Esc', '`': '`', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', '=': '=' }[p] || p)).join('+');

  // ---------------------------------------------------------------- when
  // "canvas || commandBar", "!liveTerminal && canvas". Empty matches anywhere.
  function matches(when, ctx) {
    if (!when) return true;
    return String(when).split('||').some((alt) => alt.split('&&').every((t) => {
      const term = t.trim();
      if (!term) return true;
      return term.startsWith('!') ? !ctx[term.slice(1).trim()] : !!ctx[term];
    }));
  }

  // ---------------------------------------------------------------- bindings
  // commands: Map id -> { defaultKeys: [key | {key, when}], when, global }.
  // overrides: keybindings.json, [{ key, command, when? }], where
  // "-command" removes a default (all of them, or only `key`'s).
  function build(commands, overrides, mac) {
    const defaults = [];
    for (const [id, c] of commands) {
      for (const d of c.defaultKeys || []) {
        const o = typeof d === 'string' ? { key: d } : d;
        const key = normalize(o.key, mac);
        if (key) defaults.push({ key, command: id, when: o.when != null ? o.when : c.when, source: 'default' });
      }
    }
    const user = [];
    const errors = [];
    for (const [i, o] of (Array.isArray(overrides) ? overrides : []).entries()) {
      if (!o || typeof o.command !== 'string') { errors.push(`entry ${i + 1}: needs "command"`); continue; }
      const remove = o.command.startsWith('-');
      const id = remove ? o.command.slice(1) : o.command;
      if (!commands.has(id)) { errors.push(`entry ${i + 1}: no command "${id}"`); continue; }
      const key = normalize(o.key, mac);
      if (remove) {
        for (let j = defaults.length - 1; j >= 0; j--) if (defaults[j].command === id && (!key || defaults[j].key === key)) defaults.splice(j, 1);
        for (let j = user.length - 1; j >= 0; j--) if (user[j].command === id && (!key || user[j].key === key)) user.splice(j, 1);
        continue;
      }
      if (!key) { errors.push(`entry ${i + 1}: needs "key"`); continue; }
      user.push({ key, command: id, when: o.when != null ? o.when : commands.get(id).when, source: 'user' });
    }
    // The person's own bindings win, the last one first.
    return { list: [...user.reverse(), ...defaults], errors };
  }

  // In a live terminal only global commands fire, and on macOS ⌘ shortcuts,
  // since ⌘ never reaches a program there. Everything else is the program's.
  function allowedIn(ctx, b, cmd, mac) {
    if (!ctx.liveTerminal) return true;
    return !!(cmd && cmd.global) || (mac && b.key.split('+').includes('Cmd'));
  }

  function resolve(bindings, key, ctx, commands, mac) {
    if (!key) return null;
    for (const b of bindings.list || bindings) {
      if (b.key !== key || !matches(b.when, ctx)) continue;
      const cmd = commands.get(b.command);
      if (!cmd || !allowedIn(ctx, b, cmd, mac)) continue;
      if (cmd.enabled && !cmd.enabled(ctx)) continue;
      return b.command;
    }
    return null;
  }

  const CONTEXTS = ['canvas', 'commandBar', 'liveTerminal', 'overlay', 'dialog'];
  // Two commands on the same key that can fire in the same context.
  function conflicts(bindings, commands, mac) {
    const out = [];
    const list = bindings.list || bindings;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]; const b = list[j];
        if (a.key !== b.key || a.command === b.command) continue;
        const where = CONTEXTS.filter((c) => {
          const ctx = { [c]: true, mac };
          return matches(a.when, ctx) && matches(b.when, ctx) && allowedIn(ctx, a, commands.get(a.command), mac) && allowedIn(ctx, b, commands.get(b.command), mac);
        });
        if (where.length) out.push({ key: a.key, commands: [a.command, b.command], where, winner: a.command });
      }
    }
    return out;
  }

  // The key(s) a command is on now.
  const keysFor = (bindings, id) => (bindings.list || bindings).filter((b) => b.command === id).map((b) => b.key);

  return { normalize, fromEvent, format, toAccelerator, matches, build, resolve, conflicts, keysFor, CONTEXTS };
}));
