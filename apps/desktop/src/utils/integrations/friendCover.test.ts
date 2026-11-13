import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The viewer's side: ciphertext from OUR API, decrypted with the key the
 * friend delivered to this device; no key -> nothing (and a retry when it
 * lands, without downloading again); 404 -> not asked again.
 */
const mem = new Map<string, string>();
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
};
vi.mock('../secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));
const get = vi.fn();
vi.mock('axios', () => ({ default: { get: (...a: unknown[]) => get(...a) } }));

const F = await import('./friendCover');
const K = await import('./activityKeys');
const { encryptCover, newActivityKey, newCoverId } = await import('./activityCover');

const ME = '11111111-1111-4111-8111-111111111111';
const ALICE = '22222222-2222-4222-8222-222222222222';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);
let n = 0;
(URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => `blob:cover-${++n}`;
(URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};

async function sharedCover() {
    const key = newActivityKey();
    const coverId = newCoverId();
    const blob = (await encryptCover({ sharerUserId: ALICE, coverId, kid: key.kid, keyB64: key.keyB64, image: JPEG }))!;
    get.mockImplementation(async () => ({ data: blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) }));
    return { key, coverId };
}

beforeEach(() => { mem.clear(); get.mockReset(); F.__resetFriendCovers(); F.setFriendCoverSession({ token: 'tok', userId: ME }); });

describe('loading a friend\'s cover', () => {
    it('fetches the ciphertext from our API (the friend\'s cover route, with the id) and decrypts it locally', async () => {
        const { key, coverId } = await sharedCover();
        K.fileFriendActivityKey(ME, ALICE, key.kid, key.keyB64, 1);
        await F.loadFriendCover(ALICE, coverId);
        const c = F.peekFriendCover(ALICE, coverId);
        expect(c?.bytes).toEqual(JPEG);
        expect(c?.type).toBe('image/jpeg');
        expect(c?.url).toMatch(/^blob:/);
        const [url, opts] = get.mock.calls[0] as [string, { params: unknown; headers: Record<string, string>; responseType: string }];
        expect(url).toMatch(new RegExp(`/friends/${ALICE}/listening/cover$`));
        expect(opts.params).toEqual({ id: coverId });
        expect(opts.headers.Authorization).toBe('Bearer tok');
        expect(opts.responseType).toBe('arraybuffer');
        // Once per (friend, cover) per session.
        await F.loadFriendCover(ALICE, coverId);
        expect(get).toHaveBeenCalledTimes(1);
    });

    it('no key on this device: no picture; when the key lands it decrypts WITHOUT downloading again', async () => {
        const { key, coverId } = await sharedCover();
        await F.loadFriendCover(ALICE, coverId);
        expect(F.peekFriendCover(ALICE, coverId)).toBeNull();
        await F.loadFriendCover(ALICE, coverId); // nothing new: no second request
        expect(get).toHaveBeenCalledTimes(1);
        K.fileFriendActivityKey(ME, ALICE, key.kid, key.keyB64, 1);
        await F.loadFriendCover(ALICE, coverId);
        expect(F.peekFriendCover(ALICE, coverId)?.bytes).toEqual(JPEG);
        expect(get).toHaveBeenCalledTimes(1);
    });

    it('a 404 (not friends any more / track changed) is remembered and not asked again', async () => {
        get.mockRejectedValue(Object.assign(new Error('nf'), { response: { status: 404 } }));
        const id = newCoverId();
        await F.loadFriendCover(ALICE, id);
        await F.loadFriendCover(ALICE, id);
        expect(get).toHaveBeenCalledTimes(1);
        expect(F.peekFriendCover(ALICE, id)).toBeNull();
    });

    it('never asks without a session, for a malformed id / user, or for your own record', async () => {
        await F.loadFriendCover(ALICE, 'bad');
        await F.loadFriendCover('not-a-uuid', newCoverId());
        await F.loadFriendCover(ME, newCoverId());
        F.setFriendCoverSession(null);
        await F.loadFriendCover(ALICE, newCoverId());
        expect(get).not.toHaveBeenCalled();
    });

    it('signing out forgets every decrypted cover', async () => {
        const { key, coverId } = await sharedCover();
        K.fileFriendActivityKey(ME, ALICE, key.kid, key.keyB64, 1);
        await F.loadFriendCover(ALICE, coverId);
        F.setFriendCoverSession(null);
        expect(F.peekFriendCover(ALICE, coverId)).toBeNull();
    });
});
