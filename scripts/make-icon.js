'use strict';
// Renders assets/icon.png (512x512) from assets/logo.svg using Electron's offscreen renderer.
//   npm run make-icon
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SVG = fs.readFileSync(path.join(__dirname, '..', 'assets', 'logo.svg'), 'utf8');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,' + encodeURIComponent(`<html><head><style>html,body{margin:0;overflow:hidden;background:transparent}svg{display:block;width:512px;height:512px}</style></head><body>${SVG}</body></html>`));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  const out = path.join(__dirname, '..', 'assets', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.resize({ width: 512, height: 512 }).toPNG());
  console.log('wrote', out);
  app.quit();
});
