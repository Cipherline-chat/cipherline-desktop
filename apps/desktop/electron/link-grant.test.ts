import { describe, expect, it, vi, afterEach } from 'vitest';
import * as crypto from 'crypto';
import {
    beginLinkSession, bindLinkSession, openActiveLinkSession, endLinkSession,
    hasActiveLinkSession, sealLinkGrant, LINK_GRANT_VERSION, type LinkGrantPayload,
} from './link-grant';

/**
 * `link-grant.ts` had zero test coverage before this suite. It gets one now
 * because two adversarial-review findings (QR-4, QR-8) touch it directly, and
 * QR-8 changes the internal representation of the ephemeral private key
 * (hex string -> Buffer) through `importX25519Priv`/`openLinkGrant` — a
 * round-trip regression check is cheap insurance that the refactor didn't
 * silently break the seal/open crypto.
 */

const LINK_ID = 'AAAAAAAAAAAAAAAAAAAAAA'; // 22 chars, the server's real shape

afterEach(() => {
    // Never leave a session dangling between tests — mirrors the module's own
    // "at most one in-flight session" contract.
    try { endLinkSession(); } catch { /* none active — fine */ }
});

describe('seal/open round trip — regression check for the QR-8 Buffer refactor', () => {
    it('opens a grant sealed to the freshly-generated ephemeral key', () => {
        const { ekPubB64 } = beginLinkSession(LINK_ID);
        const payload: LinkGrantPayload = {
            type: 'link_grant', v: LINK_GRANT_VERSION, link_id: LINK_ID,
            user_id: 'USER1', access_token: 'ACCESS1', refresh_token: 'REFRESH1',
            approved_by_device_id: 'DEV1', approved_by_device_name: 'Pixel',
            issued_at: new Date().toISOString(),
        };
        const envelope = sealLinkGrant(payload, ekPubB64, LINK_ID);

        const opened = openActiveLinkSession(envelope, LINK_ID);

        expect(opened).toEqual(payload);
        // openActiveLinkSession discards the key whether or not the open
        // succeeded — the session is consumed either way.
        expect(hasActiveLinkSession()).toBe(false);
    });

    it('fails closed on a wrong-key envelope, still via the Buffer path', () => {
        beginLinkSession(LINK_ID);
        // Sealed to an UNRELATED ephemeral key, not the active session's.
        const { publicKey } = crypto.generateKeyPairSync('x25519');
        const foreignEkPubB64 = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
        const payload: LinkGrantPayload = {
            type: 'link_grant', v: LINK_GRANT_VERSION, link_id: LINK_ID,
            user_id: 'USER1', access_token: 'ACCESS1', refresh_token: 'REFRESH1',
            approved_by_device_id: 'DEV1', approved_by_device_name: 'Pixel',
            issued_at: new Date().toISOString(),
        };
        const envelope = sealLinkGrant(payload, Buffer.from(foreignEkPubB64, 'base64url').toString('base64'), LINK_ID);

        expect(() => openActiveLinkSession(envelope, LINK_ID)).toThrow();
        // Discarded even on failure.
        expect(hasActiveLinkSession()).toBe(false);
    });
});

describe('QR-8 — the ephemeral private key is held in a zeroable Buffer', () => {
    it('discardActive() zeroes the private key buffer instead of only dropping the reference', () => {
        beginLinkSession(LINK_ID);
        const fillSpy = vi.spyOn(Buffer.prototype, 'fill');
        try {
            // endLinkSession()'s only synchronous action is discardActive() —
            // nothing else in this call can produce a Buffer#fill call, so any
            // invocation the spy sees is the discard path this fix added.
            // Before the fix, discardActive() only did `active = null` and the
            // spy would never fire.
            endLinkSession();
            expect(fillSpy).toHaveBeenCalledWith(0);
        } finally {
            fillSpy.mockRestore();
        }
    });
});

describe('bindLinkSession — QR-4 link_id validation', () => {
    it('accepts a well-formed 22-char base64url id', () => {
        beginLinkSession('');
        expect(() => bindLinkSession(LINK_ID)).not.toThrow();
        expect(hasActiveLinkSession()).toBe(true);
    });

    it('rejects the exact QR-4 injection payload — a duplicate &k= smuggled via link_id', () => {
        beginLinkSession('');
        // The finding's own shape: 22 valid chars, then an appended &k=
        // parameter that would shadow the real key for a first-wins parser.
        const malicious = `${LINK_ID}&k=QVRUQUNLRVJfU1VQUExJRURfS0VZX0JBU0U2NHVybA`;
        expect(() => bindLinkSession(malicious)).toThrow(/well-formed/);
        // The failed attempt must not have left the session partially bound —
        // a well-formed id must still be bindable afterwards.
        expect(() => bindLinkSession(LINK_ID)).not.toThrow();
    });

    it('rejects ids that are too short, too long, or contain invalid characters', () => {
        beginLinkSession('');
        for (const bad of ['short', 'A'.repeat(21), 'A'.repeat(23), 'not-valid-chars!!!!!!']) {
            expect(() => bindLinkSession(bad)).toThrow(/well-formed/);
        }
        expect(() => bindLinkSession(LINK_ID)).not.toThrow();
    });

    it('still rejects an empty id with its own message (unchanged behaviour)', () => {
        beginLinkSession('');
        expect(() => bindLinkSession('')).toThrow(/empty/);
    });
});

describe('v2 payload — claim secret instead of tokens (2026-09-28 hardening, A4)', () => {
    const CLAIM_SECRET = Buffer.alloc(32, 7).toString('base64url'); // 43 chars, no padding

    it('round-trips a v2 grant (the envelope format is unchanged; only the payload shape differs)', () => {
        const { ekPubB64 } = beginLinkSession(LINK_ID);
        const payload: LinkGrantPayload = {
            type: 'link_grant', v: 2, link_id: LINK_ID, user_id: 'USER1', claim_secret: CLAIM_SECRET,
            approved_by_device_id: 'DEV1', approved_by_device_name: 'Pixel', issued_at: new Date().toISOString(),
        };
        const envelope = sealLinkGrant(payload, ekPubB64, LINK_ID);
        // Envelope version is still 1 — a v1 opener would reach the payload
        // and reject on `v`, never on the crypto.
        expect(JSON.parse(Buffer.from(envelope, 'base64').toString('utf8')).v).toBe(LINK_GRANT_VERSION);
        expect(openActiveLinkSession(envelope, LINK_ID)).toEqual(payload);
    });

    it('a v2 payload whose claim secret is missing or malformed is refused, so a broken approver cannot leave this device half-signed-in', () => {
        for (const bad of [undefined, '', 'short', 'x'.repeat(44), 'has+plus' + 'a'.repeat(35)]) {
            const { ekPubB64 } = beginLinkSession(LINK_ID);
            const payload = {
                type: 'link_grant', v: 2, link_id: LINK_ID, user_id: 'USER1', claim_secret: bad,
                approved_by_device_id: 'DEV1', approved_by_device_name: 'Pixel', issued_at: new Date().toISOString(),
            } as unknown as LinkGrantPayload;
            const envelope = sealLinkGrant(payload, ekPubB64, LINK_ID);
            expect(() => openActiveLinkSession(envelope, LINK_ID)).toThrow(/claim secret/);
        }
    });

    it('a v1 payload still needs its tokens, and an unknown payload version is refused', () => {
        const { ekPubB64 } = beginLinkSession(LINK_ID);
        const v1Missing = { type: 'link_grant', v: 1, link_id: LINK_ID, user_id: 'USER1', access_token: 'A',
            approved_by_device_id: 'DEV1', approved_by_device_name: 'Pixel', issued_at: 'now' } as unknown as LinkGrantPayload;
        expect(() => openActiveLinkSession(sealLinkGrant(v1Missing, ekPubB64, LINK_ID), LINK_ID)).toThrow(/required session fields/);

        const { ekPubB64: ek2 } = beginLinkSession(LINK_ID);
        const v3 = { type: 'link_grant', v: 3, link_id: LINK_ID, user_id: 'USER1', claim_secret: CLAIM_SECRET,
            approved_by_device_id: 'DEV1', approved_by_device_name: 'Pixel', issued_at: 'now' } as unknown as LinkGrantPayload;
        expect(() => openActiveLinkSession(sealLinkGrant(v3, ek2, LINK_ID), LINK_ID)).toThrow(/unexpected payload/);
    });
});
