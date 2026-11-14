'use strict';
// Renders build/icon.svg to the icons electron-builder needs:
//   build/icon.png (1024), build/icons/<n>x<n>.png (Linux), build/icon.ico
//   (Windows), build/icon.icns (macOS, with iconutil when it's there).
// Runs in Electron so no image library is needed: npm run icons
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const build = path.join(__dirname, '..', 'build');
const LINUX = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO = [16, 24, 32, 48, 64, 128, 256];
// iconutil's names: icon_<n>x<n>[@2x].png
const ICNS = [[16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2], [256, 1], [256, 2], [512, 1], [512, 2]];

// An .ico of PNG images (Windows Vista and later read these).
function ico(pngs) {
  const head = Buffer.alloc(6 + pngs.length * 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(([size, buf], i) => {
    const e = 6 + i * 16;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(buf.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += buf.length;
  });
  return Buffer.concat([head, ...pngs.map(([, b]) => b)]);
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(build, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<body></body>');
  // Draws the SVG on a canvas of exactly n×n pixels, whatever the screen's scale.
  const render = async (n) => {
    const url = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = ${n};
        const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, ${n}, ${n}); resolve(c.toDataURL('image/png')); };
      img.onerror = () => reject(new Error('svg failed'));
      img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
    })`);
    return Buffer.from(url.split(',')[1], 'base64');
  };
  const cache = new Map();
  const png = async (n) => { if (!cache.has(n)) cache.set(n, await render(n)); return cache.get(n); };

  fs.writeFileSync(path.join(build, 'icon.png'), await png(1024));
  fs.mkdirSync(path.join(build, 'icons'), { recursive: true });
  for (const n of LINUX) fs.writeFileSync(path.join(build, 'icons', `${n}x${n}.png`), await png(n));
  const icoPngs = [];
  for (const n of ICO) icoPngs.push([n, await png(n)]);
  fs.writeFileSync(path.join(build, 'icon.ico'), ico(icoPngs));

  const set = path.join(build, 'icon.iconset');
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set);
  for (const [n, s] of ICNS) fs.writeFileSync(path.join(set, `icon_${n}x${n}${s === 2 ? '@2x' : ''}.png`), await png(n * s));
  try {
    execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(build, 'icon.icns')]);
    console.log('wrote build/icon.icns');
  } catch { console.warn('iconutil (macOS only) not found: build/icon.icns left as it was'); }
  fs.rmSync(set, { recursive: true, force: true });
  console.log(`wrote build/icon.png, build/icon.ico and ${LINUX.length} Linux sizes`);
  app.quit();
});
