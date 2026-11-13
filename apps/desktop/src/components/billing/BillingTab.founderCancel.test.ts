// @vitest-environment jsdom
/**
 * The desktop Settings > Billing cancel flow for a founding member
 * (owner decision 2026-10-30: cancelling forfeits the $2.50 lock).
 *
 * The real BillingTab is rendered with the context hooks faked, and the flow is
 * driven by clicking:
 *   - a founder whose lock is in force sees the SPECIAL prompt (not the ordinary
 *     one) with the honest copy, "Keep my subscription" as the primary action
 *     and "Cancel anyway" as the secondary;
 *   - keeping makes NO cancel call; cancelling anyway makes exactly one;
 *   - a non-founder, a founder whose lock already ended, and a comp see the
 *     ordinary flow (their cancel button reads "Yes, cancel at period end");
 *   - Resume (undoing a scheduled cancel) is untouched and keeps the lock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const { ctx, stable } = vi.hoisted(() => {
    // The component's effects depend on these callbacks, so they MUST keep their
    // identity across renders (a fresh vi.fn() per render is an infinite loop).
    const stable = {
        refresh: async () => undefined,
        openInAppCheckout: () => undefined,
        extendTrial: async () => ({ ok: true }),
        fetchPaymentMethod: async () => ({ ok: true, paymentMethod: null }),
        fetchInvoices: async () => ({ ok: true, invoices: [] as unknown[] }),
        push: () => undefined,
    };
    return {
        stable,
        ctx: {
            status: null as Record<string, unknown> | null,
            setCancellation: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
        },
    };
});

vi.mock('../../contexts/SubscriptionContext', () => ({
    useSubscription: () => ({
        status: ctx.status, statusError: null, refresh: stable.refresh, openInAppCheckout: stable.openInAppCheckout,
        extendTrial: stable.extendTrial, setCancellation: ctx.setCancellation,
        fetchPaymentMethod: stable.fetchPaymentMethod, fetchInvoices: stable.fetchInvoices,
    }),
}));
const AUTH = { token: 'tok', userId: 'u1' };
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => AUTH }));
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ push: stable.push }) }));
vi.mock('../../hooks/useServerStorageStatus', () => ({ useOwnedServersOverFreeStorage: () => ({ overCount: 0 }) }));
vi.mock('axios', () => ({ default: { get: vi.fn(async () => ({ data: { referral_code: null, referrals_count: 0, rewards_claimed: 0, max_referrals: 5, days_per_referral: 7 } })) } }));
vi.mock('../../utils/firstWeekNudgeStore', () => ({ nudges: { dismiss: vi.fn(), markDone: vi.fn(), complete: vi.fn() } }));

window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { BillingTab } = await import('./BillingTab');

const founderBlock = (over: Record<string, unknown> = {}) => ({
    open: true,
    member: true, price_locked: true, lock_ended_at: null, ...over,
});
const baseStatus = (over: Record<string, unknown> = {}) => ({
    subscription_status: 'active', effective_status: 'active', trial_ends_at: null, trial_extended: false,
    trial_days_left: 0, current_period_end: '2026-12-01T00:00:00Z', has_subscription: true,
    stripe_customer_id: 'cus_1', is_comp: false, plan_amount: 250, plan_currency: 'usd',
    founder: founderBlock(), ...over,
});

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
const buttonByText = (re: RegExp) =>
    Array.from(host!.querySelectorAll('button')).find((b) => re.test(b.textContent || '')) as HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const q = (id: string) => host!.querySelector(`[data-testid="${id}"]`);

beforeEach(() => { ctx.setCancellation = vi.fn(async () => ({ ok: true, settled: true })); });
afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null; host = null;
});

const dq = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const slider = () => document.querySelector('[data-testid="founder-cancel-slide"] [role="slider"]') as HTMLElement;
const press = (k: string) => act(() => { slider().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });

describe('BillingTab cancel: a founder whose price lock is in force gets the big slide-to-cancel modal', () => {
    beforeEach(() => { ctx.status = baseStatus(); });

    it('pressing Cancel opens the modal: losing the founding price for good, $4.99 later, Pro until period end, badge stays', async () => {
        await mount();
        await click(buttonByText(/^Cancel subscription$/));
        expect(dq('founder-cancel-prompt')).not.toBeNull();
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
        expect(dq('founder-cancel-title')!.textContent).toBe('Cancelling ends your founding price for good');
        expect(dq('founder-cancel-now')!.textContent).toContain('$2.50/mo + tax');
        expect(dq('founder-cancel-later')!.textContent).toContain('$4.99/mo + tax');
        const warn = dq('founder-cancel-warning')!.textContent!;
        expect(warn).toMatch(/can't be claimed again/);
        expect(warn).toMatch(/if you come back later you'll pay \$4\.99\/mo \+ tax/);
        expect(warn).toMatch(/Resume, and you keep your founding price/);
        expect(dq('founder-cancel-reassurance')!.textContent).toBe('Your Founder badge stays yours either way.');
        const modal = dq('founder-cancel-prompt')!.textContent!;
        expect(modal).toMatch(/You'll keep Pro until/);
        expect(modal).toMatch(/Servers you own stay yours on the free tier/);
        expect(document.body.textContent).not.toMatch(/Cancel your subscription\?|Yes, cancel at period end/);
    });

    it('never shows the founder number or a spot count, in the modal or the panel', async () => {
        await mount();
        await click(buttonByText(/^Cancel subscription$/));
        const all = document.body.textContent!;
        expect(all).not.toMatch(/#\s?1234|1,?234|6,?000|spots? left|of 10,000 founding/);
        expect(all).toContain('Founding member');            // positive control: the panel IS rendered
    });

    it('"Keep my founding price" is primary, takes the default focus, and sends nothing', async () => {
        await mount();
        await click(buttonByText(/^Cancel subscription$/));
        await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
        const keep = dq('founder-cancel-keep')!.querySelector('button')!;
        expect(keep.textContent).toBe('Keep my founding price');
        expect(keep.closest('.clb')?.className).not.toMatch(/clb--ghost/);
        expect(document.activeElement).toBe(keep);
        expect(slider().getAttribute('aria-label')).toBe('Slide to cancel and lose founding price');
        await click(keep);
        expect(ctx.setCancellation).not.toHaveBeenCalled();
    });

    it('a PARTIAL slide sends nothing', async () => {
        await mount();
        await click(buttonByText(/^Cancel subscription$/));
        for (let i = 0; i < 6; i++) press('ArrowRight');
        await settle();
        expect(ctx.setCancellation).not.toHaveBeenCalled();
    });

    it('a COMPLETED slide (keyboard path) sends exactly one cancel', async () => {
        await mount();
        await click(buttonByText(/^Cancel subscription$/));
        for (let i = 0; i < 10; i++) press('ArrowRight');
        await settle();
        expect(ctx.setCancellation).toHaveBeenCalledTimes(1);
        expect(ctx.setCancellation).toHaveBeenCalledWith(true);
    });

    it('opening the modal alone sends nothing', async () => {
        await mount();
        await click(buttonByText(/^Cancel subscription$/));
        expect(ctx.setCancellation).not.toHaveBeenCalled();
    });
});

describe('BillingTab cancel: everyone else keeps the ordinary flow', () => {
    const ordinary = async () => {
        await mount();
        await click(buttonByText(/^Cancel subscription$/));
        expect(dq('founder-cancel-prompt')).toBeNull();
        expect(document.querySelector('[role="slider"]')).toBeNull();
        expect(host!.textContent).toMatch(/Cancel your subscription\?/);
        expect(host!.textContent).not.toMatch(/founding price for good|Slide to cancel/);
    };

    it('a non-founder', async () => {
        ctx.status = baseStatus({ founder: founderBlock({ member: false, price_locked: false }) });
        await ordinary();
        await click(buttonByText(/Yes, cancel at period end/));
        expect(ctx.setCancellation).toHaveBeenCalledWith(true);
    });

    it('a founder whose lock already ENDED (re-subscribed at the regular price)', async () => {
        ctx.status = baseStatus({ founder: founderBlock({ price_locked: false, lock_ended_at: '2026-10-20T00:00:00Z' }) });
        await ordinary();
    });

    it('an older server that sends no founder block at all', async () => {
        ctx.status = baseStatus({ founder: undefined });
        await ordinary();
    });
});

describe('BillingTab: Resume is unchanged and a founder never sees the prompt for it', () => {
    it('resuming a scheduled cancel just resumes (the lock is kept server-side)', async () => {
        ctx.status = baseStatus({ subscription_status: 'canceled_pending' });
        await mount();
        expect(buttonByText(/^Cancel subscription$/)).toBeUndefined();
        await click(buttonByText(/Resume subscription/));
        expect(ctx.setCancellation).toHaveBeenCalledWith(false);
        expect(dq('founder-cancel-prompt')).toBeNull();
    });
});

describe('BillingTab: what the founder line says in each state', () => {
    it('lock in force', async () => {
        ctx.status = baseStatus();
        await mount();
        const t = q('founder-panel')!.textContent!;
        expect(t).toContain('Founding member');
        expect(t).not.toMatch(/#|1234/);
        expect(t).toMatch(/locked in/);
        expect(t).not.toMatch(/for life/i);
    });

    it('lock ended: still a founding member, says the price ended, keeps the badge', async () => {
        ctx.status = baseStatus({ subscription_status: 'expired', effective_status: 'expired', founder: founderBlock({ price_locked: false, lock_ended_at: '2026-10-20T00:00:00Z' }) });
        await mount();
        const t = q('founder-panel')!.textContent!;
        expect(t).toContain('Founding member');
        expect(t).not.toMatch(/#|1234/);
        expect(t).toMatch(/founding price ended/);
        expect(t).toMatch(/Founder badge/);
        expect(q('founder-panel')!.getAttribute('data-kind')).toBe('former');
    });

    it('lock in force: what ends it, the $4.99 new subscribers pay, and the Founder badge', async () => {
        ctx.status = baseStatus();
        await mount();
        const t = q('founder-panel')!.textContent!;
        expect(t).toContain('$2.50/mo + tax · locked in while you stay subscribed');
        expect(q('founder-panel-title')!.textContent).toBe('Founding member');
        expect(t).toMatch(/The lock ends only if your subscription ends/);
        expect(t).toContain('new subscribers pay $4.99/mo + tax');
        expect(t).toMatch(/You have the Founder badge on your profile/);
    });

    it('a trial user sees the founding offer, with no spot count', async () => {
        ctx.status = baseStatus({
            subscription_status: 'trial', effective_status: 'active', trial_days_left: 2, has_subscription: false,
            stripe_customer_id: null, current_period_end: null, founder: founderBlock({ member: false, price_locked: false }),
        });
        await mount();
        const panel = q('founder-panel')!;
        expect(panel.getAttribute('data-kind')).toBe('offer');
        expect(panel.textContent).toContain('Founding price: $2.50/mo + tax');
        expect(panel.textContent).not.toMatch(/spots? left|6,?000|4,?000/);
        expect(panel.querySelector('[role=progressbar]')).toBeNull();
    });

    it('a trial user after the spots are gone: the price, no pitch', async () => {
        ctx.status = baseStatus({
            subscription_status: 'trial', effective_status: 'active', trial_days_left: 2, has_subscription: false,
            stripe_customer_id: null, current_period_end: null,
            founder: founderBlock({ member: false, price_locked: false, open: false }),
        });
        await mount();
        const panel = q('founder-panel')!;
        expect(panel.getAttribute('data-kind')).toBe('closed');
        expect(panel.textContent).not.toMatch(/spots|Founder badge|locked in|10,000/);
    });

    it('a comp sees no founder panel at all', async () => {
        ctx.status = baseStatus({ is_comp: true, stripe_customer_id: null, founder: founderBlock({ member: false, price_locked: false }) });
        await mount();
        expect(q('founder-panel')).toBeNull();
    });
});
