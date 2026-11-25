/**
 * A real frame of a video, as a link preview's picture (2026-11-24,
 * embeds-always-thumb). Runs on the SENDER only.
 *
 * Owner: "sent a medal clip and it has no thumbnail. everything should always
 * have a thumbnail". Medal's og:image is the clip's FIRST frame, so every clip
 * that fades in from black (measured: 2 of 21 live clips, 331-byte all-black
 * AVIFs) sent a black picture. A direct .mp4, a Giphy / Imgur loop and a post
 * whose provider gave no poster had no picture at all.
 *
 * How:
 *   - main registers the file the sender's own unfurler found
 *     (embed:register-thumb-media: the same host rules as playing it, a FRESH
 *     clmedia:// entry with a byte budget), so the grab streams through the
 *     same pinned, SSRF-checked, cookie-less, Range-based path as playback;
 *   - a muted, detached `<video crossOrigin="anonymous">` (never in the DOM,
 *     never played) loads its metadata, then SEEKS to a few moments: ~1 s and
 *     10 % of the way in, and 25 % only when both of those are near-black /
 *     flat. Each seek fetches only the bytes around that moment (Range);
 *   - each frame is drawn to a small canvas and scored (detail, exposure:
 *     thumb.ts pictureScore); the best one is re-encoded to a fresh WebP like
 *     every other thumbnail (thumb.ts encodeWebpThumb);
 *   - bounded: FRAME_GRAB_TIMEOUT_MS overall, SEEK_TIMEOUT_MS per seek, main's
 *     byte budget per grab, and the element is emptied afterwards (src
 *     removed, load()) so nothing keeps streaming.
 *
 * The frame's video size and duration come back too: they go into the
 * embed's `media` so readers can size the card to the real shape.
 *
 * clmedia:// answers CORS for the app's own renderer origin only (main.ts,
 * media-protocol.ts allowOrigin), which is what keeps this canvas untainted.
 * Nothing here is sent anywhere but into the sender's own message.
 */
import { THUMB_MAX_EDGE, encodeWebpThumb, isFlatPicture, pictureScore, statsOf, makeCanvas, fitSize, type EncodedThumb, type Canvas } from './thumb';

export const FRAME_GRAB_TIMEOUT_MS = 9_000;
export const SEEK_TIMEOUT_MS = 4_000;

export interface FrameGrab {
    thumb: EncodedThumb;
    /** The video's own size and length (from its metadata). */
    width: number;
    height: number;
    durationS?: number;
    /** Where the chosen frame is (seconds). */
    atS: number;
    /** How many moments were sampled. */
    samples: number;
}

/**
 * The moments to sample, in order: ~1 s, 10 % of the way in, then 25 %
 * (only used when the first two are poor). Never at 0 (a fade-in's black),
 * never past the end, at least 0.25 s apart.
 */
export function sampleTimes(durationS: number | undefined): number[] {
    const d = typeof durationS === 'number' && Number.isFinite(durationS) && durationS > 0 ? durationS : undefined;
    const cap = (t: number) => (d ? Math.min(t, Math.max(0.05, d - 0.1)) : t);
    const raw = d ? [Math.min(1, d * 0.5), d * 0.1, d * 0.25] : [1, 2, 3];
    const out: number[] = [];
    for (const t of raw.map(cap)) {
        const v = Math.round(Math.max(0.05, t) * 1000) / 1000;
        if (out.every((o) => Math.abs(o - v) >= 0.25)) out.push(v);
    }
    return out;
}

/** The subset of HTMLVideoElement used here (a test can hand in a fake). */
export type GrabVideo = Pick<HTMLVideoElement,
    'muted' | 'playsInline' | 'preload' | 'crossOrigin' | 'src' | 'currentTime' | 'duration' | 'videoWidth' | 'videoHeight' | 'readyState'
    | 'addEventListener' | 'removeEventListener' | 'removeAttribute' | 'load'> & { defaultMuted?: boolean };

export interface FrameGrabDeps {
    makeVideo?: () => GrabVideo;
    /** Test seam: the stats of the current frame (default: thumb.ts statsOf). */
    stats?: (v: GrabVideo) => { mean: number; std: number } | null;
    /** Test seam: the frame → WebP (default: draw onto a canvas, thumb.ts encodeWebpThumb). */
    encode?: (frame: Canvas, w: number, h: number) => Promise<EncodedThumb | null>;
    /** Test seam: a copy of the current frame (default: drawn onto a canvas at THUMB_MAX_EDGE). */
    copy?: (v: GrabVideo, w: number, h: number) => Canvas | null;
    timeoutMs?: number;
    seekTimeoutMs?: number;
    signal?: AbortSignal;
}

class Aborted extends Error {}

function once(v: GrabVideo, ok: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const done = (fn: () => void) => () => {
            clearTimeout(t);
            v.removeEventListener(ok, onOk);
            v.removeEventListener('error', onErr);
            signal?.removeEventListener('abort', onAbort);
            fn();
        };
        const onOk = done(resolve);
        const onErr = done(() => reject(new Error('media error')));
        const onAbort = done(() => reject(new Aborted('aborted')));
        const t = setTimeout(done(() => reject(new Error(`timeout waiting for ${ok}`))), timeoutMs);
        v.addEventListener(ok, onOk);
        v.addEventListener('error', onErr);
        signal?.addEventListener('abort', onAbort);
        if (signal?.aborted) onAbort();
    });
}

function defaultVideo(): GrabVideo {
    return document.createElement('video');
}

function defaultCopy(v: GrabVideo, w: number, h: number): Canvas | null {
    const { width, height } = fitSize(w, h, 1, THUMB_MAX_EDGE);
    const c = makeCanvas(width, height);
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(v as unknown as CanvasImageSource, 0, 0, width, height);
    return c;
}

/**
 * The best of a few frames of the video at `src` (a clmedia:// URL from main),
 * or null (no metadata, every seek failed, a tainted canvas, all frames flat,
 * aborted, out of time). Never throws.
 */
export async function grabFrame(src: string, deps: FrameGrabDeps = {}): Promise<FrameGrab | null> {
    const v = (deps.makeVideo ?? defaultVideo)();
    const stats = deps.stats ?? ((x: GrabVideo) => statsOf(x as unknown as CanvasImageSource));
    const copy = deps.copy ?? defaultCopy;
    const encode = deps.encode ?? ((c: Canvas, w: number, h: number) => encodeWebpThumb(c as unknown as CanvasImageSource, w, h));
    const seekMs = deps.seekTimeoutMs ?? SEEK_TIMEOUT_MS;
    const deadline = Date.now() + (deps.timeoutMs ?? FRAME_GRAB_TIMEOUT_MS);
    const left = () => Math.max(1, Math.min(seekMs, deadline - Date.now()));
    try {
        v.muted = true;
        v.defaultMuted = true;
        v.playsInline = true;
        v.preload = 'metadata';
        v.crossOrigin = 'anonymous';
        const meta = once(v, 'loadedmetadata', left(), deps.signal);
        v.src = src;
        await meta;
        const w = v.videoWidth;
        const h = v.videoHeight;
        if (!w || !h) return null;
        const durationS = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : undefined;
        const times = sampleTimes(durationS);
        let best: { score: number; at: number; frame: Canvas; stats: { mean: number; std: number } } | null = null;
        let samples = 0;
        for (let i = 0; i < times.length; i++) {
            // The third moment only when the first two were both poor.
            if (i >= 2 && best && !isFlatPicture(best.stats)) break;
            if (Date.now() >= deadline) break;
            const at = times[i];
            try {
                const seeked = once(v, 'seeked', left(), deps.signal);
                v.currentTime = at;
                await seeked;
            } catch (e) {
                if (e instanceof Aborted) return null;
                continue;
            }
            samples++;
            const s = stats(v);
            if (!s) continue; // unreadable (tainted): try no further frame of this one
            const score = pictureScore(s);
            if (!best || score > best.score) {
                const frame = copy(v, w, h);
                if (frame) best = { score, at, frame, stats: s };
            }
        }
        if (!best || isFlatPicture(best.stats)) return null;
        const thumb = await encode(best.frame, best.frame.width, best.frame.height);
        if (!thumb) return null;
        return { thumb, width: w, height: h, ...(durationS ? { durationS: Math.round(durationS * 100) / 100 } : {}), atS: best.at, samples };
    } catch {
        return null;
    } finally {
        // Stop the element streaming anything more.
        try { v.removeAttribute('src'); v.load(); } catch { /* detached already */ }
    }
}
