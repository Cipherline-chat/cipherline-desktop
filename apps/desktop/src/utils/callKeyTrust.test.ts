/**
 * Call keys from a VERIFIED contact's UNVERIFIED device: warn only (owner
 * decision 2026-11-25, matching the phones) — utils/callKeyTrust.ts.
 *
 * Three layers:
 *   1. the decision table (`decideCallKeyTrust`) — exactly one case moves
 *      from reject to accept_warn; every other refusal stays;
 *   2. the call path (`routeIncomingCallKey`) against the REAL CallKeyStore
 *      and the REAL call-key gate: the warn case CONNECTS, the refused cases
 *      stay blocked;
 *   3. end to end through the real crypto engine + pin store + directory:
 *      a real `call_key` envelope from Bob's new, published, unverified device
 *      is adopted with a warning; a forged one (unpublished device, omitted
 *      `sd`, no directory evidence) and a changed key on Bob's verified device
 *      are still refused.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
const mem = new Map<string, string>();
vi.mock('./secureLocalStore', () => ({
    secureLocalStore: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => { mem.set(k, v); },
    },
}));

const { encryptForDevices, decryptEnvelope } = await import('../../electron/e2ee-engine');
const { markVerified, recordFirstSeen } = await import('./keyVerification');
const { evaluateSender, actionFor } = await import('./senderTrust');
const deviceDirectory = await import('./deviceDirectory');
const { decideCallKeyTrust, routeIncomingCallKey, routeIncomingKeyRequest, callKeyWarningNotice, CallKeyWarnings } = await import('./callKeyTrust');
const { decideKeyRequestResponse, KeyResponseLimiter } = await import('./callKeyShare');
const { CallKeyStore } = await import('./callKeyStore');
const { resolveCallKeyGate } = await import('./callKeyGate');
type CallKeyTrustInput = import('./callKeyTrust').CallKeyTrustInput;

const ALICE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ALICE_DEVICE = 'dddddddd-dddd-dddd-dddd-ddddddddddd1';
const BOB_LAPTOP = 'dddddddd-dddd-dddd-dddd-ddddddddddd2'; // verified
const BOB_NEW_PHONE = 'dddddddd-dddd-dddd-dddd-ddddddddddd3'; // new, unverified, published
const FORGED_DEVICE = 'ffffffff-ffff-ffff-ffff-fffffffffff1';
const CONV = 'conv-dm-1';
const CALL = 'call-1';
const KEY = Buffer.alloc(32, 7).toString('base64');

beforeEach(() => {
    store.clear();
    mem.clear();
    deviceDirectory._reset();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. The decision table
// ═══════════════════════════════════════════════════════════════════════════

const warnCase: CallKeyTrustInput = {
    verdict: 'unrecognized_verified',
    senderUserId: BOB,
    selfUserId: ALICE,
    senderDeviceId: BOB_NEW_PHONE,
    directory: 'match',
};

describe('decideCallKeyTrust', () => {
    it('ACCEPTS WITH A WARNING a verified contact\'s new, unverified device the directory publishes', () => {
        expect(decideCallKeyTrust(warnCase)).toBe('accept_warn');
        // …which is exactly the case actionFor alone refuses (the 2026-11-25 hang).
        expect(actionFor('unrecognized_verified', 'key_material')).toBe('reject');
    });

    it('accepts ok / first_contact outright, as before', () => {
        expect(decideCallKeyTrust({ ...warnCase, verdict: 'ok' })).toBe('accept');
        expect(decideCallKeyTrust({ ...warnCase, verdict: 'first_contact' })).toBe('accept');
        // Even with no directory evidence: unchanged TOFU behaviour.
        expect(decideCallKeyTrust({ ...warnCase, verdict: 'first_contact', directory: 'unknown' })).toBe('accept');
    });

    it('still REFUSES a changed identity key (a device you have seen, verified or not, presenting another key)', () => {
        expect(decideCallKeyTrust({ ...warnCase, verdict: 'key_changed' })).toBe('reject');
    });

    it('still REFUSES a key the directory contradicts (unattributed)', () => {
        expect(decideCallKeyTrust({ ...warnCase, verdict: 'unattributed', directory: 'mismatch' })).toBe('reject');
        expect(decideCallKeyTrust({ ...warnCase, verdict: 'unattributed' })).toBe('reject');
    });

    it('still REFUSES when there is no verdict (no usable sender identity)', () => {
        expect(decideCallKeyTrust({ ...warnCase, verdict: null })).toBe('reject');
        expect(decideCallKeyTrust({ ...warnCase, verdict: undefined })).toBe('reject');
    });

    it('still REFUSES unrecognized_verified without a positive directory match for that device', () => {
        expect(decideCallKeyTrust({ ...warnCase, directory: 'unknown' })).toBe('reject');
        expect(decideCallKeyTrust({ ...warnCase, directory: 'mismatch' })).toBe('reject');
    });

    it('still REFUSES unrecognized_verified with no device id (the F1 sd-omission shape)', () => {
        expect(decideCallKeyTrust({ ...warnCase, senderDeviceId: undefined })).toBe('reject');
        expect(decideCallKeyTrust({ ...warnCase, senderDeviceId: null })).toBe('reject');
        expect(decideCallKeyTrust({ ...warnCase, senderDeviceId: '' })).toBe('reject');
        expect(decideCallKeyTrust({ ...warnCase, senderDeviceId: '   ' })).toBe('reject');
    });

    it('never applies the carve-out to this account or to a missing sender', () => {
        expect(decideCallKeyTrust({ ...warnCase, senderUserId: ALICE })).toBe('reject');
        expect(decideCallKeyTrust({ ...warnCase, senderUserId: null })).toBe('reject');
        expect(decideCallKeyTrust({ ...warnCase, selfUserId: '' })).toBe('reject');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The call path: decision → real CallKeyStore → real call-key gate
// ═══════════════════════════════════════════════════════════════════════════

function runPath(input: CallKeyTrustInput, opts: { senderIsMember?: boolean } = {}) {
    const keys = new CallKeyStore();
    const warnings = new CallKeyWarnings();
    let refused = 0;
    const trust = routeIncomingCallKey(input, {
        adopt: () => keys.recordRemote({
            conversationId: CONV, callId: CALL, keyB64: KEY, epoch: 1,
            senderUserId: input.senderUserId!, senderIsMember: opts.senderIsMember, keyId: 'initial',
        }),
        onWarned: () => warnings.note({ conversationId: CONV, callId: CALL, senderUserId: input.senderUserId!, kind: 'received' }),
        onRefused: () => { refused += 1; },
    });
    // What Dashboard feeds the DM/group gate: the store's key for the call.
    const gate = resolveCallKeyGate({
        channelId: null,
        deliveredKeyB64: keys.get(CONV, CALL) || null,
        status: 'idle',
        keyB64: null,
        keyChannelId: null,
        lastGoodKeyB64: null,
        lastGoodChannelId: null,
        waitingSinceMs: 0,
        nowMs: 1,
    });
    return { trust, gate, warning: warnings.get(CONV, CALL), refused };
}

describe('routeIncomingCallKey — the call connects in the warn case', () => {
    it('warn case: the key is adopted, the call gate CONNECTS on it, and the warning is recorded', () => {
        const r = runPath(warnCase);
        expect(r.trust).toBe('accept_warn');
        expect(r.gate).toEqual({ kind: 'connect', keyB64: KEY, degraded: false });
        expect(r.warning).toMatchObject({ senderUserId: BOB, kind: 'received' });
        expect(r.refused).toBe(0);
    });

    it('a trusted key connects with NO warning', () => {
        const r = runPath({ ...warnCase, verdict: 'ok' });
        expect(r.gate.kind).toBe('connect');
        expect(r.warning).toBeNull();
    });

    it.each([
        ['key_changed', { verdict: 'key_changed' as const }],
        ['unattributed', { verdict: 'unattributed' as const, directory: 'mismatch' as const }],
        ['no directory evidence', { directory: 'unknown' as const }],
        ['no device id', { senderDeviceId: undefined }],
        ['self claim', { senderUserId: ALICE }],
        ['no verdict', { verdict: null }],
    ])('refused case (%s): nothing adopted, the gate stays BLOCKED, refusal path taken', (_label, patch) => {
        const r = runPath({ ...warnCase, ...patch });
        expect(r.trust).toBe('reject');
        expect(r.gate.kind).toBe('blocked');
        expect(r.warning).toBeNull();
        expect(r.refused).toBe(1);
    });

    it('a sender known NOT to be in the conversation is still refused by the store, and no warning is shown for a key not in use', () => {
        const r = runPath(warnCase, { senderIsMember: false });
        expect(r.trust).toBe('accept_warn');
        expect(r.gate.kind).toBe('blocked');
        expect(r.warning).toBeNull();
    });
});

describe('callKeyWarningNotice', () => {
    it('names the person, says the device is unverified, and never claims the call is unencrypted', () => {
        const n = callKeyWarningNotice('Sam');
        expect(n.title).toBe("Sam is calling from a new device you haven't verified");
        expect(n.body).toContain('not this device');
        expect(n.body.toLowerCase()).not.toContain('unencrypted');
        expect(callKeyWarningNotice('  ').title.startsWith('The caller ')).toBe(true);
    });
    it('a late joiner (key SENT to the device) says it joined and was given the key', () => {
        const n = callKeyWarningNotice('Sam', 'sent');
        expect(n.title).toBe("Sam joined from a new device you haven't verified");
        expect(n.body).toContain('was given it');
        expect(n.body.toLowerCase()).not.toContain('unencrypted');
        expect(callKeyWarningNotice('', 'sent').title.startsWith('Someone ')).toBe(true);
    });
});

describe('CallKeyWarnings', () => {
    const T0 = 1_700_000_000_000;
    it('remembers which way the key went, per (conversation, call); latest wins; clear forgets', () => {
        const w = new CallKeyWarnings();
        w.note({ conversationId: CONV, callId: CALL, senderUserId: BOB, kind: 'sent', nowMs: T0 });
        expect(w.get(CONV, CALL, T0)).toMatchObject({ senderUserId: BOB, kind: 'sent' });
        expect(w.get(CONV, 'other', T0)).toBeNull();
        w.note({ conversationId: CONV, callId: CALL, senderUserId: BOB, kind: 'received', nowMs: T0 + 1 });
        expect(w.get(CONV, CALL, T0 + 1)?.kind).toBe('received');
        w.clear(CONV, CALL);
        expect(w.get(CONV, CALL, T0 + 1)).toBeNull();
    });
    it('expires with the refusal TTL and ignores incomplete input', () => {
        const w = new CallKeyWarnings();
        w.note({ conversationId: CONV, callId: CALL, senderUserId: BOB, kind: 'sent', nowMs: T0 });
        expect(w.get(CONV, CALL, T0 + 31 * 60_000)).toBeNull();
        w.note({ conversationId: '', callId: CALL, senderUserId: BOB, kind: 'sent', nowMs: T0 });
        w.note({ conversationId: CONV, callId: 'x', senderUserId: '', kind: 'sent', nowMs: T0 });
        expect(w.get('', CALL, T0)).toBeNull();
        expect(w.get(CONV, 'x', T0)).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2b. ANSWERING a call_key_request (late joiners, owner 2026-11-25)
// ═══════════════════════════════════════════════════════════════════════════

/** decision → the REAL responder rules (decideKeyRequestResponse), as handleKeyRequest applies them. */
function runRequest(input: CallKeyTrustInput, opts: { requesterIsMember?: boolean; holdsKey?: boolean; connected?: boolean } = {}) {
    const warnings = new CallKeyWarnings();
    let answered = 0;
    const limiter = new KeyResponseLimiter();
    const r = routeIncomingKeyRequest(input, {
        answer: senderTrusted => {
            const d = decideKeyRequestResponse({
                connectedCallId: opts.connected === false ? null : CALL,
                requestedCallId: CALL,
                holdsAcceptedKey: opts.holdsKey ?? true,
                senderTrusted,
                requesterIsMember: opts.requesterIsMember,
                requesterDeviceId: input.senderDeviceId,
                myDeviceId: ALICE_DEVICE,
                nowMs: 1,
                limiter,
            });
            if (!d.respond) return d.reason;
            answered += 1;
            return 'scheduled';
        },
        onWarned: () => warnings.note({ conversationId: CONV, callId: CALL, senderUserId: input.senderUserId!, kind: 'sent' }),
    });
    return { ...r, answered, warning: warnings.get(CONV, CALL) };
}

describe('routeIncomingKeyRequest — a late joiner on a verified contact\'s new device', () => {
    it('warn case: the key request is ANSWERED and the call warns that the device was given the key', () => {
        const r = runRequest(warnCase, { requesterIsMember: true });
        expect(r.trust).toBe('accept_warn');
        expect(r.outcome).toBe('scheduled');
        expect(r.answered).toBe(1);
        expect(r.warning).toMatchObject({ senderUserId: BOB, kind: 'sent' });
    });

    it('a trusted requester is answered with NO warning', () => {
        const r = runRequest({ ...warnCase, verdict: 'ok' });
        expect(r.outcome).toBe('scheduled');
        expect(r.warning).toBeNull();
    });

    it.each([
        ['key_changed', { verdict: 'key_changed' as const }],
        ['unattributed', { verdict: 'unattributed' as const, directory: 'mismatch' as const }],
        ['unlisted device (no directory evidence)', { directory: 'unknown' as const }],
        ['missing device id', { senderDeviceId: undefined }],
        ['own-account claim', { senderUserId: ALICE }],
        ['no verdict', { verdict: null }],
    ])('refused case (%s): not answered (untrusted), no warning', (_label, patch) => {
        const r = runRequest({ ...warnCase, ...patch });
        expect(r.trust).toBe('reject');
        expect(r.outcome).toBe('untrusted');
        expect(r.answered).toBe(0);
        expect(r.warning).toBeNull();
    });

    it('a known NON-member is still not answered, and nothing is warned', () => {
        const r = runRequest(warnCase, { requesterIsMember: false });
        expect(r.trust).toBe('accept_warn');
        expect(r.outcome).toBe('not_member');
        expect(r.answered).toBe(0);
        expect(r.warning).toBeNull();
    });

    it('the other answer rules still apply (not connected / no accepted key): no answer, no warning', () => {
        expect(runRequest(warnCase, { connected: false })).toMatchObject({ outcome: 'not_connected', answered: 0, warning: null });
        expect(runRequest(warnCase, { holdsKey: false })).toMatchObject({ outcome: 'no_accepted_key', answered: 0, warning: null });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. End to end: real envelopes through the real engine and trust layer
// ═══════════════════════════════════════════════════════════════════════════

function x25519Pair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
    const privJwk = privateKey.export({ format: 'jwk' }) as { d: string };
    const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string };
    return { privHex: Buffer.from(privJwk.d, 'base64url').toString('hex'), pubB64: Buffer.from(pubJwk.x, 'base64url').toString('base64') };
}
function ed25519Pair() {
    const priv = ed25519.utils.randomSecretKey();
    return { privHex: Buffer.from(priv).toString('hex'), pubB64: Buffer.from(ed25519.getPublicKey(priv)).toString('base64') };
}
function makeAlice() {
    const identity = ed25519Pair();
    const spk = x25519Pair();
    const sig = Buffer.from(ed25519.sign(Buffer.from(spk.pubB64, 'base64'), Buffer.from(identity.privHex, 'hex'))).toString('base64');
    return {
        devicePub: { device_id: ALICE_DEVICE, spk_pub_b64: spk.pubB64, sig_b64: sig, identity_pub_b64: identity.pubB64 },
        spkCandidates: [{ id: 1, privHex: spk.privHex, pubB64: spk.pubB64 }],
    };
}

/** Send a call_key as `sender` claiming `claimedDevice` (undefined = omit sd), and run Alice's whole receive-side judgement. */
async function receiveCallKey(alice: ReturnType<typeof makeAlice>, sender: { privHex: string; pubB64: string }, claimedDevice: string | undefined) {
    store.set('identity_priv', sender.privHex);
    store.set('identity_pub', sender.pubB64);
    const sent = await encryptForDevices(
        JSON.stringify({ type: 'call_key', call_id: CALL, e2ee_key_b64: KEY, epoch: 1, key_id: 'initial', rotates_at: new Date(Date.now() + 600_000).toISOString() }),
        BOB, [alice.devicePub], claimedDevice,
    );
    const d = decryptEnvelope(sent.envelope_b64, ALICE_DEVICE, alice.spkCandidates);
    const directory = deviceDirectory.status(d.senderUserId!, d.senderPub!, d.senderDeviceId);
    const verdict = evaluateSender({ myUserId: ALICE, theirUserId: d.senderUserId!, senderPub: d.senderPub!, senderDeviceId: d.senderDeviceId, directory });
    const r = runPath({ verdict, senderUserId: d.senderUserId, selfUserId: ALICE, senderDeviceId: d.senderDeviceId, directory });
    return { verdict, directory, ...r };
}

describe('end to end — a verified contact calls from a new device', () => {
    let alice: ReturnType<typeof makeAlice>;
    let laptop: ReturnType<typeof ed25519Pair>;
    let phone: ReturnType<typeof ed25519Pair>;
    beforeEach(() => {
        alice = makeAlice();
        laptop = ed25519Pair();
        phone = ed25519Pair();
        // Alice verified Bob's laptop's safety number before the phone existed.
        recordFirstSeen(ALICE, BOB, laptop.pubB64, BOB_LAPTOP);
        markVerified(ALICE, BOB, laptop.pubB64, BOB_LAPTOP);
        // The server's directory publishes both of Bob's devices.
        deviceDirectory.recordFullUser(BOB, [
            { device_id: BOB_LAPTOP, identity_key_pub_b64: laptop.pubB64 },
            { device_id: BOB_NEW_PHONE, identity_key_pub_b64: phone.pubB64 },
        ]);
    });

    it('the new phone\'s call key is ADOPTED and the call connects, with the warning', async () => {
        const r = await receiveCallKey(alice, phone, BOB_NEW_PHONE);
        expect(r.verdict).toBe('unrecognized_verified');
        expect(r.directory).toBe('match');
        expect(r.trust).toBe('accept_warn');
        expect(r.gate.kind).toBe('connect');
        expect(r.warning?.kind).toBe('received');
    });

    it('the verified laptop connects with no warning', async () => {
        const r = await receiveCallKey(alice, laptop, BOB_LAPTOP);
        expect(r.verdict).toBe('ok');
        expect(r.trust).toBe('accept');
        expect(r.warning).toBeNull();
    });

    it('a forged device the server does NOT publish is still refused (unattributed)', async () => {
        const r = await receiveCallKey(alice, ed25519Pair(), FORGED_DEVICE);
        expect(r.verdict).toBe('unattributed');
        expect(r.trust).toBe('reject');
        expect(r.gate.kind).toBe('blocked');
    });

    it('the new phone\'s own key with `sd` OMITTED is still refused', async () => {
        const r = await receiveCallKey(alice, phone, undefined);
        expect(r.verdict).toBe('unrecognized_verified');
        expect(r.trust).toBe('reject');
        expect(r.gate.kind).toBe('blocked');
    });

    it('with no directory evidence at all (lookup failed) an unverified device is still refused', async () => {
        deviceDirectory._reset();
        const r = await receiveCallKey(alice, phone, BOB_NEW_PHONE);
        expect(r.directory).toBe('unknown');
        expect(r.verdict).toBe('unrecognized_verified');
        expect(r.trust).toBe('reject');
    });

    it('a CHANGED key on the verified laptop is still refused — even when the server publishes the new key', async () => {
        const swap = ed25519Pair();
        deviceDirectory.recordFullUser(BOB, [
            { device_id: BOB_LAPTOP, identity_key_pub_b64: swap.pubB64 },
            { device_id: BOB_NEW_PHONE, identity_key_pub_b64: phone.pubB64 },
        ]);
        const r = await receiveCallKey(alice, swap, BOB_LAPTOP);
        expect(r.directory).toBe('match');
        expect(r.verdict).toBe('key_changed');
        expect(r.trust).toBe('reject');
        expect(r.gate.kind).toBe('blocked');
    });

    it('the phone presenting a key different from the one pinned for it is refused (key_changed on an unverified device)', async () => {
        recordFirstSeen(ALICE, BOB, phone.pubB64, BOB_NEW_PHONE);
        const swapped = ed25519Pair();
        deviceDirectory.recordFullUser(BOB, [
            { device_id: BOB_LAPTOP, identity_key_pub_b64: laptop.pubB64 },
            { device_id: BOB_NEW_PHONE, identity_key_pub_b64: swapped.pubB64 },
        ]);
        const r = await receiveCallKey(alice, swapped, BOB_NEW_PHONE);
        expect(r.verdict).toBe('key_changed');
        expect(r.trust).toBe('reject');
    });

    it('the new phone\'s real call_key_REQUEST is answered, with the late-joiner warning', async () => {
        const r = await receiveKeyRequest(alice, phone, BOB_NEW_PHONE);
        expect(r.verdict).toBe('unrecognized_verified');
        expect(r.trust).toBe('accept_warn');
        expect(r.outcome).toBe('scheduled');
        expect(r.warning?.kind).toBe('sent');
    });

    it('a real key request from a forged unlisted device, or with sd omitted, or with a changed laptop key, is not answered', async () => {
        expect((await receiveKeyRequest(alice, ed25519Pair(), FORGED_DEVICE)).outcome).toBe('untrusted');
        expect((await receiveKeyRequest(alice, phone, undefined)).outcome).toBe('untrusted');
        const swap = ed25519Pair();
        deviceDirectory.recordFullUser(BOB, [
            { device_id: BOB_LAPTOP, identity_key_pub_b64: swap.pubB64 },
            { device_id: BOB_NEW_PHONE, identity_key_pub_b64: phone.pubB64 },
        ]);
        const changed = await receiveKeyRequest(alice, swap, BOB_LAPTOP);
        expect(changed.verdict).toBe('key_changed');
        expect(changed.outcome).toBe('untrusted');
    });
});

/** A real call_key_request envelope from `sender`, judged and routed exactly as the Dashboard request branch does. */
async function receiveKeyRequest(alice: ReturnType<typeof makeAlice>, sender: { privHex: string; pubB64: string }, claimedDevice: string | undefined) {
    store.set('identity_priv', sender.privHex);
    store.set('identity_pub', sender.pubB64);
    const sent = await encryptForDevices(
        JSON.stringify({ type: 'call_key_request', call_id: CALL, client_msg_id: 'req-1' }),
        BOB, [alice.devicePub], claimedDevice,
    );
    const d = decryptEnvelope(sent.envelope_b64, ALICE_DEVICE, alice.spkCandidates);
    expect(JSON.parse(d.contentJson).type).toBe('call_key_request');
    const directory = deviceDirectory.status(d.senderUserId!, d.senderPub!, d.senderDeviceId);
    const verdict = evaluateSender({ myUserId: ALICE, theirUserId: d.senderUserId!, senderPub: d.senderPub!, senderDeviceId: d.senderDeviceId, directory });
    const r = runRequest({ verdict, senderUserId: d.senderUserId, selfUserId: ALICE, senderDeviceId: d.senderDeviceId, directory }, { requesterIsMember: true });
    return { verdict, directory, ...r };
}
