/**
 * Inline player for a video link (docs/plans/embeds.md phase 2): a direct file
 * (.mp4/.webm/.mov) or a clip page whose video main resolves (Medal first,
 * then Streamable, Imgur, Tenor, Giphy).
 *
 * Owner decision: videos load on CLICK. Until then this is the compact clip
 * card (ClipCard.tsx, concept "video C") with a dark thumbnail, the file name
 * (or provider) and host: no request of any kind. On click the main process
 * registers the file (direct) or fetches the clip page and reads its video
 * (clip), and hands back a clmedia:// URL that it streams with Range support,
 * so playback starts quickly and seeks. The card grows into the player in
 * place; Collapse returns it to the row.
 *
 * Native controls: volume, fullscreen and picture-in-picture (fullscreen from
 * the app frame is allowed by electron/permission-policy.ts). One playing
 * embed per chat view, shared with the YouTube player: another one starting
 * pauses this one (embedPlayback.ts).
 *
 * When a file cannot play here (no video found on the page, a codec Chromium
 * lacks, an expired link) the card says so and offers "Open in browser".
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CLIP_PROVIDER_LABEL, clipLinkOf, mediaCaption, type ClipProvider } from '../../utils/mediaEmbed/mediaLinks';
import { safeBlobUrl, safeClmediaUrl } from '../../utils/safeMediaUrl';
import { outputSinkRef } from '../../utils/audioOutput';
import { useExclusivePlayback } from './embedPlayback';
import { ClipCard } from './ClipCard';
import { formatClock } from './mediaFrameSize';
import { useEmbedLayout } from '../../utils/embedPrefs';
import type { SenderVideoMeta } from './senderVideoMeta';
import { clampAspect, pickAspect } from './mediaSize';

const CLIP_NOUN: Record<ClipProvider, string> = {
    medal: 'Medal clip',
    streamable: 'Streamable video',
    imgur: 'Imgur video',
    tenor: 'Tenor GIF',
    giphy: 'GIPHY GIF',
};
const CLIP_TAG: Record<ClipProvider, string> = { medal: 'Clip', streamable: 'Video', imgur: 'Video', tenor: 'GIF', giphy: 'GIF' };

type Phase =
    | { phase: 'idle' }
    | { phase: 'loading' }
    | { phase: 'ready'; src: string; autoPlay: boolean; fromSender?: boolean }
    | { phase: 'error'; message: string };

type MediaResult = { ok: true; src: string; width?: number; height?: number; title?: string } | { ok: false };


/**
 * `sender` (phase 3): the preview the SENDER built inside the encrypted
 * message: the real title, author, game, duration and thumbnail, shown with
 * no request at all. For a clip page it may also name the video file the
 * sender found; play then streams that file straight from the provider's own
 * media host (main re-checks the host) with no page fetch, and only if that
 * fails (a signed link that expired) does it fall back to reading the page.
 */
export const VideoLinkEmbed: React.FC<{ url: string; sender?: SenderVideoMeta }> = ({ url, sender }) => {
    const clip = useMemo(() => clipLinkOf(url), [url]);
    const caption = useMemo(() => mediaCaption(url), [url]);
    const ext = useMemo(() => (/\.([a-z0-9]{2,4})$/i.exec(caption.name)?.[1] ?? '').toUpperCase(), [caption.name]);
    const [active, claim, release, holdsNow] = useExclusivePlayback();
    const layout = useEmbedLayout();
    const [state, setState] = useState<Phase>({ phase: 'idle' });
    // The box takes the video's own shape: the sender's media size, else its thumbnail's, else
    // (an older message) the decoded thumbnail's natural size in ClipCard, else 16:9. The file's
    // real size replaces it once known (play).
    const initial = useMemo(() => pickAspect({
        media: { width: sender?.width, height: sender?.height },
        thumb: { width: sender?.thumbWidth, height: sender?.thumbHeight },
    }), [sender?.width, sender?.height, sender?.thumbWidth, sender?.thumbHeight]);
    const [learned, setAspect] = useState<number | null>(null);
    const aspect = learned ?? initial.aspect;
    const [resolvedTitle, setResolvedTitle] = useState<string | null>(null);
    const [duration, setDuration] = useState<number | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    // Sound goes to the user's chosen output device, like every attachment player (utils/audioOutput).
    const attachVideo = useCallback((el: HTMLVideoElement | null) => { videoRef.current = el; outputSinkRef(el); }, []);
    const mounted = useRef(true);
    useEffect(() => () => { mounted.current = false; }, []);

    // Another embed in this chat view started: pause (keep the position).
    useEffect(() => {
        if (!active) videoRef.current?.pause();
    }, [active]);

    const fail = (message: string) => {
        if (!mounted.current) return;
        setState({ phase: 'error', message });
        release();
    };

    // The sender's copy (an expiring link): decrypted on play, then played from the blob: (derived, no effect).
    const [wantCopy, setWantCopy] = useState(false);
    const copy = sender?.copy;
    const copySrc = wantCopy && copy?.url ? safeBlobUrl(copy.url) : undefined;
    const view: Phase = !wantCopy || !copy ? state
        : copySrc ? { phase: 'ready', src: copySrc, autoPlay: true }
            : copy.failed || copy.url ? { phase: 'error', message: "This video's copy couldn't be opened." }
                : { phase: 'loading' };

    const start = async (skipSenderFile = false) => {
        claim();
        setState({ phase: 'loading' });
        if (copy) { setWantCopy(true); copy.request(); return; }
        const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
        let res: MediaResult | undefined;
        let fromSender = false;
        try {
            if (clip && sender?.mediaUrl && !skipSenderFile && api?.registerClipMedia) {
                const r = await api.registerClipMedia(url, sender.mediaUrl);
                if (r.ok) { res = r; fromSender = true; }
            }
            if (!res) res = clip ? await api?.resolveClipMedia?.(url) : await api?.registerMedia?.(sender?.directMedia ?? url, 'video');
        } catch {
            res = undefined;
        }
        if (!mounted.current) return;
        const src = res && res.ok ? safeClmediaUrl(res.src) : undefined;
        if (!res || !res.ok || !src) {
            fail(clip ? `Couldn't find the video on this ${CLIP_PROVIDER_LABEL[clip.provider]} page.` : "This video can't be played here.");
            return;
        }
        if (res.width && res.height) setAspect(clampAspect(res.width / res.height));
        if (typeof res.title === 'string' && res.title) setResolvedTitle(res.title);
        // Still the one the user wants playing? (They may have started another meanwhile.)
        setState({ phase: 'ready', src, autoPlay: holdsNow(), fromSender });
    };

    const collapse = () => {
        videoRef.current?.pause();
        setState({ phase: 'idle' });
        setWantCopy(false);
        release();
    };

    const name = clip ? CLIP_NOUN[clip.provider] : 'video';
    const title = sender?.title ?? resolvedTitle ?? (clip ? CLIP_NOUN[clip.provider] : caption.name);
    const shownDuration = duration ?? sender?.durationS ?? null;
    return (
        <ClipCard
            kind={clip ? 'clip' : 'video'}
            url={url}
            layout={layout}
            host={caption.host}
            site={clip ? CLIP_PROVIDER_LABEL[clip.provider] : caption.host}
            byline={sender?.author ? [sender.author] : clip ? [caption.host] : undefined}
            title={title}
            tags={sender?.tag ? [sender.tag] : clip ? [CLIP_TAG[clip.provider]] : ext ? [ext] : undefined}
            thumbUrl={sender?.thumbUrl ?? undefined}
            thumbLoading={sender?.thumbLoading}
            color={sender?.color}
            duration={shownDuration ? formatClock(shownDuration) : null}
            playLabel={clip ? ((sender?.title ?? resolvedTitle) ? `Play ${name}: ${sender?.title ?? resolvedTitle}` : `Play ${name}`) : `Play video: ${caption.name}`}
            onPlay={() => { void start(); }}
            busy={view.phase === 'loading'}
            error={view.phase === 'error' ? view.message : null}
            playing={view.phase === 'ready'}
            // Size follows the media (§11): the clip's own shape in both layouts, idle and playing.
            aspect={aspect}
            aspectKnown={learned !== null || initial.known}
            onCollapse={collapse}
            player={view.phase === 'ready' ? (
                <video
                    ref={attachVideo}
                    src={view.src}
                    controls
                    autoPlay={view.autoPlay}
                    playsInline
                    preload="metadata"
                    aria-label={title}
                    onPlay={claim}
                    onLoadedMetadata={(e) => {
                        const v = e.currentTarget;
                        if (v.videoWidth && v.videoHeight) setAspect(clampAspect(v.videoWidth / v.videoHeight));
                        if (Number.isFinite(v.duration) && v.duration > 0) setDuration(v.duration);
                    }}
                    onError={() => {
                        // The sender's file link expired (signed URLs last hours): read the page instead, once.
                        if (view.phase === 'ready' && view.fromSender) { void start(true); return; }
                        setWantCopy(false);
                        fail("This video can't be played here. It may have expired, or use a format Cipherline can't play.");
                    }}
                />
            ) : null}
        />
    );
};
