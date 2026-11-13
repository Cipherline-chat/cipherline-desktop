// The lab scenarios. Each takes the live context { desktop, s, v, accts } (two signed-in real clients already in one DM call, probes
// installed) and returns { status: 'pass'|'fail'|'partial'|'info'|'skipped', why, ...numbers }. They never throw for an expected failure.
import * as L from './lab.mjs';
import * as P from './probes.mjs';
import * as Sh from './share.mjs';
import * as Au from './audio.mjs';
import * as Po from './portal.mjs';
import fs from 'node:fs';
import path from 'node:path';

const SETTLE_MS = +(process.env.LAB_SETTLE_MS || 9000);
const SAMPLE_MS = +(process.env.LAB_SAMPLE_MS || 6000);
const isWayland = (ctx) => ['sway', 'kde', 'gnome'].includes(ctx.desktop);
const step = (m) => L.log('    ' + m);
const top = (rows) => rows.slice().sort((a, b) => (b.w || 0) * (b.h || 0) - (a.w || 0) * (a.h || 0) || (b.encFps || b.decFps || 0) - (a.encFps || a.decFps || 0))[0];
const num = (x) => (Number.isFinite(x) ? x : null);
const pickScreenshare = (rows) => { const s = rows.filter((r) => r.contentType === 'screenshare'); return top(s.length ? s : rows); };
const chooserPick = (name) => fs.writeFileSync(path.join(L.OUT, 'run/sharer/chooser-pick'), name);
const hasTone = (rows, hz) => rows.some((r) => (hz === 1000 ? (r.db1000 >= -90 && r.db1000 - r.floorDb >= 40) : r.db440 >= -45));   // 1000: a real tone (the share audio can start quiet: -72..-12 dBFS seen), 440: a LEAK would read about -20, residue of an absent tone -65..-150

/** Begin a share through the real picker (X11 grid / Wayland portal step). */
async function beginShare(ctx, { resolution, fps, audio = true, source = 'screen' }) {
  const t0 = Date.now();
  if (isWayland(ctx)) chooserPick('HEADLESS-1');
  const pstep = await Sh.openPicker(ctx.s.page);
  let tile = null;
  if (pstep === 'grid') tile = await Sh.chooseTile(ctx.s.page, source === 'window' ? /LAB-PATTERN|pattern/i : /screen|display|monitor/i);
  await Sh.shot(ctx.s.page, `picker-${pstep}-${ctx.desktop}`);
  await Sh.settingsAndShare(ctx.s.page, { resolution, fps, audio });
  await Sh.waitSharing(ctx.s.page, 90000);
  await Sh.watch(ctx.v.page);
  return { t0, step: pstep, tile, ui: { ...Sh.lastShare } };
}

async function measure(ctx, t0) {
  await L.sleep(SETTLE_MS);
  const [so, vi] = await Promise.all([P.rates(ctx.s.page, SAMPLE_MS), P.rates(ctx.v.page, SAMPLE_MS)]);
  const out = pickScreenshare(so.out), inn = top(vi.in);
  const calls = await P.perfCalls(ctx.s.page, { since: t0, kinds: ['share_fps', 'share_codec', 'share_start', 'share_clamp', 'share_net', 'share_start_check', 'share_fallback'] });
  const last = (k) => calls.filter((c) => c.kind === k).pop()?.detail ?? null;
  const rx = await P.perfCalls(ctx.v.page, { since: t0, kinds: ['share_rx_fps', 'share_rx_start'] });
  return {
    sharer: out && { res: `${out.w}x${out.h}`, enc_fps_counter: num(out.encFps), encoder: out.enc, hardware_encoder: out.hw ?? null, codec: out.codec, limit: out.limit, kbps: out.kbps },
    viewer: inn && { res: `${inn.w}x${inn.h}`, dec_fps_counter: num(inn.decFps), stat_fps: num(inn.fps), decoder: inn.dec, codec: inn.codec, kbps: inn.kbps, freezes: inn.freezes },
    app_events: { share_fps: last('share_fps'), share_codec: last('share_codec'), share_start: last('share_start'), share_clamp: last('share_clamp'), share_net: last('share_net'), share_fallback: last('share_fallback'), viewer_share_rx_fps: rx.pop()?.detail ?? null },
  };
}

async function endShare(ctx) { try { if (await Sh.isSharing(ctx.s.page)) await Sh.stopSharing(ctx.s.page); } catch { /* best effort */ } await L.sleep(1500); }

function fpsVerdict(m, target) {
  const sentFps = m.app_events.share_fps?.sent_fps ?? m.sharer?.enc_fps_counter ?? null;
  const got = m.viewer?.dec_fps_counter ?? null;
  const ok = !!m.viewer && got !== null && got >= 15 && !/undefined|^0x0/.test(m.viewer.res);
  return { status: ok ? 'pass' : 'fail', criteria: `viewer decodes >= 15 fps of the share (target ${target}); the numbers show how far from the target`, target_fps: target, viewer_fps: got, sharer_sent_fps: sentFps, reached_target: got !== null && got >= target * 0.9 };
}

/** Audio check on the live share: FFT of what the viewer receives, then (separately) the sharer's speakers as the positive control. */
async function audioCheck(ctx) {
  const recv = await P.fft(ctx.v.page, 4000);
  const desk = await Au.desktopAudio('cle2e-sharer', 4);
  return { recv, desk, tone1000: hasTone(recv, 1000), leak440: hasTone(recv, 440), deskBoth: desk.db1000 >= -40 && desk.db440 >= -40 };
}

export const SCENARIOS = {
  // 1a
  async 'share-1080-90'(ctx) {
    const b = await beginShare(ctx, { resolution: '1920×1080', fps: 'Up to 90 fps', audio: false });
    const m = await measure(ctx, b.t0);
    await Sh.shot(ctx.v.page, `viewer-share-1080-${ctx.desktop}`);
    const portal = isWayland(ctx) ? Po.portalCounts(b.t0, Date.now()) : null;
    await endShare(ctx);
    return { ...fpsVerdict(m, 90), picker_step: b.step, share_ui: b.ui, ...m, portal };
  },
  // 1b
  async 'share-source-90'(ctx) {
    const b = await beginShare(ctx, { resolution: 'Source (Native)', fps: 'Up to 90 fps', audio: false });
    const m = await measure(ctx, b.t0);
    await Sh.shot(ctx.v.page, `viewer-share-source-${ctx.desktop}`);
    const portal = isWayland(ctx) ? Po.portalCounts(b.t0, Date.now()) : null;
    await endShare(ctx);
    return { ...fpsVerdict(m, 90), picker_step: b.step, share_ui: b.ui, ...m, portal };
  },
  // 2: whole-screen share audio: 1000 Hz tone app arrives, the call's own 440 Hz does not
  async 'share-audio'(ctx) {
    const b = await beginShare(ctx, { resolution: '1920×1080', fps: '30 fps', audio: true });
    await L.sleep(SETTLE_MS);
    const a = await audioCheck(ctx);
    const portal = isWayland(ctx) ? Po.portalCounts(b.t0, Date.now()) : null;
    await endShare(ctx);
    return { status: a.tone1000 && !a.leak440 ? (a.deskBoth ? 'pass' : 'partial') : 'fail',
      criteria: 'viewer receives 1000 Hz on a received audio track and NO received track carries 440 Hz (the call audio); positive control: both tones are on the sharer\'s speakers',
      viewer_received_audio_tracks: a.recv, desktop_speakers_positive_control: a.desk, desktop_has_both_tones: a.deskBoth, picker_step: b.step, share_ui: b.ui, portal };
  },
  // 4 (Wayland): ScreenCast Start per share, and per fps / size change on the live share
  async 'portal-chooser'(ctx) {
    if (!isWayland(ctx)) return { status: 'skipped', why: 'X11 has no portal: nothing to count' };
    const t0 = Date.now();
    await beginShare(ctx, { resolution: '1920×1080', fps: '60 fps', audio: false });
    await L.sleep(5000);
    const start = Po.portalCounts(t0, Date.now());
    step('start counted: ' + JSON.stringify(start));
    // an fps change on the live share: the picker's "Apply to current share" (sender params, no new capture)
    const t1 = Date.now();
    const pstep = await Sh.openChangeSource(ctx.s.page);
    await Sh.settingsAndShare(ctx.s.page, { fps: '30 fps', audio: null, apply: true });
    await L.sleep(6000);
    const retune = Po.portalCounts(t1, Date.now());
    const share_fps = (await P.perfCalls(ctx.s.page, { since: t1, kinds: ['share_codec'] })).pop()?.detail ?? null;
    step('retune counted: ' + JSON.stringify(retune));
    // a source change: a new capture, so one new Start
    const t2 = Date.now();
    chooserPick('HEADLESS-2');
    await Sh.openChangeSource(ctx.s.page);
    await Sh.settingsAndShare(ctx.s.page, { audio: null });
    await L.sleep(7000);
    const change = Po.portalCounts(t2, Date.now());
    await endShare(ctx);
    const ok = start.start === 1 && retune.start === 0 && change.start === 1;
    return { status: ok ? 'pass' : 'fail', criteria: 'ScreenCast Start: 1 per share, 0 per fps change on the live share, 1 per Change Source', picker_step_on_change: pstep,
      share_start: start, fps_change_on_live_share: retune, share_codec_after_fps_change: share_fps, change_source: change,
      note: 'chooser answered by xdpw chooser_type=dmenu + inside/xdpw-chooser.sh on sway; KDE/GNOME choosers need a person (README)' };
  },
  // 3 (+ 4 on Wayland): Change Source keeps audio
  async 'change-source'(ctx) {
    const wl = isWayland(ctx);
    const b = await beginShare(ctx, { resolution: '1920×1080', fps: '30 fps', audio: true });
    await L.sleep(SETTLE_MS);
    step('share up, audio before');
    const before = await audioCheck(ctx);
    const t = Date.now();
    if (wl) chooserPick('HEADLESS-2');
    const pstep = await Sh.openChangeSource(ctx.s.page);
    step('change-source picker: ' + pstep);
    let tile = null;
    if (pstep === 'grid') tile = await Sh.chooseTile(ctx.s.page, /LAB-PATTERN|pattern/i);   // x11: screen -> the pattern window
    await Sh.shot(ctx.s.page, `change-source-picker-${ctx.desktop}`);
    // audio left at whatever the picker offers: what it offers is part of what is under test
    const audioDefault = wl ? (await ctx.s.page.locator('[data-testid="share-audio-portal"]').innerText({ timeout: 2000 }).catch(() => '')).replace(/\s+/g, ' ')
      : await ctx.s.page.locator('[data-testid="share-audio-toggle"] [role=checkbox]').first().getAttribute('aria-checked', { timeout: 2000 }).catch(() => null);
    await Sh.settingsAndShare(ctx.s.page, { audio: null });
    await L.sleep(5000);
    step('swapped');
    await Sh.waitSharing(ctx.s.page, 60000);
    await Sh.watch(ctx.v.page, 5000).catch(() => {});
    await L.sleep(SETTLE_MS);
    const after = await audioCheck(ctx);
    const vr = await P.rates(ctx.v.page, 4000);
    const portal = wl ? Po.portalCounts(t, Date.now()) : null;
    await Sh.shot(ctx.v.page, `viewer-after-change-${ctx.desktop}`);
    await endShare(ctx);
    const ok = before.tone1000 && after.tone1000 && !after.leak440 && (top(vr.in)?.decFps ?? 0) > 0;
    return { status: ok ? 'pass' : 'fail', criteria: 'share audio (1000 Hz) present at the viewer BEFORE and AFTER Change Source, 440 Hz still absent, video decoding after',
      picker_step: b.step, picker_step_after_change: pstep, tile, picker_audio_default_on_change: audioDefault, audio_before: before.recv, audio_after: after.recv,
      viewer_after: top(vr.in) && { res: `${top(vr.in).w}x${top(vr.in).h}`, dec_fps: top(vr.in).decFps }, desktop_speakers_after: after.desk, portal_for_the_change: portal };
  },
  // 5: window share. X11: the window's own audio through the pid path. Wayland: whole screen + audio of ONE APP (the tone app), per-app audio picker
  async 'window-share'(ctx) {
    if (isWayland(ctx)) {
      // xdpw 0.7 lists no windows, so the window half is not testable here; what is: audio of ONE APP (the per-app picker) on a share
      const t0 = Date.now();
      chooserPick('HEADLESS-1');
      const pstep = await Sh.openPicker(ctx.s.page);
      await Sh.settingsAndShare(ctx.s.page, { resolution: '1920×1080', fps: '30 fps', audio: 'One app', appRe: /pattern/i });
      await Sh.waitSharing(ctx.s.page, 90000);
      await Sh.watch(ctx.v.page);
      await L.sleep(SETTLE_MS);
      const a = await audioCheck(ctx);
      const portal = Po.portalCounts(t0, Date.now());
      await endShare(ctx);
      return { status: a.tone1000 && !a.leak440 ? 'partial' : 'fail', why: 'Wayland/xdpw offers monitors only (no window share here); this checks the per-app audio picker: the tone app\'s 1000 Hz arrives, no 440 Hz call audio',
        picker_step: pstep, share_ui: { ...Sh.lastShare }, audio: a.recv, desktop_speakers: a.desk, portal };
    }
    const b = await beginShare(ctx, { resolution: '1280×720', fps: '30 fps', audio: true, source: 'window' });
    await L.sleep(SETTLE_MS);
    const a = await audioCheck(ctx);
    const vr = await P.rates(ctx.v.page, 4000);
    await Sh.shot(ctx.v.page, `viewer-window-share-${ctx.desktop}`);
    await endShare(ctx);
    const dec = top(vr.in)?.decFps ?? 0;
    return { status: a.tone1000 && !a.leak440 && dec > 0 ? 'pass' : (dec > 0 ? 'partial' : 'fail'), criteria: 'window video decodes at the viewer AND the window\'s own audio (1000 Hz, X11 _NET_WM_PID path) arrives with no 440 Hz',
      tile: b.tile, share_ui: b.ui, viewer: top(vr.in) && { res: `${top(vr.in).w}x${top(vr.in).h}`, dec_fps: dec }, audio: a.recv, desktop_speakers: a.desk };
  },
  // 6: annotation: the viewer asks, the sharer allows, the viewer draws; the SHARER's compositor output is checked for the stroke
  async 'annotation'(ctx) {
    await beginShare(ctx, { resolution: '1920×1080', fps: '30 fps', audio: false });
    await L.sleep(4000);
    // Wayland + several identical screens: the app asks which one is being shared so the overlay lands on it ("Which screen are you sharing?")
    let displayPrompt = null;
    for (let i = 0; i < 10 && !displayPrompt; i++) {
      const dlg = ctx.s.page.locator('text=/pick the one you.re sharing/i').first();
      if (await dlg.isVisible().catch(() => false)) {
        await Sh.shot(ctx.s.page, `annotation-display-prompt-${ctx.desktop}`);
        displayPrompt = (await ctx.s.page.locator('button:has-text("main")').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
        await ctx.s.page.locator('button:has-text("main")').first().click({ timeout: 8000 });   // HEADLESS-1 is "1 ... main": the output the portal shares
      } else await L.sleep(700);
    }
    await L.sleep(1500);
    const TEAL = [0x25, 0xe0, 0xc8];
    const strokePixels = async (name) => {
      L.sh('docker', ['exec', '-u', 'tester', 'cle2e-sharer', 'bash', '/lab/inside/shot.sh', ctx.desktop, `/out/sharer/${name}.png`]);
      const buf = fs.readFileSync(path.join(L.OUT, 'run/sharer', `${name}.rgb`));
      let n = 0; for (let i = 0; i + 2 < buf.length; i += 3) if (Math.abs(buf[i] - TEAL[0]) < 60 && Math.abs(buf[i + 1] - TEAL[1]) < 60 && Math.abs(buf[i + 2] - TEAL[2]) < 60) n++;
      fs.mkdirSync(path.join(L.RESULTS, 'shots'), { recursive: true });
      fs.copyFileSync(path.join(L.OUT, 'run/sharer', `${name}.png`), path.join(L.RESULTS, 'shots', `annotation-${name}-${ctx.desktop}.png`));
      return n;
    };
    const vp = ctx.v.page;
    const vid = vp.locator('video').first();
    await vid.click({ force: true, timeout: 8000 }).catch(() => {});   // a click focuses the share tile (a big tile): the draw controls live on that
    await L.sleep(1500);
    await vid.hover({ force: true, timeout: 8000 }).catch(() => {});
    await L.sleep(800);
    const ask = vp.locator('button[title="Ask to draw on this video"]').first();
    if (!(await ask.count())) { await Sh.shot(vp, `annotation-no-ask-${ctx.desktop}`); await endShare(ctx); return { status: 'fail', why: 'no "Ask to draw" button on the viewer tile (even after focusing it)' }; }
    await ask.click({ force: true, timeout: 8000 });
    await L.sleep(1500);
    const allow = ctx.s.page.locator('button:has-text("Allow")').first();
    await allow.waitFor({ state: 'visible', timeout: 15000 });
    await Sh.shot(ctx.s.page, `annotation-allow-dock-${ctx.desktop}`);
    await allow.click({ timeout: 8000 });
    await L.sleep(1500);
    await vid.hover({ force: true, timeout: 8000 }).catch(() => {});
    // a grant turns drawing on by itself (the toolbar then offers "Stop drawing"); only press the toggle when it is off
    const toggle = vp.locator('button[title^="Draw on this video"], button[aria-label="Draw on this video"]').first();
    if (await toggle.count()) await toggle.click({ force: true, timeout: 8000 });
    await L.sleep(800);
    const box = await vid.boundingBox();
    if (!box) { await endShare(ctx); return { status: 'fail', why: 'no viewer video box' }; }
    const x0 = box.x + box.width * 0.25, y0 = box.y + box.height * 0.5;
    const base = await strokePixels('before');   // taken with drawing enabled and the pointer idle: the UI's own teal accents are in it
    const drawStroke = async (hold) => {
      await vp.mouse.move(x0, y0); await vp.mouse.down();
      for (let i = 0; i <= 30; i++) { await vp.mouse.move(x0 + (box.width * 0.5 * i) / 30, y0 + Math.sin(i / 3) * box.height * 0.15); await L.sleep(25); }
      if (hold) await hold();
      await vp.mouse.up();
    };
    // the first stroke makes the sharer's app try the desktop overlay; with identical screens it asks which one is shared
    await drawStroke(null);
    await L.sleep(2000);
    const dlg = ctx.s.page.locator('text=/pick the one you.re sharing/i').first();
    if (await dlg.isVisible().catch(() => false)) {
      await Sh.shot(ctx.s.page, `annotation-display-prompt-${ctx.desktop}`);
      displayPrompt = (await ctx.s.page.locator('button:has-text("main")').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
      await ctx.s.page.locator('button:has-text("main")').first().click({ timeout: 8000 });
      await L.sleep(2000);
    }
    let during = 0;
    await drawStroke(async () => { await Sh.shot(vp, `annotation-viewer-drawing-${ctx.desktop}`); during = await strokePixels('during'); });
    await L.sleep(300);
    const after = await strokePixels('after');
    await endShare(ctx);
    const seen = Math.max(during, after) - base;
    return { status: seen > 1500 ? 'pass' : 'fail', criteria: 'after the viewer draws, #25E0C8 stroke pixels appear on the SHARER\'s own compositor output (the desktop overlay window)',
      teal_pixels_before: base, teal_pixels_during: during, teal_pixels_after: after, display_prompt_answered: displayPrompt };
  },
  // 7: software-encode guard under CPU limits: report what it chose and why, from its own call events
  async 'encode-stepdown'(ctx) {
    const cpus = process.env.LAB_STEPDOWN_CPUS || '2';
    L.sh('docker', ['update', '--cpus', cpus, 'cle2e-sharer']);
    const t0 = Date.now();
    try {
      await beginShare(ctx, { resolution: 'Source (Native)', fps: 'Up to 90 fps', audio: false });
      await L.sleep(75000);
      const ev = await P.perfCalls(ctx.s.page, { since: t0, kinds: ['share_start', 'share_codec', 'share_clamp', 'share_fallback', 'share_fps', 'share_low_layer'] });
      const notices = await ctx.s.page.locator('text=/can.t keep up|too much for it/').allInnerTexts().catch(() => []);
      await Sh.shot(ctx.s.page, `stepdown-sharer-${ctx.desktop}`);
      await endShare(ctx);
      const fmt = (e) => `${Math.round((e.at - t0) / 1000)}s ${e.kind} ${Object.entries(e.detail).map(([k, v]) => `${k}=${v}`).join(' ')}`;
      const decisions = ev.filter((e) => ['share_fallback', 'share_codec', 'share_clamp'].includes(e.kind)).map(fmt);
      const fps = ev.filter((e) => e.kind === 'share_fps').map((e) => e.detail);
      const toFps30 = ev.some((e) => e.kind === 'share_fallback' && /fps_30/.test(String(e.detail.to)));
      return { status: 'info', criteria: `reported, not judged: with the sharer container at --cpus=${cpus}, what the software-encoder guard chose and the numbers it saw (30 fps is the designed answer when no smaller size carries more than 30 fps; the 1440p step only applies when it fits)`,
        cpus, chose_fps_30: toFps30, decisions, share_fps_samples: fps.slice(-6), screen_notices: notices };
    } finally { L.sh('docker', ['update', '--cpus', process.env.LAB_CPUS || '6', 'cle2e-sharer']); }
  },
  // 9: which encoder the app actually used (the app now defaults hardware encode on; stock Ubuntu iHD has EncSliceLP only)
  async 'vaapi'(ctx) {
    const facts = fs.existsSync(path.join(L.OUT, 'run/sharer/vainfo-iHD.txt')) ? fs.readFileSync(path.join(L.OUT, 'run/sharer/vainfo-iHD.txt'), 'utf8') : '';
    const b = await beginShare(ctx, { resolution: '1920×1080', fps: '30 fps', audio: false });
    const m = await measure(ctx, b.t0);
    const log = fs.readFileSync(path.join(L.OUT, 'run/sharer/electron.log'), 'utf8').split('\n').filter((l) => /hardware video encode|AcceleratedVideoEncoder|vaapi|VaapiVideo/i.test(l)).slice(0, 6);
    await endShare(ctx);
    return { status: m.sharer?.hardware_encoder ? 'pass' : 'partial', criteria: 'record which encoder the app actually used; pass = a hardware encoder',
      env: process.env.LAB_APP_ENV ?? '(default flags)', vainfo_entrypoints: [...new Set((facts.match(/VAProfile\w+\s*:\s*VAEntrypointEnc\w+/g) || []))], app_log: log, ...m };
  },
  // 8: WebGL draw check (the onboarding dot engine's own context request, in the app's renderer)
  async 'webgl-onboarding'(ctx) {
    const draw = (page) => page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const gl = c.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: true });
      if (!gl) return { webgl: false };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const vs = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs, 'attribute vec2 p; void main(){ gl_Position=vec4(p,0.,1.); gl_PointSize=40.; }'); gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fs, 'precision mediump float; void main(){ gl_FragColor=vec4(1.,0.,0.,1.); }'); gl.compileShader(fs);
      const pr = gl.createProgram(); gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr); gl.useProgram(pr);
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.POINTS, 0, 1);
      const px = new Uint8Array(4); gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return { webgl: true, renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), center_pixel_rgba: Array.from(px), draws: px[0] > 200 && px[1] < 50 };
    });
    const [sh, vw] = await Promise.all([draw(ctx.s.page), draw(ctx.v.page)]);
    return { status: 'partial', why: sh.draws ? 'WebGL draws in the real renderer; the onboarding dot screen itself was not driven (needs a real sign-up)' : 'no WebGL context in the real renderer: the dot field takes its Canvas 2D fallback; the dot screen itself was not driven', sharer_renderer_webgl: sh, viewer_x11_webgl: vw };
  },
};

export const ORDER = ['share-1080-90', 'share-source-90', 'share-audio', 'portal-chooser', 'change-source', 'window-share', 'annotation', 'encode-stepdown', 'vaapi', 'webgl-onboarding'];
