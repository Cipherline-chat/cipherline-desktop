import { describe, it, expect, beforeEach, vi } from 'vitest';
import axios from 'axios';
import { __resetNetworkReadyForTests, ensureNetworkReady, networkBackoffMs, probeApiReachable, whenNetworkReady } from './networkReady';

// The setup's bare `window` stub makes the real axios die on import.
vi.mock('axios', () => ({ default: { get: vi.fn() } }));

/** A manual clock + timers so the backoff schedule is asserted, not slept. */
function harness() {
    let t = 0;
    const timers: Array<{ at: number; cb: () => void; handle: number }> = [];
    let n = 0;
    const online = new Set<() => void>();
    const h = {
        online: true,
        probeResults: [] as boolean[],
        probeCalls: 0,
        naps: [] as number[],
        opts: {
            now: () => t,
            setTimer: (cb: () => void, ms: number) => { const handle = ++n; timers.push({ at: t + ms, cb, handle }); h.naps.push(ms); return handle; },
            clearTimer: (handle: unknown) => { const i = timers.findIndex(x => x.handle === handle); if (i >= 0) timers.splice(i, 1); },
            isOnline: () => h.online,
            onOnline: (cb: () => void) => { online.add(cb); return () => { online.delete(cb); }; },
            probe: async () => { h.probeCalls++; return h.probeResults.length ? h.probeResults.shift()! : true; },
        },
        /** Advance the clock to the earliest timer and fire it. */
        async tick() {
            for (let i = 0; i < 5; i++) await Promise.resolve();
            timers.sort((a, b) => a.at - b.at);
            const next = timers.shift();
            if (!next) return false;
            t = next.at; next.cb();
            for (let i = 0; i < 5; i++) await Promise.resolve();
            return true;
        },
        fireOnline() { h.online = true; for (const cb of [...online]) cb(); },
        get pendingTimers() { return timers.length; },
    };
    return h;
}

beforeEach(() => { __resetNetworkReadyForTests(); });

describe('whenNetworkReady', () => {
    it('resolves true at once when online and the probe answers (the common path)', async () => {
        const h = harness();
        expect(await whenNetworkReady(h.opts)).toBe(true);
        expect(h.probeCalls).toBe(1);
        expect(h.naps).toEqual([]);
    });

    it('while offline it does NOT probe or run; it waits and resolves when the online event fires', async () => {
        const h = harness();
        h.online = false;
        let resolved: boolean | null = null;
        const p = whenNetworkReady(h.opts).then(v => { resolved = v; return v; });
        for (let i = 0; i < 5; i++) await Promise.resolve();
        expect(resolved).toBeNull();
        expect(h.probeCalls).toBe(0);               // never fires a request into a dead network
        h.fireOnline();                              // Wi-Fi is back
        expect(await p).toBe(true);
        expect(h.probeCalls).toBe(1);
        expect(h.pendingTimers).toBe(0);             // the nap timer was cleaned up
    });

    it('online but the API is not reachable yet: backs off 500, 1000, 2000... and succeeds on the first answer', async () => {
        const h = harness();
        h.probeResults = [false, false, false, true];
        const p = whenNetworkReady(h.opts);
        for (let i = 0; i < 3; i++) await h.tick();
        expect(await p).toBe(true);
        expect(h.naps).toEqual([500, 1000, 2000]);
        expect(h.probeCalls).toBe(4);
    });

    it('a probe that throws is treated as not-yet, not as a rejection', async () => {
        const h = harness();
        let first = true;
        h.opts.probe = async () => { h.probeCalls++; if (first) { first = false; throw new Error('boom'); } return true; };
        const p = whenNetworkReady(h.opts);
        await h.tick();
        await expect(p).resolves.toBe(true);
    });

    it('gives up (false) after maxWaitMs and never rejects', async () => {
        const h = harness();
        h.online = false;
        const p = whenNetworkReady({ ...h.opts, maxWaitMs: 3_000 });
        while (await h.tick()) { /* run the clock out */ }
        await expect(p).resolves.toBe(false);
        expect(h.probeCalls).toBe(0);
    });

    it('aborts promptly via the signal', async () => {
        const h = harness();
        h.online = false;
        const ac = new AbortController();
        const p = whenNetworkReady({ ...h.opts, signal: ac.signal });
        for (let i = 0; i < 5; i++) await Promise.resolve();
        ac.abort();
        await expect(p).resolves.toBe(false);
    });

    it('negative control: the work behind the gate does not run while offline', async () => {
        const h = harness();
        h.online = false;
        let ran = false;
        void whenNetworkReady(h.opts).then(() => { ran = true; });
        for (let i = 0; i < 5; i++) await Promise.resolve();
        expect(ran).toBe(false);
        h.fireOnline();
        for (let i = 0; i < 5; i++) await Promise.resolve();
        expect(ran).toBe(true);                      // ...and does the moment it is back
    });
});

describe('ensureNetworkReady coalesces a wake burst onto one wait', () => {
    it('three callers share one probe loop', async () => {
        const h = harness();
        h.probeResults = [false, true];
        const a = ensureNetworkReady(h.opts);
        const b = ensureNetworkReady(h.opts);
        const c = ensureNetworkReady(h.opts);
        expect(b).toBe(a); expect(c).toBe(a);
        await h.tick();
        expect(await a).toBe(true);
        expect(h.probeCalls).toBe(2);                // not 6
    });

    it('a later burst starts a fresh wait', async () => {
        const h = harness();
        await ensureNetworkReady(h.opts);
        await ensureNetworkReady(h.opts);
        expect(h.probeCalls).toBe(2);
    });
});

describe('networkBackoffMs', () => {
    it('doubles and caps', () => {
        expect([0, 1, 2, 3, 4, 5, 9].map(n => networkBackoffMs(n))).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
    });
});

describe('probeApiReachable', () => {
    it('treats ANY http answer (even 503) as reachable and a transport failure as not', async () => {
        const get = axios.get as unknown as ReturnType<typeof vi.fn>;
        get.mockReset();
        get.mockResolvedValueOnce({ status: 503 });
        expect(await probeApiReachable()).toBe(true);
        get.mockRejectedValueOnce(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }));
        expect(await probeApiReachable()).toBe(false);
        // The request opts into every status being a success and uses a short timeout.
        const cfg = get.mock.calls[0][1];
        expect(cfg.validateStatus(503)).toBe(true);
        expect(cfg.timeout).toBeLessThanOrEqual(5000);
        expect(String(get.mock.calls[0][0])).toMatch(/\/health\/live$/);
    });
});
