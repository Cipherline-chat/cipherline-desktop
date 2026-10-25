import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    artDataUri, classifySource, encodePowerShell, MediaSessionReader, parseMacOutput, parsePlayerctl, parseWindowsLine, WINDOWS_SCRIPT,
} from './media-session';

const JPEG_B64 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jfif-bytes-here')]).toString('base64');

describe('classifySource', () => {
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
        ['MSEdge', 'browser'],
        ['308046B0AF4A39CB', 'browser'],
        ['firefox', 'browser'],
        ['foobar2000.exe', 'other'],
        ['Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic', 'other'],
        ['rhythmbox', 'other'],
    ])('%s -> %s', (app, src) => expect(classifySource(app)).toBe(src));

    it.each(['vlc.exe', 'Netflix', 'steam.exe', 'Microsoft.ZuneVideo', '', 'mpv', 'discord'])('%p is not music', (app) => expect(classifySource(app)).toBeNull());
});

describe('parseWindowsLine', () => {
    const base = { ok: true, app: 'Spotify.exe', status: 4, title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', dur: 330_000, pos: 30_000, upd: 1_000 };
    const line = (o: object) => JSON.stringify({ ...base, ...o });

    it('a playing music session, with the position advanced since Windows last updated it', () => {
        const r = parseWindowsLine(line({ art: JPEG_B64 }), { includeBrowser: false, now: 6_000 });
        expect(r.playing).toEqual({ source: 'spotify', title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', durationMs: 330_000, positionMs: 35_000, art: null });
        expect(r.art).toMatch(/^data:image\/jpeg;base64,/);
        expect(r.key).toBe('spotify|Teardrop|Massive Attack');
    });

    it('paused / stopped / not music / browser (unless asked) / empty text -> nothing', () => {
        const opts = { includeBrowser: false, now: 0 };
        expect(parseWindowsLine(line({ status: 5 }), opts).playing).toBeNull();
        expect(parseWindowsLine(line({ app: 'vlc.exe' }), opts).playing).toBeNull();
        expect(parseWindowsLine(line({ app: 'chrome.exe' }), opts).playing).toBeNull();
        expect(parseWindowsLine(line({ app: 'chrome.exe' }), { includeBrowser: true, now: 0 }).playing).toMatchObject({ source: 'browser' });
        expect(parseWindowsLine(line({ artist: '' }), opts).playing).toBeNull();
        expect(parseWindowsLine('{"ok":false}', opts).playing).toBeNull();
        expect(parseWindowsLine('not json', opts).playing).toBeNull();
    });

    it('cleans control / bidi characters out of titles', () => {
        expect(parseWindowsLine(line({ title: '‮Tear\u0000drop' }), { includeBrowser: false, now: 0 }).playing!.title).toBe('Teardrop');
    });

    it('art must sniff as an image and stay under the cap', () => {
        expect(artDataUri(JPEG_B64)).toMatch(/^data:image\/jpeg;base64,/);
        expect(artDataUri(Buffer.from('<svg onload=alert(1)>').toString('base64'))).toBeNull();
        expect(artDataUri('not base64!')).toBeNull();
        expect(artDataUri('A'.repeat(400_000))).toBeNull();
    });
});

describe('parseMacOutput / parsePlayerctl', () => {
    it('mac', () => {
        expect(parseMacOutput('spotify\tTeardrop\tMassive Attack\tMezzanine\t330000\t31000\n'))
            .toEqual({ source: 'spotify', title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', durationMs: 330000, positionMs: 31000, art: null });
        expect(parseMacOutput('')).toBeNull();
        expect(parseMacOutput('evil\ta\tb\tc\t1\t1')).toBeNull();
    });

    it('playerctl: first PLAYING music player, microseconds -> ms', () => {
        const out = [
            'Paused\tspotify\tOld\tArtist\tAlbum\t1000000\t0',
            'Playing\tchromium.instance42\tA video\tA channel\t\t5000000\t1000000',
            'Playing\tspotify\tTeardrop\tMassive Attack\tMezzanine\t330000000\t30000000',
        ].join('\n');
        expect(parsePlayerctl(out, false)).toEqual({ source: 'spotify', title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', durationMs: 330000, positionMs: 30000, art: null });
        expect(parsePlayerctl(out, true)).toMatchObject({ source: 'browser', title: 'A video' });
        expect(parsePlayerctl('', false)).toBeNull();
    });
});

describe('the Windows helper script', () => {
    it('is Windows PowerShell 5.1 WinRT code that reads on request and exits on EOF', () => {
        expect(WINDOWS_SCRIPT).toContain("ParameterType.Name -eq 'IAsyncOperation`1'");
        expect(WINDOWS_SCRIPT).toContain('GlobalSystemMediaTransportControlsSessionManager');
        expect(WINDOWS_SCRIPT).toContain('[Console]::In.ReadLine()');
        expect(WINDOWS_SCRIPT).toMatch(/if \(\$req -eq \$null -or \$req -eq 'q'\) \{ break \}/);
        // Nothing in it talks to the network or writes to disk.
        expect(WINDOWS_SCRIPT).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|Net\.WebClient|Out-File|Set-Content|Start-Process/i);
        expect(Buffer.from(encodePowerShell('ab'), 'base64').toString('utf16le')).toBe('ab');
    });

    it('main.ts registers the IPC channels and stops the helper on quit; preload exposes them', () => {
        const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
        expect(main).toContain("ipcMain.handle('media:now-playing'");
        expect(main).toContain("ipcMain.on('media:stop', () => mediaSession.stop())");
        expect(main).toContain("app.on('will-quit', () => mediaSession.stop())");
        const preload = fs.readFileSync(path.join(__dirname, 'preload.ts'), 'utf8');
        expect(preload).toContain("ipcRenderer.invoke('media:now-playing', { includeBrowser: opts?.includeBrowser === true })");
    });
});

/** A fake powershell child that answers each stdin line with the next canned line. */
function fakeChild(lines: string[]) {
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
            if (next !== undefined) setTimeout(() => stdout.write(`${next}\r\n`), 1);
        }
    });
    return { child, requests };
}

describe('MediaSessionReader (Windows)', () => {
    const playing = (o: object = {}) => JSON.stringify({ ok: true, app: 'Spotify.exe', status: 4, title: 'Teardrop', artist: 'Massive Attack', album: 'M', dur: 300_000, pos: 0, upd: 0, ...o });

    it('one hidden powershell.exe (encoded command, no shell), reused; cover kept for the track until it changes', async () => {
        const { child, requests } = fakeChild([playing({ art: JPEG_B64 }), playing(), playing({ title: 'Angel' })]);
        const spawnFn = vi.fn(() => child as never);
        let t = 0;
        const r = new MediaSessionReader('win32', vi.fn(), spawnFn, () => (t += 10_000));
        const a = await r.read(false);
        expect(a).toMatchObject({ supported: true, playing: { title: 'Teardrop' } });
        expect((a as { playing: { art: string } }).playing.art).toMatch(/^data:image\/jpeg/);
        const b = await r.read(false);
        expect((b as { playing: { art: string } }).playing.art).toMatch(/^data:image\/jpeg/);
        const c = await r.read(false);
        expect(c).toMatchObject({ playing: { title: 'Angel', art: null } });
        expect(spawnFn).toHaveBeenCalledTimes(1);
        const [cmd, args, opts] = spawnFn.mock.calls[0] as unknown as [string, string[], { windowsHide: boolean }];
        expect(cmd).toBe('powershell.exe');
        expect(args).toContain('-EncodedCommand');
        expect(args).toContain('-NoProfile');
        expect(opts.windowsHide).toBe(true);
        expect(requests).toEqual(['a', 'r', 'r']);
        r.stop();
        expect(requests).toContain('q');
    });

    it('a helper that cannot start reads as unsupported, and is not retried', async () => {
        const spawnFn = vi.fn(() => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); });
        const r = new MediaSessionReader('win32', vi.fn(), spawnFn as never, () => 0);
        await expect(r.read(false)).resolves.toEqual({ supported: false });
        let t = 0;
        const r2 = new MediaSessionReader('win32', vi.fn(), spawnFn as never, () => (t += 10_000));
        await r2.read(false);
        await r2.read(false);
        expect(spawnFn).toHaveBeenCalledTimes(2);
    });
});

describe('MediaSessionReader (mac / linux)', () => {
    it('mac: never runs the script for an app that is not running', async () => {
        const calls: string[][] = [];
        const execFileFn = vi.fn((file: string, args: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => {
            calls.push([file, ...args]);
            if (file.endsWith('pgrep')) return args[1] === 'Music' ? cb(null, '123\n') : cb(Object.assign(new Error('exit 1'), { code: 1 }), '');
            cb(null, 'apple_music\tSong\tSinger\tRecord\t200000\t1000\n');
        });
        const r = new MediaSessionReader('darwin', execFileFn as never, vi.fn() as never, () => 0);
        await expect(r.read(false)).resolves.toMatchObject({ supported: true, playing: { source: 'apple_music', title: 'Song' } });
        expect(calls.filter((c) => c[0].endsWith('osascript'))).toHaveLength(1);
        expect(calls.find((c) => c[0].endsWith('osascript'))![2]).toContain('tell application "Music"');
    });

    it('linux without playerctl: unsupported', async () => {
        const execFileFn = vi.fn((_f: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => cb(Object.assign(new Error('spawn playerctl ENOENT'), { code: 'ENOENT' }), ''));
        const r = new MediaSessionReader('linux', execFileFn as never, vi.fn() as never, () => 0);
        await expect(r.read(false)).resolves.toEqual({ supported: false });
    });
});
