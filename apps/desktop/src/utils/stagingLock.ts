/**
 * Renderer-side helpers for the staging lock. The lock itself — password
 * check, remembered unlock, refusing the staging channel — lives in the main
 * process (electron/staging-lock.ts); nothing here is load-bearing. These are
 * the pure bits of the UX so they can be tested without a DOM.
 */

/** Must match MAX_PASSWORD_LENGTH in electron/staging-lock.ts. */
export const STAGING_PASSWORD_MAX_LENGTH = 256;

/** Matches STAGING_LOCKED_ERROR in electron/staging-lock.ts. Electron wraps a
 *  rejected invoke as "Error invoking remote method '…': Error: STAGING_LOCKED",
 *  so this is a substring check. */
export const STAGING_LOCKED_CODE = 'STAGING_LOCKED';

export function isStagingLockedError(e: unknown): boolean {
    const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
    return msg.includes(STAGING_LOCKED_CODE);
}

/** "45s", "1m 20s", "15m" — always rounded UP so it never reads "0s". */
export function formatRetryAfter(ms: number): string {
    const total = Math.max(1, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m === 0) return `${s}s`;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** The inline error under the password field. */
export function unlockErrorText(result: { ok: boolean; retryAfterMs: number }): string | null {
    if (result.ok) return null;
    if (result.retryAfterMs > 0) return `Too many attempts — try again in ${formatRetryAfter(result.retryAfterMs)}`;
    return 'Wrong password';
}

/** Copy shown to anyone who is not a tester. Plain text — never a link that opens itself. */
export const STAGING_NON_TESTER_NOTE =
    'This is a pre-release test build. Get the stable release at cipherline.chat/download.';

export interface StagingLockStatusLike {
    enforced: boolean;
    isStagingBuild: boolean;
    unlocked: boolean;
    retryAfterMs: number;
}

/**
 * Should main.tsx show the full-screen lock instead of the app?
 *
 * - `'absent'` — no Electron bridge (browser preview / website): never.
 * - a status   — exactly when main says this is a staging build and the
 *                device is not unlocked.
 * - `'error'`  — the status call itself failed (a bug, not a normal path).
 *                Fail CLOSED only when the bundle's own version says it is a
 *                staging build, so a broken bridge can neither open a
 *                staging build nor brick a stable one.
 */
export function shouldShowStagingLockScreen(
    status: StagingLockStatusLike | 'absent' | 'error',
    appVersion: string,
): boolean {
    if (status === 'absent') return false;
    if (status === 'error') return /^\d+\.\d+\.\d+-staging(?:\.|$)/.test(appVersion);
    return status.isStagingBuild && !status.unlocked;
}

/** Fetch the status in the shape shouldShowStagingLockScreen takes. Never throws. */
export async function readStagingLockStatus(): Promise<StagingLockStatusLike | 'absent' | 'error'> {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!api?.getStagingLockStatus) return 'absent';
    try {
        return await api.getStagingLockStatus();
    } catch {
        return 'error';
    }
}
