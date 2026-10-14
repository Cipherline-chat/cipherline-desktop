import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { deriveDeviceApprovalCode, formatDeviceApprovalCode, normalizeDeviceApprovalCode, DEVICE_APPROVAL_CODE_PREFIX } from './deviceApprovalCode';

/**
 * The renderer's derivation must equal the API's (`deriveApprovalCode` in
 * apps/api/src/devices/device-approval.util.ts) bit for bit — otherwise the
 * two screens of an approval show different numbers for an honest request
 * and the human learns to ignore the mismatch, which is the failure mode the
 * code exists to prevent. The reference below is the API's algorithm written
 * with Node's hash (the same SHA-256 WebCrypto implements), plus fixed
 * vectors that the mobile spec also carries.
 */

function reference(userId: string, ik: string, nonce: string): string {
    const d = createHash('sha256').update(`${DEVICE_APPROVAL_CODE_PREFIX}:${userId}:${ik}:${nonce}`, 'utf8').digest();
    return (d.readUInt32BE(0) % 1_000_000).toString().padStart(6, '0');
}

describe('deriveDeviceApprovalCode', () => {
    it('matches the API reference derivation for arbitrary inputs', async () => {
        for (let i = 0; i < 50; i++) {
            const u = `user-${i}`;
            const ik = Buffer.from(String(i).repeat(32)).subarray(0, 32).toString('base64');
            const nonce = Buffer.from(`nonce${i}`.padEnd(16, '!')).toString('base64');
            expect(await deriveDeviceApprovalCode(u, ik, nonce)).toBe(reference(u, ik, nonce));
        }
    });

    it('pins the shared test vectors (also in docs/device-approval-mobile-spec.md)', async () => {
        // Vector 1
        expect(await deriveDeviceApprovalCode(
            '11111111-1111-4111-8111-111111111111',
            'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            'AAAAAAAAAAAAAAAAAAAAAA==',
        )).toBe(reference('11111111-1111-4111-8111-111111111111', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'AAAAAAAAAAAAAAAAAAAAAA=='));
        // The exact digits, so a port that gets the same answer as the
        // reference above but not these has broken the reference too.
        expect(await deriveDeviceApprovalCode('u', 'k', 'n')).toBe('399582');
        expect(await deriveDeviceApprovalCode(
            '11111111-1111-4111-8111-111111111111',
            'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            'AAAAAAAAAAAAAAAAAAAAAA==',
        )).toBe('130329');
    });

    it('is always six zero-padded digits and changes with every input', async () => {
        const base = await deriveDeviceApprovalCode('u', 'k', 'n');
        expect(base).toMatch(/^\d{6}$/);
        expect(await deriveDeviceApprovalCode('u2', 'k', 'n')).not.toBe(base);
        expect(await deriveDeviceApprovalCode('u', 'k2', 'n')).not.toBe(base);
        expect(await deriveDeviceApprovalCode('u', 'k', 'n2')).not.toBe(base);
    });
});

describe('display helpers', () => {
    it('formats as two groups of three and normalises pasted input', () => {
        expect(formatDeviceApprovalCode('123456')).toBe('123 456');
        expect(normalizeDeviceApprovalCode(' 123 456 ')).toBe('123456');
        expect(normalizeDeviceApprovalCode('12-34-56-78')).toBe('123456');
    });
});
