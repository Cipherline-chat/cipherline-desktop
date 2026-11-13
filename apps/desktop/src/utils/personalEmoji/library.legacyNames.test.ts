import { describe, it, expect } from 'vitest';
import { sanitizeLibrary, emptyLibrary, addEntry, renameEntry } from './library';
import { isPersonalEmojiName } from './token';

const id = (c: string) => 'p_' + c.repeat(32);
const entry = (c: string, name: string, order = 0) => ({ id: id(c), name, mime: 'image/png', animated: false, size: 100, order, at: 1, addedAt: 1 });

describe('a library saved before the underscore rule is repaired on load, never emptied', () => {
    it('spaces and dashes become underscores and every entry survives', () => {
        const lib = sanitizeLibrary({ entries: [entry('a', 'red heart', 0), entry('b', 'party-parrot', 1), entry('c', 'fine_name', 2)], tombstones: {} });
        expect(lib.entries.map(e => e.name)).toEqual(['red_heart', 'party_parrot', 'fine_name']);
    });
    it('a collision after repair is made unique deterministically (_2), losing nothing', () => {
        const lib = sanitizeLibrary({ entries: [entry('a', 'a b', 0), entry('b', 'a_b', 1), entry('c', 'a-b', 2)], tombstones: {} });
        expect(lib.entries).toHaveLength(3);
        expect(new Set(lib.entries.map(e => e.name)).size).toBe(3);
        expect(lib.entries.map(e => e.name)).toEqual(['a_b', 'a_b_2', 'a_b_3']);
    });
    it('is stable: loading the repaired result again changes nothing', () => {
        const once = sanitizeLibrary({ entries: [entry('a', 'x y', 0), entry('b', 'x-y', 1)], tombstones: {} });
        expect(sanitizeLibrary(JSON.parse(JSON.stringify(once)))).toEqual(once);
    });
    it('junk or one-character names are padded; other invalid fields still drop the entry', () => {
        const lib = sanitizeLibrary({ entries: [entry('a', 'x'), entry('b', '!!'), { ...entry('c', 'ok_name'), mime: 'text/html' }], tombstones: {} });
        expect(lib.entries.every(e => isPersonalEmojiName(e.name))).toBe(true);
        expect(lib.entries).toHaveLength(2);
    });
});

describe('creating and renaming reject (not coerce) a bad name', () => {
    it('addEntry / renameEntry', () => {
        const base = { id: id('a'), mime: 'image/png', animated: false, size: 10 };
        expect(addEntry(emptyLibrary(), { ...base, name: 'red heart' }, 1)).toMatchObject({ ok: false, error: 'invalid_name' });
        expect(addEntry(emptyLibrary(), { ...base, name: 'red-heart' }, 1)).toMatchObject({ ok: false, error: 'invalid_name' });
        const ok = addEntry(emptyLibrary(), { ...base, name: 'red_heart' }, 1);
        expect(ok.ok).toBe(true);
        if (ok.ok) expect(renameEntry(ok.state, id('a'), 'red heart', 2)).toMatchObject({ ok: false, error: 'invalid_name' });
    });
});
