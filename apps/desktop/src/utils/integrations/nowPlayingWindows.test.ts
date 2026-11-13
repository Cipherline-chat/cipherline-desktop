import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    coverText, fieldsNamedIn, nowPlayingStatus, putListening, readNowPlaying, watchNowPlaying, type NowPlaying,
} from './nowPlaying';

/**
 * The renderer side of the Windows fixes (2026-10-28): the cover diagnosis
 * and the "a switch keeps it out" line in Settings, the precise "this server
 * cannot share videos" latch, and the main-process schedule's subscription.
 */

describe('putListening: only a refusal that is ABOUT `kind` switches videos off', () => {
    const video = { kind: 'watching' as const, track: 'V', artist: 'C', source: 'browser' as const };
    const fail = (status: number, message: unknown) => Object.assign(new Error('x'), { response: { status, data: { message } } });

    it('an API from before "Watching" (forbidNonWhitelisted names the field) -> latched', async () => {
        const flags = { artIdRefused: false, watchingRefused: false };
        await putListening(async () => { throw fail(400, ['property kind should not exist']); }, video, flags);
        expect(flags.watchingRefused).toBe(true);
    });

    it('a 400 about the text (one long title) or the source -> NOT latched: the next video is still sent', async () => {
        for (const message of [['track must be shorter than or equal to 120 characters'], 'artist should not be empty', ['source must be one of the following values: ...']]) {
            const flags = { artIdRefused: false, watchingRefused: false };
            expect(await putListening(async () => { throw fail(400, message); }, video, flags)).toEqual({ ok: false, status: 400 });
            expect(flags.watchingRefused).toBe(false);
        }
    });

    it('media_id refused by name is dropped and the body re-sent; a 400 about `kind` after that still latches watching', async () => {
        const bodies: object[] = [];
        const flags = { artIdRefused: false, watchingRefused: false, mediaIdRefused: false };
        const send = async (b: object) => {
            bodies.push(b);
            throw fail(400, 'media_id' in b ? ['property kind should not exist', 'property media_id should not exist'] : ['property kind should not exist']);
        };
        await putListening(send, { ...video, media_id: 'youtube:dQw4w9WgXcQ' }, flags);
        expect(bodies).toEqual([{ ...video, media_id: 'youtube:dQw4w9WgXcQ' }, video]);
        expect(flags).toEqual({ artIdRefused: false, watchingRefused: true, mediaIdRefused: true });
    });

    it('a 400 that names some OTHER field keeps media_id (it was not the problem)', async () => {
        const bodies: object[] = [];
        const flags = { artIdRefused: false, watchingRefused: false, mediaIdRefused: false };
        await putListening(async (b: object) => { bodies.push(b); throw fail(400, ['track must be a string']); }, { ...video, media_id: 'youtube:dQw4w9WgXcQ' }, flags);
        expect(bodies).toHaveLength(1);
        expect(flags).toEqual({ artIdRefused: false, watchingRefused: false, mediaIdRefused: false });
    });

    it('fieldsNamedIn reads NestJS messages; nothing readable -> null (the old rule applies)', () => {
        expect(fieldsNamedIn(fail(400, ['property kind should not exist']))).toEqual(new Set(['kind']));
        expect(fieldsNamedIn(fail(400, 'progress_ms must not be less than 0'))).toEqual(new Set(['progress_ms']));
        expect(fieldsNamedIn(fail(400, ['the kindest words']))).toBeNull();
        expect(fieldsNamedIn(fail(400, 42))).toBeNull();
        expect(fieldsNamedIn(new Error('offline'))).toBeNull();
    });
});

describe('Settings line: the cover diagnosis and the switch that keeps something out', () => {
    const p = (o: Partial<NowPlaying> = {}): NowPlaying => ({ kind: 'listening', source: 'spotify', title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', durationMs: null, positionMs: null, art: null, player: 'Spotify', ...o });
    const label = (x: NowPlaying) => x.player ?? '?';

    it('cover: yes (WxH) / none from app / couldn’t read (code); nothing said where it is unknown', () => {
        expect(nowPlayingStatus({ supported: true, playing: p({ cover: { ok: true, w: 640, h: 640 } }), issue: null }, label).text).toBe('Detected: Spotify — Teardrop by Massive Attack · cover: yes (640×640)');
        expect(nowPlayingStatus({ supported: true, playing: p({ cover: { ok: true } }), issue: null }, label).text).toMatch(/ · cover: yes$/);
        expect(nowPlayingStatus({ supported: true, playing: p({ cover: { ok: false, why: 'none' } }), issue: null }, label).text).toMatch(/ · cover: none from app$/);
        expect(nowPlayingStatus({ supported: true, playing: p({ kind: 'watching', source: 'browser', player: 'Chrome', cover: { ok: false, why: 'read_failed' } }), issue: null }, label).text)
            .toBe('Detected: Chrome — watching Teardrop (Massive Attack) · cover: couldn’t read (read_failed)');
        expect(nowPlayingStatus({ supported: true, playing: p(), issue: null }, label).text).toBe('Detected: Spotify — Teardrop by Massive Attack');
        expect(coverText(undefined)).toBe('');
    });

    it('readNowPlaying keeps a well-formed cover diagnosis only', () => {
        const raw = (cover: unknown) => readNowPlaying({ supported: true, issue: null, playing: { ...p(), cover } });
        expect(raw({ ok: true, w: 640, h: 360 })).toMatchObject({ playing: { cover: { ok: true, w: 640, h: 360 } } });
        expect(raw({ ok: false, why: 'too_big' })).toMatchObject({ playing: { cover: { ok: false, why: 'too_big' } } });
        expect((raw({ ok: false, why: '<b>x</b>' }) as { playing: NowPlaying }).playing.cover).toBeUndefined();
        expect((raw({ ok: true, w: -1, h: 1e9 }) as { playing: NowPlaying }).playing.cover).toEqual({ ok: true });
        expect((raw('yes') as { playing: NowPlaying }).playing.cover).toBeUndefined();
    });

    it('excluded: names "Include my browser" / "Also share what I’m watching" instead of "Nothing playing"', () => {
        const r = readNowPlaying({ supported: true, playing: null, issue: { kind: 'excluded', why: 'browser', player: 'Chrome' } });
        expect(r).toEqual({ supported: true, playing: null, issue: { kind: 'excluded', why: 'browser', player: 'Chrome' } });
        expect(nowPlayingStatus(r, label)).toEqual({ kind: 'blocked', text: expect.stringMatching(/^Something is playing in Chrome, but “Include my browser” is off/) });
        expect(nowPlayingStatus({ supported: true, playing: null, issue: { kind: 'excluded', why: 'watching', player: null } }, label).text)
            .toBe('A video is playing, but “Also share what I’m watching” is off, so it is not shared.');
        expect(readNowPlaying({ supported: true, playing: null, issue: { kind: 'excluded', why: 'other' } })).toEqual({ supported: true, playing: null, issue: null });
    });
});

describe('watchNowPlaying: the main process keeps the schedule', () => {
    const g = globalThis as { window?: unknown };
    let had: boolean;
    beforeEach(() => { had = 'window' in g; });
    afterEach(() => { if (!had) delete g.window; });

    it('subscribes, re-validates every pushed read, drops a video without the opt-in, and unsubscribes (schedule off)', () => {
        let cb: ((r: unknown) => void) | null = null;
        const api = {
            watchNowPlaying: vi.fn(),
            onNowPlayingChanged: vi.fn((f: (r: unknown) => void) => { cb = f; return () => { cb = null; }; }),
        };
        g.window = { electronAPI: api };
        const got: unknown[] = [];
        const off = watchNowPlaying({ includeBrowser: true, includeWatching: false }, (r) => got.push(r));
        expect(off).toBeTypeOf('function');
        expect(api.watchNowPlaying).toHaveBeenCalledWith({ includeBrowser: true, includeWatching: false });
        cb!({ supported: true, issue: null, playing: { kind: 'watching', source: 'browser', title: 'V', artist: 'C', album: null, durationMs: null, positionMs: null, art: null, player: 'Chrome' } });
        cb!({ supported: true, issue: null, playing: { kind: 'listening', source: 'spotify', title: 'T', artist: 'A', album: null, durationMs: null, positionMs: null, art: 'javascript:alert(1)', player: 'Spotify' } });
        cb!('garbage');
        expect(got).toEqual([
            { supported: true, playing: null, issue: null },
            { supported: true, playing: expect.objectContaining({ title: 'T', art: null }), issue: null },
            { supported: false, reason: 'platform' },
        ]);
        off!();
        expect(cb).toBeNull();
        expect(api.watchNowPlaying).toHaveBeenLastCalledWith(null);
    });

    it('an older main process (no schedule): null, so the caller polls itself', () => {
        g.window = { electronAPI: { getNowPlaying: vi.fn() } };
        expect(watchNowPlaying({ includeBrowser: false, includeWatching: false }, () => {})).toBeNull();
    });
});
