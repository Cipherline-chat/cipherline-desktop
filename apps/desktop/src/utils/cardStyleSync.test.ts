import { describe, it, expect } from 'vitest';
import {
    MAX_STYLES_PAYLOAD_BYTES, STYLE_LIBRARY_MAX, TOMBSTONE_TTL_MS, buildLocalState, buildStylesPayload, emptyStyleMeta, mergeStyleStates,
    metaFromState, parseStyleMeta, parseStylesPayload, restampAll, sameStyleState, serializeStyleMeta, stampLocalEdit,
    type StyleSyncState, type SyncStyleItem,
} from './cardStyleSync';

const NOW = 1_800_000_000_000;
const B = NOW - 1_000_000; // recent enough that tombstones are not pruned
const st = (text = '#ffffff') => ({ v: 1 as const, text });
const item = (id: string, at: number, over: Partial<SyncStyleItem> = {}): SyncStyleItem =>
    ({ id, name: `n-${id}`, style: st(), created: over.created ?? at, at, ...over });
const S = (items: SyncStyleItem[], tombstones: Record<string, number> = {}): StyleSyncState => ({ items, tombstones });
const ids = (s: StyleSyncState) => s.items.map(i => i.id);

describe('mergeStyleStates', () => {
    it('is commutative and idempotent', () => {
        const a = S([item('x', B + 10), item('y', B + 20)], { z: B + 30 });
        const b = S([item('y', B + 25, { name: 'renamed' }), item('z', B + 5)], { x: B + 15 });
        const ab = mergeStyleStates(a, b, NOW), ba = mergeStyleStates(b, a, NOW);
        expect(sameStyleState(ab, ba)).toBe(true);
        expect(mergeStyleStates(ab, b, NOW)).toBe(ab);
        expect(mergeStyleStates(ab, a, NOW)).toBe(ab);
        expect(ids(ab)).toEqual(['y']);          // x deleted at 15 > 10; z deleted at 30 > 5
        expect(ab.items[0].name).toBe('renamed'); // newer edit of y wins
    });

    it('concurrent edit vs delete: the later of the two wins, in either order', () => {
        const base = item('a', B + 10);
        const editedAt20 = S([{ ...base, name: 'edited', at: B + 20 }]);
        const deletedAt30 = S([], { a: B + 30 });
        expect(ids(mergeStyleStates(editedAt20, deletedAt30, NOW))).toEqual([]);
        expect(ids(mergeStyleStates(deletedAt30, editedAt20, NOW))).toEqual([]);
        const deletedAt15 = S([], { a: B + 15 });
        expect(ids(mergeStyleStates(editedAt20, deletedAt15, NOW))).toEqual(['a']);
        expect(ids(mergeStyleStates(deletedAt15, editedAt20, NOW))).toEqual(['a']);
    });

    it('a delete is not resurrected by a stale device that still has the item', () => {
        const stale = S([item('a', B + 10)]);
        const deleter = S([], { a: B + 50 });
        const merged = mergeStyleStates(stale, deleter, NOW);
        expect(merged.items).toEqual([]);
        expect(merged.tombstones).toEqual({ a: B + 50 });
        // and again after a second sync from the stale side
        expect(mergeStyleStates(merged, stale, NOW)).toBe(merged);
    });

    it('exact tie: the item beats the tombstone; two items tie-break on canonical content (order independent)', () => {
        expect(ids(mergeStyleStates(S([item('a', 10)]), S([], { a: 10 }), NOW))).toEqual(['a']);
        expect(ids(mergeStyleStates(S([], { a: 10 }), S([item('a', 10)]), NOW))).toEqual(['a']);
        const p = item('a', 10, { name: 'alpha' }), q = item('a', 10, { name: 'beta' });
        expect(mergeStyleStates(S([p]), S([q]), NOW).items[0].name).toBe('alpha');
        expect(mergeStyleStates(S([q]), S([p]), NOW).items[0].name).toBe('alpha');
    });

    it('display order is created ascending, then id', () => {
        const m = mergeStyleStates(S([item('b', 5, { created: 2 })]), S([item('a', 7, { created: 2 }), item('c', 1, { created: 1 })]), NOW);
        expect(ids(m)).toEqual(['c', 'a', 'b']);
    });

    it('over the cap: keeps the 24 newest by created, drops the rest WITHOUT tombstones, same on both sides', () => {
        const mk = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => item(`${prefix}${i}`, 10, { created: 100 + i }));
        const a = S(mk('a', 20)), b = S(mk('b', 20));
        const ab = mergeStyleStates(a, b, NOW), ba = mergeStyleStates(b, a, NOW);
        expect(ab.items).toHaveLength(STYLE_LIBRARY_MAX);
        expect(sameStyleState(ab, ba)).toBe(true);
        expect(ab.tombstones).toEqual({});
        expect(Math.min(...ab.items.map(i => i.created))).toBe(100 + 20 - 12);
    });

    it('old tombstones are pruned; recent ones kept', () => {
        const m = mergeStyleStates(S([]), S([], { old: NOW - TOMBSTONE_TTL_MS - 1, fresh: NOW - 1000 }), NOW);
        expect(m.tombstones).toEqual({ fresh: NOW - 1000 });
    });

    it('a side that never heard of an id cannot outvote one that has', () => {
        const m = mergeStyleStates(S([item('a', 5)]), S([]), NOW);
        expect(ids(m)).toEqual(['a']);
    });
});

describe('local edit stamping', () => {
    it('create / edit / remove stamp, and a local edit beats a ledger entry from a faster clock', () => {
        let m = stampLocalEdit(emptyStyleMeta(), 'create', 'a', 1000);
        expect(m.stamps.a).toEqual({ created: 1000, at: 1000 });
        m = stampLocalEdit(m, 'edit', 'a', 1500);
        expect(m.stamps.a).toEqual({ created: 1000, at: 1500 });
        m = stampLocalEdit(m, 'edit', 'a', 1200); // clock behind: still strictly newer
        expect(m.stamps.a.at).toBe(1501);
        m = stampLocalEdit(m, 'remove', 'a', 100);
        expect(m.stamps.a).toBeUndefined();
        expect(m.tombstones.a).toBe(1502);
        m = stampLocalEdit(m, 'create', 'a', 5000); // re-created: tombstone cleared
        expect(m.tombstones.a).toBeUndefined();
    });

    it('a legacy unstamped library keeps its order, loses to any real edit, and drops a tombstone older than the item', () => {
        const lib = [{ id: 'b', name: 'B', style: st() }, { id: 'a', name: 'A', style: st() }];
        const s = buildLocalState(lib, emptyStyleMeta());
        expect(s.items.map(i => [i.id, i.at])).toEqual([['b', 1], ['a', 1]]);
        expect(mergeStyleStates(s, S([], { a: 2 }), NOW).items.map(i => i.id)).toEqual(['b']);
        const withTomb = buildLocalState(lib, { stamps: { a: { created: 5, at: 9 } }, tombstones: { a: 3 } });
        expect(ids(withTomb)).toEqual(['b', 'a']);
        expect(withTomb.tombstones).toEqual({});
    });

    it('restampAll makes a restore newer than anything the slot holds and clears tombstones of restored ids', () => {
        const r = restampAll(S([item('a', 10)], { a: 5, z: 7 }), NOW);
        expect(r.items[0].at).toBe(NOW);
        expect(r.tombstones).toEqual({ z: 7 });
    });

    it('meta round trips and a corrupt record reads as empty', () => {
        const m = metaFromState(S([item('a', 10, { created: 4 })], { z: 9 }));
        expect(parseStyleMeta(serializeStyleMeta(m), NOW)).toEqual(m);
        for (const bad of [null, '', '{', '[]', '{"v":2}', '{"v":1,"stamps":{"a":{"created":"x","at":1}}}']) {
            expect(parseStyleMeta(bad, NOW)).toEqual(emptyStyleMeta());
        }
    });
});

describe('parseStylesPayload (another device is not trusted)', () => {
    const good = (over: object = {}) => JSON.stringify({ v: 1, writtenAt: NOW, items: [{ id: 'a', name: ' Warm ', style: { v: 1, text: '#FFF' }, created: 5, at: 6 }], tombstones: { gone: 7 }, ...over });

    it('round trips build -> parse, normalising what it stores', () => {
        const s = S([item('a', 10, { name: 'Warm', created: 3 })], { gone: 4 });
        expect(parseStylesPayload(JSON.stringify(buildStylesPayload(s, NOW)), NOW)).toEqual(s);
        const p = parseStylesPayload(good(), NOW);
        expect(p.items[0]).toMatchObject({ id: 'a', name: 'Warm', style: { v: 1, text: '#ffffff' } });
    });

    it('rejects an unknown / higher version, non-JSON, a non-object, missing items, and oversize', () => {
        expect(() => parseStylesPayload(good({ v: 2 }), NOW)).toThrow(/version/);
        expect(() => parseStylesPayload(good({ v: undefined }), NOW)).toThrow();
        expect(() => parseStylesPayload('not json', NOW)).toThrow();
        expect(() => parseStylesPayload('[]', NOW)).toThrow();
        expect(() => parseStylesPayload(good({ items: 'x' }), NOW)).toThrow();
        expect(() => parseStylesPayload('x'.repeat(MAX_STYLES_PAYLOAD_BYTES + 1), NOW)).toThrow(/too large/);
    });

    it('drops bad items one by one and never turns a bad item into a tombstone', () => {
        const items = [
            { id: '../etc/passwd', name: 'x', style: st(), created: 1, at: 1 },
            { id: 'bad-style', name: 'x', style: 'nope', created: 1, at: 1 },
            { id: 'evil', name: 'x', style: { v: 1, text: 'url(javascript:alert(1))' }, created: 1, at: 1 },
            { id: 'noname', name: '   ', style: st(), created: 1, at: 1 },
            { id: 'future', name: 'x', style: st(), created: 1, at: NOW + 48 * 3600_000 },
            { id: 'neg', name: 'x', style: st(), created: -1, at: 1 },
            { id: 'nan', name: 'x', style: st(), created: 1, at: 'x' },
            { id: 'n'.repeat(65), name: 'x', style: st(), created: 1, at: 1 },
            null, 7, 'x',
            { id: 'ok', name: 'x'.repeat(100), style: st(), created: 1, at: 1 },
            { id: 'ok', name: 'dup', style: st(), created: 1, at: 1 },
        ];
        const p = parseStylesPayload(JSON.stringify({ v: 1, items, tombstones: {} }), NOW);
        expect(ids(p)).toEqual(['ok']);
        expect(p.items[0].name).toHaveLength(40);
        expect(p.tombstones).toEqual({});
    });

    it('reads at most 24 items and 200 tombstones, and one side per id (item if at least as new)', () => {
        const many = Array.from({ length: 60 }, (_, i) => ({ id: `i${i}`, name: 'x', style: st(), created: i, at: i + 1 }));
        const tombs = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`t${i}`, 1]));
        const p = parseStylesPayload(JSON.stringify({ v: 1, items: many, tombstones: { ...tombs, i0: 1, i1: 99 } }), NOW);
        expect(p.items.length).toBeLessThanOrEqual(STYLE_LIBRARY_MAX);
        expect(Object.keys(p.tombstones).length).toBeLessThanOrEqual(200);
        const q = parseStylesPayload(JSON.stringify({ v: 1, items: [{ id: 'k', name: 'x', style: st(), created: 1, at: 5 }], tombstones: { k: 5 } }), NOW);
        expect(ids(q)).toEqual(['k']);
        const r = parseStylesPayload(JSON.stringify({ v: 1, items: [{ id: 'k', name: 'x', style: st(), created: 1, at: 5 }], tombstones: { k: 6 } }), NOW);
        expect(ids(r)).toEqual([]);
        expect(r.tombstones).toEqual({ k: 6 });
    });
});
