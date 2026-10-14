/**
 * Which payment methods the DESKTOP checkout offers: card + Link, always.
 *
 * Why the client enforces this itself instead of trusting `payment_method_types`
 * from GET /billing/checkout-config: when that field is missing (an older API,
 * a `null` from a web-shaped response, an empty list) the Elements are created
 * with NO `paymentMethodTypes`, and Stripe falls back to the Dashboard's
 * automatic payment methods. That is how a "Bank" tab ended up on the desktop
 * checkout even though POST /billing/subscribe refuses everything but card and
 * Link for the desktop platform. The server stays the authority (it re-checks
 * the confirmation token's method type); this makes the UI unable to offer what
 * the server will refuse.
 *
 * A server list is honoured only as a SUBSET of the allowed set (so the server
 * may narrow, e.g. to ['card'], but can never widen the desktop beyond what
 * Electron can complete).
 */
import type { StripePaymentElementOptions } from '@stripe/stripe-js';
import { DESKTOP_PAYMENT_METHOD_TYPES } from '@cipherline/shared';

export function desktopPaymentMethodTypes(fromServer: readonly string[] | null | undefined): string[] {
    const allowed: readonly string[] = DESKTOP_PAYMENT_METHOD_TYPES;
    const subset = Array.isArray(fromServer) ? fromServer.filter((t) => allowed.includes(t)) : [];
    return subset.length > 0 ? Array.from(new Set(subset)) : [...allowed];
}

/**
 * Payment Element options for the desktop checkout.
 *
 * - `tabs` layout, card first.
 * - Apple Pay / Google Pay off: they need a browser payment sheet Electron does
 *   not have, and Stripe would otherwise surface them wherever the platform
 *   claims support. (Same pinning the card-update modal uses.)
 */
export const DESKTOP_PAYMENT_ELEMENT_OPTIONS: StripePaymentElementOptions = {
    layout: 'tabs',
    paymentMethodOrder: ['card'],
    wallets: { applePay: 'never', googlePay: 'never' },
};
