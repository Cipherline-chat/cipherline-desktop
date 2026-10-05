import { describe, it, expect, beforeEach, vi } from 'vitest';

// retentionTombstones only touches secureLocalStore.getItem/setItem — an
// in-memory Map stands in for the real (IndexedDB + WebCrypto) store, same
// pattern as keyVerification.test.ts.
const mem = new Map<string, string>();
vi.mock('./secureLocalStore', () => {
    const store = {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => { mem.set(k, v); },
    };
    return { default: store, secureLocalStore: store };
});

const { getPurgedMessageIds, markMessagesPurged } = await import('./retentionTombstones');

const U = 'user-1';
const C = 'channel-1';

beforeEach(() => mem.clear());

describe('retentionTombstones', () => {
    it('starts empty and round-trips ids', () => {
        expect(getPurgedMessageIds(U, C).size).toBe(0);
        markMessagesPurged(U, C, ['m1', 'm2']);
        expect([...getPurgedMessageIds(U, C)].sort()).toEqual(['m1', 'm2']);
    });

    it('accumulates across calls without losing earlier entries', () => {
        markMessagesPurged(U, C, ['m1']);
        markMessagesPurged(U, C, ['m2']);
        expect([...getPurgedMessageIds(U, C)].sort()).toEqual(['m1', 'm2']);
    });

    it('scopes by account AND channel', () => {
        markMessagesPurged(U, C, ['m1']);
        expect(getPurgedMessageIds(U, 'other-channel').size).toBe(0);
        expect(getPurgedMessageIds('other-user', C).size).toBe(0);
    });

    it('writes nothing when there is nothing new to record', () => {
        markMessagesPurged(U, C, ['m1']);
        const before = mem.get(`cipherline_retention_purged_${U}_${C}`);
        markMessagesPurged(U, C, []);
        markMessagesPurged(U, C, ['m1']);
        expect(mem.get(`cipherline_retention_purged_${U}_${C}`)).toBe(before);
    });

    it('ignores a missing userId or channelId rather than writing a junk key', () => {
        markMessagesPurged('', C, ['m1']);
        markMessagesPurged(U, '', ['m1']);
        expect(mem.size).toBe(0);
    });

    it('rolls the oldest entries off at the per-channel cap, keeping the newest', () => {
        // The cap is 1000; the tail is the least reachable history.
        const many = Array.from({ length: 1200 }, (_, i) => `m${i}`);
        markMessagesPurged(U, C, many);
        const set = getPurgedMessageIds(U, C);
        expect(set.size).toBe(1000);
        expect(set.has('m1199')).toBe(true);   // newest survive
        expect(set.has('m200')).toBe(true);    // exactly at the boundary
        expect(set.has('m199')).toBe(false);   // oldest rolled off
    });

    it('survives a corrupt or non-array stored value', () => {
        mem.set(`cipherline_retention_purged_${U}_${C}`, '{not json');
        expect(getPurgedMessageIds(U, C).size).toBe(0);
        mem.set(`cipherline_retention_purged_${U}_${C}`, '{"a":1}');
        expect(getPurgedMessageIds(U, C).size).toBe(0);
        // And a recovery write still works afterwards.
        markMessagesPurged(U, C, ['m1']);
        expect([...getPurgedMessageIds(U, C)]).toEqual(['m1']);
    });

    it('drops non-string entries from a tampered array', () => {
        mem.set(`cipherline_retention_purged_${U}_${C}`, JSON.stringify(['ok', 42, null, { x: 1 }]));
        expect([...getPurgedMessageIds(U, C)]).toEqual(['ok']);
    });
});
