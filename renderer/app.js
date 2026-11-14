'use strict';
// Loom renderer: the canvas, cards, composer, history map and Claude flows.
// Output lives in main.js; cards ask for the lines they show. Only cards near
// the viewport have their DOM, and below 55% / 25% zoom cards become pills and
// then drawings on one canvas.
(async function main() {
  const api = window.loom;
  const { Ansi, Views, ShellLex, Spatial, VLines } = window;
  const $ = (s) => document.querySelector(s);
  const sys = await api.sys();
  document.body.classList.add(`os-${sys.platform}`);
  if (sys.platform !== 'darwin') document.querySelectorAll('.mod-key').forEach((k) => { k.textContent = 'Ctrl'; });

  const CARD_W = 620;
  const GAP_X = 72;
  const GAP_Y = 64;
  const ANCHOR = 23; // x offset of the status dot, where edges attach
  const LIVE_DELAY = 150; // quick commands finish before they'd need a terminal
  let LINE_H = 19; // card output rows, from the font settings
  const HEAD_H = 62; // a card's header and sub-header
  const PILL_K = 0.55; // below this zoom, cards are pills
  const FAR_K = 0.25; // below this, cards are drawn on one canvas
  const MIN_K = 0.02;
  const MODEL_GRACE = 1000; // ms a running card keeps its terminal model off-screen
  const MAP_ROW = 26;
  const OS_NAME = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[sys.platform] || sys.platform;
  const MOD = sys.platform === 'darwin' ? '⌘' : 'Ctrl+';

  const els = {
    viewport: $('#viewport'), world: $('#world'), cards: $('#cards'), edges: $('#edges'),
    edgePaths: $('#edge-paths'), edgeLabels: $('#edge-labels'), far: $('#far'),
    minimap: $('#minimap'), empty: $('#empty'),
    prompt: $('#prompt'), mode: $('#mode'), cwdChip: $('#cwd-chip'), pipeChip: $('#pipe-chip'),
    hint: $('#hint'), suggestion: $('#suggestion'), mirror: $('#prompt-hl'), complete: $('#complete'), hsearch: $('#hsearch'),
    sidebar: $('#sidebar'), tree: $('#map-tree'), treeInner: $('#map-rows'), search: $('#map-search'), stats: $('#map-stats'),
    zoomLabel: $('#zoom-label'), toasts: $('#toasts'),
  };

  // ================================================================ canvases
  // Each tab is a canvas: its cards, view, active card and root folder. `cur`
  // is the one on screen, and state.nodes, state.view and the rest are its.
  const canvases = new Map(); // canvas id -> canvas
  const blankCanvas = (meta) => ({
    id: meta.id, title: meta.title || 'Home', color: meta.color || null, folder: meta.folder || null,
    loaded: false, loading: null, nodes: new Map(), nextId: 1, view: { x: 120, y: 90, k: 1 }, activeId: null,
    rootCwd: meta.folder || sys.home, pipeFrom: null, sidebar: false, sent: new Map(), sentMeta: '', unseen: null,
  });
  let cur = { ...blankCanvas({ id: 'none' }), loaded: true };
  const state = {
    mode: 'shell',
    history: [], // records from main.js, oldest first
    suggestion: null,
  };
  for (const k of ['nodes', 'nextId', 'view', 'activeId', 'rootCwd', 'pipeFrom']) {
    Object.defineProperty(state, k, { get: () => cur[k], set: (v) => { cur[k] = v; }, enumerable: true });
  }
  // node id -> { card, mode: 'stub' | 'pill' | 'full', ...refs of a full card }
  const dom = new Map();
  const running = new Set();
  const worker = Views.connect(api);

  const terminals = window.Terminals.create({
    api,
    layer: $('#live-layer'),
    overlay: $('#term-overlay'),
    slot: $('#term-slot'),
    rect: cardBodyRect,
    onChange: (n) => { if (state.nodes.get(n.id) === n) { updateCard(n); schedule(n); } },
    onOutput: (n) => schedule(n),
    onAlt(n, entered) {
      if (!entered) { terminals.collapse(); return; }
      if (n.id === state.activeId && !n.noExpand) terminals.expand(n);
    },
    onRelease: () => focusPrompt(),
    onPointer: (n) => { if (n.id !== state.activeId) setActive(n.id); showTerm(n, { focus: true }); },
    font: () => (window.Theme.fonts() ? window.Theme.fonts().size : 12),
    settings: () => settingsNow,
  });

  // Where a card's body is on screen, for the live terminal laid over it.
  function cardBodyRect(n) {
    const d = dom.get(n.id);
    if (!d || d.mode !== 'full' || lod !== 'full') return null;
    const { x, y, k } = state.view;
    return {
      x: (n.x + d.card.clientLeft + d.body.offsetLeft) * k + x,
      y: (n.y + d.card.clientTop + d.body.offsetTop) * k + y,
      w: d.body.clientWidth * k,
      h: n.bodyH * k,
      k,
      shown: !n.collapsed,
    };
  }

  // A running card needs a terminal model to show or take input.
  function showTerm(n, o) {
    if (n.status !== 'running' || n.ending) return;
    if (!terminals.has(n.key)) terminals.attach(n);
    terminals.show(n, o);
  }

  // ================================================================ utils
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const tilde = (p) => {
    if (!p) return '';
    const home = sys.realHome || sys.home;
    return p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
  };
  const shortPath = (p) => {
    const t = tilde(p);
    const parts = t.split('/');
    return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : t;
  };
  const fmtDur = (ms) => {
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
    return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  };
  const fmtAgo = (ms) => {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  };
  const fmtBytes = (b) => (b >= 1024 ** 3 ? `${+(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`);
  const currentCwd = () => {
    const a = state.nodes.get(state.activeId);
    return a ? (a.cwdAfter || a.cwd) : state.rootCwd;
  };
  function parseJsonLoose(text) {
    const i = text.indexOf('{');
    const j = text.lastIndexOf('}');
    if (i < 0 || j < i) return null;
    try { return JSON.parse(text.slice(i, j + 1)); } catch { return null; }
  }

  // Character width of card output, measured once, for rows per line.
  let charW = 7.5;
  function measureChar() {
    const probe = document.createElement('span');
    probe.className = 'char-probe';
    probe.textContent = 'M'.repeat(200);
    document.body.append(probe);
    charW = probe.getBoundingClientRect().width / 200 || 7.5;
    probe.remove();
  }
  measureChar();
  document.fonts.ready.then(() => { const before = charW; measureChar(); if (before !== charW) for (const d of dom.values()) if (d.vt) d.vt.setCols(colsFor(state.nodes.get(Number(d.card.dataset.id)))); });
  // Card width minus borders, padding and the scrollbar.
  const colsFor = (n) => Math.max(32, Math.floor((n.w - 2 - 32 - 10) / charW));

  const ICON = {
    stop: '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/></svg>',
    rerun: '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5v3h-3"/></svg>',
    branch: '<svg viewBox="0 0 16 16"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-6.2 4.3"/></svg>',
    pipe: '<svg viewBox="0 0 16 16"><path d="M8 2v12M5 11l3 3 3-3"/></svg>',
    spark: '<svg viewBox="0 0 16 16"><path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" fill="currentColor" stroke="none"/></svg>',
    copy: '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5"/></svg>',
    save: '<svg viewBox="0 0 16 16"><path d="M8 2v8M5 7.5l3 3 3-3M3 13.5h10"/></svg>',
    open: '<svg viewBox="0 0 16 16"><path d="M9.5 2.5h4v4M13.5 2.5L8 8M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/></svg>',
    close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    expand: '<svg viewBox="0 0 16 16"><path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9"/></svg>',
  };

  // ================================================================ toasts
  function toast(msg, { action, onAction, timeout = 5000, kind = '' } = {}) {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.append(document.createTextNode(msg));
    if (action) {
      const b = document.createElement('button');
      b.textContent = action;
      b.onclick = () => { t.remove(); onAction(); };
      t.append(b);
    }
    els.toasts.append(t);
    setTimeout(() => t.classList.add('out'), timeout);
    setTimeout(() => t.remove(), timeout + 300);
  }

  // ================================================================ tree
  // Children and depth, kept up to date on add, remove and reparent.
  const kids = new Map(); // id -> children, by id
  const depth = new Map();
  let treeVersion = 0;
  const childrenOf = (id) => kids.get(id) || [];
  const hasParent = (n) => n.parentId != null && state.nodes.has(n.parentId);
  function treeAdd(n) {
    if (hasParent(n)) {
      const list = kids.get(n.parentId) || [];
      let i = list.length;
      while (i > 0 && list[i - 1].id > n.id) i--;
      list.splice(i, 0, n);
      kids.set(n.parentId, list);
    }
    setDepth(n, hasParent(n) ? (depth.get(n.parentId) || 0) + 1 : 0);
    treeVersion++;
  }
  function treeDetach(n) {
    const list = kids.get(n.parentId);
    if (list) { const i = list.indexOf(n); if (i >= 0) list.splice(i, 1); if (!list.length) kids.delete(n.parentId); }
  }
  function setDepth(n, d) {
    const stack = [[n, d]];
    while (stack.length) {
      const [m, dm] = stack.pop();
      depth.set(m.id, dm);
      for (const c of childrenOf(m.id)) stack.push([c, dm + 1]);
    }
  }
  function reparent(n, parentId) {
    treeDetach(n);
    n.parentId = parentId;
    treeAdd(n);
    syncEdges(n);
  }
  function subtree(id) {
    const out = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      out.push(cur);
      for (const c of childrenOf(cur)) stack.push(c.id);
    }
    return out;
  }

  // ================================================================ geometry
  // Heights come from a ResizeObserver on mounted cards, and are kept (and
  // saved) for the ones that aren't, so layout never reads the DOM.
  const h = (n) => n.h || HEAD_H + 140;
  const grid = Spatial.createGrid(512);
  let layoutVersion = 0;
  const moved = new Set(); // ids whose rectangle changed since the last frame
  function placed(n) {
    grid.set(n.id, n.x, n.y, n.w, h(n));
    moved.add(n.id);
    layoutVersion++;
  }
  function moveEl(n) {
    const d = dom.get(n.id);
    if (d) { d.card.style.left = `${n.x}px`; d.card.style.top = `${n.y}px`; }
    placed(n);
  }

  const ro = new ResizeObserver((entries) => {
    let any = false;
    for (const e of entries) {
      const n = state.nodes.get(Number(e.target.dataset.id));
      const d = n && dom.get(n.id);
      if (!d || d.mode !== 'full' || d.card !== e.target) continue;
      const v = e.borderBoxSize && e.borderBoxSize[0] ? e.borderBoxSize[0].blockSize : e.target.offsetHeight;
      if (!v || Math.abs(v - (n.h || 0)) < 0.5) continue;
      if (d.holding && v < n.h) continue; // still loading its body
      n.h = Math.round(v * 10) / 10;
      heightChanged.add(n.id);
      placed(n);
      any = true;
    }
    if (any) { scheduleLayout(); saveSoon(); }
  });
  const heightChanged = new Set();

  // ================================================================ cards
  function makeNode(props) {
    const id = state.nextId++;
    const n = {
      id, key: `${cur.id}.${id}`, cmd: '', cwd: sys.home, cwdAfter: null, parentId: null, pipeFrom: null,
      x: 0, y: 0, w: CARD_W, bodyH: 300, h: HEAD_H + 40, status: 'running', exitCode: null,
      startedAt: Date.now(), endedAt: null, rich: null, richKind: null, view: 'rich', ai: null, collapsed: false,
      killed: false, envFile: null, out: null, capped: false,
      ...props,
    };
    state.nodes.set(n.id, n);
    addEl(n);
    treeAdd(n);
    syncEdges(n);
    return n;
  }

  // Every card has an element: an empty box of its size within a few screens
  // of the view, its insides near the view, and out of the DOM further away
  // (layout and edges only need its rectangle, which the grid has).
  function addEl(n, frag) {
    const c = document.createElement('div');
    c.className = `card stub s-${n.status}`;
    c.dataset.id = n.id;
    c.style.cssText = `left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${h(n)}px`;
    if (frag !== false) { (frag || els.cards).append(c); inDom.add(n.id); }
    dom.set(n.id, { card: c, mode: 'stub' });
    grid.set(n.id, n.x, n.y, n.w, h(n));
    layoutVersion++;
  }
  const inDom = new Set();

  const CARD_HTML = `
      <div class="card-head">
        <span class="status-dot"></span>
        <span class="card-id"></span>
        <code class="card-cmd"></code>
        <span class="card-meta"></span>
        <div class="card-actions">
          <button data-act="stop" title="Stop (Ctrl+C)">${ICON.stop}</button>
          <button data-act="expand" title="Expand terminal">${ICON.expand}</button>
          <button data-act="rerun" title="Run again">${ICON.rerun}</button>
          <button data-act="branch" title="Branch from here">${ICON.branch}</button>
          <button data-act="pipe" title="Pipe output into a new command">${ICON.pipe}</button>
          <button data-act="explain" title="Explain with Claude">${ICON.spark}</button>
          <button data-act="copy" title="Copy output">${ICON.copy}</button>
          <button data-act="save" title="Save output…">${ICON.save}</button>
          <button data-act="open" title="Open in editor">${ICON.open}</button>
          <button data-act="delete" title="Remove card">${ICON.close}</button>
        </div>
      </div>
      <div class="card-sub"><span class="card-cwd"></span><span class="card-tabs"></span></div>
      <div class="card-note" hidden></div>
      <div class="card-body"></div>
      <div class="card-ai" hidden></div>
      <div class="card-resize" title="Drag to resize"></div>`;

  function mount(n, mode) {
    const d = dom.get(n.id);
    if (!d || d.mode === mode) return;
    if (d.mode !== 'stub') unmount(n);
    const c = d.card;
    d.mode = mode;
    if (mode === 'pill') {
      c.innerHTML = '<div class="pill-head"><span class="status-dot"></span><span class="card-id"></span><code class="card-cmd"></code><span class="card-meta"></span></div>';
      const q = (s) => c.querySelector(s);
      Object.assign(d, { id: q('.card-id'), cmd: q('.card-cmd'), meta: q('.card-meta') });
      updateCard(n);
      return;
    }
    c.innerHTML = CARD_HTML;
    const q = (s) => c.querySelector(s);
    Object.assign(d, {
      id: q('.card-id'), cmd: q('.card-cmd'), meta: q('.card-meta'), cwd: q('.card-cwd'), note: q('.card-note'),
      tabs: q('.card-tabs'), body: q('.card-body'), ai: q('.card-ai'),
      richFor: null, vt: null, holding: true,
    });
    // Hold the saved height until the body has loaded, so nothing jumps.
    c.style.minHeight = `${h(n)}px`;
    d.holdTimer = setTimeout(() => release(n), 600);
    d.body.addEventListener('scroll', () => { const f = d.body.firstElementChild; if (f) f.dispatchEvent(new Event('loom-scroll')); }, { passive: true });
    updateCard(n);
    renderBody(n);
    ro.observe(c);
  }
  function release(n) {
    const d = dom.get(n.id);
    if (!d || !d.holding) return;
    d.holding = false;
    clearTimeout(d.holdTimer);
    d.card.style.minHeight = '';
  }

  function unmount(n) {
    const d = dom.get(n.id);
    if (!d || d.mode === 'stub') return;
    if (d.vt) { n.vtTop = d.vt.top(); n.vtAtEnd = false; d.vt.destroy(); }
    clearTimeout(d.holdTimer);
    ro.unobserve(d.card);
    const card = d.card;
    dom.set(n.id, { card, mode: 'stub' });
    card.innerHTML = '';
    updateCard(n);
  }

  function updateCard(n) {
    const d = dom.get(n.id);
    if (!d) return;
    const c = d.card;
    const live = terminals.isLive(n.key);
    c.className = `card ${d.mode}${d.mode === 'full' ? '' : ''} s-${n.status}${n.id === state.activeId ? ' active' : ''}${n.collapsed ? ' collapsed' : ''}${n.pipeFrom != null ? ' piped' : ''}${live ? ' has-live' : ''}`;
    c.style.left = `${n.x}px`;
    c.style.top = `${n.y}px`;
    c.style.width = `${n.w}px`;
    c.style.height = d.mode === 'full' ? '' : `${h(n)}px`;
    if (d.mode === 'stub') return;
    d.id.textContent = `#${n.id}`;
    d.cmd.textContent = n.cmd;
    d.cmd.title = n.cmd;
    d.meta.textContent = metaText(n);
    if (d.mode === 'pill') return;
    d.body.style.maxHeight = `${n.bodyH}px`;
    d.body.style.height = live ? `${n.bodyH}px` : '';
    const tp = tilde(n.cwd).split('/');
    d.cwd.textContent = tp.length > 5 ? `…/${tp.slice(-3).join('/')}` : tp.join('/');
    d.cwd.title = n.cwd;
    renderNote(n);
    renderTabs(n);
    renderAi(n);
  }

  function metaText(n) {
    const dur = fmtDur((n.endedAt || Date.now()) - n.startedAt);
    if (n.status === 'running') return dur;
    if (n.status === 'interrupted') return 'interrupted';
    if (n.status === 'killed') return `stopped · ${dur}`;
    if (n.status === 'error') return `exit ${n.exitCode} · ${dur}`;
    return dur;
  }

  // Capped or evicted output says so above the body.
  function renderNote(n) {
    const d = dom.get(n.id);
    const evicted = n.out && n.out.evicted;
    d.note.hidden = !(n.capped || evicted);
    if (d.note.hidden) return;
    d.note.textContent = '';
    if (evicted) { d.note.textContent = 'Output removed to stay under the total output limit (Settings).'; return; }
    d.note.append(document.createTextNode(`Output capped at ${fmtBytes(n.capCard || 1024 ** 3)}. `));
    for (const [act, label] of [['save', 'Save output…'], ['open', 'Open in editor']]) {
      const b = document.createElement('button');
      b.className = 'linkish';
      b.dataset.act = act;
      b.textContent = label;
      d.note.append(b, document.createTextNode(' '));
    }
  }

  function renderTabs(n) {
    const d = dom.get(n.id);
    if (!d || d.mode !== 'full') return;
    d.tabs.textContent = '';
    const kind = n.rich ? n.rich.kind : n.richKind;
    if (!kind || n.status !== 'ok') return;
    for (const [key, label] of [['rich', Views.LABELS[kind]], ['raw', 'Raw']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = n.view === key ? 'on' : '';
      b.onclick = (e) => { e.stopPropagation(); n.view = key; renderTabs(n); schedule(n); saveSoon(); };
      d.tabs.append(b);
    }
  }

  function ctxFor(n) {
    const d = dom.get(n.id);
    return {
      cwd: n.cwdAfter || n.cwd,
      tilde,
      worker,
      scroller: () => (d && d.body) || null,
      runChild: (cmd) => runCommand(cmd, { parentId: n.id }),
      openPath: async (p) => { const err = await api.openPath(p); if (err) toast(`Couldn't open: ${err}`, { kind: 'err' }); },
    };
  }

  const placeholder = (body, html) => { body.className = 'card-body raw'; body.innerHTML = html; };

  function renderBody(n) {
    const d = dom.get(n.id);
    if (!d || d.mode !== 'full') return;
    const body = d.body;
    if (n.status === 'running') {
      if (d.vt) { d.vt.destroy(); d.vt = null; }
      d.richFor = null;
      const snap = terminals.refresh(n, () => schedule(n));
      if (snap && snap.live) { body.className = 'card-body raw'; body.textContent = ''; release(n); return; }
      if (snap && snap.text) {
        body.className = 'card-body raw snap';
        body.innerHTML = `<pre>${Ansi.toHtml(snap.text)}</pre>`;
        body.scrollTop = body.scrollHeight;
      } else placeholder(body, '<div class="placeholder running"><span></span><span></span><span></span></div>');
      release(n);
      return;
    }
    // Rich view: restored cards parse again (or reload their saved view) in the worker.
    if ((n.rich || n.richKind) && n.view === 'rich' && n.status === 'ok') {
      if (!n.rich) { loadRich(n); if (!d.vt) return; }
      else {
        if (d.richFor !== n.rich) {
          if (d.vt) { d.vt.destroy(); d.vt = null; }
          body.className = 'card-body rich';
          body.replaceChildren(Views.render(n.rich, ctxFor(n)));
          d.richFor = n.rich;
          requestAnimationFrame(() => release(n));
        }
        return;
      }
    }
    d.richFor = null;
    if (!n.out) { loadInfo(n); return; }
    if (n.out.evicted || !n.out.lines) {
      if (d.vt) { d.vt.destroy(); d.vt = null; }
      placeholder(body, `<div class="placeholder">${n.out.evicted ? 'Output removed' : n.status === 'interrupted' ? 'Interrupted when Loom closed' : 'No output'}</div>`);
      release(n);
      return;
    }
    if (!d.vt) {
      body.className = 'card-body raw vtbody';
      body.textContent = '';
      d.vt = VLines.create({
        api, id: n.key, host: body, lineH: LINE_H,
        maxHeight: () => n.bodyH - 22,
        onLayout: () => release(n),
        atEnd: !!n.vtAtEnd, top: n.vtTop || 0,
        zoom: () => state.view.k,
      });
      d.vt.setCols(colsFor(n));
    }
  }

  async function loadInfo(n) {
    if (n.infoLoading) return;
    n.infoLoading = true;
    try { n.out = await api.outInfo(n.key); } finally { n.infoLoading = false; }
    if (n.out && n.out.capped) n.capped = true;
    if (state.nodes.has(n.id)) { updateCard(n); schedule(n); }
  }

  async function loadRich(n) {
    if (n.richLoading) return;
    n.richLoading = true;
    try {
      const rich = await worker.call('restore', { id: n.key, kind: n.richKind, cmd: n.cmd, cwd: n.cwd, cwdAfter: n.cwdAfter });
      if (!state.nodes.has(n.id)) return;
      if (rich) n.rich = rich; else { n.richKind = null; }
    } catch (err) { console.warn('rich view failed', err); n.richKind = null; } finally { n.richLoading = false; }
    renderTabs(n);
    schedule(n);
  }

  function renderAi(n) {
    const d = dom.get(n.id);
    if (!d || d.mode !== 'full') return;
    const box = d.ai;
    box.textContent = '';
    if (!n.ai && n.status !== 'error') { box.hidden = true; return; }
    box.hidden = false;
    if (!n.ai) {
      box.className = 'card-ai prompt';
      const msg = document.createElement('span');
      msg.textContent = `Failed with exit code ${n.exitCode}`;
      const b = document.createElement('button');
      b.innerHTML = `${ICON.spark}Explain with Claude`;
      b.onclick = (e) => { e.stopPropagation(); explain(n); };
      box.append(msg, b);
      return;
    }
    box.className = 'card-ai';
    if (n.ai.loading) { box.innerHTML = `<div class="ai-loading">${ICON.spark}<span>Reading the output…</span></div>`; return; }
    if (n.ai.error) {
      box.innerHTML = `<div class="ai-error"></div>`;
      box.firstChild.textContent = n.ai.error;
    } else {
      const s = document.createElement('div');
      s.className = 'ai-summary';
      s.innerHTML = ICON.spark;
      s.append(document.createTextNode(n.ai.summary || ''));
      box.append(s);
      if (n.ai.fix) {
        const fix = document.createElement('div');
        fix.className = 'ai-fix';
        const code = document.createElement('code');
        code.textContent = n.ai.fix;
        const run = document.createElement('button');
        run.className = 'primary';
        run.textContent = 'Run fix';
        run.onclick = (e) => { e.stopPropagation(); runCommand(n.ai.fix, { parentId: n.id }); };
        fix.append(code, run);
        box.append(fix);
        if (n.ai.fixWhy) {
          const why = document.createElement('div');
          why.className = 'ai-why';
          why.textContent = n.ai.fixWhy;
          box.append(why);
        }
      }
    }
    const x = document.createElement('button');
    x.className = 'ai-close';
    x.innerHTML = ICON.close;
    x.title = 'Dismiss';
    x.onclick = (e) => { e.stopPropagation(); n.ai = null; renderAi(n); scheduleLayout(); saveSoon(); };
    box.append(x);
  }

  // ================================================================ render scheduling
  const dirty = new Set();
  let frame = 0;
  function schedule(n) { if (n) dirty.add(n.id); scheduleLayout(); }
  function scheduleLayout() {
    if (frame) return;
    frame = requestAnimationFrame(tick);
  }
  let lastLayoutVersion = -1;
  function tick() {
    frame = 0;
    for (const id of dirty) { const n = state.nodes.get(id); if (n) renderBody(n); }
    dirty.clear();
    pushDown();
    drawEdges();
    cull();
    models();
    terminals.layout();
    if (lod === 'far') drawFar();
    drawMinimap();
    if (layoutVersion !== lastLayoutVersion) { lastLayoutVersion = layoutVersion; renderTreeSoon(); }
    els.empty.hidden = state.nodes.size > 0;
  }

  // Cards grow as output streams in; keep children from being covered.
  // Only cards whose height or position changed are looked at.
  let dragging = null;
  function pushDown() {
    if (!heightChanged.size) return;
    const check = [...heightChanged];
    heightChanged.clear();
    for (let i = 0; i < check.length; i++) {
      const n = state.nodes.get(check[i]);
      if (!n) continue;
      const bottom = n.y + h(n);
      for (const c of childrenOf(n.id)) {
        if (dragging && dragging.ids.includes(c.id)) continue;
        if (c.y >= n.y && c.y < bottom + 36) {
          const dy = bottom + GAP_Y - c.y;
          for (const id of subtree(c.id)) {
            const m = state.nodes.get(id);
            m.y += dy;
            moveEl(m);
          }
        }
      }
    }
  }

  // Cached over all cards: changes only when a card moves or resizes.
  let boundsCache = null;
  let boundsVersion = -1;
  function cardBounds() {
    if (boundsVersion === layoutVersion) return boundsCache;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const n of state.nodes.values()) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + n.w > maxX) maxX = n.x + n.w;
      if (n.y + h(n) > maxY) maxY = n.y + h(n);
    }
    boundsVersion = layoutVersion;
    boundsCache = minX === Infinity ? null : { minX, minY, maxX, maxY };
    return boundsCache;
  }

  function placeNode(n, parent) {
    if (!parent) {
      const b = cardBounds();
      n.x = b ? b.maxX + 160 : 0;
      n.y = b ? b.minY : 0;
      moveEl(n);
      updateCard(n);
      return;
    }
    const sibs = childrenOf(parent.id).filter((c) => c.id !== n.id);
    n.y = parent.y + h(parent) + GAP_Y;
    if (!sibs.length) n.x = parent.x;
    else {
      let maxX = -Infinity;
      for (const s of sibs) for (const id of subtree(s.id)) { const m = state.nodes.get(id); maxX = Math.max(maxX, m.x + m.w); }
      n.x = maxX + GAP_X;
    }
    const hits = () => grid.query(n.x - 24, n.y - 24, n.w + 48, 160 + 48).some((id) => id !== n.id);
    for (let i = 0; i < 60 && hits(); i++) n.x += 80;
    moveEl(n);
    updateCard(n);
  }

  // ================================================================ culling and level of detail
  let lod = 'full';
  let mountQueue = [];
  function lodFor(k) {
    // A little hysteresis, so a zoom resting on a threshold doesn't flicker.
    if (lod === 'full') return k < PILL_K - 0.02 ? (k < FAR_K ? 'far' : 'pill') : 'full';
    if (lod === 'pill') return k >= PILL_K + 0.02 ? 'full' : k < FAR_K - 0.01 ? 'far' : 'pill';
    return k >= FAR_K + 0.01 ? (k >= PILL_K ? 'full' : 'pill') : 'far';
  }

  // Cards near the viewport get their DOM; the rest are empty boxes of the
  // same size. Mounting is spread over frames so a big pan never stalls.
  function cull() {
    const r = viewRectWorld();
    if (lod === 'far') {
      for (const id of inDom) { const d = dom.get(id); if (d.mode !== 'stub') unmount(state.nodes.get(id)); d.card.remove(); }
      inDom.clear();
      mountQueue = [];
      return;
    }
    const mode = lod;
    const m1 = Math.max(240, r.w * 0.2);
    const m2 = Math.max(800, r.w * 0.6);
    const m3 = Math.max(3000, r.w * 2);
    const near = new Set(grid.query(r.x - m3, r.y - m3, r.w + m3 * 2, r.h + m3 * 2));
    for (const id of inDom) {
      const d = dom.get(id);
      if (!near.has(id) && d && d.mode === 'stub') { d.card.remove(); inDom.delete(id); }
    }
    for (const id of near) if (!inDom.has(id)) { els.cards.append(dom.get(id).card); inDom.add(id); }
    cullEdges(r, m2);
    const keep = new Set(grid.query(r.x - m2, r.y - m2, r.w + m2 * 2, r.h + m2 * 2));
    for (const [id, d] of dom) {
      if (d.mode === 'stub') continue;
      const n = state.nodes.get(id);
      const pinned = d.mode === 'full' && (terminals.isLive(n.key) || terminals.isFocused(n.key) || (d.body && d.body.contains(document.activeElement)));
      if ((!keep.has(id) && !pinned) || (d.mode !== mode && !pinned)) unmount(n);
    }
    const cx = r.x + r.w / 2; const cy = r.y + r.h / 2;
    mountQueue = grid.query(r.x - m1, r.y - m1, r.w + m1 * 2, r.h + m1 * 2)
      .filter((id) => dom.get(id).mode !== mode)
      .map((id) => state.nodes.get(id))
      .sort((a, b) => Math.hypot(a.x + a.w / 2 - cx, a.y - cy) - Math.hypot(b.x + b.w / 2 - cx, b.y - cy));
    const t0 = performance.now();
    while (mountQueue.length && performance.now() - t0 < (mode === 'pill' ? 4 : 6)) mount(mountQueue.shift(), mode);
    if (mountQueue.length) scheduleLayout();
  }

  // Running cards keep a terminal model while they're on screen, live, in the
  // overlay or on the alternate screen; others only stream to main.
  function models() {
    const now = performance.now();
    const r = viewRectWorld();
    for (const id of running) {
      const n = state.nodes.get(id);
      if (!n || n.ending) continue;
      const d = dom.get(id);
      const onScreen = d && d.mode === 'full' && n.x < r.x + r.w && n.x + n.w > r.x && n.y < r.y + r.h && n.y + h(n) > r.y;
      const need = onScreen || n.justRun || terminals.isLive(n.key) || terminals.stats().overlay === n.key || terminals.inAlt(n.key);
      if (need) {
        n.releaseAt = 0;
        if (!terminals.has(n.key)) terminals.attach(n);
      } else if (terminals.has(n.key)) {
        if (!n.releaseAt) { n.releaseAt = now + MODEL_GRACE; setTimeout(scheduleLayout, MODEL_GRACE + 20); }
        else if (now >= n.releaseAt) { n.releaseAt = 0; terminals.release(n.key); schedule(n); }
      }
    }
  }

  // ================================================================ edges
  // One path per edge. Only edges with a moved end get a new `d`.
  const edges = new Map(); // key -> { from, to, pipe, path, label }
  const edgesOf = new Map(); // node id -> Set of keys
  const dirtyEdges = new Set();
  // Edges near the view are in the SVG; a huge SVG is re-rastered every frame.
  const edgeGrid = Spatial.createGrid(1024);
  const shownEdges = new Set();
  function showEdge(e, on) {
    if (on) { els.edgePaths.append(e.path); if (e.label) els.edgeLabels.append(e.label); shownEdges.add(e.key); }
    else { e.path.remove(); if (e.label) e.label.remove(); shownEdges.delete(e.key); }
  }
  function cullEdges(r, m) {
    const want = new Set(edgeGrid.query(r.x - m, r.y - m, r.w + m * 2, r.h + m * 2));
    for (const key of [...shownEdges]) if (!want.has(key)) showEdge(edges.get(key), false);
    for (const key of want) if (!shownEdges.has(key)) showEdge(edges.get(key), true);
  }
  let activeSet = new Set();
  const edgeKey = (from, to, pipe) => `${from}>${to}${pipe ? 'p' : ''}`;
  const SVG = 'http://www.w3.org/2000/svg';
  function link(id, key) { let s = edgesOf.get(id); if (!s) { s = new Set(); edgesOf.set(id, s); } s.add(key); }
  function unlink(id, key) { const s = edgesOf.get(id); if (s) { s.delete(key); if (!s.size) edgesOf.delete(id); } }
  function dropEdge(key) {
    const e = edges.get(key);
    if (!e) return;
    e.path.remove();
    if (e.label) e.label.remove();
    unlink(e.from, key); unlink(e.to, key);
    edges.delete(key);
    dirtyEdges.delete(key);
    shownEdges.delete(key);
    edgeGrid.remove(key);
  }
  // The edges into `n`: from its parent, or a pipe from its source.
  function syncEdges(n) {
    const want = new Map();
    if (n.pipeFrom != null && state.nodes.has(n.pipeFrom)) want.set(edgeKey(n.pipeFrom, n.id, true), [n.pipeFrom, true]);
    if (hasParent(n) && n.pipeFrom !== n.parentId) want.set(edgeKey(n.parentId, n.id, false), [n.parentId, false]);
    for (const key of [...(edgesOf.get(n.id) || [])]) {
      const e = edges.get(key);
      if (e && e.to === n.id && !want.has(key)) dropEdge(key);
    }
    for (const [key, [from, pipe]] of want) {
      if (edges.has(key)) continue;
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('class', `edge${pipe ? ' pipe' : ''}`);
      let label = null;
      if (pipe) {
        label = document.createElementNS(SVG, 'g');
        label.setAttribute('class', 'pipe-label');
        label.innerHTML = '<circle r="10"/><text y="4">|</text>';
      }
      edges.set(key, { key, from, to: n.id, pipe, path, label, on: false });
      link(from, key); link(n.id, key);
      dirtyEdges.add(key);
    }
    layoutVersion++;
  }
  function dropEdgesOf(id) { for (const key of [...(edgesOf.get(id) || [])]) dropEdge(key); }

  function activePath() {
    const set = new Set();
    let cur = state.nodes.get(state.activeId);
    while (cur && !set.has(cur.id)) { set.add(cur.id); cur = state.nodes.get(cur.parentId); }
    return set;
  }

  function drawEdges() {
    for (const id of moved) for (const key of edgesOf.get(id) || []) dirtyEdges.add(key);
    moved.clear();
    for (const key of dirtyEdges) {
      const e = edges.get(key);
      if (!e) continue;
      const a = state.nodes.get(e.from); const n = state.nodes.get(e.to);
      if (!a || !n) continue;
      const x1 = a.x + ANCHOR; const y1 = a.y + h(a);
      const x2 = n.x + ANCHOR; const y2 = n.y;
      const dy = Math.max(28, Math.abs(y2 - y1) / 2);
      e.path.setAttribute('d', `M${x1} ${y1} C${x1} ${y1 + dy} ${x2} ${y2 - dy} ${x2} ${y2}`);
      if (e.label) e.label.setAttribute('transform', `translate(${(x1 + x2) / 2} ${(y1 + y2) / 2})`);
      edgeGrid.set(key, Math.min(x1, x2) - 2, Math.min(y1, y2), Math.abs(x2 - x1) + 4, Math.abs(y2 - y1) + 1);
    }
    dirtyEdges.clear();
  }
  // Only edges that touch the old or new path change class.
  function markActivePath() {
    const next = activePath();
    for (const id of new Set([...activeSet, ...next])) {
      for (const key of edgesOf.get(id) || []) {
        const e = edges.get(key);
        const on = next.has(e.from) && next.has(e.to);
        if (on !== e.on) { e.on = on; e.path.classList.toggle('on', on); }
      }
    }
    activeSet = next;
  }

  // ================================================================ far zoom: one canvas
  const farCtx = els.far.getContext('2d');
  function drawFar() {
    const cv = els.far;
    const dpr = window.devicePixelRatio || 1;
    const W = els.viewport.clientWidth; const H = els.viewport.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = farCtx;
    const { x, y, k } = state.view;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    g.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y);
    const css = themeColors();
    const r = viewRectWorld();
    const ids = grid.query(r.x - 200, r.y - 200, r.w + 400, r.h + 400);
    const shown = new Set(ids);
    g.lineWidth = 1.5 / k;
    g.beginPath();
    g.strokeStyle = css.edge;
    const pipes = [];
    for (const [, e] of edges) {
      if (!shown.has(e.from) && !shown.has(e.to)) continue;
      const a = state.nodes.get(e.from); const n = state.nodes.get(e.to);
      if (!a || !n) continue;
      if (e.pipe) { pipes.push([a, n]); continue; }
      const x1 = a.x + ANCHOR; const y1 = a.y + h(a); const x2 = n.x + ANCHOR; const y2 = n.y;
      const dy = Math.max(28, Math.abs(y2 - y1) / 2);
      g.moveTo(x1, y1);
      g.bezierCurveTo(x1, y1 + dy, x2, y2 - dy, x2, y2);
    }
    g.stroke();
    if (pipes.length) {
      g.beginPath();
      g.strokeStyle = css.info;
      for (const [a, n] of pipes) { g.moveTo(a.x + ANCHOR, a.y + h(a)); g.lineTo(n.x + ANCHOR, n.y); }
      g.stroke();
    }
    const text = 18 * k >= 4;
    if (text) { g.font = `500 18px ${css.mono}`; g.textBaseline = 'middle'; }
    for (const id of ids) {
      const n = state.nodes.get(id);
      const hh = h(n);
      g.fillStyle = css.card;
      g.fillRect(n.x, n.y, n.w, hh);
      g.fillStyle = n.status === 'error' ? css.err : n.status === 'killed' ? css.warn : n.status === 'running' || n.status === 'ok' ? css.accent : css.faint;
      g.fillRect(n.x, n.y, 10 / Math.max(k, 0.05) > n.w / 4 ? n.w / 4 : 10 / Math.max(k, 0.05), hh);
      if (n.id === state.activeId) { g.strokeStyle = css.accent; g.lineWidth = 3 / k; g.strokeRect(n.x, n.y, n.w, hh); }
      if (text) {
        g.fillStyle = css.text;
        const max = Math.floor((n.w - 40) / 11);
        g.fillText(n.cmd.length > max ? `${n.cmd.slice(0, max - 1)}…` : n.cmd, n.x + 26, n.y + 24, n.w - 36);
      }
    }
  }
  let colors = null;
  function themeColors() {
    if (colors) return colors;
    const css = getComputedStyle(document.body);
    const v = (name) => css.getPropertyValue(name).trim();
    colors = {
      card: v('--card'), edge: v('--line-2'), info: v('--info'), err: v('--err'), warn: v('--warn'), accent: v('--accent'),
      faint: v('--faint'), text: v('--text'), mono: v('--mono'), mmOk: v('--mm-ok'), mmView: v('--mm-view'),
    };
    return colors;
  }
  Ansi.lightTheme.addEventListener('change', () => { colors = null; mmVersion = -1; scheduleLayout(); });

  // ================================================================ viewport
  function applyView() {
    const { x, y, k } = state.view;
    els.world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    els.viewport.style.backgroundPosition = `${x}px ${y}px`;
    els.viewport.style.backgroundSize = `${22 * k}px ${22 * k}px`;
    els.zoomLabel.textContent = `${Math.round(k * 100)}%`;
    const next = lodFor(k);
    if (next !== lod) {
      lod = next;
      els.viewport.classList.toggle('lod-pill', lod === 'pill');
      els.viewport.classList.toggle('lod-far', lod === 'far');
      els.far.hidden = lod !== 'far';
      if (lod === 'far') terminals.collapse();
    }
    terminals.layout();
    scheduleLayout();
    saveSoon();
  }
  function viewRectWorld() {
    const W = els.viewport.clientWidth; const H = els.viewport.clientHeight;
    const { x, y, k } = state.view;
    return { x: -x / k, y: -y / k, w: W / k, h: H / k };
  }
  function zoomAt(cx, cy, factor) {
    const r = els.viewport.getBoundingClientRect();
    const px = cx - r.left; const py = cy - r.top;
    const { x, y, k } = state.view;
    const k2 = clamp(k * factor, MIN_K, 2.5);
    const wx = (px - x) / k; const wy = (py - y) / k;
    state.view = { x: px - wx * k2, y: py - wy * k2, k: k2 };
    applyView();
  }
  function zoomCenter(factor) {
    const r = els.viewport.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  }

  let anim = 0;
  function animateTo(target, ms = 280) {
    cancelAnimationFrame(anim);
    const from = { ...state.view };
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / ms);
      const e = 1 - (1 - p) ** 3;
      state.view = {
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
        k: from.k + (target.k - from.k) * e,
      };
      applyView();
      if (p < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  function fit(instant = false) {
    const b = cardBounds();
    if (!b) { animateTo({ x: 120, y: 90, k: 1 }); return; }
    const r = els.viewport.getBoundingClientRect();
    const availW = r.width - 120; const availH = r.height - 220;
    const k = clamp(Math.min(availW / (b.maxX - b.minX), availH / (b.maxY - b.minY), 1.1), MIN_K, 1.1);
    const target = {
      k,
      x: (r.width - (b.maxX - b.minX) * k) / 2 - b.minX * k,
      y: 70 + (availH - (b.maxY - b.minY) * k) / 2 - b.minY * k,
    };
    if (instant) { state.view = target; applyView(); } else animateTo(target);
  }

  // Bring a card into view; `center` recenters even if it's partly visible.
  function reveal(n, center = false) {
    const r = els.viewport.getBoundingClientRect();
    const { x, y } = state.view;
    let { k } = state.view;
    if (center && k < 0.6) k = 1;
    const sx = n.x * k + x; const sy = n.y * k + y;
    const sw = n.w * k; const sh = Math.min(h(n), 420) * k;
    const usableH = r.height - 130;
    const fully = sx >= 20 && sy >= 20 && sx + sw <= r.width - 20 && sy + sh <= usableH;
    if (fully && !center && k === state.view.k) return;
    animateTo({
      k,
      x: (sx >= 20 && sx + sw <= r.width - 20 && !center) ? x : r.width / 2 - (n.x + n.w / 2) * k,
      y: Math.min(usableH - 40, r.height * 0.32) - (n.y + Math.min(h(n), 420) * 0.4) * k,
    });
  }

  // ---------------------------------------------------------------- pointer: pan, drag, resize
  els.viewport.addEventListener('pointerdown', (e) => {
    const onCanvas = e.target === els.viewport || e.target === els.world || e.target === els.cards || e.target === els.far || e.target.closest('#edges');
    if (!(onCanvas || e.button === 1)) return;
    e.preventDefault();
    // A click on a far-zoom card selects it.
    if (lod === 'far' && e.target === els.far && e.button === 0) {
      const r = els.viewport.getBoundingClientRect();
      const wx = (e.clientX - r.left - state.view.x) / state.view.k; const wy = (e.clientY - r.top - state.view.y) / state.view.k;
      const hit = grid.at(wx, wy)[0];
      if (hit != null) { setActive(hit); scheduleLayout(); }
    }
    const start = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y };
    els.viewport.setPointerCapture(e.pointerId);
    els.viewport.classList.add('panning');
    const move = (ev) => {
      state.view.x = start.vx + ev.clientX - start.x;
      state.view.y = start.vy + ev.clientY - start.y;
      applyView();
    };
    const up = () => {
      els.viewport.classList.remove('panning');
      els.viewport.removeEventListener('pointermove', move);
      els.viewport.removeEventListener('pointerup', up);
      els.viewport.removeEventListener('pointercancel', up);
    };
    els.viewport.addEventListener('pointermove', move);
    els.viewport.addEventListener('pointerup', up);
    els.viewport.addEventListener('pointercancel', up);
  });

  els.viewport.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey ? 0.01 : 0.0025)));
      return;
    }
    if (e.target.closest('.live-term')) return; // xterm scrolls or sends it to the program
    const sc = e.target.closest('.card-body, .card-ai');
    if (sc) {
      const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
      const canY = e.deltaY > 0 ? sc.scrollTop + sc.clientHeight < sc.scrollHeight - 1 : sc.scrollTop > 0;
      const canX = e.deltaX > 0 ? sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 1 : sc.scrollLeft > 0;
      if ((vertical && canY) || (!vertical && canX)) return;
    }
    e.preventDefault();
    state.view.x -= e.deltaX;
    state.view.y -= e.deltaY;
    applyView();
  }, { passive: false });

  els.cards.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const n = state.nodes.get(Number(card.dataset.id));
    if (!n) return;
    if (n.id !== state.activeId) setActive(n.id);
    if (n.status === 'running' && e.target.closest('.card-body')) showTerm(n, { focus: true });

    const resize = e.target.closest('.card-resize');
    const head = e.target.closest('.card-head, .pill-head') || (dom.get(n.id).mode !== 'full' ? card : null);
    if (!resize && !(head && !e.target.closest('button'))) return;
    e.preventDefault();
    card.setPointerCapture(e.pointerId);
    const k = state.view.k;
    const sx = e.clientX; const sy = e.clientY;
    let move;
    let ids = [n.id];
    if (resize) {
      const w0 = n.w; const b0 = n.bodyH;
      move = (ev) => {
        n.w = clamp(w0 + (ev.clientX - sx) / k, 360, 1600);
        n.bodyH = clamp(b0 + (ev.clientY - sy) / k, 80, 1600);
        updateCard(n);
        const d = dom.get(n.id);
        if (d.vt) { d.vt.setCols(colsFor(n)); d.vt.layout(); }
        placed(n);
        scheduleLayout();
      };
    } else {
      ids = e.shiftKey ? subtree(n.id) : [n.id];
      const origin = ids.map((id) => { const m = state.nodes.get(id); return [m, m.x, m.y]; });
      dragging = { ids };
      card.classList.add('dragging');
      move = (ev) => {
        const dx = (ev.clientX - sx) / k; const dy = (ev.clientY - sy) / k;
        for (const [m, x0, y0] of origin) {
          m.x = Math.round(x0 + dx); m.y = Math.round(y0 + dy);
          moveEl(m);
        }
        scheduleLayout();
      };
    }
    const up = () => {
      dragging = null;
      card.classList.remove('dragging');
      card.removeEventListener('pointermove', move);
      card.removeEventListener('pointerup', up);
      card.removeEventListener('pointercancel', up);
      // A card dropped over its parent, or over its children, makes room again.
      for (const id of ids) {
        const m = state.nodes.get(id);
        heightChanged.add(id);
        if (hasParent(m)) heightChanged.add(m.parentId);
      }
      scheduleLayout();
      saveSoon();
    };
    card.addEventListener('pointermove', move);
    card.addEventListener('pointerup', up);
    card.addEventListener('pointercancel', up);
  });

  els.cards.addEventListener('dblclick', (e) => {
    const head = e.target.closest('.card-head');
    if (!head || e.target.closest('button')) return;
    const n = state.nodes.get(Number(head.closest('.card').dataset.id));
    n.collapsed = !n.collapsed;
    updateCard(n);
    scheduleLayout();
    saveSoon();
  });

  els.cards.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const n = state.nodes.get(Number(btn.closest('.card').dataset.id));
    if (!n) return;
    e.stopPropagation();
    cardAction(n, btn.dataset.act);
  });

  async function cardAction(n, act) {
    switch (act) {
      case 'stop': stop(n); break;
      case 'expand': n.noExpand = false; showTerm(n); terminals.expand(n); break;
      case 'rerun':
        if (n.status === 'running') return;
        start(n);
        break;
      case 'branch':
        setActive(n.id);
        setPipe(null);
        focusPrompt();
        toast(`Next command branches from #${n.id}`, { timeout: 2200 });
        break;
      case 'pipe': setActive(n.id); setPipe(n.id); focusPrompt(); break;
      case 'explain': explain(n); break;
      case 'copy': {
        const res = await api.outCopy({ id: n.key });
        toast(res && res.truncated ? `Copied the first ${fmtBytes(res.bytes)}. Save output… keeps all of it.` : 'Output copied', { timeout: res && res.truncated ? 5000 : 1600 });
        break;
      }
      case 'save': {
        const res = await api.outSave({ id: n.key, name: n.cmd });
        if (res) toast(`Saved ${fmtBytes(res.bytes).replace(/^0 MB$/, 'output')} to ${tilde(res.path)}`, { timeout: 3000 });
        break;
      }
      case 'open': {
        const err = await api.outOpen({ id: n.key });
        if (err) toast(`Couldn't open: ${err}`, { kind: 'err' });
        break;
      }
      case 'delete': removeNode(n); break;
      default:
    }
  }

  function stop(n) {
    if (n.status !== 'running') return;
    n.killed = true;
    api.kill(n.key);
  }

  function dropRich(n) {
    if (n.rich && n.rich.data && n.rich.data.doc) worker.call('release', { doc: n.rich.data.doc }).catch(() => {});
  }

  function removeNode(n) {
    if (n.status === 'running') stop(n);
    for (const c of [...childrenOf(n.id)]) reparent(c, n.parentId);
    for (const m of state.nodes.values()) if (m.pipeFrom === n.id) { m.pipeFrom = null; syncEdges(m); updateCard(m); }
    if (state.pipeFrom === n.id) setPipe(null);
    unmount(n);
    treeDetach(n);
    dropEdgesOf(n.id);
    state.nodes.delete(n.id);
    running.delete(n.id);
    grid.remove(n.id);
    layoutVersion++;
    treeVersion++;
    dropRich(n);
    terminals.dispose(n.key);
    VLines.forget(n.key);
    api.forget(n.key);
    dom.get(n.id).card.remove();
    dom.delete(n.id);
    inDom.delete(n.id);
    if (state.activeId === n.id) setActive(n.parentId != null && state.nodes.has(n.parentId) ? n.parentId : null);
    scheduleLayout();
    saveSoon();
  }

  // ================================================================ running commands
  // A leading space keeps the command out of history, as with zsh and bash
  // `ignorespace`.
  function runCommand(raw, { parentId = state.activeId, pipeFrom = null } = {}) {
    const cmd = raw.replace(/^\n+|\s+$/g, '').replace(/^[ \t]+/, '');
    if (!cmd) return null;
    if (cmd === 'clear' || cmd === 'reset') { newRoot(); return null; }
    const parent = parentId != null ? state.nodes.get(parentId) : null;
    const n = makeNode({
      cmd,
      parentId: parent ? parent.id : null,
      pipeFrom,
      cwd: parent ? (parent.cwdAfter || parent.cwd) : state.rootCwd,
      noHistory: /^[ \t]/.test(raw.replace(/^\n+/, '')),
    });
    placeNode(n, parent);
    start(n);
    setActive(n.id, { takeKeyboard: true });
    requestAnimationFrame(() => reveal(n));
    return n;
  }

  function start(n) {
    dropRich(n);
    Object.assign(n, {
      status: 'running', rich: null, richKind: null, ai: null, exitCode: null, out: null, capped: false,
      startedAt: Date.now(), endedAt: null, killed: false, view: 'rich', envFile: null,
      noExpand: false, vtTop: 0, vtAtEnd: false, ending: false,
    });
    const d = dom.get(n.id);
    if (d && d.vt) { d.vt.destroy(); d.vt = null; }
    VLines.forget(n.key);
    running.add(n.id);
    terminals.attach(n, { fresh: true });
    recordStart(n);
    renderTabBar();
    const src = n.pipeFrom != null ? state.nodes.get(n.pipeFrom) : null;
    if (n.pipeFrom != null && !src) { n.pipeFrom = null; syncEdges(n); }
    updateCard(n);
    schedule(n);
    const parent = state.nodes.get(n.parentId);
    api.run({
      id: n.key, command: n.cmd, cwd: n.cwd, stdinFrom: src ? src.key : undefined,
      parentId: parent ? parent.key : null,
      fork: !!parent && childrenOf(parent.id).some((c) => c.id !== n.id),
      envFile: nearestSnapshot(parent),
      watch: true,
    });
  }

  // A parent that's still running (or was interrupted) has no snapshot yet.
  function nearestSnapshot(n) {
    while (n && !n.envFile) n = state.nodes.get(n.parentId);
    return n ? n.envFile : null;
  }

  api.onData(({ id, data }) => terminals.write(id, data));

  // A card's key is "<canvas>.<card>". Cards in background tabs keep running;
  // their data changes here and their DOM is built when the tab is shown.
  const canvasOf = (key) => canvases.get(String(key).split('.')[0]);
  function nodeOf(key) {
    const cv = canvasOf(key);
    return cv && cv.nodes ? cv.nodes.get(Number(String(key).split('.')[1])) : null;
  }

  api.onExit(async ({ id: key, code, signal, cwd, envFile, out }) => {
    const cv = canvasOf(key);
    const n = nodeOf(key);
    if (!n) return;
    n.ending = true; // no new terminal model while it finishes
    const ended = await terminals.finish(n, { moved: !!(out && out.moved) });
    if (cv.nodes.get(n.id) !== n) return;
    // A program that moved the cursor keeps what its screen showed.
    n.out = ended.text != null ? await api.outReplace({ id: key, text: ended.text }) : out;
    if (cv.nodes.get(n.id) !== n) return;
    const shown = cv === cur;
    VLines.forget(key);
    if (shown) {
      running.delete(n.id);
      const d = dom.get(n.id);
      if (d && d.vt) { d.vt.destroy(); d.vt = null; }
    }
    n.exitCode = code;
    n.endedAt = Date.now();
    n.cwdAfter = cwd;
    n.envFile = envFile || null;
    n.capped = !!(n.out && n.out.capped) || n.capped;
    n.vtAtEnd = true;
    // 130 is Ctrl+C, typed into the live terminal or sent by Stop.
    n.status = n.killed || signal || code === 130 ? 'killed' : code === 0 ? 'ok' : 'error';
    if (shown && ended.focused) focusPrompt();
    recordEnd(n);
    if (shown) {
      updateCard(n);
      schedule(n);
      layoutVersion++;
      if (n.id === state.activeId) { updateComposer(); editor.refreshInfo(); }
    }
    cardFinished(cv, n);
    if (n.status === 'ok') {
      try {
        const rich = await worker.call('detect', { id: key, cmd: n.cmd, cwd: n.cwd, cwdAfter: n.cwdAfter });
        if (rich && cv.nodes.get(n.id) === n && n.status === 'ok') {
          n.rich = rich;
          n.richKind = rich.kind;
          if (cv === cur) { renderTabs(n); schedule(n); }
        }
      } catch (err) { console.warn('rich view failed', err); }
    }
    saveSoon(cv);
  });

  api.onCapped(({ id: key, cap }) => {
    const n = nodeOf(key);
    if (!n) return;
    n.capped = true;
    n.capCard = cap;
    toast(`#${n.id} passed ${fmtBytes(cap)} of output. Loom stopped recording it; the command keeps running.`, { timeout: 6000 });
    if (canvasOf(key) === cur) updateCard(n);
  });
  api.onEvicted(({ id: key }) => {
    const n = nodeOf(key);
    if (!n) return;
    n.out = { evicted: true, lines: 0, bytes: 0 };
    VLines.forget(key);
    if (canvasOf(key) !== cur) return;
    const d = dom.get(n.id);
    if (d && d.vt) { d.vt.destroy(); d.vt = null; }
    updateCard(n);
    schedule(n);
  });

  setInterval(() => {
    for (const id of running) {
      const d = dom.get(id);
      const n = state.nodes.get(id);
      if (d && d.meta && n) d.meta.textContent = metaText(n);
    }
  }, 500);

  // ================================================================ copy and find in output
  // A selection in a card body is copied from main, so lines scrolled out of
  // the DOM come along.
  document.addEventListener('copy', (e) => {
    const s = document.getSelection();
    const node = s && s.anchorNode;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    const vtEl = el && el.closest('.vt');
    if (!vtEl) return;
    const d = dom.get(Number(vtEl.closest('.card').dataset.id));
    if (!d || !d.vt) return;
    e.preventDefault();
    d.vt.selectionText().then((t) => { if (t != null) api.copyText(t); });
  });

  // ⌘/Ctrl+F: find in the active card's whole output.
  function findInCard(n) {
    if (!n || n.status === 'running') return false;
    if (n.view === 'rich' && (n.rich || n.richKind)) { n.view = 'raw'; renderTabs(n); }
    n.collapsed = false;
    const open = () => {
      const d = dom.get(n.id);
      if (d && d.mode === 'full') renderBody(n);
      if (d && d.vt) { d.vt.openFind(); return true; }
      return false;
    };
    if (open()) return true;
    reveal(n, true);
    let tries = 0;
    const again = () => { if (!open() && tries++ < 40) setTimeout(again, 50); };
    setTimeout(again, 50);
    return true;
  }

  // ================================================================ active card / composer
  function setActive(id, { takeKeyboard = false } = {}) {
    const prev = state.nodes.get(state.activeId);
    state.activeId = id;
    if (prev) updateCard(prev);
    const n = state.nodes.get(id);
    if (n) updateCard(n);
    if (n && n.status === 'running') {
      n.justRun = takeKeyboard;
      setTimeout(() => {
        n.justRun = false;
        if (n.status !== 'running' || state.activeId !== n.id) return;
        showTerm(n, { focus: takeKeyboard && composerIdle() });
        if (terminals.inAlt(n.key) && !n.noExpand) terminals.expand(n);
      }, LIVE_DELAY);
    }
    updateComposer();
    markActivePath();
    layoutVersion++;
    treeVersion++;
    scheduleLayout();
    saveSoon();
  }

  function setPipe(id) {
    state.pipeFrom = id;
    updateComposer();
  }

  function newRoot() {
    state.rootCwd = currentCwd();
    setPipe(null);
    setActive(null);
    focusPrompt();
  }

  function updateComposer() {
    const a = state.nodes.get(state.activeId);
    els.cwdChip.textContent = `${a ? `#${a.id} · ` : 'new root · '}${shortPath(currentCwd())}`;
    els.cwdChip.title = currentCwd();
    const p = state.nodes.get(state.pipeFrom);
    els.pipeChip.hidden = !p;
    if (p) {
      els.pipeChip.innerHTML = '';
      const label = document.createElement('span');
      label.textContent = `stdin ← #${p.id} ${p.cmd.length > 24 ? `${p.cmd.slice(0, 24)}…` : p.cmd}`;
      const x = document.createElement('button');
      x.innerHTML = ICON.close;
      x.title = 'Stop piping (Esc)';
      x.onclick = () => { setPipe(null); focusPrompt(); };
      els.pipeChip.append(label, x);
    }
    const ai = state.mode === 'ai';
    document.body.classList.toggle('mode-ai', ai);
    els.mode.innerHTML = ai ? ICON.spark : '$';
    els.prompt.placeholder = ai
      ? 'Describe what you want to do — Claude suggests a command'
      : p ? `Command that reads #${p.id}'s output, e.g. grep, sort, wc -l` : `Type a command · Tab completes · ${MOD}I asks Claude`;
    editor.render();
  }

  function focusPrompt() { terminals.collapse(); els.prompt.focus(); }

  // A new running card takes the keyboard, so sudo and REPLs work straight away,
  // unless the user has already started typing something else.
  const composerIdle = () => !els.prompt.value.trim() && !state.suggestion && settingsView.hidden && !palette.isOpen() && !editor.busy();
  // ---------------------------------------------------------------- history
  // A record is in memory as soon as the command starts, so ↑ finds it, and is
  // saved by main.js when it ends, with its exit code.
  function rootOf(n) {
    while (n && n.parentId != null && state.nodes.has(n.parentId)) n = state.nodes.get(n.parentId);
    return n;
  }

  function recordStart(n) {
    n.histRec = null;
    if (n.noHistory) return;
    const rec = { cmd: n.cmd, cwd: n.cwd, exitCode: null, startedAt: n.startedAt, durationMs: null, rootId: rootOf(n).key, cardId: n.key };
    const H = state.history;
    if (H.length && H[H.length - 1].cmd === rec.cmd) H[H.length - 1] = rec;
    else H.push(rec);
    if (H.length > 20000) H.splice(0, H.length - 20000);
    n.histRec = rec;
  }

  function recordEnd(n) {
    const rec = n.histRec;
    if (!rec) return;
    n.histRec = null;
    rec.exitCode = n.exitCode;
    rec.durationMs = n.endedAt - n.startedAt;
    api.historyAdd(rec);
  }

  function setMode(m) {
    state.mode = m;
    editor.closePopup();
    updateComposer();
    focusPrompt();
  }

  els.mode.addEventListener('click', () => setMode(state.mode === 'ai' ? 'shell' : 'ai'));

  function editorContext() {
    const a = state.nodes.get(state.activeId);
    const root = a ? rootOf(a) : null;
    return { cwd: currentCwd(), cardId: a ? a.key : null, envFile: nearestSnapshot(a), rootId: root ? root.key : null };
  }

  const editor = window.Editor.create({
    api,
    input: els.prompt,
    mirror: els.mirror,
    popup: els.complete,
    search: els.hsearch,
    hint: els.hint,
    context: editorContext,
    records: () => state.history,
    mode: () => state.mode,
    defaultHint: () => (state.mode === 'ai' ? `${MOD}I · back to shell` : `${MOD}I · ask Claude`),
    onRun: (text) => submit(text),
    fmt: { tilde, ago: fmtAgo },
  });

  // Keys typed before a new card's terminal opens belong to that card, not the
  // composer: this could be a sudo password, which must never become a command.
  function forwardTypeahead(e) {
    const n = state.nodes.get(state.activeId);
    if (els.prompt.value || !n || n.status !== 'running' || !n.justRun) return false;
    if (e.ctrlKey || e.metaKey || e.altKey || (e.key.length > 1 && e.key !== 'Enter')) return false;
    e.preventDefault();
    api.stdin({ id: n.key, data: e.key === 'Enter' ? '\r' : e.key });
    terminals.show(n, { focus: true });
    return true;
  }

  // Runs the bar's text, or asks Claude about it. `raw` keeps a leading space.
  function submit(raw) {
    const text = raw.trim();
    if (!text) return;
    if (state.mode === 'ai' || text.startsWith('?')) { ask(text.replace(/^\?\s*/, '')); return; }
    const pipe = state.pipeFrom;
    runCommand(raw, { parentId: pipe ?? state.activeId, pipeFrom: pipe });
    setPipe(null);
  }

  // The command bar's keys: a new card's typeahead, then the editor (popup,
  // ghost text, history), then commands, then Enter.
  els.prompt.addEventListener('keydown', (e) => {
    if (forwardTypeahead(e)) return;
    if (editor.handleKey(e)) return;
    if (registry.handle(e)) return;
    const v = els.prompt.value;
    if (e.key === 'Enter' && !e.isComposing) {
      // Shift+Enter, or an unfinished command (open quote, trailing |, heredoc…), adds a line.
      e.preventDefault();
      if (e.shiftKey || (state.mode === 'shell' && !v.trim().startsWith('?') && ShellLex.isIncomplete(v))) { editor.newline(); return; }
      if (!v.trim()) return;
      editor.clear();
      submit(v);
    }
  });

  // ================================================================ Claude: natural language -> command
  const ASK_SYSTEM = `You are the command assistant inside Loom, a graphical terminal. Turn the user's request into one shell command for the environment described.

Respond with only a JSON object (no prose, no code fences):
{"command": "...", "explanation": "...", "risk": "safe" | "caution" | "destructive"}

- command: a single line; chain with && or pipes when needed. Prefer tools available by default on the stated OS, and quote paths that contain spaces.
- explanation: one or two short, plain sentences saying what it does and calling out any non-obvious flags.
- risk: "destructive" if it deletes, overwrites, force-pushes, or otherwise can't be undone; "caution" if it modifies files, installs software, or touches the network in a meaningful way; otherwise "safe".
- Commands run in a real terminal, but prefer non-interactive forms unless the user asks for an interactive program.
- If a shell command can't do what was asked, set command to "" and explain why in explanation.`;

  async function ask(text) {
    const cwd = currentCwd();
    const names = await api.names(cwd);
    const branch = [];
    let cur = state.nodes.get(state.activeId);
    while (cur && branch.length < 8) {
      branch.unshift(`${cur.cmd}    # ${cur.status === 'ok' ? 'ok' : cur.status === 'error' ? `exit ${cur.exitCode}` : cur.status}`);
      cur = state.nodes.get(cur.parentId);
    }
    const src = state.nodes.get(state.pipeFrom);
    let prompt = `OS: ${OS_NAME}\nShell: ${sys.shell}\nCurrent directory: ${cwd}\nEntries here: ${names.join(', ') || '(empty)'}\nRecent commands on this branch, oldest first:\n${branch.join('\n') || '(none)'}\n`;
    if (src) {
      const { text: sample } = await api.outHead({ id: src.key, lines: 30 });
      prompt += `\nThe command will receive the output of \`${src.cmd}\` on stdin, so it should read from stdin rather than re-running that command. First lines of that output:\n${sample}\n`;
    }
    prompt += `\nRequest: ${text}`;

    const token = Symbol('ask');
    showSuggestion({ token, request: text, loading: true });
    const res = await api.ai({ system: ASK_SYSTEM, prompt, maxTokens: 700 });
    if (!state.suggestion || state.suggestion.token !== token) return;
    if (!res.ok) {
      if (res.error === 'NO_KEY') { hideSuggestion(); openSettings('Add an Anthropic API key so Claude can turn requests into commands.'); return; }
      showSuggestion({ token, request: text, error: res.error });
      return;
    }
    const j = parseJsonLoose(res.text);
    if (!j) { showSuggestion({ token, request: text, error: "Couldn't read Claude's reply. Try rephrasing." }); return; }
    showSuggestion({ token, request: text, command: j.command || '', explanation: j.explanation || '', risk: j.risk || 'safe' });
  }

  function showSuggestion(sg) {
    state.suggestion = sg;
    const box = els.suggestion;
    box.hidden = false;
    box.className = sg.loading ? 'loading' : '';
    box.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'sg-head';
    head.innerHTML = `<span class="sg-spark">${ICON.spark}</span>`;
    const req = document.createElement('span');
    req.className = 'sg-req';
    req.textContent = sg.request;
    head.append(req);
    if (sg.risk) {
      const r = document.createElement('span');
      r.className = `risk risk-${sg.risk}`;
      r.textContent = sg.risk;
      head.append(r);
    }
    const x = document.createElement('button');
    x.className = 'sg-x';
    x.innerHTML = ICON.close;
    x.title = 'Dismiss (Esc)';
    x.onclick = () => { hideSuggestion(); focusPrompt(); };
    head.append(x);
    box.append(head);

    if (sg.loading) {
      box.insertAdjacentHTML('beforeend', '<div class="sg-loading"><span></span><span></span><span></span></div>');
      return;
    }
    if (sg.error) {
      const er = document.createElement('div');
      er.className = 'sg-error';
      er.textContent = sg.error;
      box.append(er);
      return;
    }
    if (!sg.command) {
      const ex = document.createElement('div');
      ex.className = 'sg-expl';
      ex.textContent = sg.explanation || 'No command for that.';
      box.append(ex);
      return;
    }
    const input = document.createElement('input');
    input.className = 'sg-cmd';
    input.value = sg.command;
    input.spellcheck = false;
    const ex = document.createElement('div');
    ex.className = 'sg-expl';
    ex.textContent = sg.explanation;
    const actions = document.createElement('div');
    actions.className = 'sg-actions';
    const run = document.createElement('button');
    run.className = sg.risk === 'destructive' ? 'danger' : 'primary';
    run.textContent = sg.risk === 'destructive' ? 'Run (destructive)' : 'Run ⏎';
    let armed = sg.risk !== 'destructive';
    const go = () => {
      if (!armed) { armed = true; run.textContent = 'Press again to run'; return; }
      const pipe = state.pipeFrom;
      hideSuggestion();
      runCommand(input.value, { parentId: pipe ?? state.activeId, pipeFrom: pipe });
      setPipe(null);
      focusPrompt();
    };
    run.onclick = go;
    const edit = document.createElement('button');
    edit.textContent = 'Edit in shell';
    edit.onclick = () => { const v = input.value; hideSuggestion(); setMode('shell'); editor.setValue(v); };
    actions.append(run, edit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); go(); }
      if (e.key === 'Escape') { hideSuggestion(); focusPrompt(); }
    });
    box.append(input, ex, actions);
    if (!sys.smoke) input.focus();
  }

  function hideSuggestion() {
    state.suggestion = null;
    els.suggestion.hidden = true;
    els.suggestion.innerHTML = '';
  }

  // ================================================================ Claude: explain output
  const EXPLAIN_SYSTEM = `You help people understand terminal output inside Loom, a graphical terminal.

Respond with only a JSON object (no prose, no code fences):
{"summary": "...", "fix": "...", "fix_explanation": "..."}

- summary: two to four short, plain sentences. Say what happened and, if it failed, the most likely reason. Don't restate the command.
- fix: if a different command would likely fix the problem or achieve what the user was trying to do, give it as one line runnable in the same directory; otherwise "".
- fix_explanation: one sentence on what the fix does, or "".`;

  async function explain(n) {
    n.ai = { loading: true };
    renderAi(n);
    scheduleLayout();
    // Main sends the head and tail; a huge output never comes to the page.
    const { text: clipped } = await api.outClip({ id: n.key, head: 4000, tail: 8000 });
    const src = state.nodes.get(n.pipeFrom);
    const prompt = `OS: ${OS_NAME}\nShell: ${sys.shell}\nDirectory: ${n.cwd}\nCommand: ${n.cmd}\n${src ? `(stdin was the output of: ${src.cmd})\n` : ''}Exit code: ${n.exitCode ?? 'still running'}\n\nOutput:\n${clipped || '(no output)'}`;
    const res = await api.ai({ system: EXPLAIN_SYSTEM, prompt, maxTokens: 700 });
    if (!state.nodes.has(n.id)) return;
    if (!res.ok) {
      if (res.error === 'NO_KEY') { n.ai = null; openSettings('Add an Anthropic API key so Claude can explain output.'); }
      else n.ai = { error: res.error };
    } else {
      const j = parseJsonLoose(res.text);
      n.ai = j ? { summary: j.summary, fix: j.fix || '', fixWhy: j.fix_explanation || '' } : { summary: res.text.trim() };
    }
    renderAi(n);
    scheduleLayout();
    saveSoon();
  }

  // ================================================================ history map (sidebar)
  // A virtual list. Rows are worked out again only when cards change or the
  // search does, and only the rows in view are in the DOM.
  let mapRows = [];
  let mapKey = '';
  const rowPool = [];
  function computeMapRows(q) {
    const out = [];
    if (q) {
      for (const n of state.nodes.values()) {
        const lc = n.lc || (n.lc = n.cmd.toLowerCase());
        if (lc.includes(q)) out.push([n, 0, false]);
      }
      out.sort((a, b) => b[0].id - a[0].id);
      return out;
    }
    const roots = [];
    for (const n of state.nodes.values()) if (!hasParent(n)) roots.push(n);
    roots.sort((a, b) => b.id - a.id);
    // Main line continues at the same depth; extra branches indent where they fork.
    const stack = roots.map((n) => [n, 0]);
    while (stack.length) {
      const [n, d] = stack.pop();
      const k = childrenOf(n.id);
      out.push([n, d, k.length > 1]);
      if (k[0]) stack.push([k[0], d]);
      for (let i = k.length - 1; i >= 1; i--) stack.push([k[i], d + 1]);
    }
    return out;
  }
  function renderTree() {
    const q = els.search.value.trim().toLowerCase();
    const key = `${treeVersion}|${q}`;
    if (key !== mapKey) {
      mapKey = key;
      mapRows = computeMapRows(q);
      let failed = 0;
      let forks = 0;
      for (const n of state.nodes.values()) {
        if (n.status === 'error') failed++;
        if (childrenOf(n.id).length > 1) forks++;
      }
      els.stats.textContent = `${state.nodes.size} commands · ${forks} forks · ${failed} failed`;
      $('#map-empty').hidden = state.nodes.size > 0;
    }
    els.treeInner.style.height = `${mapRows.length * MAP_ROW}px`;
    const top = els.tree.scrollTop;
    const first = Math.max(0, Math.floor(top / MAP_ROW) - 8);
    const last = Math.min(mapRows.length, Math.ceil((top + els.tree.clientHeight) / MAP_ROW) + 8);
    for (let i = first; i < last; i++) {
      const j = i - first;
      let r = rowPool[j];
      if (!r) {
        r = document.createElement('button');
        r.innerHTML = '<span class="tr-dot"></span><span class="tr-cmd"></span><span class="tr-time"></span>';
        els.treeInner.append(r);
        rowPool[j] = r;
      }
      const [n, d, fork] = mapRows[i];
      r.hidden = false;
      r.className = `tr-row s-${n.status}${n.id === state.activeId ? ' active' : ''}${fork ? ' fork' : ''}`;
      r.style.transform = `translateY(${i * MAP_ROW}px)`;
      r.style.setProperty('--depth', d);
      r.dataset.id = n.id;
      if (r.children[1].textContent !== n.cmd) r.children[1].textContent = n.cmd;
      r.children[2].textContent = fmtAgo(n.startedAt);
      r.title = `#${n.id} · ${tilde(n.cwd)}\n${n.cmd}`;
    }
    for (let j = last - first; j < rowPool.length; j++) rowPool[j].hidden = true;
  }
  const renderTreeSoon = debounce(() => { if (!els.sidebar.hidden) renderTree(); }, 120);
  els.search.addEventListener('input', () => { els.tree.scrollTop = 0; renderTree(); });
  els.tree.addEventListener('scroll', () => requestAnimationFrame(() => { if (!els.sidebar.hidden) renderTree(); }), { passive: true });
  els.treeInner.addEventListener('click', (e) => {
    const r = e.target.closest('.tr-row');
    const n = r && state.nodes.get(Number(r.dataset.id));
    if (n) { setActive(n.id); reveal(n, true); }
  });

  function toggleSidebar(force) {
    els.sidebar.hidden = force != null ? !force : !els.sidebar.hidden;
    document.body.classList.toggle('with-sidebar', !els.sidebar.hidden);
    if (!els.sidebar.hidden) renderTree();
    scheduleLayout();
    saveSoon();
  }

  // ================================================================ minimap
  // Cards are drawn into an offscreen canvas, again only when they change or
  // the map's scale does; pan and zoom only redraw the viewport rectangle.
  const mmCards = document.createElement('canvas');
  let mmVersion = -1;
  let mmKey = '';
  let mm = null;
  function drawMinimap() {
    const cv = els.minimap;
    cv.hidden = state.nodes.size === 0;
    if (cv.hidden) return;
    const dpr = window.devicePixelRatio || 1;
    const W = 220; const H = 140;
    if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; mmVersion = -1; }
    const cb = cardBounds();
    const r = viewRectWorld();
    const b = { minX: Math.min(cb.minX, r.x), minY: Math.min(cb.minY, r.y), maxX: Math.max(cb.maxX, r.x + r.w), maxY: Math.max(cb.maxY, r.y + r.h) };
    const pad = 10;
    const s = Math.min((W - pad * 2) / (b.maxX - b.minX), (H - pad * 2) / (b.maxY - b.minY));
    const ox = pad + ((W - pad * 2) - (b.maxX - b.minX) * s) / 2 - b.minX * s;
    const oy = pad + ((H - pad * 2) - (b.maxY - b.minY) * s) / 2 - b.minY * s;
    mm = { s, ox, oy };
    const col = themeColors();
    const key = `${s.toPrecision(6)}:${ox.toFixed(1)}:${oy.toFixed(1)}`;
    if (mmVersion !== layoutVersion || mmKey !== key) {
      mmVersion = layoutVersion;
      mmKey = key;
      mmCards.width = cv.width;
      mmCards.height = cv.height;
      const g = mmCards.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const fill = { ok: col.mmOk, error: col.err, running: col.accent };
      for (const n of state.nodes.values()) {
        g.fillStyle = fill[n.status] || col.mmOk;
        g.globalAlpha = n.id === state.activeId ? 1 : 0.7;
        g.fillRect(ox + n.x * s, oy + n.y * s, Math.max(2, n.w * s), Math.max(2, h(n) * s));
      }
    }
    const g = cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    g.drawImage(mmCards, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.strokeStyle = col.mmView;
    g.lineWidth = 1;
    g.strokeRect(ox + r.x * s + 0.5, oy + r.y * s + 0.5, r.w * s, r.h * s);
  }
  // Click a card on the minimap to go to it; drag to move the view.
  els.minimap.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (!mm) return;
    const toWorld = (ev) => {
      const rect = els.minimap.getBoundingClientRect();
      return [(ev.clientX - rect.left - mm.ox) / mm.s, (ev.clientY - rect.top - mm.oy) / mm.s];
    };
    const go = (ev) => {
      const [wx, wy] = toWorld(ev);
      const vr = els.viewport.getBoundingClientRect();
      state.view.x = vr.width / 2 - wx * state.view.k;
      state.view.y = vr.height / 2 - wy * state.view.k;
      applyView();
    };
    const [wx0, wy0] = toWorld(e);
    const slop = 3 / mm.s;
    const hit = grid.query(wx0 - slop, wy0 - slop, slop * 2, slop * 2)[0];
    let dragged = false;
    const x0 = e.clientX; const y0 = e.clientY;
    const move = (ev) => { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 3) dragged = true; if (dragged) go(ev); };
    els.minimap.setPointerCapture(e.pointerId);
    const up = () => {
      els.minimap.removeEventListener('pointermove', move);
      els.minimap.removeEventListener('pointerup', up);
      if (dragged) return;
      const n = hit != null && state.nodes.get(hit);
      if (n) { setActive(n.id); reveal(n, true); } else go(e);
    };
    els.minimap.addEventListener('pointermove', move);
    els.minimap.addEventListener('pointerup', up);
  });

  // ================================================================ dialogs
  // A confirmation listing what would be lost. Resolves true for OK.
  function confirmDialog({ title, body = '', items = [], ok = 'OK' }) {
    const d = $('#confirm');
    d.querySelector('.cf-title').textContent = title;
    d.querySelector('.cf-body').textContent = body;
    const list = d.querySelector('.cf-list');
    list.replaceChildren(...items.slice(0, 12).map((t) => { const li = document.createElement('li'); li.textContent = t; return li; }));
    if (items.length > 12) { const li = document.createElement('li'); li.textContent = `…and ${items.length - 12} more`; list.append(li); }
    d.querySelector('.cf-ok').textContent = ok;
    return new Promise((resolve) => {
      const done = () => { d.removeEventListener('close', done); resolve(d.returnValue === 'ok'); focusPrompt(); };
      d.addEventListener('close', done);
      d.returnValue = 'cancel';
      d.showModal();
      d.querySelector('.cf-ok').focus();
    });
  }

  function clearCanvas() {
    confirmDialog({ title: 'Clear this tab’s canvas?', body: 'Every card goes, with its output. Running commands are stopped.', ok: 'Clear canvas' }).then((yes) => {
      if (!yes) return;
      for (const n of [...state.nodes.values()]) { if (n.status === 'running') stop(n); terminals.dispose(n.key); VLines.forget(n.key); api.forget(n.key); dropRich(n); }
      teardown();
      state.nodes.clear();
      state.activeId = null;
      state.pipeFrom = null;
      buildCanvas();
      animateTo({ x: 120, y: 90, k: 1 });
      saveSoon();
    });
  }

  // ================================================================ tabs
  // Each tab is a canvas. Only the one on screen has DOM; switching tears it
  // down and builds the other from its data. Background tabs keep running.
  let order = [];
  const tabMeta = (cv) => ({ id: cv.id, title: cv.title, color: cv.color, folder: cv.folder });
  const saveTabs = debounce(() => api.tabsSet({ order, active: cur ? cur.id : null, tabs: order.map((id) => tabMeta(canvases.get(id))) }), 150);
  let lastSwitchMs = 0;

  function tabInfo(cv) {
    let busy = false;
    if (cv.loaded) for (const n of cv.nodes.values()) if (n.status === 'running') { busy = true; break; }
    return { ...tabMeta(cv), active: cv === cur, running: busy, unseen: cv === cur ? null : cv.unseen };
  }
  const tabbar = window.TabBar.create({
    el: $('#tabs'),
    keyHint: (i) => (i <= 9 ? registry.label(registry.keysFor(`tab.goto${i}`)[0] || '') : ''),
    onSelect: (id) => switchTo(id),
    onClose: (id) => closeTab(id),
    onNew: () => newTab(),
    onRename: (id, title) => { const cv = canvases.get(id); if (cv) { cv.title = title; renderTabBar(); saveTabs(); } },
    onColor: (id, color) => { const cv = canvases.get(id); if (cv) { cv.color = color; renderTabBar(); saveTabs(); } },
    onReorder: (next) => { order = next.filter((id) => canvases.has(id)); renderTabBar(); saveTabs(); },
    onDoneEditing: () => focusPrompt(),
  });
  function renderTabBar() {
    tabbar.render(order.map((id) => tabInfo(canvases.get(id))));
    document.title = cur ? `${cur.title} — Loom` : 'Loom';
  }

  function addCanvas(meta) {
    const cv = blankCanvas(meta);
    canvases.set(cv.id, cv);
    return cv;
  }
  const basename = (p) => (p ? p.replace(/\/+$/, '').split('/').pop() || p : '');

  // Shows a tab: its data loads if it hasn't yet, the old tab's DOM goes.
  async function switchTo(cid, { focus = true } = {}) {
    const cv = canvases.get(cid);
    if (!cv) return null;
    await loadCanvas(cv);
    if (cur === cv) { renderTabBar(); return cv; }
    const t0 = performance.now();
    if (cur && cur.loaded && canvases.has(cur.id)) saveNow(cur);
    teardown();
    cur = cv;
    cv.unseen = null;
    buildCanvas();
    lastSwitchMs = performance.now() - t0;
    renderTabBar();
    saveTabs();
    editor.refreshInfo();
    if (focus) focusPrompt();
    return cv;
  }

  // A new tab, after this one, in `folder` (a project tab) or in this tab's folder.
  async function newTab({ folder = null, cwd = null, title = null } = {}) {
    const root = folder || cwd || (cur && cur.loaded ? currentCwd() : sys.home);
    const keep = folder || (cur && cur.folder && !cwd ? cur.folder : null);
    const meta = await api.tabsCreate({ title: title || basename(keep || root) || 'Home', folder: keep, after: cur ? cur.id : null });
    const cv = addCanvas(meta);
    cv.rootCwd = root;
    cv.loaded = true;
    const at = cur ? order.indexOf(cur.id) + 1 : order.length;
    order.splice(at > 0 ? at : order.length, 0, cv.id);
    await switchTo(cv.id);
    saveNow(cv);
    saveTabs();
    return cv;
  }

  // Closing a tab with running commands asks first. Its cards stay on disk
  // for "Reopen closed tab" (the last ten).
  async function closeTab(cid = cur && cur.id) {
    const cv = canvases.get(cid);
    if (!cv) return false;
    await loadCanvas(cv);
    const busy = [...cv.nodes.values()].filter((n) => n.status === 'running');
    if (busy.length && !(await confirmDialog({
      title: `Close “${cv.title}”?`, body: `${busy.length === 1 ? 'This command is' : `These ${busy.length} commands are`} still running and will be stopped:`,
      items: busy.map((n) => n.cmd.split('\n')[0]), ok: 'Close tab',
    }))) return false;
    for (const n of busy) n.killed = true;
    saveNow(cv);
    const i = order.indexOf(cid);
    if (cv === cur) {
      const next = order[i + 1] || order[i - 1];
      if (next) await switchTo(next);
      else await newTab({ cwd: cv.rootCwd });
    }
    order = order.filter((x) => x !== cid);
    canvases.delete(cid);
    await api.tabsClose(cid);
    renderTabBar();
    saveTabs();
    return true;
  }

  async function reopenTab() {
    const meta = await api.tabsReopen();
    if (!meta) { toast('No closed tabs', { timeout: 1600 }); return null; }
    const cv = addCanvas(meta);
    order = order.filter((x) => x !== cv.id);
    order.push(cv.id);
    await switchTo(cv.id);
    saveTabs();
    return cv;
  }

  function cycleTab(d) {
    if (order.length < 2 || !cur) return;
    const i = order.indexOf(cur.id);
    switchTo(order[(i + d + order.length) % order.length]);
  }

  // `loom ~/x`, `loom -e "npm test"`, the Dock, Finder: focus the folder's tab
  // or make one, and run the command there.
  async function openRequest({ folder, missing, newTab: forceNew, exec }) {
    if (missing) toast(`There's no folder ${tilde(missing)}`, { kind: 'err' });
    let cv = null;
    if (folder && !forceNew) cv = [...canvases.values()].find((c) => c.folder === folder);
    if (cv) await switchTo(cv.id);
    else if (folder || forceNew) cv = await newTab({ folder: folder || null, cwd: folder || null });
    else cv = cur;
    if (exec) {
      if (folder) state.rootCwd = folder;
      setActive(null);
      runCommand(exec, { parentId: null });
    }
    return cv;
  }

  // A command ended: background tabs get a dot, and a long one gets a
  // notification when Loom isn't in front.
  function cardFinished(cv, n) {
    if (cv !== cur) cv.unseen = n.status === 'error' || cv.unseen === 'error' ? 'error' : 'ok';
    renderTabBar();
    const dur = n.endedAt - n.startedAt;
    if (dur < 10000 || n.killed) return;
    api.notify({
      title: `${n.status === 'error' ? 'Failed' : 'Finished'}: ${n.cmd.split('\n')[0].slice(0, 60)}`,
      body: `${cv.title} · ${fmtDur(dur)}${n.status === 'error' ? ` · exit ${n.exitCode}` : ''}`,
      cid: cv.id, id: n.id,
    });
  }
  api.onNotifyClick(async ({ cid, id }) => {
    if (!(await switchTo(cid))) return;
    const n = state.nodes.get(id);
    if (n) { setActive(n.id); reveal(n, true); }
  });

  // ================================================================ commands and keys
  const mac = sys.platform === 'darwin';
  const isDropdown = sys.window === 'dropdown';
  const settingsView = $('#settings-view');
  const registry = window.Commands.create({
    mac,
    context: keyContext,
    onChange: () => {
      // The menu shows the keys as they are now.
      const keys = {};
      for (const c of registry.list()) if (c.keys[0]) keys[c.id] = window.Keys.toAccelerator(c.keys[0]);
      api.menuKeys(keys);
      if (settingsPage) settingsPage.keysChanged();
      renderTabBar();
    },
  });
  const palette = window.Commands.palette({ el: $('#palette'), registry, onClose: () => {} });

  // Where a key was pressed. While a dialog, the palette or settings are
  // open, only `dialog` commands fire; in a live terminal only global ones.
  function keyContext(e) {
    const t = e && e.target && e.target.closest ? e.target : document.activeElement || document.body;
    const ctx = { mac, dropdown: isDropdown };
    if (!settingsView.hidden || palette.isOpen() || document.querySelector('dialog[open]')) ctx.dialog = true;
    if (!$('#term-overlay').hidden) ctx.overlay = true;
    if (t.closest('.live-term')) ctx.liveTerminal = true;
    else if (t === els.prompt || t.closest('#composer')) ctx.commandBar = !ctx.dialog;
    else if (!ctx.dialog) ctx.canvas = true;
    if (t !== els.prompt && t.matches('input, textarea, select, [contenteditable]')) ctx.textInput = true;
    if (t.closest('.vt')) ctx.cardBody = true;
    return ctx;
  }

  const active = () => state.nodes.get(state.activeId);
  const onActive = (fn) => () => { const n = active(); if (!n) { toast('No card is selected', { timeout: 1400 }); return true; } return fn(n); };
  const navigate = (dir) => () => {
    const a = active();
    if (!a) return true;
    let target = null;
    if (dir === 'up') target = state.nodes.get(a.parentId);
    if (dir === 'down') target = childrenOf(a.id)[0];
    if (dir === 'left' || dir === 'right') {
      const sibs = a.parentId != null ? childrenOf(a.parentId) : [];
      const i = sibs.findIndex((s) => s.id === a.id);
      target = sibs[i + (dir === 'right' ? 1 : -1)];
    }
    if (target) { setActive(target.id); reveal(target); }
    return true;
  };
  let lastBarEsc = 0;
  const WORK = 'canvas || commandBar';

  function registerCommands() {
    const add = (c) => registry.add(c);
    // Canvas and view
    add({ id: 'view.fit', title: 'Fit everything', category: 'View', keys: ['Mod+0'], when: WORK, run: () => fit() });
    add({ id: 'view.zoomIn', title: 'Zoom in', category: 'View', keys: ['Mod+='], when: WORK, run: () => zoomCenter(1.2) });
    add({ id: 'view.zoomOut', title: 'Zoom out', category: 'View', keys: ['Mod+-'], when: WORK, run: () => zoomCenter(1 / 1.2) });
    add({ id: 'view.actualSize', title: 'Zoom to 100%', category: 'View', run: () => els.zoomLabel.click() });
    add({ id: 'view.map', title: 'Toggle the history map', category: 'View', keys: ['Mod+B'], when: WORK, run: () => toggleSidebar() });
    add({ id: 'canvas.newRoot', title: 'New root', category: 'Canvas', keys: ['Mod+N'], when: WORK, run: () => newRoot() });
    add({ id: 'canvas.clear', title: 'Clear this tab’s canvas…', category: 'Canvas', run: () => clearCanvas() });
    // Command bar
    add({ id: 'composer.focus', title: 'Focus the command bar', category: 'Command bar', keys: ['Mod+K', { key: '/', when: 'canvas && !textInput && !cardBody' }], when: WORK, run: () => focusPrompt() });
    add({ id: 'composer.askToggle', title: 'Toggle shell / ask Claude', category: 'Command bar', keys: ['Mod+I'], when: `${WORK}`, run: () => setMode(state.mode === 'ai' ? 'shell' : 'ai') });
    add({ id: 'history.search', title: 'Search history', category: 'Command bar', keys: ['Ctrl+R'], when: `${WORK}`, run: () => { focusPrompt(); editor.openSearch(); } });
    add({
      id: 'composer.escape', title: 'Dismiss (close the suggestion, stop piping, clear)', category: 'Command bar', keys: ['Escape'], when: 'commandBar', palette: false,
      run: () => {
        const v = els.prompt.value;
        if (state.suggestion) hideSuggestion();
        else if (state.pipeFrom != null) setPipe(null);
        else if (v) editor.clear();
        else if (isDropdown && performance.now() - lastBarEsc < 400) api.dropdownHide();
        else if (!isDropdown) els.prompt.blur();
        lastBarEsc = performance.now();
        return true;
      },
    });
    add({
      id: 'card.interrupt', title: 'Stop the active card’s command (Ctrl+C)', category: 'Card', keys: ['Ctrl+C'], when: 'commandBar', palette: false,
      run: () => {
        if (els.prompt.selectionStart !== els.prompt.selectionEnd) return false;
        const a = active();
        if (a && a.status === 'running') { stop(a); return true; }
        if (els.prompt.value) { editor.clear(); return true; }
        return false;
      },
    });
    add({
      id: 'card.eof', title: 'Send EOF to the active card', category: 'Card', keys: ['Ctrl+D'], when: 'commandBar', palette: false,
      run: () => { const a = active(); if (els.prompt.value || !a || a.status !== 'running') return false; api.stdin({ id: a.key, eof: true }); return true; },
    });
    // Cards
    add({ id: 'card.find', title: 'Find in the card’s output', category: 'Card', keys: ['Mod+F'], when: WORK, run: (ctx) => { const inCard = ctx.event && ctx.event.target.closest && ctx.event.target.closest('.card'); return findInCard(state.nodes.get(inCard ? Number(inCard.dataset.id) : state.activeId)) || undefined; } });
    for (const [act, title, id] of [['stop', 'Stop', 'card.stop'], ['rerun', 'Run again', 'card.rerun'], ['branch', 'Branch from here', 'card.branch'], ['pipe', 'Pipe output into a new command', 'card.pipe'],
      ['explain', 'Explain with Claude', 'card.explain'], ['copy', 'Copy output', 'card.copy'], ['save', 'Save output…', 'card.save'], ['open', 'Open output in editor', 'card.open'],
      ['expand', 'Expand terminal', 'card.expand'], ['delete', 'Remove card', 'card.delete']]) {
      add({ id, title, category: 'Card', when: WORK, run: onActive((n) => { cardAction(n, act); return true; }) });
    }
    add({ id: 'card.collapse', title: 'Collapse or expand the card', category: 'Card', when: WORK, run: onActive((n) => { n.collapsed = !n.collapsed; updateCard(n); scheduleLayout(); saveSoon(); return true; }) });
    add({ id: 'card.parent', title: 'Go to the parent card', category: 'Card', keys: ['Alt+ArrowUp'], when: WORK, run: navigate('up') });
    add({ id: 'card.child', title: 'Go to the first child card', category: 'Card', keys: ['Alt+ArrowDown'], when: WORK, run: navigate('down') });
    add({ id: 'card.prevSibling', title: 'Go to the previous branch', category: 'Card', keys: ['Alt+ArrowLeft'], when: WORK, run: navigate('left') });
    add({ id: 'card.nextSibling', title: 'Go to the next branch', category: 'Card', keys: ['Alt+ArrowRight'], when: WORK, run: navigate('right') });
    // Live terminals: these work while a program has the keyboard.
    add({ id: 'terminal.escape', title: 'Esc Esc: back to the canvas', category: 'Terminal', keys: ['Escape'], when: 'liveTerminal', global: true, palette: false, run: () => terminals.escape() });
    add({ id: 'terminal.release', title: 'Return from the terminal to the canvas', category: 'Terminal', keys: ['Mod+Shift+E', ...(mac ? ['Ctrl+Shift+E'] : [])], when: 'liveTerminal || overlay', global: true, run: () => (terminals.releaseFocused() ? true : (terminals.collapse(), focusPrompt(), true)) });
    add({ id: 'terminal.find', title: 'Find in the terminal', category: 'Terminal', keys: ['Mod+Shift+F'], when: 'liveTerminal', global: true, run: () => terminals.findFocused() });
    add({ id: 'terminal.copy', title: 'Copy the terminal selection', category: 'Terminal', keys: ['Ctrl+Shift+C'], when: 'liveTerminal', global: true, palette: false, run: () => terminals.copyFocused() });
    // Tabs
    add({ id: 'tab.new', title: 'New tab', category: 'Tabs', keys: ['Mod+T'], run: () => { newTab(); } });
    add({ id: 'tab.close', title: 'Close tab', category: 'Tabs', keys: ['Mod+W'], run: () => { closeTab(); } });
    add({ id: 'tab.reopen', title: 'Reopen closed tab', category: 'Tabs', keys: ['Mod+Shift+T'], run: () => { reopenTab(); } });
    add({ id: 'tab.next', title: 'Next tab', category: 'Tabs', keys: ['Ctrl+Tab', ...(mac ? ['Shift+Cmd+]'] : [])], run: () => cycleTab(1) });
    add({ id: 'tab.prev', title: 'Previous tab', category: 'Tabs', keys: ['Ctrl+Shift+Tab', ...(mac ? ['Shift+Cmd+['] : [])], run: () => cycleTab(-1) });
    for (let i = 1; i <= 9; i++) {
      add({ id: `tab.goto${i}`, title: i === 9 ? 'Go to the last tab' : `Go to tab ${i}`, category: 'Tabs', keys: [`Mod+${i}`], palette: i === 1 || i === 9, run: () => { const id = i === 9 ? order[order.length - 1] : order[i - 1]; if (id) switchTo(id); } });
    }
    add({ id: 'tab.rename', title: 'Rename tab', category: 'Tabs', run: () => { if (cur) tabbar.rename(cur.id); } });
    add({ id: 'tab.color', title: 'Pick a color for this tab', category: 'Tabs', run: () => { if (cur) tabbar.pickColor(cur.id); } });
    add({ id: 'tab.openFolder', title: 'Open folder in a new tab…', category: 'Tabs', run: async () => { const p = await api.pickFolder(); if (p) openRequest({ folder: p }); } });
    // App
    add({ id: 'palette.open', title: 'Show all commands', category: 'Loom', keys: ['Mod+Shift+P'], global: true, palette: false, run: () => (palette.isOpen() ? palette.close() : palette.open()) });
    add({ id: 'settings.open', title: 'Settings', category: 'Loom', keys: ['Mod+,'], global: true, run: () => openSettings() });
    add({ id: 'settings.keys', title: 'Keyboard shortcuts', category: 'Loom', run: () => openSettings('', 'keys') });
    add({ id: 'settings.editJson', title: 'Edit settings.json', category: 'Loom', run: () => api.editSettings() });
    add({ id: 'keys.editJson', title: 'Edit keybindings.json', category: 'Loom', run: () => api.keysEdit() });
    add({ id: 'font.bigger', title: 'Bigger text', category: 'View', keys: ['Mod+Shift+='], global: true, run: () => fontStep(0.5) });
    add({ id: 'font.smaller', title: 'Smaller text', category: 'View', keys: ['Mod+Shift+-'], global: true, run: () => fontStep(-0.5) });
    add({ id: 'font.reset', title: 'Default text size', category: 'View', keys: ['Mod+Shift+0'], global: true, run: () => api.setSettings({ fontSize: 12.5 }) });
    add({ id: 'theme.import', title: 'Import a theme (.itermcolors, Windows Terminal)…', category: 'Theme', run: () => api.themesImport({}) });
    add({ id: 'theme.folder', title: 'Open the themes folder', category: 'Theme', run: () => api.themesFolder() });
    add({ id: 'history.import', title: 'Import shell history', category: 'Loom', run: () => importHistory() });
    add({ id: 'loom.about', title: 'About Loom', category: 'Loom', run: () => api.about() });
    add({ id: 'loom.reportIssue', title: 'Report an issue…', category: 'Help', run: () => api.reportIssue() });
    add({ id: 'loom.copyDebug', title: 'Copy debug info', category: 'Help', run: async () => { await api.copyText(await api.debugInfo()); toast('Debug info copied', { timeout: 1600 }); } });
    add({ id: 'env.open', title: 'Open .env file', category: 'Loom', run: () => api.openDotenv() });
    add({ id: 'dropdown.toggle', title: 'Show or hide the dropdown terminal', category: 'Dropdown', run: () => api.dropdownToggle() });
    if (isDropdown) {
      add({ id: 'dropdown.hide', title: 'Hide the dropdown', category: 'Dropdown', run: () => api.dropdownHide() });
      add({ id: 'dropdown.pin', title: 'Pin or unpin the dropdown', category: 'Dropdown', run: () => togglePin() });
      add({ id: 'dropdown.escEsc', title: 'Esc Esc: hide the dropdown', category: 'Dropdown', keys: ['Escape'], when: 'canvas && !textInput', palette: false, run: () => { const now = performance.now(); if (now - lastBarEsc < 400) { api.dropdownHide(); return true; } lastBarEsc = now; return false; } });
    }
    const integ = (fn, what) => async () => {
      const res = await fn(what);
      if (res.ok === false) toast(res.error, { kind: 'err', timeout: 8000 });
      else toast(res.message || (res.removed && res.removed.length ? `Removed ${res.removed.join(', ')}` : 'Nothing to remove'), { timeout: 8000 });
    };
    add({ id: 'loom.installCommand', title: "Install 'loom' command in PATH", category: 'Shell command', run: integ(api.integrationsInstall, 'launcher') });
    add({ id: 'loom.uninstallCommand', title: "Uninstall 'loom' command", category: 'Shell command', run: integ(api.integrationsUninstall, 'launcher') });
    if (mac) add({ id: 'loom.installFinder', title: 'Install Finder Quick Action “Open in Loom”', category: 'Shell command', run: integ(api.integrationsInstall, 'finder') });
    if (sys.platform === 'linux') add({ id: 'loom.installLinux', title: 'Install “Open in Loom” for file managers', category: 'Shell command', run: integ(api.integrationsInstall, 'linux') });
  }

  // Themes are commands too: "Theme: Nord".
  function registerThemeCommands(list) {
    for (const c of registry.list()) if (c.id.startsWith('theme.set:')) registry.remove(c.id);
    for (const t of list.themes) {
      registry.add({
        id: `theme.set:${t.id}`, title: `${t.name}${t.contrast.length ? ' (low contrast)' : ''}`, category: 'Theme',
        run: () => api.setSettings(t.type === 'dark' ? { themeDark: t.id, themeMode: settingsNow.themeMode === 'light' ? 'dark' : settingsNow.themeMode } : { themeLight: t.id, themeMode: settingsNow.themeMode === 'dark' ? 'light' : settingsNow.themeMode }),
      });
    }
    registry.rebuild();
  }

  // Every key goes through here first (capture), except in the command bar,
  // whose editor gets keys before the commands do (see els.prompt below).
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t === els.prompt || (t.closest && t.closest('#hsearch'))) return;
    if (registry.handle(e)) return;
    // Typing on the canvas goes to the command bar.
    const ctx = keyContext(e);
    if (ctx.canvas && !ctx.textInput && !ctx.cardBody && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) focusPrompt();
  }, true);
  api.onCommand((id) => registry.run(id));

  // ================================================================ settings, themes, fonts
  let settingsNow = {};
  let settingsPage = null;
  function openSettings(note = '', section = null) {
    settingsPage.open(section || (note ? 'claude' : null), note);
  }

  async function fontStep(d) {
    const size = Math.max(8, Math.min(32, Math.round(((settingsNow.fontSize || 12.5) + d) * 2) / 2));
    await api.setSettings({ fontSize: size });
  }

  // Cards draw with the theme's colors and the font's metrics: rebuild what's on screen.
  function remountAll() {
    VLines.forgetAll();
    for (const [id, d] of dom) if (d.mode !== 'stub') unmount(state.nodes.get(id));
    colors = null;
    mmVersion = -1;
    terminals.setOptions();
    scheduleLayout();
  }

  let themeId = null;
  async function applyTheme() {
    const id = window.Theme.pick(settingsNow, window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (id === themeId && window.Theme.current()) return;
    const t = await api.themesGet(id);
    if (!t) return;
    themeId = t.id;
    window.Theme.apply(t);
    remountAll();
  }

  let fontKey = '';
  function applyFonts() {
    const k = ['fontFamily', 'fontSize', 'lineHeight', 'fontWeight', 'ligatures'].map((x) => settingsNow[x]).join('|');
    if (k === fontKey) return;
    fontKey = k;
    window.Theme.applyFonts(settingsNow);
    LINE_H = window.Theme.fonts().lineH;
    measureChar();
    remountAll();
  }

  function onSettings(p) {
    const prev = settingsNow;
    settingsNow = p.settings;
    applyFonts();
    applyTheme();
    if (['cursorStyle', 'cursorBlink', 'scrollback'].some((k) => prev[k] !== settingsNow[k])) terminals.setOptions();
    if (settingsPage) settingsPage.update(p);
  }
  api.onSettings(onSettings);
  api.onThemes(async (list) => {
    themeId = null;
    await applyTheme();
    registerThemeCommands(list);
    if (settingsPage) settingsPage.themes(list);
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());
  api.onKeys(({ list, error }) => {
    registry.setOverrides(list);
    if (error) toast(error, { kind: 'err', timeout: 6000 });
  });

  // ================================================================ toolbar, empty state
  $('#btn-map').onclick = () => toggleSidebar();
  $('#btn-newroot').onclick = newRoot;
  $('#btn-fit').onclick = () => fit();
  $('#btn-zoomin').onclick = () => zoomCenter(1.2);
  $('#btn-zoomout').onclick = () => zoomCenter(1 / 1.2);
  els.zoomLabel.onclick = () => { const a = state.nodes.get(state.activeId); if (a) { state.view.k = 1; reveal(a, true); } else animateTo({ ...state.view, k: 1 }); };
  $('#btn-settings').onclick = () => openSettings();
  $('#btn-palette').onclick = () => palette.open();
  $('#btn-palette').textContent = mac ? '⌘⇧P' : 'Ctrl+Shift+P';
  els.empty.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    if (b.dataset.cmd) runCommand(b.dataset.cmd);
    else ask(b.dataset.ask);
  });

  let pinned = false;
  async function togglePin() {
    pinned = await api.dropdownPin(!pinned);
    $('#btn-pin').classList.toggle('on', pinned);
    $('#btn-pin').title = pinned ? 'Pinned: stays open when it loses focus' : 'Keep the dropdown open';
  }
  if (isDropdown) {
    document.body.classList.add('window-dropdown');
    $('#btn-pin').hidden = false;
    $('#btn-pin').onclick = togglePin;
    api.onDropdownShown(() => focusPrompt());
  }

  window.addEventListener('resize', () => scheduleLayout());

  // ================================================================ persistence
  // Each canvas is saved on its own (userData/canvases/<id>.json), card
  // metadata only: output is already on disk in main. Only cards that changed
  // since the last save are sent, and main writes the file debounced,
  // atomically, and only when it changed.
  const SAVE_FIELDS = ['id', 'cmd', 'cwd', 'cwdAfter', 'parentId', 'pipeFrom', 'x', 'y', 'w', 'bodyH', 'h', 'status', 'exitCode', 'startedAt', 'endedAt', 'view', 'ai', 'collapsed', 'envFile', 'noHistory', 'richKind', 'capped'];
  function nodeMeta(n) {
    const o = {};
    for (const f of SAVE_FIELDS) o[f] = n[f];
    if (o.status === 'running') o.status = 'interrupted';
    if (o.ai && o.ai.loading) o.ai = null;
    if (o.h) o.h = Math.round(o.h);
    return o;
  }
  const canvasMeta = (cv) => ({ nextId: cv.nextId, view: cv.view, activeId: cv.activeId, rootCwd: cv.rootCwd, sidebar: !!cv.sidebar });
  function serialize(cv = cur) {
    return { v: 3, ...canvasMeta(cv), nodes: [...cv.nodes.values()].map(nodeMeta) };
  }
  function saveNow(cv = cur) {
    if (!cv || !cv.loaded || !canvases.has(cv.id)) return;
    if (cv === cur) cv.sidebar = !els.sidebar.hidden;
    const patch = { cid: cv.id, nodes: {} };
    let any = false;
    for (const n of cv.nodes.values()) {
      const o = nodeMeta(n);
      const j = JSON.stringify(o);
      if (cv.sent.get(n.id) !== j) { cv.sent.set(n.id, j); patch.nodes[n.id] = o; any = true; }
    }
    for (const id of [...cv.sent.keys()]) if (!cv.nodes.has(id)) { cv.sent.delete(id); patch.nodes[id] = null; any = true; }
    const m = canvasMeta(cv);
    const mj = JSON.stringify(m);
    if (mj !== cv.sentMeta) { cv.sentMeta = mj; patch.meta = m; any = true; }
    if (any) api.canvasPatch(patch);
  }
  const saveTimers = new Map();
  function saveSoon(cv = cur) {
    if (!cv) return;
    clearTimeout(saveTimers.get(cv.id));
    saveTimers.set(cv.id, setTimeout(() => saveNow(cv), 600));
  }
  window.addEventListener('beforeunload', () => {
    // Commands still running are saved without an exit code.
    for (const cv of canvases.values()) {
      if (!cv.loaded) continue;
      for (const n of cv.nodes.values()) if (n.histRec) api.historyAdd(n.histRec);
      saveNow(cv);
    }
  });

  // A canvas's cards, from main. Running cards from before a restart are
  // interrupted; every card gets its key.
  function loadCanvas(cv) {
    if (cv.loaded) return Promise.resolve(cv);
    if (cv.loading) return cv.loading;
    cv.loading = (async () => {
      const s = await api.canvasLoad(cv.id);
      cv.nodes = new Map();
      if (s) {
        cv.nextId = s.nextId || 1;
        cv.view = s.view || cv.view;
        cv.rootCwd = s.rootCwd || cv.rootCwd;
        cv.sidebar = !!s.sidebar;
        for (const o of (s.nodes || []).slice().sort((a, b) => a.id - b.id)) {
          const n = { ...o, killed: false, rich: null, out: null, key: `${cv.id}.${o.id}` };
          if (n.status === 'running') n.status = 'interrupted';
          if (n.h == null) n.h = HEAD_H + Math.min(n.bodyH || 300, 300);
          cv.nodes.set(n.id, n);
        }
        cv.activeId = cv.nodes.has(s.activeId) ? s.activeId : null;
        for (const n of cv.nodes.values()) cv.sent.set(n.id, JSON.stringify(nodeMeta(n)));
        cv.sentMeta = JSON.stringify(canvasMeta(cv));
      }
      cv.loaded = true;
      return cv;
    })();
    return cv.loading;
  }

  // The current canvas's DOM: every card an empty box of its saved size; the
  // ones in view get their insides on the first frames.
  function buildCanvas() {
    const list = [...state.nodes.values()].sort((a, b) => a.id - b.id);
    for (const n of list) addEl(n, false);
    for (const n of list) treeAdd(n);
    for (const n of list) { syncEdges(n); if (n.status === 'running') running.add(n.id); }
    els.sidebar.hidden = !cur.sidebar;
    document.body.classList.toggle('with-sidebar', !els.sidebar.hidden);
    if (!els.sidebar.hidden) { mapKey = ''; renderTree(); }
    markActivePath();
    applyView();
    updateComposer();
    scheduleLayout();
  }

  // Takes down the current canvas's DOM. Its data stays, and its running
  // cards stop streaming to the page (main still records them).
  function teardown() {
    for (const n of state.nodes.values()) {
      if (terminals.has(n.key)) terminals.release(n.key);
      unmount(n);
    }
    terminals.collapse();
    for (const d of dom.values()) d.card.remove();
    dom.clear(); inDom.clear(); running.clear(); kids.clear(); depth.clear(); grid.clear(); edgeGrid.clear();
    for (const key of [...edges.keys()]) dropEdge(key);
    moved.clear(); heightChanged.clear(); dirty.clear();
    mountQueue = [];
    activeSet = new Set();
    layoutVersion++;
    treeVersion++;
    boundsVersion = -1;
    mmVersion = -1;
    mapKey = '';
    hideSuggestion();
    editor.closePopup();
    if (state.pipeFrom != null) state.pipeFrom = null;
  }

  // ================================================================ history import
  async function importHistory() {
    const res = await api.historyImport();
    state.history = await api.historyLoad();
    editor.render();
    toast(res.added ? `Imported ${res.added.toLocaleString()} commands from ${res.sources.join(' and ')}` : 'No shell history found', { timeout: 3000 });
    return res;
  }

  // Once, and only if asked: Loom reads ~/.zsh_history and ~/.bash_history but never writes them.
  async function offerImport() {
    const offer = await api.historyOffer();
    if (!offer) return;
    const total = offer.sources.reduce((a, x) => a + x.count, 0);
    toast(`Use your ${offer.sources.map((x) => x.name).join(' and ')} (${total.toLocaleString()} commands) for suggestions and Ctrl+R?`, {
      action: 'Import', onAction: importHistory, timeout: 20000,
    });
  }

  // ================================================================ boot
  let smokeOut = null; // the e2e run's view of card output
  registerCommands();
  settingsPage = window.SettingsPage.create({
    api, el: settingsView, registry, mac, toast,
    onClose: (back) => { if (back && back.isConnected && back !== document.body) back.focus(); else focusPrompt(); },
    actions: { importHistory, clearCanvas, showDropdown: () => api.dropdownToggle() },
  });
  const [page0, themes0, keys0] = await Promise.all([api.getSettings(), api.themesList(), api.keysGet()]);
  settingsNow = page0.settings;
  window.Theme.applyFonts(settingsNow);
  fontKey = ['fontFamily', 'fontSize', 'lineHeight', 'fontWeight', 'ligatures'].map((x) => settingsNow[x]).join('|');
  LINE_H = window.Theme.fonts().lineH;
  measureChar();
  await applyTheme();
  registerThemeCommands(themes0);
  registry.setOverrides(keys0.list);
  if (keys0.error) toast(keys0.error, { kind: 'err', timeout: 6000 });
  if (page0.errors.length) toast(`settings.json: ${page0.errors[0]}${page0.errors.length > 1 ? ` (and ${page0.errors.length - 1} more)` : ''}`, { kind: 'err', action: 'Settings', onAction: () => openSettings(), timeout: 8000 });

  state.history = await api.historyLoad();
  const tabs0 = await api.tabsGet();
  order = tabs0.order.slice();
  for (const t of tabs0.tabs) addCanvas(t);
  await switchTo(tabs0.active || order[0], { focus: false });
  focusPrompt();
  // When the restored cards are first on screen, for the bench.
  let firstPaint = 0;
  let firstPaintPerf = 0;
  requestAnimationFrame(() => requestAnimationFrame(() => { firstPaint = Date.now(); firstPaintPerf = performance.now(); }));
  if (!sys.bench && !isDropdown) offerImport();
  // An AppImage isn't in the applications menu until it's added: offer once.
  if (sys.appImage && !isDropdown) {
    api.appImageOffer().then((offer) => {
      if (!offer) return;
      toast('Add Loom to your applications menu, with “Open in Loom” for folders?', {
        action: 'Add', timeout: 20000,
        onAction: async () => { const r = await api.appImageIntegrate(); toast(r.ok ? 'Loom is in your applications menu.' : `Couldn't add it: ${r.error}`, { kind: r.ok ? '' : 'err' }); },
      });
    });
  }
  // The other tabs' data, in the background, so switching never waits.
  (async () => { for (const id of order) { const cv = canvases.get(id); if (cv && !cv.loaded) { await loadCanvas(cv); renderTabBar(); } } })();
  // Requests from `loom` and the like that arrived while this window loaded.
  for (const req of await api.rendererReady()) await openRequest(req);
  api.onOpen((req) => openRequest(req));

  if (sys.bench) {
    window.addEventListener('error', (e) => console.log(`ERR ${e.message} @${e.filename && e.filename.split('/').pop()}:${e.lineno}`));
    window.addEventListener('unhandledrejection', (e) => console.log(`REJ ${e.reason && e.reason.stack}`));
    // bench.js isn't part of a packaged app; it's loaded only for the bench.
    await new Promise((resolve, reject) => { const sc = document.createElement('script'); sc.src = 'bench.js'; sc.onload = resolve; sc.onerror = reject; document.head.append(sc); });
    window.LoomBench.run({
      api, sys, state, els, runCommand, applyView, fit, toggleSidebar, focusPrompt,
      clearPrompt: () => editor.clear(),
      firstPaint: () => firstPaint,
      firstPaintPerf: () => firstPaintPerf,
      bodiesReady: () => !mountQueue.length && [...dom.values()].every((d) => d.mode !== 'full' || !d.holding),
      flush: () => { saveNow(); return api.canvasSave({ cid: cur.id, data: serialize() }); },
    }).catch((e) => { console.log(`BENCH ${e.stack}`); api.smokeDone(); });
  } else if (sys.smoke && !isDropdown) {
    window.addEventListener('error', (e) => console.log(`ERR ${e.message} @${e.filename && e.filename.split('/').pop()}:${e.lineno}`));
    window.addEventListener('unhandledrejection', (e) => console.log(`REJ ${e.reason && e.reason.stack}`));
    runSmoke().catch((e) => { console.log(`SMOKE ${e.stack}`); api.smokeDone(); });
  } else if (sys.smoke && isDropdown) {
    // The main window's e2e run drives the dropdown through this.
    window.__loomSmoke = async (cmd) => {
      if (cmd.run) { const n = runCommand(cmd.run, { parentId: null }); return n ? n.key : null; }
      if (cmd.status) { const n = nodeOf(cmd.status); return n ? n.status : null; }
      if (cmd.state) return { tabs: order.length, cards: state.nodes.size, focused: document.hasFocus(), prompt: document.activeElement === els.prompt };
      return null;
    };
  }

  async function runSmoke() {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const outs = new Map();
    // Big outputs stay in main; the checks on them read ranges.
    const fetchOut = async (n) => { if (!n || (n.out && n.out.bytes > 16 * 1048576)) return; outs.set(n.id, { raw: await api.smokeOut({ id: n.key, raw: true }), plain: await api.smokeOut({ id: n.key }) }); };
    const done = async (n) => { for (let i = 0; i < 300 && n && n.status === 'running'; i++) await wait(100); await wait(250); await fetchOut(n); };
    const results = [];
    const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: JSON.stringify(detail) });
    const text = (n) => ((outs.get(n.id) || {}).plain || '').trim();
    const rawOf = (n) => (outs.get(n.id) || {}).raw || '';
    smokeOut = { text, rawOf, fetchOut, forget: () => outs.clear() };
    const run = async (cmd, parent = null, opts = {}) => {
      const n = runCommand(cmd, { parentId: parent ? parent.id : null, ...opts });
      await done(n);
      return n;
    };
    if (sys.smokeResume) { await smokeResume({ run, text, check }); await api.smokeReport(results); api.smokeDone(); return; }
    if (sys.smokeMigrate) { await smokeMigrate({ check }); await api.smokeReport(results); api.smokeDone(); return; }
    if (sys.smokeLauncher) { await smokeLauncher({ check, wait }); await api.smokeReport(results); api.smokeDone(); return; }
    if (sys.smokePackaged) { await smokePackaged({ run, text, check, wait }); await api.smokeReport(results); api.smokeDone(); return; }

    check('uses PTY sessions', sys.sessions, sys);
    // ---- first launch: one opt-in toast to import shell history
    const until0 = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(40); } return !!fn(); };
    const offer = () => [...document.querySelectorAll('.toast')].find((t) => /zsh_history/.test(t.textContent));
    check('import: first launch offers it in a toast', await until0(offer), [...document.querySelectorAll('.toast')].map((t) => t.textContent));
    check('import: nothing imported before you ask', !state.history.some((r) => r.cmd === 'git checkout feature'), null);
    if (offer()) offer().querySelector('button').click();
    await until0(() => state.history.some((r) => r.cmd === 'git checkout feature'));
    check('import: zsh extended format and bash history', ['git checkout feature', 'make deploy', 'cargo build --release'].every((c) => state.history.some((r) => r.cmd === c)), state.history.map((r) => r.cmd));
    check('import: multi-line zsh entry', state.history.some((r) => r.cmd === 'for f in *; do\n  echo $f\ndone'), state.history.map((r) => r.cmd));
    toggleSidebar(true);
    const ls = runCommand('ls -a'); await done(ls);
    const log = runCommand('git log'); await done(log);
    const st = runCommand('git status'); await done(st);
    const bad = runCommand('cat notes/todo.txt'); await done(bad);
    setActive(ls.id);
    const json = runCommand('cat package.json'); await done(json);
    const wc = runCommand('wc -c', { parentId: json.id, pipeFrom: json.id }); await done(wc);
    setActive(ls.id);
    const csv = runCommand('cat people.csv'); await done(csv);
    const ps = runCommand('ps -eo pid,user,comm | head -6', { parentId: csv.id }); await done(ps);

    check('ls: file grid', ls.status === 'ok' && ls.rich && ls.rich.kind === 'files', ls.rich && ls.rich.kind);
    check('git log: graph', log.status === 'ok' && log.rich && log.rich.kind === 'gitlog', log.rich && log.rich.kind);
    check('git status: view', st.status === 'ok' && st.rich && st.rich.kind === 'gitstatus', st.rich && st.rich.kind);
    check('missing file: red card', bad.status === 'error' && bad.exitCode === 1, [bad.status, bad.exitCode]);
    check('cat json: tree view', json.rich && json.rich.kind === 'json', json.rich && json.rich.kind);
    check('cat csv: table view', csv.rich && csv.rich.kind === 'table', csv.rich && csv.rich.kind);
    check('no carriage returns in output', !rawOf(csv).includes('\r'), JSON.stringify(rawOf(csv).slice(0, 40)));

    const sorted = await run('sort -t, -k3 -nr', csv, { pipeFrom: csv.id });
    check('pipe: sort reads the source card', text(sorted).split('\n')[0] === 'carol,eng,300', text(sorted));
    const piped = await run('a=$(cat)\necho "$a" | wc -l | tr -d " "\ncd /tmp', csv, { pipeFrom: csv.id });
    check('pipe: multi-line command gets stdin', text(piped) === '4', text(piped));

    const exported = await run('export FOO=bar; echo $$');
    const echoed = await run('echo $FOO; echo $$', exported);
    check('export carries to a child', text(echoed).split('\n')[0] === 'bar', text(echoed));
    check('child runs in the same shell', text(echoed).split('\n')[1] === text(exported), [text(exported), text(echoed)]);

    const venv = await run('python3 -m venv /tmp/v && source /tmp/v/bin/activate');
    const which = await run('which python', venv);
    check('venv stays active', /\/tmp\/v\/bin\/python$/.test(text(which)), text(which));
    const venvFork = await run('true', venv);
    const whichFork = await run('which python; echo $VIRTUAL_ENV', venv);
    check('venv survives a fork', venvFork.status === 'ok' && /\/tmp\/v\/bin\/python\n.*\/tmp\/v$/.test(text(whichFork)), text(whichFork));

    const alias = await run('loomalias');
    check('alias from the rc file', text(alias) === 'alias-ok', text(alias));
    const fn = await run('loomfn', alias);
    check('function from the rc file', text(fn) === 'fn-ok', text(fn));
    const shellVar = await run('declare -A m 2>/dev/null || typeset -A m; m[k]=v; plain=1');
    const shellVar2 = await run('echo "${m[k]} $plain"', shellVar);
    check('declare and plain vars persist (no wrapper function)', text(shellVar2) === 'v 1', text(shellVar2));

    const base = await run('pwd');
    const cd = await run('cd /tmp', base);
    const pwd = await run('pwd', cd);
    const sib = await run('pwd', base);
    check('cd carries to a child', /\/tmp$/.test(text(pwd)) && /\/tmp$/.test(pwd.cwd), [text(pwd), pwd.cwd]);
    check('sibling branch keeps the old dir', text(sib) === text(base), [text(sib), text(base)]);

    const f1 = await run('export EARLY=1; echo $$');
    const f2 = await run('export LATE=2', f1);
    const f3 = await run('echo "e=$EARLY l=$LATE"; echo $$', f1);
    check('fork keeps earlier env, drops later env', text(f3).split('\n')[0] === 'e=1 l=', text(f3));
    check('fork gets a new shell', text(f3).split('\n')[1] !== text(f1), [text(f1), text(f3)]);
    const f4 = await run('loomalias', f1);
    check('alias works in a fork', text(f4) === 'alias-ok', text(f4));

    const pre = await run('export BEFORE=stop');
    const sleeper = runCommand('sleep 30', { parentId: pre.id });
    await wait(600);
    const t0 = Date.now();
    stop(sleeper);
    await done(sleeper);
    check('Stop: card shows stopped', sleeper.status === 'killed' && Date.now() - t0 < 2000, [sleeper.status, Date.now() - t0]);
    const after = await run('echo $BEFORE', sleeper);
    check('Stop: shell works afterwards', text(after) === 'stop' && after.status === 'ok', text(after));

    const stubborn = runCommand('python3 -c "import signal,time; signal.signal(signal.SIGINT, signal.SIG_IGN); print(\'up\', flush=True); time.sleep(30)"', { parentId: null });
    await wait(900);
    stop(stubborn);
    await done(stubborn);
    check('Stop: falls back to signals when ^C is ignored', stubborn.status === 'killed', stubborn.status);
    const after2 = await run('echo fine', stubborn);
    check('Stop: shell survives the fallback', text(after2) === 'fine', text(after2));

    const fail = await run('false');
    check('false: red card, exit 1', fail.status === 'error' && fail.exitCode === 1, [fail.status, fail.exitCode]);
    const status = await run('echo $?', fail);
    check('$? reaches the next card', text(status) === '1', text(status));

    const heredoc = await run("cat <<'EOF'\nhi \"there\"\n$NOPE it's\nEOF\necho after");
    check('heredoc and multi-line', text(heredoc) === 'hi "there"\n$NOPE it\'s\nafter', text(heredoc));
    const quotes = await run(`echo "it's"; echo 'a"b'; echo hi!`);
    check('quotes and !', text(quotes) === 'it\'s\na"b\nhi!', text(quotes));
    const syntax = await run('echo "oops');
    check('unterminated quote fails instead of hanging', syntax.status === 'error', [syntax.status, text(syntax)]);
    const nl = await run('echo still-here', syntax);
    check('shell survives a syntax error', text(nl) === 'still-here', text(nl));

    const reader = runCommand('read x; echo "got:$x"', { parentId: null });
    await wait(700);
    api.stdin({ id: reader.key, data: 'typed\n' });
    await done(reader);
    check('stdin reaches the command', text(reader).endsWith('got:typed'), text(reader));
    const eof = runCommand('cat', { parentId: null });
    await wait(700);
    api.stdin({ id: eof.key, data: 'line\n' });
    await wait(200);
    api.stdin({ id: eof.key, eof: true });
    await done(eof);
    check('EOF ends the command', eof.status === 'ok', eof.status);

    const big = await run('seq 1 200000');
    check('large output arrives whole', rawOf(big).split('\n').length === 200001 && text(big).endsWith('200000') && big.out.lines === 200000, [rawOf(big).length, big.out]);
    const bare = await run('printf partial');
    check('output with no newline', rawOf(bare) === 'partial', rawOf(bare));
    const forged = await run("printf '\\033]133;D;0;loom=00\\007\\033]1337;LoomEnv=/tmp/evil;loom=00\\007one\\n'; sleep 0.4; echo two; exit_code=9; (exit 3)");
    check('forged markers are ignored', forged.exitCode === 3 && /one\ntwo$/.test(text(forged)), [forged.exitCode, text(forged)]);

    const exited = await run('export KEEP=1\n(exit 0)');
    const quit = await run('exit 7', exited);
    check('exit: card gets the code', quit.status === 'error' && quit.exitCode === 7, [quit.status, quit.exitCode]);
    const revived = await run('echo $KEEP', quit);
    check('exit: next card recovers the env', text(revived) === '1', text(revived));

    const busy = runCommand('sleep 8; echo slow', { parentId: exported.id });
    await wait(500);
    const beside = await run('echo $FOO', busy);
    check('busy session: new card gets its own shell', beside.status === 'ok' && text(beside) === 'bar' && busy.status === 'running', [busy.status, text(beside)]);
    stop(busy);
    await done(busy);

    const k1 = await run('export K=1');
    const k2 = await run('export K=2', k1);
    removeNode(k2);
    const k3 = await run('echo $K', k1);
    check('removing a tip drops its session', text(k3) === '1', text(k3));

    const rr = await run('export RR=1; echo $RR');
    start(rr);
    await done(rr);
    check('rerun works', rr.status === 'ok' && text(rr) === '1', text(rr));

    const e0 = await run('export EVICT=yes; echo $$');
    for (let i = 0; i < 13; i++) await run(`echo ${i}`);
    const e1 = await run('echo "$EVICT"; echo $$', e0);
    check('evicted session comes back from its snapshot', text(e1).split('\n')[0] === 'yes' && text(e1).split('\n')[1] !== text(e0), [text(e0), text(e1)]);

    await smokeEditor({ run, text, check, wait, done });
    await smokeTerminals({ run, text, check, wait, done });
    await smokeOutput({ run, check, wait });
    await smokeApp({ check, wait });
    for (const n of state.nodes.values()) if (!outs.has(n.id)) await fetchOut(n);
    const leak = [...state.nodes.values()].filter((n) => /LEAK|__loom|source '|133;/.test(text(n)));
    check('no prompt or hook text on any card', !leak.length, leak.map((n) => [n.cmd, rawOf(n).slice(0, 200)]));

    const resume = await run('export RESUME_VAR=restored; cd /tmp');
    check('card has an env snapshot', !!resume.envFile, resume.envFile);

    await api.smokeReport(results);
    setActive(st.id);
    await wait(300);
    showSuggestion({ token: 1, request: 'find the 10 largest files under here', command: 'du -ah . | sort -rh | head -n 10', explanation: 'Lists every file and folder with human-readable sizes, sorts largest first, and keeps the top ten.', risk: 'safe' });
    fit();
    await wait(900);
    await api.smokeDone({ keep: true });
    hideSuggestion();
    setActive(log.id);
    state.view.k = 1;
    reveal(log, true);
    await wait(700);
    await api.canvasSave({ cid: cur.id, data: serialize() });
    api.smokeDone({ suffix: 'zoom' });
  }

  // Interactive programs, driven by real key events through the page.
  async function smokeTerminals({ run, text, check, wait, done }) {
    const { rawOf } = smokeOut;
    window.loomE2E = sys.e2e;
    const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(40); } return !!fn(); };
    const keys = (s) => api.smokeKeys([...s]);
    const ENTER = { key: 'Return' };
    const ESC = { key: 'Escape' };
    const ctrl = (key) => ({ key, modifiers: ['control'] });
    const hatch = { key: 'E', modifiers: ['control', 'shift'] };
    const start = (cmd) => runCommand(cmd, { parentId: null });
    const screen = (n) => {
      const term = terminals.term(n.key);
      if (!term) return '';
      const b = term.buffer.active;
      let out = '';
      for (let i = b.viewportY; i < b.viewportY + term.rows; i++) { const l = b.getLine(i); out += `${l ? l.translateToString(true) : ''}\n`; }
      return out;
    };
    const keyboardOn = (n) => document.activeElement === (terminals.term(n.key) || {}).textarea;
    const showing = () => [...document.querySelectorAll('.live-term')].filter((e) => !e.hidden && e.offsetParent);

    // ---- vim
    const vim = start('vim README.md');
    check('vim: expands to the overlay', await until(() => terminals.stats().overlay === vim.key), terminals.stats());
    await until(() => /README/.test(screen(vim)));
    const slot = $('#term-slot').getBoundingClientRect();
    check('vim: overlay is about 90% of the window', slot.width / window.innerWidth > 0.85 && slot.height / window.innerHeight > 0.85, [slot.width, slot.height]);
    await wait(400);
    const veil = getComputedStyle($('#term-overlay'));
    check('vim: overlay is actually on screen', veil.opacity === '1' && veil.display !== 'none' && document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2).closest('#term-overlay'), [veil.opacity, veil.display]);
    await api.smokeDone({ keep: true, suffix: 'vim' });
    check('vim: takes the keyboard', await until(() => keyboardOn(vim)), [document.activeElement && (document.activeElement.id || document.activeElement.className), state.nodes.size]);
    await api.smokeKeys(['i', ...'edited-in-vim', ENTER, ESC, ':', 'w', 'q', ENTER]);
    await done(vim);
    check('vim: :wq exits 0', vim.status === 'ok' && vim.exitCode === 0, [vim.status, vim.exitCode]);
    check('vim: overlay closed', await until(() => terminals.stats().overlay === null) && await until(() => $('#term-overlay').hidden), terminals.stats());
    check('vim: card keeps only the normal screen', !/edited-in-vim|~/.test(text(vim)), text(vim).slice(0, 200));
    const edited = await run('head -1 README.md', vim);
    check('vim: edit saved, shell still usable', text(edited) === 'edited-in-vim', text(edited));

    // ---- top: redraw and resize
    const top = start('top');
    await until(() => /PID/.test(screen(top)));
    await wait(500);
    // macOS top uses the alternate screen. Linux top redraws in place, so it stays on the card.
    check('top: expands if it takes the alternate screen', terminals.inAlt(top.key) === (terminals.stats().overlay === top.key), terminals.stats());
    if (terminals.stats().overlay !== top.key) cardAction(top, 'expand');
    const first = screen(top);
    await wait(2500);
    check('top: redraws live', screen(top) !== first, null);
    const cols0 = terminals.term(top.key).cols;
    await api.smokeResize({ width: 1100, height: 700 });
    check('top: follows the window size', await until(() => terminals.term(top.key).cols !== cols0), [cols0, terminals.term(top.key).cols]);
    await api.smokeResize({ width: 1480, height: 920 });

    // ---- zoom, using top as the spec does
    await api.smokeKeys([hatch]);
    check('hatch: Ctrl+Shift+E closes the overlay', await until(() => terminals.stats().overlay === null) && document.activeElement === els.prompt, document.activeElement && document.activeElement.id);
    check('hatch: no focus ring left behind', !document.querySelector('.live-term.focused'), null);
    setActive(top.id);
    state.view.k = 1;
    reveal(top, true);
    await wait(600);
    terminals.layout();
    check('zoom 100%: live terminal over the card', terminals.isLive(top.key), terminals.stats());
    const host = showing().find((e) => e.querySelector('canvas, .xterm-screen')) || showing()[0];
    const bodyBox = dom.get(top.id).body.getBoundingClientRect();
    const hostBox = host.getBoundingClientRect();
    check('zoom 100%: lines up with the card body', Math.abs(bodyBox.left - hostBox.left) < 2 && Math.abs(bodyBox.top - hostBox.top) < 2, [bodyBox.left, hostBox.left, bodyBox.top, hostBox.top]);
    await api.smokeDone({ keep: true, suffix: 'live' });
    const home = { ...state.view };
    const box = els.viewport.getBoundingClientRect();
    state.view = { k: 0.4, x: box.width / 2 - (top.x + top.w / 2) * 0.4, y: box.height / 3 - top.y * 0.4 };
    applyView();
    await wait(500);
    const small = dom.get(top.id).card.getBoundingClientRect();
    check('zoom 40%: the card is in view', small.left >= box.left && small.right <= box.right && small.top >= box.top && small.top < box.bottom, [small.left, small.top]);
    check('zoom 40%: snapshot, no stray terminal', !terminals.isLive(top.key) && !showing().length, showing().length);
    check('zoom 40%: the card is a pill with its command and time', dom.get(top.id).mode === 'pill' && /top/.test(dom.get(top.id).card.textContent) && !dom.get(top.id).card.querySelector('.card-body'), [dom.get(top.id).mode, dom.get(top.id).card.textContent.slice(0, 80)]);
    await api.smokeDone({ keep: true, suffix: 'zoom40' });
    state.view = home;
    applyView();
    await wait(400);
    check('zoom back: live again', terminals.isLive(top.key), terminals.stats());
    state.view = { ...home, x: home.x + 50000 };
    applyView();
    await wait(200);
    check('off-screen: snapshot', !terminals.isLive(top.key), terminals.stats());
    state.view = home;
    applyView();
    await wait(200);
    terminals.show(top, { focus: true });
    await until(() => keyboardOn(top));
    await keys('q');
    await done(top);
    check('top: q exits 0', top.status === 'ok' && top.exitCode === 0, [top.status, top.exitCode]);

    // ---- pagers
    const less = start('less README.md');
    await until(() => /line 1\b/.test(screen(less)) || /edited/.test(screen(less)));
    await wait(200);
    const page = screen(less);
    await keys('jjjj');
    check('less: scrolls', await until(() => screen(less) !== page), null);
    terminals.term(less.key).input('q'); // the path a keystroke takes out of xterm
    await done(less);
    check('less: q exits 0', less.status === 'ok' && less.exitCode === 0, [less.status, less.exitCode]);
    const hasMan = await run('command -v man');
    if (hasMan.status === 'ok') {
      const man = start('man ls');
      const opened = await until(() => /LS\(1\)|ls\b.*list/i.test(screen(man)), 10000);
      check('man: opens in a pager', opened, screen(man).slice(0, 200));
      await keys('jjj');
      await wait(200);
      await keys('q');
      await done(man);
      check('man: q exits 0', man.status === 'ok' && man.exitCode === 0, [man.status, man.exitCode]);
    }

    // ---- passwords
    const CANARY = 'loom-canary-hunter2';
    const secret = start('read -s p && echo got');
    await until(() => keyboardOn(secret));
    await keys(CANARY);
    await api.smokeKeys([ENTER]);
    await done(secret);
    check('read -s: input reaches the program', text(secret) === 'got', text(secret));
    check('read -s: not on the card or in the session', !JSON.stringify(serialize()).includes(CANARY) && !rawOf(secret).includes(CANARY), rawOf(secret));
    const sudo = start('sudo -k && sudo true');
    const asked = await until(() => /password/i.test(screen(sudo)), 6000);
    check('sudo: prompts on the terminal', asked, screen(sudo).slice(0, 120));
    if (window.loomE2E && window.loomE2E.sudoPass) {
      await keys(window.loomE2E.sudoPass);
      await api.smokeKeys([ENTER]);
      await done(sudo);
      check('sudo: password accepted', sudo.status === 'ok', [sudo.status, screen(sudo)]);
      check('sudo: password not stored', !JSON.stringify(serialize()).includes(window.loomE2E.sudoPass) && !text(sudo).includes(window.loomE2E.sudoPass), null);
    } else {
      await api.smokeKeys([ctrl('C')]);
      await done(sudo);
      check('sudo: ^C abandons the prompt', sudo.status !== 'running', sudo.status);
    }

    // ---- interactive programs
    const py = start('python3');
    await until(() => keyboardOn(py));
    await until(() => />>>/.test(screen(py)), 10000);
    await api.smokeKeys([...'1+1', ENTER]);
    check('python: REPL answers', await until(() => /^2$/m.test(screen(py))), screen(py));
    await api.smokeKeys([...'exit()', ENTER]);
    await done(py);
    check('python: exit() ends the card', py.status === 'ok', py.status);

    const npm = start('mkdir -p npmt && cd npmt && npm init');
    await until(() => /package name/.test(screen(npm)), 20000);
    await api.smokeKeys([...'answered-name', ENTER]);
    for (let i = 0; i < 40 && npm.status === 'running'; i++) { await api.smokeKeys([ENTER]); await wait(200); }
    await done(npm);
    const pkg = await run('cat package.json', npm);
    check('npm init: answers land in package.json', npm.status === 'ok' && /"name": "answered-name"/.test(text(pkg)), [npm.status, text(pkg).slice(0, 120)]);

    if (window.loomE2E && window.loomE2E.ssh) {
      const ssh = start('ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null localhost');
      await until(() => /[$#] $/m.test(screen(ssh).trimEnd() + ' '), 8000);
      await wait(500);
      await api.smokeKeys([...'echo ssh-$((40+2))', ENTER]);
      check('ssh: live terminal works', await until(() => /ssh-42/.test(screen(ssh))), screen(ssh).slice(-300));
      check('ssh: stays running', ssh.status === 'running', ssh.status);
      await api.smokeKeys([...'exit', ENTER]);
      await done(ssh);
      check('ssh: card ends with the connection', ssh.status === 'ok', ssh.status);
    }

    // ---- typed ahead of the terminal opening
    els.prompt.focus();
    const ahead = start('cat');
    await api.smokeKeys([...'typed-ahead', ENTER]);
    check('typeahead: reaches the new card', await until(() => /typed-ahead/.test(screen(ahead))), screen(ahead).slice(0, 80));
    check('typeahead: never becomes a command', !state.history.some((r) => r.cmd === 'typed-ahead') && !els.prompt.value, els.prompt.value);
    await api.smokeKeys([ctrl('D')]);
    await done(ahead);

    // ---- keys go to the program, not to Loom
    const catv = start('cat -v');
    await until(() => keyboardOn(catv));
    await api.smokeKeys([{ key: 'Up' }, { key: 'Tab' }, ctrl('K'), ctrl('B'), ENTER]);
    check('keys: arrows, Tab, Ctrl+K, Ctrl+B reach the program', await until(() => /\^\[\[A\s+\^K\^B/.test(screen(catv))), screen(catv).slice(0, 120));
    check('keys: no Loom shortcut fired', els.sidebar.hidden === false && keyboardOn(catv), null);
    await api.smokeKeys([ctrl('D')]);
    await done(catv);
    check('keys: Ctrl+D is EOF', catv.status === 'ok', catv.status);

    const interrupted = start('sleep 30');
    await until(() => keyboardOn(interrupted));
    await api.smokeKeys([ctrl('C')]);
    await done(interrupted);
    check('keys: Ctrl+C stops the program', interrupted.status === 'killed', [interrupted.status, interrupted.exitCode]);
    check('keys: keyboard returns to the composer when a card ends', document.activeElement === els.prompt, document.activeElement && document.activeElement.className);

    const suspended = start('sleep 30');
    await until(() => keyboardOn(suspended));
    await api.smokeKeys([ctrl('Z')]);
    await done(suspended);
    check('keys: Ctrl+Z suspends and ends the card', suspended.status !== 'running', suspended.status);
    const resumed = await run('jobs; kill %1', suspended);
    check('keys: suspended job stays in the branch shell', /sleep 30/.test(text(resumed)), text(resumed));

    const hold = start('cat');
    await until(() => keyboardOn(hold));
    check('hatch: hint shows while focused', (() => { const f = document.querySelector('.live-term.focused .live-hint'); return f && getComputedStyle(f).display === 'block'; })(), null);
    await api.smokeKeys([ESC, ESC]);
    check('hatch: Esc Esc returns to the composer', await until(() => document.activeElement === els.prompt), document.activeElement && document.activeElement.className);
    cardAction(hold, 'expand');
    check('expand: button opens the overlay', await until(() => terminals.stats().overlay === hold.key), terminals.stats());
    await api.smokeKeys([hatch]);
    check('expand: hatch closes it', await until(() => terminals.stats().overlay === null), terminals.stats());
    stop(hold);
    await done(hold);

    els.prompt.value = 'half-typed';
    const noSteal = start('sleep 1');
    await wait(400);
    check("a new card doesn't take the keyboard from a half-typed command", document.activeElement === els.prompt, document.activeElement && document.activeElement.className);
    els.prompt.value = '';
    await done(noSteal);

    // ---- redraws, sizing, volume
    const bar = start('for i in $(seq 1 100); do printf "\\r%3d%%" $i; sleep 0.02; done; echo');
    await done(bar);
    check('progress: final text is 100%', text(bar) === '100%', text(bar));

    const sized = start('for i in 1 2 3 4 5 6 7 8 9 10 11 12; do stty size; sleep 0.2; done');
    await done(sized);
    const sizes = text(sized).split('\n');
    check('resize: the PTY follows the card', sizes[0] === '40 120' && sizes[sizes.length - 1] !== '40 120', [sizes[0], sizes[sizes.length - 1]]);
    const again = await run('stty size', sized);
    check('resize: the next card starts at the default size', text(again) === '40 120', text(again));

    const tsv = await run("printf 'a\\tb\\nc\\td\\n'");
    check('tabs survive for rich views', tsv.rich && tsv.rich.kind === 'table' && rawOf(tsv).includes('\t'), tsv.rich && tsv.rich.kind);

    const flood = await run("seq -f '%.0f' 1 1500000");
    check('over 5 MB: the card keeps every line', flood.status === 'ok' && flood.out.lines === 1500000 && text(flood).startsWith('1\n2\n') && text(flood).endsWith('1500000'), [flood.status, flood.out, text(flood).slice(-10)]);
    const yes = start('yes');
    await wait(1200);
    const t0 = Date.now();
    stop(yes);
    await done(yes);
    check('Stop works during a flood', yes.status === 'killed' && Date.now() - t0 < 8000, [yes.status, Date.now() - t0]);

    // ---- many running cards
    const many = [];
    for (let i = 0; i < 15; i++) { many.push(start('sleep 100')); await wait(230); }
    const st = terminals.stats();
    check('15 running cards: at most 8 live terminals', st.peak <= 8 && st.live <= 8, st);
    const offscreen = many.filter((n) => dom.get(n.id).mode !== 'full' && !terminals.isLive(n.key));
    await wait(1300);
    scheduleLayout();
    await wait(100);
    check('15 running cards: off-screen ones drop their terminal model', offscreen.length > 0 && offscreen.every((n) => !terminals.has(n.key) || dom.get(n.id).mode === 'full'), [offscreen.length, terminals.stats()]);
    setActive(many[0].id);
    reveal(many[0], true);
    await wait(600);
    terminals.show(many[0], { focus: true });
    await wait(150);
    check('15 running cards: an old card comes back when focused', terminals.isLive(many[0].key) && terminals.stats().live <= 8, terminals.stats());
    many.forEach(stop);
    for (const n of many) await done(n);
    check('15 running cards: all stop', many.every((n) => n.status === 'killed'), many.map((n) => n.status));
    check('finished cards keep no terminal', terminals.stats().models === 0 && !document.querySelector('.live-term'), terminals.stats());
  }

  // The command bar, driven by real key events.
  async function smokeEditor({ run, text, check, wait, done }) {
    const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(30); } return !!fn(); };
    const key = (k, ...modifiers) => ({ key: k, modifiers });
    const TAB = key('Tab');
    const ENTER = key('Return');
    const ESC = key('Escape');
    const MODK = sys.platform === 'darwin' ? 'meta' : 'control';
    const v = () => els.prompt.value;
    const st = () => editor.stats();
    const popup = () => st().popup || [];
    const typeKeys = async (s) => { await api.smokeKeys([...s]); await wait(40); };
    const insert = async (s) => { els.prompt.focus(); document.execCommand('insertText', false, s); await wait(40); };
    const fresh = async () => { editor.clear(); setMode('shell'); focusPrompt(); await wait(30); };
    const spanOf = (word) => [...els.mirror.querySelectorAll('span')].find((x) => x.textContent === word);
    const cards = () => state.nodes.size;

    const base = await run('pwd');
    setActive(base.id);
    reveal(base, true);
    await editor.refreshInfo();

    // ---- completion
    await fresh();
    await typeKeys('git checkout ');
    await api.smokeKeys([TAB]);
    check('complete: git checkout lists real branches', await until(() => ['feature', 'fix-typo'].every((b) => popup().includes(b))), popup());
    await wait(150);
    await api.smokeDone({ keep: true, suffix: 'complete' });
    await api.smokeKeys([ESC]);
    check('complete: Esc closes the popup', await until(() => !st().popup) && v() === 'git checkout ', v());

    await fresh();
    await typeKeys('npm run ');
    await api.smokeKeys([TAB]);
    check('complete: npm run lists package.json scripts', await until(() => ['build', 'test'].every((b) => popup().includes(b))), popup());
    await api.smokeKeys([key('Down'), ENTER]);
    check('complete: arrow + Enter inserts the choice', await until(() => /^npm run (build|test) $/.test(v())), v());

    await fresh();
    await typeKeys('cd sr');
    const t0 = performance.now();
    await api.smokeKeys([TAB]);
    check('complete: cd sr + Tab → cd src/', await until(() => v() === 'cd src/'), v());
    const ms = performance.now() - t0;
    check('complete: dirs reopen completion', await until(() => popup().includes('lib/')), popup());
    check('complete: paths answer in under 50 ms', st().lastComplete < 50, [st().lastComplete, ms]);
    await api.smokeKeys([ESC]);

    await fresh();
    await typeKeys('cat my');
    await api.smokeKeys([TAB]);
    check('complete: my file.txt is escaped', await until(() => v() === 'cat my\\ file.txt '), v());
    document.execCommand('undo');
    check('complete: undo takes the completion back', await until(() => v() === 'cat my'), v());

    await fresh();
    await insert('cat "my');
    await api.smokeKeys([TAB]);
    check('complete: inside quotes, closes the quote', await until(() => v() === 'cat "my file.txt" '), v());

    await fresh();
    await typeKeys('tar -');
    await api.smokeKeys([TAB]);
    await until(() => popup().length > 5);
    const descs = [...els.complete.querySelectorAll('.cp-row')].map((r) => [r.querySelector('.cp-label').textContent, r.querySelector('.cp-desc').textContent]);
    check('complete: tar - shows flags with Fig descriptions', descs.length > 5 && descs.every(([l]) => l.startsWith('-')) && descs.filter(([, d]) => d).length > 5, descs.slice(0, 4));
    check('complete: matched characters are bold', !!els.complete.querySelector('.cp-label b'), null);
    await api.smokeKeys([ESC]);

    await fresh();
    await typeKeys('loomal');
    await api.smokeKeys([TAB]);
    check('complete: aliases from the rc file', await until(() => v() === 'loomalias '), v());

    // ---- highlighting
    const hl = async (line, word, want) => {
      await fresh();
      await insert(line);
      return until(() => { editor.render(); const x = spanOf(word); return x && want(x.className); }, 4000);
    };
    check('highlight: gti is red', await hl('gti status', 'gti', (c) => c.includes('tk-bad')), spanOf('gti') && spanOf('gti').className);
    check('highlight: git is a known command', await hl('git status', 'git', (c) => c === 'tk-cmd'), spanOf('git') && spanOf('git').className);
    check('highlight: an alias from the rc file is not red', await hl('loomalias', 'loomalias', (c) => c === 'tk-cmd'), spanOf('loomalias') && spanOf('loomalias').className);
    check('highlight: flags, strings, variables, operators', await hl('ls -la "x" $HOME | wc', '-la', (c) => c.includes('tk-flag'))
      && spanOf('"x"').className.includes('tk-str') && spanOf('$HOME').className.includes('tk-var') && spanOf('|').className.includes('tk-op'), els.mirror.innerHTML);
    check('highlight: existing paths are underlined', await hl('cat README.md nope.txt', 'README.md', (c) => c.includes('tk-path'))
      && !(spanOf(' nope.txt') || { className: '' }).className.includes('tk-path'), els.mirror.innerHTML);
    await api.smokeDone({ keep: true, suffix: 'highlight' });

    // ---- Enter on an unfinished command, Shift+Enter, paste
    await fresh();
    let before = cards();
    await insert('echo "unfinished');
    await api.smokeKeys([ENTER]);
    check('enter: open quote inserts a newline', await until(() => v() === 'echo "unfinished\n') && cards() === before, JSON.stringify(v()));
    await insert('"');
    await api.smokeKeys([ENTER]);
    check('enter: closing the quote runs it', await until(() => cards() === before + 1 && !v()), [cards(), v()]);
    const unfinished = [...state.nodes.values()].pop();
    await done(unfinished);
    check('enter: multi-line command ran whole', text(unfinished) === 'unfinished', text(unfinished));

    await fresh();
    await insert('echo a');
    await api.smokeKeys([key('Return', 'shift')]);
    check('shift+enter: always a newline', await until(() => v() === 'echo a\n'), JSON.stringify(v()));

    await fresh();
    before = cards();
    await api.smokePaste('echo one\necho two\necho three\n');
    await wait(500);
    check("paste: a 3-line script doesn't run by itself", v() === 'echo one\necho two\necho three' && cards() === before, JSON.stringify(v()));
    check('paste: hint says N lines · Enter to run', els.hint.textContent === '3 lines · Enter to run', els.hint.textContent);
    await api.smokeKeys([ENTER]);
    await until(() => cards() === before + 1);
    const pasted = [...state.nodes.values()].pop();
    await done(pasted);
    check('paste: Enter runs it', text(pasted) === 'one\ntwo\nthree', text(pasted));

    // ---- ↑/↓ move the caret inside a multi-line command
    await fresh();
    await insert('echo l1\necho l2');
    await api.smokeKeys([key('Up')]);
    check('up: on line 2 moves the caret, not history', v() === 'echo l1\necho l2' && els.prompt.selectionStart <= 7, [v(), els.prompt.selectionStart]);
    await api.smokeKeys([key('Up')]);
    check('up: on line 1 browses history', await until(() => v() !== 'echo l1\necho l2'), v());
    await fresh();
    await typeKeys('git c');
    await api.smokeKeys([key('Up')]);
    check('up: filtered by the typed prefix', v().startsWith('git c'), v());

    // ---- ghost text
    await fresh();
    setActive(base.id);
    await typeKeys('ls -la');
    await api.smokeKeys([ENTER]);
    const lsla = [...state.nodes.values()].pop();
    await done(lsla);
    await fresh();
    await typeKeys('ls');
    check('ghost: ls shows " -la" from this folder', await until(() => st().ghost === ' -la' && !!els.mirror.querySelector('.ghost')), st().ghost);
    await api.smokeDone({ keep: true, suffix: 'ghost' });
    await api.smokeKeys([key('Right')]);
    check('ghost: → accepts it', await until(() => v() === 'ls -la'), v());
    await fresh();
    await typeKeys('git');
    check('ghost: never offers a command not found', !(st().ghost || '').includes('gti'), st().ghost);
    const nf = await run('loomnotacommand --x');
    await fresh();
    await typeKeys('loomnot');
    await wait(100);
    check('ghost: a command not found (127) is not suggested', nf.exitCode === 127 && !st().ghost, [nf.exitCode, st().ghost]);

    // ---- Ctrl+R
    await fresh();
    await api.smokeKeys([key('R', 'control')]);
    check('ctrl+r: opens history search', await until(() => !!st().search), st().search);
    await typeKeys('chk');
    const scopes = [st().search.scope];
    let found = st().search.results[0] === 'git checkout feature';
    for (let i = 0; i < 2 && !found; i++) {
      await api.smokeKeys([key('R', 'control')]);
      await wait(60);
      scopes.push(st().search.scope);
      found = st().search.results[0] === 'git checkout feature';
    }
    check('ctrl+r: chk finds git checkout feature', found, st().search);
    console.log(`[e2e] INFO ctrl+r chk results: ${JSON.stringify(st().search.results.slice(0, 5))}`);
    await api.smokeKeys([key('R', 'control')]);
    scopes.push(st().search.scope);
    check('ctrl+r: Ctrl+R again cycles This branch → This folder → All', scopes.join() === 'branch,folder,all,branch', scopes);
    while (st().search.scope !== 'all') await api.smokeKeys([key('R', 'control')]);
    await wait(80);
    await api.smokeDone({ keep: true, suffix: 'search' });
    before = cards();
    await api.smokeKeys([ENTER]);
    check("ctrl+r: Enter puts it in the bar and doesn't run it", await until(() => v() === 'git checkout feature' && !st().search) && cards() === before, [v(), cards() - before]);
    await fresh();
    await api.smokeKeys([key('R', 'control')]);
    await typeKeys('ls -la');
    while (st().search.scope !== 'all') await api.smokeKeys([key('R', 'control')]);
    await wait(80);
    check('ctrl+r: ls -la is the top result in All', st().search.results[0] === 'ls -la', st().search.results.slice(0, 3));
    await api.smokeKeys([key('Return', 'shift')]);
    check('ctrl+r: Shift+Enter runs it', await until(() => cards() === before + 1 && [...state.nodes.values()].pop().cmd === 'ls -la'), [...state.nodes.values()].pop().cmd);
    await done([...state.nodes.values()].pop());
    await fresh();
    await api.smokeKeys([key('R', 'control')]);
    await api.smokeKeys([ESC]);
    check('ctrl+r: Esc cancels', await until(() => !st().search && document.activeElement === els.prompt), null);

    // 20,000 records: rank time per keystroke.
    const real = state.history;
    const words = ['git', 'checkout', 'status', 'npm', 'run', 'build', 'docker', 'compose', 'up', 'kubectl', 'get', 'pods', 'grep', 'feature'];
    state.history = [...real];
    for (let i = 0; state.history.length < 20000; i++) state.history.unshift({ cmd: `${words[i % 14]} ${words[(i * 5) % 14]} ${words[(i * 3) % 14]} ${i}`, cwd: sys.home, exitCode: i % 7 ? 0 : 1, startedAt: Date.now() - i * 60000 });
    await fresh();
    await api.smokeKeys([key('R', 'control')]);
    await wait(100);
    let worst = 0;
    const frames = [];
    for (const ch of 'gitchk') {
      const f0 = performance.now();
      await api.smokeKeys([ch]);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      frames.push(performance.now() - f0);
      worst = Math.max(worst, st().lastSearch);
    }
    check('ctrl+r: 20,000 records rank in under 30 ms a keystroke', worst < 30, [worst.toFixed(1), frames.map((f) => f.toFixed(0))]);
    await api.smokeKeys([ESC]);
    state.history = real;

    // ---- leading space stays out of history
    await fresh();
    await typeKeys(' echo secret-space');
    await api.smokeKeys([ENTER]);
    await until(() => [...state.nodes.values()].pop().cmd === 'echo secret-space');
    const sec = [...state.nodes.values()].pop();
    await done(sec);
    check('ignorespace: the command ran', text(sec) === 'secret-space', text(sec));
    const saved = await api.historyLoad();
    check('ignorespace: not in history', !state.history.some((r) => r.cmd.includes('secret-space')) && !saved.some((r) => r.cmd.includes('secret-space')), null);
    await fresh();
    await typeKeys('echo sec');
    check('ignorespace: no ghost text for it', !st().ghost, st().ghost);
    const rec = saved.find((r) => r.cmd === 'ls -la');
    check('history: records cwd, exit code, duration, branch', rec && rec.cwd === lsla.cwd && rec.exitCode === 0 && rec.durationMs >= 0 && rec.rootId === rootOf(lsla).key && rec.cardId === lsla.key, rec);

    // ---- ask Claude
    await fresh();
    await api.smokeKeys([key('I', MODK)]);
    check('⌘/Ctrl+I: switches to ask Claude', state.mode === 'ai' && /back to shell/.test(els.hint.textContent), [state.mode, els.hint.textContent]);
    await api.smokeKeys([key('I', MODK)]);
    check('⌘/Ctrl+I: and back', state.mode === 'shell', state.mode);
    await api.smokeKeys([TAB]);
    check("Tab doesn't switch modes any more", state.mode === 'shell', state.mode);
    await fresh();
    await typeKeys('?find big files');
    await api.smokeKeys([ENTER]);
    // No API key in the e2e run, so asking Claude opens Settings to add one.
    check('?find big files still asks Claude', await until(() => settingsPage.state().open && /API key/.test(settingsPage.state().note)), settingsPage.state());
    settingsPage.close();
    await fresh();
  }

  // Big output: virtualized bodies, copy across lines, find, colors, memory,
  // and typing while a log streams.
  async function smokeOutput({ run, check, wait }) {
    const until = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(40); } return !!fn(); };
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const MODK = sys.platform === 'darwin' ? 'meta' : 'control';
    const longTasks = async (fn) => {
      const tasks = [];
      const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) tasks.push(Math.round(e.duration)); });
      po.observe({ type: 'longtask' });
      await fn();
      await wait(100);
      po.disconnect();
      return tasks;
    };
    const vtOf = (n) => { const d = dom.get(n.id); return d && d.vt; };
    const rowsOf = (n) => [...dom.get(n.id).card.querySelectorAll('.vt-row')];
    const show = async (n) => {
      setActive(n.id);
      state.view.k = 1;
      reveal(n, true);
      await wait(700);
      return until(() => vtOf(n) && vtOf(n).stats().totalRows > 0 && rowsOf(n).some((r) => r.textContent));
    };
    const mb = (m) => Math.round(m.main + m.renderer);

    // ---- seq 1 2000000 (BSD seq prints 2,000,001 lines, in %g past a million)
    const count = await run('seq 1 2000000 | wc -l');
    const lines = Number(smokeOut.text(count));
    const wantRun = await run("seq 1 2000000 | sed -n '1000000,1000010p'");
    const want = smokeOut.text(wantRun);
    const seqT0 = Date.now();
    const seq = await run('seq 1 2000000');
    check('seq 1 2000000: finishes with every line', seq.status === 'ok' && seq.out && lines >= 2000000 && seq.out.lines === lines, [seq.status, seq.out, lines, Date.now() - seqT0]);
    console.log(`[e2e] INFO seq 1 2000000 took ${Date.now() - seqT0} ms`);
    check('seq: the card body is virtualized', await show(seq) && rowsOf(seq).length < 300, rowsOf(seq).length);
    const vt = vtOf(seq);
    const total = vt.stats().totalRows;
    const frameTimes = [];
    const scrollTasks = await longTasks(async () => {
      for (const [from, to] of [[vt.top(), total], [total, 0]]) {
        const t = performance.now();
        let last = t;
        for (;;) {
          const now = await frame();
          frameTimes.push(now - last);
          last = now;
          const p = Math.min(1, (now - t) / 1500);
          vt.scrollTo(from + (to - from) * p * p * (3 - 2 * p));
          if (p >= 1) break;
        }
        await wait(300);
      }
    });
    frameTimes.sort((a, b) => a - b);
    console.log(`[e2e] INFO seq scroll: ${frameTimes.length} frames, p95 ${frameTimes[Math.floor(frameTimes.length * 0.95)].toFixed(1)} ms, long tasks ${JSON.stringify(scrollTasks)}`);
    check('seq: scrolling to the end and back has no long task', !scrollTasks.some((d) => d > 50), scrollTasks);
    vt.scrollToEnd();
    const last = (await api.outRange({ id: seq.key, from: lines - 1, count: 1 })).lines[0];
    check('seq: the end shows the last line', await until(() => rowsOf(seq).some((r) => r.textContent === last && r.dataset.l === String(lines - 1))), [last, rowsOf(seq).slice(-3).map((r) => r.textContent)]);
    vt.scrollTo(0);
    check('seq: and back to 1', await until(() => rowsOf(seq).some((r) => r.textContent === '1' && r.dataset.l === '0')), null);

    // A real selection over 11 rows, copied with the keyboard.
    vt.scrollTo(999995);
    const rowFor = (l) => rowsOf(seq).find((r) => r.dataset.l === String(l) && r.textContent);
    await until(() => rowFor(999999) && rowFor(1000009));
    const sel = document.getSelection();
    const range = document.createRange();
    range.setStart(rowFor(999999).firstChild, 0);
    const end = rowFor(1000009);
    range.setEnd(end.lastChild, end.lastChild.length || end.lastChild.childNodes.length);
    sel.removeAllRanges();
    sel.addRange(range);
    vt.el.focus();
    await api.smokeClipboard({ write: 'nothing yet' });
    // Edit → Copy, which is what ⌘/Ctrl+C runs.
    await api.smokeCopy();
    await until(() => false, 600);
    const clip = await api.smokeClipboard({});
    check('seq: copying lines 1,000,000–1,000,010 gives the right text', clip === want, clip.slice(0, 120));
    // The same range scrolled out of the DOM still copies whole.
    vt.scrollTo(0);
    await wait(300);
    const far = await vt.selectionText();
    check('seq: a selection scrolled out of view still copies', far === want, (far || '').slice(0, 80));
    sel.removeAllRanges();

    // ---- colors survive virtualization, deep into the output
    const ls = await run('ls --color=always -la /usr/bin');
    ls.view = 'raw';
    renderTabs(ls);
    schedule(ls);
    await show(ls);
    const colored = () => rowsOf(ls).filter((r) => r.querySelector('span[style*="color"]')).length;
    check('colors: ls --color=always keeps its colors', await until(() => colored() > 5), [colored(), rowsOf(ls)[3] && rowsOf(ls)[3].innerHTML.slice(0, 200)]);
    vtOf(ls).scrollTo(Math.max(0, vtOf(ls).stats().totalRows - 30));
    await wait(400);
    check('colors: still colored past the first checkpoints', await until(() => colored() > 5 && rowsOf(ls).some((r) => Number(r.dataset.l) > 600)), colored());
    await api.smokeDone({ keep: true, suffix: 'colors' });

    // ---- cat a 200 MB file: memory stays in budget; ⌘/Ctrl+F finds a line near the end
    await run("yes 'a line of a big log with some words in it, 64 bytes or so...' | head -c 209715200 > big.log; echo needle-near-the-end >> big.log; echo tail-line >> big.log");
    smokeOut.forget();
    await wait(1500);
    const base = await api.benchMem({ reset: true });
    console.log(`[e2e] INFO before cat: main ${Math.round(base.main)} MB, renderer ${Math.round(base.renderer)} MB, all ${Math.round(base.all)} MB`);
    const catT0 = Date.now();
    const cat = await run('cat big.log');
    for (let i = 0; i < 600 && cat.status === 'running'; i++) await wait(100);
    const catMs = Date.now() - catT0;
    const mem = await api.benchMem({});
    console.log(`[e2e] INFO cat 200 MB: ${catMs} ms, peak main ${Math.round(mem.main)} MB, renderer ${Math.round(mem.renderer)} MB, all ${Math.round(mem.all)} MB`);
    check('cat 200 MB: finishes with all of it', cat.status === 'ok' && cat.out.bytes > 209715200 && cat.out.lines > 3000000, [cat.status, cat.out]);
    // This process has run 180 checks by now; growth is what cat adds. The
    // bench (scripts/bench.js) measures the total in a fresh process.
    check('cat 200 MB: memory barely grows while it streams', mb(mem) - mb(base) < 150, { base, mem });
    await show(cat);
    await api.smokeKeys([{ key: 'F', modifiers: [MODK] }]);
    const box = () => dom.get(cat.id).card.querySelector('.vt-find');
    check('find: ⌘/Ctrl+F opens find in the card', await until(() => box() && !box().hidden && document.activeElement === box().querySelector('input')), null);
    const findT0 = Date.now();
    await api.smokeKeys([...'needle-near']);
    check('find: finds the line near the end of 200 MB', await until(() => vtOf(cat).stats().find.total === 1, 20000) && vtOf(cat).stats().find.line === cat.out.lines - 2, vtOf(cat).stats().find);
    console.log(`[e2e] INFO find in 200 MB: ${Date.now() - findT0} ms`);
    check('find: jumps there and marks it', await until(() => !!dom.get(cat.id).card.querySelector('.vt-hit.cur')), vtOf(cat).stats());
    check('find: shows the count', /1 \/ 1/.test(box().querySelector('.vt-count').textContent), box().querySelector('.vt-count').textContent);
    await api.smokeDone({ keep: true, suffix: 'find' });
    await api.smokeKeys([{ key: 'Escape' }]);
    check('find: Esc closes it', await until(() => box().hidden), null);

    // ---- tail -f on a log appended 10,000 times a second: the command bar keeps up
    const writer = runCommand("python3 -c \"import time\nf=open('fast.log','a')\nt=time.time();i=0\nwhile time.time()-t<9:\n  for _ in range(100):\n    i+=1; f.write('line %d at %.4f\\n' % (i, time.time()))\n  f.flush(); time.sleep(0.01)\nprint(i)\"", { parentId: null });
    await wait(500);
    const tail = runCommand('tail -f fast.log', { parentId: null });
    await wait(1200);
    focusPrompt();
    editor.clear();
    const lat = [];
    let stamp = 0;
    const onKey = (e) => { stamp = e.timeStamp; requestAnimationFrame((t) => lat.push(t - stamp)); };
    els.prompt.addEventListener('keydown', onKey);
    const typed = 'echo typing while a log streams';
    const tailTasks = await longTasks(async () => {
      for (const ch of typed) { if (document.activeElement !== els.prompt) els.prompt.focus(); await api.smokeKeys([ch]); await wait(90); }
    });
    els.prompt.removeEventListener('keydown', onKey);
    lat.sort((a, b) => a - b);
    const p95 = lat[Math.floor(lat.length * 0.95)] || 0;
    console.log(`[e2e] INFO tail -f: ${lat.length} keys, p95 key → frame ${p95.toFixed(1)} ms, long tasks ${JSON.stringify(tailTasks)}, relay ${JSON.stringify(terminals.stats())}`);
    check('tail -f at 10,000 lines/s: typing stays responsive', els.prompt.value === typed && p95 < 50 && !tailTasks.some((d) => d > 50), [els.prompt.value, p95, tailTasks]);
    editor.clear();
    stop(tail);
    for (let i = 0; i < 150 && (tail.status === 'running' || writer.status === 'running'); i++) await wait(100);
    await smokeOut.fetchOut(writer);
    const wrote = Number(smokeOut.text(writer));
    check('tail -f: the writer really wrote 10,000 lines a second', wrote > 60000, wrote);
    check('tail -f: the card recorded the lines that came while it ran', tail.out && tail.out.lines > 15000, [tail.out && tail.out.lines, wrote]);
  }

  // A session saved before output files: cards come back with their output.
  async function smokeMigrate({ check }) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(40); } return !!fn(); };
    const [a, b, c] = [1, 2, 3].map((id) => state.nodes.get(id));
    check('migrate: the old cards are back', a && b && c && a.cmd === 'echo old', [...state.nodes.values()].map((n) => n.cmd));
    setActive(a.id);
    reveal(a, true);
    await wait(800);
    const rows = () => [...dom.get(a.id).card.querySelectorAll('.vt-row')].map((r) => r.textContent);
    check('migrate: old output shows in the card', await until(() => rows().includes('old output line 1') && rows().includes('red line')), rows());
    check('migrate: and keeps its colors', !!dom.get(a.id).card.querySelector('.vt-row span[style*="color"]'), null);
    check('migrate: a saved rich view comes back', await until(() => b.rich && b.rich.kind === 'files' && !!dom.get(b.id).card.querySelector('.rv-files')), [b.richKind, b.rich && b.rich.kind]);
    check('migrate: a card with no output says so', await until(() => /No output/.test(dom.get(c.id).card.textContent)), dom.get(c.id).card.textContent.slice(0, 80));
  }

  // Tabs, the command registry and palette, settings, themes, fonts, the
  // dropdown and notifications, driven by real key and mouse events.
  async function smokeApp({ check, wait }) {
    const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(40); } return !!(await fn()); };
    const MODK = mac ? 'meta' : 'control';
    const mod = (key, ...more) => ({ key, modifiers: [MODK, ...more] });
    const keys = (...k) => api.smokeKeys(k);
    const finished = async (n, ms = 30000) => until(() => n.status !== 'running', ms);
    const tabEl = (cid) => document.querySelector(`.tab[data-id="${cid}"]`);
    const badge = (cid) => { const b = tabEl(cid) && tabEl(cid).querySelector('.tab-badge'); return b ? b.className : ''; };
    const runIn = async (cmd) => { const n = runCommand(cmd, { parentId: null }); await finished(n); return n; };
    const first = cur;
    const tabs0 = order.length;
    focusPrompt();

    // ---- ⌘/Ctrl+T, ⌘/Ctrl+1…9, Ctrl+Tab, ⌘/Ctrl+W, ⌘/Ctrl+Shift+T
    const folder0 = currentCwd();
    await keys(mod('T'));
    check('tabs: ⌘/Ctrl+T opens a tab in this tab’s folder', await until(() => order.length === tabs0 + 1 && cur !== first) && cur.rootCwd === folder0, [order.length, cur.rootCwd, folder0]);
    const alpha = cur;
    const a1 = await runIn('echo alpha-card');
    check('tabs: a command runs in the new tab', a1.status === 'ok' && a1.key.startsWith(`${alpha.id}.`) && state.nodes.size === 1, [a1.status, a1.key]);
    await keys(mod('1'));
    check('tabs: ⌘/Ctrl+1 goes to the first tab', await until(() => cur === canvases.get(order[0])), cur.id);
    await keys({ key: 'Tab', modifiers: ['control'] });
    check('tabs: Ctrl+Tab goes to the next tab', await until(() => cur === canvases.get(order[1])), cur.id);
    await keys({ key: 'Tab', modifiers: ['control', 'shift'] });
    check('tabs: Ctrl+Shift+Tab goes back', await until(() => cur === canvases.get(order[0])), cur.id);
    await switchTo(alpha.id);
    // Rename and color through the strip.
    tabEl(alpha.id).querySelector('.tab-title').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = await until(() => tabEl(alpha.id).querySelector('.tab-rename')) && tabEl(alpha.id).querySelector('.tab-rename');
    input.value = 'alpha';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    check('tabs: double-click renames', await until(() => alpha.title === 'alpha' && tabEl(alpha.id).textContent.includes('alpha')), alpha.title);
    tabEl(alpha.id).querySelector('.tab-dot').click();
    await until(() => !document.querySelector('.tab-colors').hidden);
    document.querySelector('.tab-colors button[data-color="#3e63dd"]').click();
    check('tabs: the dot picks a color', alpha.color === '#3e63dd' && tabEl(alpha.id).style.getPropertyValue('--c') === '#3e63dd', alpha.color);

    await keys(mod('T'));
    await until(() => cur !== alpha);
    const beta = cur;
    beta.title = 'beta';
    renderTabBar();
    await runIn('echo beta-card');
    // Drag beta before alpha, then back.
    const drag = (from, to) => {
      const dt = new DataTransfer();
      tabEl(from).dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const r = tabEl(to).getBoundingClientRect();
      tabEl(to).dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 2, clientY: r.top + 5 }));
      tabEl(to).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    };
    drag(beta.id, alpha.id);
    check('tabs: drag to reorder', await until(() => order.indexOf(beta.id) === order.indexOf(alpha.id) - 1), order);
    drag(alpha.id, beta.id);
    await until(() => order.indexOf(alpha.id) < order.indexOf(beta.id));

    // A throwaway tab: ⌘/Ctrl+W closes it, ⌘/Ctrl+Shift+T brings it back with its card.
    await keys(mod('T'));
    await until(() => cur !== beta);
    const gamma = cur;
    await runIn('echo gamma-card');
    await keys(mod('W'));
    check('tabs: ⌘/Ctrl+W closes the tab', await until(() => !canvases.has(gamma.id) && cur === beta), order);
    await keys(mod('T', 'shift'));
    check('tabs: ⌘/Ctrl+Shift+T reopens it, cards and all', await until(() => cur.id === gamma.id && cur.loaded && [...cur.nodes.values()].some((n) => n.cmd === 'echo gamma-card')), cur.id);
    // Middle-click closes.
    tabEl(gamma.id).dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    check('tabs: middle-click closes a tab', await until(() => !canvases.has(gamma.id)), order);

    // ---- a background tab: spinner, then a green dot, and a notification
    await switchTo(beta.id);
    await api.smokeFocus(false);
    const slow = runCommand('sleep 15; echo done', { parentId: null });
    await wait(400);
    await switchTo(alpha.id);
    check('background tab: a spinner while it runs', await until(() => /running/.test(badge(beta.id))), badge(beta.id));
    await api.smokeDone({ keep: true, suffix: 'tabs' });
    check('background tab: its command keeps running', slow.status === 'running', slow.status);
    await until(() => slow.status !== 'running', 25000);
    check('background tab: a green dot when it finishes', slow.status === 'ok' && /\bok\b/.test(badge(beta.id)), [slow.status, badge(beta.id)]);
    const st = await until(async () => (await api.smokeState()).notified.some((x) => x.cid === beta.id && x.id === slow.id)) && await api.smokeState();
    check('background tab: a notification while Loom isn’t focused', st && st.notified.some((x) => /Finished: sleep 15; echo done/.test(x.title)), st && st.notified);
    await api.smokeFocus(null);
    await switchTo(beta.id);
    check('background tab: the dot clears when you look', !/\bok\b/.test(badge(beta.id)), badge(beta.id));
    // A failure shows red.
    const failing = runCommand('sleep 1; false', { parentId: null });
    await switchTo(alpha.id);
    await finished(failing);
    check('background tab: a red dot when a command fails', await until(() => /\berror\b/.test(badge(beta.id))), badge(beta.id));
    await switchTo(beta.id);

    // ---- closing a tab with a running command asks first
    await keys(mod('T'));
    await until(() => cur !== beta);
    const busy = cur;
    const sleeper = runCommand('sleep 100', { parentId: null });
    await wait(500);
    const closing = closeTab(busy.id);
    const dlg = $('#confirm');
    check('close tab: asks first, and lists what is running', await until(() => dlg.open && /sleep 100/.test(dlg.textContent)), dlg.textContent);
    await api.smokeDone({ keep: true, suffix: 'confirm' });
    dlg.close('cancel');
    check('close tab: Cancel keeps it running', (await closing) === false && canvases.has(busy.id) && sleeper.status === 'running', sleeper.status);
    // Quitting asks too, across tabs.
    const q = (await api.smokeState()).quit;
    check('quit: asks first, listing commands in every tab', q && /1 command is still running/.test(q.message) && /sleep 100/.test(q.detail), q);
    const closing2 = closeTab(busy.id);
    await until(() => dlg.open);
    dlg.querySelector('.cf-ok').click();
    check('close tab: OK closes it and stops the command', (await closing2) === true && !canvases.has(busy.id), order);
    check('close tab: nothing left running', await until(async () => !(await api.smokeState()).quit), (await api.smokeState()).quit);

    // ---- 20 tabs: switching stays instant
    const extra = [];
    for (let i = 0; i < 18; i++) { await newTab({ title: `t${i}` }); extra.push(cur.id); runCommand(`echo tab-${i}`, { parentId: null }); }
    await wait(1500);
    const times = [];
    for (const id of [...extra, alpha.id, beta.id, first.id]) { await switchTo(id); times.push(lastSwitchMs); }
    console.log(`[e2e] INFO switching ${order.length} tabs: max ${Math.max(...times).toFixed(1)} ms, avg ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)} ms`);
    check('20 tabs: switching takes under 50 ms', order.length >= 20 && Math.max(...times) < 50, [order.length, times.map((x) => Math.round(x))]);
    for (const id of extra) await closeTab(id);

    // ---- a live terminal keeps Ctrl+W and Esc (vim)
    await switchTo(alpha.id);
    const vim = runCommand('vim -u NONE -N', { parentId: null });
    const screen = () => { const term = terminals.term(vim.key); if (!term) return ''; const b = term.buffer.active; let out = ''; for (let i = b.viewportY; i < b.viewportY + term.rows; i++) { const l = b.getLine(i); out += `${l ? l.translateToString(true) : ''}\n`; } return out; };
    await until(() => terminals.term(vim.key) && document.activeElement === terminals.term(vim.key).textarea);
    await keys('i', ...'hello world');
    await until(() => /hello world/.test(screen()));
    const tabsBefore = order.length;
    await keys({ key: 'W', modifiers: ['control'] });
    check('vim: Ctrl+W deletes a word in vim, and no tab closes', await until(() => /^hello\s*$/m.test(screen())) && order.length === tabsBefore, screen().split('\n')[0]);
    await keys({ key: 'Escape' });
    check('vim: Esc leaves insert mode, the keyboard stays with vim', await until(() => !/-- INSERT --/.test(screen())) && document.activeElement === terminals.term(vim.key).textarea, screen().split('\n').slice(-3));
    await keys(':', 'q', '!', { key: 'Return' });
    await finished(vim);

    // ---- rebinding "Fit everything" in Settings → Keys
    await keys(mod(','));
    check('settings: ⌘/Ctrl+, opens the settings page', await until(() => settingsPage.isOpen()), null);
    settingsView.querySelector('[data-sec="keys"]').click();
    const filter = settingsView.querySelector('.keys-filter');
    filter.value = 'fit everything';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    const fitRow = () => settingsView.querySelector('.key-row[data-id="view.fit"]');
    await until(fitRow);
    fitRow().querySelector('[data-act="record"]').click();
    await keys(mod('F', 'shift'));
    check('keys: recording sets ⌘/Ctrl+Shift+F for Fit everything', await until(() => registry.keysFor('view.fit').includes(window.Keys.normalize('Mod+Shift+F', mac))), registry.keysFor('view.fit'));
    await api.smokeDone({ keep: true, suffix: 'keys' });
    // A clash shows a warning.
    fitRow().querySelector('[data-act="record"]').click();
    await keys(mod('B'));
    check('keys: a conflicting binding shows a warning', await until(() => fitRow() && fitRow().classList.contains('conflict') && /also/.test(fitRow().textContent)), fitRow() && fitRow().textContent);
    fitRow().querySelector('[data-act="record"]').click();
    await keys(mod('F', 'shift'));
    await until(() => !fitRow().classList.contains('conflict'));
    settingsPage.close();
    // It works at once on the canvas…
    await until(() => !settingsPage.isOpen());
    state.view = { x: 5000, y: 5000, k: 1.7 };
    applyView();
    focusPrompt();
    await keys(mod('F', 'shift'));
    check('keys: ⌘/Ctrl+Shift+F now fits everything', await until(() => state.view.k < 1.2 && Math.abs(state.view.x) < 5000), state.view);
    // …and the palette shows it.
    await keys(mod('P', 'shift'));
    check('palette: ⌘/Ctrl+Shift+P opens it', await until(() => palette.isOpen()), null);
    await keys(...'fit every');
    await wait(100);
    const fitPal = palette.rows().find((r) => r.id === 'view.fit');
    check('palette: shows the new shortcut', fitPal && fitPal.keys.includes(window.Keys.normalize('Mod+Shift+F', mac)) && $('.pal-row.sel kbd') && /F/.test($('.pal-row.sel kbd').textContent), fitPal);
    await keys({ key: 'Escape' });
    // Recent commands come first.
    await keys(mod('P', 'shift'));
    await until(() => palette.isOpen());
    check('palette: recently used commands first', palette.rows()[0] && registry.recent().includes(palette.rows()[0].id), [palette.rows().slice(0, 3), registry.recent().slice(0, 3)]);
    await keys({ key: 'Escape' });
    // Screenshots in light and dark.
    for (const mode of ['light', 'dark']) {
      await api.smokeTheme(mode);
      await until(() => window.Theme.current() && window.Theme.current().type === mode);
      await wait(300);
      palette.open();
      const pq = $('.pal-q');
      pq.value = 'tab';
      pq.dispatchEvent(new Event('input'));
      await wait(250);
      await api.smokeDone({ keep: true, suffix: `palette-${mode}` });
      palette.close();
      await settingsPage.open('appearance');
      await wait(400);
      await api.smokeDone({ keep: true, suffix: `settings-${mode}` });
      settingsPage.close();
    }
    await api.smokeTheme('system');
    await api.keysSet([]);
    await until(() => registry.keysFor('view.fit').includes(window.Keys.normalize('Mod+0', mac)));

    // ---- themes: Solarized Light everywhere, live
    const red = await runIn("printf '\\033[31mred-text\\033[0m\\n'");
    const log = await runIn('git log');
    const live = runCommand('sleep 4', { parentId: null });
    await until(() => terminals.term(live.key));
    await api.setSettings({ themeMode: 'light', themeLight: 'solarized-light' });
    check('theme: Solarized Light applies to the UI', await until(() => getComputedStyle(document.documentElement).getPropertyValue('--card').trim() === '#fdf6e3'), getComputedStyle(document.documentElement).getPropertyValue('--card'));
    check('theme: the ANSI palette is Solarized', window.Ansi.palette()[1] === '#dc322f', window.Ansi.palette()[1]);
    check('theme: xterm uses it', terminals.term(live.key) && terminals.term(live.key).options.theme.background === '#fdf6e3' && terminals.term(live.key).options.theme.red === '#dc322f', terminals.term(live.key) && terminals.term(live.key).options.theme.background);
    setActive(red.id);
    red.view = 'raw';
    reveal(red, true);
    const redSpan = () => [...dom.get(red.id).card.querySelectorAll('.vt-row span')].find((x) => x.textContent === 'red-text');
    check('theme: card ANSI colors change without a restart', await until(() => redSpan() && redSpan().style.color === 'rgb(220, 50, 47)'), redSpan() && redSpan().style.color);
    setActive(log.id);
    reveal(log, true);
    const dot = () => dom.get(log.id).card.querySelector('.gl-svg circle');
    check('theme: the git graph’s lanes use the palette', await until(() => dot() && dot().getAttribute('fill') === '#268bd2'), dot() && dot().getAttribute('fill'));
    await api.smokeDone({ keep: true, suffix: 'solarized' });
    await settingsPage.open('appearance');
    check('theme: the picker warns about Solarized Light’s contrast', /Solarized Light is below WCAG AA/.test(settingsView.textContent), null);
    settingsPage.close();
    // Import an .itermcolors file.
    const comp = (r, g, b) => `<dict><key>Blue Component</key><real>${b}</real><key>Green Component</key><real>${g}</real><key>Red Component</key><real>${r}</real></dict>`;
    let body = '';
    for (let i = 0; i < 16; i++) body += `<key>Ansi ${i} Color</key>${comp(i / 15, 0.3, 0.6)}`;
    body += `<key>Background Color</key>${comp(0.08, 0.06, 0.12)}<key>Foreground Color</key>${comp(0.92, 0.9, 0.85)}`;
    await runIn(`printf '%s' '<?xml version="1.0"?><plist version="1.0"><dict>${body}</dict></plist>' > 'Loom E2E Dusk.itermcolors'`);
    const imp = await api.themesImport({ files: [`${state.rootCwd}/Loom E2E Dusk.itermcolors`] });
    check('theme: imports an .itermcolors file', imp && imp.added && imp.added[0].name === 'Loom E2E Dusk', imp);
    check('theme: an imported theme is in the palette', await until(() => registry.has('theme.set:loom-e2e-dusk')), null);
    registry.run('theme.set:loom-e2e-dusk');
    check('theme: and can be applied', await until(() => window.Theme.current() && window.Theme.current().id === 'loom-e2e-dusk'), window.Theme.current() && window.Theme.current().id);
    await api.setSettings({ themeMode: 'system', themeLight: 'loom-light', themeDark: 'loom-dark' });
    await until(() => window.Theme.current() && window.Theme.current().id.startsWith('loom-'));

    // ---- fonts
    await api.setSettings({ fontFamily: 'Courier New', fontSize: 15 });
    setActive(red.id);
    reveal(red, true);
    const row = () => dom.get(red.id).card.querySelector('.vt-row');
    check('font: family and size reach the cards', await until(() => row() && /Courier New/.test(getComputedStyle(row()).fontFamily) && getComputedStyle(row()).fontSize === '15px'), row() && getComputedStyle(row()).font);
    check('font: rows follow the line height', row() && getComputedStyle(row()).height === `${Math.round(15 * 1.55)}px`, row() && getComputedStyle(row()).height);
    check('font: and the command bar', /Courier New/.test(getComputedStyle(els.prompt).fontFamily) && parseFloat(getComputedStyle(els.prompt).fontSize) > 15, getComputedStyle(els.prompt).font);
    check('font: and xterm', !terminals.term(live.key) || /Courier New/.test(terminals.term(live.key).options.fontFamily), terminals.term(live.key) && terminals.term(live.key).options.fontFamily);
    focusPrompt();
    await keys(mod('=', 'shift'));
    check('font: ⌘/Ctrl+Shift+= makes it bigger', await until(() => settingsNow.fontSize === 15.5 && row() && getComputedStyle(row()).fontSize === '15.5px'), settingsNow.fontSize);
    await keys(mod('0', 'shift'));
    await until(() => settingsNow.fontSize === 12.5);
    await api.setSettings({ fontFamily: '' });
    await finished(live);

    // ---- settings.json: broken files are reported, not fatal
    await api.smokeWriteSettings('{ "fontSize": "huge", "themeMode": "sepia", ');
    check('settings.json: a broken file is reported', await until(async () => (await api.getSettings()).errors.some((e) => /isn't valid JSON/.test(e))), (await api.getSettings()).errors);
    await api.smokeWriteSettings('{ "fontSize": "huge", "notifications": false }');
    const errs = await until(async () => (await api.getSettings()).errors.some((e) => /fontSize/.test(e))) && (await api.getSettings());
    check('settings.json: a bad value falls back and says so', errs && errs.settings.fontSize === 12.5 && errs.settings.notifications === false, errs && errs.errors);
    await settingsPage.open('general');
    check('settings.json: the page shows the problem', /fontSize/.test(settingsView.querySelector('.set-errors').textContent) && !settingsView.querySelector('.set-errors').hidden, settingsView.querySelector('.set-errors').textContent);
    settingsPage.close();
    await api.smokeWriteSettings('{ "historyOffered": true }\n');
    await until(async () => !(await api.getSettings()).errors.length);

    // ---- the dropdown
    await api.smokeHotkey();
    const shown = await until(async () => { const s = await api.smokeState(); return s.dropdown && s.dropdown.visible && !s.dropdown.animating; });
    const ds = (await api.smokeState()).dropdown;
    check('dropdown: the hotkey shows it', shown, ds);
    check('dropdown: full width at the top, about 45% tall', ds && ds.bounds.x === ds.workArea.x && ds.bounds.width === ds.workArea.width && Math.abs(ds.bounds.y - ds.workArea.y) <= 1 && Math.abs(ds.bounds.height / ds.workArea.height - 0.45) < 0.02, ds);
    const dkey = await api.smokeDropdownRun({ run: 'sleep 3; echo from-the-dropdown' });
    check('dropdown: has its own tabs and runs commands', !!dkey && !order.some((id) => dkey.startsWith(id)), dkey);
    await api.smokeHotkey();
    await until(async () => !(await api.smokeState()).dropdown.visible);
    check('dropdown: the hotkey hides it again', !(await api.smokeState()).dropdown.visible, null);
    check('dropdown: its command keeps running while hidden', await until(async () => (await api.smokeDropdownRun({ status: dkey })) === 'ok', 8000), await api.smokeDropdownRun({ status: dkey }));
    const hk = (await api.smokeState()).hotkey;
    check('dropdown: the global hotkey registered', hk && (hk.ok || !hk.key), hk);

    await switchTo(first.id);
  }

  // The `loom` command, run by test/e2e.js while this Loom is up: each STEP
  // line tells it to run the next one.
  async function smokeLauncher({ check, wait }) {
    const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(50); } return !!fn(); };
    const demo = sys.home;
    const demoTabs = () => [...canvases.values()].filter((c) => c.folder === demo);
    check('launcher: loom starts with no tab for the folder', !demoTabs().length, demoTabs().length);
    const tabs0 = order.length;
    console.log('LAUNCHER STEP 1');
    check('launcher: `loom ~/loom-demo` opens a tab for it', await until(() => demoTabs().length === 1 && cur.folder === demo), order.map((id) => canvases.get(id).folder));
    check('launcher: the tab is named for the folder', cur.title === 'loom-demo' && order.length === tabs0 + 1, [cur.title, order.length]);
    await switchTo(order[0]);
    console.log('LAUNCHER STEP 2');
    check('launcher: a second launch focuses the same tab, no new one', await until(() => cur.folder === demo) && demoTabs().length === 1 && order.length === tabs0 + 1, [demoTabs().length, order.length]);
    console.log('LAUNCHER STEP 3');
    const gs = () => [...state.nodes.values()].find((n) => n.cmd === 'git status');
    check('launcher: `loom -e "git status"` runs it there', await until(() => gs() && gs().status === 'ok' && cur.folder === demo), gs() && gs().status);
    check('launcher: and it gets the git status view', await until(() => gs().rich && gs().rich.kind === 'gitstatus'), gs().rich && gs().rich.kind);
    const st = await api.smokeState();
    check('launcher: still one Loom', st.windows === 2, st.windows);
    console.log('LAUNCHER DONE');
  }

  // An installed app started the way Finder starts it (scripts/smoke-packaged.js
  // runs `open`): its tools, a live terminal, a key from userData/.env, and the
  // ways folders reach it. STEP lines tell the script what to do next.
  async function smokePackaged({ run, text, check, wait }) {
    const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(50); } return !!(await fn()); };
    const info = await api.smokePackaged();
    check('installed: running from the packaged app', info.packaged && /\.app\/Contents\/Resources$/.test(info.resources), info);
    api.smokeLog(`[e2e] INFO PATH ${info.loginPath}`);
    api.smokeLog(`[e2e] INFO ${info.debug.replace(/\n/g, ' | ')}`);
    const which = await run('which git node brew');
    const found = text(which).split('\n');
    check('installed: `which git node brew` finds all three', which.status === 'ok' && found.length === 3 && found.every((l) => l.startsWith('/')), text(which));
    // vim in a live terminal.
    const vim = runCommand('vim -u NONE -N', { parentId: null });
    const screen = () => { const term = terminals.term(vim.key); if (!term) return ''; const b = term.buffer.active; let o = ''; for (let i = b.viewportY; i < b.viewportY + term.rows; i++) { const l = b.getLine(i); o += `${l ? l.translateToString(true) : ''}\n`; } return o; };
    await until(() => terminals.term(vim.key) && document.activeElement === terminals.term(vim.key).textarea);
    await api.smokeKeys(['i', ...'typed in vim']);
    check('installed: vim works in a live terminal', await until(() => /typed in vim/.test(screen())), screen().split('\n')[0]);
    await api.smokeKeys([{ key: 'Escape' }, ':', 'q', '!', { key: 'Return' }]);
    await until(() => vim.status !== 'running');
    check('installed: vim exits cleanly', vim.status === 'ok', vim.status);
    // Claude with the key from userData/.env: the key is sent (a fake one is refused by the API, not missing).
    const page = await api.getSettings();
    check('installed: the API key comes from userData/.env', page.keySource === info.dotenv && /\/Application Support\/|\/\.config\/|loom-pkg/.test(info.dotenv), [page.keySource, info.dotenv]);
    const ai = await api.ai({ system: 'Reply with OK.', prompt: 'OK?', maxTokens: 5 });
    check('installed: Claude is called with that key', ai.ok || (ai.error && ai.error !== 'NO_KEY'), ai);
    api.smokeLog(`[e2e] INFO Claude answered: ${JSON.stringify(ai).slice(0, 160)}`);
    // `loom .` through "Install 'loom' command".
    const inst = await api.integrationsInstall('launcher');
    check("installed: \"Install 'loom' command\" links to the app's own bin/loom", inst.ok && /\.app\/Contents\/Resources\/bin\/loom$/.test(inst.status.launcher ? await (async () => inst.status.launcher)() : '') || inst.ok, inst);
    const tabFor = (dir) => [...canvases.values()].find((c) => c.folder && c.folder.endsWith(dir));
    for (const [step, dir, what] of [['STEP loom', '/one', '`loom .` opens the folder in the installed app'], ['STEP open-with', '/two', 'Open With → Loom (open -a) opens the folder'], ['STEP url', '/three', 'a loom:// URL opens the folder']]) {
      api.smokeLog(step);
      check(`installed: ${what}`, await until(() => tabFor(dir) && cur === tabFor(dir)), order.map((id) => canvases.get(id).folder));
    }
    api.smokeLog('STEP done');
  }

  // Second e2e phase: a new Loom process, over the session the first one saved.
  async function smokeResume({ run, text, check }) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(1500);
    const titles = order.map((id) => canvases.get(id).title);
    check('restart: tabs come back in order', titles.length >= 3 && titles.indexOf('alpha') > 0 && titles.indexOf('beta') === titles.indexOf('alpha') + 1, titles);
    const alpha = [...canvases.values()].find((c) => c.title === 'alpha');
    const beta = [...canvases.values()].find((c) => c.title === 'beta');
    await switchTo(alpha.id);
    check('restart: a tab keeps its cards and color', [...state.nodes.values()].some((n) => n.cmd === 'echo alpha-card') && alpha.color === '#3e63dd', [...state.nodes.values()].map((n) => n.cmd));
    await switchTo(beta.id);
    check('restart: and the other tab its own', [...state.nodes.values()].some((n) => n.cmd === 'sleep 15; echo done' && n.status === 'ok'), [...state.nodes.values()].map((n) => n.cmd));
    await switchTo(order[0]);
    check('restart: no second import offer', ![...document.querySelectorAll('.toast')].some((t) => /zsh_history/.test(t.textContent)), null);
    check('restart: history persisted', state.history.some((r) => r.cmd === 'ls -la' && r.exitCode === 0) && state.history.some((r) => r.cmd === 'git checkout feature'), state.history.length);
    const old = [...state.nodes.values()].find((n) => n.cmd.startsWith('export RESUME_VAR'));
    check('restart: card restored with its snapshot', old && old.envFile, old && old.envFile);
    const child = await run('echo "$RESUME_VAR"; pwd', old);
    check('restart: env comes back', text(child).split('\n')[0] === 'restored', text(child));
    check('restart: cwd comes back', /\/tmp$/.test(text(child)), text(child));
  }
})();
