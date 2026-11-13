// Linux screen-capture probe: what Electron's capture, encoders, decoders and audio
// really do on THIS machine. Not part of the app and not run by CI: a tool for a
// Linux tester and for checking an Electron bump (e.g. 43.8.1) against what the
// share code assumes. Findings it backs: electron/share-platform.ts
// (chromiumLoopbackAudioMode), src/utils/sharePlatformSupport.ts.
//
//   cd apps/desktop
//   xvfb-run -a -s "-screen 0 1920x1080x24" npx electron --no-sandbox --disable-dev-shm-usage scripts/linux-capture-probe
//   (on a real desktop, drop xvfb-run; Wayland: it will open the portal chooser - answer it, once)
//
// Prints one `CHECK PASS|FAIL <name> <detail>` line per check and `INFO <name> <json>`
// lines for the numbers; exits 1 if any check failed. A getSources of [] is retried
// (an Xvfb root window is sometimes not ready on the first ask).
const { app, BrowserWindow, session, desktopCapturer } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
if (process.env.PROBE_HWENC === '1') app.commandLine.appendSwitch('enable-features', 'AcceleratedVideoEncoder');

let failed = 0;
let audioMode = 'loopback'; // the renderer asks main which mode to answer with, per capture

app.whenReady().then(async () => {
    session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
        let srcs = [];
        for (let i = 0; i < 5 && !srcs.length; i++) {
            srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        }
        console.log('INFO sources', JSON.stringify(srcs.map(s => ({ id: s.id, name: s.name }))));
        if (!srcs.length) { cb({}); return; }
        cb(audioMode === 'none' ? { video: srcs[0] } : { video: srcs[0], audio: audioMode });
    });
    session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(true));
    const win = new BrowserWindow({ width: 800, height: 600, show: true, webPreferences: { contextIsolation: true, sandbox: true } });
    win.webContents.on('console-message', (e) => {
        const m = e.message;
        if (m.startsWith('CHECK FAIL')) failed++;
        if (/^(CHECK|INFO|MODE)/.test(m)) console.log(m);
        const mode = /^MODE (\S+)/.exec(m);
        if (mode) audioMode = mode[1];
        if (m === 'DONE') { console.log(failed ? `RESULT ${failed} check(s) FAILED` : 'RESULT all checks passed'); app.exit(failed ? 1 : 0); }
    });
    setTimeout(() => { console.log('CHECK FAIL overall-timeout 240s'); app.exit(1); }, 240_000).unref();
    await win.loadFile(path.join(__dirname, 'index.html'));
});
