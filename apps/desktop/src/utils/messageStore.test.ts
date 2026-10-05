import { describe, it, expect, beforeEach } from 'vitest';
import { secureLocalStore } from './secureLocalStore';
import * as messageStore from './messageStore';

/**
 * messageStore splits message history from one record-per-account into one
 * record-per-conversation. The thing that makes this change risky is that the
 * backup/restore vault reads and writes through it: a bug here produces a
 * backup that looks fine and turns out to be missing conversations only when
 * someone tries to restore it. So the round-trip is tested explicitly, as is
 * migration from the old layout and the "does this device have history"
 * predicate that gates offering a destructive history sync.
 */

const USER = 'user-1';
const OTHER = 'user-2';

/** Minimal synchronous in-memory stand-in for the encrypted store. Mirrors the
 *  subset of the API messageStore uses; keeps these tests about layout logic
 *  rather than crypto (secureLocalStore.test.ts already covers that). */
function installFakeStore() {
    const m = new Map<string, string>();
    const s = secureLocalStore as any;
    s.getItem = (k: string) => (m.has(k) ? m.get(k)! : null);
    s.setItem = (k: string, v: string) => { m.set(k, v); };
    s.removeItem = (k: string) => { m.delete(k); };
    s.keysWithPrefix = (p: string) => [...m.keys()].filter(k => k.startsWith(p));
    s.hydrateMessages = async () => {};
    // Readiness seam. The reads refuse to answer from a namespace that is not
    // in memory (see HistoryNotReadableError), so the fake has to model it;
    // `setReady(null)` below is how the not-ready case is exercised.
    s.whenAccountReady = async () => {};
    s.isAccountReady = (u: string) => !!u && (readyUser === 'all' || readyUser === u);
    return m;
}

/** Which account the fake store currently has loaded. 'all' = every account is
 *  readable (the default, so the layout tests below stay about layout); a
 *  userId or null narrows it, which is how the not-ready case is exercised. */
let readyUser: string | 'all' | null = 'all';
function setReady(u: string | 'all' | null) { readyUser = u; }

let mem: Map<string, string>;
beforeEach(() => {
    setReady('all');
    mem = installFakeStore();
    messageStore._resetForTest();
});

const dmKey = (uid: string, cid: string) => `cipherline_msgs_${uid}_${cid}`;
const msg = (id: string) => ({ id, content: { type: 'text', text: id } });

describe('messageStore — per-thread layout', () => {
    it('writes one record per conversation, not one for everything', async () => {
        messageStore.saveAll('dm', USER, { a: [msg('m1')], b: [msg('m2')] });
        expect(mem.has(dmKey(USER, 'a'))).toBe(true);
        expect(mem.has(dmKey(USER, 'b'))).toBe(true);
        // The old all-in-one record must not be recreated.
        expect(mem.has(`cipherline_msgs_${USER}`)).toBe(false);
    });

    it('round-trips a full map unchanged', async () => {
        const map = { a: [msg('m1'), msg('m2')], b: [msg('m3')] };
        messageStore.saveAll('dm', USER, map);
        messageStore._resetForTest();
        expect(await messageStore.loadAll('dm', USER)).toEqual(map);
    });

    it('rewrites ONLY the thread that changed — the whole point of the split', async () => {
        const a = [msg('m1')];
        const b = [msg('m2')];
        messageStore.saveAll('dm', USER, { a, b });

        const writes: string[] = [];
        const realSet = (secureLocalStore as any).setItem;
        (secureLocalStore as any).setItem = (k: string, v: string) => { writes.push(k); realSet(k, v); };

        // `a` keeps its identity; only `b` is replaced.
        messageStore.saveAll('dm', USER, { a, b: [...b, msg('m3')] });
        expect(writes).toEqual([dmKey(USER, 'b')]);
    });

    it('deletes threads dropped from the map (retention sweep semantics)', async () => {
        messageStore.saveAll('dm', USER, { a: [msg('m1')], b: [msg('m2')] });
        messageStore.saveAll('dm', USER, { a: [msg('m1')] });   // b pruned
        expect(mem.has(dmKey(USER, 'b'))).toBe(false);
        expect(mem.has(dmKey(USER, 'a'))).toBe(true);
    });

    it('keeps DM and channel history in separate namespaces', async () => {
        messageStore.saveAll('dm', USER, { x: [msg('dm')] });
        messageStore.saveAll('channel', USER, { x: [msg('ch')] });
        expect(await messageStore.loadAll('dm', USER)).toEqual({ x: [msg('dm')] });
        expect(await messageStore.loadAll('channel', USER)).toEqual({ x: [msg('ch')] });
    });

    it('keeps accounts separate', async () => {
        messageStore.saveAll('dm', USER, { a: [msg('mine')] });
        messageStore.saveAll('dm', OTHER, { a: [msg('theirs')] });
        expect(await messageStore.loadAll('dm', USER)).toEqual({ a: [msg('mine')] });
        expect(await messageStore.loadAll('dm', OTHER)).toEqual({ a: [msg('theirs')] });
    });
});

describe('messageStore — migration from the legacy single record', () => {
    it('splits the old blob into per-thread records and retires it', async () => {
        mem.set(`cipherline_msgs_${USER}`, JSON.stringify({ a: [msg('m1')], b: [msg('m2')] }));
        const out = await messageStore.loadAll('dm', USER);
        expect(out).toEqual({ a: [msg('m1')], b: [msg('m2')] });
        expect(mem.has(dmKey(USER, 'a'))).toBe(true);
        expect(mem.has(`cipherline_msgs_${USER}`)).toBe(false);
    });

    it('is idempotent — a second load after migration is a no-op', async () => {
        mem.set(`cipherline_msgs_${USER}`, JSON.stringify({ a: [msg('m1')] }));
        await messageStore.loadAll('dm', USER);
        expect(await messageStore.loadAll('dm', USER)).toEqual({ a: [msg('m1')] });
    });

    it('never lets a half-finished earlier migration clobber newer per-thread data', async () => {
        // Crash-resume shape: `a` already migrated AND has since moved on,
        // while the legacy record still holds its original, older copy.
        mem.set(`cipherline_msgs_${USER}`, JSON.stringify({ a: [msg('old')], b: [msg('m2')] }));
        mem.set(dmKey(USER, 'a'), JSON.stringify([msg('newer')]));
        const out = await messageStore.loadAll('dm', USER);
        expect(out.a).toEqual([msg('newer')]);   // not rolled back to 'old'
        expect(out.b).toEqual([msg('m2')]);      // still migrated
    });

    it('leaves an unreadable legacy record in place rather than deleting it', async () => {
        mem.set(`cipherline_msgs_${USER}`, '{ this is not json');
        const out = await messageStore.loadAll('dm', USER);
        expect(out).toEqual({});
        expect(mem.has(`cipherline_msgs_${USER}`)).toBe(true);
    });

    it('drops only the corrupt thread, not every conversation', async () => {
        messageStore.saveAll('dm', USER, { good: [msg('m1')] });
        mem.set(dmKey(USER, 'bad'), 'not json either');
        messageStore._resetForTest();
        const out = await messageStore.loadAll('dm', USER);
        expect(out.good).toEqual([msg('m1')]);
        expect(out.bad).toBeUndefined();
    });
});

describe('messageStore — backup/restore vault path', () => {
    it('a full export→import round-trip preserves every conversation', async () => {
        const original = { a: [msg('m1'), msg('m2')], b: [msg('m3')], c: [] };
        messageStore.saveAll('dm', USER, original);

        // export reads exactly what a backup would serialise
        const exported = await messageStore.loadAll('dm', USER);
        expect(exported).toEqual(original);

        // wipe the device, then restore from that vault
        messageStore.clearAll('dm', USER);
        expect(await messageStore.loadAll('dm', USER)).toEqual({});

        messageStore.replaceAll('dm', USER, exported);
        expect(await messageStore.loadAll('dm', USER)).toEqual(original);
    });

    it('restore REPLACES — a thread absent from the vault must not survive underneath it', async () => {
        messageStore.saveAll('dm', USER, { keep: [msg('old')], stale: [msg('gone')] });
        messageStore.replaceAll('dm', USER, { keep: [msg('new')] });
        const out = await messageStore.loadAll('dm', USER);
        expect(out).toEqual({ keep: [msg('new')] });
        expect(out.stale).toBeUndefined();
    });

    it('restoring does not disturb the OTHER account on the device', async () => {
        messageStore.saveAll('dm', OTHER, { a: [msg('theirs')] });
        messageStore.replaceAll('dm', USER, { a: [msg('restored')] });
        expect(await messageStore.loadAll('dm', OTHER)).toEqual({ a: [msg('theirs')] });
    });

    it('clearAll removes per-thread records AND any legacy record', async () => {
        mem.set(`cipherline_msgs_${USER}`, JSON.stringify({ z: [msg('legacy')] }));
        messageStore.saveAll('dm', USER, { a: [msg('m1')] });
        messageStore.clearAll('dm', USER);
        expect(mem.has(`cipherline_msgs_${USER}`)).toBe(false);
        expect(mem.has(dmKey(USER, 'a'))).toBe(false);
    });
});

describe('messageStore.hasAny — gates the destructive history sync', () => {
    it('is false only when the device genuinely has nothing', async () => {
        expect(await messageStore.hasAny('dm', USER)).toBe(false);
    });

    it('is true for per-thread history', async () => {
        messageStore.saveAll('dm', USER, { a: [msg('m1')] });
        expect(await messageStore.hasAny('dm', USER)).toBe(true);
    });

    it('is true for not-yet-migrated legacy history — the data-loss case', async () => {
        // A false negative here offers to pull history from another device onto
        // a device that already has it, overwriting the local copy.
        mem.set(`cipherline_msgs_${USER}`, JSON.stringify({ a: [msg('m1')] }));
        expect(await messageStore.hasAny('dm', USER)).toBe(true);
    });

    it('does not confuse another account\'s history for this one\'s', async () => {
        messageStore.saveAll('dm', OTHER, { a: [msg('theirs')] });
        expect(await messageStore.hasAny('dm', USER)).toBe(false);
    });

    /**
     * "Not readable" and "empty" are different answers and only ONE of them may
     * unlock a restore. The store's namespace is cold for the whole window
     * between an in-session sign-in and the account rebind landing, and
     * `hydrateMessages()` does NOT cover that window (it is latched true across
     * the switch) — so without an explicit readiness gate `hasAny` answered
     * `false` for an account whose history was sitting on disk.
     */
    it('REFUSES to answer rather than reporting false from a cold namespace', async () => {
        messageStore.saveAll('dm', USER, { a: [msg('m1')] });
        setReady(null);                                   // the sign-in click; rebind still in flight
        await expect(messageStore.hasAny('dm', USER)).rejects.toThrow(messageStore.HistoryNotReadableError);
        setReady(USER);                                   // rebind lands
        expect(await messageStore.hasAny('dm', USER)).toBe(true);
    });

    it('still answers false for a genuinely empty account once it IS readable', async () => {
        setReady(USER);
        expect(await messageStore.hasAny('dm', USER)).toBe(false);
        expect(await messageStore.hasAny('channel', USER)).toBe(false);
    });

    it('loadAll refuses too — an empty map here would back up as an empty vault', async () => {
        messageStore.saveAll('dm', USER, { a: [msg('m1')] });
        setReady(null);
        await expect(messageStore.loadAll('dm', USER)).rejects.toThrow(messageStore.HistoryNotReadableError);
    });

    it('removeThread refuses too — a blind removeItem writes a tombstone', async () => {
        messageStore.saveAll('dm', USER, { a: [msg('m1')] });
        setReady(null);
        await expect(messageStore.removeThread('dm', USER, 'a')).rejects.toThrow(messageStore.HistoryNotReadableError);
        expect(mem.has(dmKey(USER, 'a'))).toBe(true);
    });
});

/**
 * Startup-hang regression (owner report: "opened the app … went to not
 * responding for a while, then came back. This happens most when I have a pin
 * lock").
 *
 * Both of these loops run in the Dashboard's mount effect, just after first
 * paint — which is exactly when the Screen Lock overlay is the focused UI and
 * is taking the user's PIN keystrokes. Walking every conversation in one
 * unyielded pass made that a single multi-second task, and input delivered to
 * a thread that doesn't service it is precisely what Windows reports as
 * "(Not Responding)".
 *
 * These tests assert the loops actually hand the thread back, by racing them
 * against a macrotask queued at the same time.
 */
describe('messageStore — yields the main thread on large accounts', () => {
    /** Flips only on a macrotask, i.e. only if the loop under test yielded. */
    function macrotaskFlag() {
        const state = { ran: false };
        setTimeout(() => { state.ran = true; }, 0);
        return state;
    }

    it('loadAll yields while parsing many threads', async () => {
        const map: messageStore.ThreadMap = {};
        for (let i = 0; i < 40; i++) map[`c${i}`] = [msg(`m${i}`)];
        messageStore.saveAll('dm', USER, map);
        messageStore._resetForTest();

        const flag = macrotaskFlag();
        const loaded = await messageStore.loadAll('dm', USER);

        expect(flag.ran).toBe(true);                  // the loop gave the thread back
        expect(Object.keys(loaded)).toHaveLength(40); // ...without losing anything
    });

    it('loadAll does NOT pay for a yield on a small account', async () => {
        messageStore.saveAll('dm', USER, { a: [msg('m1')], b: [msg('m2')] });
        messageStore._resetForTest();

        const flag = macrotaskFlag();
        await messageStore.loadAll('dm', USER);

        // Under YIELD_BATCH there is nothing to split up, so boot doesn't eat
        // an extra macrotask round-trip for a two-conversation account.
        expect(flag.ran).toBe(false);
    });

    it('legacy migration yields, and still migrates every thread exactly once', async () => {
        const legacy: messageStore.ThreadMap = {};
        for (let i = 0; i < 40; i++) legacy[`c${i}`] = [msg(`m${i}`)];
        mem.set(`cipherline_msgs_${USER}`, JSON.stringify(legacy));

        const flag = macrotaskFlag();
        const loaded = await messageStore.loadAll('dm', USER);

        expect(flag.ran).toBe(true);
        expect(Object.keys(loaded)).toHaveLength(40);
        // Legacy record is still tombstoned only after the whole loop.
        expect(mem.has(`cipherline_msgs_${USER}`)).toBe(false);
        for (let i = 0; i < 40; i++) expect(mem.has(dmKey(USER, `c${i}`))).toBe(true);
    });

    it('a message persisted DURING the load survives it', async () => {
        // The window the yields opened: loadAll parses thread c0, yields, and
        // a live message lands for c0 before the loop finishes. The snapshot
        // loadAll returns goes straight into React state and is what the next
        // saveAll writes back — so a stale snapshot here loses a message whose
        // only copy is local (the server drops the envelope once it's ACKed).
        const map: messageStore.ThreadMap = {};
        for (let i = 0; i < 40; i++) map[`c${i}`] = [msg(`m${i}`)];
        messageStore.saveAll('dm', USER, map);
        messageStore._resetForTest();

        // Land the write on the first macrotask, i.e. inside loadAll's first yield.
        const arrived = [msg('m0'), msg('LIVE')];
        setTimeout(() => messageStore.saveAll('dm', USER, { ...map, c0: arrived }), 0);

        const loaded = await messageStore.loadAll('dm', USER);

        expect(loaded.c0).toEqual(arrived);            // newer write wins
        expect(loaded.c0.map((m) => (m as { id: string }).id)).toContain('LIVE');
        expect(Object.keys(loaded)).toHaveLength(40);  // everything else intact
    });

    it('a thread deleted DURING the load does not come back', async () => {
        const map: messageStore.ThreadMap = {};
        for (let i = 0; i < 40; i++) map[`c${i}`] = [msg(`m${i}`)];
        messageStore.saveAll('dm', USER, map);
        messageStore._resetForTest();

        setTimeout(() => { void messageStore.removeThread('dm', USER, 'c0'); }, 0);

        const loaded = await messageStore.loadAll('dm', USER);

        expect(loaded.c0).toBeUndefined();
        expect(Object.keys(loaded)).toHaveLength(39);
    });

    it('concurrent loadAll calls share ONE migration rather than both walking the blob', async () => {
        const legacy: messageStore.ThreadMap = {};
        for (let i = 0; i < 40; i++) legacy[`c${i}`] = [msg(`m${i}`)];
        mem.set(`cipherline_msgs_${USER}`, JSON.stringify(legacy));

        // Yielding opened a re-entrancy window the old synchronous migration
        // did not have; both callers must still see a complete map.
        const [a, b] = await Promise.all([
            messageStore.loadAll('dm', USER),
            messageStore.loadAll('dm', USER),
        ]);

        expect(Object.keys(a)).toHaveLength(40);
        expect(Object.keys(b)).toHaveLength(40);
        expect(mem.has(`cipherline_msgs_${USER}`)).toBe(false);
    });
});
