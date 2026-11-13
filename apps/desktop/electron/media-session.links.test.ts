import { describe, it, expect } from 'vitest';
import { classifySession, MEDIA_ID_RE, macScript, pageSite, parseMacOutput, pickMpris, pickWindowsSession, spotifyTrackId } from './media-session';

/**
 * The item's own id (so a friend can open the exact song / video) and the
 * site of a browser tab: read where the OS hands them over, and only as a
 * validated id / source value - never a URL that leaves this machine.
 */

const ID = '4cOdK2wGLETKBW3PvgPWqT';

describe('spotifyTrackId: only what Spotify itself reports, only tracks', () => {
    it('accepts the three shapes Spotify uses', () => {
        expect(spotifyTrackId(`spotify:track:${ID}`)).toBe(`spotify:track:${ID}`);
        expect(spotifyTrackId(`https://open.spotify.com/track/${ID}`)).toBe(`spotify:track:${ID}`);
        expect(spotifyTrackId(`https://open.spotify.com/intl-de/track/${ID}`)).toBe(`spotify:track:${ID}`);
        expect(spotifyTrackId(`/com/spotify/track/${ID}`)).toBe(`spotify:track:${ID}`);
    });

    it.each([
        `spotify:episode:${ID}`, `spotify:ad:${ID}`, 'spotify:local:Artist:Album:Title:200', `spotify:track:${ID}x`, `spotify:track:${ID.slice(1)}`,
        `http://open.spotify.com/track/${ID}`, `https://open.spotify.com.evil.example/track/${ID}`, `https://evil.example/open.spotify.com/track/${ID}`,
        `https://open.spotify.com:8443/track/${ID}`, `https://open.spotify.com/album/${ID}`, `https://open.spotify.com/track/${ID}/extra`,
        `/org/mpris/MediaPlayer2/Track/1`, '', null, 7, `spotify:track:${'a'.repeat(300)}`,
    ])('refuses %s', (raw) => {
        expect(spotifyTrackId(raw)).toBeNull();
    });
});

describe('pageSite: a browser tab\'s site (Firefox on Linux exposes the page URL)', () => {
    it('maps exact hosts to the sources that already exist', () => {
        expect(pageSite('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1&t=42s')).toEqual({ listen: null, watch: 'youtube', mediaId: 'youtube:dQw4w9WgXcQ' });
        expect(pageSite('https://m.youtube.com/shorts/dQw4w9WgXcQ')).toMatchObject({ watch: 'youtube', mediaId: 'youtube:dQw4w9WgXcQ' });
        expect(pageSite('https://youtu.be/dQw4w9WgXcQ')).toMatchObject({ watch: 'youtube', mediaId: 'youtube:dQw4w9WgXcQ' });
        expect(pageSite('https://music.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({ listen: 'youtube_music', watch: 'youtube', mediaId: 'youtube:dQw4w9WgXcQ' });
        expect(pageSite('https://www.youtube.com/')).toEqual({ listen: null, watch: 'youtube', mediaId: null });
        expect(pageSite('https://open.spotify.com/album/x')).toEqual({ listen: 'spotify', watch: null, mediaId: null });
        expect(pageSite('https://music.apple.com/us/album/x')?.listen).toBe('apple_music');
        expect(pageSite('https://listen.tidal.com/album/1')?.listen).toBe('tidal');
        expect(pageSite('https://www.deezer.com/en/album/1')?.listen).toBe('deezer');
        expect(pageSite('https://music.amazon.co.uk/albums/x')?.listen).toBe('amazon_music');
        expect(pageSite('https://soundcloud.com/artist/track')?.listen).toBe('soundcloud');
        expect(pageSite('https://www.netflix.com/watch/1')?.watch).toBe('netflix');
        expect(pageSite('https://www.primevideo.com/detail/x')?.watch).toBe('prime_video');
        expect(pageSite('https://www.disneyplus.com/video/x')?.watch).toBe('disney_plus');
        expect(pageSite('https://www.hulu.com/watch/x')?.watch).toBe('hulu');
        expect(pageSite('https://www.crunchyroll.com/watch/x')?.watch).toBe('crunchyroll');
        expect(pageSite('https://www.twitch.tv/somestreamer')?.watch).toBe('twitch');
        expect(pageSite('https://app.plex.tv/desktop')?.watch).toBe('plex');
    });

    it.each([
        'https://notyoutube.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ', 'https://evil.example/?u=https://youtube.com/watch',
        'http://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://user:pw@www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com:444/watch?v=dQw4w9WgXcQ',
        'file:///home/me/video.mp4', 'https://bandcamp.com/x', 'not a url', '', null, 'https://www.youtube.com/watch?v=' + 'a'.repeat(3000),
    ])('no site for %s', (raw) => {
        expect(pageSite(raw)).toBeNull();
    });

    it('a malformed YouTube id is dropped, the site kept', () => {
        expect(pageSite('https://www.youtube.com/watch?v=short')).toMatchObject({ watch: 'youtube', mediaId: null });
        expect(pageSite('https://www.youtube.com/watch?v=dQw4w9WgXcQ%22%3E')).toMatchObject({ mediaId: null });
        expect(pageSite('https://youtu.be/dQw4w9WgXcQ/extra')).toMatchObject({ mediaId: 'youtube:dQw4w9WgXcQ' });
    });
});

describe('classifySession carries the site and the id', () => {
    const ff = (url: string | null, o: Record<string, unknown> = {}) =>
        classifySession({ app: 'firefox.instance_1_42', title: 'A video', artist: 'A channel', album: null, aspect: 16 / 9, url, ...o });

    it('Firefox on Linux: a YouTube video is watching on YouTube with its id', () => {
        expect(ff('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({ kind: 'watching', source: 'youtube', artist: 'A channel', mediaId: 'youtube:dQw4w9WgXcQ' });
    });

    it('a YouTube Music tab is listening on YouTube Music with its id', () => {
        expect(ff('https://music.youtube.com/watch?v=dQw4w9WgXcQ', { title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine' }))
            .toEqual({ kind: 'listening', source: 'youtube_music', artist: 'Massive Attack', mediaId: 'youtube:dQw4w9WgXcQ' });
    });

    it('a music-looking youtube.com tab stays a browser source but keeps the id; a site of the other kind falls back to browser', () => {
        expect(ff('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { artist: 'Massive Attack - Topic' })).toEqual({ kind: 'listening', source: 'browser', artist: 'Massive Attack - Topic', mediaId: 'youtube:dQw4w9WgXcQ' });
        // A music-only site decides the kind (a Spotify web episode is audio), whatever the cover looks like.
        expect(ff('https://open.spotify.com/episode/x')).toEqual({ kind: 'listening', source: 'spotify', artist: 'A channel' });
        expect(ff('https://www.netflix.com/watch/1', { album: 'X' })).toEqual({ kind: 'listening', source: 'browser', artist: 'A channel' });
    });

    it('Netflix / Twitch tabs name the service; no URL (Windows, Chromium) -> plain browser', () => {
        expect(ff('https://www.netflix.com/watch/81234567')).toEqual({ kind: 'watching', source: 'netflix', artist: 'A channel' });
        expect(ff('https://www.twitch.tv/somestreamer')).toEqual({ kind: 'watching', source: 'twitch', artist: 'A channel' });
        expect(ff(null)).toEqual({ kind: 'watching', source: 'browser', artist: 'A channel' });
        expect(classifySession({ app: 'Chrome', title: 'A video', artist: 'A channel', album: null, aspect: 16 / 9, ptype: 1 })).toEqual({ kind: 'watching', source: 'browser', artist: 'A channel' });
    });

    it('Spotify (Linux): the track id from xesam:url or mpris:trackid; any other player never gets a Spotify id', () => {
        const sp = { app: 'spotify', title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine' };
        expect(classifySession({ ...sp, url: `https://open.spotify.com/track/${ID}` })).toMatchObject({ source: 'spotify', mediaId: `spotify:track:${ID}` });
        expect(classifySession({ ...sp, trackId: `/com/spotify/track/${ID}` })).toMatchObject({ mediaId: `spotify:track:${ID}` });
        expect(classifySession({ ...sp, url: `https://open.spotify.com/episode/${ID}` })).toEqual({ kind: 'listening', source: 'spotify', artist: 'Massive Attack' });
        expect(classifySession({ ...sp, app: 'rhythmbox', url: `https://open.spotify.com/track/${ID}` })).toEqual({ kind: 'listening', source: 'other', artist: 'Massive Attack' });
    });
});

describe('the platforms that hand over an id', () => {
    it('Linux MPRIS: Spotify publishes the track id; a Firefox YouTube tab its video id; Chromium none', () => {
        const spotify = { name: 'spotify', props: { PlaybackStatus: 'Playing', Position: 0, Metadata: { 'xesam:title': 'Teardrop', 'xesam:artist': ['Massive Attack'], 'xesam:album': 'Mezzanine', 'mpris:trackid': `/com/spotify/track/${ID}`, 'xesam:url': `https://open.spotify.com/track/${ID}` } } };
        expect(pickMpris([spotify], false)!.playing.mediaId).toBe(`spotify:track:${ID}`);
        const firefox = { name: 'firefox.instance_1_42', props: { PlaybackStatus: 'Playing', Position: 0, Metadata: { 'xesam:title': 'A video', 'xesam:artist': ['A channel'], 'xesam:url': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } } };
        expect(pickMpris([firefox], { includeBrowser: true, includeWatching: true })!.playing).toMatchObject({ kind: 'watching', source: 'youtube', mediaId: 'youtube:dQw4w9WgXcQ' });
        const chromium = { name: 'chromium.instance42', props: { PlaybackStatus: 'Playing', Position: 0, Metadata: { 'xesam:title': 'A video', 'xesam:artist': ['A channel'] } } };
        const c = pickMpris([chromium], { includeBrowser: true, includeWatching: true })!.playing;
        expect(c.source).toBe('browser');
        expect(c.mediaId).toBeUndefined();
    });

    it('macOS Spotify: the script also returns the track\'s spotify url; parseMacOutput keeps only a valid track id', () => {
        expect(macScript('Spotify')).toContain('spotify url of t');
        expect(macScript('Spotify')).toMatch(/try\s+set u to \(spotify url of t\) as text\s+end try/);
        expect(parseMacOutput(`spotify\tTeardrop\tMassive Attack\tMezzanine\t330000\t31000\tspotify:track:${ID}\n`)?.mediaId).toBe(`spotify:track:${ID}`);
        expect(parseMacOutput('spotify\tAn ad\tSpotify\t\t30000\t1000\tspotify:ad:x\n')?.mediaId).toBeUndefined();
        expect(parseMacOutput('spotify\tTeardrop\tMassive Attack\tMezzanine\t330000\t31000\n')?.mediaId).toBeUndefined();
        // Music.app has no catalogue id to give: never a media id.
        expect(parseMacOutput(`apple_music\tTeardrop\tMassive Attack\tMezzanine\t330000\t31000\tspotify:track:${ID}\n`)?.mediaId).toBeUndefined();
    });

    it('Windows: SMTC carries no URL or id - a Spotify / browser session never has one', () => {
        const line = JSON.stringify({ ok: true, cur: '', sessions: [{ app: 'Spotify.exe', status: 4, title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine' }] });
        expect(pickWindowsSession(line, { includeBrowser: true, now: 0 }).playing?.mediaId).toBeUndefined();
    });

    it('every id produced matches the published regex', () => {
        for (const id of [spotifyTrackId(`spotify:track:${ID}`), pageSite('https://youtu.be/dQw4w9WgXcQ')!.mediaId]) expect(id).toMatch(MEDIA_ID_RE);
    });
});
