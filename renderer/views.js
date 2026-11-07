'use strict';
// Rich output views. detect-worker.js decides whether a finished command has a
// better-than-text representation; `render` builds the DOM for it.
(function (g) {
  const { escapeHtml: esc } = g.Ansi;

  // ------------------------------------------------------------ helpers
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

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

  // ------------------------------------------------------------ worker
  // Detection and parsing run in detect-worker.js, which gets output from main
  // over its own port. Parsed JSON and tables stay there; views ask for parts.
  function connect(api) {
    const w = new Worker('detect-worker.js');
    let rid = 0;
    const waiting = new Map();
    w.onmessage = (e) => {
      const { rid: id, ok, value, error } = e.data;
      const p = waiting.get(id);
      if (!p) return;
      waiting.delete(id);
      if (ok) p.resolve(value); else p.reject(new Error(error));
    };
    window.addEventListener('message', (e) => {
      if (e.data === 'loom-worker-port' && e.ports && e.ports[0]) w.postMessage({ port: e.ports[0] }, [e.ports[0]]);
    });
    api.workerPort();
    const call = (op, arg) => new Promise((resolve, reject) => {
      const id = ++rid;
      waiting.set(id, { resolve, reject });
      w.postMessage({ rid: id, op, arg });
    });
    return { call };
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

  // The parsed document stays in the worker. Each node asks for its children
  // when it's opened.
  function renderJson(data, ctx) {
    const root = el('div', 'rv-json');
    const keyHtml = (k) => (k === null ? '' : `<span class="jk">${typeof k === 'number' ? k : esc(JSON.stringify(k))}</span><span class="jp">: </span>`);
    const valHtml = (v) => {
      if (v.t === 'z') return '<span class="jnull">null</span>';
      if (v.t === 's') return `<span class="jstr">${esc(JSON.stringify(v.v))}</span>`;
      if (v.t === 'n') return `<span class="jnum">${v.v}</span>`;
      return `<span class="jbool">${v.v}</span>`;
    };
    function node(key, sum, path, depth) {
      const row = el('div', 'jn');
      if (sum.t !== 'o' && sum.t !== 'a') { row.innerHTML = keyHtml(key) + valHtml(sum); return row; }
      const arr = sum.t === 'a';
      const d = el('details');
      const s = el('summary');
      s.innerHTML = `${keyHtml(key)}<span class="jp">${arr ? '[' : '{'}</span><span class="jcount">${sum.n} ${arr ? (sum.n === 1 ? 'item' : 'items') : (sum.n === 1 ? 'key' : 'keys')}</span><span class="jp">${arr ? ']' : '}'}</span>`;
      const body = el('div', 'jchildren');
      d.append(s, body);
      let filled = false;
      const fill = async () => {
        if (filled) return;
        filled = true;
        const res = await ctx.worker.call('children', { doc: data.doc, path });
        if (!res) { body.append(el('div', 'jmore', 'Reopen the card to load this')); return; }
        const frag = document.createDocumentFragment();
        for (const c of res.entries) frag.append(node(c.k, c, [...path, c.k], depth + 1));
        if (res.more) frag.append(el('div', 'jmore', `… ${res.more.toLocaleString()} more`));
        body.append(frag);
      };
      d.addEventListener('toggle', () => d.open && fill());
      if (depth < 2 && sum.n <= 200) { d.open = true; fill(); }
      row.append(d);
      return row;
    }
    root.append(node(null, data.root, [], 0));
    if (data.more) root.append(el('div', 'rv-foot', 'Parsed from the first 4 MB of output'));
    return root;
  }

  // Rows come from the worker, sorted there, and only the visible ones are in
  // the DOM. The card body is the scroller.
  function renderTable(data, ctx) {
    const ROW = 25;
    const OVER = 20;
    const root = el('div', 'rv-table-wrap');
    const table = el('table', 'rv-table');
    const thead = el('thead');
    const tr = el('tr');
    const tbody = el('tbody');
    const top = el('tr', 'rv-spacer');
    const bottom = el('tr', 'rv-spacer');
    let sortCol = -1;
    let dir = 1;
    let shown = [-1, -1];
    let seq = 0;
    let queued = false;
    const total = data.total;
    data.headers.forEach((h, i) => {
      const th = el('th', null, h);
      th.style.width = `${data.widths[i] + 2}ch`;
      th.addEventListener('click', () => { if (sortCol === i) dir = -dir; else { sortCol = i; dir = 1; } shown = [-1, -1]; mark(); draw(); });
      tr.append(th);
    });
    const mark = () => [...tr.children].forEach((th, i) => { th.dataset.sort = i === sortCol ? (dir > 0 ? '↑' : '↓') : ''; });
    thead.append(tr);
    tbody.append(top, bottom);
    table.append(thead, tbody);
    root.append(table);
    if (data.more) root.append(el('div', 'rv-foot', `${total.toLocaleString()} rows from the first 4 MB of output`));

    async function draw() {
      queued = false;
      const sc = ctx.scroller();
      if (!sc) return;
      const offset = thead.offsetHeight; // the table starts the card body
      const first = Math.max(0, Math.floor((sc.scrollTop - offset) / ROW) - OVER);
      const count = Math.ceil(sc.clientHeight / ROW) + OVER * 2;
      const last = Math.min(total, first + count);
      if (first === shown[0] && last === shown[1]) return;
      const mine = ++seq;
      const res = await ctx.worker.call('rows', { doc: data.doc, sort: sortCol, dir, from: first, count: last - first });
      if (mine !== seq || !res) return;
      shown = [first, last];
      const frag = document.createDocumentFragment();
      for (const r of res.rows) {
        const row = el('tr');
        data.headers.forEach((_, i) => row.append(el('td', data.numeric[i] ? 'n' : null, r[i] ?? '')));
        frag.append(row);
      }
      while (top.nextSibling !== bottom) top.nextSibling.remove();
      tbody.insertBefore(frag, bottom);
      top.style.height = `${first * ROW}px`;
      bottom.style.height = `${(total - last) * ROW}px`;
    }
    root.addEventListener('loom-scroll', () => { if (!queued) { queued = true; requestAnimationFrame(draw); } });
    requestAnimationFrame(draw);
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
      case 'json': return renderJson(rich.data, ctx);
      case 'table': return renderTable(rich.data, ctx);
      case 'gitlog': return renderGitLog(rich.data, ctx);
      case 'gitstatus': return renderGitStatus(rich.data, ctx);
      default: return el('div', null, '');
    }
  }

  const LABELS = { files: 'Files', json: 'JSON', table: 'Table', gitlog: 'Graph', gitstatus: 'Status' };

  g.Views = { connect, render, shq, LABELS, fmtSize };
})(window);
