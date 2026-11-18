/**
 * The gift checkout's steps as plain async functions with injected effects, so
 * the ordering rules are unit-tested (giftPurchase.test.ts) rather than buried
 * in a component:
 *
 *   prepareGiftPurchase  elements.submit -> createConfirmationToken -> POST /billing/gifts,
 *                        then "does the customer have to approve a different total?"
 *                        Stops BEFORE any charge.
 *   awaitGiftPaid        after stripe.confirmPayment: POST /:id/confirm, then re-ask every
 *                        2 s for up to ~30 s. Only `paid` (or already `redeemed`) is
 *                        success; the caller must never celebrate on anything else.
 */
import {
    apiErrorCode,
    apiErrorMessage,
    totalDiffersFromQuote,
    type GiftPurchaseResult,
    type GiftView,
} from '@cipherline/shared';

export type GiftPrepareOutcome =
    | { kind: 'error'; message: string; code: string | null }
    | { kind: 'ready'; result: GiftPurchaseResult; needsConfirm: boolean };

export interface GiftPrepareDeps {
    /** `elements.submit()` */
    submit: () => Promise<{ error?: { message?: string } | null }>;
    /** `stripe.createConfirmationToken({ elements })` */
    createToken: () => Promise<{ error?: { message?: string } | null; confirmationToken?: { id: string } | null }>;
    /** `POST /billing/gifts` with the token id. */
    purchase: (confirmationTokenId: string) => Promise<GiftPurchaseResult>;
}

/** Never throws: every failure is an `error` outcome with the message to show inline. */
export async function prepareGiftPurchase(
    deps: GiftPrepareDeps,
    quote: { amount: number; currency: string },
): Promise<GiftPrepareOutcome> {
    let submitted: Awaited<ReturnType<GiftPrepareDeps['submit']>>;
    try {
        submitted = await deps.submit();
    } catch (err) {
        return { kind: 'error', message: apiErrorMessage(err, 'Check your payment details.'), code: null };
    }
    if (submitted?.error) {
        return { kind: 'error', message: submitted.error.message || 'Check your payment details.', code: null };
    }
    let made: Awaited<ReturnType<GiftPrepareDeps['createToken']>>;
    try {
        made = await deps.createToken();
    } catch (err) {
        return { kind: 'error', message: apiErrorMessage(err, 'Could not read your payment details. Please try again.'), code: null };
    }
    if (made?.error || !made?.confirmationToken?.id) {
        return { kind: 'error', message: made?.error?.message || 'Could not read your payment details. Please try again.', code: null };
    }
    let result: GiftPurchaseResult;
    try {
        result = await deps.purchase(made.confirmationToken.id);
    } catch (err) {
        return { kind: 'error', message: apiErrorMessage(err, 'Could not start the payment. Please try again.'), code: apiErrorCode(err) };
    }
    if (!result?.client_secret || !result.gift_id || typeof result.amount_total !== 'number' || !result.currency) {
        return { kind: 'error', message: 'Billing returned an unexpected response. Please try again.', code: null };
    }
    return { kind: 'ready', result, needsConfirm: totalDiffersFromQuote(result, quote.amount, quote.currency) };
}

export const GIFT_CONFIRM_POLL_MS = 2_000;
export const GIFT_CONFIRM_TIMEOUT_MS = 30_000;

export type GiftPaidOutcome =
    /** The server says paid (or the recipient already opened it): safe to celebrate + send the card. */
    | { outcome: 'paid'; view: GiftView }
    /** Still not paid after the timeout. Stripe took the money; the server will catch up. */
    | { outcome: 'slow'; view: GiftView | null }
    /** The gift ended (void / revoked) instead of becoming paid. */
    | { outcome: 'failed'; view: GiftView };

export interface GiftPaidDeps {
    /** `POST /billing/gifts/:id/confirm` (asks Stripe directly; safe to repeat). */
    confirm: () => Promise<GiftView>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    /** Stop early (the modal was closed). */
    cancelled?: () => boolean;
}

export async function awaitGiftPaid(
    deps: GiftPaidDeps,
    opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<GiftPaidOutcome> {
    const intervalMs = opts.intervalMs ?? GIFT_CONFIRM_POLL_MS;
    const timeoutMs = opts.timeoutMs ?? GIFT_CONFIRM_TIMEOUT_MS;
    const started = deps.now();
    let view: GiftView | null = null;
    for (;;) {
        try {
            view = await deps.confirm();
        } catch {
            // Transient: the payment is already with Stripe. Keep asking.
        }
        if (view && (view.status === 'paid' || view.status === 'redeemed')) return { outcome: 'paid', view };
        if (view && (view.status === 'void' || view.status === 'revoked')) return { outcome: 'failed', view };
        if (deps.cancelled?.() || deps.now() - started + intervalMs > timeoutMs) return { outcome: 'slow', view };
        await deps.sleep(intervalMs);
    }
}
