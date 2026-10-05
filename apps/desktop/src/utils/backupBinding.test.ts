import { describe, it, expect, beforeEach, vi } from 'vitest';

// importLocalHistory's wrapped-vault path writes through secureLocalStore —
// a simple in-memory Map stands in, same pattern as keyVerification.test.ts.
const mem = new Map<string, string>();
// crypto.ts imports the default export, messageStore the named one — the mock
// must supply both or the restore path blows up inside messageStore.
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    keysWithPrefix: (p: string) => [...mem.keys()].filter(k => k.startsWith(p)),
    hydrateMessages: async () => {},
};
vi.mock('./secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

const { importLocalHistory } = await import('./crypto');

beforeEach(() => {
    mem.clear();
});

/**
 * Account binding: a backup vault may only be restored into the account that
 * created it. `importLocalHistory` is the chokepoint used by the Drive/local
 * restore flows, so the guard here protects all of them.
 */
describe('importLocalHistory — account binding', () => {
    const vaultFor = (userId: string) =>
        new Blob([JSON.stringify({ userId, history: {}, topics: [] })], { type: 'application/json' });

    it('refuses to restore a backup belonging to a different account', async () => {
        await expect(importLocalHistory('account-B', vaultFor('account-A')))
            .rejects.toThrow(/different account/i);
    });

    it('restores cleanly when the userId matches', async () => {
        await expect(importLocalHistory('account-A', vaultFor('account-A'))).resolves.toBeUndefined();
        // History is stored per conversation now, so an empty vault legitimately
        // writes no message records at all — assert on the conversation list,
        // which is what actually proves the restore ran.
        expect(mem.get('cipherline_convs_account-A')).toBe(JSON.stringify([]));
        expect([...mem.keys()].some(k => k.startsWith('cipherline_msgs_account-A'))).toBe(false);
    });

    // Hardening follow-up: a WRAPPED vault (has history+topics, i.e. it looks
    // like a real export) with userId entirely MISSING used to bypass the
    // account-binding check completely (the old guard was
    // `if (vault.userId && vault.userId !== userId)` — falsy userId short-
    // circuited past it) instead of being rejected. exportLocalHistory has
    // always included userId alongside history/topics in the same object, so
    // a wrapped vault missing it isn't a legitimate legacy case — it's either
    // hand-crafted, corrupted, or tampered, and must fail closed.
    it('refuses to restore a wrapped vault with userId missing entirely (fails closed, does not silently trust it)', async () => {
        const blob = new Blob([JSON.stringify({ history: {}, topics: [] })], { type: 'application/json' });
        await expect(importLocalHistory('account-B', blob))
            .rejects.toThrow(/account information/i);
        // Confirm nothing was written — the rejection happens before any
        // secureLocalStore write, not as a partial/best-effort import.
        expect(mem.size).toBe(0);
    });

    // The one legitimate case where a missing userId is fine: the genuinely
    // ancient pre-wrapper format (no history+topics wrapper at all) never had
    // an account-binding concept, and this exemption must not regress into
    // rejecting those legacy exports.
    it('still restores a legacy pre-wrapper (bare messages dump) vault with no userId at all', async () => {
        const bareDump = { someConversationId: [{ id: 'm1', text: 'hi' }] };
        const blob = new Blob([JSON.stringify(bareDump)], { type: 'application/json' });
        await expect(importLocalHistory('account-B', blob)).resolves.toBeUndefined();
        // The bare path hands the blob to the legacy slot verbatim; messageStore
        // splits it into per-conversation records on the next read.
        expect(mem.get('cipherline_msgs_account-B')).toBe(JSON.stringify(bareDump));
    });
});
