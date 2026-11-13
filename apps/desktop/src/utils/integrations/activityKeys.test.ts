import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The activity key: delivered once per friend (end to end, as a hidden
 * profile_update), rotated when a holder stops being a friend or after a
 * week, filed on the receiving side only from that friend. Runs the real
 * crypto end to end: sharer -> wire JSON -> friend's device -> decrypt.
 */
const mem = new Map<string, string>();
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
};
vi.mock('../secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

const K = await import('./activityKeys');
const { decryptCover, encryptCover, newCoverId } = await import('./activityCover');

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';
const MALLORY = '44444444-4444-4444-8444-444444444444';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6, 5]);
const T0 = 1_800_000_000_000;

type Sent = { to: string; content: InstanceType<typeof Object> & Record<string, unknown> };
function deps(over: Partial<import('./activityKeys').KeyShareDeps> = {}) {
    const sent: Sent[] = [];
    const sleeps: number[] = [];
    let n = 0;
    const d: import('./activityKeys').KeyShareDeps = {
        send: async (t, c) => { sent.push({ to: t.userId, content: JSON.parse(JSON.stringify(c)) }); return 'sent'; },
        now: () => T0,
        sleep: async ms => { sleeps.push(ms); },
        newId: () => `m${++n}`,
        ...over,
    };
    return { d, sent, sleeps };
}
const targets = (...ids: string[]) => ids.map(id => ({ userId: id, conversationId: `dm-${id}` }));

beforeEach(() => mem.clear());

describe('rotation', () => {
    it('creates a key on first use and keeps it while the audience only grows', () => {
        const a = K.currentActivityKey(ALICE, [BOB], T0);
        expect(K.currentActivityKey(ALICE, [BOB, CAROL], T0 + 1000).kid).toBe(a.kid);
    });

    it('rotates after a week', () => {
        const a = K.currentActivityKey(ALICE, [BOB], T0);
        expect(K.currentActivityKey(ALICE, [BOB], T0 + K.ACTIVITY_KEY_MAX_AGE_MS).kid).not.toBe(a.kid);
    });

    it('rotates when someone who HOLDS the key is no longer a friend (unfriended / blocked)', async () => {
        const { d } = deps();
        const first = await K.shareActivityKey(ALICE, [BOB, CAROL], targets(BOB, CAROL), d);
        expect(first.sent.sort()).toEqual([BOB, CAROL].sort());
        // Carol removed: the next use rotates, and only Bob gets the new key.
        const { d: d2, sent } = deps();
        const second = await K.shareActivityKey(ALICE, [BOB], targets(BOB, CAROL), d2);
        expect(second.kid).not.toBe(first.kid);
        expect(sent.map(s => s.to)).toEqual([BOB]);
    });

    it('someone who never received the key leaving does not rotate it', () => {
        const a = K.currentActivityKey(ALICE, [BOB, CAROL], T0);
        expect(K.currentActivityKey(ALICE, [BOB], T0 + 1).kid).toBe(a.kid);
    });
});

describe('delivery (sharer side)', () => {
    it('one hidden profile_update per friend with a DM, paced, carrying only the key - never to self or a non-friend', async () => {
        const { d, sent, sleeps } = deps();
        const out = await K.shareActivityKey(ALICE, [BOB, CAROL], targets(BOB, CAROL, ALICE, MALLORY, BOB), d);
        expect(sent.map(s => s.to)).toEqual([BOB, CAROL]);
        expect(sleeps).toEqual([K.ACTIVITY_KEY_SEND_PACE_MS]);
        const c = sent[0].content;
        expect(Object.keys(c).sort()).toEqual(['activity_key', 'client_msg_id', 'type', 'user_id']);
        expect(c.type).toBe('profile_update');
        expect(c.user_id).toBe(ALICE);
        expect((c.activity_key as { kid: string }).kid).toBe(out.kid);
        expect(c).not.toHaveProperty('avatar_attachment_id');
    });

    it('a friend already holding the current key is not sent it again (no network at all)', async () => {
        await K.shareActivityKey(ALICE, [BOB], targets(BOB), deps().d);
        const { d, sent } = deps();
        await K.shareActivityKey(ALICE, [BOB], targets(BOB), d);
        expect(sent).toEqual([]);
    });

    it('a 429 stops the round and asks for a retry; a failure is retried; skipped (no device) is not recorded', async () => {
        const { d } = deps({ send: async t => (t.userId === BOB ? 'throttled' : 'sent') });
        const out = await K.shareActivityKey(ALICE, [BOB, CAROL], targets(BOB, CAROL), d);
        expect(out.retry).toBe(true);
        expect(out.sent).toEqual([]);
        const { d: d2 } = deps({ send: async t => (t.userId === BOB ? 'skipped' : 'failed') });
        const out2 = await K.shareActivityKey(ALICE, [BOB, CAROL], targets(BOB, CAROL), d2);
        expect(out2.failed).toEqual([CAROL]);
        expect(out2.retry).toBe(true);
        const { d: d3, sent } = deps();
        await K.shareActivityKey(ALICE, [BOB, CAROL], targets(BOB, CAROL), d3);
        expect(sent.map(s => s.to).sort()).toEqual([BOB, CAROL].sort());
    });
});

describe('receiving (friend side)', () => {
    const wire = (kid: string, key: string, user = ALICE) => ({ client_msg_id: 'm', type: 'profile_update', user_id: user, activity_key: { kid, key_b64: key } });

    it('strips the key from the content and files it - only from an accepted friend naming themselves', async () => {
        const { d, sent } = deps();
        const { kid } = await K.shareActivityKey(ALICE, [BOB], targets(BOB), d);
        const content = sent[0].content;
        const isFriend = (id: string) => id === ALICE;
        const out = K.takeActivityKey(content, { senderUserId: ALICE, myUserId: BOB, isFriend });
        expect(out).not.toHaveProperty('activity_key');
        expect(out).toMatchObject({ type: 'profile_update', user_id: ALICE });
        expect(K.friendActivityKey(BOB, ALICE, kid)).toBe((content.activity_key as { key_b64: string }).key_b64);
    });

    it('refuses: a non-friend, a sender naming someone else, ourselves, a malformed key - but always strips', () => {
        const good = K.currentActivityKey(MALLORY, [BOB], T0);
        const cases: Array<[unknown, string | null]> = [
            [wire(good.kid, good.keyB64, MALLORY), MALLORY], // not a friend
            [wire(good.kid, good.keyB64, ALICE), MALLORY], // claims to be Alice
            [wire(good.kid, good.keyB64, BOB), BOB], // ourselves
            [wire('zz', good.keyB64, ALICE), ALICE],
            [wire(good.kid, 'AAAA', ALICE), ALICE],
            [{ type: 'profile_update', user_id: ALICE, activity_key: 'x' }, ALICE],
        ];
        for (const [c, sender] of cases) {
            const out = K.takeActivityKey(c, { senderUserId: sender, myUserId: BOB, isFriend: id => id === ALICE });
            expect(out).not.toHaveProperty('activity_key');
        }
        expect(mem.get(K.friendActivityKeysStoreKey(BOB))).toBeUndefined();
    });

    it('anything else passes through untouched (same object)', () => {
        const text = { type: 'text', text: 'hi', activity_key: { kid: 'x' } };
        expect(K.takeActivityKey(text, { senderUserId: ALICE, myUserId: BOB, isFriend: () => true })).toBe(text);
        const pu = { type: 'profile_update', user_id: ALICE };
        expect(K.takeActivityKey(pu, { senderUserId: ALICE, myUserId: BOB, isFriend: () => true })).toBe(pu);
    });

    it('keeps a few keys per sharer (several devices / a rotation overlap), newest first', () => {
        const kids: string[] = [];
        for (let i = 0; i < K.FRIEND_KEYS_PER_SHARER + 2; i++) {
            const k = K.currentActivityKey(`${i}`, [], T0);
            kids.push(k.kid);
            K.fileFriendActivityKey(BOB, ALICE, k.kid, k.keyB64, T0 + i);
        }
        expect(K.friendActivityKey(BOB, ALICE, kids[kids.length - 1])).not.toBeNull();
        expect(K.friendActivityKey(BOB, ALICE, kids[0])).toBeNull();
    });

    it('notifies subscribers when a key lands (a waiting cover retries)', () => {
        const cb = vi.fn();
        const off = K.subscribeActivityKeys(cb);
        const k = K.currentActivityKey(ALICE, [], T0);
        K.fileFriendActivityKey(BOB, ALICE, k.kid, k.keyB64, T0);
        expect(cb).toHaveBeenCalled();
        off();
    });
});

describe('end to end: a cover only friends holding the CURRENT key can open', () => {
    it('Bob (friend) decrypts; Carol (removed, holds the old key) cannot; Mallory (never a friend) cannot', async () => {
        const isFriendOf = (me: string) => (id: string) => id === ALICE && me !== MALLORY;
        const deliver = async (friends: string[]) => {
            const { d, sent } = deps();
            const out = await K.shareActivityKey(ALICE, friends, targets(...friends), d);
            for (const s of sent) K.takeActivityKey(s.content, { senderUserId: ALICE, myUserId: s.to, isFriend: isFriendOf(s.to) });
            return out.kid;
        };
        await deliver([BOB, CAROL]);
        // Carol is removed: the next use rotates; the new key reaches Bob only.
        const kid2 = await deliver([BOB]);
        const key = K.currentActivityKey(ALICE, [BOB], T0);
        expect(key.kid).toBe(kid2);
        const coverId = newCoverId();
        const blob = (await encryptCover({ sharerUserId: ALICE, coverId, kid: key.kid, keyB64: key.keyB64, image: JPEG }))!;
        const open = (viewer: string) => decryptCover({ sharerUserId: ALICE, coverId, blob, keyFor: kid => K.friendActivityKey(viewer, ALICE, kid) });
        expect((await open(BOB))?.bytes).toEqual(JPEG);
        expect(await open(CAROL)).toBeNull();
        expect(await open(MALLORY)).toBeNull();
    });
});

describe('a cold store (right after sign-in, before this account is bound)', () => {
    it('creates, rotates, sends and files nothing, and asks for a retry', async () => {
        const s = fakeStore as typeof fakeStore & { isAccountReady?: (id: string) => boolean };
        s.isAccountReady = () => false;
        try {
            const { d, sent } = deps();
            const out = await K.shareActivityKey(ALICE, [BOB], targets(BOB), d);
            expect(out.retry).toBe(true);
            expect(sent).toEqual([]);
            const k = { kid: 'a'.repeat(16), key_b64: btoa(String.fromCharCode(...new Uint8Array(32))) };
            const stripped = K.takeActivityKey({ type: 'profile_update', user_id: ALICE, activity_key: k }, { senderUserId: ALICE, myUserId: BOB, isFriend: () => true });
            expect(stripped).not.toHaveProperty('activity_key');
            expect(mem.size).toBe(0);
        } finally { delete s.isAccountReady; }
    });
});

describe('audience for the publisher', () => {
    it('null until the hook sets a known list; a copy is kept', () => {
        K.setActivityAudience(null);
        expect(K.activityAudience()).toBeNull();
        const ids = [BOB];
        K.setActivityAudience(ids);
        ids.push(CAROL);
        expect(K.activityAudience()).toEqual([BOB]);
        K.setActivityAudience(null);
    });
describe('a key that arrives before the friends list has loaded', () => {
    const wireKey = () => {
        const k = K.currentActivityKey(ALICE, [BOB], T0);
        return { k, content: { type: 'profile_update', user_id: ALICE, activity_key: { kid: k.kid, key_b64: k.keyB64 } } };
    };
    beforeEach(() => { K.clearParkedActivityKeys(); });

    it('is parked, not dropped: filed once the list loads and shows the sender as a friend', () => {
        const { k, content } = wireKey();
        // Cold start: the offline backlog is pulled while /friends is still in flight (isFriend is false for everyone).
        const out = K.takeActivityKey(content, { senderUserId: ALICE, myUserId: BOB, isFriend: () => false, friendsLoaded: () => false });
        expect(out).not.toHaveProperty('activity_key');
        expect(K.friendActivityKey(BOB, ALICE, k.kid)).toBeNull();
        expect(K.releaseParkedActivityKeys(BOB, id => id === ALICE)).toBe(1);
        expect(K.friendActivityKey(BOB, ALICE, k.kid)).toBe(k.keyB64);
    });

    it('a parked key from someone who turns out not to be a friend is discarded', () => {
        const { k, content } = wireKey();
        K.takeActivityKey(content, { senderUserId: ALICE, myUserId: BOB, isFriend: () => false, friendsLoaded: () => false });
        expect(K.releaseParkedActivityKeys(BOB, () => false)).toBe(0);
        expect(K.friendActivityKey(BOB, ALICE, k.kid)).toBeNull();
        expect(K.releaseParkedActivityKeys(BOB, () => true)).toBe(0); // gone for good
    });

    it('a loaded list still refuses a non-friend outright, and parking checks the shape and the claimed sender', () => {
        const { k, content } = wireKey();
        K.takeActivityKey(content, { senderUserId: ALICE, myUserId: BOB, isFriend: () => false, friendsLoaded: () => true });
        K.takeActivityKey({ ...content, user_id: MALLORY }, { senderUserId: ALICE, myUserId: BOB, isFriend: () => true, friendsLoaded: () => false });
        K.takeActivityKey({ ...content, activity_key: { kid: 'zz', key_b64: 'x' } }, { senderUserId: ALICE, myUserId: BOB, isFriend: () => true, friendsLoaded: () => false });
        expect(K.releaseParkedActivityKeys(BOB, () => true)).toBe(0);
        expect(K.friendActivityKey(BOB, ALICE, k.kid)).toBeNull();
    });

    it('another account\'s parked keys are never filed for this one', () => {
        const { k, content } = wireKey();
        K.takeActivityKey(content, { senderUserId: ALICE, myUserId: BOB, isFriend: () => false, friendsLoaded: () => false });
        expect(K.releaseParkedActivityKeys(CAROL, () => true)).toBe(0);
        expect(K.friendActivityKey(CAROL, ALICE, k.kid)).toBeNull();
    });
});
});
