import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
    MEDIA_WATCH_KEEPALIVE_MS, MEDIA_WATCH_POLL_MS, MEDIA_WATCH_UNSUPPORTED_MS, MediaWatcher, parseWatchOpts, readSignature,
} from './media-watch';
import { MediaSessionReader, type MediaReadResult, type NowPlaying, type ReadOpts } from './media-session';

const song = (o: Partial<NowPlaying> = {}): NowPlaying => ({
    kind: 'listening', source: 'spotify', title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine',
    durationMs: 330_000, positionMs: 0, art: null, player: 'Spotify', ...o,
});
const playing = (o: Partial<NowPlaying> = {}): MediaReadResult => ({ supported: true, playing: song(o), issue: null });
const NOTHING: MediaReadResult = { supported: true, playing: null, issue: null };
const ON: ReadOpts = { includeBrowser: true, includeWatching: true };

describe('parseWatchOpts / readSignature', () => {
    it('only literal booleans count; null / garbage = off', () => {
        expect(parseWatchOpts({ includeBrowser: true, includeWatching: 'yes' })).toEqual({ includeBrowser: true, includeWatching: false });
        expect(parseWatchOpts({})).toEqual({ includeBrowser: false, includeWatching: false });
        for (const off of [null, undefined, 'on', 1, true, []]) expect(parseWatchOpts(off)).toBeNull();
    });

    it('the position does not change the signature; the track, kind, cover, and stopping do', () => {
        const base = readSignature(playing({ positionMs: 1_000 }));
        expect(readSignature(playing({ positionMs: 90_000 }))).toBe(base);
        expect(readSignature(playing({ title: 'Angel' }))).not.toBe(base);
        expect(readSignature(playing({ kind: 'watching', source: 'browser', album: null }))).not.toBe(base);
        expect(readSignature(playing({ art: 'data:image/jpeg;base64,AAAA' }))).not.toBe(base);
        expect(readSignature(playing({ cover: { ok: false, why: 'read_failed' } }))).not.toBe(base);
        expect(readSignature(NOTHING)).not.toBe(base);
        expect(readSignature({ supported: true, playing: null, issue: { kind: 'excluded', why: 'browser', player: 'Chrome' } })).not.toBe(readSignature(NOTHING));
    });
});

describe('MediaWatcher: the main-process schedule', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    const setup = (reads: Array<MediaReadResult | (() => MediaReadResult)>) => {
        let i = 0;
        const read = vi.fn(async (_o: ReadOpts) => {
            const r = reads[Math.min(i, reads.length - 1)];
            i += 1;
            return typeof r === 'function' ? r() : r;
        });
        const emit = vi.fn();
        const onOff = vi.fn();
        const w = new MediaWatcher(read, emit, onOff, () => Date.now());
        return { w, read, emit, onOff };
    };

    it('reads at once, then every poll, with NO window involved at all (hidden / minimised / tray is the same)', async () => {
        const { w, read, emit } = setup([playing()]);
        w.configure(ON);
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledWith(ON);
        expect(emit).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(MEDIA_WATCH_POLL_MS * 3);
        expect(read).toHaveBeenCalledTimes(4);
        w.stop();
    });

    it('emits only on a change (new track, a stop, a seek) and a keep-alive while playing; not every poll', async () => {
        let pos = 0;
        let title = 'Teardrop';
        let on = true;
        const { w, read, emit } = setup([() => (on ? playing({ title, positionMs: (pos += MEDIA_WATCH_POLL_MS) }) : NOTHING)]);
        w.configure(ON);
        await vi.advanceTimersByTimeAsync(0);
        expect(emit).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(MEDIA_WATCH_POLL_MS * 2); // same track, position moving as it should
        expect(read).toHaveBeenCalledTimes(3);
        expect(emit).toHaveBeenCalledTimes(1);
        title = 'Angel';
        await vi.advanceTimersByTimeAsync(MEDIA_WATCH_POLL_MS);
        expect(emit).toHaveBeenCalledTimes(2);
        expect(emit.mock.calls[1][0]).toMatchObject({ playing: { title: 'Angel' } });
        pos += 120_000; // a seek
        await vi.advanceTimersByTimeAsync(MEDIA_WATCH_POLL_MS);
        expect(emit).toHaveBeenCalledTimes(3);
        // Unchanged long enough: one keep-alive, so the renderer can re-assert before the API's record lapses.
        await vi.advanceTimersByTimeAsync(MEDIA_WATCH_KEEPALIVE_MS + MEDIA_WATCH_POLL_MS);
        expect(emit).toHaveBeenCalledTimes(4);
        on = false;
        await vi.advanceTimersByTimeAsync(MEDIA_WATCH_POLL_MS);
        expect(emit).toHaveBeenCalledTimes(5);
        expect(emit.mock.calls[4][0]).toEqual(NOTHING);
        // Nothing playing: no keep-alive (there is nothing to keep alive).
        await vi.advanceTimersByTimeAsync(MEDIA_WATCH_KEEPALIVE_MS * 3);
        expect(emit).toHaveBeenCalledTimes(5);
        w.stop();
    });

    it('keeps sharing while something plays however long nobody touches the computer (no idle rule)', async () => {
        let pos = 0;
        const { w, emit } = setup([() => playing({ kind: 'watching', source: 'browser', album: null, durationMs: null, positionMs: (pos += MEDIA_WATCH_POLL_MS) })]);
        w.configure(ON);
        await vi.advanceTimersByTimeAsync(60 * 60_000); // an hour-long video, hands off
        const calls = emit.mock.calls.map((c) => c[0] as MediaReadResult);
        expect(calls.length).toBeGreaterThanOrEqual(55); // about one a minute, for the whole hour
        expect(calls.every((r) => r.supported && r.playing?.kind === 'watching')).toBe(true);
        w.stop();
    });

    it('stops reading when sharing goes off (and lets the reader go); a configure after that starts over', async () => {
        const { w, read, onOff, emit } = setup([playing()]);
        w.configure(ON);
        await vi.advanceTimersByTimeAsync(0);
        w.configure(null);
        expect(onOff).toHaveBeenCalledTimes(1);
        expect(w.active).toBe(false);
        await vi.advanceTimersByTimeAsync(MEDIA_WATCH_POLL_MS * 10);
        expect(read).toHaveBeenCalledTimes(1);
        w.stop(); // already off: the reader is not told twice
        expect(onOff).toHaveBeenCalledTimes(1);
        // A (re)subscribing renderer always gets a first answer, even an unchanged one.
        w.configure(ON);
        await vi.advanceTimersByTimeAsync(0);
        expect(emit).toHaveBeenCalledTimes(2);
        w.stop();
    });

    it('a read in flight when settings change is dropped; the new settings are read right after', async () => {
        let release: (r: MediaReadResult) => void = () => {};
        const read = vi.fn((o: ReadOpts) => (o.includeWatching ? new Promise<MediaReadResult>((res) => { release = res; }) : Promise.resolve(playing())));
        const emit = vi.fn();
        const w = new MediaWatcher(read, emit, vi.fn(), () => Date.now());
        w.configure(ON);
        await vi.advanceTimersByTimeAsync(0);
        w.configure({ includeBrowser: true, includeWatching: false });
        await vi.advanceTimersByTimeAsync(0);
        release(playing({ kind: 'watching', source: 'browser', album: null }));
        await vi.advanceTimersByTimeAsync(1000);
        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit.mock.calls[0][0]).toMatchObject({ playing: { kind: 'listening' } });
        expect(read).toHaveBeenLastCalledWith({ includeBrowser: true, includeWatching: false });
        w.stop();
    });

    it('nothing readable on this machine: told once, then looked at again only rarely', async () => {
        const { w, read, emit } = setup([{ supported: false, reason: 'no_powershell' }]);
        w.configure(ON);
        await vi.advanceTimersByTimeAsync(MEDIA_WATCH_POLL_MS * 5);
        expect(read).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(MEDIA_WATCH_UNSUPPORTED_MS);
        expect(read).toHaveBeenCalledTimes(2);
        w.stop();
    });

    it('a read that throws is "nothing playing", and the schedule goes on', async () => {
        let n = 0;
        const read = vi.fn(async () => { n += 1; if (n === 2) throw new Error('x'); return playing(); });
        const emit = vi.fn();
        const w = new MediaWatcher(read, emit, vi.fn(), () => Date.now());
        w.configure(ON);
        await vi.advanceTimersByTimeAsync(MEDIA_WATCH_POLL_MS * 2);
        expect(emit.mock.calls.map((c) => (c[0] as MediaReadResult).supported && !!(c[0] as { playing: unknown }).playing)).toEqual([true, false, true]);
        w.stop();
    });

    it('with the real Windows reader: ONE helper process for many polls (never a spawn per poll)', async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), kill: vi.fn() });
        const answer = JSON.stringify({ ok: true, cur: '', sessions: [{ app: 'Spotify.exe', status: 4, title: 'T', artist: 'A', album: 'B' }] });
        const requests: string[] = [];
        stdin.on('data', (b: Buffer) => {
            for (const req of b.toString().split('\n').filter(Boolean)) {
                requests.push(req);
                if (req === 'q') child.emit('exit', 0);
                else setTimeout(() => stdout.write(`${answer}\r\n`), 1);
            }
        });
        const spawnFn = vi.fn(() => child as never);
        const reader = new MediaSessionReader('win32', vi.fn(), spawnFn, () => Date.now());
        const emit = vi.fn();
        const w = new MediaWatcher((o) => reader.read(o), emit, () => reader.stop(), () => Date.now());
        w.configure(ON);
        await vi.advanceTimersByTimeAsync(MEDIA_WATCH_POLL_MS * 20);
        expect(requests.length).toBeGreaterThanOrEqual(15); // ~one read per poll ...
        expect(spawnFn).toHaveBeenCalledTimes(1); // ... all through the same helper
        // The same song all along: the first answer plus a keep-alive about once a minute, not 20 events.
        expect(emit.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(emit.mock.calls.length).toBeLessThanOrEqual(6);
        w.stop(); // sharing off: the helper is told to quit
        await vi.advanceTimersByTimeAsync(10);
        expect(requests[requests.length - 1]).toBe('q');
    });
});
