'use strict';
// End-to-end run: launches Loom with LOOM_SMOKE against a throwaway project and
// home directory, once per shell, then again over the saved session to check
// that a restart recreates a card's environment. Linux needs xvfb-run.
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

function fixture(shell) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'loom e2e-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(home, shell === 'zsh' ? '.zshrc' : '.bashrc'), RC(shell));
  fs.writeFileSync(path.join(cwd, 'people.csv'), 'name,team,score\nalice,eng,100\ncarol,eng,300\nbob,ops,200\n');
  fs.writeFileSync(path.join(cwd, 'README.md'), Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n'));
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  const git = (...a) => spawnSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...a], { cwd });
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'first');
  return { root, home, cwd };
}

function launch(shell, fx, extra) {
  const env = {
    ...process.env, ...extra,
    SHELL: spawnSync('which', [shell]).stdout.toString().trim(),
    HOME: fx.home,
    LOOM_SMOKE: path.join(fx.root, 'smoke.png'),
    LOOM_SMOKE_CWD: fx.cwd,
    LOOM_SMOKE_USERDATA: path.join(fx.root, 'userData'),
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
    failed += report(shell, await launch(shell, fx, {}));
    failed += report(`${shell} (restart)`, await launch(shell, fx, { LOOM_SMOKE_RESUME: '1' }));
    const saved = fs.readFileSync(path.join(fx.root, 'userData', 'session.json'), 'utf8');
    if (saved.includes('loom-canary-hunter2')) { console.log(`${shell} FAIL typed secret found in session.json`); failed++; }
    else console.log(`${shell} PASS typed secret isn't in session.json`);
    if (process.env.E2E_SHOTS) {
      fs.mkdirSync(process.env.E2E_SHOTS, { recursive: true });
      for (const f of fs.readdirSync(fx.root)) if (f.endsWith('.png')) fs.copyFileSync(path.join(fx.root, f), path.join(process.env.E2E_SHOTS, `${shell}-${f}`));
    }
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
