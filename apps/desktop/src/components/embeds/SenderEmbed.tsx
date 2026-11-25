/**
 * Draws a message's SENDER-built link previews (packages/shared
 * link-embeds.ts, docs/plans/embeds.md phase 3).
 *
 * `SenderEmbedList` takes the message's text and its raw `embeds` field and
 * runs the shared validator against the links THIS reader finds in the text
 * (embedUrlsOf): at most five, each tied to a visible link, fields cleaned.
 * A forged embed for a URL that is not in the text is simply not drawn.
 *
 * Per embed:
 *   player (YouTube)   the click-to-play card with the sender's title, channel
 *                      and thumbnail; the player frame is built HERE from the
 *                      link's id (and must match the embed's id), never from
 *                      the message. Nothing reaches Google until play.
 *   video, a GIF host (Tenor, Giphy, Imgur .gifv)   GifLoopEmbed: a GIF, not a
 *                      video (muted loop, no player chrome, the app's GIF
 *                      rules), at the media's REAL shape from the sender's
 *                      width / height, playing the sender's file (no page read).
 *   video (clip page / video file)   the in-place player with the sender's
 *                      title, game, duration and thumbnail; on play, the
 *                      sender's file (provider media hosts only) or the page.
 *   player (Twitch, TikTok, phase 4)   FramePlayerEmbed: the clip card, and
 *                      the provider's own player frame on click, built HERE
 *                      from an id that must match the visible link.
 *   post (X, Reddit, phase 4)   PostEmbedCard: author, text, pictures, the
 *                      video on click; media blurred for NSFW / spoiler.
 *   card               WebEmbedCard (Tile / Island / Ambient, §10).
 *   image (2026-11-24, embeds-media-everywhere)   a picture / GIF at its real
 *                      size: the sender's COPY when the message has one
 *                      (media.file: an expiring link; nothing else loads), a
 *                      KLIPY GIF under KLIPY's opt-in, else the file under the
 *                      image auto-load rule, with the sender's picture shown
 *                      until it loads and if it can't.
 *   video + copy / any-site file   the same players, playing the decrypted copy
 *                      or a same-site file the sender found by its bytes; a
 *                      short silent one is a GIF (GifLoopEmbed).
 *   anything else      today's local embed for that URL (MessageEmbed).
 *
 * Never nothing: every path ends in a picture, a player or the visible link
 * card (LinkFallbackCard), and only a real picture marks itself rendered.
 *
 * A link the sender built no preview for keeps today's behaviour (the caller
 * renders MessageEmbed for it).
 */
import React, { useState } from 'react';
import { isKlipyMediaUrl, type LinkEmbed } from '@cipherline/shared';
import { ImageLinkEmbed } from './MessageEmbed';
import { KlipyLinkEmbed } from '../KlipyGifEmbed';
import { useEmbedMediaCopy } from './useEmbedMediaCopy';
import { isSameSite } from '../../utils/linkEmbeds/sameSite';
import { isKnownImageHost } from '../../utils/imageHosts';
import { X } from 'lucide-react';
import { parseYouTubeLink } from '../../utils/youtubeLink';
import { clipLinkOf, gifLoopMediaHost, isDirectVideoUrl } from '../../utils/mediaEmbed/mediaLinks';
import { GifLoopEmbed } from './GifLoopEmbed';
import { useEmbedThumb } from './useEmbedThumb';
import { WebEmbedCard } from './WebEmbedCard';
import type { EmbedLayout } from './webCardStyle';
import { useEmbedLayout } from '../../utils/embedPrefs';
import { YouTubeEmbed } from './YouTubeEmbed';
import { VideoLinkEmbed } from './VideoLinkEmbed';
import { MessageEmbed } from './MessageEmbed';
import type { SenderVideoMeta } from './senderVideoMeta';
import { FramePlayerEmbed } from './FramePlayerEmbed';
import { PostEmbedCard } from './PostEmbedCard';
import { trustedPlayer } from '../../utils/linkEmbeds/players';
import { redditRefOf, xStatusRefOf } from '../../utils/linkEmbeds/providerLinks';
import { useShowEmbeds } from '../../hooks/usePrivacySettings';
import '../../styles/sender-embeds.css';

const RemoveButton: React.FC<{ onRemove: () => void }> = ({ onRemove }) => (
    <button type="button" className="cl-se-remove" aria-label="Remove embed" title="Remove embed"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}>
        <X />
    </button>
);

export interface SenderEmbedProps { embed: LinkEmbed; layout?: EmbedLayout; onRemove?: () => void }

/** One validated embed. */
/**
 * `layout` defaults to Settings → Appearance → "Compact embeds"
 * (utils/embedPrefs.ts); the video players read the same setting themselves.
 */
const SenderEmbedInner: React.FC<SenderEmbedProps> = ({ embed, layout: layoutProp, onRemove }) => {
    const pref = useEmbedLayout();
    const layout = layoutProp ?? pref;
    // A GIF host's link is a GIF, whatever kind the sender gave it (an older sender sent Tenor as a video).
    const gifLoop = embed.kind === 'video' && !!gifLoopMediaHost(clipLinkOf(embed.url));
    // Only the YouTube / clip players, GIF loops and pictures take the thumbnail from here; the other cards decrypt their own.
    const ownThumb = embed.kind === 'video' || embed.kind === 'image' || embed.player?.provider === 'youtube';
    const thumb = useEmbedThumb(ownThumb ? (embed.kind === 'image' && embed.thumb?.designed ? undefined : embed.thumb) : undefined);
    // The sender's copy of the media (an expiring link): pictures and GIF loops decrypt it
    // when shown; a video when play is pressed.
    const m = embed.media;
    const [playCopy, setPlayCopy] = useState(false);
    const copyNow = !!m?.file && (embed.kind === 'image' || !!m.loop || gifLoop || playCopy);
    const copy = useEmbedMediaCopy(m?.file ? m : undefined, copyNow);
    const video: SenderVideoMeta = {
        title: embed.title,
        author: embed.author,
        tag: embed.tag,
        thumbUrl: thumb.url,
        thumbLoading: ownThumb && !!embed.thumb && !thumb.url && !thumb.failed,
        color: embed.color,
        durationS: embed.media?.duration_s,
        mediaUrl: embed.media?.url,
        width: embed.media?.width,
        height: embed.media?.height,
        thumbWidth: embed.thumb && !embed.thumb.designed ? embed.thumb.width : undefined,
        thumbHeight: embed.thumb && !embed.thumb.designed ? embed.thumb.height : undefined,
    };
    const wrap = (node: React.ReactNode, kind: string) => (
        <div className="cl-sevid" data-sender-embed={kind}>
            {node}
            {onRemove && <RemoveButton onRemove={onRemove} />}
        </div>
    );

    if (embed.kind === 'player' && embed.player?.provider === 'youtube') {
        const link = parseYouTubeLink(embed.url);
        // The reader's own parse of the visible link decides the player; a mismatching id is ignored.
        if (!link || link.id !== embed.player.id) return <MessageEmbed url={embed.url} />;
        return wrap(<YouTubeEmbed url={embed.url} sender={video} />, 'youtube');
    }
    if (embed.kind === 'player') {
        // Twitch / TikTok (phase 4): the id must be the one the visible link names.
        const player = trustedPlayer(embed.url, embed.player);
        if (!player) return <MessageEmbed url={embed.url} />;
        return wrap(<FramePlayerEmbed embed={embed} player={player} />, player.provider);
    }
    if (embed.kind === 'post') {
        // X / Reddit (phase 4): which card follows from the reader's own parse of the link.
        const provider = xStatusRefOf(embed.url) ? 'x' : redditRefOf(embed.url) ? 'reddit' : null;
        if (!provider) return <MessageEmbed url={embed.url} />;
        return <PostEmbedCard embed={embed} provider={provider} layout={layout} onRemove={onRemove} />;
    }
    // Its shape: the media's own size, else (an older message) its thumbnail's.
    const sized = m?.width && m?.height ? { width: m.width, height: m.height } : { width: video.thumbWidth, height: video.thumbHeight };
    if (gifLoop || (embed.kind === 'video' && m?.loop)) {
        // Tenor / Giphy / Imgur, or a short silent video on any site (by its bytes), or its copy.
        return wrap(<GifLoopEmbed url={embed.url} sender={m || embed.thumb ? { mediaUrl: m?.url, ...sized, thumbUrl: thumb.url, ...(m?.file ? { copy } : {}) } : undefined} />, 'gif');
    }
    if (embed.kind === 'image') {
        if (!m) return <MessageEmbed url={embed.url} />;
        const size = sized.width && sized.height ? { w: sized.width, h: sized.height } : undefined;
        const gif = m.mime === 'image/gif' || !!m.animated;
        // KLIPY's GIF (a KLIPY page link): KLIPY's own rules (opt-in, loaded from KLIPY, never stored).
        if (!m.file && isKlipyMediaUrl(m.url)) return wrap(<KlipyLinkEmbed url={m.url} size={size} />, 'klipy');
        // A file the link itself is, or one on its own site / a known image CDN; else no remote load.
        const loadable = m.url === embed.url || isSameSite(embed.url, m.url) || (() => { try { return isKnownImageHost(new URL(m.url).hostname); } catch { return false; } })();
        if (!m.file && !loadable) return <WebEmbedCard embed={embed} layout={layout} onRemove={onRemove} />;
        return wrap(<ImageLinkEmbed url={embed.url} mediaUrl={m.url} gif={gif} size={size} poster={thumb.url} {...(m.file ? { copy } : {})} />, gif ? 'image-gif' : 'image');
    }
    if (embed.kind === 'video') {
        const withCopy: SenderVideoMeta = m?.file ? { ...video, copy: { ...copy, request: () => setPlayCopy(true) } } : video;
        if (clipLinkOf(embed.url) || isDirectVideoUrl(embed.url) || m?.file) return wrap(<VideoLinkEmbed url={embed.url} sender={withCopy} />, 'video');
        // A video file on the link's own site found by its bytes (an extensionless link, a page's og:video).
        if (m?.url && (m.url === embed.url || isSameSite(embed.url, m.url))) return wrap(<VideoLinkEmbed url={embed.url} sender={{ ...video, directMedia: m.url }} />, 'video');
        // A page that is not a known clip host: its card, no player.
        return <WebEmbedCard embed={embed} layout={layout} onRemove={onRemove} />;
    }
    if (embed.kind === 'card') return <WebEmbedCard embed={embed} layout={layout} onRemove={onRemove} />;
    return <MessageEmbed url={embed.url} />;
};

/**
 * One validated embed, unless "Show embeds" is off (Settings → Privacy): then
 * nothing, so no thumbnail is downloaded and nothing plays. Live.
 */
export const SenderEmbed: React.FC<SenderEmbedProps> = (props) => {
    const show = useShowEmbeds();
    return show ? <SenderEmbedInner {...props} /> : null;
};
