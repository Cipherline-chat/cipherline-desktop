/**
 * channelViewerCache: who can see each restricted channel, the filter behind
 * the server member sidebar.
 *
 * Every behaviour is asserted next to the control that would catch its
 * absence: a hit costs ZERO requests right after a miss costs exactly one;
 * "unchanged answer keeps identity" sits next to "changed answer replaces it";
 * "invalidate re-asks" sits next to "fresh does not".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const axiosGet = vi.fn();
vi.mock('axios', () => ({ default: { get: (...a: unknown[]) => axiosGet(...a) } }));

import {
    refreshChannelViewers,
    peekChannelViewers,
    touchChannelViewers,
    isChannelViewersFresh,
    subscribeChannelViewers,
    invalidateServerChannelViewers,
    invalidateAllChannelViewers,
    dropServerChannelViewers,
    clearChannelViewerCache,
    cachedViewerChannelIds,
    cachedViewerIdCount,
    parseViewersResponse,
    memberFilterFor,
    filterMembers,
    FILTER_ALL,
    FILTER_LOADING,
    FRESH_MS,
    HOVER_INTENT_MS,
    hoverPrefetchChannelViewers,
    cancelHoverPrefetch,
    MAX_CHANNELS,
    MAX_TOTAL_IDS,
    __resetChannelViewerCache,
    type ChannelViewers,
    type ChannelViewerEntry,
} from './channelViewerCache';
import { clearRosterCache, bindRosterViewer, __resetRosterCache } from './serverRosterCache';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TOKEN = 'tok';
type Answer = { all: true } | { all: false; user_ids: string[] } | Error | unknown;
const answers = new Map<string, Answer>();   // channelId -> canned body
const holds: Array<() => void> = [];
let hold = false;

const serve = (channelId: string, a: Answer) => { answers.set(channelId, a); };
const calls = (channelId?: string) =>
    axiosGet.mock.calls.filter(c => !channelId || String(c[0]).includes(`/channels/${channelId}/viewers`)).length;
const release = async () => { holds.splice(0).forEach(r => r()); await new Promise(r => setTimeout(r, 0)); };

beforeEach(() => {
    __resetRosterCache();
    __resetChannelViewerCache();
    axiosGet.mockReset();
    answers.clear();
    holds.length = 0;
    hold = false;
    vi.useRealTimers();
    axiosGet.mockImplementation(async (url: string) => {
        const m = /\/servers\/([^/]+)\/channels\/([^/]+)\/viewers$/.exec(url);
        if (!m) throw new Error(`unexpected GET ${url}`);
        if (hold) await new Promise<void>(res => holds.push(res));
        const a = answers.get(m[2]);
        if (a === undefined) throw new Error('403');
        if (a instanceof Error) throw a;
        return { data: JSON.parse(JSON.stringify(a)) };   // fresh body per response
    });
});

const restricted = (id: string, server = 'S') => ({ channel_id: id, server_id: server, view_scope: 'restricted' as const });
const publicCh = (id: string, server = 'S') => ({ channel_id: id, server_id: server, view_scope: 'all' as const });
const ids = (e: ReturnType<typeof peekChannelViewers>) =>
    e && e.viewers && !e.viewers.all ? [...e.viewers.ids].sort() : e?.viewers?.all ? 'ALL' : null;

describe('hit / miss', () => {
    it('a miss asks once and caches; a fresh hit is synchronous and free', async () => {
        serve('C1', { all: false, user_ids: ['u1', 'u2'] });
        expect(peekChannelViewers('C1')).toBeNull();               // control: nothing before
        await refreshChannelViewers('S', 'C1', TOKEN);
        expect(calls('C1')).toBe(1);
        expect(ids(peekChannelViewers('C1'))).toEqual(['u1', 'u2']);
        await refreshChannelViewers('S', 'C1', TOKEN);
        expect(calls('C1')).toBe(1);                               // fresh: no second request
        expect(isChannelViewersFresh('C1')).toBe(true);
    });

    it('concurrent callers share one request', async () => {
        serve('C1', { all: false, user_ids: ['u1'] });
        hold = true;
        const a = refreshChannelViewers('S', 'C1', TOKEN);
        const b = refreshChannelViewers('S', 'C1', TOKEN);
        await release();
        await Promise.all([a, b]);
        expect(calls('C1')).toBe(1);
    });

    it('older than FRESH_MS → revalidated; the cached answer stays readable meanwhile', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        serve('C1', { all: false, user_ids: ['u1'] });
        await refreshChannelViewers('S', 'C1', TOKEN);
        vi.setSystemTime(Date.now() + FRESH_MS + 1);
        expect(isChannelViewersFresh('C1')).toBe(false);
        hold = true;
        const p = refreshChannelViewers('S', 'C1', TOKEN);
        expect(ids(peekChannelViewers('C1'))).toEqual(['u1']);     // SWR: still painted
        await release();
        await p;
        expect(calls('C1')).toBe(2);
    });

    it('`{ all: true }` is cached as "everyone"', async () => {
        serve('C1', { all: true });
        await refreshChannelViewers('S', 'C1', TOKEN);
        expect(ids(peekChannelViewers('C1'))).toBe('ALL');
    });
});

describe('structural identity', () => {
    it('an unchanged answer keeps the SAME entry and emits nothing', async () => {
        serve('C1', { all: false, user_ids: ['u1', 'u2'] });
        await refreshChannelViewers('S', 'C1', TOKEN);
        const before = peekChannelViewers('C1');
        const listener = vi.fn();
        subscribeChannelViewers(listener);
        serve('C1', { all: false, user_ids: ['u2', 'u1'] });       // same set, different order
        await refreshChannelViewers('S', 'C1', TOKEN, { force: true });
        expect(peekChannelViewers('C1')).toBe(before);
        expect(listener).not.toHaveBeenCalled();
    });

    it('control: a changed answer replaces the entry and emits once', async () => {
        serve('C1', { all: false, user_ids: ['u1', 'u2'] });
        await refreshChannelViewers('S', 'C1', TOKEN);
        const before = peekChannelViewers('C1');
        const listener = vi.fn();
        subscribeChannelViewers(listener);
        serve('C1', { all: false, user_ids: ['u1'] });
        await refreshChannelViewers('S', 'C1', TOKEN, { force: true });
        expect(peekChannelViewers('C1')).not.toBe(before);
        expect(ids(peekChannelViewers('C1'))).toEqual(['u1']);
        expect(listener).toHaveBeenCalledTimes(1);
    });
});

describe('invalidation', () => {
    it('marks a server\'s channels stale with a NEW identity (so the open sidebar re-asks), others untouched', async () => {
        serve('C1', { all: false, user_ids: ['u1'] });
        serve('C2', { all: false, user_ids: ['u2'] });
        serve('X1', { all: false, user_ids: ['x'] });
        await refreshChannelViewers('S', 'C1', TOKEN);
        await refreshChannelViewers('S', 'C2', TOKEN);
        await refreshChannelViewers('T', 'X1', TOKEN);
        const c1 = peekChannelViewers('C1')!;
        const x1 = peekChannelViewers('X1')!;
        const listener = vi.fn();
        subscribeChannelViewers(listener);

        invalidateServerChannelViewers('S');

        expect(peekChannelViewers('C1')).not.toBe(c1);
        expect(peekChannelViewers('C1')!.stale).toBe(true);
        expect(peekChannelViewers('C1')!.viewers).toBe(c1.viewers);   // same data: list does not re-filter
        expect(peekChannelViewers('X1')).toBe(x1);                    // other server untouched
        expect(listener).toHaveBeenCalledTimes(1);
        expect(isChannelViewersFresh('C1')).toBe(false);
        await refreshChannelViewers('S', 'C1', TOKEN);
        expect(calls('C1')).toBe(2);                                  // re-asked
        expect(peekChannelViewers('C1')!.stale).toBe(false);
        await refreshChannelViewers('T', 'X1', TOKEN);
        expect(calls('X1')).toBe(1);                                  // control: fresh, not re-asked
    });

    it('an answer that started BEFORE an invalidation is kept but stays stale', async () => {
        serve('C1', { all: false, user_ids: ['old'] });
        hold = true;
        const p = refreshChannelViewers('S', 'C1', TOKEN);
        await Promise.resolve();
        invalidateServerChannelViewers('S');                         // change lands mid-flight
        await release();
        await p;
        expect(ids(peekChannelViewers('C1'))).toEqual(['old']);
        expect(peekChannelViewers('C1')!.stale).toBe(true);
        expect(isChannelViewersFresh('C1')).toBe(false);
    });

    it('control: without a mid-flight invalidation the same answer is fresh', async () => {
        serve('C1', { all: false, user_ids: ['old'] });
        hold = true;
        const p = refreshChannelViewers('S', 'C1', TOKEN);
        await release();
        await p;
        expect(peekChannelViewers('C1')!.stale).toBe(false);
    });

    it('invalidateAll (reconnect) stales every server', async () => {
        serve('C1', { all: true });
        serve('X1', { all: true });
        await refreshChannelViewers('S', 'C1', TOKEN);
        await refreshChannelViewers('T', 'X1', TOKEN);
        invalidateAllChannelViewers();
        expect(peekChannelViewers('C1')!.stale).toBe(true);
        expect(peekChannelViewers('X1')!.stale).toBe(true);
    });

    it('dropServer forgets only that server', async () => {
        serve('C1', { all: true });
        serve('X1', { all: true });
        await refreshChannelViewers('S', 'C1', TOKEN);
        await refreshChannelViewers('T', 'X1', TOKEN);
        dropServerChannelViewers('S');
        expect(peekChannelViewers('C1')).toBeNull();
        expect(peekChannelViewers('X1')).not.toBeNull();
    });

    it('force while in flight → one trailing request, not one per caller', async () => {
        serve('C1', { all: true });
        hold = true;
        const a = refreshChannelViewers('S', 'C1', TOKEN);
        await Promise.resolve();
        const b = refreshChannelViewers('S', 'C1', TOKEN, { force: true });
        const c = refreshChannelViewers('S', 'C1', TOKEN, { force: true });
        await release();
        await a;
        await release();
        await Promise.all([b, c]);
        expect(calls('C1')).toBe(2);
    });
});

describe('failures', () => {
    it('a failed FIRST fetch records "unknown" so the sidebar degrades instead of spinning', async () => {
        serve('C1', new Error('429'));
        await expect(refreshChannelViewers('S', 'C1', TOKEN)).rejects.toThrow('429');
        const e = peekChannelViewers('C1');
        expect(e).not.toBeNull();
        expect(e!.viewers).toBeNull();
        expect(memberFilterFor('S', restricted('C1'), e)).toBe(FILTER_ALL);
        expect(isChannelViewersFresh('C1')).toBe(false);              // next open retries
    });

    it('a failed REVALIDATION keeps the cached answer', async () => {
        serve('C1', { all: false, user_ids: ['u1'] });
        await refreshChannelViewers('S', 'C1', TOKEN);
        serve('C1', new Error('500'));
        await expect(refreshChannelViewers('S', 'C1', TOKEN, { force: true })).rejects.toThrow();
        expect(ids(peekChannelViewers('C1'))).toEqual(['u1']);
    });

    it('a malformed body is a failure, not an empty viewer set', async () => {
        serve('C1', { all: false, user_ids: 'u1' });
        await expect(refreshChannelViewers('S', 'C1', TOKEN)).rejects.toThrow(/malformed/);
        expect(peekChannelViewers('C1')!.viewers).toBeNull();
        expect(() => parseViewersResponse({ all: false, user_ids: [1] })).toThrow();
        expect(() => parseViewersResponse(null)).toThrow();
        expect(parseViewersResponse({ all: true }).all).toBe(true);   // control
    });

    it('no token → no request', async () => {
        await refreshChannelViewers('S', 'C1', null);
        expect(calls()).toBe(0);
    });
});

describe('bounds (LRU)', () => {
    it(`keeps at most MAX_CHANNELS (${MAX_CHANNELS}) channels, evicting the least recently used`, async () => {
        for (let i = 0; i <= MAX_CHANNELS; i++) {
            serve(`C${i}`, { all: false, user_ids: ['u'] });
            await refreshChannelViewers('S', `C${i}`, TOKEN);
            if (i === 1) touchChannelViewers('C0');                   // C0 viewed again → MRU
        }
        expect(cachedViewerChannelIds().length).toBe(MAX_CHANNELS);
        expect(peekChannelViewers('C0')).not.toBeNull();              // touched: kept
        expect(peekChannelViewers('C1')).toBeNull();                  // oldest untouched: evicted
    });

    it(`keeps the total id budget (${MAX_TOTAL_IDS}) — but never evicts the entry just written`, async () => {
        const big = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);
        serve('A', { all: false, user_ids: big(MAX_TOTAL_IDS - 10, 'a') });
        serve('B', { all: false, user_ids: big(50, 'b') });
        await refreshChannelViewers('S', 'A', TOKEN);
        await refreshChannelViewers('S', 'B', TOKEN);
        expect(peekChannelViewers('A')).toBeNull();
        expect(peekChannelViewers('B')).not.toBeNull();
        expect(cachedViewerIdCount()).toBe(50);
        serve('H', { all: false, user_ids: big(MAX_TOTAL_IDS + 5, 'h') });   // alone bigger than the budget
        await refreshChannelViewers('S', 'H', TOKEN);
        expect(cachedViewerChannelIds()).toEqual(['H']);
    });
});

describe('account scope', () => {
    it('clearRosterCache (sign-out) clears the viewer sets too', async () => {
        serve('C1', { all: true });
        await refreshChannelViewers('S', 'C1', TOKEN);
        clearRosterCache();
        expect(peekChannelViewers('C1')).toBeNull();
    });

    it('switching accounts (bindRosterViewer) clears them', async () => {
        bindRosterViewer('alice');
        serve('C1', { all: true });
        await refreshChannelViewers('S', 'C1', TOKEN);
        bindRosterViewer('bob');
        expect(peekChannelViewers('C1')).toBeNull();
    });

    it('a response that lands after the account changed is discarded', async () => {
        serve('C1', { all: false, user_ids: ['alice-friend'] });
        hold = true;
        const p = refreshChannelViewers('S', 'C1', TOKEN);
        await Promise.resolve();
        clearChannelViewerCache();
        await release();
        expect(await p).toBeNull();
        expect(peekChannelViewers('C1')).toBeNull();
    });
});

describe('memberFilterFor — decision table', () => {
    const entry = (viewers: ChannelViewers | null, stale = false): ChannelViewerEntry => ({ serverId: 'S', viewers, stale });
    const SUBSET = { all: false as const, ids: new Set(['u1', 'u2']) };

    it.each([
        ['no channel', null, null, 'all'],
        ["another server's channel", restricted('C', 'T'), entry(SUBSET), 'all'],
        ['older API (no view_scope)', { channel_id: 'C', server_id: 'S' }, entry(SUBSET), 'all'],
        ['public channel, nothing cached', publicCh('C'), null, 'all'],
        ['public channel beats a stale cached subset', publicCh('C'), entry(SUBSET), 'all'],
        ['restricted, never seen', restricted('C'), null, 'loading'],
        ['restricted, first fetch failed', restricted('C'), entry(null), 'all'],
        ['restricted, cached "everyone"', restricted('C'), entry({ all: true }), 'all'],
        ['restricted, cached subset', restricted('C'), entry(SUBSET), 'subset'],
        ['restricted, cached subset being revalidated', restricted('C'), entry(SUBSET, true), 'subset'],
    ])('%s → %s', (_l, ch, e, kind) => {
        expect(memberFilterFor('S', ch as Parameters<typeof memberFilterFor>[1], e as ChannelViewerEntry | null).kind).toBe(kind);
    });

    it('the subset filter object is stable per viewer set (memoised lists do not recompute)', () => {
        const a = memberFilterFor('S', restricted('C'), entry(SUBSET));
        const b = memberFilterFor('S', restricted('C'), entry(SUBSET, true));
        expect(a).toBe(b);
        const c = memberFilterFor('S', restricted('C'), entry({ all: false, ids: new Set(['u1', 'u2']) }));
        expect(c).not.toBe(a);   // control: a different set object is a different filter
    });

    it('filterMembers: all → same array, loading → empty, subset → only the viewers', () => {
        const ms = [{ user_id: 'u1' }, { user_id: 'u2' }, { user_id: 'u3' }];
        expect(filterMembers(ms, FILTER_ALL)).toBe(ms);
        expect(filterMembers(ms, FILTER_LOADING)).toEqual([]);
        const f = memberFilterFor('S', restricted('C'), entry(SUBSET));
        expect(filterMembers(ms, f).map(m => m.user_id)).toEqual(['u1', 'u2']);
    });
});

describe('hover prefetch', () => {
    it('a pointer RESTING on a restricted channel fetches it once; a passing mouse fetches nothing', async () => {
        vi.useFakeTimers();
        serve('C1', { all: false, user_ids: ['u1'] });
        serve('C2', { all: false, user_ids: ['u2'] });
        hoverPrefetchChannelViewers(restricted('C1'), TOKEN);
        vi.advanceTimersByTime(HOVER_INTENT_MS - 10);
        cancelHoverPrefetch();                                     // left before the dwell
        hoverPrefetchChannelViewers(restricted('C2'), TOKEN);
        vi.advanceTimersByTime(HOVER_INTENT_MS);                  // rested
        vi.useRealTimers();
        await release();
        expect(calls('C1')).toBe(0);
        expect(calls('C2')).toBe(1);
        expect(ids(peekChannelViewers('C2'))).toEqual(['u2']);
    });

    it('public channels and fresh answers are never prefetched', async () => {
        serve('C1', { all: true });
        await refreshChannelViewers('S', 'C1', TOKEN);
        vi.useFakeTimers();
        hoverPrefetchChannelViewers(restricted('C1'), TOKEN);      // fresh
        vi.advanceTimersByTime(HOVER_INTENT_MS * 2);
        hoverPrefetchChannelViewers(publicCh('P'), TOKEN);         // public
        vi.advanceTimersByTime(HOVER_INTENT_MS * 2);
        vi.useRealTimers();
        await release();
        expect(calls()).toBe(1);                                   // only the initial fetch
    });
});

describe('wiring (source)', () => {
    it('the channel list prefetches on hover', () => {
        const list = readFileSync(resolve(__dirname, '..', 'components/server/ServerChannelList.tsx'), 'utf8');
        expect(list).toMatch(/onMouseEnter=\{\(\) => hoverPrefetchChannelViewers\(ch, token\)\}/);
        expect(list).toMatch(/onMouseLeave=\{cancelHoverPrefetch\}/);
    });

    const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');

    it('the panel filters ONLY the member list, from the live channel, and waits instead of flashing', () => {
        const panel = read('components/server/ServerContextPanel.tsx');
        expect(panel).toMatch(/useChannelMemberFilter\(server\.server_id, liveChannel, token\)/);
        expect(panel).toMatch(/allChannels\.find\(c => c\.channel_id === channel\.channel_id\) \?\? channel/);
        expect(panel).toMatch(/const listMembers = useMemo\(\(\) => filterMembers\(members, memberFilter\)/);
        expect(panel).toMatch(/const listLoading = loading \|\| memberFilter\.kind === 'loading';/);
        expect(panel).toMatch(/\{listLoading \? \(/);
        expect(panel).toMatch(/for \(const m of listMembers\) \{/);
        expect(panel).toMatch(/useIncrementalRows\(server\.server_id, listMembers\.length\)/);
        // Name colours / nicknames / avatars still come from the FULL roster.
        expect(panel).toMatch(/for \(const m of members\) \{\n\s*map\[m\.user_id\] = getHighestRoleColor/);
        expect(panel).toMatch(/const memberMap = new Map\(members\.map/);
    });

    it('Dashboard invalidates on every event that can change who sees a channel', () => {
        const dash = read('components/Dashboard.tsx');
        // member joined + permissions changed + channels changed
        expect([...dash.matchAll(/invalidateServerChannelViewers\(server_id\);/g)].length).toBe(3);
        expect(dash).toMatch(/invalidateServerChannelViewers\(serverMembersChangedEvent\.server_id\);/);
        expect(dash).toMatch(/invalidateAllRosters\(\);\n\s*invalidateAllChannelViewers\(\);/);
        expect(dash).toMatch(/dropServerChannelViewers\(server_id\);/);
        expect(dash).toMatch(/dropServerChannelViewers\(leaveServerTarget\.server_id\);/);
    });

    it('memory-only: the module never touches storage', () => {
        const src = read('utils/channelViewerCache.ts');
        expect(src).not.toMatch(/localStorage|secureLocalStore|indexedDB|writeFile/);
    });
});
