// cl-audio AudioWorklet processor ('cl-audio-worklet'): the Rust/WebAssembly call-audio engine as ONE stage that
// replaces noise suppression + gate + mic gain + AGC + limiter. Loaded as raw text (clAudioWorkletSource.ts), run
// unchanged by vitest (clAudioWorklet.test.ts). ASCII only: vite escapes src/audio/*.js raw imports anyway, but
// keep the source readable in the worklet.
//
// The engine (crates/cl-audio-wasm, C ABI, no imports) is instantiated INSIDE the AudioWorkletGlobalScope from
// bytes handed over in processorOptions.wasmBytes (a WebAssembly.Module in processorOptions.wasmModule works too).
// Compilation is async (WebAssembly.compile) so the render thread is never blocked by a 1.3 MB sync compile;
// until it finishes the stage is an exact passthrough.
//
// Block adaptation. The engine consumes any block size and answers in 480-sample (10 ms) bursts, one burst every
// 3.75 quanta. Each quantum we push 128 samples, append whatever came back to a small FIFO and play 128 samples
// out of it. The FIFO is primed with CLA_PRIME zeros so a quantum can never find it short: after k quanta the
// engine has produced 480*floor(128k/480) samples, so the worst shortfall is max(128k mod 480) = 448. Latency =
// CLA_PRIME + the engine's own delay (480 for Light, 0 for Off / original sound) + about 45 samples the engine does not
// report (its high-pass / limiter look-ahead). The measured end-to-end numbers are CL_AUDIO_LATENCY_SAMPLES
// (utils/clAudioLatency.ts), checked against this worklet and the real wasm by clAudioWorklet.test.ts.
//
// Real-time rules: process() allocates nothing (typed-array views over wasm memory are cached and re-made only
// when the memory grows), never throws, and output is always finite and clamped to [-1, 1]. Any trap or exception
// from the module: audio passes through unprocessed from that quantum on, ONE 'failed' message is posted, and the
// module is never called again (its state cannot be trusted after a trap). The main thread then rebuilds the
// legacy chain (voiceProcessor.ts).
//
// NATIVE MODE ("Strong" = rnnoise-wasm feeding a second engine in a Web Worker; see utils/clAudioNative.ts, workers/clAudioStrong.worker.ts - the
// name is historical, the first Strong ran in a native process and the hand-off is the same). processorOptions.native = true
// (+ nativeJitterFrames, nativeDelaySamples) reserves the extra playout delay up front, then the page sends { type: 'nativePort', port }.
// This engine never runs Strong itself (too heavy for the audio thread): a Strong request here runs Light (see applyCfg).
// The in-page engine (Light) KEEPS RUNNING on the same input as a time-aligned safety net. Every 480 input samples (10 ms) are sent over
// the port with a sequence number; the processed frame comes back by seq into a small slot store.
//
// TIME ALIGNMENT. The two engines do not delay audio equally: the worker's Strong engine has D_s = nativeDelaySamples (960; FastEnhancer's was 3072) of
// algorithmic delay, this engine's Light has D_l (480). Frame f from the worker therefore holds the input of 480 f - D_s, and the same
// slot of this engine's own output the input of 480 f - D_l. Playing one in place of the other would repeat or skip D_s - D_l samples
// (10 ms; it was 54 ms with FastEnhancer). So the Light ring is primed with (D_s - D_l) EXTRA samples (natAlign): the Light output for slot f then holds the input of
// 480 f - D_s as well, and a late frame is replaced by the same moment of audio. Playout of frame f starts at output sample
// CLA_PRIME + 480 * jitterFrames + 480 * f (natP: the alignment extra delays Light's CONTENT, it does not move the slots). The
// price is that Strong's total delay is natP + D_s + ~43 (see utils/clAudioLatency.ts), and that Light, while Strong is in use,
// is that late too. Native frames before natStart + ceil(D_s / 480) are not used: they still hold the engine's state from before
// its stream began, not our audio.
//
// At each frame start the worklet plays the native frame if it is there and the Light frame of the same slot if not (counted as an
// underrun; a 32-sample declick bridges the switch). When more than CLA_NAT_FAIL_PCT of the frames in a 5 s window were missing, or 300 ms of frames in a row were missing, native is PAUSED
// ({ type: 'nativePaused' }): Light plays, frames keep flowing, and native returns ({ type: 'nativeResumed' }) after CLA_NAT_RESUME_FRAMES
// consecutive on-time replies, with the wait doubling on each further pause (see the constants). Both switches are the same time-aligned,
// declicked slot switch. Native is abandoned for the rest of the call (ONE { type: 'nativeFailed', reason }, Light plays on at the same delay)
// only when the host reports a failure (or reports a delay other than nativeDelaySamples: the alignment would be wrong), the page
// says the worker exited or that this audio thread is overloaded, or the port errors.
// Late, duplicate and out-of-order replies are counted and dropped; frames are never played out of order.
// Settings to the host: a change that rebuilds its chain (auto gain on/off, original sound, the mic volume with auto gain OFF) restarts the
// stream ('s', debounced ~400 ms, frames held until the ack, the hold never counted against it). The mic volume with auto gain ON is a
// pre-leveller gain the engine retargets on the running chain: it goes out live ('sl', at most every ~100 ms), nothing is held or acked,
// so a slider drag cannot pause or fail Strong (report 348d6f9b). EQ is page-side biquads: the host hears nothing about it.
//
// Messages in:  { type: 'nativePort', port }              the MessagePort to the worker (transferred)
//               { type: 'nativeExit' }                    the page learned the worker died
//               { type: 'nativeAbort' }                   native could not be opened at startup: drop the reserved delay
//               { type: 'nativeOff' }                     Strong was switched off: stop native quietly, Light plays on
//               { type: 'nativeOverload' }                this audio thread itself fell behind (utils/nsLoadGuard.ts): give up native for the
//                                                         call (one nativeFailed 'render-overload'), so the worker's CPU goes back to the PC
// Messages in:  { type: 'setSettings', noise: 0|1|2 (2 = Strong: the worker's job; here it runs Light), autoGain, manualGainDb, originalSound, gate: { enabled, thresholdDb } }
//                 gate = the engine's MANUAL noise gate (fixed threshold on the raw mic level, off by default). A wasm
//                 without cla_set_gate (an older cached build) simply has no gate: nothing fails.
//               { type: 'reportLevel', ms }                ms > 0: post a 'level' message that often (0 / absent = never)
//               { type: 'setInitialDeviceGain', db }      restore a persisted per-microphone gain
//               { type: 'deviceChanged', hasGain, gainDb } the capture device changed mid-call
//               { type: 'getStats' }                       reply is the same 'stats' message, with reply: true
// Messages out: { type: 'ready' } once, { type: 'failed', error } at most once, and 'stats' once a second (the engine's
// counters in it are that second's, not cumulative; a getStats reply is cumulative), plus { type: 'level', dbfs, open } while
// reportLevel is on: dbfs = the loudest 10 ms RMS of the interval at the microphone input (the quantity the gate compares
// against, here without the engine's 80 Hz high-pass), open = the gate's state. Levels and counters only, never audio.

const CLA_FRAME = 480;
const CLA_PRIME = 448;
const CLA_RING = 8192; // power of two, > 2 * the largest burst we ever buffer
const CLA_RING_MASK = CLA_RING - 1;
const CLA_IN_CHUNK = 2048; // the wasm input buffer is 4096 samples; the upper half holds the stats words
const CLA_STATS_QUANTA = 375; // ~1 s at 48 kHz
const CLA_VOICED_PROB = 0.5;
// Pause statistics (diagnostics only): a quantum counts as a pause once the detector has been under CLA_PAUSE_PROB for
// CLA_PAUSE_RUN quanta (~130 ms: longer than the engine's own delay, so a word's tail is not counted as room noise).
const CLA_PAUSE_PROB = 0.2;
const CLA_PAUSE_RUN = 48;
const CLA_PAUSE_LOUD_MS = 1e-5; // -50 dBFS RMS: a pause quantum louder than this on the wire is plainly audible
// native mode
const CLA_NAT_JITTER_DEFAULT = 2;      // frames of playout delay reserved for the hand-off (processorOptions.nativeJitterFrames overrides)
const CLA_NAT_SLOTS = 16;              // power of two: reply slots, indexed by seq
const CLA_NAT_FAIL_WINDOW = 500;       // frames (5 s) per underrun evaluation
const CLA_NAT_FAIL_PCT = 2;            // percent of a window
const CLA_NAT_DEAD_FRAMES = 30;        // frames in a row without a reply = the port is dead
// 20 s. It was 5 s, and loading the Strong model on a PC busy with a game and a screen share took longer than that:
// native Strong was declared dead for the rest of the call while it was merely starting (report 538ab36e, 2026-11-21).
// Light plays while we wait, so a long wait costs nothing.
const CLA_NAT_ACK_TIMEOUT_FRAMES = 2000;
const CLA_NAT_SETTLE_QUANTA = 150;     // ~400 ms: a settings change that rebuilds the host's chain restarts the stream, so coalesce
// ~100 ms: the mic volume with auto gain on is retargeted on the host's running chain ('sl', no restart, no ack). A slider drag posts
// dozens of changes a second; the host gets at most one per this interval, always the latest value.
const CLA_NAT_LIVE_QUANTA = 38;
const CLA_NAT_DECLICK = 32;
// Recovery. 'underruns' and 'no-replies' are usually a stall (a starved box, a 0.5-1 s scheduling hiccup), not a dead engine: native is
// PAUSED (Light plays, frames keep flowing) and comes back after a CLA_NAT_RESUME_FRAMES stretch with at most 1 % late replies (10 s: longer than every
// stall seen in the 5-minute traces, short enough to be back within a sentence or two). Each further pause doubles the wait (10, 20, 40,
// 60 s cap) so a machine that cannot keep up settles on Light instead of flapping. A dead host (failed / process exit / port error) is final.
const CLA_NAT_RESUME_FRAMES = 1000;
const CLA_NAT_RESUME_MAX_FRAMES = 6000;
const CLA_NAT_START_GRACE = 100;       // frames (1 s) after a start or a settings change in which a missing reply is not counted
const CLA_NAT_RESUME_LATE_PCT = 1;     // late frames allowed in that stretch (the pause rule is 2 %: half of it, so it does not flap)
const CLA_NAT_HIST = 256;              // 1 ms bins

class ClAudioWorklet extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const o = (options && options.processorOptions) || {};
        this.ready = false;
        this.failed = false;
        this.failedPosted = false;
        this.x = null;
        this.ctx = 0;
        this.mem = null;
        this.memBuf = null;
        this.inV = null;
        this.outV = null;
        this.stU = null;
        this.stF = null;
        this.statsPtr = 0;
        this.delay = CLA_FRAME;

        this.ring = new Float32Array(CLA_RING);
        this.rHead = 0;
        this.rCount = 0;

        // Settings and restores that arrive before the module is up are applied right after it is.
        this.cfg = { noise: 1, autoGain: 1, manualGainDb: 0, originalSound: 0, gateOn: 0, gateDb: -55 };
        this.hasGate = false;
        this.levelQuanta = 0; // reportLevel interval in quanta; 0 = off
        this.pauseRun = 0;
        this.lvSq = 0; this.lvN = 0; this.lvMax = 0; this.lvBlocks = 0;
        this.applied = '';
        this.pendInitialGain = null;
        this.pendDeviceChanged = null;
        if (o.settings) this.setCfg(o.settings);
        if (typeof o.initialDeviceGainDb === 'number') this.pendInitialGain = o.initialDeviceGainDb;

        this.lastProb = 0;
        this.testAssumeSpeech = o.testAssumeSpeech === true;
        this.nativeInit(o);
        this.resetWindow();

        this.port.onmessage = (ev) => this.onMessage(ev && ev.data);

        const start = (mod) => {
            const inst = new WebAssembly.Instance(mod, {});
            this.bring(inst.exports);
        };
        try {
            if (o.wasmModule) start(o.wasmModule);
            else if (o.wasmBytes) WebAssembly.compile(o.wasmBytes).then(start).catch((e) => this.fail(e));
            else this.fail('no wasm bytes');
        } catch (e) { this.fail(e); }
    }

    setCfg(s) {
        const c = this.cfg;
        if (s.noise === 0 || s.noise === 1 || s.noise === 2) c.noise = s.noise; // 0 Off, 1 Light, 2 Strong (Strong is the worker's; applyCfg runs Light here)
        if (s.autoGain !== undefined) c.autoGain = s.autoGain ? 1 : 0;
        if (typeof s.manualGainDb === 'number' && s.manualGainDb === s.manualGainDb) c.manualGainDb = Math.max(-40, Math.min(40, s.manualGainDb));
        if (s.originalSound !== undefined) c.originalSound = s.originalSound ? 1 : 0;
        const g = s.gate;
        if (g && typeof g === 'object') {
            c.gateOn = g.enabled === true ? 1 : 0;
            if (typeof g.thresholdDb === 'number' && g.thresholdDb === g.thresholdDb) c.gateDb = Math.max(-100, Math.min(0, g.thresholdDb));
        }
    }

    bring(x) {
        try {
            if (sampleRate !== 48000) throw new Error('cl-audio needs a 48 kHz context, got ' + sampleRate);
            for (const n of ['memory', 'cla_new', 'cla_in_ptr', 'cla_out_ptr', 'cla_push', 'cla_set_settings', 'cla_set_initial_device_gain_db',
                'cla_device_changed', 'cla_device_gain_db', 'cla_delay_samples', 'cla_stats', 'cla_take_stats']) {
                if (!x[n]) throw new Error('missing export ' + n);
            }
            // tests only: their voice is synthetic and the engine's speech detector, rightly, does not take it for a person
            if (this.testAssumeSpeech && typeof x.cla_test_assume_speech === 'function') x.cla_test_assume_speech(1);
            const ctx = x.cla_new(sampleRate); // heavy: warms the models up
            if (!ctx) throw new Error('cla_new failed');
            this.x = x;
            this.hasGate = typeof x.cla_set_gate === 'function';
            this.ctx = ctx;
            this.mem = x.memory;
            this.inPtr = x.cla_in_ptr(ctx);
            this.outPtr = x.cla_out_ptr(ctx);
            this.statsPtr = this.inPtr + CLA_IN_CHUNK * 4;
            this.delay = x.cla_delay_samples(ctx);
            this.views();
            if (this.pendInitialGain !== null) x.cla_set_initial_device_gain_db(ctx, this.pendInitialGain);
            if (this.pendDeviceChanged) x.cla_device_changed(ctx, this.pendDeviceChanged.has, this.pendDeviceChanged.gain);
            this.pendInitialGain = null;
            this.pendDeviceChanged = null;
            this.applyCfg();
            this.delay = x.cla_delay_samples(ctx); // after the settings: the profile decides it
            this.natSetAlign();
            this.rHead = 0;
            this.ring.fill(0);
            this.rCount = CLA_PRIME + this.natExtra;
            this.ready = true;
            this.port.postMessage({ type: 'ready', delaySamples: this.delay, primeSamples: CLA_PRIME + this.natExtra, native: this.natWanted, nativeAlignSamples: this.natAlign });
        } catch (e) { this.fail(e); }
    }

    /** (Re)make the views over wasm memory. Only on first use and after the memory grew. */
    views() {
        const b = this.mem.buffer;
        this.memBuf = b;
        this.inV = new Float32Array(b, this.inPtr, CLA_IN_CHUNK);
        this.outV = new Float32Array(b, this.outPtr, 32768);
        this.stU = new Uint32Array(b, this.statsPtr, 16);
        this.stF = new Float32Array(b, this.statsPtr, 16);
    }

    applyCfg() {
        const c = this.cfg;
        const key = (c.noise === 2 ? 1 : c.noise) + ',' + c.autoGain + ',' + c.manualGainDb + ',' + c.originalSound + ',' + c.gateOn + ',' + c.gateDb;
        if (key === this.applied) return;
        this.applied = key;
        // Strong (2) is the worker's engine: its model costs ~2 ms per 10 ms, too much on top of Light in an audio-thread slot. Here a Strong
        // request runs Light, which is also what plays when the worker is late, missing or failed.
        this.x.cla_set_settings(this.ctx, c.noise === 2 ? 1 : c.noise, c.autoGain, c.manualGainDb, c.originalSound, 1);
        if (this.hasGate) this.x.cla_set_gate(this.ctx, c.gateOn, c.gateDb);
    }

    fail(e) {
        this.failed = true;
        this.ready = false;
        if (this.failedPosted) return;
        this.failedPosted = true;
        let msg = 'unknown';
        try { msg = String((e && e.message) || e).slice(0, 200); } catch (_) { /* keep 'unknown' */ }
        try { this.port.postMessage({ type: 'failed', error: msg }); } catch (_) { /* nothing more to do */ }
    }

    onMessage(d) {
        if (!d || typeof d.type !== 'string') return;
        try {
            if (d.type === 'setSettings') {
                this.setCfg(d);
                if (this.ready) this.applyCfg();
                this.natSettings(d);
            } else if (d.type === 'reportLevel') {
                const ms = typeof d.ms === 'number' && d.ms > 0 ? d.ms : 0;
                this.levelQuanta = ms ? Math.max(1, Math.round(ms * 48 / 128)) : 0;
                this.lvSq = 0; this.lvN = 0; this.lvMax = 0; this.lvBlocks = 0;
            } else if (d.type === 'setInitialDeviceGain') {
                if (typeof d.db !== 'number') return;
                if (this.ready) this.x.cla_set_initial_device_gain_db(this.ctx, d.db);
                else this.pendInitialGain = d.db;
            } else if (d.type === 'deviceChanged') {
                const has = d.hasGain ? 1 : 0;
                const gain = typeof d.gainDb === 'number' ? d.gainDb : 0;
                if (this.ready) {
                    this.x.cla_device_changed(this.ctx, has, gain);
                    this.lastProb = 0;
                } else {
                    this.pendDeviceChanged = { has, gain };
                    this.pendInitialGain = null;
                }
            } else if (d.type === 'getStats') {
                if (this.ready) this.postStats(true);
            } else if (d.type === 'nativePort') {
                this.natAttach(d.port);
            } else if (d.type === 'nativeExit') {
                this.natFail('engine-exit');
            } else if (d.type === 'nativeAbort') {
                this.natAbort();
            } else if (d.type === 'nativeOff') {
                this.natFail('off', true);
            } else if (d.type === 'nativeOverload') {
                this.natFail('render-overload');
            }
        } catch (e) { this.fail(e); }
    }

    resetWindow() {
        this.wBlocks = 0; // quanta in this report window
        this.wVoiced = 0; // ... of which the engine's detector heard speech
        this.wInMs = 0;   // summed input mean-square over voiced quanta
        this.wOutMs = 0;  // summed output mean-square over voiced quanta
        this.wPeak = 0;   // loudest |output sample|
        this.wClip = 0;   // output samples at full scale
        this.wUnder = 0;  // output samples the FIFO could not supply
        this.wOver = 0;   // samples dropped because the FIFO was full
        this.wPauseN = 0;      // quanta inside a pause (see CLA_PAUSE_RUN)
        this.wPauseInMs = 0;   // summed input mean-square over them
        this.wPauseOutMs = 0;  // summed output mean-square over them
        this.wPauseMaxMs = 0;  // loudest output quantum among them (mean-square)
        this.wPauseLoud = 0;   // ... of which louder than CLA_PAUSE_LOUD_MS on the wire
    }

    postStats(reply) {
        const x = this.x;
        // The once-a-second report takes (and resets) the engine's counters so each report is that second's; a
        // getStats reply only looks at them.
        if (reply) x.cla_stats(this.ctx, this.statsPtr); else x.cla_take_stats(this.ctx, this.statsPtr);
        if (this.mem.buffer !== this.memBuf) this.views();
        const u = this.stU, f = this.stF;
        this.port.postMessage({
            type: 'stats', reply: !!reply, engine: 'v2',
            frames: u[0], badSamples: u[1], clamped: u[2], resets: u[3], idleFrames: u[4], inputClipCount: u[5],
            mutedAtDevice: u[6] !== 0, effectiveNoise: u[7],
            gateOn: this.hasGate && this.cfg.gateOn === 1, gateSupported: this.hasGate, gateOpen: this.gateOpen(),
            inputLevelDbfs: f[8], deviceGainDb: f[9], speechProb: f[10], delaySamples: u[11],
            blocks: this.wBlocks, voiced: this.wVoiced, inMs: this.wInMs, outMs: this.wOutMs,
            peak: this.wPeak, clip: this.wClip, underrun: this.wUnder, overflow: this.wOver,
            pauseN: this.wPauseN, pauseInMs: this.wPauseInMs, pauseOutMs: this.wPauseOutMs, pauseMaxMs: this.wPauseMaxMs, pauseLoud: this.wPauseLoud,
            engineNative: this.natOn(), native: this.natStats(),
        });
        if (this.natTraceOn) this.natFlushTrace();
        if (this.natPort && !this.natFailed) { try { this.natPort.postMessage({ t: 'stats' }); } catch (_) { /* port gone */ } }
        this.resetWindow();
    }

    /** 1 while audio passes: always true with no gate (or no such export). */
    gateOpen() {
        if (!this.hasGate || this.cfg.gateOn !== 1 || typeof this.x.cla_gate_open !== 'function') return true;
        return this.x.cla_gate_open(this.ctx) !== 0;
    }

    /** Raw mic level for the Settings meter: loudest 10 ms RMS of the interval. Only runs while reportLevel is on. */
    trackLevel(inp, len) {
        for (let i = 0; i < len; i++) {
            const v = inp ? inp[i] : 0;
            this.lvSq += v * v;
            if (++this.lvN >= CLA_FRAME) {
                const ms = this.lvSq / this.lvN;
                if (ms > this.lvMax) this.lvMax = ms;
                this.lvSq = 0; this.lvN = 0;
            }
        }
        if (++this.lvBlocks >= this.levelQuanta) {
            const db = this.lvMax > 1e-12 ? 10 * Math.log10(this.lvMax) : -120;
            this.port.postMessage({ type: 'level', dbfs: db, open: this.gateOpen() });
            this.lvMax = 0; this.lvBlocks = 0;
        }
    }

    passthrough(inp, out) {
        if (!inp) { out.fill(0); return; }
        const n = out.length < inp.length ? out.length : inp.length;
        for (let i = 0; i < n; i++) {
            const v = inp[i];
            out[i] = v !== v ? 0 : v > 1 ? 1 : v < -1 ? -1 : v;
        }
        for (let i = n; i < out.length; i++) out[i] = 0;
    }

    run(inp, out) {
        const x = this.x;
        const len = out.length;
        let inSq = 0;
        for (let off = 0; off < len; off += CLA_IN_CHUNK) {
            const n = Math.min(CLA_IN_CHUNK, len - off);
            if (this.mem.buffer !== this.memBuf) this.views();
            const dst = this.inV;
            if (inp) {
                for (let i = 0; i < n; i++) { const v = inp[off + i]; dst[i] = v; inSq += v * v; }
                if (this.natWanted) this.natGather(inp, off, n);
            } else {
                for (let i = 0; i < n; i++) dst[i] = 0;
                if (this.natWanted) this.natGather(null, off, n);
            }
            if (this.natWanted) this.natInN += n;
            const got = x.cla_push(this.ctx, n);
            if (this.mem.buffer !== this.memBuf) this.views();
            const src = this.outV;
            for (let i = 0; i < got; i++) {
                if (this.rCount >= CLA_RING) { this.wOver++; this.rHead = (this.rHead + 1) & CLA_RING_MASK; this.rCount--; }
                this.ring[(this.rHead + this.rCount) & CLA_RING_MASK] = src[i];
                this.rCount++;
            }
            if (got > 0) {
                x.cla_stats(this.ctx, this.statsPtr);
                if (this.mem.buffer !== this.memBuf) this.views();
                this.lastProb = this.stF[10];
            }
        }
        let outSq = 0, peak = 0, clip = 0;
        for (let i = 0; i < len; i++) {
            let v = 0;
            if (this.rCount > 0) {
                v = this.ring[this.rHead];
                this.rHead = (this.rHead + 1) & CLA_RING_MASK;
                this.rCount--;
            } else {
                this.wUnder++;
            }
            if (this.natWanted) v = this.natOut(v);
            if (v !== v) v = 0;
            else if (v > 1) v = 1;
            else if (v < -1) v = -1;
            out[i] = v;
            const a = v < 0 ? -v : v;
            outSq += a * a;
            if (a > peak) peak = a;
            if (a >= 0.999) clip++;
        }
        if (this.levelQuanta > 0) this.trackLevel(inp, len);
        this.wBlocks++;
        if (this.natWanted) this.natQuantum();
        if (this.lastProb >= CLA_VOICED_PROB) {
            this.wVoiced++;
            this.wInMs += inSq / len;
            this.wOutMs += outSq / len;
        }
        if (this.lastProb < CLA_PAUSE_PROB) { if (this.pauseRun < CLA_PAUSE_RUN) this.pauseRun++; } else this.pauseRun = 0;
        if (this.pauseRun >= CLA_PAUSE_RUN && inSq > 0) { // inSq 0 = muted at the device: not a room
            const o = outSq / len;
            this.wPauseN++;
            this.wPauseInMs += inSq / len;
            this.wPauseOutMs += o;
            if (o > this.wPauseMaxMs) this.wPauseMaxMs = o;
            if (o > CLA_PAUSE_LOUD_MS) this.wPauseLoud++;
        }
        if (peak > this.wPeak) this.wPeak = peak;
        this.wClip += clip;
        if (this.wBlocks >= CLA_STATS_QUANTA) this.postStats(false);
    }

    // ---- native mode --------------------------------------------------------------------------------------------

    nativeInit(o) {
        this.natWanted = o.native === true;
        const j = typeof o.nativeJitterFrames === 'number' && o.nativeJitterFrames >= 0 && o.nativeJitterFrames <= 8 ? Math.floor(o.nativeJitterFrames) : CLA_NAT_JITTER_DEFAULT;
        this.natJ = j;
        // The worker engine's own delay (0 = unknown: no alignment, the engines are taken to delay equally, as the old tests' echo host does)
        this.natDelay = this.natWanted && typeof o.nativeDelaySamples === 'number' && o.nativeDelaySamples >= 0 && o.nativeDelaySamples <= 16384 ? Math.floor(o.nativeDelaySamples) : 0;
        this.natAlign = 0;                          // extra delay of Light's content so it lines up with the worker's (set in bring: needs Light's delay)
        this.natExtra = this.natWanted ? CLA_FRAME * j : 0;   // total extra ring delay: jitter + natAlign
        this.natP = CLA_PRIME + (this.natWanted ? CLA_FRAME * j : 0);   // output sample at which frame 0 starts playing (alignment does NOT move it)
        this.natPreroll = Math.ceil(this.natDelay / CLA_FRAME);      // frames until the worker's output is our audio, not its start-up state
        this.natSwitchDk = false;                   // a Strong -> Light switch is pending a declick
        this.natTraceOn = o.nativeTrace === true;
        this.natGateKey = '';
        this.natInitGainPending = typeof o.initialDeviceGainDb === 'number' && o.initialDeviceGainDb === o.initialDeviceGainDb ? o.initialDeviceGainDb : null;
        // bench-only knobs (scripts/audio-native-bench): which profile the host runs (0..3, default 2 = Strong) and "keep counting, never
        // give up on underruns or a silent port". The app never sets them.
        this.natNoise = typeof o.nativeNoise === 'number' && o.nativeNoise >= 0 && o.nativeNoise <= 3 ? Math.floor(o.nativeNoise) : 2;
        this.natNoFail = o.nativeNoFail === true;
        this.natPort = null;
        this.natReady = false;                      // host said ready
        this.natFailed = false;
        this.natFailPosted = false;
        this.natDeg = false;                        // paused after a stall: Light plays, native may come back
        this.natDegN = 0;                           // pauses so far this call
        this.natHealthy = 0;                        // on-time replies in the current recovery stretch (natRecF frames long so far)
        this.natRecF = 0;
        this.natNeed = CLA_NAT_RESUME_FRAMES;
        this.natHold = true;                        // no frames sent / counted until the host has acked the settings
        this.natStart = Infinity;                   // first seq whose playout counts
        this.natInN = 0;                            // samples pushed into the wasm engine: frame ids are absolute, aligned to ITS 480-sample frames
        this.natFrameId = 0;
        this.natIn = new Float32Array(CLA_FRAME);
        this.natFill = 0;
        this.natSlotSeq = new Float64Array(CLA_NAT_SLOTS).fill(-1);
        this.natSlot = [];
        for (let i = 0; i < CLA_NAT_SLOTS; i++) this.natSlot.push(null);
        this.natOutN = 0;                           // output samples played so far
        this.natF = -1;                             // frame index whose playout was last decided
        this.natO = 0;                              // offset inside that frame
        this.natSrc = 0;                            // 0 = Light, 1 = native
        this.natLast = 0;
        this.natDk = 0; this.natDkN = 0;
        this.natMaxSeq = -1;
        this.natMiss = 0;                           // consecutive counted frames without a reply
        this.natWinF = 0; this.natWinU = 0;
        this.natCnt = { frames: 0, played: 0, under: 0, late: 0, dup: 0, ooo: 0, bad: 0, hostFail: 0, sent: 0, replies: 0, resumed: 0 };
        this.natHist = new Uint32Array(CLA_NAT_HIST + 1);
        this.natHistN = 0;
        this.natSlackMin = 1e9;
        this.natSettingsId = 0;
        this.natSettingsDue = -1;
        this.natLastCfgKey = '';
        this.natLiveDue = -1;                       // quantum at which the latest mic volume goes to the host live ('sl'); -1 = none pending
        this.natSentGain = null;                    // the mic volume the host has (from the last 's' or 'sl')
        this.natCfg = null;
        this.natQ = 0;
        this.natAckWait = 0;
        this.natHostStats = null;
        this.natTrace = [];
        this.natReason = '';
    }

    /** once Light's delay is known: line its content up with the worker's (see TIME ALIGNMENT at the top) */
    natSetAlign() {
        if (!this.natWanted) return;
        this.natAlign = this.natDelay > this.delay ? this.natDelay - this.delay : 0;
        this.natExtra = CLA_FRAME * this.natJ + this.natAlign;
    }

    natOn() { return this.natWanted && this.natReady && !this.natFailed && !this.natDeg && !!this.natPort; }

    nowMs() { return Date.now(); }

    natAttach(port) {
        if (!this.natWanted || this.natPort || this.natFailed || !port || typeof port.postMessage !== 'function') return;
        this.natPort = port;
        port.onmessage = (ev) => this.natOnMsg(ev && ev.data);
        if (typeof port.start === 'function') { try { port.start(); } catch (_) { /* started */ } }
        // nothing is sent until the host says 'ready' (it answers the open with that); then our settings go first
    }

    natAbort() {
        // native could not be opened at startup: give the reserved delay back by dropping that much of the Light ring (a click at most, once)
        if (!this.natWanted || this.natPort || this.natOutN > CLA_PRIME + 4 * CLA_FRAME) { if (this.natWanted && !this.natPort) this.natFail('open-failed-late'); return; }
        this.natWanted = false;
        const drop = Math.min(this.natExtra, this.rCount);
        this.rHead = (this.rHead + drop) & CLA_RING_MASK;
        this.rCount -= drop;
        this.natExtra = 0;
    }

    /** the settings whose change rebuilds the host's chain (a restart of the stream: 's', held until acked). The mic volume is part of it
     *  only with auto gain OFF (that chain bakes the gain in). With auto gain on it is a pre-leveller gain the engine retargets on the
     *  running chain, so it goes out live instead ('sl', natSendLive): no hold, no re-sync, frames keep flowing, nothing can time out.
     *  (Report 348d6f9b, 2026-11-25: with the gain in this key every slider move restarted the stream; on a host that did not answer
     *  the restart was what timed out and announced "Switched to Light".) */
    natCfgKey() {
        const c = this.cfg;
        return c.autoGain + ',' + (c.autoGain ? '' : c.manualGainDb) + ',' + c.originalSound;
    }

    /** the page changed settings: Light already took them. A change that rebuilds the host's chain is sent debounced and only when it
     *  matters; a mic-volume move with auto gain on is sent live, throttled; anything else (EQ, which is page-side biquads) sends nothing. */
    natSettings() {
        if (!this.natPort || this.natFailed) return;
        this.natGateIfChanged();
        if (this.natCfgKey() !== this.natLastCfgKey) { this.natSettingsDue = this.natQ + CLA_NAT_SETTLE_QUANTA; return; }
        // back to what the host already runs (e.g. auto gain toggled off and on again): the restart queued for the in-between value is moot
        if (this.natLastCfgKey !== '') this.natSettingsDue = -1;
        if (this.cfg.manualGainDb !== this.natSentGain && this.natLiveDue < 0) this.natLiveDue = this.natQ + CLA_NAT_LIVE_QUANTA;
    }

    /** the mic volume (auto gain on) to the host's running chain: no hold, no ack, the stream is not touched */
    natSendLive() {
        this.natLiveDue = -1;
        if (!this.natPort || this.natFailed || !this.natSendOnce) return;   // before the first settings the host gets the current gain with them
        if (this.natCfgKey() !== this.natLastCfgKey) return;               // a restart is on its way and carries the gain
        const c = this.cfg;
        if (c.manualGainDb === this.natSentGain) return;
        this.natSentGain = c.manualGainDb;
        try {
            this.natPort.postMessage({ t: 'sl', noise: this.natNoise, autoGain: !!c.autoGain, manualGainDb: c.manualGainDb, originalSound: !!c.originalSound });
        } catch (e) { this.natFail('port-error'); }
    }

    /** the manual noise gate goes to the host as its own cheap message (no model restart); the engine there gates ITS output exactly like
     *  the wasm engine gates Light's, and playout picks one of the two, so the gate is applied once, whichever path produced the frame */
    natSendGate() {
        if (!this.natPort || this.natFailed) return;
        const c = this.cfg;
        try { this.natPort.postMessage({ t: 'gate', enabled: c.gateOn === 1, thresholdDb: c.gateDb }); } catch (e) { this.natFail('port-error'); }
    }

    natGateIfChanged() {
        const k = this.cfg.gateOn + ',' + this.cfg.gateDb;
        if (k === this.natGateKey) return;
        this.natGateKey = k;
        this.natSendGate();
    }

    natSendSettings() {
        const c = this.cfg;
        this.natLastCfgKey = this.natCfgKey();
        this.natSettingsDue = -1;
        this.natSentGain = c.manualGainDb;
        this.natLiveDue = -1;
        this.natGateKey = '';
        this.natSettingsId++;
        this.natHold = true;
        this.natStart = Infinity;
        this.natAckWait = 0;
        this.natFill = 0;
        try {
            this.natPort.postMessage({ t: 's', id: this.natSettingsId, noise: this.natNoise, autoGain: !!c.autoGain, manualGainDb: c.manualGainDb, originalSound: !!c.originalSound });
        } catch (e) { this.natFail('port-error'); }
    }

    natGather(inp, off, n) {
        if (!this.natPort || this.natFailed || this.natHold || !this.natReady) return;
        for (let i = 0; i < n; i++) {
            const pos = this.natInN + i;
            if (this.natFill === 0) {
                if (pos % CLA_FRAME !== 0) continue;   // a frame must start where the wasm engine's frame starts
                this.natFrameId = pos / CLA_FRAME;
            }
            this.natIn[this.natFill++] = inp ? inp[off + i] : 0;
            if (this.natFill === CLA_FRAME) {
                this.natFill = 0;
                try { this.natPort.postMessage({ t: 'f', seq: this.natFrameId, ts: this.nowMs(), pcm: this.natIn }); this.natCnt.sent++; } catch (e) { this.natFail('port-error'); return; }
            }
        }
    }

    natOnMsg(d) {
        if (!d || typeof d.t !== 'string' || this.natFailed) return;
        try {
            if (d.t === 'o') this.natOnFrame(d);
            else if (d.t === 'ready') {
                // the alignment above assumes exactly this delay: with another one a substituted frame would be a different moment
                if (this.natDelay > 0 && typeof d.delaySamples === 'number' && d.delaySamples !== this.natDelay) { this.natFail('delay-mismatch'); return; }
                this.natReady = true;
                if (!this.natSendOnce) { this.natSendOnce = true; this.natSendSettings(); }
            } else if (d.t === 'ack') {
                if (d.id === this.natSettingsId) {
                    if (!d.ok) { this.natFail('settings-rejected'); return; }
                    // the first frame we send from now on is the first one whose playout counts; frames before it play Light
                    this.natHold = false;
                    this.natStart = Math.ceil(this.natInN / CLA_FRAME) + this.natPreroll;   // the first frame sent from now on, plus the engine's pipeline
                    this.natFill = 0;
                    this.natMiss = 0; this.natWinF = 0; this.natWinU = 0;
                    this.natGateIfChanged();
                    // a remembered gain for this microphone starts the native leveller settled too (the host starts every call from a fresh engine)
                    if (this.natInitGainPending !== null && this.natPort) { try { this.natPort.postMessage({ t: 'g', db: this.natInitGainPending }); } catch (_) { /* port gone */ } this.natInitGainPending = null; }
                }
            } else if (d.t === 'failed') { this.natFail('engine-failed'); }
            else if (d.t === 'stats') {
                this.natHostStats = { frames: d.framesIn, replied: d.framesOut, procUsAvg: d.procUsAvg, procUsMax: d.procUsMax, bad: d.statusBad, dropStale: d.dropStale, dropDup: d.dropDup, dropOld: d.dropOld, lost: d.lost, watchdogFrames: d.watchdogFrames, effectiveNoise: d.effectiveNoise, rssMb: d.rssMb, speechProb: d.speechProb };
            }
        } catch (e) { this.natFail('exception'); }
    }

    natOnFrame(d) {
        const seq = d.seq;
        if (typeof seq !== 'number' || seq !== seq || seq < 0 || Math.floor(seq) !== seq || !d.pcm || d.pcm.length !== CLA_FRAME) { this.natCnt.bad++; return; }
        this.natCnt.replies++;
        const rtt = this.nowMs() - d.ts;
        const bin = rtt < 0 ? 0 : rtt >= CLA_NAT_HIST ? CLA_NAT_HIST : Math.floor(rtt);
        this.natHist[bin]++; this.natHistN++;
        // on time iff the frame's first sample has not been played yet (it is requested in the NEXT quantum at the earliest)
        const slack = this.natP + CLA_FRAME * seq - this.natOutN;
        if (slack < this.natSlackMin) this.natSlackMin = slack;
        if (this.natTraceOn) this.natTrace.push(rtt, slack, d.us || 0, seq);
        if (d.st !== 0) { this.natCnt.hostFail++; return; }       // the engine passed the frame through: not processed audio, play Light
        if (seq < this.natMaxSeq) this.natCnt.ooo++; else this.natMaxSeq = seq;
        if (seq <= this.natF) { this.natCnt.late++; return; }      // its playout was already decided
        if (seq >= this.natF + CLA_NAT_SLOTS) { this.natCnt.bad++; return; }
        const k = seq & (CLA_NAT_SLOTS - 1);
        if (this.natSlotSeq[k] === seq) { this.natCnt.dup++; return; }
        this.natSlotSeq[k] = seq;
        this.natSlot[k] = d.pcm;
    }

    /** once per render quantum */
    natQuantum() {
        this.natQ++;
        if (this.natSettingsDue >= 0 && this.natQ >= this.natSettingsDue && this.natPort && !this.natFailed) this.natSendSettings();
        if (this.natLiveDue >= 0 && this.natQ >= this.natLiveDue) this.natSendLive();
        if (this.natHold && this.natPort && this.natReady && !this.natFailed) {
            this.natAckWait++;
            if (this.natAckWait > CLA_NAT_ACK_TIMEOUT_FRAMES * 4 && this.natSettingsDue < 0) this.natFail('ack-timeout');
        }
    }

    /** one output sample: `vl` is the Light engine's sample for this slot */
    natOut(vl) {
        const n = this.natOutN++;
        if (n < this.natP) { this.natLast = vl; return vl; }
        if (this.natSwitchDk) { this.natSwitchDk = false; this.natDk = this.natLast - vl; this.natDkN = CLA_NAT_DECLICK; }
        if (this.natO === 0 || this.natF < 0) {
            // frame start (the first call has natF = -1 and natO = 0)
            if (this.natF < 0) this.natF = 0; else { this.natF++; }
            this.natDecide(this.natF, vl);
        }
        let v;
        if (this.natSrc === 1) v = this.natCur[this.natO]; else v = vl;
        this.natO++;
        if (this.natO === CLA_FRAME) this.natO = 0;
        if (this.natDkN > 0) { v += this.natDk * (this.natDkN / CLA_NAT_DECLICK); this.natDkN--; }
        this.natLast = v;
        return v;
    }

    natDecide(f, vl) {
        const k = f & (CLA_NAT_SLOTS - 1);
        const have = this.natSlotSeq[k] === f;
        let src = 0;
        const live = !this.natFailed && this.natReady && !this.natHold && f >= this.natStart && !!this.natPort;
        const counting = live && !this.natDeg;
        if (counting && f < this.natStart + CLA_NAT_START_GRACE) {
            // Just started (or just took new settings): the host is still dropping what queued up and its first frames are slow.
            // Play what arrives, play Light for what does not, and do not let it count toward a pause yet. Measured 2026-11-21: a cold start lost its
            // first ~21 frames, which was counted as "no replies" and paused Strong before it had begun.
            this.natCnt.frames++;
            if (have) { src = 1; this.natCnt.played++; } else this.natCnt.under++;   // reported, but not held against it
        } else if (counting) {
            this.natCnt.frames++;
            this.natWinF++;
            if (have) { src = 1; this.natMiss = 0; this.natCnt.played++; }
            else { this.natCnt.under++; this.natWinU++; this.natMiss++; }
        } else if (live && this.natDeg) {
            // paused: Light plays; native must be on time for a sustained stretch before it returns
            // Judged over the whole stretch, not as an unbroken run: it used to need natNeed CONSECUTIVE on-time frames, and on a
            // real machine one late frame in ten seconds is normal, so a paused Strong practically never came back (measured
            // 2026-11-21: 45 s of healthy 7 ms round trips after a 20 s overload, no resume).
            this.natRecF++;
            if (have) this.natHealthy++;
            if (this.natRecF - this.natHealthy > (this.natNeed * CLA_NAT_RESUME_LATE_PCT) / 100) {
                this.natRecF = 0; this.natHealthy = 0;   // too many late ones for this stretch: start it again from here
            } else if (this.natRecF >= this.natNeed && have) {
                this.natRecF = 0; this.natHealthy = 0;
                this.natDeg = false; this.natMiss = 0; this.natWinF = 0; this.natWinU = 0; src = 1; this.natCnt.resumed++;
                try { this.port.postMessage({ type: 'nativeResumed', pauses: this.natDegN }); } catch (_) { /* nothing */ }
            }
        } else if (have && !this.natFailed && f >= this.natStart && !this.natDeg) { src = 1; }
        if (have) { this.natCur = this.natSlot[k]; this.natSlotSeq[k] = -1; this.natSlot[k] = null; }
        if (src === 1 && !this.natCur) src = 0;
        if (src !== this.natSrc) {
            const first = src === 1 ? this.natCur[0] : vl;
            this.natDk = this.natLast - first;
            this.natDkN = CLA_NAT_DECLICK;
            this.natSrc = src;
        }
        if (counting) {
            if (this.natMiss >= CLA_NAT_DEAD_FRAMES && !this.natNoFail) { this.natPause('no-replies'); return; }
            if (this.natWinF >= CLA_NAT_FAIL_WINDOW) {
                const pct = (100 * this.natWinU) / this.natWinF;
                this.natWinF = 0; this.natWinU = 0;
                if (pct > CLA_NAT_FAIL_PCT && !this.natNoFail) this.natPause('underruns');
            }
        }
    }

    /** a stall, not a failure: Light plays from the next frame, native is retried after a sustained healthy stretch (back-off doubles) */
    natPause(reason) {
        this.natDeg = true;
        this.natDegN++;
        this.natHealthy = 0; this.natRecF = 0;
        this.natNeed = Math.min(CLA_NAT_RESUME_FRAMES * Math.pow(2, this.natDegN - 1), CLA_NAT_RESUME_MAX_FRAMES);
        this.natReason = reason;
        try { this.port.postMessage({ type: 'nativePaused', reason, pauses: this.natDegN, resumeFrames: this.natNeed }); } catch (_) { /* nothing */ }
    }

    natFail(reason, silent) {
        if (!this.natWanted) return;
        const had = !!this.natPort;
        this.natFailed = true;
        this.natReason = reason;
        if (this.natPort) {
            const p = this.natPort;
            this.natPort = null;
            try { p.onmessage = null; } catch (_) { /* gone */ }
            try { p.postMessage({ t: 'bye' }); } catch (_) { /* gone */ }
            try { if (typeof p.close === 'function') p.close(); } catch (_) { /* gone */ }
        }
        if (this.natSrc === 1) { this.natSrc = 0; this.natSwitchDk = true; }   // the next sample declicks into Light (natOut)
        if (!this.natFailPosted && had && !silent) {
            this.natFailPosted = true;
            try { this.port.postMessage({ type: 'nativeFailed', reason, native: this.natStats() }); } catch (_) { /* nothing more to do */ }
        }
    }

    natPct(p) {
        if (this.natHistN === 0) return 0;
        const want = Math.ceil((p / 100) * this.natHistN);
        let c = 0;
        for (let i = 0; i <= CLA_NAT_HIST; i++) { c += this.natHist[i]; if (c >= want) return i; }
        return CLA_NAT_HIST;
    }

    natMax() { for (let i = CLA_NAT_HIST; i >= 0; i--) if (this.natHist[i] > 0) return i; return 0; }

    /** numbers only; hand-off percentiles are per report window (1 ms bins), counters cumulative */
    natStats() {
        if (!this.natWanted) return null;
        const c = this.natCnt;
        const o = {
            active: this.natOn(), failed: this.natFailed, paused: this.natDeg, pauses: this.natDegN, resumed: c.resumed, reason: this.natReason, jitterFrames: this.natJ,
            frames: c.frames, played: c.played, underrun: c.under, late: c.late, dup: c.dup, ooo: c.ooo, bad: c.bad, hostFail: c.hostFail, sent: c.sent, replies: c.replies,
            rttP50: this.natPct(50), rttP95: this.natPct(95), rttP99: this.natPct(99), rttMax: this.natMax(), slackMinSamples: this.natSlackMin === 1e9 ? 0 : this.natSlackMin,
            host: this.natHostStats,
        };
        this.natHist.fill(0); this.natHistN = 0; this.natSlackMin = 1e9;
        return o;
    }

    natFlushTrace() {
        if (this.natTrace.length === 0) return;
        const a = new Float32Array(this.natTrace);
        this.natTrace.length = 0;
        try { this.port.postMessage({ type: 'nativeTrace', data: a }, [a.buffer]); } catch (_) { /* nothing */ }
    }

    process(inputs, outputs) {
        const out = outputs && outputs[0] && outputs[0][0];
        if (!out) return true;
        const inp = inputs && inputs[0] && inputs[0][0];
        if (!this.ready || this.failed) { this.passthrough(inp, out); return true; }
        try {
            this.run(inp, out);
        } catch (e) {
            this.fail(e);
            this.passthrough(inp, out);
        }
        return true;
    }
}

registerProcessor('cl-audio-worklet', ClAudioWorklet);
