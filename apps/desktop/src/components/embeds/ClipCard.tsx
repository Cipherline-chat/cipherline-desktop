/**
 * The card every click-to-play video embed uses (YouTube incl. Shorts, direct
 * video files, clip pages, Twitch, TikTok). No Discord-style left accent rail,
 * and no outline at all in light themes.
 *
 * Size follows the media (docs/plans/embeds.md §11, owner 2026-11-24): the box
 * has the video's own aspect ratio (mediaSize.ts: the sender's media size, the
 * thumbnail's, or the provider's shape), so there are no side gutters and no
 * letterboxing, and the card is exactly as wide as the media.
 *
 * Look: round-4 direction C, "reel" (concepts/embeds-2026-11-23/round4/C-*,
 * owner: "I like the last one the best for style"):
 *   expanded idle   no surrounding card: the poster IS the embed. The site
 *                   pill and the duration sit at the top over the picture;
 *                   the title and the tags / author line sit over a bottom
 *                   gradient. Clicking anywhere but the title plays.
 *   playing         (both layouts) the player at the same width, and a caption
 *                   strip joins under it (title, site, tags, author, open on
 *                   site, Collapse in compact), so nothing of ours lies on the
 *                   player's own controls (a TikTok / YouTube / Twitch frame
 *                   draws its own chrome; ours is the native video controls).
 *   compact idle    the owner's clip-card row (concept "video C2"): the
 *                   thumbnail in the media's own shape (a 9:16 clip is a tall
 *                   84 × 150 thumbnail, not a 16:9 one), the site pill, title
 *                   and tags beside it. Play grows it into the player.
 * Nothing streams before the click (the caller mounts `player` only then).
 *
 * Always a picture (2026-11-24, embeds-always-thumb): with no thumbnail, or one
 * that decodes to one flat colour (Medal's black first frame), the poster is
 * the designed card picture, drawn here from the site's name (no request).
 */
import React from 'react';
import { Play, ExternalLink, Minimize2 } from 'lucide-react';
import { openExternalLink } from '../../utils/openExternalLink';
import type { EmbedLayout } from '../../utils/embedPrefs';
import { imageLooksFlat, useDesignedPicture } from './useDesignedPicture';
import { MEDIA_CAPS, aspectOf, clampAspect, mediaBox } from './mediaSize';
import '../../styles/link-embeds.css';

/** Generic site badge: never the site's real favicon (that would be a request before any click). */
const SiteBadge: React.FC = () => (
    <svg className="cl-ve-fav" width={16} height={16} viewBox="0 0 16 16" aria-hidden="true">
        <rect width="16" height="16" rx="4.5" fill="var(--cl-raise)" />
        <path d="M6 4.6v6.8L11.4 8z" fill="var(--cl-text)" />
    </svg>
);
const SitePill: React.FC<{ label: string; glass?: boolean }> = ({ label, glass }) => (
    <span className={`cl-ve-site${glass ? ' cl-ve-site--glass' : ''}`}><SiteBadge /><span className="cl-ve-site-name">{label}</span></span>
);

export interface ClipCardProps {
    /** data-embed attribute: 'youtube' | 'video' | 'clip' | 'twitch' | 'tiktok'. */
    kind: string;
    layout: EmbedLayout;
    /** The link as it appears in the message (title link, "open on site"). */
    url: string;
    /** Host shown in "Open on …". */
    host: string;
    site: string;
    title: string;
    tags?: string[];
    /** Small text after the tags: author, "Starts at 0:42", … */
    byline?: string[];
    thumbUrl?: string | null;
    /** The message has a thumbnail that is still being decrypted: no designed picture meanwhile. */
    thumbLoading?: boolean;
    /** The page's colour (`#rrggbb`): the designed picture and the corner glow. */
    color?: string;
    duration?: string | null;
    /** Accessible name of the play button. */
    playLabel: string;
    onPlay: () => void;
    busy?: boolean;
    error?: string | null;
    /** Playing: `player` is mounted in the player area. */
    playing: boolean;
    /** The media's aspect ratio (w / h). */
    aspect: number;
    /**
     * False when `aspect` is only the 16:9 default (an older message with no
     * media size and no thumbnail size): the decoded thumbnail's natural size
     * is used instead once it loads.
     */
    aspectKnown?: boolean;
    /** The narrowest the player may be (TikTok's frame: TIKTOK_MIN_WIDTH). */
    minWidth?: number;
    player?: React.ReactNode;
    /** Compact only: back to the row. */
    onCollapse: () => void;
}

export const ClipCard: React.FC<ClipCardProps> = (p) => {
    // Fades in once THIS src has decoded (a new src starts hidden again).
    const [readySrc, setReadySrc] = React.useState<string | null>(null);
    // A thumbnail that decoded to one flat colour / near-black is no picture.
    const [flatSrc, setFlatSrc] = React.useState<string | null>(null);
    // The decoded thumbnail's own shape, for a message that gave no size at all.
    const [natural, setNatural] = React.useState<{ src: string; aspect: number } | null>(null);
    const realUrl = p.thumbUrl && p.thumbUrl !== flatSrc ? p.thumbUrl : null;
    const thumbReady = !!realUrl && readySrc === realUrl;
    const designedUrl = useDesignedPicture(!thumbReady && !p.thumbLoading ? { label: p.site, color: p.color, play: true } : null);
    const pictureKind = thumbReady ? 'real' : designedUrl ? 'designed' : 'none';
    const openLink = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); openExternalLink(p.url); };
    const expanded = p.layout === 'expanded';
    const open = expanded || p.playing;
    const given = p.aspect > 0 ? clampAspect(p.aspect) : 16 / 9;
    const aspect = p.aspectKnown === false && natural && natural.src === realUrl ? natural.aspect : given;
    const box = mediaBox(aspect, MEDIA_CAPS.expanded, p.minWidth);
    const thumbBox = mediaBox(aspect, MEDIA_CAPS.compactThumb);
    const portrait = aspect < 0.98;
    const by = (p.byline ?? []).filter(Boolean).join(' · ');
    const glow = p.color ? ({ ['--cl-ve-glow' as string]: p.color } as React.CSSProperties) : undefined;

    const title = (lines: 1 | 2 | 3, onPic = false) => (
        <a className={`cl-ve-title cl-ve-clamp-${lines}${onPic ? ' cl-ve-title--on-pic' : ''}`} href={p.url} onClick={openLink} title={p.url}>{p.title}</a>
    );
    const foot = (withSite: boolean) => {
        if (!withSite && !p.tags?.length && !by) return null;
        return (
            <div className="cl-ve-foot">
                {withSite && <SitePill label={p.site} />}
                {p.tags?.map((t) => <span key={t} className="cl-ve-tag">{t}</span>)}
                {by && <span className="cl-ve-byline">{by}</span>}
            </div>
        );
    };
    const playButton = !p.error && (
        <button
            type="button"
            className="cl-ve-play"
            aria-label={p.playLabel}
            aria-busy={!!p.busy}
            title={`${p.playLabel}. Loads from ${p.host} when you press play.`}
            onClick={(e) => { e.stopPropagation(); if (!p.busy) p.onPlay(); }}
        >
            {p.busy ? <span className="cl-ve-spin" /> : <Play className="cl-ve-play-ico" />}
        </button>
    );
    const pictures = (
        <>
            {designedUrl && <img className="cl-ve-frame ready" data-designed="true" src={designedUrl} alt="" draggable={false} />}
            {realUrl && (
                <img
                    className={`cl-ve-frame${thumbReady ? ' ready' : ''}`}
                    src={realUrl}
                    alt=""
                    draggable={false}
                    decoding="async"
                    onLoad={(e) => {
                        const img = e.currentTarget;
                        if (imageLooksFlat(img)) { setFlatSrc(realUrl); return; }
                        const a = aspectOf(img.naturalWidth, img.naturalHeight);
                        if (a) setNatural({ src: realUrl, aspect: clampAspect(a) });
                        setReadySrc(realUrl);
                    }}
                />
            )}
            {(realUrl || designedUrl) && <span className="cl-ve-dim" aria-hidden="true" />}
        </>
    );
    const errorBox = p.error ? (
        <div className="cl-ve-error" role="status">
            <span>{p.error}</span>
            <button type="button" className="cl-ve-pill" onClick={openLink}>Open in browser</button>
        </div>
    ) : null;
    const common = {
        'data-embed': p.kind,
        'data-layout': p.layout,
        'data-picture': pictureKind,
        'data-media-aspect': aspect.toFixed(4),
        // The chat row toggles "save" on click; an embed is its own control.
        onClick: (e: React.MouseEvent) => e.stopPropagation(),
    };

    if (!open) {
        // Compact idle: the clip-card row, the thumbnail in the media's own shape.
        return (
            <div {...common} className={`mt-2 cl-ve cl-ve--row${portrait ? ' cl-ve--portrait' : ''}`} style={glow}>
                <div className="cl-ve-row">
                    <div
                        className="cl-ve-thumb"
                        data-media-box="thumb"
                        style={{ width: thumbBox.width, aspectRatio: String(thumbBox.width / thumbBox.height) }}
                        onClick={() => { if (!p.busy && !p.error) p.onPlay(); }}
                    >
                        {pictures}
                        {playButton}
                        {p.duration && <span className="cl-ve-dur">{p.duration}</span>}
                    </div>
                    <div className="cl-ve-meta">
                        <SitePill label={p.site} />
                        {title(portrait ? 3 : 2)}
                        {errorBox ?? foot(false)}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            {...common}
            className={`mt-2 cl-ve cl-ve--reel cl-ve--open${expanded ? ' cl-ve--expanded' : ''}${p.playing ? ' cl-ve--playing' : ''}`}
            style={{ ...glow, width: box.width }}
        >
            <div
                className="cl-ve-player"
                data-media-box="player"
                style={{ aspectRatio: String(box.width / box.height) }}
                onClick={() => { if (!p.playing && !p.busy && !p.error) p.onPlay(); }}
            >
                {p.playing ? p.player : (
                    <>
                        {pictures}
                        {playButton}
                        <span className="cl-ve-top">
                            <SitePill label={p.site} glass />
                            <span className="cl-ve-grow" />
                            {p.duration && <span className="cl-ve-dur cl-ve-dur--top">{p.duration}</span>}
                        </span>
                        {p.error ? <div className="cl-ve-error-over">{errorBox}</div> : (
                            <span className="cl-ve-cap">
                                {title(2, true)}
                                {(p.tags?.length || by) ? <span className="cl-ve-cap-by">{[...(p.tags ?? []), by].filter(Boolean).join(' · ')}</span> : null}
                            </span>
                        )}
                    </>
                )}
            </div>
            {p.playing && (
                <div className="cl-ve-strip">
                    <div className="cl-ve-text">
                        {title(1)}
                        {foot(true)}
                    </div>
                    <button type="button" className="cl-ve-ibtn" aria-label={`Open on ${p.host}`} title={`Open on ${p.host}`} onClick={openLink}>
                        <ExternalLink />
                    </button>
                    {!expanded && (
                        <button
                            type="button"
                            className="cl-ve-ibtn"
                            aria-label="Collapse player"
                            title="Collapse"
                            onClick={(e) => { e.stopPropagation(); p.onCollapse(); }}
                        >
                            <Minimize2 />
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};
