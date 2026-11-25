/**
 * The card under a message for one URL in its text (ChatPane's embed row,
 * after theme links and invites are handled there): YouTube facade, inline
 * video (direct files and clip pages), a direct image / GIF, or the plain
 * domain + URL card. Which one is decided by utils/formatting/embedKind.
 *
 * Moved out of ChatPane.tsx unchanged apart from the dispatch (2026-11-23,
 * docs/plans/embeds.md phases 1-2).
 */
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Clock, Bookmark, Image as ImageIcon } from 'lucide-react';
import { isKlipyMediaUrl } from '@cipherline/shared';
import { peekRemoteImage, acquireRemoteImage, releaseRemoteImage, loadRemoteImage, rememberRemoteImageSize, type RemoteImage } from '../../utils/remoteImageCache';
import { inlineImageBox } from '../../utils/inlineImageBox';
import { isGifUrl, shouldAutoLoadImage } from '../../utils/imageHosts';
import { acquireAutoLoadSlot } from '../../utils/autoLoadLimiter';
import { embedKindOf } from '../../utils/formatting/embedKind';
import { usePrivacySettings, useShowEmbeds } from '../../hooks/usePrivacySettings';
import { useGifFavorite } from '../../hooks/useGifFavorite';
import { KlipyLinkEmbed } from '../KlipyGifEmbed';
import { ImageLightbox } from '../ImageLightbox';
import { GifPlayer } from '../GifPlayer';
import { YouTubeEmbed } from './YouTubeEmbed';
import { VideoLinkEmbed } from './VideoLinkEmbed';
import { GifLoopEmbed } from './GifLoopEmbed';
import { GIF_BOX, useEmbedLayout } from '../../utils/embedPrefs';
import { MEDIA_CAPS, mediaBox } from './mediaSize';
import { pictureOpenProps } from './embedPicture';
import { clipLinkOf, gifLoopMediaHost } from '../../utils/mediaEmbed/mediaLinks';
import { tikTokRefOf, twitchPlayerId, twitchRefOf } from '../../utils/linkEmbeds/providerLinks';
import type { FramePlayerProvider } from '../../utils/linkEmbeds/players';
import { FramePlayerEmbed } from './FramePlayerEmbed';
import { LinkFallbackCard } from './LinkFallbackCard';
import '../../styles/link-embeds.css';

/** The minimal web card for a link with no sender preview (nothing is fetched). */
const LocalLinkCard: React.FC<{ url: string }> = ({ url }) => <LinkFallbackCard url={url} />;

/** A Twitch / TikTok player the link itself names (no request needed to know it), or null. */
function localPlayerFor(url: string): { provider: FramePlayerProvider; id: string } | null {
    const tw = twitchRefOf(url);
    if (tw) return { provider: 'twitch', id: twitchPlayerId(tw) };
    const tt = tikTokRefOf(url);
    return tt?.id ? { provider: 'tiktok', id: tt.id } : null;
}

export interface ImageLinkProps {
    /** The link as it appears in the message. */
    url: string;
    /** The file to show when it differs from the link (a page's GIF; sender-built embeds). */
    mediaUrl?: string;
    /** Animated (GifPlayer, the GIF rules). Default: the link ends in .gif. */
    gif?: boolean;
    /** The picture's real size (the sender's), so its box is right from the first paint. */
    size?: { w: number; h: number };
    /** The sender's picture of it (decrypted from the message): shown until the file loads, and when it can't. */
    poster?: string | null;
    /**
     * The sender's COPY of the file (media.file, decrypted): when the message has
     * one, it is all that is ever shown and the link's host is never contacted.
     */
    copy?: { url: string | null; failed: boolean; loading: boolean };
}

/** Renders a direct image/GIF link inline, with a save button for GIFs.
 *
 *  Images are fetched through the Electron main process (net.fetch) so that
 *  CORS restrictions and hotlink-protection headers on third-party hosts never
 *  block either display or save.  The blob URL created on load is reused for
 *  saving, so there is only one network round-trip per image.
 *
 *  NEVER NOTHING (2026-11-24, embeds-media-everywhere; the owner's "invisible
 *  message"): a picture that fails to load or decode (an expired Discord link
 *  answers 404, an "image" link that is really an HTML page, a zero-size
 *  decode) shows the sender's picture when there is one, else the visible
 *  link card (LinkFallbackCard). The wrapper is marked
 *  `data-embed-rendered="media"` only once a real picture is on screen;
 *  ChatPane hides a bare media link's text only then.
 */
export const ImageLinkEmbed: React.FC<ImageLinkProps> = ({ url, mediaUrl, gif, size, poster, copy }) => {
    const src = mediaUrl ?? url;
    const isGif = gif ?? isGifUrl(src);
    const copyMode = !!copy;
    const layout = useEmbedLayout();
    // Seeded from the session image cache (utils/remoteImageCache): an image
    // already fetched this session shows on the first paint of a remount, at
    // its remembered size — no refetch, no skeleton, no layout jump.
    const [entry, setEntry]         = useState<RemoteImage | null>(() => (copyMode ? null : peekRemoteImage(src)));
    const blobUrl = copyMode ? (copy!.url ?? null) : (entry?.url ?? null);
    const blobObj = copyMode ? null : (entry?.blob ?? null);
    const [errored, setErrored]     = useState(false);
    const [decoded, setDecoded]     = useState<{ w: number; h: number } | null>(null);
    const { saved, busy: saving, toggle: toggleFavorite } = useGifFavorite(
        isGif ? blobObj : null,
        src.split('/').pop()?.split('?')[0] || 'image.gif',
    );
    const [lightboxOpen, setLightboxOpen] = useState(false);
    // Bumped once when the picture's size first becomes known (see onImgLoad).
    const [, setSizeKnown] = useState(0);
    // Privacy: do NOT auto-fetch remote URLs from message bodies by default —
    // that would leak a zero-click read-receipt + IP to whoever sent the
    // link. `imageAutoLoad` narrows this per the user's setting: 'known'
    // (default) auto-loads only a curated set of third-party CDNs that
    // aren't the sender and so can't exploit that leak (see utils/
    // imageHosts.ts); 'always'/'never' are the two blunt ends. A click
    // always loads immediately regardless of the setting.
    // Already in memory (fetched earlier this session, by auto-load or a
    // click) → no new request can happen, so nothing to decide.
    const [shouldLoad, setShouldLoad] = useState(() => !copyMode && !!peekRemoteImage(src));
    // Tracks whether the current `shouldLoad=true` came from auto-load
    // (subject to the concurrency limiter below) or a user click (never
    // queued — they're waiting on it right now).
    const autoTriggeredRef = useRef(false);
    const { settings: privacySettings } = usePrivacySettings();

    const hostname = useMemo(() => {
        try { return new URL(src).hostname; } catch { return ''; }
    }, [src]);

    // Decide once per url/setting whether this embed should auto-load.
    useEffect(() => {
        if (copyMode || shouldLoad || errored) return;
        const eligible = shouldAutoLoadImage(privacySettings.imageAutoLoad, hostname);
        if (eligible) {
            autoTriggeredRef.current = true;
            setShouldLoad(true);
        }
        // Only re-evaluate when the URL or the setting changes — `shouldLoad`/
        // `errored` are read, not depended on, to avoid re-arming after a
        // user later flips the setting back while this embed is mounted.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src, hostname, privacySettings.imageAutoLoad, copyMode]);

    // Fetch (after the user opts in, or after an eligible auto-load) via
    // main process to bypass CORS/hotlink. Auto-triggered fetches go
    // through a small concurrency limiter so a busy channel can't fire
    // dozens of simultaneous main-process fetches at once; a manual click
    // always runs immediately.
    useEffect(() => {
        if (!shouldLoad || copyMode) return;
        let cancelled = false;
        let held = false;
        let release: (() => void) | null = null;
        // A hold that arrives after unmount is handed straight back.
        const take = (e: RemoteImage) => {
            if (cancelled) { releaseRemoteImage(src); return; }
            held = true;
            setEntry(e);
        };
        (async () => {
            try {
                const hit = acquireRemoteImage(src);
                if (hit) { take(hit); return; }
                if (autoTriggeredRef.current) {
                    release = await acquireAutoLoadSlot();
                    if (cancelled) return;
                }
                take(await loadRemoteImage(src, (u) => window.electronAPI!.fetchBinary(u)));
            } catch (err) {
                if (!cancelled) {
                    console.warn('[ImageLinkEmbed] Failed to load image:', hostname, err instanceof Error ? err.message : String(err));
                    setErrored(true);
                }
            } finally {
                release?.();
            }
        })();
        return () => {
            cancelled = true;
            // The cache owns the URL now; it is revoked when evicted.
            if (held) releaseRemoteImage(src);
        };
    }, [src, shouldLoad, copyMode, hostname]);
    // Reserve the image's real box once its size is known (320×300 cap,
    // same as the CSS limits below), so a remount doesn't jump. Width +
    // aspect ratio, never a fixed height: the size lands by mutating the cache
    // entry, so the box first appears on the row's NEXT render, and it must lay
    // out exactly like the image without it (utils/inlineImageBox).
    // A GIF is a picture with no frame, sized by the Compact embeds setting (240×180 /
    // 400×300, round 3). Other images: size follows the picture (§11): its own shape
    // inside the media box (expanded: 400 wide .. 448 tall; compact: 320 × 240), never
    // upscaled; until its size is known, the box for an unknown shape. The sender's size
    // (2026-11-24) gives the box from the first paint.
    const known = entry?.width && entry?.height ? { w: entry.width, h: entry.height } : decoded ?? size ?? null;
    const imgAspect = known ? known.w / known.h : 16 / 9;
    const imgBox = mediaBox(imgAspect, layout === 'expanded' ? MEDIA_CAPS.expanded : MEDIA_CAPS.compactPicture);
    const cap = isGif ? GIF_BOX[layout] : { maxW: imgBox.width, maxH: imgBox.height };
    const box = inlineImageBox(known?.w, known?.h, cap.maxW, cap.maxH);
    const failed = errored || (copyMode && copy!.failed);
    const showPoster = !!poster && (!blobUrl || failed);
    const openViewer = (blobUrl && !failed) || showPoster ? pictureOpenProps(isGif ? 'Enlarge GIF' : 'Enlarge image', () => setLightboxOpen(true)) : null;
    const onImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
        const img = e.currentTarget;
        // A "picture" that decodes to nothing is a failure, never a 0×0 box.
        if (!img.naturalWidth || !img.naturalHeight) { setErrored(true); return; }
        const wasKnown = !!known;
        if (!copyMode) rememberRemoteImageSize(src, img.naturalWidth, img.naturalHeight);
        // The cap depends on the picture's shape (size follows the media), so the box must
        // apply NOW, at load, not at some later re-render of the row (which would move the
        // chat then: the save-jump bug inlineImageBox documents).
        setDecoded({ w: img.naturalWidth, h: img.naturalHeight });
        if (!wasKnown) setSizeKnown((n) => n + 1);
    };

    const handleSave = (e: React.MouseEvent) => {
        e.stopPropagation();
        void toggleFavorite();
    };

    // Nothing to show at all: the visible link card (never an empty row).
    if (failed && !poster) return <LinkFallbackCard url={url} reason={isGif ? "Couldn't load this GIF" : "Couldn't load this image"} />;

    const rendered = (blobUrl && !failed && (decoded || entry?.width)) || showPoster;
    const pending = !blobUrl && !failed && (copyMode ? copy!.loading || !copy!.url : shouldLoad);
    const placeholderBox: React.CSSProperties = box
        ? { ...box, maxWidth: '100%', boxSizing: 'border-box' }
        : { width: 200, height: 120 };
    return (
        <div className="mt-2 img-link-wrap" data-embed={isGif ? 'image-gif' : 'image'} data-embed-rendered={rendered ? 'media' : undefined}
            data-copy={copyMode ? (copy!.url ? 'ready' : copy!.failed ? 'failed' : 'loading') : undefined}
            data-cl-copy-image={(blobUrl && !failed ? blobUrl : poster) ?? undefined}
            style={{ position: 'relative', display: 'inline-block', maxWidth: `min(100%, ${cap.maxW}px)` }} data-layout={layout}>
            {/* The sender's picture: until the file loads, or for good when it can't / may not load. */}
            {showPoster && (
                <div style={{ position: 'relative', lineHeight: 0 }}>
                    <img src={poster!} alt="" draggable={false} decoding="async" {...openViewer} data-media-box="picture" data-poster="true"
                        style={{ maxWidth: '100%', maxHeight: cap.maxH, borderRadius: 10, display: 'block', objectFit: 'cover', cursor: 'zoom-in', ...(box ?? {}) }} />
                    {!copyMode && !shouldLoad && !failed && (
                        <button type="button" onClick={(e) => { e.stopPropagation(); setShouldLoad(true); }} title={hostname}
                            className="cl-img-load-chip" aria-label={isGif ? `Play GIF from ${hostname}` : `Load image from ${hostname}`}
                            style={{ position: 'absolute', left: 8, bottom: 8, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'rgb(var(--cl-ve-on-pic))', background: 'rgb(var(--cl-ve-glass) / 0.6)' }}>
                            <ImageIcon className="w-3.5 h-3.5" />{isGif ? 'GIF' : 'Load'}
                        </button>
                    )}
                    {pending && <Clock className="w-5 h-5 animate-pulse" style={{ position: 'absolute', right: 8, bottom: 8, color: 'rgb(var(--cl-ve-on-pic))', opacity: 0.8 }} />}
                </div>
            )}
            {/* Privacy: click-to-load placeholder — no network request until the
                user opts in, so a linked image can't beacon their IP on render. */}
            {!showPoster && !copyMode && !shouldLoad && !blobUrl && (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setShouldLoad(true); }}
                    title={hostname || src}
                    style={{ width: 200, height: 120, borderRadius: 10, background: 'rgb(var(--cl-bright-rgb) / 0.05)', border: '1px solid rgb(var(--cl-bright-rgb) / 0.08)', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'rgb(var(--cl-bright-rgb) / 0.6)' }}
                >
                    <ImageIcon className="w-5 h-5 text-white/40" />
                    <span style={{ fontSize: 12 }}>Load image</span>
                    <span style={{ fontSize: 10, opacity: 0.6, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hostname}</span>
                </button>
            )}
            {/* Skeleton while fetching / decrypting */}
            {!showPoster && pending && (
                <div style={{ ...placeholderBox, borderRadius: 10, background: 'rgb(var(--cl-bright-rgb) / 0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Clock className="w-5 h-5 text-white/30 animate-pulse" />
                </div>
            )}
            {blobUrl && !failed && (isGif ? (
                // Enter / Space on the focused GIF opens it too (the wrapper is the focusable control).
                <div {...openViewer} data-media-box="picture" data-media-aspect={known ? (known.w / known.h).toFixed(4) : undefined} style={{ display: 'block', lineHeight: 0, borderRadius: 10, outlineOffset: 2 }}>
                    <GifPlayer
                        src={blobUrl}
                        imgStyle={{ maxWidth: '100%', maxHeight: cap.maxH, borderRadius: 10, display: 'block', ...(box ?? {}) }}
                        onClick={(e) => { e.stopPropagation(); setLightboxOpen(true); }}
                        onLoadImg={onImgLoad}
                        onError={() => setErrored(true)}
                    />
                </div>
            ) : (
                <img
                    src={blobUrl}
                    alt=""
                    draggable={false}
                    decoding="async"
                    onLoad={onImgLoad}
                    onError={() => setErrored(true)}
                    {...openViewer}
                    data-media-box="picture"
                    data-media-aspect={known ? (known.w / known.h).toFixed(4) : undefined}
                    style={{ maxWidth: '100%', maxHeight: cap.maxH, borderRadius: 10, display: 'block', cursor: 'zoom-in', outlineOffset: 2, ...(box ?? {}) }}
                />
            ))}
            {lightboxOpen && ((blobUrl && !failed) || poster) && (
                <ImageLightbox
                    src={(blobUrl && !failed ? blobUrl : poster)!}
                    externalUrl={url}
                    filename={src.split('/').pop()?.split('?')[0] || 'image'}
                    onClose={() => setLightboxOpen(false)}
                />
            )}
            {/* Save button — GIFs only, revealed on hover. Plain <button>, not
                ClButton — ClButton's `style` prop lands on the outer wrapper
                span, not the inner .cap that actually renders, so shrinking
                below the kit's default 46px silently failed. Sizing/position/
                hover-reveal now live in .img-gif-save-btn (index.css). */}
            {isGif && blobObj && !failed && (
                <button
                    type="button"
                    onClick={handleSave}
                    title={saved ? 'Remove from favorites' : 'Favorite GIF'}
                    aria-label={saved ? 'Remove from favorites' : 'Favorite GIF'}
                    className={`img-gif-save-btn${saved ? ' saved' : ''}${saving ? ' saving' : ''}`}
                >
                    <Bookmark
                        className="w-4 h-4"
                        style={{ color: saved ? '#fff' : '#e5e7eb', fill: saved ? '#fff' : 'none' }}
                    />
                </button>
            )}
        </div>
    );
};

/**
 * The embed for one link in a message, unless "Show embeds" is off
 * (Settings → Privacy): then nothing at all, so no hook of the embed runs and
 * this device makes no request for the link. Live: turning it off unmounts
 * any player that was playing. (The link itself stays in the text, clickable.)
 */
export const MessageEmbed: React.FC<{ url: string }> = ({ url }) => {
    const show = useShowEmbeds();
    return show ? <MessageEmbedInner url={url} /> : null;
};

const MessageEmbedInner: React.FC<{ url: string }> = ({ url }) => {
    const kind = embedKindOf(url);

    // YouTube: a click-to-play facade (thumbnail + title); the player iframe
    // mounts only on click (components/embeds/YouTubeEmbed).
    if (kind === 'youtube') return <YouTubeEmbed url={url} />;

    // A video file, or a clip page (Medal, Streamable, Imgur, Tenor, Giphy):
    // plays in place on click, streamed by main through clmedia://
    // (components/embeds/VideoLinkEmbed). Nothing loads before the click.
    // Tenor / Giphy / Imgur .gifv: GIFs published as muted loops. They behave
    // like GIFs (auto-load like images, play under the GIF rule), not videos.
    if (kind === 'clip' && gifLoopMediaHost(clipLinkOf(url))) return <GifLoopEmbed url={url} />;
    if (kind === 'video' || kind === 'clip') return <VideoLinkEmbed url={url} />;

    // Direct image/GIF link — render inline instead of a link card.
    if (kind === 'image') {
        // KLIPY media links follow KLIPY's rules (opt-in, direct load, no stored bytes).
        if (isKlipyMediaUrl(url)) return <KlipyLinkEmbed url={url} />;
        return <ImageLinkEmbed url={url} />;
    }

    // Twitch / TikTok without a sender preview (an older client, previews off):
    // the click-to-play card built from the link alone; nothing loads before play.
    const local = localPlayerFor(url);
    if (local) return <FramePlayerEmbed embed={{ url, kind: 'player', player: local }} player={local} />;

    // Any other link: the minimal web card (the no-image Tile: the host, its
    // letter, the link's path) built from the link alone; no request, no
    // third-party metadata. The same card a sender attaches when the page gave
    // nothing, so a link looks the same with or without a sender preview.
    return <LocalLinkCard url={url} />;
};
