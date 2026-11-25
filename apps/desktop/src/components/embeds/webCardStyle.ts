/**
 * Which web card style a sender-built preview gets (docs/plans/embeds.md §10,
 * owner decisions 2026-11-23). The table itself lives with the "Compact
 * embeds" setting (utils/embedPrefs.ts WEB_CARD_STYLES, the card-layout
 * chooser); this maps its names onto WebEmbedCard's three card families.
 */
import { cleanEmbedText, type LinkEmbed } from '@cipherline/shared';
import { webCardStyleFor as chooser, type EmbedLayout, type WebCardPicture } from '../../utils/embedPrefs';

export type { EmbedLayout } from '../../utils/embedPrefs';
export type PictureShape = WebCardPicture;
export type WebCardStyle = 'tile' | 'island' | 'ambient';

/** The picture's shape from the sender's thumbnail dimensions. */
export function pictureShapeOf(embed: Pick<LinkEmbed, 'thumb'>): PictureShape {
    const t = embed.thumb;
    if (!t) return 'none';
    return t.width / t.height >= 1.3 ? 'wide' : 'square';
}

/** The owner's table (§10) through the layout chooser: Tile, Island or Ambient. */
export function webCardStyleFor(layout: EmbedLayout, shape: PictureShape): WebCardStyle {
    const s = chooser(layout, shape);
    return s === 'island' ? 'island' : s.startsWith('ambient') ? 'ambient' : 'tile';
}

/** "/news/articles/cr89…" for the minimal card: the path (+ query), decoded for reading, plain text (no control / bidi characters), bounded. */
export function linkPathLabel(u: string): string {
    try {
        const x = new URL(u);
        let p = x.pathname + x.search;
        try { p = decodeURI(p); } catch { /* keep encoded */ }
        if (p === '/' || p === '') return '';
        return cleanEmbedText(p, 90) ?? '';
    } catch { return ''; }
}

/** The letter for a site: its first letter or digit ("www.bbc.com" → B, "8bit.io" → 8). */
export function siteLetter(label: string): string {
    const clean = label.trim().replace(/^www\./i, '');
    const ch = Array.from(clean).find((c) => /[\p{L}\p{N}]/u.test(c));
    return ch ? ch.toLocaleUpperCase() : '•';
}
