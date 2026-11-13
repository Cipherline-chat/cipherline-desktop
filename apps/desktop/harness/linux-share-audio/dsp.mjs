// FFT helpers shared by capture-test.mjs (exclusion / include-by-pid) and app-test.mjs (per-application audio):
// the dBFS level of 440 / 1000 / 2000 Hz in what the addon captured (Hann window, +-3 bins, steady-state tail).
// ── FFT (iterative radix-2) ─────────────────────────────────────────────────
export function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len;
        const wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const a = i + k, b = i + k + len / 2;
                const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr; im[b] = im[a] - ti;
                re[a] += tr; im[a] += ti;
                const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
            }
        }
    }
}

export const RATE = 48000;
export const N = 65536;
/** dBFS amplitude of the sinusoid at `hz` in `x` (Hann window, peak search +-3 bins), plus the spectrum floor. */
export function spectrum(x) {
    const re = new Float64Array(N), im = new Float64Array(N);
    const start = Math.max(0, x.length - N);                // the steady-state tail
    let wsum = 0;
    for (let i = 0; i < N; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
        re[i] = (x[start + i] ?? 0) * w; wsum += w;
    }
    fft(re, im);
    const mag = new Float64Array(N / 2);
    for (let k = 0; k < N / 2; k++) mag[k] = (2 * Math.hypot(re[k], im[k])) / wsum;
    const db = (a) => (a > 1e-9 ? 20 * Math.log10(a) : -180);
    const at = (hz) => {
        const k0 = Math.round((hz * N) / RATE);
        let best = 0;
        for (let k = k0 - 3; k <= k0 + 3; k++) best = Math.max(best, mag[k]);
        return db(best);
    };
    const peaks = [];
    for (let k = 2; k < N / 2 - 2; k++) {
        if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1] && db(mag[k]) > -60) peaks.push({ hz: Math.round((k * RATE) / N), dbfs: +db(mag[k]).toFixed(1) });
    }
    peaks.sort((a, b) => b.dbfs - a.dbfs);
    return { at440: +at(440).toFixed(1), at1000: +at(1000).toFixed(1), at2000: +at(2000).toFixed(1), peaks: peaks.slice(0, 4), samples: x.length };
}

