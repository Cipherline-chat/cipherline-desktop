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
            at: 5000, activeLayers: 2, framesEncoded: 500, sentFps: 88, width: 3840, height: 720,
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
            target: 90, focus: false, vis: 'visible',
            cap_fps: 112.5, src_fps: 89, enc_fps: 90, sent_fps: 87,
            limit: 'none', enc: 'ExternalEncoder', hw: true, res: '3840x720',
        });
    });

    it('window state: focused/hidden is reported as given', () => {
        const d = buildShareFpsDetail(prev, cur, { targetFps: 90, focused: true, visible: false });
        expect(d.focus).toBe(true);
        expect(d.vis).toBe('hidden');
    });

    it('omits what is unknown instead of inventing it; first sample has no enc_fps', () => {
        const d = buildShareFpsDetail(null, { at: 1, activeLayers: 1, framesEncoded: 0 }, { targetFps: 60, focused: true, visible: true });
        expect(d).toEqual({ target: 60, focus: true, vis: 'visible' });
    });

    it('a counter that went backwards (a republished sender) gives no enc_fps rather than a negative one', () => {
        const d = buildShareFpsDetail({ ...cur, framesEncoded: 5000 }, cur, { targetFps: 90, focused: true, visible: true });
        expect('enc_fps' in d).toBe(false);
    });

    it('fits the call event log: <= 11 detail keys and every key is a valid, non-reserved name', () => {
        const d = buildShareFpsDetail(prev, cur, { captureFps: 113, targetFps: 90, focused: true, visible: true });
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
