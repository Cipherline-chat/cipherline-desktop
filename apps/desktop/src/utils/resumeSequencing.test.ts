import { describe, it, expect } from 'vitest';
import { createPullGate, createWakeResync, runPaced } from './resumeSequencing';

describe('createWakeResync - resume work waits for connectivity', () => {
    it('offline at wake: the resync is deferred until ready() resolves, then runs exactly once', async () => {
        let release!: (v: boolean) => void;
        const ready = () => new Promise<boolean>(r => { release = r; });
        const calls: unknown[][] = [];
        const wake = createWakeResync({ ready, run: async (...a: unknown[]) => { calls.push(a); } });

        const p = wake({ checkCallStaleness: true });
        await Promise.resolve(); await Promise.resolve();
        expect(calls).toEqual([]);                    // nothing fired into the dead network
        release(true);                                // Wi-Fi is back
        await p;
        expect(calls).toEqual([[{ checkCallStaleness: true }]]);
    });

    it('connectivity never returns: the resync is skipped, not forced (the WS reconnect runs it)', async () => {
        let ran = false;
        const wake = createWakeResync({ ready: async () => false, run: async () => { ran = true; } });
        await wake();
        expect(ran).toBe(false);
    });

    it('never rejects: a failing run is reported, not leaked (no unhandled rejection)', async () => {
        const errors: unknown[] = [];
        const wake = createWakeResync({ ready: async () => true, run: async () => { throw new Error('x'); }, onError: e => errors.push(e) });
        await expect(wake()).resolves.toBeUndefined();
        expect(errors).toHaveLength(1);
        // and a throwing ready() / onError() cannot leak either
        const wake2 = createWakeResync({ ready: async () => { throw new Error('r'); }, run: async () => {}, onError: () => { throw new Error('e'); } });
        await expect(wake2()).resolves.toBeUndefined();
    });

    it('negative control: ready() is strictly consulted before run()', async () => {
        const order: string[] = [];
        const run = async () => { order.push('run'); };
        const wake = createWakeResync({ ready: async () => { order.push('ready'); return true; }, run });
        await wake();
        expect(order).toEqual(['ready', 'run']);
    });
});

describe('createPullGate - the pull is skipped offline and caught up online', () => {
    function gate(opts: { fallbackMs?: number } = {}) {
        let online = true; let t = 1_000;
        let pulls = 0;
        const g = createPullGate({ isOnline: () => online, pull: async () => { pulls++; }, now: () => t, ...opts });
        return { g, set: (v: boolean) => { online = v; }, advance: (ms: number) => { t += ms; }, get pulls() { return pulls; } };
    }

    it('online: every request pulls', async () => {
        const h = gate();
        await h.g.request(); await h.g.request();
        expect(h.pulls).toBe(2);
        expect(h.g.owed).toBe(false);
    });

    it('offline: the pull is skipped (no request into a dead network) and remembered', async () => {
        const h = gate();
        h.set(false);
        await h.g.request(); await h.g.request(); await h.g.request();
        expect(h.pulls).toBe(0);
        expect(h.g.owed).toBe(true);
    });

    it('back online: the owed pull runs immediately, once (no gap until the next 5 s tick)', async () => {
        const h = gate();
        h.set(false);
        await h.g.request();
        h.set(true);
        await h.g.onOnline();
        expect(h.pulls).toBe(1);
        expect(h.g.owed).toBe(false);
        await h.g.onOnline();                          // nothing owed -> no duplicate
        expect(h.pulls).toBe(1);
    });

    it('online event while nothing was skipped does not pull; a false online event does not pull either', async () => {
        const h = gate();
        await h.g.onOnline();
        expect(h.pulls).toBe(0);
        h.set(false);
        await h.g.request();
        await h.g.onOnline();                          // flag still says offline
        expect(h.pulls).toBe(0);
        expect(h.g.owed).toBe(true);
    });

    it('a wrong navigator.onLine flag cannot stop delivery for good: one fallback attempt per 30 s', async () => {
        const h = gate();
        h.set(false);
        await h.g.request();                           // first offline request: skipped
        h.advance(29_000); await h.g.request();        // still inside the window
        expect(h.pulls).toBe(0);
        h.advance(2_000); await h.g.request();         // 31 s into the spell: fallback attempt
        expect(h.pulls).toBe(1);
        h.advance(5_000); await h.g.request();         // window restarted
        expect(h.pulls).toBe(1);
    });

    it('negative control: an ungated pull fires on every offline request', async () => {
        let pulls = 0;
        const ungated = async () => { pulls++; };
        await ungated(); await ungated();
        expect(pulls).toBe(2);                         // the gate above kept this at 0
    });
});

describe('runPaced - rehydrate loads yield between steps', () => {
    it('runs steps strictly one after another with a yield after each', async () => {
        const log: string[] = [];
        const step = (n: string) => async () => { log.push(`start ${n}`); await Promise.resolve(); log.push(`end ${n}`); };
        await runPaced([step('a'), step('b'), step('c')], async () => { log.push('yield'); });
        expect(log).toEqual(['start a', 'end a', 'yield', 'start b', 'end b', 'yield', 'start c', 'end c', 'yield']);
    });

    it('a failing (or synchronously throwing) step does not stop the rest', async () => {
        const ran: string[] = [];
        await runPaced([
            async () => { throw new Error('a'); },
            () => { throw new Error('b'); },
            async () => { ran.push('c'); },
        ], async () => {});
        expect(ran).toEqual(['c']);
    });

    it('yields to the REAL event loop: a timer queued before the run gets to fire between steps', async () => {
        const order: string[] = [];
        setTimeout(() => order.push('timer'), 0);
        await runPaced([async () => { order.push('step1'); }, async () => { order.push('step2'); }],
            () => new Promise<void>(r => setTimeout(r, 0)));
        expect(order).toEqual(['step1', 'timer', 'step2']);
    });

    it('negative control: concurrent starts (the old Promise.allSettled shape) interleave with no yield', async () => {
        const log: string[] = [];
        const step = (n: string) => async () => { log.push(`start ${n}`); await Promise.resolve(); log.push(`end ${n}`); };
        await Promise.allSettled([step('a')(), step('b')(), step('c')()]);
        expect(log.slice(0, 3)).toEqual(['start a', 'start b', 'start c']);   // all started before any finished
    });
});
