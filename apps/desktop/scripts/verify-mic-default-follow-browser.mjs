/**
 * Real-browser verification that the PUBLISHED mic follows an OS default-input
 * change while the user's mic setting is "Default" — and (second section,
 * `runExplicit`, against Chromium's real fake devices) that an EXPLICITLY picked
 * mic is what the call captures at join, after livekit-client's ended-recovery,
 * after a reconnect republish, after a mid-call change and under a stale stored
 * id; and that the picked OUTPUT reaches every element and playback context,
 * including late ones, falls back while unplugged and comes back.
 *
 * The vitest suite (src/utils/micDeviceSync.test.ts) proves the decision logic
 * and the wiring against a fake of livekit-client. This proves the parts a fake
 * cannot: the REAL livekit-client LocalAudioTrack, the REAL Chromium
 * getUserMedia, a real RTCRtpSender, and a WebAudio processor in the same
 * position as the app's voice processor (so the sender carries the processor's
 * output, exactly as in a call).
 *
 *   node scripts/verify-mic-default-follow-browser.mjs
 *
 * What it can and cannot prove:
 *   - Chromium's fake capture devices cannot change the OS default, so the
 *     "OS" is simulated: `enumerateDevices()` is stubbed to report a 'default'
 *     row whose label/groupId the script flips, and `devicechange` is
 *     dispatched by hand (a 3-event burst, as SoundSwitch produces).
 *   - It asserts what the call would transmit: the RTCRtpSender's track is
 *     swapped (same sender — no unpublish/renegotiation, so the E2EE transform
 *     bound to that sender stays), it is the processor's NEW output, the
 *     processor is fed the NEW capture, the capture was re-opened with
 *     deviceId 'default' + our capture constraints, mute is preserved.
 *   - It does NOT prove that a re-opened 'default' capture lands on the new
 *     physical device on Windows — that is Chromium/WASAPI behaviour and needs
 *     the owner's Windows repro.
 *
 * Negative control (must reproduce, or the script fails): the pre-fix call
 * path — `room.switchActiveDevice('audioinput','default',false)`, i.e.
 * `LocalAudioTrack.setDeviceId('default')` — re-opens on the FIRST change of a
 * call (the track was created with {exact:'default'}) and is a silent no-op
 * returning `true` on every change after that.
 *
 * Needs chrome-headless-shell (CIPHERLINE_CHROME / CHROME_PATH, else
 * Playwright's cache) and the monorepo-hoisted `esbuild` + `playwright-core`
 * (see verify-drag-gesture-browser.mjs for why esbuild is not declared).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function findChrome() {
  const envPath = process.env.CIPHERLINE_CHROME || process.env.CHROME_PATH;
  if (envPath) {
    if (fs.existsSync(envPath)) return envPath;
    fail(`CIPHERLINE_CHROME/CHROME_PATH is set to '${envPath}' but nothing exists there.`);
  }
  const pattern = path.join(
    os.homedir(), '.cache', 'ms-playwright',
    'chromium_headless_shell-*', 'chrome-headless-shell-*', 'chrome-headless-shell',
  );
  const matches = fs.globSync(pattern).filter((p) => {
    try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
  });
  if (matches.length === 0) fail('Could not find chrome-headless-shell (set CIPHERLINE_CHROME).');
  return matches.sort().reverse()[0];
}

// Runs in the page. Imports resolve from apps/desktop (resolveDir below).
const ENTRY = String.raw`
import { createLocalAudioTrack } from 'livekit-client';
import { createMicDeviceSync, readCaptureTrack } from './src/utils/micDeviceSync';
import { MIC_CAPTURE_CONSTRAINTS, micDeviceConstraint } from './src/utils/audioInput';
import { getCallEvents } from './src/utils/callEventLog';
import {
  applyOutputDevice, registerOutputAudioContext, onOutputDeviceChange, refreshOutputDevices,
  setOutputDeviceFallbackHandler,
} from './src/utils/audioOutput';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const md = navigator.mediaDevices;
const realGum = md.getUserMedia.bind(md);
const realEnum = md.enumerateDevices.bind(md);
const gumCalls = [];
md.getUserMedia = async (c) => { gumCalls.push(JSON.parse(JSON.stringify(c ?? {}))); return realGum(c); };

// Same position as the app's voice processor: the sender carries ITS output.
class Passthrough {
  name = 'passthrough';
  async init(opts) {
    this.ctx = opts.audioContext ?? this.ctx ?? new AudioContext();
    this.sourceTrack = opts.track;
    this.src = this.ctx.createMediaStreamSource(new MediaStream([opts.track]));
    this.dest = this.ctx.createMediaStreamDestination();
    this.src.connect(this.dest);
    this.processedTrack = this.dest.stream.getAudioTracks()[0];
  }
  async restart(opts) { await this.destroy(); await this.init(opts); }
  async destroy() { try { this.src?.disconnect(); } catch {} }
}

window.run = async () => {
  const out = {};
  let osDefault = { label: 'Default - Headset', group: 'grp-headset' };
  md.enumerateDevices = async () => {
    const real = await realEnum();
    const row = (deviceId, label, groupId) => ({ deviceId, kind: 'audioinput', label, groupId, toJSON() { return this; } });
    return [
      row('default', osDefault.label, osDefault.group),
      row('id-headset', 'Headset', 'grp-headset'),
      row('id-usb', 'USB Mic', 'grp-usb'),
      ...real.filter(d => d.kind !== 'audioinput'),
    ];
  };

  // Created the way the Room creates the call's mic (createLocalTracks).
  const track = await createLocalAudioTrack({ ...MIC_CAPTURE_CONSTRAINTS, deviceId: 'default' });
  track.setAudioContext(new AudioContext());
  const proc = new Passthrough();
  await track.setProcessor(proc);
  const pc = new RTCPeerConnection();
  const sender = pc.addTrack(track.mediaStreamTrack);
  track.sender = sender;
  out.senderCarriesProcessorOutput = sender.track === proc.processedTrack;

  async function oldPath(to) {
    const raw0 = track._mediaStreamTrack, s0 = sender.track, g0 = gumCalls.length;
    const storedBefore = JSON.stringify(track._constraints.deviceId);
    osDefault = to;
    const libReturned = await track.setDeviceId('default');
    return { storedBefore, libReturned, gumCallsMade: gumCalls.length - g0,
      senderTrackChanged: sender.track !== s0, captureChanged: track._mediaStreamTrack !== raw0 };
  }
  out.oldFirst = await oldPath({ label: 'Default - USB Mic', group: 'grp-usb' });
  out.oldSecond = await oldPath({ label: 'Default - Headset', group: 'grp-headset' });

  const follower = createMicDeviceSync({
    enumerateDevices: () => md.enumerateDevices(),
    getMicTrack: () => track,
    switchActiveDevice: (id, exact) => track.setDeviceId(exact ? { exact: id } : id),
    getSetting: () => '',
    captureConstraints: MIC_CAPTURE_CONSTRAINTS,
  });
  follower.setApplied('default');
  await follower.seed();
  md.addEventListener('devicechange', () => follower.schedule());

  async function flip(to, muted) {
    if (muted) await track.mute(); else if (track.isMuted) await track.unmute();
    const rawBefore = readCaptureTrack(track), senderBefore = sender.track, g0 = gumCalls.length;
    const t0 = performance.now();
    osDefault = to;
    for (let i = 0; i < 3; i++) { md.dispatchEvent(new Event('devicechange')); await sleep(40); }
    while (sender.track === senderBefore && performance.now() - t0 < 3000) await sleep(10);
    const ms = Math.round(performance.now() - t0);
    await sleep(500);
    const rawAfter = track._mediaStreamTrack;
    return { ms, gumCallsMade: gumCalls.length - g0, lastGumAudio: gumCalls.at(-1)?.audio,
      senderTrackChanged: sender.track !== senderBefore,
      senderIsNewProcessorOutput: sender.track === proc.processedTrack,
      processorFedNewCapture: proc.sourceTrack === rawAfter,
      oldCaptureEnded: rawBefore.readyState === 'ended', newCaptureLive: rawAfter.readyState === 'live',
      captureEnabled: rawAfter.enabled, isMuted: track.isMuted,
      sameSender: pc.getSenders().length === 1 && pc.getSenders()[0] === sender };
  }
  out.fix = [
    await flip({ label: 'Default - USB Mic', group: 'grp-usb' }, false),
    await flip({ label: 'Default - Headset', group: 'grp-headset' }, false),
    await flip({ label: 'Default - USB Mic', group: 'grp-usb' }, false),
  ];
  out.fixMuted = await flip({ label: 'Default - Headset', group: 'grp-headset' }, true);
  const g0 = gumCalls.length;
  md.dispatchEvent(new Event('devicechange'));
  await sleep(700);
  out.unrelatedDevicechangeGumCalls = gumCalls.length - g0;
  out.events = getCallEvents().filter(e => e.kind === 'mic_device_switch').map(e => e.detail);
  follower.dispose();
  return out;
};

// ── Explicit picks (2026-10): the REAL fake devices, no enumerate stub ──────
// Chromium's fake capture exposes 'default' + "Fake Audio Input 1/2" and
// "Fake Default Audio Output" + "Fake Audio Output 1/2", each with its own id.
window.runExplicit = async () => {
  md.enumerateDevices = realEnum;
  const out = {};
  const devices = await realEnum();
  const inputs = devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const outputs = devices.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default');
  const [in1, in2] = inputs;
  const [out1, out2] = outputs;
  out.haveDevices = !!(in1 && in2 && out1 && out2);
  const capId = (t) => readCaptureTrack(t)?.getSettings().deviceId;

  // NEGATIVE CONTROL (the Settings mic test's old open): a bare id opens the DEFAULT.
  const bare = await realGum({ audio: { ...MIC_CAPTURE_CONSTRAINTS, deviceId: in2.deviceId } });
  out.bareOpened = bare.getAudioTracks()[0].getSettings().deviceId;
  bare.getTracks().forEach(t => t.stop());
  const exact = await realGum({ audio: { ...MIC_CAPTURE_CONSTRAINTS, deviceId: micDeviceConstraint(in2.deviceId) } });
  out.exactOpened = exact.getAudioTracks()[0].getSettings().deviceId;
  exact.getTracks().forEach(t => t.stop());

  // The join: CallPane's audioCaptureDefaults carry the stored pick as a string,
  // createLocalTracks turns it into {exact}.
  let setting = in2.deviceId;
  let hint = { label: in2.label, groupId: in2.groupId };
  const track = await createLocalAudioTrack({ ...MIC_CAPTURE_CONSTRAINTS, deviceId: setting });
  track.setAudioContext(new AudioContext());
  const proc = new Passthrough();
  await track.setProcessor(proc);
  const pc = new RTCPeerConnection();
  const sender = pc.addTrack(track.mediaStreamTrack);
  track.sender = sender;
  out.joinCapture = capId(track) === in2.deviceId;
  out.joinGum = gumCalls.at(-1)?.audio?.deviceId;

  const follower = createMicDeviceSync({
    enumerateDevices: () => md.enumerateDevices(),
    getMicTrack: () => track,
    switchActiveDevice: (id, ex) => track.setDeviceId(ex ? { exact: id } : id),
    getSetting: () => setting,
    getSettingHint: () => hint,
    captureConstraints: MIC_CAPTURE_CONSTRAINTS,
  });
  follower.setApplied(setting);
  await follower.seed();
  track.on('restarted', () => follower.verify());     // SidebarConference: TrackEvent.Restarted → verify

  const settle = async (pred) => { const t0 = performance.now(); while (!pred() && performance.now() - t0 < 3000) await sleep(20); await sleep(400); };
  const onPicked = (id) => capId(track) === id && sender.track === proc.processedTrack
    && proc.sourceTrack === readCaptureTrack(track) && pc.getSenders().length === 1 && pc.getSenders()[0] === sender;

  // livekit-client's ended-recovery: restartTrack({ deviceId: 'default' }).
  await track.restartTrack({ deviceId: 'default' });
  out.recoveryLandedOnDefault = capId(track) === 'default';
  await settle(() => capId(track) === in2.deviceId);
  out.recoveryBackOnPick = onPicked(in2.deviceId);

  // Reconnect republish: restartTrack() with LiveKit's stored constraints.
  await track.restartTrack();
  await settle(() => true);
  out.republishOnPick = onPicked(in2.deviceId);

  // Mid-call pick change (Settings / the control-bar menu).
  setting = in1.deviceId; hint = { label: in1.label, groupId: in1.groupId };
  await follower.sync('setting_changed');
  await settle(() => capId(track) === in1.deviceId);
  out.midCallSwitch = onPicked(in1.deviceId);

  // A stale stored id (Windows re-enumerated the device): followed by groupId+label.
  setting = 'stale-' + in2.deviceId.slice(0, 8); hint = { label: in2.label, groupId: in2.groupId };
  await follower.sync('setting_changed');
  await settle(() => capId(track) === in2.deviceId);
  out.staleIdFollowed = onPicked(in2.deviceId);
  follower.dispose();

  // ── Output: every element and context, including late ones ────────────────
  const ctx0 = new AudioContext();
  const osc = ctx0.createOscillator(); const dst = ctx0.createMediaStreamDestination(); osc.connect(dst); osc.start();
  const mkEl = () => { const el = new Audio(); el.srcObject = dst.stream; el.play().catch(() => {}); return el; };
  const early = mkEl(); applyOutputDevice(early);
  const playCtx = new AudioContext(); registerOutputAudioContext(playCtx);
  const notices = [];
  setOutputDeviceFallbackHandler(() => notices.push(1));
  onOutputDeviceChange(out2.deviceId, { label: out2.label, groupId: out2.groupId });
  await sleep(300);
  out.outEarly = early.sinkId === out2.deviceId;
  out.outCtx = playCtx.sinkId === out2.deviceId;
  const late = mkEl(); applyOutputDevice(late);
  const lateCtx = new AudioContext(); registerOutputAudioContext(lateCtx);
  await sleep(300);
  out.outLate = late.sinkId === out2.deviceId && lateCtx.sinkId === out2.deviceId;
  // The pick disappears (simulated list without it) → default, one notice; back → the pick.
  const all = (await realEnum()).filter(d => d.kind === 'audiooutput');
  refreshOutputDevices(all.filter(d => d.deviceId !== out2.deviceId));
  refreshOutputDevices(all.filter(d => d.deviceId !== out2.deviceId));
  await sleep(300);
  out.outFallback = early.sinkId === '' && late.sinkId === '' && playCtx.sinkId === '' && notices.length === 1;
  refreshOutputDevices(all);
  await sleep(300);
  out.outBack = early.sinkId === out2.deviceId && late.sinkId === out2.deviceId && playCtx.sinkId === out2.deviceId;
  return out;
};
window.ready = true;
`;

// secureLocalStore (behind audioOutput.ts) is an IndexedDB/WebCrypto facade
// hydrated at app boot; a plain in-memory map stands in for it here.
const memStore = {
  name: 'mem-store',
  setup(b) {
    b.onResolve({ filter: /\/secureLocalStore$/ }, () => ({ path: 'secureLocalStore', namespace: 'mem' }));
    b.onLoad({ filter: /.*/, namespace: 'mem' }, () => ({
      contents: 'const m = new Map(); export default { getItem: k => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: k => { m.delete(k); } };',
      loader: 'js',
    }));
  },
};

const bundle = await build({
  stdin: { contents: ENTRY, resolveDir: desktopDir, loader: 'ts', sourcefile: 'mic-follow-entry.ts' },
  bundle: true, format: 'iife', write: false, logLevel: 'warning', plugins: [memStore],
});
const js = bundle.outputFiles[0].text;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/bundle.js')) { res.setHeader('content-type', 'text/javascript'); res.end(js); }
  else { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><script src="bundle.js"></script>'); }
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));

const browser = await chromium.launch({
  executablePath: findChrome(),
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
let out;
try {
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.ready === true);
  console.log(`chromium ${browser.version()}`);
  out = await page.evaluate(() => window.run());
  out.explicit = await page.evaluate(() => window.runExplicit());
} finally {
  await browser.close();   // kills only the browser this script started
  server.close();
}

console.log(JSON.stringify(out, null, 2));
const checks = [];
const check = (ok, what) => { checks.push([ok, what]); };

check(out.senderCarriesProcessorOutput, 'sender carries the processor output (app-shaped pipeline)');
check(out.oldFirst.storedBefore === '{"exact":"default"}' && out.oldFirst.senderTrackChanged,
  'NEGATIVE CONTROL: old path re-opens on the first change ({exact:"default"} stored)');
check(out.oldSecond.storedBefore === '"default"' && out.oldSecond.libReturned === true
  && out.oldSecond.gumCallsMade === 0 && !out.oldSecond.senderTrackChanged,
  'NEGATIVE CONTROL: old path is a silent no-op (returns true) on the second change');
out.fix.forEach((f, i) => {
  check(f.senderTrackChanged && f.senderIsNewProcessorOutput && f.processorFedNewCapture
    && f.oldCaptureEnded && f.newCaptureLive && f.sameSender && f.gumCallsMade === 1,
    `fix: change #${i + 1} swaps the sender onto a fresh 'default' capture (one getUserMedia per burst)`);
  check(f.lastGumAudio?.deviceId === 'default' && f.lastGumAudio?.echoCancellation === false
    && f.lastGumAudio?.noiseSuppression === false && f.lastGumAudio?.autoGainControl === false,
    `fix: change #${i + 1} re-opens with deviceId 'default' and browser DSP off`);
  check(f.ms < 1000, `fix: change #${i + 1} on the wire ${f.ms} ms after the first event (< 1000)`);
});
check(out.fixMuted.senderTrackChanged && out.fixMuted.isMuted && out.fixMuted.captureEnabled === false,
  'fix: a muted user is moved too and stays muted');
check(out.unrelatedDevicechangeGumCalls === 0, 'fix: an unrelated devicechange re-opens nothing');
check(out.events.length >= 1 && out.events.every(d => d.reason === 'default_changed' && d.to_default === true && d.verdict === 'ok'),
  'call event mic_device_switch {reason, to_default, verdict} logged');

// Explicit picks against Chromium's real fake devices.
const x = out.explicit;
check(x.haveDevices, 'explicit: Chromium exposes two fake inputs and two fake outputs');
check(x.bareOpened === 'default' && x.exactOpened !== 'default',
  'NEGATIVE CONTROL: a bare deviceId (the old Settings mic test) opens the DEFAULT; micDeviceConstraint opens the pick');
check(x.joinCapture && x.joinGum && typeof x.joinGum === 'object' && 'exact' in x.joinGum,
  'explicit: the join captures the picked mic, opened with {exact}');
check(x.recoveryLandedOnDefault && x.recoveryBackOnPick,
  "explicit: after livekit's ended-recovery reopened 'default', verify() puts the SENDER back on the pick (same sender, processor fed)");
check(x.republishOnPick, 'explicit: a reconnect republish (restartTrack()) reopens the pick');
check(x.midCallSwitch, 'explicit: a mid-call pick change moves the sender to the new mic');
check(x.staleIdFollowed, 'explicit: a stale stored id is followed to the same device by groupId+label');
check(x.outEarly && x.outCtx, 'output: setSinkId applied to an existing element and playback context');
check(x.outLate, 'output: elements/contexts created AFTER the selection are routed at birth');
check(x.outFallback, 'output: pick gone → every element/context on the system default, ONE notice');
check(x.outBack, 'output: pick back → every element/context routed to it again');

let failed = 0;
for (const [ok, what] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failed++; }
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
