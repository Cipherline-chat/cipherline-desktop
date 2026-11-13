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
    /** Period suffix: 'mo' → "$2.50/mo", 'month' → "$2.50/month", 'yr'/'year' for a
     *  yearly plan, null → bare. */
    period?: 'mo' | 'month' | 'yr' | 'year' | null;
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
    const yearly = period === 'yr' || period === 'year';
    // Fallback only when the live Price could not be read; keep in step with it.
    const fallback = yearly ? '$30' : '$2.50';
    const base = amount == null || !currency
        ? (period ? `${fallback}/${period}` : fallback)
        : (() => {
            const money = formatMoney(amount, currency);
            return period ? `${money}/${period}` : money;
        })();
    return tax ? `${base} ${PLAN_TAX_SUFFIX}` : base;
}

/* ── Billing interval (monthly / yearly) ───────────────────────────────────
 * Owner decision 2026-11-12: Pro is sold monthly OR yearly. Founding price:
 * $2.50/mo or $30.00/yr (12 x $2.50, deliberately no discount). Regular price:
 * $4.99/mo or $49.99/yr ("2 months free"). A founder keeps the founding price
 * on EITHER interval; the lock is about being a founder, not the interval.
 *
 * The constants below are for DISPLAY COPY ONLY (the marketing pricing page and
 * fallbacks). What anyone is actually charged is read off the Stripe Price the
 * API resolves, and shown from GET /billing/checkout-config / status.
 */
export type BillingInterval = 'month' | 'year';
export const BILLING_INTERVALS: readonly BillingInterval[] = ['month', 'year'];

/** Regular yearly price, minor units ($49.99 = 2 months free vs 12 x $4.99). */
export const REGULAR_YEARLY_PRICE_MINOR = 4999;
/** Founding yearly price, minor units ($30.00 = 12 x $2.50, no discount). */
export const FOUNDER_YEARLY_PRICE_MINOR = 3000;
/** Badge for the REGULAR yearly plan only; the founding yearly plan carries none. */
export const YEARLY_SAVINGS_LABEL = '2 months free';

export function isBillingInterval(v: unknown): v is BillingInterval {
    return v === 'month' || v === 'year';
}

/** 'mo' | 'yr' (or 'month' | 'year' with long = true), for formatPlanPrice. */
export function intervalPeriod(interval: BillingInterval | null | undefined, long = false): 'mo' | 'month' | 'yr' | 'year' {
    if (interval === 'year') return long ? 'year' : 'yr';
    return long ? 'month' : 'mo';
}

/** "yearly" / "monthly". */
export function intervalAdverb(interval: BillingInterval | null | undefined): 'yearly' | 'monthly' {
    return interval === 'year' ? 'yearly' : 'monthly';
}

/** What GET /billing/status adds for the interval feature (all optional: an
 *  older API omits them, and a client then behaves as monthly-only). */
export interface PlanIntervalStatus {
    /** The interval the CURRENT plan is billed on (month when not subscribed). */
    plan_interval?: BillingInterval;
    /** Intervals this account can pick. Absent / ['month'] = yearly is not offered. */
    intervals_available?: BillingInterval[];
    /** Price (minor units) of each offered interval for THIS account. */
    plan_prices?: Partial<Record<BillingInterval, { amount: number | null; currency: string | null }>>;
    /** A switch that takes effect at the end of the paid period (yearly -> monthly). */
    pending_interval?: BillingInterval | null;
    /** ISO date the pending switch happens (the end of the paid year). */
    pending_interval_at?: string | null;
}

export function yearlyOffered(s: { intervals_available?: readonly BillingInterval[] | null } | null | undefined): boolean {
    return !!s?.intervals_available?.includes('year');
}

/** POST /billing/interval-preview: what switching would do, read-only. */
export interface IntervalChangePreview {
    interval: BillingInterval;
    /** 'now' = monthly -> yearly, charged immediately (prorated). 'period_end' = takes effect at the end of the paid year. */
    effective: 'now' | 'period_end';
    /** Amount charged today in minor units incl. tax when known; 0 for a period-end switch. null = could not be computed. */
    amount_due_now: number | null;
    currency: string | null;
    /** The recurring price of the new plan, minor units (before tax). */
    new_price: number | null;
    /** ISO date: when the switch happens (period end) or the next renewal after an immediate switch. */
    effective_at: string | null;
}

/** POST /billing/interval result. */
export interface IntervalChangeResult {
    plan_interval: BillingInterval;
    pending_interval: BillingInterval | null;
    pending_interval_at: string | null;
    current_period_end: string | null;
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
    /** Which interval `amount` is quoted for (the `interval` query; month when
     *  absent). Absent on an API that predates yearly plans. */
    interval?: BillingInterval;
    /** Intervals this account may subscribe on. Absent / ['month'] = no yearly. */
    intervals_available?: BillingInterval[];
    /** Quote for each offered interval (this account's price: founding or regular). */
    prices?: Partial<Record<BillingInterval, { amount: number | null; currency: string | null }>>;
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

/**
 * What POST /billing/checkout-preview returns. DISPLAY-ONLY: it is a read-only
 * Stripe invoice preview, and the amount actually charged comes solely from the
 * subscription the server creates in POST /billing/subscribe. `available: false`
 * means "no figure" (no usable address yet, Stripe error, already subscribed,
 * ...) and the client shows the "plus tax" copy instead; it must never block pay.
 */
export type CheckoutPreview =
    | { available: false }
    | {
        available: true;
        amount_subtotal: number;
        amount_tax: number;
        amount_total: number;
        currency: string;
    };

/** "Total today: $2.68 ($2.50 + $0.18 tax)". */
export function formatPreviewTotalLine(p: Extract<CheckoutPreview, { available: true }>): string {
    const total = formatMoney(p.amount_total, p.currency);
    if (p.amount_tax <= 0) return `Total today: ${total}`;
    return `Total today: ${total} (${formatMoney(p.amount_subtotal, p.currency)} + ${formatMoney(p.amount_tax, p.currency)} tax)`;
}

/**
 * The address a Payment Element `change` event carries, if any. Stripe only
 * includes it when a SAVED payment method (e.g. a Link card) is selected; for a
 * freshly typed card the address stays inside Stripe's iframe and this is null,
 * so the preview then simply is not requested (the exact total still appears
 * before anything is charged, on the confirm step).
 */
export function previewAddressFromChange(
    value: { payment_method?: { billing_details?: { address?: { country?: string | null; postal_code?: string | null; state?: string | null } } } } | null | undefined,
): { country: string; postal_code?: string; state?: string } | null {
    const a = value?.payment_method?.billing_details?.address;
    const country = (a?.country || '').trim();
    if (!/^[A-Za-z]{2}$/.test(country)) return null;
    return {
        country: country.toUpperCase(),
        ...(a?.postal_code ? { postal_code: a.postal_code.trim().slice(0, 16) } : {}),
        ...(a?.state ? { state: a.state.trim().slice(0, 64) } : {}),
    };
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
    interval: BillingInterval = 'month',
): string {
    return `${formatMoney(result.amount_total, result.currency)}/${intervalPeriod(interval)}`;
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

/* ── Founding-member price lock ────────────────────────────────────────────
 * "The first 10,000 subscribers keep their price for as long as they stay
 * subscribed." The API owns the rules
 * (apps/api/src/billing/founder-pricing.service.ts); these are the shapes it
 * returns and the one copy both clients render, so the wording cannot drift
 * between the desktop card and the account portal.
 *
 * The public counter is GET /v1/public/founder-pricing (no auth, cached); the
 * per-account block rides on GET /billing/status as `founder`.
 *
 * Rules the copy must stay true to: founding membership is issued when the
 * account's first real (non-zero) payment confirms and is the account's FOREVER
 * (it earns the permanent Founder badge). Neither the account's founder number
 * nor the count of spots is ever shown (owner, 2026-11-12).
 * The price LOCK is a separate, conditional thing: it lasts exactly as long as
 * the subscription. Scheduling a cancel does not end it (Resume keeps it); when
 * the subscription actually ENDS the lock is forfeited and a later subscription
 * is at the regular price. Prices are shown tax-exclusive like every other
 * price (see formatPlanPrice).
 */

/** GET /v1/public/founder-pricing - ONLY whether founding spots are open. No
 *  limit / claimed / remaining: nobody learns how many are left (owner decision
 *  2026-11-12). */
export interface FounderPricingPublic {
    open: boolean;
}

/**
 * The `founder` block on GET /billing/status. No number, position or counts,
 * ever: only whether spots are open and THIS account's membership / lock state.
 */
export interface FounderStatus extends FounderPricingPublic {
    /** This account holds a founder spot (and its Founder badge). Permanent once issued. */
    member: boolean;
    /** True when the account is a member AND its price lock is still in force
     *  (its subscription has not ended). */
    price_locked: boolean;
    /** When the lock ended (ISO), or null while it is in force / no lock.
     *  Absent on a server that predates the forfeit rule. */
    lock_ended_at?: string | null;
}

/**
 * The monthly price NEW subscribers pay once all founding spots are claimed:
 * $4.99/mo + tax (owner decision 2026-11-12). The ONE place this number lives;
 * every client and the account portal render it through
 * `regularPriceAfterFoundersLabel()` so it cannot drift.
 *
 * This is a stated FUTURE price, not a live one. Until the owner creates the
 * $4.99 Stripe Price and points STRIPE_PRICE_ID_MONTHLY at it, the standard
 * price on GET /billing/status is still the founding $2.50, so never read
 * "the regular price" off `plan_amount`: what someone will actually be charged
 * comes from the API (plan_amount), what the price rises to comes from here.
 */
export const REGULAR_PRICE_AFTER_FOUNDERS_MINOR = 499;
export const REGULAR_PRICE_AFTER_FOUNDERS_CURRENCY = 'usd';

/** "$4.99/mo + tax" (tax-exclusive, like every other price we show). */
export function regularPriceAfterFoundersLabel(opts: FormatPlanPriceOptions = {}): string {
    // A yearly period gets the regular YEARLY price ($49.99/yr), not 4.99 + "/yr".
    const yearly = opts.period === 'yr' || opts.period === 'year';
    return formatPlanPrice(
        yearly ? REGULAR_YEARLY_PRICE_MINOR : REGULAR_PRICE_AFTER_FOUNDERS_MINOR,
        REGULAR_PRICE_AFTER_FOUNDERS_CURRENCY,
        opts,
    );
}

/** What the profile badge a founding membership earns is called in every bit of copy. */
export const FOUNDER_BADGE_NAME = 'Founder badge';

/** The first-N size of the founding offer, as public marketing states it. */
const FOUNDER_LIMIT_LABEL = '10,000';

/** Is THIS account a founder whose price lock is still in force? */
export function founderLockActive(founder: FounderStatus | null | undefined): boolean {
    return !!founder
        && founder.member === true
        && founder.price_locked === true
        && !founder.lock_ended_at;
}

/** Did THIS account hold a founding lock that has since ended? */
export function founderLockEnded(founder: FounderStatus | null | undefined): boolean {
    if (!founder || founder.member !== true) return false;
    return !founderLockActive(founder);
}

/**
 * Should THIS account be offered the founding price? Only `open === true` (any
 * other value, a missing block or a failed read = no pitch), and only for an
 * account that is not a member: one that lost its lock pays the regular price.
 */
export function founderOfferApplies(founder: FounderStatus | FounderPricingPublic | null | undefined): boolean {
    if (!founder || founder.open !== true) return false;
    return (founder as FounderStatus).member !== true;
}

/**
 * The founding-status panel on the subscription page (desktop Settings →
 * Subscription and the website account portal render the same one).
 *
 *   member - lock in force: the locked price, what would end it, the badge.
 *   former - lock ended: the price is gone, the badge stays.
 *   offer  - never held one, offer open: the founding price and what it rises to.
 *   closed - never held one, offer closed: just the price this account would pay.
 *
 * No counts and no founder number, anywhere (owner, 2026-11-12).
 */
export interface FounderPanel {
    kind: 'member' | 'former' | 'offer' | 'closed';
    /** Headline, e.g. "Founding member". */
    title: string;
    /** One short line under the headline, or null. */
    subtitle: string | null;
    /** Plain-words detail lines, in display order. */
    details: string[];
    /** The Founder badge line, or null. */
    badge: string | null;
}

/** Plain words for what ends a founder's lock (and what doesn't). Kept true to
 *  FounderPricingService: it ends when the subscription actually ENDS
 *  (deleted / canceled / unpaid); a scheduled cancel and past_due do not. */
export const FOUNDER_LOCK_ENDS_SENTENCE =
    'The lock ends only if your subscription ends: when a cancellation takes effect at the end of a paid period, '
    + 'or when a renewal still can\'t be collected after every retry. Scheduling a cancel doesn\'t end it, '
    + 'and neither does a card that\'s being retried.';

export function founderPanel(
    founder: FounderStatus | null | undefined,
    plan: { amount: number | null | undefined; currency: string | null | undefined; interval?: BillingInterval | null },
    opts: { cancelScheduled?: boolean } = {},
): FounderPanel | null {
    if (!founder) return null;
    const period = intervalPeriod(plan.interval);
    const price = formatPlanPrice(plan.amount, plan.currency, { period });
    const regular = regularPriceAfterFoundersLabel({ period });
    if (founderLockActive(founder)) {
        return {
            kind: 'member',
            title: 'Founding member',
            subtitle: `${price} · locked in while you stay subscribed`,
            details: [
                opts.cancelScheduled
                    ? `Your subscription is set to end. When it does, your founding price ends with it, and it can't be claimed again. Resume before then to keep ${formatPlanPrice(plan.amount, plan.currency, { period, tax: false })}.`
                    : FOUNDER_LOCK_ENDS_SENTENCE,
                `After the first ${FOUNDER_LIMIT_LABEL} subscribers, new subscribers pay ${regular}. You don't, for as long as you stay subscribed.`,
            ],
            badge: `You have the ${FOUNDER_BADGE_NAME} on your profile. It stays yours even if the lock ever ends.`,
        };
    }
    if (founderLockEnded(founder)) {
        return {
            kind: 'former',
            title: 'Founding member',
            subtitle: 'Founding price ended',
            details: ['Your founding price ended when your last subscription did, so a new subscription is at the regular price.'],
            badge: `Your ${FOUNDER_BADGE_NAME} is yours for good.`,
        };
    }
    if (founderOfferApplies(founder)) {
        return {
            kind: 'offer',
            title: `Founding price: ${price}`,
            subtitle: 'Locked in for as long as you stay subscribed',
            details: [
                `Only the first ${FOUNDER_LIMIT_LABEL} subscribers get it. After that, Pro goes up to ${regular} for new subscribers.`,
                'If your subscription ever ends, the founding price ends with it.',
            ],
            badge: `Founding members also get the ${FOUNDER_BADGE_NAME} on their profile.`,
        };
    }
    return {
        kind: 'closed',
        title: `Pro is ${price}`,
        subtitle: null,
        details: [],
        badge: null,
    };
}

/** The big confirmation a founder with an active lock sees before cancelling. */
export interface FounderCancelPrompt {
    title: string;
    /** What cancelling costs them, in plain words. */
    warning: string;
    /** "$2.50/mo + tax": what they pay now (this account's billed price). */
    nowPrice: string;
    /** "$4.99/mo + tax": what coming back later costs (the shared constant). */
    laterPrice: string;
    /** What stays no matter what. */
    reassurance: string;
    /** Primary action: do nothing, keep the subscription (and the lock). */
    keepLabel: string;
    /** Text on the slide-to-cancel track. */
    slideLabel: string;
    /** Accessible name of the slide-to-cancel control. */
    slideAriaLabel: string;
}

/**
 * The founder-only cancel prompt, or null for anyone else (a non-founder, a
 * founder who already lost the lock, a comp) - they get the ordinary flow.
 * Shown BEFORE the cancel is sent; only a completed slide sends it. Resume
 * (undoing a scheduled cancel) keeps the lock, which the warning says.
 */
export function founderCancelPrompt(
    founder: FounderStatus | null | undefined,
    plan: { amount: number | null | undefined; currency: string | null | undefined; interval?: BillingInterval | null },
): FounderCancelPrompt | null {
    if (!founder || !founderLockActive(founder)) return null;
    const period = intervalPeriod(plan.interval);
    const now = formatPlanPrice(plan.amount, plan.currency, { period });
    const later = regularPriceAfterFoundersLabel({ period });
    return {
        title: 'Cancelling ends your founding price for good',
        warning: `Your ${now} is a founding price. It lasts only while your subscription stays active, and once it ends it can't be claimed again: `
            + `if you come back later you'll pay ${later}. `
            + `Changed your mind before your paid period runs out? Resume, and you keep your founding price.`,
        nowPrice: now,
        laterPrice: later,
        reassurance: `Your ${FOUNDER_BADGE_NAME} stays yours either way.`,
        keepLabel: 'Keep my founding price',
        slideLabel: 'Slide to cancel',
        slideAriaLabel: 'Slide to cancel and lose founding price',
    };
}

/* ── Automatic-renewal disclosure, consent, and the country gate ───────────
 *
 * One definition of the wording, shared by BOTH checkouts (website + desktop)
 * and by the API, which recomputes it to record exactly what the customer was
 * shown. U.S. automatic-renewal law (ROSCA, California ARL, New York GBL
 * 527-a) wants the material terms clear, conspicuous and next to an
 * affirmative consent, and wants proof of that consent kept. Proof is only
 * worth something if the wording it points at is unambiguous: hence one
 * canonical text, a version string, and a server-side hash.
 *
 * CHANGING ANY WORDING BELOW REQUIRES BUMPING RENEWAL_DISCLOSURE_VERSION. The
 * API spec pins the hash of the current text against the current version and
 * fails if the two drift apart, so an edit cannot silently rewrite the meaning
 * of consents that were already recorded under the old version.
 *
 * The PRICE in the text is whatever the API says this account will be billed
 * (GET /billing/checkout-config): a founder sees the founder price. Nothing
 * here hardcodes an amount.
 */

/** Bump whenever ANY user-visible wording in renewalDisclosure() changes. */
export const RENEWAL_DISCLOSURE_VERSION = 'ar-2026-11-10';

/** The default billing interval (monthly). Yearly is opt-in per consent. */
export const RENEWAL_INTERVAL: BillingInterval = 'month';

export interface RenewalDisclosureInput {
    /** Plan price in minor units (250 = $2.50). */
    priceMinor: number;
    /** ISO 4217, any case. */
    currency: string;
    /** Billing interval the price is for. Default 'month'. The monthly wording is
     *  byte-identical to what was recorded before yearly plans existed, so no
     *  version bump: only the interval word changes for 'year'. */
    interval?: BillingInterval;
}

export interface RenewalDisclosure {
    version: string;
    /** "$2.50": never includes the tax suffix; tax is stated in the sentences. */
    priceLabel: string;
    renewalLine: string;
    cancelLine: string;
    /** The checkbox label. The checkbox itself must start UNCHECKED. */
    consentLabel: string;
    /** The canonical text the API hashes: every line above, in order. */
    text: string;
}

/** en-US on purpose (not the viewer's locale): this string is HASHED, so it has
 *  to come out byte-identical on the client, on the server and in a test. */
function disclosureMoney(minor: number, currency: string): string {
    const cur = (currency || 'usd').toUpperCase();
    let decimals = 2;
    try {
        decimals = new Intl.NumberFormat('en-US', { style: 'currency', currency: cur })
            .resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
        // unknown code: 2 decimals, same as formatMoney()
    }
    const value = minor / Math.pow(10, decimals);
    try {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(value);
    } catch {
        return `${value.toFixed(decimals)} ${cur}`;
    }
}

export function renewalDisclosure(input: RenewalDisclosureInput): RenewalDisclosure {
    const price = disclosureMoney(input.priceMinor, input.currency);
    const interval: BillingInterval = input.interval === 'year' ? 'year' : RENEWAL_INTERVAL;
    const renewalLine =
        `Cipherline Pro renews automatically every ${interval} at ${price} plus any applicable tax, ` +
        `charged to the payment method you provide, until you cancel.`;
    const cancelLine =
        `Cancel any time in the desktop app (Settings → Subscription) or at cipherline.chat/account. ` +
        `Cancelling stops future charges, and you keep Pro until the end of the period you have paid for.`;
    const consentLabel =
        `I agree to these renewal terms and to the Terms of Service, and I ask for access to begin immediately.`;
    return {
        version: RENEWAL_DISCLOSURE_VERSION,
        priceLabel: price,
        renewalLine,
        cancelLine,
        consentLabel,
        text: [renewalLine, cancelLine, consentLabel].join('\n'),
    };
}

/** What a checkout sends with POST /billing/subscribe (and the deprecated
 *  subscription-intent / checkout routes). */
export interface RenewalConsentPayload {
    /** Literally true: the customer ticked the (initially unchecked) box. */
    accepted: true;
    disclosure_version: string;
    /** The price the customer was SHOWN, minor units. The server re-checks it. */
    price_minor: number;
    /** ISO 4217, lowercase. */
    currency: string;
    /** Present ONLY for a yearly consent. Omitted = monthly, so a monthly consent
     *  is byte-identical to the pre-yearly payload (an older API that rejects
     *  unknown fields keeps working). The server requires this to match the
     *  interval being subscribed, so a yearly consent cannot be replayed for a
     *  monthly subscription or vice versa. */
    interval?: 'year';
}

export function renewalConsentPayload(input: RenewalDisclosureInput): RenewalConsentPayload {
    return {
        accepted: true,
        disclosure_version: RENEWAL_DISCLOSURE_VERSION,
        price_minor: input.priceMinor,
        currency: (input.currency || 'usd').toLowerCase(),
        ...(input.interval === 'year' ? { interval: 'year' as const } : {}),
    };
}

/** The API refused because the request carried no (or a not-accepted) consent. */
export const CONSENT_REQUIRED_CODE = 'renewal_consent_required';

/** The consent names a disclosure version or price that is no longer current.
 *  The client should reload the checkout and show the customer the new terms. */
export const CONSENT_STALE_CODE = 'renewal_consent_stale';

/** Machine-readable code on the refusal when BILLING_BLOCKED_COUNTRIES lists the
 *  customer's country. Only ever returned when a NEW subscription is created. */
export const COUNTRY_BLOCKED_CODE = 'country_blocked';

/** Shown verbatim to a refused customer. */
export const COUNTRY_BLOCKED_MESSAGE =
    "Cipherline Pro isn't available in your country yet. Everything on the free plan still works.";

/** Advertised on GET /billing/status by an API that REQUIRES renewal consent.
 *  FEATURE DETECTION: an older API (strict ValidationPipe, forbidNonWhitelisted)
 *  rejects an unknown `consent` field with a 400, so a client must send the
 *  consent and show the checkbox ONLY when this is present. Absent = behave
 *  exactly as before (no field, no checkbox). */
export interface RenewalConsentSupport {
    required: true;
    /** RENEWAL_DISCLOSURE_VERSION the server accepts. */
    version: string;
    /** sha256 of the canonical text for this account's current price; null when
     *  the price could not be read. Informational. */
    text_hash: string | null;
}

/** Should the checkout show the disclosure + checkbox and send `consent`? */
export function renewalConsentAdvertised(
    status: { renewal_consent?: { required?: unknown } | null } | null | undefined,
): boolean {
    return status?.renewal_consent?.required === true;
}
