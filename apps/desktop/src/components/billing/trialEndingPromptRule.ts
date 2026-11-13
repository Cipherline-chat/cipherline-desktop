/**
 * The trial-ending prompt: WHO sees it, WHEN, and WHAT it says. Pure, so the
 * rules are unit-tested without React (TrialEndingPrompt.tsx only renders this).
 *
 * Who: a live, internal Pro trial (isTrialBannerEligible: raw status 'trial',
 * server verdict 'active', never a comp) with no paid subscription behind it.
 * Already-paying users, comps and free users whose trial is over never see it.
 *
 * When: the last 3 days. It appears at most TWICE per trial and never twice on
 * the same calendar day: once when the trial enters its last 3 days ('early'),
 * and once more on the last day ('last'). The banner (TrialBanner.tsx) already
 * carries the daily reminder; this is the one moment the offer gets the screen,
 * so it must not become a daily modal. Never during a call (the host passes
 * `blocked`), and a blocked appearance is not counted, so it waits for the
 * call to end rather than being lost.
 *
 * What: the founding offer while the offer is open (`founder.open === true`
 * and nothing else: "Lock in $2.50/mo + tax for as long as you stay
 * subscribed", and the regular price it rises to afterwards). No spot counts
 * (owner, 2026-11-12). Closed, or no founder data (feature off / older API /
 * failed read): the regular variant, just the price THIS account would be
 * charged, and no founder pitch at all.
 *
 * Every price shown is either `plan_amount` (what the API will actually bill)
 * or the shared REGULAR_PRICE_AFTER_FOUNDERS constant (what it rises to). The
 * future price is never read off the billing status: today the standard Stripe
 * Price is still $2.50.
 */
import {
    formatPlanPrice, founderOfferApplies, regularPriceAfterFoundersLabel,
    REGULAR_PRICE_AFTER_FOUNDERS_MINOR, REGULAR_PRICE_AFTER_FOUNDERS_CURRENCY, FALLBACK_PLAN_AMOUNT_MINOR,
    FOUNDER_BADGE_NAME, type FounderStatus, type PlanIntervalStatus,
} from '@cipherline/shared';
import { isTrialBannerEligible } from './trialBannerRule';
import { yearlyUpsellLabel } from './planInterval';

export interface TrialPromptStatus {
    subscription_status: string;
    effective_status: string;
    is_comp?: boolean;
    trial_days_left: number;
    trial_ends_at?: string | null;
    has_subscription?: boolean;
    plan_amount?: number | null;
    plan_currency?: string | null;
    /** Yearly plans (absent on an older API = monthly only). */
    intervals_available?: PlanIntervalStatus['intervals_available'];
    plan_prices?: PlanIntervalStatus['plan_prices'];
    founder?: FounderStatus | null;
}

/** The window the prompt opens in. */
export const TRIAL_PROMPT_WINDOW_DAYS = 3;

export type TrialPromptStage = 'early' | 'last';

/** What has been shown on this device: stage -> local day (YYYY-MM-DD). */
export interface TrialPromptRecord {
    early?: string;
    last?: string;
}

/** secureLocalStore key, per account (classified in services/backupRegistry.ts). */
export const trialPromptKey = (uid: string) => `cipherline_trial_prompt_shown_${uid}`;

/** Local calendar day as YYYY-MM-DD: "once per day" follows the user's own day. */
export function localDay(d: Date = new Date()): string {
    const m = `${d.getMonth() + 1}`.padStart(2, '0');
    const day = `${d.getDate()}`.padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
}

export function parseTrialPromptRecord(raw: string | null | undefined): TrialPromptRecord {
    if (!raw) return {};
    try {
        const v = JSON.parse(raw) as unknown;
        if (!v || typeof v !== 'object') return {};
        const o = v as Record<string, unknown>;
        const out: TrialPromptRecord = {};
        if (typeof o.early === 'string') out.early = o.early;
        if (typeof o.last === 'string') out.last = o.last;
        return out;
    } catch {
        return {};
    }
}

/** Is this account in the audience at all (ignoring dates and history)? */
export function trialPromptAudience(s: TrialPromptStatus | null | undefined): boolean {
    if (!s) return false;
    if (!isTrialBannerEligible(s)) return false;          // comp, paid, lapsed trial, free
    if (s.has_subscription === true) return false;        // a real subscription already exists
    return true;
}

/** Which stage the trial is in now, or null outside the window. */
export function trialPromptStage(s: TrialPromptStatus | null | undefined): TrialPromptStage | null {
    if (!trialPromptAudience(s)) return null;
    const days = s!.trial_days_left;
    if (!Number.isFinite(days) || days > TRIAL_PROMPT_WINDOW_DAYS) return null;
    // trial_days_left is ceil(time left / 24h): 1 means "under a day to go".
    return days <= 1 ? 'last' : 'early';
}

/**
 * The stage to show right now, or null. Never twice in one local day, never
 * the same stage twice, never while `blocked` (a call, onboarding, another
 * celebration on screen).
 */
export function trialPromptToShow(input: {
    status: TrialPromptStatus | null | undefined;
    record: TrialPromptRecord;
    today: string;
    blocked: boolean;
}): TrialPromptStage | null {
    if (input.blocked) return null;
    const stage = trialPromptStage(input.status);
    if (!stage) return null;
    const { record, today } = input;
    if (record.early === today || record.last === today) return null;   // once per day
    if (record[stage]) return null;                                     // once per stage
    return stage;
}

/** The record after showing `stage` today. */
export function recordTrialPromptShown(record: TrialPromptRecord, stage: TrialPromptStage, today: string): TrialPromptRecord {
    return { ...record, [stage]: today };
}

export interface TrialPromptCopy {
    variant: 'founder' | 'regular';
    /** "Pro trial · 2 days left" */
    eyebrow: string;
    /** "Your Pro trial ends in 2 days" */
    title: string;
    /** The price this account would be billed, without "+ tax" (the label beside it says it). */
    priceAmount: string;
    /** "/mo + tax" */
    priceSuffix: string;
    /** Under the price. */
    priceNote: string;
    /** Founder variant: what the price rises to afterwards. */
    riseNote: string | null;
    /** Founder variant: the hero headline ("Lock in half price"). */
    headline: string | null;
    /** Founder variant: the honest qualifier under the headline. */
    qualifier: string | null;
    /** Founder variant: the future regular price (the shared constant), shown struck through. */
    wasPrice: string | null;
    /** "Prefer yearly? $30.00/yr + tax" — only when the API offers yearly, else null. */
    yearlyNote: string | null;
    /** Short checklist of what Pro keeps. */
    perks: string[];
    primaryLabel: string;
    secondaryLabel: string;
    /** Reassurance about what happens if they do nothing. */
    footnote: string;
}

function endsPhrase(s: TrialPromptStatus, now: Date): string {
    const days = Math.max(0, s.trial_days_left);
    if (days >= 2) return `ends in ${days} days`;
    // Under a day left: say "today" or "tomorrow" only when the end date says so.
    const end = s.trial_ends_at ? new Date(s.trial_ends_at) : null;
    if (end && !Number.isNaN(end.getTime())) {
        if (localDay(end) === localDay(now)) return 'ends today';
        const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
        if (localDay(end) === localDay(tomorrow)) return 'ends tomorrow';
    }
    return 'ends in less than a day';
}

/**
 * "Half price" only when it is (within 2 cents of half the regular price): the
 * account would be billed in the constant's currency and twice its price is
 * within 2 cents of the regular price. Anything else gets a neutral headline,
 * so a price change can never leave a false "half" on screen. Never "for life":
 * the lock lasts only while the subscription does (founder-pricing.service.ts).
 */
export function founderHeadline(s: Pick<TrialPromptStatus, 'plan_amount' | 'plan_currency'>): string {
    const amount = s.plan_amount ?? FALLBACK_PLAN_AMOUNT_MINOR;
    const currency = (s.plan_currency || 'usd').toLowerCase();
    const half = currency === REGULAR_PRICE_AFTER_FOUNDERS_CURRENCY
        && Math.abs(amount * 2 - REGULAR_PRICE_AFTER_FOUNDERS_MINOR) <= 2;
    return half ? 'Lock in half price' : 'Lock in your founding price';
}

export function trialPromptCopy(s: TrialPromptStatus, now: Date = new Date()): TrialPromptCopy {
    const days = Math.max(0, s.trial_days_left);
    const founderOpen = founderOfferApplies(s.founder);
    const bare = formatPlanPrice(s.plan_amount, s.plan_currency, { period: null, tax: false });
    const perMonth = formatPlanPrice(s.plan_amount, s.plan_currency, { period: 'mo', tax: false });
    const yearly = yearlyUpsellLabel(s);
    const common = {
        yearlyNote: yearly ? `Prefer yearly? ${yearly}.` : null,
        eyebrow: days <= 1 ? 'Pro trial · last day' : `Pro trial · ${days} days left`,
        title: `Your Pro trial ${endsPhrase(s, now)}`,
        priceAmount: bare,
        priceSuffix: '/mo + tax',
        secondaryLabel: 'Maybe later',
        footnote: 'If you do nothing you move to the free plan: messages, audio calls and encrypted backups keep working.',
    };
    if (founderOpen) {
        return {
            ...common,
            variant: 'founder',
            eyebrow: `Founding offer · trial ${endsPhrase(s, now)}`,
            headline: founderHeadline(s),
            qualifier: 'for as long as you stay subscribed',
            wasPrice: regularPriceAfterFoundersLabel({ period: null, tax: false }),
            priceNote: 'If your subscription ever ends, so does the founding price.',
            riseNote: `After the first 10,000 subscribers, Pro goes up to ${regularPriceAfterFoundersLabel({ period: 'mo' })}.`,
            perks: [`The ${FOUNDER_BADGE_NAME} on your profile`, 'Video calls and screen share', '2 GB uploads and bigger server storage'],
            primaryLabel: `Lock in ${perMonth}`,
        };
    }
    return {
        ...common,
        variant: 'regular',
        priceNote: 'Renews monthly until you cancel. Cancelling takes two clicks.',
        riseNote: null,
        headline: null,
        qualifier: null,
        wasPrice: null,
        perks: ['Video calls and screen share', '2 GB uploads', 'Bigger server storage'],
        primaryLabel: `Keep Pro at ${perMonth}`,
    };
}
