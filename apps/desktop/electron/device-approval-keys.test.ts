import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import {
    deriveRecoveryApprovalKeypair, approvalDecisionMessage, recoveryProofMessage,
    recoveryCommitMessage, linkApproveMessage, RECOVERY_APPROVAL_INFO,
} from './device-approval-keys';

/**
 * Device approval — main-process crypto.
 *
 * The recovery-derived keypair must be DETERMINISTIC (the same typed key on
 * a new device must reproduce the public key the old device published) and
 * must produce signatures the server's `verifySignedMessage` accepts — so
 * verification here uses Node's own Ed25519, the exact primitive the API
 * uses, against the raw public key the server stores.
 */

const MASTER = crypto.randomBytes(32).toString('base64');

function verify(pubB64: string, message: string, sigB64: string): boolean {
    const pub = crypto.createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(pubB64, 'base64').toString('base64url') },
        format: 'jwk',
    });
    return crypto.verify(null, Buffer.from(message, 'utf8'), pub, Buffer.from(sigB64, 'base64'));
}

describe('deriveRecoveryApprovalKeypair', () => {
    it('is deterministic: the same recovery key yields the same public key on any device', () => {
        const a = deriveRecoveryApprovalKeypair(MASTER)!;
        const b = deriveRecoveryApprovalKeypair(` ${MASTER} `)!; // typed with stray whitespace
        expect(a.pubB64).toBe(b.pubB64);
        expect(Buffer.from(a.pubB64, 'base64')).toHaveLength(32);
    });

    it('a different key yields a different public key, and its signatures do not verify against the first', () => {
        const a = deriveRecoveryApprovalKeypair(MASTER)!;
        const other = deriveRecoveryApprovalKeypair(crypto.randomBytes(32).toString('base64'))!;
        expect(other.pubB64).not.toBe(a.pubB64);
        const msg = recoveryProofMessage('u', 'd', 'IK', a.pubB64, 1);
        expect(verify(a.pubB64, msg, other.sign(msg))).toBe(false);
    });

    it('signs with the private half the public key verifies (Node Ed25519, the API primitive)', () => {
        const kp = deriveRecoveryApprovalKeypair(MASTER)!;
        const msg = recoveryProofMessage('user', 'pending', 'IDK', kp.pubB64, 1_700_000_000);
        const sig = kp.sign(msg);
        expect(Buffer.from(sig, 'base64')).toHaveLength(64);
        expect(verify(kp.pubB64, msg, sig)).toBe(true);
        expect(verify(kp.pubB64, msg + 'x', sig)).toBe(false);
    });

    it('refuses anything that is not a 32-byte key (a mistyped recovery key) without throwing', () => {
        expect(deriveRecoveryApprovalKeypair('')).toBeNull();
        expect(deriveRecoveryApprovalKeypair('not base64 at all!!')).toBeNull();
        expect(deriveRecoveryApprovalKeypair(crypto.randomBytes(31).toString('base64'))).toBeNull();
        expect(deriveRecoveryApprovalKeypair(crypto.randomBytes(33).toString('base64'))).toBeNull();
        expect(deriveRecoveryApprovalKeypair(null)).toBeNull();
    });

    it('is a distinct HKDF domain from the vault subkeys (the info string is unique to this feature)', () => {
        expect(RECOVERY_APPROVAL_INFO).toBe('cl-device-approval-recovery:v1');
        // Derived key ≠ a derivation under any other info — one spot check.
        const seedOther = crypto.hkdfSync('sha256', Buffer.from(MASTER, 'base64'), Buffer.alloc(0), Buffer.from('cl-blob-cache'), 32);
        const seedOurs = crypto.hkdfSync('sha256', Buffer.from(MASTER, 'base64'), Buffer.alloc(0), Buffer.from(RECOVERY_APPROVAL_INFO), 32);
        expect(Buffer.from(seedOther).equals(Buffer.from(seedOurs))).toBe(false);
    });
});

describe('canonical messages (domain separation)', () => {
    it('every message type has its own prefix, so no signature can be replayed as another kind', () => {
        const prefixes = [
            approvalDecisionMessage('u', 'a', 'p', 'K', 'approve', 1),
            recoveryProofMessage('u', 'p', 'K', 'R', 1),
            recoveryCommitMessage('u', 'd', 'R', 1),
            linkApproveMessage('u', 'a', 'L', 'K', 1),
        ].map(m => m.split(':').slice(0, 2).join(':'));
        expect(new Set(prefixes).size).toBe(prefixes.length);
        expect(prefixes).toEqual([
            'cipherline-device-approve:v1',
            'cipherline-device-recovery-approve:v1',
            'cipherline-device-recovery-commit:v1',
            'cipherline-link-approve:v1',
        ]);
    });

    it('the decision is INSIDE the signed approval message (approve ≠ deny)', () => {
        expect(approvalDecisionMessage('u', 'a', 'p', 'K', 'approve', 1))
            .not.toBe(approvalDecisionMessage('u', 'a', 'p', 'K', 'deny', 1));
    });

    it('an unbound link approval spells the missing key as "-"', () => {
        expect(linkApproveMessage('u', 'a', 'L', null, 7)).toBe('cipherline-link-approve:v1:u:a:L:-:7');
    });
});
