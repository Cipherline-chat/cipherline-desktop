// @vitest-environment jsdom
/**
 * Settings > Subscription: the monthly / yearly switch, rendered through the real
 * BillingTab with the context hooks faked.
 *
 *   - "Switch to yearly" / "Switch to monthly" only for an active paid plan with no
 *     scheduled cancel on an API that offers yearly (never for comps etc.)
 *   - the first click only PREVIEWS; nothing is sent until the confirm button
 *   - the confirm states exactly what is charged today and what changes when
 *   - a pending switch shows its date and an Undo that re-requests the CURRENT interval
 *   - the current-plan line and founder copy follow the plan's interval
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { formatBillingDate } from '@cipherline/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const { ctx, stable } = vi.hoisted(() => {
    const stable = {
        refresh: async () => undefined,
        openInAppCheckout: () => undefined,
        extendTrial: async () => ({ ok: true }),
        fetchPaymentMethod: async () => ({ ok: true, paymentMethod: null }),
        fetchInvoices: async () => ({ ok: true, invoices: [] as unknown[] }),
        setCancellation: async () => ({ ok: true, settled: true }),
        pushes: [] as Array<Record<string, unknown>>,
    };
    return {
        stable,
        ctx: {
            status: null as Record<string, unknown> | null,
            previewIntervalChange: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
            changeInterval: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
        },
    };
});

vi.mock('../../contexts/SubscriptionContext', () => ({
    useSubscription: () => ({
        status: ctx.status, statusError: null, refresh: stable.refresh, openInAppCheckout: stable.openInAppCheckout,
        extendTrial: stable.extendTrial, setCancellation: stable.setCancellation,
        fetchPaymentMethod: stable.fetchPaymentMethod, fetchInvoices: stable.fetchInvoices,
        previewIntervalChange: ctx.previewIntervalChange, changeInterval: ctx.changeInterval,
    }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ token: 'tok', userId: 'u1' }) }));
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ push: (t: Record<string, unknown>) => { stable.pushes.push(t); } }) }));
vi.mock('../../hooks/useServerStorageStatus', () => ({ useOwnedServersOverFreeStorage: () => ({ overCount: 0 }) }));
vi.mock('axios', () => ({ default: { get: vi.fn(async () => ({ data: { referral_code: null, referrals_count: 0, rewards_claimed: 0, max_referrals: 5, days_per_referral: 7 } })) } }));
vi.mock('../../utils/firstWeekNudgeStore', () => ({ nudges: { dismiss: vi.fn(), markDone: vi.fn(), complete: vi.fn() } }));

window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { BillingTab } = await import('./BillingTab');

const END = '2027-11-12T12:00:00Z';
const END_LABEL = formatBillingDate(END)!;
const status = (over: Record<string, unknown> = {}) => ({
    subscription_status: 'active', effective_status: 'active', trial_ends_at: null, trial_extended: false,
    trial_days_left: 0, current_period_end: END, has_subscription: true,
    stripe_customer_id: 'cus_1', is_comp: false, plan_amount: 499, plan_currency: 'usd',
    founder: null,
    plan_interval: 'month', intervals_available: ['month', 'year'],
    plan_prices: { month: { amount: 499, currency: 'usd' }, year: { amount: 4999, currency: 'usd' } },
    pending_interval: null, pending_interval_at: null, ...over,
});
const yearlyStatus = (over: Record<string, unknown> = {}) => status({ plan_interval: 'year', plan_amount: 4999, ...over });

let root: Root | null = null;
let host: HTMLElement | null = null;
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(h(BillingTab)); });
    await settle();
}
const btn = (re: RegExp) => Array.from(document.body.querySelectorAll('button')).find((b) => re.test((b.textContent || '').trim())) as HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`);
const text = () => document.body.textContent ?? '';

const TO_YEARLY = { interval: 'year', effective: 'now', amount_due_now: 2400, currency: 'usd', new_price: 4999, effective_at: END };
const TO_MONTHLY = { interval: 'month', effective: 'period_end', amount_due_now: 0, currency: 'usd', new_price: 499, effective_at: END };

beforeEach(() => {
    stable.pushes.length = 0;
    ctx.previewIntervalChange = vi.fn(async (i: string) => ({ ok: true, preview: i === 'year' ? TO_YEARLY : TO_MONTHLY }));
    ctx.changeInterval = vi.fn(async (i: string) => ({ ok: true, result: { plan_interval: i, pending_interval: null, pending_interval_at: null, current_period_end: END } }));
});
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = null; host = null; });

describe('who sees the switch', () => {
    it('an active monthly plan on an API that offers yearly: "Switch to yearly"', async () => {
        ctx.status = status();
        await mount();
        expect(btn(/^Switch to yearly$/)).toBeDefined();
        expect(text()).toContain('Cipherline Pro');
        expect(text()).not.toMatch(/billed yearly/);
    });
    it.each([
        ['yearly not offered (older API)', { intervals_available: undefined, plan_interval: undefined, plan_prices: undefined }],
        ['only monthly offered', { intervals_available: ['month'] }],
        ['complimentary', { is_comp: true }],
        ['a cancellation is scheduled', { subscription_status: 'canceled_pending' }],
        ['past due', { subscription_status: 'past_due' }],
        ['expired', { subscription_status: 'canceled', effective_status: 'expired' }],
    ])('no switch when %s', async (_n, over) => {
        ctx.status = status(over);
        await mount();
        expect(q('interval-switch')).toBeNull();
        expect(btn(/Switch to (yearly|monthly)/)).toBeUndefined();
    });
});

describe('monthly -> yearly', () => {
    it('the first click only previews; the confirm states what is charged today and from when; nothing is sent until confirmed', async () => {
        ctx.status = status();
        await mount();
        await click(btn(/^Switch to yearly$/));
        expect(ctx.previewIntervalChange).toHaveBeenCalledWith('year');
        expect(ctx.changeInterval).not.toHaveBeenCalled();
        expect(q('interval-confirm-line')!.textContent).toBe(
            `You'll be charged $24.00 today (prorated credit for the unused part of this month applied), then $49.99/yr + tax from ${END_LABEL}.`);
        expect(btn(/^Switch and pay \$24\.00$/)).toBeDefined();
        await click(btn(/^Never mind$/));
        expect(ctx.changeInterval).not.toHaveBeenCalled();
        expect(q('interval-confirm')).toBeNull();
    });
    it('confirming sends exactly one change to yearly and toasts the server-reported outcome', async () => {
        ctx.status = status();
        await mount();
        await click(btn(/^Switch to yearly$/));
        await click(btn(/^Switch and pay/));
        expect(ctx.changeInterval).toHaveBeenCalledTimes(1);
        expect(ctx.changeInterval).toHaveBeenCalledWith('year');
        expect(stable.pushes[0]).toMatchObject({ kind: 'success', message: 'You are now on yearly billing.' });
    });
    it('a founder is told they keep the founding price (and the price is the founding yearly one)', async () => {
        ctx.status = status({
            plan_amount: 250, founder: { open: true, member: true, price_locked: true, lock_ended_at: null },
            plan_prices: { month: { amount: 250, currency: 'usd' }, year: { amount: 3000, currency: 'usd' } },
        });
        ctx.previewIntervalChange = vi.fn(async () => ({ ok: true, preview: { ...TO_YEARLY, amount_due_now: 1500, new_price: 3000 } }));
        await mount();
        await click(btn(/^Switch to yearly$/));
        expect(q('interval-confirm-line')!.textContent).toMatch(/then \$30\.00\/yr \+ tax from .*You keep your founding price\.$/);
        expect(q('interval-confirm-line')!.textContent).not.toMatch(/for life/i);
    });
    it('a preview that cannot be computed shows an error and sends nothing', async () => {
        ctx.status = status();
        ctx.previewIntervalChange = vi.fn(async () => ({ ok: false, message: 'That subscription is no longer active.' }));
        await mount();
        await click(btn(/^Switch to yearly$/));
        expect(q('interval-confirm-error')!.textContent).toBe('That subscription is no longer active.');
        expect(btn(/Switch and pay/)).toBeUndefined();
        expect(ctx.changeInterval).not.toHaveBeenCalled();
    });
    it('a refused change surfaces the server message and keeps the confirm open', async () => {
        ctx.status = status();
        ctx.changeInterval = vi.fn(async () => ({ ok: false, message: 'Your card was declined.' }));
        await mount();
        await click(btn(/^Switch to yearly$/));
        await click(btn(/^Switch and pay/));
        expect(stable.pushes[0]).toMatchObject({ kind: 'error', message: 'Your card was declined.' });
        expect(q('interval-confirm')).not.toBeNull();
    });
});

describe('yearly plans', () => {
    it('the plan line says billed yearly and the renewal line shows the yearly price', async () => {
        ctx.status = yearlyStatus();
        await mount();
        expect(text()).toContain('Cipherline Pro, billed yearly');
        expect(text()).toContain(`Renews on ${END_LABEL} · $49.99/yr + tax`);
    });
    it('yearly -> monthly: nothing today, no refund, switches at the end of the paid year', async () => {
        ctx.status = yearlyStatus();
        await mount();
        await click(btn(/^Switch to monthly$/));
        expect(ctx.previewIntervalChange).toHaveBeenCalledWith('month');
        expect(q('interval-confirm-line')!.textContent).toBe(
            `Your plan switches to monthly on ${END_LABEL} (the end of the year you've paid for). Nothing changes today and there is no refund.`);
        await click(btn(/^Switch to monthly$/));   // the confirm button (same label)
        expect(ctx.changeInterval).toHaveBeenCalledTimes(1);
        expect(ctx.changeInterval).toHaveBeenCalledWith('month');
        expect(stable.pushes[0]).toMatchObject({ kind: 'success' });
    });
    it('a founder on yearly: founder panel and cancel prompt quote /yr and the plan line is billed yearly', async () => {
        ctx.status = yearlyStatus({
            plan_amount: 3000, founder: { open: true, member: true, price_locked: true, lock_ended_at: null },
            plan_prices: { month: { amount: 250, currency: 'usd' }, year: { amount: 3000, currency: 'usd' } },
        });
        await mount();
        expect(q('founder-panel-subtitle')!.textContent).toBe('$30.00/yr + tax · locked in while you stay subscribed');
        await click(btn(/^Cancel subscription$/));
        expect(document.querySelector('[data-testid="founder-cancel-now"]')!.textContent).toContain('$30.00/yr + tax');
        expect(document.querySelector('[data-testid="founder-cancel-later"]')!.textContent).toContain('$49.99/yr + tax');
        expect(document.querySelector('[data-testid="founder-cancel-warning"]')!.textContent).not.toMatch(/for life|\/mo/);
        expect(document.querySelector('[data-testid="founder-cancel-prompt"]')!.textContent).toContain(`You'll keep Pro until ${END_LABEL}`);
    });
});

describe('a pending switch', () => {
    it('shows the date and Undo instead of a second switch; Undo re-requests the CURRENT interval', async () => {
        ctx.status = yearlyStatus({ pending_interval: 'month', pending_interval_at: END });
        ctx.changeInterval = vi.fn(async () => ({ ok: true, result: { plan_interval: 'year', pending_interval: null, pending_interval_at: null, current_period_end: END } }));
        await mount();
        expect(q('interval-pending')!.textContent).toContain(`Switches to monthly on ${END_LABEL}.`);
        expect(btn(/^Switch to monthly$/)).toBeUndefined();
        await click(q('interval-undo')!.querySelector('button'));
        expect(ctx.changeInterval).toHaveBeenCalledTimes(1);
        expect(ctx.changeInterval).toHaveBeenCalledWith('year');
        expect(stable.pushes[0]).toMatchObject({ kind: 'success', message: 'Switch cancelled. You stay on yearly billing.' });
    });
    it('no pending line when nothing is scheduled', async () => {
        ctx.status = yearlyStatus();
        await mount();
        expect(q('interval-pending')).toBeNull();
        expect(q('interval-undo')).toBeNull();
    });
});
