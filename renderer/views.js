'use strict';
// Rich output views. `detect` decides whether a finished command has a
// better-than-text representation; `render` builds the DOM for it.
(function (g) {
  const { strip, escapeHtml: esc } = g.Ansi;

  // ------------------------------------------------------------ helpers
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

  // Splits a command into words. `simple` is false when it contains shell
  // control characters outside quotes (pipes, redirects, substitutions…).
  function tokenize(cmd) {
    const tokens = [];
    let cur = '';
    let has = false;
    let q = null;
    let simple = true;
    for (let i = 0; i < cmd.length; i++) {
      const c = cmd[i];
      if (q) {
        if (c === q) q = null;
        else if (c === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
        else cur += c;
        continue;
      }
      if (c === '"' || c === "'") { q = c; has = true; continue; }
      if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; has = true; continue; }
      if (/\s/.test(c)) { if (has) { tokens.push(cur); cur = ''; has = false; } continue; }
      if ('|;&<>`$(){}*?'.includes(c)) simple = false;
      cur += c; has = true;
    }
    if (has) tokens.push(cur);
    return { tokens, simple: simple && !q };
  }

  function fmtSize(n) {
    if (n < 1024) return `${n} B`;
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
  }

  function fmtAgo(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return new Date(ms).toLocaleDateString();
  }

  // ------------------------------------------------------------ file kinds
  const KINDS = {
    code: 'js mjs cjs ts tsx jsx py go rs rb java kt swift c h cc cpp hpp cs php lua sh bash zsh fish pl r scala dart vue svelte ex exs erl hs ml clj sql',
    doc: 'md mdx txt rst pdf doc docx rtf odt pages tex log',
    data: 'json jsonl ndjson csv tsv yaml yml toml xml ini env plist parquet db sqlite',
    media: 'png jpg jpeg gif svg webp ico bmp tiff heic mp4 mov webm mkv avi mp3 wav flac ogg m4a',
    archive: 'zip tar gz tgz bz2 xz 7z rar dmg iso pkg deb rpm',
    style: 'css scss sass less html htm',
  };
  const EXT_KIND = {};
  for (const [k, list] of Object.entries(KINDS)) list.split(' ').forEach((e) => { EXT_KIND[e] = k; });
  const BINARY = new Set([...KINDS.media.split(' '), ...KINDS.archive.split(' '), 'pdf', 'doc', 'docx', 'pages', 'odt', 'parquet', 'db', 'sqlite', 'woff', 'woff2', 'ttf', 'otf', 'exe', 'dll', 'so', 'dylib', 'o', 'a', 'class', 'jar', 'pyc', 'wasm', 'bin', 'app', 'xlsx', 'xls', 'pptx', 'key', 'numbers']);
  BINARY.delete('svg');

  function fileInfo(e) {
    if (e.dir) return { kind: 'dir', badge: '' };
    const dot = e.name.lastIndexOf('.');
    const ext = dot > 0 ? e.name.slice(dot + 1).toLowerCase() : '';
    if (!ext && e.name.startsWith('.')) return { kind: 'config', badge: '•' };
    if (/^(dockerfile|makefile|license|readme)/i.test(e.name) && !ext) return { kind: 'doc', badge: e.name.slice(0, 3).toUpperCase() };
    if (e.exec && !ext) return { kind: 'exec', badge: '>_' };
    return { kind: EXT_KIND[ext] || (/(lock|rc|config)$/.test(e.name) ? 'config' : 'other'), badge: ext.slice(0, 4).toUpperCase() || '—', ext };
  }

  // ------------------------------------------------------------ parsers
  function parseDelimited(text, d) {
    const rows = [];
    let row = [];
    let cell = '';
    let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"' && cell === '') q = true;
      else if (c === d) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
        if (rows.length > 5000) break;
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => !(r.length === 1 && r[0] === ''));
  }

  function detectDelimited(text, cmd) {
    const hint = /\.(csv|tsv)\b/i.test(cmd);
    for (const d of ['\t', ',']) {
      if (!text.includes(d)) continue;
      const rows = parseDelimited(text, d);
      if (rows.length < 2) continue;
      const w = rows[0].length;
      const sample = rows.slice(0, 60);
      const consistent = sample.every((r) => r.length === w);
      if (!consistent || w < 2) continue;
      if (d === ',' && !hint && (w < 3 || rows.length < 3)) continue;
      return { headers: rows[0], rows: rows.slice(1) };
    }
    return null;
  }

  // Whitespace-aligned tables (ps, df, docker ps, kubectl get…): find
  // character columns that are blank on every line and split there.
  const COLUMN_CMDS = new Set(['ps', 'df', 'docker', 'podman', 'kubectl', 'lsof', 'netstat', 'free', 'launchctl', 'who', 'w', 'jobs', 'ss', 'brew', 'pip', 'pip3', 'helm', 'gcloud', 'aws']);
  function detectColumns(text, cmd) {
    const lines = text.split('\n').filter((l) => l.trim());
    if (lines.length < 2 || lines.length > 5000) return null;
    const head = lines[0];
    const first = cmd.trim().split(/\s+/)[0];
    const letters = head.replace(/[^A-Za-z]/g, '');
    const caps = letters && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7;
    if (!COLUMN_CMDS.has(first) && !caps) return null;
    if (!/^[\sA-Z%#]/.test(head) || /[.!?]$/.test(head.trim())) return null;
    const sample = lines.slice(0, 200);
    const gap = [];
    for (let i = 0; i < head.length; i++) gap[i] = sample.every((l) => i >= l.length || l[i] === ' ');
    // column starts = header positions where a non-gap run begins after a gap run
    const starts = [];
    for (let i = 0; i < head.length; i++) if (!gap[i] && (i === 0 || gap[i - 1])) starts.push(i);
    if (starts.length < 3) return null;
    const cut = (l) => starts.map((s, j) => l.slice(s, j + 1 < starts.length ? starts[j + 1] : undefined).trim());
    const headers = cut(head);
    if (headers.some((h) => !h)) return null;
    return { headers, rows: lines.slice(1).map(cut) };
  }

  // ------------------------------------------------------------ detection
  const NO_RICH_LOG = /^(-p|--patch|--stat|--shortstat|--numstat|--name-only|--name-status|-L.*|--follow|--graph)$/;
  const DROP_LOG = /^(--oneline|--decorate.*|--color.*|--no-color|--pretty=.*|--format=.*|--abbrev-commit|--no-decorate|--date=.*)$/;

  async function detect(node, api, stdout) {
    if (node.status !== 'ok') return null;
    const cmd = node.cmd.trim();

    // `ls`, optionally after `cd somewhere &&`
    let lsCmd = cmd;
    let base = node.cwd;
    const cd = cmd.match(/^cd\s+(.+?)\s*&&\s*(ls(?:\s.*)?)$/);
    if (cd) { lsCmd = cd[2]; base = node.cwdAfter || node.cwd; }
    const lt = tokenize(lsCmd);
    if (lt.simple && lt.tokens[0] === 'ls') {
      const args = lt.tokens.slice(1);
      const flags = args.filter((a) => a.startsWith('-')).join('');
      const targets = args.filter((a) => !a.startsWith('-'));
      if (targets.length <= 1 && !/R|d/.test(flags)) {
        const res = await api.listDir({ cwd: base, target: targets[0] || '.', hidden: /a|A/.test(flags) });
        if (res) return { kind: 'files', data: res };
      }
    }

    const t = tokenize(cmd);
    if (t.simple && t.tokens[0] === 'git') {
      const sub = t.tokens[1];
      const rest = t.tokens.slice(2);
      if (sub === 'log' && !rest.some((a) => NO_RICH_LOG.test(a)) && !rest.includes('--')) {
        const res = await api.gitLog({ cwd: node.cwd, args: rest.filter((a) => !DROP_LOG.test(a)) });
        if (res && res.commits.length) {
          res.commits = res.commits.slice(0, 400);
          return { kind: 'gitlog', data: res };
        }
      }
      if (sub === 'status' && rest.every((a) => /^-(s|b|sb|-short|-branch)$/.test(a))) {
        const res = await api.gitStatus({ cwd: node.cwd });
        if (res) return { kind: 'gitstatus', data: res };
      }
    }

    const text = strip(stdout).trim();
    if (!text || text.length > 4 * 1024 * 1024) return null;

    if (/^[[{]/.test(text)) {
      try { return { kind: 'json', data: JSON.parse(text) }; } catch { /* maybe NDJSON */ }
      const lines = text.split('\n').filter((l) => l.trim());
      if (lines.length >= 2 && lines.length <= 20000) {
        try { return { kind: 'json', data: lines.map((l) => JSON.parse(l)) }; } catch { /* not JSON */ }
      }
    }
    const delim = detectDelimited(text, cmd);
    if (delim) return { kind: 'table', data: delim };
    const cols = detectColumns(text, cmd);
    if (cols) return { kind: 'table', data: cols };
    return null;
  }

  // ------------------------------------------------------------ renderers
  function renderFiles(data, ctx) {
    const root = el('div', 'rv-files');
    const top = el('div', 'rv-toolbar');
    const dirs = data.entries.filter((e) => e.dir).length;
    top.append(el('span', 'rv-path', ctx.tilde(data.path)));
    top.append(el('span', 'rv-count', `${dirs} folders · ${data.entries.length - dirs} files${data.total > data.entries.length ? ` · ${data.total - data.entries.length} hidden` : ''}`));
    const filter = el('input', 'rv-filter');
    filter.placeholder = 'Filter';
    filter.spellcheck = false;
    top.append(filter);
    root.append(top);

    const grid = el('div', 'rv-grid');
    const sorted = [...data.entries].sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const join = (n) => (data.path.endsWith('/') ? data.path + n : `${data.path}/${n}`);
    const rel = (n) => (data.path === ctx.cwd ? shq(n) : shq(join(n)));

    for (const e of sorted) {
      const info = fileInfo(e);
      const tile = el('button', `rv-tile k-${info.kind}`);
      tile.title = `${e.name}${e.dir ? '/' : ''}\n${e.dir ? 'Folder' : fmtSize(e.size)} · modified ${fmtAgo(e.mtime)}\nDouble-click to ${e.dir ? 'open' : (BINARY.has(info.ext) ? 'open with default app' : 'view')}`;
      const icon = el('span', 'rv-icon');
      if (e.dir) icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.3l2 2.2h8.7A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/></svg>';
      else icon.textContent = info.badge;
      tile.append(icon);
      const meta = el('span', 'rv-meta');
      meta.append(el('span', 'rv-name', e.name + (e.link ? ' ↗' : '')));
      meta.append(el('span', 'rv-sub', e.dir ? fmtAgo(e.mtime) : fmtSize(e.size)));
      tile.append(meta);
      tile.dataset.name = e.name.toLowerCase();
      tile.addEventListener('dblclick', () => {
        if (e.dir) ctx.runChild(`cd ${rel(e.name)} && ls`);
        else if (BINARY.has(info.ext)) ctx.openPath(join(e.name));
        else ctx.runChild(e.size > 512 * 1024 ? `head -n 200 ${rel(e.name)}` : `cat ${rel(e.name)}`);
      });
      grid.append(tile);
    }
    if (!sorted.length) grid.append(el('div', 'rv-emptydir', 'Empty folder'));
    filter.addEventListener('input', () => {
      const q = filter.value.toLowerCase();
      for (const t of grid.children) if (t.dataset.name != null) t.hidden = q && !t.dataset.name.includes(q);
    });
    root.append(grid);
    return root;
  }

  function renderJson(value) {
    const root = el('div', 'rv-json');
    const keyHtml = (k) => (k === null ? '' : `<span class="jk">${typeof k === 'number' ? k : esc(JSON.stringify(k))}</span><span class="jp">: </span>`);
    const valHtml = (v) => {
      if (v === null) return '<span class="jnull">null</span>';
      if (typeof v === 'string') {
        const s = v.length > 2000 ? `${v.slice(0, 2000)}…` : v;
        return `<span class="jstr">${esc(JSON.stringify(s))}</span>`;
      }
      if (typeof v === 'number') return `<span class="jnum">${v}</span>`;
      return `<span class="jbool">${v}</span>`;
    };
    function node(key, val, depth) {
      const row = el('div', 'jn');
      if (val && typeof val === 'object') {
        const arr = Array.isArray(val);
        const keys = arr ? val.map((_, i) => i) : Object.keys(val);
        const d = el('details');
        const s = el('summary');
        s.innerHTML = `${keyHtml(key)}<span class="jp">${arr ? '[' : '{'}</span><span class="jcount">${keys.length} ${arr ? (keys.length === 1 ? 'item' : 'items') : (keys.length === 1 ? 'key' : 'keys')}</span><span class="jp">${arr ? ']' : '}'}</span>`;
        const body = el('div', 'jchildren');
        d.append(s, body);
        const fill = () => {
          if (body.dataset.filled) return;
          body.dataset.filled = '1';
          keys.slice(0, 500).forEach((k) => body.append(node(k, val[k], depth + 1)));
          if (keys.length > 500) body.append(el('div', 'jmore', `… ${keys.length - 500} more`));
        };
        d.addEventListener('toggle', () => d.open && fill());
        if (depth < 2 && keys.length <= 200) { d.open = true; fill(); }
        row.append(d);
      } else {
        row.innerHTML = keyHtml(key) + valHtml(val);
      }
      return row;
    }
    root.append(node(null, value, 0));
    return root;
  }

  function renderTable(data) {
    const root = el('div', 'rv-table-wrap');
    const table = el('table', 'rv-table');
    const thead = el('thead');
    const tr = el('tr');
    const tbody = el('tbody');
    let sortCol = -1;
    let dir = 1;
    const num = (s) => {
      const m = String(s).trim().match(/^-?[\d,.]+(?:\s*([KMGTP])i?B?)?%?$/i);
      if (!m) return null;
      const n = parseFloat(String(s).replace(/,/g, ''));
      const mult = { K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 }[(m[1] || '').toUpperCase()] || 1;
      return Number.isFinite(n) ? n * mult : null;
    };
    const draw = () => {
      let rows = data.rows;
      if (sortCol >= 0) {
        rows = [...rows].sort((a, b) => {
          const x = a[sortCol] ?? ''; const y = b[sortCol] ?? '';
          const nx = num(x); const ny = num(y);
          if (nx != null && ny != null) return (nx - ny) * dir;
          return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
        });
      }
      tbody.textContent = '';
      for (const r of rows.slice(0, 1500)) {
        const row = el('tr');
        data.headers.forEach((_, i) => {
          const td = el('td', null, r[i] ?? '');
          if (num(r[i] ?? '') != null) td.className = 'n';
          row.append(td);
        });
        tbody.append(row);
      }
      [...tr.children].forEach((th, i) => { th.dataset.sort = i === sortCol ? (dir > 0 ? '↑' : '↓') : ''; });
    };
    data.headers.forEach((h, i) => {
      const th = el('th', null, h);
      th.addEventListener('click', () => { if (sortCol === i) dir = -dir; else { sortCol = i; dir = 1; } draw(); });
      tr.append(th);
    });
    thead.append(tr);
    table.append(thead, tbody);
    root.append(table);
    if (data.rows.length > 1500) root.append(el('div', 'rv-foot', `Showing 1,500 of ${data.rows.length.toLocaleString()} rows`));
    draw();
    return root;
  }

  const LANE_COLORS = ['#7aa8f5', '#a3d983', '#e8c278', '#c792ea', '#6cd0d0', '#f07178', '#f5a97f', '#9cc0ff'];

  function renderGitLog(data, ctx) {
    const ROW = 30;
    const LANE = 14;
    const commits = data.commits;
    const rows = [];
    let lanes = [];
    let maxLanes = 1;
    for (const c of commits) {
      let col = lanes.indexOf(c.hash);
      if (col === -1) { col = lanes.indexOf(null); if (col === -1) col = lanes.length; lanes[col] = c.hash; }
      const before = lanes.slice();
      lanes = lanes.map((h, i) => (h === c.hash && i !== col ? null : h));
      lanes[col] = c.parents[0] || null;
      for (const p of c.parents.slice(1)) {
        if (!lanes.includes(p)) { let j = lanes.indexOf(null); if (j === -1) j = lanes.length; lanes[j] = p; }
      }
      const after = lanes.slice();
      while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();
      maxLanes = Math.max(maxLanes, before.length, after.length);
      rows.push({ c, col, before, after });
    }
    const W = maxLanes * LANE + 12;
    const lx = (i) => 10 + i * LANE;
    let paths = '';
    let dots = '';
    rows.forEach(({ c, col, before, after }, r) => {
      const top = r * ROW; const mid = top + ROW / 2; const bot = top + ROW;
      before.forEach((h, i) => {
        if (h == null) return;
        const color = LANE_COLORS[i % LANE_COLORS.length];
        if (h === c.hash) paths += `<path d="M${lx(i)} ${top} C${lx(i)} ${mid - 6} ${lx(col)} ${mid - 6} ${lx(col)} ${mid}" stroke="${color}"/>`;
        else paths += `<path d="M${lx(i)} ${top} L${lx(i)} ${bot}" stroke="${color}"/>`;
      });
      c.parents.forEach((p) => {
        const j = after.indexOf(p);
        if (j === -1) return;
        const color = LANE_COLORS[j % LANE_COLORS.length];
        paths += `<path d="M${lx(col)} ${mid} C${lx(col)} ${mid + 8} ${lx(j)} ${bot - 8} ${lx(j)} ${bot}" stroke="${color}"/>`;
      });
      const color = LANE_COLORS[col % LANE_COLORS.length];
      dots += c.parents.length > 1
        ? `<circle cx="${lx(col)}" cy="${mid}" r="4" fill="var(--card)" stroke="${color}" stroke-width="2"/>`
        : `<circle cx="${lx(col)}" cy="${mid}" r="4" fill="${color}"/>`;
    });

    const root = el('div', 'rv-gitlog');
    const svg = `<svg class="gl-svg" width="${W}" height="${rows.length * ROW}" fill="none" stroke-width="2" stroke-linecap="round">${paths}${dots}</svg>`;
    root.innerHTML = svg;
    root.style.setProperty('--graph-w', `${W}px`);
    const list = el('div', 'gl-rows');
    for (const { c } of rows) {
      const row = el('div', 'gl-row');
      row.title = `${c.hash}\n${c.author} · ${c.date}\nDouble-click to show this commit`;
      row.append(el('span', 'gl-hash', c.hash.slice(0, 7)));
      const subj = el('span', 'gl-subj');
      for (const ref of c.refs) {
        const isHead = ref.startsWith('HEAD');
        const isTag = ref.startsWith('tag: ');
        const isRemote = /^[\w.-]+\//.test(ref) && !isTag;
        const label = ref.replace(/^HEAD -> /, '').replace(/^tag: /, '');
        subj.append(el('span', `gl-ref ${isHead ? 'head' : isTag ? 'tag' : isRemote ? 'remote' : 'branch'}`, isHead && ref === 'HEAD' ? 'HEAD' : label));
      }
      subj.append(document.createTextNode(c.subject));
      row.append(subj);
      row.append(el('span', 'gl-author', c.author));
      row.append(el('span', 'gl-date', c.date));
      row.addEventListener('dblclick', () => ctx.runChild(`git show --stat ${c.hash.slice(0, 10)}`));
      list.append(row);
    }
    root.append(list);
    return root;
  }

  function renderGitStatus(data, ctx) {
    const root = el('div', 'rv-gitstatus');
    const m = data.branch.match(/^(?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?:\s+\[(.+)\])?/);
    const head = el('div', 'gs-branch');
    head.append(el('span', 'gl-ref branch', m ? m[1] : data.branch));
    if (m && m[2]) head.append(el('span', 'gs-up', `tracking ${m[2]}`));
    if (m && m[3]) head.append(el('span', 'gs-ahead', m[3]));
    root.append(head);

    const groups = [
      ['Conflicts', data.files.filter((f) => f.x === 'U' || f.y === 'U' || (f.x === 'A' && f.y === 'A') || (f.x === 'D' && f.y === 'D')), 'x', 'conflict'],
      ['Staged', data.files.filter((f) => !'?! U'.includes(f.x) && f.y !== 'U'), 'x', 'staged'],
      ['Changes', data.files.filter((f) => !'?! U'.includes(f.y) && f.x !== 'U'), 'y', 'changed'],
      ['Untracked', data.files.filter((f) => f.x === '?'), 'x', 'untracked'],
    ];
    const LABEL = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', U: 'conflict', '?': 'new' };
    let any = false;
    for (const [title, files, col, cls] of groups) {
      if (!files.length) continue;
      any = true;
      const sec = el('div', `gs-group ${cls}`);
      sec.append(el('div', 'gs-title', `${title} · ${files.length}`));
      for (const f of files) {
        const row = el('div', 'gs-file');
        const code = f[col] === '?' ? '?' : f[col];
        row.append(el('span', `gs-code c-${code === '?' ? 'N' : code}`, code === '?' ? 'N' : code));
        row.append(el('span', 'gs-path', f.path));
        row.append(el('span', 'gs-kind', LABEL[code] || ''));
        row.title = 'Double-click to see the diff';
        row.addEventListener('dblclick', () => {
          if (cls === 'untracked') ctx.runChild(`cat ${shq(f.path)}`);
          else ctx.runChild(`git diff${cls === 'staged' ? ' --cached' : ''} -- ${shq(f.path)}`);
        });
        sec.append(row);
      }
      root.append(sec);
    }
    if (!any) root.append(el('div', 'gs-clean', 'Working tree clean'));
    return root;
  }

  function render(rich, ctx) {
    switch (rich.kind) {
      case 'files': return renderFiles(rich.data, ctx);
      case 'json': return renderJson(rich.data);
      case 'table': return renderTable(rich.data);
      case 'gitlog': return renderGitLog(rich.data, ctx);
      case 'gitstatus': return renderGitStatus(rich.data, ctx);
      default: return el('div', null, '');
    }
  }

  const LABELS = { files: 'Files', json: 'JSON', table: 'Table', gitlog: 'Graph', gitstatus: 'Status' };

  g.Views = { detect, render, tokenize, shq, LABELS, fmtSize };
})(window);
