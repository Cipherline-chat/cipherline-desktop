'use strict';
// Page-side half of the matrix (hidden window; main.js drives it with executeJavaScript(…, userGesture=true)).
// Everything here is plain web platform: getDisplayMedia, MediaStreamTrackProcessor, RTCPeerConnection, WebAudio.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let share = null;           // { stream, track }
let PW = 1280;              // pattern width, set by main (needed to scale the counter block positions)

function pct(a, p) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }

/** One copy of the frame's pixels -> {counter, fp}. counter = the 24-bit frame counter the pattern draws at its top-left;
 *  fp = a sparse luma fingerprint, so "did the picture change" is measurable even when the pattern window is not at the
 *  screen origin (GNOME/mutter places windows itself). */
let _buf = null;
async function sampleFrame(f) {
  // A thin strip (640 x 16 px at source scale) keeps the per-frame copy at ~30 KB: copying whole frames made the READER the
  // bottleneck (measured: ~20 fps ceiling), which would have looked like a capture limit.
  const s = f.displayWidth / PW;
  const rect = { x: 0, y: 0, width: Math.min(f.codedWidth, 2 * Math.ceil((640 * s) / 2)), height: Math.min(f.codedHeight, 2 * Math.ceil((16 * s) / 2)) };
  const need = f.allocationSize({ rect });
  if (!_buf || _buf.length < need) _buf = new Uint8Array(need);
  const layout = await f.copyTo(_buf, { rect });
  const fmt = f.format || '';
  const bpp = /^(BGR|RGB)/.test(fmt) ? 4 : 1;
  const p0 = layout[0];
  const lum = (x, y) => { const o = p0.offset + y * p0.stride + x * bpp; return bpp === 4 ? (_buf[o] + _buf[o + 1] + _buf[o + 2]) / 3 : _buf[o]; };
  let counter = 0;
  for (let i = 0; i < 24; i++) if (lum(Math.floor((i * 8 + 4) * s), Math.floor(4 * s)) > 128) counter |= 1 << i;
  let h = 2166136261;
  for (let gy = 9; gy < 16; gy += 2) for (let gx = 1; gx < 64; gx++) { h = Math.imul(h ^ lum(Math.floor(gx * 10 * s), Math.floor(gy * s)), 16777619); }
  return { counter, fp: h >>> 0 };
}

function makeDoc(w, h) {
  // A scrolling "document": light page, ragged lines of word-sized dark blocks, a few gradient "images". Realistic screen
  // content (sparse, high-contrast, structured) - NOT white noise, which is the encoder's worst case and not what a share is.
  const base = document.createElement('canvas'); base.width = w; base.height = h * 2;
  const bg = base.getContext('2d'); const tile = document.createElement('canvas'); tile.width = w; tile.height = h;
  const g = tile.getContext('2d'); g.fillStyle = '#f2f3f5'; g.fillRect(0, 0, w, h);
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let y = 16; y < h - 16; y += 22) {
    if (rnd() < 0.08) { const gr = g.createLinearGradient(0, y, w, y + 120); gr.addColorStop(0, `hsl(${(rnd() * 360) | 0} 70% 55%)`); gr.addColorStop(1, `hsl(${(rnd() * 360) | 0} 70% 35%)`); g.fillStyle = gr; g.fillRect(40, y, w - 80, 100); y += 100; continue; }
    let x = 40 + (rnd() < 0.3 ? 40 : 0);
    while (x < w - 120) { const ww = 18 + rnd() * 70; g.fillStyle = `rgb(${30 + rnd() * 80 | 0},${30 + rnd() * 80 | 0},${40 + rnd() * 90 | 0})`; g.fillRect(x, y, ww, 11); x += ww + 8; }
  }
  bg.drawImage(tile, 0, 0); bg.drawImage(tile, 0, h);
  return base;
}

window.T = {
  setPatternWidth(w) { PW = w; },

  // ── capture ───────────────────────────────────────────────────────────────
  async startShare(frameRate) {
    const t0 = performance.now();
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: frameRate } }, audio: false });
    const track = stream.getVideoTracks()[0];
    share = { stream, track };
    return { ms: Math.round(performance.now() - t0), label: track.label, settings: track.getSettings(), contentHint: track.contentHint };
  },
  stopShare() { if (share) { share.stream.getTracks().forEach((t) => t.stop()); share = null; } },

  // ── the one-prompt flow (flow-after): the capture is asked for ONCE, at the share's maximum, and never touched again ──
  /** getDisplayMedia exactly the way sharePlatformSupport.portalCaptureRequest asks on the portal. Keeps the stream as `share`. */
  async startShareMax(maxFps, maxW, maxH) {
    const t0 = performance.now();
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { max: maxW }, height: { max: maxH }, frameRate: { max: maxFps } }, audio: false });
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'motion';
    share = { stream, track };
    return { ms: Math.round(performance.now() - t0), label: track.label, settings: track.getSettings() };
  },
  trackState() { return share ? { state: share.track.readyState, muted: share.track.muted } : null; },
  /** Pull frames for `secs` WITHOUT touching the capture. A capture's own portal session starts lazily, when the first sink attaches. */
  async pull(secs) {
    if (!share) throw new Error('no share');
    const reader = new MediaStreamTrackProcessor({ track: share.track }).readable.getReader();
    const t0 = performance.now(); let frames = 0, size = null;
    while (performance.now() - t0 < secs * 1000) {
      const r = await Promise.race([reader.read(), sleep(4000).then(() => ({ timeout: true }))]);
      if (r.timeout || r.done) break;
      frames++; size = [r.value.displayWidth, r.value.displayHeight]; r.value.close();
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    return { frames, fps: +(frames / ((performance.now() - t0) / 1000)).toFixed(1), size, state: share.track.readyState, muted: share.track.muted, settings: share.track.getSettings() };
  },
  /** A second capture while the first keeps running (change of source): the old share must be untouched until this resolves. */
  async acquireNext(maxFps, maxW, maxH) {
    const old = share;
    const t0 = performance.now();
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { max: maxW }, height: { max: maxH }, frameRate: { max: maxFps } }, audio: false });
    const track = stream.getVideoTracks()[0];
    const oldStateWhenAcquired = old ? old.track.readyState : null;
    share = { stream, track };
    if (old) old.stream.getTracks().forEach((t) => t.stop());
    return { ms: Math.round(performance.now() - t0), oldTrackStateWhenNewArrived: oldStateWhenAcquired, label: track.label, settings: track.getSettings() };
  },
  /** An RTCPeerConnection loopback with the share track on its sender: the sender is where a portal share is retuned. */
  async senderOpen(mime, fmtp, bitrate, fps) {
    if (!share) throw new Error('no share');
    if (window.__snd) window.T.senderClose();
    const pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate).catch(() => {});
    pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate).catch(() => {});
    const tr = pc1.addTransceiver(share.track, { direction: 'sendonly' });
    const all = RTCRtpSender.getCapabilities('video').codecs;
    let want = all.filter((c) => c.mimeType.toLowerCase() === mime.toLowerCase() && (c.sdpFmtpLine || '') === (fmtp || ''));
    // no fmtp asked for H.264 = the constrained-baseline packetization-mode=1 flavour (what the hardware encoder takes)
    if (!want.length && /h264/i.test(mime) && !fmtp) want = all.filter((c) => /h264/i.test(c.mimeType) && /packetization-mode=1/.test(c.sdpFmtpLine || '') && /profile-level-id=42e01f/i.test(c.sdpFmtpLine || ''));
    if (want.length) tr.setCodecPreferences(want);
    const p = tr.sender.getParameters();
    p.encodings[0].maxBitrate = bitrate; p.encodings[0].maxFramerate = fps; p.degradationPreference = 'maintain-framerate';
    await tr.sender.setParameters(p);
    await pc1.setLocalDescription(await pc1.createOffer());
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription(await pc2.createAnswer());
    await pc1.setRemoteDescription(pc2.localDescription);
    window.__snd = { pc1, pc2, tr };
    return true;
  },
  /** The retune of a portal share: maxFramerate (and, for a size, scaleResolutionDownBy) on the sender; the capture is not touched. */
  async senderRetune(fps, scale) {
    const { tr } = window.__snd;
    const p = tr.sender.getParameters();
    p.encodings[0].maxFramerate = fps;
    if (scale) p.encodings[0].scaleResolutionDownBy = scale;
    await tr.sender.setParameters(p);
    return { maxFramerate: tr.sender.getParameters().encodings[0].maxFramerate, scale: tr.sender.getParameters().encodings[0].scaleResolutionDownBy ?? 1 };
  },
  /** Encoded frames/s and frame size over `secs`, from the sender's own stats. */
  async senderMeasure(secs) {
    const { pc1 } = window.__snd;
    const grab = async () => { let o = null; (await pc1.getStats()).forEach((v) => { if (v.type === 'outbound-rtp' && v.kind === 'video') o = v; }); return o; };
    await sleep(600);
    const a = await grab(); const t0 = performance.now();
    await sleep(secs * 1000);
    const b = await grab(); const dt = (performance.now() - t0) / 1000;
    if (!a || !b) return { error: 'no outbound-rtp' };
    return { encodedFps: +(((b.framesEncoded - a.framesEncoded) / dt)).toFixed(1), frameSize: [b.frameWidth, b.frameHeight], encoder: b.encoderImplementation || null, captureSettings: share.track.getSettings(), trackState: share.track.readyState };
  },
  senderClose() { if (window.__snd) { try { window.__snd.pc1.close(); window.__snd.pc2.close(); } catch { /* gone */ } window.__snd = null; } },
  /** A republish on the capture that is already running (codec drift, encoder stall, hardware-encoder rule): clone it, stop the old track, send the clone. */
  async cloneAndRepublish(mime, fmtp, bitrate, fps) {
    if (!share) throw new Error('no share');
    const clone = share.track.clone();
    window.T.senderClose();
    share.track.stop();
    share = { stream: new MediaStream([clone]), track: clone };
    await window.T.senderOpen(mime, fmtp, bitrate, fps);
    return { cloneState: clone.readyState, settings: clone.getSettings() };
  },

  // ── capture-rate experiments (stage `rate`, app/main.js) ──────────────────────────────────────────────────────────
  /** getDisplayMedia with EXACTLY these video constraints (the capture the portal gets), kept as `share`. */
  async rateOpen(constraints) {
    const t0 = performance.now();
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: constraints, audio: false });
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'motion';
    share = { stream, track };
    return { ms: Math.round(performance.now() - t0), label: track.label, settings: track.getSettings() };
  },
  /** applyConstraints on the live capture; resolves with the settings that came back and the track state. */
  async rateApply(constraints) {
    if (!share) throw new Error('no share');
    const out = {};
    try { await share.track.applyConstraints(constraints); } catch (e) { out.error = String(e && e.message || e); }
    out.settings = share.track.getSettings(); out.state = share.track.readyState; out.muted = share.track.muted;
    return out;
  },
  /**
   * One measurement window with the capture, the encoder and the viewer all at once (needs senderOpen first):
   *   source  = frames the track delivers (MediaStreamTrackProcessor) + the pattern's own counter decoded from them
   *   encoded = the sender's framesEncoded / frameWidth x frameHeight        (pc1 outbound-rtp)
   *   viewer  = what the far end decoded                                     (pc2 inbound-rtp)
   */
  async rateMeasure(secs, decode = false) {
    if (!share) throw new Error('no share');
    const snd = window.__snd;                          // optional: without a sender only the capture is measured
    const grab = async () => {
      let o = null, i = null;
      if (snd) {
        (await snd.pc1.getStats()).forEach((v) => { if (v.type === 'outbound-rtp' && v.kind === 'video') o = v; });
        (await snd.pc2.getStats()).forEach((v) => { if (v.type === 'inbound-rtp' && v.kind === 'video') i = v; });
      }
      return { o, i, t: performance.now() };
    };
    const reader = new MediaStreamTrackProcessor({ track: share.track }).readable.getReader();
    const a = await grab();
    const t0 = performance.now(); let frames = 0, size = null; const seen = new Set(); let decodeErr = null;
    while (performance.now() - t0 < secs * 1000) {
      const r = await Promise.race([reader.read(), sleep(3000).then(() => ({ timeout: true }))]);
      if (r.timeout || r.done) break;
      const f = r.value; frames++; size = [f.displayWidth, f.displayHeight];
      if (decode && !decodeErr) { try { seen.add((await sampleFrame(f)).counter); } catch (e) { decodeErr = String(e && e.message || e); } }
      f.close();
    }
    const dur = (performance.now() - t0) / 1000;
    try { await reader.cancel(); } catch { /* ignore */ }
    const b = await grab();
    const dt = (b.t - a.t) / 1000;
    const per = (x, y, k) => (x && y ? +(((y[k] - x[k]) / dt)).toFixed(1) : null);
    return {
      seconds: +dur.toFixed(2),
      source: { fps: +(frames / dur).toFixed(1), uniqueFps: decode && !decodeErr ? +(seen.size / dur).toFixed(1) : null, size, settings: share.track.getSettings(), decodeErr },
      encoded: { fps: per(a.o, b.o, 'framesEncoded'), size: b.o ? [b.o.frameWidth, b.o.frameHeight] : null, encoder: b.o && b.o.encoderImplementation, limit: b.o && b.o.qualityLimitationReason },
      viewer: { fps: per(a.i, b.i, 'framesDecoded'), received: per(a.i, b.i, 'framesReceived'), size: b.i ? [b.i.frameWidth, b.i.frameHeight] : null },
    };
  },

  /** Deliver-rate over `secs`: raw frames/s, unique pattern-counter values/s, inter-arrival jitter. */
  async measureTrack(secs, requested) {
    if (!share) throw new Error('no share');
    const out = { requested };
    try {
      await share.track.applyConstraints({ frameRate: { ideal: requested, max: requested } });
    } catch (e) { out.applyConstraintsError = String(e && e.message || e); }
    await sleep(700);                                  // let a restarted capturer settle
    out.settingsFrameRate = share.track.getSettings().frameRate;
    out.settingsSize = [share.track.getSettings().width, share.track.getSettings().height];
    const proc = new MediaStreamTrackProcessor({ track: share.track });
    const reader = proc.readable.getReader();
    const t0 = performance.now();
    let frames = 0, last = 0; const dts = []; const seen = new Set(); let decodeErr = null, fmt = null, size = null;
    let prevCounter = -1, counterGaps = 0, maxGap = 0, prevFp = null, changed = 0;
    while (performance.now() - t0 < secs * 1000) {
      const r = await Promise.race([reader.read(), sleep(3000).then(() => ({ timeout: true }))]);
      if (r.timeout) { out.stalledMs = (out.stalledMs || 0) + 3000; break; }
      if (r.done) break;
      const f = r.value; const now = performance.now();
      frames++; if (last) dts.push(now - last); last = now;
      fmt = f.format; size = [f.displayWidth, f.displayHeight];
      if (!decodeErr) {
        try {
          const { counter: c, fp } = await sampleFrame(f);
          if (fp !== prevFp) changed++;
          prevFp = fp;
          if (!seen.has(c)) { seen.add(c); if (prevCounter >= 0) { const gap = ((c - prevCounter) & 0xffffff); if (gap > 1) counterGaps += gap - 1; maxGap = Math.max(maxGap, gap); } prevCounter = c; }
        } catch (e) { decodeErr = String(e && e.message || e); }
      }
      f.close();
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    const dur = (performance.now() - t0) / 1000;
    out.seconds = +dur.toFixed(2);
    out.frames = frames; out.fps = +(frames / dur).toFixed(1);
    out.frameFormat = fmt; out.frameSize = size;
    if (decodeErr) out.decodeError = decodeErr;
    else {
      out.uniqueFrames = seen.size; out.uniqueFps = +(seen.size / dur).toFixed(1);
      out.changedFrames = changed; out.changedFps = +(changed / dur).toFixed(1);   // frames whose picture differs from the previous one
      out.sourceFramesSkipped = counterGaps;          // pattern frames (rAF ticks) the capture never delivered
    }
    out.dtMs = { p50: +(pct(dts, 0.5) || 0).toFixed(1), p95: +(pct(dts, 0.95) || 0).toFixed(1), max: +(Math.max(0, ...dts)).toFixed(1) };
    return out;
  },

  // Chromium only exposes encoderImplementation / powerEfficientEncoder in getStats() while the page holds an active capture
  // (a privacy gate). The screen share does that; for the synthetic sweep we hold a FAKE camera (--use-fake-device-for-media-stream).
  async holdFake() { if (!window.__fake) window.__fake = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } }); return window.__fake.getVideoTracks().length; },
  releaseFake() { if (window.__fake) { window.__fake.getTracks().forEach((t) => t.stop()); window.__fake = null; } },

  // ── codecs / encode ───────────────────────────────────────────────────────
  senderCodecs() {
    return RTCRtpSender.getCapabilities('video').codecs
      .filter((c) => !/rtx|red|ulpfec|flexfec/i.test(c.mimeType))
      .map((c) => ({ mimeType: c.mimeType, sdpFmtpLine: c.sdpFmtpLine || '' }));
  },
  async mediaCaps(mime, fmtp) {
    try {
      const contentType = fmtp ? `${mime};${fmtp}` : mime;
      const r = await navigator.mediaCapabilities.encodingInfo({ type: 'webrtc', video: { contentType, width: 1920, height: 1080, bitrate: 6e6, framerate: 60 } });
      return { supported: r.supported, smooth: r.smooth, powerEfficient: r.powerEfficient };
    } catch (e) { return { error: String(e && e.message || e) }; }
  },

  /** RTCPeerConnection loopback. source = 'canvas' (synthetic, independent of the portal) or 'screen' (the live share). */
  async encode({ source, mime, fmtp, secs, w, h, fps, bitrate }) {
    const res = { source, mime, fmtp, w, h, targetFps: fps };
    let timer = null, track = null, canvas = null;
    if (source === 'screen') {
      if (!share) throw new Error('no share');
      track = share.track;
    } else {
      // Synthetic source: raw I420 frames written straight into a MediaStreamTrackGenerator. No canvas, no GPU readback, no
      // compositor: the only thing that costs CPU here is the ENCODER (a 3 MB memcpy per frame is noise). Frames are
      // slices of one pre-rendered scrolling "document" (see makeDoc), so the content is realistic screen content and moves.
      const doc = makeDoc(w, h); const dg = doc.getContext('2d');
      const rgba = dg.getImageData(0, 0, w, h * 2).data;
      const H2 = h * 2, Y = new Uint8Array(w * H2), U = new Uint8Array((w / 2) * (H2 / 2)), V = new Uint8Array((w / 2) * (H2 / 2));
      for (let y = 0; y < H2; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, r = rgba[i], g2 = rgba[i + 1], b2 = rgba[i + 2];
        Y[y * w + x] = (0.257 * r + 0.504 * g2 + 0.098 * b2 + 16) | 0;
        if ((y & 1) === 0 && (x & 1) === 0) { const ci = (y >> 1) * (w >> 1) + (x >> 1); U[ci] = (-0.148 * r - 0.291 * g2 + 0.439 * b2 + 128) | 0; V[ci] = (0.439 * r - 0.368 * g2 - 0.071 * b2 + 128) | 0; }
      }
      const gen = new MediaStreamTrackGenerator({ kind: 'video' }); const writer = gen.writable.getWriter();
      track = gen;
      const buf = new Uint8Array(w * h * 3 / 2);
      var drawn = 0, tStart = performance.now(), stopGen = false;
      res._drawn = () => drawn / ((performance.now() - tStart) / 1000);
      (async () => {
        const period = 1000 / fps; let next = performance.now(), n = 0;
        while (!stopGen) {
          const off = (n * 4) % h;                                   // even rows only, so chroma stays aligned
          buf.set(Y.subarray(off * w, (off + h) * w), 0);
          buf.set(U.subarray((off / 2) * (w / 2), (off / 2 + h / 2) * (w / 2)), w * h);
          buf.set(V.subarray((off / 2) * (w / 2), (off / 2 + h / 2) * (w / 2)), w * h + (w * h) / 4);
          const f = new VideoFrame(buf, { format: 'I420', codedWidth: w, codedHeight: h, timestamp: Math.round(n * 1e6 / fps) });
          await writer.write(f); f.close(); n++; drawn++;
          next += period; const wait = next - performance.now();
          if (wait > 0) await sleep(wait); else if (wait < -250) next = performance.now();
        }
      })();
      timer = { stop() { stopGen = true; } };
    }
    const pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    try {
      pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate).catch(() => {});
      pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate).catch(() => {});
      const tr = pc1.addTransceiver(track, { direction: 'sendonly' });
      const all = RTCRtpSender.getCapabilities('video').codecs;
      const want = all.filter((c) => c.mimeType.toLowerCase() === mime.toLowerCase() && (c.sdpFmtpLine || '') === (fmtp || ''));
      if (!want.length) { res.error = 'codec not offered'; return res; }
      tr.setCodecPreferences(want);
      const p = tr.sender.getParameters();
      p.encodings[0].maxBitrate = bitrate; p.encodings[0].maxFramerate = fps; p.degradationPreference = 'maintain-resolution';
      await tr.sender.setParameters(p);
      await pc1.setLocalDescription(await pc1.createOffer());
      await pc2.setRemoteDescription(pc1.localDescription);
      await pc2.setLocalDescription(await pc2.createAnswer());
      await pc1.setRemoteDescription(pc2.localDescription);
      res.negotiated = (pc1.getTransceivers()[0].currentDirection || '');
      const samples = [];
      const t0 = performance.now();
      while (performance.now() - t0 < secs * 1000) {
        await sleep(1000);
        const st = await pc1.getStats(); const rs = await pc2.getStats();
        let o = null, i = null; st.forEach((v) => { if (v.type === 'outbound-rtp' && v.kind === 'video') o = v; }); rs.forEach((v) => { if (v.type === 'inbound-rtp' && v.kind === 'video') i = v; });
        if (o) samples.push({ t: performance.now() - t0, o, i });
      }
      const last = samples[samples.length - 1];
      if (!last) { res.error = 'no outbound-rtp stats'; return res; }
      const a = samples[Math.min(1, samples.length - 1)];                 // skip warm-up second
      const dt = (last.t - a.t) / 1000 || 1;
      const dF = last.o.framesEncoded - a.o.framesEncoded;
      if (res._drawn) { res.sourceFps = +res._drawn().toFixed(1); delete res._drawn; }
      res.encoderImplementation = last.o.encoderImplementation || [...samples].reverse().map((x) => x.o.encoderImplementation).find(Boolean) || null;
      res.powerEfficientEncoder = last.o.powerEfficientEncoder;
      res.encodedFps = +(dF / dt).toFixed(1);
      res.sentFps = last.o.framesPerSecond;
      res.framesSent = last.o.framesSent - a.o.framesSent;
      res.encodeMsPerFrame = dF > 0 ? +(((last.o.totalEncodeTime - a.o.totalEncodeTime) / dF) * 1000).toFixed(2) : null;
      res.qualityLimitationReason = last.o.qualityLimitationReason;
      res.qualityLimitationDurations = last.o.qualityLimitationDurations;
      res.frameSize = [last.o.frameWidth, last.o.frameHeight];
      res.keyFrames = last.o.keyFramesEncoded;
      res.kbps = Math.round(((last.o.bytesSent - a.o.bytesSent) * 8) / dt / 1000);
      res.codecId = last.o.codecId;
      res.statsSample = { ...last.o }; delete res.statsSample.timestamp;
      if (last.i) { res.decoderImplementation = last.i.decoderImplementation; res.powerEfficientDecoder = last.i.powerEfficientDecoder; res.framesDecoded = last.i.framesDecoded; res.framesDropped = last.i.framesDropped; }
      return res;
    } catch (e) {
      res.error = String(e && e.message || e); return res;
    } finally {
      if (timer) timer.stop();
      if (canvas && track) track.stop();
      if (source !== 'screen' && track) { try { track.stop(); } catch { /* ignore */ } }
      try { pc1.close(); pc2.close(); } catch { /* ignore */ }
    }
  },

  // ── audio: a 440 Hz tone out of THIS process tree (Chromium's audio service) ──
  async tone(on) {
    if (on) {
      if (window.__ctx) return true;
      const ctx = new AudioContext(); await ctx.resume();
      const o = ctx.createOscillator(); o.frequency.value = 440; const g = ctx.createGain(); g.gain.value = 0.25;
      o.connect(g).connect(ctx.destination); o.start();
      window.__ctx = ctx; window.__osc = o; return ctx.state;
    }
    if (window.__ctx) { window.__osc.stop(); await window.__ctx.close(); window.__ctx = null; }
    return true;
  },
};
