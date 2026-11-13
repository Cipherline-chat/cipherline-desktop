// Audio checks that need no app code: FFT of what the SHARER's desktop is playing (positive control: the call's 440 Hz and the
// tone app's 1000 Hz really are on the speakers), captured from the PipeWire sink's monitor inside the sharer container.
import { spawn } from 'node:child_process';

const RATE = 48000, N = 65536;
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = i + k + len / 2; const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } }
  }
}
/** dB (amplitude) of x near `hz` and the median bin level as a floor. */
export function toneLevels(x, hzList = [440, 1000]) {
  const re = new Float64Array(N), im = new Float64Array(N), start = Math.max(0, x.length - N); let ws = 0;
  for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); re[i] = (x[start + i] || 0) * w; ws += w; }
  fft(re, im);
  const mag = (k) => (2 * Math.hypot(re[k], im[k])) / ws, db = (v) => (v > 1e-9 ? +(20 * Math.log10(v)).toFixed(1) : -180);
  const out = {};
  for (const hz of hzList) { const k0 = Math.round((hz * N) / RATE); let b = 0; for (let k = k0 - 3; k <= k0 + 3; k++) b = Math.max(b, mag(k)); out[`db${hz}`] = db(b); }
  const bins = []; for (let k = Math.round((100 * N) / RATE); k < Math.round((8000 * N) / RATE); k++) bins.push(mag(k)); bins.sort((a, b) => a - b);
  out.floorDb = db(bins[bins.length >> 1]);
  return out;
}

/** Record `seconds` of the sharer's speakers (the null sink's monitor) and return the 440 / 1000 Hz levels. */
export function desktopAudio(container = 'cle2e-sharer', seconds = 3) {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['exec', '-u', 'tester', '-e', 'XDG_RUNTIME_DIR=/tmp/xdg-run', container, 'timeout', String(seconds), 'parec', '-d', 'cipherline-test-sink.monitor', '--format=s16le', '--rate=48000', '--channels=1', '--raw']);
    const chunks = []; p.stdout.on('data', (d) => chunks.push(d)); p.stderr.on('data', () => {});
    p.on('close', () => {
      const b = Buffer.concat(chunks); if (b.length < N * 2) return reject(new Error(`only ${b.length} bytes recorded`));
      const x = new Float64Array(b.length >> 1); for (let i = 0; i < x.length; i++) x[i] = b.readInt16LE(i * 2) / 32768;
      resolve(toneLevels(x));
    });
  });
}
