import { describe, it, expect, vi } from 'vitest';
import {
    classifyCaptureFailure, windowFallbackEligible, nextWindowShareStep, safeWindowCapture, planMonitorCrop,
    pickScreenForWindow, screenForOffer, regionMoved, windowCaptureFailedText, fallbackEventDetails, parseWindowGeometry,
    captureEndedError, runWindowFallbackLadder,
    SAFE_WINDOW_FPS, WINDOW_RETRY_DELAY_MS,
    type CaptureFailureClass, type WindowFallbackDeps, type WindowGeometry, type WindowShareStep, type WindowState,
} from './windowShareFallback';
import { validateCallEvent } from './callEventLog';
import { publishScreenShareSettled, type SettledPublishParticipant } from './shareFirstFrame';

/** A DOMException-like rejection exactly as Chromium/Electron produce them (name + fixed message). */
const domErr = (name: string, message = '') => Object.assign(new Error(message), { name });
const ABORT_REFUSED = domErr('AbortError', '');                                  // Electron: handler callback(null)
const ABORT_TIMEOUT = domErr('AbortError', 'Timeout starting video source');     // START_TIMEOUT (10 s)
const NOT_READABLE = domErr('NotReadableError', 'Could not start video source'); // device could not open the window

const MON_A = { sourceId: 'screen:0:0', rect: { x: 0, y: 0, width: 2560, height: 1440 } };
const MON_B = { sourceId: 'screen:1:0', rect: { x: 2560, y: 0, width: 1920, height: 1080 } };
const win = (over: Partial<WindowState> = {}): WindowState => ({
    exists: true, visible: true, minimized: false, cloaked: false,
    frame: { x: 100, y: 100, width: 1600, height: 900 }, ...over,
});
const geo = (w: WindowState | null, screens = [MON_A, MON_B]): WindowGeometry => ({ window: w, screens });

describe('classifyCaptureFailure', () => {
    it.each<[unknown, string | null, CaptureFailureClass]>([
        [ABORT_REFUSED, 'no_source', 'refused'],
        [ABORT_REFUSED, 'error', 'refused'],
        [ABORT_REFUSED, 'malformed', 'refused'],
        [ABORT_REFUSED, 'denied_declined', 'declined'],
        [ABORT_REFUSED, 'denied_cooldown', 'declined'],
        [ABORT_REFUSED, 'cancelled', 'declined'],
        [ABORT_TIMEOUT, 'ok', 'timeout'],
        [ABORT_TIMEOUT, null, 'timeout'],
        [ABORT_REFUSED, null, 'aborted'],
        [NOT_READABLE, 'ok', 'start_failed'],
        [domErr('NotReadableError', 'Device in use'), null, 'unreadable'],
        [domErr('NotAllowedError'), null, 'denied'],
        [domErr('NotFoundError'), null, 'not_found'],
        [domErr('OverconstrainedError'), null, 'constraints'],
        [new TypeError('bad constraint'), null, 'constraints'],
        [captureEndedError(), null, 'ended'],
        [new Error('getDisplayMedia handshake timed out'), null, 'other'],
        [null, null, 'other'],
        ['a string', null, 'other'],
    ])('%o with main=%s -> %s', (err, resolve, cls) => {
        expect(classifyCaptureFailure(err, resolve).cls).toBe(cls);
    });

    it('reports the exception NAME only - never the message (which can carry anything)', () => {
        const f = classifyCaptureFailure(domErr('AbortError', 'World of Warcraft secret title'));
        expect(f).toEqual({ name: 'AbortError', cls: 'aborted' });
        expect(classifyCaptureFailure(domErr('Weird Name!<script>')).name).toBe('WeirdNamescript');
    });
});

describe('windowFallbackEligible', () => {
    const base = { sourceId: 'window:1234:0', platform: 'win', viaPortal: false, slice: false, reused: false };
    it('a fresh Windows window capture gets the ladder', () => expect(windowFallbackEligible(base)).toBe(true));
    it.each([
        ['a screen', { sourceId: 'screen:0:0' }],
        ['macOS', { platform: 'mac' }],
        ['Linux', { platform: 'linux' }],
        ['the Wayland portal', { viaPortal: true }],
        ['an ultra-wide slice', { slice: true }],
        ['a reused capture', { reused: true }],
    ])('not for %s', (_, over) => expect(windowFallbackEligible({ ...base, ...over })).toBe(false));
});

describe('nextWindowShareStep - the decision table', () => {
    const steps: WindowShareStep[] = ['as_asked', 'safe', 'monitor_crop', 'offer_screen', 'give_up'];
    it.each(steps)('a refusal by the user after %s is never routed around', (prev) => {
        expect(nextWindowShareStep(prev, 'declined', win())).toBe('give_up');
        expect(nextWindowShareStep(prev, 'denied', win())).toBe('give_up');
    });
    it.each(steps)('a window that no longer exists after %s: give up', (prev) => {
        expect(nextWindowShareStep(prev, 'start_failed', win({ exists: false }))).toBe('give_up');
    });
    it('as asked -> safe -> monitor crop -> offer the screen', () => {
        expect(nextWindowShareStep('as_asked', 'refused', win())).toBe('safe');
        expect(nextWindowShareStep('safe', 'refused', win())).toBe('monitor_crop');
        expect(nextWindowShareStep('monitor_crop', 'refused', win())).toBe('offer_screen');
        expect(nextWindowShareStep('offer_screen', 'refused', win())).toBe('give_up');
    });
    it('the window state unknown (no addon) still walks the ladder', () => {
        expect(nextWindowShareStep('as_asked', 'timeout', null)).toBe('safe');
        expect(nextWindowShareStep('safe', 'timeout', null)).toBe('monitor_crop');
    });
    it('a MINIMISED window (exclusive-fullscreen game after alt-tab) skips straight to the screen offer', () => {
        expect(nextWindowShareStep('as_asked', 'start_failed', win({ minimized: true }))).toBe('offer_screen');
    });
    it('a cloaked window (another virtual desktop) skips straight to the screen offer', () => {
        expect(nextWindowShareStep('as_asked', 'start_failed', win({ cloaked: true }))).toBe('offer_screen');
    });
    it.each<CaptureFailureClass>(['refused', 'timeout', 'start_failed', 'aborted', 'unreadable', 'constraints', 'ended', 'not_found', 'other'])(
        'every non-user failure (%s) of the first attempt retries', (cls) => {
            expect(nextWindowShareStep('as_asked', cls, win())).toBe('safe');
        });
});

describe('safeWindowCapture', () => {
    it('Pro 4K / 75 capture fps drops to 1080p30', () => {
        expect(safeWindowCapture({ width: 3840, height: 2160 }, 75)).toEqual({ box: { width: 1920, height: 1080 }, fps: SAFE_WINDOW_FPS });
    });
    it('an ask already below that is kept', () => {
        expect(safeWindowCapture({ width: 1280, height: 720 }, 19)).toEqual({ box: { width: 1280, height: 720 }, fps: 19 });
    });
});

describe('planMonitorCrop', () => {
    it('a windowed game on the first monitor: that monitor, cropped to the window', () => {
        const p = planMonitorCrop(geo(win()))!;
        expect(p.screenSourceId).toBe('screen:0:0');
        expect(p.region.kind).toBe('region');
        expect(p.region.x).toBeCloseTo(100 / 2560);
        expect(p.region.y).toBeCloseTo(100 / 1440);
        expect(p.region.w).toBeCloseTo(1600 / 2560);
        expect(p.region.h).toBeCloseTo(900 / 1440);
        expect(p.fullscreen).toBe(false);
    });
    it('a borderless-fullscreen game covering its monitor is flagged fullscreen (region = the whole monitor)', () => {
        const p = planMonitorCrop(geo(win({ frame: { x: 2560, y: 0, width: 1920, height: 1080 } })))!;
        expect(p.screenSourceId).toBe('screen:1:0');
        expect(p.region).toEqual({ kind: 'region', x: 0, y: 0, w: 1, h: 1 });
        expect(p.fullscreen).toBe(true);
    });
    it('a window straddling two monitors picks the one holding most of it, cropped to the part on it', () => {
        const p = planMonitorCrop(geo(win({ frame: { x: 2000, y: 100, width: 1000, height: 500 } })))!;
        expect(p.screenSourceId).toBe('screen:0:0'); // 560 px on A vs 440 px on B
        expect(p.region.w).toBeCloseTo(560 / 2560);
    });
    it.each<[string, WindowGeometry | null]>([
        ['no geometry', null],
        ['window unknown', geo(null)],
        ['minimised', geo(win({ minimized: true }))],
        ['hidden', geo(win({ visible: false }))],
        ['cloaked', geo(win({ cloaked: true }))],
        ['gone', geo(win({ exists: false }))],
        ['no frame', geo(win({ frame: null }))],
        ['off every monitor', geo(win({ frame: { x: -5000, y: -5000, width: 800, height: 600 } }))],
        ['mostly off-screen', geo(win({ frame: { x: -1500, y: 0, width: 1600, height: 900 } }))],
        ['too small', geo(win({ frame: { x: 10, y: 10, width: 40, height: 40 } }))],
        ['no screens listed', geo(win(), [])],
    ])('not feasible: %s', (_, g) => expect(planMonitorCrop(g)).toBeNull());
});

describe('pickScreenForWindow / screenForOffer', () => {
    it('the offer shares the window\'s monitor', () => {
        expect(screenForOffer(geo(win({ frame: { x: 2600, y: 10, width: 800, height: 600 } })))).toBe('screen:1:0');
    });
    it('a minimised window (no usable frame) gets the first screen listed', () => {
        expect(screenForOffer(geo(win({ minimized: true, frame: { x: -32000, y: -32000, width: 160, height: 28 } })))).toBe('screen:0:0');
    });
    it('nothing known: no offer target', () => {
        expect(screenForOffer(null)).toBeNull();
        expect(pickScreenForWindow(null, [MON_A])).toBeNull();
    });
});

describe('regionMoved', () => {
    const r = { kind: 'region' as const, x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
    it('ignores sub-pixel jitter', () => expect(regionMoved(r, { ...r, x: 0.102 })).toBe(false));
    it('follows a real move', () => expect(regionMoved(r, { ...r, x: 0.2 })).toBe(true));
});

describe('windowCaptureFailedText', () => {
    it('a minimised window explains exclusive fullscreen and names the fix', () => {
        const t = windowCaptureFailedText(win({ minimized: true }), true);
        expect(t).toMatch(/minimized/);
        expect(t).toMatch(/Windowed \(Fullscreen\)/);
        expect(t).toMatch(/share the whole screen instead/i);
    });
    it('the generic case never names the window', () => {
        const t = windowCaptureFailedText(win(), false);
        expect(t).not.toMatch(/Warcraft/);
        expect(t).toMatch(/whole screen/);
    });
});

describe('fallbackEventDetails', () => {
    it('is a valid call event (keys, value types) and carries no title', () => {
        const d = fallbackEventDetails({
            from: 'safe', to: 'monitor_crop', failure: { name: 'AbortError', cls: 'refused' }, win: win(), fullscreen: true, resolve: 'no_source',
        });
        expect(validateCallEvent({ t: Date.now(), kind: 'share_window_fallback', detail: d })).toEqual([]);
        expect(d).toMatchObject({ from: 'safe', to: 'monitor_crop', why: 'AbortError', cls: 'refused', win_min: false, fullscreen: true, resolve: 'no_source' });
    });
});

describe('parseWindowGeometry (main -> renderer boundary)', () => {
    it('keeps a well-formed answer', () => {
        expect(parseWindowGeometry({ window: win(), screens: [MON_A] })).toEqual(geo(win(), [MON_A]));
    });
    it('drops malformed screens and rects', () => {
        const g = parseWindowGeometry({
            window: { exists: true, visible: true, frame: { x: 'a' } },
            screens: [{ sourceId: 'window:1:0', rect: MON_A.rect }, { sourceId: 'screen:0:0', rect: { x: 0, y: 0, width: -1, height: 5 } }, MON_B],
        })!;
        expect(g.window?.frame).toBeNull();
        expect(g.screens).toEqual([MON_B]);
    });
    it('anything else is null', () => {
        expect(parseWindowGeometry(null)).toBeNull();
        expect(parseWindowGeometry('x')).toBeNull();
    });
});

// ── The ladder, end to end, with the capture failures Chromium/Electron actually produce ─────────────
describe('runWindowFallbackLadder', () => {
    function deps(over: Partial<WindowFallbackDeps> & { resolves?: (string | null)[]; geos?: (WindowGeometry | null)[] } = {}) {
        const resolves = [...(over.resolves ?? [])];
        const geos = [...(over.geos ?? [])];
        const logs: Record<string, string | number | boolean>[] = [];
        const d: WindowFallbackDeps & { logs: typeof logs } = {
            resolveOutcome: async () => (resolves.length ? resolves.shift()! : null),
            geometry: async () => (geos.length ? geos.shift()! : geo(win())),
            cropSupported: true,
            attemptSafe: vi.fn(async () => { /* published */ }),
            attemptCrop: vi.fn(async () => { /* published */ }),
            cleanup: vi.fn(),
            log: (details) => { logs.push(details); },
            sleep: vi.fn(async () => { /* no wait */ }),
            logs,
            ...over,
        };
        return d;
    }

    it('main refused the window (AbortError): the 1080p30 retry publishes', async () => {
        const d = deps({ resolves: ['no_source'] });
        const r = await runWindowFallbackLadder(ABORT_REFUSED, d);
        expect(r).toEqual({ kind: 'published', via: 'safe', plan: null });
        expect(d.sleep).toHaveBeenCalledWith(WINDOW_RETRY_DELAY_MS);
        expect(d.attemptCrop).not.toHaveBeenCalled();
        expect(d.logs[0]).toMatchObject({ from: 'as_asked', to: 'safe', why: 'AbortError', cls: 'refused', resolve: 'no_source' });
    });

    it('the retry fails too: the monitor crop publishes, with the plan for the window', async () => {
        const d = deps({ attemptSafe: vi.fn(async () => { throw ABORT_TIMEOUT; }) });
        const r = await runWindowFallbackLadder(ABORT_REFUSED, d);
        expect(r.kind).toBe('published');
        if (r.kind !== 'published') return;
        expect(r.via).toBe('monitor_crop');
        expect(r.plan?.screenSourceId).toBe('screen:0:0');
        expect(d.cleanup).toHaveBeenCalledTimes(1);
        expect(d.logs.map(l => l.to)).toEqual(['safe', 'monitor_crop']);
        expect(d.logs[1]).toMatchObject({ cls: 'timeout' });
    });

    it('everything fails: offer the whole screen (the window\'s monitor), never silent', async () => {
        const d = deps({
            attemptSafe: vi.fn(async () => { throw NOT_READABLE; }),
            attemptCrop: vi.fn(async () => { throw ABORT_REFUSED; }),
        });
        const r = await runWindowFallbackLadder(ABORT_REFUSED, d);
        expect(r).toMatchObject({ kind: 'offer_screen', screenId: 'screen:0:0' });
        expect(d.logs.map(l => l.to)).toEqual(['safe', 'monitor_crop', 'offer_screen']);
        expect(d.cleanup).toHaveBeenCalledTimes(2);
    });

    it('exclusive fullscreen (minimised on alt-tab): no pointless retries, straight to the offer', async () => {
        const d = deps({ geos: [geo(win({ minimized: true }))] });
        const r = await runWindowFallbackLadder(NOT_READABLE, d);
        expect(r.kind).toBe('offer_screen');
        expect(d.attemptSafe).not.toHaveBeenCalled();
        expect(d.attemptCrop).not.toHaveBeenCalled();
        expect(d.logs[0]).toMatchObject({ to: 'offer_screen', win_min: true });
    });

    it('no crop support (or the window off-screen): the safe retry, then the offer', async () => {
        const d = deps({ cropSupported: false, attemptSafe: vi.fn(async () => { throw ABORT_REFUSED; }) });
        const r = await runWindowFallbackLadder(ABORT_REFUSED, d);
        expect(r.kind).toBe('offer_screen');
        expect(d.attemptCrop).not.toHaveBeenCalled();
    });

    it('the user declined the consent dialog: give up with the original error, nothing retried', async () => {
        const d = deps({ resolves: ['denied_declined'] });
        const r = await runWindowFallbackLadder(ABORT_REFUSED, d);
        expect(r).toEqual({ kind: 'give_up', err: ABORT_REFUSED });
        expect(d.attemptSafe).not.toHaveBeenCalled();
    });

    it('the window was closed: give up', async () => {
        const d = deps({ geos: [geo(win({ exists: false }))] });
        expect((await runWindowFallbackLadder(ABORT_REFUSED, d)).kind).toBe('give_up');
    });

    it('a failing geometry / resolve lookup never breaks the ladder', async () => {
        const d = deps({
            resolveOutcome: async () => { throw new Error('ipc'); },
            geometry: async () => { throw new Error('ipc'); },
        });
        expect(await runWindowFallbackLadder(ABORT_REFUSED, d)).toEqual({ kind: 'published', via: 'safe', plan: null });
    });

    // The real capture call: publishScreenShareSettled -> createScreenTracks (= getDisplayMedia) rejecting
    // with the AbortError of the report, then succeeding at the safer ask.
    it('reproduces the report: getDisplayMedia rejects AbortError at the Pro ask, the safe ask publishes', async () => {
        const asks: Array<{ width?: number; height?: number; frameRate?: number }> = [];
        const track = { kind: 'video', stop: vi.fn(), mediaStreamTrack: { readyState: 'live', getSettings: () => ({}) } };
        const lp = {
            getTrackPublication: () => undefined,
            setScreenShareEnabled: vi.fn(),
            publishTrack: vi.fn(async () => ({})),
            createScreenTracks: vi.fn(async (o: { resolution?: { width?: number; height?: number; frameRate?: number } }) => {
                asks.push({ ...o.resolution });
                if ((o.resolution?.frameRate ?? 0) > SAFE_WINDOW_FPS) throw ABORT_REFUSED;
                return [track];
            }),
        } as unknown as SettledPublishParticipant;
        const capture = (box: { width: number; height: number }, fps: number) =>
            publishScreenShareSettled(lp, { resolution: { ...box, frameRate: fps } }, {}, { waitOptions: { timeoutMs: 0 } });

        let first: unknown = null;
        try { await capture({ width: 3840, height: 2160 }, 75); } catch (e) { first = e; }
        expect((first as Error).name).toBe('AbortError');

        const d = deps({
            resolves: ['ok'],
            attemptSafe: async () => {
                const s = safeWindowCapture({ width: 3840, height: 2160 }, 75);
                await capture(s.box, s.fps);
            },
        });
        const r = await runWindowFallbackLadder(first, d);
        expect(r).toEqual({ kind: 'published', via: 'safe', plan: null });
        expect(asks).toEqual([{ width: 3840, height: 2160, frameRate: 75 }, { width: 1920, height: 1080, frameRate: 30 }]);
        expect(lp.publishTrack).toHaveBeenCalledTimes(1);
    });
});
