/**
 * The look at the OS media session that happens BEFORE consent. What these pin:
 * it reads no title by construction, the renderer gets one boolean, it is music
 * only, and it holds no timer or process once it has answered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isMusicApp, MUSIC_PROBE_MIN_GAP_MS, MusicPresenceProbe, windowsStatePlaysMusic, WINDOWS_STATE_SCRIPT, type MprisStatusBus } from './music-detect';
import { WINDOWS_SCRIPT } from './media-session';
import { UNGUARDED_IPC_CHANNELS } from './ipc-guard';

const src = (f: string) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const decoded = (b64: string) => Buffer.from(b64, 'base64').toString('utf16le');

describe('isMusicApp: known music apps only', () => {
    it.each([
        ['Spotify.exe'], ['SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify'], ['AppleInc.AppleMusicWin_nzyj5cx40ttqa!App'], ['TIDAL.exe'],
        ['foobar2000.exe'], ['Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic'], ['spotify'], ['rhythmbox'], ['plexamp'],
    ])('%s counts', (app) => expect(isMusicApp(app)).toBe(true));

    it.each([
        ['chrome.exe'], ['Chrome'], ['MSEdge'], ['308046B0AF4A39CB'], ['firefox'], ['chromium.instance42'],
        ['vlc.exe'], ['mpv'], ['Netflix'], ['Microsoft.ZuneVideo'], ['plex'], ['discord'], ['steam.exe'], ['chat.cipherline.app'], ['SomeUnknownApp.exe'], [''],
    ])('%p does not (browsers, video apps, calls, games, unknown apps)', (app) => expect(isMusicApp(app)).toBe(false));

    it('a music app that Windows says is playing a video or an image does not count', () => {
        expect(isMusicApp('Spotify.exe', 1)).toBe(true);
        expect(isMusicApp('Spotify.exe', 2)).toBe(false);
        expect(isMusicApp('Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic', 2)).toBe(false);
        expect(isMusicApp('Spotify.exe', 3)).toBe(false);
    });
});

describe('windowsStatePlaysMusic', () => {
    const line = (...s: unknown[]) => JSON.stringify({ sessions: s });
    it('a playing music app is yes, whatever else is going on', () => {
        expect(windowsStatePlaysMusic(line({ app: 'chrome.exe', status: 4, ptype: 1 }, { app: 'Spotify.exe', status: 4, ptype: 1 }))).toBe(true);
    });
    it('a browser alone is no, although browsers report every tab as Music', () => {
        expect(windowsStatePlaysMusic(line({ app: 'chrome.exe', status: 4, ptype: 1 }))).toBe(false);
    });
    it('paused, a video, nothing at all, or a malformed answer is no', () => {
        expect(windowsStatePlaysMusic(line({ app: 'Spotify.exe', status: 5, ptype: 1 }))).toBe(false);
        expect(windowsStatePlaysMusic(line({ app: 'Spotify.exe', status: 4, ptype: 2 }))).toBe(false);
        expect(windowsStatePlaysMusic(line())).toBe(false);
        for (const bad of ['', 'not json', 'null', '[]', '{"sessions":"x"}', '{"sessions":[null,3,{"status":4}]}']) expect(windowsStatePlaysMusic(bad)).toBe(false);
    });
});

describe('the Windows script reads playback state and nothing else', () => {
    // Everything that could yield a title, artist, album, cover, position or window title.
    const READS = /TryGetMediaPropertiesAsync|\.Title\b|\.Artist\b|AlbumTitle|AlbumArtist|Thumbnail|GetTimelineProperties|Get-Process|MainWindowTitle|EnumWindows|GetWindowText/;

    it('none of those appear in the pre-consent script', () => {
        expect(WINDOWS_STATE_SCRIPT).not.toMatch(READS);
    });
    it('positive control: the same pattern does catch the sharing reader, so the check above is not vacuous', () => {
        expect(WINDOWS_SCRIPT).toMatch(READS);
        for (const name of ['TryGetMediaPropertiesAsync', 'Thumbnail', 'GetTimelineProperties', 'Get-Process', 'EnumWindows']) expect(WINDOWS_SCRIPT).toContain(name);
    });
    it('it does ask for what it needs', () => {
        for (const name of ['GetSessions', 'GetPlaybackInfo', 'PlaybackStatus', 'PlaybackType', 'SourceAppUserModelId']) expect(WINDOWS_STATE_SCRIPT).toContain(name);
    });
});

describe('MusicPresenceProbe on Windows', () => {
    let now = 1_000_000;
    const clock = () => now;
    const SPOTIFY = JSON.stringify({ sessions: [{ app: 'Spotify.exe', status: 4, ptype: 1 }] });
    const execWith = (out: string, err: (Error & { code?: unknown }) | null = null) => vi.fn((_f: string, _a: string[], _o: unknown, cb: (e: typeof err, s: string) => void) => cb(err, out));
    const probe = (exec: ReturnType<typeof execWith>) => new MusicPresenceProbe('win32', exec, () => null, clock);

    it('answers a bare boolean, even from an answer that smuggles text', async () => {
        const out = JSON.stringify({ title: 'Teardrop', sessions: [{ app: 'Spotify.exe', status: 4, ptype: 1, title: 'Teardrop', artist: 'Massive Attack' }] });
        await expect(probe(execWith(out)).check()).resolves.toBe(true);
    });

    it('runs the state script, hidden and with a timeout, never the sharing reader', async () => {
        const exec = execWith(SPOTIFY);
        await probe(exec).check();
        const [file, args, opts] = exec.mock.calls[0] as unknown as [string, string[], { windowsHide: boolean; timeout: number }];
        expect(file).toBe('powershell.exe');
        expect(opts.windowsHide).toBe(true);
        expect(opts.timeout).toBeGreaterThan(0);
        expect(decoded(args[args.indexOf('-EncodedCommand') + 1])).toBe(WINDOWS_STATE_SCRIPT);
    });

    it('a burst of asks makes one read: at most one per MUSIC_PROBE_MIN_GAP_MS whatever a renderer does', async () => {
        const exec = execWith(SPOTIFY);
        const p = probe(exec);
        await Promise.all([p.check(), p.check()]);
        await p.check();
        expect(exec).toHaveBeenCalledTimes(1);
        now += MUSIC_PROBE_MIN_GAP_MS;
        await p.check();
        expect(exec).toHaveBeenCalledTimes(2);
    });

    it('any failure is no; a missing PowerShell stops further attempts', async () => {
        await expect(probe(execWith('', new Error('boom'))).check()).resolves.toBe(false);
        const gone = execWith('', Object.assign(new Error('nope'), { code: 'ENOENT' }));
        const p = probe(gone);
        await expect(p.check()).resolves.toBe(false);
        now += MUSIC_PROBE_MIN_GAP_MS * 10;
        await expect(p.check()).resolves.toBe(false);
        expect(gone).toHaveBeenCalledTimes(1);
    });
});

describe('MusicPresenceProbe leaves nothing running', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });
    it('no timer once it has answered, and no read without being asked', async () => {
        const exec = vi.fn((_f: string, _a: string[], _o: unknown, cb: (e: null, s: string) => void) => cb(null, '{"sessions":[]}'));
        const p = new MusicPresenceProbe('win32', exec);
        await p.check();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(24 * 3600_000);
        expect(exec).toHaveBeenCalledTimes(1);
    });
});

describe('MusicPresenceProbe on Linux', () => {
    const makeBus = (status: Record<string, unknown>, names = Object.keys(status)) => {
        const bus = {
            listNames: vi.fn(async () => ['org.freedesktop.DBus', ...names]),
            playbackStatus: vi.fn(async (n: string) => { if (status[n] instanceof Error) throw status[n]; return status[n]; }),
            close: vi.fn(),
        };
        return bus satisfies MprisStatusBus;
    };
    const P = 'org.mpris.MediaPlayer2.';

    it('a playing music player is yes, and the connection is closed', async () => {
        const bus = makeBus({ [`${P}spotify`]: 'Playing' });
        await expect(new MusicPresenceProbe('linux', vi.fn(), () => bus).check()).resolves.toBe(true);
        expect(bus.close).toHaveBeenCalledTimes(1);
    });
    it('a browser is not even asked; paused is no; a player that fails is skipped', async () => {
        const bus = makeBus({ [`${P}chromium.instance42`]: 'Playing', [`${P}firefox`]: 'Playing', [`${P}vlc`]: 'Playing', [`${P}rhythmbox`]: 'Paused', [`${P}spotify`]: new Error('gone') });
        await expect(new MusicPresenceProbe('linux', vi.fn(), () => bus).check()).resolves.toBe(false);
        expect(bus.playbackStatus.mock.calls.map((c) => c[0]).sort()).toEqual([`${P}rhythmbox`, `${P}spotify`]);
        expect(bus.close).toHaveBeenCalledTimes(1);
    });
    it('no session bus: no, and it stops trying', async () => {
        const factory = vi.fn(() => null);
        let t = 0;
        const p = new MusicPresenceProbe('linux', vi.fn(), factory, () => t);
        await expect(p.check()).resolves.toBe(false);
        t += MUSIC_PROBE_MIN_GAP_MS * 10;
        await expect(p.check()).resolves.toBe(false);
        expect(factory).toHaveBeenCalledTimes(1);
    });
});

describe('macOS is not offered', () => {
    it('no process, no Apple Event: an Apple Event would pop the Automation dialog before consent', async () => {
        const exec = vi.fn();
        const bus = vi.fn(() => null);
        await expect(new MusicPresenceProbe('darwin', exec, bus).check()).resolves.toBe(false);
        expect(exec).not.toHaveBeenCalled();
        expect(bus).not.toHaveBeenCalled();
    });
});

describe('wiring: what crosses into the renderer before consent', () => {
    it('the handler takes no arguments and returns only the probe\'s boolean', () => {
        expect(src('main.ts')).toContain("ipcMain.handle('media:music-playing', () => (mediaWatch.active ? false : musicProbe.check()));");
    });
    it('the preload passes no arguments and lets only a literal true through', () => {
        expect(src('preload.ts')).toContain("isMusicPlaying: (): Promise<boolean> => ipcRenderer.invoke('media:music-playing').then((v: unknown) => v === true),");
    });
    it('the channel is under the sender guard', () => {
        expect(UNGUARDED_IPC_CHANNELS.has('media:music-playing')).toBe(false);
    });
    it('this module logs nothing, sends nothing and starts nothing on a timer', () => {
        const code = src('music-detect.ts').replace(/^\s*\/\/.*$/gm, '');
        expect(code).not.toMatch(/console\.|fetch\(|https?:|XMLHttpRequest|setInterval|setTimeout|net\.|appendFile|writeFile/);
        // Positive control: the sharing reader, which does fetch covers and arm timers, trips the same pattern.
        expect(src('media-session.ts').replace(/^\s*\/\/.*$/gm, '')).toMatch(/console\.|fetch\(|https?:|XMLHttpRequest|setInterval|setTimeout|net\.|appendFile|writeFile/);
    });
});
