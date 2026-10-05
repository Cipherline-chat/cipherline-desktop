import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import {
    verifyHistoryRequestAdvertisement,
    historyRequestProofMessage,
    HISTORY_REQUEST_PROOF_PREFIX,
    HISTORY_REQUEST_PROOF_WINDOW_S,
    HISTORY_CAPABILITY_WRAPPED,
} from './historyRequestProof';

/**
 * C-2b — the server-mediated DOWNGRADE on history sync.
 *
 * C-2 wrapped the one-time AES history key to the requesting device, so the
 * server relays an envelope rather than the key. But WHICH path ran was chosen
 * by the requester's `accepts_wrapped_key` boolean, which reaches the approver
 * only through the server and was authenticated by nothing. Flip it to false
 * and the approver POSTs the raw AES key for the whole export — which the
 * server then holds next to the ciphertext it already stores. The wrapped path
 * was therefore worth something against a passive reader of the database and
 * worth nothing against an active server.
 *
 * These tests exercise the real Ed25519 verification the approver now runs
 * before it will transfer anything. They are written against the four
 * properties the fix has to have, and each is paired with the positive control
 * that proves the assertion is not passing vacuously:
 *
 *   1. A STRIPPED or ABSENT signature is rejected   (control: present ⇒ accepted)
 *   2. A FORGED signature is rejected               (control: genuine ⇒ accepted)
 *   3. A signature genuine for OTHER PARAMETERS is rejected — replay across
 *      device, account, or time                     (control: matching ⇒ accepted)
 *   4. The capability is INSIDE the signed message, so the relayed boolean is
 *      not an input to the decision at all.
 */

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_USER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const REQUESTER_DEVICE = 'dddddddd-dddd-dddd-dddd-dddddddddd01';
const OTHER_DEVICE = 'dddddddd-dddd-dddd-dddd-dddddddddd02';
const NOW = 1_800_000_000;

function bytesToB64(b: Uint8Array): string {
    let s = '';
    for (const byte of b) s += String.fromCharCode(byte);
    return btoa(s);
}

function makeIdentity() {
    const priv = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(priv);
    return { priv, pub, pubB64: bytesToB64(pub) };
}

/** Sign exactly what the electron main process signs. */
function sign(
    identity: { priv: Uint8Array },
    userId: string,
    deviceId: string,
    identityPubB64: string,
    ts: number,
): string {
    const msg = new TextEncoder().encode(
        historyRequestProofMessage(userId, deviceId, identityPubB64, ts),
    );
    return bytesToB64(ed25519.sign(msg, identity.priv));
}

/** A genuine, fresh advertisement from `identity` — the happy path every
 *  negative case below is a single mutation away from. */
function goodAdvertisement(identity: ReturnType<typeof makeIdentity>) {
    return {
        userId: USER_ID,
        requestingDeviceId: REQUESTER_DEVICE,
        identityKeyPubB64: identity.pubB64,
        capabilitySigB64: sign(identity, USER_ID, REQUESTER_DEVICE, identity.pubB64, NOW),
        capabilityTs: NOW,
        nowSec: NOW,
    };
}

describe('C-2b — a stripped or absent signature is refused', () => {
    it('POSITIVE CONTROL: the unmutated advertisement verifies', () => {
        // Without this, every assertion below could pass because the helper is
        // broken rather than because the check works.
        const identity = makeIdentity();
        expect(verifyHistoryRequestAdvertisement(goodAdvertisement(identity)))
            .toEqual({ ok: true });
    });

    it('rejects an advertisement the server stripped the signature out of', () => {
        // The exact attack: a hostile pod removes the field (and, if it likes,
        // flips accepts_wrapped_key to false) so the approver sees what looks
        // like a legacy client. The approver must NOT read that as "send the
        // plaintext key" — it is indistinguishable from the attack.
        const identity = makeIdentity();
        const verdict = verifyHistoryRequestAdvertisement({
            ...goodAdvertisement(identity),
            capabilitySigB64: undefined,
        });
        expect(verdict).toEqual({ ok: false, reason: 'no_signature' });
    });

    it('rejects an empty-string signature as firmly as a missing one', () => {
        const identity = makeIdentity();
        expect(verifyHistoryRequestAdvertisement({
            ...goodAdvertisement(identity),
            capabilitySigB64: '',
        })).toEqual({ ok: false, reason: 'no_signature' });
    });

    it('rejects a signature with the timestamp stripped', () => {
        // The timestamp is inside the signed message, so dropping it leaves
        // nothing to reconstruct the message from. Rejecting rather than
        // guessing a value keeps the server from steering the check.
        const identity = makeIdentity();
        expect(verifyHistoryRequestAdvertisement({
            ...goodAdvertisement(identity),
            capabilityTs: undefined,
        })).toEqual({ ok: false, reason: 'no_timestamp' });
    });

    it('rejects a truncated signature rather than throwing', () => {
        const identity = makeIdentity();
        const good = goodAdvertisement(identity);
        expect(verifyHistoryRequestAdvertisement({
            ...good,
            capabilitySigB64: good.capabilitySigB64.slice(0, 20),
        })).toEqual({ ok: false, reason: 'malformed_signature' });
    });
});

describe('C-2b — a forged signature is rejected', () => {
    it('rejects a signature made with a DIFFERENT identity key', () => {
        // What an attacker without the device's private key can actually
        // produce. It is well-formed and fresh; only the key is wrong.
        const real = makeIdentity();
        const attacker = makeIdentity();
        const verdict = verifyHistoryRequestAdvertisement({
            ...goodAdvertisement(real),
            // Signed by the attacker over the message naming the REAL key, so
            // the message content is entirely correct.
            capabilitySigB64: sign(attacker, USER_ID, REQUESTER_DEVICE, real.pubB64, NOW),
        });
        expect(verdict).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('POSITIVE CONTROL: the same message signed by the RIGHT key verifies', () => {
        // Pins that the case above failed on the key, not on the message.
        const real = makeIdentity();
        expect(verifyHistoryRequestAdvertisement({
            ...goodAdvertisement(real),
            capabilitySigB64: sign(real, USER_ID, REQUESTER_DEVICE, real.pubB64, NOW),
        })).toEqual({ ok: true });
    });

    it('rejects a bit-flipped signature', () => {
        const identity = makeIdentity();
        const good = goodAdvertisement(identity);
        const raw = Uint8Array.from(atob(good.capabilitySigB64), c => c.charCodeAt(0));
        raw[raw.length - 1] ^= 0xff;
        expect(verifyHistoryRequestAdvertisement({
            ...good,
            capabilitySigB64: bytesToB64(raw),
        })).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('rejects when the identity key is substituted after signing', () => {
        // A server that swaps the bundle's identity key without also forging
        // the advertisement gets a rejection, not a silent pass. (A server that
        // swaps BOTH is the pre-existing active MITM that Safety Numbers cover
        // — see historyTransferKey.ts's residual-risk note. It still never
        // yields a plaintext key.)
        const real = makeIdentity();
        const substituted = makeIdentity();
        expect(verifyHistoryRequestAdvertisement({
            ...goodAdvertisement(real),
            identityKeyPubB64: substituted.pubB64,
        })).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('rejects a malformed identity key rather than throwing', () => {
        const identity = makeIdentity();
        expect(verifyHistoryRequestAdvertisement({
            ...goodAdvertisement(identity),
            identityKeyPubB64: 'AAAA',
        })).toEqual({ ok: false, reason: 'malformed_identity_key' });
    });
});

describe('C-2b — a genuine signature cannot be replayed onto other parameters', () => {
    it('rejects a signature genuine for a DIFFERENT requesting device', () => {
        // Otherwise a server could capture one device's advertisement and
        // replay it to authorise a history transfer to a device of its own.
        const identity = makeIdentity();
        expect(verifyHistoryRequestAdvertisement({
            ...goodAdvertisement(identity),
            capabilitySigB64: sign(identity, USER_ID, OTHER_DEVICE, identity.pubB64, NOW),
        })).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('rejects a signature genuine for a DIFFERENT account', () => {
        const identity = makeIdentity();
        expect(verifyHistoryRequestAdvertisement({
            ...goodAdvertisement(identity),
            capabilitySigB64: sign(identity, OTHER_USER, REQUESTER_DEVICE, identity.pubB64, NOW),
        })).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('rejects an advertisement older than the freshness window', () => {
        const identity = makeIdentity();
        const stale = NOW - HISTORY_REQUEST_PROOF_WINDOW_S - 1;
        expect(verifyHistoryRequestAdvertisement({
            userId: USER_ID,
            requestingDeviceId: REQUESTER_DEVICE,
            identityKeyPubB64: identity.pubB64,
            capabilitySigB64: sign(identity, USER_ID, REQUESTER_DEVICE, identity.pubB64, stale),
            capabilityTs: stale,
            nowSec: NOW,
        })).toEqual({ ok: false, reason: 'stale_timestamp' });
    });

    it('POSITIVE CONTROL: the same advertisement one second inside the window verifies', () => {
        // Pins the boundary rather than just "old is rejected" — an off-by-one
        // the wrong way would reject every legitimate request.
        const identity = makeIdentity();
        const edge = NOW - HISTORY_REQUEST_PROOF_WINDOW_S + 1;
        expect(verifyHistoryRequestAdvertisement({
            userId: USER_ID,
            requestingDeviceId: REQUESTER_DEVICE,
            identityKeyPubB64: identity.pubB64,
            capabilitySigB64: sign(identity, USER_ID, REQUESTER_DEVICE, identity.pubB64, edge),
            capabilityTs: edge,
            nowSec: NOW,
        })).toEqual({ ok: true });
    });

    it('rejects a clock far in the FUTURE as well as the past', () => {
        const identity = makeIdentity();
        const future = NOW + HISTORY_REQUEST_PROOF_WINDOW_S + 1;
        expect(verifyHistoryRequestAdvertisement({
            userId: USER_ID,
            requestingDeviceId: REQUESTER_DEVICE,
            identityKeyPubB64: identity.pubB64,
            capabilitySigB64: sign(identity, USER_ID, REQUESTER_DEVICE, identity.pubB64, future),
            capabilityTs: future,
            nowSec: NOW,
        })).toEqual({ ok: false, reason: 'stale_timestamp' });
    });
});

describe('C-2b — domain separation and what the message commits to', () => {
    it('uses its own prefix, distinct from the registration proof', () => {
        // Same key signs both. Without distinct domains a registration proof
        // could be replayed as a capability advertisement.
        expect(HISTORY_REQUEST_PROOF_PREFIX).toBe('cipherline-history-request:v1');
        expect(HISTORY_REQUEST_PROOF_PREFIX).not.toBe('cipherline-device-register:v1');
        expect(historyRequestProofMessage(USER_ID, REQUESTER_DEVICE, 'K', NOW))
            .toMatch(/^cipherline-history-request:v1:/);
    });

    it('a registration proof over the same fields does NOT verify here', () => {
        // The concrete cross-protocol replay, executed rather than asserted
        // about: sign the REGISTER message with the real key, present it as a
        // capability advertisement.
        const identity = makeIdentity();
        const registerMsg = `cipherline-device-register:v1:${USER_ID}:${identity.pubB64}:${NOW}`;
        const registerSig = bytesToB64(
            ed25519.sign(new TextEncoder().encode(registerMsg), identity.priv),
        );
        expect(verifyHistoryRequestAdvertisement({
            ...goodAdvertisement(identity),
            capabilitySigB64: registerSig,
        })).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('puts the CAPABILITY inside the signed message, not beside it', () => {
        // This is what makes the flag untamperable. The verifier takes no
        // `acceptsWrappedKey` argument at all — there is nothing for the relay
        // to flip — because the capability is a field of the signed message.
        expect(historyRequestProofMessage(USER_ID, REQUESTER_DEVICE, 'K', NOW))
            .toContain(`:${HISTORY_CAPABILITY_WRAPPED}:`);
        expect(HISTORY_CAPABILITY_WRAPPED).toBe('wrapped');
    });

    it('commits to every field the approver depends on', () => {
        const msg = historyRequestProofMessage(USER_ID, REQUESTER_DEVICE, 'IDENTITY', NOW);
        expect(msg).toBe(
            `cipherline-history-request:v1:${USER_ID}:${REQUESTER_DEVICE}:IDENTITY:wrapped:${NOW}`,
        );
    });
});

/**
 * The signing half lives in the electron MAIN process (the identity private key
 * is in SecureStore there, never in the renderer), and it cannot import this
 * module: an import across the `electron/` ⇄ `src/` boundary re-roots the
 * emitted dist-electron tree and breaks packaging, which only a STAGING desktop
 * build catches. So the template is duplicated — and drift between signer and
 * verifier would mean every advertisement is refused and history sync dies
 * silently for everyone. This pins them to each other.
 */
describe('C-2b — the signer and the verifier build the same message', () => {
    const mainSrc = readFileSync(
        join(__dirname, '..', '..', 'electron', 'main.ts'),
        'utf8',
    );

    it('registers the signing IPC channel', () => {
        expect(mainSrc).toContain(`ipcMain.handle('crypto:history-request-proof'`);
    });

    it('the template in main.ts is byte-identical to historyRequestProofMessage', () => {
        // Extract main.ts's literal, substitute the same values the verifier
        // would, and compare the RESULTING STRINGS — not the source text. A
        // reordered or renamed field changes the output and fails here.
        const m = mainSrc.match(/const msg = `(cipherline-history-request:v1:[^`]*)`/);
        expect(m, 'signing template not found in electron/main.ts').toBeTruthy();

        const substituted = m![1]
            .replace('${userId}', USER_ID)
            .replace('${requestingDeviceId}', REQUESTER_DEVICE)
            .replace('${identityPub}', 'IDENTITY')
            .replace('${ts}', String(NOW));

        // No `${` left means every placeholder was one we knew about; an
        // unrecognised one would survive substitution and fail the compare.
        expect(substituted).not.toContain('${');
        expect(substituted).toBe(
            historyRequestProofMessage(USER_ID, REQUESTER_DEVICE, 'IDENTITY', NOW),
        );
    });

    it('main.ts returns null rather than an unsigned proof', () => {
        // The renderer treats null as "abandon the request". If main ever
        // returned a partial object instead, the renderer would send an
        // unsigned advertisement and get refused for the wrong reason.
        const handler = mainSrc.slice(
            mainSrc.indexOf(`ipcMain.handle('crypto:history-request-proof'`),
        ).slice(0, 1200);
        expect(handler).toContain('if (!identityPub) return null;');
        expect(handler).toContain('if (!sig) return null;');
    });
});
