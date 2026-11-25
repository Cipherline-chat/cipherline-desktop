/**
 * A GIF published as a video loop: Tenor and Giphy pages, Imgur .gifv links
 * (utils/mediaEmbed/mediaLinks gifLoopMediaHost). Owner, 2026-11-23: these
 * behave like GIFs, not like click-to-play videos:
 *   - a picture, not a card: no surface, border or caption, just the media
 *     with rounded corners, up to 240×180 (Compact embeds) or 400×300
 *     (expanded), capped at the column width (utils/embedPrefs GIF_BOX);
 *   - muted, looping, no player controls and no big play button;
 *   - they load like images do: automatically under "Load images from links"
 *     (these CDNs are on the known-host list), otherwise behind "Load GIF";
 *   - they PLAY through the real GifPlayer (its `videoSrc` mode), so the
 *     Animated images setting, reduced motion, window focus, the play badge
 *     and the frozen "GIF" tag are exactly the app's GIF rules.
 *
 * The loop is resolved and streamed by main exactly like a clip
 * (embed:resolve-clip → clmedia://): same SSRF, cookie and referrer rules;
 * only a clmedia:// src from main is ever used (GifPlayer re-checks it).
 *
 * `sender` (2026-11-23 fixes): a SENDER-built preview names the loop's file and
 * its real width / height. Then the box has the GIF's own shape from the
 * first paint (no 4:3 box, no letterboxing), and the file is registered with
 * main straight away (embed:register-clip-media: the provider's media hosts
 * only), so this reader never reads the provider's PAGE; only the media host
 * is contacted, when the GIF loads. A refused or expired file falls back to
 * reading the page once. Without a size (a link with no sender preview) the
 * box is the loop's own size once its first frame's metadata arrives.
 *
 * Always a picture (2026-11-24, embeds-always-thumb): until the loop plays (it
 * is loading, or waits behind "Load GIF"), the box shows the sender's picture
 * of the GIF from the message (no request).
 *
 * Everywhere (2026-11-24, embeds-media-everywhere):
 *   - `sender.copy`: the sender's decrypted COPY of the loop (media.file, an
 *     expiring link such as a Discord CDN attachment). It plays from that blob:
 *     and nothing else loads: no page, no media host.
 *   - a short silent video on ANY site (a direct link decided by its bytes, a
 *     page's og:video), not only Tenor / Giphy / Imgur: the sender's file is
 *     registered as a direct media link (main checks its type), and only when it
 *     is on the link's own site (sameSite.ts). Auto-load follows the image rule
 *     for its host; elsewhere "Load GIF".
 *   - never nothing: a loop that fails shows the sender's picture, else the
 *     visible link card. `data-embed-rendered="media"` once it really plays.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Clock, Image as ImageIcon } from 'lucide-react';
import { clipLinkOf, gifLoopMediaHost } from '../../utils/mediaEmbed/mediaLinks';
import { safeClmediaUrl } from '../../utils/safeMediaUrl';
import { shouldAutoLoadImage } from '../../utils/imageHosts';
import { acquireAutoLoadSlot } from '../../utils/autoLoadLimiter';
import { inlineImageBox } from '../../utils/inlineImageBox';
import { usePrivacySettings } from '../../hooks/usePrivacySettings';
import { GIF_BOX, useEmbedLayout } from '../../utils/embedPrefs';
import { GifPlayer } from '../GifPlayer';
import { isSameSite } from '../../utils/linkEmbeds/sameSite';
import { LinkFallbackCard } from './LinkFallbackCard';
import type { MediaCopyState } from './useEmbedMediaCopy';

type State = { phase: 'idle' } | { phase: 'ready'; src: string } | { phase: 'error' };

export interface GifLoopSender {
    mediaUrl?: string; width?: number; height?: number;
    /** The sender's picture of the GIF (its first good frame, decrypted from the message): shown until the loop plays. */
    thumbUrl?: string | null;
    /** The sender's decrypted copy of the loop (media.file): the only thing played; no host is contacted. */
    copy?: MediaCopyState;
}

export const GifLoopEmbed: React.FC<{ url: string; sender?: GifLoopSender }> = ({ url, sender }) => {
    const link = useMemo(() => clipLinkOf(url), [url]);
    const copy = sender?.copy;
    // A loop on any site: the sender's file, on the link's own site (or the link itself).
    const generic = !link && !!sender?.mediaUrl && isSameSite(url, sender.mediaUrl) ? sender.mediaUrl : undefined;
    const mediaHost = gifLoopMediaHost(link) ?? (generic ? (() => { try { return new URL(generic).hostname; } catch { return null; } })() : null);
    const { settings } = usePrivacySettings();
    const layout = useEmbedLayout();
    const cap = GIF_BOX[layout];
    const autoLoad = !!mediaHost && shouldAutoLoadImage(settings.imageAutoLoad, mediaHost);
    const [clicked, setClicked] = useState(false);
    const wanted = !copy && (autoLoad || clicked);
    const [state, setState] = useState<State>({ phase: 'idle' });
    const [playing, setPlaying] = useState(false);
    const [size, setSize] = useState<{ w: number; h: number } | null>(() => (sender?.width && sender?.height ? { w: sender.width, h: sender.height } : null));
    // The copy: ready when decrypted, failed when it could not be.
    const shown: State = copy ? (copy.url ? { phase: 'ready', src: copy.url } : copy.failed ? { phase: 'error' } : { phase: 'idle' }) : state;

    // Resolve once wanted. Auto-loads share the image limiter; a click does not wait.
    useEffect(() => {
        if (!wanted || (!link && !generic)) return;
        let cancelled = false;
        (async () => {
            let release: (() => void) | null = null;
            try {
                if (!clicked) release = await acquireAutoLoadSlot();
                if (cancelled) return;
                const api = window.electronAPI;
                if (generic) {
                    // Any site: the file as a direct media link (main serves only a real video/* answer).
                    const r = await api?.registerMedia?.(generic, 'video');
                    if (cancelled) return;
                    const src = r && r.ok ? safeClmediaUrl(r.src) : undefined;
                    setState(src ? { phase: 'ready', src } : { phase: 'error' });
                    return;
                }
                // The sender's file first (no page read), then the page.
                if (sender?.mediaUrl && api?.registerClipMedia) {
                    const r = await api.registerClipMedia(url, sender.mediaUrl);
                    if (cancelled) return;
                    const src = r && r.ok ? safeClmediaUrl(r.src) : undefined;
                    if (src) { setState({ phase: 'ready', src }); return; }
                }
                const res = await api?.resolveClipMedia?.(url);
                if (cancelled) return;
                const src = res && res.ok ? safeClmediaUrl(res.src) : undefined;
                if (!res || !res.ok || !src) { setState({ phase: 'error' }); return; }
                if (res.width && res.height) setSize((s) => s ?? { w: res.width!, h: res.height! });
                setState({ phase: 'ready', src });
            } catch {
                if (!cancelled) setState({ phase: 'error' });
            } finally {
                release?.();
            }
        })();
        return () => { cancelled = true; };
        // `clicked` only picks the queue; it must not restart a resolve in flight.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wanted, url, link, generic]);

    const box = inlineImageBox(size?.w, size?.h, cap.maxW, cap.maxH);
    const poster = sender?.thumbUrl ?? null;
    // Nothing that can play here, or it failed: the sender's picture, else the visible link card (never nothing).
    if ((!copy && (!link && !generic)) || (!copy && !mediaHost) || shown.phase === 'error') {
        if (!poster) return <LinkFallbackCard url={url} reason={shown.phase === 'error' ? "Couldn't play this GIF" : undefined} />;
        return (
            <div className="mt-2 cl-gif" data-embed="gif-loop" data-picture="real" data-embed-rendered="media" data-copy={copy ? (copy.failed ? 'failed' : 'loading') : undefined}>
                <img src={poster} alt="" draggable={false} decoding="async" data-gif-poster="true"
                    style={{ ...(box ?? { maxWidth: Math.min(cap.maxW, 240) }), maxWidth: '100%', maxHeight: cap.maxH, borderRadius: 10, display: 'block', objectFit: 'cover' }} />
            </div>
        );
    }
    if (shown.phase !== 'ready') {
        // Known shape (the sender's): the placeholder already has the GIF's box, so nothing jumps.
        const placeholder: React.CSSProperties = {
            ...(box ? { ...box, maxWidth: '100%', boxSizing: 'border-box' } : { width: Math.min(200, cap.maxW), height: Math.min(120, cap.maxH) }),
            borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 6,
            alignItems: 'center', justifyContent: 'center', background: 'rgb(var(--cl-bright-rgb) / 0.05)',
            color: 'rgb(var(--cl-bright-rgb) / 0.6)', border: 'none',
        };
        const posterStyle: React.CSSProperties | undefined = poster ? { position: 'relative', overflow: 'hidden' } : undefined;
        const posterImg = poster ? (
            <img src={poster} alt="" draggable={false} decoding="async" data-gif-poster="true"
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', borderRadius: 10, zIndex: 0 }} />
        ) : null;
        const over = poster ? ({ position: 'relative', zIndex: 1, filter: 'drop-shadow(0 1px 2px rgb(var(--cl-deep-rgb) / 0.7))' } as React.CSSProperties) : undefined;
        return wanted || copy ? (
            <div className="mt-2" data-embed="gif-loop" data-picture={poster ? 'real' : 'none'} data-copy={copy ? 'loading' : undefined} style={{ ...placeholder, ...posterStyle }}>
                {posterImg}
                <Clock className="w-5 h-5 animate-pulse" style={{ opacity: 0.5, ...over }} />
            </div>
        ) : (
            <button
                type="button"
                className="mt-2"
                data-embed="gif-loop"
                data-picture={poster ? 'real' : 'none'}
                style={{ ...placeholder, ...posterStyle, cursor: 'pointer' }}
                onClick={(e) => { e.stopPropagation(); setClicked(true); }}
                title={mediaHost ?? undefined}
            >
                {posterImg}
                <ImageIcon className="w-5 h-5" style={{ opacity: 0.6, ...over }} />
                <span style={{ fontSize: 12, ...over }}>Load GIF</span>
                <span style={{ fontSize: 10, opacity: 0.6, ...over }}>{mediaHost}</span>
            </button>
        );
    }

    return (
        <div className="mt-2 cl-gif" data-embed="gif-loop" data-layout={layout} data-picture="real" data-embed-rendered={playing ? 'media' : undefined}
            data-copy={copy ? 'ready' : undefined} onClick={(e) => e.stopPropagation()}>
            <GifPlayer
                src=""
                videoSrc={shown.src}
                alt="GIF"
                wrapperStyle={{ display: 'block', maxWidth: `min(100%, ${cap.maxW}px)` }}
                // The box is the loop's own shape: the sender's size, else the file's once known
                // (until then its natural size within the cap). Never a fixed 4:3 / 16:9 box.
                imgStyle={{ maxWidth: '100%', maxHeight: cap.maxH, borderRadius: 10, display: 'block', objectFit: 'cover', ...(box ?? {}) }}
                onVideoSize={(w, h) => { setPlaying(true); setSize((s) => (s && Math.abs(s.w / s.h - w / h) < 0.02 ? s : { w, h })); }}
                onError={() => setState({ phase: 'error' })}
            />
        </div>
    );
};
