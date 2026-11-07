'use strict';
// Loom — the command bar's editor. A <textarea> with transparent text sits
// over a <pre> mirror that shows the same text highlighted, so the browser
// keeps caret, selection, IME, undo and paste. On top: fish-style ghost text
// from history, a Tab completion popup fed by main.js, and Ctrl+R search.
(function () {
  const { ShellLex, Fuzzy } = window;

  const LINE = 20; // px, matches styles.css
  const MAX_LINES = 10;
  // Known even before the shell has answered, so `cd` is never red.
  const BASICS = new Set(['cd', 'echo', 'export', 'source', '.', 'alias', 'unalias', 'unset', 'set', 'exit', 'return', 'eval', 'exec',
    'read', 'printf', 'test', '[', '[[', ']]', 'true', 'false', 'type', 'history', 'jobs', 'fg', 'bg', 'kill', 'wait', 'trap', 'pwd',
    'pushd', 'popd', 'dirs', 'local', 'declare', 'typeset', 'let', 'shift', 'ulimit', 'umask', 'hash', 'command', 'builtin', 'if',
    'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', 'function', 'select', 'time', '!', '{',
    '}', 'noglob', 'nocorrect', 'disown', 'logout', 'times', 'getopts', 'readonly', 'enable', 'help', 'mapfile', 'compgen', 'complete']);
  const TOKEN_CLASS = { command: 'tk-cmd', flag: 'tk-flag', string: 'tk-str', var: 'tk-var', op: 'tk-op', comment: 'tk-comment', glob: 'tk-glob', heredoc: 'tk-heredoc' };
  const ICON = {
    dir: '<svg viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.5 1.5h4.7A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>',
    file: '<svg viewBox="0 0 16 16"><path d="M4.5 2h4.8L12 4.7v8.8a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5z"/><path d="M9 2v3h3"/></svg>',
    cmd: '<svg viewBox="0 0 16 16"><path d="M3.5 5l3 3-3 3M8.5 11.5h4"/></svg>',
    branch: '<svg viewBox="0 0 16 16"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-6.2 4.3"/></svg>',
    var: '<svg viewBox="0 0 16 16"><path d="M6 3C4 3 4.5 7 3 8c1.5 1 1 5 3 5M10 3c2 0 1.5 4 3 5-1.5 1-1 5-3 5"/></svg>',
  };
  const BADGE = { alias: 'A', function: 'ƒ', builtin: 'B', flag: '−', sub: 'S', tag: 'T', remote: 'R', script: '▸', target: 'M', host: 'H', container: 'D', process: 'P', value: '·' };
  ICON.remote = ICON.branch;

  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const commonPrefix = (list) => list.reduce((p, s) => { let i = 0; while (i < p.length && p[i] === s[i]) i++; return p.slice(0, i); });

  function marked(text, hl) {
    if (!hl || !hl.length) return esc(text);
    const set = new Set(hl);
    let out = '';
    for (let i = 0; i < text.length; i++) out += set.has(i) ? `<b>${esc(text[i])}</b>` : esc(text[i]);
    return out.replace(/<\/b><b>/g, '');
  }

  // o: { api, input, mirror, popup, search, hint, context(), records(), mode(),
  //      defaultHint(), onRun(text), fmt: { tilde, ago } }
  function create(o) {
    const { api, input: ta, mirror, popup, search } = o;
    const q = search.querySelector('.hs-q');
    const list = search.querySelector('.hs-list');
    const scopesEl = search.querySelector('.hs-scopes');
    const SCOPES = [['branch', 'This branch'], ['folder', 'This folder'], ['all', 'All']];

    let known = { key: null, commands: null };
    const paths = new Map(); // `${cwd}\0${word}` -> { e, d, x, at }
    const wanted = new Set();
    let ghost = '';
    let comp = null; // open popup: { items, sel, end }
    let seq = 0;
    let hist = null; // ↑/↓: { list, idx, draft }
    let composing = false;
    let hintNote = '';
    let hintTimer = null;
    const stats = { lastComplete: null };

    // ------------------------------------------------------------ shell info
    async function refreshInfo() {
      const c = o.context();
      try {
        const res = await api.shellInfo({ cardId: c.cardId, envFile: c.envFile, have: known.key });
        if (res && res.commands) known = { key: res.key, commands: res.commands };
        render();
      } catch { /* window going away */ }
    }
    setInterval(refreshInfo, 60000);

    function commandOk(w) {
      if (w.dynamic || w.glob || !w.value) return true;
      if (w.value.includes('/')) {
        const p = pathInfo(w.value);
        return p ? p.e && (p.x || p.d) : true;
      }
      if (BASICS.has(w.value) || Object.prototype.hasOwnProperty.call(ShellLex.PREFIXES, w.value)) return true;
      if (!known.commands) return true; // not loaded yet: don't flash red
      return Object.prototype.hasOwnProperty.call(known.commands, w.value);
    }

    // ------------------------------------------------------------ path checks
    // Checked in batches: words collect for 120 ms, then one IPC call.
    const asking = new Set();
    let pathTimer = null;
    function pathInfo(word) {
      const cwd = o.context().cwd;
      const k = `${cwd}\0${word}`;
      const hit = paths.get(k);
      if (hit && Date.now() - hit.at < 5000) return hit;
      if (!asking.has(k)) {
        wanted.add(word);
        if (!pathTimer) pathTimer = setTimeout(checkPaths, 120);
      }
      return hit || null;
    }
    async function checkPaths() {
      pathTimer = null;
      const cwd = o.context().cwd;
      const batch = [...wanted].slice(0, 200);
      wanted.clear();
      if (!batch.length) return;
      const keys = batch.map((p) => `${cwd}\0${p}`);
      keys.forEach((k) => asking.add(k));
      let res = [];
      try { res = await api.pathsExist({ cwd, paths: batch }); } catch { /* window going away */ }
      const now = Date.now();
      keys.forEach((k, i) => { asking.delete(k); paths.set(k, { ...(res[i] || { e: false }), at: now }); });
      while (paths.size > 2000) paths.delete(paths.keys().next().value);
      render();
    }

    // ------------------------------------------------------------ rendering
    function highlight(text) {
      const r = ShellLex.lex(text);
      const cls = new Array(text.length).fill('');
      for (const t of r.tokens) {
        const c = TOKEN_CLASS[t.type] || '';
        for (let i = t.start; i < t.end && i < text.length; i++) cls[i] = c;
      }
      for (const w of r.words) {
        if (w.type === 'command' && !commandOk(w)) {
          for (let i = w.start; i < w.end; i++) if (cls[i] === 'tk-cmd') cls[i] = 'tk-bad';
        } else if ((w.type === 'arg' || w.type === 'command') && !w.dynamic && !w.glob && w.value && w.value.length < 512 && !w.value.startsWith('-')) {
          if (w.type === 'command' && !w.value.includes('/')) continue;
          const p = pathInfo(w.value);
          if (p && p.e) for (let i = w.start; i < w.end; i++) cls[i] += ' tk-path';
        }
      }
      const caret = ta.selectionStart;
      let html = '';
      let run = '';
      let cur = null;
      const flush = () => { if (run) html += cur ? `<span class="${cur.trim()}">${esc(run)}</span>` : esc(run); run = ''; };
      for (let i = 0; i <= text.length; i++) {
        if (i === caret) { flush(); html += '<span class="caret-mark"></span>'; }
        if (i === text.length) break;
        if (cls[i] !== cur) { flush(); cur = cls[i]; }
        run += text[i];
      }
      flush();
      return html;
    }

    function render() {
      const text = ta.value;
      const shell = o.mode() === 'shell';
      const atEnd = ta.selectionStart === text.length && ta.selectionEnd === text.length;
      ghost = '';
      if (shell && !comp && atEnd && !composing && text.trim() && document.activeElement === ta) {
        const s = Fuzzy.suggest(o.records(), text, o.context().cwd);
        if (s) ghost = s.slice(text.length);
      }
      mirror.innerHTML = shell && !composing
        ? `${highlight(text)}${ghost ? `<span class="ghost">${esc(ghost)}</span>` : ''}${text.endsWith('\n') && !ghost ? ' ' : ''}`
        : '';
      autosize();
      updateHint(text);
    }

    function autosize() {
      ta.style.height = 'auto';
      const h = Math.min(ta.scrollHeight, MAX_LINES * LINE + 12);
      ta.style.height = `${h}px`;
      mirror.style.height = `${h}px`;
      mirror.scrollTop = ta.scrollTop;
    }

    function updateHint(text) {
      let h = hintNote || o.defaultHint();
      if (!hintNote && o.mode() === 'shell' && text.includes('\n')) {
        const n = text.replace(/\n+$/, '').split('\n').length;
        h = ShellLex.isIncomplete(text) ? `${n} lines · unfinished, Enter adds a line` : `${n} lines · Enter to run`;
      }
      if (o.hint.textContent !== h) o.hint.textContent = h;
    }

    function flash(note) {
      hintNote = note;
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => { hintNote = ''; updateHint(ta.value); }, 1600);
      updateHint(ta.value);
    }

    // ------------------------------------------------------------ editing
    // execCommand keeps the browser's undo stack, which setting .value wipes.
    function replace(start, end, text) {
      ta.focus();
      ta.setSelectionRange(start, end);
      if (text) document.execCommand('insertText', false, text);
      else if (start !== end) document.execCommand('delete');
      render();
    }

    function setValue(text, { undoable = true } = {}) {
      if (undoable) replace(0, ta.value.length, text);
      else { ta.value = text; ta.setSelectionRange(text.length, text.length); render(); }
    }

    function clear() {
      ta.value = '';
      hist = null;
      closePopup();
      render();
    }

    ta.addEventListener('input', () => {
      hist = null;
      render();
      if (comp) requestCompletion({});
    });
    ta.addEventListener('scroll', () => { mirror.scrollTop = ta.scrollTop; });
    ta.addEventListener('compositionstart', () => { composing = true; ta.classList.add('composing'); render(); });
    ta.addEventListener('compositionend', () => { composing = false; ta.classList.remove('composing'); render(); });
    ta.addEventListener('focus', () => { render(); refreshInfo(); });
    ta.addEventListener('blur', () => { closePopup(); render(); });
    ta.addEventListener('click', () => { closePopup(); render(); });
    document.addEventListener('selectionchange', () => { if (document.activeElement === ta && !composing) render(); });

    // A multi-line paste never runs by itself: it lands as text, minus the
    // trailing newline a copied script usually has.
    ta.addEventListener('paste', (e) => {
      const text = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!text || !text.includes('\n')) return;
      e.preventDefault();
      document.execCommand('insertText', false, text.replace(/\r\n?/g, '\n').replace(/\n+$/, ''));
    });

    // ------------------------------------------------------------ completion
    async function requestCompletion({ tab = false }) {
      const id = ++seq;
      const text = ta.value;
      const caret = ta.selectionStart;
      const c = o.context();
      const t0 = performance.now();
      const res = await api.complete({ text, caret, cwd: c.cwd, cardId: c.cardId, envFile: c.envFile });
      if (id !== seq || ta.value !== text || ta.selectionStart !== caret || document.activeElement !== ta) return;
      stats.lastComplete = performance.now() - t0;
      if (!res || !res.items.length) {
        closePopup();
        if (tab) flash('No completions');
        return;
      }
      if (tab) {
        if (res.items.length === 1) { accept(res.items[0], res.end); return; }
        const start = res.items[0].start;
        if (res.items.every((i) => i.start === start)) {
          const prefix = commonPrefix(res.items.map((i) => i.insert)).replace(/(^|[^\\])(\\\\)*\\$/, (m) => m.slice(0, -1));
          const typed = text.slice(start, caret);
          if (prefix.length > typed.length && prefix.startsWith(typed)) {
            replace(start, res.end, prefix);
            requestCompletion({});
            return;
          }
        }
      }
      openPopup(res);
    }

    function accept(item, end) {
      closePopup();
      replace(item.start, end, item.insert);
      if (item.reopen) requestCompletion({});
    }

    function openPopup(res) {
      comp = { items: res.items, sel: 0, end: res.end };
      ghost = '';
      render();
      const mark = mirror.querySelector('.caret-mark');
      const bar = popup.parentElement.getBoundingClientRect();
      const x = mark ? mark.getBoundingClientRect().left - bar.left : 0;
      popup.hidden = false;
      popup.innerHTML = res.items.map((it, i) => {
        const icon = ICON[it.kind] ? `<span class="cp-icon k-${it.kind}">${ICON[it.kind]}</span>`
          : `<span class="cp-icon cp-badge k-${it.kind}">${BADGE[it.kind] || '·'}</span>`;
        return `<div class="cp-row${i === 0 ? ' sel' : ''}" data-i="${i}">${icon}<span class="cp-label">${marked(it.label, it.hl)}</span>`
          + `${it.alt ? `<span class="cp-alt">${esc(it.alt)}</span>` : ''}<span class="cp-desc">${esc(it.desc.split('\n')[0])}</span></div>`;
      }).join('');
      const w = Math.min(popup.offsetWidth, bar.width);
      popup.style.left = `${Math.max(0, Math.min(x - 34, bar.width - w))}px`;
    }

    function select(i) {
      if (!comp) return;
      const n = comp.items.length;
      comp.sel = (i + n) % n;
      popup.querySelectorAll('.cp-row.sel').forEach((r) => r.classList.remove('sel'));
      const row = popup.querySelector(`.cp-row[data-i="${comp.sel}"]`);
      if (row) { row.classList.add('sel'); row.scrollIntoView({ block: 'nearest' }); }
    }

    function closePopup() {
      if (!comp && popup.hidden) return;
      comp = null;
      seq++;
      popup.hidden = true;
      popup.innerHTML = '';
    }

    popup.addEventListener('mousedown', (e) => {
      const row = e.target.closest('.cp-row');
      e.preventDefault();
      if (row && comp) accept(comp.items[Number(row.dataset.i)], comp.end);
    });

    // ------------------------------------------------------------ history search (Ctrl+R)
    let hs = null; // { scope, entries: Map scope -> aggregated, results, sel }

    function scopeRecords(scope) {
      const c = o.context();
      const all = o.records();
      if (scope === 'branch') return all.filter((r) => r.rootId != null && r.rootId === c.rootId);
      if (scope === 'folder') return all.filter((r) => r.cwd === c.cwd);
      return all;
    }

    function openSearch() {
      closePopup();
      const c = o.context();
      hs = { scope: c.rootId != null ? 0 : 1, entries: new Map(), results: [], sel: 0 };
      search.hidden = false;
      q.value = ta.value.includes('\n') ? '' : ta.value;
      q.focus();
      q.select();
      runSearch();
    }

    function closeSearch({ focus = true } = {}) {
      if (!hs) return;
      hs = null;
      search.hidden = true;
      list.innerHTML = '';
      if (focus) ta.focus();
    }

    function runSearch() {
      if (!hs) return;
      const scope = SCOPES[hs.scope][0];
      scopesEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.scope === scope));
      let entries = hs.entries.get(scope);
      if (!entries) { entries = Fuzzy.aggregate(scopeRecords(scope)); hs.entries.set(scope, entries); }
      const t0 = performance.now();
      hs.results = Fuzzy.rank(entries, q.value.trim(), { cwd: o.context().cwd });
      stats.lastSearch = performance.now() - t0;
      hs.sel = 0;
      if (!hs.results.length) {
        list.innerHTML = `<div class="hs-empty">${entries.length ? 'No matches' : 'Nothing here yet'}${hs.scope < 2 ? ' · Ctrl+R to widen' : ''}</div>`;
        return;
      }
      list.innerHTML = hs.results.map((r, i) => {
        const rec = r.entry.last;
        const st = rec.exitCode == null ? 'unknown' : rec.exitCode === 0 ? 'ok' : 'err';
        const first = r.entry.cmd.split('\n')[0];
        const more = r.entry.cmd.includes('\n') ? ' <span class="hs-more">⏎…</span>' : '';
        return `<div class="hs-row${i === 0 ? ' sel' : ''}" data-i="${i}"><span class="hs-dot s-${st}" title="${rec.exitCode == null ? 'exit code unknown' : `exit ${rec.exitCode}`}"></span>`
          + `<span class="hs-cmd">${marked(first, r.hl.filter((k) => k < first.length))}${more}</span>`
          + `<span class="hs-cwd"><bdi>${esc(rec.cwd ? o.fmt.tilde(rec.cwd) : '')}</bdi></span>`
          + `<span class="hs-time">${rec.startedAt ? o.fmt.ago(rec.startedAt) : ''}</span></div>`;
      }).join('');
    }

    function moveSearch(d) {
      if (!hs || !hs.results.length) return;
      hs.sel = (hs.sel + d + hs.results.length) % hs.results.length;
      list.querySelectorAll('.hs-row.sel').forEach((r) => r.classList.remove('sel'));
      const row = list.querySelector(`.hs-row[data-i="${hs.sel}"]`);
      if (row) { row.classList.add('sel'); row.scrollIntoView({ block: 'nearest' }); }
    }

    function pickSearch(run) {
      const r = hs && hs.results[hs.sel];
      closeSearch();
      if (!r) return;
      if (run) { clear(); o.onRun(r.entry.cmd); return; }
      setValue(r.entry.cmd);
    }

    let searchFrame = 0;
    q.addEventListener('input', () => {
      cancelAnimationFrame(searchFrame);
      searchFrame = requestAnimationFrame(runSearch);
    });
    q.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      const k = e.key;
      if (k === 'ArrowDown' || (k === 'n' && e.ctrlKey)) { e.preventDefault(); moveSearch(1); }
      else if (k === 'ArrowUp' || (k === 'p' && e.ctrlKey)) { e.preventDefault(); moveSearch(-1); }
      else if (k === 'Enter') { e.preventDefault(); pickSearch(e.shiftKey); }
      else if (k === 'Escape' || (k === 'g' && e.ctrlKey) || (k === 'c' && e.ctrlKey)) { e.preventDefault(); closeSearch(); }
      else if (k === 'r' && e.ctrlKey && !e.metaKey) { e.preventDefault(); hs.scope = (hs.scope + 1) % SCOPES.length; runSearch(); }
      else if (k === 'Tab') { e.preventDefault(); pickSearch(false); }
      e.stopPropagation();
    });
    q.addEventListener('blur', () => setTimeout(() => { if (hs && document.activeElement !== q) closeSearch({ focus: false }); }, 0));
    scopesEl.addEventListener('mousedown', (e) => {
      const b = e.target.closest('button');
      if (!b || !hs) return;
      e.preventDefault();
      hs.scope = SCOPES.findIndex(([s]) => s === b.dataset.scope);
      runSearch();
    });
    list.addEventListener('mousedown', (e) => {
      const row = e.target.closest('.hs-row');
      if (!row || !hs) return;
      e.preventDefault();
      hs.sel = Number(row.dataset.i);
      pickSearch(e.shiftKey);
    });

    // ------------------------------------------------------------ keys
    // Returns true when the key was the editor's.
    function handleKey(e) {
      if (e.isComposing || composing) return false;
      const k = e.key;
      const mod = e.metaKey || e.ctrlKey;
      const shell = o.mode() === 'shell';
      const take = () => { e.preventDefault(); e.stopPropagation(); return true; };

      if (comp) {
        if (k === 'ArrowDown' || (k === 'Tab' && !e.shiftKey)) {
          if (k === 'Tab' && comp.items.length === 1) { accept(comp.items[0], comp.end); return take(); }
          select(comp.sel + 1);
          return take();
        }
        if (k === 'ArrowUp' || (k === 'Tab' && e.shiftKey)) { select(comp.sel - 1); return take(); }
        if (k === 'Enter') { accept(comp.items[comp.sel], comp.end); return take(); }
        if (k === 'Escape') { closePopup(); render(); return take(); }
        if (k === 'PageDown') { select(Math.min(comp.items.length - 1, comp.sel + 10)); return take(); }
        if (k === 'PageUp') { select(Math.max(0, comp.sel - 10)); return take(); }
        if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End') closePopup();
      }

      if (k === 'Tab') {
        if (shell && !e.shiftKey && !mod && !e.altKey) requestCompletion({ tab: true });
        return take(); // never tab out of the bar
      }
      if (k === 'r' && e.ctrlKey && !e.metaKey && !e.altKey) { openSearch(); return take(); }

      const v = ta.value;
      const s = ta.selectionStart;
      const atEnd = s === v.length && ta.selectionEnd === v.length;
      if (ghost && atEnd && !e.shiftKey && !mod) {
        if ((k === 'ArrowRight' || k === 'End') && !e.altKey) { replace(v.length, v.length, ghost); return take(); }
        if (k === 'ArrowRight' && e.altKey) { replace(v.length, v.length, /^\s*\S+/.exec(ghost)[0]); return take(); }
        if (k === 'f' && e.altKey) { replace(v.length, v.length, /^\s*\S+/.exec(ghost)[0]); return take(); }
      }

      if ((k === 'ArrowUp' || k === 'ArrowDown') && shell && !e.altKey && !mod && !e.shiftKey) {
        const firstLine = !v.slice(0, s).includes('\n');
        const lastLine = !v.slice(ta.selectionEnd).includes('\n');
        if (k === 'ArrowUp' && firstLine) {
          // A multi-line draft isn't a prefix anyone types; browse everything.
          if (!hist) hist = { list: Fuzzy.prefixed(o.records(), v.includes('\n') ? '' : v), idx: -1, draft: v };
          if (hist.idx + 1 >= hist.list.length) return take();
          hist.idx++;
          setValue(hist.list[hist.idx], { undoable: false });
          return take();
        }
        if (k === 'ArrowDown' && lastLine && hist) {
          hist.idx--;
          setValue(hist.idx < 0 ? hist.draft : hist.list[hist.idx], { undoable: false });
          if (hist.idx < 0) hist = null;
          return take();
        }
      }
      return false;
    }

    function newline() { replace(ta.selectionStart, ta.selectionEnd, '\n'); }

    return {
      handleKey, render, refreshInfo, setValue, clear, openSearch, closeSearch, closePopup, newline,
      value: () => ta.value,
      busy: () => !!comp || !!hs,
      stats: () => ({ ...stats, ghost, popup: comp ? comp.items.map((i) => i.label) : null, search: hs ? { scope: SCOPES[hs.scope][0], results: hs.results.map((r) => r.entry.cmd) } : null }),
    };
  }

  window.Editor = { create };
}());
