// CPU cost of the native engine, paced like a call (one 10 ms frame every 10 ms), in plain Node (the utility process runs the same addon).
//   node scripts/audio-native-bench/cpu.cjs <ll|std> [seconds=60]
const path = require('node:path');
const fs = require('node:fs');
const addon = require(path.join(__dirname, '../../build/Release/cl_audio_node.node'));
const which = process.argv[2] || 'll';
const seconds = Number(process.argv[3] || 60);
const e = new addon.ClAudioNode(48000);
if (which === 'll') { if (!e.setStrongModel(fs.readFileSync(path.join(__dirname, '../../resources/dfn/DeepFilterNet3_ll_onnx.tar.gz')))) throw new Error('model rejected'); }
e.setSettings({ noise: which === 'light' ? 1 : 2, autoGain: true, manualGainDb: 0, originalSound: false, idleSkip: true });
const stats = e.stats(false);
console.log(`profile ${which}: effectiveNoise=${stats.effectiveNoise} delay=${e.delaySamples()} samples`);
// synthetic voiced speech (pitched pulses through three formants, syllable envelope, -30 dBFS active): the model's cost depends on the input
// (DeepFilterNet skips stages on frames it judges noise-only), so a steady tone under-reports; this is the crate's test voice
const SR = 48000;
function speech(seconds, activeDb, seed) {
  const res = [[700, 90], [1100, 110], [2400, 140]].map(([fc, bw]) => { const r = Math.exp(-Math.PI * bw / SR), th = 2 * Math.PI * fc / SR; return { b0: 1 - r, a1: -2 * r * Math.cos(th), a2: r * r, z1: 0, z2: 0 }; });
  let phase = 0, tilt = 0, s = seed;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 2147483648) - 1; };
  const n = Math.floor(SR * seconds), y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR, pos = t % 0.24, env = (Math.floor(t / 0.24) % 7 === 6 || pos > 0.21) ? 0 : Math.min(1, pos / 0.05, (0.21 - pos) / 0.05);
    phase += (125 + 20 * Math.sin(2 * Math.PI * 0.7 * t)) / SR;
    let e = 0; if (phase >= 1) { phase -= 1; e = 1; }
    e += 0.04 * rnd(); tilt += 0.35 * (e - tilt);
    let v = tilt;
    for (const b of res) { const o = b.b0 * v + b.z1; b.z1 = -b.a1 * o + b.z2; b.z2 = -b.a2 * o; v = o; }
    y[i] = v * env + 0.0003 * rnd();
  }
  let peak = 0; for (const v of y) peak = Math.max(peak, Math.abs(v));
  let s2 = 0, c = 0; for (const v of y) if (Math.abs(v) > 0.02 * peak) { s2 += v * v; c++; }
  const k = Math.pow(10, activeDb / 20) / Math.sqrt(s2 / c);
  for (let i = 0; i < n; i++) y[i] *= k;
  return y;
}
const x = speech(20, -30, 7);
const frame = new Float32Array(480);
const gen = (k) => { const o = (k * 480) % (x.length - 480); frame.set(x.subarray(o, o + 480)); };
for (let k = 0; k < 100; k++) { gen(k); e.process480(frame); } // warm
const durs = [];
const t0 = process.hrtime.bigint(), c0 = process.cpuUsage();
let next = Number(t0) / 1e6;
const end = next + seconds * 1000;
let k = 0;
const spin = () => {
  const now = Number(process.hrtime.bigint()) / 1e6;
  if (now >= end) {
    const cpu = process.cpuUsage(c0), wall = (now - Number(t0) / 1e6) / 1000;
    durs.sort((a, b) => a - b);
    const p = (q) => durs[Math.min(durs.length - 1, Math.floor(q * durs.length))];
    console.log(`${which}: ${durs.length} frames in ${wall.toFixed(1)} s; CPU ${(((cpu.user + cpu.system) / 1e6) / wall * 100).toFixed(1)} % of one core (user ${(cpu.user / 1e6 / wall * 100).toFixed(1)} + sys ${(cpu.system / 1e6 / wall * 100).toFixed(1)}); per-frame ms median ${p(0.5).toFixed(2)} p99 ${p(0.99).toFixed(2)} max ${durs.at(-1).toFixed(2)}; RSS ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB; watchdogFrames ${e.stats(false).watchdogFrames}`);
    return;
  }
  if (now >= next) { gen(k); const s = process.hrtime.bigint(); e.process480(frame); durs.push(Number(process.hrtime.bigint() - s) / 1e6); next += 10; k++; }
  setImmediate(spin === null ? null : () => setTimeout(spin, Math.max(0, Math.min(2, next - now - 1))));
};
spin();
