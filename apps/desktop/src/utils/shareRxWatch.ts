/**
 * One watched remote screen share, as CallEventMonitor sees it: feed it the
 * track's stats report on every monitor tick (2 s) and it says when to log
 *
 *   share_rx_start   once the decoder / codec is known, and again if it changes;
 *   share_rx_fps     every RX_FPS_WINDOW_MS (10 s) - the window's rates;
 *   share_display    (viewer) once, when the window's display refresh rate has
 *                    been measured - the caller runs the rAF measurement
 *                    (displayRefresh.ts) when claimHzMeasurement() says so.
 *
 * It reuses the report the monitor already fetched for freeze / loss detection:
 * no second getStats loop. Pure state machine over the shareRxStats readers;
 * the clock is the caller's `now`.
 */
import {
    readShareRxSnapshot, buildShareRxDetail, buildShareRxStartDetail, dispFpsBetween, rxDecoderKey,
    type ShareRxSnapshot, type VideoPlaybackSnapshot, type ShareDetail, type StatsLike,
} from './shareRxStats';
import { RxStallWatch } from './shareRxStall';
import { ShareRxRing, RingLimiter, RX_RING_GAP_MS, RX_RING_MAX } from './shareSecondRing';

export const RX_FPS_WINDOW_MS = 10_000;
/** Give up measuring the display rate after this many throttled / failed attempts... */
export const HZ_MAX_ATTEMPTS = 6;
/** ...spaced this far apart (a covered window's rAF is throttled; the user may come back). */
export const HZ_RETRY_MS = 20_000;

export interface ShareRxObserveContext {
    /** Call-log placeholder (remote-video-N). */
    track: string;
    layer?: number;
    tile?: number;
    focus: boolean;
    /** The tile's <video> playback counters, and an identity for WHICH element (a changed element resets them). */
    playback: VideoPlaybackSnapshot | null;
    playbackKey: object | null;
}

export interface ShareRxObserved {
    start?: ShareDetail;
    fps?: ShareDetail;
    /** share_rx_stall: frames arrive, none is decoded (shareRxStall.ts). */
    stall?: ShareDetail;
}

export class ShareRxWatch {
    private ref: string | undefined;
    private win: ShareRxSnapshot | null = null;
    private winPlay: VideoPlaybackSnapshot | null = null;
    private winKey: object | null = null;
    private winAt = 0;
    private decoderKey: string | null = null;
    private hz: 'todo' | 'pending' | 'done' = 'todo';
    private hzAttempts = 0;
    private hzRetryAt = 0;
    private readonly stall = new RxStallWatch();
    private last: ShareRxSnapshot | null = null;
    /** The last ~10 s, one row per second (fed by observeSecond; summarised around a freeze). */
    readonly ring = new ShareRxRing();
    /** How many freeze summaries this share may write, and how often. */
    readonly ringGate = new RingLimiter(RX_RING_GAP_MS, RX_RING_MAX);

    /** Resolved share_ref (shareRef.ts); events logged before it resolves simply omit it. */
    setRef(ref: string | null | undefined): void { if (ref) { this.ref = ref; this.stall.setRef(ref); } }
    get shareRef(): string | undefined { return this.ref; }
    /** Frames arrive and none is decoded, right now (shareRxStall.ts). */
    get stalled(): boolean { return this.stall.stalled; }
    /** The last monitor tick's reading. */
    get latest(): ShareRxSnapshot | null { return this.last; }

    observe(now: number, report: StatsLike | null | undefined, ctx: ShareRxObserveContext): ShareRxObserved {
        const out: ShareRxObserved = {};
        const cur = readShareRxSnapshot(report, now);
        if (!cur) return out;
        this.last = cur;

        const stall = this.stall.observe(now, cur, ctx.track);
        if (stall) out.stall = stall;

        const key = rxDecoderKey(cur);
        if (key && key !== this.decoderKey) {
            this.decoderKey = key;
            out.start = buildShareRxStartDetail(cur, { shareRef: this.ref, track: ctx.track, layer: ctx.layer });
        }

        if (!this.win) { this.rebase(now, cur, ctx); return out; }
        if (now - this.winAt < RX_FPS_WINDOW_MS) return out;

        // Playback counters belong to one element: a different tile now means no presented-frame rate this window.
        const sameEl = this.winKey === ctx.playbackKey;
        const detail = buildShareRxDetail(this.win, cur, {
            shareRef: this.ref, track: ctx.track,
            dispFps: sameEl ? dispFpsBetween(this.winPlay, ctx.playback) : undefined,
            tile: ctx.tile, layer: ctx.layer, focus: ctx.focus,
        });
        if (detail) out.fps = detail;
        this.rebase(now, cur, ctx);
        return out;
    }

    /** The 1 s tick: one more row for the ring. Not the 2 s monitor tick - this never logs. */
    observeSecond(now: number, report: StatsLike | null | undefined, playback: VideoPlaybackSnapshot | null, playbackKey: object | null): void {
        this.ring.observe(report, now, playback, playbackKey);
    }

    private rebase(now: number, cur: ShareRxSnapshot, ctx: ShareRxObserveContext): void {
        this.win = cur;
        this.winAt = now;
        this.winPlay = ctx.playback;
        this.winKey = ctx.playbackKey;
    }

    /**
     * Should the caller run the display-rate measurement now? True once per
     * attempt (not while one is in flight, not after it succeeded or gave up,
     * not before the retry delay); the share_ref must be known so the event can
     * be matched. `now` = the caller's clock (omitted: no retry delay applies).
     */
    claimHzMeasurement(now = Infinity): boolean {
        if (this.hz !== 'todo' || !this.ref || now < this.hzRetryAt) return false;
        this.hz = 'pending';
        return true;
    }

    /** Result of the measurement: the share_display detail on success; null -> retry later (up to HZ_MAX_ATTEMPTS). */
    finishHz(hz: number | null, now = 0): ShareDetail | null {
        if (hz === null || !Number.isFinite(hz) || hz <= 0) {
            this.hzAttempts++;
            this.hzRetryAt = now + HZ_RETRY_MS;
            this.hz = this.hzAttempts >= HZ_MAX_ATTEMPTS ? 'done' : 'todo';
            return null;
        }
        this.hz = 'done';
        const d: ShareDetail = { role: 'viewer', hz, hz_src: 'raf' };
        if (this.ref) d.share_ref = this.ref;
        return d;
    }
}
