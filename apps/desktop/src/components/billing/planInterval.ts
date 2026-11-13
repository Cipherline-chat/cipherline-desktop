/**
 * Pure helpers for the monthly / yearly choice, shared by the checkout, the
 * Settings plan card and the upsell copy. Nothing here touches the network or
 * React, so every rule is unit-tested (planInterval.test.ts).
 *
 * The client only MIRRORS what the server enforces: the interval, the price
 * and the switch rules all live in the API. Yearly is offered only when the API
 * says so (`intervals_available` includes 'year'); an older API sends none of
 * these fields and every helper then degrades to monthly-only.
 *
 * Wording rule (owner, 2026-11-12): a founder keeps the founding price "for as
 * long as you stay subscribed", never "for life", and the founding yearly plan
 * ($30/yr = 12 x $2.50) carries NO discount badge. "2 months free" appears only
 * on the regular yearly price.
 */
import {
    REGULAR_YEARLY_PRICE_MINOR,
    YEARLY_SAVINGS_LABEL,
    formatMoney,
    formatBillingDate,
    formatPlanPrice,
    intervalPeriod,
    yearlyOffered,
    type BillingInterval,
    type CheckoutConfig,
    type IntervalChangePreview,
    type PlanIntervalStatus,
} from '@cipherline/shared';

export interface IntervalPrice { amount: number; currency: string }
export type IntervalPrices = Partial<Record<BillingInterval, IntervalPrice>>;

function usable(p: { amount: number | null; currency: string | null } | undefined): IntervalPrice | null {
    return p && typeof p.amount === 'number' && p.amount > 0 && p.currency
        ? { amount: p.amount, currency: p.currency.toLowerCase() }
        : null;
}

/**
 * What the checkout may offer, from GET /billing/checkout-config. Yearly needs
 * BOTH the API's say-so and a usable yearly quote; without either the picker is
 * hidden and the checkout behaves exactly as it did before yearly plans.
 */
export function checkoutIntervals(
    cfg: Pick<CheckoutConfig, 'amount' | 'currency' | 'intervals_available' | 'prices' | 'interval'>,
    fallback: IntervalPrice,
): { yearly: boolean; prices: IntervalPrices } {
    const month = usable(cfg.prices?.month)
        ?? (cfg.interval !== 'year' && cfg.amount != null && cfg.currency ? { amount: cfg.amount, currency: cfg.currency.toLowerCase() } : null)
        ?? fallback;
    const year = usable(cfg.prices?.year);
    const yearly = yearlyOffered(cfg) && !!year;
    return { yearly, prices: yearly && year ? { month, year } : { month } };
}

/** The price the checkout quotes for `interval` (month when yearly is unavailable). */
export function quoteFor(interval: BillingInterval, prices: IntervalPrices): IntervalPrice {
    return (interval === 'year' ? prices.year : undefined) ?? prices.month ?? { amount: 250, currency: 'usd' };
}

/**
 * "2 months free", but only on the REGULAR yearly price: the year must be the
 * regular yearly amount AND genuinely cheaper than twelve months. The founding
 * yearly price (12 x the founding monthly price) therefore never gets a badge,
 * whatever the API sends.
 */
export function yearlySavingsBadge(prices: IntervalPrices): string | null {
    const { month, year } = prices;
    if (!month || !year) return null;
    return year.amount === REGULAR_YEARLY_PRICE_MINOR && year.amount < month.amount * 12 ? YEARLY_SAVINGS_LABEL : null;
}

export interface IntervalOption {
    interval: BillingInterval;
    label: 'Monthly' | 'Yearly';
    /** "$2.50/mo" or "$30.00/yr" (tax is stated once, in the quote line below). */
    priceLabel: string;
    badge: string | null;
}

/** The two segments of the picker, in order. */
export function intervalOptions(prices: IntervalPrices): IntervalOption[] {
    const badge = yearlySavingsBadge(prices);
    return (['month', 'year'] as const).filter((i) => !!prices[i]).map((interval) => {
        const p = quoteFor(interval, prices);
        return {
            interval,
            label: interval === 'year' ? 'Yearly' : 'Monthly',
            priceLabel: formatPlanPrice(p.amount, p.currency, { period: intervalPeriod(interval), tax: false }),
            badge: interval === 'year' ? badge : null,
        };
    });
}

/* ── Settings: the current plan's interval ───────────────────────────────── */

export type PlanIntervalView = Pick<PlanIntervalStatus, 'plan_interval' | 'intervals_available' | 'plan_prices' | 'pending_interval' | 'pending_interval_at'>;

/** The interval the current plan bills on (monthly for an older API). */
export function currentInterval(s: PlanIntervalView | null | undefined): BillingInterval {
    return s?.plan_interval === 'year' ? 'year' : 'month';
}

/** "billed yearly" / "billed monthly" (monthly only when we already say something about yearly). */
export function billedLabel(interval: BillingInterval): string {
    return interval === 'year' ? 'billed yearly' : 'billed monthly';
}

/** Plan name line: "Cipherline Pro, billed yearly". Monthly stays "Cipherline Pro" (unchanged). */
export function planNameWithInterval(base: string, interval: BillingInterval, show: boolean): string {
    return show && interval === 'year' ? `${base}, ${billedLabel(interval)}` : base;
}

/**
 * Who may see "Switch to yearly/monthly": an active, paid (not comp), not
 * past-due plan with no scheduled cancel, on an API that offers yearly. The
 * server refuses everything else too (and says why).
 */
export function canSwitchInterval(s: {
    subscription_status: string;
    effective_status: string;
    is_comp?: boolean;
    intervals_available?: readonly BillingInterval[] | null;
}): boolean {
    return s.subscription_status === 'active'
        && s.effective_status === 'active'
        && s.is_comp !== true
        && yearlyOffered(s);
}

export function switchActionLabel(current: BillingInterval): string {
    return current === 'year' ? 'Switch to monthly' : 'Switch to yearly';
}

export function targetInterval(current: BillingInterval): BillingInterval {
    return current === 'year' ? 'month' : 'year';
}

export function formatSwitchDate(iso: string | null | undefined): string | null {
    return formatBillingDate(iso ?? null);
}

export interface SwitchConfirmCopy {
    title: string;
    /** Each paragraph, in order. */
    lines: string[];
    /** Confirm button. */
    confirmLabel: string;
}

/**
 * Exactly what happens, and when, from the server's read-only preview.
 *
 *  monthly -> yearly  charged NOW (prorated credit for the unused month applied),
 *                     then the yearly price from the next renewal date.
 *  yearly -> monthly  nothing today, no refund; switches at the END of the paid year.
 *
 * Returns null while the preview cannot support honest copy (no date, or an
 * immediate switch whose charge could not be computed): the UI then shows the
 * server's error / a retry instead of guessing.
 */
export function switchConfirmCopy(input: {
    from: BillingInterval;
    preview: IntervalChangePreview;
    /** A founder keeps the founding price across the switch; say so. */
    isFounder: boolean;
}): SwitchConfirmCopy | null {
    const { from, preview, isFounder } = input;
    const date = formatSwitchDate(preview.effective_at);
    const keep = isFounder ? ' You keep your founding price.' : '';
    if (from === 'month') {
        if (preview.interval !== 'year' || preview.amount_due_now == null || !preview.currency || preview.new_price == null || !date) return null;
        const today = formatMoney(preview.amount_due_now, preview.currency);
        const yearly = formatPlanPrice(preview.new_price, preview.currency, { period: 'yr' });
        return {
            title: 'Switch to yearly billing?',
            lines: [
                `You'll be charged ${today} today (prorated credit for the unused part of this month applied), then ${yearly} from ${date}.${keep}`,
            ],
            confirmLabel: `Switch and pay ${today}`,
        };
    }
    if (preview.interval !== 'month' || !date) return null;
    return {
        title: 'Switch to monthly billing?',
        lines: [
            `Your plan switches to monthly on ${date} (the end of the year you've paid for). Nothing changes today and there is no refund.${keep}`,
        ],
        confirmLabel: 'Switch to monthly',
    };
}

/** "Switches to monthly on Nov 12, 2027." shown while a switch is pending. */
export function pendingSwitchLine(s: PlanIntervalView | null | undefined): string | null {
    if (!s?.pending_interval) return null;
    const date = formatSwitchDate(s.pending_interval_at);
    return `Switches to ${intervalAdverbLower(s.pending_interval)} on ${date ?? 'the end of your paid period'}.`;
}

function intervalAdverbLower(i: BillingInterval): string {
    return i === 'year' ? 'yearly' : 'monthly';
}

/** Toast after a switch call, from what the server reports it did (never from what we asked for). */
export function switchResultMessage(
    kind: 'switch' | 'undo',
    requested: BillingInterval,
    r: { plan_interval: BillingInterval; pending_interval: BillingInterval | null; pending_interval_at: string | null },
): string {
    if (kind === 'undo') {
        return r.pending_interval
            ? `Your switch to ${intervalAdverbLower(r.pending_interval)} is still scheduled. Please try again.`
            : `Switch cancelled. You stay on ${r.plan_interval === 'year' ? 'yearly' : 'monthly'} billing.`;
    }
    if (requested === 'year' && r.plan_interval === 'year') return 'You are now on yearly billing.';
    if (requested === 'month' && r.pending_interval === 'month') {
        const d = formatSwitchDate(r.pending_interval_at);
        return `Done. Your plan switches to monthly on ${d ?? 'the end of your paid year'}.`;
    }
    if (requested === 'month' && r.plan_interval === 'month') return 'You are now on monthly billing.';
    return 'Your billing interval was updated.';
}

/** Upsell suffix for a not-yet-subscribed user: "$30.00/yr + tax" / "$49.99/yr + tax (2 months free)". Null when yearly isn't offered. */
export function yearlyUpsellLabel(s: Pick<PlanIntervalStatus, 'intervals_available' | 'plan_prices'> | null | undefined): string | null {
    if (!yearlyOffered(s)) return null;
    const year = usable(s?.plan_prices?.year);
    if (!year) return null;
    const month = usable(s?.plan_prices?.month);
    const price = formatPlanPrice(year.amount, year.currency, { period: 'yr' });
    const badge = yearlySavingsBadge(month ? { month, year } : { year });
    return badge ? `${price} (${badge})` : price;
}
