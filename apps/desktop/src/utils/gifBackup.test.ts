import { describe, it, expect, beforeEach, vi } from 'vitest';
import { classifyKvKey } from '../services/backupRegistry';

// Same in-memory secureLocalStore stand-in as backupBinding.test.ts.
const mem = new Map<string, string>();
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    keysWithPrefix: (p: string) => [...mem.keys()].filter(k => k.startsWith(p)),
    hydrateMessages: async () => { },
};
vi.mock('./secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

const { importLocalHistory } = await import('./crypto');

const UID = 'user-1';

beforeEach(() => { mem.clear(); });

/**
 * The GIF library is backed up through structured vault fields, not the
 * generic kv map — so the registry marks its keys `include: false` with a
 * `why` naming the vault field. That is only correct as long as the vault
 * really carries them, which is what the round-trip below proves. Without it,
 * "excluded" and "not backed up" are indistinguishable, which is exactly the
 * quiet data loss backupRegistry exists to prevent.
 */
describe('GIF library — backup classification', () => {
    it('classifies every GIF key, none left unknown', () => {
        expect(classifyKvKey(`cipherline_gif_favorites_${UID}`, UID)).toBe('exclude');
        expect(classifyKvKey(`cipherline_gif_ledger_${UID}`, UID)).toBe('exclude');
        expect(classifyKvKey(`cipherline_gif_key_${UID}_abc`, UID)).toBe('exclude');
        expect(classifyKvKey(`cipherline_gif_sync_seen_${UID}`, UID)).toBe('exclude');
        // Legacy device-global records, kept as a migration source.
        expect(classifyKvKey('cipherline_gif_favorites', UID)).toBe('exclude');
        expect(classifyKvKey('cipherline_gif_key_abc', UID)).toBe('exclude');
        // The picker's autoplay pref has no vault field, so it rides the kv map.
        expect(classifyKvKey('cipherline_gif_settings', UID)).toBe('include');
    });

    it('a brand-new GIF key is NOT silently accepted', () => {
        // Proves the classification is a real allowlist and the rules above
        // are not just matching everything that starts with cipherline_gif.
        expect(classifyKvKey('cipherline_gif_something_new', UID)).toBe('unknown');
    });
});

describe('GIF library — vault round-trip', () => {
    const vault = (extra: Record<string, unknown>) =>
        new Blob([JSON.stringify({ userId: UID, history: {}, topics: [], ...extra })],
            { type: 'application/json' });

    it('restores favorites, per-GIF keys and the sync ledger', async () => {
        await importLocalHistory(UID, vault({
            gifFavorites: [{ id: 'g1', source: 'local', fileName: 'g1.enc', mimeType: 'image/gif', addedAt: 5 }],
            gifKeys: { g1: 'KEY-g1' },
            gifLedger: { g1: 5, deleted: 9 },
        }));

        expect(JSON.parse(mem.get(`cipherline_gif_favorites_${UID}`)!)).toHaveLength(1);
        expect(mem.get(`cipherline_gif_key_${UID}_g1`)).toBe('KEY-g1');
        expect(JSON.parse(mem.get(`cipherline_gif_ledger_${UID}`)!)).toEqual({ g1: 5, deleted: 9 });
    });

    it('restores into the account namespace, never the legacy device-global keys', async () => {
        // Writing the legacy keys back would re-share this account's library
        // with every other account on the machine.
        await importLocalHistory(UID, vault({
            gifFavorites: [{ id: 'g1', source: 'local', fileName: 'g1.enc', mimeType: 'image/gif', addedAt: 5 }],
            gifKeys: { g1: 'KEY-g1' },
        }));

        expect(mem.has('cipherline_gif_favorites')).toBe(false);
        expect(mem.has('cipherline_gif_key_g1')).toBe(false);
    });

    it('carries the ledger so a restore keeps its deletion tombstones', async () => {
        // A restore that dropped the ledger would let the next sync from a
        // device that still holds a deleted GIF resurrect it.
        await importLocalHistory(UID, vault({ gifLedger: { removed: 100 } }));
        expect(JSON.parse(mem.get(`cipherline_gif_ledger_${UID}`)!)).toEqual({ removed: 100 });
    });

    it('leaves the GIF keys untouched when the vault has no GIF section', async () => {
        await importLocalHistory(UID, vault({}));
        expect(mem.has(`cipherline_gif_favorites_${UID}`)).toBe(false);
        expect(mem.has(`cipherline_gif_ledger_${UID}`)).toBe(false);
    });

    it('still refuses a vault belonging to another account', async () => {
        await expect(importLocalHistory('other-user', vault({ gifKeys: { g1: 'KEY' } })))
            .rejects.toThrow(/different account/i);
        expect(mem.size).toBe(0);
    });
});
