/**
 * Audit run 2, lead 11 — the avatar_key:* namespace of the SecureStore must not
 * be a free-growth surface for sender-chosen ids. A real Map-backed store
 * stands in for SecureStore (same get/set/delete/keysWithPrefix contract); the
 * policy module itself is real.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import {
    applyAvatarKey, AVATAR_KEY_MAX_ENTRIES, AVATAR_KEY_PREFIX, isAvatarKeyId, type AvatarKeyStoreLike,
} from './avatar-key-policy';

function fakeStore() {
    const m = new Map<string, string>();
    let sets = 0, deletes = 0;
    const store: AvatarKeyStoreLike = {
        get: k => m.get(k) ?? null,
        set: (k, v) => { sets++; m.set(k, v); },
        delete: k => { deletes++; m.delete(k); },
        keysWithPrefix: p => [...m.keys()].filter(k => k.startsWith(p)),
    };
    return { store, m, counts: () => ({ sets, deletes }) };
}
const key = () => randomBytes(32).toString('base64');
const nonce = () => randomBytes(12).toString('base64');

describe('applyAvatarKey — legitimate path', () => {
    it('stores a real avatar key (UUID id, 32-byte key, 12-byte IV) and reads back what the renderer expects', () => {
        const { store, m } = fakeStore();
        const id = randomUUID(), k = key(), n = nonce();
        expect(applyAvatarKey(store, id, k, n)).toBe('stored');
        expect(JSON.parse(m.get(`${AVATAR_KEY_PREFIX}${id}`)!)).toEqual({ keyB64: k, nonceB64: n });
    });
    it('an identical re-send is a no-op (no second vault write)', () => {
        const { store, counts } = fakeStore();
        const id = randomUUID(), k = key(), n = nonce();
        applyAvatarKey(store, id, k, n);
        expect(applyAvatarKey(store, id, k, n)).toBe('unchanged');
        expect(counts().sets).toBe(1);
    });
    it('an upper-case UUID is accepted; a re-upload (new key for an existing id) replaces it', () => {
        const { store, m } = fakeStore();
        const id = randomUUID();
        expect(applyAvatarKey(store, id.toUpperCase(), key(), nonce())).toBe('stored');
        const k2 = key(), n2 = nonce();
        expect(applyAvatarKey(store, id.toUpperCase(), k2, n2)).toBe('stored');
        expect(JSON.parse(m.get(`${AVATAR_KEY_PREFIX}${id.toUpperCase()}`)!).keyB64).toBe(k2);
    });
    it('the deleteAvatarKey tombstone (empty key + nonce) removes an existing entry', () => {
        const { store, m } = fakeStore();
        const id = randomUUID();
        applyAvatarKey(store, id, key(), nonce());
        expect(applyAvatarKey(store, id, '', '')).toBe('cleared');
        expect(m.has(`${AVATAR_KEY_PREFIX}${id}`)).toBe(false);
    });
    it('a tombstone for an id that is not stored creates nothing', () => {
        const { store, m } = fakeStore();
        expect(applyAvatarKey(store, randomUUID(), '', '')).toBe('unchanged');
        expect(m.size).toBe(0);
    });
    it('unpadded 32-byte key base64 (43 chars) is accepted', () => {
        const { store } = fakeStore();
        expect(applyAvatarKey(store, randomUUID(), key().replace(/=+$/, ''), nonce())).toBe('stored');
    });
});

describe('applyAvatarKey — refusals (negative)', () => {
    const bad: Array<[string, unknown, unknown, unknown]> = [
        ['256-char sender-chosen id', 'x'.repeat(256), key(), nonce()],
        ['non-UUID id', 'attachment-1', key(), nonce()],
        ['id with a separator', `${randomUUID()}:../x`, key(), nonce()],
        ['512-char key', randomUUID(), 'A'.repeat(512), nonce()],
        ['512-char nonce', randomUUID(), key(), 'A'.repeat(512)],
        ['16-byte key', randomUUID(), randomBytes(16).toString('base64'), nonce()],
        ['24-byte nonce', randomUUID(), key(), randomBytes(24).toString('base64')],
        ['key not base64', randomUUID(), '!'.repeat(44), nonce()],
        ['missing key (undefined)', randomUUID(), undefined, nonce()],
        ['empty key with a nonce', randomUUID(), '', nonce()],
        ['numeric key', randomUUID(), 12345, nonce()],
        ['non-string id', { toString: () => randomUUID() }, key(), nonce()],
    ];
    for (const [name, id, k, n] of bad) {
        it(`refuses ${name} and writes nothing`, () => {
            const { store, m, counts } = fakeStore();
            expect(applyAvatarKey(store, id, k, n)).toBe('refused_invalid');
            expect(m.size).toBe(0);
            expect(counts().sets).toBe(0);
        });
    }
    it('isAvatarKeyId rejects non-strings and near-UUIDs', () => {
        expect(isAvatarKeyId(randomUUID())).toBe(true);
        expect(isAvatarKeyId(randomUUID() + 'a')).toBe(false);
        expect(isAvatarKeyId(null)).toBe(false);
    });
});

describe('applyAvatarKey — global cap', () => {
    it('refuses NEW ids at the cap without evicting anything, still serves updates/clears of existing ids', () => {
        const { store, m } = fakeStore();
        const ids: string[] = [];
        for (let i = 0; i < AVATAR_KEY_MAX_ENTRIES; i++) {
            const id = randomUUID(); ids.push(id);
            expect(applyAvatarKey(store, id, key(), nonce())).toBe('stored');
        }
        const before = new Map(m);
        // the hostile flood: a thousand fresh ids past the cap
        for (let i = 0; i < 1000; i++) expect(applyAvatarKey(store, randomUUID(), key(), nonce())).toBe('refused_full');
        expect(m.size).toBe(AVATAR_KEY_MAX_ENTRIES);
        expect([...m.entries()]).toEqual([...before.entries()]); // nothing evicted or changed
        // legitimate traffic for ids already held keeps working
        expect(applyAvatarKey(store, ids[0], key(), nonce())).toBe('stored');
        expect(applyAvatarKey(store, ids[1], '', '')).toBe('cleared');
        // …and clearing one frees exactly one slot for a new id
        expect(applyAvatarKey(store, randomUUID(), key(), nonce())).toBe('stored');
        expect(applyAvatarKey(store, randomUUID(), key(), nonce())).toBe('refused_full');
    });
    it('negative control: just under the cap a new id is still stored', () => {
        const { store } = fakeStore();
        for (let i = 0; i < AVATAR_KEY_MAX_ENTRIES - 1; i++) applyAvatarKey(store, randomUUID(), key(), nonce());
        expect(applyAvatarKey(store, randomUUID(), key(), nonce())).toBe('stored');
    });
});
