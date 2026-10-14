/**
 * Real-browser verification of the outgoing voice chain (voiceProcessor.ts):
 * the voice gate works with noise suppression OFF, and the Settings gate meter
 * reads the level the gate actually compares against its threshold.
 *
 *   node scripts/verify-voice-chain-browser.mjs
 *
 * Runs the REAL CipherlineVoiceProcessor (the in-worklet RNNoise, the gate
 * worklet, EQ, AGC, compressor), constructed as the Settings mic test does, in
 * headless Chromium on a synthetic "mic": steady room noise plus a speech-level
 * tone for 6 s (so AGC adapts the way it does on a real voice), then noise
 * only. It measures what the chain would TRANSMIT during the noise-only tail,
 * what the old meter (end of chain) showed and what the gate meter (the gate's
 * own detector) shows.
 *
 * Then, on a REAL livekit-client LocalAudioTrack (Chromium's fake capture) and
 * an RTCRtpSender: with every stage off the raw capture is published with no
 * processor; turning the gate on (NS off) attaches the processor on the same
 * sender, mute intact; turning everything off detaches it again.
 *
 * NEGATIVE CONTROL (in-run): on a hot mic with NS off the old meter reads the
 * room noise UNDER the threshold while the gate lets it through — the reported
 * "the gate doesn't work with noise suppression off".
 *
 * Needs chrome-headless-shell (CIPHERLINE_CHROME / CHROME_PATH, else
 * Playwright's cache) and the monorepo-hoisted `esbuild` + `playwright-core`.
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

// Vite-only import suffixes the processor uses: `?raw` (worklet sources) and
// `?worker` (the Worker-fed RNNoise fallback, never reached when the in-worklet
// path comes up — stubbed so a fallback would be visible as a failure).
const viteShims = {
  name: 'vite-shims',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, async (args) => {
      const spec = args.path.replace(/\?raw$/, '');
      const r = await b.resolve(spec, { resolveDir: args.resolveDir, kind: 'import-statement' });
      return { path: r.path, namespace: 'raw' };
    });
    b.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({
      contents: `export default ${JSON.stringify(fs.readFileSync(args.path, 'utf8'))};`, loader: 'js',
    }));
    b.onResolve({ filter: /\?worker$/ }, () => ({ path: 'worker-stub', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default class { constructor() { throw new Error("worker fallback not expected"); } }', loader: 'js',
    }));
  },
};

const ENTRY = String.raw`
import { createLocalAudioTrack } from 'livekit-client';
import { CipherlineVoiceProcessor } from './src/utils/voiceProcessor';
import * as mgr from './src/utils/voiceProcessorManager';
import { GATE_METER_REPORT_MS } from './src/utils/voiceChain';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const db = (lin) => lin > 0 ? 20 * Math.log10(lin) : -Infinity;
const lin = (d) => Math.pow(10, d / 20);

const BASE = {
  noiseSuppression: true, volumeNormalization: true, voiceGate: true, voiceGateThreshold: -45,
  pushToTalk: false, pushToTalkKey: null, micDeviceId: '', speakerDeviceId: '', cameraDeviceId: '',
  micVolume: 100, speakerVolume: 100, eqEnabled: false, eqBands: [0, 0, 0, 0, 0],
  cameraBrightness: 100, cameraContrast: 100, cameraSaturation: 100,
};

/** A synthetic mic: white noise at noiseDb RMS, plus a 300 Hz "voice" at toneDb for speechMs. */
function makeMic(ctx, noiseDb, toneDb, speechMs) {
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  // Uniform white noise has RMS = amplitude / sqrt(3).
  const amp = lin(noiseDb) * Math.sqrt(3);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * amp;
  const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
  const tone = ctx.createOscillator(); tone.frequency.value = 300;
  const toneGain = ctx.createGain();
  toneGain.gain.value = 0;
  // Scheduled from the measurement start, not from here: the first processor
  // init loads the 4.8 MB RNNoise module, and speech must not run into the
  // noise-only tail. Sine RMS = amplitude / sqrt(2).
  const startSpeech = () => {
    toneGain.gain.setValueAtTime(lin(toneDb) * Math.SQRT2, ctx.currentTime);
    toneGain.gain.setValueAtTime(0, ctx.currentTime + speechMs / 1000);
  };
  const dest = ctx.createMediaStreamDestination();
  noise.connect(dest); tone.connect(toneGain).connect(dest);
  noise.start(); tone.start();
  return { track: dest.stream.getAudioTracks()[0], startSpeech };
}

window.run = async (cfg) => {
  const micCtx = new AudioContext({ sampleRate: 48000 });
  await micCtx.resume();
  const { track: mic, startSpeech } = makeMic(micCtx, cfg.noiseDb, cfg.toneDb, cfg.speechMs);
  const meter = [];
  const gateMeter = [];
  const settings = { ...BASE, ...cfg.settings };
  // Constructed exactly as the Settings mic test constructs it.
  const proc = new CipherlineVoiceProcessor(settings, {
    onInputLevel: (v) => meter.push([performance.now(), v]),
    onGateLevel: (v, open) => gateMeter.push([performance.now(), v, open]),
  }, { gateMeterMs: GATE_METER_REPORT_MS });
  const procCtx = new AudioContext({ sampleRate: 48000 });
  await procCtx.resume();
  await proc.init({ track: mic, audioContext: procCtx });
  // Whatever the chain would hand to the RTCRtpSender.
  const outCtx = new AudioContext({ sampleRate: 48000 });
  await outCtx.resume();
  const an = outCtx.createAnalyser(); an.fftSize = 2048;
  outCtx.createMediaStreamSource(new MediaStream([proc.processedTrack])).connect(an);
  const samples = [];
  startSpeech();
  const t0 = performance.now();
  const buf = new Float32Array(an.fftSize);
  while (performance.now() - t0 < cfg.totalMs) {
    an.getFloatTimeDomainData(buf);
    let s = 0; for (const x of buf) s += x * x;
    samples.push([performance.now(), Math.sqrt(s / buf.length)]);
    await sleep(20);
  }
  const tailFrom = t0 + cfg.totalMs - cfg.tailMs;
  const inTail = (arr) => arr.filter(([t]) => t >= tailFrom);
  const meanDb = (vals) => {
    const f = vals.filter(v => Number.isFinite(v));
    if (!f.length) return -Infinity;
    return db(Math.sqrt(f.reduce((a, v) => a + v * v, 0) / f.length));
  };
  const median = (vals) => {
    if (!vals.length) return null;
    const s = [...vals].sort((a, b) => a - b);
    const m = s[s.length >> 1];
    return Number.isFinite(m) ? Math.round(m * 10) / 10 : m;
  };
  const gateTail = inTail(gateMeter);
  await proc.destroy();
  for (const c of [micCtx, procCtx, outCtx]) await c.close();
  const r1 = (v) => Number.isFinite(v) ? Math.round(v * 10) / 10 : String(v);
  return {
    transmittedDb: r1(meanDb(inTail(samples).map(([, v]) => v))),
    // The meter the threshold slider USED to show: the end of the chain.
    oldMeterMedianDb: r1(median(inTail(meter).map(([, v]) => v)) ?? -Infinity),
    // The meter it shows now: the gate's own detector, and the gate's state.
    gateMeterMedianDb: r1(median(gateTail.map(([, v]) => v)) ?? -Infinity),
    gateOpenFraction: gateTail.length ? Math.round(100 * gateTail.filter(([, , o]) => o).length / gateTail.length) / 100 : null,
    gateMeterMaxDb: r1(Math.max(...gateTail.map(([, v]) => v))),
  };
};

// ── Attach / detach on a REAL livekit-client mic track (fake capture device) ─
window.runAttach = async () => {
  const out = {};
  const ALL_OFF = { ...BASE, noiseSuppression: false, volumeNormalization: false, voiceGate: false };
  const track = await createLocalAudioTrack({ deviceId: 'default', echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  const pc = new RTCPeerConnection();
  const sender = pc.addTrack(track.mediaStreamTrack);
  track.sender = sender;
  const raw = () => track._mediaStreamTrack;
  const settle = async (pred) => { const t0 = performance.now(); while (!pred() && performance.now() - t0 < 3000) await sleep(20); };

  await mgr.bindMicTrack('call-x', track, ALL_OFF);
  out.allOffRaw = sender.track === raw() && !track.getProcessor();

  await track.mute();
  mgr.updateSettings({ ...ALL_OFF, voiceGate: true });             // gate on, NS still off
  await settle(() => !!track.getProcessor() && sender.track === track.getProcessor().processedTrack);
  const proc = track.getProcessor();
  out.gateOnAttached = !!proc && sender.track === proc.processedTrack && pc.getSenders().length === 1 && pc.getSenders()[0] === sender;
  out.gatePlan = proc?.chainPlan;
  out.mutedKept = track.isMuted && raw().enabled === false;

  await track.unmute();
  mgr.updateSettings(ALL_OFF);
  await settle(() => !track.getProcessor() && sender.track === raw());
  out.offDetached = !track.getProcessor() && sender.track === raw() && pc.getSenders()[0] === sender && raw().enabled === true;

  mgr.updateSettings({ ...ALL_OFF, noiseSuppression: true });
  await settle(() => !!track.getProcessor() && sender.track === track.getProcessor().processedTrack);
  out.reattached = !!track.getProcessor() && sender.track === track.getProcessor().processedTrack;
  await mgr.destroyForCall('call-x');
  track.stop();
  return out;
};
window.ready = true;
`;

const bundle = await build({
  stdin: { contents: ENTRY, resolveDir: desktopDir, loader: 'ts', sourcefile: 'voice-chain-entry.ts' },
  bundle: true, format: 'iife', write: false, logLevel: 'warning', plugins: [viteShims],
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
const THRESHOLD = -45;
// Speech for 6 s (so AGC adapts as on a real voice), then 1.5 s of noise only.
const timing = { speechMs: 6000, totalMs: 8500, tailMs: 1500 };
// A hot mic: loud speech, room noise ABOVE the -45 dBFS threshold at the gate.
// AGC pulls the speech down toward its target, and the noise with it.
const hot = { ...timing, noiseDb: -40, toneDb: -3 };
// A quieter room: noise BELOW the threshold at the gate.
const quiet = { ...timing, noiseDb: -52, toneDb: -16 };
const r = {};
let attach;
try {
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  page.on('console', m => { if (m.type() === 'error') console.error('[console]', m.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.ready === true);
  console.log(`chromium ${browser.version()}`);
  const run = (cfg, settings) => page.evaluate((c) => window.run(c), { ...cfg, settings: { voiceGateThreshold: THRESHOLD, ...settings } });
  // Warm-up, discarded: the page's first processor init compiles the 4.8 MB
  // RNNoise module and stalls that context for a few seconds, so its mic audio
  // (speech included) arrives late and runs into the "noise-only" tail.
  await run(quiet, { noiseSuppression: true, voiceGate: true });
  r.quiet_nsOff_gateOn = await run(quiet, { noiseSuppression: false, voiceGate: true });
  r.quiet_nsOff_gateOff = await run(quiet, { noiseSuppression: false, voiceGate: false });
  r.quiet_nsOn_gateOn = await run(quiet, { noiseSuppression: true, voiceGate: true });
  r.hot_nsOff_gateOn = await run(hot, { noiseSuppression: false, voiceGate: true });
  attach = await page.evaluate(() => window.runAttach());
} finally {
  await browser.close();
  server.close();
}
console.log(JSON.stringify({ threshold: THRESHOLD, quiet, hot, results: r, attach }, null, 2));

const checks = [];
const check = (ok, what) => { checks.push([ok, what]); };
const silent = (v) => v === '-Infinity' || (typeof v === 'number' && v < -90);
const num = (v) => (typeof v === 'number' ? v : -Infinity);

check(silent(r.quiet_nsOff_gateOn.transmittedDb),
  `NS OFF, gate ON: room noise under the threshold is gated to silence (transmitted ${r.quiet_nsOff_gateOn.transmittedDb} dBFS)`);
check(!silent(r.quiet_nsOff_gateOff.transmittedDb),
  `control: the same noise with the gate OFF is transmitted (${r.quiet_nsOff_gateOff.transmittedDb} dBFS) — the gate is what silenced it`);
check(silent(r.quiet_nsOn_gateOn.transmittedDb), 'NS ON, gate ON: silent too (unchanged)');
check(num(r.quiet_nsOff_gateOn.gateMeterMedianDb) < THRESHOLD && r.quiet_nsOff_gateOn.gateOpenFraction === 0,
  `gate meter: under the threshold and closed while gating (${r.quiet_nsOff_gateOn.gateMeterMedianDb} dBFS)`);
check(!silent(r.hot_nsOff_gateOn.transmittedDb) && num(r.hot_nsOff_gateOn.oldMeterMedianDb) < THRESHOLD,
  `NEGATIVE CONTROL (old meter): hot mic, NS off — noise IS transmitted (${r.hot_nsOff_gateOn.transmittedDb} dBFS) while the old end-of-chain meter reads it UNDER the threshold (${r.hot_nsOff_gateOn.oldMeterMedianDb} dBFS)`);
check(num(r.hot_nsOff_gateOn.gateMeterMedianDb) >= THRESHOLD && r.hot_nsOff_gateOn.gateOpenFraction === 1,
  `gate meter: the same noise reads ABOVE the threshold (${r.hot_nsOff_gateOn.gateMeterMedianDb} dBFS) with the gate open — the meter matches what the gate does`);
check(attach.allOffRaw, 'every stage off: the RAW capture is published, no processor');
check(attach.gateOnAttached && attach.gatePlan?.gate === true && attach.gatePlan?.ns === false,
  'gate turned on mid-call with NS off: processor attached on the SAME sender, gate active, NS off');
check(attach.mutedKept, 'mute survives the attach');
check(attach.offDetached, 'everything off again: detached live, raw capture back on the same sender');
check(attach.reattached, 'and re-attached live when a stage comes back on');

let failed = 0;
for (const [ok, what] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failed++; }
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
