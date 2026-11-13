// @vitest-environment jsdom
/**
 * The hook end to end: an open profile's "Playing" line goes away on its own
 * (the 90 s expiry, even when the re-read fails) and follows a re-read that
 * says the game closed. Positive control: the line IS there right after the read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const http = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('axios', () => ({ default: http }));

import { forgetSteamCard, useSteamCard, STEAM_NOW_PLAYING_MAX_AGE_MS, STEAM_REFRESH_MS } from './useProfileRelations';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const USER = '33333333-3333-4333-8333-333333333333';
const wire = (playing: boolean) => ({
    steam_id: '76561198000000001', persona_name: 'p', avatar: null,
    activity: {
        private: false, games_private: false, level: 7, xp: 1, badge_count: 1, member_since: '2015-03', game_count: 3, total_minutes: 60,
        top_games: [], recent: [], achievements: null,
        now_playing: playing ? { app_id: 284160, name: 'BeamNG.drive', art: null } : null,
    },
});

let root: Root;
let host: HTMLDivElement;
let seen: { now: string | null; level: number | null };
const Probe: React.FC = () => {
    const card = useSteamCard(USER, 'tok');
    seen = { now: card?.activity?.nowPlaying?.name ?? null, level: card?.activity?.level ?? null };
    return null;
};
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
    http.get.mockReset();
    forgetSteamCard(USER);
    seen = { now: null, level: null };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe('useSteamCard: now-playing cannot outlive reality by minutes', () => {
    it('shows the game right after the read, then a re-read that says it closed clears it', async () => {
        http.get.mockResolvedValueOnce({ data: wire(true) }).mockResolvedValue({ data: wire(false) });
        act(() => root.render(React.createElement(Probe)));
        await advance(0);
        expect(seen).toEqual({ now: 'BeamNG.drive', level: 7 });
        await advance(STEAM_REFRESH_MS + 100);
        expect(http.get).toHaveBeenCalledTimes(2);
        expect(seen).toEqual({ now: null, level: 7 });
    });

    it('with every re-read failing, the line still goes after 90 s while the slow stats stay', async () => {
        http.get.mockResolvedValueOnce({ data: wire(true) }).mockRejectedValue(Object.assign(new Error('net'), { response: { status: 503 } }));
        act(() => root.render(React.createElement(Probe)));
        await advance(0);
        expect(seen.now).toBe('BeamNG.drive');
        await advance(STEAM_NOW_PLAYING_MAX_AGE_MS - 5_000);
        expect(seen.now).toBe('BeamNG.drive');
        await advance(10_000);
        expect(seen).toEqual({ now: null, level: 7 });
    });
});
