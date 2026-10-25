import { describe, it, expect, beforeEach } from 'vitest';
import { PersonalEmojis } from './service';
import { CACHE_MAX_ENTRIES, emojiFileName, emojiKeyKey, openBytes, type StoreIO } from './store';
import { personalEmojiIdFromBytes } from './token';
import { emptyLibrary } from './library';

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n & 255, n >> 8, 7, 7, 7]);

function fakeIO(uid: string | null = 'u1') {
    const kv = new Map<string, string>();
    const files = new Map<string, Uint8Array>();
    const state = { uid, now: 1_000_000 };
    const io: StoreIO = {
        uid: () => state.uid,
        kvGet: k => kv.get(k) ?? null,
        kvSet: (k, v) => { kv.set(k, v); },
        kvRemove: k => { kv.delete(k); },
        readFile: async n => files.get(n) ?? null,
        writeFile: async (n, b) => { files.set(n, b); },
        deleteFile: async n => { files.delete(n); },
        now: () => state.now,
    };
    return { io, kv, files, state };
}

describe('PersonalEmojis', () => {
    let f: ReturnType<typeof fakeIO>;
    let pe: PersonalEmojis;
    beforeEach(() => { f = fakeIO(); pe = new PersonalEmojis(f.io); });

    it('adds an emoji: library entry, encrypted file, per-item key', async () => {
        const bytes = png(1);
        const r = await pe.add(bytes, 'pepe');
        expect(r).toMatchObject({ ok: true, alreadyHad: false });
        const id = await personalEmojiIdFromBytes(bytes);
        expect(pe.load().entries.map(e => e.id)).toEqual([id]);
        // At rest: the file is not the plaintext, and the key opens it.
        const sealed = f.files.get(emojiFileName(id))!;
        expect(Array.from(sealed.slice(0, 4))).not.toEqual(Array.from(bytes.slice(0, 4)));
        const key = f.kv.get(emojiKeyKey('u1', id))!;
        expect(await openBytes(sealed, key)).toEqual(bytes);
        expect(await pe.store.read(id)).toEqual(bytes);
    });

    it('the same picture twice is one emoji', async () => {
        await pe.add(png(1), 'pepe');
        const again = await pe.add(png(1), 'other');
        expect(again).toMatchObject({ ok: true, alreadyHad: true });
        expect(pe.load().entries).toHaveLength(1);
    });

    it('refuses non-images, oversize and a signed-out account without writing', async () => {
        expect(await pe.add(new TextEncoder().encode('<svg/>'), 'bad')).toEqual({ ok: false, error: 'not_an_image' });
        expect(await pe.add(new Uint8Array(300 * 1024), 'big')).toEqual({ ok: false, error: 'too_large' });
        const out = new PersonalEmojis(fakeIO(null).io);
        expect(await out.add(png(1), 'pepe')).toEqual({ ok: false, error: 'signed_out' });
        expect(f.files.size).toBe(0);
    });

    it('a duplicate name is refused before any file is written', async () => {
        await pe.add(png(1), 'pepe');
        const r = await pe.add(png(2), 'pepe');
        expect(r).toEqual({ ok: false, error: 'duplicate_name' });
        expect(f.files.size).toBe(1);
    });

    it('remove keeps the image cached so existing messages still render, rename/move persist', async () => {
        const a = await pe.add(png(1), 'aa');
        await pe.add(png(2), 'bb');
        if (!a.ok) throw new Error();
        expect(pe.rename(a.entry.id, 'zz').ok).toBe(true);
        expect(pe.move(a.entry.id, 1).ok).toBe(true);
        expect(pe.load().entries.sort((x, y) => x.order - y.order).map(e => e.name)).toEqual(['bb', 'zz']);
        pe.remove(a.entry.id);
        expect(pe.load().entries.map(e => e.name)).toEqual(['bb']);
        expect(await pe.store.read(a.entry.id)).toEqual(png(1));
    });

    it('restore (Undo of remove) puts the entry back in its old slot, clears the tombstone, and syncs as a newer write', async () => {
        const a = await pe.add(png(1), 'aa');
        const b = await pe.add(png(2), 'bb');
        await pe.add(png(3), 'cc');
        if (!a.ok || !b.ok) throw new Error();
        const removed = pe.load().entries.find(e => e.id === b.entry.id)!;
        pe.remove(b.entry.id);
        expect(pe.load().tombstones[b.entry.id]).toBeDefined();
        f.state.now += 1000;
        expect(await pe.restore(removed)).toEqual({ ok: true });
        const after = pe.load();
        expect(after.entries.map(e => e.name)).toEqual(['aa', 'bb', 'cc']);
        expect(after.tombstones[b.entry.id]).toBeUndefined();
        // Another device that only saw the removal must converge on "restored".
        const removedOnly = { entries: after.entries.filter(e => e.id !== b.entry.id), tombstones: { [b.entry.id]: removed.at + 1 } };
        const out = pe.applyRemote(removedOnly);
        expect(out.removed).toEqual([]);
        expect(pe.load().entries.map(e => e.name)).toEqual(['aa', 'bb', 'cc']);
        // Restoring something already present is a no-op.
        expect(await pe.restore(removed)).toEqual({ ok: true });
        expect(pe.load().entries).toHaveLength(3);
    });

    it('restore fails cleanly when the image is gone or nobody is signed in', async () => {
        const a = await pe.add(png(1), 'aa');
        if (!a.ok) throw new Error();
        pe.remove(a.entry.id);
        f.files.clear();
        pe.store.resetSession();
        expect(await pe.restore(a.entry)).toEqual({ ok: false, error: 'not_an_image' });
        expect(pe.load().entries).toHaveLength(0);
        f.state.uid = null;
        expect(await pe.restore(a.entry)).toEqual({ ok: false, error: 'signed_out' });
    });

    it('state is account-scoped', async () => {
        await pe.add(png(1), 'pepe');
        f.state.uid = 'u2';
        expect(pe.load()).toEqual(emptyLibrary());
        expect(pe.store.ids()).toEqual([]);
    });

    it('notifies subscribers with the change origin', async () => {
        const seen: string[] = [];
        pe.subscribe(o => seen.push(o));
        await pe.add(png(1), 'pepe');
        pe.applyRemote({ entries: [], tombstones: {} });
        expect(seen).toEqual(['local']);
    });

    it('applyRemote merges, reports what to materialise, and is idempotent', async () => {
        const other = new PersonalEmojis(fakeIO().io);
        await other.add(png(5), 'five');
        const remote = other.load();
        const r1 = pe.applyRemote(remote);
        expect(r1.changed).toBe(true);
        expect(r1.added.map(e => e.name)).toEqual(['five']);
        expect(pe.applyRemote(remote).changed).toBe(false);
    });

    it('an unreadable (missing) file is dropped from the index instead of looping', async () => {
        const r = await pe.add(png(1), 'aa');
        if (!r.ok) throw new Error();
        f.files.clear();
        expect(await pe.store.read(r.entry.id)).toBeNull();
        expect(pe.store.has(r.entry.id)).toBe(false);
    });
});

describe('cache bounds', () => {
    it('evicts least-recently-used cache entries but never library entries', async () => {
        const f = fakeIO();
        const pe = new PersonalEmojis(f.io);
        const mine = await pe.add(png(9999), 'mine');
        if (!mine.ok) throw new Error();
        // Cache a flood of received emojis, oldest first.
        for (let i = 0; i < CACHE_MAX_ENTRIES + 5; i++) {
            f.state.now += 1000;
            const bytes = png(i);
            await pe.store.put(await personalEmojiIdFromBytes(bytes), bytes, { mime: 'image/png', animated: false, name: `r${i}` });
        }
        const ids = pe.store.ids();
        expect(ids.length).toBe(CACHE_MAX_ENTRIES + 1); // cache bound + the pinned library entry
        expect(ids).toContain(mine.entry.id);
        expect(ids).not.toContain(await personalEmojiIdFromBytes(png(0)));
        expect(ids).toContain(await personalEmojiIdFromBytes(png(CACHE_MAX_ENTRIES + 4)));
        // Evicted files and keys are really gone.
        expect(f.files.size).toBe(CACHE_MAX_ENTRIES + 1);
        expect([...f.kv.keys()].filter(k => k.startsWith('cipherline_emoji_key_u1_')).length).toBe(CACHE_MAX_ENTRIES + 1);
    });
});
