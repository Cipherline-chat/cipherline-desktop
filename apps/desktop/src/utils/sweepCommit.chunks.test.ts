import { describe, it, expect } from 'vitest';
import { removeInChunks } from './sweepCommit';

describe('removeInChunks - expired-attachment deletes no longer start all at once', () => {
    it('deletes every id, in chunks, yielding between chunks (not after the last)', async () => {
        const ids = Array.from({ length: 60 }, (_, i) => `a${i}`);
        let inFlight = 0; let peak = 0; let yields = 0;
        const removed: string[] = [];
        const n = await removeInChunks(ids, async (id) => {
            inFlight++; peak = Math.max(peak, inFlight);
            await Promise.resolve();
            removed.push(id); inFlight--;
        }, 25, async () => { yields++; });
        expect(n).toBe(60);
        expect(removed).toHaveLength(60);
        expect(peak).toBe(25);          // old shape: peak === 60 (one burst)
        expect(yields).toBe(2);         // 25 | 25 | 10 -> two yields
    });

    it('a failing or synchronously throwing delete does not stop the rest', async () => {
        const removed: string[] = [];
        await removeInChunks(['a', 'b', 'c'], (id) => {
            if (id === 'a') throw new Error('sync');
            if (id === 'b') return Promise.reject(new Error('async'));
            removed.push(id); return Promise.resolve();
        }, 2, async () => {});
        expect(removed).toEqual(['c']);
    });

    it('empty list is a no-op', async () => {
        let yields = 0;
        expect(await removeInChunks([], async () => {}, 25, async () => { yields++; })).toBe(0);
        expect(yields).toBe(0);
    });

    it('negative control: the old Promise.allSettled(map) shape has all deletes in flight at once', async () => {
        let inFlight = 0; let peak = 0;
        const del = async () => { inFlight++; peak = Math.max(peak, inFlight); await Promise.resolve(); inFlight--; };
        await Promise.allSettled(Array.from({ length: 60 }, () => del()));
        expect(peak).toBe(60);
    });
});
