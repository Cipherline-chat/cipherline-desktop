import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    readShareFpsSnapshot, ratesBetween, ratesAt, classifyShareBackground, ShareBackgroundProbe,
    subscribeWindowBackground, isWindowBackground,
    SHARE_BG_SETTLE_MS, SHARE_BG_MEASURE_MS, SHARE_BG_MAX_EVENTS, SHARE_BG_TIMING_FRAMES,
    type ShareBgReport, type ShareBgTiming,
} from './shareBackgroundProbe';

type Stat = Record<string, unknown>;
const report = (stats: Stat[]) => ({ forEach: (cb: (s: Stat) => void) => stats.forEach(cb) });

/** A sender report: media-source + one or two outbound-rtp layers. */
function senderReport(o: { sourceFrames: number; sourceFps?: number; sent: number; sentFps?: number; qlr?: string; low?: boolean }) {
    const stats: Stat[] = [
        { type: 'media-source', kind: 'video', frames: o.sourceFrames, framesPerSecond: o.sourceFps },
        { type: 'outbound-rtp', kind: 'video', frameWidth: 2560, frameHeight: 1440, framesSent: o.sent, framesPerSecond: o.sentFps, qualityLimitationReason: o.qlr ?? 'none', active: true },
    ];
    if (o.low) stats.push({ type: 'outbound-rtp', kind: 'video', frameWidth: 1280, frameHeight: 720, framesSent: 999_999, framesPerSecond: 30, active: true });
    return report(stats);
}

describe('readShareFpsSnapshot', () => {
    it('reads capture + the FULL layer (largest active), not the lighter copy', () => {
        const s = readShareFpsSnapshot(senderReport({ sourceFrames: 500, sourceFps: 91, sent: 480, sentFps: 89, qlr: 'none', low: true }), 1000)!;
        expect(s).toEqual({ at: 1000, sourceFrames: 500, sourceFps: 91, framesSent: 480, sentFps: 89, limitation: 'none' });
    });
    it('falls back to inactive layers only when none is active', () => {
        const s = readShareFpsSnapshot(report([
            { type: 'outbound-rtp', kind: 'video', frameWidth: 640, frameHeight: 360, framesSent: 7, active: false },
        ]), 0)!;
        expect(s.framesSent).toBe(7);
    });
    it('null without a video outbound-rtp (audio only, or no report)', () => {
        expect(readShareFpsSnapshot(report([{ type: 'outbound-rtp', kind: 'audio', framesSent: 1 }]), 0)).toBeNull();
        expect(readShareFpsSnapshot(undefined, 0)).toBeNull();
    });
    it('ignores non-finite counters', () => {
        const s = readShareFpsSnapshot(report([
            { type: 'media-source', kind: 'video', frames: NaN },
            { type: 'outbound-rtp', kind: 'video', framesSent: 'x' },
        ]), 0)!;
        expect(s).toEqual({ at: 0 });
    });
});

describe('ratesBetween / ratesAt', () => {
    it('counts frames per second over the interval', () => {
        expect(ratesBetween({ at: 0, sourceFrames: 100, framesSent: 90 }, { at: 4000, sourceFrames: 108, framesSent: 96 })).toEqual({ capture: 2, sent: 1.5 });
    });
    it('refuses intervals under half a second and counters that went backwards', () => {
        expect(ratesBetween({ at: 0, framesSent: 10 }, { at: 400, framesSent: 50 })).toEqual({});
        expect(ratesBetween({ at: 0, framesSent: 50 }, { at: 4000, framesSent: 10 })).toEqual({});
        expect(ratesBetween(null, { at: 4000, framesSent: 10 })).toEqual({});
    });
    it('ratesAt takes Chromium\'s own last-second rates', () => {
        expect(ratesAt({ at: 0, sourceFps: 90, sentFps: 88 })).toEqual({ capture: 90, sent: 88 });
        expect(ratesAt({ at: 0 })).toEqual({});
    });
});

// Decision table — each row is one verdict, plus the boundaries around "held".
describe('classifyShareBackground', () => {
    const T = 90;
    const before = { capture: 90, sent: 88 };
    const timing = (t: Partial<ShareBgTiming>): ShareBgTiming => ({ captureMs: 3.6, periodMs: 8, intervalMs: 9, unchangedRatio: 0, ...t });
    const c = (after: { capture?: number; sent?: number }, extra: Partial<Parameters<typeof classifyShareBackground>[0]> = {}) =>
        classifyShareBackground({ before, after, targetFps: T, ...extra });

    it('held at and above 80 % of the foreground send rate; not held just below', () => {
        expect(c({ capture: 90, sent: 88 })).toBe('held');
        expect(c({ capture: 90, sent: 0.8 * 88 })).toBe('held');
        expect(c({ capture: 90, sent: 0.8 * 88 - 0.1 })).toBe('encoder_dropped');
    });
    it('the baseline never exceeds the target (a 120 fps foreground is judged against 90)', () => {
        expect(classifyShareBackground({ before: { capture: 120, sent: 120 }, after: { capture: 75, sent: 73 }, targetFps: 90 })).toBe('held');
    });
    it('the encoder\'s own limitation wins', () => {
        expect(c({ capture: 2, sent: 2 }, { limitation: 'bandwidth' })).toBe('bandwidth');
        expect(c({ capture: 90, sent: 20 }, { limitation: 'cpu' })).toBe('encoder_cpu');
    });
    it('capture held but sends fell → encoder_dropped', () => {
        expect(c({ capture: 89, sent: 30 })).toBe('encoder_dropped');
    });
    it('with the capture log: 0 Hz → capture_idle; slow grabs → capture_slow; late timer → capture_late', () => {
        expect(c({ capture: 1, sent: 1 }, { timing: timing({ unchangedRatio: 0.9 }) })).toBe('capture_idle');
        expect(c({ capture: 2, sent: 2 }, { timing: timing({ captureMs: 240 }) })).toBe('capture_slow');
        expect(c({ capture: 2, sent: 2 }, { timing: timing({ periodMs: 8, intervalMs: 500 }) })).toBe('capture_late');
    });
    it('a grab of exactly one frame budget is not "slow" yet (boundary)', () => {
        expect(c({ capture: 30, sent: 30 }, { timing: timing({ captureMs: 1000 / T }) })).toBe('capture_dropped');
    });
    it('without the capture log: next to nothing delivered → capture_idle, otherwise capture_dropped', () => {
        expect(c({ capture: 1.5, sent: 1.2 })).toBe('capture_idle');
        expect(c({ capture: 30, sent: 30 })).toBe('capture_dropped');
    });
    it('unknown without an after-rate or a foreground baseline', () => {
        expect(c({ capture: 90 })).toBe('unknown');
        expect(classifyShareBackground({ before: {}, after: { sent: 2 }, targetFps: T })).toBe('unknown');
        expect(classifyShareBackground({ before: { sent: 0 }, after: { sent: 2 }, targetFps: T })).toBe('unknown');
    });
});

describe('ShareBackgroundProbe', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    /**
     * A fake sender whose counters advance at `rate()` frames/s of the fake
     * clock — the capturer at `capture()`, the encoder at `sent()`.
     */
    function fakeSender(opts: { capture: () => number; sent: () => number; fgCapture?: number; fgSent?: number; qlr?: () => string }) {
        let t = 0; let src = 0; let snt = 0;
        const advanceTo = (now: number) => {
            const dt = (now - t) / 1000;
            src += opts.capture() * dt; snt += opts.sent() * dt; t = now;
        };
        const getStats = vi.fn(async () => {
            advanceTo(Date.now());
            return senderReport({ sourceFrames: Math.round(src), sourceFps: opts.fgCapture ?? 90, sent: Math.round(snt), sentFps: opts.fgSent ?? 89, qlr: opts.qlr?.() });
        });
        return { getStats };
    }

    function makeProbe(sender: ReturnType<typeof fakeSender>, extra: { timing?: ShareBgTiming | null; hidden?: boolean } = {}) {
        const reports: ShareBgReport[] = [];
        const getTiming = vi.fn(async () => extra.timing ?? null);
        const probe = new ShareBackgroundProbe({
            getStats: sender.getStats, getTiming, docHidden: () => !!extra.hidden, targetFps: 90,
            report: r => reports.push(r), now: () => Date.now(),
        });
        return { probe, reports, getTiming };
    }

    const settle = () => vi.advanceTimersByTimeAsync(SHARE_BG_SETTLE_MS + SHARE_BG_MEASURE_MS + 50);

    it('a share that HOLDS in the background reports held', async () => {
        const s = fakeSender({ capture: () => 90, sent: () => 89 });
        const { probe, reports, getTiming } = makeProbe(s);
        probe.setBackground(true, 'blur');
        await settle();
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({ cause: 'blur', docHidden: false, targetFps: 90, verdict: 'held', before: { capture: 90, sent: 89 } });
        expect(reports[0].after.sent).toBeCloseTo(89, 0);
        expect(getTiming).toHaveBeenCalledWith(SHARE_BG_TIMING_FRAMES);
        expect(s.getStats).toHaveBeenCalledTimes(3);
    });

    it('the owner\'s report — 90 → 1–2 fps — is caught and attributed (capture log on: slow grabs)', async () => {
        const s = fakeSender({ capture: () => 1.5, sent: () => 1.5 });
        const { probe, reports } = makeProbe(s, { timing: { captureMs: 300, periodMs: 600, intervalMs: 610, unchangedRatio: 0 }, hidden: false });
        probe.setBackground(true, 'blur');
        await settle();
        expect(reports[0].verdict).toBe('capture_slow');
        expect(reports[0].after.sent).toBeLessThan(3);
        expect(reports[0].timing).toMatchObject({ captureMs: 300 });
    });

    it('nothing is measured while in the foreground, and an episode cut short reports nothing', async () => {
        const s = fakeSender({ capture: () => 90, sent: () => 89 });
        const { probe, reports } = makeProbe(s);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(s.getStats).not.toHaveBeenCalled();
        probe.setBackground(true, 'blur');
        await vi.advanceTimersByTimeAsync(SHARE_BG_SETTLE_MS + 100);
        probe.setBackground(false);
        await settle();
        expect(reports).toHaveLength(0);
    });

    it('a stronger signal during the episode refines the cause (blur → minimize → hidden), never weakens it', async () => {
        const s = fakeSender({ capture: () => 90, sent: () => 89 });
        const { probe, reports } = makeProbe(s, { hidden: true });
        probe.setBackground(true, 'blur');
        probe.setBackground(true, 'minimize');
        probe.setBackground(true, 'hidden');
        probe.setBackground(true, 'blur');
        await settle();
        expect(reports[0]).toMatchObject({ cause: 'hidden', docHidden: true });
    });

    it('at most SHARE_BG_MAX_EVENTS episodes per share', async () => {
        const s = fakeSender({ capture: () => 90, sent: () => 89 });
        const { probe, reports } = makeProbe(s);
        for (let i = 0; i < SHARE_BG_MAX_EVENTS + 2; i++) {
            probe.setBackground(true, 'blur');
            await settle();
            probe.setBackground(false);
        }
        expect(reports).toHaveLength(SHARE_BG_MAX_EVENTS);
        expect(probe.eventsLogged).toBe(SHARE_BG_MAX_EVENTS);
    });

    it('dispose (share ended) cancels a running measurement', async () => {
        const s = fakeSender({ capture: () => 90, sent: () => 89 });
        const { probe, reports } = makeProbe(s);
        probe.setBackground(true, 'blur');
        await vi.advanceTimersByTimeAsync(10);
        probe.dispose();
        await settle();
        expect(reports).toHaveLength(0);
    });

    it('a sender that throws (share torn down) is swallowed, not reported', async () => {
        const reports: ShareBgReport[] = [];
        const probe = new ShareBackgroundProbe({
            getStats: async () => { throw new Error('gone'); }, docHidden: () => false, targetFps: 90,
            report: r => reports.push(r), now: () => Date.now(),
        });
        probe.setBackground(true, 'blur');
        await settle();
        expect(reports).toHaveLength(0);
    });
});

describe('subscribeWindowBackground', () => {
    function fakeWindow(bridge: boolean) {
        const winL = new Map<string, () => void>();
        const docL = new Map<string, () => void>();
        const push = new Map<string, () => void>();
        const doc = {
            hidden: false,
            hasFocus: () => true,
            addEventListener: (t: string, f: () => void) => docL.set(t, f),
            removeEventListener: (t: string) => docL.delete(t),
        };
        const sub = (name: string) => (cb: () => void) => { push.set(name, cb); return () => push.delete(name); };
        const win = {
            document: doc,
            addEventListener: (t: string, f: () => void) => winL.set(t, f),
            removeEventListener: (t: string) => winL.delete(t),
            electronAPI: bridge ? { onWindowFocus: sub('focus'), onWindowMinimize: sub('minimize'), onWindowHide: sub('hide') } : undefined,
        };
        return { win: win as unknown as Window, doc, winL, docL, push };
    }

    it('maps blur / minimize / hide / document hidden to causes, and main\'s focus push to foreground', () => {
        const f = fakeWindow(true);
        const seen: Array<[boolean, string]> = [];
        const off = subscribeWindowBackground((bg, c) => seen.push([bg, c]), f.win);
        f.winL.get('blur')!();
        f.push.get('minimize')!();
        f.push.get('hide')!();
        f.doc.hidden = true; f.docL.get('visibilitychange')!();
        f.winL.get('focus')!(); // DOM focus alone does NOT end it with the bridge
        f.push.get('focus')!();
        expect(seen).toEqual([[true, 'blur'], [true, 'minimize'], [true, 'hide'], [true, 'hidden'], [false, 'blur']]);
        off();
        expect(f.winL.size + f.docL.size + f.push.size).toBe(0);
    });

    it('without the bridge, DOM focus is the foreground signal', () => {
        const f = fakeWindow(false);
        const seen: boolean[] = [];
        subscribeWindowBackground(bg => seen.push(bg), f.win);
        f.winL.get('blur')!();
        f.winL.get('focus')!();
        expect(seen).toEqual([true, false]);
    });

    it('isWindowBackground: hidden or unfocused; a throwing hasFocus counts as foreground', () => {
        expect(isWindowBackground({ hidden: false, hasFocus: () => true } as unknown as Document)).toBe(false);
        expect(isWindowBackground({ hidden: false, hasFocus: () => false } as unknown as Document)).toBe(true);
        expect(isWindowBackground({ hidden: true, hasFocus: () => true } as unknown as Document)).toBe(true);
        expect(isWindowBackground({ hidden: false, hasFocus: () => { throw new Error('x'); } } as unknown as Document)).toBe(false);
    });
});
