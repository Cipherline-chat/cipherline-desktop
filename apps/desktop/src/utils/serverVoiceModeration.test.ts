// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
    clearServerVoiceModerationBit,
    describeVoiceModeration,
    fetchServerVoiceModeration,
    formatTimeLeft,
    getServerVoiceModeration,
    listServerVoiceModeration,
    removeServerVoiceModeration,
    removeVoiceModerationLabel,
    setServerVoiceModeration,
    useServerVoiceModerationFeed,
    useVoiceModerationTitles,
    VOICE_MODERATION_REFRESH_MS,
    __resetServerVoiceModeration,
    type VoiceModerationHttp,
} from './serverVoiceModeration';
import { setCallMedia, __resetCallMediaPresence } from './callMediaPresence';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const SID = 'server-1';
const A = 'user-a';
const B = 'user-b';
const NOW = Date.parse('2026-10-28T12:00:00Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => { __resetServerVoiceModeration(); __resetCallMediaPresence(); });
afterEach(() => { vi.useRealTimers(); });

describe('formatTimeLeft - rounds UP so a restriction never reads as over while it applies', () => {
    it.each([
        [24 * HOUR, '24 h left'],
        [23 * HOUR, '23 h left'],
        [23 * HOUR - 1, '23 h left'],       // 22 h 59 m 59.999 s -> still "23 h"
        [90 * 60_000, '2 h left'],
        [60 * 60_000, '1 h left'],
        [59 * 60_000 + 1, '1 h left'],
        [59 * 60_000, '59 min left'],
        [45 * 60_000, '45 min left'],
        [61_000, '2 min left'],
        [60_000, 'under a minute left'],
        [1, 'under a minute left'],
    ])('%d ms -> %s', (ms, text) => {
        expect(formatTimeLeft(NOW + ms, NOW)).toBe(text);
    });

    it('lapsed, zero and unknown give "" (callers drop the countdown)', () => {
        expect(formatTimeLeft(NOW, NOW)).toBe('');
        expect(formatTimeLeft(NOW - 5, NOW)).toBe('');
        expect(formatTimeLeft(0, NOW)).toBe('');
        expect(formatTimeLeft(Number.NaN, NOW)).toBe('');
    });
});

describe('tooltip and menu labels', () => {
    it('"Server muted · 23 h left" for a moderator, plain "Server muted" without an expiry', () => {
        expect(describeVoiceModeration('muted', NOW + 23 * HOUR, NOW)).toBe('Server muted · 23 h left');
        expect(describeVoiceModeration('deafened', NOW + 5 * HOUR, NOW)).toBe('Server deafened · 5 h left');
        expect(describeVoiceModeration('muted', 0, NOW)).toBe('Server muted');
        expect(describeVoiceModeration('deafened', undefined, NOW)).toBe('Server deafened');
    });

    it('the removal entries name what they remove and how long it had left', () => {
        expect(removeVoiceModerationLabel('muted', NOW + 2 * HOUR, NOW)).toBe('Remove Server Mute · 2 h left');
        expect(removeVoiceModerationLabel('deafened', null, NOW)).toBe('Remove Server Deafen');
    });
});

describe('the moderator list store', () => {
    it('parses a GET voice-moderation body, drops garbage, and answers per member', () => {
        setServerVoiceModeration(SID, [
            { user_id: A, muted_until: iso(NOW + 23 * HOUR), deafened_until: null },
            { user_id: B, muted_until: null, deafened_until: iso(NOW + HOUR) },
            { user_id: '', muted_until: iso(NOW + HOUR) },
            { muted_until: iso(NOW + HOUR) },
            { user_id: 'junk', muted_until: 'not a date', deafened_until: null },
            null,
        ]);
        expect(getServerVoiceModeration(SID, A, NOW)).toEqual({ mutedUntil: NOW + 23 * HOUR, deafenedUntil: 0 });
        expect(getServerVoiceModeration(SID, B, NOW)).toEqual({ mutedUntil: 0, deafenedUntil: NOW + HOUR });
        expect(getServerVoiceModeration(SID, 'junk', NOW)).toEqual({ mutedUntil: 0, deafenedUntil: 0 });
        expect(listServerVoiceModeration(SID, NOW).map(e => e.userId).sort()).toEqual([A, B]);
    });

    it('anything that is not an array reads as empty (older API, error body)', () => {
        setServerVoiceModeration(SID, [{ user_id: A, muted_until: iso(NOW + HOUR) }]);
        setServerVoiceModeration(SID, { message: 'nope' });
        expect(listServerVoiceModeration(SID, NOW)).toEqual([]);
    });

    it('a lapsed restriction is not reported even if the list has not been refetched', () => {
        setServerVoiceModeration(SID, [{ user_id: A, muted_until: iso(NOW + HOUR), deafened_until: iso(NOW + 3 * HOUR) }]);
        expect(getServerVoiceModeration(SID, A, NOW + 2 * HOUR)).toEqual({ mutedUntil: 0, deafenedUntil: NOW + 3 * HOUR });
        expect(getServerVoiceModeration(SID, A, NOW + 4 * HOUR)).toEqual({ mutedUntil: 0, deafenedUntil: 0 });
    });

    it('is per server', () => {
        setServerVoiceModeration(SID, [{ user_id: A, muted_until: iso(NOW + HOUR) }]);
        expect(getServerVoiceModeration('server-2', A, NOW).mutedUntil).toBe(0);
    });

    it('clearing one bit leaves the other', () => {
        setServerVoiceModeration(SID, [{ user_id: A, muted_until: iso(NOW + HOUR), deafened_until: iso(NOW + HOUR) }]);
        clearServerVoiceModerationBit(SID, A, 'muted');
        expect(getServerVoiceModeration(SID, A, NOW)).toEqual({ mutedUntil: 0, deafenedUntil: NOW + HOUR });
        clearServerVoiceModerationBit(SID, A, 'deafened');
        expect(listServerVoiceModeration(SID, NOW)).toEqual([]);
    });
});

describe('fetch / remove against the API', () => {
    const makeHttp = () => {
        const calls: Array<{ m: string; url: string; body?: unknown; headers: Record<string, string> }> = [];
        const http: VoiceModerationHttp = {
            get: vi.fn(async (url, c) => { calls.push({ m: 'GET', url, headers: c.headers }); return { data: [{ user_id: A, muted_until: iso(NOW + HOUR) }] }; }),
            patch: vi.fn(async (url, body, c) => { calls.push({ m: 'PATCH', url, body, headers: c.headers }); return { data: { ok: true } }; }),
        };
        return { http, calls };
    };

    it('fetch loads the server\'s list with the bearer token', async () => {
        const { http, calls } = makeHttp();
        await fetchServerVoiceModeration(http, 'https://api/v1', 'tok', SID);
        expect(calls[0]).toMatchObject({ m: 'GET', url: 'https://api/v1/servers/server-1/voice-moderation', headers: { Authorization: 'Bearer tok' } });
        expect(getServerVoiceModeration(SID, A, NOW).mutedUntil).toBe(NOW + HOUR);
    });

    it('removing a mute names NO room (so it works while the member is not in voice) and updates the list on success', async () => {
        setServerVoiceModeration(SID, [{ user_id: A, muted_until: iso(NOW + HOUR), deafened_until: iso(NOW + HOUR) }]);
        const { http, calls } = makeHttp();
        await removeServerVoiceModeration(http, 'https://api/v1', 'tok', SID, A, 'muted');
        expect(calls[0]).toMatchObject({
            m: 'PATCH', url: 'https://api/v1/servers/server-1/members/user-a/call-mute',
            body: { track_type: 'audio', muted: false },
        });
        expect(calls[0].body).not.toHaveProperty('room_name');
        expect(getServerVoiceModeration(SID, A, NOW)).toEqual({ mutedUntil: 0, deafenedUntil: NOW + HOUR });
    });

    it('removing a deafen uses track_type "deafen"', async () => {
        setServerVoiceModeration(SID, [{ user_id: A, deafened_until: iso(NOW + HOUR) }]);
        const { http, calls } = makeHttp();
        await removeServerVoiceModeration(http, 'https://api/v1', 'tok', SID, A, 'deafened');
        expect(calls[0].body).toEqual({ track_type: 'deafen', muted: false });
        expect(listServerVoiceModeration(SID, NOW)).toEqual([]);
    });

    it('a FAILED removal leaves the list as it was (no optimistic lie) and rejects', async () => {
        setServerVoiceModeration(SID, [{ user_id: A, muted_until: iso(NOW + HOUR) }]);
        const http: VoiceModerationHttp = {
            get: vi.fn(),
            patch: vi.fn(async () => { throw new Error('403'); }),
        };
        await expect(removeServerVoiceModeration(http, 'https://api/v1', 'tok', SID, A, 'muted')).rejects.toThrow('403');
        expect(getServerVoiceModeration(SID, A, NOW).mutedUntil).toBe(NOW + HOUR);
    });

    it('url-encodes ids', async () => {
        const { http, calls } = makeHttp();
        await removeServerVoiceModeration(http, 'https://api/v1', 'tok', 'a/b', 'u?x', 'muted');
        expect(calls[0].url).toBe('https://api/v1/servers/a%2Fb/members/u%3Fx/call-mute');
    });
});

function mount(el: React.ReactElement) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(el));
    return { host, unmount: () => act(() => root.unmount()) };
}

describe('useServerVoiceModerationFeed - only a moderator keeps the list loaded', () => {
    const Feed: React.FC<{ enabled: boolean; load: () => Promise<void>; serverId?: string }> = ({ enabled, load, serverId = SID }) => {
        useServerVoiceModerationFeed({ serverId, enabled, load });
        return null;
    };

    it('loads on open, again on the slow timer, and again (debounced) when presence reports a moderator-flag change', async () => {
        vi.useFakeTimers();
        const load = vi.fn(async () => undefined);
        const m = mount(h(Feed, { enabled: true, load }));
        expect(load).toHaveBeenCalledTimes(1);

        await act(async () => { vi.advanceTimersByTime(VOICE_MODERATION_REFRESH_MS); });
        expect(load).toHaveBeenCalledTimes(2);

        act(() => setCallMedia('call-1', B, { server_muted: true }));
        act(() => setCallMedia('call-1', B, { server_muted: true, server_deafened: true }));
        expect(load).toHaveBeenCalledTimes(2); // debounced
        await act(async () => { vi.advanceTimersByTime(900); });
        expect(load).toHaveBeenCalledTimes(3); // one refetch for the burst
        m.unmount();
    });

    it('does NOTHING for a viewer without MODERATE_CALL_MEDIA (enabled=false): no request, no timer, no listener', async () => {
        vi.useFakeTimers();
        const load = vi.fn(async () => undefined);
        const m = mount(h(Feed, { enabled: false, load }));
        await act(async () => { vi.advanceTimersByTime(VOICE_MODERATION_REFRESH_MS * 2); });
        act(() => setCallMedia('call-1', B, { server_muted: true }));
        await act(async () => { vi.advanceTimersByTime(2000); });
        expect(load).not.toHaveBeenCalled();
        m.unmount();
    });

    it('stops everything on unmount, and swallows a failed load (the list is a convenience layer)', async () => {
        vi.useFakeTimers();
        const load = vi.fn(async () => { throw new Error('network'); });
        const m = mount(h(Feed, { enabled: true, load }));
        expect(load).toHaveBeenCalledTimes(1);
        m.unmount();
        await act(async () => { vi.advanceTimersByTime(VOICE_MODERATION_REFRESH_MS * 2); });
        act(() => setCallMedia('call-1', B, { server_muted: true }));
        await act(async () => { vi.advanceTimersByTime(2000); });
        expect(load).toHaveBeenCalledTimes(1);
    });
});

describe('useVoiceModerationTitles - the badge tooltip', () => {
    const Probe: React.FC<{ serverId: string | null; userId: string }> = ({ serverId, userId }) => {
        const t = useVoiceModerationTitles(serverId, userId);
        return h('div', { 'data-muted': t.muted, 'data-deafened': t.deafened });
    };

    it('shows the countdown for a moderator who has the list, and updates when the list changes', () => {
        const future = Date.now() + 23 * HOUR - 1000;
        setServerVoiceModeration(SID, [{ user_id: A, muted_until: iso(future), deafened_until: null }]);
        const m = mount(h(Probe, { serverId: SID, userId: A }));
        const el = () => m.host.firstElementChild as HTMLElement;
        expect(el().dataset.muted).toBe('Server muted · 23 h left');
        expect(el().dataset.deafened).toBe('Server deafened');

        act(() => setServerVoiceModeration(SID, [{ user_id: A, muted_until: iso(Date.now() + 2 * HOUR), deafened_until: iso(Date.now() + HOUR) }]));
        expect(el().dataset.muted).toBe('Server muted · 2 h left');
        expect(el().dataset.deafened).toBe('Server deafened · 1 h left');
        m.unmount();
    });

    it('a viewer without the list (not a moderator) just gets "Server muted" - presence carries the bit, not the expiry', () => {
        const m = mount(h(Probe, { serverId: SID, userId: A }));
        expect((m.host.firstElementChild as HTMLElement).dataset.muted).toBe('Server muted');
        m.unmount();
    });
});
