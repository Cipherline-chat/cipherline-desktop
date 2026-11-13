/**
 * "Listening to / Watching" -> the link that opens it. Built by the VIEWER,
 * from text it already has, so a sharer can never send friends to an address
 * of their choosing:
 *
 *  - the exact item, when the sharer's player reported its id (`mediaId`,
 *    validated against MEDIA_ID_RE AND its kind + source by readListening):
 *    a Spotify track (Spotify on macOS / Linux) or a YouTube video (a YouTube
 *    / YouTube Music tab in Firefox on Linux). The id is the only part that
 *    came from the sharer; scheme, host and path are fixed here.
 *  - otherwise a SEARCH INSIDE THE PLATFORM it plays on, for "<title> <artist>"
 *    (Windows' media controls, which every Windows player goes through, carry
 *    no URL or id at all - Spotify for Windows included) - but ONLY for
 *    platforms whose search works without being signed in (SEARCH below; each
 *    was fetched signed-out on 2026-10-28 and returned results, not a login
 *    page).
 *  - NO link, and so a row that is not clickable, for everything else: login-
 *    gated services (Netflix, Prime Video, Disney+, Hulu, Plex, Jellyfin,
 *    TIDAL, Amazon Music, Crunchyroll - its search page never rendered signed-
 *    out), local players (VLC, foobar2000...), and a browser tab whose site
 *    could not be identified. There is deliberately NO web-search fallback: a
 *    search engine is not "that item", and the owner asked for none.
 *
 * Every link is https on a fixed host and goes through openExternalLink (the
 * same https/mailto gate as the main process's shell:open-external).
 */
import { MEDIA_ID_RE, SOURCE_LABEL, type ActivityKind, type ActivitySource } from './listening';

export interface ActivityLink {
    url: string;
    /** The accessible name / tooltip: "Open Midnight City on Spotify", "Search YouTube for ...". */
    label: string;
    /** true = the exact song / video; false = a search. */
    exact: boolean;
}

export interface ActivityLinkInput {
    kind: ActivityKind;
    source: ActivitySource;
    /** The song / video title. */
    track: string;
    /** The artist, or (watching) the channel / app name. */
    artist: string;
    mediaId?: string | null;
}

/** Longest search text sent (titles are capped at 120 and artists at 200 on the wire anyway). */
export const SEARCH_MAX = 200;

const enc = encodeURIComponent;
/** For a search term that sits in a PATH segment: a "/" there would be a path separator to some servers, so it becomes a space. */
const encPath = (q: string) => encodeURIComponent(q.replace(/\//g, ' '));

type Search = { name: string; url: (q: string) => string };

/**
 * The platform's own search page, by source - only where it works signed out.
 * Absent = no link at all (see the header).
 */
const SEARCH: Partial<Record<ActivitySource, Search>> = {
    spotify: { name: 'Spotify', url: (q) => `https://open.spotify.com/search/${encPath(q)}` },
    apple_music: { name: 'Apple Music', url: (q) => `https://music.apple.com/search?term=${enc(q)}` },
    youtube_music: { name: 'YouTube Music', url: (q) => `https://music.youtube.com/search?q=${enc(q)}` },
    deezer: { name: 'Deezer', url: (q) => `https://www.deezer.com/search/${encPath(q)}` },
    soundcloud: { name: 'SoundCloud', url: (q) => `https://soundcloud.com/search?q=${enc(q)}` },
    youtube: { name: 'YouTube', url: (q) => `https://www.youtube.com/results?search_query=${enc(q)}` },
    twitch: { name: 'Twitch', url: (q) => `https://www.twitch.tv/search?term=${enc(q)}` },
};

/** The search text: the title, plus the artist / channel unless that is just the app's own name ("Netflix"). */
export function searchText(l: Pick<ActivityLinkInput, 'track' | 'artist' | 'source'>): string {
    const app = SOURCE_LABEL[l.source];
    const by = l.artist && l.artist !== app ? l.artist : '';
    const q = `${l.track} ${by}`.replace(/\s+/g, ' ').trim();
    return q.length > SEARCH_MAX ? q.slice(0, SEARCH_MAX).trim() : q;
}

/** The link for an activity, or null (nothing on the web is that item). */
export function activityLink(l: ActivityLinkInput): ActivityLink | null {
    const id = typeof l.mediaId === 'string' && MEDIA_ID_RE.test(l.mediaId) ? l.mediaId : null;
    if (id?.startsWith('spotify:track:') && l.source === 'spotify' && l.kind === 'listening') {
        return { url: `https://open.spotify.com/track/${id.slice('spotify:track:'.length)}`, label: `Open ${l.track} on Spotify`, exact: true };
    }
    if (id?.startsWith('youtube:')) {
        const v = id.slice('youtube:'.length);
        if (l.source === 'youtube_music' && l.kind === 'listening') return { url: `https://music.youtube.com/watch?v=${v}`, label: `Open ${l.track} on YouTube Music`, exact: true };
        if (l.source === 'youtube' || l.source === 'browser') return { url: `https://www.youtube.com/watch?v=${v}`, label: `Open ${l.track} on YouTube`, exact: true };
    }
    const s = SEARCH[l.source];
    const q = searchText(l);
    if (!s || !q) return null;
    return { url: s.url(q), label: `Search ${s.name} for ${l.track}`, exact: false };
}
