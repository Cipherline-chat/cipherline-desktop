// @vitest-environment jsdom
/**
 * Owner 2026-11-16: "Add custom #0001 Tags to the list of features on pro and
 * list it when try to cancel letting them know they will lose that feature."
 *
 * The real BillingTab, context hooks faked (same harness as
 * BillingTab.founderCancel.test.ts): the Pro perks list names the feature, and
 * every cancel confirmation (the ordinary inline one AND the founder modal)
 * says what happens to the #number when Pro ends - naming it when it is a
 * chosen one. Plus the other Pro feature lists in the desktop app.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const { ctx, stable, auth } = vi.hoisted(() => {
    const stable = {
        refresh: async () => undefined,
        openInAppCheckout: () => undefined,
        extendTrial: async () => ({ ok: true }),
        fetchPaymentMethod: async () => ({ ok: true, paymentMethod: null }),
        fetchInvoices: async () => ({ ok: true, invoices: [] as unknown[] }),
        push: () => undefined,
        setCancellation: async () => ({ ok: true, settled: true }),
    };
    return {
        stable,
        ctx: { status: null as Record<string, unknown> | null },
        auth: { token: 'tok', userId: 'u1', user: null as Record<string, unknown> | null },
    };
});

vi.mock('../../contexts/SubscriptionContext', () => ({
    useSubscription: () => ({
        status: ctx.status, statusError: null, refresh: stable.refresh, openInAppCheckout: stable.openInAppCheckout,
        extendTrial: stable.extendTrial, setCancellation: stable.setCancellation,
        fetchPaymentMethod: stable.fetchPaymentMethod, fetchInvoices: stable.fetchInvoices,
    }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));
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

const baseStatus = (over: Record<string, unknown> = {}) => ({
    subscription_status: 'active', effective_status: 'active', trial_ends_at: null, trial_extended: false,
    trial_days_left: 0, current_period_end: '2026-12-01T00:00:00Z', has_subscription: true,
    stripe_customer_id: 'cus_1', is_comp: false, plan_amount: 250, plan_currency: 'usd',
    founder: null, ...over,
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
const tagLine = () => document.querySelector('[data-cancel-tag-notice]');

beforeEach(() => {
    ctx.status = baseStatus();
    auth.user = { user_id: 'u1', username: 'Shinobi', discriminator: 1, discriminator_custom: true };
});
afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null; host = null;
});

describe('BillingTab: the Pro perks list', () => {
    it('lists custom #0001 tags (with the free-tier contrast)', async () => {
        await mount();
        expect(host!.textContent).toContain('Custom #0001 tags: pick the number after your name');
        expect(host!.textContent).toContain('(free: a random #number)');
    });
});

describe('BillingTab cancel confirmation: what happens to the #number', () => {
    it('is not shown before Cancel is pressed', async () => {
        await mount();
        expect(tagLine()).toBeNull();
    });

    it('a CHOSEN number is named: "Your custom #number (#0001) will be replaced with a random one when Pro ends."', async () => {
        await mount();
        await click(buttonByText(/^Cancel subscription$/));
        const line = tagLine()!;
        expect(line.getAttribute('data-cancel-tag-notice')).toBe('custom');
        expect(line.textContent).toBe('Your custom #number (#0001) will be replaced with a random one when Pro ends.');
        // It sits inside the confirmation, next to the keep-Pro-until sentence.
        expect(buttonByText(/^Yes, cancel at period end$/)).toBeDefined();
    });

    it('a number that was never chosen gets the generic line (no number, no "replaced")', async () => {
        auth.user = { user_id: 'u1', username: 'Shinobi', discriminator: 4821, discriminator_custom: false };
        await mount();
        await click(buttonByText(/^Cancel subscription$/));
        const line = tagLine()!;
        expect(line.getAttribute('data-cancel-tag-notice')).toBe('generic');
        expect(line.textContent).toMatch(/^Custom #number tags are Pro/);
        expect(line.textContent).not.toMatch(/4821|replaced/);
    });

    it('an older API (no discriminator_custom on /auth/me) gets the generic line', async () => {
        auth.user = { user_id: 'u1', username: 'Shinobi', discriminator: 1 };
        await mount();
        await click(buttonByText(/^Cancel subscription$/));
        expect(tagLine()!.getAttribute('data-cancel-tag-notice')).toBe('generic');
    });

    it('the founder slide-to-cancel modal carries the same line', async () => {
        ctx.status = baseStatus({ founder: { open: true, member: true, price_locked: true, lock_ended_at: null } });
        await mount();
        await click(buttonByText(/^Cancel subscription$/));
        expect(document.querySelector('[data-testid="founder-cancel-prompt"]')).not.toBeNull();
        expect(tagLine()!.textContent).toBe('Your custom #number (#0001) will be replaced with a random one when Pro ends.');
    });
});

describe('every desktop Pro feature list names it', () => {
    const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');
    it('checkout summary', async () => {
        const { CHECKOUT_FEATURES } = await import('./CheckoutLayout');
        expect(CHECKOUT_FEATURES.map((f) => f.title)).toContain('Custom #0001 tags');
    });
    it('the upgrade sheet, the Pro welcome, the trial-ending prompt', async () => {
        expect(read('./UpgradePromptModal.tsx')).toContain("'**Custom #0001 tags**: pick the number after your name'");
        expect(read('../ProWelcome.tsx')).toMatch(/\{ Icon: Hash, title: PRO_TAG_FEATURE_TITLE/);
        // The trial-ending prompt says "#number" with no digits: next to the
        // founding offer "#0001" would read like a founder spot number, which
        // that prompt must never show (trialEndingPromptRule.test.ts).
        expect(read('./trialEndingPromptRule.ts').match(/'Custom #number tags'/g)).toHaveLength(2);
    });
});
