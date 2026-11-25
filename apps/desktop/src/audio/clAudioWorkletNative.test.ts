import { describe, it, expect, afterEach, vi } from 'vitest';
import { CL_AUDIO_WORKLET_SOURCE } from '../utils/clAudioWorkletSource';
import { clAudioWasmBytes } from '../utils/clAudioWasm';
import { CL_AUDIO_PRIME_SAMPLES } from '../utils/clAudioLatency';
import { engineSettingsFor } from '../utils/clAudioSettings';
import { loadModuleWorklet, waitFor, Q, type Proc } from './audit/chainHarness';

/**
 * Native mode of the cl-audio worklet (jitter buffer + Light safety net), driven in Node with the REAL worklet and the REAL wasm (Light)
 * and a simulated utility-process port: replies can be late, missing, duplicated, reordered or stop altogether. The simulated engine
 * "processes" a frame by echoing the INPUT frame back (so a played native sample is recognisable, and bit-exact against the input).
 */
vi.setConfig({ testTimeout: 60_000 });

const g = globalThis as unknown as Record<string, unknown>;
afterEach(() => { for (const k of ['registerProcessor', 'AudioWorkletProcessor', 'sampleRate']) delete g[k]; });

type Msg = { type: string; [k: string]: unknown };
const msgs = (p: Proc) => (p as unknown as { _msgs: Msg[] })._msgs;
const ofType = (p: Proc, t: string) => msgs(p).filter(m => m.type === t);
const send = (p: Proc, data: unknown) => p.port.onmessage!({ data });
const FRAME = 480;
const J = 2;
const P = CL_AUDIO_PRIME_SAMPLES + FRAME * J;

interface HostMsg { t: string; seq?: number; ts?: number; pcm?: Float32Array; id?: number; [k: string]: unknown }
interface Script {
    /** quanta between a frame being posted and its reply being delivered; null = never answered */
    delayQ: (seq: number) => number | null;
    /** extra deliveries of the same reply (duplicates) */
    dup?: (seq: number) => boolean;
    /** swap each pair of replies that become due in the same quantum */
    reorder?: boolean;
    /** the host answers frames with this status (0 = processed) */
    status?: (seq: number) => 0 | 1 | 2;
    /** after this quantum the host stops answering anything */
    deadAfterQ?: number;
    ackDelayQ?: number;
    /** per settings id: quanta until its ack, null = never acknowledged (overrides ackDelayQ) */
    ackFor?: (id: number) => number | null;
}

function signal(n: number): Float32Array {
    const x = new Float32Array(n);
    let s = 1;
    for (let i = 0; i < n; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; x[i] = 0.3 * Math.sin(i * 0.05) * (0.6 + 0.4 * Math.sin(i * 0.0007)) + 0.002 * (((s >>> 0) / 2147483648) - 1); }
    return x;
}

async function setup(opts: Record<string, unknown> = {}) {
    const p = await loadModuleWorklet(CL_AUDIO_WORKLET_SOURCE, 'cl-audio-worklet', { wasmBytes: clAudioWasmBytes(), native: true, nativeJitterFrames: J, ...opts });
    await waitFor(() => !!p.ready || !!p.failed, 30_000);
    const port = { onmessage: null as null | ((e: { data: unknown }) => void), posted: [] as HostMsg[], closed: false,
        postMessage(m: HostMsg) { this.posted.push(m.pcm ? { ...m, pcm: new Float32Array(m.pcm) } : m); }, close() { this.closed = true; }, start() { /* no-op */ } };
    send(p, { type: 'nativePort', port });
    return { p, port };
}

/** Run `n` quanta of `x` through the worklet while a scripted host answers. Returns the output and the frames the host saw. */
function drive(p: Proc, port: Awaited<ReturnType<typeof setup>>['port'], x: Float32Array, script: Script, hook?: (q: number) => void) {
    const startQ = 0;
    const log: { q: number; m: HostMsg }[] = [];
    const out = new Float32Array(Math.floor(x.length / Q) * Q);
    const o = new Float32Array(Q);
    const due: { at: number; m: HostMsg }[] = [];
    const frames: HostMsg[] = [];
    let seen = 0;
    port.onmessage?.({ data: { t: 'ready', delaySamples: 480, effectiveNoise: 2 } });
    for (let k = 0; k * Q + Q <= x.length; k++) {
        const q = startQ + k;
        const live = script.deadAfterQ === undefined || q < script.deadAfterQ;
        hook?.(q);
        p.process([[x.subarray(k * Q, (k + 1) * Q)]], [[o]]);
        out.set(o, k * Q);
        for (; seen < port.posted.length; seen++) {
            const m = port.posted[seen];
            log.push({ q, m });
            if (!live) continue;
            if (m.t === 'f') {
                frames.push({ ...m, pcm: new Float32Array(m.pcm!) });
                const d = script.delayQ(m.seq!);
                if (d === null) continue;
                const st = script.status ? script.status(m.seq!) : 0;
                const reply = { t: 'o', seq: m.seq, ts: m.ts, pcm: new Float32Array(m.pcm!), st, us: 100 };
                due.push({ at: q + d, m: reply });
                if (script.dup?.(m.seq!)) due.push({ at: q + d + 1, m: { ...reply, pcm: new Float32Array(m.pcm!) } });
            } else if (m.t === 's') {
                const d = script.ackFor ? script.ackFor(m.id!) : (script.ackDelayQ ?? 1);
                if (d !== null) due.push({ at: q + d, m: { t: 'ack', id: m.id, ok: true, effectiveNoise: 2 } });
            }
        }
        const now = due.filter(d => d.at <= q + 1);
        for (const d of now) due.splice(due.indexOf(d), 1);
        if (script.reorder) for (let i = 0; i + 1 < now.length; i += 2) [now[i], now[i + 1]] = [now[i + 1], now[i]];
        for (const d of now) port.onmessage?.({ data: d.m });
    }
    return { out, frames, log };
}

const perfect: Script = { delayQ: () => 1 };

describe('native mode: protocol and alignment', () => {
    it('says it reserved the hand-off delay, then asks the host for Strong settings and holds frames until they are acked', async () => {
        const { p, port } = await setup();
        expect(ofType(p, 'ready')[0]).toMatchObject({ primeSamples: P, native: true });
        port.onmessage!({ data: { t: 'ready' } });
        const s = port.posted.find(m => m.t === 's')!;
        expect(s).toMatchObject({ t: 's', noise: 2, autoGain: true, originalSound: false });
        expect(port.posted.some(m => m.t === 'f')).toBe(false);
        // run a few quanta without an ack: still no frames
        const o = new Float32Array(Q);
        for (let k = 0; k < 20; k++) p.process([[signal(Q)]], [[o]]);
        expect(port.posted.some(m => m.t === 'f')).toBe(false);
        port.onmessage!({ data: { t: 'ack', id: s.id, ok: true, effectiveNoise: 2 } });
        for (let k = 0; k < 20; k++) p.process([[signal(Q)]], [[o]]);
        expect(port.posted.some(m => m.t === 'f')).toBe(true);
    });

    it('sends exactly 480 floats per frame, with consecutive sequence numbers, aligned to the engine\'s frames, and a timestamp', async () => {
        const { p, port } = await setup();
        const x = signal(48000 * 2);
        const { frames } = drive(p, port, x, perfect);
        expect(frames.length).toBeGreaterThan(150);
        for (let i = 0; i < frames.length; i++) {
            const f = frames[i];
            expect(f.pcm!.length).toBe(FRAME);
            expect(Number.isFinite(f.ts)).toBe(true);
            if (i > 0) expect(f.seq).toBe(frames[i - 1].seq! + 1);
            // absolute alignment: frame `seq` is input samples [480 seq, 480 seq + 480)
            const a = f.seq! * FRAME;
            expect(Array.from(f.pcm!.subarray(0, 8))).toEqual(Array.from(x.subarray(a, a + 8)));
            expect(f.pcm![FRAME - 1]).toBe(x[a + FRAME - 1]);
        }
    });

    it('a healthy host is played bit-exactly: native output == input delayed by 448 + 480 * jitter frames, no underruns', async () => {
        const { p, port } = await setup();
        const x = signal(48000 * 3);
        const { out } = drive(p, port, x, perfect);
        let bad = 0, compared = 0;
        for (let n = 48000; n < out.length; n++) { compared++; if (Math.abs(out[n] - x[n - P]) > 1e-7) bad++; }
        expect(bad / compared).toBeLessThan(0.002); // only the first-frame declick may differ
        const st = ofType(p, 'stats').at(-1)!.native as Record<string, number | boolean>;
        expect(st).toMatchObject({ active: true, failed: false, underrun: 0, jitterFrames: J });
        expect(st.played).toBeGreaterThan(200);
        expect(ofType(p, 'nativeFailed')).toHaveLength(0);
        expect(ofType(p, 'stats').at(-1)!.engineNative).toBe(true);
    });
});

describe('native mode: late, missing, duplicate, out-of-order replies', () => {
    it('a reply later than the reserved depth is not played: Light plays that slot, it is counted as an underrun and as late', async () => {
        const { p, port } = await setup();
        const x = signal(48000 * 3);
        const { out } = drive(p, port, x, { delayQ: (s) => (s === 100 ? 80 : 1) });
        const st = ofType(p, 'stats').at(-1)!.native as Record<string, number>;
        expect(st.underrun).toBe(1);
        expect(st.late).toBeGreaterThanOrEqual(1);
        expect(ofType(p, 'nativeFailed')).toHaveLength(0);
        // the slot is Light's, not silence and not the late echo: finite, in range
        const a = P + 100 * FRAME;
        for (let i = a; i < a + FRAME; i++) expect(Number.isFinite(out[i]) && Math.abs(out[i]) <= 1).toBe(true);
    });

    it('1 % missing replies is tolerated (below the 2 % threshold) and played as Light', async () => {
        const { p, port } = await setup();
        const x = signal(48000 * 8);
        drive(p, port, x, { delayQ: (s) => (s % 100 === 50 ? null : 1) });
        const st = ofType(p, 'stats').at(-1)!.native as Record<string, number | boolean>;
        expect(st.underrun as number).toBeGreaterThanOrEqual(7);   // seq % 100 == 50 over ~8 s = 1 %
        expect(st.underrun as number).toBeLessThanOrEqual(9);
        expect(st.failed).toBe(false);
        expect(ofType(p, 'nativeFailed')).toHaveLength(0);
    });

    it('duplicates are counted and dropped, never played twice', async () => {
        const { p, port } = await setup();
        const x = signal(48000 * 3);
        const { out } = drive(p, port, x, { delayQ: () => 1, dup: (s) => s % 7 === 0 });
        const st = ofType(p, 'stats').at(-1)!.native as Record<string, number>;
        expect(st.dup).toBeGreaterThan(5);
        expect(st.underrun).toBe(0);
        for (let n = 48000; n < out.length; n += 997) expect(Math.abs(out[n] - x[n - P])).toBeLessThan(1e-6);
    });

    it('out-of-order replies are placed by sequence number and still play in order', async () => {
        const { p, port } = await setup();
        const x = signal(48000 * 3);
        const { out } = drive(p, port, x, { delayQ: (s) => (s % 2 === 0 ? 6 : 1) }); // each even reply arrives after the odd one that followed it
        const st = ofType(p, 'stats').at(-1)!.native as Record<string, number>;
        expect(st.ooo).toBeGreaterThan(10);
        expect(st.underrun).toBe(0);
        for (let n = 48000; n < out.length; n += 997) expect(Math.abs(out[n] - x[n - P])).toBeLessThan(1e-6);
    });

    it('a pass-through status from the host (engine failed on that frame) is not played as native audio', async () => {
        const { p, port } = await setup();
        const x = signal(48000 * 3);
        drive(p, port, x, { delayQ: () => 1, status: (s) => (s === 120 ? 2 : 0) });
        const st = ofType(p, 'stats').at(-1)!.native as Record<string, number>;
        expect(st.hostFail).toBe(1);
        expect(st.underrun).toBe(1);
    });

    it('malformed replies are ignored (wrong length, bad seq, unknown type)', async () => {
        const { p, port } = await setup();
        const x = signal(48000);
        drive(p, port, x, perfect);
        const before = (ofType(p, 'stats').at(-1)?.native as Record<string, number> | undefined)?.bad ?? 0;
        for (const m of [{ t: 'o', seq: 5, ts: 0, pcm: new Float32Array(10), st: 0 }, { t: 'o', seq: -1, ts: 0, pcm: new Float32Array(FRAME), st: 0 },
            { t: 'o', seq: NaN, ts: 0, pcm: new Float32Array(FRAME), st: 0 }, { t: 'o', seq: 1.5, ts: 0, pcm: new Float32Array(FRAME), st: 0 }, { t: 'zzz' }, null, 7]) {
            expect(() => port.onmessage!({ data: m })).not.toThrow();
        }
        send(p, { type: 'getStats' });
        const st = ofType(p, 'stats').at(-1)!.native as Record<string, number>;
        expect(st.bad - before).toBe(4);
    });
});

describe('native mode: pausing on stalls and resuming', () => {
    const zeroRuns = (out: Float32Array, from: number) => { let r = 0, w = 0; for (let n = from; n < out.length; n++) { r = Math.abs(out[n]) < 1e-9 ? r + 1 : 0; w = Math.max(w, r); } return w; };
    const maxStep = (out: Float32Array, from: number) => { let m = 0; for (let n = from + 1; n < out.length; n++) m = Math.max(m, Math.abs(out[n] - out[n - 1])); return m; };

    it('more than 2 % missing over 5 s PAUSES native (one nativePaused, no nativeFailed), Light plays on without a gap, the port stays open', async () => {
        const { p, port } = await setup();
        const x = signal(48000 * 14);
        const { out } = drive(p, port, x, { delayQ: (s) => (s % 20 === 10 ? null : 1) }); // 5 % missing, forever
        const paused = ofType(p, 'nativePaused');
        expect(paused[0]).toMatchObject({ reason: 'underruns', pauses: 1, resumeFrames: 1000 });
        expect(ofType(p, 'nativeFailed')).toHaveLength(0);
        expect(port.closed).toBe(false);
        expect(zeroRuns(out, 48000)).toBeLessThan(FRAME);
        expect(ofType(p, 'stats').at(-1)!.engineNative).toBe(false);
    });

    it('a stall (replies stop for 0.5 s) pauses, then native resumes after 10 s of on-time replies; both switches are click-free', async () => {
        const { p, port } = await setup();
        const x = signal(48000 * 20);
        const { out } = drive(p, port, x, { delayQ: (s) => (s >= 300 && s < 350 ? null : 1) });
        const paused = ofType(p, 'nativePaused'), resumed = ofType(p, 'nativeResumed');
        expect(paused).toHaveLength(1);
        expect(paused[0]).toMatchObject({ reason: 'no-replies', pauses: 1, resumeFrames: 1000 });
        expect(resumed).toHaveLength(1);
        expect(ofType(p, 'nativeFailed')).toHaveLength(0);
        const st = ofType(p, 'stats').at(-1)!;
        expect(st.engineNative).toBe(true);
        expect((st.native as Record<string, number>).resumed).toBe(1);
        // time-aligned and click-free: after the resume the output is the delayed input again, and no step is bigger than the signal's own slope
        for (let n = 48000 * 17; n < out.length; n += 997) expect(Math.abs(out[n] - x[n - P])).toBeLessThan(1e-6);
        expect(maxStep(out, 48000)).toBeLessThan(0.1);
        expect(zeroRuns(out, 48000)).toBeLessThan(FRAME);
    });

    it('each further pause doubles the wait (10 s, 20 s, 40 s, capped at 60 s) so a machine that cannot keep up does not flap', async () => {
        const { p, port } = await setup();
        const x = signal(48000 * 90);
        // stalls at 3 s, then 2 s after each resume would be; pick fixed frames far apart
        const stalls = [[300, 350], [1800, 1850], [4500, 4550], [8200, 8250]];
        drive(p, port, x, { delayQ: (s) => (stalls.some(([a, b]) => s >= a && s < b) ? null : 1) });
        const paused = ofType(p, 'nativePaused').map(m => m.resumeFrames);
        expect(paused).toEqual([1000, 2000, 4000, 6000].slice(0, paused.length));
        expect(paused.length).toBeGreaterThanOrEqual(3);
        expect(ofType(p, 'nativeFailed')).toHaveLength(0);
    });

    it('a host that never answers again stays paused (Light plays, port open) and is not reported as failed', async () => {
        const { p, port } = await setup();
        const x = signal(48000 * 8);
        const { out } = drive(p, port, x, { delayQ: () => 1, deadAfterQ: Math.floor(48000 * 3 / Q) });
        expect(ofType(p, 'nativePaused')[0]).toMatchObject({ reason: 'no-replies' });
        expect(ofType(p, 'nativeResumed')).toHaveLength(0);
        expect(ofType(p, 'nativeFailed')).toHaveLength(0);
        expect(zeroRuns(out, 48000)).toBeLessThan(FRAME);
        expect(maxStep(out, 48000)).toBeLessThan(0.1);
    });

    it('replies that come back only slowly (late, never on time) never resume', async () => {
        const { p, port } = await setup();
        const x = signal(48000 * 20);
        drive(p, port, x, { delayQ: (s) => (s < 300 ? 1 : 40) });
        expect(ofType(p, 'nativePaused').length).toBeGreaterThanOrEqual(1);
        expect(ofType(p, 'nativeResumed')).toHaveLength(0);
    });
});

describe('native mode: falling back to Light', () => {
    it('a host failure message, or the page reporting the utility process exit, falls back for good immediately and only once', async () => {
        for (const how of ['failed', 'exit'] as const) {
            const { p, port } = await setup();
            const x = signal(48000);
            drive(p, port, x, perfect);
            if (how === 'failed') port.onmessage!({ data: { t: 'failed', error: 'x' } }); else send(p, { type: 'nativeExit' });
            send(p, { type: 'nativeExit' });
            const failed = ofType(p, 'nativeFailed');
            expect(failed).toHaveLength(1);
            expect(failed[0].reason).toBe(how === 'failed' ? 'engine-failed' : 'engine-exit');
        }
    });

    it('nativeOff (Strong switched off) stops native quietly: no failure report, Light plays', async () => {
        const { p, port } = await setup();
        drive(p, port, signal(48000), perfect);
        send(p, { type: 'nativeOff' });
        expect(ofType(p, 'nativeFailed')).toHaveLength(0);
        const o = new Float32Array(Q);
        p.process([[signal(Q)]], [[o]]);
        send(p, { type: 'getStats' });
        expect(ofType(p, 'stats').at(-1)!.engineNative).toBe(false);
    });

    it('nativeOverload (the audio thread itself fell behind) gives Strong up for the call: one failure report, Light plays', async () => {
        const { p, port } = await setup();
        drive(p, port, signal(48000), perfect);
        send(p, { type: 'nativeOverload' });
        send(p, { type: 'nativeOverload' });
        const failed = ofType(p, 'nativeFailed');
        expect(failed).toHaveLength(1);
        expect(failed[0].reason).toBe('render-overload');
        expect(port.posted.at(-1)).toMatchObject({ t: 'bye' }); // the worker is told to stop, so its CPU goes back to the PC
        expect(port.closed).toBe(true);
        const o = new Float32Array(Q);
        p.process([[signal(Q)]], [[o]]);
        send(p, { type: 'getStats' });
        expect(ofType(p, 'stats').at(-1)!.engineNative).toBe(false);
    });

    it('nativeAbort at startup gives the reserved delay back; the worklet is then plain Light', async () => {
        const p = await loadModuleWorklet(CL_AUDIO_WORKLET_SOURCE, 'cl-audio-worklet', { wasmBytes: clAudioWasmBytes(), native: true, nativeJitterFrames: J });
        await waitFor(() => !!p.ready);
        const rBefore = (p as unknown as { rCount: number }).rCount;
        send(p, { type: 'nativeAbort' });
        expect((p as unknown as { rCount: number }).rCount).toBe(rBefore - FRAME * J);
        expect((p as unknown as { natWanted: boolean }).natWanted).toBe(false);
    });
});

describe('native mode: the manual noise gate', () => {
    const GATE = { noise: 1, autoGain: true, manualGainDb: 0, originalSound: false, gate: { enabled: true, thresholdDb: -42 } };
    it('is sent to the host right after the settings ack and before any frame, as its own message', async () => {
        const { p, port } = await setup({ settings: GATE });
        const { log } = drive(p, port, signal(48000 * 2), perfect);
        const g = log.filter(l => l.m.t === 'gate');
        expect(g).toHaveLength(1);
        expect(g[0].m).toMatchObject({ t: 'gate', enabled: true, thresholdDb: -42 });
        expect(log.indexOf(g[0])).toBeLessThan(log.findIndex(l => l.m.t === 'f'));
    });
    it('a change goes out at once without restarting the host (no settings message, frames keep flowing); unchanged resends nothing', async () => {
        const { p, port } = await setup({ settings: GATE });
        const { log } = drive(p, port, signal(48000 * 3), perfect, (q) => {
            if (q === 200) send(p, { type: 'setSettings', ...GATE, gate: { enabled: true, thresholdDb: -30 } });
            if (q === 300) send(p, { type: 'setSettings', ...GATE, gate: { enabled: true, thresholdDb: -30 } });
            if (q === 400) send(p, { type: 'setSettings', ...GATE, gate: { enabled: false, thresholdDb: -30 } });
        });
        expect(log.filter(l => l.m.t === 'gate').map(l => `${l.m.enabled}:${l.m.thresholdDb}`)).toEqual(['true:-42', 'true:-30', 'false:-30']);
        expect(log.filter(l => l.m.t === 's')).toHaveLength(1);
        expect(ofType(p, 'nativePaused')).toHaveLength(0);
    });
    it('the played samples are not gated a second time: gate off, native output is bit-exact', async () => {
        const { p, port } = await setup();
        const x = signal(48000 * 2);
        const { out } = drive(p, port, x, perfect);
        for (let n = 48000; n < out.length; n += 997) expect(Math.abs(out[n] - x[n - P])).toBeLessThan(1e-6);
    });
});

describe('native mode: remembered microphone gain', () => {
    it('is sent to the host once, right after the settings are acknowledged (before any frame)', async () => {
        const { p, port } = await setup({ initialDeviceGainDb: 12.5 });
        const { log } = drive(p, port, signal(48000 * 2), perfect);
        const g = log.filter(l => l.m.t === 'g');
        expect(g).toHaveLength(1);
        expect(g[0].m).toMatchObject({ t: 'g', db: 12.5 });
        const firstFrame = log.findIndex(l => l.m.t === 'f');
        expect(log.indexOf(g[0])).toBeLessThan(firstFrame);
    });
    it('nothing is sent when no gain is remembered', async () => {
        const { p, port } = await setup();
        const { log } = drive(p, port, signal(48000), perfect);
        expect(log.filter(l => l.m.t === 'g')).toHaveLength(0);
    });
});

describe('native mode: bench-only knobs', () => {
    it('nativeNoise picks the profile asked of the host; nativeNoFail keeps counting instead of giving up', async () => {
        const { p, port } = await setup({ nativeNoise: 1, nativeNoFail: true });
        const { log } = drive(p, port, signal(48000 * 6), { delayQ: () => null });
        expect(log.find(l => l.m.t === 's')!.m).toMatchObject({ noise: 1 });
        expect(ofType(p, 'nativeFailed')).toHaveLength(0);
        const st = ofType(p, 'stats').at(-1)!.native as Record<string, number | boolean>;
        expect(st.failed).toBe(false);
        expect(st.underrun as number).toBeGreaterThan(300);
    });
    it('without the knobs the default is Strong and a silent host pauses native', async () => {
        const { p, port } = await setup();
        const { log } = drive(p, port, signal(48000 * 6), { delayQ: () => null });
        expect(log.find(l => l.m.t === 's')!.m).toMatchObject({ noise: 2 });
        expect(ofType(p, 'nativePaused')).toHaveLength(1);
    });
});

describe('native mode: settings', () => {
    it('a settings change that matters restarts the host once (debounced), frames stop until the ack, no failure meanwhile', async () => {
        const { p, port } = await setup();
        const x = signal(48000 * 6);
        let changedAt = -1;
        const { log } = drive(p, port, x, { delayQ: () => 1, ackDelayQ: 1 }, (q) => {
            if (q === 400) {
                changedAt = q;
                for (let i = 0; i < 5; i++) send(p, { type: 'setSettings', noise: 1, autoGain: false, manualGainDb: i, originalSound: false });
            }
        });
        const ss = log.filter(l => l.m.t === 's');
        expect(ss.length).toBe(2);                                   // the initial one and exactly one for the five changes
        expect(ss[1].q).toBeGreaterThanOrEqual(changedAt + 148);       // debounced ~400 ms
        expect(ss[1].m).toMatchObject({ autoGain: false, manualGainDb: 4, noise: 2 });
        const gap = log.filter(l => l.m.t === 'f' && l.q > ss[1].q && l.q <= ss[1].q + 1);
        expect(gap.length).toBe(0);
        expect(ofType(p, 'nativeFailed')).toHaveLength(0);
        // frames resume after the ack
        expect(log.filter(l => l.m.t === 'f' && l.q > ss[1].q + 2).length).toBeGreaterThan(100);
    });

    it('a lone change restarts the host once; the hold is not counted as an underrun or a failure', async () => {
        const { p, port } = await setup();
        const x = signal(48000 * 8);
        const { log } = drive(p, port, x, { delayQ: () => 1, ackDelayQ: 1 }, (q) => {
            if (q === 400) send(p, { type: 'setSettings', noise: 1, autoGain: false, manualGainDb: 3, originalSound: false });
        });
        const st = ofType(p, 'stats').at(-1)!.native as Record<string, number | boolean>;
        expect(st.failed).toBe(false);
        expect(log.filter(l => l.m.t === 's').length).toBe(2);
        expect(st.underrun).toBe(0);
    });

    it('the mic volume while auto gain is on is a pre-gain the host must apply too: it goes out live once (\'sl\'), with no restart (no second \'s\')', async () => {
        const { p, port } = await setup();
        const { log } = drive(p, port, signal(48000 * 3), perfect, (q) => {
            if (q === 100) send(p, { type: 'setSettings', noise: 1, autoGain: true, manualGainDb: 12, originalSound: false });
        });
        expect(log.filter(l => l.m.t === 's').length).toBe(1);
        const live = log.filter(l => l.m.t === 'sl');
        expect(live).toHaveLength(1);
        expect(live[0].m).toMatchObject({ t: 'sl', autoGain: true, manualGainDb: 12, noise: 2, originalSound: false });
        expect(live[0].q).toBeLessThanOrEqual(100 + 40);   // ~100 ms, not the ~400 ms restart debounce
    });
});

/**
 * Report 348d6f9b (2026-11-25, owner, i5-13600HX): "pc switched to light even though I have a good computer". Native Strong had no
 * underruns at all; the owner dragged the Input volume slider with Strong + auto gain on (100 -> 196 -> 31 -> 13 -> 100 -> 200 %) and
 * Strong was given up with "ack-timeout". With the gain in the restart key every slider move restarted the stream (frames held until an
 * ack, Light played meanwhile); a restart that is not answered is what times out and announces the fallback.
 */
describe('native mode: in-call settings never drop Strong (report 348d6f9b)', () => {
    const OWNER_PCTS = [100, 196, 31, 13, 100, 200];
    const forPct = (micVolume: number) => engineSettingsFor({ noiseSuppression: true, noiseSuppressionMode: 'strong', volumeNormalization: true, micVolume });
    const DRAG_START_Q = 600;      // ~1.6 s: native is up and past its start-up grace
    const STEP_Q = 3;              // a drag posts a change every ~8 ms
    const STEPS = 12;              // per move
    const HOLD_Q = 150;            // ~0.4 s on each target before the next move
    /** the owner's drag, as the page posts it: every slider step is a setSettings */
    const ownerDrag = (p: Proc) => {
        const plan = new Map<number, ReturnType<typeof forPct>>();
        let q = DRAG_START_Q;
        for (let i = 1; i < OWNER_PCTS.length; i++) {
            const a = OWNER_PCTS[i - 1], b = OWNER_PCTS[i];
            for (let k = 1; k <= STEPS; k++) { plan.set(q, forPct(Math.round(a + ((b - a) * k) / STEPS))); q += STEP_Q; }
            q += HOLD_Q;
        }
        return { end: q, hook: (at: number) => { const s = plan.get(at); if (s) send(p, { type: 'setSettings', ...s }); } };
    };
    const playedNative = (out: Float32Array, x: Float32Array, from: number) => {
        let bad = 0, n0 = 0;
        for (let n = from; n < out.length; n++) { n0++; if (Math.abs(out[n] - x[n - P]) > 1e-7) bad++; }
        return 1 - bad / n0;
    };

    it('a fast mic-volume drag with auto gain on keeps native Strong playing every frame: no restart, no hold, no pause, no failure', async () => {
        const { p, port } = await setup({ settings: forPct(100) });
        const x = signal(48000 * 8);
        const drag = ownerDrag(p);
        const { out, log, frames } = drive(p, port, x, perfect, drag.hook);
        expect(drag.end * Q).toBeLessThan(x.length - 48000);   // the whole drag ran, with a second of audio after it

        // no restart of the host's stream: the one settings message is the start-up one
        expect(log.filter(l => l.m.t === 's')).toHaveLength(1);
        // the mic volume reached the host live, throttled (one per ~100 ms at most), ending on the final value
        const live = log.filter(l => l.m.t === 'sl');
        expect(live.length).toBeGreaterThanOrEqual(OWNER_PCTS.length - 1);
        expect(live.length).toBeLessThanOrEqual(Math.ceil((drag.end - DRAG_START_Q) / 38) + 1);
        expect(live.at(-1)!.m.manualGainDb).toBe(forPct(200).manualGainDb);
        for (let i = 1; i < live.length; i++) expect(live[i].q - live[i - 1].q).toBeGreaterThanOrEqual(38);

        // frames never stopped (a restart holds them until the ack)
        for (let i = 1; i < frames.length; i++) expect(frames[i].seq).toBe(frames[i - 1].seq! + 1);
        // every sample from the start of the drag on is the native engine's (the echo host): Light never stood in
        expect(playedNative(out, x, DRAG_START_Q * Q)).toBeGreaterThan(0.9999);

        expect(ofType(p, 'nativePaused')).toHaveLength(0);
        expect(ofType(p, 'nativeFailed')).toHaveLength(0);
        const st = ofType(p, 'stats').at(-1)!;
        expect(st.engineNative).toBe(true);
        expect(st.native).toMatchObject({ active: true, failed: false, paused: false, underrun: 0 });
    });

    it('the owner\'s exact failure: the same drag against a host that never acknowledges a later settings change does not end in "ack-timeout" (nothing waits for one)', async () => {
        const { p, port } = await setup({ settings: forPct(100) });
        // 28 s: past the 20 s acknowledgement timeout counted from the drag's last change (~4.5 s in)
        const x = signal(48000 * 28);
        const drag = ownerDrag(p);
        const { log } = drive(p, port, x, { delayQ: () => 1, ackFor: (id) => (id === 1 ? 1 : null) }, drag.hook);
        expect(ofType(p, 'nativeFailed').map(m => m.reason)).toEqual([]);   // staging before the fix: ['ack-timeout'], as in the report
        expect(log.filter(l => l.m.t === 's')).toHaveLength(1);
        expect(ofType(p, 'nativePaused')).toHaveLength(0);
        const st = ofType(p, 'stats').at(-1)!;
        expect(st.engineNative).toBe(true);
        expect(st.native).toMatchObject({ failed: false, reason: '' });
    });

    it('an EQ toggle (page-side biquads: the engine settings are unchanged) sends the host nothing and Strong keeps playing', async () => {
        const { p, port } = await setup({ settings: forPct(100) });
        const x = signal(48000 * 5);
        const same = forPct(100);
        const { out, log, frames } = drive(p, port, x, perfect, (q) => {
            if (q === 600 || q === 640 || q === 900 || q === 1200) send(p, { type: 'setSettings', ...same });
        });
        expect(log.filter(l => l.m.t === 's')).toHaveLength(1);
        expect(log.filter(l => l.m.t === 'sl')).toHaveLength(0);
        for (let i = 1; i < frames.length; i++) expect(frames[i].seq).toBe(frames[i - 1].seq! + 1);
        expect(playedNative(out, x, 600 * Q)).toBeGreaterThan(0.9999);
        expect(ofType(p, 'nativeFailed')).toHaveLength(0);
        expect(ofType(p, 'nativePaused')).toHaveLength(0);
        expect(ofType(p, 'stats').at(-1)!.engineNative).toBe(true);
    });

    it('a change that does rebuild the host\'s chain (auto gain switched off) is a deliberate restart: no failure, no notice, and it comes back as Strong', async () => {
        const off = engineSettingsFor({ noiseSuppression: true, noiseSuppressionMode: 'strong', volumeNormalization: false, micVolume: 150 });
        const { p, port } = await setup({ settings: forPct(100) });
        const x = signal(48000 * 8);
        const { out, log } = drive(p, port, x, perfect, (q) => {
            // a drag of the slider with auto gain off: debounced into ONE restart
            if (q === 600) send(p, { type: 'setSettings', ...off, manualGainDb: 1 });
            if (q === 610) send(p, { type: 'setSettings', ...off, manualGainDb: 2 });
            if (q === 620) send(p, { type: 'setSettings', ...off });
        });
        const ss = log.filter(l => l.m.t === 's');
        expect(ss).toHaveLength(2);
        expect(ss[1].m).toMatchObject({ autoGain: false, manualGainDb: off.manualGainDb });
        expect(ofType(p, 'nativeFailed')).toHaveLength(0);
        expect(ofType(p, 'nativePaused')).toHaveLength(0);
        const st = ofType(p, 'stats').at(-1)!;
        expect(st.engineNative).toBe(true);
        expect(st.native).toMatchObject({ failed: false, paused: false, underrun: 0 });
        // native again well after the restart
        expect(playedNative(out, x, 48000 * 5)).toBeGreaterThan(0.9999);
    });

    it('auto gain switched off and back on before the restart went out cancels it; only the mic volume (if it moved) goes out live', async () => {
        const { p, port } = await setup({ settings: forPct(100) });
        const { log } = drive(p, port, signal(48000 * 4), perfect, (q) => {
            if (q === 600) send(p, { type: 'setSettings', ...forPct(100), autoGain: false });
            if (q === 650) send(p, { type: 'setSettings', ...forPct(150) });
        });
        expect(log.filter(l => l.m.t === 's')).toHaveLength(1);
        const live = log.filter(l => l.m.t === 'sl');
        expect(live).toHaveLength(1);
        expect(live[0].m.manualGainDb).toBe(forPct(150).manualGainDb);
        expect(ofType(p, 'nativeFailed')).toHaveLength(0);
    });
});

describe('native mode: off by default', () => {
    it('without processorOptions.native nothing changes: prime stays 448, no native stats', async () => {
        const p = await loadModuleWorklet(CL_AUDIO_WORKLET_SOURCE, 'cl-audio-worklet', { wasmBytes: clAudioWasmBytes() });
        await waitFor(() => !!p.ready);
        expect(ofType(p, 'ready')[0]).toMatchObject({ primeSamples: CL_AUDIO_PRIME_SAMPLES, native: false });
        const o = new Float32Array(Q);
        for (let k = 0; k < 400; k++) p.process([[signal(Q)]], [[o]]);
        const st = ofType(p, 'stats').at(-1)!;
        expect(st.engineNative).toBe(false);
        expect(st.native).toBeNull();
        send(p, { type: 'nativePort', port: { postMessage() { /* never used */ } } });
        send(p, { type: 'nativeExit' });
        expect(ofType(p, 'nativeFailed')).toHaveLength(0);
    });
});

/**
 * Replays a RECORDED hand-off (scripts/audio-native-bench results.json, env CL_NATIVE_TRACE=<file> [CL_NATIVE_TRACE_STEP=<name part>]) through
 * the real worklet: each frame's reply is delayed by its recorded round trip, frames with no recorded reply are never answered. Prints how
 * often native paused and resumed. Skipped without the env var (the traces are measurements, not fixtures).
 */
describe.skipIf(!process.env.CL_NATIVE_TRACE)('native mode: replay of a recorded trace', () => {
    it('pauses on the recorded stalls, resumes after healthy stretches, never fails, never leaves a hole', async () => {
        const { readFileSync } = await import('node:fs');
        const all = JSON.parse(readFileSync(process.env.CL_NATIVE_TRACE!, 'utf8')).results as { step: { name: string }; res: { trace?: number[] } }[];
        const r = all.find(x => x.step.name.includes(process.env.CL_NATIVE_TRACE_STEP ?? 'S2') && x.res?.trace)!;
        const rtt = new Map<number, number>();
        for (let i = 0; i + 3 < r.res.trace!.length; i += 4) rtt.set(r.res.trace![i + 3], r.res.trace![i]);
        const seqs = [...rtt.keys()].sort((a, b) => a - b);
        const first = seqs[0], last = seqs[seqs.length - 1];
        const { p, port } = await setup({ nativeNoFail: false });
        const x = signal(Math.min(48000 * 300, (last - first) * FRAME));
        const { out } = drive(p, port, x, { delayQ: (s) => { const v = rtt.get(s + first); return v === undefined ? null : Math.max(1, Math.ceil(v * 48 / Q) + 1); } });
        const paused = ofType(p, 'nativePaused'), resumed = ofType(p, 'nativeResumed');
        process.stderr.write(`trace replay (${r.step.name}): ${paused.length} pauses (${paused.map(m => m.reason).join(',')}), ${resumed.length} resumes, native active at end: ${ofType(p, "stats").at(-1)!.engineNative}\n`);
        expect(ofType(p, 'nativeFailed')).toHaveLength(0);
        let z = 0, w = 0; for (let n = 48000; n < out.length; n++) { z = Math.abs(out[n]) < 1e-9 ? z + 1 : 0; w = Math.max(w, z); }
        expect(w).toBeLessThan(FRAME);
        let m = 0; for (let n = 48001; n < out.length; n++) m = Math.max(m, Math.abs(out[n] - out[n - 1]));
        expect(m).toBeLessThan(0.1);
    });
});
