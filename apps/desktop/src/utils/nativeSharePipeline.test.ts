import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startNativeSharePipeline, startFailureLatchesNative, type NativeShareApi, type NativeShareParams } from './nativeSharePipeline';
import { NATIVE_AU_KIND, NATIVE_STATUS_KIND } from './nativeShareWorker';

// Browser globals the dummy generator track needs (the test runs in node).
class FakeFrame { close() {} }
class FakeGenerator {
    id = 'gen-track-1'; stopped = false; written = 0;
    writable = { getWriter: () => ({ write: async () => { this.written++; }, close: async () => {} }) };
    stop() { this.stopped = true; }
}

function fakes() {
    let onEvent: ((ev: unknown) => void) | null = null, onExit: ((x: { code: number; reason: string }) => void) | null = null;
    const calls: { start: unknown[]; stop: number } = { start: [], stop: 0 };
    const api: NativeShareApi = {
        available: async () => ({ helper: true }),
        start: async (a) => { calls.start.push(a); return { ok: true }; },
        stop: async () => { calls.stop++; return { ok: true }; },
        probe: async () => ({ vaapi: false, nvenc: true }),
        onEvent: (cb) => { onEvent = cb; return () => { onEvent = null; }; },
        onExit: (cb) => { onExit = cb; return () => { onExit = null; }; },
    };
    const workerListeners = new Set<(e: MessageEvent) => void>();
    const posted: unknown[] = [];
    const worker = {
        postMessage: (m: unknown) => { posted.push(m); },
        addEventListener: (_t: 'message', cb: (e: MessageEvent) => void) => { workerListeners.add(cb); },
        removeEventListener: (_t: 'message', cb: (e: MessageEvent) => void) => { workerListeners.delete(cb); },
    };
    const target = { addEventListener() {}, removeEventListener() {} } as unknown as Window;
    return {
        api, worker, target, calls, posted, workerListeners,
        emit: (ev: unknown) => onEvent?.(ev), exit: (x: { code: number; reason: string }) => onExit?.(x),
        fromWorker: (m: unknown) => { for (const l of [...workerListeners]) l({ data: m } as MessageEvent); },
        listening: () => onEvent !== null,
    };
}

const params: NativeShareParams = { backend: 'nvenc', maxWidth: 3440, maxHeight: 1440, fps: 90, bitrateBps: 30_000_000, source: 'any', restoreToken: null };
const FORMAT = { event: 'format', srcW: 3440, srcH: 1440, w: 3440, h: 1440, encoder: 'nvenc', gpu: 'RTX 5070' };

beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as Record<string, unknown>).MediaStreamTrackGenerator = FakeGenerator;
    (globalThis as Record<string, unknown>).VideoFrame = FakeFrame;
});
afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).MediaStreamTrackGenerator;
    delete (globalThis as Record<string, unknown>).VideoFrame;
});

/** Start and answer with the first `format` event after `start` resolves. */
async function startOk(f: ReturnType<typeof fakes>, extra: Partial<Parameters<typeof startNativeSharePipeline>[0]> = {}) {
    const p = startNativeSharePipeline({ api: f.api, worker: f.worker, params, target: f.target, ...extra });
    await vi.advanceTimersByTimeAsync(0);
    f.emit(FORMAT);
    await vi.advanceTimersByTimeAsync(400);
    return p;
}

describe('startNativeSharePipeline', () => {
    it('starts the helper in capture mode, waits for the first format, and returns a pipeline with the helper\'s sizes', async () => {
        const f = fakes();
        const r = await startOk(f);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(f.calls.start[0]).toMatchObject({ backend: 'nvenc', width: 3440, height: 1440, fps: 90, capture: { source: 'any', persist: true } });
        expect(r.pipeline.info).toMatchObject({ width: 3440, height: 1440, srcWidth: 3440, srcHeight: 1440 });
        expect(r.pipeline.encoder).toBe('nvenc');
        expect(r.pipeline.publishOptions).toMatchObject({ videoCodec: 'h264', simulcast: false });
    });
    it('passes a stored restore token, and reports a NEW one from the portal event for the next share', async () => {
        const f = fakes(); const saved: string[] = [];
        const r = await startOk(f, { params: { ...params, restoreToken: 'old_tok' }, onRestoreToken: (t) => saved.push(t) });
        expect(r.ok).toBe(true);
        expect((f.calls.start[0] as { capture: { restoreToken: string } }).capture.restoreToken).toBe('old_tok');
        f.emit({ event: 'portal', restoreToken: 'new_tok' });
        expect(saved).toEqual(['new_tok']);
    });
    it('FALLBACK: a helper that exits before the first frame (portal denied) is an explicit failure with the reason, and everything is torn down', async () => {
        const f = fakes();
        const p = startNativeSharePipeline({ api: f.api, worker: f.worker, params, target: f.target });
        await vi.advanceTimersByTimeAsync(0);
        f.exit({ code: 12, reason: 'portal_denied' });
        const r = await p;
        expect(r).toEqual({ ok: false, reason: 'portal_denied' });
        expect(f.calls.stop).toBe(1);
        expect(f.listening()).toBe(false);
        expect(f.workerListeners.size).toBe(0);
    });
    it('FALLBACK: start rejected by main (invalid args / helper missing), no format ever comes, and a timeout all fail cleanly', async () => {
        const f = fakes();
        f.api.start = async () => ({ ok: false, error: 'helper missing' });
        expect(await startNativeSharePipeline({ api: f.api, worker: f.worker, params, target: f.target })).toEqual({ ok: false, reason: 'start_rejected', detail: 'helper missing' });
        const g = fakes();
        const p = startNativeSharePipeline({ api: g.api, worker: g.worker, params, target: g.target, startTimeoutMs: 5000 });
        await vi.advanceTimersByTimeAsync(5100);
        expect(await p).toEqual({ ok: false, reason: 'start_timeout' });
        expect(g.calls.stop).toBe(1);
    });
    it('FALLBACK: no MediaStreamTrackGenerator (an old Chromium) is reported, never thrown', async () => {
        delete (globalThis as Record<string, unknown>).MediaStreamTrackGenerator;
        const f = fakes();
        const r = await startNativeSharePipeline({ api: f.api, worker: f.worker, params, target: f.target });
        expect(r).toMatchObject({ ok: false, reason: 'no_track_generator' });
        expect(f.calls.start.length).toBe(0);
    });
    it('1:1 pacing: one dummy frame per access unit the worker reports; other tracks\' messages are ignored', async () => {
        const f = fakes();
        const r = await startOk(f);
        if (!r.ok) throw new Error('start failed');
        const w0 = r.pipeline.stats().written;
        f.fromWorker({ kind: NATIVE_AU_KIND, data: { trackId: 'gen-track-1', key: true } });
        f.fromWorker({ kind: NATIVE_AU_KIND, data: { trackId: 'someone-else', key: true } });
        await vi.advanceTimersByTimeAsync(0);
        expect(r.pipeline.stats().written).toBe(w0 + 1);
    });
    it('CHOOSER: a portal chooser that takes 10 s still engages native; the worker is told to arm its stall watchdog only AFTER the format', async () => {
        const f = fakes();
        const p = startNativeSharePipeline({ api: f.api, worker: f.worker, params, target: f.target });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(f.posted.some((m) => (m as { kind?: string }).kind === 'cl:native-arm')).toBe(false);
        f.emit(FORMAT);
        await vi.advanceTimersByTimeAsync(400);
        const r = await p;
        expect(r.ok).toBe(true);
        expect(f.posted.filter((m) => (m as { kind?: string }).kind === 'cl:native-arm')).toEqual([{ kind: 'cl:native-arm', data: { trackId: 'gen-track-1' } }]);
    });
    it('CHOOSER: a cancelled chooser (helper exits before any frame) is a clean failure carrying the reason', async () => {
        const f = fakes();
        const p = startNativeSharePipeline({ api: f.api, worker: f.worker, params, target: f.target });
        await vi.advanceTimersByTimeAsync(7000);
        f.exit({ code: 3, reason: 'portal_denied' });
        const r = await p;
        expect(r).toMatchObject({ ok: false, reason: 'portal_denied' });
    });
    it('LIVE FAILURE: the worker\'s injection watchdog declaring the helper dead ends the share once, with a reason', async () => {
        const f = fakes();
        const r = await startOk(f);
        if (!r.ok) throw new Error('start failed');
        const reasons: string[] = [];
        r.pipeline.onSourceEnded((x) => reasons.push(x));
        f.fromWorker({ kind: NATIVE_STATUS_KIND, data: { trackId: 'gen-track-1', state: 'dead' } });
        f.exit({ code: 4, reason: 'encode_failed' });                  // a second signal must not double-fire
        expect(reasons).toEqual(['injection_watchdog']);
    });
    it('LIVE FAILURE: the compositor stopping the source and a helper crash are reported; a late subscriber is told too', async () => {
        const f = fakes();
        const r = await startOk(f);
        if (!r.ok) throw new Error('start failed');
        f.emit({ event: 'ended', reason: 'the screen source stopped' });
        const late: string[] = [];
        r.pipeline.onSourceEnded((x) => late.push(x));
        await vi.advanceTimersByTimeAsync(0);
        expect(late).toEqual(['source_ended:the screen source stopped']);
    });
    it('user stop is silent (no "ended" callback), idempotent, and stops the helper exactly once', async () => {
        const f = fakes();
        const r = await startOk(f);
        if (!r.ok) throw new Error('start failed');
        const reasons: string[] = [];
        r.pipeline.onSourceEnded((x) => reasons.push(x));
        r.pipeline.stop(); r.pipeline.stop();
        f.exit({ code: 0, reason: 'stopped' });                         // main reports the helper's exit AFTER our stop
        expect(reasons).toEqual([]);
        expect(f.calls.stop).toBe(1);
    });
    it('exposes the helper\'s live numbers (encoder, fps, size) for the stats overlay', async () => {
        const f = fakes();
        const r = await startOk(f);
        if (!r.ok) throw new Error('start failed');
        f.emit({ event: 'stats', encoder: 'nvenc', w: 3440, h: 1440, fps: 90, dropped: 1, encMsP95: 4.2, kbps: 28000, effFps: 90 });
        expect(r.pipeline.liveStats()).toMatchObject({ encoder: 'nvenc', width: 3440, height: 1440, fps: 90, kbps: 28000 });
        expect(r.pipeline.captureSettings()).toMatchObject({ width: 3440, height: 1440, frameRate: 90 });
    });
});

describe('startNativeSharePipeline: the lighter copy (lowerLayer)', () => {
    const lowMsgs = (f: ReturnType<typeof fakes>) => f.posted.filter((m) => (m as { kind?: string }).kind === 'cl:native-low').map((m) => (m as { data: Record<string, unknown> }).data);

    it('publishes a 2-layer simulcast like the Chromium share (rids q/h come from LiveKit): low preset 720p, h264, no backup codec', async () => {
        const f = fakes();
        const r = await startOk(f, { lowerLayer: true });
        if (!r.ok) throw new Error('start failed');
        expect(r.pipeline.lowerLayer).toBe(true);
        const o = r.pipeline.publishOptions as unknown as { simulcast: boolean; videoCodec: string; backupCodec: unknown; screenShareSimulcastLayers: { width: number; height: number; encoding: { maxFramerate: number; maxBitrate: number } }[]; screenShareEncoding: { maxBitrate: number } };
        expect(o).toMatchObject({ simulcast: true, videoCodec: 'h264', backupCodec: false });
        expect(o.screenShareSimulcastLayers).toHaveLength(1);
        expect(o.screenShareSimulcastLayers[0]).toMatchObject({ width: 1280, height: 720 });
        expect(o.screenShareSimulcastLayers[0].encoding.maxFramerate).toBe(30);       // shareLowEncoding's ceiling, the Chromium path's number
        expect(o.screenShareEncoding.maxBitrate).toBe(30_000_000);                    // the FULL layer advertises its real ceiling to the SFU
    });
    it('the port bind tells the worker it is a 2-layer session', async () => {
        const f = fakes(); const listeners: ((ev: MessageEvent) => void)[] = [];
        const target = { addEventListener: (_t: string, cb: (ev: MessageEvent) => void) => { listeners.push(cb); }, removeEventListener() {} } as unknown as Window;
        const r = await startOk(f, { lowerLayer: true, target });
        if (!r.ok) throw new Error('start failed');
        const port = {} as MessagePort;
        for (const l of listeners) l({ source: target, data: { kind: 'cl:native-share-port' }, ports: [port] } as unknown as MessageEvent);
        expect((f.posted.find((m) => (m as { kind?: string }).kind === 'cl:native-share') as { data: { layers?: number } }).data.layers).toBe(2);
    });
    it('NEGATIVE CONTROL: without lowerLayer it is the old single-layer share, and setLowLayer does nothing', async () => {
        const f = fakes();
        const r = await startOk(f);
        if (!r.ok) throw new Error('start failed');
        expect(r.pipeline.lowerLayer).toBe(false);
        expect(r.pipeline.publishOptions).toMatchObject({ simulcast: false });
        r.pipeline.setLowLayer(true);
        expect(lowMsgs(f)).toEqual([]);
    });
    it('setLowLayer(true) asks the worker for the helper session at the Chromium path\'s size/rate/bitrate; false closes it; repeats are idempotent', async () => {
        const f = fakes();
        const r = await startOk(f, { lowerLayer: true });
        if (!r.ok) throw new Error('start failed');
        r.pipeline.setLowLayer(true); r.pipeline.setLowLayer(true);
        expect(lowMsgs(f)).toEqual([{ trackId: 'gen-track-1', on: true, w: 1720, h: 720, fps: 30, bps: expect.any(Number) }]);
        expect((lowMsgs(f)[0].bps as number)).toBeGreaterThanOrEqual(300_000);
        r.pipeline.setLowLayer(false);
        expect(lowMsgs(f)[1]).toEqual({ trackId: 'gen-track-1', on: false });
    });
    it('a new source size while the copy is wanted re-asks the helper at the new size', async () => {
        const f = fakes();
        const r = await startOk(f, { lowerLayer: true });
        if (!r.ok) throw new Error('start failed');
        r.pipeline.setLowLayer(true);
        f.emit({ ...FORMAT, srcW: 1600, srcH: 900, w: 1600, h: 900 });
        const last = lowMsgs(f)[lowMsgs(f).length - 1];
        expect(last).toMatchObject({ on: true, w: 800, h: 450 });                       // < 1000 px short side: half size, never upscaled
    });
    it('FAILURE IS NOT FATAL: low_failed latches the copy off, tells the gate, never ends the share, and later asks are no-ops', async () => {
        const f = fakes();
        const r = await startOk(f, { lowerLayer: true });
        if (!r.ok) throw new Error('start failed');
        const ended: string[] = [], failed: string[] = [];
        r.pipeline.onSourceEnded((x) => ended.push(x));
        r.pipeline.onLowLayerFailed((c) => failed.push(c));
        r.pipeline.setLowLayer(true);
        const before = lowMsgs(f).length;
        f.emit({ event: 'low_failed', code: 'low_session_limit', message: 'out of NVENC sessions' });
        expect(failed).toEqual(['low_session_limit']);
        expect(ended).toEqual([]);                                                     // the share continues, single layer
        expect(r.pipeline.lowLayerFacts().blocked).toMatch(/low_session_limit/);
        r.pipeline.setLowLayer(false); r.pipeline.setLowLayer(true);
        expect(lowMsgs(f).length).toBe(before);                                        // never retried this share
        const late: string[] = []; r.pipeline.onLowLayerFailed((c) => late.push(c));
        await vi.advanceTimersByTimeAsync(0);
        expect(late).toEqual(['low_session_limit']);                                   // a late subscriber is told too
    });
    it('the gate\'s facts come from the helper, not from the dummy track: hardware unless the pcm test backend, real short side', async () => {
        const f = fakes();
        const r = await startOk(f, { lowerLayer: true });
        if (!r.ok) throw new Error('start failed');
        f.emit({ event: 'stats', encoder: 'nvenc', w: 3440, h: 1440, fps: 90, dropped: 0, encMsP95: 4.2, kbps: 28000, effFps: 90 });
        expect(r.pipeline.lowLayerFacts()).toEqual({ hardware: true, topShort: 1440, encodeMs: 4.2, blocked: null });
        const g = fakes();
        const p = startNativeSharePipeline({ api: g.api, worker: g.worker, params, target: g.target, lowerLayer: true });
        await vi.advanceTimersByTimeAsync(0); g.emit({ ...FORMAT, encoder: 'pcm' }); await vi.advanceTimersByTimeAsync(400);
        const rp = await p; if (!rp.ok) throw new Error('start failed');
        expect(rp.pipeline.lowLayerFacts().hardware).toBe(false);
    });
    it('NEGATIVE: nothing is asked of the helper after the share is stopped', async () => {
        const f = fakes();
        const r = await startOk(f, { lowerLayer: true });
        if (!r.ok) throw new Error('start failed');
        r.pipeline.stop();
        r.pipeline.setLowLayer(true);
        expect(lowMsgs(f)).toEqual([]);
    });
});

describe('startNativeSharePipeline: the sender advertises the share\'s REAL target (report bcde1655: avail pinned ~3.2 Mbps)', () => {
    const senderOf = (trackId: string, encodings: { rid?: string; maxBitrate?: number }[]) => {
        const set = vi.fn(async () => {});
        const sender = { track: { id: trackId }, getParameters: () => ({ encodings: encodings.map((e) => ({ ...e })) }), setParameters: set };
        return { pc: { getSenders: () => [sender], getStats: async () => new Map() } as unknown as RTCPeerConnection, set };
    };
    it('single layer: the dummy advertises the share target, not the old 400 kbps', async () => {
        const f = fakes(); const r = await startOk(f);
        if (!r.ok) throw new Error('start failed');
        expect((r.pipeline.publishOptions as unknown as { videoEncoding: { maxBitrate: number } }).videoEncoding.maxBitrate).toBe(params.bitrateBps);
    });
    it('afterPublish sets the full layer to the share target (not a 2 Mbps cap) and the lighter copy keeps its own ceiling', async () => {
        const f = fakes(); const r = await startOk(f, { lowerLayer: true });
        if (!r.ok) throw new Error('start failed');
        const { pc, set } = senderOf('gen-track-1', [{ rid: 'q', maxBitrate: 1_200_000 }, { rid: 'h', maxBitrate: 5_000_000 }]);
        await r.pipeline.afterPublish(pc);
        const enc = (set.mock.calls[0] as unknown as [{ encodings: { rid: string; maxBitrate: number }[] }])[0].encodings;
        expect(enc.find((e) => e.rid === 'h')!.maxBitrate).toBe(Math.max(400_000, params.bitrateBps));
        expect(enc.find((e) => e.rid === 'q')!.maxBitrate).toBe(1_200_000);
        r.pipeline.stop();
    });
});

describe('startFailureLatchesNative', () => {
    it('a cancelled / timed-out chooser and a start-time stall do NOT latch native off for the session; real encoder/helper failures do', () => {
        for (const r of ['portal_denied', 'start_timeout', 'injection_watchdog']) expect(startFailureLatchesNative(r)).toBe(false);
        for (const r of ['encode_failed', 'encoder_open_failed', 'driver_too_old', 'no_frames', 'start_rejected', 'no_track_generator']) expect(startFailureLatchesNative(r)).toBe(true);
    });
});
