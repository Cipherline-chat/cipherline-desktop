'use strict';
// The sharer desktop's "something is happening": an animated window (a moving document + a frame counter, so a shared
// screen is never static and the viewer's fps is measurable) and, optionally, a 1000 Hz tone played from THIS process
// tree. It is NOT the Cipherline app, so the tone is exactly "another application's audio" for the share-audio scenarios.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const W = +arg('w', 900), H = +arg('h', 900), HZ = +arg('hz', 1000), TONE = arg('tone', '1') === '1';
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: W, height: H, x: 0, y: 0, frame: false, show: true, title: 'LAB-PATTERN', backgroundColor: '#000',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, 'pattern.html'), { hash: `w=${W}&h=${H}&hz=${HZ}&tone=${TONE ? 1 : 0}` });
  win.setTitle('LAB-PATTERN');
});
