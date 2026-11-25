/**
 * YouTube link → click-to-play facade (docs/plans/embeds.md phase 1).
 *
 * Before: every YouTube link in view mounted the full youtube-nocookie player
 * (~1 MB of Google JavaScript per video per viewer) and its thumbnail only
 * appeared once that had run — "the thumbnail always loads slow".
 *
 * Now the facade is one ~20 KB JPEG from i.ytimg.com, fetched through the main
 * process into the session image cache, plus the title from YouTube's public
 * oEmbed (also via main, best effort). The player iframe mounts only on click,
 * autoplaying, at the link's `?t=` offset; Shorts get a vertical 9:16 frame.
 *
 * One player per chat view: starting another (or an inline video) unmounts
 * this one back to its facade (embedPlayback.ts); Collapse does the same.
 *
 * Look: the compact clip card (ClipCard.tsx, owner's concept "video C").
 *
 * Privacy: with "Load images from links" set to Never, the facade fetches
 * nothing at all (no thumbnail, no title) until play is pressed.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { parseYouTubeLink, youTubeEmbedSrc, youTubeThumbUrls } from '../../utils/youtubeLink';
import { loadYouTubeMeta, peekYouTubeMeta, type YouTubeMeta } from '../../utils/youtubeMeta';
import { usePrivacySettings } from '../../hooks/usePrivacySettings';
import { useExclusivePlayback } from './embedPlayback';
import { useRemoteThumb } from './useRemoteThumb';
import { ClipCard } from './ClipCard';
import { formatClock } from './mediaFrameSize';
import { useEmbedLayout } from '../../utils/embedPrefs';
import type { SenderVideoMeta } from './senderVideoMeta';

/**
 * `sender` (phase 3): the preview the SENDER built inside the encrypted
 * message (title, channel, decrypted thumbnail). With it nothing at all is
 * fetched for the card — no i.ytimg.com thumbnail, no oEmbed — until play.
 */
export const YouTubeEmbed: React.FC<{ url: string; sender?: SenderVideoMeta }> = ({ url, sender }) => {
    const link = useMemo(() => parseYouTubeLink(url), [url]);
    const [playing, claim, release] = useExclusivePlayback();
    const layout = useEmbedLayout();
    const { settings } = usePrivacySettings();
    const fromSender = !!sender;
    const allowFetch = settings.imageAutoLoad !== 'never' && !fromSender;
    const id = link?.id ?? null;

    const thumbUrls = useMemo(() => (id && !fromSender ? youTubeThumbUrls(id) : null), [id, fromSender]);
    const remoteThumb = useRemoteThumb(thumbUrls, allowFetch);
    const thumb = sender ? sender.thumbUrl ?? null : remoteThumb;

    // The answer for THIS id (a cached one shows on the first paint).
    const [loaded, setLoaded] = useState<{ id: string; meta: YouTubeMeta | null } | null>(null);
    const meta = sender?.title ? { title: sender.title, author: sender.author ?? '' }
        : !id || !allowFetch ? null : loaded?.id === id ? loaded.meta : peekYouTubeMeta(id) ?? null;
    useEffect(() => {
        if (!id || !allowFetch) return;
        let cancelled = false;
        const fetchMeta = typeof window !== 'undefined' ? window.electronAPI?.youtubeOEmbed : undefined;
        void loadYouTubeMeta(id, fetchMeta).then((m) => { if (!cancelled) setLoaded({ id, meta: m }); });
        return () => { cancelled = true; };
    }, [id, allowFetch]);

    if (!link) return null;
    const aspect = link.short ? 9 / 16 : 16 / 9;
    const title = meta?.title;
    return (
        <ClipCard
            kind="youtube"
            url={url}
            layout={layout}
            host="youtube.com"
            site="YouTube"
            title={title || 'YouTube video'}
            tags={link.short ? ['Short'] : undefined}
            byline={[meta?.author ?? '', link.start > 0 ? `Starts at ${formatClock(link.start)}` : '']}
            thumbUrl={thumb}
            thumbLoading={sender?.thumbLoading}
            color={sender?.color}
            playLabel={title ? `Play YouTube video: ${title}` : 'Play YouTube video'}
            onPlay={claim}
            playing={playing}
            aspect={aspect}
            onCollapse={release}
            player={playing ? (
                <iframe
                    // Built from the parsed id + offset only, never the message's URL.
                    // origin= is YouTube's documented way for embedders to declare their
                    // parent origin; without it the player falls back to a referer-based
                    // probe that fails under our page-level 'no-referrer' policy.
                    src={youTubeEmbedSrc(link, window.location.origin)}
                    // Scheme+host only (no path) to YouTube, overriding the page-level
                    // 'no-referrer' for this frame alone; without it the embed fails with
                    // "Video player configuration error" (153) in packaged builds.
                    referrerPolicy="strict-origin-when-cross-origin"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                    title={title ? `YouTube: ${title}` : 'YouTube video'}
                />
            ) : null}
        />
    );
};
