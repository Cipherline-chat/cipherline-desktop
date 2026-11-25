/**
 * A post card (phase 4): an X / Twitter tweet or a Reddit post, drawn from the
 * SENDER's preview inside the end-to-end encrypted message.
 *
 * What the reader shows, and from where:
 *   - author, handle, text, title, time, score / comments: plain text from the
 *     message, re-validated (sanitizeLinkEmbeds). The text is never HTML; bare
 *     links in it open through openExternalLink (utils/linkEmbeds/postText.ts).
 *   - the author's picture and the post's pictures: the sender's re-encoded
 *     copies, inline or as encrypted attachments on Cipherline's own storage
 *     (useEmbedThumb). Nothing is fetched from X or Reddit to draw the card.
 *   - a video (X video, Reddit v.redd.it): on PLAY only, streamed by main
 *     through clmedia:// from the provider's own media host (video.twimg.com,
 *     v.redd.it; main re-checks it). Reddit's file has no sound: it plays
 *     muted with "Open on Reddit for sound".
 *   - an X GIF: a silent loop under the GIF rules (GifPlayer). It loads only
 *     when images from that host load automatically ("Load images from links"
 *     = Always), otherwise on click; then it plays while the window is focused.
 *   - NSFW (Reddit over_18, X possibly_sensitive) and spoiler posts: the media
 *     is blurred until clicked.
 *
 * Which card: the caller decides from the READER's own parse of the visible
 * link (x.com / twitter.com status → X, reddit.com post → Reddit).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Play, X as XIcon } from 'lucide-react';
import type { EmbedImage, LinkEmbed } from '@cipherline/shared';
import { useEmbedThumb } from './useEmbedThumb';
import { useDesignedPicture } from './useDesignedPicture';
import { useExclusivePlayback } from './embedPlayback';
import { formatClock } from './mediaFrameSize';
import { EmbedPictureViewer } from './EmbedPictureViewer';
import { isLocalPicture, pictureFilename } from './embedPicture';
import { MEDIA_CAPS, mediaBox, pickAspect } from './mediaSize';
import { GifPlayer } from '../GifPlayer';
import { openExternalLink } from '../../utils/openExternalLink';
import { safeClmediaUrl } from '../../utils/safeMediaUrl';
import { outputSinkRef } from '../../utils/audioOutput';
import { shouldAutoLoadImage } from '../../utils/imageHosts';
import { usePrivacySettings } from '../../hooks/usePrivacySettings';
import { GIF_BOX, type EmbedLayout } from '../../utils/embedPrefs';
import { compactCount, postTextParts, type PostProvider } from '../../utils/linkEmbeds/postText';
import { formatDateTime } from '../../utils/a11y/timeFormat';
import '../../styles/sender-embeds.css';
import '../../styles/post-embeds.css';

const SITE: Record<PostProvider, string> = { x: 'X', reddit: 'Reddit' };

const PostText: React.FC<{ text: string }> = ({ text }) => (
    <p className="cl-pe-text">
        {postTextParts(text).map((p, i) => ('url' in p ? (
            <a key={i} href={p.url} title={p.url} onClick={(e) => { e.preventDefault(); e.stopPropagation(); openExternalLink(p.url); }}>{p.url.replace(/^https?:\/\//, '')}</a>
        ) : <React.Fragment key={i}>{p.text}</React.Fragment>))}
    </p>
);

const Avatar: React.FC<{ icon?: EmbedImage; label: string }> = ({ icon, label }) => {
    const pic = useEmbedThumb(icon);
    return (
        <span className="cl-pe-avatar" aria-hidden="true">
            {pic.url ? <img src={pic.url} alt="" draggable={false} /> : (Array.from(label.replace(/^[@ur]\//i, '').trim())[0]?.toUpperCase() ?? '•')}
        </span>
    );
};

const PostImage: React.FC<{ image: EmbedImage; index: number; total: number; url: string; layout: EmbedLayout; onOpen: (src: string, mime: string) => void }> = ({ image, index, total, url, layout, onOpen }) => {
    const pic = useEmbedThumb(image);
    // A single picture is drawn at its own shape (§11): the expanded media box, or the compact picture box.
    const single = total === 1 ? mediaBox(image.width / image.height, layout === 'expanded' ? MEDIA_CAPS.expanded : MEDIA_CAPS.compactPicture) : null;
    return (
        <button
            type="button"
            className="cl-pe-cell"
            aria-label={`Enlarge picture ${index + 1} of ${total}`}
            onClick={(e) => { e.stopPropagation(); if (isLocalPicture(pic.url)) onOpen(pic.url, image.mime); }}
            data-picture-of={url}
            data-picture-open="true"
            data-media-box={single ? 'picture' : undefined}
            data-media-aspect={single ? (image.width / image.height).toFixed(4) : undefined}
            style={single ? { width: '100%', aspectRatio: `${image.width} / ${image.height}` } : undefined}
        >
            {/* width / height reserve the picture's box before it decodes (a single picture keeps its shape). */}
            {pic.url ? <img src={pic.url} alt="" width={image.width} height={image.height} draggable={false} decoding="async" />
                : <span className="cl-pe-ph" style={{ aspectRatio: `${image.width} / ${image.height}` }} />}
        </button>
    );
};

type VideoState = { phase: 'idle' } | { phase: 'loading' } | { phase: 'ready'; src: string } | { phase: 'error' };

/** A post's video (or GIF loop), streamed from the provider's media host only after the click. */
const PostVideo: React.FC<{ embed: LinkEmbed; provider: PostProvider; layout: EmbedLayout; posterUrl: string | null; onWidth: (w: number) => void }> = ({ embed, provider, layout, posterUrl, onWidth }) => {
    const media = embed.media!;
    const [active, claim, release, holdsNow] = useExclusivePlayback();
    const [state, setState] = useState<VideoState>({ phase: 'idle' });
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const attach = useCallback((el: HTMLVideoElement | null) => { videoRef.current = el; outputSinkRef(el); }, []);
    const mounted = useRef(true);
    useEffect(() => () => { mounted.current = false; }, []);
    const { settings } = usePrivacySettings();
    const loop = media.loop === true;
    // A GIF loads like an image from that host does; a video only on click.
    const gifAuto = loop && shouldAutoLoadImage(settings.imageAutoLoad, 'video.twimg.com');

    useEffect(() => { if (!active && !loop) videoRef.current?.pause(); }, [active, loop]);

    const start = useCallback(async () => {
        if (!loop) claim();
        setState({ phase: 'loading' });
        let src: string | undefined;
        try {
            const r = await window.electronAPI?.registerPostMedia?.(embed.url, media.url);
            src = r && r.ok ? safeClmediaUrl(r.src) : undefined;
        } catch { src = undefined; }
        if (!mounted.current) return;
        if (!src) { setState({ phase: 'error' }); if (!loop) release(); return; }
        setState({ phase: 'ready', src });
        if (!loop && !holdsNow()) videoRef.current?.pause();
    }, [claim, release, holdsNow, embed.url, media.url, loop]);

    // Auto-load (GIF rules): started on the next tick, not inside the effect body.
    useEffect(() => {
        if (!gifAuto || state.phase !== 'idle') return;
        const t = setTimeout(() => { void start(); }, 0);
        return () => clearTimeout(t);
    }, [gifAuto, state.phase, start]);

    // Size follows the media (§11): the video's own size, else the poster's (not a designed one), else 16:9.
    const aspect = pickAspect({ media, thumb: embed.thumb }).aspect;
    const open = state.phase === 'ready' || layout === 'expanded';
    const site = SITE[provider];
    // Playing / expanded: the media box; a compact poster: the compact picture box.
    const box = mediaBox(aspect, open ? MEDIA_CAPS.expanded : MEDIA_CAPS.compactPicture);
    // A GIF is sized like the app's other GIFs (GIF_BOX: 240×180 compact, 400×300 expanded).
    const gifBox = GIF_BOX[layout];
    const gifWidth = Math.round(Math.min(gifBox.maxW, gifBox.maxH * aspect));
    // The card sizes itself to this (it hugs its one medium).
    const shownWidth = loop ? gifWidth : box.width;
    useEffect(() => { onWidth(shownWidth); }, [shownWidth, onWidth]);

    if (loop && state.phase === 'ready') {
        return (
            <div className="cl-pe-media" data-post-media="gif" data-media-box="gif" data-media-aspect={aspect.toFixed(4)} style={{ width: '100%' }}>
                <GifPlayer
                    src=""
                    videoSrc={state.src}
                    alt="GIF"
                    wrapperStyle={{ display: 'block', width: '100%' }}
                    imgStyle={{ width: '100%', aspectRatio: String(aspect), objectFit: 'contain', display: 'block' }}
                    onError={() => setState({ phase: 'error' })}
                />
            </div>
        );
    }

    return (
        <>
            <div
                className={`cl-pe-media cl-pe-video${open ? ' cl-pe-video--open' : ''}`}
                data-post-media={loop ? 'gif' : 'video'}
                data-media-box={loop ? 'gif' : 'video'}
                data-media-aspect={aspect.toFixed(4)}
                style={{ ['--cl-pe-aspect' as string]: String(aspect), width: '100%' } as React.CSSProperties}
            >
                {state.phase === 'ready' ? (
                    <video
                        ref={attach}
                        src={state.src}
                        controls
                        autoPlay
                        playsInline
                        muted={media.no_audio === true}
                        preload="metadata"
                        aria-label={embed.title ?? `${site} video`}
                        onPlay={claim}
                        onError={() => { setState({ phase: 'error' }); release(); }}
                    />
                ) : (
                    <>
                        {posterUrl && <img src={posterUrl} alt="" draggable={false} decoding="async" />}
                        {state.phase !== 'error' && (
                            <button
                                type="button"
                                className="cl-pe-play"
                                aria-label={loop ? 'Play GIF' : `Play ${site} video`}
                                aria-busy={state.phase === 'loading'}
                                title={`${loop ? 'Play GIF' : 'Play video'}. Loads from ${provider === 'x' ? 'video.twimg.com' : 'v.redd.it'} when you press play.`}
                                onClick={(e) => { e.stopPropagation(); if (state.phase === 'idle') void start(); }}
                            >
                                {state.phase === 'loading' ? <span className="cl-ve-spin" /> : <Play />}
                            </button>
                        )}
                        {loop ? <span className="cl-pe-badge">GIF</span> : media.duration_s ? <span className="cl-pe-badge">{formatClock(media.duration_s)}</span> : null}
                    </>
                )}
            </div>
            {state.phase === 'error' && (
                <div className="cl-pe-note" role="status">
                    <span>This {loop ? 'GIF' : 'video'} can't be played here.</span>
                    <button type="button" onClick={(e) => { e.stopPropagation(); openExternalLink(embed.url); }}>Open on {site}</button>
                </div>
            )}
            {state.phase === 'ready' && media.no_audio && (
                <div className="cl-pe-note" role="note">
                    <span>Playing without sound.</span>
                    <button type="button" onClick={(e) => { e.stopPropagation(); openExternalLink(embed.url); }}>Open on {site} for sound</button>
                </div>
            )}
        </>
    );
};

export interface PostEmbedCardProps {
    embed: LinkEmbed;
    provider: PostProvider;
    layout: EmbedLayout;
    onRemove?: () => void;
}

export const PostEmbedCard: React.FC<PostEmbedCardProps> = ({ embed, provider, layout, onRemove }) => {
    const [revealed, setRevealed] = useState(false);
    const [lightbox, setLightbox] = useState<{ src: string; mime: string } | null>(null);
    const poster = useEmbedThumb(embed.media ? embed.thumb : undefined);
    const site = SITE[provider];
    // A video with no poster (an older message): the designed picture (no request).
    const designedPoster = useDesignedPicture(embed.media && (!embed.thumb || poster.failed) ? { label: site, color: embed.color, play: true } : null);
    const name = embed.author ?? site;
    const images = embed.images ?? [];
    const veiled = (embed.nsfw || embed.spoiler) && !revealed;
    const hasMedia = !!embed.media || images.length > 0;
    // One video / GIF / picture: the card hugs it (its text wraps to the media's width, 280 px at least).
    const hug = !!embed.media || images.length === 1;
    // Its px width: a picture's box from its own size; a video's (or GIF's) as PostVideo reports it
    // (it grows on play in Compact). The media wrapper is exactly that and the card that plus its
    // padding and border, both capped by the column (explicit widths: a card sized from its
    // content clipped the picture, measured in the real app).
    const [videoWidth, setVideoWidth] = useState<number | null>(null);
    const onVideoWidth = useCallback((w: number) => setVideoWidth(w), []);
    const single = images.length === 1 ? images[0] : null;
    const mediaWidth = embed.media ? videoWidth
        : single ? mediaBox(single.width / single.height, layout === 'expanded' ? MEDIA_CAPS.expanded : MEDIA_CAPS.compactPicture).width : null;
    // The card's width is the media's + its padding and border, 280 px at least (post-embeds.css).
    const hugged = hug && !!mediaWidth;
    const cardStyle = hugged ? ({ ['--cl-pe-mw' as string]: `${mediaWidth}px` } as React.CSSProperties) : undefined;
    const when = embed.published_at ? new Date(embed.published_at) : null;
    const open = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); openExternalLink(embed.url); };

    return (
        <div
            className="mt-2 cl-pe"
            data-embed="post"
            data-provider={provider}
            data-layout={layout}
            data-hug={hugged ? 'true' : undefined}
            style={cardStyle}
            onClick={(e) => e.stopPropagation()}
        >
            <div className="cl-pe-head">
                <Avatar icon={embed.author_icon} label={name} />
                <div className="cl-pe-who">
                    <span className="cl-pe-name">{name}</span>
                    <span className="cl-pe-handle">{[embed.author_handle, site].filter(Boolean).join(' · ')}</span>
                </div>
            </div>
            {embed.title && <a className="cl-pe-title" href={embed.url} onClick={open} title={embed.url}>{embed.title}</a>}
            {embed.description && <PostText text={embed.description} />}
            {hasMedia && (
                <div className={`cl-pe-mediawrap${veiled ? ' cl-pe-veiled' : ''}`} data-veiled={veiled ? 'true' : undefined}
                    style={hugged ? { width: mediaWidth!, maxWidth: '100%' } : undefined}
                    data-n={embed.media ? (embed.media.loop ? 'gif' : 'video') : Math.min(images.length, 4)}>
                    {embed.media
                        ? <PostVideo embed={embed} provider={provider} layout={layout} posterUrl={poster.url ?? designedPoster} onWidth={onVideoWidth} />
                        : (
                            <div className="cl-pe-grid" data-n={Math.min(images.length, 4)}>
                                {images.slice(0, 4).map((img, i) => (
                                    <PostImage key={i} image={img} index={i} total={Math.min(images.length, 4)} url={embed.url} layout={layout} onOpen={(src, mime) => setLightbox({ src, mime })} />
                                ))}
                            </div>
                        )}
                    {veiled && (
                        <button type="button" className="cl-pe-veil" onClick={(e) => { e.stopPropagation(); setRevealed(true); }}
                            aria-label={embed.nsfw ? 'Adult content: show the media' : 'Spoiler: show the media'}>
                            <span>{embed.nsfw ? 'NSFW' : 'Spoiler'} · Click to show</span>
                        </button>
                    )}
                </div>
            )}
            <div className="cl-pe-foot">
                {when && !Number.isNaN(when.getTime()) && (
                    <span title={when.toISOString()}>{formatDateTime(when, undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                )}
                {embed.score !== undefined && <span aria-label={`Score ${embed.score}`}>▲ {compactCount(embed.score)}</span>}
                {embed.comments !== undefined && <span>{compactCount(embed.comments)} comment{embed.comments === 1 ? '' : 's'}</span>}
                <button type="button" className="cl-pe-open" onClick={open} title={embed.url}>
                    Open on {site} <ExternalLink />
                </button>
            </div>
            {onRemove && (
                <button type="button" className="cl-se-remove" aria-label="Remove embed" title="Remove embed"
                    onClick={(e) => { e.stopPropagation(); onRemove(); }}>
                    <XIcon />
                </button>
            )}
            {lightbox && (
                <EmbedPictureViewer src={lightbox.src} pageUrl={embed.url} filename={pictureFilename(embed.url, lightbox.mime)} onClose={() => setLightbox(null)} />
            )}
        </div>
    );
};
