/**
 * What the ending's trial beat says — a pure decision over the facts the
 * client has, so the honesty rules are pinned by tests (endingTrial.test.ts).
 *
 * The server facts (auth.service finalize()):
 *   - the 7-day trial starts when the account is created, unless the per-
 *     network quota withheld it (P2-BILL-6) — then `trial_granted: false`;
 *   - a valid referral adds 7 days (`bonus_days`) AND overrides a withheld
 *     trial (it acts as a voucher: a 7-day trial "started by <who>'s link").
 *
 * Note: finalize() reports `trial_granted` AFTER the voucher has applied, so
 * a voucher arrives as `trialGranted: true` + a referral. The live
 * `trialEndsAt` tells the two apart (≈7 days left = the voucher, ≈14 = a
 * granted trial plus the bonus); without it we fall back to the sum.
 *
 * `trialGranted === undefined` means "unknown" (the setup resumed without the
 * finalize marker): never claim the trial was withheld then — read the live
 * subscription instead, and say nothing about a trial it does not show.
 */

const DAY_MS = 24 * 3600_000;
/** The base trial finalize() grants (auth.service TRIAL_DAYS). */
export const BASE_TRIAL_DAYS = 7;

export interface TrialFactsInput {
    /** From /auth/finalize; undefined = unknown. Only an explicit `false` means withheld. */
    trialGranted?: boolean;
    referralApplied?: boolean;
    /** Referral bonus days (finalize: 7 when the referral applied, else 0). */
    bonusDays?: number;
    /** The referrer's username, when known. */
    referrerName?: string | null;
    /** The live subscription (SubscriptionContext). */
    subscription?: { status: string | null; trialEndsAt: string | null } | null;
    /** For tests. */
    now?: number;
}

export type TrialBeat =
    | {
        kind: 'started';
        /** null when the length is unknown ("Your Pro trial has started."). */
        days: number | null;
        title: string;
        sub: string;
        /** Started by a referral voucher (the trial itself was withheld). */
        voucher: boolean;
        /** Includes the referral bonus. */
        bonus: boolean;
    }
    | { kind: 'withheld'; title: string; sub: string };

const FREE_STAYS = 'When it ends, everything free stays free.';

/** "sam" → "Sam" (the prototype's "Sam’s link"). */
export function linkOwner(name: string | null | undefined): string {
    const n = (name ?? '').trim();
    if (!n) return 'your friend’s link';
    return `${n}’s link`; // a username is an identity: never re-cased
}

/** Whole days left on the live trial, or null when unknown. */
function liveDaysLeft(sub: TrialFactsInput['subscription'], now: number): number | null {
    if (!sub?.trialEndsAt) return null;
    const end = Date.parse(sub.trialEndsAt);
    if (!Number.isFinite(end)) return null;
    return (end - now) / DAY_MS;
}

function started(days: number | null, why: string, voucher: boolean, bonus: boolean): TrialBeat {
    return {
        kind: 'started',
        days,
        title: days ? `Your ${days}-day Pro trial has started.` : 'Your Pro trial has started.',
        sub: `${why} ${FREE_STAYS}`,
        voucher,
        bonus,
    };
}

/**
 * The trial beat, or null when there is nothing honest to say about a trial
 * (unknown facts and the live subscription is not a trial).
 */
export function decideTrialBeat(i: TrialFactsInput): TrialBeat | null {
    const now = i.now ?? Date.now();
    const bonusDays = i.referralApplied === true ? Math.max(0, Math.round(i.bonusDays ?? 7)) : 0;
    const refBonus = bonusDays > 0;
    const who = linkOwner(i.referrerName);

    if (i.trialGranted === false) {
        // The referral acts as a voucher for a fresh trial of its own length.
        if (refBonus) return started(bonusDays, `Started by ${who}.`, true, false);
        return {
            kind: 'withheld',
            title: 'Your free trial didn’t start this time.',
            sub: 'Only a few trials can start from one network each day, and yours hit that limit. Everything free is still yours, and you can go Pro any time in Settings → Billing.',
        };
    }

    if (i.trialGranted === true) {
        if (!refBonus) return started(BASE_TRIAL_DAYS, 'No card needed.', false, false);
        // finalize() reports the voucher as granted; the live end date tells.
        const left = liveDaysLeft(i.subscription, now);
        if (left !== null && left < bonusDays + BASE_TRIAL_DAYS / 2) {
            return started(bonusDays, `Started by ${who}.`, true, false);
        }
        return started(BASE_TRIAL_DAYS + bonusDays, `${BASE_TRIAL_DAYS} days, plus ${bonusDays} from ${who}.`, false, true);
    }

    // Unknown: only what the live subscription shows.
    if (i.subscription?.status === 'trial') {
        const left = liveDaysLeft(i.subscription, now);
        const days = left !== null && left > 0 ? Math.max(1, Math.round(left)) : null;
        return started(days, 'No card needed.', false, false);
    }
    return null;
}

/**
 * Does this new account have a trial running? The onboarding profile card
 * shows the Pro pill exactly when it does (the API gives an active trial the
 * same `is_pro` a paying user gets; an account whose trial was withheld is
 * free and shows none). The same facts as the ending's trial beat, so the two
 * can never disagree: a started beat (granted, voucher, or a live trial on a
 * resume that lost the marker) is a trial; a withheld or unknown-and-not-
 * trialling account is not.
 */
export function hasLiveTrial(i: TrialFactsInput): boolean {
    return decideTrialBeat(i)?.kind === 'started';
}
