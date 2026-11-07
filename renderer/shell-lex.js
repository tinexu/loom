'use strict';
// Loom — a small POSIX-ish shell lexer for the command bar.
// It's not a parser: it finds words, quotes, expansions and operators well
// enough to highlight a line, tell whether Enter should run it, and say what
// the word under the caret is for completion. Loaded by the page as
// window.ShellLex and by main.js / the tests with require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShellLex = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  // Words after these are still in command position: `sudo make`, `time ls`.
  // Each lists its flags that take a value, so `sudo -u root ls` finds `ls`.
  const PREFIXES = {
    sudo: ['-u', '-g', '-h', '-p', '-C', '-U', '-D', '-r', '-t', '-T'],
    doas: ['-u', '-C'],
    env: ['-u', '-C', '-S'],
    time: [],
    xargs: ['-I', '-n', '-L', '-P', '-d', '-E', '-s', '-a'],
    nohup: [],
    nice: ['-n'],
    command: [],
    builtin: [],
    exec: ['-a'],
    noglob: [],
  };
  // Reserved words after which a command follows.
  const LEADERS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);

  const OPS = ['&>>', '<<<', '<<-', '&&', '||', '|&', ';;', '&>', '>>', '>|', '<<', '<>', '<&', '>&', '|', ';', '&', '>', '<'];
  const CONTROL = new Set(['&&', '||', '|&', ';;', '|', ';', '&']);
  const BREAK = new Set([' ', '\t', '\n', ';', '|', '&', '<', '>', '(', ')']);

  function lex(src) {
    const n = src.length;
    const tokens = []; // {type, start, end}, painted in order, so later ones win
    const words = []; // {start, end, raw, value, type, seg, quoted, dynamic, glob}
    const open = []; // unclosed constructs, innermost last
    const heredocs = []; // delimiters waiting for the next newline
    let heredocOpen = false;
    let i = 0;
    let segs = 0;
    let last = null; // last significant token, for trailing `|` and `&&`
    let W = null; // the word being read
    let endState = null; // command state where the input ran out

    const tok = (type, start, end) => {
      const t = { type, start, end };
      tokens.push(t);
      return t;
    };
    const newState = () => ({ seg: segs++, cmdPos: true, prefix: null, skipArg: false, redirect: false, heredoc: null, command: null });
    const reset = (st) => Object.assign(st, newState());

    // A redirect, with any fd in front: `2>`, `2>&1`, `&>`, `>>`.
    function operatorAt() {
      const s = src.slice(i, i + 12);
      const dup = /^\d*>&(?:\d+|-)(?=$|[\s;|&<>()])/.exec(s);
      if (dup) return dup[0];
      const fd = (/^\d+(?=[<>])/.exec(s) || [''])[0];
      for (const op of OPS) {
        if (s.startsWith(op, fd.length) && (!fd || op[0] === '<' || op[0] === '>')) return fd + op;
      }
      return null;
    }

    function operator(op, st) {
      const t = tok('op', i, i + op.length);
      t.text = op;
      i += op.length;
      last = { type: 'op', text: op };
      const bare = op.replace(/^\d+/, '');
      if (CONTROL.has(bare)) reset(st);
      else if (bare === '<<' || bare === '<<-') st.heredoc = { strip: bare === '<<-' };
      else if (!/&(\d+|-)$/.test(bare)) st.redirect = true;
    }

    function readHeredocs() {
      while (heredocs.length && i <= n) {
        const h = heredocs.shift();
        const bodyStart = i;
        let found = false;
        while (i < n) {
          const nl = src.indexOf('\n', i);
          const lineEnd = nl < 0 ? n : nl;
          let line = src.slice(i, lineEnd);
          if (h.strip) line = line.replace(/^\t+/, '');
          i = nl < 0 ? n : nl + 1;
          if (line === h.delim) { found = true; break; }
        }
        if (i > bodyStart) tok('heredoc', bodyStart, i);
        if (!found) { heredocOpen = true; heredocs.length = 0; }
      }
    }

    // Commands until `close` (a `)`, `}` or backtick) or the end of input.
    // Returns true with i on the closer, false if the input ran out.
    function commands(close) {
      const st = newState();
      while (i < n) {
        const c = src[i];
        if (c === ' ' || c === '\t') { i++; continue; }
        if (c === '\n') {
          i++;
          reset(st);
          readHeredocs();
          continue;
        }
        if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
        if (c === '#') {
          const e = src.indexOf('\n', i);
          tok('comment', i, e < 0 ? n : e);
          i = e < 0 ? n : e;
          continue;
        }
        if (close && c === close && (close !== '}' || st.cmdPos)) return true;
        const op = operatorAt();
        if (op) { operator(op, st); continue; }
        if (c === '(') {
          if (src[i + 1] === '(') { // (( arithmetic ))
            const e = src.indexOf('))', i + 2);
            if (e < 0) { tok('var', i, n); open.push('(('); i = n; break; }
            tok('var', i, e + 2);
            i = e + 2;
            st.cmdPos = false;
            last = { type: 'word' };
            continue;
          }
          tok('op', i, i + 1).text = '(';
          i++;
          open.push('(');
          last = { type: 'op', text: '(' };
          if (!commands(')')) { if (!endState) endState = st; return false; }
          open.pop();
          tok('op', i, i + 1).text = ')';
          i++;
          st.cmdPos = false;
          last = { type: 'op', text: ')' };
          continue;
        }
        if (c === ')') { tok('op', i, i + 1).text = ')'; i++; last = { type: 'op', text: ')' }; continue; }
        if (c === '{' && st.cmdPos && /[\s]/.test(src[i + 1] || '\n')) {
          tok('op', i, i + 1).text = '{';
          i++;
          open.push('{');
          last = { type: 'op', text: '{' };
          if (!commands('}')) { if (!endState) endState = st; return false; }
          open.pop();
          tok('op', i, i + 1).text = '}';
          i++;
          st.cmdPos = false;
          last = { type: 'op', text: '}' };
          continue;
        }
        if (!word(st, close)) { if (!endState) endState = st; return false; }
      }
      if (!endState) endState = st;
      return false;
    }

    function dquote() {
      const t = tok('string', i, n);
      W.quoted = true;
      i++;
      while (i < n) {
        const c = src[i];
        if (c === '\\' && i + 1 < n) {
          const d = src[i + 1];
          if (d !== '\n') W.value += '$`"\\'.includes(d) ? d : `\\${d}`;
          i += 2;
          continue;
        }
        if (c === '"') { i++; t.end = i; return true; }
        if (c === '$') {
          const r = dollar();
          if (r === false) return false;
          if (r === null) { W.value += '$'; i++; }
          continue;
        }
        if (c === '`') { if (!backtick()) return false; continue; }
        W.value += c;
        i++;
      }
      open.push('"');
      return false;
    }

    // `$NAME`, `${…}`, `$(…)`, `$((…))`. Returns true, false at the end of
    // input inside it, or null for a literal `$`.
    function dollar() {
      const s = i;
      const d = src[i + 1];
      const was = W.dynamic;
      W.dynamic = true;
      if (d === '(') {
        if (src[i + 2] === '(') {
          const e = src.indexOf('))', i + 3);
          if (e < 0) { tok('var', s, n); open.push('$(('); i = n; return false; }
          tok('var', s, e + 2);
          W.value += src.slice(s, e + 2);
          i = e + 2;
          return true;
        }
        tok('var', s, s + 2);
        i = s + 2;
        open.push('$(');
        const outer = W;
        const closed = commands(')');
        W = outer;
        if (!closed) return false;
        open.pop();
        tok('var', i, i + 1);
        i++;
        W.value += src.slice(s, i);
        return true;
      }
      if (d === '{') {
        let depth = 0;
        let e = i + 1;
        for (; e < n; e++) {
          if (src[e] === '{') depth++;
          else if (src[e] === '}' && --depth === 0) break;
        }
        if (e >= n) { tok('var', s, n); open.push('${'); W.value += src.slice(s); i = n; return false; }
        tok('var', s, e + 1);
        W.value += src.slice(s, e + 1);
        i = e + 1;
        return true;
      }
      const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9?#@*!$-])/.exec(src.slice(i, i + 256));
      if (m) {
        tok('var', s, s + m[0].length);
        W.value += m[0];
        i += m[0].length;
        return true;
      }
      W.dynamic = was;
      return null;
    }

    function backtick() {
      W.dynamic = true;
      const s = i;
      tok('var', i, i + 1);
      i++;
      open.push('`');
      const outer = W;
      const closed = commands('`');
      W = outer;
      if (!closed) return false;
      open.pop();
      tok('var', i, i + 1);
      i++;
      W.value += src.slice(s, i);
      return true;
    }

    // One word. Returns false if the input ran out inside a quote or expansion.
    function word(st, close) {
      const start = i;
      const base = tok('arg', start, start);
      const outer = W;
      W = { value: '', quoted: false, dynamic: false, glob: false };
      let ok = true;
      let quote = null;
      while (i < n) {
        const c = src[i];
        if (BREAK.has(c) || (c === '`' && close === '`')) break;
        if (c === '\\') {
          if (i + 1 >= n) { open.push('\\'); quote = '\\'; i++; ok = false; break; }
          if (src[i + 1] !== '\n') W.value += src[i + 1];
          i += 2;
          continue;
        }
        if (c === "'") {
          W.quoted = true;
          const e = src.indexOf("'", i + 1);
          if (e < 0) { tok('string', i, n); W.value += src.slice(i + 1); open.push("'"); quote = "'"; i = n; ok = false; break; }
          tok('string', i, e + 1);
          W.value += src.slice(i + 1, e);
          i = e + 1;
          continue;
        }
        if (c === '$' && src[i + 1] === "'") {
          W.quoted = true;
          let e = i + 2;
          let v = '';
          for (; e < n && src[e] !== "'"; e++) {
            if (src[e] === '\\' && e + 1 < n) { e++; v += ({ n: '\n', t: '\t', e: '\x1b' })[src[e]] || src[e]; } else v += src[e];
          }
          W.value += v;
          if (e >= n) { tok('string', i, n); open.push("$'"); quote = "'"; i = n; ok = false; break; }
          tok('string', i, e + 1);
          i = e + 1;
          continue;
        }
        if (c === '"') {
          if (!dquote()) { quote = '"'; ok = false; break; }
          continue;
        }
        if (c === '$') {
          const r = dollar();
          if (r === false) { ok = false; break; }
          if (r === null) { W.value += '$'; i++; }
          continue;
        }
        if (c === '`') {
          if (!backtick()) { ok = false; break; }
          continue;
        }
        if (c === '*' || c === '?') {
          tok('glob', i, i + 1);
          W.glob = true;
          W.value += c;
          i++;
          continue;
        }
        if (c === '[') {
          const e = src.indexOf(']', i + 1);
          if (e > i + 1 && !/[\s|&;<>()]/.test(src.slice(i + 1, e))) {
            tok('glob', i, e + 1);
            W.glob = true;
            W.value += src.slice(i, e + 1);
            i = e + 1;
            continue;
          }
        }
        W.value += c;
        i++;
      }
      if (i === start) i++; // never stall on a stray character
      base.end = i;
      const raw = src.slice(start, i);
      const w = { start, end: i, raw, value: W.value, seg: st.seg, quoted: W.quoted, dynamic: W.dynamic, glob: W.glob, quote, type: 'arg' };
      W = outer;

      if (st.heredoc) {
        heredocs.push({ delim: w.value, strip: st.heredoc.strip });
        st.heredoc = null;
        w.type = 'heredoc';
      } else if (st.redirect) {
        st.redirect = false;
        w.redirect = true;
      } else if (st.cmdPos) {
        const assign = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.exec(raw);
        if (assign) {
          w.type = 'assign';
          tok('var', start, start + assign[0].length - 1);
        } else if (st.skipArg) {
          st.skipArg = false;
        } else if (st.prefix && raw.startsWith('-') && !w.quoted) {
          w.type = 'flag';
          if ((PREFIXES[st.prefix] || []).includes(raw)) st.skipArg = true;
        } else {
          w.type = 'command';
          st.command = w;
          if (Object.prototype.hasOwnProperty.call(PREFIXES, w.value) || LEADERS.has(w.value)) {
            st.prefix = w.value;
          } else {
            st.cmdPos = false;
            st.prefix = null;
          }
        }
      } else if (raw.startsWith('-') && raw.length > 1) {
        w.type = 'flag';
      }
      base.type = w.type === 'assign' ? 'arg' : w.type;
      words.push(w);
      last = { type: 'word' };
      return ok;
    }

    commands(null);
    if (heredocs.length) heredocOpen = true; // `cat <<EOF` with no body yet
    const quoteOpen = [...open].reverse().find((k) => k === '"' || k === "'" || k === "$'") || null;
    return { tokens, words, open, heredocOpen, last, state: endState, quote: quoteOpen };
  }

  // Would a shell wait for more input after this text? Then Enter means newline.
  function isIncomplete(text) {
    const r = lex(text);
    if (r.open.length || r.heredocOpen) return true;
    return !!(r.last && r.last.type === 'op' && ['|', '&&', '||', '|&'].includes(r.last.text));
  }

  // What's being typed at the caret: the command it belongs to, which
  // argument it is, the partial word and whether it's inside quotes.
  function contextAt(text, caret = text.length) {
    const before = text.slice(0, caret);
    const r = lex(before);
    const st = r.state;
    let cur = null;
    for (let k = r.words.length - 1; k >= 0; k--) {
      const w = r.words[k];
      if (w.end !== caret) break;
      if (w.seg === st.seg) { cur = w; break; }
    }
    // A word that ended on an unescaped space isn't under the caret any more.
    if (cur && /[ \t\n]$/.test(before) && !cur.quote && !before.endsWith('\\ ')) cur = null;
    const segWords = r.words.filter((w) => w.seg === st.seg && w !== cur);
    let cmdIdx = -1;
    for (let k = segWords.length - 1; k >= 0; k--) if (segWords[k].type === 'command') { cmdIdx = k; break; }
    const cmdWord = cmdIdx >= 0 ? segWords[cmdIdx] : null;
    const inCommand = cur ? cur.type === 'command' : st.cmdPos && !st.redirect && !st.heredoc && !st.skipArg;
    const args = cmdWord && !inCommand ? segWords.slice(cmdIdx + 1).filter((w) => w.type !== 'heredoc').map((w) => w.value) : [];
    let wordEnd = caret;
    while (wordEnd < text.length && !BREAK.has(text[wordEnd])) wordEnd++;
    const v = r.quote === "'" ? null : /\$(\{?)([A-Za-z_][A-Za-z0-9_]*)?$/.exec(before);
    return {
      command: inCommand ? null : (cmdWord ? cmdWord.value : null),
      args,
      argIndex: inCommand ? 0 : args.length + 1,
      word: cur ? cur.value : '',
      raw: cur ? cur.raw : '',
      wordStart: cur ? cur.start : caret,
      wordEnd: cur ? wordEnd : caret,
      quote: r.quote,
      inCommand,
      redirect: !!(cur ? cur.redirect : st.redirect),
      variable: v && (!cur || v.index >= cur.start) ? { start: v.index, brace: !!v[1], name: v[2] || '' } : null,
    };
  }

  return { lex, isIncomplete, contextAt, PREFIXES };
}));
