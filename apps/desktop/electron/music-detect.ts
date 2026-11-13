// "Is a music app playing right now?": the ONE look at the OS media session that
// happens BEFORE the user has agreed to share anything. It exists so Cipherline
// can ask "Show what you're listening to?" once, at the moment it makes sense
// (src/utils/integrations/listeningAsk.ts decides when; this only answers).
//
// Everything else about media (media-session.ts, media-watch.ts) reads titles
// and runs only once sharing is on. This file is deliberately NOT built on that
// reader, so consent is not a matter of remembering to throw things away:
//
//   Windows  A separate, one-shot PowerShell script (WINDOWS_STATE_SCRIPT) that
//            asks WinRT for each session's app id, playback status and playback
//            type. It never calls TryGetMediaPropertiesAsync or
//            GetTimelineProperties and never lists windows, so title, artist,
//            album, cover, position and window titles are not read at all.
//   Linux    org.freedesktop.DBus.Properties.Get of the single PlaybackStatus
//            property, on allow-listed players only. Never GetAll: that returns
//            the Metadata (title, artist) too.
//   macOS    Not offered. There is no playback state without an Apple Event, and
//            the first Apple Event to Spotify / Music pops the system dialog
//            "Cipherline wants to control Spotify" before the person has agreed
//            to anything. An app merely being open is not music playing.
//
// Privacy: the answer is ONE BOOLEAN, handed to the renderer over IPC. The app
// id stays here and is dropped; nothing is logged, kept, or sent anywhere, and
// this file makes no network call. The renderer stops asking for good once the
// question has been shown or answered, and there is no timer here at all: no
// call from the renderer, no read.
//
// Music only, and conservative: only an app on the known-music list counts
// (classifySource) and never one Windows says is playing a video. Browsers NEVER
// count: they report every tab as Music, and telling a song from a video takes
// the title, album and cover (browserKind), which this read does not have. An
// unknown app does not count either. So someone who only ever plays music in a
// browser is not asked; the switch in Settings is still there.
//
// Cost: Windows, one short-lived powershell.exe per check (no helper is kept
// alive: at this interval it would have exited between checks anyway, see
// HELPER_IDLE_MS). Linux, one short D-Bus connection and 1 + n calls. The renderer
// checks at most every LISTENING_ASK_CHECK_MS, only on input with the window
// focused; MUSIC_PROBE_MIN_GAP_MS below caps it here whatever a renderer does.
//
// No electron import, no src/ import (the rootDir trap): unit-tested in
// music-detect.test.ts; main.ts wires it to ipcMain.

import { execFile } from 'child_process';
import * as fs from 'fs';
import { classifySession, classifySource, encodePowerShell } from './media-session';

/** The most often a real read can happen, whatever the renderer asks; an earlier ask gets the last answer. */
export const MUSIC_PROBE_MIN_GAP_MS = 60_000;
/** Windows PowerShell loading WinRT from cold is slow on a busy machine. */
const PROBE_TIMEOUT_MS = 8_000;
const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
/** Windows' GlobalSystemMediaTransportControlsSessionPlaybackStatus: 4 = Playing. */
const WIN_PLAYING = 4;

/**
 * Is this app a known music app, and not playing a video? `ptype` is Windows'
 * MediaPlaybackType (1 Music, 2 Video, 3 Image), absent elsewhere. Browsers and
 * unknown apps are not. classifySession then applies the same rules sharing does
 * (calls and games never count; a video service's app is not music), given
 * placeholder text because this read has none.
 */
export function isMusicApp(app: string, ptype?: number): boolean {
    const source = classifySource(app);
    if (!source || source === 'browser') return false;
    return classifySession({ app, title: '-', artist: '-', album: null, ptype })?.kind === 'listening';
}

/**
 * Windows PowerShell 5.1, one answer then exit. Reads ONLY the app id, status
 * and playback type of sessions that are playing. A test pins that no call that
 * could read a title, cover, position or window appears in this text.
 */
export const WINDOWS_STATE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1' })[0]
$MgrT = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$task = $asTask.MakeGenericMethod($MgrT).Invoke($null, @($MgrT::RequestAsync()))
if (-not $task.Wait(3000)) { exit 0 }
$list = New-Object System.Collections.ArrayList
foreach ($s in $task.Result.GetSessions()) {
  if ($list.Count -ge 16) { break }
  try {
    $info = $s.GetPlaybackInfo()
    if ([int]$info.PlaybackStatus -eq 4) {
      $e = @{ app = [string]$s.SourceAppUserModelId; status = 4 }
      try { if ($info.PlaybackType -ne $null) { $e.ptype = [int]$info.PlaybackType } } catch { }
      [void]$list.Add($e)
    }
  } catch { }
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ sessions = $list.ToArray() } -Compress -Depth 3))
`;

/** One line from WINDOWS_STATE_SCRIPT -> is a music app playing? Anything odd is no. */
export function windowsStatePlaysMusic(line: string): boolean {
    let o: unknown;
    try { o = JSON.parse(line); } catch { return false; }
    const sessions = o && typeof o === 'object' ? (o as { sessions?: unknown }).sessions : null;
    if (!Array.isArray(sessions)) return false;
    return sessions.slice(0, 32).some((raw) => {
        const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
        return !!s && s.status === WIN_PLAYING && typeof s.app === 'string'
            && isMusicApp(s.app.slice(0, 300), typeof s.ptype === 'number' ? s.ptype : undefined);
    });
}

/** The D-Bus calls this read needs; dbus-native in the app, a fake in tests. No call here can return metadata. */
export interface MprisStatusBus {
    listNames(): Promise<string[]>;
    /** Properties.Get("org.mpris.MediaPlayer2.Player", "PlaybackStatus"). */
    playbackStatus(busName: string): Promise<unknown>;
    close(): void;
}

/** A session-bus connection through dbus-native, or null when there is no session bus. */
export function dbusStatusBus(env: NodeJS.ProcessEnv = process.env): MprisStatusBus | null {
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
    bus.connection?.on?.('error', () => { /* the pending call fails on its own; never unhandled */ });
    return {
        listNames: async () => {
            const r = await bus.invoke({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'ListNames' }, { timeout: 2000 });
            return Array.isArray(r) ? r.filter((n): n is string => typeof n === 'string') : [];
        },
        playbackStatus: async (busName) => toPlain(await bus.invoke({
            destination: busName, path: '/org/mpris/MediaPlayer2', interface: 'org.freedesktop.DBus.Properties',
            member: 'Get', signature: 'ss', body: ['org.mpris.MediaPlayer2.Player', 'PlaybackStatus'],
        }, { timeout: 1500 })),
        close: () => { try { bus.connection?.end?.(); } catch { /* gone */ } },
    };
}

type ExecFileFn = (
    file: string, args: string[], opts: { timeout: number; windowsHide: boolean; maxBuffer: number },
    cb: (err: (Error & { code?: unknown }) | null, stdout: string) => void,
) => void;

/** Answers "is a music app playing?" with a boolean. Holds no timer and no child between checks. */
export class MusicPresenceProbe {
    private inflight: Promise<boolean> | null = null;
    private last: { at: number; value: boolean } | null = null;
    private unsupported = false;

    constructor(
        private readonly platform: NodeJS.Platform = process.platform,
        private readonly execFileFn: ExecFileFn = execFile as unknown as ExecFileFn,
        private readonly busFactory: () => MprisStatusBus | null = () => dbusStatusBus(),
        private readonly now: () => number = Date.now,
    ) {}

    /** Never throws. False on any failure and on platforms this read does not cover. */
    check(): Promise<boolean> {
        if (this.unsupported || (this.platform !== 'win32' && this.platform !== 'linux')) return Promise.resolve(false);
        if (this.inflight) return this.inflight;
        if (this.last && this.now() - this.last.at < MUSIC_PROBE_MIN_GAP_MS) return Promise.resolve(this.last.value);
        this.inflight = (this.platform === 'win32' ? this.readWindows() : this.readLinux())
            .catch(() => false)
            .then((value) => { this.last = { at: this.now(), value }; return value; })
            .finally(() => { this.inflight = null; });
        return this.inflight;
    }

    private readWindows(): Promise<boolean> {
        return new Promise((resolve) => {
            try {
                // No -ExecutionPolicy: it governs script FILES only, never an -EncodedCommand. stderr is never looked at.
                this.execFileFn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(WINDOWS_STATE_SCRIPT)], {
                    timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024,
                }, (err, stdout) => {
                    if (err?.code === 'ENOENT') this.unsupported = true;
                    resolve(err ? false : windowsStatePlaysMusic(String(stdout ?? '').trim()));
                });
            } catch {
                this.unsupported = true;
                resolve(false);
            }
        });
    }

    private async readLinux(): Promise<boolean> {
        const bus = this.busFactory();
        if (!bus) { this.unsupported = true; return false; }
        try {
            const names = await bus.listNames();
            // Allow-listed names only: a browser's bus is never even asked.
            const players = names.filter((n) => n.startsWith(MPRIS_PREFIX) && isMusicApp(n.slice(MPRIS_PREFIX.length))).slice(0, 12);
            for (const name of players) {
                try {
                    if (await bus.playbackStatus(name) === 'Playing') return true;
                } catch { /* that player quit mid-read, or does not answer */ }
            }
            return false;
        } finally {
            bus.close();
        }
    }
}
