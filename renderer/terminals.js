'use strict';
// Terminal side of a running card. Every running card has an xterm Terminal
// that interprets its output, usually never attached to the DOM. A card the
// user is looking at also gets a live view: that same Terminal opened in an
// unscaled layer over the card, because xterm blurs and misplaces the mouse
// under CSS transforms. When the card ends, its buffer becomes plain text for
// the cheap HTML card and the Terminal is disposed.
(function (g) {
  const { Ansi } = g;
  const MAX_LIVE = 8; // browsers cap WebGL contexts at about 16 per page
  const MIN_ZOOM = 0.6;
  const SCROLLBACK = 10000;
  const RAW_MAX = 5 * 1024 * 1024;
  const FONT = 12;
  const OVERLAY_FONT = 13;
  const ESC_ESC_MS = 400;
  const SNAPSHOT_MS = 200;
  const SNAPSHOT_LINES = 400;
  const isMac = navigator.platform.startsWith('Mac');

  function theme() {
    const css = getComputedStyle(document.documentElement);
    const token = (name) => css.getPropertyValue(name).trim();
    const p = Ansi.palette();
    return {
      background: token('--card'), foreground: token('--text'),
      cursor: token('--accent'), cursorAccent: token('--accent-ink'),
      selectionBackground: Ansi.lightTheme.matches ? 'rgba(31, 157, 85, 0.25)' : 'rgba(126, 224, 161, 0.3)',
      black: p[0], red: p[1], green: p[2], yellow: p[3], blue: p[4], magenta: p[5], cyan: p[6], white: p[7],
      brightBlack: p[8], brightRed: p[9], brightGreen: p[10], brightYellow: p[11],
      brightBlue: p[12], brightMagenta: p[13], brightCyan: p[14], brightWhite: p[15],
    };
  }
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

  // Output with no cursor movement doesn't need the terminal's interpretation,
  // and raw text is better when it's available: it keeps tabs, which rich views
  // and pipes care about, and isn't limited by scrollback. Null means use the buffer.
  function plainText(raw) {
    const text = raw.replace(/\r+\n/g, '\n');
    const rest = text
      .replace(/\x1b\[[0-9;:]*m/g, '')
      .replace(/\x1b\[[0-2]?K/g, '')
      .replace(/\x1b\[\?[0-9;]*[hl]/g, '')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
    return /[\x1b\r\x08]/.test(rest) ? null : text;
  }

  // ---------------------------------------------------------------- manager
  // opts: api, layer, overlay (element), slot (element in the overlay),
  // rect(n) -> { x, y, w, h, k, shown } in viewport pixels,
  // onChange(n) after the live view appears or disappears, onOutput(n),
  // onAlt(n, entered), onRelease(n, focused) when keyboard control leaves a terminal.
  function create(opts) {
    const { api, layer, overlay, slot } = opts;
    const terms = new Map(); // card id -> t
    const attached = new Set();
    let overlaid = null;
    let peak = 0;

    function attach(n) {
      dispose(n.id);
      const term = new g.Terminal({
        cols: 120, rows: 40, scrollback: SCROLLBACK, allowProposedApi: true,
        fontFamily: monoFont(), fontSize: FONT, lineHeight: 1.2, theme: theme(),
        minimumContrastRatio: 3, macOptionIsMeta: true, cursorBlink: true,
      });
      term.loadAddon(new g.Unicode11Addon.Unicode11Addon());
      term.unicode.activeVersion = '11';
      const t = {
        n, term, fit: null, search: null, webgl: null, host: null, find: null, opened: false,
        visible: false, focused: false, focusedAt: 0, lastEsc: 0, lastSnapshot: 0, snapTimer: null,
        raw: '', rawOver: false, sawAlt: false, resizeTimer: null, fitTimer: null, w: 0, h: 0,
      };
      terms.set(n.id, t);
      // Input and the terminal's own query replies go to the PTY and nowhere else.
      term.onData((data) => api.stdin({ id: n.id, data }));
      term.onBinary((data) => api.stdin({ id: n.id, data }));
      term.onResize(({ cols, rows }) => {
        clearTimeout(t.resizeTimer);
        t.resizeTimer = setTimeout(() => api.resize({ id: n.id, cols, rows }), 60);
      });
      term.buffer.onBufferChange((buf) => {
        const alt = buf.type === 'alternate';
        if (alt) t.sawAlt = true;
        opts.onAlt(n, alt);
      });
      term.attachCustomKeyEventHandler((e) => onKey(t, e));
      return t;
    }

    function write(n, text) {
      const t = terms.get(n.id);
      if (!t) return;
      if (t.raw.length + text.length <= RAW_MAX) t.raw += text;
      else t.rawOver = true;
      t.term.write(text, () => {
        api.ack({ id: n.id, bytes: text.length });
        opts.onOutput(n);
      });
    }

    // ------------------------------------------------------------ keyboard
    function onKey(t, e) {
      const down = e.type === 'keydown';
      const key = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && key === 'e') { if (down) release(t); return false; }
      if (mod && e.shiftKey && key === 'f') { if (down) openFind(t); return false; }
      if (e.key === 'Escape' && down) {
        const now = performance.now();
        if (now - t.lastEsc < ESC_ESC_MS) { t.lastEsc = 0; release(t); return false; }
        t.lastEsc = now;
        return true; // the first Esc still belongs to the program
      }
      if (e.ctrlKey && e.shiftKey && key === 'c') {
        if (down && t.term.hasSelection()) navigator.clipboard.writeText(t.term.getSelection());
        return false;
      }
      return !(isMac && e.metaKey); // ⌘ shortcuts stay with Loom and the OS
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
      loadWebgl(t);
      t.term.refresh(0, t.term.rows - 1);
      fitNow(t);
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
        const font = Math.round(FONT * r.k * 2) / 2;
        if (t.term.options.fontSize !== font) t.term.options.fontSize = font;
        if (r.w !== t.w || r.h !== t.h) { t.w = r.w; t.h = r.h; fitSoon(t); }
      } else if (t.focused) release(t);
      setVisible(t, on);
    }

    function layout() {
      for (const t of attached) if (t !== overlaid) position(t);
    }

    function show(n, { focus = false } = {}) {
      const t = terms.get(n.id);
      if (!t) return;
      promote(t);
      if (focus && t.visible) takeFocus(t);
      if (focus && t.term.buffer.active.type === 'alternate') { n.noExpand = false; expand(n); }
    }

    // ------------------------------------------------------------ overlay
    function expand(n) {
      const t = terms.get(n.id);
      if (!t) return;
      if (overlaid && overlaid !== t) collapse();
      promote(t);
      overlaid = t;
      slot.append(t.host);
      Object.assign(t.host.style, { left: '', top: '', width: '', height: '' });
      t.host.hidden = false;
      t.w = 0;
      t.term.options.fontSize = OVERLAY_FONT;
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
      if (terms.has(t.n.id)) {
        layer.append(t.host);
        position(t);
        fitNow(t);
      }
    }

    // ------------------------------------------------------------ text
    // Keeps n.segs current for a running card that has no live view.
    function snapshot(t) {
      const buf = t.term.buffer.active;
      const text = bufferText(buf, Math.max(0, buf.length - SNAPSHOT_LINES));
      t.n.segs = text ? [[0, text]] : [];
      t.lastSnapshot = performance.now();
    }

    // Returns true while a live view covers the card body.
    function refresh(n, again) {
      const t = terms.get(n.id);
      if (!t || t.visible) return !!t;
      const wait = SNAPSHOT_MS - (performance.now() - t.lastSnapshot);
      if (wait <= 0) snapshot(t);
      else if (!t.snapTimer) t.snapTimer = setTimeout(() => { t.snapTimer = null; again(); }, wait);
      return false;
    }

    function snapshotNow(n) {
      const t = terms.get(n.id);
      if (t) snapshot(t);
    }

    function finalText(t) {
      const plain = t.sawAlt || t.rawOver ? null : plainText(t.raw);
      if (plain != null) return plain;
      const text = bufferText(t.term.buffer.normal, 0);
      return t.rawOver ? `[loom: over ${RAW_MAX / 1048576} MB of output, showing the last ${SCROLLBACK.toLocaleString()} lines]\n${text}` : text;
    }

    // The final text of a card that ended, once everything is parsed.
    async function finish(n) {
      const t = terms.get(n.id);
      if (!t) return null;
      await new Promise((r) => t.term.write('', r));
      const focused = !!t.opened && document.activeElement === t.term.textarea;
      if (overlaid === t) collapse();
      const text = finalText(t);
      dispose(n.id);
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
    }

    Ansi.lightTheme.addEventListener('change', () => {
      for (const t of terms.values()) t.term.options.theme = theme();
    });
    window.addEventListener('resize', () => {
      layout();
      if (overlaid) fitNow(overlaid);
    });

    return {
      attach, write, show, layout, expand, collapse, refresh, snapshotNow, finish, dispose,
      isLive: (id) => { const t = terms.get(id); return !!t && t.visible; },
      inAlt: (id) => { const t = terms.get(id); return !!t && t.term.buffer.active.type === 'alternate'; },
      // For the e2e run.
      stats: () => ({ live: attached.size, peak, models: terms.size, overlay: overlaid ? overlaid.n.id : null }),
      term: (id) => { const t = terms.get(id); return t ? t.term : null; },
    };
  }

  g.Terminals = { create, plainText };
})(window);
