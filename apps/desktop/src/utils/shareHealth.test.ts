import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    readShareEncoderSnapshot, buildShareFpsDetail, ShareStatsSampler, ShareEncoderWatchdog,
    decideStallAction, stallToastCopy, STALL_MS, SHARE_FPS_INTERVAL_MS, SHARE_FPS_FOCUS_DELAY_MS,
    type StatsLike, type ShareEncoderSnapshot, type EncoderStall,
} from './shareHealth';
import { MAX_RESOLUTION_STEP } from './shareEncoderLimits';
import { CALL_EVENT_KINDS, logCallEvent, getCallEvents, clearCallEvents, validateCallEvent } from './callEventLog';

type Stat = Record<string, unknown>;
const report = (...stats: Stat[]): StatsLike => ({ forEach: cb => stats.forEach(cb) });
const outbound = (over: Stat = {}): Stat => ({
    type: 'outbound-rtp', kind: 'video', active: true,
    frameWidth: 3840, frameHeight: 720, framesEncoded: 0, framesPerSecond: 0,
    qualityLimitationReason: 'none', encoderImplementation: 'ExternalEncoder', powerEfficientEncoder: true,
    ...over,
});
const source = (over: Stat = {}): Stat => ({ type: 'media-source', kind: 'video', framesPerSecond: 88, frames: 1000, ...over });

describe('readShareEncoderSnapshot', () => {
    it('reads the largest ACTIVE layer and sums frames encoded over active layers', () => {
        const snap = readShareEncoderSnapshot(report(
            outbound({ frameWidth: 1280, frameHeight: 720, framesEncoded: 100, framesPerSecond: 30, encoderImplementation: 'small' }),
            outbound({ frameWidth: 3840, frameHeight: 720, framesEncoded: 400, framesPerSecond: 88, encoderImplementation: 'NvEncoder', qualityLimitationReason: 'cpu' }),
            outbound({ frameWidth: 7680, frameHeight: 1440, framesEncoded: 999, active: false, encoderImplementation: 'paused' }),
            source({ framesPerSecond: 91 }),
        ), 5000)!;
        expect(snap).toEqual({
            at: 5000, activeLayers: 2, layerSet: '-|-', framesEncoded: 500, sentFps: 88, width: 3840, height: 720,
            limitation: 'cpu', encoder: 'NvEncoder', hardware: true, sourceFps: 91,
        });
    });

    it('null when there is no video outbound-rtp yet; ignores audio', () => {
        expect(readShareEncoderSnapshot(report(), 0)).toBeNull();
        expect(readShareEncoderSnapshot(report({ type: 'outbound-rtp', kind: 'audio', framesEncoded: 5 }), 0)).toBeNull();
        expect(readShareEncoderSnapshot(null, 0)).toBeNull();
        expect(readShareEncoderSnapshot(undefined, 0)).toBeNull();
    });

    it('all layers paused (dynacast): zero active layers, not a stall candidate', () => {
        const snap = readShareEncoderSnapshot(report(outbound({ active: false })), 1)!;
        expect(snap.activeLayers).toBe(0);
    });
});

describe('share_fps payload', () => {
    const cur: ShareEncoderSnapshot = {
        at: 20_000, activeLayers: 1, framesEncoded: 1900, sentFps: 87, width: 3840, height: 720,
        limitation: 'none', encoder: 'ExternalEncoder', hardware: true, sourceFps: 89,
    };
    const prev: ShareEncoderSnapshot = { ...cur, at: 10_000, framesEncoded: 1000 };

    it('carries capture fps, source fps, encode fps (counter delta), sent fps, limit, encoder, hardware, size, target and window state', () => {
        expect(buildShareFpsDetail(prev, cur, { captureFps: 112.5, targetFps: 90, focused: false, visible: true })).toEqual({
            target: 90, focus: false, vis: 'visible', act: 1,
            cap_fps: 112.5, src_fps: 89, enc_fps: 90, sent_fps: 87,
            limit: 'none', enc: 'ExternalEncoder', hw: true, res: '3840x720',
        });
    });

    it('window state: focused/hidden is reported as given', () => {
        const d = buildShareFpsDetail(prev, cur, { targetFps: 90, focused: true, visible: false });
        expect(d.focus).toBe(true);
        expect(d.vis).toBe('hidden');
    });

    // Reports 4667c6fa / 14a5184a: enc_fps=646.2 / 662.7 / 765.9 on a 90 fps share, in the
    // sample right after dynacast re-enabled the full layer (its cumulative frames, ~6600,
    // landed in a single window because the previous sum did not include that layer).
    it('a window across a change of the ACTIVE layer set gives no enc_fps (no 650 fps from a resumed layer)', () => {
        const snap = (layers: string[], framesEncoded: number, at: number) => readShareEncoderSnapshot(report(
            ...layers.map(rid => outbound({ rid, frameWidth: rid === 'q' ? 1280 : 2560, frameHeight: rid === 'q' ? 720 : 1440, framesEncoded: rid === 'q' ? 300 : framesEncoded })),
        ), at)!;
        const qOnly = snap(['q'], 0, 0);
        const both = snap(['q', 'h'], 6600, 10_000);
        const d = buildShareFpsDetail(qOnly, both, { targetFps: 90, focused: false, visible: true });
        expect('enc_fps' in d).toBe(false);
        // the next window, same layers both ends, is a real rate
        const later = snap(['q', 'h'], 7500, 20_000);
        expect(buildShareFpsDetail(both, later, { targetFps: 90, focused: false, visible: true }).enc_fps).toBe(90);
    });

    it('omits what is unknown instead of inventing it; first sample has no enc_fps', () => {
        const d = buildShareFpsDetail(null, { at: 1, activeLayers: 1, framesEncoded: 0 }, { targetFps: 60, focused: true, visible: true });
        expect(d).toEqual({ target: 60, focus: true, vis: 'visible', act: 1 });
    });

    it('a counter that went backwards (a republished sender) gives no enc_fps rather than a negative one', () => {
        const d = buildShareFpsDetail({ ...cur, framesEncoded: 5000 }, cur, { targetFps: 90, focused: true, visible: true });
        expect('enc_fps' in d).toBe(false);
    });

    it('act is the number of ACTIVE layers: 0 = dynacast paused them all (enc_fps 0 is then expected), >0 with enc_fps 0 = an encoder that stopped', () => {
        const paused = buildShareFpsDetail(prev, { ...cur, activeLayers: 0, framesEncoded: 1000 }, { targetFps: 90, focused: true, visible: true });
        expect(paused.act).toBe(0);
        const stalled = buildShareFpsDetail(prev, { ...cur, framesEncoded: 1000 }, { targetFps: 90, focused: true, visible: true });
        expect(stalled.act).toBe(1);
        expect(stalled.enc_fps).toBe(0);
    });

    it('fits the call event log: the keys the call site logs (cap_fps / vis / res are not) are <= 11 valid, non-reserved names', () => {
        const full = buildShareFpsDetail(prev, cur, { captureFps: 113, targetFps: 90, focused: true, visible: true });
        const d = { ...full };
        for (const k of ['cap_fps', 'vis', 'res']) delete d[k]; // SidebarConference does not log these (the fg_* trio took their slots)
        expect(Object.keys(d).length).toBeLessThanOrEqual(11);
        expect(CALL_EVENT_KINDS as readonly string[]).toContain('share_fps');
        expect(CALL_EVENT_KINDS as readonly string[]).toContain('share_clamp');
        clearCallEvents();
        logCallEvent('share_fps', d);
        const ev = getCallEvents()[0];
        expect(ev.kind).toBe('share_fps');
        expect(ev.detail).toEqual(d);   // nothing dropped by the log's sanitiser
        expect(validateCallEvent(ev)).toEqual([]);
        clearCallEvents();
    });
});

describe('ShareStatsSampler', () => {
    afterEach(() => { vi.useRealTimers(); });

    function setup() {
        vi.useFakeTimers();
        let clock = 0;
        let frames = 0;
        const reports: Array<Record<string, string | number | boolean>> = [];
        let focused = true;
        const sampler = new ShareStatsSampler({
            getStats: async () => report(outbound({ framesEncoded: frames, framesPerSecond: 90 }), source()),
            getCaptureFps: () => 113,
            focused: () => focused,
            visible: () => true,
            targetFps: 90,
            report: d => reports.push(d),
            now: () => clock,
        });
        const tick = async (ms: number, framesAdded: number) => {
            clock += ms; frames += framesAdded;
            await vi.advanceTimersByTimeAsync(ms);
        };
        return { sampler, reports, tick, setFocused: (v: boolean) => { focused = v; } };
    }

    it('takes a baseline at start (no event), then reports one event per interval with a real encode rate', async () => {
        const { sampler, reports, tick } = setup();
        sampler.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(reports).toHaveLength(0);
        await tick(SHARE_FPS_INTERVAL_MS, 900);
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({ enc_fps: 90, sent_fps: 90, src_fps: 88, cap_fps: 113, target: 90, focus: true, vis: 'visible', enc: 'ExternalEncoder', hw: true, limit: 'none' });
        await tick(SHARE_FPS_INTERVAL_MS, 450);
        expect(reports).toHaveLength(2);
        expect(reports[1].enc_fps).toBe(45);
        sampler.dispose();
    });

    it('samples again shortly after a focus change, with the new focus state', async () => {
        const { sampler, reports, tick, setFocused } = setup();
        sampler.start();
        await vi.advanceTimersByTimeAsync(0);
        setFocused(false);
        sampler.noteFocusChange();
        await tick(SHARE_FPS_FOCUS_DELAY_MS, 20);
        expect(reports).toHaveLength(1);
        expect(reports[0].focus).toBe(false);
        sampler.dispose();
    });

    it('dispose() stops everything, including a pending focus sample', async () => {
        const { sampler, reports, tick } = setup();
        sampler.start();
        sampler.noteFocusChange();
        sampler.dispose();
        await tick(SHARE_FPS_INTERVAL_MS * 3, 100);
        expect(reports).toHaveLength(0);
    });

    it('a failing getStats (share ended mid-sample) is swallowed', async () => {
        vi.useFakeTimers();
        const reports: unknown[] = [];
        const sampler = new ShareStatsSampler({
            getStats: async () => { throw new Error('gone'); },
            getCaptureFps: () => undefined, focused: () => true, visible: () => true, targetFps: 30,
            report: d => reports.push(d), now: () => 0,
        });
        sampler.start();
        await vi.advanceTimersByTimeAsync(SHARE_FPS_INTERVAL_MS * 2);
        expect(reports).toEqual([]);
        sampler.dispose();
    });
});

describe('ShareEncoderWatchdog - the black-screen safety net', () => {
    /** Drives the watchdog on a virtual clock: sleep() advances it. */
    function drive(statsAt: (t: number) => StatsLike | null | 'throw') {
        let t = 0;
        const stalls: EncoderStall[] = [];
        const healthy = vi.fn();
        const wd = new ShareEncoderWatchdog({
            getStats: async () => { const r = statsAt(t); if (r === 'throw') throw new Error('gone'); return r; },
            onStall: i => stalls.push(i),
            onHealthy: healthy,
            now: () => t,
            sleep: async ms => { t += ms; },
        });
        return { wd, stalls, healthy, time: () => t };
    }

    it('flags a stall when an active layer has encoded nothing for 3 s', async () => {
        const { wd, stalls, healthy, time } = drive(() => report(outbound({ framesEncoded: 0, encoderImplementation: 'unknown', frameWidth: 7680, frameHeight: 1440 })));
        await wd.start();
        expect(stalls).toHaveLength(1);
        expect(stalls[0]).toMatchObject({ layers: 1, encoder: 'unknown', width: 7680, height: 1440 });
        expect(stalls[0].waitedMs).toBeGreaterThanOrEqual(STALL_MS);
        expect(time()).toBeGreaterThanOrEqual(STALL_MS);
        expect(healthy).not.toHaveBeenCalled();
    });

    it('is healthy at the first encoded frame - no stall, one callback', async () => {
        const { wd, stalls, healthy } = drive(t => report(outbound({ framesEncoded: t >= 2000 ? 12 : 0 })));
        await wd.start();
        expect(stalls).toEqual([]);
        expect(healthy).toHaveBeenCalledTimes(1);
    });

    it('does not count time while every layer is paused (dynacast: nobody is watching)', async () => {
        const { wd, stalls } = drive(t => report(outbound({ framesEncoded: 0, active: t >= 20_000 })));
        await wd.start();
        // paused 0..20 s -> not counted; active from 20 s -> stalls 3 s later, not at 3 s
        expect(stalls).toHaveLength(1);
        expect(stalls[0].waitedMs).toBeGreaterThanOrEqual(STALL_MS);
        expect(stalls[0].waitedMs).toBeLessThan(STALL_MS + 2000);
    });

    it('does not count time before any stats exist', async () => {
        const { wd, stalls, healthy } = drive(t => (t < 10_000 ? null : report(outbound({ framesEncoded: 5 }))));
        await wd.start();
        expect(stalls).toEqual([]);
        expect(healthy).toHaveBeenCalled();
    });

    it('a sender that stops answering (share ended) ends it quietly', async () => {
        const { wd, stalls, healthy } = drive(() => 'throw');
        await wd.start();
        expect(stalls).toEqual([]);
        expect(healthy).not.toHaveBeenCalled();
    });

    it('dispose() ends it with no callbacks', async () => {
        let t = 0;
        const onStall = vi.fn();
        const wd = new ShareEncoderWatchdog({
            getStats: async () => report(outbound()), onStall, now: () => t,
            sleep: async ms => { t += ms; if (t >= 1000) wd.dispose(); },
        });
        await wd.start();
        expect(onStall).not.toHaveBeenCalled();
    });

    it('start() is idempotent', async () => {
        const { wd, stalls } = drive(() => report(outbound()));
        await Promise.all([wd.start(), wd.start()]);
        expect(stalls).toHaveLength(1);
    });
});

describe('what to do about a stall (encoder-stall fallback)', () => {
    it('steps resolution down one rung at a time, then gives up honestly', () => {
        expect(decideStallAction(0)).toEqual({ kind: 'resolution', step: 1 });
        expect(decideStallAction(1)).toEqual({ kind: 'resolution', step: 2 });
        expect(decideStallAction(MAX_RESOLUTION_STEP)).toEqual({ kind: 'give_up' });
        expect(decideStallAction(99)).toEqual({ kind: 'give_up' });
    });

    it('every outcome has a toast; none of them is silent', () => {
        const a = stallToastCopy({ kind: 'resolution', step: 1 });
        const b = stallToastCopy({ kind: 'resolution', step: 2 });
        const c = stallToastCopy({ kind: 'give_up' });
        expect(a.kind).toBe('warning');
        expect(b.kind).toBe('warning');
        expect(c.kind).toBe('error');
        expect(new Set([a.message, b.message, c.message]).size).toBe(3);
        expect(a.message).toMatch(/lower resolution/);
        expect(c.message).toMatch(/isn.t reaching the call/);
    });

    it('end to end on the virtual clock: stall -> step 1 -> stall -> step 2 -> stall -> give up', async () => {
        let step = 0;
        const outcomes: string[] = [];
        for (let attempt = 0; attempt < 4; attempt++) {
            let t = 0;
            let stalled = false;
            const wd = new ShareEncoderWatchdog({
                getStats: async () => report(outbound({ framesEncoded: 0 })),
                onStall: () => { stalled = true; }, now: () => t, sleep: async ms => { t += ms; },
            });
            await wd.start();
            expect(stalled).toBe(true);
            const action = decideStallAction(step);
            outcomes.push(action.kind === 'resolution' ? `res${action.step}` : 'give_up');
            if (action.kind !== 'resolution') break;
            step = action.step;
        }
        expect(outcomes).toEqual(['res1', 'res2', 'give_up']);
    });
});

describe('ShareStatsSampler share_net (same report, no second stats call)', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('reports the network side from the SAME getStats() result as share_fps, after a baseline, with cap + ref', async () => {
        vi.useFakeTimers();
        let clock = 0;
        let bytes = 0;
        let frames = 0;
        let calls = 0;
        const fps: Array<Record<string, string | number | boolean>> = [];
        const nets: Array<Record<string, string | number | boolean>> = [];
        const sampler = new ShareStatsSampler({
            getStats: async () => {
                calls++;
                return report(
                    outbound({ ssrc: 7, framesEncoded: frames, framesPerSecond: 90, bytesSent: bytes, totalEncodeTime: frames * 0.004, timestamp: clock }),
                    { type: 'remote-inbound-rtp', kind: 'video', ssrc: 7, fractionLost: 0.02, roundTripTime: 0.03 },
                    { type: 'transport', selectedCandidatePairId: 'P' },
                    { type: 'candidate-pair', id: 'P', availableOutgoingBitrate: 30_000_000, localCandidateId: 'L1' },
                    { type: 'local-candidate', id: 'L1', address: '192.168.1.20', port: 5555 },
                );
            },
            getCaptureFps: () => 113, focused: () => true, visible: () => true, targetFps: 90,
            report: d => fps.push(d),
            reportNet: d => nets.push(d),
            getCapKbps: () => 16_000,
            getShareRef: () => 'a1b2c3d4',
            now: () => clock,
        });
        sampler.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(nets).toHaveLength(0); // baseline
        clock += SHARE_FPS_INTERVAL_MS; frames += 900; bytes += 12_500_000;
        await vi.advanceTimersByTimeAsync(SHARE_FPS_INTERVAL_MS);
        expect(fps).toHaveLength(1);
        // Single layer here, so the top layer's own keys equal the sums; the lines below are the new ones.
        expect(nets).toEqual([{ share_ref: 'a1b2c3d4', kbps: 10_000, cap_kbps: 16_000, avail_kbps: 30_000, rtt_ms: 30, loss_pct: 2, enc_ms: 4, top_kbps: 10_000, top_enc_ms: 4 }]);
        expect(JSON.stringify(nets)).not.toContain('192.168');
        expect(calls).toBe(2); // one baseline + one sample: share_net added no stats call
        sampler.dispose();
    });

    it('a restarted sender (counters back to 0) skips share_net for that window instead of reporting a rate', async () => {
        vi.useFakeTimers();
        let clock = 0;
        let bytes = 9_000_000;
        const nets: Array<Record<string, string | number | boolean>> = [];
        const sampler = new ShareStatsSampler({
            getStats: async () => report(outbound({ framesEncoded: 500, bytesSent: bytes, totalEncodeTime: 2, timestamp: clock })),
            getCaptureFps: () => 90, focused: () => true, visible: () => true, targetFps: 90,
            report: () => {}, reportNet: d => nets.push(d), now: () => clock,
        });
        sampler.start();
        await vi.advanceTimersByTimeAsync(0);
        clock += SHARE_FPS_INTERVAL_MS; bytes = 4_000;
        await vi.advanceTimersByTimeAsync(SHARE_FPS_INTERVAL_MS);
        expect(nets).toEqual([]);
        sampler.dispose();
    });

    it('onStats gets the raw report and what was in front when THAT sample was taken (null when nothing could say)', async () => {
        vi.useFakeTimers();
        let clock = 0;
        let front: { state: string; exe: string; covers: boolean; isCipherline: boolean; onSharedScreen: boolean | null } | null = {
            state: 'QUNS_BUSY', exe: 'a.exe', covers: true, isCipherline: false, onSharedScreen: true,
        };
        const seen: Array<[number, unknown]> = [];
        const sampler = new ShareStatsSampler({
            getStats: async () => report(outbound({ framesEncoded: clock })), getCaptureFps: () => 90, focused: () => false, visible: () => true,
            targetFps: 90, report: () => {}, now: () => clock, getForeground: async () => front,
            onStats: (_stats, at, fg) => seen.push([at, fg]),
        });
        sampler.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(seen).toEqual([]); // the baseline sample is not a reading
        clock += SHARE_FPS_INTERVAL_MS;
        await vi.advanceTimersByTimeAsync(SHARE_FPS_INTERVAL_MS);
        front = null;
        clock += SHARE_FPS_INTERVAL_MS;
        await vi.advanceTimersByTimeAsync(SHARE_FPS_INTERVAL_MS);
        expect(seen.map(([at]) => at)).toEqual([SHARE_FPS_INTERVAL_MS, 2 * SHARE_FPS_INTERVAL_MS]);
        expect(seen[0][1]).toMatchObject({ exe: 'a.exe', covers: true });
        expect(seen[1][1]).toBeNull();
        sampler.dispose();
    });

    it('without reportNet nothing changes (existing callers)', async () => {
        vi.useFakeTimers();
        let clock = 0;
        const fps: unknown[] = [];
        const sampler = new ShareStatsSampler({
            getStats: async () => report(outbound({ bytesSent: clock })), getCaptureFps: () => 90, focused: () => true, visible: () => true,
            targetFps: 90, report: d => fps.push(d), now: () => clock,
        });
        sampler.start();
        await vi.advanceTimersByTimeAsync(0);
        clock += SHARE_FPS_INTERVAL_MS;
        await vi.advanceTimersByTimeAsync(SHARE_FPS_INTERVAL_MS);
        expect(fps).toHaveLength(1);
        sampler.dispose();
    });
});
