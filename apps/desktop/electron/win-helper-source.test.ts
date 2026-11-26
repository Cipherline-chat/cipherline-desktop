/**
 * Source pins for the Rust Windows helper (apps/desktop-host/win-helper). They replace the old pins on the PowerShell scripts'
 * text: what the helper may read, and what it must never do. Positive controls make sure each pattern really matches the code
 * the pin is about, so a pin cannot pass vacuously.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BROWSER_PROCESS_NAMES } from './browser-site';

const ROOT = path.join(__dirname, '../../desktop-host/win-helper/src');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
/** Rust code without comments, so a pin is about code, not prose. */
const code = (f: string) => read(f).replace(/\/\/[^\n]*/g, '');
const ALL = ['lib.rs', 'main.rs', 'ntproc.rs', 'proto.rs', 'win/mod.rs', 'win/media.rs', 'win/sig.rs', 'win/sys.rs'];

describe('the helper never does what behavioural engines flag', () => {
    const FORBIDDEN = [
        ['starts a process', /Command::new|CreateProcess|ShellExecute|WinExec|std::process::Command/],
        ['reads another process\'s memory or command line', /ReadProcessMemory|NtReadVirtualMemory|NtQueryInformationProcess|PROCESS_VM_READ|PEB\b|ProcessParameters|CommandLine|Win32_Process/],
        ['injects or writes to another process', /WriteProcessMemory|VirtualAllocEx|CreateRemoteThread|SetWindowsHookEx|QueueUserAPC/],
        ['opens a socket or talks HTTP', /std::net|TcpStream|UdpSocket|WinHttp|InternetOpen|reqwest|ureq/],
        ['writes a file', /std::fs::write|File::create|OpenOptions|CreateFileW|WriteFile/],
        ['loads code dynamically', /LoadLibrary|GetProcAddress/],
    ] as const;
    for (const [what, re] of FORBIDDEN) {
        it(`never ${what}`, () => {
            for (const f of ALL) expect(code(f), f).not.toMatch(re);
        });
    }
    it('positive control: the patterns do match what they describe', () => {
        expect('Command::new("x")').toMatch(FORBIDDEN[0][1]);
        expect('ReadProcessMemory(h)').toMatch(FORBIDDEN[1][1]);
        expect('TcpStream::connect').toMatch(FORBIDDEN[3][1]);
    });
    it('OpenProcess is only ever asked for the limited query right', () => {
        const uses = ALL.flatMap((f) => [...code(f).matchAll(/OpenProcess\(([^)]*)\)/g)].map((m) => m[1]));
        expect(uses.length).toBeGreaterThan(0);
        for (const u of uses) expect(u).toMatch(/^PROCESS_QUERY_LIMITED_INFORMATION,/);
    });
    it('the only registry key it touches is the per-app GPU preference list', () => {
        expect(read('win/sys.rs')).toContain('r"Software\\Microsoft\\DirectX\\UserGpuPreferences"');
        expect(code('win/sys.rs').match(/RegCreateKeyExW|RegSetValueExW/g)?.length).toBe(4);
        for (const f of ALL.filter((x) => x !== 'win/sys.rs')) expect(code(f), f).not.toMatch(/Reg[A-Z]\w+W\(/);
    });
});

describe('Now Playing: the pre-consent read and the sharing reader', () => {
    const media = code('win/media.rs');
    const musicState = media.slice(media.indexOf('pub fn music_state'), media.indexOf('struct Reader'));
    const READS = /TryGetMediaPropertiesAsync|\.Title\(|\.Artist\(|AlbumTitle|AlbumArtist|Thumbnail|GetTimelineProperties|window_titles|EnumWindows|GetWindowText/;
    it('music-state reads app id, status and playback type only', () => {
        expect(musicState.length).toBeGreaterThan(200);
        expect(musicState).not.toMatch(READS);
        for (const name of ['GetSessions', 'GetPlaybackInfo', 'PlaybackStatus', 'PlaybackType', 'SourceAppUserModelId']) expect(musicState).toContain(name);
    });
    it('positive control: the same pattern does catch the sharing reader', () => {
        expect(media).toMatch(READS);
        for (const name of ['TryGetMediaPropertiesAsync', 'Thumbnail', 'GetTimelineProperties', 'window_titles']) expect(media).toContain(name);
    });
    it('window titles are read only for a PLAYING browser session, by a fixed list of browser process names', () => {
        const answer = media.slice(media.indexOf('fn answer'));
        const playing = answer.indexOf('if status == PLAYING');
        const call = answer.indexOf('window_titles');
        expect(playing).toBeGreaterThan(-1);
        expect(call).toBeGreaterThan(playing);
        expect(answer.slice(0, call)).toContain('browser_proc_name(&app)');
        expect(media.match(/window_titles/g)).toHaveLength(1); // one call site, nowhere else
        const names = [...code('proto.rs').matchAll(/return Some\("([a-z]+)"\)/g)].map((m) => m[1]);
        expect([...new Set(names)].sort()).toEqual([...BROWSER_PROCESS_NAMES].sort());
    });
    it('covers are still capped at 4 MB, retried up to 6 times, and reported per session (artErr)', () => {
        expect(media).toContain('4 * 1024 * 1024');
        expect(media).toContain('n >= 6');
        for (const c of ['none', 'open_timeout', 'read_failed', 'too_big', 'empty']) expect(media).toContain(`"${c}"`);
    });
    it('at most 24 titles are read per browser', () => {
        expect(code('win/sys.rs')).toContain('.take(24)');
    });
});

describe('the Minecraft check never reads a command line', () => {
    it('matches a window title on java/javaw only', () => {
        const sys = code('win/sys.rs');
        const fn = sys.slice(sys.indexOf('pub fn minecraft_window'), sys.indexOf('pub fn exe_path'));
        expect(fn).toContain('"java" | "javaw"');
        expect(fn).toContain('is_minecraft_title');
        expect(fn).not.toMatch(/CommandLine|OpenProcess/);
    });
});
