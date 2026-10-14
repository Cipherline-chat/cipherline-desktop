import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerStorageStatus } from '@cipherline/shared';
import {
    createServerStorageStatusStore,
    SERVER_STORAGE_STATUS_WINDOW_EVENT,
    StorageStatusHttpError,
    storageStatusPushServerId,
    STATUS_FAILURE_BACKOFF_MS,
} from './serverStorageStatusStore';

const st = (server_id: string, state: ServerStorageStatus['state'] = 'grace'): ServerStorageStatus => ({
    server_id, audience: 'owner', state, usage_bytes: 1, limit_bytes: 1, target_bytes: 1,
    pro_ends_at: null, grace_started_at: null, grace_deadline: null, days_left: 9, transfer: null,
    prune_summary: null, resolved_reason: null, resolved_at: null, pruned_at: null,
    notice_id: state === 'ok' ? null : `${state}:x`, dismissible: false,
});

/** A controllable clock + sleep, so pacing is tested without real waiting. */
function clock() {
    let t = 1_000_000;
    const sleeps: number[] = [];
    return {
        now: () => t,
        advance: (ms: number) => { t += ms; },
        sleeps,
        sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    };
}
const flush = () => new Promise(r => setTimeout(r, 0));

describe('serverStorageStatusStore', () => {
    it('caches a fresh result and shares an in-flight request', async () => {
        const c = clock();
        const fetcher = vi.fn(async (id: string) => st(id));
        const store = createServerStorageStatusStore({ fetcher, now: c.now, sleep: c.sleep });
        const [a, b] = await Promise.all([store.ensure('s1', 't'), store.ensure('s1', 't')]);
        expect(a).toEqual(b);
        expect(fetcher).toHaveBeenCalledTimes(1);
        await store.ensure('s1', 't');
        expect(fetcher).toHaveBeenCalledTimes(1);
        c.advance(6 * 60_000);
        await store.ensure('s1', 't');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('paces requests to at most 8 per 10 s (the API allows 10)', async () => {
        vi.useFakeTimers();
        try {
            const starts: number[] = [];
            const fetcher = vi.fn(async (id: string) => { starts.push(Date.now()); return st(id); });
            // Real defaults (Date.now + setTimeout), driven by fake timers.
            const store = createServerStorageStatusStore({ fetcher });
            const all = Promise.all(Array.from({ length: 20 }, (_, i) => store.ensure(`s${i}`, 't')));
            await vi.advanceTimersByTimeAsync(0);
            expect(fetcher).toHaveBeenCalledTimes(8);
            await vi.advanceTimersByTimeAsync(9_999);
            expect(fetcher).toHaveBeenCalledTimes(8);
            await vi.advanceTimersByTimeAsync(1);
            expect(fetcher).toHaveBeenCalledTimes(16);
            await vi.advanceTimersByTimeAsync(10_000);
            await all;
            expect(fetcher).toHaveBeenCalledTimes(20);
            // Any 10-second window holds at most 8 request starts.
            for (const s of starts) {
                expect(starts.filter(x => x >= s && x < s + 10_000).length).toBeLessThanOrEqual(8);
            }
        } finally {
            vi.useRealTimers();
        }
    });

    it('a push refetches ONLY the pushed server, and only while something shows it', async () => {
        const c = clock();
        const fetcher = vi.fn(async (id: string) => st(id));
        const store = createServerStorageStatusStore({ fetcher, now: c.now, sleep: c.sleep });
        await store.ensure('shown', 't');
        await store.ensure('hidden', 't');
        const listener = vi.fn();
        const off = store.subscribe('shown', listener);
        fetcher.mockClear();

        store.handlePush('shown', 't');
        await flush();
        expect(fetcher.mock.calls.map(x => x[0])).toEqual(['shown']);
        expect(listener).toHaveBeenCalled();

        // Not subscribed: marked stale, not fetched — the next ensure() refetches.
        store.handlePush('hidden', 't');
        await flush();
        expect(fetcher).toHaveBeenCalledTimes(1);
        await store.ensure('hidden', 't');
        expect(fetcher).toHaveBeenCalledTimes(2);

        off();
        store.handlePush('shown', 't');
        await flush();
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('a push that lands mid-fetch triggers one more fetch after it (the in-flight answer may be stale)', async () => {
        const c = clock();
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        let n = 0;
        const fetcher = vi.fn(async (id: string) => { n += 1; if (n === 1) await gate; return st(id, n === 1 ? 'grace' : 'resolved'); });
        const store = createServerStorageStatusStore({ fetcher, now: c.now, sleep: c.sleep });
        store.subscribe('s', () => {});
        const first = store.ensure('s', 't');
        await flush();
        store.handlePush('s', 't');
        release();
        await first;
        await flush(); await flush();
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(store.get('s')?.state).toBe('resolved');
    });

    it('403/404 clears; 429/network keeps the last status and backs off', async () => {
        const c = clock();
        const fetcher = vi.fn(async (id: string): Promise<ServerStorageStatus> => st(id));
        const store = createServerStorageStatusStore({ fetcher, now: c.now, sleep: c.sleep });
        await store.ensure('s', 't');
        expect(store.get('s')?.state).toBe('grace');

        fetcher.mockRejectedValueOnce(new StorageStatusHttpError(429));
        expect((await store.refresh('s', 't'))?.state).toBe('grace');
        expect(store.get('s')?.state).toBe('grace');
        // Backing off: an ensure() inside the window does not refetch.
        await store.ensure('s', 't');
        expect(fetcher).toHaveBeenCalledTimes(2);
        c.advance(STATUS_FAILURE_BACKOFF_MS + 1);
        await store.ensure('s', 't');
        expect(fetcher).toHaveBeenCalledTimes(3);

        fetcher.mockRejectedValueOnce(new StorageStatusHttpError(403));
        expect(await store.refresh('s', 't')).toBeNull();
        expect(store.get('s')).toBeNull();
    });

    it('reset() forgets everything and a late answer from before it is dropped', async () => {
        const c = clock();
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const fetcher = vi.fn(async (id: string) => { await gate; return st(id); });
        const store = createServerStorageStatusStore({ fetcher, now: c.now, sleep: c.sleep });
        const p = store.ensure('s', 't');
        store.reset();
        release();
        await p;
        expect(store.get('s')).toBeUndefined();
    });

    it('parses the push detail defensively', () => {
        expect(storageStatusPushServerId({ server_id: 'abc' })).toBe('abc');
        expect(storageStatusPushServerId({ server_id: '' })).toBeNull();
        expect(storageStatusPushServerId({ server_id: 5 })).toBeNull();
        expect(storageStatusPushServerId(null)).toBeNull();
    });
});

describe('useRealtime re-emits server:storage_status_changed with the exact window event name', () => {
    it('contains both the WS event and the window event literal', () => {
        const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'useRealtime.ts'), 'utf8');
        expect(src).toContain("msg.event === 'server:storage_status_changed'");
        expect(src).toContain(`'${SERVER_STORAGE_STATUS_WINDOW_EVENT}'`);
    });
});
