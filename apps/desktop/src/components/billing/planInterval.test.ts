/**
 * The monthly / yearly rules as pure functions: what checkout may offer, what the
 * badge may say, when "Switch to ..." shows, and the exact words of the switch
 * confirmation (what is charged today, what changes when).
 */
import { describe, it, expect } from 'vitest';
import { formatBillingDate, type IntervalChangePreview } from '@cipherline/shared';
import {
    billedLabel, canSwitchInterval, checkoutIntervals, currentInterval, intervalOptions, pendingSwitchLine,
    planNameWithInterval, quoteFor, switchActionLabel, switchConfirmCopy, switchResultMessage, targetInterval,
    yearlySavingsBadge, yearlyUpsellLabel,
} from './planInterval';

const FALLBACK = { amount: 250, currency: 'usd' };
const FOUNDER = { month: { amount: 250, currency: 'usd' }, year: { amount: 3000, currency: 'usd' } };
const REGULAR = { month: { amount: 499, currency: 'usd' }, year: { amount: 4999, currency: 'usd' } };
const END = '2027-11-12T12:00:00Z';
const END_LABEL = formatBillingDate(END)!;

describe('checkoutIntervals: yearly needs the API\'s say-so AND a usable yearly quote', () => {
    const base = { amount: 250, currency: 'usd', interval: 'month' as const };
    it('offered with both prices', () => {
        const r = checkoutIntervals({ ...base, intervals_available: ['month', 'year'], prices: FOUNDER }, FALLBACK);
        expect(r.yearly).toBe(true);
        expect(r.prices).toEqual(FOUNDER);
    });
    it('an older API (no interval fields) is monthly-only, quoted from amount/currency', () => {
        const r = checkoutIntervals({ amount: 250, currency: 'USD' }, FALLBACK);
        expect(r).toEqual({ yearly: false, prices: { month: { amount: 250, currency: 'usd' } } });
    });
    it('year listed but not quoted (null amount) -> hidden', () => {
        const r = checkoutIntervals({ ...base, intervals_available: ['month', 'year'], prices: { month: FOUNDER.month, year: { amount: null, currency: null } } }, FALLBACK);
        expect(r.yearly).toBe(false);
        expect(r.prices.year).toBeUndefined();
    });
    it('year quoted but not in intervals_available -> hidden', () => {
        const r = checkoutIntervals({ ...base, intervals_available: ['month'], prices: FOUNDER }, FALLBACK);
        expect(r.yearly).toBe(false);
        expect(r.prices.year).toBeUndefined();
    });
    it('falls back to the fallback monthly price when nothing is readable', () => {
        expect(checkoutIntervals({ amount: null, currency: null }, FALLBACK).prices.month).toEqual(FALLBACK);
    });
});

describe('quoteFor', () => {
    it('year -> yearly quote; month -> monthly; year without a yearly quote -> monthly', () => {
        expect(quoteFor('year', FOUNDER)).toEqual(FOUNDER.year);
        expect(quoteFor('month', FOUNDER)).toEqual(FOUNDER.month);
        expect(quoteFor('year', { month: FOUNDER.month })).toEqual(FOUNDER.month);
    });
});

describe('yearlySavingsBadge: never a discount badge on the founding price', () => {
    it('regular yearly -> "2 months free"', () => expect(yearlySavingsBadge(REGULAR)).toBe('2 months free'));
    it('founding yearly (12 x 2.50) -> none', () => expect(yearlySavingsBadge(FOUNDER)).toBeNull());
    it('a yearly amount that is not the regular price -> none, whatever it is', () => {
        expect(yearlySavingsBadge({ month: REGULAR.month, year: { amount: 4000, currency: 'usd' } })).toBeNull();
    });
    it('no yearly or no monthly quote -> none', () => {
        expect(yearlySavingsBadge({ month: REGULAR.month })).toBeNull();
        expect(yearlySavingsBadge({ year: REGULAR.year })).toBeNull();
    });
});

describe('intervalOptions', () => {
    it('founder: Monthly $2.50/mo, Yearly $30.00/yr, no badge', () => {
        expect(intervalOptions(FOUNDER)).toEqual([
            { interval: 'month', label: 'Monthly', priceLabel: '$2.50/mo', badge: null },
            { interval: 'year', label: 'Yearly', priceLabel: '$30.00/yr', badge: null },
        ]);
    });
    it('regular: the badge is on Yearly only', () => {
        const o = intervalOptions(REGULAR);
        expect(o.map((x) => x.badge)).toEqual([null, '2 months free']);
        expect(o[1].priceLabel).toBe('$49.99/yr');
    });
});

describe('current interval + plan name', () => {
    it('defaults to month; year only when the API says so', () => {
        expect(currentInterval(null)).toBe('month');
        expect(currentInterval({})).toBe('month');
        expect(currentInterval({ plan_interval: 'year' })).toBe('year');
    });
    it('"Cipherline Pro, billed yearly" for yearly; monthly stays unchanged', () => {
        expect(planNameWithInterval('Cipherline Pro', 'year', true)).toBe('Cipherline Pro, billed yearly');
        expect(planNameWithInterval('Cipherline Pro', 'month', true)).toBe('Cipherline Pro');
        expect(billedLabel('year')).toBe('billed yearly');
    });
});

describe('canSwitchInterval: active, paid, not comp, yearly offered', () => {
    const ok = { subscription_status: 'active', effective_status: 'active', intervals_available: ['month', 'year'] as ('month' | 'year')[] };
    it('shows for an active paid plan', () => expect(canSwitchInterval(ok)).toBe(true));
    it('not when yearly is not offered (older API)', () => {
        expect(canSwitchInterval({ ...ok, intervals_available: undefined })).toBe(false);
        expect(canSwitchInterval({ ...ok, intervals_available: ['month'] })).toBe(false);
    });
    it.each([
        ['comp', { is_comp: true }],
        ['cancel scheduled', { subscription_status: 'canceled_pending' }],
        ['past due', { subscription_status: 'past_due' }],
        ['trial', { subscription_status: 'trial' }],
        ['expired', { effective_status: 'expired' }],
    ])('not for %s', (_n, over) => expect(canSwitchInterval({ ...ok, ...over })).toBe(false));
    it('labels', () => {
        expect(switchActionLabel('month')).toBe('Switch to yearly');
        expect(switchActionLabel('year')).toBe('Switch to monthly');
        expect(targetInterval('month')).toBe('year');
        expect(targetInterval('year')).toBe('month');
    });
});

describe('switchConfirmCopy: says exactly what happens and when', () => {
    const toYearly: IntervalChangePreview = { interval: 'year', effective: 'now', amount_due_now: 2400, currency: 'usd', new_price: 4999, effective_at: END };
    const toMonthly: IntervalChangePreview = { interval: 'month', effective: 'period_end', amount_due_now: 0, currency: 'usd', new_price: 499, effective_at: END };

    it('monthly -> yearly: charged today (prorated credit applied), then the yearly price from the date', () => {
        const c = switchConfirmCopy({ from: 'month', preview: toYearly, isFounder: false })!;
        expect(c.lines[0]).toBe(`You'll be charged $24.00 today (prorated credit for the unused part of this month applied), then $49.99/yr + tax from ${END_LABEL}.`);
        expect(c.confirmLabel).toBe('Switch and pay $24.00');
    });
    it('a founder is told they keep the founding price', () => {
        const c = switchConfirmCopy({ from: 'month', preview: { ...toYearly, amount_due_now: 1500, new_price: 3000 }, isFounder: true })!;
        expect(c.lines[0]).toContain('then $30.00/yr + tax from');
        expect(c.lines[0]).toMatch(/You keep your founding price\.$/);
        expect(c.lines[0]).not.toMatch(/for life/i);
    });
    it('yearly -> monthly: nothing today, no refund, switches at the end of the paid year', () => {
        const c = switchConfirmCopy({ from: 'year', preview: toMonthly, isFounder: false })!;
        expect(c.lines[0]).toBe(`Your plan switches to monthly on ${END_LABEL} (the end of the year you've paid for). Nothing changes today and there is no refund.`);
        expect(c.confirmLabel).toBe('Switch to monthly');
    });
    it('yearly -> monthly for a founder also says they keep the founding price', () => {
        const c = switchConfirmCopy({ from: 'year', preview: toMonthly, isFounder: true })!;
        expect(c.lines[0]).toMatch(/there is no refund\. You keep your founding price\.$/);
    });
    it('refuses to guess: missing date, uncomputed charge, or a preview for the wrong interval -> null', () => {
        expect(switchConfirmCopy({ from: 'month', preview: { ...toYearly, effective_at: null }, isFounder: false })).toBeNull();
        expect(switchConfirmCopy({ from: 'month', preview: { ...toYearly, amount_due_now: null }, isFounder: false })).toBeNull();
        expect(switchConfirmCopy({ from: 'month', preview: toMonthly, isFounder: false })).toBeNull();
        expect(switchConfirmCopy({ from: 'year', preview: { ...toMonthly, effective_at: null }, isFounder: false })).toBeNull();
        expect(switchConfirmCopy({ from: 'year', preview: toYearly, isFounder: false })).toBeNull();
    });
});

describe('pending switch', () => {
    it('"Switches to monthly on <date>." when pending', () => {
        expect(pendingSwitchLine({ pending_interval: 'month', pending_interval_at: END })).toBe(`Switches to monthly on ${END_LABEL}.`);
    });
    it('nothing when not pending', () => {
        expect(pendingSwitchLine({ pending_interval: null })).toBeNull();
        expect(pendingSwitchLine({})).toBeNull();
        expect(pendingSwitchLine(null)).toBeNull();
    });
    it('a pending switch with no date still reads honestly', () => {
        expect(pendingSwitchLine({ pending_interval: 'month', pending_interval_at: null })).toBe('Switches to monthly on the end of your paid period.');
    });
    it('result toasts follow what the server reports, not what was asked', () => {
        const yearly = { plan_interval: 'year' as const, pending_interval: null, pending_interval_at: null };
        const scheduled = { plan_interval: 'year' as const, pending_interval: 'month' as const, pending_interval_at: END };
        const monthly = { plan_interval: 'month' as const, pending_interval: null, pending_interval_at: null };
        expect(switchResultMessage('switch', 'year', yearly)).toBe('You are now on yearly billing.');
        expect(switchResultMessage('switch', 'month', scheduled)).toBe(`Done. Your plan switches to monthly on ${END_LABEL}.`);
        expect(switchResultMessage('switch', 'month', monthly)).toBe('You are now on monthly billing.');
    });
    it('undo reads as cancelled only if the server cleared it; otherwise it says it is still scheduled', () => {
        const cleared = { plan_interval: 'year' as const, pending_interval: null, pending_interval_at: null };
        const still = { plan_interval: 'year' as const, pending_interval: 'month' as const, pending_interval_at: END };
        expect(switchResultMessage('undo', 'year', cleared)).toBe('Switch cancelled. You stay on yearly billing.');
        expect(switchResultMessage('undo', 'year', still)).toMatch(/still scheduled/);
    });
});

describe('yearlyUpsellLabel: brief, only when offered', () => {
    it('founder: "$30.00/yr + tax", no badge', () => {
        expect(yearlyUpsellLabel({ intervals_available: ['month', 'year'], plan_prices: FOUNDER })).toBe('$30.00/yr + tax');
    });
    it('regular: "$49.99/yr + tax (2 months free)"', () => {
        expect(yearlyUpsellLabel({ intervals_available: ['month', 'year'], plan_prices: REGULAR })).toBe('$49.99/yr + tax (2 months free)');
    });
    it('hidden when not offered or not quoted', () => {
        expect(yearlyUpsellLabel({ plan_prices: REGULAR })).toBeNull();
        expect(yearlyUpsellLabel({ intervals_available: ['month'], plan_prices: REGULAR })).toBeNull();
        expect(yearlyUpsellLabel({ intervals_available: ['month', 'year'], plan_prices: { month: REGULAR.month } })).toBeNull();
        expect(yearlyUpsellLabel(null)).toBeNull();
    });
});
