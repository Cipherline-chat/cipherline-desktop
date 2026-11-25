// @vitest-environment jsdom
/**
 * Owner report 2026-11-23 (0.1.4-staging.277): a live Calls-channel call
 * "completely closed like everyone left" on his screen while everyone was still
 * in it, and came back only after leaving the server and opening it again.
 *
 * Mechanism (utils/huddleCallsLoad.ts): during a reconnect storm the per-channel
 * `GET /v1/huddles/:hid/calls` hit transient failures (429 from the route's
 * rate limit, dropped connections), and `loadHuddleCalls` emptied the channel
 * on ANY failure. After that the call stayed gone: `huddle:participant` events
 * only edit a call already in the map.
 *
 * These drive the real hook with a mocked axios.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Reply = { data: unknown } | { error: unknown };
const { api } = vi.hoisted(() => ({
    api: {
        // Per-URL queue of replies for /huddles/:hid/calls; anything else → [].
        calls: [] as Reply[],
        callGets: 0,
        pending: null as null | { resolve: (v: { data: unknown }) => void },
        hold: false,
    },
}));
vi.mock('axios', () => ({
    default: {
        get: vi.fn((url: string) => {
            if (!/\/huddles\/[^/]+\/calls$/.test(url)) return Promise.resolve({ data: [] });
            api.callGets++;
            if (api.hold) {
                return new Promise(resolve => { api.pending = { resolve }; });
            }
            const r = api.calls.shift() ?? { data: [] };
            return 'error' in r ? Promise.reject(r.error) : Promise.resolve(r);
        }),
        post: vi.fn(async () => ({ data: {} })),
        isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError,
    },
}));
vi.mock('../utils/secureLocalStore', () => ({
    secureLocalStore: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
}));
vi.mock('../utils/bootFetch', () => ({ takeBootFetch: () => null }));
vi.mock('../constants', async (orig) => ({ ...(await orig<typeof import('../constants')>()), API_BASE: 'http://api/v1' }));

const { useServers } = await import('./useServers');
type Hook = ReturnType<typeof useServers>;

const HUDDLE = 'h-1';
const CALL = {
    call_id: 'c-1', huddle_id: HUDDLE, name: 'General', spawner_user_id: 'u-a',
    spawned_at: '2026-11-23T23:40:00.000Z', participants: ['me', 'u-a', 'u-b'],
};
const httpError = (status: number) => Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true, response: { status },
});
const networkError = () => Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK' });

const seen: Hook[] = [];
const cur = (): Hook => seen[seen.length - 1];
const Probe = () => { seen.push(useServers('jwt', 'me', 'dev-1')); return null; };
let root: Root | null = null;
let host: HTMLElement;
const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };

beforeEach(async () => {
    seen.length = 0;
    api.calls = []; api.callGets = 0; api.hold = false; api.pending = null;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(React.createElement(Probe)); });
    await flush();
    // The live call, as the boot seed delivered it.
    await act(async () => { cur().applyHuddleCallsSnapshot({ [HUDDLE]: [CALL] }); });
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; vi.useRealTimers(); vi.restoreAllMocks(); });

describe('loadHuddleCalls during a reconnect storm (the vanish)', () => {
    for (const [label, err] of [
        ['429 from the route rate limit', httpError(429)],
        ['a 503 from a pod mid-roll', httpError(503)],
        ['a dropped connection', networkError()],
    ] as const) {
        it(`keeps the live call on ${label}`, async () => {
            api.calls.push({ error: err });
            await act(async () => { await cur().loadHuddleCalls(HUDDLE); });
            expect(cur().huddleCalls[HUDDLE]?.map(c => c.call_id)).toEqual(['c-1']);
            expect(cur().huddleCalls[HUDDLE]?.[0].participants).toEqual(['me', 'u-a', 'u-b']);
        });
    }

    it('still empties the channel on 403 (lost VIEW_CHANNEL): no stale private presence', async () => {
        api.calls.push({ error: httpError(403) });
        await act(async () => { await cur().loadHuddleCalls(HUDDLE); });
        expect(cur().huddleCalls[HUDDLE]).toEqual([]);
    });

    it('still empties the channel on 404 (channel deleted)', async () => {
        api.calls.push({ error: httpError(404) });
        await act(async () => { await cur().loadHuddleCalls(HUDDLE); });
        expect(cur().huddleCalls[HUDDLE]).toEqual([]);
    });

    it('a successful answer still replaces the roster (an ended call goes away)', async () => {
        api.calls.push({ data: [] });
        await act(async () => { await cur().loadHuddleCalls(HUDDLE); });
        expect(cur().huddleCalls[HUDDLE]).toEqual([]);
    });

    it('concurrent loads of one channel share a single request', async () => {
        api.hold = true;
        let all!: Promise<unknown>;
        await act(async () => {
            all = Promise.all([cur().loadHuddleCalls(HUDDLE), cur().loadHuddleCalls(HUDDLE), cur().loadHuddleCalls(HUDDLE)]);
            await Promise.resolve();
        });
        expect(api.callGets).toBe(1);
        await act(async () => { api.pending!.resolve({ data: [CALL] }); await all; });
        expect(cur().huddleCalls[HUDDLE]?.map(c => c.call_id)).toEqual(['c-1']);
    });
});

describe('a join for a call the map lost re-reads that channel', () => {
    it('heals a vanished call on the next join event', async () => {
        vi.useFakeTimers();
        // The map lost the call (e.g. an older build's wipe, or a seed landing after the spawn).
        await act(async () => { cur().applyHuddleCallsSnapshot({}); });
        api.calls.push({ data: [{ ...CALL, participants: [...CALL.participants, 'u-c'] }] });
        await act(async () => { cur().applyHuddleParticipant(HUDDLE, 'c-1', 'u-c', 'join'); });
        expect(api.callGets).toBe(0);           // not acted on synchronously
        await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
        expect(api.callGets).toBe(1);
        expect(cur().huddleCalls[HUDDLE]?.[0].participants).toContain('u-c');
    });

    it('does not re-read when the call is known, or for a leave', async () => {
        vi.useFakeTimers();
        await act(async () => { cur().applyHuddleParticipant(HUDDLE, 'c-1', 'u-c', 'join'); });
        await act(async () => { cur().applyHuddleParticipant(HUDDLE, 'c-gone', 'u-a', 'leave'); });
        await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
        expect(api.callGets).toBe(0);
        expect(cur().huddleCalls[HUDDLE]?.[0].participants).toContain('u-c');
    });

    it('does not re-read when call_spawned lands in the same batch as the spawner join', async () => {
        vi.useFakeTimers();
        await act(async () => {
            cur().applyHuddleSpawn(HUDDLE, { call_id: 'c-2', name: 'New', spawner_user_id: 'u-d', spawned_at: '2026-11-24T00:00:00Z', participants: ['u-d'] });
            cur().applyHuddleParticipant(HUDDLE, 'c-2', 'u-d', 'join');
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
        expect(api.callGets).toBe(0);
    });
});
