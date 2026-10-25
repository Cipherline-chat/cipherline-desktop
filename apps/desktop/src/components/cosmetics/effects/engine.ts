
import type { ItemOptions } from '../../../utils/profileCosmetics';
import { shade, type HSL } from '../colour';

/**
 * The profile-effect runtime (types, sprites; the loop is EffectCanvas.tsx):
 * ONE <canvas> per card, one frame loop.
 *
 * Policy (owner, 2026-10-24): an effect animates continuously while the app
 * is focused and visible, and pauses (stops requesting frames) when the window
 * is blurred or hidden (`<html data-cl-motion="idle">`, utils/idleMotion.ts),
 * when the card is scrolled out of view, or when the tab is hidden. Under
 * prefers-reduced-motion it draws ONE still frame and never loops. Every
 * program is a continuous simulation or a function of time built from smooth
 * noise, so it never "plays once and settles" and never shows a seam.
 *
 * Cost: programs draw in CSS pixels; soft, volumetric programs (aurora, god
 * rays) render into a small offscreen canvas (`lowRes`) that is upscaled with
 * smoothing, which is both cheaper and softer. `fps` caps slow programs.
 */

export interface FxEnv {
    /** Card size in CSS px. */
    w: number;
    h: number;
    /** The avatar's centre and radius in card px (effects radiate from it). */
    avatar: { x: number; y: number; r: number };
    /** The banner's height (sky effects live there). */
    banner: number;
    /** The effect's colour (hue option > theme tint > stock). */
    tint: HSL;
    opts: ItemOptions;
    /** keepsake-rain's image, when this device holds it; null = fallback particles. */
    image: CanvasImageSource | null;
    /** The image is the avatar (drawn round) rather than an emoji. */
    imageRound: boolean;
}

export interface FxProgram<S = unknown> {
    /** The stock colour when there is no hue option / theme tint. */
    stock: string;
    /** Frame-rate cap (slow, soft programs run at 30). */
    fps?: number;
    /** Render scale for soft programs (e.g. 0.35). */
    lowRes?: number;
    /** Softening applied to the visible lowRes canvas by the compositor (CSS px; free per frame). */
    cssBlur?: number;
    /** Gaussian softening applied to the lowRes frame (in lowRes px; cheap at that size). */
    blur?: number;
    /** Composite onto the card with `screen` (light) - the default - or plainly. */
    blend?: 'screen' | 'normal';
    /** Seconds of simulation to run before the first frame (so particles are spread). */
    preroll?: number;
    init(env: FxEnv, rand: () => number): S;
    frame(g: CanvasRenderingContext2D, s: S, t: number, dt: number, env: FxEnv): void;
    /** A full-resolution pass drawn over a `lowRes` frame (crisp particles in soft light). */
    after?(g: CanvasRenderingContext2D, s: S, t: number, dt: number, env: FxEnv): void;
}

/** Option level (1-3) -> a multiplier. */
export const lvl = (v: number | undefined, a: number, b: number, c: number): number => (v === 1 ? a : v === 3 ? c : b);

// ── sprites (cached) ─────────────────────────────────────────────────────────

const spriteCache = new Map<string, HTMLCanvasElement>();
const makeCanvas = (w: number, h: number): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
};
function cached(key: string, build: () => HTMLCanvasElement): HTMLCanvasElement {
    let c = spriteCache.get(key);
    if (!c) {
        if (spriteCache.size > 96) spriteCache.clear();
        c = build();
        spriteCache.set(key, c);
    }
    return c;
}

/** A soft round glow (core + falloff), `size` px across, drawn at alpha 1. */
export function glowSprite(c: HSL, size = 32, core = 0.18, hot = 30): HTMLCanvasElement {
    return cached(`g|${c.h.toFixed(0)}|${c.s.toFixed(0)}|${c.l.toFixed(0)}|${size}|${core}|${hot}`, () => {
        const cv = makeCanvas(size, size);
        const g = cv.getContext('2d')!;
        const r = size / 2;
        const grad = g.createRadialGradient(r, r, 0, r, r, r);
        grad.addColorStop(0, shade(c, hot, 1, -20));
        grad.addColorStop(core, shade(c, 8, 0.85));
        grad.addColorStop(Math.min(0.95, core * 2.6), shade(c, 0, 0.22));
        grad.addColorStop(1, shade(c, 0, 0));
        g.fillStyle = grad;
        g.fillRect(0, 0, size, size);
        return cv;
    });
}

/** A sprite drawn once by `draw` into a `w` x `h` canvas, cached under `key`. */
export function sprite(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement {
    return cached(`s|${key}`, () => {
        const cv = makeCanvas(w, h);
        draw(cv.getContext('2d')!);
        return cv;
    });
}

