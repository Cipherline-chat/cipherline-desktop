import { describe, expect, it, vi } from 'vitest';
import type { GiftPurchaseResult, GiftView } from '@cipherline/shared';
import { awaitGiftPaid, prepareGiftPurchase, type GiftPrepareDeps } from './giftPurchase';

const RESULT: GiftPurchaseResult = {
    gift_id: '0f8e3c2a-1b4d-4c6e-8f9a-0b1c2d3e4f5a',
    client_secret: 'test-client-secret', // not a real Stripe secret (a pi_..._secret_... shape trips gitleaks)
    amount_subtotal: 499,
    amount_tax: 0,
    amount_total: 499,
    currency: 'usd',
};

function deps(over: Partial<GiftPrepareDeps> = {}): GiftPrepareDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        submit: over.submit ?? (async () => { calls.push('submit'); return {}; }),
        createToken: over.createToken ?? (async () => { calls.push('token'); return { confirmationToken: { id: 'ctoken_1' } }; }),
        purchase: over.purchase ?? (async (id) => { calls.push(`purchase:${id}`); return RESULT; }),
    };
}

const axiosErr = (status: number, data: unknown) => Object.assign(new Error('Request failed'), { response: { status, data } });

describe('prepareGiftPurchase', () => {
    it('runs submit -> token -> purchase in order and charges directly when the total matches', async () => {
        const d = deps();
        const out = await prepareGiftPurchase(d, { amount: 499, currency: 'usd' });
        expect(d.calls).toEqual(['submit', 'token', 'purchase:ctoken_1']);
        expect(out).toEqual({ kind: 'ready', result: RESULT, needsConfirm: false });
    });

    it('asks for a confirm when tax changed the total (nothing charged yet)', async () => {
        const taxed = { ...RESULT, amount_tax: 35, amount_total: 534 };
        const out = await prepareGiftPurchase(deps({ purchase: async () => taxed }), { amount: 499, currency: 'usd' });
        expect(out).toEqual({ kind: 'ready', result: taxed, needsConfirm: true });
    });

    it('asks for a confirm on a currency change too', async () => {
        const out = await prepareGiftPurchase(deps({ purchase: async () => ({ ...RESULT, currency: 'eur' }) }), { amount: 499, currency: 'usd' });
        expect(out.kind === 'ready' && out.needsConfirm).toBe(true);
    });

    it('a form validation error stops before tokenising', async () => {
        const d = deps({ submit: async () => ({ error: { message: 'Your card number is incomplete.' } }) });
        const out = await prepareGiftPurchase(d, { amount: 499, currency: 'usd' });
        expect(out).toEqual({ kind: 'error', message: 'Your card number is incomplete.', code: null });
        expect(d.calls).toEqual([]);
    });

    it('a token error stops before the server is asked', async () => {
        const purchase = vi.fn();
        const out = await prepareGiftPurchase(deps({ createToken: async () => ({ error: { message: 'nope' } }), purchase }), { amount: 499, currency: 'usd' });
        expect(out).toMatchObject({ kind: 'error', message: 'nope' });
        expect(purchase).not.toHaveBeenCalled();
    });

    it('a missing token id is an error, not a purchase with "undefined"', async () => {
        const purchase = vi.fn();
        const out = await prepareGiftPurchase(deps({ createToken: async () => ({ confirmationToken: null }), purchase }), { amount: 499, currency: 'usd' });
        expect(out.kind).toBe('error');
        expect(purchase).not.toHaveBeenCalled();
    });

    it('surfaces the API message and code (tax_location_required goes inline by the form)', async () => {
        const err = axiosErr(400, { code: 'tax_location_required', message: 'Enter your country and ZIP to calculate tax.' });
        const out = await prepareGiftPurchase(deps({ purchase: async () => { throw err; } }), { amount: 499, currency: 'usd' });
        expect(out).toEqual({ kind: 'error', message: 'Enter your country and ZIP to calculate tax.', code: 'tax_location_required' });
    });

    it('a gift_not_friend refusal keeps its wording', async () => {
        const err = axiosErr(403, { code: 'gift_not_friend', message: 'You can only gift Pro to friends.' });
        const out = await prepareGiftPurchase(deps({ purchase: async () => { throw err; } }), { amount: 499, currency: 'usd' });
        expect(out).toEqual({ kind: 'error', message: 'You can only gift Pro to friends.', code: 'gift_not_friend' });
    });

    it('a malformed server answer is never charged', async () => {
        for (const bad of [{ ...RESULT, client_secret: '' }, { ...RESULT, gift_id: '' }, { ...RESULT, amount_total: undefined as unknown as number }, null as unknown as GiftPurchaseResult]) {
            const out = await prepareGiftPurchase(deps({ purchase: async () => bad }), { amount: 499, currency: 'usd' });
            expect(out.kind).toBe('error');
        }
    });

    it('never throws, even when Stripe.js itself throws', async () => {
        const out = await prepareGiftPurchase(deps({ submit: async () => { throw new Error('iframe gone'); } }), { amount: 499, currency: 'usd' });
        expect(out).toMatchObject({ kind: 'error', message: 'iframe gone' });
    });
});

function gift(status: GiftView['status']): GiftView {
    return {
        gift_id: RESULT.gift_id, months: 1, status, role: 'sender', other_user_id: 'u2',
        created_at: '', paid_at: null, redeemed_at: null, redemption_kind: null,
        amount_subtotal: 499, amount_tax: 0, amount_total: 499, currency: 'usd',
        grant_end: null, credit_amount: null, ended_reason: null,
    };
}

/** A fake clock: sleep advances it. */
function clock() {
    let t = 0;
    const sleeps: number[] = [];
    return {
        now: () => t,
        sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
        sleeps,
        advance: (ms: number) => { t += ms; },
    };
}

describe('awaitGiftPaid', () => {
    it('paid on the first confirm: no polling', async () => {
        const c = clock();
        const confirm = vi.fn(async () => gift('paid'));
        const out = await awaitGiftPaid({ confirm, ...c });
        expect(out.outcome).toBe('paid');
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(c.sleeps).toEqual([]);
    });

    it('already redeemed (fast friend, other device) also counts as paid', async () => {
        const out = await awaitGiftPaid({ confirm: async () => gift('redeemed'), ...clock() });
        expect(out.outcome).toBe('paid');
    });

    it('polls every 2 s while pending, then succeeds', async () => {
        const c = clock();
        const answers = [gift('pending'), gift('pending'), gift('paid')];
        const out = await awaitGiftPaid({ confirm: async () => answers.shift()!, ...c });
        expect(out.outcome).toBe('paid');
        expect(c.sleeps).toEqual([2000, 2000]);
    });

    it('a transient confirm failure is retried, not fatal', async () => {
        const c = clock();
        let n = 0;
        const out = await awaitGiftPaid({ confirm: async () => { if (n++ === 0) throw new Error('502'); return gift('paid'); }, ...c });
        expect(out.outcome).toBe('paid');
    });

    it('gives up as "slow" at ~30 s — never claims success', async () => {
        const c = clock();
        const confirm = vi.fn(async () => gift('pending'));
        const out = await awaitGiftPaid({ confirm, ...c });
        expect(out.outcome).toBe('slow');
        expect(c.now()).toBeLessThanOrEqual(30_000);
        expect(confirm.mock.calls.length).toBeGreaterThanOrEqual(14);
        expect(confirm.mock.calls.length).toBeLessThanOrEqual(16);
    });

    it('slow even when every confirm errored (view stays null)', async () => {
        const out = await awaitGiftPaid({ confirm: async () => { throw new Error('down'); }, ...clock() });
        expect(out).toEqual({ outcome: 'slow', view: null });
    });

    it('void / revoked is a failure, not a success', async () => {
        expect((await awaitGiftPaid({ confirm: async () => gift('void'), ...clock() })).outcome).toBe('failed');
        expect((await awaitGiftPaid({ confirm: async () => gift('revoked'), ...clock() })).outcome).toBe('failed');
    });

    it('stops early when cancelled', async () => {
        const c = clock();
        const out = await awaitGiftPaid({ confirm: async () => gift('pending'), cancelled: () => true, ...c });
        expect(out.outcome).toBe('slow');
        expect(c.sleeps).toEqual([]);
    });

    it('honours custom timings', async () => {
        const c = clock();
        const out = await awaitGiftPaid({ confirm: async () => gift('pending'), ...c }, { intervalMs: 500, timeoutMs: 1000 });
        expect(out.outcome).toBe('slow');
        // asks at 0, 500 and 1000 ms (the last one exactly at the timeout), then stops
        expect(c.sleeps).toEqual([500, 500]);
    });
});
