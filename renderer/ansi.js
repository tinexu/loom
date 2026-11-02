'use strict';
// Minimal ANSI → HTML: SGR colors/styles, carriage-return overwrites,
// backspaces; every other escape sequence is dropped.
(function (g) {
  const DARK = [
    '#3d434d', '#f07178', '#a3d983', '#e8c278', '#7aa8f5', '#c792ea', '#6cd0d0', '#c9ced6',
    '#69707c', '#ff8f96', '#bdeb9f', '#f5d491', '#9cc0ff', '#dcabff', '#8ee6e6', '#f2f4f7',
  ];
  // On a white card, "yellow" and "white" have to be dark enough to read.
  const LIGHT = [
    '#1b1f25', '#c4323b', '#237a3e', '#8a6100', '#2a5fc9', '#8a3fb5', '#14787d', '#5d6573',
    '#4a515c', '#b8323b', '#1f6b37', '#7a5600', '#2353b0', '#7a35a3', '#106a6f', '#3f4650',
  ];
  const lightTheme = window.matchMedia('(prefers-color-scheme: light)');
  const palette = () => (lightTheme.matches ? LIGHT : DARK);
  const RE = /\x1b\[([0-9;?]*)([ -\/]*[@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMc]/g;

  function c256(n) {
    if (n < 16) return palette()[n];
    if (n < 232) {
      n -= 16;
      const v = (x) => (x ? x * 40 + 55 : 0);
      return `rgb(${v(Math.floor(n / 36))},${v(Math.floor(n / 6) % 6)},${v(n % 6)})`;
    }
    const l = 8 + (n - 232) * 10;
    return `rgb(${l},${l},${l})`;
  }

  const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const strip = (s) => s.replace(RE, '');

  function normalize(text) {
    if (!/[\r\x08]/.test(text)) return text;
    return text.split('\n').map((line) => {
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.includes('\r')) line = line.split('\r').filter((p) => p.length).pop() || '';
      while (line.includes('\x08')) {
        const next = line.replace(/[^\x08]\x08/, '').replace(/^\x08+/, '');
        if (next === line) break;
        line = next;
      }
      return line;
    }).join('\n');
  }

  function applySGR(st, params) {
    const codes = params === '' ? [0] : params.split(';').map((x) => parseInt(x || '0', 10));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { for (const k in st) delete st[k]; }
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 3) st.italic = true;
      else if (c === 4) st.underline = true;
      else if (c === 7) st.inverse = true;
      else if (c === 22) { st.bold = false; st.dim = false; }
      else if (c === 23) st.italic = false;
      else if (c === 24) st.underline = false;
      else if (c === 27) st.inverse = false;
      else if (c >= 30 && c <= 37) st.fg = palette()[c - 30];
      else if (c >= 90 && c <= 97) st.fg = palette()[c - 90 + 8];
      else if (c >= 40 && c <= 47) st.bg = palette()[c - 40];
      else if (c >= 100 && c <= 107) st.bg = palette()[c - 100 + 8];
      else if (c === 39) delete st.fg;
      else if (c === 49) delete st.bg;
      else if (c === 38 || c === 48) {
        const key = c === 38 ? 'fg' : 'bg';
        if (codes[i + 1] === 5) { st[key] = c256(codes[i + 2] || 0); i += 2; }
        else if (codes[i + 1] === 2) { st[key] = `rgb(${codes[i + 2] | 0},${codes[i + 3] | 0},${codes[i + 4] | 0})`; i += 4; }
      }
    }
  }

  function styleOf(st) {
    let fg = st.fg; let bg = st.bg;
    if (st.inverse) { fg = st.bg || 'var(--card)'; bg = st.fg || 'var(--text)'; }
    let css = '';
    if (fg) css += `color:${fg};`;
    if (bg) css += `background:${bg};`;
    if (st.bold) css += 'font-weight:600;';
    if (st.dim) css += 'opacity:.65;';
    if (st.italic) css += 'font-style:italic;';
    if (st.underline) css += 'text-decoration:underline;';
    return css;
  }

  function toHtml(text) {
    text = normalize(text);
    const st = {};
    let out = '';
    let last = 0;
    let m;
    const emit = (chunk) => {
      if (!chunk) return;
      const css = styleOf(st);
      out += css ? `<span style="${css}">${escapeHtml(chunk)}</span>` : escapeHtml(chunk);
    };
    RE.lastIndex = 0;
    while ((m = RE.exec(text))) {
      emit(text.slice(last, m.index));
      last = RE.lastIndex;
      if (m[2] === 'm' && m[1] !== undefined && !m[1].startsWith('?')) applySGR(st, m[1]);
    }
    emit(text.slice(last));
    return out;
  }

  g.Ansi = { toHtml, strip, escapeHtml, normalize, palette, lightTheme };
})(window);
