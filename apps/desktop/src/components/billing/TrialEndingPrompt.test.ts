// @vitest-environment jsdom
/**
 * The real TrialEndingPrompt host, with the contexts and the encrypted store
 * faked: it opens after the settle delay for a trial in its last 3 days,
 * records "shown" device-locally under the classified key, does not reopen the
 * same day, stays shut (and records nothing) during a call, closes if a call
 * starts, and "Keep Pro" opens the existing in-app checkout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ctx, kv } = vi.hoisted(() => ({
    ctx: { status: null as Record<string, unknown> | null, openInAppCheckout: (() => undefined) as () => void },
    kv: new Map<string, string>(),
}));
vi.mock('../../contexts/SubscriptionContext', () => ({
    useSubscription: () => ({ status: ctx.status, openInAppCheckout: ctx.openInAppCheckout }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ userId: 'u1' }) }));
vi.mock('../../utils/secureLocalStore', () => {
    const store = {
        getItem: (k: string) => kv.get(k) ?? null,
        setItem: (k: string, v: string) => { kv.set(k, v); },
        removeItem: (k: string) => { kv.delete(k); },
        isAccountReady: () => true,
        whenAccountReady: async () => undefined,
    };
    return { default: store, secureLocalStore: store };
});

window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { TrialEndingPrompt } = await import('./TrialEndingPrompt');

const trial = (over: Record<string, unknown> = {}) => ({
    subscription_status: 'trial', effective_status: 'active', is_comp: false, trial_days_left: 3,
    trial_ends_at: null, has_subscription: false, plan_amount: 250, plan_currency: 'usd',
    founder: { open: true, member: false, price_locked: false, lock_ended_at: null },
    ...over,
});

let root: Root | null = null;
let host: HTMLElement | null = null;
const prompt = () => document.querySelector('[data-testid="trial-ending-prompt"]');

async function render(blocked = false) {
    if (!host) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); }
    await act(async () => { root!.render(React.createElement(TrialEndingPrompt, { blocked })); });
}
async function settle(ms = 4100) {
    await act(async () => { vi.advanceTimersByTime(ms); });
    await act(async () => { vi.advanceTimersByTime(50); });   // ClModal's open rAF
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] });
    vi.setSystemTime(new Date(2026, 10, 12, 12, 0));
    kv.clear();
    ctx.status = trial();
    ctx.openInAppCheckout = vi.fn();
});
afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove(); root = null; host = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('TrialEndingPrompt host', () => {
    it('opens after the settle delay for a trial with 3 days left, founder variant (no counts), and records today', async () => {
        await render();
        expect(prompt()).toBeNull();                       // not instantly at boot
        await settle();
        expect(prompt()).not.toBeNull();
        expect(prompt()!.getAttribute('data-variant')).toBe('founder');
        expect(prompt()!.textContent).toContain('trial ends in 3 days');
        expect(document.querySelector('[data-testid="trial-prompt-headline"]')!.textContent).toBe('Lock in half price');
        expect(document.querySelector('[data-testid="trial-prompt-qualifier"]')!.textContent).toBe('for as long as you stay subscribed');
        expect(document.querySelector('[data-testid="trial-prompt-was"]')!.tagName).toBe('S');            // struck through
        expect(document.querySelector('[data-testid="trial-prompt-was"]')!.textContent).toBe('$4.99');
        expect(document.querySelector('[data-testid="trial-prompt-medallion"]')).not.toBeNull();
        expect(prompt()!.textContent).not.toMatch(/spots|6,?000|4,?000/);
        expect(prompt()!.querySelector('[role=progressbar]')).toBeNull();
        expect(JSON.parse(kv.get('cipherline_trial_prompt_shown_u1')!)).toEqual({ early: '2026-11-12' });
    });

    it('closed founder pool renders the regular variant', async () => {
        ctx.status = trial({ founder: { open: false, member: false, price_locked: false } });
        await render(); await settle();
        expect(prompt()!.getAttribute('data-variant')).toBe('regular');
        expect(document.querySelector('[data-testid="trial-prompt-medallion"]')).toBeNull();     // standard look
        expect(document.querySelector('[data-testid="trial-prompt-headline"]')).toBeNull();
        expect(prompt()!.textContent).not.toMatch(/[Ff]ounding|Founder/);
    });

    it('does not reopen the same day after "Maybe later"', async () => {
        await render(); await settle();
        const later = document.querySelector('[data-testid="trial-prompt-later"] button') as HTMLButtonElement;
        await act(async () => { later.click(); });
        await settle(400);
        expect(prompt()).toBeNull();
        ctx.status = trial({ trial_days_left: 1 });         // even the last-day stage waits for tomorrow
        await render(); await settle();
        expect(prompt()).toBeNull();
    });

    it('"Lock in $2.50/mo" opens the existing in-app checkout', async () => {
        await render(); await settle();
        const keep = document.querySelector('[data-testid="trial-prompt-keep"] button') as HTMLButtonElement;
        expect(keep.textContent).toBe('Lock in $2.50/mo');
        await act(async () => { keep.click(); });
        expect(ctx.openInAppCheckout).toHaveBeenCalledTimes(1);
    });

    it('never during a call: stays shut and records nothing; shows once the call ends', async () => {
        await render(true); await settle(10_000);
        expect(prompt()).toBeNull();
        expect(kv.has('cipherline_trial_prompt_shown_u1')).toBe(false);
        await render(false); await settle();
        expect(prompt()).not.toBeNull();
    });

    it('a call starting while it is open closes it', async () => {
        await render(); await settle();
        expect(prompt()).not.toBeNull();
        await render(true); await settle(400);
        expect(prompt()).toBeNull();
    });

    it('comps, paying users and lapsed trials never see it', async () => {
        for (const s of [trial({ is_comp: true }), trial({ subscription_status: 'active' }), trial({ effective_status: 'expired', trial_days_left: 0 })]) {
            ctx.status = s;
            await render(); await settle(10_000);
            expect(prompt()).toBeNull();
        }
        expect(kv.size).toBe(0);
    });
});
