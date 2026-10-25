import { describe, it, expect, beforeEach } from 'vitest';
import { secureLocalStore } from './secureLocalStore';
import * as messageStore from './messageStore';
import { makeSliceYield, yieldMainThread } from './sweepCommit';

/**
 * Before/after for the retention sweep's COMMIT (beta diagnostics: a 1 s
 * `retention:sweep` freeze on 1.0.22-staging.166, after the SCAN was already
 * time-sliced). After a wake every thread whose window lapsed while the machine
 * slept is pruned at once; the old commit (`messageStore.saveAll`) stringified
 * and wrote them all in ONE task. The new one (`saveThreadsSliced` driven by the
 * sweep's own makeSliceYield(8 ms)) hands the thread back every ~8 ms.
 *
 * "Longest block" is the longest stretch the main thread was held without
 * returning to the event loop - the thing a user feels as a freeze. The numbers
 * are printed so they can be quoted; the assertions are structural (the sliced
 * commit yields, and its longest block is a fraction of the single-task cost)
 * rather than absolute milliseconds, so a loaded CI box cannot flake them.
 */
const USER = 'bench-user';

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

function pruned(threads: number, perThread: number): Array<readonly [string, unknown[]]> {
    return Array.from({ length: threads }, (_, t) => [`c${t}`, Array.from({ length: perThread }, (_, i) => ({
        id: `m-${t}-${i}-${'x'.repeat(16)}`,
        timestamp: new Date(1_790_000_000_000 - i * 60_000).toISOString(),
        sender_user_id: 'u1',
        content: i % 20 === 0 ? { type: 'attachment', attachment_id: `a-${t}-${i}`, name: 'photo.png' } : { type: 'text', text: 'hello there, this is a typical chat line' },
    }))] as const);
}

beforeEach(() => { installFakeStore(); messageStore._resetForTest(); });

describe('retention sweep commit - longest main-thread block, before vs after', () => {
    it.each([[100, 800], [300, 1500]] as const)('%i pruned threads x %i messages', async (threads, per) => {
        const entries = pruned(threads, per);

        // BEFORE: saveAll over the whole map, one task.
        messageStore._resetForTest();
        const map: Record<string, unknown[]> = Object.fromEntries(entries.map(([id, m]) => [id, m]));
        const t0 = performance.now();
        messageStore.saveAll('dm', USER, map);
        const before = performance.now() - t0;

        // AFTER: saveThreadsSliced + a real yield every 8 ms of work.
        messageStore._resetForTest();
        let blockStart = performance.now();
        let longest = 0;
        let yields = 0;
        const countingYield = async () => {
            longest = Math.max(longest, performance.now() - blockStart);
            yields++;
            await yieldMainThread();
            blockStart = performance.now();
        };
        const slice = makeSliceYield(8, () => performance.now(), countingYield);
        await messageStore.saveThreadsSliced('dm', USER, entries, { yieldIfDue: slice });
        longest = Math.max(longest, performance.now() - blockStart);

        console.log(`[sweep-commit bench] ${threads} threads x ${per} msgs: before = one ${before.toFixed(1)} ms task; after = longest block ${longest.toFixed(1)} ms over ${yields} yields`);
        expect(yields).toBeGreaterThan(1);
        // The sliced commit never holds the thread for anything near the old single task
        // (generous bound: one thread's stringify is the floor, plus scheduling slack).
        expect(longest).toBeLessThan(Math.max(before * 0.6, 25));
        // and it wrote everything
        expect((secureLocalStore as any).keysWithPrefix(`cipherline_msgs_${USER}_`)).toHaveLength(threads);
    }, 60_000);

    it('negative control: a slice budget that is never spent never yields, so the commit is one long block again', async () => {
        const entries = pruned(100, 800);
        let yields = 0;
        const slice = makeSliceYield(1e9, () => performance.now(), async () => { yields++; });
        const t0 = performance.now();
        await messageStore.saveThreadsSliced('dm', USER, entries, { yieldIfDue: slice });
        expect(yields).toBe(0);
        expect(performance.now() - t0).toBeGreaterThan(0);
    });
});
