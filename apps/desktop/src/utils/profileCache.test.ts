/**
 * profileCache: the session profile cache and the hover/press prefetch.
 *
 * What is pinned here is COST as much as speed. Every API request comes out of
 * the account's shared 300/min `default` budget, so the prefetch must:
 *   - share one request between the hover, the press and the card itself;
 *   - do nothing for a pointer that does not rest (the dwell);
 *   - never run more than MAX_CONCURRENT_PREFETCH bets at once, DROPPING the
 *     excess rather than queueing it;
 *   - stop after PREFETCH_BURST bets until the bucket refills;
 *   - cost nothing at all when everything is already in memory;
 * while a press (demand) is never held back by any of that.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const axiosGet = vi.fn();
vi.mock('axios', () => ({ default: { get: (...a: unknown[]) => axiosGet(...a) } }));

const preloaded: Array<{ id: string; kind?: string }> = [];
const inMemory = new Set<string>();
vi.mock('../hooks/useEncryptedAvatar', () => ({
    preloadAvatar: vi.fn(async (id: string, _t: string, opts?: { kind?: string }) => { preloaded.push({ id, kind: opts?.kind }); inMemory.add(id); }),
    peekAvatarUrl: (id: string | null | undefined) => (id && inMemory.has(id) ? `blob:${id}` : null),
}));

const kv = new Map<string, string>();
vi.mock('./secureLocalStore', () => {
    const store = {
        getItem: (k: string) => kv.get(k) ?? null,
        setItem: (k: string, v: string) => { kv.set(k, v); },
        removeItem: (k: string) => { kv.delete(k); },
        isAccountReady: (u: string) => !!u,
        whenAccountReady: async () => {},
    };
    return { default: store, secureLocalStore: store };
});

import {
    fetchProfile,
    peekProfile,
    primeProfile,
    isProfileFresh,
    bindProfileCacheViewer,
    noteProfileEdited,
    prefetchProfileMedia,
    scheduleProfilePrefetch,
    __profilePrefetchTuning as T,
    __resetProfileCache,
    __activePrefetchCount,
} from './profileCache';
import { lookupUserAvatarId, lookupUserBannerId, __resetPeerIdentityCache, rememberUserAvatarId } from './peerIdentityCache';

const TOKEN = 't';
const profile = (uid: string, extra: Record<string, unknown> = {}) => ({
    user_id: uid, username: `n-${uid}`, discriminator: 1, avatar_url: `av-${uid}`, banner_url: `bn-${uid}`,
    bio: null, status: 'online' as const, custom_status_text: null, custom_status_emoji: null, last_seen_at: null, ...extra,
});
const profileCalls = () => axiosGet.mock.calls.filter(c => String(c[0]).includes('/auth/users/')).length;

/** Each profile request is held until the test releases it. */
let pending: Array<() => void> = [];
function holdResponses() {
    axiosGet.mockImplementation((u: string) => new Promise(resolve => {
        const uid = u.split('/auth/users/')[1];
        pending.push(() => resolve({ data: profile(uid) }));
    }));
}
async function releaseAll() {
    const p = pending; pending = [];
    p.forEach(f => f());
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    axiosGet.mockReset();
    axiosGet.mockImplementation(async (u: string) => ({ data: profile(u.split('/auth/users/')[1]) }));
    pending = [];
    preloaded.length = 0;
    inMemory.clear();
    kv.clear();
    __resetProfileCache();
    __resetPeerIdentityCache();
});
afterEach(() => { vi.useRealTimers(); });

describe('profile cache', () => {
    it('concurrent callers share ONE request, and the answer is cached', async () => {
        holdResponses();
        const a = fetchProfile('u1', TOKEN);
        const b = fetchProfile('u1', TOKEN);
        expect(profileCalls()).toBe(1);
        await releaseAll();
        expect((await a).user_id).toBe('u1');
        expect(await b).toBe(await a);
        expect(peekProfile('u1')?.username).toBe('n-u1');
    });

    it('a fresh copy satisfies maxAgeMs with no request; a stale one refetches', async () => {
        await fetchProfile('u1', TOKEN);
        await fetchProfile('u1', TOKEN, { maxAgeMs: T.FRESH_MS });
        expect(profileCalls()).toBe(1);
        vi.advanceTimersByTime(T.FRESH_MS + 1);
        expect(isProfileFresh('u1')).toBe(false);
        await fetchProfile('u1', TOKEN, { maxAgeMs: T.FRESH_MS });
        expect(profileCalls()).toBe(2);
    });

    it('records the avatar AND banner ids so the next open starts both images on the click', async () => {
        await fetchProfile('u1', TOKEN);
        expect(lookupUserAvatarId('u1')).toBe('av-u1');
        expect(lookupUserBannerId('u1')).toBe('bn-u1');
        // "No banner" from the server clears a remembered one.
        axiosGet.mockImplementation(async () => ({ data: profile('u1', { banner_url: null }) }));
        await fetchProfile('u1', TOKEN);
        expect(lookupUserBannerId('u1')).toBeNull();
    });

    it('a failed refetch keeps the cached copy', async () => {
        await fetchProfile('u1', TOKEN);
        axiosGet.mockRejectedValue(new Error('500'));
        await expect(fetchProfile('u1', TOKEN)).rejects.toThrow();
        expect(peekProfile('u1')?.user_id).toBe('u1');
    });

    it('a response for a different user is rejected, not cached', async () => {
        axiosGet.mockImplementation(async () => ({ data: profile('someone-else') }));
        await expect(fetchProfile('u1', TOKEN)).rejects.toThrow();
        expect(peekProfile('u1')).toBeNull();
    });

    it('is per VIEWER: an account switch drops it, and a late answer for the old account is discarded', async () => {
        bindProfileCacheViewer('me-A');
        await fetchProfile('u1', TOKEN);
        holdResponses();
        const late = fetchProfile('u2', TOKEN);
        bindProfileCacheViewer('me-B');
        expect(peekProfile('u1')).toBeNull();
        await releaseAll();
        await late;
        expect(peekProfile('u2')).toBeNull();
    });

    it('primeProfile (the DM panel\'s fetch) lets the card open from cache', () => {
        primeProfile(profile('u3'));
        expect(peekProfile('u3')?.banner_url).toBe('bn-u3');
        expect(lookupUserBannerId('u3')).toBe('bn-u3');
        expect(profileCalls()).toBe(0);
    });

    it('editing your own profile drops the cached copy and repoints the ids', async () => {
        await fetchProfile('me', TOKEN);
        noteProfileEdited('me', { bio: 'x', banner_url: 'bn-new' });
        expect(peekProfile('me')).toBeNull();
        expect(lookupUserBannerId('me')).toBe('bn-new');
        expect(lookupUserAvatarId('me')).toBe('av-me'); // untouched: not in the patch
    });
});

describe('profile prefetch', () => {
    it('hover: nothing before the dwell, and nothing at all if the pointer leaves first', async () => {
        const cancel = scheduleProfilePrefetch('u1', TOKEN);
        vi.advanceTimersByTime(T.HOVER_DWELL_MS - 1);
        cancel();
        vi.advanceTimersByTime(1_000);
        await Promise.resolve();
        expect(axiosGet).not.toHaveBeenCalled();

        scheduleProfilePrefetch('u1', TOKEN);
        await vi.advanceTimersByTimeAsync(T.HOVER_DWELL_MS);
        expect(profileCalls()).toBe(1);
        // …and both images were warmed, the banner under its own prune class.
        expect(preloaded).toEqual(expect.arrayContaining([{ id: 'av-u1', kind: undefined }, { id: 'bn-u1', kind: 'banner' }]));
    });

    it('known ids start their images at once, alongside the profile request', async () => {
        rememberUserAvatarId('u1', 'av-u1');
        holdResponses();
        void prefetchProfileMedia('u1', TOKEN, true);
        // The profile has not answered, yet the avatar is already on its way.
        expect(preloaded.map(p => p.id)).toEqual(['av-u1']);
        await releaseAll();
        expect(preloaded.map(p => p.id)).toEqual(['av-u1', 'bn-u1']);
    });

    it(`runs at most ${T.MAX_CONCURRENT_PREFETCH} hover bets at once and DROPS the rest`, async () => {
        holdResponses();
        const jobs = ['a', 'b', 'c', 'd', 'e'].map(u => prefetchProfileMedia(u, TOKEN));
        expect(__activePrefetchCount()).toBe(T.MAX_CONCURRENT_PREFETCH);
        expect(profileCalls()).toBe(T.MAX_CONCURRENT_PREFETCH);
        await releaseAll();
        await Promise.all(jobs);
        expect(profileCalls()).toBe(T.MAX_CONCURRENT_PREFETCH); // dropped, never run late
        expect(__activePrefetchCount()).toBe(0);
    });

    it(`stops after ${T.PREFETCH_BURST} bets until the bucket refills`, async () => {
        for (let i = 0; i < T.PREFETCH_BURST + 3; i++) await prefetchProfileMedia(`u${i}`, TOKEN);
        expect(profileCalls()).toBe(T.PREFETCH_BURST);
        vi.advanceTimersByTime(T.PREFETCH_REFILL_MS);
        await prefetchProfileMedia('late', TOKEN);
        expect(profileCalls()).toBe(T.PREFETCH_BURST + 1);
    });

    it('a press (demand) is never capped or rate-limited', async () => {
        for (let i = 0; i < T.PREFETCH_BURST; i++) await prefetchProfileMedia(`u${i}`, TOKEN); // drain the bucket
        holdResponses();
        const jobs = ['x', 'y', 'z'].map(u => prefetchProfileMedia(u, TOKEN, true));
        expect(profileCalls()).toBe(T.PREFETCH_BURST + 3);
        await releaseAll();
        await Promise.all(jobs);
    });

    it('a fully warm profile costs nothing — no request, no token', async () => {
        await fetchProfile('u1', TOKEN);
        inMemory.add('av-u1'); inMemory.add('bn-u1');
        axiosGet.mockClear();
        for (let i = 0; i < T.PREFETCH_BURST * 2; i++) await prefetchProfileMedia('u1', TOKEN);
        expect(axiosGet).not.toHaveBeenCalled();
        // The bucket is untouched: a cold user still gets a bet.
        await prefetchProfileMedia('cold', TOKEN);
        expect(profileCalls()).toBe(1);
    });
});
