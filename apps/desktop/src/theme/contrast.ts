/**
 * WCAG 2.x contrast for theme tokens. Pure; shared by the contrast guard test
 * and (later) the custom-theme editor's live contrast check.
 */

function channel(c: number): number {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Relative luminance of an opaque #RRGGBB colour. */
export function relativeLuminance(hex: string): number {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) throw new Error(`expected #RRGGBB, got ${hex}`);
    const n = parseInt(m[1], 16);
    return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** Contrast ratio (1-21) between two opaque colours. */
export function contrastRatio(a: string, b: string): number {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
}

/** AA thresholds: normal text 4.5, large text and UI components 3. */
export const AA_TEXT = 4.5;
export const AA_UI = 3;
