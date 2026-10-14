/**
 * Is our screen share actually leaving the machine - and if not, where is it
 * stuck? Two small instruments, both reading the share SENDER's getStats():
 *
 *  1. ShareStatsSampler - one `share_fps` call event every SHARE_FPS_INTERVAL_MS
 *     while sharing (and one a moment after Cipherline gains or loses focus):
 *     the capture rate, the capturer's delivery rate, frames encoded per second,
 *     frames sent per second, why the encoder is limited, which encoder and
 *     whether it is hardware - plus whether the window has focus / is visible.
 *     Owner report 2026-10-13: "1 fps in a game, 50-60 when I click into
 *     Cipherline, even at 90". The next test reads these events and the answer
 *     is in the numbers:
 *        src_fps low, enc_fps ~ src_fps            -> the CAPTURER is the limit
 *                                                     (grab time, display refresh)
 *        src_fps high, enc_fps low, limit=cpu      -> the ENCODER/CPU is
 *        limit=bandwidth                           -> the NETWORK is
 *        focus=false rows low, focus=true rows high -> a background throttle
 *                                                     is still getting through
 *        hw=false                                  -> software encoder
 *        fg_state=QUNS_RUNNING_D3D_FULL_SCREEN, or fg_cover=true with a game's
 *        fg_exe, while src_fps collapses           -> a fullscreen game is
 *                                                     bypassing DWM composition
 *                                                     (owner report 2026-10-14:
 *                                                     ~9 fps with the game in
 *                                                     front, 45-80 without)
 *
 *  2. ShareEncoderWatchdog - the black-screen safety net. An encoder that fails
 *     to open (an illegal size, an exhausted NVENC session, a driver fault)
 *     produces NO frames and every viewer sees black. The watchdog notices
 *     "framesEncoded still 0 on every active layer after STALL_MS" and tells
 *     the caller, which republishes lower (decideStallAction) and says so.
 *     Never silently sends black.
 *
 * Nothing about who is in the call is read or logged: counters, rates and
 * enums only (the call event log's own allowlist enforces it).
 */
import { MAX_RESOLUTION_STEP } from './shareEncoderLimits';
import type { ForegroundDiag } from './foregroundInfo';

export const SHARE_FPS_INTERVAL_MS = 10_000;
/** An extra sample this long after a focus change, so before/after is visible without waiting. */
export const SHARE_FPS_FOCUS_DELAY_MS = 2_000;
/** Zero frames encoded on every active layer for this long = the encoder is not working. */
export const STALL_MS = 3_000;
export const STALL_POLL_MS = 1_000;

type Stat = Record<string, unknown>;
export type StatsLike = { forEach(cb: (s: Stat) => void): void };
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The numbers one getStats() report holds for the share. */
export interface ShareEncoderSnapshot {
    /** Epoch-independent ms (performance.now()). */
    at: number;
    /** Number of active video layers (outbound-rtp with active !== false). */
    activeLayers: number;
    /** Sum of framesEncoded over ACTIVE layers. */
    framesEncoded: number;
    /** Largest active layer. */
    sentFps?: number;
    width?: number;
    height?: number;
    limitation?: string;
    encoder?: string;
    hardware?: boolean;
    /** media-source framesPerSecond: what the capturer delivered in the last second. */
    sourceFps?: number;
}

/** Pull the snapshot from a sender report. null = no video outbound-rtp yet. */
export function readShareEncoderSnapshot(report: StatsLike | null | undefined, at: number): ShareEncoderSnapshot | null {
    if (!report) return null;
    const outs: Stat[] = [];
    let source: Stat | undefined;
    report.forEach(s => {
        if (!s || typeof s !== 'object') return;
        if (s.type === 'outbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) outs.push(s);
        else if (s.type === 'media-source' && s.kind === 'video' && !source) source = s;
    });
    if (outs.length === 0) return null;
    const area = (s: Stat) => (fin(s.frameWidth) ? s.frameWidth : 0) * (fin(s.frameHeight) ? s.frameHeight : 0);
    const active = outs.filter(s => s.active !== false);
    const pool = active.length > 0 ? active : outs;
    const top = pool.reduce((a, b) => (area(b) > area(a) ? b : a));
    const snap: ShareEncoderSnapshot = {
        at,
        activeLayers: active.length,
        framesEncoded: active.reduce((n, s) => n + (fin(s.framesEncoded) ? s.framesEncoded : 0), 0),
    };
    if (fin(top.framesPerSecond)) snap.sentFps = top.framesPerSecond;
    if (fin(top.frameWidth) && fin(top.frameHeight)) { snap.width = top.frameWidth; snap.height = top.frameHeight; }
    if (typeof top.qualityLimitationReason === 'string') snap.limitation = top.qualityLimitationReason;
    if (typeof top.encoderImplementation === 'string' && top.encoderImplementation) snap.encoder = top.encoderImplementation;
    if (typeof top.powerEfficientEncoder === 'boolean') snap.hardware = top.powerEfficientEncoder;
    if (source && fin(source.framesPerSecond)) snap.sourceFps = source.framesPerSecond;
    return snap;
}

/** What the sampler also needs from the page. */
export interface ShareSampleContext {
    /** MediaStreamTrack.getSettings().frameRate of the capture - what Chromium negotiated with the capturer. */
    captureFps?: number;
    targetFps: number;
    focused: boolean;
    visible: boolean;
}

export type ShareFpsDetail = Record<string, string | number | boolean>;

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The `share_fps` call event's detail (<= 11 keys, the log's per-event limit):
 *   cap_fps  capture frame rate Chromium negotiated   src_fps  capturer delivery, last second
 *   enc_fps  frames encoded per second (counter delta) sent_fps  encoder output, last second
 *   limit    qualityLimitationReason                   enc      encoderImplementation
 *   hw       powerEfficientEncoder                     res      encoded frame size
 *   target   the fps the user asked for                focus / vis  window state
 * Absent values are omitted (the log drops non-finite numbers and empty strings).
 */
export function buildShareFpsDetail(
    prev: ShareEncoderSnapshot | null,
    cur: ShareEncoderSnapshot,
    ctx: ShareSampleContext,
): ShareFpsDetail {
    const d: ShareFpsDetail = { target: ctx.targetFps, focus: ctx.focused, vis: ctx.visible ? 'visible' : 'hidden' };
    if (fin(ctx.captureFps)) d.cap_fps = r1(ctx.captureFps);
    if (fin(cur.sourceFps)) d.src_fps = r1(cur.sourceFps);
    if (prev) {
        const dt = (cur.at - prev.at) / 1000;
        if (dt >= 0.5 && cur.framesEncoded >= prev.framesEncoded) d.enc_fps = r1((cur.framesEncoded - prev.framesEncoded) / dt);
    }
    if (fin(cur.sentFps)) d.sent_fps = r1(cur.sentFps);
    if (cur.limitation) d.limit = cur.limitation;
    if (cur.encoder) d.enc = cur.encoder;
    if (typeof cur.hardware === 'boolean') d.hw = cur.hardware;
    if (cur.width && cur.height) d.res = `${cur.width}x${cur.height}`;
    return d;
}

export interface ShareStatsSamplerDeps {
    getStats(): Promise<StatsLike | null | undefined>;
    /** The capture track's settings, or null. */
    getCaptureFps(): number | undefined;
    focused(): boolean;
    visible(): boolean;
    targetFps: number;
    /** What has the screen right now (foregroundInfo.ts); null/absent = unknown. Asked before every sample. */
    getForeground?(): Promise<ForegroundDiag | null>;
    /** Every sample's foreground answer, the baseline included - the fullscreen hint watches this. */
    onForeground?(fg: ForegroundDiag | null): void;
    /** `fg` is what was in front when this sample was taken (null = unknown). */
    report(detail: ShareFpsDetail, fg: ForegroundDiag | null): void;
    now?(): number;
    intervalMs?: number;
    focusDelayMs?: number;
}

/** Emits `share_fps` on an interval and shortly after a focus change. One per share. */
export class ShareStatsSampler {
    private prev: ShareEncoderSnapshot | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private focusTimer: ReturnType<typeof setTimeout> | null = null;
    private disposed = false;
    private inFlight = false;
    private readonly now: () => number;
    private readonly deps: ShareStatsSamplerDeps;

    constructor(deps: ShareStatsSamplerDeps) {
        this.deps = deps;
        this.now = deps.now ?? (() => performance.now());
    }

    start(): void {
        if (this.timer || this.disposed) return;
        this.timer = setInterval(() => { void this.sample(); }, this.deps.intervalMs ?? SHARE_FPS_INTERVAL_MS);
        // A baseline now, so the first reported enc_fps spans a real interval.
        void this.sample(true);
    }

    /** Cipherline gained or lost focus: sample again shortly, to catch the change. */
    noteFocusChange(): void {
        if (this.disposed) return;
        if (this.focusTimer) clearTimeout(this.focusTimer);
        this.focusTimer = setTimeout(() => { this.focusTimer = null; void this.sample(); }, this.deps.focusDelayMs ?? SHARE_FPS_FOCUS_DELAY_MS);
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer) clearInterval(this.timer);
        if (this.focusTimer) clearTimeout(this.focusTimer);
        this.timer = this.focusTimer = null;
    }

    private async sample(baselineOnly = false): Promise<void> {
        if (this.disposed || this.inFlight) return;
        this.inFlight = true;
        try {
            // Foreground first, stats second: the stats timestamp (which the
            // rates are computed from) is taken right after its own await.
            let fg: ForegroundDiag | null = null;
            try { fg = (await this.deps.getForeground?.()) ?? null; } catch { fg = null; }
            if (this.disposed) return;
            try { this.deps.onForeground?.(fg); } catch { /* a watcher must not break the sampler */ }
            const cur = readShareEncoderSnapshot(await this.deps.getStats(), this.now());
            if (this.disposed || !cur) return;
            const prev = this.prev;
            this.prev = cur;
            if (baselineOnly) return;
            this.deps.report(buildShareFpsDetail(prev, cur, {
                captureFps: this.deps.getCaptureFps(),
                targetFps: this.deps.targetFps,
                focused: this.deps.focused(),
                visible: this.deps.visible(),
            }), fg);
        } catch {
            /* the share ended mid-sample - diagnostics only */
        } finally {
            this.inFlight = false;
        }
    }
}

// ── Black-screen safety net ────────────────────────────────────────────────

export interface EncoderStall {
    /** Active layers that produced nothing. */
    layers: number;
    /** performance-clock ms spent waiting. */
    waitedMs: number;
    /** What the stats said the encoder was (may be missing - it never opened). */
    encoder?: string;
    limitation?: string;
    width?: number;
    height?: number;
}

export interface EncoderWatchdogDeps {
    getStats(): Promise<StatsLike | null | undefined>;
    /** Called once, when an active layer has encoded nothing for stallMs. */
    onStall(info: EncoderStall): void;
    /** Called once, the first time a frame was encoded: the share is alive. */
    onHealthy?(): void;
    stallMs?: number;
    pollMs?: number;
    now?(): number;
    sleep?(ms: number): Promise<void>;
}

/**
 * Watches for "the encoder never produced a frame". Counts only time during
 * which at least one layer is ACTIVE: dynacast pauses a layer nobody watches,
 * and a paused layer legitimately encodes nothing. Ends (one-shot) at the first
 * encoded frame, at a stall, or on dispose(). The wait is on the performance
 * clock, so a backgrounded page's throttled timers cannot shorten it.
 */
export class ShareEncoderWatchdog {
    private disposed = false;
    private running: Promise<void> | null = null;
    private readonly deps: EncoderWatchdogDeps;

    constructor(deps: EncoderWatchdogDeps) {
        this.deps = deps;
    }

    start(): Promise<void> {
        if (!this.running) this.running = this.run();
        return this.running;
    }

    dispose(): void { this.disposed = true; }

    private async run(): Promise<void> {
        const now = this.deps.now ?? (() => performance.now());
        const sleep = this.deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
        const stallMs = this.deps.stallMs ?? STALL_MS;
        const pollMs = this.deps.pollMs ?? STALL_POLL_MS;
        let activeSince: number | null = null;
        while (!this.disposed) {
            let snap: ShareEncoderSnapshot | null = null;
            try { snap = readShareEncoderSnapshot(await this.deps.getStats(), now()); } catch { return; /* sender gone: share ended */ }
            if (this.disposed) return;
            if (snap && snap.framesEncoded > 0) { this.deps.onHealthy?.(); return; }
            if (snap && snap.activeLayers > 0) {
                const t = snap.at;
                if (activeSince === null) activeSince = t;
                if (t - activeSince >= stallMs) {
                    this.deps.onStall({
                        layers: snap.activeLayers, waitedMs: Math.round(t - activeSince),
                        encoder: snap.encoder, limitation: snap.limitation, width: snap.width, height: snap.height,
                    });
                    return;
                }
            } else {
                activeSince = null; // paused / no stats yet: not counted
            }
            await sleep(pollMs);
        }
    }
}

// ── What to do about a stall ───────────────────────────────────────────────

export type StallAction =
    /** Republish the same source with a smaller pixel budget (RESOLUTION_STEP_PIXELS[step]). */
    | { kind: 'resolution'; step: number }
    /** Nothing lower is left to try: tell the user, do not pretend. */
    | { kind: 'give_up' };

/** Resolution steps first, one at a time; once they are used up, give up honestly. */
export function decideStallAction(currentStep: number): StallAction {
    return currentStep < MAX_RESOLUTION_STEP ? { kind: 'resolution', step: currentStep + 1 } : { kind: 'give_up' };
}

/** The toast for each outcome. */
export function stallToastCopy(action: StallAction): { kind: 'warning' | 'error'; message: string } {
    if (action.kind === 'give_up') {
        return {
            kind: 'error',
            message: 'Your screen share isn’t reaching the call - the video encoder produced nothing even at a low resolution. Try a window instead of the whole display, or pick another codec in Settings → Advanced.',
        };
    }
    return {
        kind: 'warning',
        message: action.step === 1
            ? 'Your screen is too large for the video encoder, so the share was restarted at a lower resolution.'
            : 'The video encoder still couldn’t start, so the share was restarted at an even lower resolution.',
    };
}
