import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _clearYouTubeMetaCache, loadYouTubeMeta, peekYouTubeMeta } from './youtubeMeta';

const ID = 'dQw4w9WgXcQ';

describe('youtubeMeta: best-effort, cached title lookup', () => {
    beforeEach(() => _clearYouTubeMetaCache());

    it('asks once per id; later calls and peeks come from the cache', async () => {
        const fetch = vi.fn(async () => ({ title: 'T', author: 'A' }));
        expect(peekYouTubeMeta(ID)).toBeUndefined();
        expect(await loadYouTubeMeta(ID, fetch)).toEqual({ title: 'T', author: 'A' });
        expect(await loadYouTubeMeta(ID, fetch)).toEqual({ title: 'T', author: 'A' });
        expect(peekYouTubeMeta(ID)).toEqual({ title: 'T', author: 'A' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('concurrent callers share one request', async () => {
        let resolve!: (v: { title: string; author: string }) => void;
        const fetch = vi.fn(() => new Promise<{ title: string; author: string }>((r) => { resolve = r; }));
        const a = loadYouTubeMeta(ID, fetch);
        const b = loadYouTubeMeta(ID, fetch);
        resolve({ title: 'T', author: '' });
        expect(await a).toEqual({ title: 'T', author: '' });
        expect(await b).toEqual({ title: 'T', author: '' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('fails silently to "no title", remembered for a while, then asked again', async () => {
        const fetch = vi.fn(async () => { throw new Error('offline'); });
        const t0 = Date.now();
        expect(await loadYouTubeMeta(ID, fetch, t0)).toBeNull();
        expect(peekYouTubeMeta(ID, t0 + 1000)).toBeNull();
        expect(await loadYouTubeMeta(ID, fetch, t0 + 1000)).toBeNull();
        expect(fetch).toHaveBeenCalledTimes(1);
        // Past the failure TTL the next view asks again.
        expect(peekYouTubeMeta(ID, t0 + 6 * 60_000)).toBeUndefined();
        await loadYouTubeMeta(ID, fetch, t0 + 6 * 60_000);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('a malformed answer is "no title"; no bridge means no request', async () => {
        expect(await loadYouTubeMeta(ID, async () => ({ title: '', author: 'x' }))).toBeNull();
        _clearYouTubeMetaCache();
        expect(await loadYouTubeMeta(ID, async () => ({ nope: 1 }) as never)).toBeNull();
        _clearYouTubeMetaCache();
        expect(await loadYouTubeMeta(ID, undefined)).toBeNull();
        expect(peekYouTubeMeta(ID)).toBeUndefined();
    });
});
