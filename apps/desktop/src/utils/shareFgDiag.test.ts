import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareStatsSampler, SHARE_FPS_INTERVAL_MS, type StatsLike } from './shareHealth';
import { ShareBackgroundProbe, SHARE_BG_SETTLE_MS, SHARE_BG_MEASURE_MS, type ShareBgReport } from './shareBackgroundProbe';
import { logCallEvent, getCallEvents, clearCallEvents, validateCallEvent } from './callEventLog';
import { FullscreenHintGate } from './shareFullscreenHint';
import type { ForegroundDiag } from './foregroundInfo';

/**
 * The fg_* fields on `share_fps` and `share_background`, end to end through the
 * real sampler / probe and the real call event log: the numbers the owner's
 * next report is read from.
 */
type Stat = Record<string, unknown>;
const report = (...stats: Stat[]): StatsLike => ({ forEach: cb => stats.forEach(cb) });
const statsOf = (frames: number): StatsLike => report(
    { type: 'outbound-rtp', kind: 'video', active: true, frameWidth: 2560, frameHeight: 1440, framesEncoded: frames, framesSent: frames, framesPerSecond: 9,
      qualityLimitationReason: 'none', encoderImplementation: 'ExternalEncoder', powerEfficientEncoder: true },
    { type: 'media-source', kind: 'video', framesPerSecond: 9, frames },
);

const GAME: ForegroundDiag = { state: 'QUNS_RUNNING_D3D_FULL_SCREEN', exe: 'game.exe', covers: true, isCipherline: false, onSharedScreen: true };
const CIPHERLINE: ForegroundDiag = { state: 'QUNS_ACCEPTS_NOTIFICATIONS', exe: 'Cipherline.exe', covers: false, isCipherline: true, onSharedScreen: true };

describe('ShareStatsSampler carries what had the screen', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    function setup(getForeground?: () => Promise<ForegroundDiag | null>) {
        let clock = 0, frames = 0;
        const reports: Array<{ d: Record<string, string | number | boolean>; fg: ForegroundDiag | null }> = [];
        const seen: Array<ForegroundDiag | null> = [];
        const sampler = new ShareStatsSampler({
            getStats: async () => statsOf(frames), getCaptureFps: () => 90, focused: () => false, visible: () => true, targetFps: 90,
            getForeground, onForeground: fg => seen.push(fg),
            report: (d, fg) => reports.push({ d, fg }), now: () => clock,
        });
        const tick = async (ms: number, add: number) => { clock += ms; frames += add; await vi.advanceTimersByTimeAsync(ms); };
        return { sampler, reports, seen, tick };
    }

    it('every sample - the baseline too - is shown to onForeground; each report carries the fg that was in front', async () => {
        const { sampler, reports, seen, tick } = setup(async () => GAME);
        sampler.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(seen).toEqual([GAME]);              // baseline: no report, but the hint still sees it
        expect(reports).toHaveLength(0);
        await tick(SHARE_FPS_INTERVAL_MS, 90);
        expect(seen).toHaveLength(2);
        expect(reports).toHaveLength(1);
        expect(reports[0].fg).toEqual(GAME);
        expect(reports[0].d).toMatchObject({ src_fps: 9, focus: false, target: 90 });
        sampler.dispose();
    });

    it('no foreground source (non-Windows / older main): fg is null and the sampler is otherwise unchanged', async () => {
        const { sampler, reports, tick } = setup(undefined);
        sampler.start();
        await vi.advanceTimersByTimeAsync(0);
        await tick(SHARE_FPS_INTERVAL_MS, 90);
        expect(reports).toHaveLength(1);
        expect(reports[0].fg).toBeNull();
        expect(reports[0].d.enc_fps).toBe(9);
        sampler.dispose();
    });

    it('a foreground lookup that throws does not lose the sample', async () => {
        const { sampler, reports, tick } = setup(async () => { throw new Error('ipc closed'); });
        sampler.start();
        await vi.advanceTimersByTimeAsync(0);
        await tick(SHARE_FPS_INTERVAL_MS, 90);
        expect(reports).toHaveLength(1);
        expect(reports[0].fg).toBeNull();
        sampler.dispose();
    });

    it('feeding the hint gate from the sampler: Cipherline in front never hints, the game in front hints once', async () => {
        let current: ForegroundDiag = CIPHERLINE;
        const onHint = vi.fn();
        const gate = new FullscreenHintGate({ onHint });
        let clock = 0, frames = 0;
        const sampler = new ShareStatsSampler({
            getStats: async () => statsOf(frames), getCaptureFps: () => 90, focused: () => true, visible: () => true, targetFps: 90,
            getForeground: async () => current, onForeground: fg => gate.observe(fg, 'screen'),
            report: () => {}, now: () => clock,
        });
        const tick = async () => { clock += SHARE_FPS_INTERVAL_MS; frames += 90; await vi.advanceTimersByTimeAsync(SHARE_FPS_INTERVAL_MS); };
        sampler.start();
        await vi.advanceTimersByTimeAsync(0);
        await tick();
        expect(onHint).not.toHaveBeenCalled();
        current = GAME;
        await tick();
        await tick();
        expect(onHint).toHaveBeenCalledTimes(1);
        expect(onHint).toHaveBeenCalledWith('game.exe');
        sampler.dispose();
    });
});

describe('ShareBackgroundProbe carries what had the screen', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    function run(getForeground?: () => Promise<ForegroundDiag | null>) {
        let t = 0, src = 0, snt = 0, calls = 0;
        const getStats = async () => {
            const now = Date.now(); const dt = (now - t) / 1000;
            src += 9 * dt; snt += 9 * dt; t = now;
            // Chromium's own last-second rate as Cipherline loses focus: 90 fps; the frames then arrive at 9.
            const fps = calls++ === 0 ? 90 : 9;
            return report(
                { type: 'media-source', kind: 'video', frames: Math.round(src), framesPerSecond: fps },
                { type: 'outbound-rtp', kind: 'video', frameWidth: 2560, frameHeight: 1440, framesSent: Math.round(snt), framesPerSecond: fps, qualityLimitationReason: 'none', active: true },
            );
        };
        const reports: ShareBgReport[] = [];
        const probe = new ShareBackgroundProbe({
            getStats, getForeground, docHidden: () => false, targetFps: 90, report: r => reports.push(r), now: () => Date.now(),
            getTiming: async () => ({ captureMs: 56.5, periodMs: 11, intervalMs: 108, unchangedRatio: 0 }),
        });
        probe.setBackground(true, 'blur');
        return { reports, done: () => vi.advanceTimersByTimeAsync(SHARE_BG_SETTLE_MS + SHARE_BG_MEASURE_MS + 50) };
    }

    it('the report holds the fg answer next to the verdict (the owner\'s capture_slow row)', async () => {
        const { reports, done } = run(async () => GAME);
        await done();
        expect(reports).toHaveLength(1);
        expect(reports[0].fg).toEqual(GAME);
        expect(reports[0].verdict).toBe('capture_slow');
    });

    it('no fg source -> the report still lands, fg null', async () => {
        const { reports, done } = run(undefined);
        await done();
        expect(reports[0].fg).toBeNull();
    });

    it('a throwing lookup does not lose the report', async () => {
        const { reports, done } = run(async () => { throw new Error('ipc closed'); });
        await done();
        expect(reports).toHaveLength(1);
        expect(reports[0].fg).toBeNull();
    });
});

describe('the fg_* fields survive the call event log\'s 11-key limit', () => {
    beforeEach(() => clearCallEvents());

    it('share_fps: all eleven keys incl. fg_state / fg_exe / fg_cover are kept, in a valid event', () => {
        // The literal SidebarConference logs (keep in step with it - shareFpsSurround.wiring.test.ts pins the call).
        logCallEvent('share_fps', {
            src_fps: 9, enc_fps: 9, sent_fps: 9, limit: 'none', enc: 'ExternalEncoder', hw: true,
            target: 90, focus: false,
            fg_state: GAME.state, fg_exe: GAME.exe, fg_cover: GAME.covers,
        });
        const [ev] = getCallEvents();
        expect(Object.keys(ev.detail!)).toHaveLength(11);
        expect(ev.detail).toMatchObject({ fg_state: 'QUNS_RUNNING_D3D_FULL_SCREEN', fg_exe: 'game.exe', fg_cover: true, src_fps: 9, focus: false });
        expect(validateCallEvent(ev)).toEqual([]);
    });

    it('share_background: all eleven keys incl. the fg trio are kept', () => {
        logCallEvent('share_background', {
            cause: 'blur', verdict: 'capture_slow',
            fg_state: GAME.state, fg_exe: GAME.exe, fg_cover: GAME.covers,
            capture_before: 90, sent_before: 89, capture_after: 9, sent_after: 9, grab_ms: 56.5, interval_ms: 108,
        });
        const [ev] = getCallEvents();
        expect(Object.keys(ev.detail!)).toHaveLength(11);
        expect(ev.detail).toMatchObject({ verdict: 'capture_slow', fg_state: 'QUNS_RUNNING_D3D_FULL_SCREEN', fg_exe: 'game.exe', fg_cover: true, grab_ms: 56.5, interval_ms: 108 });
        expect(validateCallEvent(ev)).toEqual([]);
    });

    it('unknown fg (empty string) is dropped, not logged as a value', () => {
        logCallEvent('share_fps', { src_fps: 9, fg_state: '', fg_exe: '', fg_cover: '' });
        expect(Object.keys(getCallEvents()[0].detail!)).toEqual(['src_fps']);
    });

    it('share_hint is a published kind with a result enum', () => {
        logCallEvent('share_hint', { result: 'shown' });
        logCallEvent('share_hint', { result: 'accepted' });
        expect(getCallEvents().map(e => e.detail?.result)).toEqual(['shown', 'accepted']);
    });
});
