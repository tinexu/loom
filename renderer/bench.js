'use strict';
// The renderer half of `npm run bench` (scripts/bench.js). app.js calls
// LoomBench.run with its internals when Loom starts with LOOM_BENCH.
(function (g) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

  const longTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* no long task API */ }
  const tasksIn = (t0, t1) => longTasks.filter((e) => e.start >= t0 && e.start < t1);

  // Drives the view one animation frame at a time and records frame intervals.
  async function animate(ms, step) {
    const intervals = [];
    const t0 = await frame();
    let last = t0;
    for (;;) {
      const t = await frame();
      intervals.push(t - last);
      last = t;
      const p = Math.min(1, (t - t0) / ms);
      step(p);
      if (p >= 1) break;
    }
    // The first interval includes setup.
    intervals.shift();
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    return { fps: 1000 / avg, p95: pct(intervals, 0.95), frames: intervals.length, slow: intervals.filter((x) => x > 25).length };
  }

  async function stream(h) {
    const out = {};
    await wait(3000);
    const idle = await h.api.benchMem({ reset: true });
    Object.assign(out, { idleMainMB: idle.main, idleRendererMB: idle.renderer, idleAllMB: idle.all });
    const cmds = [
      ['seq', 'seq 1 3000000'],
      ['yes', `yes "$(printf 'x%.0s' {1..200})" | head -n 1000000`],
      // A card holding 1 GB, for the memory budget.
      ['gb', `yes "$(printf 'y%.0s' {1..99})" | head -c 1073741824`],
    ];
    for (const [label, cmd] of cmds) {
      await wait(500);
      await h.api.benchMem({ reset: true });
      let heap = 0;
      const heapTimer = setInterval(() => { heap = Math.max(heap, (performance.memory && performance.memory.usedJSHeapSize) || 0); }, 100);
      const t0 = performance.now();
      const n = h.runCommand(cmd);
      // Type into the composer while it streams: keystroke to the next frame.
      await wait(300);
      h.focusPrompt();
      const lat = [];
      let stamp = 0;
      const onKey = (e) => { stamp = e.timeStamp; requestAnimationFrame((t) => lat.push(t - stamp)); };
      h.els.prompt.addEventListener('keydown', onKey);
      const typing = (async () => {
        while (n.status === 'running' && performance.now() - t0 < 300000) {
          if (document.activeElement !== h.els.prompt) h.focusPrompt();
          await h.api.smokeKeys(['a']);
          await wait(120);
        }
      })();
      while (n.status === 'running' && performance.now() - t0 < 300000) await wait(50);
      const t1 = performance.now();
      await typing;
      h.els.prompt.removeEventListener('keydown', onKey);
      h.clearPrompt();
      await wait(300);
      const tasks = tasksIn(t0, t1 + 300);
      clearInterval(heapTimer);
      const m = await h.api.benchMem();
      out[label] = {
        ms: t1 - t0, status: n.status, bytes: n.out && n.out.bytes, lines: n.out && n.out.lines,
        longTasks: tasks.length, maxLongTask: tasks.length ? Math.max(...tasks.map((x) => x.dur)) : 0,
        keyP95: pct(lat, 0.95), keys: lat.length,
        // When the long tasks happened, from the start and from the end.
        tasks: tasks.map((x) => [Math.round(x.start - t0), Math.round(x.start - t1), Math.round(x.dur)]),
        mainMB: Math.round(m.main), rendererMB: Math.round(m.renderer), heapMB: Math.round(heap / 1048576),
      };
      console.log(`BENCH ${label} ${JSON.stringify(out[label])}`);
    }
    const mem = await h.api.benchMem();
    Object.assign(out, { peakMainMB: mem.main, peakRendererMB: mem.renderer, peakAllMB: mem.all });
    return out;
  }

  // Waits for a second with no long task, the bench's idea of idle.
  async function idleAt(h, limit = 30000) {
    const start = performance.now();
    for (;;) {
      await wait(100);
      const lastEnd = longTasks.reduce((m, e) => Math.max(m, e.start + e.dur), 0);
      const quietSince = Math.max(lastEnd, h.firstPaintPerf());
      if (performance.now() - quietSince > 1000 || performance.now() - start > limit) {
        return Math.round(Date.now() - (performance.now() - quietSince) - h.sys.procStart);
      }
    }
  }

  async function startup(h, { measureView }) {
    while (!h.firstPaint()) await wait(20);
    const out = { firstPaint: Math.round(h.firstPaint() - h.sys.procStart), cards: h.state.nodes.size };
    // The cards in view with their output in them, not just their frames.
    if (h.bodiesReady) {
      const t = performance.now();
      while (!h.bodiesReady() && performance.now() - t < 20000) await wait(10);
      out.bodies = Math.round(Date.now() - h.sys.procStart);
    }
    out.idle = await idleAt(h);
    if (!measureView) return out;
    const mem0 = await h.api.benchMem({ reset: true });
    const view = { ...h.state.view };
    const box = h.els.viewport.getBoundingClientRect();
    out.pan = await animate(2500, (p) => {
      h.state.view = { ...view, x: view.x - p * 6000, y: view.y - Math.sin(p * Math.PI) * 600 };
      h.applyView();
    });
    h.state.view = view; h.applyView();
    await wait(300);
    const cx = box.width / 2; const cy = box.height / 2;
    const wx = (cx - view.x) / view.k; const wy = (cy - view.y) / view.k;
    out.zoom = await animate(3000, (p) => {
      const k = view.k * Math.exp(Math.log(0.15) * Math.sin(p * Math.PI));
      h.state.view = { k, x: cx - wx * k, y: cy - wy * k };
      h.applyView();
    });
    h.state.view = view; h.applyView();
    await wait(300);
    h.fit(true);
    await wait(600);
    const far = { ...h.state.view };
    out.far = await animate(2000, (p) => {
      h.state.view = { ...far, x: far.x + Math.sin(p * Math.PI * 2) * 300, y: far.y + Math.cos(p * Math.PI * 2) * 150 - 150 };
      h.applyView();
    });
    h.state.view = view; h.applyView();
    await wait(400);
    let t0 = performance.now();
    h.toggleSidebar(true);
    await frame(); await frame();
    out.mapOpen = performance.now() - t0;
    t0 = performance.now();
    h.els.search.value = 'seq';
    h.els.search.dispatchEvent(new Event('input'));
    await frame(); await frame();
    out.mapFilter = performance.now() - t0;
    const mem = await h.api.benchMem();
    Object.assign(out, { peakMainMB: Math.max(mem.main, mem0.main), peakRendererMB: Math.max(mem.renderer, mem0.renderer), peakAllMB: Math.max(mem.all, mem0.all) });
    return out;
  }

  // The history map with a very large session: opening it and filtering it.
  async function map(h) {
    while (!h.firstPaint()) await wait(20);
    const out = { firstPaint: Math.round(h.firstPaint() - h.sys.procStart), cards: h.state.nodes.size };
    await wait(1000);
    let t0 = performance.now();
    h.toggleSidebar(true);
    await frame(); await frame();
    out.mapOpen = performance.now() - t0;
    const filters = [];
    for (const q of ['s', 'se', 'seq', 'seq 1', 'echo', 'nothing-matches']) {
      t0 = performance.now();
      h.els.search.value = q;
      h.els.search.dispatchEvent(new Event('input'));
      await frame(); await frame();
      filters.push(performance.now() - t0);
    }
    out.mapFilter = Math.max(...filters);
    h.els.search.value = '';
    h.els.search.dispatchEvent(new Event('input'));
    t0 = performance.now();
    const sc = document.querySelector('#map-tree');
    for (let i = 0; i < 30; i++) { sc.scrollTop += 2000; await frame(); }
    out.mapScroll = (performance.now() - t0) / 30;
    return out;
  }

  async function run(h) {
    let out;
    if (h.sys.bench === 'stream') out = await stream(h);
    else if (h.sys.bench === 'map') out = await map(h);
    else out = await startup(h, { measureView: h.sys.bench === 'startup' });
    if (h.sys.bench !== 'stream' && out.peakMainMB == null) {
      const mem = await h.api.benchMem();
      Object.assign(out, { peakMainMB: mem.main, peakRendererMB: mem.renderer, peakAllMB: mem.all });
    }
    await h.flush();
    await h.api.benchReport(out);
    await h.api.smokeDone();
  }

  g.LoomBench = { run };
})(window);
