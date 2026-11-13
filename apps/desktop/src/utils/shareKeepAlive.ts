/**
 * Keep a screen share alive for viewers while the OS capturer hands over (almost) no new frames.
 *
 * ── Why (owner reports 566966f4, 4667c6fa; Windows 11, DXGI capturer, 90 fps share)
 * With another program in a fullscreen-like state in front (obs64 under QUNS_BUSY, a game under
 * QUNS_RUNNING_D3D_FULL_SCREEN), the capture fell to 1-3 fps (`share_fps src_fps=1`) while the
 * encoder stayed healthy (enc 87-100 fps capability) and nothing below the page was throttled
 * (`share_background verdict=held`, capture 72-80 fps in the 4 s after the window went to the
 * background; the same share ran at 90 with a normal window in front). The source stopped
 * delivering; viewers saw a picture that no longer moved for up to ~60 s. A static screen looks
 * the same to the capturer on DXGI (no new frame when nothing changed), so "no new frames" can be a
 * stall, a still desktop, or a game that bypasses the compositor: the sender cannot tell which.
 *
 * What this does about it: when the capture has delivered under ENGAGE_BELOW_FPS for
 * ENGAGE_SUSTAIN_MS, the published track is switched (RTCRtpSender.replaceTrack, no republish, no
 * unpublish) to one that re-emits the LAST real frame whenever the source has been quiet for
 * IDLE_MS, i.e. at least ~5 frames a second, and passes every real frame straight through the
 * moment one arrives. Viewers keep receiving frames (no stall indicator, no keyframe storm, no
 * "frozen" tile), a still screen is never reported as a freeze, and a screen that starts moving
 * again shows up at once. The picture itself is still the last one the capturer produced: this
 * cannot make a starved capturer deliver, it only keeps the stream honest about being alive.
 * The sharer is told separately, in words (shareStarveNotice.ts).
 *
 * ── Safety
 *   - Engaged only while nothing is in flight (the capture is delivering < 5 fps), so the
 *     encoder is not handed a changed frame size mid-stream (the crash class of 45a5e136 /
 *     2a673e74): the repeated frames are the capture's own frames at the capture's own size.
 *   - Stopped BEFORE any retune, swap or republish (the capture's constraints change the frame
 *     size), on share end, and on any error: the original capture track goes back on the sender.
 *   - The stop reverts only when the sender still carries OUR track; otherwise (the share was
 *     replaced or ended) it just releases the capture it owns.
 *   - Kill switch: secureLocalStore `cipherline_share_keepalive` = 'off'.
 *   - Frame lifetime as in shareCropTransform.ts: every path closes the frames it owns, the held
 *     copy is released on every new frame, and the queues are one frame deep.
 */
import { readShareFpsSnapshot, ratesBetween, type ShareFpsSnapshot } from './shareBackgroundProbe';
import type { StatsLike } from './shareEncoderOverload';

/** Capture rate under which the source counts as "not delivering". */
export const KEEPALIVE_ENGAGE_BELOW_FPS = 5;
/** ...for this long, in consecutive stats windows. */
export const KEEPALIVE_ENGAGE_SUSTAIN_MS = 6_000;
/** A quiet source gets a repeated frame after this long without a real one. */
export const KEEPALIVE_IDLE_MS = 250;
/** ...and then another this often, while it stays quiet. */
export const KEEPALIVE_REPEAT_MS = 200;

// ── the decision ───────────────────────────────────────────────────────────

/**
 * Feed it every sender stats report; it says `true` once when the capture has been starved long
 * enough. Pure (no clock of its own). `reset()` after a stop, retune or republish.
 */
export class KeepAliveGate {
    private prev: ShareFpsSnapshot | null = null;
    private starvedMs = 0;
    private fired = false;

    reset(): void { this.prev = null; this.starvedMs = 0; this.fired = false; }

    observe(now: number, report: StatsLike | null | undefined): boolean {
        const snap = readShareFpsSnapshot(report, now);
        if (!snap) { this.starvedMs = 0; return false; }
        const pf = this.prev;
        this.prev = snap;
        if (!pf) return false;
        const dt = snap.at - pf.at;
        // A window too short or a clock that went backwards says nothing.
        if (!(dt >= 500)) { this.prev = pf; return false; }
        const cap = ratesBetween(pf, snap).capture;
        if (typeof cap !== 'number' || !Number.isFinite(cap) || cap >= KEEPALIVE_ENGAGE_BELOW_FPS) {
            this.starvedMs = 0;
            return false;
        }
        this.starvedMs += dt;
        if (this.fired || this.starvedMs < KEEPALIVE_ENGAGE_SUSTAIN_MS) return false;
        this.fired = true;
        return true;
    }
}

// ── the frame stage ────────────────────────────────────────────────────────

/** The slice of a WebCodecs VideoFrame this needs. */
export interface KeepAliveFrame {
    timestamp: number;
    close(): void;
}

export interface KeepAliveStats {
    /** Real frames from the capturer. */
    real: number;
    /** Frames re-emitted because the capturer was quiet. */
    repeated: number;
    errors: number;
}

export interface KeepAliveDeps<F extends KeepAliveFrame> {
    /** An independent copy of `frame` (shares its pixels): `frame.clone()`. */
    cloneFrame(frame: F): F;
    /** A copy of `frame` stamped `timestampUs`: `new VideoFrame(frame, { timestamp })`. */
    restamp(frame: F, timestampUs: number): F;
    now(): number;
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
    idleMs?: number;
    repeatMs?: number;
}

/**
 * A Transformer that passes real frames through and re-emits the newest one while the source is
 * quiet. `start` arms the timer, `flush` / `cancel` (via `dispose`) release it and the held copy.
 */
export function createKeepAliveTransformer<F extends KeepAliveFrame>(deps: KeepAliveDeps<F>): Transformer<F, F> & { stats: KeepAliveStats; dispose(): void } {
    const idleMs = deps.idleMs ?? KEEPALIVE_IDLE_MS;
    const repeatMs = deps.repeatMs ?? KEEPALIVE_REPEAT_MS;
    const stats: KeepAliveStats = { real: 0, repeated: 0, errors: 0 };
    let held: F | null = null;
    let lastOutAt = deps.now();
    let heldAt = 0;
    let timer: unknown = null;
    let ctl: TransformStreamDefaultController<F> | null = null;

    const release = () => { if (held) { try { held.close(); } catch { /* already closed */ } held = null; } };
    const tick = () => {
        if (!ctl || !held) return;
        const t = deps.now();
        if (t - lastOutAt < idleMs) return;
        try {
            // The held frame's own timestamp plus the real time since it arrived: strictly increasing
            // across repeats, and never ahead of the next real frame (which was captured later).
            ctl.enqueue(deps.restamp(held, held.timestamp + Math.round((t - heldAt) * 1000)));
            stats.repeated++;
            // The next repeat is one repeat interval after this one, not one idle interval.
            lastOutAt = t - (idleMs - repeatMs);
        } catch {
            stats.errors++;
        }
    };
    const dispose = () => {
        if (timer !== null) { deps.clearInterval(timer); timer = null; }
        release();
        ctl = null;
    };

    return {
        stats,
        dispose,
        start(controller) {
            ctl = controller;
            lastOutAt = deps.now();
            timer = deps.setInterval(tick, Math.max(20, Math.floor(repeatMs / 2)));
        },
        transform(frame, controller) {
            stats.real++;
            let passed = false;
            try {
                release();
                held = deps.cloneFrame(frame);
                heldAt = deps.now();
                lastOutAt = heldAt;
                controller.enqueue(frame);
                passed = true;
            } catch {
                stats.errors++;
            } finally {
                // A passed frame now belongs to the sink; anything else is ours to close.
                if (!passed) { try { frame.close(); } catch { /* already closed */ } }
            }
        },
        flush() { dispose(); },
    };
}

/** Wire readable -> keep-alive -> writable. `stop()` aborts the pipe and releases the held frame. */
export function runKeepAlivePipe<F extends KeepAliveFrame>(
    readable: ReadableStream<F>,
    writable: WritableStream<F>,
    deps: KeepAliveDeps<F>,
): { done: Promise<void>; stop(): void; stats: KeepAliveStats } {
    const t = createKeepAliveTransformer(deps);
    const ac = new AbortController();
    // One frame deep each way: a queued frame is a frame the capturer's pool is short of.
    const ts = new TransformStream<F, F>(t, { highWaterMark: 1 }, { highWaterMark: 1 });
    const done = readable.pipeThrough(ts, { signal: ac.signal }).pipeTo(writable, { signal: ac.signal })
        .catch(() => { /* aborted / sink closed: the normal way a pipe ends */ })
        .finally(() => t.dispose());
    return { done, stop: () => { ac.abort(); t.dispose(); }, stats: t.stats };
}

// ── switching the sender over ──────────────────────────────────────────────

type ProcessorCtor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> };
type GeneratorCtor = new (init: { kind: 'video' }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> };

/** The slice of LiveKit's LocalVideoTrack this needs. */
export interface KeepAliveTrackLike {
    mediaStreamTrack?: MediaStreamTrack;
    replaceTrack(track: MediaStreamTrack, userProvidedTrack?: boolean): Promise<unknown>;
}

export interface KeepAliveHandle {
    /** Back to the capture itself (or, if the share already moved on, just release it). Idempotent. */
    stop(): Promise<void>;
    stats(): KeepAliveStats;
}

export interface EngageDeps {
    Processor?: ProcessorCtor;
    Generator?: GeneratorCtor;
    frame?: KeepAliveDeps<VideoFrame>;
}

const g = globalThis as unknown as { MediaStreamTrackProcessor?: ProcessorCtor; MediaStreamTrackGenerator?: GeneratorCtor; VideoFrame?: unknown };

/**
 * Which OSes engage the keep-alive. Written Windows-only (the evidence was a DXGI capturer starved by a fullscreen game),
 * but nothing in the stage is Windows-specific: it is a renderer-side track swap, and it is built to be harmless on a
 * still screen. Linux (X11 and the Wayland portal) and macOS (ScreenCaptureKit) capturers also deliver nothing for a
 * still or occluded screen, and their viewers then see a frozen / stalled tile exactly as on Windows (2026-11-10 share
 * parity pass). The native hardware path never gets here (its sender carries a stand-in track).
 */
export function keepAlivePlatformOk(platform: string | undefined): boolean {
    return platform === 'windows' || platform === 'linux' || platform === 'mac';
}

export function supportsKeepAlive(): boolean {
    return typeof g.MediaStreamTrackProcessor === 'function' && typeof g.MediaStreamTrackGenerator === 'function' && typeof g.VideoFrame === 'function';
}

const browserFrameDeps = (): KeepAliveDeps<VideoFrame> => ({
    cloneFrame: f => f.clone(),
    restamp: (f, ts) => new VideoFrame(f, { timestamp: ts }),
    now: () => performance.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: h => clearInterval(h as ReturnType<typeof setInterval>),
});

/**
 * Put the keep-alive stage between the share's capture and its sender. Resolves null (and leaves
 * everything as it was) when it cannot: unsupported, no live capture, or replaceTrack refused.
 */
export async function engageKeepAlive(track: KeepAliveTrackLike, deps: EngageDeps = {}): Promise<KeepAliveHandle | null> {
    const Processor = deps.Processor ?? g.MediaStreamTrackProcessor;
    const Generator = deps.Generator ?? g.MediaStreamTrackGenerator;
    const raw = track.mediaStreamTrack;
    if (!Processor || !Generator || !raw || raw.readyState !== 'live') return null;
    let generator: (MediaStreamTrack & { writable: WritableStream<VideoFrame> }) | null = null;
    let pipe: ReturnType<typeof runKeepAlivePipe<VideoFrame>> | null = null;
    try {
        generator = new Generator({ kind: 'video' });
        // Same advisory hint the crop pipeline gives its generated track: frame rate over sharpness.
        try { generator.contentHint = 'motion'; } catch { /* advisory */ }
        pipe = runKeepAlivePipe<VideoFrame>(new Processor({ track: raw }).readable, generator.writable, deps.frame ?? browserFrameDeps());
        await track.replaceTrack(generator, true);
    } catch {
        pipe?.stop();
        try { generator?.stop(); } catch { /* gone */ }
        return null;
    }
    const gen = generator;
    let stopped = false;
    return {
        stats: () => ({ ...pipe!.stats }),
        async stop() {
            if (stopped) return;
            stopped = true;
            // Revert only while the sender still carries OUR track and it is still running (an ended one
            // means the share was stopped: the capture is then released below, never re-attached).
            let reverted = false;
            if (track.mediaStreamTrack === gen && gen.readyState === 'live' && raw.readyState === 'live') {
                try { await track.replaceTrack(raw, true); reverted = true; } catch { /* fall through: release it */ }
            }
            pipe!.stop();
            try { gen.stop(); } catch { /* gone */ }
            // The capture is ours to release unless it is back on the sender.
            if (!reverted) { try { raw.stop(); } catch { /* ended */ } }
        },
    };
}

/** Kill switch (read-only here; set 'off' from the console to disable). */
export function keepAliveDisabled(read: (k: string) => string | null): boolean {
    try { return read('cipherline_share_keepalive') === 'off'; } catch { return false; }
}
