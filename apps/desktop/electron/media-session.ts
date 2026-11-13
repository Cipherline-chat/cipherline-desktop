// "Listening to ..." — what music THIS machine is playing, read from the
// operating system's own media session. No Spotify (or any other) account,
// no network: the OS already knows what is playing because the music app
// publishes it for the media keys / lock screen.
//
// "Watching ..." comes from the same sessions: each playing session is
// classified as music, a video, or never shared (classifySession). Videos are
// read only when the user has ALSO switched "Also share what I'm watching" on
// (off by default); with it off a video is skipped, never shared as music.
// Browsers report every tab as Music, so a browser tab is judged by what the
// page published (browserKind) - and by its site where that is known: Firefox
// on Linux hands MPRIS the page URL, and on Windows the helper lists the
// playing browser's window titles, whose page title ends with the site
// ("<video> - YouTube - Google Chrome"; browser-site.ts matches them). The site
// gives the right icon and a source such as 'youtube' instead of 'browser'.
//
//   Windows  System Media Transport Controls (WinRT
//            GlobalSystemMediaTransportControlsSessionManager), through ONE
//            long-lived, hidden Windows PowerShell 5.1 child that reads EVERY
//            session only when asked (a line on stdin) and exits when stdin
//            closes. Works for Spotify, Apple Music, TIDAL, Deezer, Amazon
//            Music, foobar2000, browsers, ... — whatever registers a session.
//            No native addon, nothing to rebuild.
//
//            1.0.23 read only GetCurrentSession(): the ONE session Windows
//            considers "current" (the media-key target). That is often not the
//            music: a browser tab, a paused video, or Cipherline itself (call
//            audio plays through <audio>, which Chromium registers as a media
//            session) takes it over, and the reader then saw a non-music app
//            and reported nothing while Spotify played. It also threw the
//            whole answer away when the cover could not be read. Now every
//            session is listed, the playing music one is picked here
//            (pickWindowsSession), and each session / cover fails on its own.
//
//   macOS    AppleScript for the two apps that expose a dictionary (Spotify,
//            Music), only when that app is already RUNNING (checked with
//            pgrep first, so the script never launches it or asks "Where is
//            Spotify?"). MediaRemote (what the menu-bar Now Playing uses) is
//            closed to third-party processes since macOS 15.4, so other
//            players cannot be read reliably. macOS asks the user once for
//            Automation permission ("Cipherline wants to control Spotify"),
//            with the NSAppleEventsUsageDescription purpose string from
//            package.json's mac.extendInfo. A refusal (-1743) is reported
//            (issue: mac_permission) so Settings can say where to allow it,
//            instead of silently showing nothing.
//
//   Linux    MPRIS over the D-Bus session bus, read directly with dbus-native
//            (already a dependency, lazily required): ListNames ->
//            org.mpris.MediaPlayer2.* -> Properties.GetAll on the Player
//            interface. No playerctl needed.
//
// Privacy: this reader runs only while the user has switched sharing on (Settings >
// Connections, off by default; electron/media-watch.ts polls then, from the
// main process, so it keeps working with the window in the background or in
// the tray) or has that pane open. The one look before that is a separate read,
// electron/music-detect.ts: playback state only, no titles, and it answers the
// renderer with a yes or no to offer the switch. What is read never leaves the device except
// the small text record the renderer chooses to publish (title, artist, album,
// app, timing); the cover art travels to the renderer only, for the user's
// OWN view (friends get the music icon and the text).
//
// Covers, per platform (each read once per track, then cached here):
//   Windows  the session's Thumbnail stream (SMTC), read by the helper through
//            reflection on the WinRT stream interfaces (PowerShell 5.1 sees the
//            stream as a bare __ComObject: `.Size` is empty and
//            AsStreamForRead($st) finds no overload, so until 2026-10-28 no cover
//            was ever read on Windows). Each failure is reported per session
//            (artErr) for Settings' "cover:" diagnosis.
//   macOS    Spotify: `artwork url of current track` (an https URL on Spotify's
//            image CDN, i.scdn.co, fetched here - the only host allowed).
//            Music: `raw data of artwork 1 of current track`, written by the
//            script to a private temp file (0700 dir), read and deleted.
//   Linux    mpris:artUrl: a local file:// cover, or Spotify's i.scdn.co URL.
// Every cover must sniff as JPEG/PNG/GIF/WebP and stay under ART_MAX_BYTES.
//
// Child processes: spawned/execFile'd directly, never through a shell, hidden,
// with timeouts. Nothing is logged.

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { siteFromWindowTitles, type SiteKey } from './browser-site';

export type ListenSource =
    | 'spotify' | 'apple_music' | 'youtube_music' | 'tidal' | 'deezer' | 'amazon_music' | 'soundcloud' | 'browser' | 'other';
/** Where a video is playing. Mirrors WATCH_SOURCES in apps/api/src/integrations/listening.ts. */
export type WatchSource =
    | 'youtube' | 'netflix' | 'prime_video' | 'disney_plus' | 'hulu' | 'crunchyroll' | 'twitch' | 'plex' | 'jellyfin' | 'browser' | 'other';
/** "Listening to" (music) or "Watching" (a video, a show, a film). */
export type ActivityKind = 'listening' | 'watching';

export interface NowPlaying {
    kind: ActivityKind;
    source: ListenSource | WatchSource;
    title: string;
    /** Listening: the artist. Watching: the channel, or the app's name when the app gives none ("Netflix", "VLC"). */
    artist: string;
    album: string | null;
    durationMs: number | null;
    positionMs: number | null;
    /** data:image/... cover for the user's own view only, or null. */
    art: string | null;
    /** The app it was read from ("foobar2000", "Chrome"), for the user's own Settings view only. Never published. */
    player: string | null;
    /**
     * Spotify only (macOS / Linux, where Spotify reports its cover as an
     * i.scdn.co URL): the album-cover image id. The one thing about a cover
     * that may be published - the API turns it into a cover it fetches
     * itself, for friends. Never a URL, never bytes.
     */
    artId?: string | null;
    /**
     * The playing item's own id, when the player reports one (MEDIA_ID_RE):
     * `spotify:track:<id>` (Spotify on macOS / Linux) or `youtube:<id>` (a
     * YouTube / YouTube Music tab whose page URL the browser exposes - Firefox
     * on Linux). Published so friends can open that exact song / video; the
     * viewer builds the link, so it is only ever this id, never a URL.
     */
    mediaId?: string | null;
    /**
     * Windows only, for the user's own Settings line ("cover: yes (640x360) /
     * none from app / couldn't read"): what became of this track's cover.
     * Undefined where the reader has nothing to say (macOS, Linux).
     */
    cover?: CoverDiag;
}

/** Codes the Windows helper reports for a cover it could not get (artErr), plus `bad_image` (bytes that are no usable image). */
export const COVER_ERRORS = ['none', 'open_timeout', 'read_failed', 'too_big', 'empty', 'bad_image'] as const;
export type CoverError = (typeof COVER_ERRORS)[number];
/** A cover was read (its original size), or why not. `none` = the app gave no cover at all. */
export type CoverDiag = { ok: true; w?: number; h?: number } | { ok: false; why: CoverError };

/** Why a read came back empty although the platform is supported (shown in Settings > Connections). */
export type MediaIssue =
    /** macOS refused the Apple Event: the user has not allowed (or has denied) Automation for that app. */
    | { kind: 'mac_permission'; app: 'Spotify' | 'Music' }
    /** macOS is still waiting for the user to answer the Automation prompt (the script timed out). */
    | { kind: 'mac_waiting'; app: 'Spotify' | 'Music' }
    /** Windows answered, but its media-controls service could not be reached. */
    | { kind: 'win_unavailable' }
    /** The Windows helper did not answer (it crashed, or is blocked by policy / antivirus). */
    | { kind: 'helper_failed' }
    /**
     * Something IS playing, but only where a switch keeps it out: a browser
     * with "Include my browser" off, or a video with "Also share what I'm
     * watching" off. Lets Settings name the switch instead of "Nothing playing".
     */
    | { kind: 'excluded'; why: 'browser' | 'watching'; player: string | null };

export type UnsupportedReason = 'platform' | 'no_powershell' | 'no_dbus';

/** What the renderer asked for. Watching is its own opt-in (off by default); browsers are another. */
export interface ReadOpts { includeBrowser: boolean; includeWatching: boolean }

export type MediaReadResult =
    | { supported: false; reason: UnsupportedReason }
    | { supported: true; playing: NowPlaying | null; issue: MediaIssue | null };

// ── Pure helpers (unit-tested) ────────────────────────────────────────────

/**
 * The app behind a media session -> a coarse source, or null for apps we do
 * not treat as music (video players, games, unknown apps, Cipherline itself).
 * Matches on the lowercased Windows AppUserModelId / process name, the mac
 * app, or the MPRIS bus-name suffix.
 */
export function classifySource(appId: string): ListenSource | null {
    const a = appId.toLowerCase();
    if (!a) return null;
    if (a.includes('spotify')) return 'spotify';
    if (a.includes('applemusic') || a === 'music' || a === 'apple_music' || a.includes('itunes')) return 'apple_music';
    if (a.includes('youtube-music') || a.includes('youtubemusic') || a.includes('youtube music')) return 'youtube_music';
    if (a.includes('tidal')) return 'tidal';
    if (a.includes('deezer')) return 'deezer';
    if (a.includes('amazonmusic') || a.includes('amazon music')) return 'amazon_music';
    if (a.includes('soundcloud')) return 'soundcloud';
    if (/(^|[^a-z])(chrome|msedge|firefox|brave|opera|vivaldi|chromium)([^a-z]|$)/.test(a) || a === '308046b0af4a39cb') return 'browser';
    if (/(foobar2000|musicbee|aimp|winamp|zunemusic|strawberry|clementine|rhythmbox|lollypop|elisa|audacious|cmus|mpd|quodlibet|amarok|tauon|cider|plexamp)/.test(a)) return 'other';
    return null;
}

// Apps whose sessions are never shared at all: calls, games, streaming software, Cipherline itself.
const NEVER = /(cipherline|discord|steam|teams|zoom|slack|skype|obs)/;
// Video services with their own app: always "Watching". [pattern, source, the name shown when the app gives no channel]
const VIDEO_SERVICES: Array<[RegExp, WatchSource, string]> = [
    [/netflix/, 'netflix', 'Netflix'], [/primevideo|amazonvideo/, 'prime_video', 'Prime Video'],
    [/disney/, 'disney_plus', 'Disney+'], [/hulu/, 'hulu', 'Hulu'], [/crunchyroll/, 'crunchyroll', 'Crunchyroll'],
    [/twitch/, 'twitch', 'Twitch'], [/plex/, 'plex', 'Plex'], [/jellyfin/, 'jellyfin', 'Jellyfin'],
];
/** The service's name, shown as the channel when a tab of that site published none ("Netflix"). */
const WATCH_NAME: Partial<Record<WatchSource, string>> = {
    youtube: 'YouTube', ...Object.fromEntries(VIDEO_SERVICES.map(([, source, name]) => [source, name])),
};
// Video players (they play music files too): [pattern, the name shown when the file gives no artist].
const VIDEO_PLAYERS: Array<[RegExp, string]> = [
    [/vlc/, 'VLC'], [/mpv/, 'mpv'], [/mpc-hc|mpc-be|mpc_hc|mpc_be/, 'MPC'], [/potplayer/, 'PotPlayer'], [/kodi/, 'Kodi'],
    [/zunevideo/, 'Films & TV'], [/totem/, 'Videos'], [/celluloid/, 'Celluloid'], [/smplayer/, 'SMPlayer'], [/haruna/, 'Haruna'],
];
// Installed web apps (PWAs) run under the browser's AUMID with their app id appended
// ("Chrome._crx_<id>"). These are the Chrome Web Store ids of the YouTube and YouTube Music web apps.
const YOUTUBE_PWA = 'agimnkijcaahngcdmfeangaknmldooml';
const YOUTUBE_MUSIC_PWA = 'cinhimbnkkaeohfgghhklpknlkffjgod';
/** Windows MediaPlaybackType: 1 = Music, 2 = Video, 3 = Image (0 / absent = the app did not say). */
const PLAYBACK_MUSIC = 1;
const PLAYBACK_VIDEO = 2;
const PLAYBACK_IMAGE = 3;

/** Everything the reader knows about one playing session. */
export interface SessionFacts {
    /** Windows AUMID / process, MPRIS bus-name suffix, or mac app. */
    app: string;
    title: string | null;
    artist: string | null;
    album: string | null;
    /** Windows MediaPlaybackType (undefined on MPRIS / macOS). */
    ptype?: number;
    /** The cover / thumbnail's width / height; null when there is none or it could not be read. */
    aspect?: number | null;
    /**
     * MPRIS xesam:url: a local file for players such as VLC (used only for its
     * extension), Spotify's https://open.spotify.com/track/<id>, or - Firefox
     * on Linux - the playing tab's page URL (used only for its site and a
     * YouTube video id: pageSite). Never published.
     */
    url?: string | null;
    /** MPRIS mpris:trackid (Spotify: /com/spotify/track/<id>). */
    trackId?: string | null;
    /**
     * A browser tab's site when something other than a page URL identified it
     * (Windows: the browser's window titles, siteOfWindowsSession). Wins over `url`.
     */
    site?: PageSite | null;
}

export type Classified =
    | { kind: 'listening'; source: ListenSource; artist: string; mediaId?: string | null }
    | { kind: 'watching'; source: WatchSource; artist: string; mediaId?: string | null }
    | null;

/** Mirrors MEDIA_ID_RE in apps/api/src/integrations/listening.ts (and src/utils/integrations/listening.ts). */
export const MEDIA_ID_RE = /^(?:spotify:track:[A-Za-z0-9]{22}|youtube:[A-Za-z0-9_-]{11})$/;
const SPOTIFY_TRACK_RE = /^[A-Za-z0-9]{22}$/;
const YOUTUBE_VIDEO_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * A Spotify track reference -> `spotify:track:<id>`, or null. Accepts what
 * Spotify itself reports: `spotify:track:<id>` (macOS `spotify url`),
 * https://open.spotify.com/track/<id> (Linux xesam:url) and the MPRIS object
 * path /com/spotify/track/<id>. Ads, podcast episodes and local files are
 * other kinds and give null.
 */
export function spotifyTrackId(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.length > 200) return null;
    const s = raw.trim();
    let id: string | null = null;
    let m = /^spotify:track:([A-Za-z0-9]+)$/.exec(s) ?? /^\/com\/spotify\/track\/([A-Za-z0-9]+)$/.exec(s);
    if (m) id = m[1];
    else {
        try {
            const u = new URL(s);
            m = u.protocol === 'https:' && u.hostname === 'open.spotify.com' && !u.port && !u.username
                ? /^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?track\/([A-Za-z0-9]+)\/?$/i.exec(u.pathname)
                : null;
            if (m) id = m[1];
        } catch { /* not a URL */ }
    }
    return id && SPOTIFY_TRACK_RE.test(id) ? `spotify:track:${id}` : null;
}

/** What a browser tab's page URL says: the site (as a listening and a watching source) and a YouTube video id. */
export interface PageSite { listen: ListenSource | null; watch: WatchSource | null; mediaId: string | null }

// Exact hosts (after dropping a leading "www." / "m."), so "notyoutube.com" or "youtube.com.evil.example" never match.
const SITES: Record<string, [ListenSource | null, WatchSource | null]> = {
    'youtube.com': [null, 'youtube'], 'youtu.be': [null, 'youtube'], 'music.youtube.com': ['youtube_music', 'youtube'],
    'open.spotify.com': ['spotify', null], 'music.apple.com': ['apple_music', null],
    'listen.tidal.com': ['tidal', null], 'tidal.com': ['tidal', null], 'deezer.com': ['deezer', null],
    'soundcloud.com': ['soundcloud', null], 'netflix.com': [null, 'netflix'], 'primevideo.com': [null, 'prime_video'],
    'disneyplus.com': [null, 'disney_plus'], 'hulu.com': [null, 'hulu'], 'crunchyroll.com': [null, 'crunchyroll'],
    'twitch.tv': [null, 'twitch'], 'app.plex.tv': [null, 'plex'],
};

/**
 * A browser tab's page URL -> its site, or null for any other site. Only
 * Firefox on Linux hands the page URL to the OS (MPRIS xesam:url; never from
 * a private window). Chromium-based browsers and Firefox on Windows publish no
 * URL or origin to the OS media session at all (system_media_controls_win.cc
 * sets only title / artist / album / thumbnail; WindowsSMTCProvider.cpp only
 * title / artist), so there a tab stays 'browser'. The URL itself is read here
 * and dropped: only the site's source value and a YouTube video id are kept.
 */
export function pageSite(raw: unknown): PageSite | null {
    if (typeof raw !== 'string' || raw.length > 2048) return null;
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    const host = u.hostname.toLowerCase().replace(/^(?:www|m)\./, '');
    const site: [ListenSource | null, WatchSource | null] | undefined = /^music\.amazon\.[a-z]{2,3}(?:\.[a-z]{2})?$/.test(host)
        ? ['amazon_music', null]
        : Object.prototype.hasOwnProperty.call(SITES, host) ? SITES[host] : undefined;
    if (!site) return null;
    let video: string | null = null;
    if (host === 'youtu.be') video = u.pathname.split('/')[1] ?? null;
    else if (host === 'youtube.com' || host === 'music.youtube.com') {
        video = u.pathname === '/watch' ? u.searchParams.get('v') : (/^\/(?:shorts|live)\/([^/]+)\/?$/.exec(u.pathname)?.[1] ?? null);
    }
    return { listen: site[0], watch: site[1], mediaId: video && YOUTUBE_VIDEO_RE.test(video) ? `youtube:${video}` : null };
}

/** A site key found from window titles (browser-site.ts) -> the same shape pageSite() gives for a URL. */
export const KEY_SITES: Record<SiteKey, [ListenSource | null, WatchSource | null]> = {
    youtube: [null, 'youtube'], youtube_music: ['youtube_music', null], spotify: ['spotify', null], apple_music: ['apple_music', null],
    tidal: ['tidal', null], deezer: ['deezer', null], amazon_music: ['amazon_music', null], soundcloud: ['soundcloud', null],
    netflix: [null, 'netflix'], prime_video: [null, 'prime_video'], disney_plus: [null, 'disney_plus'], hulu: [null, 'hulu'],
    crunchyroll: [null, 'crunchyroll'], twitch: [null, 'twitch'], plex: [null, 'plex'],
};

/**
 * The site of a playing BROWSER session on Windows, or null (it stays 'browser').
 * Two local signals, nothing is read from the network:
 *  - the artist field, when the page published none of its own and the browser
 *    filled in the page's host ("www.netflix.com"): an origin, so decisive;
 *  - the browser's window titles (the helper lists only the playing browser's
 *    own processes' windows), matched against the session's title: a page title
 *    ends with its site ("<video> - YouTube"). See browser-site.ts for the rules and limits.
 * The titles are used here and dropped: only the site comes out.
 */
export function siteOfWindowsSession(f: { title: string | null; artists: Array<string | null>; wins: readonly string[] }): PageSite | null {
    for (const a of f.artists) {
        if (a && LOOKS_LIKE_HOST.test(a)) {
            const byHost = pageSite(`https://${a.toLowerCase()}/`);
            if (byHost) return byHost;
        }
    }
    const key = f.wins.length ? siteFromWindowTitles(f.title, f.wins) : null;
    if (!key) return null;
    const [listen, watch] = KEY_SITES[key];
    return { listen, watch, mediaId: null };
}

const AUDIO_EXT = /\.(mp3|flac|m4a|aac|ogg|oga|opus|wav|wma|aiff?|ape|wv|mka)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mkv|webm|avi|mov|wmv|flv|mpe?g|ts|m2ts|3gp|ogv|vob)$/i;
/** "youtube.com": what is left in the artist field when a page published no artist of its own. */
const LOOKS_LIKE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * Is a BROWSER session music or a video? The browser cannot tell us:
 * Chromium (components/system_media_controls/win/system_media_controls_win.cc)
 * and Firefox (widget/windows/WindowsSMTCProvider.cpp) both hard-code
 * MediaPlaybackType_Music for every tab, and neither passes the page's URL.
 * So this reads what the PAGE published (navigator.mediaSession metadata):
 *
 *  - an album -> music (YouTube Music, Spotify / Apple Music / Deezer web and
 *    Bandcamp set one; YouTube and video sites do not);
 *  - an artist ending " - Topic" -> music (YouTube's auto-generated music channels);
 *  - the cover's shape: square (within 12%) -> music; anything else (YouTube's
 *    16:9 / 4:3 thumbnails, a portrait Short) -> video;
 *  - no cover we could read -> video. A song shown as "Watching" is a smaller
 *    mistake than a film shown as "Listening to".
 */
export function browserKind(f: Pick<SessionFacts, 'artist' | 'album' | 'aspect'>): ActivityKind {
    if (f.album) return 'listening';
    if (f.artist && / - Topic$/i.test(f.artist)) return 'listening';
    if (typeof f.aspect === 'number' && Number.isFinite(f.aspect) && f.aspect > 0) return Math.abs(f.aspect - 1) <= 0.12 ? 'listening' : 'watching';
    return 'watching';
}

/**
 * One playing session -> what to share it as, or null (never shared).
 * Browsers: browserKind. Apps:
 *  - calls, games, streaming tools, Cipherline: never; Windows says Image: never;
 *  - Windows says Video: watching (any app);
 *  - a video service's app (Netflix, Prime Video, Disney+, Hulu, Crunchyroll,
 *    Twitch, Plex, Jellyfin, the YouTube web app): watching, under the
 *    service's name when it gives no channel;
 *  - a video player (VLC, mpv, MPC, PotPlayer, Kodi, Films & TV, ...): music
 *    when Windows says Music or the file is an audio file; video when it is a
 *    video file; otherwise music only when tagged with an artist AND an album,
 *    else watching under the player's name;
 *  - a music app or any other app: listening.
 * Listening needs a title and an artist; watching a title and a channel or app name.
 */
export function classifySession(f: SessionFacts): Classified {
    const a = f.app.toLowerCase();
    const title = f.title;
    if (!a || !title || NEVER.test(a) || f.ptype === PLAYBACK_IMAGE) return null;
    const artist = f.artist && !LOOKS_LIKE_HOST.test(f.artist) ? f.artist : null;
    const listen = (source: ListenSource): Classified => (artist ? { kind: 'listening', source, artist } : null);
    const watch = (source: WatchSource, name: string | null): Classified => {
        const by = artist ?? name;
        return by ? { kind: 'watching', source, artist: by } : null;
    };
    if (a.includes(YOUTUBE_MUSIC_PWA)) return listen('youtube_music');
    if (a.includes(YOUTUBE_PWA)) return watch('youtube', 'YouTube');
    const music = classifySource(a);
    if (music === 'browser') {
        // The site, where it is known: the page URL (Firefox on Linux) or the window titles (Windows); else just "a browser".
        const site = f.site ?? pageSite(f.url);
        // A site that carries only music (Spotify, SoundCloud...) decides the kind; one that carries only video (YouTube, Netflix,
        // Twitch...) says video unless the page publishes music metadata. The cover's shape (YouTube's thumbnails are sometimes
        // square) only counts for sites that carry both (YouTube Music via a URL) or are not known.
        let kind = browserKind({ artist, album: f.album, aspect: f.aspect });
        if (site?.listen && !site.watch) kind = 'listening';
        else if (site?.watch && !site.listen) kind = browserKind({ artist, album: f.album, aspect: null }); // video, unless the page says music (an album, a " - Topic" channel)
        // The page published no metadata of its own: a bare tab title is not shared - unless the site is a known video site,
        // which then names it ("Watching <title> · Netflix").
        if (!artist && !(kind === 'watching' && site?.watch)) return null;
        const c = kind === 'listening' ? listen(site?.listen ?? 'browser') : watch(site?.watch ?? 'browser', site?.watch ? WATCH_NAME[site.watch] ?? null : null);
        // A YouTube video id, only under YouTube's own sources or a plain browser tab (never under, say, "Spotify").
        const id = site?.mediaId ?? null;
        const fits = !!c && !!id && (c.source === 'browser' || c.source === 'youtube' || c.source === 'youtube_music');
        return c && fits ? { ...c, mediaId: id } : c;
    }
    if (music === 'spotify' && f.ptype !== PLAYBACK_VIDEO) {
        const c = listen('spotify');
        const id = spotifyTrackId(f.url) ?? spotifyTrackId(f.trackId);
        return c && id ? { ...c, mediaId: id } : c;
    }
    const svc = VIDEO_SERVICES.find(([re]) => re.test(a));
    const pl = VIDEO_PLAYERS.find(([re]) => re.test(a));
    if (f.ptype === PLAYBACK_VIDEO) return svc ? watch(svc[1], svc[2]) : watch('other', pl ? pl[1] : music ? playerLabel(a) : null);
    if (music) return listen(music);
    if (svc) return watch(svc[1], svc[2]);
    if (pl) {
        const url = f.url ?? '';
        if (f.ptype === PLAYBACK_MUSIC || AUDIO_EXT.test(url)) return listen('other');
        if (VIDEO_EXT.test(url)) return watch('other', pl[1]);
        if (artist && f.album) return listen('other');
        return watch('other', pl[1]);
    }
    return listen('other');
}

/**
 * Width / height of a JPEG, PNG, GIF or WebP, from its header bytes, or
 * null. Used for one thing: telling a square album cover from a 16:9 video
 * thumbnail (browserKind).
 */
export function imageAspect(buf: Buffer | null): number | null {
    const sz = imageSize(buf);
    return sz ? sz.w / sz.h : null;
}

/** Width and height of a JPEG, PNG, GIF or WebP, from its header bytes, or null. */
export function imageSize(buf: Buffer | null): { w: number; h: number } | null {
    if (!buf || buf.length < 24) return null;
    let w = 0;
    let h = 0;
    try {
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
            w = buf.readUInt32BE(16); h = buf.readUInt32BE(20);
        } else if (buf.subarray(0, 3).toString('latin1') === 'GIF') {
            w = buf.readUInt16LE(6); h = buf.readUInt16LE(8);
        } else if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP' && buf.length >= 30) {
            const chunk = buf.subarray(12, 16).toString('latin1');
            if (chunk === 'VP8 ') { w = buf.readUInt16LE(26) & 0x3fff; h = buf.readUInt16LE(28) & 0x3fff; }
            else if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); w = (b & 0x3fff) + 1; h = ((b >>> 14) & 0x3fff) + 1; }
            else if (chunk === 'VP8X') { w = buf.readUIntLE(24, 3) + 1; h = buf.readUIntLE(27, 3) + 1; }
        } else if (buf[0] === 0xff && buf[1] === 0xd8) {
            let i = 2;
            while (i + 9 < buf.length) {
                if (buf[i] !== 0xff) { i += 1; continue; }
                const m = buf[i + 1];
                if (m === 0xff) { i += 1; continue; }
                if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
                // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC): height, then width.
                if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { h = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7); break; }
                const len = buf.readUInt16BE(i + 2);
                if (len < 2) return null;
                i += 2 + len;
            }
        }
    } catch {
        return null;
    }
    return w > 0 && h > 0 ? { w, h } : null;
}

/** imageAspect of a data: URI (only its head is decoded: a JPEG's frame header can sit after ~60 KB of EXIF / ICC). */
export function dataUriAspect(uri: string | null | undefined): number | null {
    if (!uri) return null;
    const comma = uri.indexOf(',');
    if (comma < 0) return null;
    return imageAspect(Buffer.from(uri.slice(comma + 1, comma + 1 + 87_384), 'base64'));
}

/** "Spotifast" from `C:\...\spotifast.exe`, `spotifast.exe` or `Vendor.App_hash!App`, for the user's own Settings line. */
export function appNameFromId(appId: string): string | null {
    let a = appId.trim();
    const bang = a.lastIndexOf('!');
    if (bang >= 0) { const tail = a.slice(bang + 1); a = tail && tail.toLowerCase() !== 'app' ? tail : a.slice(0, bang).split('_')[0].split('.').pop() ?? ''; }
    a = a.split(/[\\/]/).pop() ?? '';
    a = a.replace(/\.exe$/i, '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40);
    return a ? a[0].toUpperCase() + a.slice(1) : null;
}

/** A short, friendly name for the app, for the user's own Settings line ("Detected: foobar2000 — ..."). */
export function playerLabel(appId: string): string | null {
    const a = appId.toLowerCase();
    const known: Array<[RegExp, string]> = [
        [/spotify/, 'Spotify'], [/applemusic|^music$|apple_music/, 'Apple Music'], [/itunes/, 'iTunes'],
        [/youtube-?music|youtube music/, 'YouTube Music'], [/tidal/, 'TIDAL'], [/deezer/, 'Deezer'],
        [/amazonmusic|amazon music/, 'Amazon Music'], [/soundcloud/, 'SoundCloud'], [/msedge/, 'Edge'],
        [/firefox|^308046b0af4a39cb$/, 'Firefox'], [/brave/, 'Brave'], [/opera/, 'Opera'], [/vivaldi/, 'Vivaldi'],
        [/chromium/, 'Chromium'], [/chrome/, 'Chrome'], [/foobar2000/, 'foobar2000'], [/musicbee/, 'MusicBee'],
        [/aimp/, 'AIMP'], [/winamp/, 'Winamp'], [/zunemusic/, 'Media Player'], [/strawberry/, 'Strawberry'],
        [/clementine/, 'Clementine'], [/rhythmbox/, 'Rhythmbox'], [/lollypop/, 'Lollypop'], [/elisa/, 'Elisa'],
        [/audacious/, 'Audacious'], [/cmus/, 'cmus'], [/mpd/, 'MPD'], [/quodlibet/, 'Quod Libet'], [/amarok/, 'Amarok'],
        [/tauon/, 'Tauon'], [/cider/, 'Cider'], [/plexamp/, 'Plexamp'],
        [/netflix/, 'Netflix'], [/primevideo|amazonvideo/, 'Prime Video'], [/disney/, 'Disney+'], [/hulu/, 'Hulu'],
        [/crunchyroll/, 'Crunchyroll'], [/twitch/, 'Twitch'], [/plex/, 'Plex'], [/jellyfin/, 'Jellyfin'], [/vlc/, 'VLC'],
        [/mpv/, 'mpv'], [/mpc-hc|mpc-be/, 'MPC'], [/potplayer/, 'PotPlayer'], [/kodi/, 'Kodi'], [/zunevideo/, 'Films & TV'],
    ];
    for (const [re, name] of known) if (re.test(a)) return name;
    return null;
}

const clean = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null;
    const s = v.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, max);
    return s || null;
};
const msOrNull = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 24 * 3600_000 ? Math.round(v) : null;

/** Windows' PlaybackStatus enum: 4 = Playing. */
const WIN_PLAYING = 4;
export const ART_MAX_BYTES = 512 * 1024;
/**
 * What the Windows helper may hand over raw. Browsers give Windows the page's
 * artwork re-encoded as a lossless PNG (Chromium's SystemMediaControlsWin:
 * gfx::PNGCodec), so a 640 px album cover is often 0.6-1.5 MB - over
 * ART_MAX_BYTES. Such a cover is shrunk (`shrinkArt`) before anything else sees it.
 */
export const HELPER_ART_MAX_BYTES = 4 * 1024 * 1024;
/**
 * A cover over this size is shrunk too, when a shrinker is there (Spotify's
 * desktop app hands Windows a ~220 KB PNG): it travels to the renderer on
 * every change and sits in its store, and 300 px is plenty. If the shrink
 * fails, a cover within ART_MAX_BYTES is still used as it came.
 */
export const ART_SHRINK_ABOVE_BYTES = 96 * 1024;

/** A JPEG/PNG/GIF/WebP base64 blob -> data: URI (by magic bytes), else null. */
export function artDataUri(b64: unknown): string | null {
    if (typeof b64 !== 'string' || !b64 || b64.length > Math.ceil(ART_MAX_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
    const head = Buffer.from(b64.slice(0, 24), 'base64');
    let type: string | null = null;
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) type = 'image/jpeg';
    else if (head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) type = 'image/png';
    else if (head.subarray(0, 3).toString('latin1') === 'GIF') type = 'image/gif';
    else if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') type = 'image/webp';
    return type ? `data:${type};base64,${b64}` : null;
}

/**
 * A cover from the Windows helper -> data: URI, or null. A cover within
 * ART_MAX_BYTES is used as is; a bigger JPEG/PNG (up to HELPER_ART_MAX_BYTES)
 * only through `shrink` (main.ts: nativeImage, longest side 300 px, JPEG),
 * and only if the result fits ART_MAX_BYTES.
 */
export function helperArt(raw: unknown, shrink?: (bytes: Buffer) => Buffer | null): string | null {
    const direct = artDataUri(raw);
    if (!shrink || typeof raw !== 'string' || !raw) return direct;
    if (direct && raw.length <= Math.ceil(ART_SHRINK_ABOVE_BYTES * 4 / 3)) return direct;
    if (raw.length > Math.ceil(HELPER_ART_MAX_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
    const bytes = Buffer.from(raw, 'base64');
    const png = bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!png && !jpeg) return direct;
    let out: Buffer | null = null;
    try { out = shrink(bytes); } catch { out = null; }
    return (out && out.length > 0 && out.length <= ART_MAX_BYTES ? artDataUri(out.toString('base64')) : null) ?? direct;
}

/** The size of a cover the helper sent (base64), from its header, before any shrink. */
export function rawArtSize(raw: unknown): { w: number; h: number } | null {
    if (typeof raw !== 'string' || !raw) return null;
    // Only the head is decoded (a JPEG's frame header can sit after ~60 KB of EXIF / ICC); a whole number of base64 quads.
    const head = raw.slice(0, 87_384);
    return imageSize(Buffer.from(head.slice(0, head.length - (head.length % 4)), 'base64'));
}

export const trackKeyOf = (app: string, title: string, artist: string) => `${app}|${title}|${artist}`;

export interface WindowsPick {
    /** null = nothing playing that counts as music (or browsers are off). */
    playing: NowPlaying | null;
    /** The chosen session's track key (the cover cache key), or null. */
    key: string | null;
    /** Covers sent in this answer, by track key (the helper sends one only when a session's track changes). */
    arts: Map<string, string>;
    /** What this answer says about covers, by track key: read (original size) or why not (the helper's artErr). */
    diags: Map<string, CoverDiag>;
    /** The helper answered `ok:false`: the media-controls service could not be reached. */
    unavailable: boolean;
    /** Nothing picked, but something played that a switch keeps out (Settings names that switch). */
    excluded?: { why: 'browser' | 'watching'; player: string | null } | null;
}

const isCoverError = (v: unknown): v is CoverError => typeof v === 'string' && (COVER_ERRORS as readonly string[]).includes(v);

/**
 * One JSON line from the Windows helper -> the session to show.
 *
 * The helper lists every session (`sessions`) plus the AUMID of Windows'
 * "current" one (`cur`). Only PLAYING sessions count, classified by
 * classifySession (browsers only when asked; videos only when asked, and a
 * video is then simply skipped, never shared as music). Among those a
 * dedicated music app wins, then any other player, then a video app, then a
 * browser; Windows' current session, then Windows' own order break ties.
 * `now` adjusts the position for the time since Windows last updated it.
 * `artFor` returns a cover the reader already holds for a track key (the
 * helper sends each cover only once), so a browser tab's thumbnail shape
 * keeps counting after the first answer.
 */
export function pickWindowsSession(
    line: string,
    opts: { includeBrowser: boolean; includeWatching?: boolean; now: number; artFor?: (key: string) => string | null; shrink?: (bytes: Buffer) => Buffer | null },
): WindowsPick {
    const none: WindowsPick = { playing: null, key: null, arts: new Map(), diags: new Map(), unavailable: false };
    let o: Record<string, unknown>;
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { return none; }
    if (!o || typeof o !== 'object') return none;
    if (o.ok !== true) return { ...none, unavailable: true };
    const list = Array.isArray(o.sessions) ? o.sessions.slice(0, 32) : [];
    const cur = typeof o.cur === 'string' ? o.cur : '';
    const arts = new Map<string, string>();
    const diags = new Map<string, CoverDiag>();
    type Cand = { p: NowPlaying; key: string; app: string; rank: number };
    const cands: Cand[] = [];
    let excluded: WindowsPick['excluded'] = null;
    list.forEach((raw, i) => {
        const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
        if (!s) return;
        const app = typeof s.app === 'string' ? s.app.slice(0, 300) : '';
        const title = clean(s.title, 120);
        const rawArtist = clean(s.artist, 200) ?? clean(s.albumArtist, 200);
        // The cover cache key uses what the session itself reported (before any app-name fallback).
        const key = trackKeyOf(app, title ?? '', rawArtist ?? '');
        const sent = title ? helperArt(s.art, opts.shrink) : null;
        if (sent) arts.set(key, sent);
        if (title) {
            const size = sent ? rawArtSize(s.art) : null;
            if (sent) diags.set(key, size ? { ok: true, ...size } : { ok: true });
            else if (typeof s.art === 'string' && s.art) diags.set(key, { ok: false, why: 'bad_image' });
            else if (isCoverError(s.artErr)) diags.set(key, { ok: false, why: s.artErr });
        }
        if (s.status !== WIN_PLAYING) return;
        const album = clean(s.album, 120);
        // A browser tab: its site, from the window titles the helper listed (used here, never kept).
        const wins = Array.isArray(s.wins) ? s.wins.slice(0, 32).filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 400)) : [];
        const site = classifySource(app) === 'browser' && opts.includeBrowser
            ? siteOfWindowsSession({ title, artists: [clean(s.artist, 200), clean(s.albumArtist, 200)], wins })
            : null;
        const c = classifySession({
            app, title, artist: rawArtist, album, ptype: typeof s.ptype === 'number' ? s.ptype : undefined,
            aspect: dataUriAspect(sent ?? opts.artFor?.(key) ?? null), site,
        });
        if (!c || !title) return;
        const browser = classifySource(app) === 'browser';
        const player = playerLabel(app) ?? appNameFromId(app);
        if (browser && !opts.includeBrowser) { excluded ??= { why: 'browser', player }; return; }
        if (c.kind === 'watching' && !opts.includeWatching) { excluded ??= { why: 'watching', player }; return; }
        const dur = msOrNull(s.dur);
        let pos = typeof s.pos === 'number' && Number.isFinite(s.pos) && s.pos >= 0 ? s.pos : null;
        const upd = typeof s.upd === 'number' && Number.isFinite(s.upd) && s.upd > 0 ? s.upd : null;
        if (pos !== null && upd !== null && upd <= opts.now) pos += opts.now - upd;
        if (pos !== null && dur !== null) pos = Math.min(pos, dur);
        // A known music app, then any other player, then a video app, then a browser; Windows' current session breaks ties.
        const rank = (browser ? 20 : c.kind === 'watching' ? 15 : classifySource(app) ? 0 : 10) + (app === cur ? 0 : 5) + i / 100;
        cands.push({
            p: {
                kind: c.kind, source: c.source, title, artist: c.artist, album: c.kind === 'listening' ? album : null,
                durationMs: dur, positionMs: pos !== null ? Math.round(pos) : null, art: null, player,
            },
            key, app, rank,
        });
    });
    cands.sort((a, b) => a.rank - b.rank);
    const best = cands[0];
    return best ? { playing: best.p, key: best.key, arts, diags, unavailable: false } : { ...none, arts, diags, excluded };
}

/** macOS script output: `source<TAB>title<TAB>artist<TAB>album<TAB>durationMs<TAB>positionMs[<TAB>spotify url]`. */
export function parseMacOutput(out: string): NowPlaying | null {
    const f = out.replace(/\r?\n$/, '').split('\t');
    if (f.length < 6) return null;
    const source = f[0] === 'spotify' ? 'spotify' : f[0] === 'apple_music' ? 'apple_music' : null;
    const title = clean(f[1], 120);
    const artist = clean(f[2], 200);
    if (!source || !title || !artist) return null;
    const dur = msOrNull(Number(f[4]));
    const pos = Number(f[5]);
    const mediaId = source === 'spotify' ? spotifyTrackId(f[6]) : null;
    return {
        kind: 'listening', source, title, artist, album: clean(f[3], 120), durationMs: dur,
        positionMs: Number.isFinite(pos) && pos >= 0 ? Math.round(dur ? Math.min(pos, dur) : pos) : null,
        art: null, player: source === 'spotify' ? 'Spotify' : 'Apple Music',
        ...(mediaId ? { mediaId } : {}),
    };
}

/** An osascript failure -> what it means for Settings. */
export function macScriptIssue(err: { killed?: boolean; signal?: string | null; code?: unknown } | null, stderr: string, app: 'Spotify' | 'Music'): MediaIssue | null {
    if (!err) return null;
    // -1743 errAEEventNotPermitted: Automation not allowed (denied, or the purpose string / entitlement is missing).
    if (/-1743\b|not authori[sz]ed to send apple events/i.test(stderr)) return { kind: 'mac_permission', app };
    // The prompt is up and nobody has answered it yet: osascript waits, our timeout kills it.
    if (err.killed || err.signal === 'SIGTERM') return { kind: 'mac_waiting', app };
    return null; // -600 "isn't running" (quit between pgrep and the script) and the like: just nothing playing
}

/** An MPRIS value that may come back as a bigint (int64 / uint64), a number, or not at all. */
const num = (v: unknown): number | null => {
    if (typeof v === 'bigint') return Number(v);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

export interface MprisPlayer {
    /** The bus name suffix after org.mpris.MediaPlayer2. ("spotify", "chromium.instance42"). */
    name: string;
    /** Properties.GetAll("org.mpris.MediaPlayer2.Player"), as plain JS (dbus-native toPlain). */
    props: Record<string, unknown>;
}

/**
 * The PLAYING player to show among MPRIS players, classified by
 * classifySession (browsers only when asked, videos only when asked; a video
 * is then skipped, never shared as music). A music app wins, then any other
 * player, then a video app, then a browser. Lengths and positions are
 * microseconds on the wire. `aspectOf` reads the shape of a local cover
 * (browsers write the page's artwork to a file:// path), for browserKind.
 */
export function pickMpris(
    players: MprisPlayer[],
    o: boolean | { includeBrowser: boolean; includeWatching?: boolean; aspectOf?: (artUrl: string | null) => number | null },
): { playing: NowPlaying; artUrl: string | null } | null {
    const opts = typeof o === 'boolean' ? { includeBrowser: o } : o;
    let best: { hit: { playing: NowPlaying; artUrl: string | null }; rank: number } | null = null;
    players.forEach((pl, i) => {
        const p = pl.props;
        if (p.PlaybackStatus !== 'Playing') return;
        const browser = classifySource(pl.name) === 'browser';
        if (browser && !opts.includeBrowser) return;
        const md = p.Metadata && typeof p.Metadata === 'object' ? (p.Metadata as Record<string, unknown>) : {};
        const title = clean(md['xesam:title'], 120);
        const artists = Array.isArray(md['xesam:artist']) ? md['xesam:artist'] : typeof md['xesam:artist'] === 'string' ? [md['xesam:artist']] : [];
        const artist = clean(artists.filter((x) => typeof x === 'string').join(', '), 200) ?? clean(Array.isArray(md['xesam:albumArtist']) ? md['xesam:albumArtist'][0] : md['xesam:albumArtist'], 200);
        const album = clean(md['xesam:album'], 120);
        const artUrl = typeof md['mpris:artUrl'] === 'string' ? md['mpris:artUrl'] : null;
        const c = classifySession({
            app: pl.name, title, artist, album, url: typeof md['xesam:url'] === 'string' ? md['xesam:url'] : null,
            trackId: typeof md['mpris:trackid'] === 'string' ? md['mpris:trackid'] : null,
            aspect: browser && !album ? opts.aspectOf?.(artUrl) ?? null : null,
        });
        if (!c || !title) return;
        if (c.kind === 'watching' && !opts.includeWatching) return;
        const lenUs = num(md['mpris:length']);
        const posUs = num(p.Position);
        const dur = lenUs !== null ? msOrNull(lenUs / 1000) : null;
        const pos = posUs !== null && posUs >= 0 ? Math.round(posUs / 1000) : null;
        const rank = (browser ? 20 : c.kind === 'watching' ? 15 : classifySource(pl.name) ? 0 : 10) + i / 100;
        if (best && best.rank <= rank) return;
        best = {
            rank,
            hit: {
                playing: {
                    kind: c.kind, source: c.source, title, artist: c.artist, album: c.kind === 'listening' ? album : null, durationMs: dur,
                    positionMs: pos !== null && dur !== null ? Math.min(pos, dur) : pos, art: null, player: playerLabel(pl.name) ?? appNameFromId(pl.name),
                    ...(c.mediaId && MEDIA_ID_RE.test(c.mediaId) ? { mediaId: c.mediaId } : {}),
                },
                artUrl,
            },
        };
    });
    return (best as { hit: { playing: NowPlaying; artUrl: string | null } } | null)?.hit ?? null;
}

/**
 * A local cover file (file:// from mpris:artUrl) -> data: URI, or null. Only
 * file:// URLs (never a network fetch), only regular files under the cap,
 * and only bytes that sniff as an image: a player cannot make this read an
 * arbitrary file into the UI.
 */
export function localArt(url: string | null, read: (p: string) => Buffer | null): string | null {
    if (!url || !url.startsWith('file://')) return null;
    let p: string;
    try { p = decodeURIComponent(new URL(url).pathname); } catch { return null; }
    const buf = read(p);
    return buf ? artDataUri(buf.toString('base64')) : null;
}

/** Spotify's ALBUM-cover image ids (640 / 300 / 64 px). Mirrors SPOTIFY_COVER_ID_RE in apps/api/src/integrations/listening-art.ts. */
export const SPOTIFY_COVER_ID_RE = /^ab67616d0000(?:b273|1e02|4851)[0-9a-f]{24}$/;

/** `https://i.scdn.co/image/<album cover id>` -> the id, else null (playlist covers / profile pictures are refused). */
export function spotifyCoverId(raw: unknown): string | null {
    const u = remoteArtUrl(raw);
    const m = u ? /^https:\/\/i\.scdn\.co\/image\/([0-9a-f]{40})$/.exec(u) : null;
    return m && SPOTIFY_COVER_ID_RE.test(m[1]) ? m[1] : null;
}

/** The only host a cover may be fetched from: Spotify's image CDN (what Spotify itself reports). */
export const REMOTE_ART_HOSTS = ['i.scdn.co'] as const;

/** An https cover URL -> the URL to fetch, or null unless it is https on an allowed host (no credentials, no port). */
export function remoteArtUrl(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.length > 500) return null;
    let u: URL;
    try { u = new URL(raw.trim()); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    if (!(REMOTE_ART_HOSTS as readonly string[]).includes(u.hostname.toLowerCase())) return null;
    return u.toString();
}

export type ArtFetch = (url: string) => Promise<Buffer | null>;

/** fetch() with a timeout, no redirects, and a byte cap. Never throws. */
export const fetchArtBytes: ArtFetch = async (url) => {
    try {
        const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(4000), headers: { Accept: 'image/*' } });
        if (!res.ok || !res.body) return null;
        const len = Number(res.headers.get('content-length') ?? '0');
        if (len > ART_MAX_BYTES) return null;
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            total += chunk.byteLength;
            if (total > ART_MAX_BYTES) return null;
            chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    } catch {
        return null;
    }
};

const readSmallFile = (p: string): Buffer | null => {
    try {
        const st = fs.statSync(p);
        if (!st.isFile() || st.size > ART_MAX_BYTES || st.size < 8) return null;
        return fs.readFileSync(p);
    } catch {
        return null;
    }
};

// ── Windows helper script ─────────────────────────────────────────────────
//
// Windows PowerShell 5.1 (powershell.exe, NOT pwsh: only 5.1 projects WinRT
// types). Answers one line per line received on stdin; exits on EOF or 'q'.
// 'a' = "send every cover again" (the reader lost its cache), anything else =
// "send a cover only when that session's track changed" (it is the expensive
// part). Verified on Windows 11 26200 / PowerShell 5.1.26100: the WinRT type
// loads, the AsTask bridge, and the stdin/stdout framing below.

export const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); if (-not $task.Wait(3000)) { return $null }; return $task.Result }
$MgrT = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$PropsT = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
$StreamT = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
# OpenReadAsync hands back a bare __ComObject: its Size property reads empty and
# a direct WindowsRuntimeStreamExtensions.AsStreamForRead call finds no overload.
# Both are reached through the WinRT interface types by reflection instead.
$RasT = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$InT = [Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$SizeP = $RasT.GetProperty('Size')
$asRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@($InT))
$DisposeM = [System.IDisposable].GetMethod('Dispose')
# A playing BROWSER session carries the titles of that browser's own windows (wins), so the reader can tell which
# website it is from: Chromium and Firefox give Windows no URL, but the active tab's title (with the site in it) is the
# window's title. Only the process names below are looked at; titles go to the reader over this pipe, nowhere else.
function BrowserProcName([string]$app) {
  $a = $app.ToLower()
  if ($a -match '_crx_') { return $null }
  if ($a -match 'msedge') { return 'msedge' }
  if ($a -match 'chromium') { return 'chromium' }
  if ($a -match 'chrome') { return 'chrome' }
  if ($a -match 'firefox' -or $a -eq '308046b0af4a39cb') { return 'firefox' }
  if ($a -match 'brave') { return 'brave' }
  if ($a -match 'opera') { return 'opera' }
  if ($a -match 'vivaldi') { return 'vivaldi' }
  return $null
}
# EnumWindows sees every top-level window (a browser has one process but many windows; Process.MainWindowTitle shows
# one). It is compiled by Add-Type AFTER an answer is sent (the first compile takes a moment), so it can never delay
# or break a read; until then, and if the compile is blocked, MainWindowTitle is used.
$ClWinSrc = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class ClWin {
  private delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static string[] Titles(uint[] pids) {
    var found = new List<string>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (found.Count >= 24 || !IsWindowVisible(h)) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) < 0) return true;
      int len = GetWindowTextLength(h);
      if (len <= 0 || len > 1000) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.Length > 0) found.Add(sb.ToString());
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
}
'@
$ClWinT = $null
$winTried = $false
function BrowserTitles([string]$proc, $winType) {
  $titles = New-Object System.Collections.ArrayList
  try {
    $procs = @(Get-Process -Name $proc -ErrorAction SilentlyContinue)
    if ($procs.Count -gt 0) {
      if ($winType -ne $null) {
        foreach ($t in $winType::Titles([uint32[]]@($procs | ForEach-Object { $_.Id }))) { if ($titles.Count -lt 24) { [void]$titles.Add([string]$t) } }
      } else {
        foreach ($p in $procs) { if ($p.MainWindowTitle -and $titles.Count -lt 24) { [void]$titles.Add([string]$p.MainWindowTitle) } }
      }
    }
  } catch { }
  return ,@($titles.ToArray())
}
$mgr = $null
$sent = @{}
$tries = @{}
while ($true) {
  $req = [Console]::In.ReadLine()
  if ($req -eq $null -or $req -eq 'q') { break }
  if ($req -eq 'a' -or $tries.Count -gt 64) { $sent = @{}; $tries = @{} }
  $out = @{ ok = $true }
  $needWin = $false
  $wc = @{}
  try {
    if ($mgr -eq $null) { $mgr = Await ($MgrT::RequestAsync()) $MgrT }
    if ($mgr -eq $null) { throw 'no manager' }
    $cur = ''
    try { $c = $mgr.GetCurrentSession(); if ($c -ne $null) { $cur = [string]$c.SourceAppUserModelId } } catch { }
    $list = New-Object System.Collections.ArrayList
    foreach ($s in $mgr.GetSessions()) {
      if ($list.Count -ge 16) { break }
      $e = @{ app = '' }
      try {
        $e.app = [string]$s.SourceAppUserModelId
        $pi = $s.GetPlaybackInfo()
        $e.status = [int]$pi.PlaybackStatus
        try { if ($pi.PlaybackType -ne $null) { $e.ptype = [int]$pi.PlaybackType } } catch { }
        if ($e.status -eq 4) {
          $p = Await ($s.TryGetMediaPropertiesAsync()) $PropsT
          if ($p -ne $null) {
            $e.title = [string]$p.Title
            $e.artist = [string]$p.Artist
            $e.albumArtist = [string]$p.AlbumArtist
            $e.album = [string]$p.AlbumTitle
          }
          try {
            $tl = $s.GetTimelineProperties()
            $e.dur = [int64]($tl.EndTime - $tl.StartTime).TotalMilliseconds
            $e.pos = [int64]($tl.Position - $tl.StartTime).TotalMilliseconds
            $e.upd = [int64]$tl.LastUpdatedTime.ToUnixTimeMilliseconds()
          } catch { }
          # A browser: the window titles of THAT browser (once per request per browser).
          $bp = BrowserProcName $e.app
          if ($bp -ne $null) {
            $needWin = $true
            if (-not $wc.ContainsKey($bp)) { $wc[$bp] = BrowserTitles $bp $ClWinT }
            $e.wins = $wc[$bp]
          }
          $key = "$($e.app)|$($e.title)|$($e.artist)"
          # artErr (only while this track's cover is not sent yet): none = the app gave no cover,
          # open_timeout / read_failed / too_big / empty = it gave one that could not be read.
          if ($p -ne $null -and $p.Thumbnail -eq $null -and $sent[$e.app] -ne $key) { $e.artErr = 'none' }
          if ($p -ne $null -and $p.Thumbnail -ne $null -and $sent[$e.app] -ne $key) {
            # Browsers fetch the page's artwork AFTER the title: an early read comes back empty or fails.
            # Only a cover actually read marks the track done; otherwise retry on later polls, up to 6 tries.
            $n = [int]$tries[$key]
            if ($n -ge 6) { $sent[$e.app] = $key } else {
              $tries[$key] = $n + 1
              $st = $null; $ns = $null; $ms = $null
              try {
                $st = Await ($p.Thumbnail.OpenReadAsync()) $StreamT
                if ($st -eq $null) { $e.artErr = 'open_timeout' } else {
                  $size = [int64]$SizeP.GetValue($st)
                  if ($size -gt 4194304) { $e.artErr = 'too_big'; $sent[$e.app] = $key } elseif ($size -le 0) { $e.artErr = 'empty' } else {
                    $ns = $asRead.Invoke($null, @($st))
                    $ms = New-Object System.IO.MemoryStream
                    $ns.CopyTo($ms)
                    if ($ms.Length -gt 0) { $e.art = [Convert]::ToBase64String($ms.ToArray()); $sent[$e.app] = $key } else { $e.artErr = 'empty' }
                  }
                }
              } catch { $e.artErr = 'read_failed' } finally {
                if ($ms -ne $null) { try { $ms.Dispose() } catch { } }
                if ($ns -ne $null) { try { $ns.Dispose() } catch { } }
                if ($st -ne $null) { try { [void]$DisposeM.Invoke($st, $null) } catch { } }
              }
            }
          }
        }
      } catch { $e.err = 1 }
      [void]$list.Add($e)
    }
    $out.cur = $cur
    $out.sessions = $list.ToArray()
  } catch { $mgr = $null; $out = @{ ok = $false } }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $out -Compress -Depth 4))
  [Console]::Out.Flush()
  if ($needWin -and -not $winTried) {
    $winTried = $true
    try {
      $ts = Add-Type -TypeDefinition $ClWinSrc -PassThru -ErrorAction Stop
      $ClWinT = $ts | Where-Object { $_.Name -eq 'ClWin' } | Select-Object -First 1
    } catch { $ClWinT = $null }
  }
}
`;

/** pwsh-safe encoding for `-EncodedCommand`: UTF-16LE base64. */
export const encodePowerShell = (script: string): string => Buffer.from(script, 'utf16le').toString('base64');

// ── macOS script ──────────────────────────────────────────────────────────

export const macScript = (app: 'Spotify' | 'Music'): string => app === 'Spotify'
    ? `tell application "Spotify"
  if player state is playing then
    set t to current track
    set u to ""
    try
      set u to (spotify url of t) as text
    end try
    return "spotify" & tab & (name of t) & tab & (artist of t) & tab & (album of t) & tab & ((duration of t) as integer) & tab & (((player position) * 1000) as integer) & tab & u
  end if
end tell
return ""`
    : `tell application "Music"
  if player state is playing then
    set t to current track
    return "apple_music" & tab & (name of t) & tab & (artist of t) & tab & (album of t) & tab & (((duration of t) * 1000) as integer) & tab & (((player position) * 1000) as integer)
  end if
end tell
return ""`;

/** Spotify: the cover's URL (on i.scdn.co). Read only for a track whose cover is not cached yet. */
export const MAC_SPOTIFY_ART_SCRIPT = `tell application "Spotify"
  if player state is playing then return (artwork url of current track)
end tell
return ""`;

/**
 * Music: the cover's bytes, written to the path given as argv 1 (a file in a
 * private 0700 temp dir the reader owns, read then deleted). "ok" = written.
 */
export const MAC_MUSIC_ART_SCRIPT = `on run argv
  set p to item 1 of argv
  tell application "Music"
    if player state is not playing then return ""
    if (count of artworks of current track) is 0 then return ""
    set d to raw data of artwork 1 of current track
  end tell
  set f to open for access (POSIX file p) with write permission
  try
    set eof f to 0
    write d to f
    close access f
  on error
    try
      close access f
    end try
    return ""
  end try
  return "ok"
end run`;

// ── Linux: MPRIS over dbus-native ────────────────────────────────────────

/** The two D-Bus calls the reader needs; dbus-native in the app, a fake in tests. */
export interface MprisBus {
    listNames(): Promise<string[]>;
    getAll(busName: string): Promise<Record<string, unknown>>;
    close(): void;
}

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';

/** A session-bus connection through dbus-native, or null when there is no session bus. */
export function dbusNativeMpris(env: NodeJS.ProcessEnv = process.env): MprisBus | null {
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    if (!env.DBUS_SESSION_BUS_ADDRESS && !(uid >= 0 && fs.existsSync(`/run/user/${uid}/bus`))) return null;
    let bus: {
        invoke: (msg: Record<string, unknown>, opts: { timeout: number }) => Promise<unknown>;
        connection?: { on?: (ev: string, cb: (e: unknown) => void) => void; end?: () => void };
    };
    let toPlain: (v: unknown) => unknown;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require so dbus-native stays out of the Windows/macOS dependency graph (Linux-only module)
        const dbus = require('dbus-native');
        bus = dbus.sessionBus({ timeout: 3000 });
        toPlain = dbus.toPlain;
    } catch {
        return null;
    }
    let dead = false;
    bus.connection?.on?.('error', () => { dead = true; });
    bus.connection?.on?.('end', () => { dead = true; });
    const call = (msg: Record<string, unknown>, timeout: number) => {
        if (dead) return Promise.reject(new Error('bus closed'));
        return bus.invoke(msg, { timeout });
    };
    return {
        listNames: async () => {
            const r = await call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'ListNames' }, 2000);
            return Array.isArray(r) ? r.filter((n): n is string => typeof n === 'string') : [];
        },
        getAll: async (busName: string) => {
            const r = await call({
                destination: busName, path: '/org/mpris/MediaPlayer2', interface: 'org.freedesktop.DBus.Properties',
                member: 'GetAll', signature: 's', body: ['org.mpris.MediaPlayer2.Player'],
            }, 1500);
            const plain = toPlain(r);
            return plain && typeof plain === 'object' && !Array.isArray(plain) ? (plain as Record<string, unknown>) : {};
        },
        close: () => { dead = true; try { bus.connection?.end?.(); } catch { /* gone */ } },
    };
}

// ── The reader ────────────────────────────────────────────────────────────

const CHILD_TIMEOUT_MS = 6000;
/** The Windows helper exits after this long without a request (Settings off, app idle). */
export const HELPER_IDLE_MS = 2 * 60_000;
/** Answers are reused for this long (two windows asking at once, a fast re-render). */
const CACHE_MS = 3000;
/** Covers kept for tracks the helper already sent (it sends each only once per track). */
const ART_CACHE_MAX = 6;
/** The longest answer line kept from the Windows helper. */
export const HELPER_LINE_MAX_CHARS = 16 * 1024 * 1024;
/** Consecutive helper failures (no answer / died) before Settings is told it is failing. */
const HELPER_FAILS_TO_REPORT = 2;

type ExecErr = (Error & { code?: unknown; killed?: boolean; signal?: string | null }) | null;
type ExecFileFn = (file: string, args: string[], opts: { timeout: number; windowsHide: boolean; maxBuffer: number }, cb: (err: ExecErr, stdout: string, stderr: string) => void) => void;
type SpawnFn = (cmd: string, args: string[], opts: { windowsHide: boolean; stdio: 'pipe' }) => ChildProcessWithoutNullStreams;

export class MediaSessionReader {
    private child: ChildProcessWithoutNullStreams | null = null;
    private buf = '';
    private waiters: Array<(line: string | null) => void> = [];
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private cache: { at: number; opts: string; value: MediaReadResult } | null = null;
    private inflight: Promise<MediaReadResult> | null = null;
    /** Covers by track key, most recent last. */
    private arts = new Map<string, string | null>();
    /** Windows: what became of each recent track's cover (Settings' diagnosis line). */
    private diags = new Map<string, CoverDiag>();
    /** Spotify album-cover ids by track key (macOS: read with the cover, once per track). */
    private artIds = new Map<string, string | null>();
    private unsupported: UnsupportedReason | null = null;
    private helperFails = 0;
    private bus: MprisBus | null = null;

    constructor(
        private readonly platform: NodeJS.Platform = process.platform,
        private readonly execFileFn: ExecFileFn = execFile as unknown as ExecFileFn,
        private readonly spawnFn: SpawnFn = spawn as unknown as SpawnFn,
        private readonly now: () => number = Date.now,
        private readonly busFactory: () => MprisBus | null = () => dbusNativeMpris(),
        private readonly readFile: (p: string) => Buffer | null = readSmallFile,
        private readonly fetchArt: ArtFetch = fetchArtBytes,
        /** Shrinks an over-size Windows cover (main.ts passes a nativeImage resizer); none = such covers are dropped. */
        private readonly shrinkArt?: (bytes: Buffer) => Buffer | null,
    ) {}

    /** Private temp dir for Music.app covers (macOS), created on first use, removed by stop(). */
    private artDir: string | null = null;

    /** What is playing now: music, and videos only when asked (browsers only when asked). Never throws. */
    read(o: boolean | ReadOpts): Promise<MediaReadResult> {
        const opts: ReadOpts = typeof o === 'boolean' ? { includeBrowser: o, includeWatching: false } : { includeBrowser: o?.includeBrowser === true, includeWatching: o?.includeWatching === true };
        const want = `${opts.includeBrowser ? 1 : 0}${opts.includeWatching ? 1 : 0}`;
        if (this.cache && this.cache.opts === want && this.now() - this.cache.at < CACHE_MS) return Promise.resolve(this.cache.value);
        if (this.inflight) return this.inflight;
        this.inflight = this.readFresh(opts)
            .catch((): MediaReadResult => ({ supported: true, playing: null, issue: null }))
            .then((value) => { this.cache = { at: this.now(), opts: want, value }; return value; })
            .finally(() => { this.inflight = null; });
        return this.inflight;
    }

    /** Stop the helper / close the bus now (Settings switched off, app quitting). */
    stop(): void {
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        const c = this.child;
        this.child = null;
        this.arts.clear(); this.diags.clear();
        this.artIds.clear();
        this.cache = null;
        this.helperFails = 0;
        if (c) {
            try { c.stdin.end('q\n'); } catch { /* already gone */ }
            setTimeout(() => { try { c.kill(); } catch { /* gone */ } }, 1000).unref?.();
        }
        for (const w of this.waiters.splice(0)) w(null);
        if (this.bus) { this.bus.close(); this.bus = null; }
        if (this.artDir) { try { fs.rmSync(this.artDir, { recursive: true, force: true }); } catch { /* best effort */ } this.artDir = null; }
    }

    private async readFresh(opts: ReadOpts): Promise<MediaReadResult> {
        if (this.unsupported) return { supported: false, reason: this.unsupported };
        if (this.platform === 'win32') return this.readWindows(opts);
        if (this.platform === 'darwin') return this.readMac();
        if (this.platform === 'linux') return this.readLinux(opts);
        return { supported: false, reason: 'platform' };
    }

    private run(file: string, args: string[]): Promise<{ err: ExecErr; out: string; stderr: string }> {
        return new Promise((resolve) => {
            try {
                this.execFileFn(file, args, { timeout: CHILD_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
                    resolve({ err, out: err ? '' : String(stdout ?? ''), stderr: String(stderr ?? '') });
                });
            } catch (e) {
                resolve({ err: e as ExecErr, out: '', stderr: '' });
            }
        });
    }

    private async readMac(): Promise<MediaReadResult> {
        let issue: MediaIssue | null = null;
        for (const app of ['Spotify', 'Music'] as const) {
            // pgrep exits 1 when nothing matches: that is "not running", not an error worth anything.
            const running = await this.run('/usr/bin/pgrep', ['-x', app]);
            if (running.err || !running.out.trim()) continue;
            const r = await this.run('/usr/bin/osascript', ['-e', macScript(app)]);
            if (r.err) { issue ??= macScriptIssue(r.err, r.stderr, app); continue; }
            const p = parseMacOutput(r.out);
            if (p) {
                const key = trackKeyOf(app, p.title, p.artist);
                if (!this.arts.has(key)) {
                    const got = await this.macArt(app);
                    this.rememberArt(key, got.art);
                    this.artIds.set(key, got.id);
                    while (this.artIds.size > ART_CACHE_MAX) this.artIds.delete(this.artIds.keys().next().value as string);
                }
                return { supported: true, playing: { ...p, art: this.arts.get(key) ?? null, artId: this.artIds.get(key) ?? null }, issue: null };
            }
        }
        return { supported: true, playing: null, issue };
    }

    /** The current track's cover on macOS (+ Spotify's album-cover id), or nulls. Never throws; at most one extra osascript per new track. */
    private async macArt(app: 'Spotify' | 'Music'): Promise<{ art: string | null; id: string | null }> {
        if (app === 'Spotify') {
            const r = await this.run('/usr/bin/osascript', ['-e', MAC_SPOTIFY_ART_SCRIPT]);
            const url = r.err ? null : remoteArtUrl(r.out.trim());
            const bytes = url ? await this.fetchArt(url) : null;
            return { art: bytes ? artDataUri(bytes.toString('base64')) : null, id: spotifyCoverId(url) };
        }
        try {
            this.artDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'cipherline-art-'));
        } catch {
            return { art: null, id: null };
        }
        const file = path.join(this.artDir, 'cover');
        try {
            const r = await this.run('/usr/bin/osascript', ['-e', MAC_MUSIC_ART_SCRIPT, file]);
            if (r.err || r.out.trim() !== 'ok') return { art: null, id: null };
            const bytes = this.readFile(file);
            return { art: bytes ? artDataUri(bytes.toString('base64')) : null, id: null };
        } finally {
            try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
        }
    }

    private async readLinux(opts: ReadOpts): Promise<MediaReadResult> {
        if (!this.bus) {
            this.bus = this.busFactory();
            if (!this.bus) { this.unsupported = 'no_dbus'; return { supported: false, reason: 'no_dbus' }; }
        }
        const bus = this.bus;
        let names: string[];
        try {
            names = await bus.listNames();
        } catch {
            // The connection died (session bus restarted): reconnect on the next read.
            bus.close();
            if (this.bus === bus) this.bus = null;
            return { supported: true, playing: null, issue: null };
        }
        const players: MprisPlayer[] = [];
        for (const n of names.filter((x) => x.startsWith(MPRIS_PREFIX)).slice(0, 12)) {
            try {
                players.push({ name: n.slice(MPRIS_PREFIX.length), props: await bus.getAll(n) });
            } catch { /* that player quit mid-read, or does not answer: skip it */ }
        }
        const hit = pickMpris(players, { ...opts, aspectOf: (u) => { const d = localArt(u, this.readFile); return d ? dataUriAspect(d) : null; } });
        if (!hit) return { supported: true, playing: null, issue: null };
        const key = trackKeyOf(hit.playing.player ?? '', hit.playing.title, hit.playing.artist);
        if (!this.arts.has(key)) {
            let art = localArt(hit.artUrl, this.readFile);
            const remote = art ? null : remoteArtUrl(hit.artUrl);
            if (remote) { const bytes = await this.fetchArt(remote); art = bytes ? artDataUri(bytes.toString('base64')) : null; }
            this.rememberArt(key, art);
        }
        const artId = hit.playing.kind === 'listening' && hit.playing.source === 'spotify' ? spotifyCoverId(hit.artUrl) : null;
        return { supported: true, playing: { ...hit.playing, art: this.arts.get(key) ?? null, artId }, issue: null };
    }

    private async readWindows(opts: ReadOpts): Promise<MediaReadResult> {
        const child = this.ensureChild();
        if (!child) return { supported: false, reason: this.unsupported ?? 'no_powershell' };
        this.armIdle();
        const line = await new Promise<string | null>((resolve) => {
            const t = setTimeout(() => {
                const i = this.waiters.indexOf(done);
                if (i >= 0) this.waiters.splice(i, 1);
                resolve(null);
            }, CHILD_TIMEOUT_MS);
            const done = (l: string | null) => { clearTimeout(t); resolve(l); };
            this.waiters.push(done);
            try { child.stdin.write(this.arts.size ? 'r\n' : 'a\n'); } catch { done(null); }
        });
        if (line === null) {
            this.helperFails += 1;
            // A helper that stopped answering is restarted (its answers could now arrive out of step).
            if (this.child === child) this.restartChild();
            return { supported: true, playing: null, issue: this.helperFails >= HELPER_FAILS_TO_REPORT ? { kind: 'helper_failed' } : null };
        }
        this.helperFails = 0;
        const r = pickWindowsSession(line, { ...opts, now: this.now(), artFor: (k) => this.arts.get(k) ?? null, shrink: this.shrinkArt });
        for (const [k, a] of r.arts) this.rememberArt(k, a);
        for (const [k, d] of r.diags) this.rememberDiag(k, d);
        if (r.unavailable) return { supported: true, playing: null, issue: { kind: 'win_unavailable' } };
        if (!r.playing || !r.key) return { supported: true, playing: null, issue: r.excluded ? { kind: 'excluded', ...r.excluded } : null };
        if (!this.arts.has(r.key)) this.rememberArt(r.key, null);
        const cover = this.diags.get(r.key);
        return { supported: true, playing: { ...r.playing, art: this.arts.get(r.key) ?? null, ...(cover ? { cover } : {}) }, issue: null };
    }

    private rememberDiag(key: string, d: CoverDiag): void {
        // A cover that was read stays "read": a later artErr for the same track (a retry after a reset) does not undo it.
        if (!d.ok && this.diags.get(key)?.ok) return;
        this.diags.delete(key);
        this.diags.set(key, d);
        while (this.diags.size > ART_CACHE_MAX) this.diags.delete(this.diags.keys().next().value as string);
    }

    private rememberArt(key: string, art: string | null): void {
        // A later "no cover in this answer" for a known track must not wipe the cover it already sent.
        if (art === null && this.arts.get(key)) return;
        this.arts.delete(key);
        this.arts.set(key, art);
        while (this.arts.size > ART_CACHE_MAX) this.arts.delete(this.arts.keys().next().value as string);
    }

    private restartChild(): void {
        const c = this.child;
        this.child = null;
        this.arts.clear(); this.diags.clear();
        for (const w of this.waiters.splice(0)) w(null);
        if (c) { try { c.kill(); } catch { /* gone */ } }
    }

    private ensureChild(): ChildProcessWithoutNullStreams | null {
        if (this.child) return this.child;
        let c: ChildProcessWithoutNullStreams;
        try {
            // No -ExecutionPolicy: it governs script FILES only, never an -EncodedCommand.
            c = this.spawnFn('powershell.exe', [
                '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(WINDOWS_SCRIPT),
            ], { windowsHide: true, stdio: 'pipe' });
        } catch {
            this.unsupported = 'no_powershell';
            return null;
        }
        this.child = c;
        this.buf = '';
        let dropping = false;
        c.stdout.setEncoding('utf8');
        c.stdout.on('data', (chunk: string) => {
            this.buf += chunk;
            let nl: number;
            while ((nl = this.buf.indexOf('\n')) >= 0) {
                const line = this.buf.slice(0, nl).trim();
                this.buf = this.buf.slice(nl + 1);
                // The rest of an over-long line: its waiter gets an answer that reads as "nothing" (not a dead helper).
                if (dropping) { dropping = false; this.waiters.shift()?.('-'); continue; }
                if (line) this.waiters.shift()?.(line);
            }
            // A runaway line is dropped, not buffered forever. The cap fits a full-size cover
            // (HELPER_ART_MAX_BYTES as base64 is ~5.6 MB) with room for a second one: 4 MB used to cut such a line off.
            if (this.buf.length > HELPER_LINE_MAX_CHARS) { this.buf = ''; dropping = true; }
        });
        c.stderr.on('data', () => { /* never logged: it can carry track titles */ });
        c.on('error', (e: NodeJS.ErrnoException) => {
            if (e?.code === 'ENOENT') this.unsupported = 'no_powershell';
            if (this.child === c) this.child = null;
            for (const w of this.waiters.splice(0)) w(null);
        });
        c.on('exit', () => {
            if (this.child === c) { this.child = null; this.arts.clear(); this.diags.clear(); }
            for (const w of this.waiters.splice(0)) w(null);
        });
        return c;
    }

    private armIdle(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.stop(), HELPER_IDLE_MS);
        this.idleTimer.unref?.();
    }
}
