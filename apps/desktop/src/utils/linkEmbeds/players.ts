/**
 * Third-party players a READER may mount for a sender's embed (phase 4):
 * Twitch and TikTok. docs/plans/embeds.md §4: "the player (iframe) URL is
 * built by the READER from {provider, id}, never taken from the message".
 *
 *   - `playerIdForLink` derives the id from the VISIBLE link, so a message
 *     cannot make a card for one video and play another: an embed whose
 *     `player.id` differs is refused (a short share link, whose id the reader
 *     cannot know without a request, is the one case where the sender's id is
 *     taken, and it is still checked for shape and only ever framed on the
 *     provider's own player origin).
 *   - `playerFrameSrc` builds the frame URL on an exact, allowlisted origin
 *     (PLAYER_FRAME_ORIGINS). The CSP's frame-src in electron/main.ts lists
 *     exactly these origins and nothing wider; players.test.ts checks both.
 *
 * Twitch's embed requires `parent=<the embedding page's host>`; Twitch then
 * answers with `frame-ancestors http(s)://<parent>:*`. The packaged app is
 * served from http://127.0.0.1:<port>/ (main.ts, a loopback server for dist/)
 * and the dev app from the Vite host; both are `window.location.hostname`.
 * Checked live 2026-11-23: parent=127.0.0.1 → `frame-ancestors
 * http://127.0.0.1:* https://127.0.0.1:*`, and the clip played in the real
 * Electron app (worklog entry).
 */
import { isLinkEmbedPlayerId, type LinkEmbedPlayer } from '@cipherline/shared';
import { tikTokRefOf, twitchPlayerId, twitchRefOf } from './providerLinks';

export type FramePlayerProvider = 'twitch' | 'tiktok';

/** The only origins a phase-4 player frame may have. Mirrors the CSP frame-src. */
export const PLAYER_FRAME_ORIGINS: Record<FramePlayerProvider, readonly string[]> = {
    twitch: ['https://clips.twitch.tv', 'https://player.twitch.tv'],
    tiktok: ['https://www.tiktok.com'],
};

export const isFramePlayerProvider = (p: unknown): p is FramePlayerProvider => p === 'twitch' || p === 'tiktok';

/**
 * The player id the visible link names: a string, `null` when the link is a
 * short share link whose target the reader cannot know, or `undefined` when
 * the link is not that provider's at all.
 */
export function playerIdForLink(provider: FramePlayerProvider, url: string): string | null | undefined {
    if (provider === 'twitch') {
        const ref = twitchRefOf(url);
        return ref ? twitchPlayerId(ref) : undefined;
    }
    const ref = tikTokRefOf(url);
    return ref ? ref.id : undefined;
}

/** The embed's player when the reader trusts it for this link; else null (draw no player). */
export function trustedPlayer(url: string, player: LinkEmbedPlayer | undefined): (LinkEmbedPlayer & { provider: FramePlayerProvider }) | null {
    if (!player || !isFramePlayerProvider(player.provider) || !isLinkEmbedPlayerId(player.provider, player.id)) return null;
    const fromLink = playerIdForLink(player.provider, url);
    if (fromLink === undefined) return null;
    if (fromLink !== null && fromLink !== player.id) return null;
    return player as LinkEmbedPlayer & { provider: FramePlayerProvider };
}

const HOST_RE = /^[a-z0-9.-]{1,253}$/;

/** Twitch's `parent`: the page's own host (127.0.0.1 packaged, the Vite host in dev). */
export function embeddingHost(): string | null {
    const h = typeof window !== 'undefined' ? window.location.hostname.toLowerCase() : '';
    return HOST_RE.test(h) ? h : null;
}

/** The frame URL for a trusted player, built here from `{ provider, id }`; null when it cannot be. */
export function playerFrameSrc(player: { provider: FramePlayerProvider; id: string }, parentHost: string | null): string | null {
    if (!isLinkEmbedPlayerId(player.provider, player.id)) return null;
    let src: string;
    if (player.provider === 'twitch') {
        if (!parentHost || !HOST_RE.test(parentHost)) return null;
        const [kind, value] = [player.id.slice(0, player.id.indexOf(':')), player.id.slice(player.id.indexOf(':') + 1)];
        const q = new URLSearchParams({ parent: parentHost, autoplay: 'true' });
        if (kind === 'clip') src = `https://clips.twitch.tv/embed?clip=${encodeURIComponent(value)}&${q}`;
        else if (kind === 'video') src = `https://player.twitch.tv/?video=v${value}&${q}`;
        else src = `https://player.twitch.tv/?channel=${encodeURIComponent(value)}&${q}`;
    } else {
        const q = new URLSearchParams({ autoplay: '1', music_info: '1', description: '1', rel: '0' });
        src = `https://www.tiktok.com/player/v1/${player.id}?${q}`;
    }
    // Defence in depth: whatever was built must sit on that provider's own origin.
    try {
        return PLAYER_FRAME_ORIGINS[player.provider].includes(new URL(src).origin) ? src : null;
    } catch {
        return null;
    }
}

/** The player's natural shape: TikTok is a vertical 9:16 video. */
export function playerAspect(provider: FramePlayerProvider): number {
    return provider === 'tiktok' ? 9 / 16 : 16 / 9;
}
