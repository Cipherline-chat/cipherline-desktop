/**
 * F1 — envelopes that claim to come from the RECIPIENT'S OWN account.
 *
 * Built like senderForgery.test.ts: the forgery is produced by the real engine
 * with only public inputs (the victim's published signed prekey), the victim's
 * real engine attributes it to the victim's own user id, and the trust layer
 * (selfSenderTrust.ts + actionFor) is what must refuse it. Before the fix the
 * Dashboard returned "no verdict" for any `su === me` envelope and treated
 * that as accept — key material included.
 *
 * Positive controls: the user's genuine other devices (multi-device
 * self-fan-out) are accepted, both for content and for key material.
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

const { encryptForDevices, decryptEnvelope } = await import('../../electron/e2ee-engine');
const { evaluateSelfSender, selfContentRefused } = await import('./selfSenderTrust');
const { actionFor } = await import('./senderTrust');
const { applyObservation, applyConfirm } = await import('./ownDeviceLedger');

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

const ME = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const THIS_DEVICE = 'dddddddd-dddd-dddd-dddd-ddddddddddd1';
const MY_PHONE = 'dddddddd-dddd-dddd-dddd-ddddddddddd2';
const MY_NEW_LAPTOP = 'dddddddd-dddd-dddd-dddd-ddddddddddd3';
const FORGED_DEVICE = 'ffffffff-ffff-ffff-ffff-fffffffffff1';

function makeRecipient() {
    const identity = ed25519Pair();
    const spk = x25519Pair();
    const spkSig = Buffer.from(ed25519.sign(Buffer.from(spk.pubB64, 'base64'), Buffer.from(identity.privHex, 'hex'))).toString('base64');
    return {
        identity,
        devicePub: { device_id: THIS_DEVICE, spk_pub_b64: spk.pubB64, sig_b64: spkSig, identity_pub_b64: identity.pubB64 },
        spkCandidates: [{ id: 1, privHex: spk.privHex, pubB64: spk.pubB64 }],
    };
}

/** Send `content` as `su = ME` from a process holding `senderIdentity`. */
async function sendAsMe(recipient: ReturnType<typeof makeRecipient>, senderIdentity: { privHex: string; pubB64: string }, sd: string, content: unknown) {
    store.set('identity_priv', senderIdentity.privHex);
    store.set('identity_pub', senderIdentity.pubB64);
    const env = await encryptForDevices(JSON.stringify(content), ME, [recipient.devicePub], sd);
    return decryptEnvelope(env.envelope_b64, THIS_DEVICE, recipient.spkCandidates);
}

let recipient: ReturnType<typeof makeRecipient>;
let phone: ReturnType<typeof ed25519Pair>;
let ledger: ReturnType<typeof applyObservation>;
const self = () => ({ deviceId: THIS_DEVICE, pub: recipient.identity.pubB64 });

beforeEach(() => {
    store.clear();
    recipient = makeRecipient();
    phone = ed25519Pair();
    // The account's own-device ledger: this device + the phone, from a complete listing.
    ledger = applyObservation(null, self(), [
        { device_id: THIS_DEVICE, pub: recipient.identity.pubB64 },
        { device_id: MY_PHONE, pub: phone.pubB64 },
    ], true, 1);
});

const judge = (d: { senderPub: string; senderDeviceId?: string }, opts: { ledger?: typeof ledger | null; directory?: 'match' | 'mismatch' | 'unknown' } = {}) =>
    evaluateSelfSender({
        senderPub: d.senderPub,
        senderDeviceId: d.senderDeviceId,
        self: self(),
        ledger: opts.ledger === undefined ? ledger : opts.ledger,
        directory: opts.directory ?? 'unknown',
    });

describe('F1 — a forged "from myself" envelope', () => {
    it('Act 1: the engine attributes an attacker-signed envelope to my own user id', async () => {
        const attacker = ed25519Pair();
        const d = await sendAsMe(recipient, attacker, FORGED_DEVICE, { type: 'call_key', call_id: 'c1', e2ee_key_b64: 'k' });
        expect(d.senderUserId).toBe(ME);
        expect(d.senderPub).toBe(attacker.pubB64);
    });

    it('is refused as key material and not shown as my message (invented device id)', async () => {
        const attacker = ed25519Pair();
        const d = await sendAsMe(recipient, attacker, FORGED_DEVICE, { type: 'call_key', call_id: 'c1', e2ee_key_b64: 'k' });
        const r = judge({ senderPub: d.senderPub!, senderDeviceId: d.senderDeviceId });
        expect(r.verdict).toBe('unattributed');
        expect(r.known).toBe(false); // the caller re-reads the own listing once
        expect(actionFor(r.verdict, 'key_material')).toBe('reject');
        expect(selfContentRefused(r.verdict)).toBe(true);
    });

    it('is refused when it borrows my phone\'s device id with its own key', async () => {
        const attacker = ed25519Pair();
        const d = await sendAsMe(recipient, attacker, MY_PHONE, { type: 'channel_key', key_b64: 'x' });
        const r = judge({ senderPub: d.senderPub!, senderDeviceId: d.senderDeviceId });
        expect(r.verdict).toBe('key_changed');
        expect(actionFor(r.verdict, 'key_material')).toBe('reject');
        expect(selfContentRefused(r.verdict)).toBe(true);
    });

    it('is refused when it claims THIS device\'s id', async () => {
        const attacker = ed25519Pair();
        const d = await sendAsMe(recipient, attacker, THIS_DEVICE, { type: 'text', text: 'x' });
        expect(judge({ senderPub: d.senderPub!, senderDeviceId: d.senderDeviceId }).verdict).toBe('unattributed');
    });

    it('is refused when it omits sd', () => {
        const attacker = ed25519Pair();
        expect(judge({ senderPub: attacker.pubB64 }).verdict).toBe('unattributed');
    });

    it('a known own key presented under a different device id is refused', () => {
        expect(judge({ senderPub: phone.pubB64, senderDeviceId: FORGED_DEVICE }).verdict).toBe('unattributed');
    });

    it('with no ledger yet, a key the directory does not list for me is refused', () => {
        const attacker = ed25519Pair();
        expect(judge({ senderPub: attacker.pubB64, senderDeviceId: FORGED_DEVICE }, { ledger: null, directory: 'mismatch' }).verdict).toBe('unattributed');
        expect(judge({ senderPub: attacker.pubB64, senderDeviceId: FORGED_DEVICE }, { ledger: undefined, directory: 'unknown' }).verdict).toBe('unattributed');
    });

    it('a rejected or removed own device can no longer supply key material', () => {
        const rejected = { ...ledger!, devices: { ...ledger!.devices, [MY_PHONE]: { ...ledger!.devices[MY_PHONE], status: 'rejected' as const } } };
        expect(actionFor(judge({ senderPub: phone.pubB64, senderDeviceId: MY_PHONE }, { ledger: rejected }).verdict, 'key_material')).toBe('reject');
        const gone = { ...ledger!, devices: { ...ledger!.devices, [MY_PHONE]: { ...ledger!.devices[MY_PHONE], gone_at: 5 } } };
        expect(actionFor(judge({ senderPub: phone.pubB64, senderDeviceId: MY_PHONE }, { ledger: gone }).verdict, 'key_material')).toBe('reject');
    });
});

describe('F1 positive controls — genuine multi-device self-fan-out', () => {
    it('my phone (baseline own device) is accepted for content and key material', async () => {
        const d = await sendAsMe(recipient, phone, MY_PHONE, { type: 'call_key', call_id: 'c1', e2ee_key_b64: 'k' });
        const r = judge({ senderPub: d.senderPub!, senderDeviceId: d.senderDeviceId });
        expect(r.verdict).toBe('ok');
        expect(actionFor(r.verdict, 'key_material')).toBe('accept');
        expect(selfContentRefused(r.verdict)).toBe(false);
    });

    it('an envelope signed by THIS device\'s own key is accepted', () => {
        expect(judge({ senderPub: recipient.identity.pubB64, senderDeviceId: THIS_DEVICE }).verdict).toBe('ok');
    });

    it('a just-added own device: shown (pending, ghost-device banner up), key material waits for confirmation', () => {
        const laptop = ed25519Pair();
        const withLaptop = applyObservation(ledger, self(), [
            { device_id: THIS_DEVICE, pub: recipient.identity.pubB64 },
            { device_id: MY_PHONE, pub: phone.pubB64 },
            { device_id: MY_NEW_LAPTOP, pub: laptop.pubB64 },
        ], true, 2);
        const pending = judge({ senderPub: laptop.pubB64, senderDeviceId: MY_NEW_LAPTOP }, { ledger: withLaptop });
        expect(pending.verdict).toBe('unrecognized_verified');
        expect(selfContentRefused(pending.verdict)).toBe(false);
        expect(actionFor(pending.verdict, 'key_material')).toBe('reject');

        const confirmed = applyConfirm(withLaptop!, MY_NEW_LAPTOP, laptop.pubB64, 3);
        expect(actionFor(judge({ senderPub: laptop.pubB64, senderDeviceId: MY_NEW_LAPTOP }, { ledger: confirmed }).verdict, 'key_material')).toBe('accept');
    });

    it('before any ledger exists, a key the directory lists for me is first contact (accepted)', () => {
        const r = judge({ senderPub: phone.pubB64, senderDeviceId: MY_PHONE }, { ledger: null, directory: 'match' });
        expect(r.verdict).toBe('first_contact');
        expect(actionFor(r.verdict, 'key_material')).toBe('accept');
    });
});
