'use strict';
// Loom renderer: the canvas, cards, composer, history map and Claude flows.
(async function main() {
  const api = window.loom;
  const { Ansi, Views, ShellLex } = window;
  const $ = (s) => document.querySelector(s);
  const sys = await api.sys();
  document.body.classList.add(`os-${sys.platform}`);
  if (sys.platform !== 'darwin') document.querySelectorAll('.mod-key').forEach((k) => { k.textContent = 'Ctrl'; });

  const CARD_W = 620;
  const GAP_X = 72;
  const GAP_Y = 64;
  const ANCHOR = 23; // x offset of the status dot, where edges attach
  const LIVE_DELAY = 150; // quick commands finish before they'd need a terminal
  const OS_NAME = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[sys.platform] || sys.platform;
  const MOD = sys.platform === 'darwin' ? '⌘' : 'Ctrl+';

  const els = {
    viewport: $('#viewport'), world: $('#world'), cards: $('#cards'), edges: $('#edges'),
    minimap: $('#minimap'), empty: $('#empty'),
    prompt: $('#prompt'), mode: $('#mode'), cwdChip: $('#cwd-chip'), pipeChip: $('#pipe-chip'),
    hint: $('#hint'), suggestion: $('#suggestion'), mirror: $('#prompt-hl'), complete: $('#complete'), hsearch: $('#hsearch'),
    sidebar: $('#sidebar'), tree: $('#map-tree'), search: $('#map-search'), stats: $('#map-stats'),
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
  const dom = new Map(); // node id -> element refs (kept out of the saved state)

  const terminals = window.Terminals.create({
    api,
    layer: $('#live-layer'),
    overlay: $('#term-overlay'),
    slot: $('#term-slot'),
    rect: cardBodyRect,
    onChange: (n) => { updateCard(n); schedule(n); },
    onOutput: (n) => schedule(n),
    onAlt(n, entered) {
      if (!entered) { terminals.collapse(); return; }
      if (n.id === state.activeId && !n.noExpand) terminals.expand(n);
    },
    onRelease: () => focusPrompt(),
    onPointer: (n) => { if (n.id !== state.activeId) setActive(n.id); terminals.show(n, { focus: true }); },
  });

  // Where a card's body is on screen, for the live terminal laid over it.
  function cardBodyRect(n) {
    const d = dom.get(n.id);
    if (!d) return null;
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
  const stdoutOf = (n) => n.segs.filter((s) => s[0] === 0).map((s) => s[1]).join('');
  const allOutput = (n) => n.segs.map((s) => s[1]).join('');
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

  const ICON = {
    stop: '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/></svg>',
    rerun: '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5v3h-3"/></svg>',
    branch: '<svg viewBox="0 0 16 16"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-6.2 4.3"/></svg>',
    pipe: '<svg viewBox="0 0 16 16"><path d="M8 2v12M5 11l3 3 3-3"/></svg>',
    spark: '<svg viewBox="0 0 16 16"><path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" fill="currentColor" stroke="none"/></svg>',
    copy: '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5"/></svg>',
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

  // ================================================================ cards
  function makeNode(props) {
    const n = {
      id: state.nextId++, cmd: '', cwd: sys.home, cwdAfter: null, parentId: null, pipeFrom: null,
      x: 0, y: 0, w: CARD_W, bodyH: 300, status: 'running', exitCode: null, segs: [],
      startedAt: Date.now(), endedAt: null, rich: null, view: 'rich', ai: null, collapsed: false,
      showAll: false, killed: false, envFile: null,
      ...props,
    };
    state.nodes.set(n.id, n);
    buildCard(n);
    return n;
  }

  function buildCard(n) {
    const c = document.createElement('div');
    c.className = 'card';
    c.dataset.id = n.id;
    c.innerHTML = `
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
          <button data-act="delete" title="Remove card">${ICON.close}</button>
        </div>
      </div>
      <div class="card-sub"><span class="card-cwd"></span><span class="card-tabs"></span></div>
      <div class="card-body"></div>
      <div class="card-ai" hidden></div>
      <div class="card-resize" title="Drag to resize"></div>`;
    const q = (s) => c.querySelector(s);
    dom.set(n.id, {
      card: c, id: q('.card-id'), cmd: q('.card-cmd'), meta: q('.card-meta'), cwd: q('.card-cwd'),
      tabs: q('.card-tabs'), body: q('.card-body'), ai: q('.card-ai'),
      richFor: null,
    });
    els.cards.append(c);
    updateCard(n);
    schedule(n);
  }

  function updateCard(n) {
    const d = dom.get(n.id);
    if (!d) return;
    const c = d.card;
    const live = terminals.isLive(n.id);
    c.className = `card s-${n.status}${n.id === state.activeId ? ' active' : ''}${n.collapsed ? ' collapsed' : ''}${n.pipeFrom != null ? ' piped' : ''}${live ? ' has-live' : ''}`;
    c.style.left = `${n.x}px`;
    c.style.top = `${n.y}px`;
    c.style.width = `${n.w}px`;
    d.body.style.maxHeight = `${n.bodyH}px`;
    d.body.style.height = live ? `${n.bodyH}px` : '';
    d.id.textContent = `#${n.id}`;
    d.cmd.textContent = n.cmd;
    d.cmd.title = n.cmd;
    const tp = tilde(n.cwd).split('/');
    d.cwd.textContent = tp.length > 5 ? `…/${tp.slice(-3).join('/')}` : tp.join('/');
    d.cwd.title = n.cwd;
    d.meta.textContent = metaText(n);
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

  function renderTabs(n) {
    const d = dom.get(n.id);
    d.tabs.textContent = '';
    if (!n.rich) return;
    for (const [key, label] of [['rich', Views.LABELS[n.rich.kind]], ['raw', 'Raw']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = n.view === key ? 'on' : '';
      b.onclick = (e) => { e.stopPropagation(); n.view = key; renderTabs(n); schedule(n); saveSoon(); };
      d.tabs.append(b);
    }
  }

  function tailSegs(segs, max) {
    let lines = 0;
    const out = [];
    for (let i = segs.length - 1; i >= 0; i--) {
      const [s, t] = segs[i];
      const count = (t.match(/\n/g) || []).length;
      if (lines + count <= max) { out.unshift(segs[i]); lines += count; continue; }
      const parts = t.split('\n');
      const keep = max - lines;
      out.unshift([s, parts.slice(parts.length - keep - 1).join('\n')]);
      let hidden = parts.length - keep - 1;
      for (let j = 0; j < i; j++) hidden += (segs[j][1].match(/\n/g) || []).length;
      return { segs: out, hidden };
    }
    return { segs: out, hidden: 0 };
  }

  function ctxFor(n) {
    return {
      cwd: n.cwdAfter || n.cwd,
      tilde,
      runChild: (cmd) => runCommand(cmd, { parentId: n.id }),
      openPath: async (p) => { const err = await api.openPath(p); if (err) toast(`Couldn't open: ${err}`, { kind: 'err' }); },
    };
  }

  function renderBody(n) {
    const d = dom.get(n.id);
    if (!d) return;
    const body = d.body;
    if (n.rich && n.view === 'rich') {
      if (d.richFor !== n.rich) {
        body.className = 'card-body rich';
        body.replaceChildren(Views.render(n.rich, ctxFor(n)));
        d.richFor = n.rich;
      }
      return;
    }
    d.richFor = null;
    if (n.status === 'running' && terminals.refresh(n, () => schedule(n))) {
      body.className = 'card-body raw';
      body.textContent = '';
      return;
    }
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    body.className = 'card-body raw';
    if (!n.segs.length) {
      body.innerHTML = n.status === 'running'
        ? '<div class="placeholder running"><span></span><span></span><span></span></div>'
        : `<div class="placeholder">${n.status === 'interrupted' ? 'Interrupted when Loom closed' : 'No output'}</div>`;
      return;
    }
    const { segs, hidden } = n.showAll ? { segs: n.segs, hidden: 0 } : tailSegs(n.segs, 2000);
    let html = hidden ? `<button class="show-all" data-act="showall">${hidden.toLocaleString()} earlier lines hidden · show all</button>` : '';
    html += '<pre>';
    for (const [s, t] of segs) html += s ? `<span class="stderr">${Ansi.toHtml(t)}</span>` : Ansi.toHtml(t);
    html += '</pre>';
    body.innerHTML = html;
    if (atBottom || n.status === 'running') body.scrollTop = body.scrollHeight;
  }

  function renderAi(n) {
    const d = dom.get(n.id);
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
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const id of dirty) { const n = state.nodes.get(id); if (n) renderBody(n); }
      dirty.clear();
      pushDown();
      terminals.layout();
      drawEdges();
      drawMinimap();
      renderTreeSoon();
      els.empty.hidden = state.nodes.size > 0;
    });
  }

  const heightCache = new Map();
  const h = (n) => {
    const d = dom.get(n.id);
    const v = d ? d.card.offsetHeight : 0;
    return v || heightCache.get(n.id) || 120;
  };

  function childMap() {
    const m = new Map();
    for (const n of state.nodes.values()) {
      if (n.parentId == null || !state.nodes.has(n.parentId)) continue;
      if (!m.has(n.parentId)) m.set(n.parentId, []);
      m.get(n.parentId).push(n);
    }
    for (const list of m.values()) list.sort((a, b) => a.id - b.id);
    return m;
  }
  const childrenOf = (id) => childMap().get(id) || [];
  function subtree(id, cm = childMap()) {
    const out = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      out.push(cur);
      for (const c of cm.get(cur) || []) stack.push(c.id);
    }
    return out;
  }

  // Cards grow as output streams in; keep children from being covered.
  let dragging = null;
  function pushDown() {
    const cm = childMap();
    for (const n of state.nodes.values()) {
      const bottom = n.y + h(n);
      for (const c of cm.get(n.id) || []) {
        if (dragging && dragging.ids.includes(c.id)) continue;
        if (c.y >= n.y && c.y < bottom + 36) {
          const dy = bottom + GAP_Y - c.y;
          for (const id of subtree(c.id, cm)) {
            const m = state.nodes.get(id);
            m.y += dy;
            const d = dom.get(id);
            if (d) d.card.style.top = `${m.y}px`;
          }
        }
      }
    }
  }

  function bounds(includeViewport = false) {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const n of state.nodes.values()) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + h(n));
    }
    if (includeViewport) {
      const r = viewRectWorld();
      minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
    }
    return minX === Infinity ? null : { minX, minY, maxX, maxY };
  }

  function placeNode(n, parent) {
    if (!parent) {
      const b = bounds();
      n.x = b ? b.maxX + 160 : 0;
      n.y = b ? b.minY : 0;
      updateCard(n);
      return;
    }
    const cm = childMap();
    const sibs = (cm.get(parent.id) || []).filter((c) => c.id !== n.id);
    n.y = parent.y + h(parent) + GAP_Y;
    if (!sibs.length) n.x = parent.x;
    else {
      let maxX = -Infinity;
      for (const s of sibs) for (const id of subtree(s.id, cm)) { const m = state.nodes.get(id); maxX = Math.max(maxX, m.x + m.w); }
      n.x = maxX + GAP_X;
    }
    const hits = () => [...state.nodes.values()].some((m) => m.id !== n.id
      && n.x < m.x + m.w + 24 && n.x + n.w + 24 > m.x && n.y < m.y + h(m) + 24 && n.y + 160 > m.y);
    for (let i = 0; i < 60 && hits(); i++) n.x += 80;
    updateCard(n);
  }

  // ================================================================ edges
  function activePath() {
    const set = new Set();
    let cur = state.nodes.get(state.activeId);
    while (cur && !set.has(cur.id)) { set.add(cur.id); cur = state.nodes.get(cur.parentId); }
    return set;
  }

  function drawEdges() {
    const path = activePath();
    let s = '';
    let labels = '';
    for (const n of state.nodes.values()) {
      for (const [fromId, pipe] of [[n.parentId, false], [n.pipeFrom, true]]) {
        if (fromId == null) continue;
        if (!pipe && n.pipeFrom === fromId) continue; // drawn as the pipe edge
        const a = state.nodes.get(fromId);
        if (!a) continue;
        const x1 = a.x + ANCHOR; const y1 = a.y + h(a);
        const x2 = n.x + ANCHOR; const y2 = n.y;
        const dy = Math.max(28, Math.abs(y2 - y1) / 2);
        const on = path.has(n.id) && path.has(a.id);
        s += `<path class="edge${pipe ? ' pipe' : ''}${on ? ' on' : ''}" d="M${x1} ${y1} C${x1} ${y1 + dy} ${x2} ${y2 - dy} ${x2} ${y2}"/>`;
        if (pipe) {
          const mx = (x1 + x2) / 2; const my = (y1 + y2) / 2;
          labels += `<g class="pipe-label" transform="translate(${mx} ${my})"><circle r="10"/><text y="4">|</text></g>`;
        }
      }
    }
    els.edges.innerHTML = s + labels;
  }

  // ================================================================ viewport
  function applyView() {
    const { x, y, k } = state.view;
    els.world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    els.viewport.style.backgroundPosition = `${x}px ${y}px`;
    els.viewport.style.backgroundSize = `${22 * k}px ${22 * k}px`;
    els.zoomLabel.textContent = `${Math.round(k * 100)}%`;
    els.viewport.classList.toggle('far', k < 0.55);
    terminals.layout();
    drawMinimap();
    saveSoon();
  }
  function viewRectWorld() {
    const r = els.viewport.getBoundingClientRect();
    const { x, y, k } = state.view;
    return { x: -x / k, y: -y / k, w: r.width / k, h: r.height / k };
  }
  function zoomAt(cx, cy, factor) {
    const r = els.viewport.getBoundingClientRect();
    const px = cx - r.left; const py = cy - r.top;
    const { x, y, k } = state.view;
    const k2 = clamp(k * factor, 0.15, 2.5);
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

  function fit() {
    const b = bounds();
    if (!b) { animateTo({ x: 120, y: 90, k: 1 }); return; }
    const r = els.viewport.getBoundingClientRect();
    const availW = r.width - 120; const availH = r.height - 220;
    const k = clamp(Math.min(availW / (b.maxX - b.minX), availH / (b.maxY - b.minY), 1.1), 0.15, 1.1);
    animateTo({
      k,
      x: (r.width - (b.maxX - b.minX) * k) / 2 - b.minX * k,
      y: 70 + (availH - (b.maxY - b.minY) * k) / 2 - b.minY * k,
    });
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
    const onCanvas = e.target === els.viewport || e.target === els.world || e.target === els.cards || e.target === els.edges || e.target.closest('#edges');
    if (!(onCanvas || e.button === 1)) return;
    e.preventDefault();
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
    const sc = e.target.closest('.card-body, .rv-table-wrap, .card-ai');
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
    if (n.status === 'running' && e.target.closest('.card-body')) terminals.show(n, { focus: true });

    const resize = e.target.closest('.card-resize');
    const head = e.target.closest('.card-head');
    if (!resize && !(head && !e.target.closest('button'))) return;
    e.preventDefault();
    card.setPointerCapture(e.pointerId);
    const k = state.view.k;
    const sx = e.clientX; const sy = e.clientY;
    let move;
    if (resize) {
      const w0 = n.w; const b0 = n.bodyH;
      move = (ev) => {
        n.w = clamp(w0 + (ev.clientX - sx) / k, 360, 1600);
        n.bodyH = clamp(b0 + (ev.clientY - sy) / k, 80, 1600);
        updateCard(n);
        scheduleLayout();
      };
    } else {
      const ids = e.shiftKey ? subtree(n.id) : [n.id];
      const origin = ids.map((id) => { const m = state.nodes.get(id); return [m, m.x, m.y]; });
      dragging = { ids };
      card.classList.add('dragging');
      move = (ev) => {
        const dx = (ev.clientX - sx) / k; const dy = (ev.clientY - sy) / k;
        for (const [m, x0, y0] of origin) {
          m.x = Math.round(x0 + dx); m.y = Math.round(y0 + dy);
          const d = dom.get(m.id);
          d.card.style.left = `${m.x}px`; d.card.style.top = `${m.y}px`;
        }
        terminals.layout();
        drawEdges();
        drawMinimap();
      };
    }
    const up = () => {
      dragging = null;
      card.classList.remove('dragging');
      card.removeEventListener('pointermove', move);
      card.removeEventListener('pointerup', up);
      card.removeEventListener('pointercancel', up);
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

  function cardAction(n, act) {
    switch (act) {
      case 'stop': stop(n); break;
      case 'expand': n.noExpand = false; terminals.expand(n); break;
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
      case 'copy':
        navigator.clipboard.writeText(Ansi.strip(allOutput(n))).then(() => toast('Output copied', { timeout: 1600 }));
        break;
      case 'delete': removeNode(n); break;
      case 'showall': n.showAll = true; schedule(n); break;
      default:
    }
  }

  function stop(n) {
    if (n.status !== 'running') return;
    n.killed = true;
    api.kill(n.id);
  }

  function removeNode(n) {
    if (n.status === 'running') stop(n);
    for (const m of state.nodes.values()) {
      if (m.parentId === n.id) m.parentId = n.parentId;
      if (m.pipeFrom === n.id) m.pipeFrom = null;
    }
    if (state.pipeFrom === n.id) setPipe(null);
    state.nodes.delete(n.id);
    terminals.dispose(n.id);
    api.forget(n.id);
    dom.get(n.id).card.remove();
    dom.delete(n.id);
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
    Object.assign(n, {
      status: 'running', segs: [], rich: null, ai: null, exitCode: null,
      startedAt: Date.now(), endedAt: null, killed: false, showAll: false, view: 'rich', envFile: null,
      noExpand: false,
    });
    terminals.attach(n);
    recordStart(n);
    const src = n.pipeFrom != null ? state.nodes.get(n.pipeFrom) : null;
    if (n.pipeFrom != null && !src) n.pipeFrom = null;
    if (src) terminals.snapshotNow(src);
    updateCard(n);
    schedule(n);
    const parent = state.nodes.get(n.parentId);
    api.run({
      id: n.id, command: n.cmd, cwd: n.cwd, stdin: src ? Ansi.strip(stdoutOf(src)) : undefined,
      parentId: parent ? parent.id : null,
      fork: !!parent && childrenOf(parent.id).some((c) => c.id !== n.id),
      envFile: nearestSnapshot(parent),
    });
  }

  // A parent that's still running (or was interrupted) has no snapshot yet.
  function nearestSnapshot(n) {
    while (n && !n.envFile) n = state.nodes.get(n.parentId);
    return n ? n.envFile : null;
  }

  api.onData(({ id, chunks }) => {
    const n = state.nodes.get(id);
    if (!n) return;
    for (const [, t] of chunks) terminals.write(n, t);
  });

  api.onExit(async ({ id, code, signal, cwd, envFile }) => {
    const n = state.nodes.get(id);
    if (!n) return;
    const ended = await terminals.finish(n);
    if (!state.nodes.has(id)) return;
    n.segs = ended && ended.text ? [[0, ended.text]] : [];
    n.exitCode = code;
    n.endedAt = Date.now();
    n.cwdAfter = cwd;
    n.envFile = envFile || null;
    // 130 is Ctrl+C, typed into the live terminal or sent by Stop.
    n.status = n.killed || signal || code === 130 ? 'killed' : code === 0 ? 'ok' : 'error';
    if (ended && ended.focused) focusPrompt();
    recordEnd(n);
    updateCard(n);
    schedule(n);
    if (id === state.activeId) { updateComposer(); editor.refreshInfo(); }
    if (n.status === 'ok') {
      try {
        const rich = await Views.detect(n, api, stdoutOf(n));
        if (rich && state.nodes.has(id) && n.status === 'ok') {
          n.rich = rich;
          renderTabs(n);
          schedule(n);
        }
      } catch (err) { console.warn('rich view failed', err); }
    }
    saveSoon();
  });

  setInterval(() => {
    for (const n of state.nodes.values()) {
      if (n.status === 'running') dom.get(n.id).meta.textContent = metaText(n);
    }
  }, 500);

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
        terminals.show(n, { focus: takeKeyboard && composerIdle() });
        if (terminals.inAlt(n.id) && !n.noExpand) terminals.expand(n);
      }, LIVE_DELAY);
    }
    updateComposer();
    drawEdges();
    renderTreeSoon();
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
      const sample = Ansi.strip(stdoutOf(src)).split('\n').slice(0, 30).join('\n');
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
    const out = Ansi.strip(allOutput(n));
    const clipped = out.length > 14000 ? `${out.slice(0, 4000)}\n…[${out.length - 12000} characters omitted]…\n${out.slice(-8000)}` : out;
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
  function renderTree() {
    const q = els.search.value.trim().toLowerCase();
    const tree = els.tree;
    tree.textContent = '';
    const cm = childMap();
    const row = (n, depth, fork) => {
      const r = document.createElement('button');
      r.className = `tr-row s-${n.status}${n.id === state.activeId ? ' active' : ''}${fork ? ' fork' : ''}`;
      r.style.setProperty('--depth', depth);
      r.innerHTML = '<span class="tr-dot"></span>';
      const c = document.createElement('span');
      c.className = 'tr-cmd';
      c.textContent = n.cmd;
      const t = document.createElement('span');
      t.className = 'tr-time';
      t.textContent = fmtAgo(n.startedAt);
      r.append(c, t);
      r.title = `#${n.id} · ${tilde(n.cwd)}\n${n.cmd}`;
      r.onclick = () => { setActive(n.id); reveal(n, true); };
      tree.append(r);
    };
    const all = [...state.nodes.values()];
    if (q) {
      all.filter((n) => n.cmd.toLowerCase().includes(q)).sort((a, b) => b.id - a.id).forEach((n) => row(n, 0, false));
    } else {
      const roots = all.filter((n) => n.parentId == null || !state.nodes.has(n.parentId)).sort((a, b) => a.id - b.id);
      // Main line continues at the same depth; extra branches indent where they fork.
      const stack = roots.reverse().map((n) => [n, 0]);
      while (stack.length) {
        const [n, depth] = stack.pop();
        const kids = cm.get(n.id) || [];
        row(n, depth, kids.length > 1);
        if (kids[0]) stack.push([kids[0], depth]);
        for (let i = kids.length - 1; i >= 1; i--) stack.push([kids[i], depth + 1]);
      }
    }
    if (!all.length) tree.innerHTML = '<div class="tr-empty">Commands you run show up here as a map of branches.</div>';
    const failed = all.filter((n) => n.status === 'error').length;
    const forks = [...cm.values()].filter((l) => l.length > 1).length;
    els.stats.textContent = `${all.length} commands · ${forks} forks · ${failed} failed`;
  }
  const renderTreeSoon = debounce(() => { if (!els.sidebar.hidden) renderTree(); }, 120);
  els.search.addEventListener('input', renderTree);

  function toggleSidebar(force) {
    els.sidebar.hidden = force != null ? !force : !els.sidebar.hidden;
    document.body.classList.toggle('with-sidebar', !els.sidebar.hidden);
    if (!els.sidebar.hidden) renderTree();
    saveSoon();
  }

  // ================================================================ minimap
  let mm = null;
  function drawMinimap() {
    const cv = els.minimap;
    cv.hidden = state.nodes.size === 0;
    if (cv.hidden) return;
    const dpr = window.devicePixelRatio || 1;
    const W = 220; const H = 140;
    if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const b = bounds(true);
    const pad = 10;
    const s = Math.min((W - pad * 2) / (b.maxX - b.minX), (H - pad * 2) / (b.maxY - b.minY));
    const ox = pad + ((W - pad * 2) - (b.maxX - b.minX) * s) / 2 - b.minX * s;
    const oy = pad + ((H - pad * 2) - (b.maxY - b.minY) * s) / 2 - b.minY * s;
    mm = { s, ox, oy };
    const css = getComputedStyle(document.body);
    const col = {
      ok: css.getPropertyValue('--mm-ok'), error: css.getPropertyValue('--err'),
      running: css.getPropertyValue('--accent'), other: css.getPropertyValue('--mm-ok'),
    };
    for (const n of state.nodes.values()) {
      g.fillStyle = col[n.status] || col.other;
      g.globalAlpha = n.id === state.activeId ? 1 : 0.7;
      g.fillRect(ox + n.x * s, oy + n.y * s, Math.max(2, n.w * s), Math.max(2, h(n) * s));
    }
    g.globalAlpha = 1;
    const r = viewRectWorld();
    g.strokeStyle = css.getPropertyValue('--mm-view');
    g.lineWidth = 1;
    g.strokeRect(ox + r.x * s + 0.5, oy + r.y * s + 0.5, r.w * s, r.h * s);
  }
  els.minimap.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    const go = (ev) => {
      if (!mm) return;
      const rect = els.minimap.getBoundingClientRect();
      const wx = (ev.clientX - rect.left - mm.ox) / mm.s;
      const wy = (ev.clientY - rect.top - mm.oy) / mm.s;
      const vr = els.viewport.getBoundingClientRect();
      state.view.x = vr.width / 2 - wx * state.view.k;
      state.view.y = vr.height / 2 - wy * state.view.k;
      applyView();
    };
    go(e);
    els.minimap.setPointerCapture(e.pointerId);
    const up = () => { els.minimap.removeEventListener('pointermove', go); els.minimap.removeEventListener('pointerup', up); };
    els.minimap.addEventListener('pointermove', go);
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
    $('#set-shell').textContent = `Shell: ${s.shell}. Keys are stored with your OS keychain encryption when available.`;
    if (!dlg.open) dlg.showModal();
    if (note) $('#set-key').focus();
  }
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'save') return;
    const patch = { model: $('#set-model').value, forceColor: $('#set-color').checked, realPager: $('#set-pager').checked };
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
    for (const n of [...state.nodes.values()]) { if (n.status === 'running') stop(n); terminals.dispose(n.id); api.forget(n.id); }
    state.nodes.clear();
    for (const d of dom.values()) d.card.remove();
    dom.clear();
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
  $('#btn-fit').onclick = fit;
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
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); focusPrompt(); return; }
    if (mod && e.key === '0') { e.preventDefault(); fit(); return; }
    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomCenter(1.2); return; }
    if (mod && e.key === '-') { e.preventDefault(); zoomCenter(1 / 1.2); return; }
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); return; }
    if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newRoot(); return; }
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

  window.addEventListener('resize', () => { drawMinimap(); });

  // ================================================================ persistence
  const SAVE_FIELDS = ['id', 'cmd', 'cwd', 'cwdAfter', 'parentId', 'pipeFrom', 'x', 'y', 'w', 'bodyH', 'status', 'exitCode', 'startedAt', 'endedAt', 'view', 'ai', 'collapsed', 'envFile', 'noHistory'];
  function serialize() {
    const nodes = [...state.nodes.values()].map((n) => {
      if (n.status === 'running') terminals.snapshotNow(n);
      const o = {};
      for (const f of SAVE_FIELDS) o[f] = n[f];
      if (o.status === 'running') o.status = 'interrupted';
      if (o.ai && o.ai.loading) o.ai = null;
      // keep the tail of the output (≈200 KB per card)
      let budget = 200 * 1024;
      const segs = [];
      for (let i = n.segs.length - 1; i >= 0 && budget > 0; i--) {
        const t = n.segs[i][1];
        segs.unshift([n.segs[i][0], t.length > budget ? t.slice(-budget) : t]);
        budget -= t.length;
      }
      o.segs = segs;
      const rich = n.rich && JSON.stringify(n.rich);
      o.rich = rich && rich.length < 400 * 1024 ? n.rich : null;
      return o;
    });
    return {
      v: 1, nextId: state.nextId, view: state.view, activeId: state.activeId, rootCwd: state.rootCwd,
      sidebar: !els.sidebar.hidden, nodes,
    };
  }
  const saveSoon = debounce(() => api.saveSession(serialize()), 800);
  window.addEventListener('beforeunload', () => {
    // Commands still running are saved without an exit code.
    for (const n of state.nodes.values()) if (n.histRec) api.historyAdd(n.histRec);
    api.saveSession(serialize());
  });

  async function restore() {
    const s = await api.loadSession();
    if (!s || s.v !== 1) return;
    state.nextId = s.nextId || 1;
    state.view = s.view || state.view;
    // Sessions from before history.jsonl kept a list of plain commands.
    if (Array.isArray(s.history) && !state.history.length) {
      for (const cmd of s.history) if (typeof cmd === 'string') { const r = { cmd, cwd: null, exitCode: null, startedAt: 0 }; state.history.push(r); api.historyAdd(r); }
    }
    state.rootCwd = s.rootCwd || sys.home;
    for (const o of s.nodes || []) {
      const n = { ...o, killed: false, showAll: false, segs: o.segs || [] };
      if (n.status === 'running') n.status = 'interrupted';
      state.nodes.set(n.id, n);
      buildCard(n);
    }
    if (s.sidebar) toggleSidebar(true);
    state.activeId = state.nodes.has(s.activeId) ? s.activeId : null;
    for (const n of state.nodes.values()) updateCard(n);
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
  state.history = await api.historyLoad();
  await restore();
  applyView();
  updateComposer();
  scheduleLayout();
  focusPrompt();
  offerImport();

  if (sys.smoke) {
    window.addEventListener('error', (e) => console.log(`ERR ${e.message} @${e.lineno}`));
    window.addEventListener('unhandledrejection', (e) => console.log(`REJ ${e.reason && e.reason.stack}`));
    runSmoke().catch((e) => { console.log(`SMOKE ${e.stack}`); api.smokeDone(); });
  }

  async function runSmoke() {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const done = async (n) => { for (let i = 0; i < 300 && n && n.status === 'running'; i++) await wait(100); await wait(250); };
    const results = [];
    const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: JSON.stringify(detail) });
    const text = (n) => Ansi.strip(allOutput(n)).trim();
    const run = async (cmd, parent = null, opts = {}) => {
      const n = runCommand(cmd, { parentId: parent ? parent.id : null, ...opts });
      await done(n);
      return n;
    };
    if (sys.smokeResume) { await smokeResume({ run, text, check }); await api.smokeReport(results); api.smokeDone(); return; }

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
    check('no carriage returns in output', !stdoutOf(csv).includes('\r'), JSON.stringify(stdoutOf(csv).slice(0, 40)));

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
    check('large output arrives whole', stdoutOf(big).split('\n').length === 200001 && text(big).endsWith('200000'), stdoutOf(big).length);
    const bare = await run('printf partial');
    check('output with no newline', allOutput(bare) === 'partial', allOutput(bare));
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
    const leak = [...state.nodes.values()].filter((n) => /LEAK|__loom|source '|133;/.test(text(n)));
    check('no prompt or hook text on any card', !leak.length, leak.map((n) => [n.cmd, allOutput(n).slice(0, 200)]));

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
    check('zoom 40%: card shows the text', /PID/.test(dom.get(top.id).body.textContent), dom.get(top.id).body.textContent.slice(0, 80));
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
    check('read -s: not on the card or in the session', !JSON.stringify(serialize()).includes(CANARY), null);
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
    check('tabs survive for rich views', tsv.rich && tsv.rich.kind === 'table' && stdoutOf(tsv).includes('\t'), tsv.rich && tsv.rich.kind);

    const flood = await run("seq -f '%.0f' 1 1500000");
    check('over 5 MB: card finishes with the tail and a note', flood.status === 'ok' && /^\[loom: over/.test(text(flood)) && text(flood).endsWith('1500000'), [flood.status, text(flood).slice(0, 60), text(flood).slice(-10)]);
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
    check('15 running cards: at most 8 live terminals', st.peak <= 8 && st.live <= 8 && st.models >= 15, st);
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
