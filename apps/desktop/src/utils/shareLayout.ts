/**
 * Ultra-wide displays: telling them apart, and slicing one into its monitors.
 *
 * NVIDIA Surround / AMD Eyefinity present several monitors as ONE display (the
 * owner's three 2560x1440 racing-sim screens are a single 7680x1440 one). A
 * share of that display is a 5.3:1 sliver: scaled to fit an encoder it is
 * 3840x720, unreadable to anyone watching. So when the display is wide enough
 * the picker offers a choice:
 *   - "Whole display (scaled)" - the entire thing, downscaled to what the
 *     encoder takes (shareEncoderLimits.ts): 7680x1440 -> 3840x720;
 *   - one screen of it, cropped at native resolution: 2560x1440 (the crop is
 *     done on decoded frames before encoding - shareCrop.ts).
 *
 * Pure. The picker, the crop worker and the tests all use these.
 */

/** Wider than this (width / height) is "ultra-wide". 21:9 is 2.33 and 2.37 (cinema), so it is not. */
export const ULTRAWIDE_ASPECT = 2.4;
/** Aspect from which the default is a single-screen crop rather than the whole display. */
export const MULTI_SCREEN_DEFAULT_ASPECT = 4.5;
const MAX_SLICES = 5;

export type ShareLayout =
    | { kind: 'whole' }
    | { kind: 'slice'; count: number; index: number };

export const WHOLE_LAYOUT: ShareLayout = Object.freeze({ kind: 'whole' }) as ShareLayout;

const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

export function aspectOf(width: number | undefined, height: number | undefined): number | null {
    return fin(width) && fin(height) ? width / height : null;
}

/** Is a display of this aspect ultra-wide (> 2.4)? Unknown -> false. */
export function isUltrawide(aspect: number | null | undefined): boolean {
    return fin(aspect) && aspect > ULTRAWIDE_ASPECT;
}

/**
 * Per-screen aspects a surround group is built from: 16:9, and the "21:9"
 * panels - which are really 64:27 (2560x1080), 7:3 (the nominal 21:9) and 43:18
 * (3440x1440). Without the real ratios three 3440x1440 panels (7.17) would read
 * as four 16:9 ones.
 */
const SCREEN_ASPECTS = [16 / 9, 64 / 27, 21 / 9, 43 / 18];
/**
 * Two groupings can describe the same display (four 16:9 screens are also
 * three 64:27 ones: 10240x1440 vs 3 x 3413x1440). 16:9 is by far the commoner
 * panel, so a "21:9" explanation has to beat it by more than this to win.
 */
const WIDE_PANEL_PENALTY = 0.005;

/**
 * How many monitors an ultra-wide display of this aspect is made of: the
 * integer n in 2..5 whose per-screen aspect (aspect / n) is closest, in log
 * terms, to 16:9 or 21:9. 7680x1440 (5.33) -> 3, 5120x1440 (3.56) -> 2,
 * 7680x2160 (3.56, two 4K) -> 2, 3x 21:9 (7.0) -> 3. Not ultra-wide -> 1.
 */
export function inferSliceCount(aspect: number | null | undefined): number {
    if (!isUltrawide(aspect)) return 1;
    const a = aspect as number;
    let best = 2;
    let bestErr = Infinity;
    for (let n = 2; n <= MAX_SLICES; n++) {
        for (const r of SCREEN_ASPECTS) {
            const err = Math.abs(Math.log(a / n / r)) + (r === SCREEN_ASPECTS[0] ? 0 : WIDE_PANEL_PENALTY);
            if (err < bestErr - 1e-9) { bestErr = err; best = n; }
        }
    }
    return best;
}

/** Index of the "middle" screen of `count`: 3 -> 1 (Center), 2 -> 0, 4 -> 1, 5 -> 2. */
export function centerIndex(count: number): number {
    return Math.max(0, Math.floor((count - 1) / 2));
}

/**
 * The layout a display of this aspect starts on. Three or more screens
 * (aspect >= 4.5): the Center screen - that is where a racing sim or any
 * surround game puts the action. Two screens, or anything merely wide: the
 * whole display, scaled (a half of a two-screen desk is the less useful default).
 */
export function defaultLayoutFor(aspect: number | null | undefined): ShareLayout {
    if (!isUltrawide(aspect)) return WHOLE_LAYOUT;
    const count = inferSliceCount(aspect);
    if (count >= 3 && (aspect as number) >= MULTI_SCREEN_DEFAULT_ASPECT) {
        return { kind: 'slice', count, index: centerIndex(count) };
    }
    return WHOLE_LAYOUT;
}

/** "Left" / "Center" / "Right" for 3; "Left" / "Right" for 2; "Screen N" otherwise. */
export function sliceLabel(count: number, index: number): string {
    if (count === 2) return index === 0 ? 'Left screen' : 'Right screen';
    if (count === 3) return ['Left screen', 'Center screen', 'Right screen'][index] ?? `Screen ${index + 1}`;
    return `Screen ${index + 1}`;
}

export function layoutLabel(layout: ShareLayout): string {
    return layout.kind === 'whole' ? 'Whole display (scaled)' : sliceLabel(layout.count, layout.index);
}

/** Every choice the picker offers for a display of this aspect (empty = not ultra-wide: no choice to make). */
export function layoutChoices(aspect: number | null | undefined): Array<{ layout: ShareLayout; label: string }> {
    if (!isUltrawide(aspect)) return [];
    const count = inferSliceCount(aspect);
    const out: Array<{ layout: ShareLayout; label: string }> = [
        { layout: WHOLE_LAYOUT, label: layoutLabel(WHOLE_LAYOUT) },
    ];
    for (let i = 0; i < count; i++) {
        const layout: ShareLayout = { kind: 'slice', count, index: i };
        out.push({ layout, label: layoutLabel(layout) });
    }
    return out;
}

export function layoutsEqual(a: ShareLayout | undefined, b: ShareLayout | undefined): boolean {
    if (!a || !b) return !a && !b;
    if (a.kind === 'whole' || b.kind === 'whole') return a.kind === b.kind;
    return a.count === b.count && a.index === b.index;
}

/** Validates an untrusted layout (a message to the crop worker, a stored value). */
export function parseLayout(v: unknown): ShareLayout | null {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    if (o.kind === 'whole') return WHOLE_LAYOUT;
    if (o.kind === 'slice' && Number.isInteger(o.count) && Number.isInteger(o.index)) {
        const count = o.count as number;
        const index = o.index as number;
        if (count >= 2 && count <= MAX_SLICES && index >= 0 && index < count) return { kind: 'slice', count, index };
    }
    return null;
}

export interface CropRect { x: number; y: number; width: number; height: number }

const evenRound = (n: number) => Math.round(n / 2) * 2;

/**
 * The source rectangle of screen `index` of `count` in a frame of
 * `frameWidth` x `frameHeight`. Edges are rounded to even coordinates (4:2:0
 * video frames cannot be cropped at an odd offset) and adjacent slices share
 * their boundary, so together they tile the frame with no gap or overlap.
 * 7680x1440 / 3 -> x 0, 2560, 5120, each 2560 wide, full height.
 * Out-of-range input is clamped to a valid slice rather than thrown.
 */
export function sliceRect(frameWidth: number, frameHeight: number, count: number, index: number): CropRect {
    const w = Math.max(2, Math.floor(frameWidth));
    const h = Math.max(2, Math.floor(frameHeight) - (Math.floor(frameHeight) % 2));
    const n = Math.min(Math.max(1, Math.floor(count)), MAX_SLICES);
    const i = Math.min(Math.max(0, Math.floor(index)), n - 1);
    const x0 = i === 0 ? 0 : evenRound((i * w) / n);
    const x1 = i === n - 1 ? w - (w % 2) : evenRound(((i + 1) * w) / n);
    return { x: x0, y: 0, width: Math.max(2, x1 - x0), height: h };
}
