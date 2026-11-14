'use strict';
// npm run check:package: lists every app.asar in dist/ (and its .unpacked
// folder) and fails if it holds a .env file, anything containing "sk-ant-",
// tests, fixtures or dev-only files (lib/package-check.js has the rules).
// Run after every build, locally and in CI.
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');
const { check } = require('../lib/package-check');

const dist = path.join(__dirname, '..', process.argv[2] || 'dist');

function findAsars(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === 'app.asar') out.push(p);
    else if (e.isDirectory() && !e.name.endsWith('.asar.unpacked')) findAsars(p, out);
  }
  return out;
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push({ path: path.relative(base, p), read: () => fs.readFileSync(p) });
  }
  return out;
}

const archives = findAsars(dist);
if (!archives.length) {
  console.error(`check:package: no app.asar under ${dist}. Run npm run dist first.`);
  process.exit(1);
}
let failed = 0;
for (const a of archives) {
  const files = asar.listPackage(a).map((p) => p.replace(/^[\\/]/, ''));
  const entries = files.map((p) => ({
    path: p,
    read: () => { try { return asar.extractFile(a, p); } catch { return null; } },
  }));
  const unpackedDir = `${a}.unpacked`;
  const unpacked = fs.existsSync(unpackedDir) ? walk(unpackedDir) : [];
  const problems = check([...entries, ...unpacked]);
  const rel = path.relative(process.cwd(), a);
  console.log(`check:package ${rel}: ${files.length} entries, ${unpacked.length} unpacked files`);
  const top = [...new Set(files.map((p) => p.split(/[\\/]/)[0]))].sort();
  console.log(`  top level: ${top.join(', ')}`);
  if (problems.length) {
    failed += problems.length;
    for (const p of problems.slice(0, 50)) console.error(`  ✗ ${p}`);
    if (problems.length > 50) console.error(`  …and ${problems.length - 50} more`);
  } else console.log('  ✓ no .env, keys, tests, fixtures or dev-only files');
}
process.exit(failed ? 1 : 0);
