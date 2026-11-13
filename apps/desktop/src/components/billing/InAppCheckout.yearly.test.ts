// @vitest-environment jsdom
/**
 * The checkout's Monthly / Yearly choice, driven end to end against mocked Stripe
 * (same harness as InAppCheckout.test.ts; nothing here reaches Stripe).
 *
 *   - the picker exists only when the API offers yearly, and defaults to Monthly
 *   - the toggle drives the quote, the consent text AND payload, the tax-preview
 *     request, the subscribe call, the Pay button and the confirm-step total
 *   - a consent is per interval: switching clears the checkbox
 *   - "2 months free" only on the REGULAR yearly price; the founding $30/yr has no badge
 *   - the monthly requests stay byte-identical to before yearly plans existed
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
const elementsFake = { submit: vi.fn(), update: vi.fn() };
let loadStripeResult: unknown = {};

vi.mock('@stripe/stripe-js/pure', () => ({
    loadStripe: vi.fn(async () => loadStripeResult),
}));
vi.mock('@stripe/react-stripe-js', () => ({
    Elements: (p: { options: Record<string, unknown>; children: React.ReactNode }) => {
        return React.createElement('div', { 'data-testid': 'elements' }, p.children);
    },
    PaymentElement: (p: { onReady?: () => void; onChange?: (e: any) => void }) => {
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
/** Does the (fake) API advertise renewal consent on /billing/status? Default: yes (the new API). */
let advertiseConsent = true;
const withConsentFlag = (url: string, res: unknown) => {
    const r = res as { data?: Record<string, unknown> };
    return advertiseConsent && url.endsWith('/billing/status') && r?.data
        ? { ...r, data: { ...r.data, renewal_consent: { required: true, version: 'ar-2026-11-10', text_hash: null } } }
        : res;
};
const routes: { get: Handler; post: Handler } = { get: () => ({ data: {} }), post: () => ({ data: {} }) };
vi.mock('axios', () => {
    const get = vi.fn(async (url: string, cfg?: unknown) => { calls.push(`GET ${url}`); return withConsentFlag(url, routes.get(url, undefined, cfg)); });
    const post = vi.fn(async (url: string, body?: unknown, cfg?: unknown) => { calls.push(`POST ${url}`); return routes.post(url, body, cfg); });
    return { default: { get, post, isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError } };
});

import axios from 'axios';
import { InAppCheckout } from './InAppCheckout';
import { RENEWAL_DISCLOSURE_VERSION } from '@cipherline/shared';

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

/** Tick the (initially unchecked) auto-renewal consent box, then press Pay. */
const tickConsent = async () => {
    const box = document.body.querySelector('[data-testid="renewal-consent-checkbox"]') as HTMLInputElement | null;
    if (!box) throw new Error('no consent checkbox on screen');
    if (!box.checked) await act(async () => { box.click(); });
};
const pay = async () => { await tickConsent(); await click(/^Pay /); };

const CONFIG = { publishable_key: 'pk_test_x', amount: 250, currency: 'usd', automatic_tax: true, payment_method_types: ['card', 'link'] };
const quote = (over: Record<string, unknown> = {}) => ({
    client_secret: 'pi_secret_1', subscription_id: 'sub_1',
    amount_subtotal: 250, amount_tax: 18, amount_total: 268, currency: 'usd', ...over,
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


const FOUNDER_CFG = { ...CONFIG, intervals_available: ['month', 'year'], prices: { month: { amount: 250, currency: 'usd' }, year: { amount: 3000, currency: 'usd' } } };
const REGULAR_CFG = { ...CONFIG, amount: 499, intervals_available: ['month', 'year'], prices: { month: { amount: 499, currency: 'usd' }, year: { amount: 4999, currency: 'usd' } } };

type Axios = { post: ReturnType<typeof vi.fn> };
const axiosPost = (axios as unknown as Axios).post;
const posts = async (suffix: string) => ((await import('axios')).default as unknown as Axios).post.mock.calls.filter((c) => String(c[0]).endsWith(suffix));
const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const pickYearly = async () => { await act(async () => { q('interval-year')!.click(); }); await flush(); };
const pickMonthly = async () => { await act(async () => { q('interval-month')!.click(); }); await flush(); };
const consentBox = () => q('renewal-consent-checkbox') as HTMLInputElement;

beforeEach(() => {
    advertiseConsent = true;
    calls.length = 0;
    loadStripeResult = {};
    onSuccess.mockReset(); onClose.mockReset();
    stripeFake.createConfirmationToken.mockReset().mockResolvedValue({ confirmationToken: { id: 'ctoken_1' } });
    stripeFake.confirmPayment.mockReset().mockResolvedValue({ paymentIntent: { status: 'succeeded' } });
    elementsFake.submit.mockReset().mockResolvedValue({});
    elementsFake.update.mockReset();
    axiosPost.mockClear();
    routes.get = (url) => {
        if (url.endsWith('/billing/checkout-config')) return { data: FOUNDER_CFG };
        if (url.endsWith('/billing/status')) return { data: { subscription_status: 'active', renewal_consent: { required: true, version: 'ar-2026-11-10', text_hash: null } } };
        return { data: {} };
    };
    routes.post = (url, body) => {
        if (url.endsWith('/billing/checkout-preview')) {
            const yearly = (body as { interval?: string })?.interval === 'year';
            return { data: yearly
                ? { available: true, amount_subtotal: 3000, amount_tax: 216, amount_total: 3216, currency: 'usd' }
                : { available: true, amount_subtotal: 250, amount_tax: 18, amount_total: 268, currency: 'usd' } };
        }
        if (url.endsWith('/billing/subscribe')) {
            const yearly = (body as { interval?: string })?.interval === 'year';
            return { data: yearly ? quote({ amount_subtotal: 3000, amount_tax: 216, amount_total: 3216 }) : quote() };
        }
        if (url.endsWith('/billing/activate')) return { data: { subscription_status: 'active' } };
        return { data: {} };
    };
    (window as unknown as { electronAPI?: unknown }).electronAPI = { openExternal: vi.fn(async () => undefined) };
});
afterEach(() => { act(() => { root?.unmount(); }); root = null; host?.remove(); });

describe('interval picker visibility', () => {
    it('is hidden when the API does not offer yearly, and monthly requests carry no interval anywhere', async () => {
        routes.get = (url) => url.endsWith('/billing/checkout-config') ? { data: CONFIG } : { data: { renewal_consent: { required: true, version: 'ar-2026-11-10', text_hash: null } } };
        await mount();
        expect(q('interval-picker')).toBeNull();
        await pay();
        const sub = (await posts('/billing/subscribe'))[0][1] as Record<string, unknown>;
        expect(sub).not.toHaveProperty('interval');
        expect(sub.consent).not.toHaveProperty('interval');
        for (const c of await posts('/billing/checkout-preview')) expect(c[1]).not.toHaveProperty('interval');
    });
    it('is hidden when yearly is "offered" but no yearly quote came with it', async () => {
        routes.get = (url) => url.endsWith('/billing/checkout-config')
            ? { data: { ...CONFIG, intervals_available: ['month', 'year'], prices: { month: { amount: 250, currency: 'usd' }, year: { amount: null, currency: null } } } }
            : { data: {} };
        await mount();
        expect(q('interval-picker')).toBeNull();
    });
    it('is hidden when only monthly is listed, even if a yearly price is present', async () => {
        routes.get = (url) => url.endsWith('/billing/checkout-config') ? { data: { ...FOUNDER_CFG, intervals_available: ['month'] } } : { data: {} };
        await mount();
        expect(q('interval-picker')).toBeNull();
    });
    it('shows both choices, defaulting to Monthly, with the quote for monthly', async () => {
        await mount();
        expect(q('interval-picker')).not.toBeNull();
        expect(q('interval-month')!.getAttribute('aria-checked')).toBe('true');
        expect(q('interval-year')!.getAttribute('aria-checked')).toBe('false');
        expect(button(/^Pay /)?.textContent).toContain('$2.68/mo');   // the preview total, monthly
        expect(q('renewal-disclosure')!.textContent).toContain('every month at $2.50');
        // monthly request: the preview carries no interval key
        for (const c of await posts('/billing/checkout-preview')) expect(c[1]).not.toHaveProperty('interval');
    });
});

describe('badge: "2 months free" on the regular yearly price only', () => {
    it('founding yearly ($30/yr = 12 x $2.50) carries NO badge and no discount wording', async () => {
        await mount();
        expect(q('interval-year')!.textContent).toContain('$30.00/yr');
        expect(q('interval-badge')).toBeNull();
        expect(text()).not.toMatch(/months? free|\bsave\b|% off|discount/i);
    });
    it('regular yearly ($49.99) shows "2 months free"', async () => {
        routes.get = (url) => url.endsWith('/billing/checkout-config') ? { data: REGULAR_CFG } : { data: {} };
        await mount();
        expect(q('interval-year')!.textContent).toContain('$49.99/yr');
        expect(q('interval-badge')!.textContent).toBe('2 months free');
        expect(q('interval-month')!.textContent).not.toMatch(/free/);
    });
});

describe('choosing Yearly', () => {
    it('re-quotes everything: Elements amount, Pay label, consent wording, and the preview request', async () => {
        await mount();
        await pickYearly();
        expect(q('interval-year')!.getAttribute('aria-checked')).toBe('true');
        expect(elementsFake.update).toHaveBeenCalledWith({ amount: 3000 });
        // preview refetched WITH the interval; its total drives the Pay label
        const previews = await posts('/billing/checkout-preview');
        expect(previews[previews.length - 1][1]).toMatchObject({ platform: 'desktop', interval: 'year' });
        expect(button(/^Pay /)?.textContent).toContain('$32.16/yr');
        expect(q('total-today')!.textContent).toContain('$32.16');
        // the consent text says yearly, at the yearly price
        expect(q('renewal-disclosure')!.textContent).toBe(
            'Cipherline Pro renews automatically every year at $30.00 plus any applicable tax, charged to the payment method you provide, until you cancel.');
        expect(q('checkout-price')!.textContent).toBe('$32.16/yr');
    });
    it('clears the consent checkbox: a consent is per interval (both directions)', async () => {
        await mount();
        await tickConsent();
        expect(consentBox().checked).toBe(true);
        await pickYearly();
        expect(consentBox().checked).toBe(false);
        expect(button(/^Pay /)?.disabled).toBe(true);
        await tickConsent();
        await pickMonthly();
        expect(consentBox().checked).toBe(false);
        expect(elementsFake.update).toHaveBeenLastCalledWith({ amount: 250 });
    });
    it('subscribes yearly: interval + a yearly consent payload at the yearly price, and the confirm step says /yr', async () => {
        await mount();
        await pickYearly();
        await pay();
        const sub = (await posts('/billing/subscribe'))[0][1];
        expect(sub).toEqual({
            confirmation_token_id: 'ctoken_1', platform: 'desktop', interval: 'year',
            consent: { accepted: true, disclosure_version: RENEWAL_DISCLOSURE_VERSION, price_minor: 3000, currency: 'usd', interval: 'year' },
        });
        // the server total (3216) matches the previewed yearly total, so no confirm step
        expect(stripeFake.confirmPayment).toHaveBeenCalledTimes(1);
    });
    it('a taxed yearly total that differs from the shown one stops at "Confirm $X/yr" and charges nothing yet', async () => {
        routes.post = (url) => {
            if (url.endsWith('/billing/checkout-preview')) return { data: { available: false } };
            if (url.endsWith('/billing/subscribe')) return { data: quote({ amount_subtotal: 3000, amount_tax: 216, amount_total: 3216 }) };
            return { data: { subscription_status: 'active' } };
        };
        await mount();
        await pickYearly();
        await pay();
        expect(q('tax-confirm-total')!.textContent).toBe('$32.16/yr');
        expect(button(/Confirm \$32\.16\/yr/)).toBeDefined();
        expect(stripeFake.confirmPayment).not.toHaveBeenCalled();
    });
    it('switching back to Monthly subscribes with NO interval key and a consent without one', async () => {
        await mount();
        await pickYearly();
        await pickMonthly();
        await pay();
        const sub = (await posts('/billing/subscribe'))[0][1] as Record<string, unknown>;
        expect(sub).not.toHaveProperty('interval');
        expect(sub.consent).toEqual({ accepted: true, disclosure_version: RENEWAL_DISCLOSURE_VERSION, price_minor: 250, currency: 'usd' });
    });
    it('toggling from the confirm step returns to the form and drops the stale quote', async () => {
        routes.post = (url) => url.endsWith('/billing/subscribe') ? { data: quote() } : { data: { available: false } };
        await mount();
        await pay();                       // monthly, tax differs -> confirm step
        expect(q('tax-confirm')).not.toBeNull();
        await pickYearly();
        expect(q('tax-confirm')).toBeNull();
        expect(button(/^Pay /)).toBeDefined();
        expect(stripeFake.confirmPayment).not.toHaveBeenCalled();
    });
});

describe('founder / regular yearly quotes come from the API amounts', () => {
    it('regular yearly: Pay shows $49.99/yr + tax (no preview) and consent says $49.99', async () => {
        routes.get = (url) => url.endsWith('/billing/checkout-config') ? { data: REGULAR_CFG } : { data: {} };
        routes.post = () => ({ data: { available: false } });
        await mount();
        await pickYearly();
        expect(button(/^Pay /)?.textContent).toContain('$49.99/yr + tax');
        expect(q('renewal-disclosure')!.textContent).toContain('every year at $49.99');
        expect(elementsFake.update).toHaveBeenCalledWith({ amount: 4999 });
    });
});
