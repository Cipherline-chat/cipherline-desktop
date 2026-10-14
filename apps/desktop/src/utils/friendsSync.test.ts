import { describe, it, expect } from 'vitest';
import {
    createFriendsSync,
    friendsRetryDelayMs,
    parseFriendsPayload,
    type FriendsLoadStatus,
    type FriendsPayload,
} from './friendsSync';

/**
 * The reported bug: after accepting a friend request the Friends main list said
 * "no friends" while the Active Now panel listed the friend as online. The two
 * read DIFFERENT copies of GET /friends; the main list's was a pane-local state
 * that starts empty and was never repaired by a failed/hung/reordered fetch.
 * These pin the rules that make a single copy safe.
 */

const friend = (id: string, username = `user-${id}`) => ({
    friend_table_id: `row-${id}`, user_id: id, username, status: 'online',
});
const payload = (accepted: unknown[] = [], extra: Record<string, unknown> = {}) => ({
    pending_incoming: [], pending_outgoing: [], accepted, blocked: [], ...extra,
});

/** A controllable fake clock + a recorder for everything the sync reports. */
function harness(load: () => Promise<unknown>) {
    const timers: { id: number; fn: () => void; ms: number }[] = [];
    let nextId = 1;
    const data: FriendsPayload[] = [];
    const statuses: FriendsLoadStatus[] = [];
    const errors: unknown[] = [];
    const sync = createFriendsSync({
        load: () => load(),
        onData: p => data.push(p),
        onStatus: s => statuses.push(s),
        onError: e => errors.push(e),
        setTimer: (fn, ms) => { const id = nextId++; timers.push({ id, fn, ms }); return id; },
        clearTimer: h => { const i = timers.findIndex(t => t.id === h); if (i >= 0) timers.splice(i, 1); },
    });
    return {
        sync, timers, data, statuses, errors,
        get latest() { return data[data.length - 1] ?? null; },
        fireTimer: () => { const t = timers.shift(); t?.fn(); },
    };
}

/** A promise you resolve/reject by hand, to control response ORDER. */
function deferred<T>() {
    let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

describe('parseFriendsPayload — a misparsed response is a failure, never "empty"', () => {
    it('accepts the server shape, including a genuinely empty list', () => {
        expect(parseFriendsPayload(payload([friend('a')]))?.accepted).toHaveLength(1);
        expect(parseFriendsPayload(payload([]))?.accepted).toEqual([]);
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['an HTML error page', '<html>502 Bad Gateway</html>'],
        ['an empty string (e.g. a 204/304 body)', ''],
        ['a bare array', []],
        ['an object with no accepted list', { pending_incoming: [], blocked: [] }],
        ['accepted that is not an array', { accepted: 'none' }],
        ['a paginated envelope', { data: [friend('a')], next: 'cursor' }],
        ['a wrong-typed pending list', { accepted: [], pending_incoming: 'x' }],
    ])('rejects %s', (_label, body) => {
        expect(parseFriendsPayload(body)).toBeNull();
    });

    it('tolerates absent optional lists (older server) but not wrong-typed ones', () => {
        const p = parseFriendsPayload({ accepted: [friend('a')] });
        expect(p?.blocked).toEqual([]);
        expect(p?.pending_incoming).toEqual([]);
    });

    it('drops non-object rows and gives a username-less row a placeholder (it used to crash the pane)', () => {
        const p = parseFriendsPayload(payload([friend('a'), null, 7, { user_id: 'b' }]));
        expect(p?.accepted).toHaveLength(2);
        expect(p?.accepted[1]).toMatchObject({ user_id: 'b', username: 'Unknown user' });
    });
});

describe('createFriendsSync — keeps the last good list', () => {
    it('REPRO: a failed refresh after accept does not blank the list, and a retry heals it', async () => {
        const responses: (() => Promise<unknown>)[] = [
            async () => payload([], { pending_incoming: [{ friend_table_id: 'r1', requester_id: 'x', username: 'x' }] }),
            async () => { throw new Error('Network Error'); },                 // the post-accept refetch fails
            async () => payload([friend('x')]),                                // the backoff retry lands
        ];
        const h = harness(() => responses.shift()!());

        await h.sync.refresh();
        expect(h.latest?.accepted).toEqual([]);

        await h.sync.refresh();                                                // accept → refetch → fails
        // Nothing was pushed: the previous (pre-accept) list is untouched rather than
        // replaced by an empty/initial one, and the UI is told the refresh failed.
        expect(h.data).toHaveLength(1);
        expect(h.statuses.at(-1)).toBe('error');
        expect(h.timers).toHaveLength(1);                                       // retry is armed

        h.fireTimer();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        expect(h.latest?.accepted.map(f => f.user_id)).toEqual(['x']);
        expect(h.statuses.at(-1)).toBe('ready');
        expect(h.timers).toHaveLength(0);                                       // retry disarmed
    });

    it('a malformed 200 never replaces good data with an empty list', async () => {
        const bodies: unknown[] = [payload([friend('a')]), { unexpected: true }, '', null];
        const h = harness(async () => bodies.shift());
        await h.sync.refresh();
        for (let i = 0; i < 3; i++) { await h.sync.refresh(); h.timers.length = 0; }
        expect(h.data).toHaveLength(1);
        expect(h.latest?.accepted).toHaveLength(1);
        expect(h.statuses.at(-1)).toBe('error');
    });

    it('with nothing ever loaded, a failure pushes NO data (the UI shows loading/error, not "no friends")', async () => {
        const h = harness(async () => { throw new Error('ECONNRESET'); });
        await h.sync.refresh();
        expect(h.data).toHaveLength(0);
        expect(h.statuses).toEqual(['loading', 'error']);
        expect(h.errors).toHaveLength(1);
    });

    it('a loaded, genuinely empty list IS reported (loaded-and-empty is distinct from never-loaded)', async () => {
        const h = harness(async () => payload([]));
        await h.sync.refresh();
        expect(h.data).toHaveLength(1);
        expect(h.latest?.accepted).toEqual([]);
        expect(h.statuses.at(-1)).toBe('ready');
    });
});

describe('createFriendsSync — responses apply in request order', () => {
    it('REPRO: a slow pre-accept snapshot landing after the post-accept one is dropped', async () => {
        const pre = deferred<unknown>();
        const post = deferred<unknown>();
        const queue = [pre, post];
        const h = harness(() => queue.shift()!.promise);

        const first = h.sync.refresh();    // fired before the accept
        const second = h.sync.refresh();   // fired after the accept
        post.resolve(payload([friend('x')]));
        await second;
        pre.resolve(payload([]));          // arrives LAST but is OLDER
        await first;

        expect(h.latest?.accepted.map(f => f.user_id)).toEqual(['x']);
        expect(h.data.every(p => p.accepted.length === 1)).toBe(true);
        expect(h.statuses.at(-1)).toBe('ready');
    });

    it('a late FAILURE from an older request does not flag an error over fresh data', async () => {
        const slow = deferred<unknown>();
        const queue = [slow.promise, Promise.resolve(payload([friend('x')]))];
        const h = harness(() => queue.shift()!);
        const first = h.sync.refresh();
        await h.sync.refresh();
        slow.reject(new Error('timeout'));
        await first;
        expect(h.statuses.at(-1)).toBe('ready');
        expect(h.timers).toHaveLength(0);
        expect(h.errors).toHaveLength(0);
    });

    it('newer data followed by a still-newer one is applied normally', async () => {
        const bodies = [payload([friend('a')]), payload([friend('a'), friend('b')])];
        const h = harness(async () => bodies.shift());
        await h.sync.refresh();
        await h.sync.refresh();
        expect(h.latest?.accepted).toHaveLength(2);
    });
});

describe('createFriendsSync — retry', () => {
    it('backs off 3s, 6s, 12s, 24s then holds at 30s', () => {
        expect([1, 2, 3, 4, 5, 6, 20].map(friendsRetryDelayMs)).toEqual([3000, 6000, 12000, 24000, 30000, 30000, 30000]);
    });

    it('keeps retrying with growing delays until a load succeeds, then stops', async () => {
        let n = 0;
        const h = harness(async () => { n += 1; if (n < 4) throw new Error('down'); return payload([friend('a')]); });
        await h.sync.refresh();
        expect(h.timers.map(t => t.ms)).toEqual([3000]);
        for (const expected of [6000, 12000]) {
            h.fireTimer();
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            expect(h.timers.map(t => t.ms)).toEqual([expected]);
        }
        h.fireTimer();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        expect(h.timers).toHaveLength(0);
        expect(h.latest?.accepted).toHaveLength(1);
    });

    it('a manual refresh while a retry is pending replaces it rather than stacking timers', async () => {
        const bodies: (() => Promise<unknown>)[] = [
            async () => { throw new Error('x'); },
            async () => { throw new Error('y'); },
        ];
        const h = harness(() => bodies.shift()!());
        await h.sync.refresh();
        await h.sync.refresh();
        expect(h.timers).toHaveLength(1);
    });

    it('dispose() stops retries and discards in-flight results; resume() revives it (StrictMode)', async () => {
        const inflight = deferred<unknown>();
        const h = harness(() => inflight.promise);
        const p = h.sync.refresh();
        h.sync.dispose();
        inflight.resolve(payload([friend('a')]));
        await p;
        expect(h.data).toHaveLength(0);

        const h2 = harness(async () => { throw new Error('down'); });
        await h2.sync.refresh();
        h2.sync.dispose();
        expect(h2.timers).toHaveLength(0);

        const h3 = harness(async () => payload([friend('a')]));
        h3.sync.dispose();
        h3.sync.resume();
        await h3.sync.refresh();
        expect(h3.data).toHaveLength(1);
    });
});
