/**
 * Viewer side of a screen share, as numbers: how many frames arrived, how many
 * the decoder produced, how many it dropped, how many the tile actually
 * presented - so "the 90 fps share looked like 70 fps" can be located at the
 * stage that lost the frames. Pure readers and delta maths over RTCStatsReport
 * snapshots (CallEventMonitor owns the clock and the report - this module
 * never calls getStats itself, so there is no second stats loop).
 *
 *   rx_fps    inbound-rtp framesReceived delta / s   (assembled frames off the wire)
 *   dec_fps   framesDecoded delta / s                (what the decoder finished)
 *   drop_fps  framesDropped delta / s                (decoder / pipeline drops)
 *   disp_fps  presented frames of the tile's <video> (getVideoPlaybackQuality:
 *             totalVideoFrames - droppedVideoFrames, delta / s)
 *   jb_ms     mean jitter-buffer delay of the frames emitted in the window
 *             (jitterBufferDelay / jitterBufferEmittedCount deltas)
 *   decoder   decoderImplementation, hw = powerEfficientDecoder (start event)
 *
 * Counter resets: a stream that restarts (SFU layer switch to a new SSRC, a
 * republish) restarts every counter from 0. Any counter going BACKWARDS makes
 * the whole window unusable (null) - the caller re-baselines on `cur`; a rate
 * is never computed from a negative delta, and never reported as 0 for it.
 *
 * Privacy: counters, rates and a decoder implementation name (a code
 * identifier like "ExternalDecoder"). No addresses, SSRCs, ids or names.
 */

type Stat = Record<string, unknown>;
export type StatsLike = { forEach(cb: (s: Stat) => void): void };
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const r1 = (n: number) => Math.round(n * 10) / 10;

export interface ShareRxSnapshot {
    /** Stats timestamp (ms, monotonic-ish); the caller's clock if the report has none. */
    at: number;
    framesReceived: number;
    framesDecoded: number;
    framesDropped: number;
    /** Cumulative seconds frames spent in the jitter buffer / how many were emitted. */
    jbDelay: number;
    jbEmitted: number;
    /** keyFramesDecoded, and keyframe requests this receiver SENT (PLI + FIR). Cumulative. */
    keyFrames?: number;
    kfRequests?: number;
    width?: number;
    height?: number;
    decoder?: string;
    hw?: boolean;
    /** Lower-case codec name from the codec stat's mimeType (h264, vp8, vp9, av1, h265). */
    codec?: string;
}

const CODEC_NAMES: Record<string, string> = { h264: 'h264', vp8: 'vp8', vp9: 'vp9', av1: 'av1', h265: 'h265', hevc: 'h265' };

/** `video/H264` -> `h264`; anything unrecognised -> undefined (never free text). */
export function codecFromMime(mime: unknown): string | undefined {
    if (typeof mime !== 'string') return undefined;
    const sub = mime.split('/')[1]?.toLowerCase();
    return sub ? CODEC_NAMES[sub] : undefined;
}

/** The snapshot of the (single) video inbound-rtp in a track's report. null = none yet. */
export function readShareRxSnapshot(report: StatsLike | null | undefined, fallbackAt: number): ShareRxSnapshot | null {
    if (!report) return null;
    let inbound: Stat | undefined;
    const codecs = new Map<string, Stat>();
    report.forEach(s => {
        if (!s || typeof s !== 'object') return;
        if (s.type === 'inbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) inbound = s;
        else if (s.type === 'codec' && typeof s.id === 'string') codecs.set(s.id, s);
    });
    if (!inbound) return null;
    const s: Stat = inbound;
    const n = (k: string) => (fin(s[k]) ? s[k] as number : 0);
    const snap: ShareRxSnapshot = {
        at: fin(s.timestamp) ? s.timestamp : fallbackAt,
        framesReceived: n('framesReceived'),
        framesDecoded: n('framesDecoded'),
        framesDropped: n('framesDropped'),
        jbDelay: n('jitterBufferDelay'),
        jbEmitted: n('jitterBufferEmittedCount'),
        keyFrames: n('keyFramesDecoded'),
        kfRequests: n('pliCount') + n('firCount'),
    };
    if (fin(s.frameWidth) && fin(s.frameHeight) && s.frameWidth > 0 && s.frameHeight > 0) { snap.width = s.frameWidth; snap.height = s.frameHeight; }
    if (typeof s.decoderImplementation === 'string' && s.decoderImplementation) snap.decoder = s.decoderImplementation.slice(0, 64);
    if (typeof s.powerEfficientDecoder === 'boolean') snap.hw = s.powerEfficientDecoder;
    const codec = typeof s.codecId === 'string' ? codecFromMime(codecs.get(s.codecId)?.mimeType) : undefined;
    if (codec) snap.codec = codec;
    return snap;
}

/** True when any cumulative counter went backwards: a new stream, not a rate. */
export function rxCountersReset(prev: ShareRxSnapshot, cur: ShareRxSnapshot): boolean {
    return cur.framesReceived < prev.framesReceived || cur.framesDecoded < prev.framesDecoded
        || cur.framesDropped < prev.framesDropped || cur.jbEmitted < prev.jbEmitted || cur.jbDelay < prev.jbDelay;
}

export interface ShareRxRates { rx_fps: number; dec_fps: number; drop_fps: number; jb_ms?: number }

/** Rates between two snapshots; null when the window is too short, runs backwards or a counter reset. */
export function shareRxRates(prev: ShareRxSnapshot, cur: ShareRxSnapshot): ShareRxRates | null {
    const dt = (cur.at - prev.at) / 1000;
    if (!(dt >= 0.5) || rxCountersReset(prev, cur)) return null;
    const out: ShareRxRates = {
        rx_fps: r1((cur.framesReceived - prev.framesReceived) / dt),
        dec_fps: r1((cur.framesDecoded - prev.framesDecoded) / dt),
        drop_fps: r1((cur.framesDropped - prev.framesDropped) / dt),
    };
    const emitted = cur.jbEmitted - prev.jbEmitted;
    if (emitted > 0) out.jb_ms = r1(((cur.jbDelay - prev.jbDelay) / emitted) * 1000);
    return out;
}

// ── the tile's <video>: frames it presented ────────────────────────────────

export interface VideoPlaybackSnapshot { at: number; total: number; dropped: number }

/** From HTMLVideoElement.getVideoPlaybackQuality(); null when the element can't say. */
export function readPlaybackSnapshot(el: { getVideoPlaybackQuality?: () => { totalVideoFrames: number; droppedVideoFrames: number } } | null | undefined, at: number): VideoPlaybackSnapshot | null {
    try {
        const q = el?.getVideoPlaybackQuality?.();
        if (!q || !fin(q.totalVideoFrames) || !fin(q.droppedVideoFrames)) return null;
        return { at, total: q.totalVideoFrames, dropped: q.droppedVideoFrames };
    } catch {
        return null;
    }
}

/** The few things of an HTMLVideoElement the picker reads (so it can be tested without a DOM). */
export interface VideoElLike {
    clientWidth: number;
    clientHeight: number;
    isConnected?: boolean;
    paused?: boolean;
    checkVisibility?: (o?: { checkOpacity?: boolean; checkVisibilityCSS?: boolean }) => boolean;
    getBoundingClientRect?: () => { left: number; top: number; right: number; bottom: number };
}

const areaOf = (e: VideoElLike) => Math.max(0, e.clientWidth) * Math.max(0, e.clientHeight);

/** Is this element something a person could be looking at right now (rendered, not hidden, on screen)? */
export function isPresenting(e: VideoElLike, viewport?: { width: number; height: number }): boolean {
    try {
        if (e.isConnected === false || e.paused === true || areaOf(e) <= 0) return false;
        if (e.checkVisibility && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) === false) return false;
        const r = e.getBoundingClientRect?.();
        if (r && viewport && (r.right <= 0 || r.bottom <= 0 || r.left >= viewport.width || r.top >= viewport.height)) return false;
        return true;
    } catch {
        return false;
    }
}

/**
 * Which of the <video> elements a share is attached to to read.
 *   largest    biggest rendered box - the tile's size (what layer to ask for);
 *   presenting biggest one that is actually being drawn - the one whose playback
 *              counters mean "frames shown". A share shown in a focus view AND a
 *              strip copy has two; the larger may be a hidden, off-screen or
 *              crossfaded one that presents nothing, and its zeros are not the
 *              display's. null = none is drawing: presented frames are UNKNOWN.
 */
export function pickShareVideoElements<T extends VideoElLike>(els: Iterable<T>, viewport?: { width: number; height: number }): { largest: T | null; presenting: T | null } {
    let largest: T | null = null;
    let presenting: T | null = null;
    for (const e of els) {
        if (!largest || areaOf(e) > areaOf(largest)) largest = e;
        if (isPresenting(e, viewport) && (!presenting || areaOf(e) > areaOf(presenting))) presenting = e;
    }
    return { largest, presenting };
}

/** Presented frames per second between two playback snapshots; undefined on a reset (a new element) or a short window. */
export function dispFpsBetween(prev: VideoPlaybackSnapshot | null | undefined, cur: VideoPlaybackSnapshot | null | undefined): number | undefined {
    if (!prev || !cur) return undefined;
    const dt = (cur.at - prev.at) / 1000;
    const total = cur.total - prev.total;
    const dropped = cur.dropped - prev.dropped;
    if (!(dt >= 0.5) || total < 0 || dropped < 0 || dropped > total) return undefined;
    return r1((total - dropped) / dt);
}

/**
 * Decoding fast while the tile "presented" nothing is not a measurement of the
 * display, it is a tile that was not drawing: Chromium counts every frame the
 * element was handed as dropped when its compositor is not asking for frames
 * (the element hidden, covered, in a window that is not being painted), so
 * presented = total - dropped reads exactly 0 (report 7d1f7abe: dec 90 fps,
 * disp_fps 0 in every report-time sample, 54-65 in the periodic rows before).
 * Logged as 0 it reads like "the display showed nothing"; the honest value is
 * "unknown", so the field is left out. A real 0 with a slow decode stays.
 */
export const DISP_ZERO_IMPLAUSIBLE_DEC_FPS = 5;

export function dispFpsPlausible(disp: number | undefined, decFps: number): disp is number {
    if (!fin(disp)) return false;
    return !(disp === 0 && decFps >= DISP_ZERO_IMPLAUSIBLE_DEC_FPS);
}

// ── event details ──────────────────────────────────────────────────────────

export type ShareDetail = Record<string, string | number | boolean>;

export interface ShareRxContext {
    shareRef?: string;
    /** Call-log placeholder (remote-video-N). */
    track?: string;
    dispFps?: number;
    /** Short side of the tile's rendered box, CSS px. */
    tile?: number;
    /** Layer/quality we are asking the SFU for (0 low, 1 medium, 2 high). */
    layer?: number;
    focus: boolean;
}

const sizeOf = (s: ShareRxSnapshot): string | undefined => (s.width && s.height ? `${s.width}x${s.height}` : undefined);

/**
 * The `share_rx_fps` detail (11 keys - the log keeps a 12th slot for `repeat`):
 * share_ref, track, rx_fps, dec_fps, drop_fps, disp_fps, jb_ms, res, layer, focus, tile.
 * Absent values are omitted. null = no usable window.
 */
export function buildShareRxDetail(prev: ShareRxSnapshot | null, cur: ShareRxSnapshot, ctx: ShareRxContext): ShareDetail | null {
    if (!prev) return null;
    const rates = shareRxRates(prev, cur);
    if (!rates) return null;
    const d: ShareDetail = {};
    if (ctx.shareRef) d.share_ref = ctx.shareRef;
    if (ctx.track) d.track = ctx.track;
    d.rx_fps = rates.rx_fps;
    d.dec_fps = rates.dec_fps;
    d.drop_fps = rates.drop_fps;
    if (dispFpsPlausible(ctx.dispFps, rates.dec_fps)) d.disp_fps = ctx.dispFps;
    if (fin(rates.jb_ms)) d.jb_ms = rates.jb_ms;
    const res = sizeOf(cur);
    if (res) d.res = res;
    if (fin(ctx.layer) && ctx.layer >= 0) d.layer = ctx.layer;
    d.focus = ctx.focus;
    if (fin(ctx.tile) && ctx.tile > 0) d.tile = Math.round(ctx.tile);
    return d;
}

/** The `share_rx_start` detail: what is decoding this share (logged when first known and when it changes). */
export function buildShareRxStartDetail(cur: ShareRxSnapshot, ctx: Pick<ShareRxContext, 'shareRef' | 'track' | 'layer'>): ShareDetail {
    const d: ShareDetail = {};
    if (ctx.shareRef) d.share_ref = ctx.shareRef;
    if (ctx.track) d.track = ctx.track;
    if (cur.codec) d.codec = cur.codec;
    if (cur.decoder) d.decoder = cur.decoder;
    if (typeof cur.hw === 'boolean') d.hw = cur.hw;
    const res = sizeOf(cur);
    if (res) d.res = res;
    if (fin(ctx.layer) && ctx.layer >= 0) d.layer = ctx.layer;
    return d;
}

/** Has what is decoding changed (or become known) since `last`? Key for share_rx_start. */
export function rxDecoderKey(s: ShareRxSnapshot): string | null {
    return s.decoder || s.codec ? `${s.codec ?? ''}|${s.decoder ?? ''}|${s.hw ?? ''}` : null;
}
