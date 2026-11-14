'use strict';
// electron-builder afterPack hook: node-pty ships prebuilt binaries for every
// system; keep only this package's platform and architecture.
const fs = require('fs');
const path = require('path');

const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

exports.default = async function afterPack(ctx) {
  const platform = ctx.electronPlatformName; // darwin, linux, win32
  const arch = ARCH[ctx.arch] || 'x64';
  const resources = platform === 'darwin'
    ? path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(ctx.appOutDir, 'resources');
  const dir = path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (name !== `${platform}-${arch}` && !(arch === 'universal' && name.startsWith(`${platform}-`))) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }
};
