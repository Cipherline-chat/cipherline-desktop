import secureLocalStore from './secureLocalStore';

/**
 * onboardingProgress — "this account is in the middle of its first-run setup
 * on THIS device, and here is where it got to".
 *
 * The round-6 onboarding (components/onboarding/) runs AFTER the account is
 * signed in: email verification creates the account and logs in, and the
 * Dashboard mounts with the setup flow over it. That is what lets every step
 * save through the app's real settings hooks, and what makes a crash or a
 * quit mid-setup resumable: the next launch restores the session, the
 * Dashboard sees this marker and puts the setup back up at the same step.
 *
 * Two signals decide "show the setup" (see `shouldShowOnboarding`):
 *   1. this marker — written the moment verification succeeds, advanced as
 *      each step is completed, removed by the ending;
 *   2. the server's `username_pending` on /auth/me — the account still has the
 *      temporary `user_<hex>` name finalize() gave it. This covers a resume on
 *      a DIFFERENT device (no marker there) and a marker that was lost, so
 *      nobody is ever left as `user_xxxx`.
 *
 * Key `cipherline_onboarding_r6_<uid>` is device-local (excluded from backups
 * in services/backupRegistry.ts): a restore must never reopen onboarding.
 */

export type OnboardingStepId = 'storage' | 'privacy' | 'profile' | 'invite' | 'ending';

export const ONBOARDING_STEPS: readonly OnboardingStepId[] = ['storage', 'privacy', 'profile', 'invite'];

export interface OnboardingMarker {
    v: 1;
    /** The step to show on resume (the first one not yet completed). */
    step: OnboardingStepId;
    /** ms since epoch the setup started. */
    startedAt: number;
    /** From /auth/finalize — whether the free trial actually started. Absent
     *  when unknown (resumed on another device): the ending then reads the
     *  live subscription instead. */
    trialGranted?: boolean;
    /** From /auth/finalize — whether the referral code applied. */
    referralApplied?: boolean;
    /** From /auth/finalize — referral bonus days (0 when none). */
    bonusDays?: number;
    /** The referral code that applied (spelled in dots on the referral step). */
    referralCode?: string;
}

/** Referral codes are minted as 8 upper-case hex chars; accept the DTO's 6–12. */
const REFERRAL_CODE_SHAPE = /^[A-F0-9]{6,12}$/;

export const onboardingKey = (userId: string) => `cipherline_onboarding_r6_${userId}`;

const STEP_SET = new Set<OnboardingStepId>(['storage', 'privacy', 'profile', 'invite', 'ending']);

/** Pure: parse a stored marker; null for anything malformed. */
export function parseOnboardingMarker(raw: string | null | undefined): OnboardingMarker | null {
    if (!raw) return null;
    try {
        const m = JSON.parse(raw) as Partial<OnboardingMarker>;
        if (!m || typeof m !== 'object' || m.v !== 1) return null;
        if (typeof m.step !== 'string' || !STEP_SET.has(m.step as OnboardingStepId)) return null;
        const out: OnboardingMarker = { v: 1, step: m.step as OnboardingStepId, startedAt: typeof m.startedAt === 'number' ? m.startedAt : 0 };
        if (typeof m.trialGranted === 'boolean') out.trialGranted = m.trialGranted;
        if (typeof m.referralApplied === 'boolean') out.referralApplied = m.referralApplied;
        if (typeof m.bonusDays === 'number' && Number.isFinite(m.bonusDays) && m.bonusDays >= 0) out.bonusDays = m.bonusDays;
        if (typeof m.referralCode === 'string' && REFERRAL_CODE_SHAPE.test(m.referralCode)) out.referralCode = m.referralCode;
        return out;
    } catch {
        return null;
    }
}

export function readOnboarding(userId: string | null | undefined): OnboardingMarker | null {
    if (!userId) return null;
    try { return parseOnboardingMarker(secureLocalStore.getItem(onboardingKey(userId))); } catch { return null; }
}

function write(userId: string, m: OnboardingMarker): void {
    try { secureLocalStore.setItem(onboardingKey(userId), JSON.stringify(m)); } catch { /* best effort — username_pending still resumes */ }
}

/** Signup just created the account: start the setup at the first step. */
export function startOnboarding(
    userId: string,
    info: { trialGranted?: boolean; referralApplied?: boolean; bonusDays?: number; referralCode?: string } = {},
    now: number = Date.now(),
): OnboardingMarker {
    const m: OnboardingMarker = { v: 1, step: 'storage', startedAt: now };
    if (typeof info.trialGranted === 'boolean') m.trialGranted = info.trialGranted;
    if (typeof info.referralApplied === 'boolean') m.referralApplied = info.referralApplied;
    if (typeof info.bonusDays === 'number') m.bonusDays = info.bonusDays;
    if (info.referralCode && REFERRAL_CODE_SHAPE.test(info.referralCode)) m.referralCode = info.referralCode;
    write(userId, m);
    return m;
}

/** Record the step to resume at. Creates the marker when it is missing (a
 *  resume driven only by the server's username_pending). */
export function setOnboardingStep(userId: string, step: OnboardingStepId): void {
    const cur = readOnboarding(userId) ?? { v: 1 as const, step, startedAt: Date.now() };
    write(userId, { ...cur, step });
}

/** The setup is over (the ending played or was skipped): forget the marker. */
export function finishOnboarding(userId: string): void {
    try { secureLocalStore.removeItem(onboardingKey(userId)); } catch { /* ignore */ }
}

/**
 * Pure decision: should the setup be up?
 *   marker present             → yes
 *   server says username_pending → yes (resume elsewhere / lost marker)
 *   otherwise                  → no
 * `usernamePending` is `undefined` until /auth/me has answered (and on an API
 * that predates the field), which never by itself opens the setup.
 */
export function shouldShowOnboarding(marker: OnboardingMarker | null, usernamePending: boolean | undefined): boolean {
    return !!marker || usernamePending === true;
}

/**
 * Where to resume. A marker wins; a server-only resume starts at storage when
 * this device has not chosen its retention yet, otherwise at profile (the one
 * step that must be finished).
 */
export function resumeStep(marker: OnboardingMarker | null, deviceStorageDone: boolean): OnboardingStepId {
    if (marker) return marker.step;
    return deviceStorageDone ? 'profile' : 'storage';
}
