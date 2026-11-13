'use strict';
// Linux hardware-encode E2EE proof: ONE Electron (the real binary, the app's exact Linux switches, a real Wayland session
// with the render node passed in) running TWO windows of the share-e2e harness page (harness/share-e2e):
//   * the PUBLISHER publishes a 1080p60 WebGL "game" as a screen share through the app's own publish options, sender
//     params, lighter-copy gate and E2EE worker (installE2EEKey / stableE2EEOptions / E2EESenderCodecPin);
//   * the VIEWER subscribes through the app's quality arbiter and decrypts with the app's E2EE worker.
// Both talk to a THROWAWAY LiveKit v1.9.12 SFU on the internal docker network (run-e2e.sh). Nothing leaves the host.
// Output: $E2E_OUT (JSONL of every drained sample / event) and $E2E_OUT.summary.json.
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const E = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const OUT = E('E2E_OUT', '/out/e2e.jsonl');
const DIST = E('E2E_DIST', '/dist');
const SECS = +E('E2E_SECS', '40');
const WARM = +E('E2E_WARM', '15');
const FPS = +E('E2E_FPS', '60');
const CODEC = E('E2E_CODEC', 'h264');
const HIGH = E('E2E_HIGH', '0') === '1';
const W = +E('E2E_W', '1920'), H = +E('E2E_H', '1080');
const RES = E('E2E_RES', '1080p');

// The app's own launch-time decision (electron/linux-video-encode.ts, transpiled by run-e2e.sh and mounted at /lve).
const LVE = require('/lve/linux-video-encode.cjs');
const DECISION = LVE.decideLinuxHwEncode({
  platform: process.platform, mode: LVE.parseLinuxHwEncodeMode(process.env.CIPHERLINE_LINUX_HW_ENCODE), setting: true,
  hasSwitch: (n) => app.commandLine.hasSwitch(n), ledger: null, appVersion: 'e2e', now: Date.now(),
});
app.commandLine.appendSwitch('enable-features', ['WebRTCPipeWireCapturer', ...DECISION.features].join(','));
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.env.E2E_VERBOSE !== '1') app.commandLine.appendSwitch('log-level', '3');

const rows = [];
const write = (o) => { rows.push(o); try { fs.appendFileSync(OUT, JSON.stringify(o) + '\n'); } catch { /* ignore */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(DIST, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const f = p.endsWith('/') ? path.join(p, 'index.html') : p;
  if (!f.startsWith(DIST) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': mime[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

async function openPage(name, url, w, h) {
  const win = new BrowserWindow({ width: w, height: h, show: true, title: name, backgroundColor: '#000',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  win.webContents.on('console-message', (_e, _level, message) => {
    if (/error|warn|ScreenShare|lighter|E2EE|harness|encryption/i.test(message) && !/DevTools/.test(message)) write({ t: Date.now(), role: name, console: String(message).slice(0, 300) });
  });
  await win.loadURL(url);
  for (let i = 0; i < 100; i++) { if (await win.webContents.executeJavaScript('window.HREADY === true')) break; await sleep(200); }
  return win;
}
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * (s.length - 1))))]; };

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  write({ t: Date.now(), role: 'meta', electron: process.versions.electron, chrome: process.versions.chrome, hw_decision: DECISION, codec: CODEC, high: HIGH, fps: FPS, e2ee: !!process.env.E2E_KEY_PUB });
  const pub = await openPage('pub', url, 640, 360);
  const view = await openPage('view', url, 1280, 720);
  const pubInfo = await pub.webContents.executeJavaScript(`H.startPublisher(${JSON.stringify({
    url: process.env.E2E_URL, token: process.env.E2E_TOKEN_PUB, keyB64: process.env.E2E_KEY_PUB || null, codec: CODEC, high: HIGH, fps: FPS, width: W, height: H,
    resolution: RES, viewers: 1, source: 'canvas', gate: true, simulateHardware: false, exposeEncoder: true,
  })})`, true);
  write({ t: Date.now(), role: 'meta', pubInfo });
  await view.webContents.executeJavaScript(`H.startViewer(${JSON.stringify({ url: process.env.E2E_URL, token: process.env.E2E_TOKEN_VIEW, keyB64: process.env.E2E_KEY_VIEW || null })})`, true);

  const end = Date.now() + (WARM + SECS) * 1000;
  const warmEnd = Date.now() + WARM * 1000;
  while (Date.now() < end) {
    await sleep(5000);
    for (const [name, w] of [['pub', pub], ['view', view]]) {
      try {
        const d = await w.webContents.executeJavaScript('H.drain()', true);
        for (const s of d.samples) write({ ...s });
        for (const e of d.events) write({ ...e, from: name });
      } catch (e) { write({ t: Date.now(), role: name, drainError: String(e).slice(0, 200) }); }
    }
  }
  // ── summary ──
  const after = (r) => r.t >= warmEnd;
  const vs = rows.filter((r) => r.role === 'view' && typeof r.fps === 'number' && after(r));
  const ps = rows.filter((r) => r.role === 'pub' && after(r));
  const top = ps.map((r) => (r.layers || []).reduce((a, l) => ((l.w || 0) > ((a && a.w) || 0) ? l : a), null)).filter(Boolean);
  const annex = rows.filter((r) => r.kind === 'e2ee_annexb');
  const lastBy = (from) => annex.filter((r) => r.from === from).pop() || null;
  const sum = {
    decision: DECISION, codec: CODEC, high: HIGH, e2ee: !!process.env.E2E_KEY_PUB, key_mismatch: process.env.E2E_KEY_PUB !== process.env.E2E_KEY_VIEW,
    pub_encoder_impl: [...new Set(top.map((l) => l.impl))], pub_power_efficient: [...new Set(top.map((l) => l.hw))],
    pub_top_fps_p50: pct(top.map((l) => l.fps || 0), 50), pub_top_kbps_p50: pct(top.map((l) => l.kbps || 0), 50), pub_top_wh: top.length ? `${top[top.length - 1].w}x${top[top.length - 1].h}` : null,
    pub_pix_samples: [...new Set(ps.map((r) => r.pix).filter(Boolean))].slice(0, 6), pub_canvas_fps_p50: pct(ps.map((r) => r.canvasFps || 0), 50),
    pub_published: [...new Set(ps.map((r) => r.published))], pub_sent_codecs: [...new Set(ps.map((r) => r.sentCodecs))],
    view_codec: [...new Set(vs.map((r) => r.codec))], view_decoder: [...new Set(vs.map((r) => r.decoder))],
    view_fps_p50: pct(vs.map((r) => r.fps), 50), view_fps_p5: pct(vs.map((r) => r.fps), 5), view_decoded_seconds_with_frames: vs.filter((r) => r.fps > 0).length, view_seconds: vs.length,
    view_wh: vs.length ? `${vs[vs.length - 1].w}x${vs[vs.length - 1].h}` : null, view_freezes: vs.reduce((a, r) => a + (r.freezes || 0), 0), view_pli: vs.reduce((a, r) => a + (r.pli || 0), 0), view_keyframes_decoded: vs.reduce((a, r) => a + (r.kf || 0), 0),
    e2ee_annexb_pub: lastBy('pub'), e2ee_annexb_view: lastBy('view'),
    encryption_errors: rows.filter((r) => typeof r.m === 'string' && /encryption error/.test(r.m)).length + rows.filter((r) => r.kind === 'e2ee_decrypt_error').length,
    low_layer_events: rows.filter((r) => r.kind === 'share_low_layer').map((r) => `${r.on ? 'on' : 'off'}(${r.reason})`),
  };
  fs.writeFileSync(OUT + '.summary.json', JSON.stringify(sum, null, 2));
  console.log(JSON.stringify(sum, null, 2));
  server.close(); app.exit(0);
}).catch((e) => { console.error('e2e failed', e); try { fs.writeFileSync(OUT + '.summary.json', JSON.stringify({ error: String((e && e.stack) || e) })); } catch { /* ignore */ } app.exit(1); });
