'use strict';
// Linux screen-share matrix: the Electron test app. NO login, NO network to anything but loopback, NO account.
//
// It applies exactly the Chromium switches electron/main.ts applies on Linux (see APP_SWITCHES below) and then walks the
// same path a share takes in the real app:
//   desktopCapturer.getSources (window list first, screen list second)  ->  setDisplayMediaRequestHandler
//   ->  getDisplayMedia  ->  capture  ->  RTCPeerConnection encode  ->  native addon system audio (exclude self).
// Every stage is wrapped so one failure never hides the others; results are rewritten to $CELL_OUT after each stage.
const { app, BrowserWindow, desktopCapturer, session, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const OUT = process.env.CELL_OUT || '/out/app.json';
const PHASE_LOG = process.env.PHASE_LOG || '/out/phases.log';
const RUN = process.env.MATRIX_RUN || 'default';
const TESTS = new Set((process.env.MATRIX_TESTS || 'env,addon,webgl,gpu,sources,capture,encode-screen,audio').split(','));
const W = +process.env.MATRIX_W || 1280, H = +process.env.MATRIX_H || 720;
// The pattern window (the damage source). Default = the whole output; MATRIX_PAT_W/H shrink it so a big output is not dominated by drawing it.
const PAT_W = +process.env.MATRIX_PAT_W || W, PAT_H = +process.env.MATRIX_PAT_H || H;
const ADDON = process.env.ADDON || '/addon/audio_capture.node';
const TONES = process.env.TONES || '/tmp/tones';
const SCALE = +process.env.MATRIX_TIME_SCALE || 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the switches electron/main.ts applies on Linux ────────────────────────────────────────────────────────────────────
// buildChromiumMediaSwitches('linux', …): enable-features=WebRTCPipeWireCapturer + whatever decideLinuxHwEncode() says
// (AcceleratedVideoEncoder - ON by default since 2026-11-04, off with CIPHERLINE_LINUX_HW_ENCODE=0), main.ts:
// ozone-platform-hint=auto, log-level=3. The decision is the APP'S OWN function: run.sh transpiles
// electron/linux-video-encode.ts and mounts it at /lve (no mirrored copy to drift). A drift guard in run.sh greps
// main.ts / capture-flags.ts for the other literals.
// MATRIX_EXTRA_FEATURES: an EXPERIMENT knob (comma list) for features the app does not enable, e.g. VaapiLowPowerEncoderGen9x. Unset in every standard run.
const LVE = require('/lve/linux-video-encode.cjs');
const HW_DECISION = LVE.decideLinuxHwEncode({
  platform: process.platform,
  mode: LVE.parseLinuxHwEncodeMode(process.env.CIPHERLINE_LINUX_HW_ENCODE),
  setting: true,                       // Settings toggle at its default
  hasSwitch: (n) => app.commandLine.hasSwitch(n),
  ledger: null, appVersion: 'matrix', now: Date.now(),
});
const HW = HW_DECISION.enable;
// The app's own portal capture decisions (src/utils/sharePlatformSupport.ts portalCaptureRequest, portalCapturePlan.ts
// portalRetuneTouchesCapture): run.sh bundles them and mounts them at /pcr, so the `open-*` and `plan` cases ask for exactly what the app asks for.
let PCR = null; try { PCR = require('/pcr/portal-capture-plan.cjs'); } catch { /* the stages that need it say so */ }
const EXTRA_FEATURES = (process.env.MATRIX_EXTRA_FEATURES || '').split(',').filter(Boolean);
const ENABLE = ['WebRTCPipeWireCapturer', ...HW_DECISION.features, ...EXTRA_FEATURES];
app.commandLine.appendSwitch('enable-features', ENABLE.join(','));
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
if (process.env.MATRIX_VERBOSE !== '1') app.commandLine.appendSwitch('log-level', '3');
const APP_SWITCHES = { 'enable-features': ENABLE.join(','), 'ozone-platform-hint': 'auto', 'log-level': process.env.MATRIX_VERBOSE === '1' ? '(verbose, harness)' : '3' };

const R = { run: RUN, hw_flag: HW, hw_reason: HW_DECISION.reason, extra_features: EXTRA_FEATURES, switches: APP_SWITCHES, phases: [], stages: {}, errors: [] };
function save() { try { fs.writeFileSync(OUT, JSON.stringify(R, null, 2)); } catch (e) { console.error('save failed', e); } }
function phase(name) { const t = Date.now(); R.phases.push([t, name]); try { fs.appendFileSync(PHASE_LOG, `${t} ${name}\n`); } catch { /* ignore */ } }
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms: ${what}`)), ms))]);
async function stage(name, fn, ms = 120000) {
  if (!TESTS.has(name) && !TESTS.has(name.split('-')[0])) return;
  phase(`stage:${name}:begin`);
  const t0 = Date.now();
  try { R.stages[name] = await withTimeout(fn(), ms * SCALE, name); }
  catch (e) { R.stages[name] = { error: String(e && e.message || e) }; R.errors.push(`${name}: ${e && e.message || e}`); }
  R.stages[name] && typeof R.stages[name] === 'object' && (R.stages[name]._ms = Date.now() - t0);
  phase(`stage:${name}:end`); save();
}

// ── FFT (for the in-Electron audio self-exclusion test) ───────────────────────────────────────────────────────────────
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = i + k + len / 2; const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } }
  }
}
const RATE = 48000, N = 65536;
function dbAt(x, hz) {
  const re = new Float64Array(N), im = new Float64Array(N); const start = Math.max(0, x.length - N); let ws = 0;
  for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); re[i] = (x[start + i] || 0) * w; ws += w; }
  fft(re, im); const k0 = Math.round((hz * N) / RATE); let best = 0;
  for (let k = k0 - 3; k <= k0 + 3; k++) best = Math.max(best, (2 * Math.hypot(re[k], im[k])) / ws);
  return best > 1e-9 ? +(20 * Math.log10(best)).toFixed(1) : -180;
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const sh = (cmd, args, o = {}) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], ...o }).trim(); } catch (e) { return null; } };
function childCmdlines() {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { out.push({ pid: +d, ppid: +fs.readFileSync(`/proc/${d}/stat`, 'utf8').replace(/^.*\) \S+ /, '').split(' ')[0], cmd: fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' ') }); } catch { /* gone */ }
  }
  return out;
}

let patternWin = null, runnerWin = null, chosen = null, lastPatternStats = [];
ipcMain.on('pattern-stat', (_e, counter, t) => { lastPatternStats.push([counter, t]); if (lastPatternStats.length > 4000) lastPatternStats.shift(); });
/** rAF-tick rate of the pattern window between two wall-clock instants — the real SOURCE frame rate the capture is chasing. */
function patternFps(t0, t1) {
  const s = lastPatternStats.filter(([, t]) => t >= t0 && t <= t1);
  if (s.length < 2) return null;
  const dc = ((s[s.length - 1][0] - s[0][0]) & 0xffffff), dt = (s[s.length - 1][1] - s[0][1]) / 1000;
  return dt > 0 ? +(dc / dt).toFixed(1) : null;
}

async function createPattern() {
  patternWin = new BrowserWindow({
    width: PAT_W, height: PAT_H, x: 0, y: 0, frame: false, show: true, title: 'CL-MATRIX-PATTERN', backgroundColor: '#000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await patternWin.loadFile(path.join(__dirname, 'pattern.html'), { 'hash': `w=${PAT_W}&h=${PAT_H}` });
  patternWin.setTitle('CL-MATRIX-PATTERN');
}
async function createRunner() {
  runnerWin = new BrowserWindow({
    width: 800, height: 600, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  await runnerWin.loadFile(path.join(__dirname, 'runner.html'));
  await runnerWin.webContents.executeJavaScript(`T.setPatternWidth(${W})`);
}
const inRunner = (code, ms = 60000) => withTimeout(runnerWin.webContents.executeJavaScript(code, true), ms * SCALE, code.slice(0, 60));

// The display-media handler, in the two shapes the app has had on the portal:
//   'chosen'       BEFORE: the picker listed the sources earlier (a chooser), the handler answers getDisplayMedia with that id
//                  (electron/main.ts desktop-capturer-resolve). The portal ignores the id and opens its chooser AGAIN.
//   'portal-placeholder'  AFTER: nothing lists; the handler answers the capture with a placeholder id and the capture's own chooser
//                  picks (electron/main.ts desktop-capturer-resolve + electron/portal-source.ts). One chooser per capture.
//   'portal-list'  (experiment only) the handler lists inside the request and answers with the listed source: 2 choosers, see stage probe.
let handlerCalls = 0;
let handlerMode = 'chosen';
let pickPlaceholder = 'screen:portal-a:0';
let portalPicks = null;
function installDisplayMediaHandler(mode) {
  if (mode) handlerMode = mode;
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    handlerCalls++;
    phase(`handler:call:${handlerCalls}`);
    // (a NEW numeric id per capture, like electron/portal-source.ts portalCaptureVideo: with the same id twice Chromium attaches the
    //  second capture to the running one - no new portal session, no chooser, and the user's second answer is never asked for)
    if (handlerMode === 'portal-placeholder') { callback({ video: { id: `screen:${1000 + handlerCalls}:0`, name: 'Screen or window' } }); return; }
    // 'portal-pick': electron/main.ts desktop-capturer-resolve in portalRestoreMode 'listed', with the APP'S OWN planPortalPick /
    //   pickFromListing (bundled at /pcr): a NEW placeholder lists once (the one dialog) and is answered with the listed id; the SAME
    //   placeholder is answered from its pick and never lists; a listing with no source is a cancel.
    if (handlerMode === 'portal-pick') {
      const ph = pickPlaceholder;
      const plan = PCR.planPortalPick(portalPicks, ph);
      if (plan.action === 'reuse') { phase(`handler:pick:reuse:${ph}`); callback({ video: plan.source }); return; }
      phase(`handler:pick:list:${ph}`);
      let listed = [];
      try { listed = await desktopCapturer.getSources({ types: (process.env.MATRIX_PICK_TYPES || 'window').split(','), thumbnailSize: { width: 0, height: 0 } }); } catch { listed = []; }
      const pk = PCR.pickFromListing(listed);
      if (!pk) { phase('handler:pick:closed'); callback(null); return; }
      portalPicks.set(ph, pk); callback({ video: pk }); return;
    }
    if (handlerMode === 'portal-list') {
      try {
        const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
        const picked = list[0];
        if (!picked) { callback(null); return; }
        callback({ video: { id: picked.id, name: picked.name } });
      } catch { callback(null); }
      return;
    }
    if (!chosen) { callback({}); return; }
    callback({ video: { id: chosen.id, name: chosen.name } });
  });
}

async function listSources(types, thumb, tag = 'getSources') {
  const label = types.join('+');
  const t0 = Date.now(); phase(`${tag}:${label}:begin`);
  try {
    const s = await withTimeout(desktopCapturer.getSources({ types, thumbnailSize: thumb }), 30000 * SCALE, `getSources ${label}`);
    phase(`${tag}:${label}:end`);
    return { ok: true, ms: Date.now() - t0, sources: s.map((x) => ({ id: x.id, name: x.name, display_id: x.display_id, thumb: x.thumbnail && !x.thumbnail.isEmpty() ? x.thumbnail.getSize() : null })), _raw: s };
  } catch (e) { phase(`${tag}:${label}:fail`); return { ok: false, ms: Date.now() - t0, error: String(e && e.message || e), sources: [] }; }
}

// ── CPU + PipeWire probes for the capture-rate stage ───────────────────────────────────────────────────────────────────
// clock ticks (1/100 s) of user+system time. `app` = every process of the Electron under test; `comp` = the desktop side of the
// capture (compositor, portal backend, PipeWire), which is where a capture opened at full rate costs too.
const COMP = /^(sway|kwin_wayland|mutter|gnome-shell|xdg-desktop-por.*|xdg-desktop-portal|pipewire|wireplumber|xdpw.*)$/;
function cpuTicks() {
  const o = { app: 0, comp: {} };
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const m = st.match(/^\d+ \((.*)\) (.*)$/s); if (!m) continue;
      const f = m[2].split(' '); const t = (+f[11]) + (+f[12]);
      let exe = ''; try { exe = fs.readlinkSync(`/proc/${d}/exe`); } catch { /* gone / not ours */ }
      if (exe.startsWith('/electron/')) o.app += t;
      else if (COMP.test(m[1])) o.comp[m[1]] = (o.comp[m[1]] || 0) + t;
    } catch { /* gone */ }
  }
  o.compTotal = Object.values(o.comp).reduce((a, b) => a + b, 0);
  return o;
}
const cpuPct = (a, b, secs) => ({ app: +(((b.app - a.app) / 100) / secs * 100).toFixed(1), comp: +(((b.compTotal - a.compTotal) / 100) / secs * 100).toFixed(1) });
/** What PipeWire says the video streams negotiated (pw-dump): the capture's own rate/size at the source, below Chromium. */
function pwVideo() {
  const raw = sh('pw-dump', [], { timeout: 15000, maxBuffer: 64 << 20 });
  if (!raw) return null;
  let objs; try { objs = JSON.parse(raw); } catch { return null; }
  const out = [];
  for (const o of objs) {
    if (o.type !== 'PipeWire:Interface:Node') continue;
    const pr = (o.info && o.info.props) || {};
    const cls = pr['media.class'] || '';
    const fmt = o.info && o.info.params && o.info.params.Format;
    if (!/Video/.test(cls) && !(fmt && fmt.length && fmt[0].mediaType === 'video')) continue;
    const f = fmt && fmt[0];
    out.push({ id: o.id, name: pr['node.name'] || pr['application.name'], cls, state: o.info.state,
      format: f ? { size: f.size, framerate: f.framerate, maxFramerate: f.maxFramerate, format: f.format } : null });
  }
  return out;
}

async function main() {
  await app.whenReady();
  const t0 = Date.now();

  // ── env ──
  await stage('env', async () => {
    const procs = childCmdlines();
    const gpuProc = procs.find((p) => /--type=gpu-process/.test(p.cmd));
    const ozone = gpuProc && (gpuProc.cmd.match(/--ozone-platform=(\w+)/) || [])[1];
    const audioProc = procs.find((p) => /audio\.mojom\.AudioService/.test(p.cmd));
    let gpuInfo = null;
    try { gpuInfo = await app.getGPUInfo('basic'); } catch (e) { gpuInfo = { error: String(e) }; }
    const dev = gpuInfo && gpuInfo.gpuDevice ? gpuInfo.gpuDevice.map((d) => ({ vendorId: d.vendorId, deviceId: d.deviceId, active: d.active, driverVendor: d.driverVendor, driverVersion: d.driverVersion })) : [];
    const aux = (gpuInfo && gpuInfo.auxAttributes) || {};
    return {
      electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
      xdgSessionType: process.env.XDG_SESSION_TYPE || null, waylandDisplay: process.env.WAYLAND_DISPLAY || null, display: process.env.DISPLAY || null,
      currentDesktop: process.env.XDG_CURRENT_DESKTOP || null,
      effectiveOzonePlatform: ozone || null,          // from the GPU process's own command line
      gpuProcessCmd: gpuProc ? gpuProc.cmd.slice(0, 400) : null,
      audioServicePid: audioProc ? audioProc.pid : null, mainPid: process.pid,
      featureStatus: app.getGPUFeatureStatus(),
      gpuDevices: dev, glRenderer: aux.glRenderer || null, glVendor: aux.glVendor || null, glImplementation: aux.glImplementationParts || null,
      displayFrequencyHz: screen.getPrimaryDisplay().displayFrequency, displaySize: screen.getPrimaryDisplay().size, scaleFactor: screen.getPrimaryDisplay().scaleFactor,
      pipewire: sh('pipewire', ['--version']), loadavg: fs.readFileSync('/proc/loadavg', 'utf8').trim(),
      gpuInfoKeys: gpuInfo ? Object.keys(gpuInfo) : null,
    };
  });

  // ── addon (loaded the way main.ts loads it: lazily, after ready) ──
  let addon = null;
  await stage('addon', async () => {
    const t = Date.now();
    try { addon = require(ADDON); } catch (e) { return { loaded: false, error: String(e && e.message || e).slice(0, 600) }; }
    let supported = null; try { supported = addon.isSupported ? addon.isSupported() : null; } catch (e) { supported = 'threw: ' + e.message; }
    // The addon `npm run rebuild-native` produced on the dev box: does THIS distro's libc accept it?
    let hostBuilt = null;
    if (process.env.ADDON_HOST && fs.existsSync(process.env.ADDON_HOST)) {
      try { process.dlopen({ exports: {} }, process.env.ADDON_HOST); hostBuilt = { loads: true }; }
      catch (e) { hostBuilt = { loads: false, error: String(e && e.message || e).slice(0, 300) }; }
    }
    return { loaded: true, loadMs: Date.now() - t, exports: Object.keys(addon).sort(), isSupported: supported, hostBuilt };
  });

  // ── webgl ──
  await stage('webgl', async () => {
    const win = new BrowserWindow({ width: 256, height: 256, x: 0, y: 0, frame: false, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await win.loadFile(path.join(__dirname, 'webgl.html'));
      const probes = {};
      for (const k of ['dots-webgl1', 'webgl1', 'webgl2']) probes[k] = await win.webContents.executeJavaScript(`runWebglProbe(${JSON.stringify(k)})`);
      await win.webContents.executeJavaScript('startOnscreen()');
      await sleep(1500);
      const img = await win.webContents.capturePage();
      const bmp = img.toBitmap(); const sz = img.getSize();
      const o = (Math.floor(sz.height / 2) * sz.width + Math.floor(sz.width / 2)) * 4;
      const center = [bmp[o + 2], bmp[o + 1], bmp[o], bmp[o + 3]];                  // BGRA -> RGBA
      const presented = Math.abs(center[0] - 255) < 12 && center[1] < 12 && Math.abs(center[2] - 128) < 12;
      return { probes, presented: { size: sz, centerPixel: center, ok: presented, note: 'capturePage of the window with a continuously redrawn WebGL canvas: is the drawn point composited?' } };
    } finally { win.destroy(); }
  });

  // ── sources + capture ──
  let screenSrc = null, windowSrc = null;
  if (TESTS.has('sources') || TESTS.has('capture') || TESTS.has('probe') || TESTS.has('flow') || TESTS.has('cancel') || TESTS.has('rate') || TESTS.has('restore') || TESTS.has('pickflow')) {
    installDisplayMediaHandler();
    await createPattern();
    await sleep(1500);
    await createRunner();
  }
  await stage('sources', async () => {
    // exactly the picker's order (main.ts 'desktop-capturer-get-sources'): window list first, WITHOUT screens, then the screen list
    const win = await listSources(['window'], { width: 0, height: 0 });
    const scr = await listSources(['screen'], { width: 320, height: 200 });
    windowSrc = win.sources.find((s) => /CL-MATRIX-PATTERN/.test(s.name)) || null;
    // Wayland lists a single anonymous window entry (the real choice is made in the portal): capture that one instead.
    let windowPick = windowSrc ? 'by-title' : null;
    if (!windowSrc && win.sources.length) { windowSrc = win.sources[0]; windowPick = 'first-source (no title match)'; }
    screenSrc = scr.sources[0] || null;
    const pid = (addon && windowSrc && addon.getPidFromSourceId) ? (() => { try { return addon.getPidFromSourceId(windowSrc.id); } catch (e) { return 'threw: ' + e.message; } })() : null;
    const strip = (x) => { const { _raw, ...rest } = x; return rest; };
    return { windowList: strip(win), screenList: strip(scr), patternWindowFound: windowPick === 'by-title', windowPick, patternWindowSourceId: windowSrc && windowSrc.id, addonPidForPatternWindow: pid, mainPid: process.pid };
  });

  // EXPERIMENT stage (MATRIX_TESTS=probe only): which capture shapes cost how many ScreenCast.Start calls. Every variant pulls frames
  // (a capture's own Start is lazy: it happens when the first sink attaches, NOT when getDisplayMedia resolves) and waits for late
  // Starts before the next variant begins.
  await stage('probe', async () => {
    const out = {};
    const answer = (fn) => session.defaultSession.setDisplayMediaRequestHandler(async (_rq, callback) => { handlerCalls++; try { await fn(callback); } catch { callback(null); } });
    const variant = async (label, fn, secs = 2) => {
      handlerCalls = 0; answer(fn); phase(`probe:${label}:begin`);
      const r = {};
      try {
        r.start = await inRunner('T.startShareMax(75, 3840, 2160)', 60000);
        const m = await inRunner(`T.measureTrack(${secs}, 30)`, 40000);
        r.fps = m.fps; r.frameSize = m.frameSize; r.decodeError = m.decodeError;
      } catch (e) { r.error = String(e && e.message || e); }
      r.handlerCalls = handlerCalls;
      await sleep(2500);
      try { await inRunner('T.stopShare()'); } catch { /* none */ }
      await sleep(2000);
      out[label] = r;
    };
    // V1: no listing: the handler answers with an id made up on the spot (the capturer opens its OWN chooser)
    await variant('V1-synthetic-screen-id', async (cb) => cb({ video: { id: 'screen:0:0', name: 'Entire screen' } }));
    // V2: no listing, a made-up WINDOW id
    await variant('V2-synthetic-window-id', async (cb) => cb({ video: { id: 'window:0:0', name: 'Window' } }));
    // V3: the listing inside the handler (the Electron docs shape), the answer is the listed source
    await variant('V3-list-in-handler', async (cb) => {
      const s = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      cb({ video: { id: s[0].id, name: s[0].name } });
    });
    // V4: the listing inside the handler, but only screens
    await variant('V4-list-screen-in-handler', async (cb) => {
      const s = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      cb({ video: { id: s[0].id, name: s[0].name } });
    });
    installDisplayMediaHandler();
    return out;
  }, 400000);

  // ── FLOW A/B: what ONE user decision costs in portal prompts ──────────────────────────────────────────────────────────
  // BEFORE (control, the app as shipped until 2026-11-04): the picker lists both types once (a chooser), the capture then asks
  // AGAIN (the selection is not held for it), every frame-rate change on the live share is applyConstraints on the capture (a
  // new portal session each), and a change of source is the whole thing over.
  // AFTER (the one-prompt flow, electron/main.ts + sharePlatformSupport): nothing lists; the display-media handler answers the
  // capture with a placeholder (electron/portal-source.ts) and the capture's own chooser is the only one. The capture is asked
  // for ONCE at the share's maximum; frame rate / size are retuned on the RTP sender (maxFramerate / scaleResolutionDownBy); a
  // republish clones the live capture; a change of source is one more capture, acquired while the old one keeps running.
  // Every step is a "flow:<flow>:<step>:begin" marker and ends with frames pulled + a wait: a capture's own portal session starts
  // LAZILY (when the first sink attaches), so the step that owns a Start must still be the current one when it happens.
  // analyze-portal.mjs counts ScreenCast.Start calls per step.
  const MAXFPS = /kde/i.test(process.env.XDG_CURRENT_DESKTOP || '') ? 113 : 75;      // portalCaptureRequest: captureFrameRateFor(90, ceiling or none)
  const TAIL = 2500;                                                                // late Starts land inside the step that caused them
  const failed = (e) => ({ error: String(e && e.message || e) });
  await stage('flow-before', async () => {
    const out = { steps: [] };
    installDisplayMediaHandler('chosen');
    handlerCalls = 0;
    const l = await listSources(['screen', 'window'], { width: 0, height: 0 }, 'flow:before:pick');
    chosen = l.sources[0] || null;
    out.picked = chosen && { id: chosen.id, name: chosen.name };
    if (!chosen) return { ...out, skipped: 'the chooser produced no source' };
    await sleep(TAIL);
    phase('flow:before:capture:begin');
    out.start = await inRunner('T.startShare(30)', 60000).catch(failed);
    await inRunner('T.pull(2)', 30000).catch(failed);
    await sleep(TAIL);
    for (const f of [60, 90]) {
      phase(`flow:before:retune-${f}:begin`);
      const m = await inRunner(`T.measureTrack(3, ${f})`, 40000).catch(failed);
      out.steps.push({ step: `retune-${f}`, via: 'applyConstraints on the capture', rawFps: m.fps, applyConstraintsError: m.applyConstraintsError || null });
      await sleep(TAIL);
    }
    // change source: the picker again (list), then the capture again
    const l2 = await listSources(['screen', 'window'], { width: 0, height: 0 }, 'flow:before:change-pick');
    chosen = l2.sources[0] || chosen;
    await sleep(TAIL);
    phase('flow:before:change-capture:begin');
    out.change = await inRunner('T.startShare(30)', 60000).catch(failed);
    await inRunner('T.pull(2)', 30000).catch(failed);
    await sleep(TAIL);
    phase('flow:before:end');
    out.handlerCalls = handlerCalls;
    try { await inRunner('T.stopShare()'); } catch { /* none */ }
    await sleep(1500);
    return out;
  }, 400000);

  await stage('flow-after', async () => {
    const out = { steps: [], maxFps: MAXFPS };
    installDisplayMediaHandler('portal-placeholder');
    handlerCalls = 0;
    phase('flow:after:capture:begin');
    out.start = await inRunner(`T.startShareMax(${MAXFPS}, 3840, 2160)`, 90000).catch(failed);
    if (out.start.error) return out;
    out.pull = await inRunner('T.pull(2)', 30000).catch(failed);
    await sleep(TAIL);
    out.handlerCalls = handlerCalls;
    await inRunner("T.senderOpen('video/VP8', '', 8e6, 30)");
    const step = async (name, via, fn) => {
      phase(`flow:after:${name}:begin`);
      const r = await fn();
      const m = await inRunner('T.senderMeasure(3)', 30000).catch(failed);
      await sleep(TAIL);
      out.steps.push({ step: name, via, ...r, ...m });
    };
    await step('fps-30', 'sender maxFramerate', () => inRunner('T.senderRetune(30)'));
    await step('fps-60', 'sender maxFramerate', () => inRunner('T.senderRetune(60)'));
    await step('fps-90', 'sender maxFramerate', () => inRunner('T.senderRetune(90)'));
    await step('size-half', 'sender scaleResolutionDownBy', () => inRunner('T.senderRetune(60, 2)'));
    await step('fps-30-again', 'sender maxFramerate', () => inRunner('T.senderRetune(30, 1)'));
    // a republish (codec drift / encoder stall / hardware-encoder rule) keeps the live capture: a clone, the old track stopped
    await step('republish', 'clone of the live capture', () => inRunner("T.cloneAndRepublish('video/VP8', '', 8e6, 30)").catch(failed));
    // a change of source: one more capture, acquired while the old share is still live
    phase('flow:after:change:begin');
    out.change = await inRunner(`T.acquireNext(${MAXFPS}, 3840, 2160)`, 90000).catch(failed);
    if (!out.change.error) {
      await inRunner('T.pull(2)', 30000).catch(failed);
      await inRunner("T.senderOpen('video/VP8', '', 8e6, 30)");
      out.steps.push({ step: 'after-change', via: 'new capture on a new sender', ...(await inRunner('T.senderMeasure(3)', 30000).catch(failed)) });
    }
    await sleep(TAIL);
    phase('flow:after:end');
    out.handlerCalls = handlerCalls;
    try { await inRunner('T.senderClose()'); await inRunner('T.stopShare()'); } catch { /* none */ }
    installDisplayMediaHandler('chosen');
    return out;
  }, 400000);


  // ── CAPTURE RATE: is the capture itself at the chosen rate/size, and can a live change move it without a chooser? ──────────
  // Every case: fresh portal capture (placeholder id, one Start), frames pulled (the session starts lazily), a VP8 loopback with
  // maxFramerate = the chosen rate, then ONE window that reads the capture (source), the encoder (pc1) and the far end (pc2) together.
  // CPU of the Electron tree and of the desktop side (compositor + portal + PipeWire) over the same window.
  //   open-<fps>-<size>   the capture is OPENED at the chosen rate and box (portalCaptureRequest at the choice, not at the maximum)
  //   old-<fps>-<size>    NEGATIVE CONTROL: the capture opened at the share's maximum (what a3dbc5b3 does), the choice applied on the
  //                       sender only (maxFramerate / scaleResolutionDownBy)
  //   live-*              ONE capture opened at 90 fps and the source box, then applyConstraints({frameRate | width,height}) up and down
  const RW = +process.env.MATRIX_W || W, RH = +process.env.MATRIX_H || H;
  const BOX = { '1080p': [1920, 1080], '1440p': [2560, 1440], 'source': null };
  const pick = (env, dflt) => (process.env[env] || dflt).split(',').filter(Boolean);
  const RSECS = +process.env.MATRIX_RATE_SECS || 6;
  // What the app asks the portal for at a pick (portalCaptureRequest, bundled from src/): the box of the picked size, the picked rate.
  // Wayland's capture-rate ceiling: 60, except KDE (electron/capture-flags.ts captureFpsCeiling).
  const CEILING = /kde/i.test(process.env.XDG_CURRENT_DESKTOP || '') ? null : 60;
  const appRequest = (fps, size) => PCR.portalCaptureRequest({ resolution: size, frameRate: fps }, CEILING);
  const capOf = (fps, size) => { const r = appRequest(fps, size); return { width: { max: r.box.width }, height: { max: r.box.height }, frameRate: { max: r.frameRate } }; };
  const CODEC = process.env.MATRIX_RATE_CODEC || 'video/H264';
  async function rateCase(label, openC, sendFps, scaleDown, secs) {
    handlerCalls = 0;
    phase(`rate:${label}:begin`);
    const r = { label, request: openC, sendFps, scaleDown };
    try {
      r.start = await inRunner(`T.rateOpen(${JSON.stringify(openC)})`, 90000);
      r.pull = await inRunner('T.pull(2)', 30000);
      await sleep(1500);
      await inRunner(`T.senderOpen('${CODEC}', '', 12e6, ${sendFps})`);
      if (scaleDown && scaleDown !== 1) await inRunner(`T.senderRetune(${sendFps}, ${scaleDown})`);
      await sleep(800);
      const c0 = cpuTicks(); const t0 = Date.now();
      r.m = await inRunner(`T.rateMeasure(${secs})`, (secs + 40) * 1000);
      const c1 = cpuTicks(); r.cpu = cpuPct(c0, c1, (Date.now() - t0) / 1000);
      r.patternFps = patternFps(t0, Date.now());
      r.pw = pwVideo();
    } catch (e) { r.error = String(e && e.message || e); }
    r.handlerCalls = handlerCalls;
    await sleep(TAIL);
    try { await inRunner('T.senderClose()'); await inRunner('T.stopShare()'); } catch { /* none */ }
    await sleep(2000);
    return r;
  }
  await stage('rate', async () => {
    // MATRIX_RATE_HANDLER=chosen: the captures are answered with a LISTED source (the real app's listed-id path); the listing is the
    // pick (MATRIX_RATE_PICK = comma list of types, MATRIX_RATE_PICK_THUMB = thumbnail edge, 0 = none). Default: placeholder ids (the one-prompt path).
    const listed = process.env.MATRIX_RATE_HANDLER === 'chosen';
    installDisplayMediaHandler(listed ? 'chosen' : 'portal-placeholder');
    const out = { output: [RW, RH], maxFps: MAXFPS, cases: [], handler: listed ? 'chosen' : 'portal-placeholder' };
    if (listed && !process.env.MATRIX_RATE_PICK) {
      // the `sources` stage (MATRIX_TESTS=sources,rate) already listed: its screen entry is the pick
      chosen = screenSrc; out.pick = { id: chosen && chosen.id, name: chosen && chosen.name, from: 'sources stage' };
      if (!chosen) return { ...out, skipped: 'no listed screen source' };
    } else if (listed) {
      const th = +process.env.MATRIX_RATE_PICK_THUMB || 0;
      phase('rate:pick:begin');
      const l = await listSources(pick('MATRIX_RATE_PICK', 'screen'), { width: th, height: th }, 'rate:pick-list');
      chosen = l.sources[0] || null;
      out.pick = { id: chosen && chosen.id, name: chosen && chosen.name, error: l.error, thumb: th };
      if (!chosen) return out;
      await sleep(TAIL);
    }
    const fpsList = pick('MATRIX_RATE_FPS', '30,60,90').map(Number), sizes = pick('MATRIX_RATE_SIZES', '1080p,1440p,source');
    const modes = pick('MATRIX_RATE_MODES', 'open,old,live');
    if (modes.includes('open')) for (const size of sizes) for (const fps of fpsList) out.cases.push(await rateCase(`open-${fps}-${size}`, capOf(fps, size), fps, 1, RSECS));
    if (modes.includes('old')) for (const size of sizes) for (const fps of fpsList) {
      const h = BOX[size] ? Math.min(BOX[size][1], RH) : RH;
      out.cases.push(await rateCase(`old-${fps}-${size}`, { width: { max: 3840 }, height: { max: 2160 }, frameRate: { max: MAXFPS } }, fps, +(RH / h).toFixed(3), RSECS));
    }
    if (modes.includes('live')) {
      out.lives = [];
      for (const withSender of pick('MATRIX_RATE_LIVE_SENDER', '0,1').map((x) => x === '1')) {
        const tag = withSender ? 'lives' : 'live';
        const live = { withSender, steps: [] }; out.lives.push(live);
        handlerCalls = 0; phase(`rate:${tag}-open:begin`);
        try {
          live.start = await inRunner(`T.rateOpen(${JSON.stringify({ frameRate: { max: 90 } })})`, 90000);
          await inRunner('T.pull(2)', 30000); await sleep(TAIL);
          if (withSender) await inRunner(`T.senderOpen('${CODEC}', '', 12e6, 90)`);
          const step = async (name, c, sendFps) => {
            phase(`rate:${tag}-${name}:begin`);
            const a = await inRunner(`T.rateApply(${JSON.stringify(c)})`, 60000).catch(failed);
            await inRunner('T.pull(2)', 30000).catch(failed);
            await sleep(TAIL);
            if (withSender && sendFps) await inRunner(`T.senderRetune(${sendFps})`).catch(failed);
            const c0 = cpuTicks(); const t0 = Date.now();
            const m = await inRunner(`T.rateMeasure(${RSECS})`, 60000).catch(failed);
            live.steps.push({ step: `${tag}-${name}`, applied: c, applyResult: a, m, cpu: cpuPct(c0, cpuTicks(), (Date.now() - t0) / 1000), patternFps: patternFps(t0, Date.now()), pw: pwVideo() });
          };
          await step('base', { frameRate: { max: 90 } }, 90);
          await step('down-30', { frameRate: { max: 30, ideal: 30 } }, 30);
          await step('up-90', { frameRate: { max: 90, ideal: 90 } }, 90);
          await step('down-1080p', { width: { max: 1920 }, height: { max: 1080 } }, 90);
          await step('up-source', { width: { max: 3840 }, height: { max: 2160 } }, 90);
        } catch (e) { live.error = String(e && e.message || e); }
        await sleep(TAIL);
        try { await inRunner('T.senderClose()'); await inRunner('T.stopShare()'); } catch { /* none */ }
        await sleep(2000);
      }
    }
    if (modes.includes('cpu')) {
      // CPU, interleaved so drift in the box hits both alike: MATRIX_RATE_CPU_ROUNDS x (open at 30 fps 1080p, then the old full-rate capture
      // with the same 30 fps sender), MATRIX_RATE_SECS each, sender included (the real pipeline).
      for (let i = 1; i <= (+process.env.MATRIX_RATE_CPU_ROUNDS || 3); i++) {
        out.cases.push(await rateCase(`open-30-1080p-r${i}`, capOf(30, '1080p'), 30, 1, RSECS));
        out.cases.push(await rateCase(`old-30-1080p-r${i}`, { width: { max: 3840 }, height: { max: 2160 }, frameRate: { max: MAXFPS } }, 30, +(RH / 1080).toFixed(3), RSECS));
      }
    }
    if (modes.includes('plan')) {
      // The app's own live-retune decision (portalRetuneTouchesCapture) replayed on ONE share: start at the pick, then raise and lower
      // the quality the way the chips and the step-down do. `listed` = the desktop restores a listed source silently (GNOME), the capture
      // follows every change; otherwise only a raise past what the capture was asked for re-opens it and a lower choice is the sender's.
      const restoreListed = (process.env.MATRIX_RATE_RESTORE || (/gnome/i.test(process.env.XDG_CURRENT_DESKTOP || '') ? 'listed' : 'single')) === 'listed';
      const plan = { restoreListed, steps: [] }; out.plan = plan;
      const seq = pick('MATRIX_RATE_PLAN', '1080p@30,1440p@60,1080p@30,source@90,720p@30,1080p@60').map((x) => { const [r, f] = x.split('@'); return { res: r, fps: +f }; });
      handlerCalls = 0;
      const first = seq[0]; let asked = null;
      phase('rate:plan-open:begin');
      try {
        const o = appRequest(first.fps, first.res);
        asked = { fps: o.frameRate, width: o.box.width, height: o.box.height };
        plan.start = await inRunner(`T.rateOpen(${JSON.stringify(capOf(first.fps, first.res))})`, 90000);
        await inRunner('T.pull(2)', 30000); await sleep(TAIL);
        await inRunner(`T.senderOpen('${CODEC}', '', 12e6, ${first.fps})`);
        for (let i = 0; i < seq.length; i++) {
          const st = seq[i]; const want = appRequest(st.fps, st.res);
          const wantAsk = { fps: want.frameRate, width: want.box.width, height: want.box.height };
          const name = `plan-${i}-${st.res}@${st.fps}`;
          phase(`rate:${name}:begin`);
          let touched = false; let applyResult = null;
          if (i > 0) {
            touched = PCR.portalRetuneTouchesCapture({ restoreListed, asked, want: wantAsk });
            if (touched) { applyResult = await inRunner(`T.rateApply(${JSON.stringify({ width: { max: wantAsk.width }, height: { max: wantAsk.height }, frameRate: { max: wantAsk.fps } })})`, 60000).catch(failed); asked = wantAsk; }
            // the sender: the chosen rate, and the chosen size as a scale of the capture AS IT IS (1 when the capture was just re-opened at it)
            const fit = (w, h, bw, bh) => { const k = Math.min(1, bw / w, bh / h); return [Math.round(w * k), Math.round(h * k)]; };
            const [cw, ch] = fit(RW, RH, asked.width, asked.height);
            const scale = Math.max(1, cw / wantAsk.width, ch / wantAsk.height);
            await inRunner(`T.senderRetune(${st.fps}, ${scale.toFixed(4)})`).catch(failed);
          }
          await inRunner('T.pull(2)', 30000).catch(failed); await sleep(TAIL);
          const c0 = cpuTicks(); const t0 = Date.now();
          const m = await inRunner(`T.rateMeasure(${RSECS})`, 60000).catch(failed);
          plan.steps.push({ step: name, touchedCapture: touched, asked: wantAsk, applyResult, m, cpu: cpuPct(c0, cpuTicks(), (Date.now() - t0) / 1000), patternFps: patternFps(t0, Date.now()) });
        }
      } catch (e) { plan.error = String(e && e.message || e); }
      await sleep(TAIL);
      try { await inRunner('T.senderClose()'); await inRunner('T.stopShare()'); } catch { /* none */ }
    }
    installDisplayMediaHandler('chosen');
    return out;
  }, 1500000);


  // ── RESTORE: does the portal ask AGAIN for a capture it already asked about? ────────────────────────────────────────────
  // Chromium's PipeWire capturer sends persist_mode=1 on every session and a restore_token once it holds one (only sessions of
  // a LISTING - desktopCapturer.getSources - were seen to hand it one; a plain getDisplayMedia did not, see README). A backend
  // that honours the token starts the session with NO dialog. So `ScreenCast.Start` is not "a chooser"; the dialogs are counted
  // from the backend's own log (inside/dialogs.mjs). Steps (one marker each, `restore:<step>:begin`):
  //   L1 list      getSources(types)             - the first dialog of the share
  //   C1 capture   getDisplayMedia, answered with the LISTED id
  //   Q1/Q2        applyConstraints down / up on the live capture (a restart = a new portal session)
  //   X nolist     a capture with NO listing (placeholder id) while a token is held: does it silently take the OLD source?
  //   L2 list      getSources again               - the Change source dialog
  //   C2 capture   getDisplayMedia, answered with the (new) listed id
  await stage('restore', async () => {
    const out = { steps: [] };
    const types = pick('MATRIX_RESTORE_TYPES', 'window');
    const mark = (n) => phase(`restore:${n}:begin`);
    const measure = async (name, extra = {}) => {
      await inRunner('T.pull(2)', 30000).catch(failed); await sleep(TAIL);
      const m = await inRunner('T.rateMeasure(4)', 60000).catch(failed);
      out.steps.push({ step: name, ...extra, m });
    };
    installDisplayMediaHandler('chosen'); handlerCalls = 0;
    mark('L1-list');
    const l1 = await listSources(types, { width: 0, height: 0 }, 'restore:list1'); chosen = l1.sources[0] || null;
    out.steps.push({ step: 'L1-list', picked: chosen && chosen.name, error: l1.error });
    if (!chosen) return out;
    await sleep(TAIL);
    mark('C1-capture');
    const c1 = await inRunner(`T.rateOpen(${JSON.stringify({ frameRate: { max: 60 } })})`, 90000).catch(failed);
    await measure('C1-capture', { start: c1 });
    for (const [n, fps] of [['Q1-down-30', 30], ['Q2-up-60', 60]]) {
      mark(n);
      const a = await inRunner(`T.rateApply(${JSON.stringify({ frameRate: { max: fps, ideal: fps } })})`, 60000).catch(failed);
      await measure(n, { applyResult: a });
    }
    try { await inRunner('T.stopShare()'); } catch { /* none */ }
    await sleep(TAIL);
    mark('X-nolist-capture');
    installDisplayMediaHandler('portal-placeholder');
    const x = await inRunner(`T.rateOpen(${JSON.stringify({ frameRate: { max: 60 } })})`, 90000).catch(failed);
    await measure('X-nolist-capture', { start: x });
    try { await inRunner('T.stopShare()'); } catch { /* none */ }
    await sleep(TAIL);
    installDisplayMediaHandler('chosen');
    mark('L2-list');
    const l2 = await listSources(types, { width: 0, height: 0 }, 'restore:list2'); chosen = l2.sources[0] || chosen;
    out.steps.push({ step: 'L2-list', picked: l2.sources[0] && l2.sources[0].name, error: l2.error });
    await sleep(TAIL);
    mark('C2-capture');
    const c2 = await inRunner(`T.rateOpen(${JSON.stringify({ frameRate: { max: 60 } })})`, 90000).catch(failed);
    await measure('C2-capture', { start: c2 });
    try { await inRunner('T.stopShare()'); } catch { /* none */ }
    await sleep(TAIL);
    return out;
  }, 900000);


  // ── PICK FLOW: the share lifecycle on a 'listed' desktop, with the app's own pick logic (portal-pick.ts) ──────────────────────────
  // start (placeholder P1: the listing is the one dialog, the capture is silent) -> quality changes (applyConstraints, silent) -> a republish
  // of the same placeholder (answered from its pick, no listing) -> Change source (placeholder P2: lists again) -> its capture (silent).
  // Dialogs per step come from inside/dialogs.mjs (`pickflow:<step>`); MATRIX_PICK_TYPES=window because the GNOME bot answers window dialogs only.
  await stage('pickflow', async () => {
    portalPicks = PCR.createPortalPicks();
    installDisplayMediaHandler('portal-pick');
    const out = { steps: [] };
    const step = async (name, fn) => {
      phase(`pickflow:${name}:begin`);
      const r = await fn().catch(failed);
      await inRunner('T.pull(2)', 30000).catch(failed); await sleep(TAIL);
      const m = await inRunner('T.rateMeasure(4)', 60000).catch(failed);
      out.steps.push({ step: name, r, m });
    };
    pickPlaceholder = 'screen:portal-a:0';
    await step('1-start', () => inRunner(`T.rateOpen(${JSON.stringify({ frameRate: { max: 60 } })})`, 120000));
    await step('2-quality-down-30', () => inRunner(`T.rateApply(${JSON.stringify({ frameRate: { max: 30 } })})`, 60000));
    await step('3-quality-up-60', () => inRunner(`T.rateApply(${JSON.stringify({ frameRate: { max: 60 } })})`, 60000));
    await step('4-size-down-480p', () => inRunner(`T.rateApply(${JSON.stringify({ width: { max: 854 }, height: { max: 480 }, frameRate: { max: 60 } })})`, 60000));
    try { await inRunner('T.stopShare()'); } catch { /* none */ }
    await sleep(TAIL);
    await step('5-republish-same-placeholder', () => inRunner(`T.rateOpen(${JSON.stringify({ frameRate: { max: 60 } })})`, 120000));
    pickPlaceholder = 'screen:portal-b:0';
    await step('6-change-source', () => inRunner(`T.rateOpen(${JSON.stringify({ frameRate: { max: 60 } })})`, 120000));
    try { await inRunner('T.stopShare()'); } catch { /* none */ }
    await sleep(TAIL);
    installDisplayMediaHandler('chosen');
    return out;
  }, 900000);

  // EXPERIMENT stage (MATRIX_TESTS=cancel; run with MATRIX_XDPW_OUTPUT=NO-SUCH-OUTPUT so the portal's Start fails): what getDisplayMedia
  // reports when the capture's own chooser ends without a source - the error name the share start has to treat as "the user closed it".
  await stage('cancel', async () => {
    installDisplayMediaHandler('portal-placeholder');
    phase('cancel:capture:begin');
    let r;
    try { r = { ok: await inRunner(`T.startShareMax(${MAXFPS}, 3840, 2160)`, 60000) }; }
    catch (e) { r = { error: String(e && e.message || e) }; }
    // getDisplayMedia resolves BEFORE the portal session starts (it starts when the first sink attaches): what does the track do when it fails?
    if (r.ok) { r.pull = await inRunner('T.pull(4)', 30000).catch((e) => ({ error: String(e && e.message || e) })); }
    await sleep(1500);
    try { r.stateAfter = await inRunner('T.trackState()'); } catch { /* none */ }
    installDisplayMediaHandler('chosen');
    return r;
  }, 200000);

  await stage('gpu', async () => {
    let info = null;
    try { info = await withTimeout(app.getGPUInfo('complete'), 15000, 'getGPUInfo'); } catch (e) { info = { error: String(e) }; }
    const aux = (info && info.auxAttributes) || {};
    const vea = (info && (info.videoEncodeAcceleratorSupportedProfile || aux.videoEncodeAcceleratorSupportedProfile)) || null;
    const vda = (info && (info.videoDecodeAcceleratorSupportedProfile || aux.videoDecodeAcceleratorSupportedProfile)) || null;
    return {
      featureStatus: app.getGPUFeatureStatus(),
      glRenderer: aux.glRenderer || null, glVendor: aux.glVendor || null, glVersion: aux.glVersion || null, glImplementation: aux.glImplementationParts || null,
      gpuDevices: info && info.gpuDevice ? info.gpuDevice.map((d) => ({ vendorId: d.vendorId, deviceId: d.deviceId, active: d.active, driverVendor: d.driverVendor, driverVersion: d.driverVersion })) : [],
      infoKeys: info ? Object.keys(info) : null, auxKeys: Object.keys(aux),
      videoEncodeProfiles: vea, videoDecodeProfileCount: Array.isArray(vda) ? vda.length : null,
    };
  });

  async function runShare(kind, src, fpsList) {
    const out = { kind, source: src ? { id: src.id, name: src.name } : null };
    if (!src) { out.skipped = 'no such source was offered by desktopCapturer'; return out; }
    chosen = src; handlerCalls = 0;
    phase(`gdm:${kind}:begin`);
    try {
      out.start = await inRunner('T.startShare(30)', 60000);
    } catch (e) { out.startError = String(e && e.message || e); phase(`gdm:${kind}:fail`); return out; }
    phase(`gdm:${kind}:end`);
    out.handlerCalls = handlerCalls;
    await sleep(1500);
    out.fps = [];
    for (const f of fpsList) {
      const a = Date.now();
      phase(`measure:${kind}:${f}:begin`);
      const m = await inRunner(`T.measureTrack(${Math.round(4 * SCALE)}, ${f})`, 40000);
      m.sourceFps = patternFps(a + 1200, Date.now());      // what the pattern window itself managed during the same window
      out.fps.push(m);
    }
    return out;
  }

  await stage('capture', async () => {
    const res = { screen: null, window: null };
    res.screen = await runShare('screen', screenSrc, [30, 60, 90]);
    // keep the screen share alive for the 'screen'-sourced encode test, then drop it
    res.keptShare = !!(res.screen && res.screen.start);
    if (!res.keptShare) { try { await inRunner('T.stopShare()'); } catch { /* none */ } }
    if (res.keptShare) {
      R._screenShareLive = true;
    }
    // window capture needs its own share; stop the screen one first
    return res;
  }, 240000);

  async function pickCodecs() {
    const codecs = await inRunner('T.senderCodecs()');
    const pick = [];
    const seen = new Set();
    for (const c of codecs) {
      const m = c.mimeType.toLowerCase(); const f = c.sdpFmtpLine || '';
      let key = m;
      if (m === 'video/h264') {
        if (/packetization-mode=1/.test(f) && /profile-level-id=42e01f/i.test(f)) key = 'h264-cb';
        else if (/packetization-mode=1/.test(f) && /profile-level-id=6400/i.test(f)) key = 'h264-high';
        else continue;
      }
      if (seen.has(key)) continue; seen.add(key); pick.push({ key, ...c });
    }
    return { codecs, pick };
  }
  const ENC_SECS = () => Math.round(7 * SCALE);
  const load = () => fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ');

  // 1) the live SCREEN share (portal / XShm capture) -> encoder, the real pipeline. Pattern window still animating.
  await stage('encode-screen', async () => {
    if (!R._screenShareLive) return { skipped: 'no live screen share (capture failed or not requested)' };
    const { pick } = await pickCodecs();
    const out = { results: [], loadavgStart: load() };
    for (const c of pick.filter((p) => ['video/vp8', 'h264-cb', 'h264-high', 'video/vp9'].includes(p.key))) {
      const r = await inRunner(`T.encode(${JSON.stringify({ source: 'screen', mime: c.mimeType, fmtp: c.sdpFmtpLine, secs: ENC_SECS(), w: W, h: H, fps: 30, bitrate: 4e6 })})`, 60000);
      r.key = c.key; out.results.push(r);
    }
    out.loadavgEnd = load();
    return out;
  }, 200000);

  await stage('capture-window', async () => {
    if (R._screenShareLive) { try { await inRunner('T.stopShare()'); } catch { /* ignore */ } R._screenShareLive = false; }
    return await runShare('window', windowSrc, [30, 60]);
  }, 200000);
  try { await inRunner('T.stopShare()'); } catch { /* ignore */ }
  delete R._screenShareLive;
  // The animated pattern window burns CPU (and on a software compositor, a lot of it): close it before the codec sweep so
  // the encoder numbers are the encoder's, not the encoder competing with the harness's own animation.
  if (patternWin && !patternWin.isDestroyed()) { patternWin.destroy(); patternWin = null; await sleep(500); }

  // 2) the codec sweep: a synthetic 1080p60 canvas stream, independent of the portal, so a cell whose capture failed still
  //    reports its encoders. sourceFps in each result says whether the canvas actually produced 60 fps.
  await stage('encode-canvas', async () => {
    if (!runnerWin) await createRunner();
    const fakeCam = await inRunner('T.holdFake()').catch((e) => 'fake camera unavailable: ' + e.message);
    const { codecs, pick } = await pickCodecs();
    const out = { offered: codecs, results: [], loadavgStart: load(), fakeCamera: fakeCam };
    const caps = {};
    for (const c of pick) caps[c.key] = await inRunner(`T.mediaCaps(${JSON.stringify(c.mimeType)}, ${JSON.stringify(c.sdpFmtpLine)})`);
    out.mediaCapabilities = caps;
    for (const c of pick) {
      const r = await inRunner(`T.encode(${JSON.stringify({ source: 'canvas', mime: c.mimeType, fmtp: c.sdpFmtpLine, secs: ENC_SECS(), w: 1920, h: 1080, fps: 60, bitrate: 8e6 })})`, 60000);
      r.key = c.key; r.loadavg = load(); out.results.push(r);
    }
    out.loadavgEnd = load();
    await inRunner('T.releaseFake()').catch(() => {});
    return out;
  }, 400000);

  await stage('audio', async () => {
    if (!addon || !addon.startCapture) return { skipped: 'addon not loaded' };
    if (!runnerWin) await createRunner();      // portal-less cells never opened the runner; the page plays the app's own tone
    if (addon.isSupported && !addon.isSupported()) return { skipped: 'addon.isSupported() is false' };
    const res = { scenarios: [] };
    const unrelated = spawn('sleep', ['120'], { stdio: 'ignore' });
    const scenario = async (label, pid, withTone) => {
      const chunks = []; const events = [];
      const tStart = Date.now();
      addon.startCapture(pid, 'exclude', (c) => { if (c.data) chunks.push(Buffer.from(c.data)); else events.push(c); });
      await sleep(500);
      let player = null;
      if (withTone) await inRunner('T.tone(true)');
      // the 1000 Hz tone is played by a process OUTSIDE this app's tree (cell.sh starts it); spawning it here would make it excluded too
      await sleep(3500);
      let snap = null;
      const dump = sh('pw-dump', [], { maxBuffer: 64 << 20 });
      try {
        const d = JSON.parse(dump); const pids = [];
        for (const o of d) if (o.type === 'PipeWire:Interface:Node' && o.info && o.info.props && o.info.props['media.class'] === 'Stream/Output/Audio') pids.push({ app: o.info.props['application.name'], pid: +o.info.props['application.process.id'] || null, media: o.info.props['media.name'] });
        const links = d.filter((o) => o.type === 'PipeWire:Interface:Node' && o.info && o.info.props && o.info.props['node.name'] === 'cipherline-share-audio').length;
        const cl = childCmdlines(); const byPid = new Map(cl.map((p) => [p.pid, p]));
        const isDesc = (pid) => { let x = pid, n = 0; while (x && n++ < 20) { if (x === process.pid) return true; const p = byPid.get(x); x = p && p.ppid; } return false; };
        snap = { streams: pids.map((p) => ({ ...p, descendantOfMain: p.pid ? isDesc(p.pid) : null })), captureNodeExists: links > 0 };
      } catch { /* ignore */ }
      addon.stopCapture();
      if (withTone) await inRunner('T.tone(false)');
      await sleep(600);
      const all = Buffer.concat(chunks); const f = new Float32Array(all.buffer, all.byteOffset, Math.floor(all.length / 4));
      const L = new Float32Array(f.length / 2); for (let i = 0; i < L.length; i++) L[i] = f[2 * i];
      const r = { label, wallMs: Date.now() - tStart, chunks: chunks.length, seconds: +(L.length / RATE).toFixed(2), events, db440: dbAt(L, 440), db1000: dbAt(L, 1000), pw: snap };
      res.scenarios.push(r); return r;
    };
    // exclude self FIRST (the real share's shape), then the control, then self again. A control that excludes an unrelated
    // pid must let BOTH tones through — it proves Chromium's tone reaches PipeWire and the capture itself works.
    const self = await scenario('exclude self (process.pid, as main.ts does)', process.pid, true);
    const ctl = await scenario('control (exclude an unrelated pid)', unrelated.pid, true);
    const self2 = await scenario('exclude self again (restart after a stop)', process.pid, true);
    try { unrelated.kill('SIGKILL'); } catch { /* ignore */ }
    res.pageTonePresentInControl = ctl.db440 > -30;
    res.externalTonePresentInControl = ctl.db1000 > -30;
    res.selfExcluded = self.db440 < -60 && self.db1000 > -30;
    res.selfNotExcluded = self.db440 > -30;
    res.selfProducedNoAudioAtAll = self.chunks === 0;
    res.verdict = res.selfProducedNoAudioAtAll ? 'BROKEN: exclude-self capture delivered ZERO audio chunks in Electron (control: ' + ctl.chunks + ' chunks)' : !res.pageTonePresentInControl ? 'inconclusive: the page tone never reached PipeWire (control failed)'
      : res.selfExcluded ? 'self-exclusion works' : res.selfNotExcluded ? 'SELF-EXCLUSION FAILED: the app\'s own audio is in the capture (echo)' : 'partial';
    return res;
  }, 120000);

  R.total_ms = Date.now() - t0;
  save();
}

app.on('window-all-closed', () => { /* the webgl probe window closes before the pattern opens: do not quit */ });
process.on('uncaughtException', (e) => { R.errors.push('uncaught: ' + (e && e.stack || e)); save(); });
main().then(() => { phase('done'); save(); app.exit(0); }).catch((e) => { R.errors.push('fatal: ' + (e && e.stack || e)); save(); app.exit(2); });
// absolute watchdog: a wedged portal dialog must not wedge the matrix
setTimeout(() => { R.errors.push('watchdog: killed after ' + (+process.env.MATRIX_WATCHDOG_S || 600) + 's'); save(); app.exit(3); }, (+process.env.MATRIX_WATCHDOG_S || 600) * 1000).unref();
