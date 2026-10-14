// @vitest-environment jsdom
/**
 * The one-step in-app checkout, driven end to end against mocked Stripe.
 *
 * NOTHING here reaches Stripe (the production keys are live): `@stripe/*` and
 * axios are mocked, and the assertions are about ORDER and CONSEQUENCE:
 *
 *   - the card form is on screen straight away: no separate tax-location screen
 *   - nothing is charged (confirmPayment) until the customer has seen the real total
 *   - the extra "Confirm $X" click happens only when the total differs from the quote
 *   - there is no browser/hosted-Checkout fallback, and Link (not wallets) is enabled
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ── mocks ─────────────────────────────────────────────────────────────── */

const calls: string[] = [];
const stripeFake = {
    createConfirmationToken: vi.fn(),
    confirmPayment: vi.fn(),
};
const elementsFake = { submit: vi.fn() };
let elementsOptions: Record<string, unknown> | null = null;
let loadStripeResult: unknown = {};

vi.mock('@stripe/stripe-js/pure', () => ({
    loadStripe: vi.fn(async () => loadStripeResult),
}));
vi.mock('@stripe/react-stripe-js', () => ({
    Elements: (p: { options: Record<string, unknown>; children: React.ReactNode }) => {
        elementsOptions = p.options;
        return React.createElement('div', { 'data-testid': 'elements' }, p.children);
    },
    PaymentElement: (p: { onReady?: () => void; onChange?: (e: { complete: boolean }) => void }) => {
        React.useEffect(() => { p.onReady?.(); p.onChange?.({ complete: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
        return React.createElement('div', { 'data-testid': 'payment-element' });
    },
    useStripe: () => stripeFake,
    useElements: () => elementsFake,
}));
vi.mock('framer-motion', () => {
    const el = (tag: string) => ({ children, ...rest }: Record<string, unknown>) => {
        const clean: Record<string, unknown> = {};
        for (const k of ['className', 'style', 'role', 'data-testid']) if (k in rest) clean[k] = rest[k];
        return React.createElement(tag, clean, children as React.ReactNode);
    };
    return {
        motion: { div: el('div'), p: el('p') },
        AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
        useReducedMotion: () => true,
    };
});
vi.mock('../mascot/Keys', () => ({ Keys: () => null }));
vi.mock('../ClButton', () => ({
    ClButton: (p: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; loading?: boolean }) =>
        React.createElement('button', { onClick: p.onClick, disabled: p.disabled || p.loading }, p.children),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ token: 'jwt' }) }));
vi.mock('../../constants', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../constants')>()),
    API_BASE: 'http://api/v1',
}));

type Handler = (url: string, body?: unknown, cfg?: unknown) => unknown;
const routes: { get: Handler; post: Handler } = { get: () => ({ data: {} }), post: () => ({ data: {} }) };
vi.mock('axios', () => {
    const get = vi.fn(async (url: string, cfg?: unknown) => { calls.push(`GET ${url}`); return routes.get(url, undefined, cfg); });
    const post = vi.fn(async (url: string, body?: unknown, cfg?: unknown) => { calls.push(`POST ${url}`); return routes.post(url, body, cfg); });
    return { default: { get, post, isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError } };
});

import { InAppCheckout } from './InAppCheckout';

/* ── harness ───────────────────────────────────────────────────────────── */

let root: Root | null = null;
let host: HTMLElement;
const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
const text = () => document.body.textContent ?? '';
const button = (label: RegExp) => Array.from(document.body.querySelectorAll('button')).find((b) => label.test((b.textContent ?? '').trim()));
const click = async (label: RegExp) => {
    const b = button(label);
    if (!b) throw new Error(`no button matching ${label}; have: ${Array.from(document.body.querySelectorAll('button')).map((x) => x.textContent).join(' | ')}`);
    await act(async () => { b.click(); });
    await flush();
};

const CONFIG = { publishable_key: 'pk_test_x', amount: 250, currency: 'usd', automatic_tax: true, payment_method_types: ['card', 'link'] };
const quote = (over: Record<string, unknown> = {}) => ({
    client_secret: 'pi_secret_1', subscription_id: 'sub_1',
    amount_subtotal: 250, amount_tax: 18, amount_total: 268, currency: 'usd', ...over,
});
const apiError = (message: string, code?: string) => Object.assign(new Error(message), {
    isAxiosError: true, response: { data: code ? { code, message } : { message } },
});

const onSuccess = vi.fn();
const onClose = vi.fn();
const mount = async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(React.createElement(InAppCheckout, { context: 'upgrade', onSuccess, onClose })); });
    await flush();
};

beforeEach(() => {
    calls.length = 0;
    elementsOptions = null;
    loadStripeResult = {};
    onSuccess.mockReset(); onClose.mockReset();
    stripeFake.createConfirmationToken.mockReset().mockResolvedValue({ confirmationToken: { id: 'ctoken_1' } });
    stripeFake.confirmPayment.mockReset().mockResolvedValue({ paymentIntent: { status: 'succeeded' } });
    elementsFake.submit.mockReset().mockResolvedValue({});
    routes.get = (url) => {
        if (url.endsWith('/billing/checkout-config')) return { data: CONFIG };
        if (url.endsWith('/billing/status')) return { data: { subscription_status: 'active' } };
        return { data: {} };
    };
    routes.post = (url) => {
        if (url.endsWith('/billing/subscribe')) return { data: quote() };
        if (url.endsWith('/billing/activate')) return { data: { subscription_status: 'active' } };
        return { data: {} };
    };
    (window as unknown as { electronAPI?: unknown }).electronAPI = { openExternal: vi.fn(async () => undefined) };
});
afterEach(() => { act(() => { root?.unmount(); }); root = null; host?.remove(); });

/* ── tests ─────────────────────────────────────────────────────────────── */

describe('one-step checkout: a single panel', () => {
    it('mounts a deferred-intent Elements (subscription mode) with the live amount, restricted to card + Link', async () => {
        await mount();
        expect(calls[0]).toBe('GET http://api/v1/billing/checkout-config');
        expect(elementsOptions).toMatchObject({
            mode: 'subscription', amount: 250, currency: 'usd', paymentMethodTypes: ['card', 'link'],
        });
        // no clientSecret: there is no PaymentIntent yet
        expect(elementsOptions).not.toHaveProperty('clientSecret');
    });
    it('asks for the DESKTOP method set', async () => {
        await mount();
        const axios = (await import('axios')).default as unknown as { get: ReturnType<typeof vi.fn> };
        expect(axios.get.mock.calls[0][1]).toMatchObject({ params: { platform: 'desktop' } });
    });
    it('shows the card form immediately: no tax-location screen, and none of the old routes are called', async () => {
        await mount();
        expect(document.body.querySelector('[data-testid="payment-element"]')).not.toBeNull();
        expect(text()).not.toMatch(/Where are you|Select your country|ZIP code|work out the tax that gets/i);
        expect(calls.join('\n')).not.toMatch(/subscription-intent|tax-location/);
        expect(button(/^Pay /)?.textContent).toContain('$2.50/mo + tax');
    });
    // The "Bank" tab regression: with NO paymentMethodTypes, Stripe falls back
    // to the Dashboard's automatic methods and offers methods the server refuses
    // for the desktop platform. The client must always send the explicit list.
    it.each([
        ['null', null],
        ['absent', undefined],
        ['empty', []],
        ['only unknown types', ['us_bank_account']],
    ])('still restricts to card + Link when the server sends %s', async (_label, types) => {
        routes.get = () => ({ data: { ...CONFIG, payment_method_types: types } });
        await mount();
        expect(elementsOptions).toHaveProperty('paymentMethodTypes', ['card', 'link']);
    });
    it('never lets the server WIDEN the set: bank types are dropped, a narrower list is honoured', async () => {
        routes.get = () => ({ data: { ...CONFIG, payment_method_types: ['card', 'link', 'us_bank_account', 'amazon_pay'] } });
        await mount();
        expect(elementsOptions).toHaveProperty('paymentMethodTypes', ['card', 'link']);
        act(() => { root?.unmount(); }); root = null; host.remove();
        routes.get = () => ({ data: { ...CONFIG, payment_method_types: ['card'] } });
        await mount();
        expect(elementsOptions).toHaveProperty('paymentMethodTypes', ['card']);
    });
    it('falls back to $2.50 USD when the live price could not be read', async () => {
        routes.get = () => ({ data: { ...CONFIG, amount: null, currency: null } });
        await mount();
        expect(elementsOptions).toMatchObject({ amount: 250, currency: 'usd' });
        expect(button(/^Pay /)?.textContent).toContain('$2.50/mo + tax');
    });
});

describe('one-step checkout: tax is shown honestly BEFORE any charge', () => {
    it('no tax (total == quote): Pay goes straight to confirmPayment, with no extra step', async () => {
        routes.post = (url) => url.endsWith('/billing/subscribe')
            ? { data: quote({ amount_tax: 0, amount_total: 250 }) }
            : { data: { subscription_status: 'active' } };
        await mount();
        await click(/^Pay /);
        expect(document.body.querySelector('[data-testid="tax-confirm"]')).toBeNull();
        expect(stripeFake.confirmPayment).toHaveBeenCalledTimes(1);
        expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it('tax applies: shows the exact total and does NOT charge until Confirm is clicked', async () => {
        await mount();
        await click(/^Pay /);

        // the order of operations, up to the pause
        expect(elementsFake.submit).toHaveBeenCalledTimes(1);
        expect(stripeFake.createConfirmationToken).toHaveBeenCalledTimes(1);
        expect(calls).toContain('POST http://api/v1/billing/subscribe');

        expect(document.body.querySelector('[data-testid="tax-confirm"]')).not.toBeNull();
        expect(document.body.querySelector('[data-testid="tax-confirm-total"]')?.textContent).toBe('$2.68/mo');
        expect(document.body.querySelector('[data-testid="tax-confirm-breakdown"]')?.textContent).toBe('$2.50 + $0.18 tax');
        expect(button(/Confirm \$2\.68\/mo/)).toBeDefined();
        // THE money assertion: nothing charged yet
        expect(stripeFake.confirmPayment).not.toHaveBeenCalled();
        expect(onSuccess).not.toHaveBeenCalled();

        await click(/Confirm \$2\.68\/mo/);
        expect(stripeFake.confirmPayment).toHaveBeenCalledTimes(1);
        expect(stripeFake.confirmPayment.mock.calls[0][0]).toMatchObject({
            clientSecret: 'pi_secret_1', redirect: 'if_required',
        });
        expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it('sends the ConfirmationToken id (and the desktop platform), never a country/ZIP from our own UI', async () => {
        await mount();
        await click(/^Pay /);
        const axios = (await import('axios')).default as unknown as { post: ReturnType<typeof vi.fn> };
        const sub = axios.post.mock.calls.find((c) => String(c[0]).endsWith('/billing/subscribe'))!;
        expect(sub[1]).toEqual({ confirmation_token_id: 'ctoken_1', platform: 'desktop' });
    });

    it('Back from the total returns to the form with nothing charged, and Pay again re-quotes', async () => {
        await mount();
        await click(/^Pay /);
        await click(/^Back$/);
        expect(document.body.querySelector('[data-testid="tax-confirm"]')).toBeNull();
        expect(document.body.querySelector('[data-testid="payment-element"]')).not.toBeNull();
        expect(stripeFake.confirmPayment).not.toHaveBeenCalled();
        await click(/^Pay /);
        expect(stripeFake.createConfirmationToken).toHaveBeenCalledTimes(2);
    });

    it('a total that moved for any OTHER reason (e.g. a discount) also stops for confirmation', async () => {
        routes.post = (url) => url.endsWith('/billing/subscribe')
            ? { data: quote({ amount_tax: 0, amount_subtotal: 200, amount_total: 200 }) }
            : { data: { subscription_status: 'active' } };
        await mount();
        await click(/^Pay /);
        expect(document.body.querySelector('[data-testid="tax-confirm-total"]')?.textContent).toBe('$2.00/mo');
        expect(stripeFake.confirmPayment).not.toHaveBeenCalled();
    });

    it('re-validates the form on Confirm, and a failure there blocks the charge', async () => {
        await mount();
        await click(/^Pay /);
        elementsFake.submit.mockResolvedValueOnce({ error: { message: 'Your card number is incomplete.' } });
        await click(/Confirm /);
        expect(stripeFake.confirmPayment).not.toHaveBeenCalled();
        expect(text()).toContain('Your card number is incomplete.');
    });
});

describe('one-step checkout: errors stay inline in the same panel', () => {
    it('a missing country (tax_location_required) is an inline error, the form stays, nothing is charged', async () => {
        routes.post = (url) => {
            if (url.endsWith('/billing/subscribe')) throw apiError('Enter your country and ZIP / postal code in the payment form so we can work out the tax.', 'tax_location_required');
            return { data: {} };
        };
        await mount();
        await click(/^Pay /);
        expect(text()).toContain('Enter your country and ZIP / postal code in the payment form');
        expect(document.body.querySelector('[data-testid="payment-element"]')).not.toBeNull();
        expect(document.body.querySelector('[data-testid="tax-confirm"]')).toBeNull();
        expect(text()).not.toMatch(/Select your country/);
        expect(stripeFake.confirmPayment).not.toHaveBeenCalled();
        expect(button(/Try again/)).toBeDefined();
    });
    it('Stripe field validation (elements.submit) is shown and stops before tokenising', async () => {
        elementsFake.submit.mockResolvedValueOnce({ error: { message: 'Your postal code is incomplete.' } });
        await mount();
        await click(/^Pay /);
        expect(text()).toContain('Your postal code is incomplete.');
        expect(stripeFake.createConfirmationToken).not.toHaveBeenCalled();
        expect(calls.join('\n')).not.toContain('/billing/subscribe');
    });
    it('a token error stops before the server is called', async () => {
        stripeFake.createConfirmationToken.mockResolvedValueOnce({ error: { message: 'Could not tokenise.' } });
        await mount();
        await click(/^Pay /);
        expect(text()).toContain('Could not tokenise.');
        expect(calls.join('\n')).not.toContain('/billing/subscribe');
    });
    it('a declined card at confirm time returns to the form with a friendly message', async () => {
        stripeFake.confirmPayment.mockResolvedValueOnce({ error: { message: 'Your card was declined.' } });
        routes.post = (url) => url.endsWith('/billing/subscribe')
            ? { data: quote({ amount_tax: 0, amount_total: 250 }) }
            : { data: {} };
        await mount();
        await click(/^Pay /);
        expect(text()).toContain('Your card was declined — try another card?');
        expect(onSuccess).not.toHaveBeenCalled();
    });
    it('does not celebrate until the SERVER says the subscription is active', async () => {
        vi.useFakeTimers();
        try {
            routes.post = (url) => url.endsWith('/billing/subscribe')
                ? { data: quote({ amount_tax: 0, amount_total: 250 }) }
                : { data: { subscription_status: 'expired' } };
            routes.get = (url) => url.endsWith('/billing/checkout-config')
                ? { data: CONFIG }
                : { data: { subscription_status: 'expired' } };
            await mount();
            await click(/^Pay /);
            expect(stripeFake.confirmPayment).toHaveBeenCalled();
            expect(onSuccess).not.toHaveBeenCalled();
        } finally { vi.useRealTimers(); }
    });
});

describe('one-step checkout: the browser fallback is gone', () => {
    it('Stripe.js failing to load shows an error with Try again + the website account page, and NO "continue in browser"', async () => {
        loadStripeResult = null;
        await mount();
        expect(document.body.querySelector('[data-testid="checkout-load-error"]')).not.toBeNull();
        expect(text()).not.toMatch(/continue in (your )?browser/i);
        expect(button(/Try again/)).toBeDefined();
        expect(button(/cipherline\.chat\/account/)).toBeDefined();
        expect(calls.join('\n')).not.toMatch(/billing\/checkout\b(?!-)/);
    });
    it('a failed config fetch is the same recoverable error, and Try again re-requests it', async () => {
        let n = 0;
        routes.get = (url) => {
            if (url.endsWith('/billing/checkout-config')) {
                n += 1;
                if (n === 1) throw apiError('Billing is not configured on this server.');
                return { data: CONFIG };
            }
            return { data: {} };
        };
        await mount();
        expect(text()).toContain('Billing is not configured on this server.');
        await click(/Try again/);
        expect(document.body.querySelector('[data-testid="payment-element"]')).not.toBeNull();
        expect(n).toBe(2);
    });
    it('the account-page link opens the WEBSITE via the validated external opener, not a Stripe session', async () => {
        loadStripeResult = null;
        await mount();
        await click(/cipherline\.chat\/account/);
        const open = (window as unknown as { electronAPI: { openExternal: ReturnType<typeof vi.fn> } }).electronAPI.openExternal;
        expect(open).toHaveBeenCalledWith('https://cipherline.chat/account');
        expect(String(open.mock.calls[0][0])).not.toMatch(/stripe/i);
    });
    it('"Not now" closes', async () => {
        loadStripeResult = null;
        await mount();
        await click(/Not now/);
        expect(onClose).toHaveBeenCalled();
    });
});
