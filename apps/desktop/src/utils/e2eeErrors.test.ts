import { describe, it, expect } from 'vitest';
import { classifyDecryptFailure, extractE2eeCode, isLegacyEnvelope } from './e2eeErrors';

describe('extractE2eeCode', () => {
    it('extracts the bracketed code', () => {
        expect(extractE2eeCode('[E2EE:REPLAY] Replay detected — duplicate ephemeral key')).toBe('REPLAY');
    });

    it('returns null for a message with no code', () => {
        expect(extractE2eeCode('Network request failed')).toBeNull();
    });

    it('extracts the code through Electron IPC error-wrapping', () => {
        const wrapped = "Error invoking remote method 'crypto:decrypt-message': Error: [E2EE:WRAP_AUTH_FAILED] Unsupported state or unable to authenticate data";
        expect(extractE2eeCode(wrapped)).toBe('WRAP_AUTH_FAILED');
    });
});

describe('isLegacyEnvelope', () => {
    it('matches the bare LEGACY string decryptEnvelope throws', () => {
        expect(isLegacyEnvelope('LEGACY')).toBe(true);
    });

    it('matches LEGACY through IPC error-wrapping', () => {
        expect(isLegacyEnvelope("Error invoking remote method 'crypto:decrypt-message': Error: LEGACY")).toBe(true);
    });

    it('does not match an unrelated message', () => {
        expect(isLegacyEnvelope('[E2EE:REPLAY] Replay detected')).toBe(false);
    });
});

describe('classifyDecryptFailure', () => {
    const permanentCodes = [
        'NO_RECIPIENT_ENTRY', 'REPLAY', 'WRAP_AUTH_FAILED', 'CONTENT_AUTH_FAILED', 'SIG_INVALID',
    ];
    for (const code of permanentCodes) {
        it(`classifies ${code} as permanent`, () => {
            expect(classifyDecryptFailure(new Error(`[E2EE:${code}] something happened`))).toBe('permanent');
        });
    }

    it('classifies LEGACY as permanent', () => {
        expect(classifyDecryptFailure(new Error('LEGACY'))).toBe('permanent');
    });

    it('classifies NO_SPK as transient (secure store may still be unlocking)', () => {
        expect(classifyDecryptFailure(new Error('[E2EE:NO_SPK] No signed prekeys found in secure store'))).toBe('transient');
    });

    it('classifies an unrecognized error as transient (fail safe, not silently destructive)', () => {
        expect(classifyDecryptFailure(new Error('Network request failed'))).toBe('transient');
    });

    it('classifies a non-Error thrown value as transient', () => {
        expect(classifyDecryptFailure('a plain string throw')).toBe('transient');
    });

    it('classifies through Electron IPC error-wrapping', () => {
        const wrapped = new Error("Error invoking remote method 'crypto:decrypt-message': Error: [E2EE:SIG_INVALID] v:3 envelope signature invalid");
        expect(classifyDecryptFailure(wrapped)).toBe('permanent');
    });
});
