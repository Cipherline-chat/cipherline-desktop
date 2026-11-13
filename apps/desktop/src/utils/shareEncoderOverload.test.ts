import { describe, it, expect } from 'vitest';
import {
    EncoderOverloadWatch, evaluateWindow, readOverloadSnapshot, suggestSetting, resolveOption, summarizeEvidence,
    describeOption, shortOption, sizeChange, suggestionInputs, overloadEventDetail, overloadNoteDetail, settingKey, OVERLOAD_NOTE_MAX,
    OVERLOAD_SETTLE_MS, OVERLOAD_SUSTAIN_MS, type OverloadObserveContext, type OverloadSnapshot, type OverloadWindow,
} from './shareEncoderOverload';
import { logCallEvent, getCallEvents, clearCallEvents, validateCallEvent } from './callEventLog';

// ── a sender report, built the way Chromium reports it ────────────────────
interface Layer { rid: string; w: number; h: number; fps: number; encMs: number; cpuFracOfWindow?: number }
interface Phase { layers: Layer[]; src?: number; reason?: string; seconds: number }

/** Cumulative stats generator: advance with phases, read a report at the end of each step. */
class Sender {
    t = 0;
    private frames = new Map<string, number>();
    private enc = new Map<string, number>();
    private cpu = new Map<string, number>();
    private last: Phase | null = null;
    private resetBase = 0;
    advance(p: Phase): void {
        this.t += p.seconds;
        for (const l of p.layers) {
            this.frames.set(l.rid, (this.frames.get(l.rid) ?? 0) + l.fps * p.seconds);
            this.enc.set(l.rid, (this.enc.get(l.rid) ?? 0) + (l.fps * p.seconds * l.encMs) / 1000);
            this.cpu.set(l.rid, (this.cpu.get(l.rid) ?? 0) + (l.cpuFracOfWindow ?? 0) * p.seconds);
        }
        this.last = p;
    }
    /** A republish: every counter restarts from 0. */
    reset(): void { this.frames.clear(); this.enc.clear(); this.cpu.clear(); this.resetBase++; }
    report() {
        const p = this.last!;
        const entries: Record<string, unknown>[] = p.layers.map(l => ({
            type: 'outbound-rtp', kind: 'video', rid: l.rid, active: true, frameWidth: l.w, frameHeight: l.h,
            framesEncoded: this.frames.get(l.rid) ?? 0, totalEncodeTime: this.enc.get(l.rid) ?? 0,
            qualityLimitationReason: p.reason ?? 'none',
            qualityLimitationDurations: { cpu: this.cpu.get(l.rid) ?? 0, bandwidth: 0, none: 0, other: 0 },
            powerEfficientEncoder: true, encoderImplementation: 'SimulcastEncoderAdapter (VideoToolbox, VideoToolbox)',
        }));
        if (p.src !== undefined) entries.push({ type: 'media-source', kind: 'video', framesPerSecond: p.src });
        return { forEach: (cb: (s: Record<string, unknown>) => void) => entries.forEach(cb) };
    }
}

const LOW: Layer = { rid: 'q', w: 1280, h: 720, fps: 30, encMs: 3 };
const SOURCE_OPT = { resolution: 'source', frameRate: 90 } as const;
const SUG_OPT = { resolution: '1440p', frameRate: 90 } as const;
const ctx = (o: Partial<OverloadObserveContext> = {}): OverloadObserveContext => ({
    setting: { resolution: 'source', frameRate: 90 }, targetFps: 90, blocked: false, suppressed: false, ...o,
});

/** Run a watch over `phases` at 10 s cadence; return the time of the first verdict (or null). */
function run(phases: Phase[], c: OverloadObserveContext = ctx(), watch = new EncoderOverloadWatch()) {
    const s = new Sender();
    watch.restart(0);
    let verdict: ReturnType<EncoderOverloadWatch['observe']> = null;
    let at: number | null = null;
    watch.observe(0, (s.advance({ ...phases[0], seconds: 0 }), s.report()), c);
    for (const p of phases) {
        for (let k = 0; k < p.seconds / 10; k++) {
            s.advance({ ...p, seconds: 10 });
            const v = watch.observe(s.t * 1000, s.report(), c);
            if (v && !verdict) { verdict = v; at = s.t; }
        }
    }
    return { verdict, at, watch, s };
}

// Real numbers from the two reports (base Apple M5, H.265, VideoToolbox).
const SRC = 90;
const OVERLOADED_3024: Phase = { seconds: 10, src: SRC, layers: [{ rid: 'h', w: 3024, h: 1964, fps: 55, encMs: 80 }, LOW] };
const CPU_SCALED_2268: Phase = { seconds: 10, src: SRC, reason: 'cpu', layers: [{ rid: 'h', w: 2268, h: 1472, fps: 90, encMs: 10.2, cpuFracOfWindow: 1 }, LOW] };
const HEALTHY_RTX: Phase = { seconds: 10, src: SRC, layers: [{ rid: 'h', w: 2560, h: 1440, fps: 90, encMs: 6.5 }, LOW] };
const rep = (n: number, p: Phase): Phase[] => Array.from({ length: n }, () => ({ ...p }));

describe('reading the TOP layer', () => {
    it('the top layer is the largest active picture; layers sum separately', () => {
        const s = new Sender(); s.advance({ seconds: 10, src: 90, layers: [LOW, { rid: 'h', w: 3024, h: 1964, fps: 60, encMs: 12 }] });
        const snap = readOverloadSnapshot(s.report(), 1)!;
        expect(snap.layers.map(l => l.rid)).toEqual(['h', 'q']);
        expect(snap.layerSet).toBe('h|q');
        expect(snap.srcFps).toBe(90);
    });
    it('judges the top layer alone: 60+30 summed fps looks like 90 and hides a top layer at 30 fps', () => {
        const s = new Sender();
        s.advance({ seconds: 0, src: 60, layers: [{ rid: 'h', w: 3024, h: 1964, fps: 30, encMs: 70 }, LOW] });
        const a = readOverloadSnapshot(s.report(), 0)!;
        s.advance({ seconds: 10, src: 60, layers: [{ rid: 'h', w: 3024, h: 1964, fps: 30, encMs: 70 }, LOW] });
        const w = evaluateWindow(a, readOverloadSnapshot(s.report(), 10_000)!, 60);
        expect(w).toMatchObject({ valid: true, overloaded: true, slow: true });
        expect((w as OverloadWindow).encFps).toBeCloseTo(30);
        // the lighter copy is measured on its own: 30 fps of 1280x720
        expect((w as OverloadWindow).lowRate).toBeCloseTo(30 * 1280 * 720);
    });
});

describe('detection - positives', () => {
    it('base M5, 3024x1964 at 90: top layer 55 fps at 80 ms per frame -> verdict after settle + sustain, not before', () => {
        const { verdict, at } = run(rep(8, OVERLOADED_3024));
        expect(verdict).not.toBeNull();
        // settle 25 s, then 3 windows of 10 s
        expect(at).toBe(50);
        expect(at! * 1000).toBeGreaterThanOrEqual(OVERLOAD_SETTLE_MS + OVERLOAD_SUSTAIN_MS - 10_000);
        expect(verdict!.evidence.encMs).toBeCloseTo(80, 0);
        expect(verdict!.evidence.encFps).toBeCloseTo(55, 0);
        expect(verdict!.key).toBe('source@90');
    });
    it('a cpu-limited stretch counts: libwebrtc scaled to 2268x1472 and the encode time looks healthy (10 ms)', () => {
        const { verdict } = run(rep(8, CPU_SCALED_2268));
        expect(verdict).not.toBeNull();
        expect(verdict!.evidence.cpuPct).toBe(100);
        expect(verdict!.evidence.provenTotal).toBeGreaterThan(300e6); // 2268x1472x90 + the lighter copy
    });
    it('the Mac flip (overloaded, cpu-scaled, overloaded) is one sustained overload, not three short ones', () => {
        const { verdict } = run([OVERLOADED_3024, OVERLOADED_3024, ...rep(2, CPU_SCALED_2268), ...rep(2, OVERLOADED_3024), ...rep(2, CPU_SCALED_2268)]);
        expect(verdict).not.toBeNull();
    });
    it('on a 60 Hz display asked for 90: offered fps is the capture\'s 60, so 30 fps out at 70 ms is overload', () => {
        const p: Phase = { seconds: 10, src: 60, layers: [{ rid: 'h', w: 3024, h: 1964, fps: 30, encMs: 70 }, LOW] };
        expect(run(rep(8, p)).verdict).not.toBeNull();
    });
});

describe('detection - negatives (must stay silent)', () => {
    it('Windows RTX at 1440p90, 6.5 ms per frame: never', () => {
        expect(run(rep(30, HEALTHY_RTX)).verdict).toBeNull();
    });
    it('the base M5 at 3024x1964 / 60 fps (12.5 ms, 60 fps out): healthy, never', () => {
        const p: Phase = { seconds: 10, src: 60, layers: [{ rid: 'h', w: 3024, h: 1964, fps: 60, encMs: 12.5 }, LOW] };
        expect(run(rep(30, p), ctx({ setting: { resolution: 'source', frameRate: 60 }, targetFps: 60 })).verdict).toBeNull();
    });
    it('the 10-20 s bandwidth ramp after a publish (fps 9 -> 21 -> 60 at 6-12 ms per frame) is not the encoder', () => {
        const ramp: Phase[] = [9, 21, 28, 40, 50, 57, 60, 60].map(fps => ({ seconds: 10, src: 60, layers: [{ rid: 'h', w: 3024, h: 1964, fps, encMs: 11 }, LOW] }));
        expect(run(ramp, ctx({ setting: { resolution: 'source', frameRate: 60 }, targetFps: 60 })).verdict).toBeNull();
    });
    it('a bandwidth limit (reason bandwidth, low fps, fast encodes): not the encoder', () => {
        const p: Phase = { seconds: 10, src: 90, reason: 'bandwidth', layers: [{ rid: 'h', w: 2560, h: 1440, fps: 25, encMs: 8 }, LOW] };
        expect(run(rep(20, p)).verdict).toBeNull();
    });
    it('a low-motion screen (capture delivers 5 fps, encoder encodes 5 fps): not the encoder', () => {
        const p: Phase = { seconds: 10, src: 5, layers: [{ rid: 'h', w: 2560, h: 1440, fps: 5, encMs: 4 }, LOW] };
        expect(run(rep(20, p)).verdict).toBeNull();
    });
    it('a capture that is not delivering frames is the capture stall\'s to report, even with a slow encoder', () => {
        const p: Phase = { seconds: 10, src: 20, layers: [{ rid: 'h', w: 3024, h: 1964, fps: 10, encMs: 90 }, LOW] };
        expect(run(rep(20, p)).verdict).toBeNull();
    });
    it('nothing before the settle period is over, however bad the numbers', () => {
        const r = run(rep(8, OVERLOADED_3024));
        // windows are judged from 30 s on (25 s settle), and three of them are needed
        expect(r.at).toBe(50);
        expect(run(rep(4, OVERLOADED_3024)).verdict).toBeNull(); // 40 s of bad numbers: still inside settle + sustain
    });
    it('a share that is being (re)published is not judged, and the wait starts over', () => {
        const watch = new EncoderOverloadWatch();
        const s = new Sender(); watch.restart(0);
        watch.observe(0, (s.advance({ ...OVERLOADED_3024, seconds: 0 }), s.report()), ctx());
        let at: number | null = null;
        for (let i = 1; i <= 12; i++) {
            s.advance(OVERLOADED_3024);
            // a republish in flight for the whole of 30..50 s
            if (watch.observe(s.t * 1000, s.report(), ctx({ blocked: s.t >= 30 && s.t <= 50 })) && at === null) at = s.t;
        }
        // settle restarted when the republish ended (50 s): judged from 80 s, three windows -> 100 s, not 50 s
        expect(at).toBe(100);
    });
    it('a counter reset (republish restarts every counter) clears the streak - never a rate from a negative delta', () => {
        const watch = new EncoderOverloadWatch();
        const s = new Sender(); watch.restart(0);
        watch.observe(0, (s.advance({ ...OVERLOADED_3024, seconds: 0 }), s.report()), ctx());
        const seen: unknown[] = [];
        for (let i = 1; i <= 7; i++) {
            if (i === 5) s.reset();
            s.advance(OVERLOADED_3024);
            seen.push(watch.observe(s.t * 1000, s.report(), ctx()));
        }
        // 30 s sustained would have landed at i=5 (t=50); the reset at i=5 voids that window and starts over
        expect(seen.slice(0, 5).every(v => v === null)).toBe(true);
    });
    it('a change of the active layers (dynacast pauses the lighter copy) is not comparable: the streak starts over', () => {
        const phases: Phase[] = [
            ...rep(3, OVERLOADED_3024),
            { seconds: 10, src: SRC, layers: [{ rid: 'h', w: 3024, h: 1964, fps: 55, encMs: 80 }] },
            { seconds: 10, src: SRC, layers: [{ rid: 'h', w: 3024, h: 1964, fps: 55, encMs: 80 }] },
        ];
        const { at } = run(phases);
        expect(at === null || at > 50).toBe(true);
    });
    it('one healthy window breaks the streak', () => {
        const phases: Phase[] = [...rep(5, OVERLOADED_3024), { ...HEALTHY_RTX }, ...rep(1, OVERLOADED_3024)];
        const { verdict } = run(phases);
        expect(verdict).not.toBeNull(); // sustained by t=50 before the healthy window...
        const broken = run([...rep(2, OVERLOADED_3024), ...rep(1, HEALTHY_RTX), ...rep(2, OVERLOADED_3024), ...rep(1, HEALTHY_RTX), ...rep(2, OVERLOADED_3024)]);
        expect(broken.verdict).toBeNull();
    });
});

describe('once per setting, dismissals, suppression, never automatic', () => {
    it('says it once per setting; a dismissed setting stays dismissed across restarts; another setting is judged afresh', () => {
        const watch = new EncoderOverloadWatch();
        const first = run(rep(12, OVERLOADED_3024), ctx(), watch);
        expect(first.verdict).not.toBeNull();
        // the same setting keeps overloading: no second notice
        const s2 = first.s; let again = null as unknown;
        for (let i = 0; i < 6; i++) { s2.advance(OVERLOADED_3024); again = watch.observe(s2.t * 1000, s2.report(), ctx()) ?? again; }
        expect(again).toBeNull();
        // dismissed, share republished at the same setting (restart): stays quiet
        watch.dismiss('source@90');
        watch.restart(s2.t * 1000);
        for (let i = 0; i < 10; i++) { s2.advance(OVERLOADED_3024); again = watch.observe(s2.t * 1000, s2.report(), ctx()) ?? again; }
        expect(again).toBeNull();
        // the user moves to 1440p at 90 and that still overloads: a fresh notice, with fresh numbers
        watch.restart(s2.t * 1000);
        let next = null as ReturnType<typeof watch.observe>;
        for (let i = 0; i < 8; i++) {
            s2.advance({ seconds: 10, src: SRC, layers: [{ rid: 'h', w: 2217, h: 1440, fps: 60, encMs: 60 }, LOW] });
            next = watch.observe(s2.t * 1000, s2.report(), ctx({ setting: { resolution: '1440p', frameRate: 90 } })) ?? next;
        }
        expect(next).not.toBeNull();
        expect(next!.key).toBe('1440p@90');
        expect(next!.evidence.encFps).toBeCloseTo(60, 0);
    });
    it('another notice on screen defers it (not consumed), then it is said when the way is clear', () => {
        const watch = new EncoderOverloadWatch();
        const s = new Sender(); watch.restart(0);
        watch.observe(0, (s.advance({ ...OVERLOADED_3024, seconds: 0 }), s.report()), ctx());
        let said = 0;
        for (let i = 1; i <= 9; i++) {
            s.advance(OVERLOADED_3024);
            if (watch.observe(s.t * 1000, s.report(), ctx({ suppressed: i < 8 }))) said++;
        }
        expect(said).toBe(1);
    });
});

describe('the suggestion', () => {
    const src = { width: 3024, height: 1964 };
    const m5Run1 = (() => {
        const { verdict } = run(rep(8, OVERLOADED_3024));
        return verdict!.evidence;
    })();

    it('FIXTURE base M5: Source 90 overloaded (55 fps of 3024x1964 + the lighter copy) -> 1440p at 90, which the same chip ran healthy', () => {
        const sug = suggestSetting({ current: { resolution: 'source', frameRate: 90 }, codec: 'h265', source: src, maxFps: 90, budgetTop: m5Run1.budgetTop, srcFpsCap: m5Run1.srcFps });
        expect(sug).toMatchObject({ resolution: '1440p', frameRate: 90, width: 2218, height: 1440, floor: false });
        // the measured healthy point (2268x1472 at 90, libwebrtc's own scale) is above this suggestion's rate: it is sustainable
        expect(sug!.rate).toBeLessThan(2268 * 1472 * 90);
    });
    it('FIXTURE base M5 cpu-scaled run: the proven 2268x1472@90 + lighter copy budget also yields 1440p at 90', () => {
        const { verdict } = run(rep(8, CPU_SCALED_2268));
        const sug = suggestSetting({ current: { resolution: 'source', frameRate: 90 }, codec: 'h265', source: src, maxFps: 90, budgetTop: verdict!.evidence.budgetTop });
        expect(sug).toMatchObject({ resolution: '1440p', frameRate: 90 });
    });
    it('is the highest-rate real option under the budget (checked against a brute-force enumeration)', () => {
        for (const budget of [60e6, 120e6, 160e6, 200e6, 260e6, 300e6]) {
            const sug = suggestSetting({ current: { resolution: 'source', frameRate: 90 }, codec: 'h265', source: src, maxFps: 90, budgetTop: budget })!;
            const all = (['source', '1440p', '1080p', '720p', '480p'] as const).flatMap(resolution => [90, 60, 30, 15].map(frameRate => resolveOption({ resolution, frameRate }, 'h265', src)))
                .filter(o => o.rate <= budget && o.rate < resolveOption({ resolution: 'source', frameRate: 90 }, 'h265', src).rate * 0.98);
            const best = Math.max(...all.map(o => o.rate));
            expect(sug.rate).toBeLessThanOrEqual(budget);
            expect(sug.rate).toBeGreaterThanOrEqual(best * 0.97);
        }
    });
    it('chooses the highest stable pixel rate; ties go to the chosen frame rate', () => {
        // two options within 3 % of each other: the one at the user's 60 fps wins over a higher res at 30
        const a = resolveOption({ resolution: '1080p', frameRate: 60 }, 'h264', { width: 1920, height: 1080 });
        const b = resolveOption({ resolution: '1080p', frameRate: 30 }, 'h264', { width: 1920, height: 1080 });
        expect(a.rate).toBeGreaterThan(b.rate);
        const sug = suggestSetting({ current: { resolution: 'source', frameRate: 60 }, codec: 'h264', source: { width: 3840, height: 2160 }, maxFps: 90, budgetTop: a.rate });
        expect(sug).toMatchObject({ resolution: '1080p', frameRate: 60 });
    });
    it('never suggests the current setting or anything that is not less work; null when nothing is lower', () => {
        expect(suggestSetting({ current: { resolution: '480p', frameRate: 15 }, codec: 'h264', source: { width: 1920, height: 1080 }, maxFps: 90, budgetTop: 1e12 })).toBeNull();
        const sug = suggestSetting({ current: { resolution: '1080p', frameRate: 30 }, codec: 'h264', source: { width: 1920, height: 1080 }, maxFps: 90, budgetTop: 1e12 });
        expect(sug && sug.rate).toBeLessThan(1920 * 1080 * 30);
    });
    it('a window source is offered 60 at most; a 60 Hz capture offers no 90 and no 90 is suggested as if it did', () => {
        const sug = suggestSetting({ current: { resolution: 'source', frameRate: 60 }, codec: 'h264', source: src, maxFps: 60, budgetTop: 1e12 });
        expect(sug!.frameRate).toBeLessThanOrEqual(60);
        const capped = resolveOption({ resolution: '1440p', frameRate: 90 }, 'h265', src, 60);
        expect(capped.fps).toBe(60);
    });
    it('nothing fits the estimate: a clear step down (half the work), flagged as a floor, never silence', () => {
        const sug = suggestSetting({ current: { resolution: 'source', frameRate: 90 }, codec: 'h265', source: src, maxFps: 90, budgetTop: 1e6 });
        expect(sug).not.toBeNull();
        expect(sug!.floor).toBe(true);
        expect(sug!.rate).toBeLessThanOrEqual(resolveOption({ resolution: 'source', frameRate: 90 }, 'h265', src).rate * 0.5);
    });
    it('uses the same codec clamp as the share: an 8K source is held to 4K before any rate is computed', () => {
        const o = resolveOption({ resolution: 'source', frameRate: 30 }, 'h265', { width: 7680, height: 4320 });
        expect(o.width).toBeLessThanOrEqual(3840);
        expect(o.height).toBeLessThanOrEqual(2160);
    });
});

describe('evidence maths', () => {
    const w = (o: Partial<OverloadWindow>): OverloadWindow => ({
        dtS: 10, overloaded: true, cpuLimited: false, slow: true, encFps: 55, encMs: 80, offeredFps: 90, topPixels: 5.9e6,
        topRate: 55 * 5.9e6, lowRate: 27.6e6, cpuFrac: 0, provenUp: false, starved: false, ...o,
    });
    it('an unproven rate is discounted; a proven one is not', () => {
        const e1 = summarizeEvidence([w({})]);
        expect(e1.provenTotal).toBe(0);
        expect(e1.budgetTop).toBeCloseTo(0.9 * (55 * 5.9e6 + 27.6e6) - 27.6e6, -3);
        const e2 = summarizeEvidence([w({}), w({ encFps: 90, topPixels: 3.3e6, topRate: 90 * 3.3e6, provenUp: true })]);
        expect(e2.provenTotal).toBeCloseTo(90 * 3.3e6 + 27.6e6, -3);
        expect(e2.budgetTop).toBeGreaterThan(e1.budgetTop - 1);
    });
});

describe('words and events', () => {
    it('plain wording with the app\'s own names', () => {
        expect(shortOption(SOURCE_OPT)).toBe('Source at 90 fps');
        expect(shortOption(SUG_OPT)).toBe('1440p at 90 fps');
        expect(describeOption({ resolution: '1080p', width: 1920, height: 1080, frameRate: 60 }, 'High')).toBe('High (1080p (1920×1080) at 60 fps)');
    });
    it('the event is content-free, at most 11 keys, and valid in the call event log', () => {
        const { verdict } = run(rep(8, OVERLOADED_3024));
        const sug = suggestSetting({ current: { resolution: 'source', frameRate: 90 }, codec: 'h265', source: { width: 3024, height: 1964 }, maxFps: 90, budgetTop: verdict!.evidence.budgetTop });
        for (const phase of ['shown', 'accepted', 'dismissed', 'none'] as const) {
            const d = overloadEventDetail(phase, verdict!.key, verdict!.evidence, sug);
            expect(Object.keys(d).length).toBeLessThanOrEqual(11);
            clearCallEvents();
            logCallEvent('share_encoder_overload', d);
            const ev = getCallEvents().find(e => e.kind === 'share_encoder_overload')!;
            expect(ev.detail).toMatchObject({ phase, setting: 'source@90', sug: settingKey(sug!) });
            expect(Object.keys(ev.detail!).length).toBe(Object.keys(d).length); // nothing truncated away
            expect(validateCallEvent(ev)).toEqual([]);
        }
    });
});

// keep the unused-type import honest
export type _S = OverloadSnapshot;

describe('sizeChange', () => {
    it('says the real pixels when the size changes', () => {
        expect(sizeChange({ width: 3024, height: 1964 }, { width: 2216, height: 1438 })).toBe('3024×1964 → 2216×1438');
    });
    it('says nothing when only the frame rate changes', () => {
        expect(sizeChange({ width: 1920, height: 1080 }, { width: 1920, height: 1080 })).toBeNull();
    });
});

// ── why the watch did not judge (phase = state) ────────────────────────────
describe('reasons are reported when they CHANGE, not every tick', () => {
    const whys = (w: EncoderOverloadWatch) => w.takeNotes().map(n => n.why);

    it('a fresh watch\'s first restart is not news; a later restart is', () => {
        const watch = new EncoderOverloadWatch();
        watch.restart(0);
        expect(whys(watch)).toEqual([]);
        const s = new Sender(); s.advance({ ...HEALTHY_RTX, seconds: 0 });
        watch.observe(0, s.report(), ctx());
        s.advance(HEALTHY_RTX);
        watch.observe(s.t * 1000, s.report(), ctx());
        expect(whys(watch)).toEqual([]);
        watch.restart(s.t * 1000);
        expect(whys(watch)).toEqual(['restart']);
        watch.restart(s.t * 1000); // twice in a row: still one
        expect(whys(watch)).toEqual([]);
    });

    it('blocked (a republish in flight) is said once, however many ticks it lasts', () => {
        const watch = new EncoderOverloadWatch();
        const s = new Sender(); watch.restart(0); s.advance({ ...HEALTHY_RTX, seconds: 0 });
        watch.observe(0, s.report(), ctx());
        for (let i = 0; i < 6; i++) { s.advance(HEALTHY_RTX); watch.observe(s.t * 1000, s.report(), ctx({ blocked: true })); }
        expect(whys(watch)).toEqual(['blocked']);
    });

    it('the capture under half the target is no_capture, with the capture rate; recovered is said when an overloaded stretch ends', () => {
        const watch = new EncoderOverloadWatch();
        const { s } = run(rep(6, { ...OVERLOADED_3024, src: 30 }), ctx(), watch); // src 30 < half of 90
        const notes = watch.takeNotes();
        expect(notes.map(n => n.why)).toEqual(['no_capture']);
        expect(notes[0].srcFps).toBe(30);
        // overloaded for 20 s, then the encoder recovers: the evidence it had is reported
        for (let i = 0; i < 2; i++) { s.advance(OVERLOADED_3024); watch.observe(s.t * 1000, s.report(), ctx()); }
        s.advance(HEALTHY_RTX); watch.observe(s.t * 1000, s.report(), ctx());
        const after = watch.takeNotes();
        expect(after.map(n => n.why)).toEqual(['recovered']);
        expect(after[0].secs).toBe(20);
    });

    it('a layer-set change (dynacast) and a counter reset are named', () => {
        const watch = new EncoderOverloadWatch();
        const { s } = run(rep(4, HEALTHY_RTX), ctx(), watch);
        watch.takeNotes();
        s.advance({ seconds: 10, src: SRC, layers: [{ rid: 'h', w: 2560, h: 1440, fps: 90, encMs: 6.5 }] }); // lighter copy paused
        watch.observe(s.t * 1000, s.report(), ctx());
        s.advance({ seconds: 10, src: SRC, layers: [{ rid: 'h', w: 2560, h: 1440, fps: 90, encMs: 6.5 }] });
        watch.observe(s.t * 1000, s.report(), ctx());
        s.reset();
        s.advance({ seconds: 10, src: SRC, layers: [{ rid: 'h', w: 2560, h: 1440, fps: 90, encMs: 6.5 }] });
        watch.observe(s.t * 1000, s.report(), ctx());
        expect(whys(watch)).toEqual(['layers', 'reset']);
    });

    it('a verdict held back by another notice is suppressed; by a dismissal, dismissed', () => {
        const watch = new EncoderOverloadWatch();
        const s = new Sender(); watch.restart(0);
        watch.observe(0, (s.advance({ ...OVERLOADED_3024, seconds: 0 }), s.report()), ctx());
        for (let i = 1; i <= 8; i++) { s.advance(OVERLOADED_3024); watch.observe(s.t * 1000, s.report(), ctx({ suppressed: true })); }
        const notes = watch.takeNotes();
        expect(notes.map(n => n.why)).toEqual(['suppressed']);
        expect(notes[0].secs).toBeGreaterThanOrEqual(30);
        watch.dismiss('source@90');
        s.advance(OVERLOADED_3024); watch.observe(s.t * 1000, s.report(), ctx());
        expect(whys(watch)).toEqual(['dismissed']);
    });

    it('is capped per share, so a flapping state cannot flood the log', () => {
        const watch = new EncoderOverloadWatch();
        const s = new Sender(); watch.restart(0); s.advance({ ...HEALTHY_RTX, seconds: 0 });
        watch.observe(0, s.report(), ctx());
        let total = 0;
        for (let i = 0; i < 100; i++) {
            s.advance(HEALTHY_RTX);
            watch.observe(s.t * 1000, s.report(), ctx({ blocked: i % 2 === 0 }));
            watch.observe(s.t * 1000 + 1, s.report(), ctx({ blocked: false }));
            total += watch.takeNotes().length;
        }
        expect(total).toBe(OVERLOAD_NOTE_MAX);
    });

    it('the logged detail is a valid call event of enums and counts only', () => {
        const d = overloadNoteDetail({ why: 'no_capture', secs: 12, srcFps: 31.5 }, 'source@90', 90);
        expect(d).toEqual({ phase: 'state', why: 'no_capture', setting: 'source@90', secs: 12, target: 90, src_fps: 31.5 });
        clearCallEvents();
        logCallEvent('share_encoder_overload', d);
        const ev = getCallEvents()[0];
        expect(ev.detail).toEqual(d);
        expect(validateCallEvent(ev)).toEqual([]);
        clearCallEvents();
    });
});


// ── a CPU-starved machine: the capture collapses together with the encoder ─
// Lab (Linux X11, sharer container `--cpus=2`, whole-screen 1080p, 90 fps target, VP8 software): libwebrtc says `cpu`
// from the second sample on, the capture delivers 5-10 fps, the encoder 2-8. The watch used to call every one of
// those windows no_capture and say nothing, for the whole share.
describe('CPU-starved capture (capture under half the target, encoder cpu-limited)', () => {
    const TOP_1080 = { rid: 'h', w: 1920, h: 1080 };
    const STARVED = (src: number, fps: number): Phase => ({
        seconds: 10, src, reason: 'cpu', layers: [{ ...TOP_1080, fps, encMs: 140, cpuFracOfWindow: 1 }],
    });
    // recorded-shaped: capture 10, 5, 7, 9, 6, 8 ... encode 2-8
    const LAB: Phase[] = [[10, 8], [5, 3], [7, 4], [9, 5], [6, 2], [8, 6], [7, 4], [5, 3], [9, 5], [6, 4], [8, 5], [7, 4]].map(([a, b]) => STARVED(a, b));
    const HEALTHY_90: Phase = { seconds: 10, src: 90, layers: [{ ...TOP_1080, fps: 90, encMs: 6 }] };
    const lab = (c: OverloadObserveContext = ctx()) => run(LAB, c);

    it('(a) the lab case: a verdict inside a bounded time (settle + sustain + one sample), flagged starved', () => {
        const { verdict, at, watch } = lab();
        expect(verdict).not.toBeNull();
        expect(at).toBeLessThanOrEqual((OVERLOAD_SETTLE_MS + OVERLOAD_SUSTAIN_MS) / 1000 + 10);
        expect(verdict!.key).toBe('source@90');
        expect(verdict!.evidence.starved).toBe(true);
        expect(verdict!.evidence.srcFps).toBeLessThan(10);
        expect(verdict!.evidence.cpuPct).toBe(100);
        // the reason is on the record, once
        expect(watch.takeNotes().map(n => n.why)).toContain('cpu_starved');
        // said once per setting: the rest of the 120 s adds nothing
        expect(lab().verdict).not.toBeNull();
        let verdicts = 0;
        const w2 = new EncoderOverloadWatch(); const s = new Sender(); w2.restart(0);
        w2.observe(0, (s.advance({ ...LAB[0], seconds: 0 }), s.report()), ctx());
        for (const p of LAB) { s.advance(p); if (w2.observe(s.t * 1000, s.report(), ctx())) verdicts++; }
        expect(verdicts).toBe(1);
    });

    it('(a) the window is judged against the TARGET, not against the starved capture', () => {
        const s = new Sender(); s.advance({ ...LAB[0], seconds: 0 });
        const a = readOverloadSnapshot(s.report(), 0)!;
        s.advance(STARVED(7, 7)); // the encoder kept up with the 7 fps the capture gave it
        const b = readOverloadSnapshot(s.report(), 10_000)!;
        const w = evaluateWindow(a, b, 90);
        expect(w.valid && w.starved && w.overloaded).toBe(true);
        if (w.valid) { expect(w.offeredFps).toBe(90); expect(w.provenUp).toBe(false); }
    });

    it('(a) the suggestion is a real step down (at most half the work), fitted from the target not the collapsed rate', () => {
        const { verdict } = lab();
        const fit = suggestionInputs(verdict!.evidence);
        expect(fit).toEqual({ budgetTop: 0, srcFpsCap: undefined });
        const src = { width: 1920, height: 1080 };
        const cur = resolveOption(SOURCE_OPT, 'vp8', src);
        const sug = suggestSetting({ current: SOURCE_OPT, codec: 'vp8', source: src, maxFps: 90, ...fit })!;
        expect(sug).not.toBeNull();
        expect(sug.rate).toBeLessThanOrEqual(cur.rate * 0.5);
        expect(sug.frameRate === 90 && sug.resolution === 'source').toBe(false);
        // a normal verdict keeps its measured inputs
        const normal = run(rep(8, OVERLOADED_3024)).verdict!;
        expect(normal.evidence.starved).toBe(false);
        expect(suggestionInputs(normal.evidence).budgetTop).toBe(normal.evidence.budgetTop);
    });

    it('(b) a healthy 90 fps share never speaks', () => {
        const { verdict, watch } = run(rep(12, HEALTHY_90));
        expect(verdict).toBeNull();
        expect(watch.takeNotes().map(n => n.why)).toEqual([]);
    });

    it('the first samples after a start never speak, however starved (settle)', () => {
        expect(run(LAB.slice(0, 2)).verdict).toBeNull();
        expect(run(LAB.slice(0, 4)).verdict).toBeNull(); // 40 s: settled at 25, only 15 s of evidence
    });

    it('(c) a brief 2-sample dip does nothing, and the streak starts over after it', () => {
        const dip = [...rep(4, HEALTHY_90), STARVED(7, 4), STARVED(6, 3), ...rep(8, HEALTHY_90)];
        const { verdict, watch } = run(dip);
        expect(verdict).toBeNull();
        expect(watch.takeNotes().map(n => n.why)).toEqual(['cpu_starved', 'recovered']);
        // two dips of 20 s with a healthy window between them do not add up to 40 s
        expect(run([...rep(4, HEALTHY_90), STARVED(7, 4), STARVED(6, 3), HEALTHY_90, STARVED(7, 4), STARVED(6, 3), ...rep(4, HEALTHY_90)]).verdict).toBeNull();
    });

    it('(d) the user\'s "no" holds: dismissed for this setting says nothing and does not throw', () => {
        const watch = new EncoderOverloadWatch(); watch.dismiss('source@90');
        const { verdict } = run(LAB, ctx(), watch);
        expect(verdict).toBeNull();
        expect(watch.takeNotes().map(n => n.why)).toContain('dismissed');
        expect(watch.isDismissed('source@90')).toBe(true);
        // another setting of the same share is judged afresh
        const other = run(LAB, ctx({ setting: { resolution: '1080p', frameRate: 60 }, targetFps: 60 }), watch);
        expect(other.verdict?.key).toBe('1080p@60');
        // and another notice up = held back, not lost
        expect(run(LAB, ctx({ suppressed: true })).verdict).toBeNull();
    });

    it('(e) a collapsed capture WITHOUT libwebrtc saying cpu is still no_capture (the capture\'s problem)', () => {
        const calm: Phase = { seconds: 10, src: 7, layers: [{ ...TOP_1080, fps: 7, encMs: 5 }] };
        const { verdict, watch } = run(rep(12, calm));
        expect(verdict).toBeNull();
        expect(watch.takeNotes().map(n => n.why)).toEqual(['no_capture']);
    });

    it('(e) a game in front keeps the old rule: cpu-limited or not, a collapsed capture is the game-starve card\'s', () => {
        const watch = new EncoderOverloadWatch();
        const { verdict } = run(LAB, ctx({ gameInFront: true }), watch);
        expect(verdict).toBeNull();
        expect(watch.takeNotes().map(n => n.why)).toEqual(['no_capture']);
    });

    it('(e) a capture at or above half the target is judged exactly as before', () => {
        const cpuScaled: Phase = { seconds: 10, src: 60, reason: 'cpu', layers: [{ ...TOP_1080, fps: 55, encMs: 14, cpuFracOfWindow: 1 }] };
        const { verdict } = run(rep(8, cpuScaled));
        expect(verdict).not.toBeNull();
        expect(verdict!.evidence.starved).toBe(false);
    });
});
