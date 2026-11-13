// @vitest-environment jsdom
/**
 * The publisher: your own "Listening to / Watching" goes out when the MAIN
 * process pushes a read (electron/media-watch.ts), not on a renderer timer
 * that stops when the window is in the background or the tray, and it stays
 * up for as long as something PLAYS - no idle cut-off (watching a video means
 * not touching the mouse).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('axios', () => ({ default: http }));
const prefsBox = vi.hoisted(() => ({ value: { share: true, includeBrowser: true, includeWatching: true } }));
vi.mock('../utils/integrations/listeningPrefs', () => ({ useListeningPrefs: () => prefsBox.value }));

import { useListeningShare } from './useListeningShare';
import { listeningStore } from '../utils/integrations/listening';
import { EVENT_REFRESH_MS, POLL_FALLBACK_MS } from '../utils/integrations/nowPlaying';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const ME = '22222222-2222-4222-8222-222222222222';

const video = (o: Record<string, unknown> = {}) => ({
    supported: true, issue: null,
    playing: { kind: 'watching', source: 'browser', title: 'How to Make a Bow', artist: 'Some Channel', album: null, durationMs: 754_000, positionMs: 61_000, art: null, player: 'Chrome', ...o },
});
const song = (o: Record<string, unknown> = {}) => ({
    supported: true, issue: null,
    playing: { kind: 'listening', source: 'spotify', title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', durationMs: 330_000, positionMs: 1_000, art: null, player: 'Spotify', ...o },
});
const NOTHING = { supported: true, playing: null, issue: null };

type Bridge = Record<string, unknown>;
let bridge: Bridge;
let push: ((r: unknown) => void) | null;
let root: Root;
let host: HTMLDivElement;

const Harness: React.FC<{ token: string | null }> = ({ token }) => {
    useListeningShare({ token, userId: token ? ME : null, wsConnectCount: 0 });
    return null;
};
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const mount = async (token: string | null = 'tok') => { act(() => root.render(h(Harness, { token }))); await settle(); };
const send = async (r: unknown) => { act(() => push?.(r)); await settle(); };
const puts = () => http.put.mock.calls.map((c) => c[1] as Record<string, unknown>);

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
    http.get.mockReset().mockResolvedValue({ data: {} });
    http.put.mockReset().mockResolvedValue({ data: { ok: true } });
    http.delete.mockReset().mockResolvedValue({ data: { ok: true } });
    prefsBox.value = { share: true, includeBrowser: true, includeWatching: true };
    push = null;
    bridge = {
        watchNowPlaying: vi.fn(),
        onNowPlayingChanged: vi.fn((cb: (r: unknown) => void) => { push = cb; return () => { push = null; }; }),
        getNowPlaying: vi.fn(async () => song()),
        mediaStop: vi.fn(),
        // A machine nobody has touched for an hour: must change nothing.
        getSystemIdleTime: vi.fn(async () => 3600),
    };
    (window as unknown as { electronAPI: Bridge }).electronAPI = bridge;
    listeningStore.clear();
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    listeningStore.clear();
    delete (window as unknown as { electronAPI?: Bridge }).electronAPI;
    vi.useRealTimers();
});

describe('useListeningShare: publishes on the main process\'s events', () => {
    it('subscribes with the opt-ins; a pushed video is shown as yours and PUT as watching', async () => {
        await mount();
        expect(bridge.watchNowPlaying).toHaveBeenCalledWith({ includeBrowser: true, includeWatching: true });
        expect(bridge.getNowPlaying).not.toHaveBeenCalled(); // no renderer polling with a main process that keeps the schedule
        await send(video());
        expect(puts()).toEqual([expect.objectContaining({ kind: 'watching', track: 'How to Make a Bow', artist: 'Some Channel', source: 'browser' })]);
        expect(listeningStore.get(ME)).toMatchObject({ kind: 'watching', track: 'How to Make a Bow' });
    });

    it('the same thing again is not re-sent; the keep-alive re-asserts it once the refresh is due; a stop DELETEs', async () => {
        await mount();
        await send(song());
        await send(song({ positionMs: 13_000 }));
        expect(http.put).toHaveBeenCalledTimes(1);
        vi.setSystemTime(Date.now() + EVENT_REFRESH_MS + 10_000);
        await send(song({ positionMs: 61_000 }));
        expect(http.put).toHaveBeenCalledTimes(2);
        await send(song({ title: 'Angel', positionMs: 0 }));
        expect(http.put).toHaveBeenCalledTimes(3);
        await send(NOTHING);
        expect(http.delete).toHaveBeenCalledTimes(1);
        expect(listeningStore.get(ME)).toBeNull();
    });

    it('NO idle rule: an hour of a video with nobody at the keyboard keeps "Watching" up (never withdrawn, idle never asked)', async () => {
        await mount();
        let pos = 0;
        for (let minute = 0; minute < 60; minute += 1) {
            vi.setSystemTime(Date.now() + 60_000);
            await send(video({ durationMs: 3 * 3600_000, positionMs: (pos += 60_000) }));
        }
        expect(http.delete).not.toHaveBeenCalled();
        expect(http.put.mock.calls.length).toBeGreaterThanOrEqual(59);
        expect(listeningStore.get(ME)).toMatchObject({ kind: 'watching' });
        expect(bridge.getSystemIdleTime).not.toHaveBeenCalled();
    });

    it('sharing off / sign-out: unsubscribes (the main process stops reading) and withdraws', async () => {
        await mount();
        await send(song());
        await mount(null);
        expect(bridge.watchNowPlaying).toHaveBeenLastCalledWith(null);
        expect(push).toBeNull();
        expect(http.delete).toHaveBeenCalledTimes(1);
    });

    it('quitting the app withdraws the status (best effort, before the process goes)', async () => {
        let quit: (() => void) | null = null;
        bridge.onBeforeQuit = vi.fn((cb: () => void) => { quit = cb; return () => { quit = null; }; });
        await mount();
        await send(song());
        act(() => quit?.());
        await settle();
        expect(http.delete).toHaveBeenCalledTimes(1);
    });

    it('a video pushed although watching is off is never shown or sent (belt and braces)', async () => {
        prefsBox.value = { share: true, includeBrowser: true, includeWatching: false };
        await mount();
        expect(bridge.watchNowPlaying).toHaveBeenCalledWith({ includeBrowser: true, includeWatching: false });
        await send(video());
        expect(http.put).not.toHaveBeenCalled();
        expect(listeningStore.get(ME)).toBeNull();
    });
});

describe('useListeningShare: the "server cannot share videos" latch is precise', () => {
    const fail = (status: number, message?: unknown) => Object.assign(new Error('x'), { response: { status, data: message === undefined ? {} : { message } } });

    it('a 400 about something else (one video\'s text) does NOT switch videos off for the session', async () => {
        await mount();
        http.put.mockRejectedValueOnce(fail(400, ['track must be shorter than or equal to 120 characters']));
        await send(video({ title: 'A' }));
        await send(video({ title: 'B' }));
        expect(puts().map((b) => [b.kind, b.track])).toEqual([['watching', 'A'], ['watching', 'B']]);
        expect(bridge.watchNowPlaying).toHaveBeenCalledTimes(1);
    });

    it('a 400 naming `kind` (an API from before "Watching"): withdraws, resubscribes without videos, music still works', async () => {
        await mount();
        http.put.mockRejectedValueOnce(fail(400, ['property kind should not exist']));
        await send(video());
        expect(bridge.watchNowPlaying).toHaveBeenLastCalledWith({ includeBrowser: true, includeWatching: false });
        await send(video({ title: 'Another' }));
        expect(puts().filter((b) => b.kind === 'watching')).toHaveLength(1);
        await send(song());
        expect(puts().at(-1)).toMatchObject({ track: 'Teardrop' });
        expect(puts().at(-1)).not.toHaveProperty('kind');
    });
});

describe('useListeningShare: an older main process (no schedule of its own)', () => {
    it('polls from the renderer at one cadence, focused or not, and never stops for idleness', async () => {
        delete bridge.watchNowPlaying;
        delete bridge.onNowPlayingChanged;
        const start = Date.now();
        bridge.getNowPlaying = vi.fn(async () => song({ positionMs: Date.now() - start }));
        await mount();
        expect(bridge.getNowPlaying).toHaveBeenCalledTimes(1);
        for (let i = 0; i < 5; i += 1) {
            await act(async () => { await vi.advanceTimersByTimeAsync(POLL_FALLBACK_MS); });
            await settle();
        }
        expect((bridge.getNowPlaying as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(5);
        // 60 s of one song: the first PUT and one refresh, no withdraw.
        expect(http.put).toHaveBeenCalledTimes(2);
        expect(http.delete).not.toHaveBeenCalled();
        expect(bridge.getSystemIdleTime).not.toHaveBeenCalled();
    });
});
