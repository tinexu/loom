'use strict';
// Loom — what must never be in a packaged app: secrets, tests and dev-only
// files. Used by scripts/check-package.js on every build, and by the tests.

// Paths are relative to the app's root inside app.asar (or app.asar.unpacked).
const RULES = [
  { name: '.env file', test: (p) => /(^|\/)\.env(\.[^/]*)?$/.test(p) },
  { name: 'test folder of the app', test: (p) => /^\/?(test|tests|__tests__)\//.test(p) },
  { name: 'e2e or bench file', test: (p) => /(^|\/)(e2e|bench)[^/]*\.(js|json)$/.test(p) && !p.includes('node_modules/') },
  { name: 'bench results', test: (p) => /(^|\/)bench-results\.json$/.test(p) },
  { name: 'dev-only folder', test: (p) => /^\/?(scripts|build|dist|\.github|\.vscode|\.idea|coverage)\//.test(p) },
  { name: 'screenshot', test: (p) => /\.png$/i.test(p) && !p.includes('node_modules/') },
  { name: 'log file', test: (p) => /\.log$/i.test(p) },
  { name: 'old root copies', test: (p) => /^\/?(ansi|views)\.js$|^\/?styles\.css$/.test(p) },
];
const SECRET = /sk-ant-/;

// Files are { path, read() } where read() returns a Buffer (or null for a folder).
// Returns a list of problems; empty means the package is clean.
function check(files) {
  const problems = [];
  for (const f of files) {
    const p = f.path.replace(/\\/g, '/');
    for (const r of RULES) if (r.test(p)) problems.push(`${p}: ${r.name}`);
    const buf = f.read ? f.read() : null;
    if (buf && SECRET.test(buf.toString('latin1'))) problems.push(`${p}: contains "sk-ant-" (an Anthropic key?)`);
  }
  return problems;
}

module.exports = { check, RULES, SECRET };
