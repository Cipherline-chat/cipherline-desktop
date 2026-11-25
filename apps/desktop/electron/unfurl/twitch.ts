/**
 * Twitch clips, VODs and channels for the sender-side unfurler (pure parsing).
 *
 * Checked LIVE on 2026-11-23 (fixtures __fixtures__/providers/twitch-*.html):
 *   - Twitch has no public oEmbed any more. Its pages are server-rendered for
 *     link previews with OpenGraph + JSON-LD: a clip (clips.twitch.tv/<slug>)
 *     has og:title "<title> - <channel> on Twitch", og:image (1920x1080
 *     thumbnail on static-cdn.jtvnw.net), og:video:duration and a JSON-LD
 *     VideoObject whose creator is the channel; a VOD has the same shape;
 *     a channel has og:title "<channel> - Twitch", the profile picture and a
 *     description.
 *   - The FIRST request for a URL is often answered with the generic app shell
 *     (og:title "Twitch", og:type website, the Twitch logo) and the real page
 *     a moment later: the unfurler retries once (isGenericTwitchShell).
 *   - www.twitch.tv/<ch>/clip/<slug> and m.twitch.tv/clip/<slug> answered the
 *     shell every time; clips.twitch.tv/<slug> answered the real page, so a
 *     clip is always read from clips.twitch.tv.
 *   - Playback: the clip itself is never fetched. Readers play it in Twitch's
 *     own player (clips.twitch.tv/embed, player.twitch.tv), on click.
 */
import type { PageMeta } from './parse-page';
import type { TwitchRef } from './provider-links';

/** Twitch's generic shell instead of the page asked for (no metadata yet). */
export function isGenericTwitchShell(page: PageMeta): boolean {
    return (page.title ?? '').trim().toLowerCase() === 'twitch' && (page.type ?? 'website') === 'website';
}

/** The page to read for a Twitch link. */
export function twitchPageUrl(ref: TwitchRef): string {
    return ref.kind === 'clip' ? `https://clips.twitch.tv/${ref.slug}`
        : ref.kind === 'video' ? `https://www.twitch.tv/videos/${ref.id}`
            : `https://www.twitch.tv/${ref.login}`;
}

export function twitchPageHostAllowed(h: string): boolean {
    return h === 'clips.twitch.tv' || h === 'www.twitch.tv' || h === 'twitch.tv' || h === 'm.twitch.tv';
}
export function twitchImageHostAllowed(h: string): boolean {
    return h === 'static-cdn.jtvnw.net' || h === 'clips-media-assets2.twitch.tv';
}

export interface TwitchFacts { title?: string; author?: string; tag?: string; durationS?: number }

/** "<title> - <channel> on Twitch" → { title, channel }; "<channel> - Twitch" (a channel page) → channel. */
export function twitchFacts(page: PageMeta, ref: TwitchRef, html: string): TwitchFacts {
    const raw = (page.title ?? '').trim();
    let title: string | undefined;
    let author: string | undefined;
    const m = /^(.*\S)\s+-\s+(.{1,40}?)\s+on Twitch$/i.exec(raw);
    if (m) { title = m[1]; author = m[2]; }
    else {
        const c = /^(.{1,40}?)\s+-\s+Twitch$/i.exec(raw);
        if (c) author = c[1];
        else if (raw && raw.toLowerCase() !== 'twitch') title = raw;
    }
    if (!author && ref.kind === 'clip' && ref.channel) author = ref.channel;
    if (!author && ref.kind === 'channel') author = ref.login;
    // Game: the clip description reads "Watch <ch>'s <Game> clip titled …".
    const game = /^Watch .{1,40}?'s (.{1,60}?) clip titled /i.exec(page.description ?? '')?.[1];
    const ogDuration = /<meta[^>]+(?:property|name)=["']og:video:duration["'][^>]*content=["'](\d{1,6})["']|<meta[^>]+content=["'](\d{1,6})["'][^>]*(?:property|name)=["']og:video:duration["']/i.exec(html);
    const d = Number(ogDuration?.[1] ?? ogDuration?.[2] ?? page.durationS ?? 0);
    return {
        ...(title ? { title } : {}),
        ...(author ? { author } : {}),
        ...(game ? { tag: game } : ref.kind === 'channel' ? { tag: 'Channel' } : ref.kind === 'video' ? { tag: 'VOD' } : { tag: 'Clip' }),
        // A channel page lists its VODs in JSON-LD: their lengths are not the channel's.
        ...(ref.kind !== 'channel' && d > 0 && d < 86400 * 2 ? { durationS: d } : {}),
    };
}
