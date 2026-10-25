// "Listening to ..." — what music THIS machine is playing, read from the
// operating system's own media session. No Spotify (or any other) account,
// no network: the OS already knows what is playing because the music app
// publishes it for the media keys / lock screen.
//
//   Windows  System Media Transport Controls (WinRT
//            GlobalSystemMediaTransportControlsSessionManager), through ONE
//            long-lived, hidden Windows PowerShell 5.1 child that reads the
//            current session only when asked (a line on stdin) and exits when
//            stdin closes. Works for Spotify, Apple Music, TIDAL, Deezer,
//            Amazon Music, foobar2000, browsers, ... — whatever registers a
//            session. No native addon, nothing to rebuild.
//   macOS    AppleScript for the two apps that expose a dictionary (Spotify,
//            Music), only when that app is already RUNNING (checked with
//            pgrep first, so the script never launches it or asks "Where is
//            Spotify?"). macOS asks the user once for Automation permission.
//   Linux    MPRIS via `playerctl` when it is installed; otherwise unsupported.
//
// Privacy: the renderer asks only while the user has switched this on
// (Settings > Connections, off by default) and polls only while the app is in
// use. What is read never leaves the device except the small text record the
// renderer chooses to publish (title, artist, album, app, timing); the cover
// art travels to the renderer only, for the user's OWN view.
//
// Child processes: spawned/execFile'd directly, never through a shell, hidden,
// with timeouts. Nothing is logged.

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process';

export type ListenSource =
    | 'spotify' | 'apple_music' | 'youtube_music' | 'tidal' | 'deezer' | 'amazon_music' | 'soundcloud' | 'browser' | 'other';

export interface NowPlaying {
    source: ListenSource;
    title: string;
    artist: string;
    album: string | null;
    durationMs: number | null;
    positionMs: number | null;
    /** data:image/... cover for the user's own view only, or null. */
    art: string | null;
}

export type MediaReadResult =
    | { supported: false }
    | { supported: true; playing: NowPlaying | null };

// ── Pure helpers (unit-tested) ────────────────────────────────────────────

/**
 * The app behind a media session -> a coarse source, or null for apps we do
 * not treat as music (video players, games, unknown apps). Matches on the
 * lowercased Windows AppUserModelId / process name, the mac app, or the MPRIS
 * player name.
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
    if (/(foobar2000|musicbee|aimp|winamp|zunemusic|strawberry|clementine|rhythmbox|lollypop|elisa|audacious|cmus|mpd|quodlibet|amarok|tauon|cider)/.test(a)) return 'other';
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
export const ART_MAX_BYTES = 256 * 1024;

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
 * One JSON line from the Windows helper -> NowPlaying (null = nothing playing
 * / not music / unreadable). `now` adjusts the position for the time since
 * Windows last updated it.
 */
export function parseWindowsLine(line: string, opts: { includeBrowser: boolean; now: number }): { playing: NowPlaying | null; art: string | null; key: string | null } {
    let o: Record<string, unknown>;
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { return { playing: null, art: null, key: null }; }
    if (!o || o.ok !== true || o.status !== WIN_PLAYING) return { playing: null, art: null, key: null };
    const source = classifySource(typeof o.app === 'string' ? o.app : '');
    if (!source || (source === 'browser' && !opts.includeBrowser)) return { playing: null, art: null, key: null };
    const title = clean(o.title, 120);
    const artist = clean(o.artist, 200);
    if (!title || !artist) return { playing: null, art: null, key: null };
    const dur = msOrNull(o.dur);
    let pos = typeof o.pos === 'number' && Number.isFinite(o.pos) && o.pos >= 0 ? o.pos : null;
    const upd = typeof o.upd === 'number' && Number.isFinite(o.upd) && o.upd > 0 ? o.upd : null;
    if (pos !== null && upd !== null && upd <= opts.now) pos += opts.now - upd;
    if (pos !== null && dur !== null) pos = Math.min(pos, dur);
    const key = `${source}|${title}|${artist}`;
    return {
        playing: { source, title, artist, album: clean(o.album, 120), durationMs: dur, positionMs: pos !== null ? Math.round(pos) : null, art: null },
        art: artDataUri(o.art),
        key,
    };
}

/** macOS script output: `source<TAB>title<TAB>artist<TAB>album<TAB>durationMs<TAB>positionMs`. */
export function parseMacOutput(out: string): NowPlaying | null {
    const f = out.replace(/\r?\n$/, '').split('\t');
    if (f.length < 6) return null;
    const source = f[0] === 'spotify' ? 'spotify' : f[0] === 'apple_music' ? 'apple_music' : null;
    const title = clean(f[1], 120);
    const artist = clean(f[2], 200);
    if (!source || !title || !artist) return null;
    const dur = msOrNull(Number(f[4]));
    const pos = Number(f[5]);
    return { source, title, artist, album: clean(f[3], 120), durationMs: dur, positionMs: Number.isFinite(pos) && pos >= 0 ? Math.round(dur ? Math.min(pos, dur) : pos) : null, art: null };
}

/** `playerctl -a metadata --format ...` output (one player per line) -> the first PLAYING music player. */
export function parsePlayerctl(out: string, includeBrowser: boolean): NowPlaying | null {
    for (const line of out.split('\n')) {
        const f = line.split('\t');
        if (f.length < 7 || f[0] !== 'Playing') continue;
        const source = classifySource(f[1]);
        if (!source || (source === 'browser' && !includeBrowser)) continue;
        const title = clean(f[2], 120);
        const artist = clean(f[3], 200);
        if (!title || !artist) continue;
        const durUs = Number(f[5]);
        const posUs = Number(f[6]);
        const dur = msOrNull(durUs / 1000);
        const pos = Number.isFinite(posUs) && posUs >= 0 ? Math.round(posUs / 1000) : null;
        return { source, title, artist, album: clean(f[4], 120), durationMs: dur, positionMs: pos !== null && dur !== null ? Math.min(pos, dur) : pos, art: null };
    }
    return null;
}

// ── Windows helper script ─────────────────────────────────────────────────
//
// Windows PowerShell 5.1 (powershell.exe, NOT pwsh: only 5.1 projects WinRT
// types). Reads one session per line received on stdin; exits on EOF. The
// cover is sent only when the track changes (it is the expensive part).

export const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); if (-not $task.Wait(3000)) { return $null }; return $task.Result }
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$mgr = $null
$lastKey = ''
while ($true) {
  $req = [Console]::In.ReadLine()
  if ($req -eq $null -or $req -eq 'q') { break }
  $out = @{ ok = $true }
  try {
    if ($mgr -eq $null) { $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]) }
    $s = $null
    if ($mgr -ne $null) { $s = $mgr.GetCurrentSession() }
    if ($s -ne $null) {
      $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $tl = $s.GetTimelineProperties()
      $out.app = [string]$s.SourceAppUserModelId
      $out.status = [int]$s.GetPlaybackInfo().PlaybackStatus
      if ($p -ne $null) {
        $out.title = [string]$p.Title
        $out.artist = [string]$p.Artist
        $out.album = [string]$p.AlbumTitle
      }
      $out.dur = [int64]$tl.EndTime.TotalMilliseconds
      $out.pos = [int64]$tl.Position.TotalMilliseconds
      $out.upd = [int64]$tl.LastUpdatedTime.ToUnixTimeMilliseconds()
      $key = "$($out.app)|$($out.title)|$($out.artist)"
      if ($req -eq 'a') { $lastKey = '' }
      if ($key -ne $lastKey -and $p -ne $null -and $p.Thumbnail -ne $null) {
        $lastKey = $key
        $st = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        if ($st -ne $null -and $st.Size -le 262144) {
          $ns = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($st)
          $ms = New-Object System.IO.MemoryStream
          $ns.CopyTo($ms)
          $out.art = [Convert]::ToBase64String($ms.ToArray())
          $ms.Dispose(); $ns.Dispose()
        }
      }
    }
  } catch { $out = @{ ok = $false } }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
`;

/** pwsh-safe encoding for `-EncodedCommand`: UTF-16LE base64. */
export const encodePowerShell = (script: string): string => Buffer.from(script, 'utf16le').toString('base64');

// ── macOS script ──────────────────────────────────────────────────────────

const macScript = (app: 'Spotify' | 'Music'): string => app === 'Spotify'
    ? `tell application "Spotify"
  if player state is playing then
    set t to current track
    return "spotify" & tab & (name of t) & tab & (artist of t) & tab & (album of t) & tab & ((duration of t) as integer) & tab & (((player position) * 1000) as integer)
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

// ── The reader ────────────────────────────────────────────────────────────

const CHILD_TIMEOUT_MS = 6000;
/** The Windows helper exits after this long without a request (Settings off, app idle). */
export const HELPER_IDLE_MS = 2 * 60_000;
/** Answers are reused for this long (two windows asking at once, a fast re-render). */
const CACHE_MS = 3000;

type ExecFileFn = (file: string, args: string[], opts: { timeout: number; windowsHide: boolean; maxBuffer: number }, cb: (err: Error | null, stdout: string) => void) => void;
type SpawnFn = (cmd: string, args: string[], opts: { windowsHide: boolean; stdio: 'pipe' }) => ChildProcessWithoutNullStreams;

export class MediaSessionReader {
    private child: ChildProcessWithoutNullStreams | null = null;
    private buf = '';
    private waiters: Array<(line: string | null) => void> = [];
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private cache: { at: number; browser: boolean; value: MediaReadResult } | null = null;
    private inflight: Promise<MediaReadResult> | null = null;
    private lastArt: { key: string; art: string | null } | null = null;
    private unsupported = false;

    constructor(
        private readonly platform: NodeJS.Platform = process.platform,
        private readonly execFileFn: ExecFileFn = execFile as unknown as ExecFileFn,
        private readonly spawnFn: SpawnFn = spawn as unknown as SpawnFn,
        private readonly now: () => number = Date.now,
    ) {}

    /** What is playing now (music apps only; browsers only when asked). Never throws. */
    read(includeBrowser: boolean): Promise<MediaReadResult> {
        if (this.cache && this.cache.browser === includeBrowser && this.now() - this.cache.at < CACHE_MS) return Promise.resolve(this.cache.value);
        if (this.inflight) return this.inflight;
        this.inflight = this.readFresh(includeBrowser)
            .catch((): MediaReadResult => ({ supported: true, playing: null }))
            .then((value) => { this.cache = { at: this.now(), browser: includeBrowser, value }; return value; })
            .finally(() => { this.inflight = null; });
        return this.inflight;
    }

    /** Stop the helper now (Settings switched off, app quitting). */
    stop(): void {
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        const c = this.child;
        this.child = null;
        this.lastArt = null;
        this.cache = null;
        if (c) {
            try { c.stdin.end('q\n'); } catch { /* already gone */ }
            setTimeout(() => { try { c.kill(); } catch { /* gone */ } }, 1000).unref?.();
        }
        for (const w of this.waiters.splice(0)) w(null);
    }

    private async readFresh(includeBrowser: boolean): Promise<MediaReadResult> {
        if (this.unsupported) return { supported: false };
        if (this.platform === 'win32') return this.readWindows(includeBrowser);
        if (this.platform === 'darwin') return this.readMac();
        if (this.platform === 'linux') return this.readLinux(includeBrowser);
        return { supported: false };
    }

    private run(file: string, args: string[]): Promise<string | null> {
        return new Promise((resolve) => {
            try {
                this.execFileFn(file, args, { timeout: CHILD_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout) => {
                    if (err) {
                        if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.unsupported = true;
                        resolve(null);
                    } else resolve(String(stdout));
                });
            } catch {
                resolve(null);
            }
        });
    }

    private async readMac(): Promise<MediaReadResult> {
        for (const app of ['Spotify', 'Music'] as const) {
            // pgrep exits 1 when nothing matches: that is "not running", not an error worth anything.
            const running = await this.run('/usr/bin/pgrep', ['-x', app]);
            if (!running || !running.trim()) continue;
            const out = await this.run('/usr/bin/osascript', ['-e', macScript(app)]);
            const p = out ? parseMacOutput(out) : null;
            if (p) return { supported: true, playing: p };
        }
        return { supported: true, playing: null };
    }

    private async readLinux(includeBrowser: boolean): Promise<MediaReadResult> {
        const out = await this.run('playerctl', ['-a', 'metadata', '--format',
            '{{status}}\t{{playerName}}\t{{title}}\t{{artist}}\t{{album}}\t{{mpris:length}}\t{{position}}']);
        if (this.unsupported) return { supported: false };
        return { supported: true, playing: out ? parsePlayerctl(out, includeBrowser) : null };
    }

    private async readWindows(includeBrowser: boolean): Promise<MediaReadResult> {
        const child = this.ensureChild();
        if (!child) return { supported: false };
        this.armIdle();
        const line = await new Promise<string | null>((resolve) => {
            const t = setTimeout(() => {
                const i = this.waiters.indexOf(done);
                if (i >= 0) this.waiters.splice(i, 1);
                resolve(null);
            }, CHILD_TIMEOUT_MS);
            const done = (l: string | null) => { clearTimeout(t); resolve(l); };
            this.waiters.push(done);
            try { child.stdin.write(this.lastArt ? 'r\n' : 'a\n'); } catch { done(null); }
        });
        if (line === null) return { supported: true, playing: null };
        const r = parseWindowsLine(line, { includeBrowser, now: this.now() });
        if (!r.playing || !r.key) return { supported: true, playing: null };
        // The helper sends the cover only when the track changes; keep it for that track.
        if (r.art || !this.lastArt || this.lastArt.key !== r.key) this.lastArt = { key: r.key, art: r.art };
        return { supported: true, playing: { ...r.playing, art: this.lastArt.art } };
    }

    private ensureChild(): ChildProcessWithoutNullStreams | null {
        if (this.child) return this.child;
        let c: ChildProcessWithoutNullStreams;
        try {
            c = this.spawnFn('powershell.exe', [
                '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(WINDOWS_SCRIPT),
            ], { windowsHide: true, stdio: 'pipe' });
        } catch {
            this.unsupported = true;
            return null;
        }
        this.child = c;
        this.buf = '';
        c.stdout.setEncoding('utf8');
        c.stdout.on('data', (chunk: string) => {
            this.buf += chunk;
            if (this.buf.length > 2 * 1024 * 1024) this.buf = ''; // a runaway line is dropped, not buffered forever
            let nl: number;
            while ((nl = this.buf.indexOf('\n')) >= 0) {
                const line = this.buf.slice(0, nl).trim();
                this.buf = this.buf.slice(nl + 1);
                if (line) this.waiters.shift()?.(line);
            }
        });
        c.stderr.on('data', () => { /* never logged: it can carry track titles */ });
        c.on('error', (e: NodeJS.ErrnoException) => {
            if (e?.code === 'ENOENT') this.unsupported = true;
            if (this.child === c) this.child = null;
            for (const w of this.waiters.splice(0)) w(null);
        });
        c.on('exit', () => {
            if (this.child === c) { this.child = null; this.lastArt = null; }
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
