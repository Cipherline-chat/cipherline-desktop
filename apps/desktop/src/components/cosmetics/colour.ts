/**
 * Tiny colour helpers for the cosmetics art: every item derives its whole
 * palette (shadow, body, rim light, bloom) from ONE tint, so a hue option or
 * the theme's "match" colour recolours the art coherently instead of
 * flat-filling one shape.
 */
export interface HSL { h: number; s: number; l: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function hexToHsl(hex: string): HSL | null {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        h *= 60;
    }
    return { h, s: s * 100, l: l * 100 };
}

/** `#rrggbb`, `hsl(h s% l%)` / `hsl(h, s%, l%)` -> HSL; anything else null. */
export function parseColour(c: string | null | undefined): HSL | null {
    if (!c) return null;
    const hex = hexToHsl(c);
    if (hex) return hex;
    const m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i.exec(c.trim());
    return m ? { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) } : null;
}

/** A CSS colour from `c`, shifted: dl / ds in percentage points, dh in degrees. */
export function shade(c: HSL, dl = 0, a = 1, ds = 0, dh = 0): string {
    const h = ((c.h + dh) % 360 + 360) % 360;
    const s = clamp(c.s + ds, 0, 100), l = clamp(c.l + dl, 0, 100);
    return a >= 1 ? `hsl(${h.toFixed(1)} ${s.toFixed(1)}% ${l.toFixed(1)}%)` : `hsl(${h.toFixed(1)} ${s.toFixed(1)}% ${l.toFixed(1)}% / ${a.toFixed(3)})`;
}

/** HSL (degrees / percent) -> [r, g, b] in 0-255. */
export function hslToRgb(c: HSL): [number, number, number] {
    const h = (((c.h % 360) + 360) % 360) / 360, s = clamp(c.s, 0, 100) / 100, l = clamp(c.l, 0, 100) / 100;
    if (s === 0) return [l * 255, l * 255, l * 255];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    };
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** The colour an item paints with: its hue option, else the theme tint, else its stock colour. */
export function itemTint(h: number | undefined, themeTint: string | null | undefined, stock: string): HSL {
    if (typeof h === 'number') return { h, s: 78, l: 62 };
    return parseColour(themeTint) ?? hexToHsl(stock)!;
}
