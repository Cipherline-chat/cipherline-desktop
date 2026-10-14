/**
 * Billing shapes the API returns and BOTH clients render.
 *
 * They live here rather than in either client because the desktop settings
 * pane and the website account portal show the same subscription information
 * from the same endpoints. The two checkout components are already maintained
 * as manual near-duplicates; this is the drift that contract is meant to stop.
 *
 * Display fields only — deliberately no Stripe ids beyond what a client needs
 * to render a row, no billing address, no fingerprints.
 */

/** The saved card that will actually be charged on the next renewal. */
export interface PaymentMethodView {
    id: string;
    /** Stripe payment-method type: 'card', 'link', ... */
    type: string;
    /** 'visa' | 'mastercard' | ... — null for non-card methods. */
    brand: string | null;
    last4: string | null;
    exp_month: number | null;
    exp_year: number | null;
}

/** One past charge, for the in-app payment history. */
export interface InvoiceView {
    id: string;
    /** Stripe's human-facing invoice number, e.g. "B1C2D3-0001". */
    number: string | null;
    /** ISO timestamp. */
    created: string;
    /** Minor units (250 = $2.50), matching Stripe. */
    amount_paid: number;
    amount_due: number;
    /** ISO 4217, lowercase, as Stripe returns it. */
    currency: string;
    /** 'paid' | 'open' | 'uncollectible' (void/draft are never listed). */
    status: string;
    /** Stripe-hosted receipt page / PDF. We link rather than re-render. */
    hosted_invoice_url: string | null;
    invoice_pdf: string | null;
}

/** How one payment-history row should read. Shared so desktop and website agree. */
export interface InvoiceRowView {
    /** True only for an invoice Stripe actually collected. */
    paid: boolean;
    /** Minor units to show: what was PAID for a paid row, what is DUE otherwise. */
    amountMinor: number;
    /** Chip text for a row that is not a settled payment ('Unpaid'), else null. */
    chip: string | null;
    /** Link text. "Receipt" is reserved for money actually collected. */
    linkLabel: 'Receipt' | 'View invoice';
}

/**
 * Display rules for a payment-history row. An open invoice is something the
 * user OWES (a failed renewal), not a payment, so it must never read as a
 * "Receipt" or show a collected amount. Display only; the server decides which
 * invoices are listed at all (`isUserVisibleInvoice` in the API).
 */
export function invoiceRowView(
    inv: Pick<InvoiceView, 'status' | 'amount_paid' | 'amount_due'>,
): InvoiceRowView {
    if (inv.status === 'paid') {
        return { paid: true, amountMinor: inv.amount_paid, chip: null, linkLabel: 'Receipt' };
    }
    const unpaid = inv.status === 'open' || inv.status === 'uncollectible';
    return {
        paid: false,
        amountMinor: inv.amount_due,
        chip: unpaid ? 'Unpaid' : inv.status,
        linkLabel: 'View invoice',
    };
}

/**
 * Format a Stripe minor-unit amount for display.
 *
 * Zero-decimal currencies (JPY, KRW, ...) are NOT multiplied by 100 by Stripe,
 * so dividing them would show "¥1.50" for a ¥150 charge. Intl already knows
 * each currency's decimal count; letting it drive the divisor keeps the two
 * consistent instead of hardcoding a list.
 */
export function formatMoney(minorUnits: number, currency: string): string {
    const cur = (currency || 'usd').toUpperCase();
    let decimals = 2;
    try {
        decimals = new Intl.NumberFormat('en', { style: 'currency', currency: cur })
            .resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
        // Unknown currency code — fall back to the 2-decimal assumption.
    }
    const value = minorUnits / Math.pow(10, decimals);
    try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(value);
    } catch {
        return `${value.toFixed(decimals)} ${cur}`;
    }
}

/**
 * Format a billing date for display, or return NULL when there isn't one.
 *
 * Deliberately returns null rather than a placeholder string. Both clients
 * previously used a local formatter that returned a sentinel ('—' on desktop,
 * 'never' on the website) and then interpolated it straight into the middle of
 * a sentence, so a null period end rendered as
 *   "You'll keep Pro until — — the period you've already paid for"
 * on desktop and the outright false
 *   "You'll keep Pro until never — the period you've already paid for"
 * on the website. A sentinel is only safe in a standalone field; mid-sentence
 * the CALLER has to pick different wording, which it can only do if it can tell
 * the date is missing. Hence null, and the sentence builders below.
 *
 * `current_period_end` is genuinely nullable on a live `active` subscription:
 * `computeEffectiveStatus` treats a missing period end as active, and Stripe
 * moved `current_period_end` off the subscription onto its items in API
 * 2025-03-31, so extraction can legitimately come up empty.
 */
export function formatBillingDate(iso: string | null | undefined, locale?: string): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    try {
        return d.toLocaleDateString(locale, { dateStyle: 'medium' });
    } catch {
        // Environments without full ICU — an ISO day is still true and readable.
        return d.toISOString().slice(0, 10);
    }
}

/** Standalone-field version: safe to drop into a table cell or a stat line. */
export function formatBillingDateOr(
    iso: string | null | undefined,
    fallback: string,
    locale?: string,
): string {
    return formatBillingDate(iso, locale) ?? fallback;
}

/**
 * The lead sentence of the cancel confirmation, built as a whole so the two
 * clients can't drift apart again and so the no-date branch stays grammatical
 * instead of splicing a placeholder between two em dashes.
 */
export function cancellationKeepProSentence(
    currentPeriodEnd: string | null | undefined,
    locale?: string,
): string {
    const when = formatBillingDate(currentPeriodEnd, locale);
    const head = when
        ? `You'll keep Pro until ${when} — the period you've already paid for — and then move to the free tier.`
        : `You'll keep Pro until the end of the period you've already paid for, and then move to the free tier.`;
    return `${head} Nothing is charged again, and you can resume any time before then. Your messages, keys and backups aren't affected.`;
}

/* ── Plan price display — tax-EXCLUSIVE ────────────────────────────────────
 * The plan is charged tax-exclusive: the Stripe Price carries
 * tax_behavior='exclusive' and Stripe Tax adds the customer's tax on top at
 * invoice time. We therefore CANNOT render a single all-in total — the total
 * depends on a tax location we may not know yet and on registrations that
 * change over time. So every price we show is the base amount plus an explicit
 * "+ tax" qualifier, and the real total is shown by Stripe itself (the Payment
 * Element's order summary, the hosted Checkout page, and the invoice/receipt).
 *
 * Showing a confident inclusive total we computed ourselves would be worse than
 * showing "+ tax": it would be wrong for most customers and it would be wrong
 * in the direction that looks like a bait-and-switch at the card screen.
 *
 * Both clients used to hardcode '$2.50/mo' in eight-plus components. getStatus
 * already returns plan_amount/plan_currency read off the live Price object;
 * these helpers are what finally turns those into one canonical label.
 */

/** Appended to every rendered plan price. Never show a total we can't compute. */
export const PLAN_TAX_SUFFIX = '+ tax';

/**
 * Label used when plan_amount/plan_currency are unavailable (billing not
 * configured, or the Stripe read failed and getPlanPrice returned nulls).
 * A fallback, not the source of truth — keep it in step with the live Price.
 */
export const FALLBACK_PLAN_PRICE_LABEL = `$2.50/mo ${PLAN_TAX_SUFFIX}`;

export interface FormatPlanPriceOptions {
    /** Period suffix: 'mo' → "$2.50/mo", 'month' → "$2.50/month", null → bare. */
    period?: 'mo' | 'month' | null;
    /** Append "+ tax". Pass false ONLY where the surrounding sentence already
     *  says tax is added on top — never to make a button read tidier. */
    tax?: boolean;
}

/**
 * The canonical plan-price label, e.g. "$2.50/mo + tax".
 *
 * Degrades to FALLBACK_PLAN_PRICE_LABEL when the amount or currency is missing,
 * so a soft Stripe failure renders a correct-today string rather than "null/mo"
 * or a blank button.
 */
export function formatPlanPrice(
    amount: number | null | undefined,
    currency: string | null | undefined,
    opts: FormatPlanPriceOptions = {},
): string {
    const { period = 'mo', tax = true } = opts;
    const base = amount == null || !currency
        ? (period ? `$2.50/${period}` : '$2.50')
        : (() => {
            const money = formatMoney(amount, currency);
            return period ? `${money}/${period}` : money;
        })();
    return tax ? `${base} ${PLAN_TAX_SUFFIX}` : base;
}

/* ── Tax location ──────────────────────────────────────────────────────────
 * Stripe Tax cannot calculate tax without a recognised customer location, and
 * creating a subscription with automatic_tax enabled against a customer that
 * has no address fails outright (customer_tax_location_invalid). The hosted
 * Checkout page collects the address itself; the in-app Payment Element flows
 * have to collect it BEFORE the subscription exists, which is what this carries.
 *
 * Deliberately the MINIMUM that makes tax calculable — country, plus a postal
 * code for countries with sub-national rates. No street address: we don't need
 * it for a rate lookup, and not storing it is the data-minimisation rule.
 */
export interface TaxLocationInput {
    /** ISO 3166-1 alpha-2, uppercase. */
    country: string;
    /** Required for countries whose rates vary below the country level. */
    postal_code?: string | null;
}

/** Countries where the country code alone can't pick a rate. */
export const POSTAL_CODE_REQUIRED_COUNTRIES = ['US', 'CA'];

/** Does this country need a postal code before Stripe Tax can compute a rate? */
export function taxPostalCodeRequired(country: string): boolean {
    return POSTAL_CODE_REQUIRED_COUNTRIES.includes((country || '').toUpperCase());
}

/**
 * The machine-readable code POST /billing/subscription-intent returns when
 * automatic tax is on and the customer has no usable tax location yet. Clients
 * switch to their tax-location step on exactly this code — never on message
 * text, which is user-facing copy and will be reworded.
 */
export const TAX_LOCATION_REQUIRED_CODE = 'tax_location_required';

/**
 * ISO 3166-1 alpha-2 codes for the country picker on the tax-location step.
 *
 * Codes only, deliberately — display names come from the platform's own
 * `Intl.DisplayNames(locale, { type: 'region' })`, so the list stays a few
 * hundred bytes, needs no translation work, and renders in the user's own
 * language instead of ours. Use `countryName()` below rather than shipping a
 * parallel English name table that would immediately drift.
 */
export const TAX_COUNTRY_CODES = [
    'AD', 'AE', 'AG', 'AL', 'AM', 'AO', 'AR', 'AT', 'AU', 'AW', 'AZ', 'BA', 'BB', 'BD', 'BE',
    'BF', 'BG', 'BH', 'BJ', 'BM', 'BO', 'BR', 'BS', 'BW', 'BY', 'BZ', 'CA', 'CD', 'CH', 'CI',
    'CL', 'CM', 'CN', 'CO', 'CR', 'CV', 'CY', 'CZ', 'DE', 'DK', 'DO', 'DZ', 'EC', 'EE', 'EG',
    'ES', 'ET', 'FI', 'FJ', 'FR', 'GA', 'GB', 'GE', 'GH', 'GR', 'GT', 'HK', 'HN', 'HR', 'HU',
    'ID', 'IE', 'IL', 'IN', 'IS', 'IT', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KR', 'KW', 'KZ',
    'LA', 'LB', 'LI', 'LK', 'LT', 'LU', 'LV', 'MA', 'MC', 'MD', 'ME', 'MG', 'MK', 'MN', 'MT',
    'MU', 'MV', 'MX', 'MY', 'MZ', 'NA', 'NG', 'NI', 'NL', 'NO', 'NP', 'NZ', 'OM', 'PA', 'PE',
    'PH', 'PK', 'PL', 'PT', 'PY', 'QA', 'RO', 'RS', 'RW', 'SA', 'SE', 'SG', 'SI', 'SK', 'SN',
    'SR', 'SV', 'TH', 'TJ', 'TN', 'TR', 'TT', 'TW', 'TZ', 'UA', 'UG', 'US', 'UY', 'UZ', 'VN',
    'ZA', 'ZM', 'ZW',
] as const;

/**
 * Localised country name for a code, falling back to the bare code when the
 * runtime has no ICU region data (a stripped Node build, an old WebView). A
 * two-letter code is still selectable and still correct, so the fallback keeps
 * the form usable rather than rendering blank options.
 */
export function countryName(code: string, locale?: string): string {
    try {
        const dn = new Intl.DisplayNames(locale ? [locale] : undefined, { type: 'region' });
        return dn.of(code.toUpperCase()) || code.toUpperCase();
    } catch {
        return code.toUpperCase();
    }
}

/** Codes paired with localised names, sorted for display. */
export function taxCountryOptions(locale?: string): { code: string; name: string }[] {
    return TAX_COUNTRY_CODES
        .map((code) => ({ code, name: countryName(code, locale) }))
        .sort((a, b) => a.name.localeCompare(b.name, locale));
}

/* ── One-step checkout (deferred intent + ConfirmationToken) ───────────────
 * The in-app checkout no longer asks for a tax location on a separate screen.
 * The Payment Element mounts straight away (Elements `mode: 'subscription'`,
 * so no PaymentIntent exists yet), collects the card AND its country/ZIP in
 * one panel, and on Pay the client:
 *
 *   1. elements.submit()
 *   2. stripe.createConfirmationToken({ elements })
 *   3. POST /billing/subscribe { confirmation_token_id }   -> SubscribeResult
 *   4. (only if the real total differs from the quoted amount) show the exact
 *      total with a Confirm button
 *   5. stripe.confirmPayment({ elements, clientSecret })
 *
 * The server reads the billing address off the ConfirmationToken, writes it to
 * the Customer so Stripe Tax has a location, and creates the subscription with
 * automatic_tax. These types are that contract.
 *
 * `POST /billing/subscription-intent` + `POST /billing/tax-location` (the old
 * two-step flow) remain on the API, DEPRECATED, for clients that predate this.
 */

/** What GET /billing/checkout-config returns: everything the client needs to
 *  mount a deferred-intent Elements BEFORE any subscription exists. */
export interface CheckoutConfig {
    publishable_key: string;
    /** Minor units; null when the plan price could not be read from Stripe
     *  (clients fall back to FALLBACK_PLAN_AMOUNT_MINOR). */
    amount: number | null;
    currency: string | null;
    /** Is the server sending automatic_tax? Informational. */
    automatic_tax: boolean;
    /** Payment-method types to allow in Elements, or null = let the Dashboard decide.
     *  Desktop gets ['card','link']: Apple/Google Pay need a browser payment
     *  sheet Electron lacks, and every redirect-based method (Amazon Pay, bank
     *  redirects) needs a top-level navigation the app's window policy denies. */
    payment_method_types: string[] | null;
}

/** What POST /billing/subscribe returns. Amounts are minor units; the TOTAL is
 *  what the PaymentIntent will actually charge. */
export interface SubscribeResult {
    client_secret: string;
    subscription_id: string;
    amount_subtotal: number;
    amount_tax: number;
    amount_total: number;
    currency: string;
}

/** Fallbacks for when the live Price can't be read; keep in step with the Price. */
export const FALLBACK_PLAN_AMOUNT_MINOR = 250;
export const FALLBACK_PLAN_CURRENCY = 'usd';

/** Payment methods the desktop (Electron) checkout may offer. */
export const DESKTOP_PAYMENT_METHOD_TYPES = ['card', 'link'] as const;

/**
 * Must the customer see and approve a different total before we charge?
 *
 * True whenever the amount the server is about to charge is not the amount we
 * quoted on the Pay button. In practice that is "tax applies here". The check is
 * on the TOTAL rather than `amount_tax > 0` so any other reason the number moved
 * (a discount, a price change mid-session) also stops for an explicit confirm
 * instead of charging something the customer was never shown.
 */
export function totalDiffersFromQuote(
    result: Pick<SubscribeResult, 'amount_total' | 'currency'>,
    quotedAmountMinor: number,
    quotedCurrency: string,
): boolean {
    return result.amount_total !== quotedAmountMinor
        || result.currency.toLowerCase() !== quotedCurrency.toLowerCase();
}

/** "$2.68/mo": the tax-INCLUSIVE total the server computed, for the Confirm step. */
export function formatConfirmedTotal(
    result: Pick<SubscribeResult, 'amount_total' | 'currency'>,
): string {
    return `${formatMoney(result.amount_total, result.currency)}/mo`;
}

/** "$2.50 + $0.18 tax": the breakdown line under the total. */
export function formatTotalBreakdown(
    result: Pick<SubscribeResult, 'amount_subtotal' | 'amount_tax' | 'currency'>,
): string {
    const base = formatMoney(result.amount_subtotal, result.currency);
    return result.amount_tax > 0
        ? `${base} + ${formatMoney(result.amount_tax, result.currency)} tax`
        : base;
}

/** Human message from an axios-style error: the API's own wording (a string, or
 *  class-validator's string[]), else the error's message, else `fallback`. */
export function apiErrorMessage(err: unknown, fallback: string): string {
    const e = err as { response?: { data?: { message?: unknown } }; message?: unknown } | null | undefined;
    const m = e?.response?.data?.message;
    if (typeof m === 'string' && m) return m;
    if (Array.isArray(m) && m.length) return m.filter((x) => typeof x === 'string').join(' ');
    if (typeof e?.message === 'string' && e.message) return e.message;
    return fallback;
}

/** The machine-readable `code` an API error carries (not its wording). */
export function apiErrorCode(err: unknown): string | null {
    const body = (err as { response?: { data?: unknown } } | null | undefined)?.response?.data;
    if (!body || typeof body !== 'object') return null;
    const b = body as { code?: unknown; message?: unknown };
    if (typeof b.code === 'string') return b.code;
    const inner = b.message;
    if (inner && typeof inner === 'object' && typeof (inner as { code?: unknown }).code === 'string') {
        return (inner as { code: string }).code;
    }
    return null;
}

/** What preparing a one-step subscription produced. */
export type PrepareOutcome =
    | { kind: 'error'; message: string; code: string | null }
    | { kind: 'ready'; result: SubscribeResult; needsConfirm: boolean };

export interface PrepareDeps {
    /** `elements.submit()` */
    submit: () => Promise<{ error?: { message?: string } | null }>;
    /** `stripe.createConfirmationToken({ elements })` */
    createToken: () => Promise<{ error?: { message?: string } | null; confirmationToken?: { id: string } | null }>;
    /** `POST /billing/subscribe` */
    subscribe: (confirmationTokenId: string) => Promise<SubscribeResult>;
}

/**
 * Steps 1-4 of the one-step checkout, shared by the desktop and website so the
 * two cannot drift: validate the form, mint the ConfirmationToken, have the
 * server build the taxed subscription, and decide whether the customer must
 * approve a different total before anything is charged.
 *
 * Deliberately stops BEFORE `confirmPayment`: the charge happens only after the
 * caller has either seen `needsConfirm === false` or the customer has clicked
 * "Confirm $X". Never throws; every failure is an `error` outcome carrying the
 * message to show inline in the payment panel.
 */
export async function prepareOneStepSubscription(
    deps: PrepareDeps,
    quote: { amount: number; currency: string },
): Promise<PrepareOutcome> {
    const submitted = await deps.submit();
    if (submitted.error) {
        return { kind: 'error', message: submitted.error.message || 'Check your payment details.', code: null };
    }
    const made = await deps.createToken();
    if (made.error || !made.confirmationToken?.id) {
        return { kind: 'error', message: made.error?.message || 'Could not read your payment details. Please try again.', code: null };
    }
    let result: SubscribeResult;
    try {
        result = await deps.subscribe(made.confirmationToken.id);
    } catch (err) {
        return { kind: 'error', message: apiErrorMessage(err, 'Could not start checkout. Please try again.'), code: apiErrorCode(err) };
    }
    if (!result?.client_secret || typeof result.amount_total !== 'number') {
        return { kind: 'error', message: 'Billing returned an unexpected response. Please try again.', code: null };
    }
    return { kind: 'ready', result, needsConfirm: totalDiffersFromQuote(result, quote.amount, quote.currency) };
}

/** Where a user goes when the in-app checkout can't load: the website account
 *  page has the same native checkout. NOT a hosted Stripe Checkout session. */
export const WEBSITE_ACCOUNT_URL = 'https://cipherline.chat/account';
