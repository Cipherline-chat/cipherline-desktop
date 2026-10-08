import { describe, it, expect } from 'vitest';
import {
    formatRetryAfter, isStagingLockedError, unlockErrorText, shouldShowStagingLockScreen,
    STAGING_LOCKED_CODE, STAGING_PASSWORD_MAX_LENGTH, STAGING_NON_TESTER_NOTE,
} from './stagingLock';
import {
    STAGING_LOCKED_ERROR, MAX_PASSWORD_LENGTH, isStagingVersion,
    STAGING_UNLOCK_STORE_KEY, PREVIEW_UNLOCK_STORE_KEY,
} from '../../electron/staging-lock';
import { APP_PREF_KEYS, SECURE_STORE_EXCLUDED } from '../services/backupRegistry';

describe('renderer staging-lock helpers', () => {
    it('stay in step with the main-process constants they mirror', () => {
        expect(STAGING_LOCKED_CODE).toBe(STAGING_LOCKED_ERROR);
        expect(STAGING_PASSWORD_MAX_LENGTH).toBe(MAX_PASSWORD_LENGTH);
    });

    it('formats the backoff as the owner reads it, rounding up', () => {
        expect(formatRetryAfter(80_000)).toBe('1m 20s');
        expect(formatRetryAfter(79_001)).toBe('1m 20s');
        expect(formatRetryAfter(30_000)).toBe('30s');
        expect(formatRetryAfter(60_000)).toBe('1m');
        expect(formatRetryAfter(900_000)).toBe('15m');
        expect(formatRetryAfter(1)).toBe('1s');
        expect(formatRetryAfter(0)).toBe('1s');
    });

    it('maps unlock results to the inline error', () => {
        expect(unlockErrorText({ ok: true, retryAfterMs: 0 })).toBeNull();
        expect(unlockErrorText({ ok: false, retryAfterMs: 0 })).toBe('Wrong password');
        expect(unlockErrorText({ ok: false, retryAfterMs: 80_000 })).toBe('Too many attempts — try again in 1m 20s');
    });

    it('recognises the refusal from updater:set-channel the way Electron delivers it', () => {
        expect(isStagingLockedError(new Error("Error invoking remote method 'updater:set-channel': Error: STAGING_LOCKED"))).toBe(true);
        expect(isStagingLockedError(new Error('Untrusted IPC sender'))).toBe(false);
        expect(isStagingLockedError(undefined)).toBe(false);
    });

    it('the non-tester line is plain text pointing at the download page', () => {
        expect(STAGING_NON_TESTER_NOTE).toBe(
            'This is a pre-release test build. Get the stable release at cipherline.chat/download.',
        );
    });
});

describe('shouldShowStagingLockScreen', () => {
    const s = (isStagingBuild: boolean, unlocked: boolean) => ({ enforced: true, isStagingBuild, unlocked, retryAfterMs: 0 });

    it('locks a staging build that is not unlocked, and only that', () => {
        expect(shouldShowStagingLockScreen(s(true, false), '1.0.17-staging.5')).toBe(true);
        expect(shouldShowStagingLockScreen(s(true, true), '1.0.17-staging.5')).toBe(false);
        expect(shouldShowStagingLockScreen(s(false, false), '1.0.16')).toBe(false);
    });

    it('trusts main over the bundle version when main answered (dev/smoke say not-a-staging-build)', () => {
        expect(shouldShowStagingLockScreen({ enforced: false, isStagingBuild: false, unlocked: true, retryAfterMs: 0 }, '1.0.17-staging.5'))
            .toBe(false);
    });

    it('never locks without an Electron bridge (browser preview / website)', () => {
        expect(shouldShowStagingLockScreen('absent', '1.0.17-staging.5')).toBe(false);
    });

    it('fails CLOSED on a status error only for a staging bundle', () => {
        expect(shouldShowStagingLockScreen('error', '1.0.17-staging.5')).toBe(true);
        expect(shouldShowStagingLockScreen('error', '1.0.16')).toBe(false);
        expect(shouldShowStagingLockScreen('error', '0.0.0')).toBe(false);
    });

    it('the renderer fallback and main agree on what a staging version is', () => {
        for (const v of ['1.0.17-staging.5', '1.0.17-staging', '1.0.16', '1.0.17-beta.1', '1.0.17-stagingx']) {
            expect(shouldShowStagingLockScreen('error', v), v).toBe(isStagingVersion(v));
        }
    });
});

describe('the remembered-unlock SecureStore key is never backed up', () => {
    // A restored backup must not unlock staging on a machine that never
    // entered the password. (main.ts writes it via a constant, which the
    // source-scan in backupRegistry.test.ts cannot see — hence this pin.)
    it.each([STAGING_UNLOCK_STORE_KEY, PREVIEW_UNLOCK_STORE_KEY])('%s is excluded, not an app pref', (key) => {
        expect(SECURE_STORE_EXCLUDED.some((p) => key === p || key.startsWith(p))).toBe(true);
        expect((APP_PREF_KEYS as readonly string[]).includes(key)).toBe(false);
    });
});
