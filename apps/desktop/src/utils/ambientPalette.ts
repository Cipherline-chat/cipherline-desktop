/**
 * Ambient motes in every theme — how the decorative "sea" particles are tinted
 * for the active theme.
 *
 * The ambient layer (Settings' water column, components/settings/SeaBackdrop.tsx;
 * Server Settings' dock, components/server/DockBackdrop.tsx; the home deck's
 * rising motes, styles/home-deck.css; December's marine snow, index.css) was
 * drawn in Dark's teal and amber literals. Light then hid the Settings canvas
 * outright ("Light has no night sea") and every other theme drew Dark's teal
 * over its own colours. This module is the one place that decides the look per
 * theme, from the theme's own resolved colours (theme.palette, the same values
 * themeColor() returns), so a custom theme's motes follow its accent.
 *
 *   Dark (the built-in)   glow    lume + an occasional warm (glow) mote: EXACTLY
 *                                 today's draw calls (ambientPalette.test.ts).
 *   Custom, dark base     glow    the theme's accent (lume) + warm, as Dark.
 *   Midnight              glow    dim: 60% alpha, 70% of the motes, no warm one
 *                                 (a glow on pure black reads cheap).
 *   Light-scheme themes   bubble  soft bubbles: a pale accent fill with a thin
 *   (Light, custom light)         rim in the accent's UI shade (`lume-ui`, >= 3:1
 *                                 on the page), slightly larger, no warm one
 *                                 (amber on cream reads as dirt).
 *   High contrast         quiet   half the motes, neutral grey (`faint`), low
 *                                 alpha, no warm one. Motion stays (it is the
 *                                 user's Motion setting that decides motion,
 *                                 not the theme); the particles are kept so
 *                                 faint that body and secondary text stay at
 *                                 >= 7:1 even with a mote right behind them
 *                                 (ambientPalette.test.ts checks the worst case).
 *
 * Contrast cap (every theme except built-in Dark, which stays exactly as it
 * was): a mote can sit right behind a line of text, so its strongest pixel may
 * never pull the theme's body or secondary text below 4.5:1 (7:1 in high
 * contrast) on the page or panel colour. The look's alpha is lowered until
 * that holds (contrastCap), which matters for custom themes, whose accent can
 * be anything (a near-white accent on a near-black page would otherwise drop
 * secondary text to ~3.8:1). Built-in themes never hit the cap.
 *
 * Canvas consumers read the palette from useTheme() into a ref every render,
 * so a theme switch retints the motes on the next frame without restarting the
 * field. Motion itself is gated elsewhere (hooks/useAmbientMotion.ts
 * useAmbientActive: Reduce motion, Celebrations and effects, Home ambience).
 */
import { rgbaOf } from '../theme/engine';
import { contrastRatio } from '../theme/contrast';
import type { Theme } from '../theme/themes';

export type AmbientKind = 'glow' | 'bubble' | 'quiet';

export interface AmbientPalette {
    kind: AmbientKind;
    /** The mote colour (a resolved hex): the dot, or a bubble's fill. */
    mote: string;
    /** A bubble's rim (resolved hex); null = a filled dot. */
    rim: string | null;
    /** The occasional warm mote (resolved hex); null = none in this theme. */
    warm: string | null;
    /** Multiplier on every mote's own alpha. */
    alpha: number;
    /** Multiplier on mote counts. */
    density: number;
    /** Multiplier on mote radius. */
    size: number;
}

/** A bubble's fill alpha, as a fraction of its rim's. */
export const BUBBLE_FILL = 0.35;

/** The strongest alpha any canvas mote is drawn at before the palette's multiplier (SeaBackdrop: .05 + .22). */
export const CANVAS_MOTE_MAX_ALPHA = 0.27;

type ThemeSlice = Pick<Theme, 'id' | 'scheme' | 'contrast' | 'customId' | 'palette'>;

function lookFor(theme: ThemeSlice): AmbientPalette {
    const p = theme.palette;
    if (theme.contrast === 'high') {
        return { kind: 'quiet', mote: p.faint, rim: null, warm: null, alpha: 0.5, density: 0.5, size: 1 };
    }
    if (theme.scheme === 'light') {
        return { kind: 'bubble', mote: p.lume, rim: p['lume-ui'], warm: null, alpha: 1.1, density: 1, size: 2 };
    }
    if (theme.id === 'midnight' && !theme.customId) {
        return { kind: 'glow', mote: p.lume, rim: null, warm: null, alpha: 0.6, density: 0.7, size: 1 };
    }
    // Dark, and custom themes on the dark base: Dark's look in the theme's own accent.
    return { kind: 'glow', mote: p.lume, rim: null, warm: p.glow, alpha: 1, density: 1, size: 1 };
}

/** `fg` at `alpha` over the opaque `bg`, composited in sRGB as the browser does (both resolved hexes). */
export function compositeOver(fg: string, alpha: number, bg: string): string {
    const f = parseInt(fg.slice(1), 16); const b = parseInt(bg.slice(1), 16);
    let out = '#';
    for (const sh of [16, 8, 0]) {
        const c = Math.round(((f >> sh) & 255) * alpha + ((b >> sh) & 255) * (1 - alpha));
        out += c.toString(16).padStart(2, '0');
    }
    return out;
}

/** Every [colour, alpha] a mote of this look paints at its strongest. */
export function strongestPixels(pal: AmbientPalette, baseMax = CANVAS_MOTE_MAX_ALPHA): [string, number][] {
    const a = Math.min(1, baseMax * pal.alpha);
    const out: [string, number][] = [[pal.rim ?? pal.mote, a]];
    if (pal.rim) out.push([pal.mote, a * BUBBLE_FILL]);
    if (pal.warm) out.push([pal.warm, a]);
    return out;
}

/** True when no mote pixel pulls text / muted below `floor` on the page or panel (where the theme clears it). */
export function motesKeepContrast(theme: ThemeSlice, pal: AmbientPalette, baseMax = CANVAS_MOTE_MAX_ALPHA): boolean {
    const p = theme.palette;
    const floor = theme.contrast === 'high' ? 7 : 4.5;
    for (const g of [p.abyss, p.deep]) {
        for (const [c, a] of strongestPixels(pal, baseMax)) {
            const bg = compositeOver(c, a, g);
            for (const ink of [p.text, p.muted]) {
                if (contrastRatio(ink, g) < floor) continue; // the theme itself, not a mote
                if (contrastRatio(ink, bg) < floor) return false;
            }
        }
    }
    return true;
}

/** The look with its alpha lowered (never raised) until motesKeepContrast holds. */
function contrastCap(theme: ThemeSlice, pal: AmbientPalette): AmbientPalette {
    if (motesKeepContrast(theme, pal)) return pal;
    let lo = 0; let hi = pal.alpha;
    for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        if (motesKeepContrast(theme, { ...pal, alpha: mid })) lo = mid; else hi = mid;
    }
    return { ...pal, alpha: lo };
}

const cache = new WeakMap<object, AmbientPalette>();

export function ambientPaletteFor(theme: ThemeSlice): AmbientPalette {
    const hit = cache.get(theme.palette);
    if (hit) return hit;
    const look = lookFor(theme);
    // Built-in Dark: exactly the pre-theme field, by mandate (its teal motes
    // already dip secondary text on a panel to ~4.4:1 under a 1-3 px mote).
    const pal = theme.id === 'dark' && !theme.customId ? look : contrastCap(theme, look);
    cache.set(theme.palette, pal);
    return pal;
}

/** How many motes a field of `base` gets in this palette (Dark: exactly `base`). */
export function ambientCount(pal: AmbientPalette, base: number): number {
    return pal.density === 1 ? base : Math.max(1, Math.round(base * pal.density));
}

/**
 * Draw one mote. In Dark this is byte-for-byte the call sequence the canvases
 * made before themes (beginPath, arc, fillStyle = rgba of lume / glow at `a`,
 * fill): `a * 1` and `r * 1` are exact, and rgbaOf writes the alpha unrounded.
 */
export function drawMote(
    cx: CanvasRenderingContext2D, pal: AmbientPalette,
    x: number, y: number, r: number, a: number, warm: boolean,
): void {
    cx.beginPath();
    cx.arc(x, y, r * pal.size, 0, 7);
    if (pal.rim) {
        cx.fillStyle = rgbaOf(pal.mote, a * pal.alpha * BUBBLE_FILL);
        cx.fill();
        cx.lineWidth = 1;
        cx.strokeStyle = rgbaOf(pal.rim, a * pal.alpha);
        cx.stroke();
        return;
    }
    cx.fillStyle = rgbaOf(warm && pal.warm ? pal.warm : pal.mote, a * pal.alpha);
    cx.fill();
}
