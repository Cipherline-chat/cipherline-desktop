/**
 * "A game in front is starving the share" - detected on the sharer from the
 * stats the app already reads, and answered with the one thing that fits the
 * cause. Nothing here changes the share by itself: every action waits for a
 * click (the card is call/ShareOverloadOffer.tsx).
 *
 * ── The gap this closes (owner reports 479af6c7, 438f97a1, 14a5184a,
 *    4667c6fa, dd3e84e3, ead6da6b - Windows, builds 178-180)
 *
 * shareEncoderOverload.ts asks "is the ENCODER too slow for this setting?"
 * and stands down when the capture is not delivering. On these shares the
 * encoder was healthy and libwebrtc said `qualityLimitationReason: none`;
 * what failed was the machine around it while a game had the graphics card:
 *   - the CAPTURE collapsed (14a5184a: media-source 9, 4, 6 fps for a 90 fps
 *     share, game in front; 438f97a1: 2.7 fps with a 185 ms grab = Chromium
 *     pacing the next grab at 2 x the last one; 479af6c7: 18 fps with the
 *     capture thread's timer firing 153 ms late); or
 *   - the ENCODER side dropped frames the capture HAD delivered (ead6da6b: 90
 *     fps captured, 60 / 21 / 55 / 50 sent over 30 s - `share_background`'s
 *     `encoder_dropped`).
 * The viewers got a frozen or stuttering stream and the sharer was told
 * nothing. Both signals are the ones `share_background` already reads
 * (shareBackgroundProbe.ts: windowed capture / sent rates from the sender
 * report's counters); nothing new is measured.
 *
 * ── What counts (and what must not)
 *
 * Per window (>= MIN_WINDOW_MS between two reports), after SETTLE and
 * for SUSTAIN of consecutive qualifying windows - the same discipline as the
 * encoder-overload card:
 *   capture  the windowed capture rate is under min(24, half the target) fps
 *            (the band BELOW what shareCaptureBound.ts speaks for: a steady
 *            24-70 % capture is "the game's own frame rate", not starvation);
 *   encoder  the capture held (>= 80 % of what it delivers at best, i.e.
 *            SHARE_BG_HELD_RATIO) but the top layer encoded under 80 % of it,
 *            with libwebrtc NOT saying cpu / bandwidth and the window NOT one
 *            shareEncoderOverload already calls overload (its card owns that).
 * AND all of:
 *   - a program other than Cipherline covers the shared screen and Cipherline
 *     is not focused (foregroundInfo.ts; Windows only - nowhere else is there
 *     an answer, so macOS / Linux never reach this path and the Mac M5 case
 *     stays on the old one). A still desktop or Cipherline's own window
 *     delivers 1-13 fps by design;
 *   - this share has delivered healthily before (>= half the target in some
 *     window): a machine whose capture always ran at 10 fps (a346d7cf, 81d4b8e8)
 *     has a different problem and nothing "starved" it;
 *   - below 3 fps (no new frames at all, `share_background`'s capture_idle:
 *     a static screen looks identical) it only counts when the SAME covering
 *     program already delivered healthily in this stretch of it being in
 *     front - a slideshow or a paused video that was still from the moment it
 *     came to the front never qualifies. (The program's name is compared in
 *     memory to tell programs apart; it is never stored or logged.)
 *
 * ── The answer, per cause (evidence in the reports + code)
 *   boost off + (either cause)  "Prioritize calls and screen share while
 *            gaming" (share-boost.ts: GPU scheduling priority, power-throttle
 *            opt-out, process priority) is the free lever that targets exactly
 *            this; offered as a one-click turn-on, unless the user already
 *            said "never" / "not now" to the same offer.
 *   boost on, capture starved  nothing in Cipherline measurably helps: all six
 *            reports ran with the boost applied (share_gpu_sched: realtime; in ead6da6b the
 *            first apply found no GPU process yet and the re-apply 6 s later got it),
 *            and nothing in the data says a smaller or slower share shortens a
 *            grab that is waiting behind the game's GPU work (the same 4K grab
 *            was 2-5 ms when healthy and 185 ms when starved: the wait, not
 *            the pixels). A tip, not a button: capping the game's frame rate
 *            frees the card (general practice, NOT measured here).
 *   boost on, encoder starved  fewer pixels per second is the one thing that
 *            helps an encoder fighting for the card: the existing suggestion
 *            (suggestSetting) fitted to what the top layer actually achieved.
 * Exclusive fullscreen vs borderless is NOT distinguished: in the 23 Windows
 * reports of the survey the capture collapsed in 14 % of the "game in front"
 * samples under QUNS_BUSY and 9 % under QUNS_RUNNING_D3D_FULL_SCREEN.
 */
import type { ForegroundDiag } from './foregroundInfo';
import { isForegroundUnavailable } from './foregroundInfo';
import {
    readShareFpsSnapshot, ratesBetween, SHARE_BG_HELD_RATIO, type ShareFpsSnapshot,
} from './shareBackgroundProbe';
import { CAPTURE_BOUND_MIN_FPS } from './shareCaptureBound';
import {
    readOverloadSnapshot, evaluateWindow, summarizeEvidence, suggestSetting, resolveOption, shortOption, sizeChange, settingKey,
    MIN_WINDOW_MS, OVERLOAD_SETTLE_MS, OVERLOAD_SUSTAIN_MS, CAPTURE_MIN_RATIO,
    type OverloadSetting, type OverloadSnapshot, type OverloadWindow, type OverloadEvidence, type OverloadSuggestion, type StatsLike,
} from './shareEncoderOverload';
import type { ScreenShareCodec } from './screenShare';
import { GAMING_VIDEO_LABEL } from './gamingVideoMode';

/** No verdict this soon after a (re)start or a setting change (the same wait as the encoder-overload card). */
export const STARVE_SETTLE_MS = OVERLOAD_SETTLE_MS;
/** Consecutive qualifying windows this long before anything is said. */
export const STARVE_SUSTAIN_MS = OVERLOAD_SUSTAIN_MS;
/** Under this a capture delivers no new frames at all (shareBackgroundProbe's `capture_idle` line); a still screen looks the same. */
export const STARVE_IDLE_FPS = 3;
/** The encoder sent under this share of the frames the capture delivered. */
export const STARVE_ENCODER_RATIO = SHARE_BG_HELD_RATIO;

export type StarveCause = 'capture' | 'encoder';

/** The capture rate under which a share counts as collapsed: below the band the capture-bound note speaks for. */
export function collapseBelow(targetFps: number): number {
    return Math.min(CAPTURE_BOUND_MIN_FPS, CAPTURE_MIN_RATIO * targetFps);
}

export interface StarveWindowInput {
    targetFps: number;
    /** Capture rate over the window (frames the capturer delivered per second). */
    captureFps: number | undefined;
    /** The best windowed capture rate this share has shown (capped at the target): what "the capture held" means here. */
    peakCaptureFps: number;
    /** The share has delivered >= half its target in some window. */
    baselineHealthy: boolean;
    /** The program now in front delivered >= half its target in this stretch of it being in front. */
    episodeHealthy: boolean;
    /** The top layer's window, when the encoder side could be judged. */
    encoder?: { encFps: number; overloaded: boolean; reason?: string } | null;
}

/** One window's verdict: which cause it supports, or null. Pure. */
export function classifyStarveWindow(i: StarveWindowInput): StarveCause | null {
    const cap = i.captureFps;
    if (cap === undefined || !(i.targetFps > 0)) return null;
    if (cap < collapseBelow(i.targetFps)) {
        if (!i.baselineHealthy) return null;
        if (cap < STARVE_IDLE_FPS && !i.episodeHealthy) return null;
        return 'capture';
    }
    const e = i.encoder;
    const reference = Math.min(i.targetFps, i.peakCaptureFps);
    if (e && !e.overloaded && e.reason !== 'cpu' && e.reason !== 'bandwidth'
        && reference >= CAPTURE_MIN_RATIO * i.targetFps
        && cap >= SHARE_BG_HELD_RATIO * reference
        && e.encFps < STARVE_ENCODER_RATIO * cap) return 'encoder';
    return null;
}

// ── the watch ──────────────────────────────────────────────────────────────

interface StreakWindow { dtS: number; captureFps: number; sentFps?: number; encFps?: number; ow?: OverloadWindow }

export interface StarveEvidence {
    cause: StarveCause;
    seconds: number;
    /** Time-weighted means over the windows the verdict rests on. */
    captureFps: number;
    sentFps?: number;
    targetFps: number;
    /** Encoder cause only: the top layer's measurements, for the suggestion. */
    overload?: OverloadEvidence;
}

export interface StarveVerdict { key: string; cause: StarveCause; evidence: StarveEvidence }

export interface StarveObserveContext {
    setting: OverloadSetting;
    targetFps: number;
    /** What had the screen when this report was taken (null = unknown / not Windows). */
    fg: ForegroundDiag | null;
    /** Cipherline's own window has focus. */
    focused: boolean;
    /** A start, swap, republish or codec-drift fix is in flight: no judgement now. */
    blocked: boolean;
    /** Another notice, offer or guard is already speaking about this share: wait. */
    suppressed: boolean;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A program other than Cipherline covers the shared screen, Cipherline not focused. Windows only. */
export function gameInFront(fg: ForegroundDiag | null, focused: boolean): boolean {
    return !!fg && !focused && !isForegroundUnavailable(fg) && fg.covers && !fg.isCipherline && fg.onSharedScreen !== false;
}

/**
 * One per share (kept across the sampler's restarts for a retune, so a
 * dismissed setting stays dismissed). Feed it every sender stats report.
 */
export class GameStarveWatch {
    private prevFps: ShareFpsSnapshot | null = null;
    private prevOv: OverloadSnapshot | null = null;
    private settleFrom: number | null = null;
    private streak: StreakWindow[] = [];
    private streakCause: StarveCause | null = null;
    private streakMs = 0;
    private baselineHealthy = false;
    private peak = 0;
    private episode: { exe: string; healthy: boolean } | null = null;
    private readonly dismissed = new Set<string>();
    private readonly said = new Set<string>();

    /** The share (re)started, its setting changed, or it was republished: start the settle period again. */
    restart(now: number): void {
        this.prevFps = null;
        this.prevOv = null;
        this.settleFrom = now;
        this.episode = null;
        this.dropStreak();
    }

    dismiss(key: string): void { this.dismissed.add(key); }
    isDismissed(key: string): boolean { return this.dismissed.has(key); }

    observe(now: number, report: StatsLike | null | undefined, ctx: StarveObserveContext): StarveVerdict | null {
        const fps = readShareFpsSnapshot(report, now);
        const ov = readOverloadSnapshot(report, now);
        if (!fps || !ov) { this.dropStreak(); return null; }
        if (this.settleFrom === null) this.settleFrom = now;
        if (ctx.blocked) {
            this.dropStreak();
            this.settleFrom = now;
            this.prevFps = fps; this.prevOv = ov;
            this.episode = null;
            return null;
        }
        const pf = this.prevFps;
        const po = this.prevOv;
        if (!pf || !po) { this.prevFps = fps; this.prevOv = ov; return null; }
        // A window that is too short says nothing; keep the older report so the next one spans more.
        if (fps.at - pf.at < MIN_WINDOW_MS) return null;
        this.prevFps = fps; this.prevOv = ov;

        const rates = ratesBetween(pf, fps);
        const captureFps = rates.capture ?? ov.srcFps;
        const sentFps = rates.sent;
        const healthyNow = fin(captureFps) && captureFps >= CAPTURE_MIN_RATIO * ctx.targetFps;
        if (healthyNow) this.baselineHealthy = true;
        if (fin(captureFps)) this.peak = Math.max(this.peak, Math.min(captureFps, ctx.targetFps));

        const fg = ctx.fg;
        if (!fg || !gameInFront(fg, ctx.focused)) { this.episode = null; this.dropStreak(); return null; }
        const exe = fg.exe;
        if (!this.episode || this.episode.exe !== exe) this.episode = { exe, healthy: false };
        if (healthyNow) this.episode.healthy = true;
        if (now - this.settleFrom < STARVE_SETTLE_MS) return null;

        const w = evaluateWindow(po, ov, ctx.targetFps);
        const cause = classifyStarveWindow({
            targetFps: ctx.targetFps, captureFps, peakCaptureFps: this.peak,
            baselineHealthy: this.baselineHealthy, episodeHealthy: this.episode.healthy,
            encoder: w.valid ? { encFps: w.encFps, overloaded: w.overloaded, reason: ov.reason } : null,
        });
        if (!cause || !fin(captureFps)) { this.dropStreak(); return null; }
        if (this.streakCause !== cause) this.dropStreak();
        this.streakCause = cause;
        const dtS = (fps.at - pf.at) / 1000;
        this.streak.push({
            dtS, captureFps, ...(fin(sentFps) ? { sentFps } : {}),
            ...(w.valid ? { encFps: w.encFps, ow: w } : {}),
        });
        this.streakMs += dtS * 1000;
        if (this.streakMs < STARVE_SUSTAIN_MS) return null;
        const key = `${cause}:${settingKey(ctx.setting)}`;
        if (this.dismissed.has(key) || this.said.has(key) || ctx.suppressed) return null;
        this.said.add(key);
        return { key, cause, evidence: this.evidence(cause, ctx.targetFps) };
    }

    private evidence(cause: StarveCause, targetFps: number): StarveEvidence {
        const secs = this.streak.reduce((n, s) => n + s.dtS, 0) || 1;
        const mean = (f: (s: StreakWindow) => number | undefined) => {
            const rows = this.streak.filter(s => f(s) !== undefined);
            const t = rows.reduce((n, s) => n + s.dtS, 0);
            return t > 0 ? rows.reduce((n, s) => n + (f(s) as number) * s.dtS, 0) / t : undefined;
        };
        const sent = mean(s => s.sentFps);
        const ows = this.streak.map(s => s.ow).filter((o): o is OverloadWindow => !!o);
        return {
            cause, seconds: Math.round(secs), targetFps,
            captureFps: r1(mean(s => s.captureFps) ?? 0),
            ...(sent !== undefined ? { sentFps: r1(sent) } : {}),
            ...(cause === 'encoder' && ows.length > 0 ? { overload: summarizeEvidence(ows) } : {}),
        };
    }

    private dropStreak(): void { this.streak = []; this.streakMs = 0; this.streakCause = null; }
}

// ── what to offer ──────────────────────────────────────────────────────────

/** 'off' = the "While gaming" boost is available, saved OFF and may be offered; 'on' = already on; 'na' = unavailable or declined. */
export type BoostState = 'off' | 'on' | 'na';
export type StarveAction = 'boost' | 'lower' | 'tip';

export interface StarvePlan {
    action: StarveAction;
    title: string;
    body: string;
    /** Absent for a tip (nothing to click but "Got it"). */
    acceptLabel?: string;
    dismissLabel: string;
    sizeChange?: string | null;
    suggestion: OverloadSuggestion | null;
}

export interface StarvePlanInput {
    verdict: StarveVerdict;
    boost: BoostState;
    setting: OverloadSetting;
    codec: ScreenShareCodec;
    /** The source's size; null = unknown (then no lower setting can be fitted). */
    source: { width: number; height: number } | null;
    /** Highest frame rate this source may ask for. */
    maxFps: number;
}

const n0 = (n: number) => Math.max(0, Math.round(n));

/**
 * The card for a verdict, or null when there is nothing honest to offer (an
 * encoder cause with the boost already on and no lower setting left).
 */
export function planStarveOffer(i: StarvePlanInput): StarvePlan | null {
    const e = i.verdict.evidence;
    const cap = n0(e.captureFps);
    if (i.verdict.cause === 'capture') {
        const head = `Only about ${cap} frames a second are getting through while another program is in front.`;
        if (i.boost === 'off') {
            return {
                action: 'boost', title: 'Your share is stuttering', suggestion: null,
                body: `${head} “${GAMING_VIDEO_LABEL}” gives Cipherline more of your graphics card.`,
                acceptLabel: 'Turn on', dismissLabel: 'Not now',
            };
        }
        return {
            action: 'tip', title: 'Your share is stuttering', suggestion: null,
            body: `${head} ${i.boost === 'on' ? 'Cipherline’s priority boost is already on; your' : 'Your'} graphics card is probably fully used. Capping that program’s frame rate or lowering its graphics usually frees enough.`,
            dismissLabel: 'Got it',
        };
    }
    const sent = n0(e.sentFps ?? e.overload?.encFps ?? 0);
    const head = `Only about ${sent} of ${cap} frames a second are being sent while another program is busy on your computer.`;
    if (i.boost === 'off') {
        return {
            action: 'boost', title: 'Your share is dropping frames', suggestion: null,
            body: `${head} “${GAMING_VIDEO_LABEL}” gives the video encoder more of it.`,
            acceptLabel: 'Turn on', dismissLabel: 'Not now',
        };
    }
    if (!i.source || !e.overload) return null;
    const sug = suggestSetting({
        current: i.setting, codec: i.codec, source: i.source, maxFps: i.maxFps,
        budgetTop: e.overload.budgetTop, srcFpsCap: e.captureFps,
    });
    if (!sug) return null;
    const cur = resolveOption(i.setting, i.codec, i.source, e.captureFps);
    return {
        action: 'lower', title: 'Your share is dropping frames', suggestion: sug,
        body: `${head} ${shortOption(sug)} should run smoothly.`,
        sizeChange: sizeChange(cur, sug),
        acceptLabel: 'Switch', dismissLabel: 'Keep current',
    };
}

/** Content-free numbers for the `share_game_starve` event (<= 11 keys; no program names, no titles). */
export function starveEventDetail(
    phase: 'shown' | 'accepted' | 'dismissed' | 'none',
    v: StarveVerdict, plan: { action: StarveAction; suggestion: OverloadSetting | null } | null, boost: BoostState,
): Record<string, string | number | boolean> {
    const e = v.evidence;
    const d: Record<string, string | number | boolean> = {
        phase, cause: v.cause, act: plan?.action ?? 'none', boost,
        setting: v.key.slice(v.key.indexOf(':') + 1),
        sug: plan?.suggestion ? settingKey(plan.suggestion) : 'none',
        cap_fps: e.captureFps, target: e.targetFps, secs: e.seconds,
    };
    if (e.sentFps !== undefined) d.sent_fps = e.sentFps;
    return d;
}
