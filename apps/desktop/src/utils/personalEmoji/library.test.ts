import { describe, it, expect } from 'vitest';
import {
    addEntry, diffLibraries, emptyLibrary, mergeLibraries, moveEntry, pruneTombstones, removeEntry,
    renameEntry, sanitizeLibrary, EMOJI_TOMBSTONE_TTL_MS, type EmojiLibState, type OpResult,
} from './library';
import { PERSONAL_EMOJI_LIBRARY_MAX } from './token';

const id = (n: number) => 'p_' + n.toString(16).padStart(32, '0');
const meta = (n: number, name = `e${n}x`) => ({ id: id(n), name, mime: 'image/webp', animated: false, size: 1000 });
const must = (r: OpResult): EmojiLibState => { if (!r.ok) throw new Error(r.error); return r.state; };
const names = (s: EmojiLibState) => [...s.entries].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)).map(e => e.name);

describe('local ops', () => {
    it('add appends in order, stamps at/addedAt, and is idempotent per id', () => {
        let s = must(addEntry(emptyLibrary(), meta(1, 'aa'), 100));
        s = must(addEntry(s, meta(2, 'bb'), 101));
        expect(names(s)).toEqual(['aa', 'bb']);
        expect(addEntry(s, meta(1, 'aa'), 999)).toMatchObject({ ok: true, state: s });
    });

    it('enforces the 100 cap, valid names and unique names', () => {
        let s = emptyLibrary();
        for (let i = 0; i < PERSONAL_EMOJI_LIBRARY_MAX; i++) s = must(addEntry(s, meta(i, `n${i}x`), i));
        expect(addEntry(s, meta(500, 'zzz'), 1)).toEqual({ ok: false, error: 'full' });
        const small = must(addEntry(emptyLibrary(), meta(1, 'aa'), 1));
        expect(addEntry(small, meta(2, 'aa'), 2)).toEqual({ ok: false, error: 'duplicate_name' });
        expect(addEntry(small, meta(2, 'A!'), 2)).toEqual({ ok: false, error: 'invalid_name' });
    });

    it('rename keeps order, rejects duplicates, bumps at', () => {
        let s = must(addEntry(emptyLibrary(), meta(1, 'aa'), 100));
        s = must(addEntry(s, meta(2, 'bb'), 101));
        expect(renameEntry(s, id(2), 'aa', 5)).toEqual({ ok: false, error: 'duplicate_name' });
        expect(renameEntry(s, id(9), 'cc', 5)).toEqual({ ok: false, error: 'not_found' });
        const r = must(renameEntry(s, id(2), 'cc', 5));
        expect(names(r)).toEqual(['aa', 'cc']);
        // clock behind the previous stamp still wins
        expect(r.entries.find(e => e.id === id(2))!.at).toBe(102);
    });

    it('move places an entry at the index, touching only that entry', () => {
        let s = emptyLibrary();
        for (let i = 1; i <= 4; i++) s = must(addEntry(s, meta(i, `n${i}x`), i));
        const m = must(moveEntry(s, id(4), 0, 50));
        expect(names(m)).toEqual(['n4x', 'n1x', 'n2x', 'n3x']);
        expect(names(must(moveEntry(m, id(4), 99, 60)))).toEqual(['n1x', 'n2x', 'n3x', 'n4x']);
        expect(names(must(moveEntry(m, id(1), 2, 70)))).toEqual(['n4x', 'n2x', 'n1x', 'n3x']);
        const untouched = m.entries.filter(e => e.id !== id(4)).every(e => s.entries.find(o => o.id === e.id)!.at === e.at);
        expect(untouched).toBe(true);
    });

    it('remove leaves a tombstone newer than the entry; re-add clears it', () => {
        let s = must(addEntry(emptyLibrary(), meta(1, 'aa'), 100));
        s = removeEntry(s, id(1), 50); // slow clock
        expect(s.entries).toHaveLength(0);
        expect(s.tombstones[id(1)]).toBe(101);
        const again = must(addEntry(s, meta(1, 'aa'), 60));
        expect(again.tombstones[id(1)]).toBeUndefined();
        expect(again.entries[0].at).toBeGreaterThan(101);
    });
});

describe('mergeLibraries', () => {
    const build = (ops: ((s: EmojiLibState) => EmojiLibState)[]) => ops.reduce((s, f) => f(s), emptyLibrary());
    const add = (n: number, name: string, t: number) => (s: EmojiLibState) => must(addEntry(s, meta(n, name), t));

    it('union of two devices, identical result in either order, and idempotent', () => {
        const a = build([add(1, 'aa', 10), add(2, 'bb', 11)]);
        const b = build([add(3, 'cc', 12), add(2, 'bb', 11)]);
        const ab = mergeLibraries(a, b), ba = mergeLibraries(b, a);
        expect(names(ab)).toEqual(names(ba));
        expect(JSON.stringify(ab)).toBe(JSON.stringify(ba));
        expect(mergeLibraries(ab, b)).toBe(ab);
        expect(mergeLibraries(ab, ab)).toBe(ab);
    });

    it('newest rename wins on either side', () => {
        const base = build([add(1, 'aa', 10)]);
        const a = must(renameEntry(base, id(1), 'zz', 20));
        const b = must(renameEntry(base, id(1), 'yy', 30));
        expect(names(mergeLibraries(a, b))).toEqual(['yy']);
        expect(names(mergeLibraries(b, a))).toEqual(['yy']);
    });

    it('a newer tombstone deletes; a newer re-add survives the old tombstone; a tie keeps the entry', () => {
        const base = build([add(1, 'aa', 10)]);
        const removed = removeEntry(base, id(1), 20);
        expect(mergeLibraries(base, removed).entries).toHaveLength(0);
        expect(mergeLibraries(removed, base).entries).toHaveLength(0);
        const readded = must(addEntry(removed, meta(1, 'aa'), 30));
        expect(mergeLibraries(removed, readded).entries).toHaveLength(1);
        const tie: EmojiLibState = { entries: base.entries, tombstones: { [id(1)]: base.entries[0].at } };
        expect(mergeLibraries(tie, base).entries).toHaveLength(1);
        expect(mergeLibraries(base, tie).entries).toHaveLength(1);
    });

    it('two devices adding the same name for different pictures converge on unique names', () => {
        const a = build([add(1, 'pepe', 10)]);
        const b = build([add(2, 'pepe', 11)]);
        const ab = mergeLibraries(a, b), ba = mergeLibraries(b, a);
        expect(new Set(ab.entries.map(e => e.name)).size).toBe(2);
        expect(JSON.stringify(ab)).toBe(JSON.stringify(ba));
        expect(mergeLibraries(ab, ba)).toBe(ab);
    });

    it('converges above the cap by trimming deterministically', () => {
        let a = emptyLibrary(), b = emptyLibrary();
        for (let i = 0; i < 70; i++) a = must(addEntry(a, meta(i, `a${i}x`), i));
        for (let i = 100; i < 170; i++) b = must(addEntry(b, meta(i, `b${i}x`), i));
        const ab = mergeLibraries(a, b), ba = mergeLibraries(b, a);
        expect(ab.entries).toHaveLength(PERSONAL_EMOJI_LIBRARY_MAX);
        expect(JSON.stringify(ab)).toBe(JSON.stringify(ba));
    });

    it('three-way: any merge order gives the same library', () => {
        const x = build([add(1, 'aa', 10)]);
        const y = must(renameEntry(x, id(1), 'bb', 20));
        const z = removeEntry(x, id(1), 15);
        const orders = [[x, y, z], [z, y, x], [y, x, z], [y, z, x]].map(([p, q, r]) =>
            JSON.stringify(mergeLibraries(mergeLibraries(p, q), r)));
        expect(new Set(orders).size).toBe(1);
    });

    it('drops invalid remote entries instead of merging junk', () => {
        const local = build([add(1, 'aa', 10)]);
        const junk = { entries: [{ id: '../../x', name: 'aa' }, { ...local.entries[0], mime: 'text/html', id: id(2) }], tombstones: { nope: 1 } } as unknown as EmojiLibState;
        expect(mergeLibraries(local, junk)).toBe(local);
    });
});

describe('housekeeping', () => {
    it('sanitize drops malformed state', () => {
        expect(sanitizeLibrary(null)).toEqual(emptyLibrary());
        expect(sanitizeLibrary({ entries: 'x', tombstones: 3 })).toEqual(emptyLibrary());
    });

    it('prunes only old tombstones', () => {
        const s: EmojiLibState = { entries: [], tombstones: { [id(1)]: 0, [id(2)]: EMOJI_TOMBSTONE_TTL_MS } };
        expect(Object.keys(pruneTombstones(s, EMOJI_TOMBSTONE_TTL_MS + 5).tombstones)).toEqual([id(2)]);
    });

    it('diff names what to write and what to delete', () => {
        const a = must(addEntry(emptyLibrary(), meta(1, 'aa'), 1));
        const b = must(addEntry(emptyLibrary(), meta(2, 'bb'), 1));
        const d = diffLibraries(a, b);
        expect(d.added.map(e => e.id)).toEqual([id(2)]);
        expect(d.removed).toEqual([id(1)]);
    });
});
