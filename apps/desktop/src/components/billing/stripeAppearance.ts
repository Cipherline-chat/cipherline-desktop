/**
 * The "glow in the deep" look for Stripe Elements, in one place.
 *
 * This was duplicated in the desktop checkout and the website checkout, kept in
 * sync by hand and by comment. Now that a third surface (the card-update modal)
 * needs it too, it lives here — `apps/website` already compiles against this
 * tree, so it can import the same object rather than keeping a fourth copy.
 */
import type { Appearance, StripePaymentElementOptions } from '@stripe/stripe-js';

export const STRIPE_APPEARANCE: Appearance = {
    theme: 'night',
    variables: {
        colorPrimary: '#25E0C8',
        colorBackground: '#131A30',
        colorText: '#E8ECF4',
        colorTextSecondary: '#9AA4B8',
        colorDanger: '#FF6B5E',
        fontFamily: 'Nunito, system-ui, sans-serif',
        fontSizeBase: '15px',
        borderRadius: '12px',
        spacingUnit: '4px',
    },
    rules: {
        '.Input': { backgroundColor: '#0F1424', border: '1px solid rgba(255,255,255,0.08)', boxShadow: 'none' },
        '.Input:focus': { border: '1px solid #25E0C8', boxShadow: '0 0 0 3px rgba(37,224,200,0.25)' },
        '.Label': { color: '#9AA4B8', fontWeight: '600' },
        '.Tab': { backgroundColor: '#0F1424', border: '1px solid rgba(255,255,255,0.08)' },
        '.Tab:hover': { borderColor: '#25E0C8' },
        '.Tab--selected': { borderColor: '#25E0C8', boxShadow: '0 0 0 1px #25E0C8' },
        '.Block': { backgroundColor: '#0F1424', border: '1px solid rgba(255,255,255,0.08)' },
        '.Error': { color: '#FF6B5E' },
    },
};

/**
 * Nunito for the Elements iframe.
 *
 * The DESKTOP loads this from Google Fonts (its CSP allows fonts.googleapis.com
 * and the renderer already pulls Nunito the same way). The WEBSITE deliberately
 * self-hosts every font for CSP + GDPR reasons and must pass `[]` instead —
 * see the comment on its checkout. Don't "fix" that asymmetry by pointing the
 * website at Google.
 */
export const STRIPE_FONTS = [
    { cssSrc: 'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700&display=swap' },
];

/**
 * `wallets.link` is real in the live Elements runtime but missing from the
 * pinned @stripe/stripe-js 5.10 typings.
 *
 * The npm package is only a loader — the Element itself is fetched from
 * js.stripe.com at runtime and is always current — so an option added to
 * Stripe's API after 5.10 works today; the types are the only thing lagging.
 * Widened here rather than bumping two apps' dependencies for one key.
 */
type WalletsWithLink = NonNullable<StripePaymentElementOptions['wallets']> & {
    link?: 'auto' | 'never';
};

/**
 * The Payment Element options for CARD-ONLY surfaces — currently the
 * "update payment method" modal on desktop and on the website, which must
 * render identically.
 *
 * Changing the card on a $2.50/mo subscription is not a checkout, and the
 * Payment Element's defaults treat it like one:
 *
 * - **Link** rides along with `card` by design. Stripe's own docs are explicit
 *   that `payment_method_types: ['card']` INCLUDES Link ("To include Link in a
 *   card integration, pass `card`"), so restricting the SetupIntent server-side
 *   does not suppress it. Link is what produced "Secure, fast checkout with
 *   Link", the optional email/phone "save my information" block, and the "Bank"
 *   tab with its cash-back badge — Link Instant Bank Payments, an incentive
 *   Stripe injects that Cipherline neither offers nor funds. `link: 'never'` is
 *   the per-integration off switch (the alternative is an account-wide
 *   Dashboard toggle, which would also strip Link from the purchase flow).
 * - **Apple Pay / Google Pay** are not payment-method types either; Stripe
 *   surfaces them wherever the platform supports them. That is why the website
 *   showed more options than the desktop off one identical SetupIntent — the
 *   drift was the browser, not the config. Pinning both to 'never' makes the
 *   two clients render the same thing everywhere. A wallet is also the wrong
 *   control here: it re-authorises a payment, it does not hand us a card to
 *   store for renewals.
 *
 * `terms` is deliberately left at 'auto' — the card mandate text is a legal
 * disclosure, not chrome to trim for height.
 */
export const STRIPE_CARD_ONLY_ELEMENT_OPTIONS: StripePaymentElementOptions = {
    layout: 'tabs',
    paymentMethodOrder: ['card'],
    wallets: {
        applePay: 'never',
        googlePay: 'never',
        link: 'never',
    } as WalletsWithLink,
};
