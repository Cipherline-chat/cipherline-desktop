import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Direct coverage of electron/channel-keys.ts's pruneOldKeys retention rules
 * (RC-10) — same mock pattern as e2eeEngine.smoke.test.ts: only the
 * SecureStore dependency (which imports the `electron` module) is stubbed,
 * everything else runs the real module.
 */

const store = new Map<string, string>();
/**
 * Counts how many times the real SecureStore would have hit the disk. Both
 * `set` and `setMany` end in exactly one `save()` — which re-serialises the
 * WHOLE vault and does a writeFileSync + renameSync — so this is a faithful
 * proxy for "full-vault disk writes", the thing pruneOldKeys must not do once
 * per channel on the main process's UI thread at boot.
 */
let saveCount = 0;
vi.mock('../../electron/storage', () => ({
    secureStore: {
        get: (k: string) => store.get(k) ?? null,
        set: (k: string, v: string) => { store.set(k, v); saveCount++; },
        setDeferred: (k: string, v: string) => { store.set(k, v); saveCount++; },
        setMany: (entries: Record<string, string>) => {
            for (const [k, v] of Object.entries(entries)) store.set(k, v);
            saveCount++;
        },
        delete: (k: string) => { store.delete(k); },
        deleteDeferred: (k: string) => { store.delete(k); },
        batch: <T>(fn: () => T): T => fn(),
        keys: () => [...store.keys()],
    },
}));

const { setChannelKey, listChannelEpochs, setProtectedEpochs, pruneOldKeys } =
    await import('../../electron/channel-keys');

const CHANNEL = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const DAY_MS = 24 * 60 * 60 * 1000;

/** A 32-byte AES key, base64 — pruneOldKeys never inspects key bytes, only rotatesAt. */
function fakeKeyB64(seed: number): string {
    return Buffer.from(new Uint8Array(32).fill(seed % 256)).toString('base64');
}

/** rotatesAt = createdApprox + 7 days (pruneOldKeys backs out createdApprox this way). */
function rotatesAtFor(ageDays: number): Date {
    return new Date(Date.now() - ageDays * DAY_MS + 7 * DAY_MS);
}

beforeEach(() => {
    store.clear();
    saveCount = 0;
});

describe('pruneOldKeys disk-write batching (startup hang)', () => {
    // NOTE: channel-keys.ts holds a module-level in-memory cache that the
    // `store.clear()` in beforeEach does NOT reset, so every test here uses
    // its own channel ids rather than the shared CHANNEL constant.
    const chan = (n: number) => `dddddddd-dddd-dddd-dddd-${String(n).padStart(12, '0')}`;

    /** Seed `count` channels that each have prunable epochs (60 epochs, all
     *  older than the 30-day cutoff → 1..10 fall outside the newest-50 window). */
    function seedPrunableChannels(count: number): string[] {
        const ids: string[] = [];
        for (let i = 0; i < count; i++) {
            const id = chan(i);
            ids.push(id);
            for (let e = 1; e <= 60; e++) setChannelKey(id, e, fakeKeyB64(e), rotatesAtFor(90));
        }
        return ids;
    }

    it('writes the vault ONCE no matter how many channels are pruned', () => {
        const ids = seedPrunableChannels(12);
        saveCount = 0;

        pruneOldKeys();

        // The whole point: one full-vault write, not one per pruned channel.
        // `SecureStore.set()` re-serialises the entire vault and does a
        // writeFileSync + renameSync, and this runs on the Electron main
        // process's UI thread before createWindow() — so N writes meant N
        // stalls of the thread that owns the window HWND.
        expect(saveCount).toBe(1);
        // ...and the prune itself still did its job on every channel.
        for (const id of ids) {
            const held = new Set(listChannelEpochs(id));
            expect(held.has(1)).toBe(false);
            expect(held.has(60)).toBe(true);
        }
    });

    it('writes nothing at all when there is nothing to prune', () => {
        const id = chan(100);
        setChannelKey(id, 1, fakeKeyB64(1), rotatesAtFor(1));
        setChannelKey(id, 2, fakeKeyB64(2), rotatesAtFor(1));
        saveCount = 0;

        pruneOldKeys();

        expect(saveCount).toBe(0);
        expect(listChannelEpochs(id)).toEqual([1, 2]);
    });

    it('still respects pin-protected epochs when batching', () => {
        const id = chan(101);
        for (let e = 1; e <= 60; e++) setChannelKey(id, e, fakeKeyB64(e), rotatesAtFor(90));
        setProtectedEpochs(id, [1]);
        saveCount = 0;

        pruneOldKeys();

        const held = new Set(listChannelEpochs(id));
        expect(held.has(1)).toBe(true);  // pinned — survives the batched write
        expect(held.has(60)).toBe(true); // highest — always survives
        expect(held.has(2)).toBe(false); // unpinned, old, outside newest-50 — pruned
    });
});

describe('pruneOldKeys retention (RC-10)', () => {
    it('always keeps the highest epoch regardless of age', () => {
        setChannelKey(CHANNEL, 1, fakeKeyB64(1), rotatesAtFor(90));
        pruneOldKeys();
        expect(listChannelEpochs(CHANNEL)).toEqual([1]);
    });

    it('prunes an old, non-latest, unprotected epoch outside both retention windows', () => {
        // 60 epochs so epoch 1 falls outside both the highest-epoch rule and
        // the newest-50 rule; all old enough to clear PRUNE_AFTER_MS (30d).
        for (let e = 1; e <= 60; e++) {
            setChannelKey(CHANNEL, e, fakeKeyB64(e), rotatesAtFor(90 - e)); // epoch 1 oldest
        }
        pruneOldKeys();
        const held = new Set(listChannelEpochs(CHANNEL));
        expect(held.has(1)).toBe(false); // pruned: not latest, not in newest 50, old, unprotected
        expect(held.has(60)).toBe(true); // latest — always kept
    });

    it('keeps the newest 50 epochs regardless of age even when the channel has more', () => {
        for (let e = 1; e <= 60; e++) {
            setChannelKey(CHANNEL, e, fakeKeyB64(e), rotatesAtFor(90)); // ALL old enough to prune by age
        }
        pruneOldKeys();
        const held = new Set(listChannelEpochs(CHANNEL));
        // Epochs 11..60 are the newest 50 (plus 60 is also the always-kept latest).
        for (let e = 11; e <= 60; e++) expect(held.has(e)).toBe(true);
        // Epochs 1..10 are old AND outside the newest-50 window — pruned.
        for (let e = 1; e <= 10; e++) expect(held.has(e)).toBe(false);
    });

    it('never prunes an epoch marked protected (pinned), even if old and outside the newest-50 window', () => {
        for (let e = 1; e <= 60; e++) {
            setChannelKey(CHANNEL, e, fakeKeyB64(e), rotatesAtFor(90 - e));
        }
        setProtectedEpochs(CHANNEL, [1]); // epoch 1 would otherwise be pruned (see the unprotected test above)
        pruneOldKeys();
        expect(listChannelEpochs(CHANNEL)).toContain(1);
    });

    it('setProtectedEpochs wholesale-replaces the protected set on each call', () => {
        for (let e = 1; e <= 60; e++) {
            setChannelKey(CHANNEL, e, fakeKeyB64(e), rotatesAtFor(90 - e));
        }
        setProtectedEpochs(CHANNEL, [1, 2]);
        setProtectedEpochs(CHANNEL, [2]); // epoch 1 no longer protected
        pruneOldKeys();
        const held = new Set(listChannelEpochs(CHANNEL));
        expect(held.has(1)).toBe(false);
        expect(held.has(2)).toBe(true);
    });

    it('an unrelated channel is unaffected by another channel\'s protected epochs', () => {
        const OTHER = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
        for (let e = 1; e <= 60; e++) {
            setChannelKey(CHANNEL, e, fakeKeyB64(e), rotatesAtFor(90 - e));
            setChannelKey(OTHER, e, fakeKeyB64(e), rotatesAtFor(90 - e));
        }
        setProtectedEpochs(CHANNEL, [1]);
        pruneOldKeys();
        expect(listChannelEpochs(CHANNEL)).toContain(1);
        expect(listChannelEpochs(OTHER)).not.toContain(1);
    });
});
