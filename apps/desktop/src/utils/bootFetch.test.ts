import { describe, it, expect, vi, beforeEach } from 'vitest';

const { calls } = vi.hoisted(() => ({ calls: [] as Array<{ url: string; auth: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }> }));
vi.mock('axios', () => ({
    default: {
        get: (url: string, cfg: { headers: { Authorization: string } }) => new Promise((resolve, reject) => { calls.push({ url, auth: cfg.headers.Authorization, resolve, reject }); }),
    },
}));
vi.mock('../constants', () => ({ API_BASE: 'https://api.test/v1' }));

import { startBootFetches, takeBootFetch, __resetBootFetches, BOOT_FETCH_MAX_AGE_MS } from './bootFetch';

describe('bootFetch (core loads start at session restore)', () => {
    beforeEach(() => { calls.length = 0; __resetBootFetches(); });

    it('starts all three once per token, and the first call takes the request in flight', async () => {
        startBootFetches('t1', () => 1000);
        startBootFetches('t1', () => 1000);
        expect(calls.map(c => c.url)).toEqual(['https://api.test/v1/conversations', 'https://api.test/v1/friends', 'https://api.test/v1/servers']);
        expect(calls.every(c => c.auth === 'Bearer t1')).toBe(true);
        const fallback = vi.fn(async () => ({ data: 'fallback' }) as never);
        const p = takeBootFetch('conversations', 't1', fallback, () => 1500);
        calls[0].resolve({ data: 'boot' });
        expect((await p as { data: string }).data).toBe('boot');
        expect(fallback).not.toHaveBeenCalled();
        // One use: the next call fetches normally.
        await takeBootFetch('conversations', 't1', fallback, () => 1600);
        expect(fallback).toHaveBeenCalledTimes(1);
    });

    it('never reuses another token, a stale request, or a failed one', async () => {
        startBootFetches('t1', () => 0);
        const fb = () => Promise.resolve({ data: 'fresh' } as never);
        expect((await takeBootFetch('friends', 't2', fb, () => 10) as { data: string }).data).toBe('fresh');
        expect((await takeBootFetch('servers', 't1', fb, () => BOOT_FETCH_MAX_AGE_MS + 1) as { data: string }).data).toBe('fresh');
        const p = takeBootFetch('conversations', 't1', fb, () => 10);
        calls[0].reject(new Error('net'));
        expect((await p as { data: string }).data).toBe('fresh');
    });

    it('no token: nothing starts', () => {
        startBootFetches(null);
        expect(calls).toHaveLength(0);
    });
});
