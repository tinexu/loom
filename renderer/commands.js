'use strict';
// Loom — the command registry, the one keydown dispatcher, and the command
// palette. Every shortcut is a command { id, title, category, keys, when,
// global, run }; keybindings.json can add, move or remove keys (renderer/keys.js
// resolves them). Text editing in the command bar (Tab completion, ↑/↓
// history, Enter) belongs to the editor, which sees keys first there.
(function (g) {
  const { Keys, Fuzzy } = g;
  const RECENT_KEY = 'loom.recentCommands';

  // opts: mac, context(e) -> { canvas, commandBar, liveTerminal, overlay, dialog, ... },
  // onChange() when bindings change.
  function create(opts) {
    const { mac } = opts;
    const commands = new Map();
    let overrides = [];
    let bindings = { list: [], errors: [] };
    let recording = null;
    let recent = [];
    try { recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { recent = []; }

    function rebuild() {
      bindings = Keys.build(commands, overrides, mac);
      opts.onChange && opts.onChange();
    }

    // { id, title, category, keys: [key | {key, when}], when, global, palette, run(ctx) }
    function add(cmd) {
      commands.set(cmd.id, { palette: true, ...cmd, defaultKeys: cmd.keys || [] });
    }
    function remove(id) { commands.delete(id); }

    function run(id, ctx = {}) {
      const c = commands.get(id);
      if (!c) return false;
      if (c.palette !== false) {
        recent = [id, ...recent.filter((x) => x !== id)].slice(0, 20);
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* private mode */ }
      }
      return c.run(ctx);
    }

    // The keydown pipeline's command step. Returns true when a command took
    // the key. A command's run() returning false lets the key through.
    function handle(e, ctx = opts.context(e)) {
      if (e.isComposing) return false;
      const key = Keys.fromEvent(e);
      if (!key) return false;
      if (recording) { e.preventDefault(); e.stopPropagation(); const fn = recording; recording = null; fn(key); return true; }
      const id = Keys.resolve(bindings, key, ctx, commands, mac);
      if (!id) return false;
      const res = run(id, { ...ctx, key, event: e });
      if (res === false) return false;
      e.preventDefault();
      e.stopPropagation();
      return true;
    }

    const keysFor = (id) => Keys.keysFor(bindings, id);
    const label = (key) => Keys.format(key, mac);

    return {
      add, remove, run, handle, keysFor, label,
      has: (id) => commands.has(id),
      get: (id) => commands.get(id),
      list: () => [...commands.entries()].map(([id, c]) => ({ id, ...c, keys: keysFor(id) })),
      setOverrides(list) { overrides = Array.isArray(list) ? list : []; rebuild(); },
      overrides: () => overrides.slice(),
      bindings: () => bindings,
      errors: () => bindings.errors,
      conflicts: () => Keys.conflicts(bindings, commands, mac),
      defaults: (id) => (commands.get(id).defaultKeys || []).map((k) => Keys.normalize(typeof k === 'string' ? k : k.key, mac)),
      recent: () => recent.filter((id) => commands.has(id)),
      // The next key pressed goes to fn (Settings → Keys records shortcuts this way).
      record(fn) { recording = fn; },
      cancelRecord() { recording = null; },
      rebuild,
    };
  }

  // ---------------------------------------------------------------- palette
  // ⌘/Ctrl+Shift+P: fuzzy search over every command, with its shortcut, recent first.
  function palette({ el, registry, onClose }) {
    el.innerHTML = '<div class="pal-box"><input class="pal-q" spellcheck="false" autocomplete="off" placeholder="Type a command"><div class="pal-list"></div></div>';
    const q = el.querySelector('.pal-q');
    const list = el.querySelector('.pal-list');
    let rows = [];
    let sel = 0;
    let back = null;

    function score(c, query) {
      const text = `${c.category ? `${c.category}: ` : ''}${c.title}`;
      if (!query) return { s: 0, hl: [], text };
      const m = Fuzzy.match(query, text);
      return m ? { s: m.score, hl: m.hl, text } : null;
    }

    function render() {
      const query = q.value.trim();
      const recent = registry.recent();
      const all = registry.list().filter((c) => c.palette !== false && (!c.enabled || c.enabled({})));
      rows = [];
      for (const c of all) {
        const m = score(c, query);
        if (!m) continue;
        const r = recent.indexOf(c.id);
        rows.push({ c, ...m, rank: (query ? m.s : 0) + (r >= 0 ? (query ? 6 : 1000) - r * (query ? 0.3 : 10) : 0) });
      }
      rows.sort((a, b) => b.rank - a.rank || a.text.localeCompare(b.text));
      sel = Math.min(sel, Math.max(0, rows.length - 1));
      const frag = document.createDocumentFragment();
      rows.slice(0, 200).forEach((r, i) => {
        const row = document.createElement('div');
        row.className = `pal-row${i === sel ? ' sel' : ''}`;
        row.dataset.i = i;
        const t = document.createElement('span');
        t.className = 'pal-title';
        const hl = new Set(r.hl);
        let html = '';
        for (let j = 0; j < r.text.length; j++) {
          const ch = r.text[j].replace(/[&<>]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x]));
          html += hl.has(j) ? `<b>${ch}</b>` : ch;
        }
        t.innerHTML = html;
        row.append(t);
        if (!query && recent.includes(r.c.id)) { const b = document.createElement('span'); b.className = 'pal-recent'; b.textContent = 'recent'; row.append(b); }
        const keys = document.createElement('span');
        keys.className = 'pal-keys';
        for (const k of r.c.keys.slice(0, 2)) { const kb = document.createElement('kbd'); kb.textContent = registry.label(k); keys.append(kb); }
        row.append(keys);
        frag.append(row);
      });
      if (!rows.length) { const e = document.createElement('div'); e.className = 'pal-empty'; e.textContent = 'No matching commands'; frag.append(e); }
      list.replaceChildren(frag);
      const s = list.querySelector('.sel');
      if (s) s.scrollIntoView({ block: 'nearest' });
    }

    function open() {
      back = document.activeElement;
      el.hidden = false;
      q.value = '';
      sel = 0;
      render();
      q.focus();
    }
    function close(runId) {
      el.hidden = true;
      if (back && back.isConnected && !runId) back.focus();
      onClose && onClose(runId);
      if (runId) registry.run(runId, { palette: true });
    }
    q.addEventListener('input', () => { sel = 0; render(); });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) { e.preventDefault(); sel = Math.min(rows.length - 1, sel + 1); render(); }
      else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); const r = rows[sel]; close(r ? r.c.id : null); }
      else if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else return;
      e.stopPropagation();
    });
    list.addEventListener('mousedown', (e) => {
      const row = e.target.closest('.pal-row');
      if (!row) return;
      e.preventDefault();
      close(rows[Number(row.dataset.i)].c.id);
    });
    el.addEventListener('mousedown', (e) => { if (e.target === el) close(null); });
    return { open, close: () => close(null), isOpen: () => !el.hidden, rows: () => rows.map((r) => ({ id: r.c.id, text: r.text, keys: r.c.keys })) };
  }

  g.Commands = { create, palette };
})(window);
