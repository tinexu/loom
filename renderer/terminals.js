'use strict';
// Terminal side of a running card. main.js records every card's output; a
// running card that needs a screen (on screen, live, or on the alternate
// screen) also has an xterm Terminal that interprets it, usually never
// attached to the DOM. A card the user is looking at gets a live view: that
// same Terminal opened in an unscaled layer over the card, because xterm blurs
// and misplaces the mouse under CSS transforms. A model opened on a card that
// was already running starts from main's replay of its screen. When the card
// ends, its output file is the card's text, except when the program moved the
// cursor: then the normal-screen buffer is, and goes back to main.
(function (g) {
  const { Ansi } = g;
  const MAX_LIVE = 8; // browsers cap WebGL contexts at about 16 per page
  const MIN_ZOOM = 0.6;
  const SCROLLBACK = 10000;
  const FONT = 12; // when there are no font settings yet
  const ESC_ESC_MS = 400;
  const SNAPSHOT_MS = 200;
  const SNAPSHOT_LINES = 400;
  const isMac = navigator.platform.startsWith('Mac');

  // The active theme's terminal colors (renderer/theme.js), on the card's background.
  const theme = () => g.Theme.xterm() || {};
  const monoFont = () => getComputedStyle(document.documentElement).getPropertyValue('--mono').trim();

  // ---------------------------------------------------------------- buffer → text
  function sgrFor(c) {
    const codes = [];
    if (c.isBold()) codes.push(1);
    if (c.isDim()) codes.push(2);
    if (c.isItalic()) codes.push(3);
    if (c.isUnderline()) codes.push(4);
    if (c.isInverse()) codes.push(7);
    const color = (fg, n, palette, rgb) => {
      if (rgb) codes.push(fg ? 38 : 48, 2, (n >> 16) & 255, (n >> 8) & 255, n & 255);
      else if (palette) codes.push(fg ? 38 : 48, 5, n);
    };
    color(true, c.getFgColor(), c.isFgPalette(), c.isFgRGB());
    color(false, c.getBgColor(), c.isBgPalette(), c.isBgRGB());
    return codes.join(';');
  }

  // Renders buffer lines as text with SGR colors, which is what the card's HTML
  // renderer, Copy and the rich views already consume.
  function bufferText(buf, first) {
    const cell = buf.getNullCell();
    const lines = [];
    let out = '';
    for (let y = first; y < buf.length; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      let last = line.length - 1;
      while (last >= 0 && !line.getCell(last, cell).getChars()) last--;
      let sgr = '';
      for (let x = 0; x <= last; x++) {
        line.getCell(x, cell);
        if (cell.getWidth() === 0) continue; // second half of a wide character
        const next = sgrFor(cell);
        if (next !== sgr) { out += `\x1b[0${next ? `;${next}` : ''}m`; sgr = next; }
        out += cell.getChars() || ' ';
      }
      if (sgr) out += '\x1b[0m';
      const nextLine = buf.getLine(y + 1);
      if (nextLine && nextLine.isWrapped) continue;
      lines.push(out);
      out = '';
    }
    if (out) lines.push(out);
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- manager
  // opts: api, layer, overlay (element), slot (element in the overlay),
  // rect(n) -> { x, y, w, h, k, shown } in viewport pixels,
  // onChange(n) after the live view appears or disappears, onOutput(n),
  // onAlt(n, entered), onRelease(n, focused) when keyboard control leaves a terminal.
  function create(opts) {
    const { api, layer, overlay, slot } = opts;
    const terms = new Map(); // card key -> t
    const fontSize = () => (opts.font && opts.font()) || FONT;
    // Cursor and scrollback from settings, and the font weight.
    const termOptions = () => {
      const s = (opts.settings && opts.settings()) || {};
      const f = g.Theme.fonts() || {};
      return {
        cursorBlink: s.cursorBlink !== false, cursorStyle: s.cursorStyle || 'block', scrollback: s.scrollback || SCROLLBACK,
        fontWeight: f.weight || 400, fontWeightBold: Math.min(900, (f.weight || 400) + 300),
      };
    };
    const attached = new Set();
    let overlaid = null;
    let peak = 0;

    const newTerm = () => {
      const term = new g.Terminal({
        cols: 120, rows: 40, allowProposedApi: true,
        fontFamily: monoFont(), fontSize: fontSize(), lineHeight: 1.2, theme: theme(),
        minimumContrastRatio: 3, macOptionIsMeta: true, ...termOptions(),
      });
      term.loadAddon(new g.Unicode11Addon.Unicode11Addon());
      term.unicode.activeVersion = '11';
      return term;
    };

    // A model for a running card. `fresh`: main is already sending it
    // everything (a card that just started); otherwise it asks main to start,
    // and shows main's replay of the screen first.
    function attach(n, { fresh = false } = {}) {
      dispose(n.key);
      const term = newTerm();
      const t = {
        n, term, fit: null, search: null, webgl: null, host: null, find: null, opened: false,
        visible: false, focused: false, focusedAt: 0, lastEsc: 0, lastSnapshot: 0, snapTimer: null, snap: '',
        resizeTimer: null, fitTimer: null, w: 0, h: 0, queue: fresh ? null : [],
      };
      terms.set(n.key, t);
      if (!fresh) {
        api.outSubscribe({ id: n.key, on: true }).then((res) => {
          if (terms.get(n.key) !== t) return;
          const q = t.queue;
          t.queue = null;
          if (res && res.replay) t.term.write(res.replay);
          for (const d of q) feed(t, d);
          opts.onOutput(n);
        });
      }
      // Input and the terminal's own query replies go to the PTY and nowhere else.
      term.onData((data) => api.stdin({ id: n.key, data }));
      term.onBinary((data) => api.stdin({ id: n.key, data }));
      term.onResize(({ cols, rows }) => {
        clearTimeout(t.resizeTimer);
        t.resizeTimer = setTimeout(() => api.resize({ id: n.key, cols, rows }), 60);
      });
      term.buffer.onBufferChange((buf) => opts.onAlt(n, buf.type === 'alternate'));
      term.attachCustomKeyEventHandler((e) => onKey(t, e));
      return t;
    }

    function feed(t, text) {
      t.term.write(text, () => {
        api.ack({ id: t.n.key, bytes: text.length });
        opts.onOutput(t.n);
      });
    }

    function write(id, text) {
      const t = terms.get(id);
      if (!t) { api.ack({ id, bytes: text.length }); return; }
      if (t.queue) t.queue.push(text); else feed(t, text);
    }

    // The card doesn't need a screen any more: main stops sending.
    function releaseModel(id) {
      if (!terms.has(id)) return;
      dispose(id);
      api.outSubscribe({ id, on: false });
    }

    // ------------------------------------------------------------ keyboard
    // Loom's own keys in a terminal are commands (renderer/commands.js), which
    // see the key first. Everything else is the program's, except ⌘ on macOS,
    // which stays with Loom and the OS.
    const onKey = (_t, e) => !(isMac && e.metaKey);
    const focusedT = () => { for (const t of terms.values()) if (t.focused || (t.opened && document.activeElement === t.term.textarea)) return t; return null; };

    // Esc Esc returns to the canvas; the first Esc still belongs to the program.
    function escape() {
      const t = focusedT();
      if (!t) return false;
      const now = performance.now();
      if (now - t.lastEsc < ESC_ESC_MS) { t.lastEsc = 0; release(t); return true; }
      t.lastEsc = now;
      return false;
    }

    function release(t) {
      if (overlaid === t) { t.n.noExpand = true; collapse(); }
      t.term.blur();
      setFocused(t, false); // moving the host out of the overlay doesn't fire blur
      opts.onRelease(t.n, true);
    }

    function openFind(t) {
      t.find.hidden = false;
      t.find.focus();
      t.find.select();
    }

    // ------------------------------------------------------------ live views
    function ensureHost(t) {
      if (t.host) return;
      const host = document.createElement('div');
      host.className = 'live-term';
      host.innerHTML = `<div class="live-hint">Esc Esc or ${isMac ? '⌘' : 'Ctrl'}+Shift+E to return to canvas</div><input class="live-find" placeholder="Find" spellcheck="false" hidden><div class="live-slot"></div>`;
      t.host = host;
      t.find = host.querySelector('.live-find');
      t.find.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') t.search.findNext(t.find.value);
        if (e.key === 'Escape') { t.find.hidden = true; t.term.focus(); }
      });
      host.addEventListener('pointerdown', () => { touch(t); opts.onPointer(t.n); });
    }

    function open(t) {
      const parent = t.host.querySelector('.live-slot');
      t.term.open(parent);
      t.fit = new g.FitAddon.FitAddon();
      t.search = new g.SearchAddon.SearchAddon();
      t.term.loadAddon(t.fit);
      t.term.loadAddon(t.search);
      t.term.loadAddon(new g.WebLinksAddon.WebLinksAddon((_e, url) => window.open(url)));
      t.term.textarea.addEventListener('focus', () => setFocused(t, true));
      t.term.textarea.addEventListener('blur', () => setFocused(t, false));
      t.opened = true;
    }

    function setFocused(t, on) {
      t.focused = on;
      t.host.classList.toggle('focused', on);
      if (on) touch(t);
    }
    const touch = (t) => { t.focusedAt = performance.now(); };

    // focus events don't fire while the window itself is in the background.
    function takeFocus(t) {
      t.term.focus();
      setFocused(t, document.activeElement === t.term.textarea);
    }

    function loadWebgl(t) {
      if (t.webgl) return;
      try {
        const w = new g.WebglAddon.WebglAddon();
        w.onContextLoss(() => { w.dispose(); t.webgl = null; });
        t.term.loadAddon(w);
        t.webgl = w;
      } catch { /* xterm keeps its default renderer */ }
    }

    function promote(t) {
      touch(t);
      if (attached.has(t)) return;
      while (attached.size >= MAX_LIVE) {
        let oldest = null;
        for (const o of attached) if (o !== overlaid && (!oldest || o.focusedAt < oldest.focusedAt)) oldest = o;
        if (!oldest) break;
        demote(oldest);
      }
      ensureHost(t);
      layer.append(t.host);
      attached.add(t);
      peak = Math.max(peak, attached.size);
      position(t);
      if (!t.opened) open(t);
      fitNow(t);
      // WebGL compiles its shaders on load; a task of its own keeps both short.
      setTimeout(() => { if (attached.has(t) && terms.get(t.n.key) === t) { loadWebgl(t); t.term.refresh(0, t.term.rows - 1); } }, 0);
    }

    // The Terminal stays as the card's model. Only its view and WebGL context go.
    function demote(t) {
      if (t.webgl) { t.webgl.dispose(); t.webgl = null; }
      t.host.remove();
      attached.delete(t);
      setVisible(t, false);
    }

    function fitNow(t) {
      if (t.host && !t.host.hidden && attached.has(t)) t.fit.fit();
    }
    function fitSoon(t) {
      clearTimeout(t.fitTimer);
      t.fitTimer = setTimeout(() => fitNow(t), 90);
    }

    function setVisible(t, on) {
      if (t.visible === on) return;
      t.visible = on;
      opts.onChange(t.n);
    }

    function position(t) {
      const r = opts.rect(t.n);
      const area = layer.getBoundingClientRect();
      const on = !!r && r.shown && r.k >= MIN_ZOOM
        && r.x < area.width && r.y < area.height && r.x + r.w > 0 && r.y + r.h > 0;
      t.host.hidden = !on;
      if (on) {
        const { style } = t.host;
        style.left = `${r.x}px`;
        style.top = `${r.y}px`;
        style.width = `${r.w}px`;
        style.height = `${r.h}px`;
        const font = Math.round(fontSize() * r.k * 2) / 2;
        if (t.term.options.fontSize !== font) t.term.options.fontSize = font;
        if (r.w !== t.w || r.h !== t.h) { t.w = r.w; t.h = r.h; fitSoon(t); }
      } else if (t.focused) release(t);
      setVisible(t, on);
    }

    function layout() {
      for (const t of attached) if (t !== overlaid) position(t);
    }

    function show(n, { focus = false } = {}) {
      const t = terms.get(n.key);
      if (!t) return;
      promote(t);
      if (focus && t.visible) takeFocus(t);
      if (focus && t.term.buffer.active.type === 'alternate') { n.noExpand = false; expand(n); }
    }

    // ------------------------------------------------------------ overlay
    function expand(n) {
      const t = terms.get(n.key);
      if (!t) return;
      if (overlaid && overlaid !== t) collapse();
      promote(t);
      overlaid = t;
      slot.append(t.host);
      Object.assign(t.host.style, { left: '', top: '', width: '', height: '' });
      t.host.hidden = false;
      t.w = 0;
      t.term.options.fontSize = fontSize() + 1;
      overlay.hidden = false;
      setVisible(t, false); // the card shows its snapshot while the overlay has the terminal
      requestAnimationFrame(() => { overlay.classList.add('open'); fitNow(t); });
      setTimeout(() => fitNow(t), 200);
      takeFocus(t);
    }

    function collapse() {
      const t = overlaid;
      if (!t) return;
      overlaid = null;
      overlay.classList.remove('open');
      setTimeout(() => { if (!overlaid) overlay.hidden = true; }, 180);
      if (terms.has(t.n.key)) {
        layer.append(t.host);
        position(t);
        fitNow(t);
      }
    }

    // ------------------------------------------------------------ text
    // The last lines of a running card with no live view, for its body.
    function snapshot(t) {
      const buf = t.term.buffer.active;
      t.snap = bufferText(buf, Math.max(0, buf.length - SNAPSHOT_LINES));
      t.lastSnapshot = performance.now();
    }

    // Returns { live: true } while a live view covers the card body, or the
    // snapshot text (refreshed at most every SNAPSHOT_MS), or null with no model.
    function refresh(n, again) {
      const t = terms.get(n.key);
      if (!t) return null;
      if (t.visible) return { live: true };
      const wait = SNAPSHOT_MS - (performance.now() - t.lastSnapshot);
      if (wait <= 0) snapshot(t);
      else if (!t.snapTimer) t.snapTimer = setTimeout(() => { t.snapTimer = null; again(); }, wait);
      return { text: t.snap };
    }

    // A card ended. When its program moved the cursor (`moved`), the screen
    // text is what the card keeps: from its model, or from a model fed main's
    // replay if it had none. Null means the output file is the text as it is.
    async function finish(n, { moved = false } = {}) {
      const t = terms.get(n.key);
      let focused = false;
      let text = null;
      if (t) {
        await new Promise((r) => t.term.write('', r));
        if (t.queue) await new Promise((r) => { const iv = setInterval(() => { if (!t.queue) { clearInterval(iv); r(); } }, 20); setTimeout(() => { clearInterval(iv); r(); }, 3000); });
        await new Promise((r) => t.term.write('', r));
        focused = !!t.opened && document.activeElement === t.term.textarea;
        if (overlaid === t) collapse();
        if (moved) text = bufferText(t.term.buffer.normal, 0);
        dispose(n.key);
      } else if (moved) {
        const res = await api.outReplay({ id: n.key, full: true });
        const term = newTerm();
        await new Promise((r) => term.write((res && res.replay) || '', r));
        text = bufferText(term.buffer.normal, 0);
        term.dispose();
      }
      return { text, focused };
    }

    function dispose(id) {
      const t = terms.get(id);
      if (!t) return;
      if (overlaid === t) collapse();
      terms.delete(id);
      attached.delete(t);
      clearTimeout(t.resizeTimer);
      clearTimeout(t.fitTimer);
      clearTimeout(t.snapTimer);
      if (t.host) t.host.remove();
      t.term.dispose();
      opts.onChange(t.n);
    }

    // A new theme, font or terminal setting reaches every model and live view.
    function setOptions() {
      const o = { theme: theme(), fontFamily: monoFont(), ...termOptions() };
      for (const t of terms.values()) {
        Object.assign(t.term.options, o);
        if (overlaid !== t) t.w = 0;
      }
      layout();
      if (overlaid) { overlaid.term.options.fontSize = fontSize() + 1; fitNow(overlaid); }
    }
    window.addEventListener('resize', () => {
      layout();
      if (overlaid) fitNow(overlaid);
    });

    return {
      attach, write, release: releaseModel, escape, setOptions, show,
      releaseFocused: () => { const t = focusedT(); if (t) release(t); return !!t; },
      findFocused: () => { const t = focusedT(); if (t && t.find) openFind(t); return !!t; },
      copyFocused: () => { const t = focusedT(); if (t && t.term.hasSelection()) navigator.clipboard.writeText(t.term.getSelection()); return !!t; }, layout, expand, collapse, refresh, finish, dispose,
      has: (id) => terms.has(id),
      isLive: (id) => { const t = terms.get(id); return !!t && t.visible; },
      isFocused: (id) => { const t = terms.get(id); return !!t && t.focused; },
      inAlt: (id) => { const t = terms.get(id); return !!t && t.term.buffer.active.type === 'alternate'; },
      // For the e2e run.
      stats: () => ({ live: attached.size, peak, models: terms.size, overlay: overlaid ? overlaid.n.key : null }),
      term: (id) => { const t = terms.get(id); return t ? t.term : null; },
    };
  }

  g.Terminals = { create, bufferText };
})(window);
