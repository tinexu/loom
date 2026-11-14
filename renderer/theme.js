'use strict';
// Loom — applies a theme (UI tokens, the ANSI palette) and the font settings
// to the page, live. Cards, rich views, xterm and the command bar all read
// the same CSS variables or listen here.
(function (g) {
  const FALLBACK = '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace';
  const listeners = [];
  let current = null;
  let fonts = null;

  const emit = (what) => { for (const fn of listeners) fn(what); };

  function apply(t) {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(t.ui)) root.style.setProperty(k, v);
    root.style.colorScheme = t.type;
    root.dataset.theme = t.id;
    document.body.classList.toggle('theme-light', t.type === 'light');
    g.Ansi.setPalette(t.ansi);
    current = t;
    emit('theme');
  }

  // fontFamily, fontSize, lineHeight, fontWeight, ligatures from settings.
  function applyFonts(s) {
    const root = document.documentElement;
    const family = s.fontFamily ? `"${String(s.fontFamily).replace(/["\\]/g, '')}", ${FALLBACK}` : FALLBACK;
    const lineH = Math.max(10, Math.round(s.fontSize * s.lineHeight));
    root.style.setProperty('--mono', family);
    root.style.setProperty('--term-size', `${s.fontSize}px`);
    root.style.setProperty('--term-lh', String(s.lineHeight));
    root.style.setProperty('--line-h', `${lineH}px`);
    root.style.setProperty('--term-weight', String(s.fontWeight));
    root.style.setProperty('--term-lig', s.ligatures ? 'normal' : 'none');
    root.style.setProperty('--bar-size', `${Math.round((s.fontSize + 1.5) * 2) / 2}px`);
    root.style.setProperty('--bar-lh', `${Math.round((s.fontSize + 1.5) * 1.45)}px`);
    fonts = { family, fontFamily: s.fontFamily, size: s.fontSize, lineHeight: s.lineHeight, lineH, weight: s.fontWeight, ligatures: s.ligatures };
    emit('fonts');
  }

  // The theme for the OS's mode, or the one the person fixed.
  function pick(settings, systemDark) {
    const mode = settings.themeMode === 'system' ? (systemDark ? 'dark' : 'light') : settings.themeMode;
    return mode === 'dark' ? settings.themeDark : settings.themeLight;
  }

  // xterm's theme: the card background, so a live terminal sits flush on its card.
  function xterm() {
    const t = current;
    if (!t) return null;
    const a = t.ansi;
    return {
      background: t.ui['--card'], foreground: t.foreground, cursor: t.cursor, cursorAccent: t.cursorAccent, selectionBackground: t.selection,
      black: a[0], red: a[1], green: a[2], yellow: a[3], blue: a[4], magenta: a[5], cyan: a[6], white: a[7],
      brightBlack: a[8], brightRed: a[9], brightGreen: a[10], brightYellow: a[11],
      brightBlue: a[12], brightMagenta: a[13], brightCyan: a[14], brightWhite: a[15],
    };
  }

  // Installed fonts whose 'i' and 'M' are the same width. queryLocalFonts
  // needs permission (main grants it); without it the list is empty and a
  // family can still be typed.
  let monoCache = null;
  async function monospaceFonts() {
    if (monoCache) return monoCache;
    let families = [];
    try {
      const all = await g.queryLocalFonts();
      families = [...new Set(all.map((f) => f.family))];
    } catch { return []; }
    const c = document.createElement('canvas').getContext('2d');
    const width = (fam, s) => { c.font = `20px "${fam}", serif`; return c.measureText(s).width; };
    const serifI = width('__none__', 'iiiiiiiiii');
    monoCache = families.filter((f) => {
      const i = width(f, 'iiiiiiiiii');
      return Math.abs(i - width(f, 'MMMMMMMMMM')) < 0.5 && Math.abs(i - serifI) > 0.01;
    }).sort((a, b) => a.localeCompare(b));
    return monoCache;
  }

  // Lane colors for the git graph, from the palette.
  const lanes = () => { const a = current ? current.ansi : g.Ansi.palette(); return [a[4], a[2], a[3], a[5], a[6], a[1], a[9], a[12]]; };

  g.Theme = { apply, applyFonts, pick, xterm, lanes, monospaceFonts, onChange: (fn) => listeners.push(fn), current: () => current, fonts: () => fonts };
})(window);
