/**
 * Viewer: get a remote share moving again when its decoder has fallen behind.
 * The stall itself is detected by RxStallWatch (shareRxStall.ts, which holds the
 * root cause); until this existed, nothing acted on it. Neither older recovery
 * could: ShareLossFallback needs loss or a keyframe request and this stall has
 * neither, and RxDecoderLostWatch needs the NullVideoDecoder name.
 *
 * ── What ends this stall (reports cd4f4ce5, c704ba3e, 2026-11-08)
 *
 * A keyframe alone cannot: it joins the back of the queue (one arrived during the
 * 28 s stall, and 88 fps kept being dropped for two more 5 s samples). All three
 * stalls ended when the decoder's INPUT paused and the backlog drained:
 *   12 s: the sender went idle (pkt/s 1067, 313, 12, 12, 12), no keyframe;
 *   12 s: the same (pkt/s 1085, 353, 12, 276, 70, 12), dec/s 0 until 7, no keyframe;
 *   28 s: packet repair (NACKs 14 to 26) held frames back for ~1.5 s: dec/s 10.6
 *         with drop/s 22, then 0 and 0 with no jitter-buffer reading, then 67, then 90.
 *
 * That 10.6 is the 10-frame memory draining, and drain time is at most ~4 s here.
 *
 * ── What this does, in order, within ATTEMPT_WINDOW_MS
 *
 *   1. Pause forwarding at the SFU until the decoder has drained, then resume.
 *      The picture is already frozen, so the pause costs nothing the viewer can
 *      see, and the SFU asks the sender for a keyframe on resume.
 *      Drained = framesDecoded moves during the pause: libwebrtc forgets all but
 *      the last 10 frames it handed over, so those are the first outputs it can
 *      count again, and they come out last. Bounded by FLUSH_MAX_MS.
 *   2. The same, and hold the share at its lighter copy (ShareLossFallback): a
 *      lower frame rate leaves the decoder headroom. The fallback owns the hold,
 *      the way back up, the notice and "Keep full quality".
 *   3. The same, and when there is no lighter copy to go to (one layer, the
 *      sharer's gate has it off, opted out, already on it), stop advertising
 *      H.265 decode so the sharer resends as H.264: there Chromium bounds the
 *      queue and asks for a keyframe by itself.
 *
 * Time and side effects are injected. Counts and enums only in the log.
 */

/** Longest the input stays paused for one attempt, whether or not the drain was seen. */
export const FLUSH_MAX_MS = 5_000;
/** After a resume, how long a stall may stand before the next attempt (the keyframe needs a moment). */
export const RETRY_AFTER_MS = 5_000;
/** The retry delay doubles past the third attempt, up to this: a decoder that never recovers is not paused forever. */
export const RETRY_MAX_MS = 60_000;
/** Attempts this close together count as the same trouble and escalate. */
export const ATTEMPT_WINDOW_MS = 180_000;
export const CAP_FROM_ATTEMPT = 2;
export const H264_FROM_ATTEMPT = 3;

export type StallFlushDetail = Record<string, string | number | boolean>;

export interface StallRecoveryDeps {
    now(): number;
    /** Stop forwarding this share at the SFU; the returned function resumes it. */
    pause(): () => void;
    /** Hold the share at its lower layer. True when this call put the cap on. */
    cap(): boolean;
    /** Stop advertising H.265 decode. True when it did (the share is H.265). */
    withdrawH265(): boolean;
    log(detail: StallFlushDetail): void;
    setTimer(cb: () => void, ms: number): unknown;
    clearTimer(handle: unknown): void;
}

interface Flush { since: number; frames: number; attempt: number; resume: () => void; timer: unknown }

export class ShareRxStallRecovery {
    private attempts: number[] = [];
    private flush: Flush | null = null;
    private nextAt = -Infinity;
    private withdrawn = false;
    private readonly deps: StallRecoveryDeps;

    constructor(deps: StallRecoveryDeps) { this.deps = deps; }

    /** The input is paused on purpose: the caller must not read the silence as anything else. */
    get flushing(): boolean { return this.flush !== null; }

    /** Every monitor tick. `stalled`: frames arrive and none decodes, on a decoder that is still alive. */
    tick(stalled: boolean, framesDecoded: number): void {
        if (this.flush || !stalled) return;
        const now = this.deps.now();
        if (now < this.nextAt) return;
        this.attempts = [...this.attempts.filter(t => now - t < ATTEMPT_WINDOW_MS), now];
        const attempt = this.attempts.length;
        const capped = attempt >= CAP_FROM_ATTEMPT && this.deps.cap();
        const h264 = attempt >= H264_FROM_ATTEMPT && !capped && !this.withdrawn && this.deps.withdrawH265();
        if (h264) this.withdrawn = true;
        this.flush = {
            since: now, frames: framesDecoded, attempt,
            resume: this.deps.pause(),
            timer: this.deps.setTimer(() => this.finish(false), FLUSH_MAX_MS),
        };
        this.deps.log({ phase: 'start', attempt, cap: capped, h264 });
    }

    /** While flushing, as often as stats are read: framesDecoded moving means the backlog is gone. */
    decoded(framesDecoded: number | undefined): void {
        if (this.flush && framesDecoded !== undefined && framesDecoded > this.flush.frames) this.finish(true);
    }

    /** The share went away or the call ended: never leave it paused. No log, nothing was concluded. */
    stop(): void {
        const f = this.flush;
        if (!f) return;
        this.flush = null;
        this.deps.clearTimer(f.timer);
        f.resume();
    }

    private finish(drained: boolean): void {
        const f = this.flush;
        if (!f) return;
        this.flush = null;
        this.deps.clearTimer(f.timer);
        f.resume();
        const now = this.deps.now();
        this.nextAt = now + Math.min(RETRY_MAX_MS, RETRY_AFTER_MS * 2 ** Math.max(0, f.attempt - H264_FROM_ATTEMPT));
        this.deps.log({ phase: 'end', attempt: f.attempt, drained, ms: Math.round(now - f.since) });
    }
}
