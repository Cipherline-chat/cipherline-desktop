// "Listening to / Watching": the POLLING SCHEDULE, in the main process.
//
// Until 2026-10-28 the renderer polled (10 s with the window focused, 30 s in
// the background, not at all once the computer had been idle 5 minutes). Two
// things followed from that, both reported on the owner's Windows PC:
//
//  - Nothing updated while you were using another app: a track change waited
//    out the 30 s background interval, and the immediate re-read on window
//    focus made it look as if only clicking into Cipherline updated it.
//  - Watching a video means not touching the mouse or keyboard, so after 5
//    minutes the idle rule WITHDREW "Watching" exactly while you watched.
//
// Now this timer reads the media session (electron/media-session.ts) every
// MEDIA_WATCH_POLL_MS while the renderer has sharing on, whatever the window
// is doing (focused, behind other apps, minimised, hidden in the tray), and
// pushes the read to the renderer ONLY when it matters (readSignature: a new
// track / video, a cover arriving, playback stopping, a seek), plus a
// keep-alive while something plays so the renderer can re-assert the status
// before the API's record expires. An IPC message wakes the renderer even
// when its own timers would be throttled. Sharing continues while something
// is PLAYING (the OS says so), idle or not, and stops when nothing plays; the
// renderer withdraws on sign-out / sharing off, and on quit the timer stops.
//
// Cost: one read per poll. On Windows that is one line to the long-lived
// PowerShell helper (never a new process per poll); macOS pgrep + osascript;
// Linux two D-Bus calls. The reader caches for 3 s, so Settings' own probe
// shares the work.
//
// No electron import, no src/ import (the rootDir trap): unit-tested with fake
// timers in media-watch.test.ts; main.ts wires it to ipcMain / webContents.

import type { MediaReadResult, ReadOpts } from './media-session';

/** How often the media session is read while sharing is on. */
export const MEDIA_WATCH_POLL_MS = 12_000;
/**
 * While something plays and nothing changed, the read is sent again this often
 * (the renderer re-asserts the status with it; the API keeps a record ~150 s
 * and expects a refresh about every 60 s).
 */
export const MEDIA_WATCH_KEEPALIVE_MS = 50_000;
/** A position this far from where it should be is a seek: sent at once. */
export const MEDIA_WATCH_SEEK_MS = 20_000;
/** Nothing can be read on this machine (no PowerShell / no D-Bus): look again rarely. */
export const MEDIA_WATCH_UNSUPPORTED_MS = 5 * 60_000;
/** A read was still running when a new one was due (settings changed): try again this soon. */
const BUSY_RETRY_MS = 250;

/** The renderer's `media:watch` argument -> what to read, or null (= stop). Booleans must be literal. */
export function parseWatchOpts(v: unknown): ReadOpts | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    return { includeBrowser: o.includeBrowser === true, includeWatching: o.includeWatching === true };
}

/**
 * Everything about a read the renderer shows or publishes, EXCEPT the position
 * (it moves every poll). Two reads with the same signature need no new event.
 */
export function readSignature(r: MediaReadResult): string {
    if (!r.supported) return `unsupported:${r.reason}`;
    const p = r.playing;
    if (!p) return `none:${r.issue ? JSON.stringify(r.issue) : ''}`;
    // The cover by length and tail: it is a data: URI up to ~700 KB, never compared whole.
    const art = p.art ? `${p.art.length}:${p.art.slice(-32)}` : '';
    return JSON.stringify([p.kind, p.source, p.title, p.artist, p.album, p.durationMs, p.player, p.artId ?? null, p.mediaId ?? null, art, p.cover ?? null]);
}

/**
 * One content-free line saying what a read found, for the Performance log
 * (`media:read`, only when it CHANGES). Words and numbers only: whether a
 * session was found and of which kind, or why not. Never a title, an artist,
 * an app / player name or a source - what someone listens to is not logged.
 * Answers "did the Windows reader work at all" in a diagnostic report.
 */
export function describeRead(r: MediaReadResult): string {
    if (!r.supported) return `supported=0 reason=${r.reason}`;
    const kind = r.playing ? r.playing.kind : 'none';
    const i = r.issue;
    const issue = !i ? 'none' : i.kind === 'excluded' ? `excluded_${i.why}` : i.kind;
    return `supported=1 playing=${kind} issue=${issue}`;
}

/** The same for the schedule itself (`media:watch`): on, with which opt-ins, or off. */
export function describeWatch(opts: ReadOpts | null): string {
    return opts ? `on browser=${opts.includeBrowser ? 1 : 0} watching=${opts.includeWatching ? 1 : 0}` : 'off';
}

export interface WatchTimers {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}

const realTimers: WatchTimers = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class MediaWatcher {
    private opts: ReadOpts | null = null;
    private timer: unknown = null;
    /** Bumped by every configure / stop: a read that started before it is dropped. */
    private gen = 0;
    private busy = false;
    private last: { sig: string; at: number; pos: number | null } | null = null;

    constructor(
        private readonly read: (o: ReadOpts) => Promise<MediaReadResult>,
        /** Hands a read to the renderer (main.ts: webContents.send('media:now-playing-changed')). */
        private readonly emit: (r: MediaReadResult) => void,
        /** Sharing went off: end the reader's helper / bus now (main.ts: mediaSession.stop()). */
        private readonly onOff: () => void,
        private readonly now: () => number = Date.now,
        private readonly timers: WatchTimers = realTimers,
        private readonly pollMs: number = MEDIA_WATCH_POLL_MS,
    ) {}

    /** Whether sharing is on (a schedule is running). */
    get active(): boolean { return this.opts !== null; }

    /**
     * Sharing on with these opt-ins (read now, then every poll), or off (null).
     * Every configure sends its first read whatever it says: a renderer that
     * just (re)subscribed needs an answer, not "no change".
     */
    configure(opts: ReadOpts | null): void {
        if (!opts) { this.stop(); return; }
        this.opts = { includeBrowser: opts.includeBrowser === true, includeWatching: opts.includeWatching === true };
        this.gen += 1;
        this.last = null;
        this.schedule(0);
    }

    /** Sharing off / app quitting: no more reads, and the reader is told to let go of its helper. */
    stop(): void {
        const was = this.opts !== null;
        this.opts = null;
        this.gen += 1;
        this.last = null;
        if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; }
        if (was) { try { this.onOff(); } catch { /* best effort */ } }
    }

    private schedule(ms: number): void {
        if (this.timer !== null) this.timers.clear(this.timer);
        this.timer = this.timers.set(() => { this.timer = null; void this.poll(); }, ms);
    }

    private async poll(): Promise<void> {
        const opts = this.opts;
        if (!opts) return;
        if (this.busy) { this.schedule(BUSY_RETRY_MS); return; }
        const gen = this.gen;
        this.busy = true;
        let r: MediaReadResult;
        try {
            r = await this.read(opts);
        } catch {
            r = { supported: true, playing: null, issue: null };
        } finally {
            this.busy = false;
        }
        // Settings changed or sharing went off meanwhile: that call scheduled its own read (or none).
        if (gen !== this.gen || !this.opts) return;
        if (this.changed(r)) {
            try { this.emit(r); } catch { /* the window is gone: the next configure brings a new one */ }
        }
        this.schedule(r.supported ? this.pollMs : MEDIA_WATCH_UNSUPPORTED_MS);
    }

    /** Whether this read is worth an event: different, a seek, or the keep-alive is due. Records it when so. */
    private changed(r: MediaReadResult): boolean {
        const now = this.now();
        const sig = readSignature(r);
        const playing = r.supported ? r.playing : null;
        const pos = playing?.positionMs ?? null;
        const prev = this.last;
        let send = !prev || prev.sig !== sig;
        if (!send && prev && playing) {
            if (now - prev.at >= MEDIA_WATCH_KEEPALIVE_MS) send = true;
            else if (pos !== null && prev.pos !== null && Math.abs(pos - (prev.pos + (now - prev.at))) > MEDIA_WATCH_SEEK_MS) send = true;
        }
        if (send) this.last = { sig, at: now, pos };
        return send;
    }
}
