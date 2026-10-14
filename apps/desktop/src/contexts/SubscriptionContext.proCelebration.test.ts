// @vitest-environment jsdom
/**
 * The "you're Pro" trigger wiring in SubscriptionContext: every purchase path
 * raises proCelebration exactly once, and nothing else does.
 *
 *   in-app checkout success  → immediately (InAppCheckout has already confirmed
 *                              activation with the server)
 *   paid elsewhere / trial → paid while closed → a free → active status edge
 *   new device of an existing subscriber, reload, HMR, resume → never
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Status = { subscription_status: string; effective_status: string; has_subscription: boolean };
const server = { status: null as Status | null };
const store = new Map<string, string>();
let checkoutProps: { onSuccess: () => void; onFallback?: () => void } | null = null;

vi.mock('axios', () => {
    const get = vi.fn(async () => ({ data: server.status }));
    const post = vi.fn(async () => ({ data: {} }));
    return { default: { get, post, isAxiosError: () => false } };
});
vi.mock('./AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true, token: 't', userId: 'u1' }) }));
vi.mock('../utils/secureLocalStore', () => ({
    secureLocalStore: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        isAccountReady: (uid: string) => uid === 'u1',
        whenAccountReady: () => Promise.resolve(),
    },
}));
vi.mock('../components/billing/InAppCheckout', () => ({
    InAppCheckout: (p: { onSuccess: () => void; onFallback?: () => void }) => { checkoutProps = p; return null; },
}));
vi.mock('../components/billing/UpgradePromptModal', () => ({ UpgradePromptModal: () => null }));

import { SubscriptionProvider, useSubscription } from './SubscriptionContext';

let latest: ReturnType<typeof useSubscription> | null = null;
// eslint-disable-next-line react-hooks/globals -- test probe: reads the hook's value from outside
const Probe: React.FC = () => { latest = useSubscription(); return null; };
let root: Root | null = null;

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const mount = async () => {
    const el = document.createElement('div');
    root = createRoot(el);
    await act(async () => { root!.render(React.createElement(SubscriptionProvider, null, React.createElement(Probe))); });
    await flush();
};
const remount = async () => { act(() => { root?.unmount(); }); latest = null; await mount(); };
const refresh = async () => { await act(async () => { await latest!.refresh(); }); await flush(); };
const S = (subscription_status: string, has_subscription = true): Status =>
    ({ subscription_status, has_subscription, effective_status: subscription_status === 'expired' ? 'expired' : 'active' });

beforeEach(() => {
    store.clear();
    checkoutProps = null;
    server.status = null;
    (window as unknown as { electronAPI: unknown }).electronAPI = { openExternal: vi.fn(async () => {}) };
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    latest = null;
    vi.useRealTimers();
});

describe('SubscriptionContext → ProWelcome trigger', () => {
    it('trial → paid observed on a later status read celebrates once; dismiss + more reads + reload never replay it', async () => {
        server.status = S('trial', false);
        await mount();
        expect(latest!.proCelebration).toBe(false);
        expect(store.get('cipherline_pro_seen_u1')).toBe('free');

        server.status = S('active'); // paid on the website / in the browser
        await refresh();
        expect(latest!.proCelebration).toBe(true);
        act(() => { latest!.dismissProCelebration(); });
        expect(latest!.proCelebration).toBe(false);

        await refresh();
        expect(latest!.proCelebration).toBe(false);
        await remount(); // reload / HMR
        expect(latest!.proCelebration).toBe(false);
    });

    it('an existing subscriber on a NEW device (no record yet) is not celebrated', async () => {
        server.status = S('active');
        await mount();
        expect(latest!.proCelebration).toBe(false);
        expect(store.get('cipherline_pro_seen_u1')).toBe('pro');
    });

    it('a comp grant is not a purchase', async () => {
        server.status = S('expired', false);
        await mount();
        server.status = S('active', false);
        await refresh();
        expect(latest!.proCelebration).toBe(false);
    });

    it('in-app checkout success celebrates at once, records it, and the follow-up status poll does not double it', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        server.status = S('trial', false);
        await mount();
        act(() => { latest!.openInAppCheckout(); });
        await flush();
        expect(checkoutProps).not.toBeNull();

        server.status = S('active');
        let raised = false;
        // A quick "Let's go" BEFORE the poll's status lands must not let that
        // status (free → active, as this device last saw it) replay it.
        await act(async () => {
            checkoutProps!.onSuccess();
            raised = true;
            latest!.dismissProCelebration();
        });
        expect(raised).toBe(true);
        expect(store.get('cipherline_pro_seen_u1')).toBe('pro');
        await flush();
        await act(async () => { vi.advanceTimersByTime(5000); });
        await flush();
        expect(latest!.status?.subscription_status).toBe('active');
        expect(latest!.proCelebration).toBe(false);
    });

    it('in-app checkout success raises the celebration synchronously', async () => {
        server.status = S('trial', false);
        await mount();
        act(() => { latest!.openInAppCheckout(); });
        await flush();
        act(() => { checkoutProps!.onSuccess(); });
        expect(latest!.proCelebration).toBe(true);
    });

    it('in-app checkout stays mounted under the veil for the hand-off, then closes', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        server.status = S('trial', false);
        await mount();
        act(() => { latest!.openInAppCheckout(); });
        await flush();
        const first = checkoutProps!;
        checkoutProps = null;
        await act(async () => { first.onSuccess(); });
        expect(checkoutProps).not.toBeNull(); // re-rendered, still mounted
        checkoutProps = null;
        await act(async () => { vi.advanceTimersByTime(600); });
        await flush();
        checkoutProps = null;
        await act(async () => { latest!.dismissProCelebration(); }); // any re-render
        expect(checkoutProps).toBeNull(); // unmounted
    });

    it('the in-app checkout offers NO browser fallback, and the context no longer exposes one', async () => {
        server.status = S('expired');
        await mount();
        act(() => { latest!.openInAppCheckout(); });
        await flush();
        expect(checkoutProps).not.toBeNull();
        expect(checkoutProps!.onFallback).toBeUndefined();
        expect('openCheckout' in (latest as object)).toBe(false);
        // and nothing ever POSTs for a hosted Checkout session
        const axios = (await import('axios')).default as unknown as { post: ReturnType<typeof vi.fn> };
        expect(axios.post.mock.calls.some((c) => String(c[0]).endsWith('/billing/checkout'))).toBe(false);
    });

    it('a free → paid edge observed with no prior record does NOT celebrate (no pending-browser signal exists)', async () => {
        server.status = S('expired');
        await mount();
        store.clear();
        server.status = S('active');
        await refresh();
        expect(latest!.proCelebration).toBe(false);
    });

    it('resuming a pending cancellation is not a purchase', async () => {
        server.status = S('canceled_pending');
        await mount();
        server.status = S('active');
        await refresh();
        expect(latest!.proCelebration).toBe(false);
    });
});
