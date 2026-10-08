/**
 * serverRosterCache: the stale-while-revalidate member roster behind the server
 * panel.
 *
 * Every behaviour is pinned together with the control that would catch its
 * absence: a hit is asserted to cost ZERO requests right after a miss is
 * asserted to cost exactly one pair; "unchanged answer keeps identity" is
 * asserted next to "changed answer replaces only the changed row".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const axiosGet = vi.fn();
vi.mock('axios', () => ({ default: { get: (...a: unknown[]) => axiosGet(...a) } }));

import {
    refreshRoster,
    getRoster,
    peekRoster,
    isRosterFresh,
    subscribeRoster,
    invalidateRoster,
    invalidateAllRosters,
    dropRoster,
    patchRosterUser,
    bindRosterViewer,
    clearRosterCache,
    cachedRosterServerIds,
    cachedRosterRowCount,
    __resetRosterCache,
    FRESH_MS,
    MAX_SERVERS,
    MAX_TOTAL_ROWS,
    type RosterMember,
    type RosterRole,
} from './serverRosterCache';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TOKEN = 'tok';

const member = (id: string, extra: Partial<RosterMember> = {}): RosterMember => ({
    user_id: id, username: `u-${id}`, discriminator: 1, nickname: null, avatar_url: `av-${id}`,
    status: 'online', joined_at: '2026-01-01T00:00:00Z', muted_until: null, role_ids: [], ...extra,
});
const role = (id: string, extra: Partial<RosterRole> = {}): RosterRole => ({
    role_id: id, name: `r-${id}`, color: -1, position: 1, hoisted: false, is_everyone: false, ...extra,
});

/** Per-server canned answers; every GET is counted and resolves on a microtask. */
interface Canned { members: RosterMember[] | Error; roles: RosterRole[] | Error }
const answers = new Map<string, Canned>();
const holds: Array<() => void> = [];
let hold = false;

function serve(serverId: string, members: RosterMember[], roles: RosterRole[] = []): void {
    answers.set(serverId, { members, roles });
}
const calls = (kind: 'members' | 'roles', serverId?: string) =>
    axiosGet.mock.calls.filter(c => String(c[0]).endsWith(`/${kind}`) && (!serverId || String(c[0]).includes(`/servers/${serverId}/`))).length;

beforeEach(() => {
    __resetRosterCache();
    axiosGet.mockReset();
    answers.clear();
    holds.length = 0;
    hold = false;
    axiosGet.mockImplementation(async (url: string) => {
        const m = /\/servers\/([^/]+)\/(members|roles)$/.exec(url);
        if (!m) throw new Error(`unexpected GET ${url}`);
        if (hold) await new Promise<void>(res => holds.push(res));
        const canned = answers.get(m[1]);
        if (!canned) throw new Error('404');
        const v = m[2] === 'members' ? canned.members : canned.roles;
        if (v instanceof Error) throw v;
        // A fresh deep copy per response, like a real HTTP body: identity must
        // be preserved by the CACHE, not by the transport handing back the same objects.
        return { data: JSON.parse(JSON.stringify(v)) };
    });
});
afterEach(() => { vi.restoreAllMocks(); });

const release = async () => { holds.splice(0).forEach(r => r()); await new Promise(r => setTimeout(r, 0)); };

describe('hit / miss', () => {
    it('a miss fetches members + roles once and stores them; the next read is synchronous and free', async () => {
        serve('A', [member('1'), member('2')], [role('r1')]);
        expect(getRoster('A')).toBeNull();                      // control: nothing before the fetch

        const r = await refreshRoster('A', TOKEN);
        expect(calls('members')).toBe(1);
        expect(calls('roles')).toBe(1);
        expect(r?.members.map(m => m.user_id)).toEqual(['1', '2']);

        axiosGet.mockClear();
        expect(getRoster('A')).toBe(r);                          // same object, no await
        expect(axiosGet).not.toHaveBeenCalled();
    });

    it('without a token nothing is requested', async () => {
        expect(await refreshRoster('A', null)).toBeNull();
        expect(axiosGet).not.toHaveBeenCalled();
    });

    it('a copy younger than FRESH_MS is not revalidated; an older one is', async () => {
        serve('A', [member('1')]);
        const now = vi.spyOn(Date, 'now');
        now.mockReturnValue(1_000_000);
        await refreshRoster('A', TOKEN);
        axiosGet.mockClear();

        now.mockReturnValue(1_000_000 + FRESH_MS - 1);
        expect(isRosterFresh('A')).toBe(true);
        await refreshRoster('A', TOKEN);
        expect(axiosGet).not.toHaveBeenCalled();

        now.mockReturnValue(1_000_000 + FRESH_MS + 1);
        expect(isRosterFresh('A')).toBe(false);
        await refreshRoster('A', TOKEN);
        expect(calls('members')).toBe(1);                         // control: the stale one DID refetch
    });
});

describe('stale-while-revalidate', () => {
    it('keeps serving the cached rows while the revalidation is in flight, then replaces them', async () => {
        serve('A', [member('1', { nickname: 'old' })]);
        await refreshRoster('A', TOKEN);
        invalidateRoster('A');

        serve('A', [member('1', { nickname: 'new' }), member('2')]);
        hold = true;
        const p = refreshRoster('A', TOKEN);
        await Promise.resolve();
        // Mid-flight: the stale list is still there (this is what removes the spinner).
        expect(getRoster('A')?.members).toHaveLength(1);
        expect(getRoster('A')?.members[0].nickname).toBe('old');

        hold = false;
        await release();
        await p;
        expect(getRoster('A')?.members.map(m => m.nickname)).toEqual(['new', null]);
    });

    it('an unchanged answer keeps every identity and notifies nobody', async () => {
        serve('A', [member('1'), member('2')], [role('r1')]);
        const first = await refreshRoster('A', TOKEN);
        const listener = vi.fn();
        subscribeRoster(listener);

        const second = await refreshRoster('A', TOKEN, { force: true });
        expect(calls('members')).toBe(2);                        // it DID go to the network
        expect(second).toBe(first);                              // ...and nothing was replaced
        expect(second?.members).toBe(first?.members);
        expect(listener).not.toHaveBeenCalled();
    });

    it('a changed answer replaces only the changed row; untouched rows keep their identity', async () => {
        serve('A', [member('1'), member('2'), member('3')]);
        const first = await refreshRoster('A', TOKEN);
        const listener = vi.fn();
        subscribeRoster(listener);

        serve('A', [member('1'), member('2', { nickname: 'renamed' }), member('3')]);
        const second = await refreshRoster('A', TOKEN, { force: true });

        expect(second).not.toBe(first);
        expect(second?.members[0]).toBe(first?.members[0]);
        expect(second?.members[2]).toBe(first?.members[2]);
        expect(second?.members[1]).not.toBe(first?.members[1]);
        expect(second?.members[1].nickname).toBe('renamed');
        expect(second?.roles).toBe(first?.roles);                // roles untouched
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('a member who left disappears; a role field the row-signature does not know about still counts as a change', async () => {
        serve('A', [member('1'), member('2')], [role('r1', { mentionable: false })]);
        await refreshRoster('A', TOKEN);
        serve('A', [member('1')], [role('r1', { mentionable: true })]);
        const next = await refreshRoster('A', TOKEN, { force: true });
        expect(next?.members.map(m => m.user_id)).toEqual(['1']);
        expect(next?.roles[0].mentionable).toBe(true);
    });

    it('a failed revalidation leaves the cached roster untouched and rejects', async () => {
        serve('A', [member('1')]);
        const first = await refreshRoster('A', TOKEN);
        answers.set('A', { members: new Error('boom'), roles: [] });
        await expect(refreshRoster('A', TOKEN, { force: true })).rejects.toThrow('boom');
        expect(peekRoster('A')).toBe(first);
    });

    it('a failed ROLES request keeps the last known roles instead of blanking them', async () => {
        serve('A', [member('1')], [role('r1')]);
        await refreshRoster('A', TOKEN);
        answers.set('A', { members: [member('1'), member('2')], roles: new Error('roles down') });
        const next = await refreshRoster('A', TOKEN, { force: true });
        expect(next?.members).toHaveLength(2);
        expect(next?.roles.map(r => r.role_id)).toEqual(['r1']);
    });
});

describe('request sharing', () => {
    it('concurrent callers share ONE members + roles pair', async () => {
        serve('A', [member('1')]);
        hold = true;
        const ps = [refreshRoster('A', TOKEN), refreshRoster('A', TOKEN), refreshRoster('A', TOKEN)];
        hold = false;
        await release();
        const rs = await Promise.all(ps);
        expect(calls('members')).toBe(1);
        expect(calls('roles')).toBe(1);
        expect(rs[0]).toBe(rs[1]);
        expect(rs[1]).toBe(rs[2]);
    });

    it('a forced refresh never reuses a request that started before it: one trailing fetch, shared by every forced caller', async () => {
        serve('A', [member('1')]);
        hold = true;
        const first = refreshRoster('A', TOKEN);                  // in flight, will return the OLD answer
        await Promise.resolve();
        serve('A', [member('1'), member('2')]);                   // the change the forced callers are reacting to
        const f1 = refreshRoster('A', TOKEN, { force: true });
        const f2 = refreshRoster('A', TOKEN, { force: true });
        hold = false;
        for (let i = 0; i < 6; i++) await release();
        await Promise.all([first, f1, f2]);

        expect(calls('members')).toBe(2);                         // not 1 (stale reuse), not 3 (no sharing)
        expect(f1).toBe(f2);
        expect(getRoster('A')?.members).toHaveLength(2);
    });
});

describe('LRU bound', () => {
    it(`holds at most ${MAX_SERVERS} servers and drops the least recently used first`, async () => {
        for (let i = 0; i < MAX_SERVERS + 2; i++) {
            serve(`S${i}`, [member(`m${i}`)]);
            await refreshRoster(`S${i}`, TOKEN);
        }
        const ids = cachedRosterServerIds();
        expect(ids).toHaveLength(MAX_SERVERS);
        expect(ids).not.toContain('S0');                          // control: the oldest went
        expect(ids).not.toContain('S1');
        expect(ids).toContain(`S${MAX_SERVERS + 1}`);
    });

    it('reading a server (viewing it) protects it from eviction', async () => {
        for (let i = 0; i < MAX_SERVERS; i++) {
            serve(`S${i}`, [member(`m${i}`)]);
            await refreshRoster(`S${i}`, TOKEN);
        }
        getRoster('S0');                                          // S0 becomes most recent
        serve('NEW', [member('n')]);
        await refreshRoster('NEW', TOKEN);
        expect(cachedRosterServerIds()).toContain('S0');
        expect(cachedRosterServerIds()).not.toContain('S1');      // S1 was the least recent
    });

    it(`stays under the ${MAX_TOTAL_ROWS}-row budget by evicting older servers`, async () => {
        const big = (tag: string, n: number) => Array.from({ length: n }, (_, i) => member(`${tag}${i}`));
        serve('A', big('a', 1500));
        serve('B', big('b', 1500));
        serve('C', big('c', 1500));
        await refreshRoster('A', TOKEN);
        await refreshRoster('B', TOKEN);
        expect(cachedRosterRowCount()).toBe(3000);                // exactly at budget
        await refreshRoster('C', TOKEN);
        expect(cachedRosterRowCount()).toBeLessThanOrEqual(MAX_TOTAL_ROWS);
        expect(cachedRosterServerIds()).toEqual(['B', 'C']);
    });

    it('the viewed server is always kept even when it alone exceeds the budget, and goes first afterwards', async () => {
        serve('HUGE', Array.from({ length: MAX_TOTAL_ROWS + 500 }, (_, i) => member(`h${i}`)));
        serve('SMALL', [member('s')]);
        await refreshRoster('HUGE', TOKEN);
        expect(getRoster('HUGE')?.members).toHaveLength(MAX_TOTAL_ROWS + 500);   // not truncated, not dropped
        await refreshRoster('SMALL', TOKEN);
        expect(cachedRosterServerIds()).toEqual(['SMALL']);
    });
});

describe('prefetch', () => {
    it('fills free room at the LRU end and never evicts a server the user has looked at', async () => {
        for (let i = 0; i < MAX_SERVERS; i++) {
            serve(`S${i}`, [member(`m${i}`)]);
            await refreshRoster(`S${i}`, TOKEN);
        }
        serve('EXTRA', [member('x')]);
        const r = await refreshRoster('EXTRA', TOKEN, { prefetch: true });
        expect(r?.members).toHaveLength(1);                        // handed back to the caller...
        expect(peekRoster('EXTRA')).toBeNull();                    // ...but not stored: no room
        expect(cachedRosterServerIds()).toHaveLength(MAX_SERVERS);
        expect(cachedRosterServerIds()).toContain('S0');
    });

    it('a prefetched server sits at the LRU end, so a later real view outranks it', async () => {
        serve('PRE', [member('p')]);
        await refreshRoster('PRE', TOKEN, { prefetch: true });
        serve('VIEW', [member('v')]);
        await refreshRoster('VIEW', TOKEN);
        expect(cachedRosterServerIds()).toEqual(['PRE', 'VIEW']);  // PRE is the first to go
    });

    it('a viewer who joins an in-flight prefetch gets the result stored even with no free room', async () => {
        for (let i = 0; i < MAX_SERVERS; i++) {
            serve(`S${i}`, [member(`m${i}`)]);
            await refreshRoster(`S${i}`, TOKEN);
        }
        serve('OPEN', [member('o')]);
        hold = true;
        const pre = refreshRoster('OPEN', TOKEN, { prefetch: true });
        const view = refreshRoster('OPEN', TOKEN);                 // the user clicks it mid-flight
        hold = false;
        await release();
        await Promise.all([pre, view]);
        expect(peekRoster('OPEN')).not.toBeNull();                 // else the panel would spin forever
    });
});

describe('live events', () => {
    it('invalidateRoster keeps the rows (instant paint) but forces the next open to revalidate', async () => {
        serve('A', [member('1')]);
        const first = await refreshRoster('A', TOKEN);
        invalidateRoster('A');
        expect(getRoster('A')).toBe(first);                        // still painted
        expect(isRosterFresh('A')).toBe(false);
        axiosGet.mockClear();
        await refreshRoster('A', TOKEN);
        expect(calls('members')).toBe(1);
    });

    it('invalidateAllRosters stales every server (socket reconnect)', async () => {
        serve('A', [member('1')]);
        serve('B', [member('2')]);
        await refreshRoster('A', TOKEN);
        await refreshRoster('B', TOKEN);
        invalidateAllRosters();
        expect(isRosterFresh('A')).toBe(false);
        expect(isRosterFresh('B')).toBe(false);
        expect(peekRoster('A')).not.toBeNull();
    });

    it('patchRosterUser updates the user in every cached server that has them and leaves the others untouched', async () => {
        serve('A', [member('1'), member('2')]);
        serve('B', [member('1')]);
        serve('C', [member('3')]);
        await refreshRoster('A', TOKEN);
        await refreshRoster('B', TOKEN);
        await refreshRoster('C', TOKEN);
        const a0 = peekRoster('A'); const b0 = peekRoster('B'); const c0 = peekRoster('C');
        const listener = vi.fn();
        subscribeRoster(listener);

        patchRosterUser('1', { avatar_url: 'new-av', username: 'renamed' });

        expect(peekRoster('A')?.members[0]).toMatchObject({ user_id: '1', avatar_url: 'new-av', username: 'renamed' });
        expect(peekRoster('B')?.members[0].avatar_url).toBe('new-av');
        expect(peekRoster('A')?.members[1]).toBe(a0?.members[1]);  // other rows untouched
        expect(peekRoster('C')).toBe(c0);                          // server without the user: same object
        expect(peekRoster('A')).not.toBe(a0);
        expect(peekRoster('B')).not.toBe(b0);
        expect(listener).toHaveBeenCalledTimes(1);

        listener.mockClear();
        patchRosterUser('1', { avatar_url: 'new-av' });            // no-op patch
        expect(listener).not.toHaveBeenCalled();
    });

    it('dropRoster forgets a server (left / kicked / banned)', async () => {
        serve('A', [member('1')]);
        await refreshRoster('A', TOKEN);
        const listener = vi.fn();
        subscribeRoster(listener);
        dropRoster('A');
        expect(peekRoster('A')).toBeNull();
        expect(listener).toHaveBeenCalledTimes(1);
    });
});

describe('sign-out / account switch', () => {
    it('clearRosterCache empties everything', async () => {
        serve('A', [member('1')]);
        await refreshRoster('A', TOKEN);
        clearRosterCache();
        expect(cachedRosterServerIds()).toEqual([]);
    });

    it('every way AuthContext ends a session (logout, rejected refresh) clears the rosters', () => {
        const auth = readFileSync(resolve(__dirname, '..', 'contexts/AuthContext.tsx'), 'utf8');
        expect([...auth.matchAll(/dropSessionMedia\(\);\n\s*clearRosterCache\(\);/g)].length).toBe(2);
        expect(auth).toMatch(/from '\.\.\/utils\/serverRosterCache'/);
    });

    it('switching accounts drops the previous account\'s rosters; the first bind of a session does not', async () => {
        serve('A', [member('1')]);
        await refreshRoster('A', TOKEN);
        bindRosterViewer('alice');                                 // null -> alice: boot, keep the prefetch
        expect(peekRoster('A')).not.toBeNull();
        bindRosterViewer('alice');                                 // same account: no-op
        expect(peekRoster('A')).not.toBeNull();
        bindRosterViewer('bob');                                   // alice -> bob
        expect(peekRoster('A')).toBeNull();
    });

    it('a response that lands after the account changed is discarded, not cached for the next account', async () => {
        bindRosterViewer('alice');
        serve('A', [member('1')]);
        hold = true;
        const p = refreshRoster('A', TOKEN);
        await Promise.resolve();
        bindRosterViewer(null);                                    // signed out mid-flight
        hold = false;
        await release();
        expect(await p).toBeNull();
        expect(peekRoster('A')).toBeNull();
    });
});

describe('wiring (source)', () => {
    // Pin the call sites the unit tests above cannot reach: the panel must read
    // the cache and must never put the list behind a spinner when it has rows.
    const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');

    it('ServerContextPanel renders from the cache and only spins when there is nothing to show', () => {
        const panel = read('components/server/ServerContextPanel.tsx');
        expect(panel).toMatch(/useServerRoster\(server\.server_id\)/);
        expect(panel).toMatch(/const loading = roster === null && failedRosterFor !== server\.server_id;/);
        expect(panel).not.toMatch(/const \[members, setMembers\]/);
        expect(panel).not.toMatch(/setLoading\(true\)/);
        expect(panel).not.toMatch(/axios\.get\(`\$\{API_BASE\}\/servers\/\$\{server\.server_id\}\/members`/);
    });

    it('ChatPane no longer makes its own members + roles requests on every channel switch', () => {
        const chat = read('components/ChatPane.tsx');
        expect(chat).toMatch(/refreshRoster\(sid, token\)/);
        expect(chat).not.toMatch(/axios\.get\(`\$\{API_BASE\}\/servers\/\$\{sid\}\/members`/);
    });

    it('Dashboard feeds the live events into the cache', () => {
        const dash = read('components/Dashboard.tsx');
        expect(dash).toMatch(/invalidateRoster\(serverMembersChangedEvent\.server_id\)/);
        // joined / permissions-changed: the server_id destructured from the event
        expect([...dash.matchAll(/invalidateRoster\(server_id\);/g)].length).toBe(2);
        expect(dash).toMatch(/invalidateAllRosters\(\);/);   // socket reconnect resync
        expect(dash).toMatch(/patchRosterUser\(user_id, \{ avatar_url: newAttachmentId \}\)/);
        expect(dash).toMatch(/patchRosterUser\(user_id, \{ username/);
        expect(dash).toMatch(/dropRoster\(server_id\)/);
        expect(dash).toMatch(/refreshRoster\(srv\.server_id, token, \{ prefetch: true \}\)/);
    });

    it('the roster is memory-only: the module never touches storage', () => {
        const src = read('utils/serverRosterCache.ts');
        expect(src).not.toMatch(/localStorage|secureLocalStore|indexedDB|writeFile/);
    });
});
