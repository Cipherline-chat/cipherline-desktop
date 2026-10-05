import { describe, it, expect } from 'vitest';
import {
    computeContactCode,
    formatCode,
    normalizeCode,
    checkCode,
    CODE_LENGTH,
    FINGERPRINT_BYTES,
} from './verificationCode';

/** 32-byte Ed25519-shaped pubs. Content is irrelevant; distinctness is not. */
const pubA = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const pubB = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const pubC = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));

describe('computeContactCode', () => {
    it('produces exactly CODE_LENGTH base32 characters', async () => {
        const code = await computeContactCode('user-1', [pubA]);
        expect(code).toHaveLength(CODE_LENGTH);
        expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
    });

    it('carries the full 200 bits the safety number does', () => {
        // Guards the strength claim in the module header and in the UI copy. If
        // someone shortens the fingerprint to make the code prettier, the
        // "at least as strong as comparing all twelve digit groups" statement
        // stops being true, and this is where that gets caught.
        expect(FINGERPRINT_BYTES * 8).toBe(200);
        expect(CODE_LENGTH * 5).toBe(FINGERPRINT_BYTES * 8);
    });

    it('is deterministic', async () => {
        const a = await computeContactCode('user-1', [pubA, pubB]);
        const b = await computeContactCode('user-1', [pubA, pubB]);
        expect(a).toBe(b);
    });

    it('is independent of the order the server returned the device keys in', async () => {
        // GET /keys/identity_keys makes no ordering promise. If the code moved
        // with the response order, two honest clients would disagree and every
        // verification would fail for cosmetic reasons.
        const forward  = await computeContactCode('user-1', [pubA, pubB, pubC]);
        const reversed = await computeContactCode('user-1', [pubC, pubB, pubA]);
        expect(reversed).toBe(forward);
    });

    it('changes when a device is added', async () => {
        const one = await computeContactCode('user-1', [pubA]);
        const two = await computeContactCode('user-1', [pubA, pubB]);
        expect(two).not.toBe(one);
    });

    it('changes when a device key is substituted', async () => {
        // The MITM case: the server swaps one of the contact's keys for its own.
        const honest = await computeContactCode('user-1', [pubA, pubB]);
        const swapped = await computeContactCode('user-1', [pubA, pubC]);
        expect(swapped).not.toBe(honest);
    });

    it('is bound to the account, so a code cannot be replayed as another contact', async () => {
        const forOne = await computeContactCode('user-1', [pubA]);
        const forTwo = await computeContactCode('user-2', [pubA]);
        expect(forTwo).not.toBe(forOne);
    });

    it('separates device keys so two device lists cannot collide by concatenation', async () => {
        // Without the 0x00 separators, a single 64-byte key whose bytes are
        // exactly A||B would hash identically to the two-device list [A, B].
        // (Built as one base64 of the concatenated BYTES — concatenating the
        // two base64 STRINGS is not valid base64, because each carries its own
        // padding.)
        const joinedBytes = new Uint8Array(64);
        joinedBytes.set(new Uint8Array(32).fill(1), 0);
        joinedBytes.set(new Uint8Array(32).fill(2), 32);
        const joined = btoa(String.fromCharCode(...joinedBytes));

        const a = await computeContactCode('u', [joined]);
        const b = await computeContactCode('u', [pubA, pubB]);
        expect(a).not.toBe(b);
    });

    it('refuses to mint a code with nothing to commit to', async () => {
        await expect(computeContactCode('user-1', [])).rejects.toThrow();
        await expect(computeContactCode('', [pubA])).rejects.toThrow();
    });
});

describe('normalizeCode', () => {
    it('strips the formatting a copy-paste picks up', () => {
        expect(normalizeCode('  ab12 cd34\n-ef56  ')).toBe('AB12CD34EF56');
    });

    it('folds the Crockford look-alikes a human transcription introduces', () => {
        // I/l -> 1, O -> 0, U -> V. Without this a correctly read code fails
        // to match for cosmetic reasons and the user learns to distrust the check.
        expect(normalizeCode('Il0O1u')).toBe('11001V');
    });
});

describe('checkCode', () => {
    const code = '0123456789ABCDEFGHJKMNPQRSTVWXYZ01234567';

    it('matches an identical code', () => {
        expect(checkCode(code, code)).toEqual({ result: 'match' });
    });

    it('matches through display formatting', () => {
        expect(checkCode(code, formatCode(code))).toEqual({ result: 'match' });
    });

    it('matches through lowercase and look-alike transcription', () => {
        const typed = code.toLowerCase().replace(/1/g, 'l').replace(/0/g, 'O');
        expect(checkCode(code, typed)).toEqual({ result: 'match' });
    });

    it('reports a single-character difference as a mismatch, not a match', () => {
        const tampered = 'Z' + code.slice(1);
        expect(checkCode(code, tampered).result).toBe('mismatch');
    });

    it('distinguishes malformed input from a real mismatch', () => {
        // These mean opposite things to the user — "you pasted it wrong" versus
        // "stop, the keys disagree" — and collapsing them either cries wolf or
        // buries a real alarm.
        expect(checkCode(code, '').result).toBe('malformed');
        expect(checkCode(code, code.slice(0, 20)).result).toBe('malformed');
        expect(checkCode(code, code + 'ABCD').result).toBe('malformed');
    });

    it('rejects characters outside the alphabet rather than silently comparing them', () => {
        const withBadChar = code.slice(0, 39) + '!';
        expect(checkCode(code, withBadChar).result).toBe('malformed');
    });

    it('never reports a match for a wrong-length code, however similar', () => {
        expect(checkCode(code, code.slice(0, -1)).result).toBe('malformed');
    });
});
