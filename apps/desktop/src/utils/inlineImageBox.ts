/**
 * The box an inline image link (ChatPane ImageLinkEmbed) reserves once its
 * natural size is known, capped at `maxW` x `maxH`.
 *
 * It must lay out EXACTLY like the same image without a box, at every column
 * width, because the size becomes known by mutating the cache entry on `load`
 * (utils/remoteImageCache rememberRemoteImageSize), which re-renders nothing:
 * the box only appears at the row's NEXT render, whatever causes it (a save, a
 * pin, a reaction, a hover). It used to be an explicit `width` + `height`; with
 * `max-width: 100%` a column narrower than the box shrank the width but kept
 * the height, so that next render made the image taller (and stretched it) and
 * moved every message below it: saving a message made the chat jump
 * (0.1.2-staging.245, harness/save-no-jump-check.mjs). So: an exact width
 * (unrounded, so it matches the browser's own max-height scaling), `height:
 * auto` and the natural aspect ratio. Before the image decodes (a remount
 * seeded from the cache) the aspect ratio still reserves its height.
 */
export interface InlineImageBox {
    width: number;
    height: 'auto';
    aspectRatio: string;
}

export function inlineImageBox(naturalW: number | undefined, naturalH: number | undefined, maxW = 320, maxH = 300): InlineImageBox | null {
    if (!naturalW || !naturalH || naturalW <= 0 || naturalH <= 0) return null;
    const k = Math.min(1, maxW / naturalW, maxH / naturalH);
    return { width: naturalW * k, height: 'auto', aspectRatio: `${naturalW} / ${naturalH}` };
}
