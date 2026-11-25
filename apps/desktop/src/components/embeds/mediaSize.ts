/**
 * How big a video or picture embed is drawn (docs/plans/embeds.md §11, owner
 * 2026-11-24: "any video or image sent the embed should match its size").
 *
 * The box always has the media's OWN aspect ratio (no side gutters, no
 * letterboxing: the card hugs the media) and fits inside a per-layout cap:
 *
 *   maxW   the widest a landscape box gets (16:9 → maxW wide)
 *   maxH   the tallest a portrait box gets (9:16 → maxH tall)
 *   area   a ceiling on width × height, so the sizes between those two ends
 *          change smoothly instead of jumping at "square" (a square box is
 *          √area on a side). Infinity = plain fit-in-box.
 *
 * Values (round-4 concepts, concepts/embeds-2026-11-23/round4, measured there
 * in the real chat at 1000x720 and 1366x768):
 *   expanded   400 × 448, area 252 × 448: 16:9 = 400 × 225, 9:16 = 252 × 448,
 *              1:1 = 336 × 336. The player when playing (both layouts).
 *   compact    the idle clip-card row's thumbnail: 184 × 150, area = 16:9 at 184 wide:
 *              16:9 = 184 × 104, 9:16 = 84 × 150, 1:1 = 138 square.
 *   picture    a picture (an image link, a compact post picture) in Compact:
 *              320 × 240, no area cap.
 * The chat column caps every box further (CSS max-width: 100%, height
 * following through aspect-ratio).
 *
 * TikTok's own player (player/v1) needs at least 252 px of width: measured
 * live 2026-11-24 in this app's Electron, its control bar's time collides with
 * the settings button at 240 px and the fullscreen button is cut at 225 px.
 */
export interface MediaCaps { maxW: number; maxH: number; area: number }

export const MEDIA_CAPS = {
    expanded: { maxW: 400, maxH: 448, area: 252 * 448 },
    compactThumb: { maxW: 184, maxH: 150, area: 184 * 184 * 9 / 16 },
    compactPicture: { maxW: 320, maxH: 240, area: Number.POSITIVE_INFINITY },
} as const satisfies Record<string, MediaCaps>;

/** TikTok player/v1's narrowest usable width (see above). */
export const TIKTOK_MIN_WIDTH = 252;

/** The band an aspect ratio is kept in, so a broken header cannot draw a sliver. */
export const ASPECT_MIN = 0.45;
export const ASPECT_MAX = 2.4;

export function clampAspect(a: number): number {
    return Math.min(ASPECT_MAX, Math.max(ASPECT_MIN, a));
}

/** w / h when both are real positive numbers, else null. */
export function aspectOf(w: number | undefined | null, h: number | undefined | null): number | null {
    if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return w / h;
}

export interface MediaBox { width: number; height: number }

/**
 * The box (CSS px, before the column cap) for media of `aspect` under `caps`.
 * `minW` raises a box that came out narrower (TikTok), keeping the aspect.
 */
export function mediaBox(aspect: number, caps: MediaCaps, minW = 0): MediaBox {
    const a = clampAspect(Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9);
    let w = Math.min(caps.maxW, caps.maxH * a, Math.sqrt(caps.area * a));
    if (w < minW) w = minW;
    const r = (n: number) => Math.round(n * 100) / 100;
    return { width: r(w), height: r(w / a) };
}

export type AspectSource = 'media' | 'thumb' | 'provider' | 'natural' | 'default';

export interface AspectInputs {
    /** LinkEmbed.media width / height (the real video file's, from the sender). */
    media?: { width?: number; height?: number } | null;
    /** The sender's thumbnail (EmbedImage) dimensions; a DESIGNED picture says nothing about the media and is ignored. */
    thumb?: { width?: number; height?: number; designed?: boolean } | null;
    /** A shape the provider always has (YouTube Shorts / TikTok 9:16, a YouTube video 16:9); wins over the files. */
    provider?: number | null;
    /** What the provider usually is, used only when nothing above is known (TikTok 9:16). */
    providerDefault?: number | null;
}

/**
 * Which aspect ratio an embed's box takes, in order: the provider's fixed
 * shape, the media's own size, the thumbnail's size, the provider's usual
 * shape, else 16:9. `known` is false only for the last: the caller may then
 * still learn it from the decoded thumbnail's natural size.
 */
export function pickAspect(i: AspectInputs): { aspect: number; source: AspectSource; known: boolean } {
    if (i.provider && i.provider > 0) return { aspect: clampAspect(i.provider), source: 'provider', known: true };
    const m = aspectOf(i.media?.width, i.media?.height);
    if (m) return { aspect: clampAspect(m), source: 'media', known: true };
    const t = i.thumb && !i.thumb.designed ? aspectOf(i.thumb.width, i.thumb.height) : null;
    if (t) return { aspect: clampAspect(t), source: 'thumb', known: true };
    if (i.providerDefault && i.providerDefault > 0) return { aspect: clampAspect(i.providerDefault), source: 'provider', known: true };
    return { aspect: 16 / 9, source: 'default', known: false };
}
