// Рисует иконку приложения build/icon.png (1024×1024) из SVG средствами Electron.
// Запуск: node scripts/start.mjs не нужен — `npx electron scripts/make-icon.cjs`.
'use strict';
const {app, BrowserWindow} = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 1024;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${SIZE}" height="${SIZE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2b2d42"/><stop offset="1" stop-color="#1b1c26"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#bg)"/>
  <path d="M10 14h8l2 2h6l2-2h6a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H28l-2 2h-6l-2-2h-8a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z" fill="#FFAB19"/>
  <path d="M18 31h8l2 2h6l2-2h6a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H36l-2 2h-6l-2-2h-8a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z" fill="#4C97FF"/>
  <path d="M44 14l9 9-9 9" fill="none" stroke="#59C059" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="12" y="49" width="22" height="5" rx="2.5" fill="#9966FF"/>
  <rect x="38" y="49" width="12" height="5" rx="2.5" fill="#FF6680"/>
</svg>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({width: SIZE, height: SIZE, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: {offscreen: true}});
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`,
  ));
  await new Promise((r) => setTimeout(r, 500));
  const image = await win.webContents.capturePage({x: 0, y: 0, width: SIZE, height: SIZE});
  const out = path.join(__dirname, '..', 'build');
  fs.mkdirSync(out, {recursive: true});
  fs.writeFileSync(path.join(out, 'icon.png'), image.resize({width: SIZE, height: SIZE}).toPNG());
  fs.writeFileSync(path.join(out, 'icon.svg'), svg);
  console.log('build/icon.png готов');
  app.quit();
});
