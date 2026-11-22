// Bench page (plain script, injected by main.cjs after load; the REAL preload provides window.audioEngine).
// window.__assets = { worklet: <text of src/audio/clAudioWorklet.js>, wasmB64: <cl_audio.wasm> } is set by main.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const b64 = (s) => { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; };
  const blobUrl = (text) => URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));

  const RECORDER = `
class Rec extends AudioWorkletProcessor {
  constructor(o) { super(); const n = o.processorOptions.n; this.n = n; this.a = new Float32Array(n); this.b = new Float32Array(n); this.i = 0; this.done = false; this.f0 = -1; }
  process(inputs) {
    if (this.done) return true;
    const a = inputs[0] && inputs[0][0], b = inputs[1] && inputs[1][0];
    if (this.f0 < 0) this.f0 = currentFrame;
    for (let k = 0; k < 128 && this.i < this.n; k++, this.i++) { this.a[this.i] = a ? a[k] : 0; this.b[this.i] = b ? b[k] : 0; }
    if (this.i >= this.n) { this.done = true; this.port.postMessage({ a: this.a, b: this.b, f0: this.f0 }); }
    return true;
  }
}
registerProcessor('bench-rec', Rec);`;

  // synthetic voiced speech: pitched pulse train through three formant resonators with a syllable envelope (the crate's test voice)
  function speech(seconds, activeDb, seed) {
    const SR = 48000;
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

  async function run(o) {
    const log = [];
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await ctx.resume();
    await ctx.audioWorklet.addModule(blobUrl(window.__assets.worklet));
    const wavRaw = o.wavFile ? new Uint8Array(b64(window.__wav)) : null;
    const recN = o.wavFile ? Math.floor(((wavRaw.length - 44) / 2 + 48000 * 6) / 128) * 128 : o.recordSeconds ? Math.floor(o.recordSeconds * 48000 / 128) * 128 : 0;
    if (recN) await ctx.audioWorklet.addModule(blobUrl(RECORDER));
    const t = { openMs: null, ready: null, failed: null, nativeFailed: null, nativeFailedAtS: null, stats: [], trace: [], hostStats: [] };
    const node = new AudioWorkletNode(ctx, 'cl-audio-worklet', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { wasmBytes: b64(window.__assets.wasmB64), settings: o.settings || { noise: 1, autoGain: true, manualGainDb: 0, originalSound: false }, native: !!o.native, nativeJitterFrames: o.jitter, nativeTrace: true, nativeNoise: o.hostNoise ?? 2, nativeNoFail: !!o.noFail },
    });
    const t0 = performance.now();
    node.port.onmessage = ({ data }) => {
      if (!data) return;
      if (data.type === 'ready') t.ready = data;
      else if (data.type === 'failed') t.failed = data;
      else if (data.type === 'nativePaused') (t.paused = t.paused || []).push({ at: (performance.now() - t0) / 1000, ...data });
      else if (data.type === 'nativeResumed') (t.resumed = t.resumed || []).push({ at: (performance.now() - t0) / 1000, ...data });
      else if (data.type === 'nativeFailed') { t.nativeFailed = data; t.nativeFailedAtS = (performance.now() - t0) / 1000; }
      else if (data.type === 'stats') { const n = data.native; t.stats.push({ at: (performance.now() - t0) / 1000, underrun: data.underrun, overflow: data.overflow, frames: data.frames, resets: data.resets, eff: data.effectiveNoise, reply: !!data.reply, native: n }); }
      else if (data.type === 'nativeTrace') t.trace.push(data.data);
    };
    let buf;
    if (o.wavFile) {   // 16-bit mono 48 kHz PCM WAV (44-byte header) from main, base64
      const raw = wavRaw; const dv = new DataView(raw.buffer, 44);
      const n = (raw.length - 44) >> 1; buf = ctx.createBuffer(1, n, 48000); const ch = buf.getChannelData(0);
      for (let i = 0; i < n; i++) ch[i] = dv.getInt16(i * 2, true) / 32768;
      window.__wav = null;
    } else { buf = ctx.createBuffer(1, 48000 * 20, 48000); buf.getChannelData(0).set(speech(20, o.activeDb ?? -30, 7)); }
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = !o.wavFile;
    let rec = null, recDone = null;
    if (recN) {
      rec = new AudioWorkletNode(ctx, 'bench-rec', { numberOfInputs: 2, numberOfOutputs: 0, processorOptions: { n: recN } });
      recDone = new Promise((res) => { rec.port.onmessage = ({ data }) => res(data); });
      src.connect(rec, 0, 0); node.connect(rec, 0, 1);
    }
    src.connect(node); node.connect(ctx.destination);
    let unsubExit = null;
    if (o.native) {
      const to = performance.now();
      const port = await window.__clNative.openNativePort(40000);
      t.openMs = performance.now() - to;
      if (port) { unsubExit = window.__clNative.onNativeEngineExit(() => node.port.postMessage({ type: 'nativeExit' })); node.port.postMessage({ type: 'nativePort', port }, [port]); }
      else { node.port.postMessage({ type: 'nativeAbort' }); t.openFailed = true; }
    }
    src.start();
    const startedAt = performance.now();
    // o.changes: [{ at: seconds, settings: {...} }] = what the app sends when the user changes a voice setting mid-call
    for (const c of (o.changes || [])) setTimeout(() => { node.port.postMessage({ type: 'setSettings', ...c.settings }); }, c.at * 1000);
    if (typeof o.onStart === 'function') o.onStart();
    window.__benchStarted = Date.now();
    const total = o.wavFile ? (buf.length / 48000 + 1.5) * 1000 : o.seconds * 1000;
    while (performance.now() - startedAt < total) await sleep(250);
    let recd = null;
    if (recDone) recd = await Promise.race([recDone, sleep(5000).then(() => null)]);
    node.port.postMessage({ type: 'getStats' });
    await sleep(300);
    if (unsubExit) unsubExit();
    src.stop(); node.disconnect(); await ctx.close();
    if (o.native) await window.__clNative.closeNativeEngine();
    const flat = []; for (const a of t.trace) for (let i = 0; i < a.length; i++) flat.push(a[i]);
    const out = { ready: t.ready, failed: t.failed, nativeFailed: t.nativeFailed, nativeFailedAtS: t.nativeFailedAtS, openMs: t.openMs, openFailed: !!t.openFailed,
      stats: t.stats, paused: t.paused || [], resumed: t.resumed || [], trace: flat, ctxBase: ctx.baseLatency, ctxOut: ctx.outputLatency };
    if (recd && o.wavFile) { const u = new Uint8Array(recd.b.buffer); let bin = ''; for (let i = 0; i < u.length; i += 8192) bin += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); out.recB64 = btoa(bin); }
    else if (recd) { out.rec = { f0: recd.f0, a: Array.from(recd.a), b: Array.from(recd.b) }; }
    out.src = o.recordSeconds ? Array.from(buf.getChannelData(0).subarray(0, 48000 * 20)).length : 0;
    return out;
  }

  // Feed a WAV through the REAL host over the real port, closed loop (4 frames in flight), no AudioContext, not paced: checks the host + addon + protocol
  async function runHostOnly(o) {
    const raw = new Uint8Array(b64(window.__wav)); window.__wav = null;
    const dv = new DataView(raw.buffer, 44), n = (raw.length - 44) >> 1, x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = dv.getInt16(i * 2, true) / 32768;
    const port = await window.__clNative.openNativePort(40000);
    if (!port) return { error: 'no port' };
    const frames = Math.floor(n / 480), out = new Float32Array(n);
    let got = 0, sent = 0, bad = 0, ack = null, ackP = new Promise((r) => { ack = r; });
    let finish; const done = new Promise((r) => { finish = r; });
    const send = () => { const k = sent++; port.postMessage({ t: 'f', seq: k, ts: Date.now(), pcm: x.slice(k * 480, k * 480 + 480) }); };
    port.onmessage = ({ data: d }) => { if (d.t === 'ack') { console.log('[bench] ack'); ack(); } else if (d.t !== 'o') console.log('[bench] msg ' + d.t); else if (d.t === 'o') {  if (d.st !== 0) bad++; out.set(d.pcm, d.seq * 480); got++; lastProgress = performance.now(); if (got >= frames) finish(); else if (sent < frames) send(); } };
    port.postMessage({ t: 's', id: 1, noise: o.hostNoise ?? 2, autoGain: true, manualGainDb: 0, originalSound: false });
    await ackP;
    // a frame the host drops as stale (the box is busy) never answers: keep the pump moving and count it
    let lastProgress = performance.now(), lost = 0;
    const pump = setInterval(() => { if (performance.now() - lastProgress > 250) { lastProgress = performance.now(); lost++; if (sent < frames) send(); else if (got + lost >= frames) finish(); } }, 50);
    const t0 = performance.now(); for (let i = 0; i < 2; i++) send(); await done; clearInterval(pump);
    const u = new Uint8Array(out.buffer); let bin = ''; for (let i = 0; i < u.length; i += 8192) bin += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
    port.postMessage({ t: 'bye' }); await window.__clNative.closeNativeEngine();
    return { recB64: btoa(bin), frames, bad, lost, seconds: (performance.now() - t0) / 1000 };
  }
  // How long the REAL host takes to acknowledge each settings message (o.sequence: [{noise, autoGain, manualGainDb}]), with frames flowing
  // at real-time pace meanwhile. This is the wait the worklet's settings timeout has to cover.
  async function ackTimes(o) {
    const port = await window.__clNative.openNativePort(40000);
    if (!port) return { error: 'no port' };
    const waits = new Map(); const out = []; let seq = 0, replies = 0;
    port.onmessage = ({ data: d }) => { if (d.t === 'ack') { const w = waits.get(d.id); if (w) w(d); } else if (d.t === 'o') replies++; };
    const x = speech(1, -30, 3);
    const pump = setInterval(() => { const k = seq++; port.postMessage({ t: 'f', seq: k, ts: Date.now(), pcm: x.slice((k % 100) * 480, (k % 100) * 480 + 480) }); }, 10);
    let id = 0;
    for (const st of o.sequence) {
      id++;
      const t0 = performance.now();
      const ack = new Promise((r) => waits.set(id, r));
      port.postMessage({ t: 's', id, noise: st.noise ?? 2, autoGain: st.autoGain !== false, manualGainDb: st.manualGainDb || 0, originalSound: false });
      const d = await Promise.race([ack, sleep(60000).then(() => null)]);
      out.push({ ...st, ackMs: d ? Math.round(performance.now() - t0) : null, ok: d ? d.ok : null, effectiveNoise: d ? d.effectiveNoise : null });
      await sleep(o.gapMs || 1500);
    }
    clearInterval(pump);
    port.postMessage({ t: 'bye' }); await window.__clNative.closeNativeEngine();
    return { acks: out, framesSent: seq, replies };
  }
  window.__bench = { runHostOnly, ackTimes, run, available: () => window.__clNative.nativeEngineAvailable(), speech };
})();
