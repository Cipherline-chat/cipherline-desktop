import type { ProfileTheme } from './profileTheme';

/**
 * "Match my banner": a theme taken from your banner (or avatar), entirely on
 * this device. The image is already decrypted locally; it is sampled on a
 * small canvas (~2.3k pixels), clustered in OKLab (perceptual: distances there
 * track how different colours LOOK), and the clusters are scored for a theme:
 *
 *  - primary: a colour that is both present and alive (population x chroma),
 *    never near-black or near-white (those make a muddy or washed-out frame);
 *  - accent: the best partner for it - clearly a different hue (or, for a
 *    one-colour image, a clearly different lightness of the same hue).
 *
 * Colours are then lifted into a band that reads on the card's dark navy
 * (OKLCH lightness 0.58-0.86, chroma kept, clipped to sRGB). Text contrast on
 * the card is guaranteed separately by utils/profileTheme (the tint is capped
 * for 4.5:1 whatever the pair), so any proposal here is safe to apply.
 */

export interface Swatch {
    hex: string;
    /** Share of sampled pixels (0..1). */
    weight: number;
    L: number;
    C: number;
    /** Hue in degrees (0..360). */
    h: number;
}

// ── colour maths (sRGB <-> OKLab, Björn Ottosson) ────────────────────────────

const toLin = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
const fromLin = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
    const lr = toLin(r), lg = toLin(g), lb = toLin(b);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
}

function oklabToRgbUnclamped(L: number, a: number, b: number): [number, number, number] {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [
        fromLin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        fromLin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        fromLin(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
    ];
}

const inGamut = (c: [number, number, number]) => c.every((v) => v >= -0.0005 && v <= 1.0005);
const hex2 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');

/** OKLCH -> '#rrggbb', reducing chroma until it fits sRGB (keeps hue and lightness). */
export function oklchToHex(L: number, C: number, h: number): string {
    const rad = (h * Math.PI) / 180;
    let c = C;
    let rgb = oklabToRgbUnclamped(L, c * Math.cos(rad), c * Math.sin(rad));
    for (let i = 0; i < 24 && !inGamut(rgb); i++) {
        c *= 0.9;
        rgb = oklabToRgbUnclamped(L, c * Math.cos(rad), c * Math.sin(rad));
    }
    return `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`;
}

export function hexToOklch(hex: string): { L: number; C: number; h: number } {
    const n = parseInt(hex.slice(1), 16);
    const [L, a, b] = rgbToOklab((n >> 16) & 255, (n >> 8) & 255, n & 255);
    return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

// ── clustering ───────────────────────────────────────────────────────────────

/**
 * Cluster RGBA pixels into at most `k` swatches, heaviest first. Deterministic
 * (no randomness): seeds are the most common coarse bucket, then the farthest
 * points from the seeds so far (k-means++ without the dice).
 */
export function paletteFromPixels(rgba: Uint8ClampedArray | number[], k = 6, iterations = 10): Swatch[] {
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i + 3 < rgba.length; i += 4) {
        if (rgba[i + 3] < 200) continue; // transparent edges carry no colour
        pts.push(rgbToOklab(rgba[i], rgba[i + 1], rgba[i + 2]));
    }
    if (pts.length === 0) return [];

    // Seed 1: the centre of the most populated coarse bucket.
    const buckets = new Map<string, { n: number; s: [number, number, number] }>();
    for (const p of pts) {
        const key = `${Math.round(p[0] * 8)}:${Math.round(p[1] * 16)}:${Math.round(p[2] * 16)}`;
        const bk = buckets.get(key) ?? { n: 0, s: [0, 0, 0] };
        bk.n++; bk.s[0] += p[0]; bk.s[1] += p[1]; bk.s[2] += p[2];
        buckets.set(key, bk);
    }
    let best = { n: 0, s: [0, 0, 0] as [number, number, number] };
    for (const bk of buckets.values()) if (bk.n > best.n) best = bk;
    const centres: Array<[number, number, number]> = [[best.s[0] / best.n, best.s[1] / best.n, best.s[2] / best.n]];
    const d2 = (p: number[], q: number[]) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
    while (centres.length < Math.min(k, pts.length)) {
        let far = pts[0], fd = -1;
        for (const p of pts) {
            let m = Infinity;
            for (const c of centres) m = Math.min(m, d2(p, c));
            if (m > fd) { fd = m; far = p; }
        }
        if (fd < 1e-6) break; // fewer distinct colours than k
        centres.push([...far]);
    }

    const assign = new Int32Array(pts.length);
    for (let it = 0; it < iterations; it++) {
        for (let i = 0; i < pts.length; i++) {
            let bi = 0, bd = Infinity;
            for (let c = 0; c < centres.length; c++) { const d = d2(pts[i], centres[c]); if (d < bd) { bd = d; bi = c; } }
            assign[i] = bi;
        }
        const sum = centres.map(() => [0, 0, 0, 0]);
        for (let i = 0; i < pts.length; i++) { const s = sum[assign[i]]; s[0] += pts[i][0]; s[1] += pts[i][1]; s[2] += pts[i][2]; s[3]++; }
        for (let c = 0; c < centres.length; c++) if (sum[c][3] > 0) centres[c] = [sum[c][0] / sum[c][3], sum[c][1] / sum[c][3], sum[c][2] / sum[c][3]];
    }
    const counts = new Array(centres.length).fill(0);
    for (let i = 0; i < pts.length; i++) counts[assign[i]]++;

    return centres
        .map((c, i) => {
            const C = Math.hypot(c[1], c[2]);
            const h = ((Math.atan2(c[2], c[1]) * 180) / Math.PI + 360) % 360;
            return { hex: oklchToHex(c[0], C, h), weight: counts[i] / pts.length, L: c[0], C, h };
        })
        .filter((s) => s.weight > 0)
        .sort((a, b) => b.weight - a.weight);
}

// ── from a palette to themes ─────────────────────────────────────────────────

const hueDist = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/** Lift a colour into the band that reads on the dark card (OKLCH L 0.58..0.86), keeping its hue and chroma. */
export function displayable(s: Pick<Swatch, 'L' | 'C' | 'h'>): string {
    const L = Math.min(0.86, Math.max(0.58, s.L));
    return oklchToHex(L, Math.min(0.32, s.C), s.h);
}

/** How good a swatch is as a theme's main colour. */
const primaryScore = (s: Swatch) => {
    const lightPenalty = s.L < 0.22 || s.L > 0.94 ? 0.25 : 1;
    return Math.pow(s.weight, 0.55) * (0.15 + Math.min(s.C, 0.3) * 5) * lightPenalty;
};

export interface ThemeProposal { primary: string; accent: string }

/**
 * Up to `max` distinct theme proposals from a palette, best first. Empty when
 * the palette is empty. A one-colour (or grey) image still gets a proposal: a
 * light and a deep version of its dominant colour.
 */
export function themesFromPalette(palette: readonly Swatch[], max = 4): ThemeProposal[] {
    if (palette.length === 0) return [];
    const ranked = [...palette].sort((a, b) => primaryScore(b) - primaryScore(a));
    const out: ThemeProposal[] = [];
    const seen = new Set<string>();
    const push = (p: ThemeProposal) => {
        const key = `${p.primary}|${p.accent}`;
        if (p.primary === p.accent || seen.has(key)) return;
        seen.add(key);
        out.push(p);
    };
    for (const prim of ranked) {
        if (out.length >= max) break;
        // The partner: a different hue (scored by hue distance, life and presence), else the best other one.
        const partners = palette
            .filter((s) => s !== prim)
            .map((s) => ({
                s,
                score: (s.C < 0.03 || prim.C < 0.03 ? 0.4 : Math.min(1, hueDist(s.h, prim.h) / 70)) * (0.2 + Math.min(s.C, 0.3) * 4) * Math.pow(s.weight, 0.3)
                    * (Math.abs(s.L - prim.L) > 0.05 || hueDist(s.h, prim.h) > 25 ? 1 : 0.3),
            }))
            .sort((a, b) => b.score - a.score);
        const partner = partners[0]?.s;
        if (partner && partners[0].score > 0.02) push({ primary: displayable(prim), accent: displayable(partner) });
        // A tonal pair from the same colour (always available; good for near one-colour images).
        push({ primary: displayable({ ...prim, L: Math.max(prim.L, 0.72) }), accent: oklchToHex(0.5, Math.min(0.2, prim.C), prim.h) });
    }
    return out.slice(0, max);
}

/** Distinct displayable colours from a palette, for the picker's "From your banner" row. */
export function suggestedColours(palette: readonly Swatch[], max = 6): string[] {
    const out: string[] = [];
    for (const s of [...palette].sort((a, b) => primaryScore(b) - primaryScore(a))) {
        const hex = displayable(s);
        if (!out.includes(hex)) out.push(hex);
        if (out.length >= max) break;
    }
    return out;
}

/** Sample an image URL (blob: / data:) on a small canvas. Null when it cannot be read. */
export async function paletteFromImageUrl(url: string, k = 6): Promise<Swatch[] | null> {
    try {
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
        await img.decode();
        const max = 64;
        const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * s)), h = Math.max(1, Math.round(img.naturalHeight * s));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0, w, h);
        return paletteFromPixels(ctx.getImageData(0, 0, w, h).data, k);
    } catch {
        return null;
    }
}

export const isTheme = (t: unknown): t is ProfileTheme => !!t && typeof t === 'object'
    && /^#[0-9a-f]{6}$/.test((t as ProfileTheme).primary) && /^#[0-9a-f]{6}$/.test((t as ProfileTheme).accent);
