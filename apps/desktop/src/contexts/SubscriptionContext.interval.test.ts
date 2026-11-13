// @vitest-environment jsdom
/**
 * SubscriptionContext's interval surface: the derived fields (an older API that
 * sends none reads as monthly-only with yearly hidden) and the two calls
 * (read-only preview, then the change; Undo = the current interval).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { api } = vi.hoisted(() => ({
    api: { status: {} as Record<string, unknown>, posts: [] as Array<[string, unknown]>, postResult: { data: {} } as { data: unknown } | Error },
}));
vi.mock('axios', () => ({
    default: {
        get: vi.fn(async () => ({ data: api.status })),
        post: vi.fn(async (url: string, body: unknown) => {
            api.posts.push([url, body]);
            if (api.postResult instanceof Error) throw api.postResult;
            return api.postResult;
        }),
        isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError,
    },
}));
vi.mock('./AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true, token: 'jwt', userId: 'u1' }) }));
vi.mock('../components/billing/InAppCheckout', () => ({ InAppCheckout: () => null }));
vi.mock('../components/billing/UpgradePromptModal', () => ({ UpgradePromptModal: () => null }));
vi.mock('../utils/secureLocalStore', () => ({
    secureLocalStore: { isAccountReady: () => false, whenAccountReady: () => new Promise(() => undefined), getItem: () => null, setItem: () => undefined },
}));
vi.mock('../utils/proCelebration', () => ({ observeProStatus: () => false, recordProPurchase: () => undefined }));
vi.mock('../constants', async (orig) => ({ ...(await orig<typeof import('../constants')>()), API_BASE: 'http://api/v1' }));

const { SubscriptionProvider, useSubscription } = await import('./SubscriptionContext');

const seen: Array<ReturnType<typeof useSubscription>> = [];
const Probe = () => { const v = useSubscription(); seen.push(v); return null; };
const cur = () => seen[seen.length - 1];
let root: Root | null = null;
let host: HTMLElement;
const mount = async () => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(React.createElement(SubscriptionProvider, null, React.createElement(Probe))); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};
beforeEach(() => { api.posts.length = 0; api.postResult = { data: {} }; seen.length = 0; });
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; });

describe('derived interval fields', () => {
    it('an older API (no interval fields): monthly, yearly hidden, nothing pending', async () => {
        api.status = { subscription_status: 'active', effective_status: 'active', plan_amount: 250, plan_currency: 'usd' };
        await mount();
        expect(cur()).toMatchObject({ planInterval: 'month', isYearlyOffered: false, pendingInterval: null, pendingIntervalAt: null });
    });
    it('a yearly plan with a pending switch', async () => {
        api.status = {
            subscription_status: 'active', effective_status: 'active', plan_interval: 'year', intervals_available: ['month', 'year'],
            plan_prices: { year: { amount: 3000, currency: 'usd' } }, pending_interval: 'month', pending_interval_at: '2027-11-12T00:00:00Z',
        };
        await mount();
        expect(cur()).toMatchObject({ planInterval: 'year', isYearlyOffered: true, pendingInterval: 'month', pendingIntervalAt: '2027-11-12T00:00:00Z' });
    });
});

describe('interval calls', () => {
    beforeEach(() => { api.status = { subscription_status: 'active', effective_status: 'active' }; });
    it('previewIntervalChange POSTs the preview endpoint only', async () => {
        api.postResult = { data: { interval: 'year', effective: 'now', amount_due_now: 100, currency: 'usd', new_price: 4999, effective_at: null } };
        await mount();
        const r = await cur().previewIntervalChange('year');
        expect(r.ok).toBe(true);
        expect(api.posts).toEqual([['http://api/v1/billing/interval-preview', { interval: 'year' }]]);
    });
    it('changeInterval POSTs /billing/interval and returns the server result', async () => {
        api.postResult = { data: { plan_interval: 'year', pending_interval: null, pending_interval_at: null, current_period_end: null } };
        await mount();
        const r = await cur().changeInterval('year');
        expect(r).toMatchObject({ ok: true, result: { plan_interval: 'year' } });
        expect(api.posts).toEqual([['http://api/v1/billing/interval', { interval: 'year' }]]);
    });
    it('a server refusal comes back as the server\'s own message, not a generic one', async () => {
        api.postResult = Object.assign(new Error('x'), { isAxiosError: true, response: { data: { message: 'Resume your subscription first.' } } });
        await mount();
        const r = await cur().changeInterval('month');
        expect(r).toEqual({ ok: false, message: 'Resume your subscription first.' });
    });
});
