/**
 * A Twitch or TikTok link with the SENDER's preview (phase 4): the clip card
 * (ClipCard.tsx, same as YouTube) with the sender's title, author, tag and
 * thumbnail, and the provider's own player mounted in place ON CLICK.
 *
 * Nothing reaches Twitch or TikTok before play: the card is drawn from the
 * encrypted message. On play the frame URL is built HERE from the embed's
 * `{ provider, id }`, which must match what the visible link itself names
 * (utils/linkEmbeds/players.ts trustedPlayer), on that provider's exact player
 * origin (PLAYER_FRAME_ORIGINS, the same list as the CSP frame-src).
 *
 * Twitch needs `parent=` = this page's host (127.0.0.1 in the packaged app,
 * the Vite host in dev). TikTok is a vertical 9:16 player.
 */
import React from 'react';
import type { LinkEmbed } from '@cipherline/shared';
import { useExclusivePlayback } from './embedPlayback';
import { useEmbedThumb } from './useEmbedThumb';
import { ClipCard } from './ClipCard';
import { useEmbedLayout } from '../../utils/embedPrefs';
import { embeddingHost, playerAspect, playerFrameSrc, type FramePlayerProvider } from '../../utils/linkEmbeds/players';
import { TIKTOK_MIN_WIDTH, pickAspect } from './mediaSize';

const SITE: Record<FramePlayerProvider, { site: string; host: string; noun: string }> = {
    twitch: { site: 'Twitch', host: 'twitch.tv', noun: 'Twitch video' },
    tiktok: { site: 'TikTok', host: 'tiktok.com', noun: 'TikTok video' },
};

export const FramePlayerEmbed: React.FC<{ embed: LinkEmbed; player: { provider: FramePlayerProvider; id: string } }> = ({ embed, player }) => {
    const [playing, claim, release] = useExclusivePlayback();
    const layout = useEmbedLayout();
    const thumb = useEmbedThumb(embed.thumb);
    // A Twitch channel has no frame of its own: its picture is the channel's (sent as the author's icon).
    const icon = useEmbedThumb(embed.thumb ? undefined : embed.author_icon);
    const meta = SITE[player.provider];
    const isChannel = player.provider === 'twitch' && player.id.startsWith('channel:');
    const twitchKind = player.provider === 'twitch' ? player.id.slice(0, player.id.indexOf(':')) : '';
    const noun = twitchKind === 'clip' ? 'Twitch clip' : isChannel ? 'Twitch channel' : meta.noun;
    const title = embed.title || noun;
    const src = playing ? playerFrameSrc(player, embeddingHost()) : null;
    const tags = embed.tag ? [embed.tag] : undefined;
    const byline = [embed.author ?? '', embed.author_handle && embed.author_handle !== `@${embed.author}` ? embed.author_handle : ''];
    // The box's shape (§11): a TikTok or a Twitch clip has the video's own shape (the sender's
    // media size, else its thumbnail's; TikTok is usually 9:16). A Twitch video / channel is
    // Twitch's 16:9 player whatever the picture (a channel's picture is its avatar).
    const shape = player.provider === 'tiktok' || twitchKind === 'clip'
        ? pickAspect({ media: embed.media, thumb: embed.thumb, providerDefault: playerAspect(player.provider) })
        : pickAspect({ provider: playerAspect(player.provider) });
    return (
        <ClipCard
            kind={player.provider}
            url={embed.url}
            layout={layout}
            host={meta.host}
            site={meta.site}
            title={title}
            tags={tags}
            byline={byline}
            thumbUrl={thumb.url ?? icon.url}
            thumbLoading={(!!embed.thumb && !thumb.url && !thumb.failed) || (!embed.thumb && !!embed.author_icon && !icon.url && !icon.failed)}
            color={embed.color}
            playLabel={isChannel ? `Watch ${embed.author ?? 'this channel'} on Twitch` : `Play ${noun}: ${title}`}
            onPlay={claim}
            playing={playing && !!src}
            aspect={shape.aspect}
            aspectKnown={shape.known}
            // TikTok's own player needs 252 px for its control bar (mediaSize.ts).
            minWidth={player.provider === 'tiktok' ? TIKTOK_MIN_WIDTH : undefined}
            onCollapse={release}
            error={playing && !src ? `This ${meta.site} player can't open here.` : null}
            player={src ? (
                <iframe
                    src={src}
                    // Scheme + host only, as for YouTube (the page itself is 'no-referrer').
                    referrerPolicy="strict-origin-when-cross-origin"
                    allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                    allowFullScreen
                    // The frame may run its own scripts in its own origin; it may not navigate us or open popups unasked.
                    sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"
                    title={`${meta.site}: ${title}`}
                />
            ) : null}
        />
    );
};
