import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    artDataUri, browserKind, classifySession, helperArt, classifySource, dataUriAspect, encodePowerShell, imageAspect, localArt, MAC_MUSIC_ART_SCRIPT, MAC_SPOTIFY_ART_SCRIPT, macScriptIssue, MediaSessionReader,
    parseMacOutput, pickMpris, pickWindowsSession, playerLabel, remoteArtUrl, spotifyCoverId, WINDOWS_SCRIPT, type MprisBus,
} from './media-session';

const JPEG_B64 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jfif-bytes-here')]).toString('base64');
const JPEG = Buffer.from(JPEG_B64, 'base64');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

describe('classifySource / playerLabel', () => {
    it.each([
        ['Spotify.exe', 'spotify'],
        ['SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', 'spotify'],
        ['AppleInc.AppleMusicWin_nzyj5cx40ttqa!App', 'apple_music'],
        ['iTunes.exe', 'apple_music'],
        ['com.github.th-ch.youtube-music', 'youtube_music'],
        ['TIDAL.exe', 'tidal'],
        ['Deezer.exe', 'deezer'],
        ['AmazonMobileLLC.AmazonMusic_kc6t79cpj4tp0!AmazonMusic', 'amazon_music'],
        ['chrome.exe', 'browser'],
        ['Chrome', 'browser'],
        ['MSEdge', 'browser'],
        ['308046B0AF4A39CB', 'browser'],
        ['firefox', 'browser'],
        ['chromium.instance42', 'browser'],
        ['foobar2000.exe', 'other'],
        ['Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic', 'other'],
        ['rhythmbox', 'other'],
    ])('%s -> %s', (app, src) => expect(classifySource(app)).toBe(src));

    it.each(['vlc.exe', 'Netflix', 'steam.exe', 'Microsoft.ZuneVideo', '', 'mpv', 'discord', 'chat.cipherline.app'])('%p is not music', (app) => expect(classifySource(app)).toBeNull());

    it('friendly names for the Settings line', () => {
        expect(playerLabel('Spotify.exe')).toBe('Spotify');
        expect(playerLabel('Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic')).toBe('Media Player');
        expect(playerLabel('MSEdge')).toBe('Edge');
        expect(playerLabel('chromium.instance42')).toBe('Chromium');
        expect(playerLabel('foobar2000.exe')).toBe('foobar2000');
        expect(playerLabel('whatever.exe')).toBeNull();
    });
});

// Recorded from Windows PowerShell 5.1 (WINDOWSSVR, 2026-10-26) running WINDOWS_SCRIPT against a fake
// session manager: a current Chrome session, a playing Spotify whose cover threw, a paused Media Player,
// and a session whose GetPlaybackInfo() threw. Exactly the JSON the helper printed.
const RECORDED = '{"ok":true,"sessions":[{"artist":"A channel","album":"Mezzanine","dur":330000,"pos":31000,"upd":1793025047167,"app":"Chrome","status":4,"title":"Some video","albumArtist":""},{"artist":"Massive Attack","album":"Mezzanine","dur":330000,"pos":31000,"upd":1793025047174,"app":"Spotify.exe","status":4,"title":"Teardrop","albumArtist":""},{"app":"Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic","status":5},{"err":1,"app":"Broken.App"}],"cur":"Chrome"}';

describe('pickWindowsSession', () => {
    const sess = (o: object = {}) => ({ app: 'Spotify.exe', status: 4, title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', dur: 330_000, pos: 30_000, upd: 1_000, ...o });
    const line = (sessions: object[], cur = '') => JSON.stringify({ ok: true, cur, sessions });

    it('THE 1.0.23 BUG: Spotify plays while another app is Windows\' "current" session -> Spotify, not nothing', () => {
        const r = pickWindowsSession(RECORDED, { includeBrowser: false, now: 1793025049174 });
        expect(r.playing).toMatchObject({ source: 'spotify', title: 'Teardrop', artist: 'Massive Attack', player: 'Spotify', positionMs: 33_000 });
        // Cipherline itself (call audio) as the current session must not hide the music either.
        const own = line([{ app: 'chat.cipherline.app', status: 4, title: 'Cipherline', artist: 'Call' }, sess()], 'chat.cipherline.app');
        expect(pickWindowsSession(own, { includeBrowser: true, now: 0 }).playing).toMatchObject({ source: 'spotify' });
    });

    it('OWNER\'S PC: a player we have no name for (spotifast.exe, Windows\' current session) still counts', () => {
        // Exactly what the owner's Windows PowerShell check printed: "current: spotifast.exe / spotifast.exe status=Playing".
        const r = pickWindowsSession(line([sess({ app: 'spotifast.exe' })], 'spotifast.exe'), { includeBrowser: false, now: 0 });
        expect(r.playing).toMatchObject({ source: 'other', title: 'Teardrop', artist: 'Massive Attack', player: 'Spotifast' });
        // A packaged app with the same story, and one that says Music explicitly.
        expect(pickWindowsSession(line([sess({ app: 'Vendor.NewPlayer_abc123!App' })]), { includeBrowser: false, now: 0 }).playing).toMatchObject({ source: 'other', player: 'NewPlayer' });
        expect(pickWindowsSession(line([sess({ app: 'vlc.exe', ptype: 1 })]), { includeBrowser: false, now: 0 }).playing).toMatchObject({ kind: 'listening', source: 'other', player: 'VLC' });
    });

    it('an unknown player loses to a known music app, and video / calls / games never count (videos: unless asked)', () => {
        expect(pickWindowsSession(line([sess({ app: 'spotifast.exe', title: 'A' }), sess({ title: 'B' })], 'spotifast.exe'), { includeBrowser: false, now: 0 }).playing).toMatchObject({ title: 'B' });
        for (const s of [
            sess({ app: 'someplayer.exe', ptype: 2 }), sess({ app: 'someplayer.exe', ptype: 3 }), sess({ app: 'vlc.exe', album: '' }), sess({ app: 'mpv', album: '' }),
            sess({ app: 'Discord.exe' }), sess({ app: 'steam.exe' }), sess({ app: 'chat.cipherline.app' }), sess({ app: 'Microsoft.ZuneVideo_8wekyb3d8bbwe!Microsoft.ZuneVideo', album: '' }),
            sess({ app: '4DF9E0F8.Netflix_mcm4njqhnhss8!Netflix.App' }), sess({ app: 'spotifast.exe', artist: '' }),
        ]) expect(pickWindowsSession(line([s]), { includeBrowser: true, now: 0 }).playing).toBeNull();
    });

    it('a dedicated music app beats a browser, then the current session, then Windows\' order', () => {
        expect(pickWindowsSession(RECORDED, { includeBrowser: true, now: 0 }).playing).toMatchObject({ source: 'spotify' });
        expect(pickWindowsSession(line([sess({ app: 'chrome.exe' })]), { includeBrowser: true, now: 0 }).playing).toMatchObject({ source: 'browser', player: 'Chrome' });
        const two = (cur: string) => line([sess({ app: 'foobar2000.exe', title: 'A' }), sess({ title: 'B' })], cur);
        expect(pickWindowsSession(two('Spotify.exe'), { includeBrowser: false, now: 0 }).playing).toMatchObject({ title: 'B' });
        expect(pickWindowsSession(two(''), { includeBrowser: false, now: 0 }).playing).toMatchObject({ title: 'A' });
    });

    it('the position advances by the time since Windows last updated it, capped at the duration', () => {
        expect(pickWindowsSession(line([sess()]), { includeBrowser: false, now: 6_000 }).playing).toMatchObject({ positionMs: 35_000, durationMs: 330_000 });
        expect(pickWindowsSession(line([sess()]), { includeBrowser: false, now: 9_999_999 }).playing!.positionMs).toBe(330_000);
    });

    it('covers come back by track key, for every session that sent one', () => {
        const r = pickWindowsSession(line([sess({ art: JPEG_B64 }), sess({ app: 'chrome.exe', title: 'V', artist: 'C', art: JPEG_B64, status: 5 })]), { includeBrowser: false, now: 0 });
        expect(r.key).toBe('Spotify.exe|Teardrop|Massive Attack');
        expect([...r.arts.keys()]).toEqual(['Spotify.exe|Teardrop|Massive Attack', 'chrome.exe|V|C']);
        expect(r.arts.get(r.key!)).toMatch(/^data:image\/jpeg;base64,/);
    });

    it('paused / not music / browser (unless asked) / no title or artist / garbage -> nothing; ok:false -> unavailable', () => {
        const opts = { includeBrowser: false, now: 0 };
        expect(pickWindowsSession(line([sess({ status: 5 })]), opts).playing).toBeNull();
        expect(pickWindowsSession(line([sess({ app: 'vlc.exe', album: '' })]), opts).playing).toBeNull();
        expect(pickWindowsSession(line([sess({ app: 'chrome.exe' })]), opts).playing).toBeNull();
        expect(pickWindowsSession(line([sess({ artist: '', albumArtist: '' })]), opts).playing).toBeNull();
        expect(pickWindowsSession(line([sess({ artist: '', albumArtist: 'Massive Attack' })]), opts).playing).toMatchObject({ artist: 'Massive Attack' });
        expect(pickWindowsSession(line([]), opts)).toMatchObject({ playing: null, unavailable: false });
        expect(pickWindowsSession('{"ok":false}', opts)).toMatchObject({ playing: null, unavailable: true });
        expect(pickWindowsSession('not json', opts)).toMatchObject({ playing: null, unavailable: false });
        expect(pickWindowsSession('{"ok":true,"sessions":"x"}', opts).playing).toBeNull();
    });

    it('cleans control / bidi characters out of titles', () => {
        expect(pickWindowsSession(line([sess({ title: '‮Tear\u0000drop' })]), { includeBrowser: false, now: 0 }).playing!.title).toBe('Teardrop');
    });

    it('art must sniff as an image and stay under the cap', () => {
        expect(artDataUri(JPEG_B64)).toMatch(/^data:image\/jpeg;base64,/);
        expect(artDataUri(Buffer.from('<svg onload=alert(1)>').toString('base64'))).toBeNull();
        expect(artDataUri('not base64!')).toBeNull();
        expect(artDataUri('A'.repeat(800_000))).toBeNull();
    });
});

describe('parseMacOutput / macScriptIssue / mac scripts', () => {
    it('mac output', () => {
        expect(parseMacOutput('spotify\tTeardrop\tMassive Attack\tMezzanine\t330000\t31000\n'))
            .toEqual({ kind: 'listening', source: 'spotify', title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', durationMs: 330000, positionMs: 31000, art: null, player: 'Spotify' });
        expect(parseMacOutput('')).toBeNull();
        expect(parseMacOutput('evil\ta\tb\tc\t1\t1')).toBeNull();
    });

    it('osascript failures: -1743 = permission, a timeout = waiting on the prompt, -600 = nothing', () => {
        const fail = Object.assign(new Error('Command failed'), { code: 1 });
        expect(macScriptIssue(fail, 'execution error: Not authorized to send Apple events to Spotify. (-1743)', 'Spotify')).toEqual({ kind: 'mac_permission', app: 'Spotify' });
        expect(macScriptIssue(Object.assign(new Error('t'), { killed: true, signal: 'SIGTERM' }), '', 'Music')).toEqual({ kind: 'mac_waiting', app: 'Music' });
        expect(macScriptIssue(fail, "execution error: Music got an error: Application isn't running. (-600)", 'Music')).toBeNull();
        expect(macScriptIssue(null, '', 'Music')).toBeNull();
    });

    it('cover scripts: Spotify returns the artwork URL; Music writes raw artwork data to the path it is given', () => {
        expect(MAC_SPOTIFY_ART_SCRIPT).toContain('artwork url of current track');
        expect(MAC_MUSIC_ART_SCRIPT).toContain('raw data of artwork 1 of current track');
        expect(MAC_MUSIC_ART_SCRIPT).toContain('set p to item 1 of argv');
        expect(MAC_MUSIC_ART_SCRIPT).toContain('open for access (POSIX file p) with write permission');
    });
});

describe('MPRIS (Linux)', () => {
    // dbus-native toPlain() shapes, as read from a real session bus (dbus-run-session + an exported mock player).
    const spotify = { name: 'spotify', props: { PlaybackStatus: 'Playing', Position: 31_000_000n, Metadata: { 'xesam:title': 'Teardrop', 'xesam:artist': ['Massive Attack'], 'xesam:album': 'Mezzanine', 'mpris:length': 330_000_000n, 'mpris:artUrl': 'https://i.scdn.co/image/ab67616d0000b273abc' } } };
    const chromium = { name: 'chromium.instance42', props: { PlaybackStatus: 'Playing', Position: 1_000_000n, Metadata: { 'xesam:title': 'A video', 'xesam:artist': ['A channel'], 'mpris:length': 5_000_000n } } };

    it('first PLAYING music player, microseconds -> ms, bigint or number; a music app beats a browser', () => {
        expect(pickMpris([chromium, spotify], false)).toEqual({
            playing: { kind: 'listening', source: 'spotify', title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', durationMs: 330000, positionMs: 31000, art: null, player: 'Spotify' },
            artUrl: 'https://i.scdn.co/image/ab67616d0000b273abc',
        });
        expect(pickMpris([chromium, spotify], true)!.playing.source).toBe('spotify');
        // A browser tab with no album and no readable cover is a VIDEO: shown only with videos on, never as music.
        expect(pickMpris([chromium], true)).toBeNull();
        expect(pickMpris([chromium], { includeBrowser: true, includeWatching: true })!.playing).toMatchObject({ kind: 'watching', source: 'browser', title: 'A video', artist: 'A channel' });
        expect(pickMpris([chromium], false)).toBeNull();
        expect(pickMpris([{ ...spotify, props: { ...spotify.props, PlaybackStatus: 'Paused' } }], false)).toBeNull();
        expect(pickMpris([{ name: 'rhythmbox', props: { PlaybackStatus: 'Playing', Position: 0, Metadata: { 'xesam:title': 'Angel', 'xesam:artist': ['Massive Attack', 'Horace Andy'], 'mpris:length': 380_000_000 } } }], false)!.playing)
            .toMatchObject({ artist: 'Massive Attack, Horace Andy', durationMs: 380_000 });
        // mpv with a tagged song (artist + album) is music; untagged it is a video.
        expect(pickMpris([{ name: 'mpv', props: spotify.props }], false)!.playing).toMatchObject({ kind: 'listening', source: 'other' });
        // Any other player with an artist counts (third-party clients); video players and Cipherline never do.
        expect(pickMpris([{ name: 'spot', props: spotify.props }], false)!.playing).toMatchObject({ source: 'other', player: 'Spot' });
        expect(pickMpris([{ name: 'cipherline', props: spotify.props }], false)).toBeNull();
        expect(pickMpris([], false)).toBeNull();
    });

    it('a local cover is read only from file:// and only if it sniffs as an image', () => {
        const read = vi.fn((p: string) => (p === '/tmp/cover art.png' ? PNG : Buffer.from('ssh-ed25519 AAAA secret')));
        expect(localArt('file:///tmp/cover%20art.png', read)).toMatch(/^data:image\/png;base64,/);
        expect(localArt('file:///home/me/.ssh/id_ed25519', read)).toBeNull();
        expect(localArt('https://i.scdn.co/image/x', read)).toBeNull();
        expect(localArt(null, read)).toBeNull();
    });

    it('a remote cover only from Spotify\'s image CDN over https', () => {
        expect(remoteArtUrl('https://i.scdn.co/image/ab67616d0000b273abc')).toBe('https://i.scdn.co/image/ab67616d0000b273abc');
        for (const bad of ['http://i.scdn.co/image/x', 'https://evil.example/x.jpg', 'https://i.scdn.co.evil.example/x', 'https://u:p@i.scdn.co/x', 'https://i.scdn.co:8443/x', 'file:///etc/passwd', '', 42, null]) {
            expect(remoteArtUrl(bad)).toBeNull();
        }
    });
});

// ── Watching vs listening ────────────────────────────────────────────────

/** A real-shaped image header of the given size. */
const pngOf = (w: number, h: number) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const jpegOf = (w: number, h: number) => Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14), // APP0 (JFIF), skipped
    Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x00]), // DQT, skipped
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03]), Buffer.alloc(9), // SOF0
    Buffer.from([0xff, 0xd9]),
]);
const webpVp8xOf = (w: number, h: number) => { const b = Buffer.alloc(30); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1'); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b; };
const uri = (b: Buffer, type = 'image/jpeg') => `data:${type};base64,${b.toString('base64')}`;
const YT_THUMB = uri(jpegOf(1280, 720)); // YouTube's maxresdefault 16:9
const YT_HQ = uri(jpegOf(480, 360)); // hqdefault, 4:3 (letterboxed)
const COVER = uri(jpegOf(544, 544)); // YouTube Music / Spotify web: square

describe('image shape (imageAspect)', () => {
    it('reads width / height from JPEG (past other segments), PNG, GIF and WebP headers', () => {
        expect(imageAspect(jpegOf(1280, 720))).toBeCloseTo(16 / 9);
        expect(imageAspect(pngOf(300, 300))).toBe(1);
        const gif = Buffer.alloc(24); gif.write('GIF89a', 0, 'latin1'); gif.writeUInt16LE(400, 6); gif.writeUInt16LE(300, 8);
        expect(imageAspect(gif)).toBeCloseTo(4 / 3);
        expect(imageAspect(webpVp8xOf(640, 360))).toBeCloseTo(16 / 9);
        expect(dataUriAspect(YT_THUMB)).toBeCloseTo(16 / 9);
    });

    it('garbage, truncated or zero-sized -> null, never a throw', () => {
        expect(imageAspect(null)).toBeNull();
        expect(imageAspect(Buffer.from('not an image at all, really not'))).toBeNull();
        expect(imageAspect(jpegOf(1280, 720).subarray(0, 26))).toBeNull();
        expect(imageAspect(pngOf(0, 10))).toBeNull();
        expect(dataUriAspect('data:image/jpeg;base64,')).toBeNull();
        expect(dataUriAspect(null)).toBeNull();
    });
});

describe('classifySession: listening, watching, or never', () => {
    const f = (o: Partial<Parameters<typeof classifySession>[0]> = {}) => classifySession({ app: 'Spotify.exe', title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', ...o });

    it('Windows playback type: 1 Music / 2 Video / 3 Image / absent', () => {
        expect(f({ app: 'someplayer.exe', ptype: 1 })).toEqual({ kind: 'listening', source: 'other', artist: 'Massive Attack' });
        expect(f({ app: 'someplayer.exe', ptype: 2, title: 'A film', artist: 'Studio' })).toEqual({ kind: 'watching', source: 'other', artist: 'Studio' });
        expect(f({ app: 'someplayer.exe', ptype: 3 })).toBeNull();
        expect(f({ app: 'someplayer.exe' })).toEqual({ kind: 'listening', source: 'other', artist: 'Massive Attack' });
        // A video from an unknown app with no channel has nothing to show under it: not shared.
        expect(f({ app: 'someplayer.exe', ptype: 2, artist: null })).toBeNull();
        // Windows' Media Player (a music app) playing a video file says Video.
        expect(f({ app: 'Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic', ptype: 2, title: 'Holiday.mp4', artist: null })).toEqual({ kind: 'watching', source: 'other', artist: 'Media Player' });
    });

    it.each([
        ['4DF9E0F8.Netflix_mcm4njqhnhss8!Netflix.App', 'netflix', 'Netflix'],
        ['AmazonVideo.PrimeVideo_pwbj9vvecjh7j!App', 'prime_video', 'Prime Video'],
        ['Disney.37853FC22B2CE_6rarf9sa4v8jt!App', 'disney_plus', 'Disney+'],
        ['HuluLLC.HuluPlus_fphbd361v8tya!App', 'hulu', 'Hulu'],
        ['CrunchyrollLLC.CrunchyrollWindowsApp_xyz!App', 'crunchyroll', 'Crunchyroll'],
        ['twitch.exe', 'twitch', 'Twitch'],
        ['Plex.exe', 'plex', 'Plex'],
        ['Jellyfin Media Player.exe', 'jellyfin', 'Jellyfin'],
        ['Chrome._crx_agimnkijcaahngcdmfeangaknmldooml', 'youtube', 'YouTube'],
    ])('video service %s -> watching %s (its name when there is no channel)', (app, source, name) => {
        expect(f({ app, title: 'Episode 1', artist: null, album: null })).toEqual({ kind: 'watching', source, artist: name });
        expect(f({ app, title: 'Episode 1', artist: 'A channel', album: null })).toEqual({ kind: 'watching', source, artist: 'A channel' });
    });

    it.each([['vlc.exe', 'VLC'], ['mpv', 'mpv'], ['mpc-hc64.exe', 'MPC'], ['PotPlayerMini64.exe', 'PotPlayer'], ['kodi.exe', 'Kodi'], ['Microsoft.ZuneVideo_8wekyb3d8bbwe!Microsoft.ZuneVideo', 'Films & TV']])(
        'video player %s: music when it says so / an audio file / tagged artist+album, else watching',
        (app, name) => {
            expect(f({ app, ptype: 1 })?.kind).toBe('listening');
            expect(f({ app, ptype: 2, artist: null })).toEqual({ kind: 'watching', source: 'other', artist: name });
            expect(f({ app, url: 'file:///music/teardrop.flac', album: null })?.kind).toBe('listening');
            expect(f({ app, url: 'file:///films/heat.mkv' })).toEqual({ kind: 'watching', source: 'other', artist: 'Massive Attack' });
            expect(f({ app })?.kind).toBe('listening'); // tagged artist + album
            expect(f({ app, title: 'heat.1995.mkv', artist: null, album: null })).toEqual({ kind: 'watching', source: 'other', artist: name });
        },
    );

    it('music apps stay listening (YouTube Music app and web app, Plexamp, Spotify...)', () => {
        expect(f({ app: 'com.github.th-ch.youtube-music' })).toMatchObject({ kind: 'listening', source: 'youtube_music' });
        expect(f({ app: 'Chrome._crx_cinhimbnkkaeohfgghhklpknlkffjgod', album: null })).toMatchObject({ kind: 'listening', source: 'youtube_music' });
        expect(f({ app: 'Plexamp.exe' })).toMatchObject({ kind: 'listening', source: 'other' });
        expect(f()).toMatchObject({ kind: 'listening', source: 'spotify' });
    });

    it.each(['Discord.exe', 'steam.exe', 'chat.cipherline.app', 'obs64.exe', 'Teams.exe', 'Zoom.exe', 'slack.exe'])('%s is never shared, whatever it plays', (app) => {
        expect(f({ app })).toBeNull();
        expect(f({ app, ptype: 2 })).toBeNull();
    });

    it('no title -> nothing', () => {
        expect(f({ title: null })).toBeNull();
        expect(f({ app: 'netflix', title: null })).toBeNull();
    });
});

describe('browsers: always "Music" to Windows, so the page\'s metadata decides (browserKind)', () => {
    const b = (o: Partial<Parameters<typeof classifySession>[0]> = {}) =>
        classifySession({ app: 'Chrome', title: 'A video', artist: 'A channel', album: null, ptype: 1, ...o });

    it('YouTube: 16:9 or 4:3 thumbnail, no album -> watching (Windows saying Music is ignored)', () => {
        expect(b({ aspect: dataUriAspect(YT_THUMB) })).toEqual({ kind: 'watching', source: 'browser', artist: 'A channel' });
        expect(b({ aspect: dataUriAspect(YT_HQ) })?.kind).toBe('watching');
        expect(b({ aspect: 9 / 16 })?.kind).toBe('watching'); // a portrait Short
    });

    it('no cover at all -> watching (the smaller mistake)', () => {
        expect(b({ aspect: null })?.kind).toBe('watching');
        expect(browserKind({ artist: 'x', album: null, aspect: undefined })).toBe('watching');
    });

    it('music sites stay listening: an album (YouTube Music, Spotify / Apple Music / Deezer web, Bandcamp), a square cover (SoundCloud), a " - Topic" channel', () => {
        expect(b({ title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', aspect: dataUriAspect(COVER) })).toEqual({ kind: 'listening', source: 'browser', artist: 'Massive Attack' });
        expect(b({ title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', aspect: 16 / 9 })?.kind).toBe('listening'); // album wins over shape
        expect(b({ title: 'A track', artist: 'A producer', aspect: 1 })?.kind).toBe('listening');
        expect(b({ title: 'A track', artist: 'A producer', aspect: 1.1 })?.kind).toBe('listening'); // within 12%
        expect(b({ title: 'Teardrop', artist: 'Massive Attack - Topic', aspect: 16 / 9 })?.kind).toBe('listening');
    });

    it('a page that published no artist (empty, or the site\'s host in its place) is not shared at all', () => {
        expect(b({ artist: null })).toBeNull();
        expect(b({ artist: 'www.netflix.com' })).toBeNull();
        expect(b({ artist: 'youtube.com' })).toBeNull();
    });

    it.each(['msedge', 'MSEdge', 'firefox.exe', '308046B0AF4A39CB', 'brave.exe', 'opera.exe', 'chromium.instance42'])('%s is a browser', (app) => {
        expect(b({ app, aspect: 16 / 9 })).toMatchObject({ kind: 'watching', source: 'browser' });
    });
});

describe('pickWindowsSession with watching', () => {
    const line = (sessions: object[], cur = '') => JSON.stringify({ ok: true, cur, sessions });
    const yt = (o: object = {}) => ({ app: 'Chrome', status: 4, ptype: 1, title: 'A video', artist: 'A channel', album: '', dur: 600_000, pos: 0, upd: 0, ...o });
    const spotify = { app: 'Spotify.exe', status: 4, title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine' };
    const both = { includeBrowser: true, includeWatching: true, now: 0 };

    it('THE BUG: a YouTube video in a browser was "Listening to <video>"; now it is watching, and only with watching on', () => {
        expect(pickWindowsSession(line([yt({ art: YT_THUMB.split(',')[1] })]), both).playing).toMatchObject({ kind: 'watching', source: 'browser', title: 'A video', artist: 'A channel', album: null });
        // Watching off: the video is skipped - NOT shared as listening.
        expect(pickWindowsSession(line([yt({ art: YT_THUMB.split(',')[1] })]), { includeBrowser: true, includeWatching: false, now: 0 }).playing).toBeNull();
        // Browser off: not read at all.
        expect(pickWindowsSession(line([yt()]), { includeBrowser: false, includeWatching: true, now: 0 }).playing).toBeNull();
    });

    it('the thumbnail shape keeps counting after the helper stops resending it (artFor)', () => {
        const key = 'Chrome|Teardrop|Massive Attack';
        const song = yt({ title: 'Teardrop', artist: 'Massive Attack' });
        expect(pickWindowsSession(line([song]), { ...both, artFor: (k) => (k === key ? COVER : null) }).playing).toMatchObject({ kind: 'listening' });
        expect(pickWindowsSession(line([song]), both).playing).toMatchObject({ kind: 'watching' }); // no cover known: video
    });

    it('a Netflix app session is watching; music beats a video when both play; watching off falls through to the music', () => {
        const nf = { app: '4DF9E0F8.Netflix_mcm4njqhnhss8!Netflix.App', status: 4, ptype: 2, title: 'Episode 1', artist: '' };
        expect(pickWindowsSession(line([nf]), both).playing).toMatchObject({ kind: 'watching', source: 'netflix', artist: 'Netflix', player: 'Netflix' });
        expect(pickWindowsSession(line([nf, spotify], nf.app), both).playing).toMatchObject({ kind: 'listening', source: 'spotify' });
        expect(pickWindowsSession(line([yt({ art: YT_THUMB.split(',')[1] }), spotify]), { includeBrowser: true, now: 0 }).playing).toMatchObject({ source: 'spotify' });
        expect(pickWindowsSession(line([nf]), { includeBrowser: true, now: 0 }).playing).toBeNull();
    });

    it('the reader passes both opt-ins through (and a bare boolean still means music only)', async () => {
        const { child } = fakeChild([line([yt({ art: YT_THUMB.split(',')[1] })]), line([yt()])]);
        let t = 0;
        const r = new MediaSessionReader('win32', vi.fn(), vi.fn(() => child as never), () => (t += 10_000));
        expect(await r.read({ includeBrowser: true, includeWatching: true })).toMatchObject({ playing: { kind: 'watching', art: expect.stringMatching(/^data:image\/jpeg/) } });
        // Second answer has no cover (the helper sends it once): the cached cover still says "video".
        expect(await r.read(true)).toMatchObject({ playing: null });
        r.stop();
    });
});

describe('Windows covers: the diagnosis (artErr) and real browser sessions', () => {
    const line = (sessions: object[], cur = '') => JSON.stringify({ ok: true, cur, sessions });
    const both = { includeBrowser: true, includeWatching: true, now: 0 };
    // What Chromium (Chrome / Edge) and Firefox hand Windows for a YouTube tab: their own AUMID,
    // PlaybackType Music (hard-coded), the page's mediaSession title / artist (= the channel), no album.
    const ytIn = (app: string, o: object = {}) => ({ app, status: 4, ptype: 1, title: 'How to Make a Bow', artist: 'Some Channel', album: '', albumArtist: '', dur: 754_000, pos: 61_000, upd: 0, ...o });
    const BROWSERS: Array<[string, string]> = [['Chrome', 'Chrome'], ['MSEdge', 'Edge'], ['308046B0AF4A39CB', 'Firefox']];

    it.each(BROWSERS)('%s: a YouTube video WITH its 16:9 thumbnail is watching (browser), cover yes with its size', (app, player) => {
        const r = pickWindowsSession(line([ytIn(app, { art: jpegOf(1280, 720).toString('base64') })], app), both);
        expect(r.playing).toMatchObject({ kind: 'watching', source: 'browser', title: 'How to Make a Bow', artist: 'Some Channel', album: null, player });
        expect(r.diags.get(r.key!)).toEqual({ ok: true, w: 1280, h: 720 });
    });

    it.each(BROWSERS)('%s: the same video with NO readable cover (the pre-fix state on every Windows PC) is still watching', (app) => {
        for (const artErr of [undefined, 'read_failed', 'open_timeout', 'none']) {
            const r = pickWindowsSession(line([ytIn(app, artErr ? { artErr } : {})]), both);
            expect(r.playing).toMatchObject({ kind: 'watching', source: 'browser' });
            if (artErr) expect(r.diags.get(r.key!)).toEqual({ ok: false, why: artErr });
        }
    });

    it('a YouTube Music tab (album set, square cover) in Edge stays listening', () => {
        const r = pickWindowsSession(line([ytIn('MSEdge', { title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', art: jpegOf(544, 544).toString('base64') })]), both);
        expect(r.playing).toMatchObject({ kind: 'listening', source: 'browser', album: 'Mezzanine', player: 'Edge' });
    });

    it('Spotify PAUSED + YouTube playing in Chrome -> the video (a paused session never counts, whatever Windows calls current)', () => {
        const paused = { app: 'Spotify.exe', status: 5, title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine' };
        const r = pickWindowsSession(line([paused, ytIn('Chrome')], 'Spotify.exe'), both);
        expect(r.playing).toMatchObject({ kind: 'watching', source: 'browser', player: 'Chrome' });
        // Cipherline's own call audio (its AUMID) playing alongside changes nothing.
        const own = { app: 'com.cipherline.desktop', status: 4, ptype: 1, title: 'Cipherline', artist: 'Call' };
        expect(pickWindowsSession(line([own, paused, ytIn('Chrome')], 'com.cipherline.desktop'), both).playing).toMatchObject({ kind: 'watching', player: 'Chrome' });
        // Spotify actually PLAYING still wins over the video (music first).
        expect(pickWindowsSession(line([{ ...paused, status: 4 }, ytIn('Chrome')]), both).playing).toMatchObject({ kind: 'listening', source: 'spotify' });
    });

    it('nothing picked because a switch keeps it out -> `excluded` names that switch (Settings says which)', () => {
        expect(pickWindowsSession(line([ytIn('Chrome')]), { includeBrowser: false, includeWatching: true, now: 0 })).toMatchObject({ playing: null, excluded: { why: 'browser', player: 'Chrome' } });
        expect(pickWindowsSession(line([ytIn('Chrome')]), { includeBrowser: true, includeWatching: false, now: 0 })).toMatchObject({ playing: null, excluded: { why: 'watching', player: 'Chrome' } });
        const nf = { app: '4DF9E0F8.Netflix_mcm4njqhnhss8!Netflix.App', status: 4, ptype: 2, title: 'Episode 1', artist: '' };
        expect(pickWindowsSession(line([nf]), { includeBrowser: false, now: 0 }).excluded).toEqual({ why: 'watching', player: 'Netflix' });
        // Something shareable plays: no `excluded` at all.
        const shared = pickWindowsSession(line([ytIn('Chrome'), { app: 'Spotify.exe', status: 4, title: 'T', artist: 'A' }]), { includeBrowser: false, now: 0 });
        expect(shared.playing).toMatchObject({ source: 'spotify' });
        expect(shared.excluded ?? null).toBeNull();
    });

    it('artErr: only known codes; a sent cover that is not an image is bad_image; no title -> no diagnosis', () => {
        const r = pickWindowsSession(line([
            { app: 'a.exe', status: 4, title: 'A', artist: 'X', artErr: 'too_big' },
            { app: 'b.exe', status: 4, title: 'B', artist: 'X', artErr: '<script>' },
            { app: 'c.exe', status: 4, title: 'C', artist: 'X', art: Buffer.from('not an image at all, just text').toString('base64') },
            { app: 'd.exe', status: 4, title: '', artist: 'X', artErr: 'none' },
            { app: 'e.exe', status: 4, title: 'E', artist: 'X', art: JPEG_B64 }, // an image, but no size in its header
        ]), both);
        expect(r.diags.get('a.exe|A|X')).toEqual({ ok: false, why: 'too_big' });
        expect(r.diags.has('b.exe|B|X')).toBe(false);
        expect(r.diags.get('c.exe|C|X')).toEqual({ ok: false, why: 'bad_image' });
        expect(r.diags.has('d.exe||X')).toBe(false);
        expect(r.diags.get('e.exe|E|X')).toEqual({ ok: true });
    });

    it('Spotify desktop\'s ~218 KB PNG: the size is read from the ORIGINAL, and the cover is shrunk before it goes anywhere', () => {
        const big = Buffer.concat([pngOf(640, 640), Buffer.alloc(218_000 - 33, 9)]);
        const shrink = vi.fn(() => jpegOf(300, 300));
        const r = pickWindowsSession(line([{ app: 'Spotify.exe', status: 4, title: 'T', artist: 'A', art: big.toString('base64') }]), { includeBrowser: false, now: 0, shrink });
        expect(shrink).toHaveBeenCalledTimes(1);
        expect(r.arts.get(r.key!)).toBe(uri(jpegOf(300, 300)));
        expect(r.diags.get(r.key!)).toEqual({ ok: true, w: 640, h: 640 });
        // No shrinker (or it fails): under ART_MAX_BYTES it is used as it came.
        expect(helperArt(big.toString('base64'))).toMatch(/^data:image\/png;base64,/);
        expect(helperArt(big.toString('base64'), () => null)).toMatch(/^data:image\/png;base64,/);
    });

    it('the reader keeps the diagnosis per track and hands it out with the read (Settings\' "cover:" line)', async () => {
        const ans = (o: object) => line([{ app: 'Spotify.exe', status: 4, title: 'Teardrop', artist: 'Massive Attack', album: 'M', ...o }]);
        const { child } = fakeChild([ans({ artErr: 'open_timeout' }), ans({ art: pngOf(640, 640).toString('base64') }), ans({}), ans({ artErr: 'read_failed' })]);
        let t = 0;
        const r = new MediaSessionReader('win32', vi.fn(), vi.fn(() => child as never), () => (t += 10_000));
        expect(await r.read(false)).toMatchObject({ playing: { art: null, cover: { ok: false, why: 'open_timeout' } } });
        expect(await r.read(false)).toMatchObject({ playing: { art: expect.stringMatching(/^data:image\/png/), cover: { ok: true, w: 640, h: 640 } } });
        expect(await r.read(false)).toMatchObject({ playing: { cover: { ok: true, w: 640, h: 640 } } }); // the helper does not resend it
        expect(await r.read(false)).toMatchObject({ playing: { cover: { ok: true, w: 640, h: 640 } } }); // a later error does not undo a read cover
        r.stop();
    });

    it('the reader reports `excluded` as the issue when only a switched-off source plays', async () => {
        const { child } = fakeChild([line([ytIn('Chrome')])]);
        const r = new MediaSessionReader('win32', vi.fn(), vi.fn(() => child as never), () => 0);
        expect(await r.read({ includeBrowser: false, includeWatching: true })).toEqual({ supported: true, playing: null, issue: { kind: 'excluded', why: 'browser', player: 'Chrome' } });
        r.stop();
    });

    it('an answer carrying a full-size (4 MB) cover is read whole (the old 4 M-character cap cut it off)', async () => {
        const huge = Buffer.concat([pngOf(3000, 3000), Buffer.alloc(4 * 1024 * 1024 - 100, 1)]).toString('base64');
        expect(huge.length).toBeGreaterThan(4 * 1024 * 1024);
        const { child } = fakeChild([line([{ app: 'Spotify.exe', status: 4, title: 'T', artist: 'A', art: huge }])]);
        const r = new MediaSessionReader('win32', vi.fn(), vi.fn(() => child as never), () => 0, undefined, undefined, undefined, () => jpegOf(300, 300));
        expect(await r.read(false)).toMatchObject({ playing: { title: 'T', art: uri(jpegOf(300, 300)), cover: { ok: true, w: 3000, h: 3000 } } });
        r.stop();
    });
});

describe('Spotify album-cover id (the one cover detail that may be published, for friends\' covers)', () => {
    const ID = `ab67616d0000b273${'c'.repeat(24)}`;
    it('only from an https i.scdn.co album-cover URL', () => {
        expect(spotifyCoverId(`https://i.scdn.co/image/${ID}`)).toBe(ID);
        for (const bad of [
            `https://i.scdn.co/image/ab67706c0000da84${'c'.repeat(24)}`, // a playlist cover a user uploaded
            `https://i.scdn.co/image/ab6775700000ee85${'c'.repeat(24)}`, // a profile picture
            `http://i.scdn.co/image/${ID}`, `https://evil.example/image/${ID}`, `https://i.scdn.co/image/${ID}?x=1`, ID, null,
        ]) expect(spotifyCoverId(bad)).toBeNull();
    });

    it('Linux: Spotify\'s MPRIS artUrl gives the id; other players never do', async () => {
        const props = (name: string, art: string) => ({ PlaybackStatus: 'Playing', Position: 0, Metadata: { 'xesam:title': 'Teardrop', 'xesam:artist': ['Massive Attack'], 'xesam:album': 'Mezzanine', 'mpris:length': 1_000_000, 'mpris:artUrl': art } });
        const bus = (players: Record<string, object>): MprisBus => ({
            listNames: async () => Object.keys(players).map((n) => `org.mpris.MediaPlayer2.${n}`),
            getAll: async (n: string) => players[n.slice('org.mpris.MediaPlayer2.'.length)] as Record<string, unknown>,
            close: () => {},
        });
        const sp = new MediaSessionReader('linux', vi.fn() as never, vi.fn() as never, () => 0, () => bus({ spotify: props('spotify', `https://i.scdn.co/image/${ID}`) }), () => null, async () => null);
        expect(await sp.read(false)).toMatchObject({ playing: { source: 'spotify', artId: ID } });
        const other = new MediaSessionReader('linux', vi.fn() as never, vi.fn() as never, () => 0, () => bus({ rhythmbox: props('rhythmbox', `https://i.scdn.co/image/${ID}`) }), () => null, async () => null);
        expect(await other.read(false)).toMatchObject({ playing: { source: 'other', artId: null } });
    });
});

describe('the Windows helper script', () => {
    it('is Windows PowerShell 5.1 WinRT code that lists every session on request and exits on EOF', () => {
        expect(WINDOWS_SCRIPT).toContain("ParameterType.Name -eq 'IAsyncOperation`1'");
        expect(WINDOWS_SCRIPT).toContain('GlobalSystemMediaTransportControlsSessionManager');
        expect(WINDOWS_SCRIPT).toContain('foreach ($s in $mgr.GetSessions())');
        expect(WINDOWS_SCRIPT).toContain('[Console]::In.ReadLine()');
        expect(WINDOWS_SCRIPT).toMatch(/if \(\$req -eq \$null -or \$req -eq 'q'\) \{ break \}/);
        // Nothing in it talks to the network or writes to disk.
        expect(WINDOWS_SCRIPT).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|Net\.WebClient|Out-File|Set-Content|Start-Process/i);
        expect(Buffer.from(encodePowerShell('ab'), 'base64').toString('utf16le')).toBe('ab');
    });

    it('retries a cover that is not there yet (browsers fetch the artwork after the title) instead of giving up on the track', () => {
        // A track is marked done only once a non-empty cover was read, or after 6 tries, or when it is too big.
        expect(WINDOWS_SCRIPT).not.toMatch(/\$sent\[\$e\.app\] -ne \$key\) \{\s*\$sent\[\$e\.app\] = \$key/);
        expect(WINDOWS_SCRIPT).toContain('if ($ms.Length -gt 0) { $e.art = [Convert]::ToBase64String($ms.ToArray()); $sent[$e.app] = $key }');
        expect(WINDOWS_SCRIPT).toContain('if ($n -ge 6) { $sent[$e.app] = $key }');
        expect(WINDOWS_SCRIPT).toContain("if ($size -gt 4194304) { $e.artErr = 'too_big'; $sent[$e.app] = $key }");
        expect(WINDOWS_SCRIPT).toMatch(/\$tries\.Count -gt 64\) \{ \$sent = @\{\}; \$tries = @\{\} \}/);
    });

    it('OWNER\'S PC: reads the cover through reflection on the WinRT stream interfaces (the direct calls never worked on PowerShell 5.1)', () => {
        // OpenReadAsync hands back a bare __ComObject: `$st.Size` is empty and
        // [WindowsRuntimeStreamExtensions]::AsStreamForRead($st) throws "Cannot find an overload".
        expect(WINDOWS_SCRIPT).not.toMatch(/\$st\.Size/);
        expect(WINDOWS_SCRIPT).not.toContain('::AsStreamForRead(');
        // The verified workaround (owner's Windows 11 PC: "size via reflection: 218023", "starts with 89 50 4E 47"),
        // with both types loaded once at the top, outside the request loop.
        const head = WINDOWS_SCRIPT.slice(0, WINDOWS_SCRIPT.indexOf('while ($true)'));
        expect(head).toContain('$RasT = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]');
        expect(head).toContain('$InT = [Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime]');
        expect(head).toContain("$SizeP = $RasT.GetProperty('Size')");
        expect(head).toContain("$asRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@($InT))");
        expect(WINDOWS_SCRIPT).toContain('$size = [int64]$SizeP.GetValue($st)');
        expect(WINDOWS_SCRIPT).toContain('$ns = $asRead.Invoke($null, @($st))');
        expect(WINDOWS_SCRIPT).toContain('$ns.CopyTo($ms)');
        // Still capped at 4 MB, and every stream is disposed whatever happened (finally).
        expect(WINDOWS_SCRIPT).toMatch(/\} finally \{\s*if \(\$ms -ne \$null\) \{ try \{ \$ms\.Dispose\(\) \} catch \{ \} \}\s*if \(\$ns -ne \$null\) \{ try \{ \$ns\.Dispose\(\) \} catch \{ \} \}\s*if \(\$st -ne \$null\) \{ try \{ \[void\]\$DisposeM\.Invoke\(\$st, \$null\) \} catch \{ \} \}/);
    });

    it('reports why a cover could not be had, per session (artErr), with no titles anywhere but the answer line', () => {
        for (const code of ['none', 'open_timeout', 'read_failed', 'too_big', 'empty']) expect(WINDOWS_SCRIPT).toContain(`$e.artErr = '${code}'`);
        expect(WINDOWS_SCRIPT).toContain("if ($st -eq $null) { $e.artErr = 'open_timeout' }");
        expect(WINDOWS_SCRIPT).toContain("} catch { $e.artErr = 'read_failed' } finally {");
        // "none" only while the track is not done, so a browser whose artwork arrives late still gets it.
        expect(WINDOWS_SCRIPT).toContain("if ($p -ne $null -and $p.Thumbnail -eq $null -and $sent[$e.app] -ne $key) { $e.artErr = 'none' }");
        // Nothing is written anywhere but stdout (no Write-Host / Write-Error / transcript of titles).
        expect(WINDOWS_SCRIPT).not.toMatch(/Write-Host|Write-Error|Write-Verbose|Start-Transcript|Add-Content/i);
    });

    it('braces balance in the script (a typo there is a parse error that kills the helper on every Windows PC)', () => {
        const code = WINDOWS_SCRIPT.replace(/'[^'\n]*'/g, "''").replace(/"[^"\n]*"/g, '""').replace(/#.*$/gm, '');
        for (const [open, close] of [['{', '}'], ['(', ')'], ['[', ']']]) {
            expect(code.split(open).length, `${open}${close}`).toBe(code.split(close).length);
        }
    });

    it('a browser cover over 512 KB (Chromium re-encodes artwork as PNG) is shrunk, not dropped', () => {
        const bigPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(900 * 1024, 7)]);
        const small = JPEG;
        const shrink = vi.fn(() => small);
        expect(helperArt(bigPng.toString('base64'))).toBeNull();                    // no shrinker: dropped, as before
        expect(helperArt(bigPng.toString('base64'), shrink)).toBe(`data:image/jpeg;base64,${JPEG_B64}`);
        expect(shrink).toHaveBeenCalledTimes(1);
        expect(helperArt(JPEG_B64, shrink)).toBe(`data:image/jpeg;base64,${JPEG_B64}`); // small: used as is
        expect(shrink).toHaveBeenCalledTimes(1);
        // Not an image, too big even for the helper, a shrink that fails or comes back too big: null.
        expect(helperArt(Buffer.alloc(900 * 1024, 1).toString('base64'), shrink)).toBeNull();
        expect(helperArt(Buffer.concat([bigPng, Buffer.alloc(4 * 1024 * 1024)]).toString('base64'), shrink)).toBeNull();
        expect(helperArt(bigPng.toString('base64'), () => { throw new Error('x'); })).toBeNull();
        expect(helperArt(bigPng.toString('base64'), () => Buffer.alloc(600 * 1024, 0xff))).toBeNull();
        // And through pickWindowsSession.
        const line = JSON.stringify({ ok: true, cur: 'chrome', sessions: [{ app: 'chrome', status: 4, title: 'Midnight City', artist: 'M83', album: 'Hurry Up', art: bigPng.toString('base64') }] });
        expect(pickWindowsSession(line, { includeBrowser: true, now: 0, shrink: () => small }).arts.size).toBe(1);
        expect(pickWindowsSession(line, { includeBrowser: true, now: 0 }).arts.size).toBe(0);
    });

    it('main.ts shrinks over-size Windows covers with nativeImage', () => {
        const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
        expect(main).toMatch(/new MediaSessionReader\([^]*?nativeImage\.createFromBuffer\(bytes\)[^]*?toJPEG\(85\)/);
    });

    it('main.ts registers the IPC channels and stops the helper on quit; preload exposes them', () => {
        const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
        expect(main).toContain("ipcMain.handle('media:now-playing'");
        expect(main).toContain("ipcMain.on('media:stop', () => mediaSession.stop())");
        expect(main).toContain("app.on('will-quit', () => mediaSession.stop())");
        const preload = fs.readFileSync(path.join(__dirname, 'preload.ts'), 'utf8');
        expect(preload).toContain("ipcRenderer.invoke('media:now-playing', { includeBrowser: opts?.includeBrowser === true, includeWatching: opts?.includeWatching === true })");
        expect(main).toContain('includeWatching: o.includeWatching === true');
        // The background schedule (electron/media-watch.ts): configured by the renderer, pushed back to it,
        // stopped on quit and when the page that asked reloads / dies.
        expect(main).toContain("ipcMain.on('media:watch', (e, opts: unknown) => {");
        expect(main).toContain("wc.send('media:now-playing-changed', r)");
        expect(main).toContain("app.on('will-quit', () => mediaWatch.stop())");
        expect(main).toMatch(/wc\.on\('did-navigate', off\);\s*wc\.on\('render-process-gone', off\);\s*wc\.once\('destroyed', off\);/);
        expect(preload).toContain("ipcRenderer.send('media:watch', opts ? { includeBrowser: opts.includeBrowser === true, includeWatching: opts.includeWatching === true } : null)");
        expect(preload).toContain("ipcRenderer.on('media:now-playing-changed', listener);");
        expect(preload).toContain("return () => ipcRenderer.removeListener('media:now-playing-changed', listener);");
    });

    it('the mac build declares why it sends Apple Events (the Automation prompt text)', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
        expect(pkg.build.mac.extendInfo.NSAppleEventsUsageDescription).toMatch(/Spotify or Music/);
    });
});

/** A fake powershell child that answers each stdin line with the next canned line (null = stay silent). */
function fakeChild(lines: Array<string | null>) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: vi.fn() });
    const requests: string[] = [];
    stdin.on('data', (b: Buffer) => {
        for (const req of b.toString().split('\n').filter(Boolean)) {
            requests.push(req);
            if (req === 'q') { child.emit('exit', 0); continue; }
            const next = lines.shift();
            if (typeof next === 'string') setTimeout(() => stdout.write(`${next}\r\n`), 1);
        }
    });
    return { child, requests };
}

describe('MediaSessionReader (Windows)', () => {
    const answer = (o: object = {}, extra: object[] = []) => JSON.stringify({ ok: true, cur: '', sessions: [{ app: 'Spotify.exe', status: 4, title: 'Teardrop', artist: 'Massive Attack', album: 'M', dur: 300_000, pos: 0, upd: 0, ...o }, ...extra] });

    it('one hidden powershell.exe (encoded command, no shell, no execution-policy flag), reused; cover kept per track', async () => {
        const { child, requests } = fakeChild([answer({ art: JPEG_B64 }), answer(), answer({ title: 'Angel' }), answer()]);
        const spawnFn = vi.fn(() => child as never);
        let t = 0;
        const r = new MediaSessionReader('win32', vi.fn(), spawnFn, () => (t += 10_000));
        const a = await r.read(false);
        expect(a).toMatchObject({ supported: true, issue: null, playing: { title: 'Teardrop', player: 'Spotify' } });
        expect((a as { playing: { art: string } }).playing.art).toMatch(/^data:image\/jpeg/);
        const b = await r.read(false);
        expect((b as { playing: { art: string } }).playing.art).toMatch(/^data:image\/jpeg/);
        const c = await r.read(false);
        expect(c).toMatchObject({ playing: { title: 'Angel', art: null } });
        // Back to the first track: its cover is still cached (the helper does not resend it).
        const d = await r.read(false);
        expect((d as { playing: { art: string } }).playing.art).toMatch(/^data:image\/jpeg/);
        expect(spawnFn).toHaveBeenCalledTimes(1);
        const [cmd, args, opts] = spawnFn.mock.calls[0] as unknown as [string, string[], { windowsHide: boolean }];
        expect(cmd).toBe('powershell.exe');
        expect(args).toContain('-EncodedCommand');
        expect(args).toContain('-NoProfile');
        expect(args).not.toContain('-ExecutionPolicy');
        expect(opts.windowsHide).toBe(true);
        expect(requests).toEqual(['a', 'r', 'r', 'r']);
        r.stop();
        expect(requests).toContain('q');
    });

    it('the media service is unreachable (ok:false) -> issue win_unavailable', async () => {
        const { child } = fakeChild(['{"ok":false}']);
        const r = new MediaSessionReader('win32', vi.fn(), vi.fn(() => child as never), () => 0);
        await expect(r.read(false)).resolves.toEqual({ supported: true, playing: null, issue: { kind: 'win_unavailable' } });
        r.stop();
    });

    it('a helper that stops answering is restarted, and reported after two misses', async () => {
        vi.useFakeTimers();
        try {
            const kids = [fakeChild([null]), fakeChild([null]), fakeChild([answer()])];
            let n = 0;
            const spawnFn = vi.fn(() => kids[n++].child as never);
            let t = 0;
            const r = new MediaSessionReader('win32', vi.fn(), spawnFn, () => (t += 10_000));
            const p1 = r.read(false); await vi.advanceTimersByTimeAsync(6500);
            expect(await p1).toEqual({ supported: true, playing: null, issue: null });
            const p2 = r.read(false); await vi.advanceTimersByTimeAsync(6500);
            expect(await p2).toEqual({ supported: true, playing: null, issue: { kind: 'helper_failed' } });
            const p3 = r.read(false); await vi.advanceTimersByTimeAsync(50);
            expect(await p3).toMatchObject({ playing: { title: 'Teardrop' }, issue: null });
            expect(spawnFn).toHaveBeenCalledTimes(3);
            expect(kids[0].child.kill).toHaveBeenCalled();
            r.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('a helper that cannot start reads as unsupported (no_powershell), and is not retried', async () => {
        const spawnFn = vi.fn(() => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); });
        let t = 0;
        const r = new MediaSessionReader('win32', vi.fn(), spawnFn as never, () => (t += 10_000));
        await expect(r.read(false)).resolves.toEqual({ supported: false, reason: 'no_powershell' });
        await r.read(false);
        expect(spawnFn).toHaveBeenCalledTimes(1);
    });
});

type ExecCb = (e: Error | null, out: string, err: string) => void;

describe('MediaSessionReader (mac)', () => {
    it('never runs the script for an app that is not running; reads Music and its cover once per track', async () => {
        const calls: string[][] = [];
        const covers: string[] = [];
        const execFileFn = vi.fn((file: string, args: string[], _o: unknown, cb: ExecCb) => {
            calls.push([file, ...args]);
            if (file.endsWith('pgrep')) return args[1] === 'Music' ? cb(null, '123\n', '') : cb(Object.assign(new Error('exit 1'), { code: 1 }), '', '');
            if (args[1] === MAC_MUSIC_ART_SCRIPT) { covers.push(args[2]); fs.writeFileSync(args[2], PNG); return cb(null, 'ok\n', ''); }
            cb(null, 'apple_music\tSong\tSinger\tRecord\t200000\t1000\n', '');
        });
        let t = 0;
        const r = new MediaSessionReader('darwin', execFileFn as never, vi.fn() as never, () => (t += 10_000));
        const a = await r.read(false);
        expect(a).toMatchObject({ supported: true, issue: null, playing: { source: 'apple_music', title: 'Song', player: 'Apple Music' } });
        expect((a as { playing: { art: string } }).playing.art).toMatch(/^data:image\/png;base64,/);
        await r.read(false);
        expect(covers).toHaveLength(1);
        // The temp cover is deleted after reading, and the private dir on stop().
        expect(fs.existsSync(covers[0])).toBe(false);
        const dir = path.dirname(covers[0]);
        expect(fs.statSync(dir).mode & 0o077).toBe(0);
        r.stop();
        expect(fs.existsSync(dir)).toBe(false);
        expect(calls.filter((c) => c[0].endsWith('osascript') && c[2].includes('tell application "Spotify"'))).toHaveLength(0);
    });

    it('Spotify: the cover URL is fetched only from i.scdn.co', async () => {
        const fetchArt = vi.fn(async () => JPEG);
        let artUrl = 'https://i.scdn.co/image/ab67616d0000b273abc';
        const execFileFn = vi.fn((file: string, args: string[], _o: unknown, cb: ExecCb) => {
            if (file.endsWith('pgrep')) return args[1] === 'Spotify' ? cb(null, '9\n', '') : cb(Object.assign(new Error('exit 1'), { code: 1 }), '', '');
            if (args[1] === MAC_SPOTIFY_ART_SCRIPT) return cb(null, `${artUrl}\n`, '');
            cb(null, `spotify\t${artUrl.length}\tArtist\tAlbum\t200000\t1000\n`, '');
        });
        let t = 0;
        const r = new MediaSessionReader('darwin', execFileFn as never, vi.fn() as never, () => (t += 10_000), undefined, undefined, fetchArt);
        const a = await r.read(false);
        expect((a as { playing: { art: string } }).playing.art).toMatch(/^data:image\/jpeg;base64,/);
        expect(fetchArt).toHaveBeenCalledWith('https://i.scdn.co/image/ab67616d0000b273abc');
        artUrl = 'https://evil.example/track.jpg'; // a new "track" (the title above is the URL's length)
        const b = await r.read(false);
        expect(b).toMatchObject({ playing: { art: null } });
        expect(fetchArt).toHaveBeenCalledTimes(1);
    });

    it('Automation denied -> issue mac_permission (and no crash, no track)', async () => {
        const execFileFn = vi.fn((file: string, args: string[], _o: unknown, cb: ExecCb) => {
            if (file.endsWith('pgrep')) return args[1] === 'Spotify' ? cb(null, '9\n', '') : cb(Object.assign(new Error('exit 1'), { code: 1 }), '', '');
            cb(Object.assign(new Error('Command failed'), { code: 1 }), '', '0:120: execution error: Not authorized to send Apple events to Spotify. (-1743)\n');
        });
        const r = new MediaSessionReader('darwin', execFileFn as never, vi.fn() as never, () => 0);
        await expect(r.read(false)).resolves.toEqual({ supported: true, playing: null, issue: { kind: 'mac_permission', app: 'Spotify' } });
    });
});

describe('MediaSessionReader (linux, MPRIS)', () => {
    const fakeBus = (players: Record<string, Record<string, unknown>>): MprisBus & { closed: boolean } => {
        const bus = {
            closed: false,
            listNames: async () => ['org.freedesktop.DBus', ':1.42', ...Object.keys(players).map((n) => `org.mpris.MediaPlayer2.${n}`)],
            getAll: async (name: string) => {
                const p = players[name.replace('org.mpris.MediaPlayer2.', '')];
                if (!p) throw new Error('org.freedesktop.DBus.Error.ServiceUnknown');
                return p;
            },
            close: () => { bus.closed = true; },
        };
        return bus;
    };

    it('reads the playing player straight off the bus (no playerctl), with a local cover', async () => {
        const players: Record<string, Record<string, unknown>> = {
            'chromium.instance1': { PlaybackStatus: 'Playing', Metadata: { 'xesam:title': 'Video', 'xesam:artist': ['Ch'] } },
            strawberry: { PlaybackStatus: 'Playing', Position: 5_000_000n, Metadata: { 'xesam:title': 'Angel', 'xesam:artist': ['Massive Attack'], 'mpris:length': 380_000_000n, 'mpris:artUrl': 'file:///tmp/c.png' } },
        };
        const bus = fakeBus(players);
        const execFileFn = vi.fn();
        const r = new MediaSessionReader('linux', execFileFn as never, vi.fn() as never, () => 0, () => bus, (p) => (p === '/tmp/c.png' ? PNG : null));
        const a = await r.read(false);
        expect(a).toMatchObject({ supported: true, issue: null, playing: { source: 'other', title: 'Angel', positionMs: 5000, durationMs: 380000, player: 'Strawberry' } });
        expect((a as { playing: { art: string } }).playing.art).toMatch(/^data:image\/png/);
        expect(execFileFn).not.toHaveBeenCalled();
        r.stop();
        expect(bus.closed).toBe(true);
    });

    it('a player that quits between ListNames and GetAll is skipped', async () => {
        const bus = fakeBus({});
        bus.listNames = async () => ['org.mpris.MediaPlayer2.gone'];
        const r = new MediaSessionReader('linux', vi.fn() as never, vi.fn() as never, () => 0, () => bus);
        await expect(r.read(false)).resolves.toEqual({ supported: true, playing: null, issue: null });
    });

    it('no session bus -> unsupported (no_dbus), asked once', async () => {
        const factory = vi.fn(() => null);
        let t = 0;
        const r = new MediaSessionReader('linux', vi.fn() as never, vi.fn() as never, () => (t += 10_000), factory);
        await expect(r.read(false)).resolves.toEqual({ supported: false, reason: 'no_dbus' });
        await r.read(false);
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it('a dead connection is dropped and re-made on the next read', async () => {
        const dead = fakeBus({});
        dead.listNames = async () => { throw new Error('bus closed'); };
        const live = fakeBus({ spotify: { PlaybackStatus: 'Playing', Metadata: { 'xesam:title': 'T', 'xesam:artist': ['A'] } } });
        const buses = [dead, live];
        let t = 0;
        const r = new MediaSessionReader('linux', vi.fn() as never, vi.fn() as never, () => (t += 10_000), () => buses.shift() ?? null, () => null, async () => null);
        await expect(r.read(false)).resolves.toMatchObject({ playing: null });
        expect(dead.closed).toBe(true);
        await expect(r.read(false)).resolves.toMatchObject({ playing: { source: 'spotify', title: 'T' } });
    });

    it('other platforms: unsupported (platform)', async () => {
        await expect(new MediaSessionReader('freebsd').read(false)).resolves.toEqual({ supported: false, reason: 'platform' });
    });
});
