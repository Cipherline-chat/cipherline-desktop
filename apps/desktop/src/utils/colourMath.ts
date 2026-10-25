/**
 * Pure colour conversions for the in-app colour picker (ColourPicker.tsx).
 *
 * Conventions: hex is always `#rrggbb` lowercase; RGB channels are integers
 * 0..255; HSV is `h` in degrees [0, 360], `s` and `v` as fractions [0, 1].
 * HSV is what the picker keeps as its state, so dragging saturation to 0 (or
 * brightness to 0) does not lose the hue.
 */

export interface Rgb { r: number; g: number; b: number }
export interface Hsv { h: number; s: number; v: number }

export const clamp = (n: number, min: number, max: number): number =>
    Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;

/**
 * `#abc`, `abc`, `#aabbcc`, `AABBCC` (surrounding whitespace allowed) ->
 * `#aabbcc`. Anything else -> null; garbage is never coerced.
 */
export function normalizeHex(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
    if (!m) return null;
    let d = m[1].toLowerCase();
    if (d.length === 3) d = d[0] + d[0] + d[1] + d[1] + d[2] + d[2];
    return `#${d}`;
}

export function hexToRgb(hex: string): Rgb | null {
    const n = normalizeHex(hex);
    if (!n) return null;
    const v = parseInt(n.slice(1), 16);
    return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

const byte = (n: number): string => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');

export function rgbToHex({ r, g, b }: Rgb): string {
    return `#${byte(r)}${byte(g)}${byte(b)}`;
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
    const rn = clamp(r, 0, 255) / 255, gn = clamp(g, 0, 255) / 255, bn = clamp(b, 0, 255) / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === rn) h = ((gn - bn) / d) % 6;
        else if (max === gn) h = (bn - rn) / d + 2;
        else h = (rn - gn) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
    const hh = clamp(h, 0, 360) % 360;
    const ss = clamp(s, 0, 1), vv = clamp(v, 0, 1);
    const c = vv * ss;
    const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
    const m = vv - c;
    let r = 0, g = 0, b = 0;
    if (hh < 60) { r = c; g = x; }
    else if (hh < 120) { r = x; g = c; }
    else if (hh < 180) { g = c; b = x; }
    else if (hh < 240) { g = x; b = c; }
    else if (hh < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

export function hexToHsv(hex: string): Hsv | null {
    const rgb = hexToRgb(hex);
    return rgb ? rgbToHsv(rgb) : null;
}

export function hsvToHex(hsv: Hsv): string {
    return rgbToHex(hsvToRgb(hsv));
}
