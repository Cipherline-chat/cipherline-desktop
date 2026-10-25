/**
 * Real-browser verification of call loudness: does the REAL outgoing voice chain
 * (voiceProcessor.ts: in-worklet RNNoise, gate, EQ, AGC, mic volume) put a quiet
 * talker and a loud talker at the same level, without clipping — and does the
 * listener-side leveler (audio/receiveLeveler.js) leave a talker the sender AGC
 * already levelled alone, while pulling an un-levelled one toward the target?
 *
 *   node scripts/verify-call-loudness-browser.mjs
 *
 * How: real speech (ffmpeg's flite TTS, four different voices), scaled to a
 * known ACTIVE-speech level (P.56-style: mean power of the frames within ~16 dB
 * of the active level) and hard-clipped at full scale like a hot mic, is played
 * as the "microphone" into the real CipherlineVoiceProcessor in headless
 * Chromium, in real time, exactly as verify-voice-chain-browser.mjs constructs
 * it. What the chain would hand to the RTCRtpSender is captured sample for
 * sample and measured here in node: active-speech level over the first 10 s
 * (convergence) and the last 10 s (steady state), peak, clipped samples.
 * The same captured audio is then turned into the 20 ms RTP audio-level
 * readings a receiver sees (-1.4 dB bias, whole-dB quantisation, measured on a
 * loopback RTCPeerConnection) and run through the real ReceiveLeveler.
 *
 * Finally the measurement the listener-side leveler depends on is checked on a
 * real RTCPeerConnection (loopback, Opus): getSynchronizationSources().audioLevel
 * of a received speech track, polled every 50 ms through the app's own
 * pickRtpLevel(), driving the real ReceiveLeveler.
 *
 * NEGATIVE CONTROL (in-run): the same four talkers with "Auto gain control"
 * OFF must come out far apart — otherwise the "levelled" result proves nothing.
 *
 * Needs ffmpeg with flite (speech), chrome-headless-shell (CIPHERLINE_CHROME /
 * CHROME_PATH, else Playwright's cache) and the hoisted `esbuild` +
 * `playwright-core`. Takes ~3-4 minutes (real time). Exit 0 = all checks pass.
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
// Before/after runs: point this at a directory that holds an OLDER copy of src/
// (inside apps/desktop, so node_modules still resolves) to measure that chain
// with the same signals. The checks below are then expected to FAIL for a chain
// that does not level.
const chainDir = process.env.LOUDNESS_CHAIN_DIR ? path.resolve(process.env.LOUDNESS_CHAIN_DIR) : desktopDir;
const SR = 48000;

function fail(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }

function findChrome() {
  const envPath = process.env.CIPHERLINE_CHROME || process.env.CHROME_PATH;
  if (envPath) {
    if (fs.existsSync(envPath)) return envPath;
    fail(`CIPHERLINE_CHROME/CHROME_PATH is set to '${envPath}' but nothing exists there.`);
  }
  const pattern = path.join(os.homedir(), '.cache', 'ms-playwright',
    'chromium_headless_shell-*', 'chrome-headless-shell-*', 'chrome-headless-shell');
  const matches = fs.globSync(pattern).filter((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  if (matches.length === 0) fail('Could not find chrome-headless-shell (set CIPHERLINE_CHROME).');
  return matches.sort().reverse()[0];
}

// ── Speech ────────────────────────────────────────────────────────────────────
const TEXT = 'Hey, can everybody hear me okay? I think the volume on my end is a little strange today. ' +
  'Let me try saying something longer so you can judge how loud I am compared to everyone else. ' +
  'The quick brown fox jumps over the lazy dog, and then he sits down quietly for a while. ' +
  'Alright, who wants to start with the agenda for tonight?';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-loudness-'));
function speech(voice) {
  const out = path.join(tmp, `${voice}.f32`);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    `flite=text='${TEXT}':voice=${voice}`, '-ar', String(SR), '-ac', '1', '-f', 'f32le', out], { encoding: 'utf8' });
  if (r.status !== 0) fail(`ffmpeg flite failed for voice ${voice}: ${r.stderr}`);
  const b = fs.readFileSync(out);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}

// ── Measurement (P.56-flavoured active speech level) ─────────────────────────
const lin = (d) => Math.pow(10, d / 20);
function activeLevelDb(x, from = 0, to = x.length) {
  const fr = Math.round(SR * 0.02); const e = [];
  for (let i = from; i + fr <= to; i += fr) { let s = 0; for (let j = 0; j < fr; j++) s += x[i + j] * x[i + j]; e.push(s / fr); }
  if (!e.length) return -120;
  let lvl = 10 * Math.log10(Math.max(e.reduce((a, b) => a + b, 0) / e.length, 1e-20));
  for (let k = 0; k < 6; k++) {
    const thr = Math.pow(10, (lvl - 15.9) / 10); let s = 0, n = 0;
    for (const v of e) if (v >= thr) { s += v; n++; }
    if (!n) break;
    lvl = 10 * Math.log10(s / n);
  }
  return lvl;
}
const peakDb = (x, a = 0, b = x.length) => { let p = 0; for (let i = a; i < b; i++) p = Math.max(p, Math.abs(x[i])); return 20 * Math.log10(Math.max(p, 1e-12)); };
function scaleToActive(x, targetDb) {
  const g = lin(targetDb - activeLevelDb(x)); const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = Math.max(-1, Math.min(1, x[i] * g)); // a hot mic clips
  return y;
}
const repeatTo = (x, seconds) => {
  const n = Math.ceil((seconds * SR) / x.length); const y = new Float32Array(x.length * n);
  for (let i = 0; i < n; i++) y.set(x, i * x.length); return y;
};

// ── Receive side: RTP audio-level readings -> the real ReceiveLeveler ─────────
const rx = await build({ entryPoints: [path.join(desktopDir, 'src/audio/receiveLeveler.js')], bundle: true, format: 'esm', write: false, logLevel: 'warning' });
const { ReceiveLeveler, dbToLinear } = await import('data:text/javascript;base64,' + Buffer.from(rx.outputFiles[0].text).toString('base64'));
function listen(wire) {
  const lv = new ReceiveLeveler(); const y = new Float32Array(wire.length); let gDb = 0;
  for (let p = 0; (p + 1) * 960 <= wire.length; p++) {
    let s = 0; for (let j = 0; j < 960; j++) s += wire[p * 960 + j] ** 2;
    const reading = Math.max(-127, Math.round(10 * Math.log10(Math.max(s / 960, 1e-14)) - 1.4)); // ssrc-audio-level
    if (p % 2 === 1) gDb = lv.push(reading, 0.04);                                                 // 25 Hz polls
    const g = dbToLinear(gDb);
    for (let j = 0; j < 960; j++) y[p * 960 + j] = wire[p * 960 + j] * g;
  }
  return { y, gainDb: gDb };
}

const il = await build({ entryPoints: [path.join(desktopDir, 'src/utils/incomingLeveler.ts')], bundle: true, format: 'esm', write: false, logLevel: 'warning' });
const { pickRtpLevel } = await import('data:text/javascript;base64,' + Buffer.from(il.outputFiles[0].text).toString('base64'));

// ── The page: the real voice processor on a speech "microphone" ──────────────
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
  noiseSuppression: true, echoCancellation: true, volumeNormalization: true, voiceGate: true, voiceGateThreshold: -45,
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
// RTCPeerConnection loopback: poll the RTP audio level of the received track like the app does.
window.rtpRun = async (cfg) => {
  const f32 = new Float32Array(await (await fetch('/mic/' + cfg.id)).arrayBuffer());
  const ac = new AudioContext({ sampleRate: 48000 }); await ac.resume();
  const buf = ac.createBuffer(1, f32.length, 48000); buf.copyToChannel(f32, 0);
  const src = ac.createBufferSource(); src.buffer = buf;
  const dest = ac.createMediaStreamDestination(); src.connect(dest);
  const pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
  pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
  pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
  pc1.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
  const got = new Promise((r) => { pc2.ontrack = r; });
  const offer = await pc1.createOffer(); await pc1.setLocalDescription(offer); await pc2.setRemoteDescription(offer);
  const answer = await pc2.createAnswer(); await pc2.setLocalDescription(answer); await pc1.setRemoteDescription(answer);
  const ev = await got;
  const el = new Audio(); el.srcObject = ev.streams[0]; el.volume = 0; await el.play().catch(() => {});
  src.start();
  const out = []; const t0 = performance.now();
  while (performance.now() - t0 < f32.length / 48000 * 1000) {
    out.push([performance.now(), ev.receiver.getSynchronizationSources()]);
    await sleep(50);
  }
  pc1.close(); pc2.close(); await ac.close();
  return out.map(([t, srcs]) => [t, srcs.map((x) => ({ timestamp: x.timestamp, audioLevel: x.audioLevel }))]);
};
window.ready = true;
`;
const bundle = await build({ stdin: { contents: ENTRY, resolveDir: chainDir, loader: 'ts', sourcefile: 'loudness-entry.ts' }, bundle: true, format: 'iife', write: false, logLevel: 'warning', plugins: [viteShims] });
const js = bundle.outputFiles[0].text;

const mics = new Map();
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/bundle.js')) { res.setHeader('content-type', 'text/javascript'); res.end(js); }
  else if (req.url.startsWith('/mic/')) { const b = mics.get(req.url.slice(5)); res.setHeader('content-type', 'application/octet-stream'); res.end(Buffer.from(b.buffer, b.byteOffset, b.byteLength)); }
  else { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><script src="bundle.js"></script>'); }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

const SECONDS = 32;
const talkers = [
  ['quiet  (-40 dBFS)', 'slt', -40],
  ['normal (-26 dBFS)', 'rms', -26],
  ['loud   (-12 dBFS)', 'kal', -12],
  ['hot    (-6 dBFS, clipped)', 'awb', -6],
];
const rows = []; const results = { agcOn: [], agcOff: [], rtp: [] };
const browser = await chromium.launch({ executablePath: findChrome(), args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.ready === true);
  console.log(`chromium ${browser.version()}`);
  const runOne = async (label, voice, db, agc, id) => {
    const mic = scaleToActive(repeatTo(speech(voice), SECONDS), db);
    mics.set(id, mic);
    const b64 = await page.evaluate((c) => window.run(c), { id, settings: { volumeNormalization: agc } });
    const bin = Buffer.from(b64, 'base64');
    const wire = new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length));
    // The processed track starts a moment after the mic: measure from where speech is.
    const n = wire.length; const first = [Math.round(SR * 1), Math.round(SR * 11)]; const last = [n - SR * 11, n - SR * 1];
    const heard = listen(wire);
    return {
      label, agc,
      first10: activeLevelDb(wire, ...first), steady: activeLevelDb(wire, ...last), peak: peakDb(wire, SR, n),
      clipped: wire.reduce((c, v) => c + (Math.abs(v) >= 0.9999 ? 1 : 0), 0),
      heardSteady: activeLevelDb(heard.y, ...last), rxGainDb: heard.gainDb,
    };
  };
  // The listener's measurement on a REAL RTCPeerConnection: speech with no sender AGC at all.
  for (const [label, voice, db] of [['quiet  (-40 dBFS)', 'slt', -40], ['loud   (-12 dBFS)', 'kal', -12]]) {
    const id = `rtp-${voice}`;
    mics.set(id, scaleToActive(repeatTo(speech(voice), 24), db));
    const samples = await page.evaluate((c) => window.rtpRun(c), { id });
    const lv = new ReceiveLeveler(); let prev = samples[0][0]; let readings = 0; let gain = 0; const levels = [];
    for (const [t, srcs] of samples) {
      const dt = (t - prev) / 1000; prev = t;
      const level = pickRtpLevel(srcs, t);
      if (level === undefined) continue;
      readings++; levels.push(20 * Math.log10(Math.max(level, 1e-9)));
      gain = lv.pushLinear(level, dt);
    }
    // what the wire reading says the talker's loud frames are vs the truth we scaled to
    const loud = levels.filter((v) => v > -60).sort((a, b) => a - b); const p90 = loud[Math.floor(loud.length * 0.9)];
    results.rtp.push({ label, db, readings, polls: samples.length, gain, p90, est: lv.levelDb });
  }
  // Warm-up, discarded: the first processor init compiles the 4.8 MB RNNoise module.
  await runOne('warm', 'rms', -26, true, 'warm');
  for (const agc of [true, false]) {
    for (const [label, voice, db] of talkers) {
      const r = await runOne(label, voice, db, agc, `${agc ? 'on' : 'off'}-${voice}`);
      (agc ? results.agcOn : results.agcOff).push(r);
      rows.push({ talker: label, 'AGC': agc ? 'on' : 'OFF', '0-10s': r.first10.toFixed(1), 'steady': r.steady.toFixed(1), 'peak': r.peak.toFixed(1), clipped: r.clipped, 'rx gain': r.rxGainDb.toFixed(1), 'heard steady': r.heardSteady.toFixed(1) });
    }
  }
} finally { await browser.close(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
console.table(rows);
console.table(results.rtp.map((r) => ({ talker: r.label, 'RTP readings': `${r.readings}/${r.polls} polls`, 'p90 reading dB': r.p90?.toFixed(1), 'est. active level dB': r.est.toFixed(1), 'leveler gain dB': r.gain.toFixed(1) })));

const checks = []; const check = (ok, what) => checks.push([ok, what]);
const spread = (arr, k) => Math.max(...arr.map((r) => r[k])) - Math.min(...arr.map((r) => r[k]));
const on = results.agcOn, off = results.agcOff;
check(spread(on, 'steady') <= 3, `AGC on: steady-state active levels of a -40 / -26 / -12 / -6 dBFS talker are within 3 dB (spread ${spread(on, 'steady').toFixed(1)} dB)`);
check(spread(on, 'first10') <= 4, `AGC on: already within 4 dB over the first 10 s (spread ${spread(on, 'first10').toFixed(1)} dB)`);
check(on.every((r) => Math.abs(r.steady - -20) <= 3), `AGC on: every talker lands within 3 dB of the -20 dBFS target (${on.map((r) => r.steady.toFixed(1)).join(', ')})`);
check(on.every((r) => r.peak <= -0.5 && r.clipped === 0), `AGC on: no clipping, peaks <= -0.5 dBFS (${on.map((r) => r.peak.toFixed(1)).join(', ')})`);
check(spread(off, 'steady') >= 15, `CONTROL, AGC off: the same talkers come out far apart (spread ${spread(off, 'steady').toFixed(1)} dB) — the levelling above is the AGC's doing`);
check(spread(on, 'heardSteady') <= spread(on, 'steady') + 1 && on.every((r) => Math.abs(r.rxGainDb) <= 1), `listener leveler leaves already-levelled talkers alone (|gain| <= 1 dB: ${on.map((r) => r.rxGainDb.toFixed(1)).join(', ')})`);
check(spread(off, 'heardSteady') < spread(off, 'steady') - 5, `listener leveler pulls UN-levelled talkers together (${spread(off, 'steady').toFixed(1)} -> ${spread(off, 'heardSteady').toFixed(1)} dB spread)`);
const rq = results.rtp[0], rl = results.rtp[1];
check(rq.readings > rq.polls * 0.6 && rl.readings > rl.polls * 0.6, `RTP audio-level extension reaches the receiver on a real RTCPeerConnection (${rq.readings}/${rq.polls}, ${rl.readings}/${rl.polls} polls had a fresh reading)`);
check(rq.gain >= 4 && rq.gain <= 6.01, `quiet talker with no sender AGC: the leveler boosts, capped at +6 dB (gain ${rq.gain.toFixed(1)} dB, estimate ${rq.est.toFixed(1)} dBFS)`);
check(rl.gain <= -3 && rl.gain >= -9.01, `loud talker with no sender AGC: the leveler cuts (gain ${rl.gain.toFixed(1)} dB, estimate ${rl.est.toFixed(1)} dBFS)`);
let failed = 0;
for (const [ok, what] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failed++; }
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
