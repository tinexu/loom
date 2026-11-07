'use strict';
// npm run bench: launches Loom headlessly (the LOOM_SMOKE harness, under
// xvfb-run on Linux) and measures it against the budgets below.
//   stream    long tasks and keystroke latency while big commands stream
//   startup   a generated 1,000-card session: first launch, then a second
//             launch for first paint, time to idle, and pan/zoom frame rate
// Prints a table, appends the run to bench-results.json, and exits 1 if a
// budget is missed by more than 25%.
// Usage: node scripts/bench.js [--label name] [--only stream|startup|map] [--cards 1000]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const electron = require('electron');
const repo = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const LABEL = opt('label', '');
const ONLY = opt('only', '');
const CARDS = Number(opt('cards', 1000));
const SLACK = 1.25;

// [key, label, unit, budget, 'max' (lower is better) | 'min']
const BUDGETS = [
  ['stream.seq.maxLongTask', 'seq 1 3000000: longest task', 'ms', 50, 'max'],
  ['stream.yes.maxLongTask', 'yes 200 B × 1M: longest task', 'ms', 50, 'max'],
  ['startup.pan.fps', '1,000 cards: pan fps', 'fps', 60, 'min'],
  ['startup.zoom.fps', '1,000 cards: zoom fps', 'fps', 60, 'min'],
  ['startup.firstPaint', '1,000 cards: first paint', 'ms', 1500, 'max'],
  ['peakMB', 'Peak memory, main + renderer', 'MB', 600, 'max'],
];
const INFO = [
  ['stream.seq.ms', 'seq 1 3000000: duration', 'ms'],
  ['stream.seq.longTasks', 'seq: long tasks (>50 ms)', ''],
  ['stream.seq.keyP95', 'seq: keystroke → frame, p95', 'ms'],
  ['stream.gb.maxLongTask', '1 GB in one card: longest task', 'ms'],
  ['stream.gb.ms', '1 GB in one card: duration', 'ms'],
  ['stream.yes.ms', 'yes 200 B × 1M: duration', 'ms'],
  ['stream.yes.longTasks', 'yes: long tasks (>50 ms)', ''],
  ['stream.yes.keyP95', 'yes: keystroke → frame, p95', 'ms'],
  ['stream.idleMainMB', 'idle: main', 'MB'],
  ['stream.idleRendererMB', 'idle: renderer', 'MB'],
  ['stream.peakMainMB', 'stream: peak main', 'MB'],
  ['stream.peakRendererMB', 'stream: peak renderer', 'MB'],
  ['stream.peakAllMB', 'stream: peak, all processes', 'MB'],
  ['first.firstPaint', 'first launch over the fixture (migrates it): first paint', 'ms'],
  ['startup.bodies', '1,000 cards: output in the cards in view', 'ms'],
  ['startup.idle', '1,000 cards: time to idle', 'ms'],
  ['startup.pan.p95', 'pan: frame interval p95', 'ms'],
  ['startup.zoom.p95', 'zoom: frame interval p95', 'ms'],
  ['startup.far.fps', 'zoomed out to all cards: pan fps', 'fps'],
  ['startup.mapOpen', 'history map: open', 'ms'],
  ['startup.mapFilter', 'history map: filter', 'ms'],
  ['map.firstPaint', '20,000 cards: first paint', 'ms'],
  ['map.mapOpen', '20,000 cards: history map open', 'ms'],
  ['map.mapFilter', '20,000 cards: history map filter, worst', 'ms'],
  ['map.mapScroll', '20,000 cards: history map scroll, per frame', 'ms'],
  ['startup.peakMainMB', 'startup: peak main', 'MB'],
  ['startup.peakRendererMB', 'startup: peak renderer', 'MB'],
  ['startup.sessionMB', 'session.json size', 'MB'],
];

function homeFixture(root) {
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(home, '.zshrc'), "PROMPT='%~ $ '\n");
  fs.writeFileSync(path.join(home, '.bashrc'), "PS1='\\w $ '\n");
  return { home, cwd };
}

function launch(fx, userData, extra) {
  const env = {
    ...process.env, ...extra,
    SHELL: spawnSync('which', ['zsh']).stdout.toString().trim() || '/bin/bash',
    HOME: fx.home,
    LOOM_SMOKE: path.join(userData, '..', 'bench.png'),
    LOOM_SMOKE_CWD: fx.cwd,
    LOOM_SMOKE_USERDATA: userData,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ZDOTDIR;
  const argv = [repo];
  if ((process.getuid && process.getuid() === 0) || process.env.E2E_NO_SANDBOX) argv.push('--no-sandbox');
  const linux = process.platform === 'linux';
  const [cmd, a] = linux ? ['xvfb-run', ['-a', '-s', '-screen 0 1920x1080x24', electron, ...argv]] : [electron, argv];
  return new Promise((resolve) => {
    const child = spawn(cmd, a, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { out += '\n[bench] TIMEOUT\n'; child.kill('SIGKILL'); }, 600000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', () => {
      clearTimeout(timer);
      if (process.env.BENCH_LOG) fs.appendFileSync(process.env.BENCH_LOG, out);
      const lines = out.split('\n');
      for (const l of lines) if (/^\[renderer\] (ERR|REJ|SMOKE|BENCH)/.test(l)) console.log(l);
      const res = lines.filter((l) => l.startsWith('[bench] {')).map((l) => JSON.parse(l.slice(8)));
      if (!res.length) console.log(out.slice(-2000));
      resolve(Object.assign({}, ...res));
    });
  });
}

const get = (o, key) => key.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
const fmt = (v) => (v == null ? '—' : typeof v === 'number' ? (Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : (+v.toFixed(1)).toString()) : String(v));

(async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'loom-bench-'));
  const fx = homeFixture(root);
  const results = {};
  if (!ONLY || ONLY === 'stream') {
    console.log('stream: seq and yes…');
    results.stream = await launch(fx, path.join(root, 'ud-stream'), { LOOM_BENCH: 'stream' });
  }
  if (!ONLY || ONLY === 'startup') {
    const ud = path.join(root, 'ud-startup');
    spawnSync(process.execPath, [path.join(__dirname, 'gen-fixture.js'), ud, fx.cwd, String(CARDS)], { stdio: 'inherit' });
    console.log('startup: first launch…');
    results.first = await launch(fx, ud, { LOOM_BENCH: 'first' });
    console.log('startup: second launch, pan and zoom…');
    results.startup = await launch(fx, ud, { LOOM_BENCH: 'startup' });
    results.startup.sessionMB = fs.statSync(path.join(ud, 'session.json')).size / 1048576;
  }
  if (!ONLY || ONLY === 'map') {
    const ud = path.join(root, 'ud-map');
    spawnSync(process.execPath, [path.join(__dirname, 'gen-fixture.js'), ud, fx.cwd, '20000', '--light'], { stdio: 'inherit' });
    console.log('map: 20,000 cards, first launch…');
    await launch(fx, ud, { LOOM_BENCH: 'first' });
    console.log('map: second launch, open and filter the history map…');
    results.map = await launch(fx, ud, { LOOM_BENCH: 'map' });
  }
  const peaks = [results.stream, results.startup, results.first].filter(Boolean).map((r) => (r.peakMainMB || 0) + (r.peakRendererMB || 0));
  results.peakMB = peaks.length ? Math.max(...peaks) : null;

  const file = path.join(repo, 'bench-results.json');
  let saved = { runs: [] };
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  const prev = saved.runs[saved.runs.length - 1];
  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo }).stdout.toString().trim();
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: repo }).stdout.toString().trim() ? '+dirty' : '';

  const rows = [];
  let failed = 0;
  for (const [key, label, unit, budget, dir] of BUDGETS) {
    const v = get(results, key);
    let status = '—';
    if (v != null) {
      const ok = dir === 'max' ? v <= budget : v >= budget;
      const fail = dir === 'max' ? v > budget * SLACK : v < budget / SLACK;
      status = ok ? 'ok' : fail ? 'FAIL' : 'over';
      if (fail) failed++;
    }
    rows.push([label, `${fmt(v)} ${unit}`, `${dir === 'max' ? '≤' : '≥'} ${fmt(budget)} ${unit}`, status, prev ? `${fmt(get(prev.results, key))}` : '']);
  }
  for (const [key, label, unit] of INFO) {
    const v = get(results, key);
    if (v == null) continue;
    rows.push([label, `${fmt(v)} ${unit}`, '', '', prev ? `${fmt(get(prev.results, key))}` : '']);
  }
  const head = ['Metric', 'Value', 'Budget', '', prev ? `Prev (${prev.label || prev.commit})` : ''];
  const widths = head.map((_, i) => Math.max(...[head, ...rows].map((r) => String(r[i]).length)));
  const line = (r) => `| ${r.map((c, i) => String(c).padEnd(widths[i])).join(' | ')} |`;
  console.log(`\n${line(head)}\n|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`);
  for (const r of rows) console.log(line(r));

  saved.runs.push({
    label: LABEL, date: new Date().toISOString(), commit: commit + dirty,
    machine: `${os.cpus()[0].model}, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${process.platform}`,
    results,
  });
  fs.writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);
  fs.rmSync(root, { recursive: true, force: true });
  console.log(failed ? `\n${failed} budget(s) missed by more than 25%` : '\nall budgets within 25%');
  process.exit(failed ? 1 : 0);
})();
