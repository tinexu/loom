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
  const LINE_H = 19; // card output rows
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

  const state = {
    nodes: new Map(),
    nextId: 1,
    view: { x: 120, y: 90, k: 1 },
    activeId: null,
    rootCwd: sys.home,
    pipeFrom: null,
    mode: 'shell',
    history: [], // records from main.js, oldest first
    suggestion: null,
  };
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
    onChange: (n) => { if (state.nodes.has(n.id)) { updateCard(n); schedule(n); } },
    onOutput: (n) => schedule(n),
    onAlt(n, entered) {
      if (!entered) { terminals.collapse(); return; }
      if (n.id === state.activeId && !n.noExpand) terminals.expand(n);
    },
    onRelease: () => focusPrompt(),
    onPointer: (n) => { if (n.id !== state.activeId) setActive(n.id); showTerm(n, { focus: true }); },
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
    if (!terminals.has(n.id)) terminals.attach(n);
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
    const n = {
      id: state.nextId++, cmd: '', cwd: sys.home, cwdAfter: null, parentId: null, pipeFrom: null,
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
    const live = terminals.isLive(n.id);
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
        api, id: n.id, host: body, lineH: LINE_H,
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
    try { n.out = await api.outInfo(n.id); } finally { n.infoLoading = false; }
    if (n.out && n.out.capped) n.capped = true;
    if (state.nodes.has(n.id)) { updateCard(n); schedule(n); }
  }

  async function loadRich(n) {
    if (n.richLoading) return;
    n.richLoading = true;
    try {
      const rich = await worker.call('restore', { id: n.id, kind: n.richKind, cmd: n.cmd, cwd: n.cwd, cwdAfter: n.cwdAfter });
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
      const pinned = d.mode === 'full' && (terminals.isLive(id) || terminals.isFocused(id) || (d.body && d.body.contains(document.activeElement)));
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
      const need = onScreen || n.justRun || terminals.isLive(id) || terminals.stats().overlay === id || terminals.inAlt(id);
      if (need) {
        n.releaseAt = 0;
        if (!terminals.has(id)) terminals.attach(n);
      } else if (terminals.has(id)) {
        if (!n.releaseAt) { n.releaseAt = now + MODEL_GRACE; setTimeout(scheduleLayout, MODEL_GRACE + 20); }
        else if (now >= n.releaseAt) { n.releaseAt = 0; terminals.release(id); schedule(n); }
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
        const res = await api.outCopy({ id: n.id });
        toast(res && res.truncated ? `Copied the first ${fmtBytes(res.bytes)}. Save output… keeps all of it.` : 'Output copied', { timeout: res && res.truncated ? 5000 : 1600 });
        break;
      }
      case 'save': {
        const res = await api.outSave({ id: n.id, name: n.cmd });
        if (res) toast(`Saved ${fmtBytes(res.bytes).replace(/^0 MB$/, 'output')} to ${tilde(res.path)}`, { timeout: 3000 });
        break;
      }
      case 'open': {
        const err = await api.outOpen({ id: n.id });
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
    api.kill(n.id);
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
    terminals.dispose(n.id);
    VLines.forget(n.id);
    api.forget(n.id);
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
    VLines.forget(n.id);
    running.add(n.id);
    terminals.attach(n, { fresh: true });
    recordStart(n);
    const src = n.pipeFrom != null ? state.nodes.get(n.pipeFrom) : null;
    if (n.pipeFrom != null && !src) { n.pipeFrom = null; syncEdges(n); }
    updateCard(n);
    schedule(n);
    const parent = state.nodes.get(n.parentId);
    api.run({
      id: n.id, command: n.cmd, cwd: n.cwd, stdinFrom: src ? src.id : undefined,
      parentId: parent ? parent.id : null,
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

  api.onExit(async ({ id, code, signal, cwd, envFile, out }) => {
    const n = state.nodes.get(id);
    if (!n) return;
    n.ending = true; // no new terminal model while it finishes
    const ended = await terminals.finish(n, { moved: !!(out && out.moved) });
    if (!state.nodes.has(id)) return;
    // A program that moved the cursor keeps what its screen showed.
    n.out = ended.text != null ? await api.outReplace({ id, text: ended.text }) : out;
    if (!state.nodes.has(id)) return;
    running.delete(id);
    VLines.forget(id);
    const d = dom.get(id);
    if (d && d.vt) { d.vt.destroy(); d.vt = null; }
    n.exitCode = code;
    n.endedAt = Date.now();
    n.cwdAfter = cwd;
    n.envFile = envFile || null;
    n.capped = !!(n.out && n.out.capped) || n.capped;
    n.vtAtEnd = true;
    // 130 is Ctrl+C, typed into the live terminal or sent by Stop.
    n.status = n.killed || signal || code === 130 ? 'killed' : code === 0 ? 'ok' : 'error';
    if (ended.focused) focusPrompt();
    recordEnd(n);
    updateCard(n);
    schedule(n);
    layoutVersion++;
    if (id === state.activeId) { updateComposer(); editor.refreshInfo(); }
    if (n.status === 'ok') {
      try {
        const rich = await worker.call('detect', { id, cmd: n.cmd, cwd: n.cwd, cwdAfter: n.cwdAfter });
        if (rich && state.nodes.has(id) && n.status === 'ok') {
          n.rich = rich;
          n.richKind = rich.kind;
          renderTabs(n);
          schedule(n);
        }
      } catch (err) { console.warn('rich view failed', err); }
    }
    saveSoon();
  });

  api.onCapped(({ id, cap }) => {
    const n = state.nodes.get(id);
    if (!n) return;
    n.capped = true;
    n.capCard = cap;
    toast(`#${id} passed ${fmtBytes(cap)} of output. Loom stopped recording it; the command keeps running.`, { timeout: 6000 });
    updateCard(n);
  });
  api.onEvicted(({ id }) => {
    const n = state.nodes.get(id);
    if (!n) return;
    n.out = { evicted: true, lines: 0, bytes: 0 };
    VLines.forget(id);
    const d = dom.get(id);
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
        if (terminals.inAlt(n.id) && !n.noExpand) terminals.expand(n);
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
  const composerIdle = () => !els.prompt.value.trim() && !state.suggestion && !$('#settings').open && !editor.busy();
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
    const rec = { cmd: n.cmd, cwd: n.cwd, exitCode: null, startedAt: n.startedAt, durationMs: null, rootId: rootOf(n).id, cardId: n.id };
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
    return { cwd: currentCwd(), cardId: a ? a.id : null, envFile: nearestSnapshot(a), rootId: root ? root.id : null };
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
    api.stdin({ id: n.id, data: e.key === 'Enter' ? '\r' : e.key });
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

  els.prompt.addEventListener('keydown', (e) => {
    if (forwardTypeahead(e)) return;
    if (editor.handleKey(e)) return;
    const v = els.prompt.value;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      setMode(state.mode === 'ai' ? 'shell' : 'ai');
      return;
    }
    if (e.key === 'Enter' && !e.isComposing) {
      // Shift+Enter, or an unfinished command (open quote, trailing |, heredoc…), adds a line.
      e.preventDefault();
      if (e.shiftKey || (state.mode === 'shell' && !v.trim().startsWith('?') && ShellLex.isIncomplete(v))) { editor.newline(); return; }
      if (!v.trim()) return;
      editor.clear();
      submit(v);
      return;
    }
    if (e.key === 'Escape') {
      if (state.suggestion) hideSuggestion();
      else if (state.pipeFrom != null) setPipe(null);
      else if (v) editor.clear();
      else els.prompt.blur();
      return;
    }
    if (e.key === 'c' && e.ctrlKey && !e.metaKey && els.prompt.selectionStart === els.prompt.selectionEnd) {
      const a = state.nodes.get(state.activeId);
      if (a && a.status === 'running') { e.preventDefault(); stop(a); }
      else if (v) { e.preventDefault(); editor.clear(); }
      return;
    }
    if (e.key === 'd' && e.ctrlKey && !v) {
      const a = state.nodes.get(state.activeId);
      if (a && a.status === 'running') { e.preventDefault(); api.stdin({ id: a.id, eof: true }); }
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
      const { text: sample } = await api.outHead({ id: src.id, lines: 30 });
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
    const { text: clipped } = await api.outClip({ id: n.id, head: 4000, tail: 8000 });
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

  // ================================================================ settings
  const dlg = $('#settings');
  async function openSettings(note = '') {
    const s = await api.getSettings();
    $('#settings-note').textContent = note;
    $('#settings-note').hidden = !note;
    $('#set-key').value = '';
    $('#set-key').placeholder = s.keyFromEnv ? 'Using ANTHROPIC_API_KEY from the environment' : s.hasKey ? 'Saved · leave blank to keep' : 'sk-ant-…';
    $('#set-key-remove').hidden = !s.hasKey || s.keyFromEnv;
    $('#set-model').value = s.model;
    $('#set-color').checked = s.forceColor;
    $('#set-pager').checked = s.realPager;
    $('#set-cap').value = s.outputCapGB;
    $('#set-total').value = s.outputTotalGB;
    $('#set-shell').textContent = `Shell: ${s.shell}. Keys are stored with your OS keychain encryption when available.`;
    if (!dlg.open) dlg.showModal();
    if (note) $('#set-key').focus();
  }
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'save') return;
    const patch = {
      model: $('#set-model').value, forceColor: $('#set-color').checked, realPager: $('#set-pager').checked,
      outputCapGB: Number($('#set-cap').value), outputTotalGB: Number($('#set-total').value),
    };
    if ($('#set-key').value.trim()) patch.apiKey = $('#set-key').value.trim();
    await api.setSettings(patch);
    toast('Settings saved', { timeout: 1600 });
  });
  $('#set-key-remove').addEventListener('click', async () => {
    await api.setSettings({ apiKey: '' });
    openSettings('Saved key removed.');
  });
  $('#set-import').addEventListener('click', () => { dlg.close('cancel'); importHistory(); });
  $('#set-clear').addEventListener('click', () => {
    if (!window.confirm('Remove every card from the canvas? Running commands will be stopped.')) return;
    for (const n of [...state.nodes.values()]) { if (n.status === 'running') stop(n); unmount(n); dropRich(n); terminals.dispose(n.id); VLines.forget(n.id); api.forget(n.id); }
    state.nodes.clear();
    for (const d of dom.values()) d.card.remove();
    dom.clear();
    kids.clear(); depth.clear(); running.clear(); grid.clear(); inDom.clear();
    for (const key of [...edges.keys()]) dropEdge(key);
    layoutVersion++; treeVersion++;
    state.activeId = null;
    state.pipeFrom = null;
    dlg.close('cancel');
    updateComposer();
    scheduleLayout();
    animateTo({ x: 120, y: 90, k: 1 });
    saveSoon();
  });

  // ================================================================ toolbar, empty state, keys
  $('#btn-map').onclick = () => toggleSidebar();
  $('#btn-newroot').onclick = newRoot;
  $('#btn-fit').onclick = () => fit();
  $('#btn-zoomin').onclick = () => zoomCenter(1.2);
  $('#btn-zoomout').onclick = () => zoomCenter(1 / 1.2);
  els.zoomLabel.onclick = () => { const a = state.nodes.get(state.activeId); if (a) { state.view.k = 1; reveal(a, true); } else animateTo({ ...state.view, k: 1 }); };
  $('#btn-settings').onclick = () => openSettings();
  els.empty.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    if (b.dataset.cmd) runCommand(b.dataset.cmd);
    else ask(b.dataset.ask);
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    // Ctrl+K, Alt+arrows and the like belong to the program in a live terminal.
    if (e.target.closest('.live-term') && !(sys.platform === 'darwin' && e.metaKey)) return;
    const typing = e.target.matches('input, textarea, [contenteditable]');
    if (e.target.closest('.vt') && !mod) return; // the card body's own keys
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); focusPrompt(); return; }
    if (mod && e.key === '0') { e.preventDefault(); fit(); return; }
    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomCenter(1.2); return; }
    if (mod && e.key === '-') { e.preventDefault(); zoomCenter(1 / 1.2); return; }
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); return; }
    if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newRoot(); return; }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
      const inCard = e.target.closest && e.target.closest('.card');
      const n = state.nodes.get(inCard ? Number(inCard.dataset.id) : state.activeId);
      if (findInCard(n)) e.preventDefault();
      return;
    }
    if (e.ctrlKey && !e.metaKey && e.key === 'r' && !typing) { e.preventDefault(); focusPrompt(); editor.openSearch(); return; }
    if (mod && e.key.toLowerCase() === 'i' && !typing) { e.preventDefault(); setMode(state.mode === 'ai' ? 'shell' : 'ai'); return; }
    if (e.altKey && e.key.startsWith('Arrow')) {
      const a = state.nodes.get(state.activeId);
      if (!a) return;
      e.preventDefault();
      let target = null;
      if (e.key === 'ArrowUp') target = state.nodes.get(a.parentId);
      if (e.key === 'ArrowDown') target = childrenOf(a.id)[0];
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const sibs = a.parentId != null ? childrenOf(a.parentId) : [];
        const i = sibs.findIndex((s) => s.id === a.id);
        target = sibs[i + (e.key === 'ArrowRight' ? 1 : -1)];
      }
      if (target) { setActive(target.id); reveal(target); }
      return;
    }
    if (!typing && !mod && (e.key === '/' || (e.key.length === 1 && !e.altKey))) {
      if (dlg.open) return;
      focusPrompt();
      if (e.key === '/') e.preventDefault();
    }
  });

  window.addEventListener('resize', () => scheduleLayout());

  // ================================================================ persistence
  // session.json holds card metadata only; output is already on disk in main.
  // Only cards that changed since the last save are sent, and main writes the
  // file debounced, atomically, and only when it changed.
  const SAVE_FIELDS = ['id', 'cmd', 'cwd', 'cwdAfter', 'parentId', 'pipeFrom', 'x', 'y', 'w', 'bodyH', 'h', 'status', 'exitCode', 'startedAt', 'endedAt', 'view', 'ai', 'collapsed', 'envFile', 'noHistory', 'richKind', 'capped'];
  function nodeMeta(n) {
    const o = {};
    for (const f of SAVE_FIELDS) o[f] = n[f];
    if (o.status === 'running') o.status = 'interrupted';
    if (o.ai && o.ai.loading) o.ai = null;
    if (o.h) o.h = Math.round(o.h);
    return o;
  }
  const sessionMeta = () => ({ nextId: state.nextId, view: state.view, activeId: state.activeId, rootCwd: state.rootCwd, sidebar: !els.sidebar.hidden });
  function serialize() {
    return { v: 2, ...sessionMeta(), nodes: [...state.nodes.values()].map(nodeMeta) };
  }
  const sent = new Map(); // id -> JSON last sent
  let sentMeta = '';
  function saveNow() {
    const patch = { nodes: {} };
    let any = false;
    for (const n of state.nodes.values()) {
      const o = nodeMeta(n);
      const j = JSON.stringify(o);
      if (sent.get(n.id) !== j) { sent.set(n.id, j); patch.nodes[n.id] = o; any = true; }
    }
    for (const id of [...sent.keys()]) if (!state.nodes.has(id)) { sent.delete(id); patch.nodes[id] = null; any = true; }
    const m = sessionMeta();
    const mj = JSON.stringify(m);
    if (mj !== sentMeta) { sentMeta = mj; patch.meta = m; any = true; }
    if (any) api.patchSession(patch);
  }
  const saveSoon = debounce(saveNow, 600);
  window.addEventListener('beforeunload', () => {
    // Commands still running are saved without an exit code.
    for (const n of state.nodes.values()) if (n.histRec) api.historyAdd(n.histRec);
    saveNow();
  });

  // Every card starts as an empty box of its saved size; the ones in view
  // get their insides on the first frames.
  async function restore() {
    const s = await api.loadSession();
    if (!s || (s.v !== 1 && s.v !== 2)) return;
    state.nextId = s.nextId || 1;
    state.view = s.view || state.view;
    // Sessions from before history.jsonl kept a list of plain commands.
    if (Array.isArray(s.history) && !state.history.length) {
      for (const cmd of s.history) if (typeof cmd === 'string') { const r = { cmd, cwd: null, exitCode: null, startedAt: 0 }; state.history.push(r); api.historyAdd(r); }
    }
    state.rootCwd = s.rootCwd || sys.home;
    const list = (s.nodes || []).slice().sort((a, b) => a.id - b.id);
    for (const o of list) {
      const n = { ...o, killed: false, rich: null, out: null };
      delete n.segs;
      if (n.status === 'running') n.status = 'interrupted';
      if (n.h == null) n.h = HEAD_H + Math.min(n.bodyH || 300, 300);
      state.nodes.set(n.id, n);
      addEl(n, false);
    }
    for (const o of list) treeAdd(state.nodes.get(o.id));
    for (const o of list) syncEdges(state.nodes.get(o.id));
    if (s.sidebar) toggleSidebar(true);
    state.activeId = state.nodes.has(s.activeId) ? s.activeId : null;
    for (const n of state.nodes.values()) sent.set(n.id, JSON.stringify(nodeMeta(n)));
    sentMeta = JSON.stringify(sessionMeta());
    markActivePath();
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
  state.history = await api.historyLoad();
  await restore();
  applyView();
  updateComposer();
  scheduleLayout();
  focusPrompt();
  // When the restored cards are first on screen, for the bench.
  let firstPaint = 0;
  let firstPaintPerf = 0;
  requestAnimationFrame(() => requestAnimationFrame(() => { firstPaint = Date.now(); firstPaintPerf = performance.now(); }));
  if (!sys.bench) offerImport();

  if (sys.bench) {
    window.addEventListener('error', (e) => console.log(`ERR ${e.message} @${e.filename && e.filename.split('/').pop()}:${e.lineno}`));
    window.addEventListener('unhandledrejection', (e) => console.log(`REJ ${e.reason && e.reason.stack}`));
    window.LoomBench.run({
      api, sys, state, els, runCommand, applyView, fit, toggleSidebar, focusPrompt,
      clearPrompt: () => editor.clear(),
      firstPaint: () => firstPaint,
      firstPaintPerf: () => firstPaintPerf,
      bodiesReady: () => !mountQueue.length && [...dom.values()].every((d) => d.mode !== 'full' || !d.holding),
      flush: () => { saveNow(); return api.saveSession(serialize()); },
    }).catch((e) => { console.log(`BENCH ${e.stack}`); api.smokeDone(); });
  } else if (sys.smoke) {
    window.addEventListener('error', (e) => console.log(`ERR ${e.message} @${e.filename && e.filename.split('/').pop()}:${e.lineno}`));
    window.addEventListener('unhandledrejection', (e) => console.log(`REJ ${e.reason && e.reason.stack}`));
    runSmoke().catch((e) => { console.log(`SMOKE ${e.stack}`); api.smokeDone(); });
  }


  async function runSmoke() {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const outs = new Map();
    // Big outputs stay in main; the checks on them read ranges.
    const fetchOut = async (n) => { if (!n || (n.out && n.out.bytes > 16 * 1048576)) return; outs.set(n.id, { raw: await api.smokeOut({ id: n.id, raw: true }), plain: await api.smokeOut({ id: n.id }) }); };
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
    api.stdin({ id: reader.id, data: 'typed\n' });
    await done(reader);
    check('stdin reaches the command', text(reader).endsWith('got:typed'), text(reader));
    const eof = runCommand('cat', { parentId: null });
    await wait(700);
    api.stdin({ id: eof.id, data: 'line\n' });
    await wait(200);
    api.stdin({ id: eof.id, eof: true });
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
    await api.saveSession(serialize());
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
      const term = terminals.term(n.id);
      if (!term) return '';
      const b = term.buffer.active;
      let out = '';
      for (let i = b.viewportY; i < b.viewportY + term.rows; i++) { const l = b.getLine(i); out += `${l ? l.translateToString(true) : ''}\n`; }
      return out;
    };
    const keyboardOn = (n) => document.activeElement === (terminals.term(n.id) || {}).textarea;
    const showing = () => [...document.querySelectorAll('.live-term')].filter((e) => !e.hidden && e.offsetParent);

    // ---- vim
    const vim = start('vim README.md');
    check('vim: expands to the overlay', await until(() => terminals.stats().overlay === vim.id), terminals.stats());
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
    check('top: expands if it takes the alternate screen', terminals.inAlt(top.id) === (terminals.stats().overlay === top.id), terminals.stats());
    if (terminals.stats().overlay !== top.id) cardAction(top, 'expand');
    const first = screen(top);
    await wait(2500);
    check('top: redraws live', screen(top) !== first, null);
    const cols0 = terminals.term(top.id).cols;
    await api.smokeResize({ width: 1100, height: 700 });
    check('top: follows the window size', await until(() => terminals.term(top.id).cols !== cols0), [cols0, terminals.term(top.id).cols]);
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
    check('zoom 100%: live terminal over the card', terminals.isLive(top.id), terminals.stats());
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
    check('zoom 40%: snapshot, no stray terminal', !terminals.isLive(top.id) && !showing().length, showing().length);
    check('zoom 40%: the card is a pill with its command and time', dom.get(top.id).mode === 'pill' && /top/.test(dom.get(top.id).card.textContent) && !dom.get(top.id).card.querySelector('.card-body'), [dom.get(top.id).mode, dom.get(top.id).card.textContent.slice(0, 80)]);
    await api.smokeDone({ keep: true, suffix: 'zoom40' });
    state.view = home;
    applyView();
    await wait(400);
    check('zoom back: live again', terminals.isLive(top.id), terminals.stats());
    state.view = { ...home, x: home.x + 50000 };
    applyView();
    await wait(200);
    check('off-screen: snapshot', !terminals.isLive(top.id), terminals.stats());
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
    terminals.term(less.id).input('q'); // the path a keystroke takes out of xterm
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
    check('expand: button opens the overlay', await until(() => terminals.stats().overlay === hold.id), terminals.stats());
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
    const offscreen = many.filter((n) => dom.get(n.id).mode !== 'full' && !terminals.isLive(n.id));
    await wait(1300);
    scheduleLayout();
    await wait(100);
    check('15 running cards: off-screen ones drop their terminal model', offscreen.length > 0 && offscreen.every((n) => !terminals.has(n.id) || dom.get(n.id).mode === 'full'), [offscreen.length, terminals.stats()]);
    setActive(many[0].id);
    reveal(many[0], true);
    await wait(600);
    terminals.show(many[0], { focus: true });
    await wait(150);
    check('15 running cards: an old card comes back when focused', terminals.isLive(many[0].id) && terminals.stats().live <= 8, terminals.stats());
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
    check('history: records cwd, exit code, duration, branch', rec && rec.cwd === lsla.cwd && rec.exitCode === 0 && rec.durationMs >= 0 && rec.rootId === rootOf(lsla).id && rec.cardId === lsla.id, rec);

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
    check('?find big files still asks Claude', await until(() => $('#settings').open && /API key/.test($('#settings-note').textContent)), $('#settings-note').textContent);
    $('#settings').close('cancel');
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
    const last = (await api.outRange({ id: seq.id, from: lines - 1, count: 1 })).lines[0];
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

  // Second e2e phase: a new Loom process, over the session the first one saved.
  async function smokeResume({ run, text, check }) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(1500);
    check('restart: no second import offer', ![...document.querySelectorAll('.toast')].some((t) => /zsh_history/.test(t.textContent)), null);
    check('restart: history persisted', state.history.some((r) => r.cmd === 'ls -la' && r.exitCode === 0) && state.history.some((r) => r.cmd === 'git checkout feature'), state.history.length);
    const old = [...state.nodes.values()].find((n) => n.cmd.startsWith('export RESUME_VAR'));
    check('restart: card restored with its snapshot', old && old.envFile, old && old.envFile);
    const child = await run('echo "$RESUME_VAR"; pwd', old);
    check('restart: env comes back', text(child).split('\n')[0] === 'restored', text(child));
    check('restart: cwd comes back', /\/tmp$/.test(text(child)), text(child));
  }
})();
