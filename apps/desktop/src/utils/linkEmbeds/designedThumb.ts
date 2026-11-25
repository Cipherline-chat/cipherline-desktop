/**
 * The designed card picture: the last step of "always a thumbnail"
 * (2026-11-24, embeds-always-thumb). When a link gave no usable picture at all
 * (no provider thumbnail, no og:image, no frame, no snapshot), its preview
 * still gets one: the site's icon (or its letter) on a tile, the site's name
 * under it, on a background tinted with the page's colour (else a colour
 * derived from the site's name). Drawn locally from text the embed already
 * carries; nothing is fetched.
 *
 *   SENDER    designedThumb(spec): a fresh WebP (tiny: it rides inline in the
 *             message), marked `designed` so a better picture that arrives
 *             later replaces it (lateAttach.ts improvesOn) and so readers know
 *             it is not a picture of the page.
 *   RECEIVER  designedPictureUrl(spec): the same drawing as a data: URL, for a
 *             message that has no picture (sent before this, or by an older
 *             app) or whose picture is one flat colour (a black Medal frame).
 *
 * `play`: the layout for a video poster (the play button sits in the middle):
 * the tile and name go to the lower left. Otherwise they are centred.
 */
import { encodeWebpThumb, makeCanvas, type EncodedThumb } from './thumb';

export interface DesignSpec {
    /** The site's name ("Medal", "example.com"). */
    label: string;
    /** `#rrggbb` (the page's theme-color), else derived from the label. */
    color?: string;
    /** The site's icon, already decoded (the sender's re-encoded favicon, or the reader's decrypted one). */
    icon?: CanvasImageSource | null;
    /** A video poster: keep the middle clear for the play button. */
    play?: boolean;
}

export const DESIGNED_W = 640;
export const DESIGNED_H = 360;

/** The letter for a site: its first letter or digit ("www.bbc.com" → B). */
export function designLetter(label: string): string {
    const clean = label.trim().replace(/^www\./i, '');
    const ch = Array.from(clean).find((c) => /[\p{L}\p{N}]/u.test(c));
    return ch ? ch.toLocaleUpperCase() : '•';
}

/** A stable hue (0-359) from the label, so one site always gets one colour. */
export function labelHue(label: string): number {
    let h = 2166136261;
    for (const ch of label.toLowerCase().replace(/^www\./, '')) {
        h ^= ch.codePointAt(0)!;
        h = Math.imul(h, 16777619);
    }
    return Math.abs(h) % 360;
}

function hslToHex(h: number, s: number, l: number): string {
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
        const k = (n + h / 30) % 12;
        const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return Math.round(c * 255).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a: string, b: string, t: number) => {
    const x = rgbOf(a); const y = rgbOf(b);
    return `rgb(${x.map((v, i) => Math.round(v * (1 - t) + y[i] * t)).join(',')})`;
};
function luminance(hex: string): number {
    const c = rgbOf(hex).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** The accent: the page's colour when it is a real one, else one from the label. */
export function designAccent(spec: Pick<DesignSpec, 'label' | 'color'>): string {
    if (spec.color && /^#[0-9a-f]{6}$/i.test(spec.color)) {
        const l = luminance(spec.color);
        // A near-white / near-black theme colour says nothing: use the label's.
        if (l > 0.04 && l < 0.85) return spec.color.toLowerCase();
    }
    return hslToHex(labelHue(spec.label), 0.55, 0.56);
}

const FONT = '"Nunito", "Segoe UI", system-ui, sans-serif';

function roundRect(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function fitText(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, text: string, max: number): string {
    if (ctx.measureText(text).width <= max) return text;
    const chars = Array.from(text);
    while (chars.length > 1 && ctx.measureText(`${chars.join('')}…`).width > max) chars.pop();
    return `${chars.join('')}…`;
}

/** Draws the designed picture onto a `w` x `h` 2D context. */
export function drawDesigned(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number, spec: DesignSpec): void {
    const accent = designAccent(spec);
    const letter = designLetter(spec.label);
    // Background: the accent sunk into a deep neutral, so it reads in both themes.
    ctx.fillStyle = mix(accent, '#101216', 0.8);
    ctx.fillRect(0, 0, w, h);
    // A large faint letter for texture (right, bleeding off the edge).
    ctx.save();
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = accent;
    ctx.font = `800 ${Math.round(h * 1.15)}px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(letter, w + h * 0.08, h * 1.02);
    ctx.restore();

    const tile = Math.round(h * (spec.play ? 0.2 : 0.3));
    const fontPx = Math.round(h * (spec.play ? 0.07 : 0.075));
    const tx = spec.play ? Math.round(h * 0.09) : Math.round((w - tile) / 2);
    const ty = spec.play ? Math.round(h - h * 0.09 - tile) : Math.round(h * 0.38 - tile / 2);
    const r = Math.round(tile * 0.24);
    // The tile: the icon on a white plate, else the letter on the accent.
    roundRect(ctx, tx, ty, tile, tile, r);
    ctx.fillStyle = spec.icon ? '#ffffff' : accent;
    ctx.fill();
    if (spec.icon) {
        const inner = Math.round(tile * 0.62);
        ctx.save();
        roundRect(ctx, tx, ty, tile, tile, r);
        ctx.clip();
        try { ctx.drawImage(spec.icon, tx + (tile - inner) / 2, ty + (tile - inner) / 2, inner, inner); } catch { /* an undecodable icon: the plate alone */ }
        ctx.restore();
    } else {
        ctx.fillStyle = luminance(accent) > 0.45 ? '#15171c' : '#ffffff';
        ctx.font = `800 ${Math.round(tile * 0.56)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(letter, tx + tile / 2, ty + tile / 2 + tile * 0.03);
    }
    // The site's name.
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.font = `700 ${fontPx}px ${FONT}`;
    ctx.textBaseline = 'middle';
    const label = spec.label.trim().replace(/^www\./i, '') || letter;
    if (spec.play) {
        ctx.textAlign = 'left';
        const x = tx + tile + Math.round(h * 0.045);
        ctx.fillText(fitText(ctx, label, w - x - h * 0.09), x, ty + tile / 2);
    } else {
        ctx.textAlign = 'center';
        ctx.fillText(fitText(ctx, label, w * 0.8), w / 2, ty + tile + h * 0.13);
    }
}

const inJsdom = () => typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);

/** SENDER: the designed picture as a fresh WebP (marked `designed`), or null (no canvas / encoder). Never throws. */
export async function designedThumb(spec: DesignSpec): Promise<EncodedThumb | null> {
    if (inJsdom()) return null;
    try {
        const c = makeCanvas(DESIGNED_W, DESIGNED_H);
        const ctx = c.getContext('2d');
        if (!ctx) return null;
        drawDesigned(ctx, DESIGNED_W, DESIGNED_H, spec);
        const out = await encodeWebpThumb(c as unknown as CanvasImageSource, DESIGNED_W, DESIGNED_H, DESIGNED_W);
        return out ? { ...out, designed: true } : null;
    } catch {
        return null;
    }
}

const urlCache = new Map<string, string>();

/** RECEIVER: the designed picture as a data: URL (cached per spec), or null where there is no canvas. Never throws. */
export function designedPictureUrl(spec: DesignSpec, iconKey = ''): string | null {
    if (inJsdom() || typeof document === 'undefined') return null;
    const key = `${spec.label}|${spec.color ?? ''}|${spec.play ? 1 : 0}|${spec.icon ? iconKey : ''}`;
    const hit = urlCache.get(key);
    if (hit) return hit;
    try {
        const c = document.createElement('canvas');
        c.width = DESIGNED_W; c.height = DESIGNED_H;
        const ctx = c.getContext('2d');
        if (!ctx) return null;
        drawDesigned(ctx, DESIGNED_W, DESIGNED_H, spec);
        const url = c.toDataURL('image/png');
        urlCache.set(key, url);
        while (urlCache.size > 64) urlCache.delete(urlCache.keys().next().value as string);
        return url;
    } catch {
        return null;
    }
}
