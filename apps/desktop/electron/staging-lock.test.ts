import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as crypto from 'crypto';

// Pass-through spies on the two crypto calls the verifier's guarantees rest
// on (ESM namespaces cannot be spied on in place).
vi.mock('crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('crypto')>();
    return {
        ...actual,
        default: actual,
        scryptSync: vi.fn(actual.scryptSync),
        timingSafeEqual: vi.fn(actual.timingSafeEqual),
    };
});
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    verifyPassword, isAcceptablePasswordInput, MAX_PASSWORD_LENGTH, STAGING_VERIFIER,
    delayAfterFailures, createAttemptLimiter, FREE_ATTEMPTS, BASE_DELAY_MS, MAX_DELAY_MS,
    parseUnlockFile, serializeUnlockFile, readUnlockFileSync, writeUnlockFileAtomic, removeUnlockFile,
    UNLOCK_FILE_VERSION, UNLOCK_FILENAME, PREVIEW_UNLOCK_FILENAME,
    isStagingVersion, resolveStagingLockMode, decideSetChannel, STAGING_LOCKED_ERROR,
    type ScryptVerifier,
} from './staging-lock';

/**
 * Every password in this file is a THROWAWAY generated here, with its own
 * random salt — never the real staging password, which appears nowhere in the
 * repo. The production verifier is only checked for shape and for rejecting
 * obviously-wrong input.
 */
function makeVerifier(pw: string, N = 1024): ScryptVerifier {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(pw.normalize('NFKC'), salt, 32, { N, r: 8, p: 1, maxmem: 128 * N * 8 * 2 });
    return { alg: 'scrypt', N, r: 8, p: 1, len: 32, salt: salt.toString('hex'), hash: hash.toString('hex') };
}

const randomPassword = () => crypto.randomBytes(15).toString('base64url'); // 20 chars

describe('verifyPassword', () => {
    const pw = randomPassword();
    const params = makeVerifier(pw);

    it('accepts the right password', () => {
        expect(verifyPassword(pw, params)).toBe(true);
    });

    it('rejects a wrong password, a one-character change, and surrounding whitespace', () => {
        expect(verifyPassword(randomPassword(), params)).toBe(false);
        const flipped = pw.slice(0, -1) + (pw.endsWith('a') ? 'b' : 'a');
        expect(verifyPassword(flipped, params)).toBe(false);
        expect(verifyPassword(` ${pw}`, params)).toBe(false);
        expect(verifyPassword(pw.toUpperCase() === pw ? pw.toLowerCase() : pw.toUpperCase(), params)).toBe(false);
    });

    it('rejects empty and non-string input without throwing', () => {
        expect(verifyPassword('', params)).toBe(false);
        for (const bad of [undefined, null, 42, {}, [], Buffer.from(pw)]) {
            expect(verifyPassword(bad as unknown, params)).toBe(false);
        }
    });

    it('rejects input over the length cap WITHOUT running scrypt, even when it is a real match', () => {
        const long = 'x'.repeat(MAX_PASSWORD_LENGTH + 1);
        const longParams = makeVerifier(long);
        const spy = vi.mocked(crypto.scryptSync);
        spy.mockClear();
        expect(verifyPassword(long, longParams)).toBe(false);
        expect(spy).not.toHaveBeenCalled();
        // Exactly at the cap is accepted and verified normally.
        const atCap = 'y'.repeat(MAX_PASSWORD_LENGTH);
        expect(verifyPassword(atCap, makeVerifier(atCap))).toBe(true);
        expect(isAcceptablePasswordInput(atCap)).toBe(true);
        expect(isAcceptablePasswordInput(long)).toBe(false);
    });

    it('normalizes Unicode (NFKC): composed and decomposed forms verify the same', () => {
        const composed = 'café-１２-' + randomPassword();   // é + full-width digits
        const decomposed = composed.normalize('NFD');
        expect(decomposed).not.toBe(composed);
        const p = makeVerifier(composed);
        expect(verifyPassword(composed, p)).toBe(true);
        expect(verifyPassword(decomposed, p)).toBe(true);
        expect(verifyPassword('cafe-12-' + composed.slice(8), p)).toBe(false); // accent dropped
    });

    it('compares with timingSafeEqual (the timing-safe path is the one that decides)', () => {
        const spy = vi.mocked(crypto.timingSafeEqual);
        spy.mockClear();
        expect(verifyPassword(pw, params)).toBe(true);
        expect(verifyPassword(randomPassword(), params)).toBe(false);
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it('returns false (never throws) for a malformed verifier', () => {
        expect(verifyPassword(pw, { ...params, salt: 'zz' })).toBe(false);
        expect(verifyPassword(pw, { ...params, hash: params.hash.slice(2) })).toBe(false); // len mismatch
        expect(verifyPassword(pw, { ...params, alg: 'pbkdf2' as 'scrypt' })).toBe(false);
        expect(verifyPassword(pw, { ...params, N: 1000 })).toBe(false);                   // not a power of 2
    });

    it('works at the production cost (N=32768, r=8) — maxmem must be raised for that', () => {
        const prodCostPw = randomPassword();
        const p = makeVerifier(prodCostPw, 32768);
        expect(verifyPassword(prodCostPw, p)).toBe(true);
        // Node's default maxmem rejects these parameters outright — this is
        // why verifyPassword passes maxmem explicitly.
        expect(() => crypto.scryptSync('x', Buffer.alloc(16), 32, { N: 32768, r: 8, p: 1 })).toThrow();
    });

    it('the shipped verifier is well-formed and rejects ordinary guesses', () => {
        expect(STAGING_VERIFIER.alg).toBe('scrypt');
        expect(STAGING_VERIFIER.N).toBe(32768);
        expect(STAGING_VERIFIER.len).toBe(32);
        expect(STAGING_VERIFIER.salt).toMatch(/^[0-9a-f]{32}$/);
        expect(STAGING_VERIFIER.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(verifyPassword('password', STAGING_VERIFIER)).toBe(false);
        expect(verifyPassword('', STAGING_VERIFIER)).toBe(false);
    });
});

describe('attempt limiter', () => {
    it('allows FREE_ATTEMPTS failures with no delay, then 30 s, 60 s, 120 s … capped at 15 min', () => {
        for (let i = 0; i < FREE_ATTEMPTS; i++) expect(delayAfterFailures(i)).toBe(0);
        expect(delayAfterFailures(FREE_ATTEMPTS)).toBe(BASE_DELAY_MS);
        expect(delayAfterFailures(FREE_ATTEMPTS + 1)).toBe(60_000);
        expect(delayAfterFailures(FREE_ATTEMPTS + 2)).toBe(120_000);
        expect(delayAfterFailures(FREE_ATTEMPTS + 5)).toBe(MAX_DELAY_MS);   // 960 s → capped at 900 s
        expect(delayAfterFailures(10_000)).toBe(MAX_DELAY_MS);
        expect(Number.isFinite(delayAfterFailures(Number.MAX_SAFE_INTEGER))).toBe(true);
    });

    it('reports retryAfterMs counting down with the clock, and resets on success', () => {
        let t = 1_000_000;
        const lim = createAttemptLimiter(() => t);
        for (let i = 0; i < FREE_ATTEMPTS - 1; i++) {
            lim.recordFailure();
            expect(lim.retryAfterMs()).toBe(0);
        }
        lim.recordFailure(); // 5th
        expect(lim.retryAfterMs()).toBe(30_000);
        t += 10_000;
        expect(lim.retryAfterMs()).toBe(20_000);
        t += 20_000;
        expect(lim.retryAfterMs()).toBe(0);
        lim.recordFailure(); // 6th
        expect(lim.retryAfterMs()).toBe(60_000);
        lim.recordSuccess();
        expect(lim.retryAfterMs()).toBe(0);
        lim.recordFailure(); // back to failure #1
        expect(lim.retryAfterMs()).toBe(0);
    });
});

describe('remembered unlock file', () => {
    let dir: string;
    beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-lock-')); });
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('round-trips what it writes', () => {
        expect(parseUnlockFile(serializeUnlockFile(1_700_000_000_000))).toBe(true);
        const f = path.join(dir, UNLOCK_FILENAME);
        writeUnlockFileAtomic(f, Date.now());
        expect(readUnlockFileSync(f)).toBe(true);
        expect(fs.existsSync(`${f}.tmp`)).toBe(false);
        expect(removeUnlockFile(f)).toBe(true);
        expect(readUnlockFileSync(f)).toBe(false);
        expect(removeUnlockFile(f)).toBe(true); // already gone is fine
    });

    it('reads as LOCKED for missing, garbage and tampered shapes', () => {
        const bad: (string | null | undefined)[] = [
            null, undefined, '', 'not json', '[]', 'null', 'true', '{}', '"unlocked"',
            JSON.stringify({ v: UNLOCK_FILE_VERSION, unlocked: 'true', unlockedAt: 1 }),
            JSON.stringify({ v: UNLOCK_FILE_VERSION, unlocked: true }),
            JSON.stringify({ v: UNLOCK_FILE_VERSION, unlocked: true, unlockedAt: '1' }),
            JSON.stringify({ v: UNLOCK_FILE_VERSION, unlocked: true, unlockedAt: 0 }),
            JSON.stringify({ v: UNLOCK_FILE_VERSION, unlocked: true, unlockedAt: -5 }),
            JSON.stringify({ v: UNLOCK_FILE_VERSION + 1, unlocked: true, unlockedAt: 1 }),
            JSON.stringify({ v: String(UNLOCK_FILE_VERSION), unlocked: true, unlockedAt: 1 }),
            JSON.stringify({ v: UNLOCK_FILE_VERSION, unlocked: false, unlockedAt: 1 }),
            '{"v":1,"unlocked":true,"unlockedAt":1e400}', // Infinity
            ' '.repeat(2000) + serializeUnlockFile(1),    // oversized
        ];
        for (const raw of bad) expect(parseUnlockFile(raw), String(raw).slice(0, 60)).toBe(false);

        expect(readUnlockFileSync(path.join(dir, 'nope.json'))).toBe(false);
        expect(readUnlockFileSync(dir)).toBe(false); // a directory, not a file
        const big = path.join(dir, 'big.json');
        fs.writeFileSync(big, ' '.repeat(5000) + serializeUnlockFile(1));
        expect(readUnlockFileSync(big)).toBe(false);
    });

    it('uses a separate file name for the unpackaged preview', () => {
        expect(PREVIEW_UNLOCK_FILENAME).not.toBe(UNLOCK_FILENAME);
    });
});

describe('isStagingVersion / resolveStagingLockMode', () => {
    it('recognises staging versions only', () => {
        expect(isStagingVersion('1.0.17-staging.5')).toBe(true);
        expect(isStagingVersion('1.0.17-staging.135')).toBe(true);
        expect(isStagingVersion('1.0.17-staging')).toBe(true);
        expect(isStagingVersion('1.0.16')).toBe(false);
        expect(isStagingVersion('1.0.17-beta.1')).toBe(false);
        expect(isStagingVersion('1.0.17-stagingx')).toBe(false);
        expect(isStagingVersion('')).toBe(false);
    });

    it('packaged staging build: enforced + launch screen', () => {
        expect(resolveStagingLockMode({ packaged: true, smokeTest: false, version: '1.0.17-staging.5' }))
            .toEqual({ enforced: true, isStagingBuild: true, preview: false });
        expect(resolveStagingLockMode({ packaged: true, smokeTest: false, version: '1.0.17-staging' }).isStagingBuild)
            .toBe(true);
    });

    it('packaged stable build: channel gate only, no launch screen', () => {
        expect(resolveStagingLockMode({ packaged: true, smokeTest: false, version: '1.0.16' }))
            .toEqual({ enforced: true, isStagingBuild: false, preview: false });
    });

    it('smoke test: never, even on a packaged staging build and even with the preview var', () => {
        expect(resolveStagingLockMode({ packaged: true, smokeTest: true, version: '1.0.17-staging.5', previewEnv: '1' }))
            .toEqual({ enforced: false, isStagingBuild: false, preview: false });
    });

    it('unpackaged/dev: off, even for a staging-looking version', () => {
        expect(resolveStagingLockMode({ packaged: false, smokeTest: false, version: '1.0.17-staging' }))
            .toEqual({ enforced: false, isStagingBuild: false, preview: false });
        expect(resolveStagingLockMode({ packaged: false, smokeTest: false, version: '1.0.16', previewEnv: '0' }).enforced)
            .toBe(false);
    });

    it('unpackaged + preview var: behaves like a staging build; packaged ignores the var', () => {
        expect(resolveStagingLockMode({ packaged: false, smokeTest: false, version: '1.0.16', previewEnv: '1' }))
            .toEqual({ enforced: true, isStagingBuild: true, preview: true });
        expect(resolveStagingLockMode({ packaged: true, smokeTest: false, version: '1.0.16', previewEnv: '1' }))
            .toEqual({ enforced: true, isStagingBuild: false, preview: false });
    });
});

describe('decideSetChannel (the updater:set-channel policy)', () => {
    it('refuses staging while locked', () => {
        expect(decideSetChannel({ requested: 'staging', enforced: true, unlocked: false })).toBe('refuse-locked');
    });
    it('allows staging once unlocked', () => {
        expect(decideSetChannel({ requested: 'staging', enforced: true, unlocked: true })).toBe('allow');
    });
    it('always allows stable', () => {
        expect(decideSetChannel({ requested: 'latest', enforced: true, unlocked: false })).toBe('allow');
        expect(decideSetChannel({ requested: 'latest', enforced: true, unlocked: true })).toBe('allow');
    });
    it('allows anything where the lock is not enforced (dev, smoke test)', () => {
        expect(decideSetChannel({ requested: 'staging', enforced: false, unlocked: false })).toBe('allow');
    });
    it('has a distinct error code for the renderer', () => {
        expect(STAGING_LOCKED_ERROR).toBe('STAGING_LOCKED');
    });
});
