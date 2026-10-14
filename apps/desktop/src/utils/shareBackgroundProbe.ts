/**
 * What happens to OUR screen share when Cipherline goes to the background —
 * measured, once per background episode, and written to the call event log
 * as `share_background`.
 *
 * ── Why this exists (owner report, 2026-10-11) ─────────────────────────────
 * "When Cipherline is not focused, the screenshare fps tanks to 1 or 2 fps
 * when streaming at 90 requested." The investigation (branch
 * claude/share-fps-unfocused) found:
 *
 *   - Nothing on the share's frame path is driven by the page: the capture is
 *     Chromium's own desktop capturer (getDisplayMedia resolved by main's
 *     setDisplayMediaRequestHandler), the "lighter copy" is an encoder
 *     simulcast layer (scaleResolutionDownBy), and LiveKit's E2EE runs on
 *     encoded streams in a dedicated worker. No requestAnimationFrame, canvas,
 *     captureStream or track processor anywhere between capturer and wire
 *     (shareFramePath.test.ts keeps it that way).
 *   - Measured in Electron 43.2.0 (harness: real desktop capture → VP8 →
 *     loopback, with and without an E2EE encoded-streams worker): with the
 *     page genuinely HIDDEN (backgroundThrottling on, window hidden —
 *     rAF 0 Hz, timers clamped to 1 Hz) the share kept sending at its capture
 *     rate; the same harness with a rAF-driven canvas source fell to 0 fps
 *     (negative control). With backgroundThrottling off (the app's setting)
 *     the page never even becomes hidden.
 *
 * So "the page went to the background" cannot by itself take a share to
 * 1–2 fps. What is left is below the page, and Windows-only: the capturer
 * (DXGI / WGC readback queueing behind a GPU-bound foreground game, which
 * Chromium's capture pacing — next grab no sooner than 2 × the last grab —
 * turns into a collapse; or a fullscreen game whose frames stop reaching the
 * capturer at all, after which WebRTC repeats the last frame about once a
 * second), the OS timer the capture thread waits on, or the encoder. Those
 * need different fixes, and this dev box cannot run any of them. This probe
 * is how the next report says which one it is, with numbers:
 *
 *   capture_before/after  frames per second the CAPTURER delivered to WebRTC
 *                         (media-source) — before: Chromium's own last-second
 *                         rate at the moment of going to the background;
 *                         after: counted over SHARE_BG_MEASURE_MS once the
 *                         transition has settled;
 *   sent_before/after     frames per second the full layer actually SENT;
 *   doc_hidden            whether Chromium told the page it was hidden
 *                         (backgroundThrottling:false should keep this false
 *                         on every platform — a `true` from Windows would
 *                         mean native occlusion got through anyway);
 *   grab_ms / interval_ms / unchanged_pct
 *                         only with Settings → Advanced → capture timing log
 *                         on: Chromium's mean grab duration, the real time
 *                         between grabs, and the share of grabs that found no
 *                         new frame, over the newest SHARE_BG_TIMING_FRAMES;
 *   verdict               classifyShareBackground below.
 *
 *   fg_state / fg_exe / fg_cover
 *                         what had the screen when the verdict was taken
 *                         (foregroundInfo.ts): the Windows notification state
 *                         (QUNS_RUNNING_D3D_FULL_SCREEN = a fullscreen game),
 *                         the foreground PROGRAM's basename, and whether its
 *                         window covers its monitor. A `capture_slow` /
 *                         `capture_idle` verdict with a covering game here is
 *                         hypothesis (B): the game's fullscreen / independent-
 *                         flip presentation bypasses DWM, so a whole-SCREEN
 *                         capture only gets occasional frames. (To keep the
 *                         event inside the log's 11 detail keys this replaced
 *                         `doc_hidden`, `target_fps` and `unchanged_pct`:
 *                         `cause: hidden` says the page was hidden, share_fps
 *                         carries `target`, and `capture_idle` is the verdict.)
 *
 * Cost: nothing while the window is in the foreground (no polling); three
 * getStats calls and at most one capture-timing read per background episode,
 * at most SHARE_BG_MAX_EVENTS per share publication. Nothing about who is in
 * the call is read or logged — counters, rates and enums only.
 */

import type { ForegroundDiag } from './foregroundInfo';

/** Skip the first second after going to the background (the transition itself). */
export const SHARE_BG_SETTLE_MS = 1000;
/** The background window the "after" rates are counted over. */
export const SHARE_BG_MEASURE_MS = 4000;
/** Per share publication — enough for "alt-tab, back, alt-tab" without flooding the log. */
export const SHARE_BG_MAX_EVENTS = 3;
/** Newest capture-log polls summarised for grab_ms / interval_ms / unchanged_pct. */
export const SHARE_BG_TIMING_FRAMES = 12;
/** "Held" = the background send rate is at least this share of the foreground one. */
export const SHARE_BG_HELD_RATIO = 0.8;

export type ShareBgCause = 'blur' | 'minimize' | 'hide' | 'hidden';

/** blur < minimize/hide < hidden: how far into the background the window went. */
const CAUSE_RANK: Record<ShareBgCause, number> = { blur: 0, minimize: 1, hide: 1, hidden: 2 };

export type ShareBgVerdict =
    /** Sent rate held (≥ SHARE_BG_HELD_RATIO of before). */
    | 'held'
    /** Network: the encoder said bandwidth. Not a background problem. */
    | 'bandwidth'
    /** The encoder said cpu: this machine's encode is being starved. */
    | 'encoder_cpu'
    /** The capturer handed over (almost) no new frames: most polls found nothing new (0 Hz) —
     *  a static screen, or a fullscreen game whose frames no longer reach the capturer. */
    | 'capture_idle'
    /** Grabs got slow: each grab ≥ half the frame budget, so Chromium's 2 × rule paces capture
     *  down (readback queued behind the game's GPU work). */
    | 'capture_slow'
    /** The capture thread's timer fires late (OS timer throttling): real interval ≫ scheduled. */
    | 'capture_late'
    /** Capture rate fell; no capture timing log to say why. */
    | 'capture_dropped'
    /** Capture held but fewer frames were sent (encoder / GPU process). */
    | 'encoder_dropped'
    /** Not enough data to say. */
    | 'unknown';

/** The handful of stats the probe needs at one instant. */
export interface ShareFpsSnapshot {
    /** performance.now() ms. */
    at: number;
    /** media-source `frames`: frames the capturer delivered, cumulative. */
    sourceFrames?: number;
    /** media-source `framesPerSecond`: Chromium's own last-second capture rate. */
    sourceFps?: number;
    /** Full (largest) layer's `framesSent`, cumulative. */
    framesSent?: number;
    /** Full layer's `framesPerSecond`: Chromium's own last-second send rate. */
    sentFps?: number;
    /** Full layer's qualityLimitationReason. */
    limitation?: string;
}

type StatsLike = { forEach(cb: (s: Record<string, unknown>) => void): void };
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Pull the snapshot out of the share SENDER's getStats report. null = no video outbound-rtp yet. */
export function readShareFpsSnapshot(report: StatsLike | null | undefined, at: number): ShareFpsSnapshot | null {
    if (!report) return null;
    const outs: Record<string, unknown>[] = [];
    let source: Record<string, unknown> | undefined;
    report.forEach(s => {
        if (!s || typeof s !== 'object') return;
        if (s.type === 'outbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) outs.push(s);
        else if (s.type === 'media-source' && s.kind === 'video' && !source) source = s;
    });
    if (outs.length === 0) return null;
    const area = (s: Record<string, unknown>) => (fin(s.frameWidth) ? s.frameWidth : 0) * (fin(s.frameHeight) ? s.frameHeight : 0);
    // The full layer: the largest ACTIVE encoding (the lighter copy, when it
    // exists, is the smaller one and is usually inactive).
    const active = outs.filter(s => s.active !== false);
    const pool = active.length > 0 ? active : outs;
    const top = pool.reduce((a, b) => (area(b) > area(a) ? b : a));
    const snap: ShareFpsSnapshot = { at };
    if (source && fin(source.frames)) snap.sourceFrames = source.frames;
    if (source && fin(source.framesPerSecond)) snap.sourceFps = source.framesPerSecond;
    if (fin(top.framesSent)) snap.framesSent = top.framesSent;
    if (fin(top.framesPerSecond)) snap.sentFps = top.framesPerSecond;
    if (typeof top.qualityLimitationReason === 'string') snap.limitation = top.qualityLimitationReason;
    return snap;
}

export interface ShareRates { capture?: number; sent?: number }

/** Rates counted between two snapshots (≥ 0.5 s apart; counters must not go backwards). */
export function ratesBetween(a: ShareFpsSnapshot | null, b: ShareFpsSnapshot | null): ShareRates {
    if (!a || !b) return {};
    const dt = (b.at - a.at) / 1000;
    if (!(dt >= 0.5)) return {};
    const rate = (x?: number, y?: number) => (fin(x) && fin(y) && y >= x ? Math.round(((y - x) / dt) * 10) / 10 : undefined);
    const out: ShareRates = {};
    const c = rate(a.sourceFrames, b.sourceFrames);
    const s = rate(a.framesSent, b.framesSent);
    if (c !== undefined) out.capture = c;
    if (s !== undefined) out.sent = s;
    return out;
}

/** The "before" rates: Chromium's own last-second rates in the snapshot taken as we left the foreground. */
export function ratesAt(s: ShareFpsSnapshot | null): ShareRates {
    if (!s) return {};
    const out: ShareRates = {};
    if (fin(s.sourceFps)) out.capture = s.sourceFps;
    if (fin(s.sentFps)) out.sent = s.sentFps;
    return out;
}

/** The capture-log summary fields the verdict uses (screenShareDiagnostics.CaptureTiming). */
export interface ShareBgTiming { captureMs: number; periodMs: number; intervalMs?: number; unchangedRatio: number }

/**
 * Which part of the pipeline lost the frames. Order matters: the encoder's
 * own limitation reason first (it is authoritative), then the capturer.
 */
export function classifyShareBackground(input: {
    before: ShareRates;
    after: ShareRates;
    limitation?: string;
    timing?: ShareBgTiming | null;
    targetFps: number;
}): ShareBgVerdict {
    const { before, after, limitation, timing, targetFps } = input;
    if (!fin(after.sent)) return 'unknown';
    // Baseline: what it was sending in the foreground, never above the target.
    const base = fin(before.sent) && before.sent > 0
        ? Math.min(before.sent, targetFps > 0 ? targetFps : before.sent)
        : null;
    if (base === null) return 'unknown';
    if (after.sent >= SHARE_BG_HELD_RATIO * base) return 'held';
    if (limitation === 'bandwidth') return 'bandwidth';
    if (limitation === 'cpu') return 'encoder_cpu';
    const captureFell = fin(after.capture)
        ? (fin(before.capture) && before.capture > 0 ? after.capture < SHARE_BG_HELD_RATIO * Math.min(before.capture, base) : after.capture < SHARE_BG_HELD_RATIO * base)
        : null;
    if (captureFell === false) return 'encoder_dropped';
    if (timing) {
        if (timing.unchangedRatio >= 0.5) return 'capture_idle';
        // Chromium waits max(2 × grab, budget) between grabs; a grab longer
        // than a whole frame budget has at least halved the rate by itself.
        const budgetMs = targetFps > 0 ? 1000 / targetFps : 0;
        if (budgetMs > 0 && timing.captureMs > budgetMs) return 'capture_slow';
        if (fin(timing.intervalMs) && timing.periodMs > 0 && timing.intervalMs > 1.5 * timing.periodMs) return 'capture_late';
    }
    if (captureFell === true) {
        // Without the timing log, a capturer that delivers next to nothing is
        // most likely 0 Hz (no new frames), not slow grabs: slow grabs still
        // deliver every grab.
        return fin(after.capture) && after.capture < 3 ? 'capture_idle' : 'capture_dropped';
    }
    return 'unknown';
}

/** The detail logged as `share_background` (≤ 11 keys: the log keeps one slot for `repeat`). */
export interface ShareBgReport {
    cause: ShareBgCause;
    docHidden: boolean;
    targetFps: number;
    before: ShareRates;
    after: ShareRates;
    verdict: ShareBgVerdict;
    timing?: ShareBgTiming | null;
    /** What had the screen when the verdict was taken (null = unknown). */
    fg?: ForegroundDiag | null;
}

export interface ShareBackgroundProbeDeps {
    /** The share sender's getStats (null/undefined once it is gone). */
    getStats(): Promise<StatsLike | null | undefined>;
    /** Capture-log summary of the newest `frames` polls, or null when the log is off. */
    getTiming?(frames: number): Promise<ShareBgTiming | null>;
    /** What has the screen right now (foregroundInfo.ts); null/absent = unknown. */
    getForeground?(): Promise<ForegroundDiag | null>;
    /** document.hidden right now. */
    docHidden(): boolean;
    targetFps: number;
    report(r: ShareBgReport): void;
    now?(): number;
}

/**
 * One probe per share publication. Feed it background/foreground transitions
 * (subscribeWindowBackground below does that in the app).
 */
export class ShareBackgroundProbe {
    private background = false;
    private cause: ShareBgCause = 'blur';
    private episode = 0;
    private reported = 0;
    private timers: ReturnType<typeof setTimeout>[] = [];
    private disposed = false;
    private readonly now: () => number;
    private readonly deps: ShareBackgroundProbeDeps;

    constructor(deps: ShareBackgroundProbeDeps) {
        this.deps = deps;
        this.now = deps.now ?? (() => performance.now());
    }

    get eventsLogged(): number { return this.reported; }

    setBackground(bg: boolean, cause: ShareBgCause = 'blur'): void {
        if (this.disposed) return;
        if (bg === this.background) {
            // Already in the background: a later, stronger signal (blur, then
            // minimise) refines the cause without restarting the measurement.
            if (bg && CAUSE_RANK[cause] > CAUSE_RANK[this.cause]) this.cause = cause;
            return;
        }
        this.background = bg;
        this.cause = cause;
        this.episode++;
        this.clearTimers();
        if (!bg || this.reported >= SHARE_BG_MAX_EVENTS) return;
        const episode = this.episode;
        const live = () => !this.disposed && this.background && this.episode === episode;
        void (async () => {
            const at0 = this.now();
            const s0 = await this.snap();
            if (!live() || !s0) return;
            const before = ratesAt(s0);
            const s1 = await this.after(SHARE_BG_SETTLE_MS - (this.now() - at0), live);
            if (!s1) return;
            const s2 = await this.after(SHARE_BG_MEASURE_MS, live);
            if (!s2) return;
            let timing: ShareBgTiming | null = null;
            try { timing = (await this.deps.getTiming?.(SHARE_BG_TIMING_FRAMES)) ?? null; } catch { timing = null; }
            let fg: ForegroundDiag | null = null;
            try { fg = (await this.deps.getForeground?.()) ?? null; } catch { fg = null; }
            if (!live() || this.reported >= SHARE_BG_MAX_EVENTS) return;
            const after = ratesBetween(s1, s2);
            const verdict = classifyShareBackground({ before, after, limitation: s2.limitation, timing, targetFps: this.deps.targetFps });
            this.reported++;
            this.deps.report({ cause: this.cause, docHidden: this.deps.docHidden(), targetFps: this.deps.targetFps, before, after, verdict, timing, fg });
        })().catch(() => { /* the share ended mid-measurement — diagnostics only */ });
    }

    dispose(): void {
        this.disposed = true;
        this.clearTimers();
    }

    private async snap(): Promise<ShareFpsSnapshot | null> {
        try { return readShareFpsSnapshot(await this.deps.getStats(), this.now()); } catch { return null; }
    }

    /** Wait `ms` (clamped ≥ 0), then snapshot — null if the episode ended meanwhile. */
    private after(ms: number, live: () => boolean): Promise<ShareFpsSnapshot | null> {
        return new Promise(resolve => {
            const t = setTimeout(() => {
                this.timers = this.timers.filter(x => x !== t);
                if (!live()) { resolve(null); return; }
                void this.snap().then(s => resolve(live() ? s : null));
            }, Math.max(0, ms));
            this.timers.push(t);
        });
    }

    private clearTimers(): void {
        for (const t of this.timers) clearTimeout(t);
        this.timers = [];
    }
}

type BgApi = Partial<Record<'onWindowMinimize' | 'onWindowHide' | 'onWindowFocus', (cb: () => void) => (() => void)>>;

/**
 * "Is Cipherline in the background" transitions, with the cause. Same rule as
 * GamingVideoGuard / utils/idleMotion.ts: with the Electron bridge only main's
 * real OS focus push ends a minimise/hide (a hidden window's page can still
 * get DOM focus); without it, DOM focus is all there is.
 */
export function subscribeWindowBackground(
    cb: (background: boolean, cause: ShareBgCause) => void,
    win: Window = window,
): () => void {
    const doc = win.document;
    const api = (win as unknown as { electronAPI?: BgApi }).electronAPI;
    const onBlur = () => cb(true, 'blur');
    const onFg = () => cb(false, 'blur');
    const onVis = () => { if (doc.hidden) cb(true, 'hidden'); };
    const domFocus = api?.onWindowFocus ? () => { /* wait for main */ } : onFg;
    win.addEventListener('blur', onBlur);
    win.addEventListener('focus', domFocus);
    doc.addEventListener('visibilitychange', onVis);
    const offs = [
        api?.onWindowFocus?.(onFg),
        api?.onWindowMinimize?.(() => cb(true, 'minimize')),
        api?.onWindowHide?.(() => cb(true, 'hide')),
    ];
    return () => {
        win.removeEventListener('blur', onBlur);
        win.removeEventListener('focus', domFocus);
        doc.removeEventListener('visibilitychange', onVis);
        for (const off of offs) { try { off?.(); } catch { /* already gone */ } }
    };
}

/** Is the window in the background right now (for a probe installed mid-share)? */
export function isWindowBackground(doc: Document = document): boolean {
    try { return doc.hidden || !doc.hasFocus(); } catch { return false; }
}
