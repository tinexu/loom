'use strict';
// End-to-end run: launches Loom with LOOM_SMOKE against a throwaway project and
// home directory, once per shell, then again over the saved session to check
// that a restart recreates a card's environment, then over a session saved in
// the old format (output inline) to check its migration. Linux needs xvfb-run.
// Usage: node test/e2e.js [zsh|bash ...]   E2E_RC appends to the fixture rc files.
// E2E_SHOTS=<dir> keeps the screenshots. E2E_SUDO_PASS and E2E_SSH=1 turn on the
// sudo password and ssh checks where a test account or sshd exists.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const electron = require('electron');
const repo = path.join(__dirname, '..');
const RC = (shell) => `
alias loomalias='echo alias-ok'
loomfn() { echo fn-ok; }
${shell === 'zsh'
    ? `PROMPT='%F{red}LEAKPROMPT%f %~ $ '\nRPROMPT='LEAKRIGHT'\nprecmd() { echo LEAKPRECMD; }\npreexec() { echo LEAKPREEXEC; }`
    : `PS1='LEAKPROMPT \\w $ '\nPROMPT_COMMAND='echo LEAKPRECMD;'`}
${process.env.E2E_RC || ''}
`;

const HISTORY = {
  zsh: ': 1700000000:0;git checkout feature\n: 1700000100:2;for f in *; do\\\n  echo $f\\\ndone\n: 1700000200:0;make deploy\n',
  bash: '#1700000300\ncargo build --release\n',
};
const hash = (f) => require('crypto').createHash('sha1').update(fs.readFileSync(f)).digest('hex');

function fixture(shell) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'loom e2e-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'loom-demo');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home, shell === 'zsh' ? '.zshrc' : '.bashrc'), RC(shell));
  // Shell history to import: extended zsh format with a multi-line entry, and bash.
  fs.writeFileSync(path.join(home, '.zsh_history'), HISTORY.zsh);
  fs.writeFileSync(path.join(home, '.bash_history'), HISTORY.bash);
  for (const d of ['src/lib', 'scripts']) fs.mkdirSync(path.join(cwd, d), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'my file.txt'), 'spaced\n');
  fs.writeFileSync(path.join(cwd, 'people.csv'), 'name,team,score\nalice,eng,100\ncarol,eng,300\nbob,ops,200\n');
  fs.writeFileSync(path.join(cwd, 'README.md'), Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n'));
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"fixture","version":"1.0.0","scripts":{"build":"echo built","test":"echo tested"}}\n');
  const git = (...a) => spawnSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...a], { cwd });
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'first');
  git('branch', 'feature');
  git('branch', 'fix-typo');
  return { root, home, cwd };
}

// A session.json from before output files: each card kept its output in `segs`.
function oldSession(cwd) {
  const now = Date.now();
  const card = (o) => ({
    cwd, cwdAfter: cwd, parentId: null, pipeFrom: null, x: 0, y: 0, w: 620, bodyH: 300, status: 'ok', exitCode: 0,
    startedAt: now - 60000, endedAt: now - 59000, view: 'rich', ai: null, collapsed: false, envFile: null, rich: null, ...o,
  });
  return {
    v: 1, nextId: 4, view: { x: 120, y: 90, k: 1 }, activeId: 1, rootCwd: cwd, sidebar: false,
    nodes: [
      card({ id: 1, cmd: 'echo old', segs: [[0, 'old output line 1\nold output line 2\n\x1b[31mred line\x1b[0m\n']] }),
      card({ id: 2, cmd: 'ls', parentId: 1, y: 260, segs: [[0, 'a.txt\nb.txt\n']], rich: { kind: 'files', data: { path: cwd, total: 1, entries: [{ name: 'a.txt', dir: false, link: false, size: 1, mtime: now, exec: false }] } } }),
      card({ id: 3, cmd: 'false', parentId: 1, x: 700, y: 260, status: 'error', exitCode: 1, segs: [] }),
    ],
  };
}

function launch(shell, fx, extra) {
  const env = {
    ...process.env,
    SHELL: spawnSync('which', [shell]).stdout.toString().trim(),
    HOME: fx.home,
    LOOM_SMOKE: path.join(fx.root, 'smoke.png'),
    LOOM_SMOKE_CWD: fx.cwd,
    LOOM_SMOKE_USERDATA: path.join(fx.root, 'userData'),
    ...extra,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ZDOTDIR;
  const args = [repo];
  if ((process.getuid && process.getuid() === 0) || process.env.E2E_NO_SANDBOX) args.push('--no-sandbox');
  const linux = process.platform === 'linux';
  const [cmd, argv] = linux ? ['xvfb-run', ['-a', electron, ...args]] : [electron, args];
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { out += '\n[e2e] FAIL timed out\n'; child.kill('SIGKILL'); }, 420000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

function report(label, out) {
  if (process.env.E2E_LOG) fs.appendFileSync(process.env.E2E_LOG, `\n=== ${label}\n${out}`);
  const lines = out.split('\n');
  const results = lines.filter((l) => /^\[e2e\] (PASS|FAIL)/.test(l));
  const fails = results.filter((l) => l.startsWith('[e2e] FAIL'));
  for (const l of results) console.log(`${label} ${l.slice(6)}`);
  for (const l of lines.filter((x) => /^\[renderer\] (ERR|REJ|SMOKE)/.test(x))) { console.log(`${label} ${l}`); fails.push(l); }
  if (!lines.some((l) => l.startsWith('[e2e] END'))) {
    console.log(`${label} FAIL run never finished\n${out.slice(-1500)}`);
    fails.push('unfinished');
  }
  return fails.length;
}

(async () => {
  const shells = process.argv.slice(2).length ? process.argv.slice(2) : ['zsh', 'bash'];
  let failed = 0;
  for (const shell of shells) {
    const fx = fixture(shell);
    const histHash = ['.zsh_history', '.bash_history'].map((f) => hash(path.join(fx.home, f))).join();
    failed += report(shell, await launch(shell, fx, {}));
    failed += report(`${shell} (restart)`, await launch(shell, fx, { LOOM_SMOKE_RESUME: '1' }));
    const saved = fs.readFileSync(path.join(fx.root, 'userData', 'session.json'), 'utf8');
    if (saved.includes('loom-canary-hunter2')) { console.log(`${shell} FAIL typed secret found in session.json`); failed++; }
    else console.log(`${shell} PASS typed secret isn't in session.json`);
    const hist = fs.readFileSync(path.join(fx.root, 'userData', 'history.jsonl'), 'utf8');
    const histOk = !hist.includes('secret-space') && !hist.includes('loom-canary-hunter2') && hist.includes('"cmd":"ls -la"');
    console.log(`${shell} ${histOk ? 'PASS' : 'FAIL'} history.jsonl has ls -la and no leading-space command or typed secret`);
    if (!histOk) failed++;
    const untouched = ['.zsh_history', '.bash_history'].map((f) => hash(path.join(fx.home, f))).join() === histHash;
    console.log(`${shell} ${untouched ? 'PASS' : 'FAIL'} ~/.zsh_history and ~/.bash_history unchanged`);
    if (!untouched) failed++;
    // ---- migration of an old session
    const mig = path.join(fx.root, 'userData-old');
    fs.mkdirSync(mig, { recursive: true });
    fs.writeFileSync(path.join(mig, 'session.json'), JSON.stringify(oldSession(fx.cwd)));
    failed += report(`${shell} (migrate)`, await launch(shell, fx, { LOOM_SMOKE_MIGRATE: '1', LOOM_SMOKE_USERDATA: mig }));
    const after = JSON.parse(fs.readFileSync(path.join(mig, 'session.json'), 'utf8'));
    const logs = ['1', '2'].every((id) => fs.existsSync(path.join(mig, 'outputs', `${id}.log`)));
    const migOk = after.v === 2 && !JSON.stringify(after).includes('"segs"') && logs && fs.existsSync(path.join(mig, 'session.v1.json'))
      && fs.readFileSync(path.join(mig, 'outputs', '1.log'), 'utf8').startsWith('old output line 1');
    console.log(`${shell} ${migOk ? 'PASS' : 'FAIL'} migrate: session.json is metadata only, output moved to files, old file kept`);
    if (!migOk) failed++;
    const outFiles = fs.readdirSync(path.join(fx.root, 'userData', 'outputs')).length;
    const sessText = fs.readFileSync(path.join(fx.root, 'userData', 'session.json'), 'utf8');
    const sess = JSON.parse(sessText);
    const perCard = sessText.length / sess.nodes.length;
    const small = !sessText.includes('"segs"') && !sessText.includes('alias-ok') && !sessText.includes('1.00001e+06') && perCard < 1000 && outFiles > 10;
    console.log(`${shell} ${small ? 'PASS' : 'FAIL'} session.json holds no output (${sessText.length} bytes for ${sess.nodes.length} cards, ${outFiles} output files)`);
    if (!small) failed++;
    if (process.env.E2E_SHOTS) {
      fs.mkdirSync(process.env.E2E_SHOTS, { recursive: true });
      for (const f of fs.readdirSync(fx.root)) if (f.endsWith('.png')) fs.copyFileSync(path.join(fx.root, f), path.join(process.env.E2E_SHOTS, `${shell}-${f}`));
    }
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
