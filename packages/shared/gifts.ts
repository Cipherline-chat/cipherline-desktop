/**
 * Gift subscriptions — the client <-> API contract (owner decision 2026-11-17).
 *
 * A user buys 1 or 12 months of Cipherline Pro for a FRIEND at the full
 * standard price, then sends the gift into their DM as an E2EE `pro_gift`
 * message that carries the gift id and nothing else. The recipient accepts it
 * from that card: a recipient with a live, renewing paid subscription gets the
 * value as credit against their renewals; anyone else gets Pro time.
 *
 * Everything that decides money or entitlement is server-side (apps/api
 * billing/gifts.service.ts). These types describe what the API returns; a
 * client must never compute a price, a state transition or an entitlement
 * from them.
 */

/** The only gift lengths on sale. */
export const GIFT_MONTH_OPTIONS = [1, 12] as const;
export type GiftMonths = typeof GIFT_MONTH_OPTIONS[number];

export type GiftStatus = 'pending' | 'paid' | 'redeemed' | 'void' | 'revoked';

/** One gift, as the CALLER may see it (GET /v1/billing/gifts/:id). Only the
 *  buyer and the recipient can read a gift; anyone else gets a 404. */
export interface GiftView {
    gift_id: string;
    months: GiftMonths;
    status: GiftStatus;
    /** Which side of the gift the caller is on. */
    role: 'sender' | 'recipient';
    /** The recipient (for the sender) or the buyer (for the recipient). */
    other_user_id: string | null;
    created_at: string;
    paid_at: string | null;
    redeemed_at: string | null;
    redemption_kind: 'time' | 'credit' | null;
    /** Sender only (null for the recipient): what was paid, minor units. */
    amount_subtotal: number | null;
    amount_tax: number | null;
    amount_total: number | null;
    currency: string | null;
    /** Recipient only: the end of the gifted Pro slot (time redemptions). */
    grant_end: string | null;
    /** Recipient only: balance credit applied (credit redemptions), minor units. */
    credit_amount: number | null;
    /** Why a void / revoked gift ended: refunded or disputed by the buyer's
     *  card, or refunded AUTOMATICALLY - 'expired' (not opened within
     *  GIFT_UNOPENED_REFUND_DAYS) / 'recipient_deleted' (the recipient closed
     *  their account before opening it). */
    ended_reason: 'refunded' | 'disputed' | 'expired' | 'recipient_deleted' | null;
}

/** GET /v1/billing/gifts */
export interface GiftListResponse {
    sent: GiftView[];
    received: GiftView[];
    /** The caller's gifted Pro end, when a gifted period is running. */
    pro_until: string | null;
}

/** GET /v1/billing/gifts/config */
export interface GiftConfig {
    /** False while the server's GIFTS_ENABLED switch is off: nothing to buy
     *  (accepting gifts already paid for still works). Absent on no API. */
    enabled: boolean;
    /** Days after which an unopened gift is refunded to the buyer. */
    refund_after_days: number;
    publishable_key: string;
    /** Price per length (before tax). A length is absent when not on sale. */
    offers: Array<{ months: GiftMonths; amount: number | null; currency: string | null }>;
    automatic_tax: boolean;
    payment_method_types: string[] | null;
}

/** POST /v1/billing/gifts — the PaymentIntent to confirm, and the exact total. */
export interface GiftPurchaseResult {
    gift_id: string;
    client_secret: string;
    amount_subtotal: number;
    amount_tax: number;
    amount_total: number;
    currency: string;
}

/** POST /v1/billing/gifts/:id/redeem */
export interface GiftRedeemResult {
    gift: GiftView;
    outcome: 'time' | 'credit';
    pro_until: string | null;
    credit_amount: number | null;
    /** The gift was already redeemed (a retry, or another of the recipient's devices). */
    already: boolean;
}

/** Owner 2026-11-17: an unopened gift is refunded to its buyer after this many days. */
export const GIFT_UNOPENED_REFUND_DAYS = 90;

/** Machine-readable error codes the gift routes return in `{ code, message }`. */
export const GIFT_ERROR_CODES = [
    'gift_self', 'gift_not_friend', 'gift_buyer_revoked', 'gift_recipient_unavailable',
    'gift_recipient_revoked', 'gift_not_found', 'gift_not_paid', 'gift_void', 'gift_unavailable',
    'gift_currency_mismatch', 'gift_payment_method', 'gift_token_used', 'gift_token_expired', 'gifts_disabled',
] as const;

/** "1 month" / "12 months". */
export function giftLengthLabel(months: number): string {
    return months === 12 ? '12 months' : '1 month';
}

// ── The E2EE chat card ──────────────────────────────────────────────────────

/**
 * The `pro_gift` ClientContent variant's payload check. The card carries the
 * gift id ONLY: no price, no length, no state — the server already knows the
 * buyer, the recipient and the gift (necessary billing data), and the message
 * must not tell it anything more. Every client fetches the gift's state by id
 * (buyer/recipient only), so a forged or replayed card can show nothing the
 * viewer is not already entitled to see, and can never claim a state.
 */
export const GIFT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function proGiftProblem(c: unknown): string | null {
    if (!c || typeof c !== 'object') return 'pro_gift must be an object';
    const v = c as Record<string, unknown>;
    if (v.type !== 'pro_gift') return 'pro_gift.type must be pro_gift';
    if (typeof v.gift_id !== 'string' || !GIFT_ID_PATTERN.test(v.gift_id)) return 'pro_gift.gift_id must be a uuid';
    // Other keys are IGNORED, not refused: the send pipeline seals transport
    // fields into every payload (e.g. franking's `_fk`, lifted on receipt),
    // and the renderer reads nothing but `gift_id`.
    return null;
}
