import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('axios', () => ({ default: { get: (...a: unknown[]) => get(...a) } }));

import {
    STEAM_NOW_PLAYING_MAX_AGE_MS, STEAM_REFRESH_MS, expireNowPlaying, forgetSteamCard, peekSteamCard, readSteamCard, refreshSteamCard, watchSteamCard,
    type SteamCard,
} from './useProfileRelations';
import { STEAM_HOLD_MS, noteOwnGame, ownGameEndedAt, resetOwnGameEnd, steamNowPlayingTrusted } from '../utils/integrations/ownGameEnd';

const SID = '76561198000000001';
const wire = (nowPlaying: boolean) => ({
    steam_id: SID, persona_name: 'p', avatar: null,
    activity: {
        private: false, games_private: false, level: 12, xp: 1, badge_count: 2, member_since: '2015-03', game_count: 10, total_minutes: 600,
        top_games: [], recent: [], achievements: null,
        now_playing: nowPlaying ? { app_id: 284160, name: 'BeamNG.drive', art: null } : null,
    },
});
const USER = '11111111-1111-4111-8111-111111111111';
const nowName = (c: SteamCard | null | undefined) => c?.activity?.nowPlaying?.name ?? null;

describe('readSteamCard wire shape (positive control for the fixtures below)', () => {
    it('reads now playing from the fixture', () => {
        expect(nowName(readSteamCard(wire(true)))).toBe('BeamNG.drive');
        expect(nowName(readSteamCard(wire(false)))).toBeNull();
    });
});

describe('expireNowPlaying - one shared expiry', () => {
    const card = readSteamCard(wire(true)) as SteamCard;
    it('keeps now-playing just under the max age and drops it at it, leaving the slow stats', () => {
        expect(expireNowPlaying(card, 0, STEAM_NOW_PLAYING_MAX_AGE_MS - 1)).toBe(card);
        const gone = expireNowPlaying(card, 0, STEAM_NOW_PLAYING_MAX_AGE_MS);
        expect(gone?.activity?.nowPlaying).toBeNull();
        expect(gone?.activity?.level).toBe(12);
        expect(gone?.activity?.gameCount).toBe(10);
    });
    it('returns a stable object for the same expired card (no render churn) and does not mutate the original', () => {
        const a = expireNowPlaying(card, 0, 10 * 60_000);
        expect(expireNowPlaying(card, 0, 11 * 60_000)).toBe(a);
        expect(nowName(card)).toBe('BeamNG.drive');
    });
    it('passes through a null card and a card with nothing playing', () => {
        expect(expireNowPlaying(null, 0, 1e9)).toBeNull();
        const idle = readSteamCard(wire(false)) as SteamCard;
        expect(expireNowPlaying(idle, 0, 1e9)).toBe(idle);
    });
});

describe('watchSteamCard / refreshSteamCard', () => {
    let visibility: 'visible' | 'hidden';
    let listeners: Array<() => void>;
    const realDocument = (globalThis as any).document;
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        get.mockReset();
        forgetSteamCard(USER);
        visibility = 'visible';
        listeners = [];
        (globalThis as any).document = {
            get visibilityState() { return visibility; },
            addEventListener: (_: string, f: () => void) => listeners.push(f),
            removeEventListener: (_: string, f: () => void) => { listeners = listeners.filter((x) => x !== f); },
        };
    });
    afterEach(() => { vi.useRealTimers(); (globalThis as any).document = realDocument; });

    const flush = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };

    it('fetches on open, then re-reads about once a minute while open, and stops when closed', async () => {
        get.mockResolvedValue({ data: wire(true) });
        const stop = watchSteamCard(USER, 'tok');
        await flush(0);
        expect(get).toHaveBeenCalledTimes(1);
        await flush(STEAM_REFRESH_MS - 1000);
        expect(get).toHaveBeenCalledTimes(1);
        await flush(1000);
        expect(get).toHaveBeenCalledTimes(2);
        await flush(STEAM_REFRESH_MS);
        expect(get).toHaveBeenCalledTimes(3);
        stop();
        await flush(10 * STEAM_REFRESH_MS);
        expect(get).toHaveBeenCalledTimes(3);
    });

    it('a game that closed is gone from the next re-read (positive control: the first read had it)', async () => {
        get.mockResolvedValueOnce({ data: wire(true) }).mockResolvedValue({ data: wire(false) });
        const stop = watchSteamCard(USER, 'tok');
        await flush(0);
        const first = nowName(peekSteamCard(USER)?.value);
        await flush(STEAM_REFRESH_MS);
        const second = nowName(peekSteamCard(USER)?.value);
        stop();
        expect([first, second]).toEqual(['BeamNG.drive', null]);
    });

    it('does not fetch while the window is hidden, and catches up when it is shown', async () => {
        get.mockResolvedValue({ data: wire(true) });
        visibility = 'hidden';
        const stop = watchSteamCard(USER, 'tok');
        await flush(5 * STEAM_REFRESH_MS);
        expect(get).not.toHaveBeenCalled();
        visibility = 'visible';
        listeners.forEach((f) => f());
        await flush(0);
        expect(get).toHaveBeenCalledTimes(1);
        stop();
    });

    it('a window hidden after the loop started stops it at the next tick', async () => {
        get.mockResolvedValue({ data: wire(true) });
        const stop = watchSteamCard(USER, 'tok');
        await flush(0);
        visibility = 'hidden';
        await flush(3 * STEAM_REFRESH_MS);
        expect(get).toHaveBeenCalledTimes(1);
        stop();
    });

    it('opening with a card already fresh does not refetch until it is a minute old', async () => {
        get.mockResolvedValue({ data: wire(true) });
        await refreshSteamCard(USER, 'tok');
        expect(get).toHaveBeenCalledTimes(1);
        await flush(20_000);
        const stop = watchSteamCard(USER, 'tok');
        await flush(0);
        expect(get).toHaveBeenCalledTimes(1);
        await flush(STEAM_REFRESH_MS - 20_000);
        expect(get).toHaveBeenCalledTimes(2);
        stop();
    });

    it('concurrent surfaces share one request', async () => {
        get.mockResolvedValue({ data: wire(true) });
        await Promise.all([refreshSteamCard(USER, 'tok'), refreshSteamCard(USER, 'tok')]);
        expect(get).toHaveBeenCalledTimes(1);
    });

    it('a failed re-read keeps the cached card, and its now-playing still expires on age', async () => {
        get.mockResolvedValueOnce({ data: wire(true) }).mockRejectedValue(Object.assign(new Error('net'), { response: { status: 503 } }));
        const stop = watchSteamCard(USER, 'tok');
        await flush(0);
        const entry = peekSteamCard(USER)!;
        await flush(STEAM_REFRESH_MS);
        const kept = peekSteamCard(USER)!;
        expect(kept).toBe(entry);
        expect(nowName(expireNowPlaying(kept.value, kept.at, kept.at + STEAM_NOW_PLAYING_MAX_AGE_MS - 1))).toBe('BeamNG.drive');
        expect(nowName(expireNowPlaying(kept.value, kept.at, kept.at + STEAM_NOW_PLAYING_MAX_AGE_MS))).toBeNull();
        stop();
    });

    it('a failing API is asked once a minute, never in a tight loop (with or without a cached card)', async () => {
        get.mockRejectedValue(Object.assign(new Error('net'), { response: { status: 503 } }));
        const stop = watchSteamCard(USER, 'tok');
        await flush(0);
        expect(get).toHaveBeenCalledTimes(1);
        await flush(STEAM_REFRESH_MS - 1000);
        expect(get).toHaveBeenCalledTimes(1);
        await flush(1000);
        expect(get).toHaveBeenCalledTimes(2);
        await flush(10 * STEAM_REFRESH_MS);
        expect(get).toHaveBeenCalledTimes(12);
        stop();
    });

    it('a 404 (hidden / unlinked) clears the card and stops polling it', async () => {
        get.mockResolvedValueOnce({ data: wire(true) }).mockRejectedValue(Object.assign(new Error('nf'), { response: { status: 404 } }));
        const stop = watchSteamCard(USER, 'tok');
        await flush(0);
        await flush(STEAM_REFRESH_MS);
        expect(peekSteamCard(USER)?.value).toBeNull();
        const calls = get.mock.calls.length;
        await flush(5 * STEAM_REFRESH_MS);
        expect(get.mock.calls.length).toBe(calls);
        stop();
    });
});

describe('own profile: Steam waits out a game this app saw end', () => {
    beforeEach(() => resetOwnGameEnd());
    it('is trusted when no game ever ended', () => {
        expect(steamNowPlayingTrusted(0)).toBe(true);
    });
    it('a card fetched before / shortly after the end is not trusted; one fetched after the hold is', () => {
        noteOwnGame(null, 'BeamNG.drive', 5_000);
        expect(ownGameEndedAt()).toBe(5_000);
        expect(steamNowPlayingTrusted(4_000)).toBe(false);
        expect(steamNowPlayingTrusted(5_000 + STEAM_HOLD_MS - 1)).toBe(false);
        expect(steamNowPlayingTrusted(5_000 + STEAM_HOLD_MS)).toBe(true);
    });
    it('starting a game clears the wait; "none" with no game before it records nothing', () => {
        noteOwnGame(null, null, 1_000);
        expect(ownGameEndedAt()).toBeNull();
        noteOwnGame(null, 'A', 2_000);
        noteOwnGame('B', null, 3_000);
        expect(ownGameEndedAt()).toBeNull();
        expect(steamNowPlayingTrusted(0)).toBe(true);
    });
    it('a repeated "none" keeps the first end time', () => {
        noteOwnGame(null, 'A', 2_000);
        noteOwnGame(null, null, 9_000);
        expect(ownGameEndedAt()).toBe(2_000);
    });
});
