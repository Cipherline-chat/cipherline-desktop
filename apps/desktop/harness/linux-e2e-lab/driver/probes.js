// Injected into the REAL renderer (before the call starts) by driver/probes.mjs. Test-side observation only: it wraps the
// RTCPeerConnection constructor to keep a handle on every peer connection the app (livekit-client) creates, then reads the
// standard WebRTC stats and the received audio from those handles. Nothing here changes what the app does.
(() => {
  const prev = window.__lab; // re-injection (a newer probe script) keeps the peer connections already collected
  const lab = (window.__lab = { pcs: prev ? prev.pcs : [], clipboard: prev ? prev.clipboard : [] });
  if (!prev) {
    const O = window.RTCPeerConnection;
    function P(...a) { const pc = new O(...a); lab.pcs.push(pc); return pc; }
    P.prototype = O.prototype; Object.setPrototypeOf(P, O);
    window.RTCPeerConnection = P;
  }
  // the app's "Copy call log" button writes the call event log (utils/callEventLog.ts) to the clipboard: keep a copy
  const w = navigator.clipboard && navigator.clipboard.writeText && navigator.clipboard.writeText.bind(navigator.clipboard);
  if (w) navigator.clipboard.writeText = (t) => { lab.clipboard.push(String(t)); return w(t).catch(() => {}); };

  const summarize = async () => {
    const out = { out: [], in: [], audioIn: [], audioOut: [] };
    for (const pc of lab.pcs) {
      if (pc.connectionState === 'closed') continue;
      let rep; try { rep = await Promise.race([pc.getStats(), new Promise((_, rj) => setTimeout(() => rj(new Error('getStats timeout')), 2500))]); } catch { continue; }
      const byId = {}; rep.forEach((r) => { byId[r.id] = r; });
      rep.forEach((r) => {
        const codec = r.codecId && byId[r.codecId] ? byId[r.codecId].mimeType : undefined;
        if (r.type === 'outbound-rtp' && r.kind === 'video') out.out.push({ ssrc: r.ssrc, rid: r.rid, contentType: r.contentType, w: r.frameWidth, h: r.frameHeight, fps: r.framesPerSecond, framesEncoded: r.framesEncoded, framesSent: r.framesSent, enc: r.encoderImplementation, hw: r.powerEfficientEncoder, limit: r.qualityLimitationReason, codec, bytes: r.bytesSent, active: r.active, t: r.timestamp });
        if (r.type === 'inbound-rtp' && r.kind === 'video') out.in.push({ ssrc: r.ssrc, w: r.frameWidth, h: r.frameHeight, fps: r.framesPerSecond, framesDecoded: r.framesDecoded, framesReceived: r.framesReceived, dec: r.decoderImplementation, codec, freezes: r.freezeCount, bytes: r.bytesReceived, t: r.timestamp });
        if (r.type === 'inbound-rtp' && r.kind === 'audio') out.audioIn.push({ ssrc: r.ssrc, level: r.audioLevel, energy: r.totalAudioEnergy, samples: r.totalSamplesReceived, bytes: r.bytesReceived, t: r.timestamp });
        if (r.type === 'outbound-rtp' && r.kind === 'audio') out.audioOut.push({ ssrc: r.ssrc, bytes: r.bytesSent, t: r.timestamp });
      });
    }
    return out;
  };
  lab.stats = summarize;
  /** Average rates over ms: for each video stream, decoded/encoded frames per second computed from counter deltas. */
  lab.rates = async (ms) => {
    const a = await summarize(); await new Promise((r) => setTimeout(r, ms)); const b = await summarize();
    const rate = (x, y, key) => { const dt = (y.t - x.t) / 1000; return dt > 0 && Number.isFinite(y[key]) && Number.isFinite(x[key]) ? +((y[key] - x[key]) / dt).toFixed(1) : null; };
    return {
      out: b.out.map((y) => { const x = a.out.find((q) => q.ssrc === y.ssrc); return { ...y, encFps: x ? rate(x, y, 'framesEncoded') : null, kbps: x ? Math.round(rate(x, y, 'bytes') * 8 / 1000) : null }; }),
      in: b.in.map((y) => { const x = a.in.find((q) => q.ssrc === y.ssrc); return { ...y, decFps: x ? rate(x, y, 'framesDecoded') : null, kbps: x ? Math.round(rate(x, y, 'bytes') * 8 / 1000) : null }; }),
      audioIn: b.audioIn,
    };
  };

  /** FFT of every received audio track (post-decrypt, what the app would play): peak frequency + dB at 440 / 1000 Hz vs the median floor. */
  // Preferred path: MediaStreamTrackProcessor hands over the decoded AudioData frames of the track itself (no WebAudio graph, which
  // Chromium does not feed from a remote track unless it is also playing). Hann-windowed FFT of the last 65536 samples, in the page.
  lab.fft = async (ms = 3000) => {
    if (typeof MediaStreamTrackProcessor === 'undefined') return lab.fftAnalyser(ms);
    const N = 65536, RATE = 48000;
    const fftIn = (re, im) => {
      const n = re.length;
      for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = i + k + len / 2; const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } }
      }
    };
    const jobs = [];
    for (const pc of lab.pcs) for (const rx of pc.getReceivers()) {
      if (!rx.track || rx.track.kind !== 'audio' || rx.track.readyState !== 'live') continue;
      const clone = rx.track.clone();
      const rd = new MediaStreamTrackProcessor({ track: clone }).readable.getReader();
      const buf = new Float32Array(N); let filled = 0, frames = 0, rate = RATE;
      const t0 = Date.now();
      const pump = (async () => {
        while (Date.now() - t0 < ms) {
          const r = await Promise.race([rd.read(), new Promise((res) => setTimeout(() => res({ timeout: true }), 400))]);
          if (r.timeout || r.done) { if (r.done) break; continue; }
          const d = r.value; frames++; rate = d.sampleRate;
          const tmp = new Float32Array(d.numberOfFrames); d.copyTo(tmp, { planeIndex: 0, format: 'f32-planar' }); d.close();
          for (let i = 0; i < tmp.length; i++) { buf[filled % N] = tmp[i]; filled++; }
        }
        try { rd.cancel(); } catch { /* done */ } clone.stop();
      })();
      jobs.push({ id: rx.track.id, pump, get: () => ({ buf, filled, frames, rate }) });
    }
    await Promise.race([Promise.all(jobs.map((j) => j.pump)), new Promise((r) => setTimeout(r, ms + 3000))]);
    return jobs.map((j) => {
      const { buf, filled, frames, rate } = j.get();
      if (filled < N) return { track: j.id.slice(0, 8), peakHz: 0, peakDb: -200, db440: -200, db1000: -200, floorDb: -200, frames, samples: filled, note: 'fewer than 65536 samples arrived' };
      const re = new Float64Array(N), im = new Float64Array(N); let ws = 0;
      for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); re[i] = buf[(filled + i) % N] * w; ws += w; }
      fftIn(re, im);
      const mag = (k) => (2 * Math.hypot(re[k], im[k])) / ws, db = (v) => (v > 1e-9 ? +(20 * Math.log10(v)).toFixed(1) : -180);
      const near = (hz) => { const k0 = Math.round((hz * N) / rate); let m = 0; for (let k = k0 - 3; k <= k0 + 3; k++) m = Math.max(m, mag(k)); return db(m); };
      const bins = []; for (let k = Math.round((100 * N) / rate); k < Math.round((8000 * N) / rate); k++) bins.push(mag(k)); bins.sort((a, b) => a - b);
      let pk = Math.round((100 * N) / rate); for (let k = pk; k < Math.round((8000 * N) / rate); k++) if (mag(k) > mag(pk)) pk = k;
      return { track: j.id.slice(0, 8), peakHz: Math.round((pk * rate) / N), peakDb: db(mag(pk)), db440: near(440), db1000: near(1000), floorDb: db(bins[bins.length >> 1]), frames, samples: filled };
    });
  };
  lab.fftAnalyser = async (ms = 3000) => {
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume().catch(() => {});
    const taps = [];
    for (const pc of lab.pcs) for (const rx of pc.getReceivers()) {
      if (!rx.track || rx.track.kind !== 'audio' || rx.track.readyState !== 'live') continue;
      const ms = new MediaStream([rx.track]);
      // Chromium only delivers a REMOTE WebRTC track's samples to WebAudio while the stream is also attached to a media element
      const el = new Audio(); el.srcObject = ms; el.muted = true; el.play().catch(() => {});
      const src = ctx.createMediaStreamSource(ms);
      const an = ctx.createAnalyser(); an.fftSize = 32768; an.smoothingTimeConstant = 0; src.connect(an);
      taps.push({ id: rx.track.id, an, acc: null, n: 0, el });
    }
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      for (const t of taps) { const f = new Float32Array(t.an.frequencyBinCount); t.an.getFloatFrequencyData(f); if (!t.acc) t.acc = new Float64Array(f.length).fill(-200); for (let i = 0; i < f.length; i++) t.acc[i] = Math.max(t.acc[i], f[i]); t.n++; }
      await new Promise((r) => setTimeout(r, 120));
    }
    for (const t of taps) { try { t.el.pause(); t.el.srcObject = null; } catch { /* gone */ } }
    const hz = (f) => Math.round((f * 32768) / 48000);
    const res = taps.map((t) => {
      const f = t.acc; const near = (c) => { let m = -200; for (let i = hz(c) - 3; i <= hz(c) + 3; i++) m = Math.max(m, f[i]); return +m.toFixed(1); };
      const sorted = Array.from(f.slice(hz(100), hz(8000))).sort((x, y) => x - y); const floor = +sorted[sorted.length >> 1].toFixed(1);
      let pk = 0; for (let i = hz(100); i < hz(8000); i++) if (f[i] > f[pk || i]) pk = i;
      return { track: t.id.slice(0, 8), peakHz: Math.round((pk * 48000) / 32768), peakDb: +f[pk].toFixed(1), db440: near(440), db1000: near(1000), floorDb: floor, frames: t.n };
    });
    ctx.close().catch(() => {});
    return res;
  };
})();
