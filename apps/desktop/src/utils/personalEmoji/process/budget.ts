/**
 * Fitting an encoded emoji under its byte budget.
 *
 * The encoder callbacks are injected, so the search order - the part worth
 * testing - is separate from canvas/WebP code that only runs in a browser.
 *
 *   still:     quality steps at full size, then a smaller canvas.
 *   animation: quality steps, then fewer frames (the dropped time is folded
 *              into the kept frames, so playback length is preserved), then a
 *              smaller canvas. A short, bounded list of attempts: every attempt
 *              encodes every frame.
 */

export interface TimedFrame<F> { frame: F; durationMs: number }

/** Keep every k-th frame; the time of the dropped ones goes to the kept frame before them. */
export function decimateFrames<F>(frames: TimedFrame<F>[], k: number): TimedFrame<F>[] {
    if (k <= 1) return frames;
    const out: TimedFrame<F>[] = [];
    for (let i = 0; i < frames.length; i += k) {
        let d = 0;
        for (let j = i; j < Math.min(frames.length, i + k); j++) d += frames[j].durationMs;
        out.push({ frame: frames[i].frame, durationMs: d });
    }
    return out;
}

const STATIC_SIDES = [128, 112, 96, 80, 64];
const STATIC_QUALITIES = [0.92, 0.82, 0.7, 0.55];

/** Smallest-first search; returns the first encode <= `target`, else the smallest seen. */
export async function fitStatic(
    encode: (quality: number, side: number) => Promise<Uint8Array>,
    target: number,
    maxSide: number,
): Promise<{ bytes: Uint8Array; side: number; quality: number }> {
    let best: { bytes: Uint8Array; side: number; quality: number } | null = null;
    for (const side of STATIC_SIDES.filter(s => s <= maxSide).concat(maxSide < 64 ? [maxSide] : [])) {
        for (const quality of STATIC_QUALITIES) {
            const bytes = await encode(quality, side);
            if (!best || bytes.length < best.bytes.length) best = { bytes, side, quality };
            if (bytes.length <= target) return { bytes, side, quality };
        }
    }
    return best!;
}

/** [frame-decimation, quality, side-scale] in the order they are tried. */
const ANIMATED_ATTEMPTS: [number, number, number][] = [
    [1, 0.8, 1], [1, 0.62, 1], [1, 0.46, 1],
    [2, 0.62, 1], [2, 0.46, 1],
    [3, 0.46, 1],
    [2, 0.46, 0.75], [3, 0.4, 0.75],
    [4, 0.4, 0.625],
];

export interface AnimatedFit<F> {
    bytes: Uint8Array;
    frames: TimedFrame<F>[];
    keptFrames: number;
    side: number;
    quality: number;
}

/** First attempt that encodes to <= `cap` bytes, or null if none does. */
export async function fitAnimated<F>(
    frames: TimedFrame<F>[],
    encode: (frames: TimedFrame<F>[], quality: number, side: number) => Promise<Uint8Array>,
    cap: number,
    maxSide: number,
): Promise<AnimatedFit<F> | null> {
    for (const [k, quality, scale] of ANIMATED_ATTEMPTS) {
        const kept = decimateFrames(frames, k);
        const side = Math.max(32, Math.round(maxSide * scale));
        const bytes = await encode(kept, quality, side);
        if (bytes.length <= cap) return { bytes, frames: kept, keptFrames: kept.length, side, quality };
    }
    return null;
}
