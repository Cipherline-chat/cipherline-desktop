// @vitest-environment jsdom
/**
 * Upsell copy for people who are not subscribed yet: the trial-ending prompt and
 * the Pro-feature explainer mention yearly briefly, ONLY when the API offers it
 * (an older API sends no interval fields: both stay exactly as they were), and
 * only the regular yearly price carries "2 months free".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { trialPromptCopy } from './trialEndingPromptRule';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ctx } = vi.hoisted(() => ({
    ctx: { status: null as Record<string, unknown> | null },
}));
vi.mock('../../contexts/SubscriptionContext', () => ({
    useSubscription: () => ({ status: ctx.status, openInAppCheckout: () => undefined }),
}));
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { UpgradePromptModal } = await import('./UpgradePromptModal');

const FOUNDER_PRICES = { month: { amount: 250, currency: 'usd' }, year: { amount: 3000, currency: 'usd' } };
const REGULAR_PRICES = { month: { amount: 499, currency: 'usd' }, year: { amount: 4999, currency: 'usd' } };
const now = new Date('2026-11-12T12:00:00Z');
const trial = (over: Record<string, unknown> = {}) => ({
    subscription_status: 'trial', effective_status: 'active', is_comp: false, trial_days_left: 3,
    trial_ends_at: null, has_subscription: false, plan_amount: 250, plan_currency: 'usd',
    founder: { open: true, member: false, price_locked: false, lock_ended_at: null }, ...over,
});

describe('trial-ending prompt copy', () => {
    it('founder offer: "Prefer yearly? $30.00/yr + tax." with no discount wording', () => {
        const c = trialPromptCopy(trial({ intervals_available: ['month', 'year'], plan_prices: FOUNDER_PRICES }), now);
        expect(c.variant).toBe('founder');
        expect(c.yearlyNote).toBe('Prefer yearly? $30.00/yr + tax.');
        expect(JSON.stringify(c)).not.toMatch(/months? free|for life/i);
    });
    it('regular: "$49.99/yr + tax (2 months free)"', () => {
        const c = trialPromptCopy(trial({ founder: { open: false }, plan_amount: 499, intervals_available: ['month', 'year'], plan_prices: REGULAR_PRICES }), now);
        expect(c.variant).toBe('regular');
        expect(c.yearlyNote).toBe('Prefer yearly? $49.99/yr + tax (2 months free).');
    });
    it('older API (no interval fields) or yearly not offered: no yearly note, and the monthly copy is unchanged', () => {
        const old = trialPromptCopy(trial(), now);
        expect(old.yearlyNote).toBeNull();
        expect(old.priceSuffix).toBe('/mo + tax');
        expect(old.primaryLabel).toBe('Lock in $2.50/mo');
        expect(trialPromptCopy(trial({ intervals_available: ['month'], plan_prices: FOUNDER_PRICES }), now).yearlyNote).toBeNull();
    });
});

describe('UpgradePromptModal', () => {
    let root: Root | null = null;
    let host: HTMLElement | null = null;
    beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => root!.unmount()); host?.remove(); });
    const render = async () => {
        await act(async () => { root!.render(React.createElement(UpgradePromptModal, { open: true, reason: 'video', onClose: () => undefined })); });
        await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    };
    const yearly = () => document.body.querySelector('[data-testid="upgrade-yearly"]');

    it('keeps the monthly CTA and adds one brief yearly line when offered (founder: no badge)', async () => {
        ctx.status = { intervals_available: ['month', 'year'], plan_prices: FOUNDER_PRICES };
        await render();
        expect(document.body.textContent).toContain('Upgrade — $2.50/mo + tax');
        expect(yearly()!.textContent).toBe('or $30.00/yr + tax');
    });
    it('regular price: the yearly line carries "2 months free"', async () => {
        ctx.status = { intervals_available: ['month', 'year'], plan_prices: REGULAR_PRICES };
        await render();
        expect(yearly()!.textContent).toBe('or $49.99/yr + tax (2 months free)');
    });
    it('not offered / older API: no yearly line at all', async () => {
        ctx.status = { subscription_status: 'expired' };
        await render();
        expect(yearly()).toBeNull();
        expect(document.body.textContent).toContain('Upgrade — $2.50/mo + tax');
    });
});
