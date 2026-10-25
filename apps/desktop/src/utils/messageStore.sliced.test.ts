import { describe, it, expect, beforeEach } from 'vitest';
import { secureLocalStore } from './secureLocalStore';
import * as messageStore from './messageStore';

/**
 * saveThreadsSliced is the retention sweep's commit: after a wake, every
 * thread whose window lapsed while the machine slept is pruned and written.
 * saveAll wrote them all in ONE task (a JSON.stringify each - the 1 s+
 * `retention:sweep` freeze); this writes them with a yield between threads.
 */

const USER = 'user-1';
const OTHER = 'user-2';

function installFakeStore() {
    const m = new Map<string, string>();
    const s = secureLocalStore as any;
    s.getItem = (k: string) => (m.has(k) ? m.get(k)! : null);
    s.setItem = (k: string, v: string) => { m.set(k, v); };
    s.removeItem = (k: string) => { m.delete(k); };
    s.keysWithPrefix = (p: string) => [...m.keys()].filter(k => k.startsWith(p));
    s.hydrateMessages = async () => {};
    s.whenAccountReady = async () => {};
    s.isAccountReady = () => true;
    return m;
}

let mem: Map<string, string>;
beforeEach(() => {
    mem = installFakeStore();
    messageStore._resetForTest();
});

const dmKey = (uid: string, cid: string) => `cipherline_msgs_${uid}_${cid}`;
const msg = (id: string) => ({ id, content: { type: 'text', text: id } });

describe('messageStore.saveThreadsSliced - the sweep commit yields between threads', () => {
    it('writes every named thread, yielding before each one (the long-task fix)', async () => {
        const yields: number[] = [];
        const entries = ['a', 'b', 'c'].map(id => [id, [msg(`${id}1`)]] as [string, any[]]);
        const res = await messageStore.saveThreadsSliced('dm', USER, entries, { yieldIfDue: async () => { yields.push(yields.length); } });
        expect(res).toEqual({ written: 3, skipped: 0 });
        expect(yields).toHaveLength(3);
        for (const [id] of entries) expect(mem.has(dmKey(USER, id))).toBe(true);
    });

    it('a thread that moved on while we yielded is SKIPPED, never overwritten with the stale pruned copy', async () => {
        const stale = [msg('old')];
        const fresh = [msg('old'), msg('arrived-during-yield')];
        const live: Record<string, ReturnType<typeof msg>[]> = { a: stale, b: [msg('b1')] };
        const res = await messageStore.saveThreadsSliced('dm', USER, [['a', stale], ['b', live.b]], {
            // the message lands (and the persist effect stores it) during the first yield
            yieldIfDue: async () => { if (live.a === stale) { live.a = fresh; messageStore.saveAll('dm', USER, { a: fresh }); } },
            isCurrent: (id, m) => live[id] === m,
        });
        expect(res).toEqual({ written: 1, skipped: 1 });
        expect(JSON.parse(mem.get(dmKey(USER, 'a'))!)).toEqual(fresh);     // the newer copy survives
        expect(mem.has(dmKey(USER, 'b'))).toBe(true);
    });

    it('negative control: without isCurrent the stale copy WOULD clobber the newer one', async () => {
        const stale = [msg('old')];
        const fresh = [msg('old'), msg('arrived-during-yield')];
        let moved = false;
        await messageStore.saveThreadsSliced('dm', USER, [['a', stale]], {
            yieldIfDue: async () => { if (!moved) { moved = true; messageStore.saveAll('dm', USER, { a: fresh }); } },
        });
        expect(JSON.parse(mem.get(dmKey(USER, 'a'))!)).toEqual(stale);      // the guard is what prevents this
    });

    it('never deletes (unlike saveAll): threads not named are left alone', async () => {
        messageStore.saveAll('dm', USER, { keep: [msg('k')], prune: [msg('p1'), msg('p2')] });
        await messageStore.saveThreadsSliced('dm', USER, [['prune', [msg('p2')]]]);
        expect(mem.has(dmKey(USER, 'keep'))).toBe(true);
        expect(JSON.parse(mem.get(dmKey(USER, 'prune'))!)).toEqual([msg('p2')]);
    });

    it('skips a referentially unchanged thread (no rewrite)', async () => {
        const t = [msg('x')];
        messageStore.saveAll('dm', USER, { a: t });
        const res = await messageStore.saveThreadsSliced('dm', USER, [['a', t]]);
        expect(res.written).toBe(0);
    });

    it("is account-scoped: another account's keys are untouched", async () => {
        messageStore.saveAll('dm', OTHER, { a: [msg('o')] });
        await messageStore.saveThreadsSliced('dm', USER, [['a', [msg('u')]]]);
        expect(JSON.parse(mem.get(dmKey(OTHER, 'a'))!)).toEqual([msg('o')]);
    });

    it('a failing write is contained and the rest still persist', async () => {
        const s = secureLocalStore as any;
        const orig = s.setItem;
        s.setItem = (k: string, v: string) => { if (k === dmKey(USER, 'bad')) throw new Error('quota'); orig(k, v); };
        const res = await messageStore.saveThreadsSliced('dm', USER, [['bad', [msg('b')]], ['good', [msg('g')]]]);
        expect(res.written).toBe(1);
        expect(mem.has(dmKey(USER, 'good'))).toBe(true);
    });
});
