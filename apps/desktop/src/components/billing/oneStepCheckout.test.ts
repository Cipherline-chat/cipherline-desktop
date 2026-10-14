/**
 * The framework-free half of the one-step checkout (packages/shared/billing.ts),
 * shared by the desktop and the website so they cannot drift. Covers the
 * sequence/stop-points of `prepareOneStepSubscription`, the "must the customer
 * approve a different total?" rule, and how API errors are read.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    prepareOneStepSubscription, totalDiffersFromQuote, formatConfirmedTotal, formatTotalBreakdown,
    apiErrorMessage, apiErrorCode, DESKTOP_PAYMENT_METHOD_TYPES, WEBSITE_ACCOUNT_URL,
    type SubscribeResult, type PrepareDeps,
} from '@cipherline/shared';

const result = (over: Partial<SubscribeResult> = {}): SubscribeResult => ({
    client_secret: 'pi_secret', subscription_id: 'sub_1',
    amount_subtotal: 250, amount_tax: 18, amount_total: 268, currency: 'usd', ...over,
});

function deps(over: Partial<PrepareDeps> = {}) {
    const order: string[] = [];
    const d: PrepareDeps = {
        submit: vi.fn(async () => { order.push('submit'); return {}; }),
        createToken: vi.fn(async () => { order.push('token'); return { confirmationToken: { id: 'ctoken_1' } }; }),
        subscribe: vi.fn(async () => { order.push('subscribe'); return result(); }),
        ...over,
    };
    return { d, order };
}

describe('totalDiffersFromQuote', () => {
    it('is false only when amount AND currency match the quote', () => {
        expect(totalDiffersFromQuote(result({ amount_total: 250, amount_tax: 0 }), 250, 'usd')).toBe(false);
        expect(totalDiffersFromQuote(result({ amount_total: 250, currency: 'USD' }), 250, 'usd')).toBe(false);
    });
    it('is true for tax, for a discount, and for a currency change', () => {
        expect(totalDiffersFromQuote(result(), 250, 'usd')).toBe(true);
        expect(totalDiffersFromQuote(result({ amount_total: 200 }), 250, 'usd')).toBe(true);
        expect(totalDiffersFromQuote(result({ amount_total: 250, currency: 'eur' }), 250, 'usd')).toBe(true);
    });
});

describe('total formatting', () => {
    it('shows the tax-inclusive monthly total and its breakdown', () => {
        expect(formatConfirmedTotal(result())).toBe('$2.68/mo');
        expect(formatTotalBreakdown(result())).toBe('$2.50 + $0.18 tax');
    });
    it('omits the tax clause when there is none', () => {
        expect(formatTotalBreakdown(result({ amount_tax: 0, amount_total: 250 }))).toBe('$2.50');
    });
});

describe('prepareOneStepSubscription', () => {
    it('runs submit -> token -> subscribe in that order and flags a differing total', async () => {
        const { d, order } = deps();
        const out = await prepareOneStepSubscription(d, { amount: 250, currency: 'usd' });
        expect(order).toEqual(['submit', 'token', 'subscribe']);
        expect(d.subscribe).toHaveBeenCalledWith('ctoken_1');
        expect(out).toMatchObject({ kind: 'ready', needsConfirm: true });
    });
    it('needs no confirmation when the total equals the quote', async () => {
        const { d } = deps({ subscribe: vi.fn(async () => result({ amount_tax: 0, amount_total: 250 })) });
        expect(await prepareOneStepSubscription(d, { amount: 250, currency: 'usd' })).toMatchObject({ kind: 'ready', needsConfirm: false });
    });
    it('stops at a form-validation error: no token, no server call', async () => {
        const { d } = deps({ submit: vi.fn(async () => ({ error: { message: 'Incomplete.' } })) });
        const out = await prepareOneStepSubscription(d, { amount: 250, currency: 'usd' });
        expect(out).toEqual({ kind: 'error', message: 'Incomplete.', code: null });
        expect(d.createToken).not.toHaveBeenCalled();
        expect(d.subscribe).not.toHaveBeenCalled();
    });
    it('stops at a token error (or a token with no id): no server call', async () => {
        for (const bad of [{ error: { message: 'No token.' } }, { confirmationToken: null }, {}]) {
            const { d } = deps({ createToken: vi.fn(async () => bad) });
            const out = await prepareOneStepSubscription(d, { amount: 250, currency: 'usd' });
            expect(out.kind).toBe('error');
            expect(d.subscribe).not.toHaveBeenCalled();
        }
    });
    it('never throws: a server rejection becomes an error outcome carrying message AND code', async () => {
        const err = Object.assign(new Error('x'), { response: { data: { code: 'tax_location_required', message: 'Enter your country.' } } });
        const { d } = deps({ subscribe: vi.fn(async () => { throw err; }) });
        await expect(prepareOneStepSubscription(d, { amount: 250, currency: 'usd' }))
            .resolves.toEqual({ kind: 'error', message: 'Enter your country.', code: 'tax_location_required' });
    });
    it('rejects a malformed server response instead of proceeding to charge it', async () => {
        for (const bad of [{}, { client_secret: '', amount_total: 268 }, { client_secret: 's' }]) {
            const { d } = deps({ subscribe: vi.fn(async () => bad as unknown as SubscribeResult) });
            expect((await prepareOneStepSubscription(d, { amount: 250, currency: 'usd' })).kind).toBe('error');
        }
    });
});

describe('API error readers', () => {
    it('prefers the API message (string or class-validator array) over the transport message', () => {
        expect(apiErrorMessage({ response: { data: { message: 'Nope.' } }, message: 'Request failed with status code 400' }, 'f')).toBe('Nope.');
        expect(apiErrorMessage({ response: { data: { message: ['a', 'b'] } } }, 'f')).toBe('a b');
        expect(apiErrorMessage(new Error('Network Error'), 'f')).toBe('Network Error');
        expect(apiErrorMessage(null, 'fallback')).toBe('fallback');
    });
    it('reads the machine-readable code from either envelope shape', () => {
        expect(apiErrorCode({ response: { data: { code: 'c1', message: 'm' } } })).toBe('c1');
        expect(apiErrorCode({ response: { data: { message: { code: 'c2' } } } })).toBe('c2');
        expect(apiErrorCode({ response: { data: 'text' } })).toBeNull();
        expect(apiErrorCode(undefined)).toBeNull();
    });
});

describe('platform constants', () => {
    it('desktop is card + Link only: no wallet or redirect method an Electron window cannot complete', () => {
        expect([...DESKTOP_PAYMENT_METHOD_TYPES]).toEqual(['card', 'link']);
    });
    it('the fallback for a checkout that cannot load is the website account page, not Stripe', () => {
        expect(WEBSITE_ACCOUNT_URL).toBe('https://cipherline.chat/account');
        expect(WEBSITE_ACCOUNT_URL).not.toMatch(/stripe/i);
    });
});
