/**
 * Pure helpers for the two call-personalization looks:
 *
 *  1. SPEAKING RING COLOUR. Every speaking indicator in the app draws its ring
 *     through `speakingShadow()`, which resolves the person's chosen colour
 *     (or the stock green) and guarantees it is readable on the dark UI. The
 *     list of surfaces is pinned by callRingSurfaces.test.ts: a new green
 *     literal in a speaking branch fails that test.
 *  2. PROFILE THEME TINT. A faint wash of the person's theme primary behind
 *     their camera-off tile and their voice-list row. Alpha is capped low, so
 *     the (light) name text keeps its contrast whatever colour was picked.
 *
 * No React, no I/O: unit-tested in callPersonalizationStyle.test.ts.
 */

/** The stock ring (Tailwind green-500) every client drew before this feature. */
export const DEFAULT_RING_COLOR = '#22c55e';

/**
 * Lowest WCAG relative luminance a ring may render at: about 3.6:1 against the
 * darkest surface (#0B0F1E), above the 3:1 non-text minimum. The API refuses
 * anything under RING_SERVER_MIN_LUMINANCE (a little lower, so a colour the
 * picker offers can never be refused); the drift test reads the API file.
 */
export const RING_MIN_LUMINANCE = 0.15;
export const RING_SERVER_MIN_LUMINANCE = 0.12;

export const RING_HEX = /^#[0-9a-f]{6}$/;

export interface RingPreset { id: string; label: string; hex: string }

/** Design-token presets (index.css / tailwind.config.js), all above the floor. */
export const RING_PRESETS: readonly RingPreset[] = [
    { id: 'lume',   label: 'Lume',   hex: '#25e0c8' },
    { id: 'ok',     label: 'Green',  hex: '#4ade80' },
    { id: 'glow',   label: 'Glow',   hex: '#ffc94d' },
    { id: 'flash',  label: 'Flash',  hex: '#ff6b5e' },
    { id: 'danger', label: 'Rose',   hex: '#ff5c7a' },
    { id: 'muted',  label: 'Mist',   hex: '#a7b3d4' },
    { id: 'text',   label: 'White',  hex: '#f4f7ff' },
];

export function isRingHex(v: unknown): v is string {
    return typeof v === 'string' && RING_HEX.test(v);
}

function channel(hex: string, i: number): number { return parseInt(hex.slice(i, i + 2), 16); }

/** WCAG 2.x relative luminance of a `#rrggbb`. */
export function relativeLuminance(hex: string): number {
    const lin = (i: number) => {
        const c = channel(hex, i) / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
}

function mixWithWhite(hex: string, t: number): string {
    const m = (i: number) => Math.round(channel(hex, i) + (255 - channel(hex, i)) * t);
    return '#' + [1, 3, 5].map(i => m(i).toString(16).padStart(2, '0')).join('');
}

/** True when a colour needs no lifting (also what the picker checks). */
export function isReadableRing(hex: string): boolean {
    return isRingHex(hex) && relativeLuminance(hex) >= RING_MIN_LUMINANCE;
}

/** Lift a too-dark colour towards white, keeping its hue, until it clears the floor. */
export function readableRingColor(hex: string): string {
    if (relativeLuminance(hex) >= RING_MIN_LUMINANCE) return hex;
    for (let t = 0.05; t < 1; t += 0.05) {
        const c = mixWithWhite(hex, t);
        if (relativeLuminance(c) >= RING_MIN_LUMINANCE) return c;
    }
    return '#ffffff';
}

/**
 * The colour to draw: null / undefined / malformed -> the stock green; a dark
 * colour (stale data, a modified client) -> lifted to readable. Never throws.
 */
export function resolveRingColor(hex: string | null | undefined): string {
    if (!isRingHex(hex)) return DEFAULT_RING_COLOR;
    return readableRingColor(hex);
}

export function withAlpha(hex: string, alpha: number): string {
    return `rgba(${channel(hex, 1)},${channel(hex, 3)},${channel(hex, 5)},${alpha})`;
}

export interface SpeakingShadowOpts {
    /** Blur radius of the glow, px. */
    glow: number;
    /** Glow opacity. */
    alpha: number;
    /** Ring thickness, px (default 2). */
    ring?: number;
    /** Draw the ring inside the box (tile borders over video). */
    inset?: boolean;
}

/**
 * `box-shadow` for a speaking element: a solid ring plus a soft glow, in the
 * person's colour. Replaces the old `ring-2 ring-green-500 shadow-[...]`
 * classes (an inline box-shadow overrides Tailwind's ring shadow, so the ring
 * is emulated here).
 */
export function speakingShadow(hex: string | null | undefined, o: SpeakingShadowOpts): string {
    const c = resolveRingColor(hex);
    const ring = `${o.inset ? 'inset ' : ''}0 0 0 ${o.ring ?? 2}px ${c}`;
    return `${ring}, 0 0 ${o.glow}px ${withAlpha(c, o.alpha)}`;
}

/** The ring's solid colour on its own (for a CSS `border-color`). */
export function speakingBorderColor(hex: string | null | undefined): string {
    return resolveRingColor(hex);
}

// ── Profile theme tint ───────────────────────────────────────────────────────

/** Strongest alpha any tint may use. Keeps white-ish text legible on any colour. */
export const TINT_MAX_ALPHA = 0.18;

export interface ThemeLike { primary?: string | null; accent?: string | null }

function themePrimary(theme: ThemeLike | null | undefined): string | null {
    return theme && isRingHex(theme.primary) ? theme.primary : null;
}

/** Row background for the voice-channel participant list, or undefined for no theme. */
export function themeRowBackground(theme: ThemeLike | null | undefined): string | undefined {
    const p = themePrimary(theme);
    return p ? `linear-gradient(90deg, ${withAlpha(p, 0.12)} 0%, ${withAlpha(p, 0.04)} 70%, transparent 100%)` : undefined;
}

/** Camera-off tile background: a soft wash behind the avatar. */
export function themeTileBackground(theme: ThemeLike | null | undefined): string | undefined {
    const p = themePrimary(theme);
    return p ? `radial-gradient(circle at 50% 42%, ${withAlpha(p, TINT_MAX_ALPHA)} 0%, ${withAlpha(p, 0.05)} 62%, transparent 100%)` : undefined;
}
