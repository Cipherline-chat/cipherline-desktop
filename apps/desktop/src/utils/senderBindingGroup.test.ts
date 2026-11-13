/**
 * Security audit run-2 (desktop-inbound-claimed-su-not-bound-to-conversation-
 * or-verdict + desktop-dm-ingest-claimed-su-gates-friend-only-profile-
 * controls): a group member M could sign an envelope with his OWN key, name
 * `su = V` (another member), and have every other member's desktop edit,
 * delete or post as V.
 *
 * Same shape as senderForgery.test.ts: the REAL crypto engine
 * (encryptForDevices / decryptEnvelope) builds and opens the forged envelope -
 * only the SecureStore is stood in - then the REAL binding decision and the
 * REAL applyIncomingDmMessages reducer run on it.
 *
 *   Act 1  the forgery decrypts as V, and the old pull path would have applied it
 *   Act 2  bindSender refuses it; nothing reaches the reducer
 *   Act 3  the legitimate paths (V's own edit, a just-joined member, a new
 *          device, a member who just left, a DM peer, my own other device) pass,
 *          and an unreachable roster HOLDS (never refuses, never acks)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'crypto';
import { ed25519 } from '@noble/curves/ed25519';

const store = new Map<string, string>();
vi.mock('../../electron/storage', () => ({
    secureStore: {
        get: (k: string) => store.get(k) ?? null,
        set: (k: string, v: string) => { store.set(k, v); },
        setDeferred: (k: string, v: string) => { store.set(k, v); },
        delete: (k: string) => { store.delete(k); },
        deleteDeferred: (k: string) => { store.delete(k); },
        batch: <T>(fn: () => T): T => fn(),
        keys: () => [...store.keys()],
    },
}));

const { encryptForDevices, decryptEnvelope } = await import('../../electron/e2ee-engine');
const deviceDirectory = await import('./deviceDirectory');
const { bindSender, ROSTER_REFRESH_MIN_MS, SENDER_BINDING_MAX_HOLD_MS } = await import('./senderBinding');
const { applyIncomingDmMessages } = await import('./dmInbound');

function x25519Pair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
    const privJwk = privateKey.export({ format: 'jwk' }) as { d: string };
    const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string };
    return {
        privHex: Buffer.from(privJwk.d, 'base64url').toString('hex'),
        pubB64: Buffer.from(pubJwk.x, 'base64url').toString('base64'),
    };
}
function ed25519Pair() {
    const priv = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(priv);
    return { privHex: Buffer.from(priv).toString('hex'), pubB64: Buffer.from(pub).toString('base64') };
}

const R = 'rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr'; // the recipient (me)
const V = 'vvvvvvvv-vvvv-4vvv-8vvv-vvvvvvvvvvvv'; // the victim member
const M = 'mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm'; // the malicious member
const J = 'jjjjjjjj-jjjj-4jjj-8jjj-jjjjjjjjjjjj'; // a member who just joined
const GROUP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const R_DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01';

function makeRecipient() {
    const identity = ed25519Pair();
    const spk = x25519Pair();
    const spkSig = Buffer.from(ed25519.sign(Buffer.from(spk.pubB64, 'base64'), Buffer.from(identity.privHex, 'hex'))).toString('base64');
    return {
        devicePub: { device_id: R_DEVICE, spk_pub_b64: spk.pubB64, sig_b64: spkSig, identity_pub_b64: identity.pubB64 },
        spkCandidates: [{ id: 1, privHex: spk.privHex, pubB64: spk.pubB64 }],
    };
}

/** Sign as `who` (sets the engine's identity), claiming `claimedSu`. */
async function envelopeFrom(signer: { privHex: string; pubB64: string }, claimedSu: string, content: object, recipient: ReturnType<typeof makeRecipient>) {
    store.set('identity_priv', signer.privHex);
    store.set('identity_pub', signer.pubB64);
    const enc = await encryptForDevices(JSON.stringify(content), claimedSu, [recipient.devicePub]);
    return decryptEnvelope(enc.envelope_b64, R_DEVICE, recipient.spkCandidates);
}

const entry = (user_id: string, pub: string, n = 1) => ({ user_id, device_id: `dev-${user_id.slice(0, 1)}-${n}`, identity_pub_b64: pub });

/** The deps the Dashboard builds, over the REAL roster store; `serve` is what
 *  GET /conversations/:id/devices would answer on a refresh (null = unreachable). */
function deps(serve: () => ReturnType<typeof entry>[] | null, convs: Record<string, { type?: string; other_user_id?: string | null }> = { [GROUP]: { type: 'group' } }) {
    const refresh = vi.fn(async (id: string) => {
        const rows = serve();
        if (!rows) return false;
        deviceDirectory.recordConversationRoster(id, rows);
        return true;
    });
    return {
        refresh,
        d: {
            myUserId: R,
            conversation: (id: string) => convs[id],
            judge: deviceDirectory.conversationRosterJudgment,
            rosterAgeMs: deviceDirectory.conversationRosterAgeMs,
            refreshRoster: refresh,
        },
    };
}

beforeEach(() => {
    store.clear();
    deviceDirectory._reset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe('Act 1 - the forgery, on the real engine and the real reducer', () => {
    it('decrypts as V although M signed it, and the old attribution lets it rewrite V\'s message', async () => {
        const r = makeRecipient();
        const m = ed25519Pair();
        const forged = await envelopeFrom(m, V, { type: 'edit', client_msg_id: crypto.randomUUID(), target_id: 'v-msg-1', text: 'forged text' }, r);
        expect(forged.senderUserId).toBe(V);
        expect(forged.senderPub).toBe(m.pubB64);

        // What the pull loop did before: store/apply with sender_user_id = the claim.
        const threads = { [GROUP]: [{ id: 'v-msg-1', content: { type: 'text', text: 'genuine' }, sender_user_id: V, sender_device_id: '' }] };
        const applied = applyIncomingDmMessages(threads, { [GROUP]: [{ id: 'e1', content: JSON.parse(forged.contentJson), sender_user_id: forged.senderUserId!, sender_device_id: '' }] });
        expect(applied[GROUP][0].content.text).toBe('forged text'); // the bug
    });
});

describe('Act 2 - bindSender stops it before anything reads the claim', () => {
    it('M signs with his own key and names V -> refuse (V is listed, but not with M\'s key)', async () => {
        const r = makeRecipient();
        const v = ed25519Pair(); const m = ed25519Pair();
        const roster = [entry(V, v.pubB64), entry(M, m.pubB64)];
        deviceDirectory.recordConversationRoster(GROUP, roster);
        const forged = await envelopeFrom(m, V, { type: 'delete', client_msg_id: crypto.randomUUID(), target_id: 'v-msg-1' }, r);

        vi.setSystemTime(Date.now() + ROSTER_REFRESH_MIN_MS + 1); // roster old enough to be re-asked
        const { d, refresh } = deps(() => roster);
        const result = await bindSender(d, { conversationId: GROUP, senderUserId: forged.senderUserId, senderPub: forged.senderPub });
        expect(result).toBe('refuse');
        expect(refresh).toHaveBeenCalledTimes(1); // it did re-ask before refusing
    });

    it('M names a user who is not in the conversation at all -> refuse', async () => {
        const m = ed25519Pair(); const v = ed25519Pair();
        const roster = [entry(M, m.pubB64)]; // V is not in this group
        deviceDirectory.recordConversationRoster(GROUP, roster);
        vi.setSystemTime(Date.now() + ROSTER_REFRESH_MIN_MS + 1);
        const { d } = deps(() => roster);
        await expect(bindSender(d, { conversationId: GROUP, senderUserId: V, senderPub: v.pubB64 })).resolves.toBe('refuse');
    });

    it('DM: a sender that is neither me nor the DM peer -> refuse, with no network', async () => {
        const dm = 'dm-1';
        const { d, refresh } = deps(() => null, { [dm]: { type: 'dm', other_user_id: V } });
        await expect(bindSender(d, { conversationId: dm, senderUserId: M, senderPub: 'x' })).resolves.toBe('refuse');
        expect(refresh).not.toHaveBeenCalled();
    });

    it('the reducer applies nothing when the pull loop refuses (control content is dropped, not applied)', async () => {
        const threads = { [GROUP]: [{ id: 'v-msg-1', content: { type: 'text', text: 'genuine' }, sender_user_id: V, sender_device_id: '' }] };
        const applied = applyIncomingDmMessages(threads, {}); // refused -> never reaches the reducer
        expect(applied[GROUP][0].content.text).toBe('genuine');
    });
});

describe('Act 3 - legitimate senders are not rejected', () => {
    it('V\'s own edit (V\'s key under V) -> ok, and the reducer applies it', async () => {
        const r = makeRecipient();
        const v = ed25519Pair(); const m = ed25519Pair();
        deviceDirectory.recordConversationRoster(GROUP, [entry(V, v.pubB64), entry(M, m.pubB64)]);
        const real = await envelopeFrom(v, V, { type: 'edit', client_msg_id: crypto.randomUUID(), target_id: 'v-msg-1', text: 'genuine edit' }, r);
        const { d, refresh } = deps(() => null);
        await expect(bindSender(d, { conversationId: GROUP, senderUserId: real.senderUserId, senderPub: real.senderPub })).resolves.toBe('ok');
        expect(refresh).not.toHaveBeenCalled(); // already known: zero extra requests
        const threads = { [GROUP]: [{ id: 'v-msg-1', content: { type: 'text', text: 'old' }, sender_user_id: V, sender_device_id: '' }] };
        const applied = applyIncomingDmMessages(threads, { [GROUP]: [{ id: 'e', content: JSON.parse(real.contentJson), sender_user_id: real.senderUserId!, sender_device_id: '' }] });
        expect(applied[GROUP][0].content.text).toBe('genuine edit');
    });

    it('cold start (no roster yet): the roster is fetched once and the real sender passes', async () => {
        const v = ed25519Pair();
        const { d, refresh } = deps(() => [entry(V, v.pubB64)]);
        await expect(bindSender(d, { conversationId: GROUP, senderUserId: V, senderPub: v.pubB64 })).resolves.toBe('ok');
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('a member who JUST JOINED (roster is a few seconds old) is held, then accepted after the refresh window', async () => {
        const v = ed25519Pair(); const j = ed25519Pair();
        deviceDirectory.recordConversationRoster(GROUP, [entry(V, v.pubB64)]);
        const joined = [entry(V, v.pubB64), entry(J, j.pubB64)];
        const { d, refresh } = deps(() => joined);

        vi.setSystemTime(Date.now() + 5_000);
        await expect(bindSender(d, { conversationId: GROUP, senderUserId: J, senderPub: j.pubB64 })).resolves.toBe('pending'); // not refused, not acked
        expect(refresh).not.toHaveBeenCalled(); // rate limit holds

        vi.setSystemTime(Date.now() + ROSTER_REFRESH_MIN_MS);
        await expect(bindSender(d, { conversationId: GROUP, senderUserId: J, senderPub: j.pubB64 })).resolves.toBe('ok');
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('a NEW DEVICE of an existing member (new key under the same user) is accepted after a refresh', async () => {
        const v1 = ed25519Pair(); const v2 = ed25519Pair();
        deviceDirectory.recordConversationRoster(GROUP, [entry(V, v1.pubB64, 1)]);
        vi.setSystemTime(Date.now() + ROSTER_REFRESH_MIN_MS + 1);
        const { d } = deps(() => [entry(V, v1.pubB64, 1), entry(V, v2.pubB64, 2)]);
        await expect(bindSender(d, { conversationId: GROUP, senderUserId: V, senderPub: v2.pubB64 })).resolves.toBe('ok');
    });

    it('a member who sent a message and then LEFT is still recognised from the roster this session saw', async () => {
        const v = ed25519Pair(); const x = ed25519Pair(); const X = 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx';
        deviceDirectory.recordConversationRoster(GROUP, [entry(V, v.pubB64), entry(X, x.pubB64)]);
        vi.setSystemTime(Date.now() + ROSTER_REFRESH_MIN_MS + 1);
        deviceDirectory.recordConversationRoster(GROUP, [entry(V, v.pubB64)]); // X has left; the new roster omits X
        vi.setSystemTime(Date.now() + 1_000);
        const { d } = deps(() => [entry(V, v.pubB64)]);
        await expect(bindSender(d, { conversationId: GROUP, senderUserId: X, senderPub: x.pubB64 })).resolves.toBe('ok');
    });

    it('an unreachable roster HOLDS the envelope (pending) instead of refusing or dropping it', async () => {
        const v = ed25519Pair();
        const { d, refresh } = deps(() => null);
        await expect(bindSender(d, { conversationId: GROUP, senderUserId: V, senderPub: v.pubB64 })).resolves.toBe('pending');
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(SENDER_BINDING_MAX_HOLD_MS).toBeLessThan(5 * 60_000); // below the HeldBackEnvelopes TTL it is parked in
    });

    it('DM: the peer passes locally; a conversation not listed yet falls through to the roster', async () => {
        const dm = 'dm-1';
        const peer = ed25519Pair();
        const { d, refresh } = deps(() => [entry(V, peer.pubB64)], { [dm]: { type: 'dm', other_user_id: V } });
        await expect(bindSender(d, { conversationId: dm, senderUserId: V, senderPub: peer.pubB64 })).resolves.toBe('ok');
        expect(refresh).not.toHaveBeenCalled();
        // A DM this client has not listed yet (peer's first message): the roster decides.
        await expect(bindSender(d, { conversationId: 'dm-new', senderUserId: V, senderPub: peer.pubB64 })).resolves.toBe('ok');
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('my own other device (self fan-out) is not subjected to the roster at all', async () => {
        const { d, refresh } = deps(() => null);
        await expect(bindSender(d, { conversationId: GROUP, senderUserId: R, senderPub: 'my-other-device' })).resolves.toBe('ok');
        expect(refresh).not.toHaveBeenCalled();
    });

    it('no claimed sender -> nothing to bind (stored unattributed, as before)', async () => {
        const { d } = deps(() => null);
        await expect(bindSender(d, { conversationId: GROUP, senderUserId: undefined, senderPub: 'x' })).resolves.toBe('ok');
    });
});

describe('the roster is learned from the directory responses the app already makes', () => {
    it('captures GET /conversations/:id/devices (with or without ?claim_otp=1) per conversation, nothing else', async () => {
        let intercept: (res: unknown) => unknown = r => r;
        const host = { interceptors: { response: { use: (fn: (res: unknown) => unknown) => { intercept = fn; return 1; }, eject: () => {} } } };
        deviceDirectory.installDirectoryCapture(host);
        const v = ed25519Pair();
        intercept({ config: { url: `https://api.example/v1/conversations/${GROUP}/devices?claim_otp=1` }, data: [entry(V, v.pubB64)] });
        expect(deviceDirectory.conversationRosterJudgment(GROUP, V, v.pubB64)).toBe('member');
        // The same user is NOT thereby a member of another conversation.
        expect(deviceDirectory.conversationRosterJudgment('cccccccc-cccc-4ccc-8ccc-ccccccccccc2', V, v.pubB64)).toBe('no-roster');
        // A full-user key listing says nothing about conversations.
        intercept({ config: { url: `https://api.example/v1/keys/identity_keys?user_id=${M}` }, data: [entry(M, v.pubB64)] });
        expect(deviceDirectory.conversationRosterJudgment(GROUP, M, v.pubB64)).toBe('not-member');
    });
});
