/**
 * A web page's sender-built preview card (docs/plans/embeds.md §10, phase 3).
 *
 * The owner's designs (concepts/embeds-2026-11-23/round2 + round3, harness
 * r2.tsx / r3.tsx), one family with the video clip card, no left rail:
 *
 *   picture   Compact            Expanded
 *   wide      Ambient            Island (picture on top, text under it, 16:9..1.91:1)
 *   square    Ambient            Ambient (the picture blurred into the card's light)
 *   none      Tile (no image)    Tile (no image)
 *
 * Every page card has a picture (2026-11-23, page snapshots): the page's own,
 * else a snapshot of the page the SENDER's app took (a 1200x675 picture, the
 * Island at the YouTube player's size; compact: the Amazon card's layout).
 * The no-picture Tile is only the fallback for pages that cannot be shown
 * (bot walls, sign-in pages, errors, unreachable sites).
 *
 * "wide" = the sender's re-encoded thumbnail is at least 1.3:1. The page's
 * theme-color is a faint corner glow, never a bar. Light mode has no outlines:
 * a white card on the cream page with a soft warm shadow (sender-embeds.css).
 *
 * Everything drawn here came from the sender inside the encrypted message and
 * was re-validated (sanitizeLinkEmbeds): plain text only, the picture decrypted
 * from our own storage or inline. Nothing is requested from the linked site.
 *
 * The site badge is the site's icon when the SENDER fetched it (2026-11-23
 * fixes: `author_icon` on a card = its favicon, re-encoded, inside the message
 * like the thumbnail; never loaded from the site), else a generated letter in
 * the page's colour. A badge picture that fails to decode / decrypt falls back
 * to the letter: never a broken-image icon.
 *
 * The MINIMAL card (a page that gave nothing, a bot wall, an unreachable host,
 * an http link, or a message without any sender preview: MessageEmbed builds
 * one from the link alone) is the no-image Tile with the host as its title and
 * the link's path under it.
 *
 * Always a picture (2026-11-24, embeds-always-thumb): a card with no picture
 * (sent before this, by an older app, or whose picture is gone / refused) is
 * drawn with the DESIGNED card picture (the site's icon or letter on a tinted
 * background, useDesignedPicture), made here from the embed's own text and
 * icon: no request. New senders attach the same picture themselves.
 *
 * Clicking the title opens the link in the browser (openExternalLink validates it).
 */
import React, { useState } from 'react';
import { X } from 'lucide-react';
import type { LinkEmbed } from '@cipherline/shared';
import { openExternalLink } from '../../utils/openExternalLink';
import { useEmbedThumb } from './useEmbedThumb';
import { useDesignedPicture } from './useDesignedPicture';
import { EmbedPictureViewer } from './EmbedPictureViewer';
import { isLocalPicture, pictureFilename, pictureOpenProps } from './embedPicture';
import { aspectOf } from './mediaSize';
import '../../styles/sender-embeds.css';

import { linkPathLabel, pictureShapeOf, siteLetter, webCardStyleFor, type EmbedLayout, type PictureShape } from './webCardStyle';

export type { EmbedLayout } from './webCardStyle';

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

/**
 * The site's badge: its icon (sender-fetched, from the message) or, without one
 * or when it will not draw, a letter in the page's colour. Never a request.
 */
const SiteMark: React.FC<{ label: string; color?: string; size?: number; iconUrl?: string | null }> = ({ label, color, size = 16, iconUrl }) => {
    const [broken, setBroken] = useState<string | null>(null);
    if (iconUrl && broken !== iconUrl) {
        return (
            <span className="cl-se-mark cl-se-mark--icon" aria-hidden="true" style={{ width: size, height: size }}>
                <img src={iconUrl} alt="" draggable={false} decoding="async" onError={() => setBroken(iconUrl)} />
            </span>
        );
    }
    const ch = siteLetter(label);
    // The letter is dark on a light page colour and light on a dark one (no colour: the theme's raise + text).
    const ink = color ? (relativeLuminance(color) > 0.45 ? ' cl-se-mark--ink-dark' : ' cl-se-mark--ink-light') : '';
    return (
        <span className={`cl-se-mark${ink}`} aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }}>{ch}</span>
    );
};

/** WCAG relative luminance of a validated `#rrggbb`. */
function relativeLuminance(hex: string): number {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

const SitePill: React.FC<{ label: string; color?: string; glass?: boolean; iconUrl?: string | null }> = ({ label, color, glass, iconUrl }) => (
    <span className={`cl-se-site${glass ? ' cl-se-site--glass' : ''}`}><SiteMark label={label} color={color} iconUrl={iconUrl} />{label}</span>
);

export interface WebEmbedCardProps {
    embed: LinkEmbed;
    layout: EmbedLayout;
    /** Own message: a "Remove embed" button (an edit that drops this embed). */
    onRemove?: () => void;
}

export const WebEmbedCard: React.FC<WebEmbedCardProps> = ({ embed, layout, onRemove }) => {
    const thumb = useEmbedThumb(embed.thumb);
    // A card's author_icon is its site's icon (decrypted from our storage / inline, like the thumbnail).
    const icon = useEmbedThumb(embed.kind === 'card' ? embed.author_icon : undefined);
    const iconUrl = icon.failed ? null : icon.url;
    const host = hostOf(embed.url);
    const site = embed.site || host;
    // No picture, or one that is gone (expired attachment) / refused: the designed picture.
    const noPicture = !embed.thumb || thumb.failed;
    const designedUrl = useDesignedPicture(noPicture ? { label: site, color: embed.color, iconUrl } : null);
    const pictureUrl = noPicture ? designedUrl : thumb.url;
    const shape: PictureShape = noPicture ? (designedUrl ? 'wide' : 'none') : pictureShapeOf(embed);
    const style = webCardStyleFor(layout, shape);
    const title = embed.title || host;
    // The minimal card: no title of its own, so the host is the title and the path stands in for a description.
    const minimal = !embed.title && !embed.description;
    const path = minimal ? linkPathLabel(embed.url) : '';
    const showPill = !minimal || site.toLowerCase() !== host.toLowerCase();
    const byline = [embed.author, embed.tag].filter(Boolean).join(' · ');
    const open = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); openExternalLink(embed.url); };
    const glow = embed.color ? ({ ['--cl-se-glow' as string]: embed.color } as React.CSSProperties) : undefined;
    // The picture at its REAL shape where the layout allows (§11, 2026-11-24): the Island's
    // hero and the wide Tile's thumbnail take any wide shape (1.3:1 .. 2.4:1, the band
    // pictureShapeOf calls "wide"), the Ambient thumbnail any shape from 3:4 to 1.6:1 at
    // about the same area. A designed picture keeps its 16:9 drawing.
    const realAspect = !noPicture && embed.thumb ? aspectOf(embed.thumb.width, embed.thumb.height) : null;
    const wideAspect = realAspect ? Math.min(2.4, Math.max(1.3, realAspect)) : 16 / 9;
    const heroAspect = (embed.thumb && !noPicture) || designedUrl ? ({ aspectRatio: String(wideAspect) } as React.CSSProperties) : undefined;
    const ambAspect = realAspect ? Math.min(1.6, Math.max(0.75, realAspect)) : 1;
    const thumbStyle = (cls: string): React.CSSProperties | undefined => cls === 'cl-se-thumb--amb'
        ? ({ ['--cl-se-amb-a' as string]: String(ambAspect), ['--cl-se-amb-f' as string]: String(Math.sqrt(ambAspect)) } as React.CSSProperties)
        : cls === 'cl-se-thumb--tile' && shape === 'wide' ? { aspectRatio: String(wideAspect) } : undefined;
    // Click / Enter on a real picture (the page's own, a snapshot) enlarges it in the app's
    // image viewer: the decrypted copy from the message, never a request to the site.
    // A designed picture is not a picture of anything: it does not open.
    const [viewing, setViewing] = useState(false);
    const openable = !noPicture && !embed.thumb?.designed && isLocalPicture(pictureUrl);
    const pictureProps = openable ? pictureOpenProps(`Enlarge the picture of ${title}`, () => setViewing(true)) : {};
    const img = (cls: string) => (
        <div className={`cl-se-thumb ${cls}`} style={thumbStyle(cls)} {...pictureProps}>
            {pictureUrl && <img className="cl-se-frame" src={pictureUrl} alt="" draggable={false} decoding="async" />}
        </div>
    );
    const titleEl = (lines: number) => (
        <a className={`cl-se-title cl-se-clamp-${lines}`} href={embed.url} onClick={open} title={embed.url}>{title}</a>
    );
    const remove = onRemove ? (
        <button type="button" className="cl-se-remove" aria-label="Remove embed" title="Remove embed"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}>
            <X />
        </button>
    ) : null;

    return (
        <div
            className={`mt-2 cl-se cl-se--${style} cl-se--${shape}`}
            data-embed="web" data-embed-style={style} data-embed-shape={shape}
            data-embed-minimal={minimal ? 'true' : undefined} data-embed-icon={iconUrl ? 'site' : 'letter'}
            data-picture={noPicture ? (designedUrl ? 'designed' : 'none') : embed.thumb?.designed ? 'designed' : 'real'}
            style={glow}
            // The chat row toggles "save" on click; an embed is its own control.
            onClick={(e) => e.stopPropagation()}
        >
            {style === 'island' ? (
                <>
                    <div className="cl-se-hero" style={heroAspect} {...pictureProps}>
                        {pictureUrl && <img className="cl-se-frame" src={pictureUrl} alt="" draggable={false} decoding="async" />}
                        <span className="cl-se-chip"><SitePill label={site} color={embed.color} iconUrl={iconUrl} glass /></span>
                    </div>
                    <div className="cl-se-body">
                        {titleEl(2)}
                        {embed.description && <p className="cl-se-desc cl-se-clamp-3">{embed.description}</p>}
                        <div className="cl-se-foot cl-se-foot--full">
                            {byline && <span className="cl-se-byline">{byline}</span>}
                            <span className="cl-se-grow" />
                            <span className="cl-se-host">{host}</span>
                        </div>
                    </div>
                </>
            ) : style === 'ambient' ? (
                <>
                    <div className="cl-se-amb" aria-hidden="true">{pictureUrl && <img src={pictureUrl} alt="" />}</div>
                    <div className="cl-se-veil" aria-hidden="true" />
                    <div className="cl-se-inner">
                        <div className="cl-se-meta">
                            <SitePill label={site} color={embed.color} iconUrl={iconUrl} />
                            {titleEl(2)}
                            {embed.description && <p className="cl-se-desc cl-se-clamp-3">{embed.description}</p>}
                            {byline && <div className="cl-se-foot"><span className="cl-se-byline">{byline}</span></div>}
                        </div>
                        {img('cl-se-thumb--amb')}
                    </div>
                </>
            ) : (
                <div className="cl-se-row">
                    {shape === 'none'
                        ? <div className={`cl-se-well${iconUrl ? ' cl-se-well--icon' : ''}`}><SiteMark label={site} color={embed.color} size={iconUrl ? 32 : 28} iconUrl={iconUrl} /></div>
                        : img('cl-se-thumb--tile')}
                    <div className={`cl-se-meta${minimal ? ' cl-se-meta--minimal' : ''}`}>
                        {showPill && <SitePill label={site} color={embed.color} iconUrl={iconUrl} />}
                        {titleEl(2)}
                        {embed.description && <p className="cl-se-desc cl-se-clamp-2">{embed.description}</p>}
                        {path && <p className="cl-se-path cl-se-clamp-1">{path}</p>}
                        {byline && <div className="cl-se-foot"><span className="cl-se-byline">{byline}</span></div>}
                    </div>
                </div>
            )}
            {remove}
            {viewing && openable && (
                <EmbedPictureViewer src={pictureUrl} pageUrl={embed.url} filename={pictureFilename(embed.url, embed.thumb?.mime)} onClose={() => setViewing(false)} />
            )}
        </div>
    );
};
