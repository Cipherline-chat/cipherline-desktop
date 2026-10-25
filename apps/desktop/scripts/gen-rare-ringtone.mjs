// Synthesises public/sounds/call_sound_rare.wav: the rare alternate ringtone
// (about 1 incoming call in 1,000; see utils/rareRingtone.ts).
//
//   node scripts/gen-rare-ringtone.mjs [out.wav]
//
// An original little music-box figure (C major pentatonic, two bars, a held
// last note) built from plain sine partials with a soft decay and a light
// feedback echo. Nothing is sampled and no existing melody is used, so there is
// no third-party audio to license. Deterministic: the same script always
// writes the same bytes. Mono, 44.1 kHz, 16-bit, 3.6 s like the normal ring,
// and it ends in silence so the loop restarts cleanly.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RATE = 44100;
const SECONDS = 3.6;
const N = Math.round(RATE * SECONDS);
const out = new Float64Array(N);

const hz = (semitonesFromA4) => 440 * 2 ** (semitonesFromA4 / 12);
// C major pentatonic around the C5 octave: C5 D5 E5 G5 A5 (semitones from A4).
const C5 = 3, D5 = 5, E5 = 7, G5 = 10, A5 = 12, C6 = 15;
// [start seconds, pitch, length seconds, gain]
const NOTES = [
  [0.00, E5, 0.9, 0.8], [0.22, G5, 0.9, 0.8], [0.44, A5, 0.9, 0.85], [0.66, G5, 0.9, 0.75],
  [1.10, E5, 0.9, 0.7], [1.32, D5, 0.9, 0.7], [1.54, C5, 1.4, 0.8],
  [2.10, E5, 0.9, 0.7], [2.32, G5, 0.9, 0.75], [2.54, C6, 1.0, 0.8],
];
// Music-box-ish timbre: a fundamental plus bright partials that die faster.
const PARTIALS = [[1, 1.0, 3.2], [2, 0.38, 5.5], [3, 0.16, 8.0], [4.01, 0.07, 11.0]];

for (const [t0, pitch, len, gain] of NOTES) {
  const f = hz(pitch);
  const start = Math.round(t0 * RATE);
  const count = Math.round(len * RATE);
  for (let i = 0; i < count && start + i < N; i++) {
    const t = i / RATE;
    const attack = Math.min(1, t / 0.004);
    let s = 0;
    for (const [mult, amp, decay] of PARTIALS) s += amp * Math.exp(-decay * t) * Math.sin(2 * Math.PI * f * mult * t);
    out[start + i] += s * attack * gain * 0.22;
  }
}

// Light feedback echo (two taps) for a little room.
const echo = new Float64Array(N);
const taps = [[Math.round(0.18 * RATE), 0.32], [Math.round(0.36 * RATE), 0.16]];
for (let i = 0; i < N; i++) {
  let v = out[i];
  for (const [d, g] of taps) if (i >= d) v += out[i - d] * g;
  echo[i] = v;
}

// Fade the last 150 ms so the loop restarts from silence, normalise to -7 dBFS (the same loudness as the normal ring).
const fade = Math.round(0.15 * RATE);
for (let i = 0; i < fade; i++) echo[N - 1 - i] *= i / fade;
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(echo[i]));
const scale = (10 ** (-7 / 20)) / peak;

const data = Buffer.alloc(N * 2);
for (let i = 0; i < N; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(echo[i] * scale * 32767))), i * 2);
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(data.length, 40);

const target = process.argv[2]
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sounds', 'call_sound_rare.wav');
writeFileSync(target, Buffer.concat([header, data]));
console.log(`wrote ${target} (${N} samples, peak scale ${scale.toFixed(3)})`);
