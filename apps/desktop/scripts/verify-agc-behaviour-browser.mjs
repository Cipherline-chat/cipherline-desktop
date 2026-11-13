/**
 * Real-browser capture of the AGC behaviour the owner reported (2026-10): runs
 * the REAL CipherlineVoiceProcessor (in-worklet RNNoise "Strong", Speex "Light",
 * gate, EQ, AGC) on scripted "microphones" and saves what the chain would hand
 * to the RTCRtpSender, sample for sample, for offline analysis
 * (see AGC_OUT_DIR/analyze.mjs next to the saved files).
 *
 *   node scripts/verify-agc-behaviour-browser.mjs [--chain=after|before] [--only=a-strong,b-light]
 *
 * Scenarios (id suffix = noise-suppression mode):
 *   a  quiet talk, then 30 s of room noise with breaths and key clicks, then a
 *      LOUD talker  (symptom 1: gain creeping up in "silence", loud onset)
 *   b  a quiet (-30 dBFS active) talker from a cold start (time to target)
 *   c  a loud (-6 dBFS, hard-clipped like a hot mic) talker from a cold start
 *      (symptom 2: first-second overshoot of a loud joiner)
 *   d  normal (-26) then loud (-6) speech back to back (symptom 3: Light vs Strong)
 *   e  the same over non-stationary room noise at -44 dBFS (what Light cannot remove)
 *   g  like a, but the 30 s are typing + a wobbling fan (Light cannot remove it, Strong can)
 *   f  d with AGC and gate OFF (the noise suppressors' own effect on level)
 *
 * LOUDNESS_CHAIN_DIR=<dir holding an older src/> measures that chain instead of
 * this checkout (inside apps/desktop so node_modules resolves).
 * Needs ffmpeg with flite, chrome-headless-shell (CIPHERLINE_CHROME /
 * CHROME_PATH, else Playwright's cache), hoisted esbuild + playwright-core.
 * Real time: a few minutes per scenario.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const chainName = arg('chain', 'after');
const chainDir = process.env.LOUDNESS_CHAIN_DIR ? path.resolve(process.env.LOUDNESS_CHAIN_DIR) : desktopDir;
const outDir = process.env.AGC_OUT_DIR || path.join(os.tmpdir(), 'agc-out');
const only = arg('only', '').split(',').filter(Boolean);
const SR = 48000;
fs.mkdirSync(outDir, { recursive: true });

function fail(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }
function findChrome() {
  const envPath = process.env.CIPHERLINE_CHROME || process.env.CHROME_PATH;
  if (envPath) { if (fs.existsSync(envPath)) return envPath; fail(`CHROME path '${envPath}' missing`); }
  const pattern = path.join(os.homedir(), '.cache', 'ms-playwright', 'chromium_headless_shell-*', 'chrome-headless-shell-*', 'chrome-headless-shell');
  const m = fs.globSync(pattern).filter((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  if (!m.length) fail('Could not find chrome-headless-shell (set CIPHERLINE_CHROME).');
  return m.sort().reverse()[0];
}

// ── Signals ──────────────────────────────────────────────────────────────────
const TEXT = 'Hey, can everybody hear me okay? I think the volume on my end is a little strange today. ' +
  'Let me try saying something longer so you can judge how loud I am compared to everyone else. ' +
  'The quick brown fox jumps over the lazy dog, and then he sits down quietly for a while. ' +
  'Alright, who wants to start with the agenda for tonight?';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-agc-'));
function speech(voice) {
  const out = path.join(tmp, `${voice}.f32`);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `flite=text='${TEXT}':voice=${voice}`, '-ar', String(SR), '-ac', '1', '-f', 'f32le', out], { encoding: 'utf8' });
  if (r.status !== 0) fail(`ffmpeg flite failed: ${r.stderr}`);
  const b = fs.readFileSync(out);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}
const lin = (d) => Math.pow(10, d / 20);
function activeLevelDb(x) {
  const fr = Math.round(SR * 0.02); const e = [];
  for (let i = 0; i + fr <= x.length; i += fr) { let s = 0; for (let j = 0; j < fr; j++) s += x[i + j] * x[i + j]; e.push(s / fr); }
  let lvl = 10 * Math.log10(Math.max(e.reduce((a, b) => a + b, 0) / e.length, 1e-20));
  for (let k = 0; k < 6; k++) {
    const thr = Math.pow(10, (lvl - 15.9) / 10); let s = 0, n = 0;
    for (const v of e) if (v >= thr) { s += v; n++; }
    if (!n) break; lvl = 10 * Math.log10(s / n);
  }
  return lvl;
}
function scaleToActive(x, targetDb) {
  const g = lin(targetDb - activeLevelDb(x)); const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = Math.max(-1, Math.min(1, x[i] * g)); // a hot mic clips
  return y;
}
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
function noise(n, levelDb) { const y = new Float32Array(n); let lp = 0; const g = lin(levelDb) * Math.sqrt(3) * 1.6; for (let i = 0; i < n; i++) { lp += 0.35 * ((rnd() * 2 - 1) - lp); y[i] = lp * g; } return y; }
function addAt(dst, src, at) { for (let i = 0; i < src.length && at + i < dst.length; i++) dst[at + i] += src[i]; }
function concat(...a) { let n = 0; for (const x of a) n += x.length; const y = new Float32Array(n); let p = 0; for (const x of a) { y.set(x, p); p += x.length; } return y; }
function breath(sec, db) { const n = Math.round(sec * SR); const y = noise(n, db); for (let i = 0; i < n; i++) y[i] *= 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); return y; }
function click(db) { const n = Math.round(0.012 * SR); const y = new Float32Array(n); const g = lin(db); for (let i = 0; i < n; i++) y[i] = (rnd() * 2 - 1) * g * Math.exp(-i / (0.0025 * SR)); return y; }
// Non-stationary room noise (fan wobble, distant traffic, a TV in the next room):
// low-passed noise under a slowly wandering ~14 dB envelope, average level avgDb.
// A steady-noise suppressor (Speex "Light") cannot follow it; a speech model
// (RNNoise "Strong") removes it.
function bursty(n, avgDb) {
  const y = noise(n, avgDb); let m = 0, tgt = 0, k = 0;
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) { if (k-- <= 0) { tgt = -14 * rnd(); k = Math.round((0.15 + 0.5 * rnd()) * SR); } m += (tgt - m) * 0.0004; e[i] = lin(m); }
  let s = 0; for (let i = 0; i < n; i++) { y[i] *= e[i]; s += y[i] * y[i]; }
  const g = lin(avgDb) / Math.sqrt(s / n); for (let i = 0; i < n; i++) y[i] *= g;
  return y;
}
// Thirty seconds of "nobody is talking" the way a real desk sounds: room noise,
// breaths, key clicks and the odd chair - louder than the default -45 dBFS gate.
function silenceWithRoom(sec) {
  const s = bursty(sec * SR, -52);
  for (let t = 1; t < sec - 1; t += 1.7) addAt(s, breath(0.4, -34), Math.round(t * SR));
  for (let t = 0.5; t < sec - 1; t += 0.9) addAt(s, click(-24), Math.round(t * SR));
  return s;
}
// The same thirty seconds with a person typing and a fan wobbling, nothing speech-like: a
// speech model (Strong) deletes all of it, a steady-noise suppressor (Light) cannot.
function typingAndFan(sec) {
  const s = bursty(sec * SR, -46);
  for (let t = 0.3; t < sec - 1; t += 0.33 + 0.1 * rnd()) addAt(s, click(-24 + 6 * rnd()), Math.round(t * SR));
  return s;
}
const secs = (x, a, b) => x.subarray(Math.round(a * SR), Math.round(b * SR));
const sp = speech('rms');
const sp2 = speech('slt');
// A lead-in of room noise: the chain's start-up (worklet priming, track hand-over; the
// first ~0.5 s of the published track is digital silence) must not eat the first word.
const lead = (sec = 2) => noise(sec * SR, -62);
const SCEN = {
  a: () => concat(lead(), secs(scaleToActive(sp, -30), 0, 8), silenceWithRoom(30), secs(scaleToActive(sp2, -12), 0, 9)),
  g: () => concat(lead(), secs(scaleToActive(sp, -30), 0, 8), typingAndFan(30), secs(scaleToActive(sp2, -12), 0, 9)),
  b: () => concat(lead(4), secs(scaleToActive(sp2, -30), 0, 12)),
  c: () => concat(lead(4), secs(scaleToActive(sp, -6), 0, 10)),
  d: () => concat(lead(), secs(scaleToActive(sp, -26), 0, 10), noise(2 * SR, -62), secs(scaleToActive(sp2, -6), 0, 12)),
  // d again with AGC and gate OFF: what the noise suppressors themselves do to level
  f: () => SCEN.d(),
  // normal then loud speech over a desk's worth of non-stationary noise
  e: () => { const x = concat(lead(), secs(scaleToActive(sp, -26), 0, 10), noise(2 * SR, -62), secs(scaleToActive(sp2, -6), 0, 12)); const nz = bursty(x.length, -44); for (let i = 0; i < x.length; i++) x[i] = Math.max(-1, Math.min(1, x[i] + nz[i])); return x; },
};
const jobs = [];
for (const id of Object.keys(SCEN)) for (const mode of ['strong', 'light']) jobs.push({ id: `${id}-${mode}`, key: id, mode });
const todo = only.length ? jobs.filter((j) => only.includes(j.id)) : jobs;

// ── The page ──────────────────────────────────────────────────────────────────
const viteShims = {
  name: 'vite-shims',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, async (args) => {
      const r = await b.resolve(args.path.replace(/\?raw$/, ''), { resolveDir: args.resolveDir, kind: 'import-statement' });
      return { path: r.path, namespace: 'raw' };
    });
    b.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({ contents: `export default ${JSON.stringify(fs.readFileSync(args.path, 'utf8'))};`, loader: 'js' }));
    b.onResolve({ filter: /\?worker$/ }, () => ({ path: 'worker-stub', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default class { constructor() { throw new Error("worker fallback not expected"); } }', loader: 'js' }));
  },
};
const ENTRY = String.raw`
import { CipherlineVoiceProcessor } from './src/utils/voiceProcessor';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BASE = {
  noiseSuppression: true, noiseSuppressionMode: 'strong', echoCancellation: false, volumeNormalization: true, voiceGate: true, voiceGateThreshold: -45,
  pushToTalk: false, pushToTalkKey: null, micDeviceId: '', speakerDeviceId: '', cameraDeviceId: '',
  micVolume: 100, speakerVolume: 100, eqEnabled: false, eqBands: [0, 0, 0, 0, 0],
  cameraBrightness: 100, cameraContrast: 100, cameraSaturation: 100,
};
window.run = async (cfg) => {
  const f32 = new Float32Array(await (await fetch('/mic/' + cfg.id)).arrayBuffer());
  const micCtx = new AudioContext({ sampleRate: 48000 }); await micCtx.resume();
  const buf = micCtx.createBuffer(1, f32.length, 48000); buf.copyToChannel(f32, 0);
  const src = micCtx.createBufferSource(); src.buffer = buf;
  const dest = micCtx.createMediaStreamDestination(); src.connect(dest);
  const proc = new CipherlineVoiceProcessor({ ...BASE, ...cfg.settings }, {}, {});
  const procCtx = new AudioContext({ sampleRate: 48000 }); await procCtx.resume();
  await proc.init({ track: dest.stream.getAudioTracks()[0], audioContext: procCtx });
  const outCtx = new AudioContext({ sampleRate: 48000 }); await outCtx.resume();
  const sp = outCtx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  sp.onaudioprocess = (e) => { chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  const mute = outCtx.createGain(); mute.gain.value = 0;
  outCtx.createMediaStreamSource(new MediaStream([proc.processedTrack])).connect(sp);
  sp.connect(mute); mute.connect(outCtx.destination);
  src.start();
  await sleep(f32.length / 48000 * 1000 + 1500);
  let n = 0; for (const c of chunks) n += c.length;
  const out = new Float32Array(n); let p = 0; for (const c of chunks) { out.set(c, p); p += c.length; }
  await proc.destroy();
  for (const c of [micCtx, procCtx, outCtx]) await c.close();
  let bin = ''; const u = new Uint8Array(out.buffer);
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(bin);
};
window.ready = true;
`;
const bundle = await build({ stdin: { contents: ENTRY, resolveDir: chainDir, loader: 'ts', sourcefile: 'agc-entry.ts' }, bundle: true, format: 'iife', write: false, logLevel: 'warning', plugins: [viteShims] });
const js = bundle.outputFiles[0].text;
const mics = new Map();
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/bundle.js')) { res.setHeader('content-type', 'text/javascript'); res.end(js); }
  else if (req.url.startsWith('/mic/')) { const b = mics.get(req.url.slice(5)); res.setHeader('content-type', 'application/octet-stream'); res.end(Buffer.from(b.buffer, b.byteOffset, b.byteLength)); }
  else { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><script src="bundle.js"></script>'); }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const browser = await chromium.launch({ executablePath: findChrome(), args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.ready === true);
  // Warm-up (discarded): the first init compiles the 4.8 MB RNNoise module.
  mics.set('warm', secs(scaleToActive(sp, -26), 0, 4));
  await page.evaluate((c) => window.run(c), { id: 'warm', settings: {} });
  for (const j of todo) {
    seed = 12345; // same noise for every chain (before/after)
    const mic = SCEN[j.key]();
    mics.set(j.id, mic);
    fs.writeFileSync(path.join(outDir, `${j.key}.mic.f32`), Buffer.from(mic.buffer));
    const b64 = await page.evaluate((c) => window.run(c), { id: j.id, settings: { noiseSuppressionMode: j.mode, ...(j.key === 'f' ? { volumeNormalization: false, voiceGate: false } : {}) } });
    fs.writeFileSync(path.join(outDir, `${j.id}.${chainName}.f32`), Buffer.from(b64, 'base64'));
    console.log(`captured ${j.id} (${chainName}): mic ${(mic.length / SR).toFixed(1)} s`);
  }
} finally { await browser.close(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
