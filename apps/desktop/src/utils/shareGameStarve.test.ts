import { describe, it, expect } from 'vitest';
import {
    GameStarveWatch, classifyStarveWindow, collapseBelow, gameInFront, planStarveOffer, starveEventDetail,
    STARVE_SETTLE_MS, STARVE_SUSTAIN_MS, STARVE_IDLE_FPS,
    type StarveObserveContext, type StarveVerdict, type StarveWindowInput,
} from './shareGameStarve';
import { EncoderOverloadWatch, settingKey } from './shareEncoderOverload';
import { unavailableForegroundDiag, type ForegroundDiag } from './foregroundInfo';
import { CaptureBoundWatch } from './shareCaptureBound';
import { CALL_EVENT_KINDS, logCallEvent, getCallEvents, clearCallEvents, validateCallEvent } from './callEventLog';

// ── a sender report, built the way Chromium reports it ────────────────────
interface Step {
    /** Capture rate over the step (media-source `frames`). */
    capture: number;
    /** Top layer sent / encoded rate over the step. */
    sent: number;
    /** Encode ms per frame of the top layer. */
    encMs?: number;
    w?: number; h?: number;
    /** A lighter copy's rate (a second active layer), 0 = none. */
    low?: number;
    reason?: string;
    /** Share of the step libwebrtc reported `cpu` (qualityLimitationDurations). */
    cpuFrac?: number;
}

class Tx {
    t = 0;
    private src = 0; private hf = 0; private he = 0; private qf = 0; private qe = 0; private cpu = 0;
    private last: Step | null = null;
    step(toMs: number, p: Step): void {
        const dt = (toMs - this.t) / 1000;
        this.t = toMs;
        this.src += p.capture * dt;
        this.hf += p.sent * dt;
        this.he += (p.sent * dt * (p.encMs ?? 8)) / 1000;
        this.qf += (p.low ?? 0) * dt;
        this.qe += ((p.low ?? 0) * dt * 3) / 1000;
        this.cpu += (p.cpuFrac ?? 0) * dt;
        this.last = p;
    }
    report() {
        const p = this.last!;
        const entries: Record<string, unknown>[] = [{
            type: 'outbound-rtp', kind: 'video', rid: 'h', active: true, frameWidth: p.w ?? 2560, frameHeight: p.h ?? 1440,
            framesEncoded: this.hf, framesSent: this.hf, totalEncodeTime: this.he,
            qualityLimitationReason: p.reason ?? 'none',
            qualityLimitationDurations: { cpu: this.cpu, bandwidth: 0, none: 0, other: 0 },
            powerEfficientEncoder: true, encoderImplementation: 'ExternalEncoder',
        }, { type: 'media-source', kind: 'video', frames: this.src, framesPerSecond: p.capture }];
        if ((p.low ?? 0) > 0) {
            entries.push({
                type: 'outbound-rtp', kind: 'video', rid: 'q', active: true, frameWidth: 1280, frameHeight: 720,
                framesEncoded: this.qf, framesSent: this.qf, totalEncodeTime: this.qe, qualityLimitationReason: 'none',
                qualityLimitationDurations: { cpu: 0, bandwidth: 0, none: 0, other: 0 },
            });
        }
        return { forEach: (cb: (s: Record<string, unknown>) => void) => entries.forEach(cb) };
    }
}

// What was in front. Program names are made up: they are only ever compared with each other.
const fgOf = (exe: string, o: Partial<ForegroundDiag> = {}): ForegroundDiag => ({
    state: 'QUNS_BUSY', exe, covers: true, isCipherline: false, onSharedScreen: true, ...o,
});
const GAME_A = fgOf('game-a.exe');
const GAME_B = fgOf('game-b.exe', { state: 'QUNS_RUNNING_D3D_FULL_SCREEN' });
const SLIDES = fgOf('slides.exe');
const CIPHERLINE = fgOf('Cipherline.exe', { state: 'QUNS_ACCEPTS_NOTIFICATIONS', covers: false, isCipherline: true, onSharedScreen: false });
const DESKTOP = fgOf('', { state: 'QUNS_ACCEPTS_NOTIFICATIONS', covers: false, onSharedScreen: false });

/** [seconds, capture fps, sent fps, what was in front] - the numbers of a real share_fps log. */
type Row = [number, number, number, ForegroundDiag | null, Partial<Step>?];

const ctx = (o: Partial<StarveObserveContext> = {}): StarveObserveContext => ({
    setting: { resolution: 'source', frameRate: 90 }, targetFps: 90, fg: null, focused: false, blocked: false, suppressed: false, ...o,
});
const ms = (s: number) => Math.round(s * 1000);

interface RunOut { verdict: StarveVerdict | null; at: number | null; oldFired: boolean; watch: GameStarveWatch; boundFired: boolean }

/** Feed the starve watch (and, beside it, the encoder-overload watch and the capture-bound note) the same reports. */
function run(rows: Row[], o: { start: number; ctx?: Partial<StarveObserveContext>; watch?: GameStarveWatch; step?: Partial<Step> } = { start: 0 }): RunOut {
    const tx = new Tx();
    const watch = o.watch ?? new GameStarveWatch();
    const old = new EncoderOverloadWatch();
    const bound = new CaptureBoundWatch();
    watch.restart(ms(o.start));
    old.restart(ms(o.start));
    tx.step(ms(o.start), { capture: 0, sent: 0 });
    let verdict: StarveVerdict | null = null; let at: number | null = null; let oldFired = false; let boundFired = false;
    for (const [t, capture, sent, fg, extra] of rows) {
        tx.step(ms(t), { capture, sent, ...o.step, ...extra });
        const c = ctx({ fg, focused: !!fg?.isCipherline, ...o.ctx });
        const rep = tx.report();
        if (old.observe(ms(t), rep, { setting: c.setting, targetFps: c.targetFps, blocked: c.blocked, suppressed: false })) oldFired = true;
        const v = watch.observe(ms(t), rep, c);
        if (v && !verdict) { verdict = v; at = t; }
        if (bound.observe({ targetFps: c.targetFps, srcFps: capture, encFps: sent, limit: extra?.reason ?? 'none', fgCover: !!fg?.covers, focused: !!fg?.isCipherline })) boundFired = true;
    }
    return { verdict, at, oldFired, watch, boundFired };
}

// Real numbers: ead6da6b (RTX hardware H.264, 2560x1440 at 90, Source), build 180.
const EAD6_BASE: Row[] = [[-78.0, 88, 89, GAME_A], [-68.0, 90, 89, GAME_A], [-58.0, 91, 90, GAME_A]];
const EAD6_DROP: Row[] = [
    [-48.0, 88, 89, CIPHERLINE], [-46.9, 89, 90, CIPHERLINE],
    [-42.8, 90, 60, GAME_A], [-38.0, 90, 21, GAME_A], [-28.0, 89, 55, GAME_A], [-18.0, 89, 50, GAME_A], [-10.8, 85, 85, CIPHERLINE],
];
// Real numbers: 14a5184a (build 179), BeamNG in front, 90 fps asked - the capture collapses.
const R14A_START = -285;
const R14A: Row[] = [
    [-280.1, 90, 90, CIPHERLINE], [-270.1, 51, 53, GAME_A], [-269.2, 83, 81, GAME_A], [-260.1, 86, 86, GAME_A],
    [-250.1, 33, 32, GAME_A], [-240.1, 90, 92, GAME_A], [-230.1, 60, 58, GAME_A],
    [-220.1, 9, 8, GAME_A], [-210.1, 4, 4, GAME_A], [-200.1, 6, 6, GAME_A], [-190.1, 30, 27, GAME_A], [-180.1, 89, 88, GAME_A],
];

describe('positives: the two ways a game starves a share (real report numbers)', () => {
    it('14a5184a: capture 9 / 4 / 6 fps for 30 s at 90 asked, game in front -> capture verdict at the third window, never before', () => {
        const out = run(R14A, { start: R14A_START });
        expect(out.verdict?.cause).toBe('capture');
        expect(out.at).toBe(-200.1);
        expect(out.verdict!.evidence.captureFps).toBeCloseTo(6.3, 0);
        expect(out.verdict!.evidence.sentFps).toBeCloseTo(6, 0);
        expect(out.verdict!.evidence.seconds).toBe(30);
        expect(out.verdict!.key).toBe('capture:source@90');
    });

    it('an exclusive-fullscreen game (QUNS_RUNNING_D3D_FULL_SCREEN) counts exactly like a borderless one: the survey saw both collapse', () => {
        const out = run(R14A.map(([t, c, s, f]) => [t, c, s, f === GAME_A ? GAME_B : f] as Row), { start: R14A_START });
        expect(out.verdict?.cause).toBe('capture');
        expect(out.at).toBe(-200.1);
    });

    it('...and the gap is real: the encoder-overload watch and the capture-bound note stay silent on the same reports', () => {
        const out = run(R14A, { start: R14A_START });
        expect(out.oldFired).toBe(false);
        expect(out.boundFired).toBe(false);
    });

    it('ead6da6b: capture holds at 89-90 but only 60 / 21 / 55 / 50 fps are sent for 30 s -> encoder verdict, with a budget from what was achieved', () => {
        const out = run([...EAD6_BASE, ...EAD6_DROP], { start: -88 });
        expect(out.verdict?.cause).toBe('encoder');
        expect(out.at).toBe(-18.0);
        const e = out.verdict!.evidence;
        expect(e.captureFps).toBeGreaterThan(88);
        expect(e.sentFps).toBeCloseTo(49.9, 0); // counters over 5.2 + 4.8 + 10 + 10 s, the first window still holds a second of the focused 90
        // top layer 2560x1440 at ~50 fps = ~184 Mpx/s achieved, 90 % of it is the budget
        expect(e.overload!.budgetTop / 1e6).toBeGreaterThan(150);
        expect(e.overload!.budgetTop / 1e6).toBeLessThan(170);
        expect(out.oldFired).toBe(false); // 8 ms encodes, `limit: none`: the old card cannot see this
    });

    it('a window share and a lighter copy do not change the verdict (the top layer alone is judged)', () => {
        const out = run([...EAD6_BASE, ...EAD6_DROP], { start: -88, step: { low: 30 } });
        expect(out.verdict?.cause).toBe('encoder');
        expect(out.verdict!.evidence.overload!.lowRate).toBeGreaterThan(0);
    });

    it('waits out the settle period and the sustain period', () => {
        const out = run(R14A, { start: R14A_START });
        expect(out.at! - R14A_START).toBeGreaterThanOrEqual(STARVE_SETTLE_MS / 1000);
        const early = run(R14A.slice(0, 9), { start: R14A_START }); // up to -210.1: only 20 s of collapse
        expect(early.verdict).toBeNull();
    });
});

describe('negatives: what must stay silent', () => {
    it('a still screen at 1 fps with Cipherline in front (438f97a1: src 1, 1, 2 with Cipherline focused) is by design', () => {
        const rows: Row[] = [[-30, 30, 30, GAME_A], [-20, 30, 30, GAME_A]];
        for (let t = -10; t <= 150; t += 10) rows.push([t, 1, 1, CIPHERLINE]);
        expect(run(rows, { start: -50 }).verdict).toBeNull();
    });

    it('a still desktop with nothing covering the screen delivers 1 fps and says nothing', () => {
        const rows: Row[] = [[-30, 88, 88, GAME_A]];
        for (let t = -20; t <= 150; t += 10) rows.push([t, 1, 1, DESKTOP]);
        expect(run(rows, { start: -50 }).verdict).toBeNull();
    });

    it('a slideshow that was still from the moment it came to the front (idle capture, never healthy under it) is not starvation', () => {
        const rows: Row[] = [[-20, 90, 90, DESKTOP], [-10, 90, 90, DESKTOP]];
        for (let t = 0; t <= 150; t += 10) rows.push([t, 1, 1, SLIDES]);
        expect(run(rows, { start: -45 }).verdict).toBeNull();
    });

    it('...and neither is one that comes to the front after a game: the episode belongs to the program, not to the share', () => {
        const rows: Row[] = [[-60, 90, 90, GAME_A], [-50, 90, 90, GAME_A], [-40, 90, 90, GAME_A], [-30, 90, 90, GAME_A], [-20, 90, 90, GAME_A], [-10, 90, 90, GAME_A]];
        for (let t = 0; t <= 150; t += 10) rows.push([t, 1, 1, SLIDES]);
        expect(run(rows, { start: -90 }).verdict).toBeNull();
    });

    it('a 5-10 s dip is not sustained: 438f97a1 src 1, 1 with the game in front, 1.6 s apart, then Cipherline took focus', () => {
        const rows: Row[] = [];
        for (let t = -140; t <= -81; t += 10) rows.push([t, 30, 30, GAME_A]);
        rows.push([-80, 30, 30, CIPHERLINE], [-71.1, 1, 1, GAME_A], [-69.5, 1, 1, GAME_A], [-63.8, 1, 1, CIPHERLINE], [-60.6, 30, 31, CIPHERLINE]);
        const out = run(rows, { start: -170, ctx: { targetFps: 30, setting: { resolution: 'source', frameRate: 30 } } });
        expect(out.verdict).toBeNull();
    });

    it('a dip with the game in front that recovers inside 30 s (14a5184a at -250: 33 fps once, then 90) is not sustained', () => {
        const out = run(R14A.slice(0, 7), { start: R14A_START }); // through -230.1
        expect(out.verdict).toBeNull();
    });

    it('a capture that never delivered (a346d7cf: Chrome fullscreen, 10-12 fps at 60 asked, from the first sample) is a different problem', () => {
        const rows: Row[] = [];
        for (let t = 0; t <= 120; t += 10) rows.push([t, 11, 11, fgOf('browser.exe')]);
        const out = run(rows, { start: -40, ctx: { targetFps: 60, setting: { resolution: 'source', frameRate: 60 } } });
        expect(out.verdict).toBeNull();
    });

    it('a steady middle rate (4667c6fa: 30 fps flat at 90 asked, game in front) is the capture-bound note\'s, not a starvation card', () => {
        const rows: Row[] = [[-300, 87, 87, GAME_A], [-293, 87, 87, GAME_A]];
        for (let t = -283; t <= -100; t += 10) rows.push([t, 30, 30, GAME_A]);
        const out = run(rows, { start: -340 });
        expect(out.verdict).toBeNull();
        expect(out.boundFired).toBe(true);
    });

    it('a bandwidth-limited sender (reason bandwidth, low sent fps, capture held) is the network\'s', () => {
        const out = run([...EAD6_BASE, ...EAD6_DROP], { start: -88, step: { reason: 'bandwidth' } });
        expect(out.verdict).toBeNull();
    });

    it('nothing before the settle period is over, however bad the numbers: windows inside it do not count toward the 30 s', () => {
        const rows: Row[] = [[-39, 90, 90, GAME_A], [-30, 90, 90, GAME_A]];
        for (let t = -25; t <= 0; t += 5) rows.push([t, 2, 2, GAME_A]); // 30 s of collapse, but the first 25 s of the share are settling
        const out = run(rows, { start: -40 });
        expect(out.verdict).toBeNull();
        // the same collapse, continued, is said as soon as 30 s of it lie past the settle
        for (let t = 5; t <= 30; t += 5) rows.push([t, 2, 2, GAME_A]);
        expect(run(rows, { start: -40 }).verdict?.cause).toBe('capture');
    });

    it('Cipherline holding focus (even if the foreground answer is stale) is never a game in front', () => {
        const out = run(R14A, { start: R14A_START, ctx: { focused: true } });
        expect(out.verdict).toBeNull();
    });

    it('no foreground information (macOS, Linux, an older main) never qualifies', () => {
        for (const fg of [null, unavailableForegroundDiag()]) {
            const out = run(R14A.map(([t, c, s]) => [t, c, s, fg] as Row), { start: R14A_START });
            expect(out.verdict).toBeNull();
        }
    });

    it('a covering program on ANOTHER monitor than the shared screen is not in front of the share', () => {
        const elsewhere = fgOf('game-a.exe', { onSharedScreen: false });
        expect(run(R14A.map(([t, c, s]) => [t, c, s, elsewhere] as Row), { start: R14A_START }).verdict).toBeNull();
    });

    it('a share being (re)published is not judged, and the wait starts over', () => {
        const watch = new GameStarveWatch();
        const out = run(R14A.map(([t, c, s, f]) => [t, c, s, f] as Row), { start: R14A_START, ctx: { blocked: true }, watch });
        expect(out.verdict).toBeNull();
    });
});

describe('the Mac M5 case still goes down the old path, untouched', () => {
    // base Apple M5, 3024x1964 at 90 (H.265, VideoToolbox): top layer 55 fps at 80 ms per frame, a lighter copy beside it
    const M5: Step = { capture: 90, sent: 55, encMs: 80, w: 3024, h: 1964, low: 30 };
    const rows = (fg: ForegroundDiag | null): Row[] => Array.from({ length: 8 }, (_, k) => [(k + 1) * 10, 90, 55, fg] as Row);

    it('on macOS (no foreground answer) the old watch fires at 50 s and the new one never does', () => {
        const out = run(rows(unavailableForegroundDiag()), { start: 0, step: M5 });
        expect(out.oldFired).toBe(true);
        expect(out.verdict).toBeNull();
    });

    it('even with a program in front, a window the old card calls overload is left to it (no second card for the same thing)', () => {
        const out = run(rows(GAME_A), { start: 0, step: M5 });
        expect(out.oldFired).toBe(true);
        expect(out.verdict).toBeNull();
    });

    it('the cpu-limited stretch (libwebrtc scaled to 2268x1472) is the old card\'s too', () => {
        const out = run(rows(GAME_A), { start: 0, step: { capture: 90, sent: 90, encMs: 10.2, w: 2268, h: 1472, low: 30, reason: 'cpu', cpuFrac: 1 } });
        expect(out.oldFired).toBe(true);
        expect(out.verdict).toBeNull();
    });
});

describe('once per setting, dismissals, suppression', () => {
    it('says it once; a dismissed cause+setting stays dismissed across restarts; another setting is judged afresh', () => {
        const watch = new GameStarveWatch();
        const a = run(R14A, { start: R14A_START, watch });
        expect(a.verdict).not.toBeNull();
        // the same stretch again, same watch: already said
        expect(run(R14A, { start: R14A_START, watch }).verdict).toBeNull();
        watch.dismiss(a.verdict!.key);
        expect(watch.isDismissed('capture:source@90')).toBe(true);
        const other = { setting: { resolution: '1080p', frameRate: 60 } as const, targetFps: 90 };
        const b = run(R14A, { start: R14A_START, watch, ctx: other });
        expect(b.verdict?.key).toBe(`capture:${settingKey({ resolution: '1080p', frameRate: 60 })}`);
    });

    it('another notice, offer or guard on screen defers it (not consumed); it is said once the way is clear', () => {
        const watch = new GameStarveWatch();
        const held = run(R14A, { start: R14A_START, watch, ctx: { suppressed: true } });
        expect(held.verdict).toBeNull();
        const later = run(R14A, { start: R14A_START, watch });
        expect(later.verdict).not.toBeNull();
    });
});

describe('classifyStarveWindow (pure)', () => {
    const base: StarveWindowInput = { targetFps: 90, captureFps: 6, peakCaptureFps: 90, baselineHealthy: true, episodeHealthy: true, encoder: null };
    it('the collapse band is under min(24, half the target)', () => {
        expect(collapseBelow(90)).toBe(24);
        expect(collapseBelow(60)).toBe(24);
        expect(collapseBelow(30)).toBe(15);
        expect(classifyStarveWindow({ ...base, captureFps: 23.9 })).toBe('capture');
        expect(classifyStarveWindow({ ...base, captureFps: 24 })).toBeNull();
        expect(classifyStarveWindow({ ...base, targetFps: 30, captureFps: 10 })).toBe('capture');
        expect(classifyStarveWindow({ ...base, targetFps: 30, captureFps: 16 })).toBeNull();
    });
    it('under 3 fps needs the covering program to have delivered before; 3 fps and up needs only the share to have', () => {
        expect(STARVE_IDLE_FPS).toBe(3);
        expect(classifyStarveWindow({ ...base, captureFps: 1, episodeHealthy: false })).toBeNull();
        expect(classifyStarveWindow({ ...base, captureFps: 1, episodeHealthy: true })).toBe('capture');
        expect(classifyStarveWindow({ ...base, captureFps: 2.7, episodeHealthy: false })).toBeNull();
        expect(classifyStarveWindow({ ...base, captureFps: 4, episodeHealthy: false })).toBe('capture');
        expect(classifyStarveWindow({ ...base, captureFps: 4, baselineHealthy: false })).toBeNull();
    });
    it('encoder: capture held, top layer under 80 % of it, not cpu / bandwidth / already overload', () => {
        const enc = (o: Partial<NonNullable<StarveWindowInput['encoder']>> = {}) => ({ encFps: 21, overloaded: false, reason: 'none', ...o });
        const w = { ...base, captureFps: 90 };
        expect(classifyStarveWindow({ ...w, encoder: enc() })).toBe('encoder');
        expect(classifyStarveWindow({ ...w, encoder: enc({ encFps: 80 }) })).toBeNull();
        expect(classifyStarveWindow({ ...w, encoder: enc({ overloaded: true }) })).toBeNull();
        expect(classifyStarveWindow({ ...w, encoder: enc({ reason: 'cpu' }) })).toBeNull();
        expect(classifyStarveWindow({ ...w, encoder: enc({ reason: 'bandwidth' }) })).toBeNull();
        expect(classifyStarveWindow({ ...w, encoder: null })).toBeNull();
        // a 60 Hz display asked for 90: capture at 58-60 IS holding
        expect(classifyStarveWindow({ ...w, captureFps: 59, peakCaptureFps: 60, encoder: enc({ encFps: 25 }) })).toBe('encoder');
        // a capture that sits in the middle (30 of 90) is not "held"
        expect(classifyStarveWindow({ ...w, captureFps: 30, encoder: enc({ encFps: 10 }) })).toBeNull();
    });
    it('gameInFront needs Windows information, a covering program that is not Cipherline, on the shared screen, with Cipherline unfocused', () => {
        expect(gameInFront(GAME_A, false)).toBe(true);
        expect(gameInFront(GAME_A, true)).toBe(false);
        expect(gameInFront(CIPHERLINE, false)).toBe(false);
        expect(gameInFront(DESKTOP, false)).toBe(false);
        expect(gameInFront(null, false)).toBe(false);
        expect(gameInFront(unavailableForegroundDiag(), false)).toBe(false);
        expect(gameInFront(fgOf('a.exe', { onSharedScreen: null }), false)).toBe(true); // a window share cannot tell
    });
});

describe('the offer per cause', () => {
    const capture = run(R14A, { start: R14A_START }).verdict!;
    const encoder = run([...EAD6_BASE, ...EAD6_DROP], { start: -88 }).verdict!;
    const src = { width: 2560, height: 1440 };
    const common = { setting: { resolution: 'source', frameRate: 90 } as const, codec: 'h264' as const, source: src, maxFps: 90 };

    it('capture, boost OFF: offer to turn the "While gaming" boost on (one click), with a Not now', () => {
        const p = planStarveOffer({ ...common, verdict: capture, boost: 'off' })!;
        expect(p.action).toBe('boost');
        expect(p.acceptLabel).toBe('Turn on');
        expect(p.dismissLabel).toBe('Not now');
        expect(p.body).toContain('Prioritize calls and screen share while gaming');
        expect(p.body).toContain('about 6 frames a second');
        expect(p.suggestion).toBeNull();
    });

    it('capture, boost ON (every one of the six reports): a tip, nothing to click but "Got it" - no measured lever in Cipherline beyond the boost', () => {
        const p = planStarveOffer({ ...common, verdict: capture, boost: 'on' })!;
        expect(p.action).toBe('tip');
        expect(p.acceptLabel).toBeUndefined();
        expect(p.dismissLabel).toBe('Got it');
        expect(p.body).toMatch(/already on/);
        expect(p.body).toMatch(/frame rate/);
        expect(p.suggestion).toBeNull();
    });

    it('capture, boost unavailable or declined: the tip without claiming the boost is on', () => {
        const p = planStarveOffer({ ...common, verdict: capture, boost: 'na' })!;
        expect(p.action).toBe('tip');
        expect(p.body).not.toMatch(/already on/);
    });

    it('encoder, boost OFF: the same turn-on offer, worded for dropped frames', () => {
        const p = planStarveOffer({ ...common, verdict: encoder, boost: 'off' })!;
        expect(p.action).toBe('boost');
        expect(p.title).toBe('Your share is dropping frames');
        expect(p.body).toContain('about 50 of 89 frames');
    });

    it('encoder, boost ON: a lower setting fitted to what the encoder achieved (ead6da6b: 2560x1440 at 90 -> 1080p at 60)', () => {
        const p = planStarveOffer({ ...common, verdict: encoder, boost: 'on' })!;
        expect(p.action).toBe('lower');
        expect(p.acceptLabel).toBe('Switch');
        expect(p.dismissLabel).toBe('Keep current');
        expect(p.suggestion).toMatchObject({ resolution: '1080p', frameRate: 60 });
        expect(p.body).toContain('1080p at 60 fps should run smoothly');
        expect(p.sizeChange).toBe('2560×1440 → 1920×1080');
    });

    it('encoder, boost ON, size unknown or nothing lower left: no card rather than a made-up one', () => {
        expect(planStarveOffer({ ...common, verdict: encoder, boost: 'on', source: null })).toBeNull();
        expect(planStarveOffer({ ...common, verdict: encoder, boost: 'on', setting: { resolution: '480p', frameRate: 15 } })).toBeNull();
    });

    it('no copy names a program or a window', () => {
        for (const v of [capture, encoder]) for (const boost of ['off', 'on', 'na'] as const) {
            const p = planStarveOffer({ ...common, verdict: v, boost });
            if (p) expect(`${p.title} ${p.body}`).not.toMatch(/\.exe|game-a|game-b|beamng|cyberpunk/i);
        }
    });
});

describe('the call event', () => {
    it('share_game_starve is a known kind; the detail is content-free, <= 11 keys, valid in the call event log, and never names a program', () => {
        expect(CALL_EVENT_KINDS).toContain('share_game_starve');
        clearCallEvents();
        const v = run(R14A, { start: R14A_START }).verdict!;
        const plan = planStarveOffer({ verdict: v, boost: 'off', setting: { resolution: 'source', frameRate: 90 }, codec: 'h264', source: { width: 2560, height: 1440 }, maxFps: 90 });
        for (const phase of ['shown', 'accepted', 'dismissed', 'none'] as const) {
            const d = starveEventDetail(phase, v, plan, 'off');
            expect(Object.keys(d).length).toBeLessThanOrEqual(11);
            expect(Object.keys(d).sort().join()).not.toMatch(/exe|title|app|name|window/);
            logCallEvent('share_game_starve', d);
        }
        const evs = getCallEvents().filter(e => e.kind === 'share_game_starve');
        expect(evs.length).toBeGreaterThan(0);
        for (const e of evs) expect(validateCallEvent(e)).toEqual([]);
        expect(evs[0].detail).toMatchObject({ phase: 'shown', cause: 'capture', act: 'boost', boost: 'off', setting: 'source@90', sug: 'none', target: 90 });
    });
    it('sustain and settle are the encoder-overload card\'s (30 s / 25 s)', () => {
        expect(STARVE_SUSTAIN_MS).toBe(30_000);
        expect(STARVE_SETTLE_MS).toBe(25_000);
    });
});
