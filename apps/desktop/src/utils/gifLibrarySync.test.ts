import { describe, it, expect } from 'vitest';
import {
    applyGifOp,
    applyGifOps,
    localGifOp,
    mergeGifLibraries,
    diffLibraries,
    pruneGifLedger,
    isValidEntry,
    emptyLibraryState,
    type GifEntry,
    type GifLibraryState,
} from './gifLibrarySync';

const gif = (id: string, addedAt = 1_000, label?: string): GifEntry => ({
    id,
    source: 'local',
    fileName: `${id}.enc`,
    mimeType: 'image/gif',
    addedAt,
    label,
});

const state = (entries: GifEntry[], ledger: Record<string, number> = {}): GifLibraryState =>
    ({ entries, ledger });

describe('applyGifOp — basics', () => {
    it('adds an entry and records its timestamp', () => {
        const next = applyGifOp(emptyLibraryState(), localGifOp('a', 'add', 100, gif('a')));
        expect(next.entries.map(e => e.id)).toEqual(['a']);
        expect(next.ledger.a).toBe(100);
    });

    it('removes an entry but keeps the tombstone', () => {
        const s = state([gif('a')], { a: 100 });
        const next = applyGifOp(s, localGifOp('a', 'remove', 200));
        expect(next.entries).toEqual([]);
        expect(next.ledger.a).toBe(200);
    });

    it('ignores an add with no entry payload — nothing to insert', () => {
        const s = emptyLibraryState();
        expect(applyGifOp(s, { id: 'a', action: 'add', at: 100 })).toBe(s);
    });

    it('ignores a malformed op and returns the same object', () => {
        const s = state([gif('a')], { a: 100 });
        expect(applyGifOp(s, { id: '', action: 'remove', at: 200 })).toBe(s);
        expect(applyGifOp(s, { id: 'a', action: 'remove', at: Number.NaN })).toBe(s);
    });

    it('applies a batch in order', () => {
        const next = applyGifOps(emptyLibraryState(), [
            localGifOp('a', 'add', 100, gif('a')),
            localGifOp('b', 'add', 110, gif('b')),
            localGifOp('a', 'remove', 120),
        ]);
        expect(next.entries.map(e => e.id)).toEqual(['b']);
        expect(next.ledger).toEqual({ a: 120, b: 110 });
    });
});

describe('applyGifOp — last-write-wins', () => {
    it('ignores an op older than the ledger entry', () => {
        const s = state([], { a: 500 });
        expect(applyGifOp(s, localGifOp('a', 'add', 400, gif('a')))).toBe(s);
    });

    it('is idempotent on redelivery — equal timestamp does not flip', () => {
        const s = state([gif('a')], { a: 500 });
        expect(applyGifOp(s, localGifOp('a', 'remove', 500))).toBe(s);
    });

    it('records a timestamp even when the id set does not move', () => {
        // Re-adding an already-present GIF must still advance the ledger, or a
        // later-but-older remove would find no entry and get applied.
        const s = state([gif('a')], { a: 100 });
        const next = applyGifOp(s, localGifOp('a', 'add', 300, gif('a')));
        expect(next.entries.map(e => e.id)).toEqual(['a']);
        expect(next.ledger.a).toBe(300);

        // ...and now a stale remove at 200 is correctly ignored.
        expect(applyGifOp(next, localGifOp('a', 'remove', 200))).toBe(next);
    });

    it('converges regardless of arrival order', () => {
        const add = localGifOp('a', 'add', 100, gif('a'));
        const rm = localGifOp('a', 'remove', 200);
        const forward = applyGifOps(emptyLibraryState(), [add, rm]);
        const backward = applyGifOps(emptyLibraryState(), [rm, add]);
        expect(forward.entries.map(e => e.id)).toEqual(backward.entries.map(e => e.id));
        expect(forward.ledger.a).toBe(backward.ledger.a);
    });

    it('never produces a duplicate id', () => {
        const next = applyGifOps(emptyLibraryState(), [
            localGifOp('a', 'add', 100, gif('a')),
            localGifOp('a', 'add', 200, gif('a')),
        ]);
        expect(next.entries.map(e => e.id)).toEqual(['a']);
    });
});

describe('mergeGifLibraries', () => {
    it('unions GIFs that only one side has', () => {
        const local = state([gif('a', 100)], { a: 100 });
        const remote = state([gif('b', 110)], { b: 110 });
        const merged = mergeGifLibraries(local, remote);
        expect(merged.entries.map(e => e.id).sort()).toEqual(['a', 'b']);
    });

    it('honours a remote tombstone newer than the local add', () => {
        const local = state([gif('a', 100)], { a: 100 });
        const remote = state([], { a: 200 });
        expect(mergeGifLibraries(local, remote).entries).toEqual([]);
    });

    it('ignores a remote tombstone older than the local add', () => {
        const local = state([gif('a', 300)], { a: 300 });
        const remote = state([], { a: 200 });
        expect(mergeGifLibraries(local, remote).entries.map(e => e.id)).toEqual(['a']);
    });

    it('is commutative — both devices reach the same library', () => {
        const local = state([gif('a', 100), gif('c', 130)], { a: 100, b: 250, c: 130 });
        const remote = state([gif('b', 120), gif('c', 130)], { b: 120, c: 130 });
        const ab = mergeGifLibraries(local, remote);
        const ba = mergeGifLibraries(remote, local);
        expect(ab.entries.map(e => e.id)).toEqual(ba.entries.map(e => e.id));
        expect(ab.ledger).toEqual(ba.ledger);
    });

    it('is idempotent — merging the same snapshot twice changes nothing', () => {
        const local = state([gif('a', 100)], { a: 100 });
        const remote = state([gif('b', 110)], { b: 110 });
        const once = mergeGifLibraries(local, remote);
        expect(mergeGifLibraries(once, remote)).toBe(once);
    });

    it('returns the local object itself when the merge is a no-op', () => {
        const local = state([gif('a', 100)], { a: 100 });
        expect(mergeGifLibraries(local, emptyLibraryState())).toBe(local);
    });

    it('keeps the GIF on an exact timestamp tie rather than deleting it', () => {
        const local = state([gif('a', 100)], { a: 100 });
        const remote = state([], { a: 100 });
        expect(mergeGifLibraries(local, remote).entries.map(e => e.id)).toEqual(['a']);
        // ...and the same either way round.
        expect(mergeGifLibraries(remote, local).entries.map(e => e.id)).toEqual(['a']);
    });

    it('does NOT delete never-synced local imports against an empty remote ledger', () => {
        // The first-sync regression this guards: a device with GIFs but no
        // ledger must not lose them just because it has no timestamps.
        const local = state([gif('a', 100), gif('b', 110)], {});
        const remote = emptyLibraryState();
        const merged = mergeGifLibraries(local, remote);
        expect(merged.entries.map(e => e.id).sort()).toEqual(['a', 'b']);
        // addedAt became the effective timestamp.
        expect(merged.ledger).toEqual({ a: 100, b: 110 });
    });

    it('lets a real remote tombstone still beat an unsynced local import', () => {
        const local = state([gif('a', 100)], {});
        const remote = state([], { a: 200 });
        expect(mergeGifLibraries(local, remote).entries).toEqual([]);
    });

    it('produces a deterministic newest-first order on both devices', () => {
        const local = state([gif('a', 100)], { a: 100 });
        const remote = state([gif('b', 300), gif('c', 200)], { b: 300, c: 200 });
        expect(mergeGifLibraries(local, remote).entries.map(e => e.id)).toEqual(['b', 'c', 'a']);
        expect(mergeGifLibraries(remote, local).entries.map(e => e.id)).toEqual(['b', 'c', 'a']);
    });

    it('breaks an equal-addedAt ordering tie by id, so both devices agree', () => {
        const local = state([gif('z', 100), gif('a', 100)], { z: 100, a: 100 });
        const remote = emptyLibraryState();
        expect(mergeGifLibraries(local, remote).entries.map(e => e.id)).toEqual(['a', 'z']);
    });

    it('drops malformed entries arriving in a remote snapshot', () => {
        const remote = {
            entries: [
                gif('good', 100),
                { id: 'bad-no-filename', source: 'local', mimeType: 'image/gif', addedAt: 100 },
                null,
                { id: '', fileName: 'x.enc', mimeType: 'image/gif', addedAt: 1 },
            ] as unknown as GifEntry[],
            ledger: { good: 100 },
        };
        const merged = mergeGifLibraries(emptyLibraryState(), remote);
        expect(merged.entries.map(e => e.id)).toEqual(['good']);
    });
});

describe('isValidEntry', () => {
    it('accepts a well-formed entry and rejects junk', () => {
        expect(isValidEntry(gif('a'))).toBe(true);
        expect(isValidEntry(null)).toBe(false);
        expect(isValidEntry({ id: 'a' })).toBe(false);
        expect(isValidEntry({ ...gif('a'), addedAt: Number.NaN })).toBe(false);
        expect(isValidEntry({ ...gif('a'), fileName: '' })).toBe(false);
    });
});

describe('diffLibraries', () => {
    it('reports what must be written and deleted on disk', () => {
        const before = state([gif('a'), gif('b')]);
        const after = state([gif('b'), gif('c')]);
        const d = diffLibraries(before, after);
        expect(d.added.map(e => e.id)).toEqual(['c']);
        expect(d.removed).toEqual(['a']);
    });

    it('reports nothing for an unchanged library', () => {
        const s = state([gif('a')]);
        expect(diffLibraries(s, s)).toEqual({ added: [], removed: [] });
    });
});

describe('pruneGifLedger', () => {
    const DAY = 24 * 60 * 60 * 1000;

    it('drops a stale tombstone', () => {
        const s = state([], { gone: 0 });
        expect(pruneGifLedger(s, 40 * DAY, 30 * DAY).ledger).toEqual({});
    });

    it('never drops a ledger entry for a GIF still in the library', () => {
        const s = state([gif('a', 0)], { a: 0 });
        expect(pruneGifLedger(s, 400 * DAY, 30 * DAY).ledger).toEqual({ a: 0 });
    });

    it('keeps a recent tombstone so a slow snapshot cannot resurrect it', () => {
        const s = state([], { gone: 29 * DAY });
        expect(pruneGifLedger(s, 30 * DAY, 30 * DAY).ledger).toEqual({ gone: 29 * DAY });
    });

    it('returns the same object when nothing needed pruning', () => {
        const s = state([gif('a', 0)], { a: 0 });
        expect(pruneGifLedger(s, 0, 30 * DAY)).toBe(s);
    });
});
