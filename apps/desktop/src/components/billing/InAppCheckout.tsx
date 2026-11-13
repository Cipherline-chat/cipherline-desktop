/**
 * InAppCheckout — the in-app, Keys-hosted Stripe Payment Element checkout.
 *
 * The whole payment lives inside the app, wrapped in motion + the Keys mascot.
 * Card data stays inside Stripe's iframe (`js.stripe.com`); we never see a PAN.
 *
 * ONE STEP. The Payment Element mounts straight away (Elements
 * `mode: 'subscription'`, a "deferred intent": no PaymentIntent exists yet) and
 * collects the card AND its country / ZIP in the same panel. On Pay:
 *
 *   1. elements.submit()
 *   2. stripe.createConfirmationToken({ elements })
 *   3. POST /v1/billing/subscribe { confirmation_token_id }
 *        — the server reads the billing address off the token, stores it on the
 *          Stripe Customer, creates the taxed incomplete subscription, and
 *          returns the PaymentIntent secret AND the exact total
 *   4. only if that total differs from the quoted price (tax applies): show
 *      "Confirm $2.68/mo" in this same panel — nothing has been charged yet
 *   5. stripe.confirmPayment({ elements, clientSecret, redirect: 'if_required' })
 *      (mandatory in Electron — never a top-level redirect)
 *
 * This replaced a flow that answered `tax_location_required` with a separate
 * country/ZIP screen before the card form ever appeared.
 *
 * Activation is then confirmed SYNCHRONOUSLY via POST /billing/activate — the
 * server asks Stripe directly rather than waiting for a webhook, which is what
 * once left a paying customer on the free tier for ~42 hours. The status poll
 * remains as a fallback for payments still settling at the bank.
 *
 * Layout: hosted in ClModal (the app's modal chrome: overlay, spring-in, focus
 * trap, Escape via useEscape). Two columns when the window allows (plan summary |
 * payment form), one column when narrow; the card is capped to the viewport so
 * nothing clips, only the form body scrolls, and Pay + the fine print live in a
 * sticky footer. See CheckoutLayout.tsx and styles/checkout.css.
 *
 * Payment methods: card + Link only, enforced client-side (checkoutPaymentMethods.ts). Apple Pay / Google Pay need a browser
 * payment sheet Electron does not have, and every redirect-based method (Amazon
 * Pay, bank redirects) needs a top-level navigation the main window refuses by
 * design (setWindowOpenHandler deny + will-navigate allow-list). The server
 * enforces the same restriction on the subscription's PaymentIntent. Those
 * wallets live on the website checkout (cipherline.chat/account).
 *
 * There is deliberately NO "continue in browser" fallback and no hosted Stripe
 * Checkout from here; if Stripe cannot load the user is pointed at the website
 * account page, which runs this same native checkout.
 *
 * Reused from both onboarding (after finalize, account+token exist) and the
 * BillingTab / expired upgrade path.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
// `/pure`, not the default entry point. Importing '@stripe/stripe-js' has a
// SIDE EFFECT: it injects <script src="https://js.stripe.com/v3"> as soon as the
// module is evaluated. This component is pulled into the boot graph by
// SubscriptionContext (a top-level provider), so the default import made every
// launch fetch Stripe.js and spawn its m-outer + m.stripe.network fraud-detection
// iframes — measured at ~198 MB RSS across two extra renderer processes, on the
// LOGIN SCREEN, for a user who may never open billing. It also meant a
// third-party beacon fired at startup for every user of a privacy-first client.
// The `/pure` entry defers the network load until loadStripe() is actually
// called, which the code below already does explicitly and awaits. Same API,
// same Elements/PaymentElement flow — nothing about the payment path changes.
// The `/pure` entry only re-exports the loader, not the types, so `Stripe` comes
// from the root package as a TYPE-ONLY import — `import type` is erased entirely
// at compile time, so it emits no require/import and therefore does NOT
// re-introduce the side-effectful script load this change exists to remove.
import { loadStripe } from '@stripe/stripe-js/pure';
import type { Stripe, StripeElementsOptions } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import axios from 'axios';
import { Lock, ShieldCheck, X, Globe, AlertTriangle, RefreshCw, Loader2 } from 'lucide-react';
import {
    FALLBACK_PLAN_AMOUNT_MINOR,
    FALLBACK_PLAN_CURRENCY,
    WEBSITE_ACCOUNT_URL,
    CONSENT_STALE_CODE,
    apiErrorMessage,
    formatConfirmedTotal,
    formatPlanPrice,
    formatPreviewTotalLine,
    previewAddressFromChange,
    formatTotalBreakdown,
    prepareOneStepSubscription,
    renewalConsentAdvertised,
    renewalConsentPayload,
    intervalPeriod,
    type BillingInterval,
    type CheckoutConfig,
    type CheckoutPreview,
    type SubscribeResult,
} from '@cipherline/shared';
import { API_BASE } from '../../constants';
import { useAuth } from '../../contexts/AuthContext';
import { openExternalLink } from '../../utils/openExternalLink';
import { ClButton } from '../ClButton';
import { ClModal } from '../cl/ClModal';
import type { KeysSignal } from '../mascot/Keys';
import { STRIPE_APPEARANCE, STRIPE_FONTS } from './stripeAppearance';
import { DESKTOP_PAYMENT_ELEMENT_OPTIONS, desktopPaymentMethodTypes } from './checkoutPaymentMethods';
import { CheckoutShell, CheckoutSummary } from './CheckoutLayout';
import { RenewalConsent } from './RenewalConsent';
import { IntervalPicker } from './IntervalPicker';
import { checkoutIntervals, quoteFor, type IntervalPrices } from './planInterval';
import { useCheckoutWide } from './useCheckoutLayout';

// Shared with the card-update modal (and available to the website) so the
// three Elements surfaces can't drift apart — see stripeAppearance.ts.
const APPEARANCE = STRIPE_APPEARANCE;
const FONTS = STRIPE_FONTS;

export interface InAppCheckoutProps {
    context: 'onboarding' | 'upgrade';
    onSuccess: () => void;
    onClose: () => void;
    /** Onboarding mounts this BEFORE login() runs, so AuthContext isn't
     *  authenticated yet — pass the freshly-issued access token here. */
    authToken?: string | null;
    /** When true, renders the checkout content inline (no fixed overlay, no card
     *  chrome) — used when the wizard hosts checkout as a full-screen step. */
    inline?: boolean;
}

/** What the Elements need to mount, resolved from GET /billing/checkout-config. */
interface Mounted {
    stripe: Promise<Stripe | null>;
    options: StripeElementsOptions;
    /** Minor units the Pay button quotes for MONTHLY (the plan price, before tax). */
    amount: number;
    currency: string;
    /** Quote per interval. `year` is present only when the API offers yearly
     *  (and quoted it); absent = no picker, monthly exactly as before. */
    prices: IntervalPrices;
    /** The API advertised that it requires renewal consent (GET /billing/status).
     *  Only then are the disclosure + checkbox shown and `consent` sent: an older
     *  API rejects the unknown field with a 400. */
    consentRequired: boolean;
}

export const InAppCheckout: React.FC<InAppCheckoutProps> = ({ context, onSuccess, onClose, authToken, inline }) => {
    const { token: ctxToken } = useAuth();
    const token = authToken ?? ctxToken;
    const [mounted, setMounted] = useState<Mounted | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    /** Bumped by "Try again" to re-run the load. */
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await axios.get<CheckoutConfig>(`${API_BASE}/billing/checkout-config`, {
                    params: { platform: 'desktop' },
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (cancelled) return;
                const cfg = res.data;
                if (!cfg?.publishable_key) throw new Error('Billing is not configured.');
                const stripeInst = await loadStripe(cfg.publishable_key);
                if (cancelled) return;
                if (!stripeInst) {
                    setLoadError('The payment system could not load.');
                    return;
                }
                const amount = cfg.amount ?? FALLBACK_PLAN_AMOUNT_MINOR;
                const currency = (cfg.currency ?? FALLBACK_PLAN_CURRENCY).toLowerCase();
                const { prices } = checkoutIntervals(cfg, { amount, currency });
                // Feature detection. Any failure = "not advertised" = today's
                // behaviour (no checkbox, no consent field).
                let consentRequired = false;
                try {
                    const st = await axios.get(`${API_BASE}/billing/status`, { headers: { Authorization: `Bearer ${token}` } });
                    consentRequired = renewalConsentAdvertised(st?.data);
                } catch { /* old API or transient: behave as before */ }
                if (cancelled) return;
                setMounted({
                    stripe: Promise.resolve(stripeInst),
                    amount,
                    currency,
                    prices,
                    consentRequired,
                    options: {
                        // Deferred intent: Elements first, subscription second.
                        mode: 'subscription',
                        amount,
                        currency,
                        // card + link on desktop (see file header), ALWAYS explicit:
                        // omitted = the Dashboard decides, which is how a "Bank"
                        // tab appeared that the server then refuses. The server's
                        // list can only narrow this, never widen it.
                        paymentMethodTypes: desktopPaymentMethodTypes(cfg.payment_method_types),
                        appearance: APPEARANCE,
                        fonts: FONTS,
                    },
                });
            } catch (err) {
                if (cancelled) return;
                setLoadError(apiErrorMessage(err, 'Could not start checkout.'));
            }
        })();
        return () => { cancelled = true; };
    }, [token, attempt]);

    // Esc must not abandon a charge that is already in flight. The X button is
    // deliberately NOT guarded (it never was, and a hung 3-D Secure frame must
    // never trap the customer); only the accidental keypress is.
    const busyRef = useRef(false);
    const onBusyChange = useCallback((b: boolean) => { busyRef.current = b; }, []);
    const requestClose = useCallback(() => { if (!busyRef.current) onClose(); }, [onClose]);

    // ClModal restores focus when `open` flips, but this component is unmounted
    // by its host instead, so hand focus back to whatever opened the checkout.
    useEffect(() => {
        if (inline) return;
        const opener = document.activeElement;
        return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
    }, [inline]);

    const content = loadError ? (
        <LoadError message={loadError} inline={inline} onRetry={() => { setLoadError(null); setMounted(null); setAttempt((n) => n + 1); }} onClose={onClose} />
    ) : mounted ? (
        <Elements stripe={mounted.stripe} options={mounted.options}>
            <CheckoutForm
                context={context} onSuccess={onSuccess} onClose={onClose} token={token}
                amount={mounted.amount} currency={mounted.currency} prices={mounted.prices} consentRequired={mounted.consentRequired}
                inline={inline} onBusyChange={onBusyChange} onEscape={inline ? undefined : requestClose}
            />
        </Elements>
    ) : (
        <LoadingView inline={inline} />
    );

    if (inline) {
        return <div className="pt-2 w-full">{content}</div>;
    }

    // ClModal supplies the app's modal chrome: the blurred overlay, the spring-in
    // card, role=dialog + aria-modal, a Tab trap, and Escape through the shared
    // escape stack (useEscape). The overlay stays above every other layer
    // (z 2100; ProWelcome's veil is 2200) and does not close on a stray click,
    // as before: a half-typed card should not vanish.
    return (
        <ClModal
            open
            onClose={requestClose}
            width={920}
            closeOnOverlay={false}
            cardClassName="ckt-card"
            overlayStyle={{ zIndex: 2100, background: 'rgba(5,8,16,0.78)', backdropFilter: 'blur(6px)' }}
            label="Upgrade to Cipherline Pro"
        >
            <button type="button" onClick={onClose} className="ckt-close" aria-label="Close">
                <X size={18} aria-hidden />
            </button>
            {content}
        </ClModal>
    );
};

/** Fallback plan price for the shells that render before the live price is known. */
const FALLBACK_PRICE_LABEL = formatPlanPrice(FALLBACK_PLAN_AMOUNT_MINOR, FALLBACK_PLAN_CURRENCY);

const LoadingView: React.FC<{ inline?: boolean }> = ({ inline }) => {
    const wide = useCheckoutWide() && !inline;
    return (
        <CheckoutShell
            wide={wide} inline={inline} title="Payment details"
            summary={<CheckoutSummary wide={wide} priceLabel={FALLBACK_PRICE_LABEL} signal="idle" bubble="Spinning up a secure line…" />}
        >
            <div className="space-y-2.5" aria-busy="true" aria-label="Loading payment form">
                {[0, 1, 2].map((i) => (
                    <div key={i} className="h-11 rounded-xl" style={{ background: 'linear-gradient(90deg, var(--cl-surface) 25%, var(--cl-raise) 50%, var(--cl-surface) 75%)', backgroundSize: '200% 100%', animation: 'shimmer 1.4s linear infinite' }} />
                ))}
            </div>
        </CheckoutShell>
    );
};

/**
 * Checkout could not open (Stripe.js blocked/offline, billing not configured,
 * the API down). Offers a retry and the WEBSITE account page, which runs the
 * same native checkout. It does NOT offer a hosted Stripe Checkout session:
 * that path was removed on purpose.
 */
const LoadError: React.FC<{ message: string; inline?: boolean; onRetry: () => void; onClose: () => void }> = ({ message, inline, onRetry, onClose }) => {
    const wide = useCheckoutWide() && !inline;
    return (
        <CheckoutShell
            wide={wide} inline={inline} title="Payment details"
            summary={<CheckoutSummary wide={wide} priceLabel={FALLBACK_PRICE_LABEL} signal="alert" bubble="Hmm — couldn’t open the till." announceBubble={false} />}
            footer={
                <div className="space-y-2.5">
                    <ClButton fullWidth onClick={onRetry}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><RefreshCw size={16} /> Try again</span>
                    </ClButton>
                    <ClButton variant="ghost" fullWidth onClick={() => { openExternalLink(WEBSITE_ACCOUNT_URL); }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Globe size={16} /> Open cipherline.chat/account</span>
                    </ClButton>
                    <ClButton variant="ghost" fullWidth onClick={onClose}>Not now</ClButton>
                </div>
            }
        >
            <div data-testid="checkout-load-error" role="alert">
                <div className="text-sm text-cl-text mb-2">{message}</div>
                <div className="text-xs text-cl-muted">
                    Check your connection and try again, or subscribe from your account page on the website.
                </div>
            </div>
        </CheckoutShell>
    );
};

/* ── The actual form (inside <Elements>) ── */
type Phase = 'ready' | 'preparing' | 'confirm' | 'processing' | 'error' | 'activating' | 'pending' | 'success';

/** How long to wait for webhook-driven activation before saying so plainly.
 *  This form used to jump straight from a confirmed PaymentIntent to the
 *  success celebration, having never asked the server whether the account was
 *  actually upgraded — so a charge whose activation webhook never verified
 *  played confetti over a free-tier account. The API self-heals from Stripe on
 *  a status read, so the opening poll almost always settles it. */
const ACTIVATION_TIMEOUT_MS = 45_000;
const ACTIVATION_POLL_MS = 2_000;
const SUPPORT_EMAIL = 'hello@cipherline.chat';

const CheckoutForm: React.FC<{
    context: 'onboarding' | 'upgrade';
    onSuccess: () => void;
    onClose: () => void;
    token: string | null;
    amount: number;
    currency: string;
    prices: IntervalPrices;
    consentRequired: boolean;
    inline?: boolean;
    /** Tells the host a charge is in flight (so a stray Esc can't abandon it). */
    onBusyChange?: (busy: boolean) => void;
    /** Stripe's iframe swallows keydown, so it reports Escape through this. */
    onEscape?: () => void;
}> = ({ onSuccess, onClose, token, amount: monthlyAmount, currency: monthlyCurrency, prices, consentRequired, inline, onBusyChange, onEscape }) => {
    const stripe = useStripe();
    const elements = useElements();
    const reduced = useReducedMotion();
    const wide = useCheckoutWide() && !inline;
    /** Monthly unless the customer picks yearly (the picker exists only when the API offers it). */
    const [interval, setIntervalState] = useState<BillingInterval>('month');
    const yearlyAvailable = !!prices.year;
    // The quote for the chosen interval: everything below (Pay label, consent
    // text + payload, tax preview, confirm total) follows it.
    const { amount, currency } = interval === 'year' ? quoteFor('year', prices) : { amount: monthlyAmount, currency: monthlyCurrency };
    /** Display-only tax preview (POST /billing/checkout-preview). null = none
     *  yet / unavailable, and the "plus tax" wording stays. NEVER gates payment. */
    const [preview, setPreview] = useState<Extract<CheckoutPreview, { available: true }> | null>(null);
    const previewKey = useRef('');
    /** What the customer has been shown: the previewed total when there is one,
     *  else the base price. The server-computed total is still compared against
     *  this before charging, so a stale preview only costs a confirm step. */
    const quoteAmount = preview ? preview.amount_total : amount;
    /** "$2.50/mo + tax" until a real total is known, then "$2.68/mo". */
    const period = intervalPeriod(interval);
    const priceLabel = useMemo(
        () => (preview ? formatPlanPrice(preview.amount_total, preview.currency, { period, tax: false }) : formatPlanPrice(amount, currency, { period })),
        [preview, amount, currency, period],
    );
    // "Everything unlocks the moment this goes through." is no longer one of the
    // rotating lines: it is a fixed line in the summary (CheckoutSummary).
    const readyBubbles = useMemo(() => [
        'Less than a mid-tier fountain drink.',
        'Your card never touches our servers. Promise.',
    ], []);
    const [phase, setPhase] = useState<Phase>('ready');
    /** The auto-renewal consent box. Starts UNCHECKED, always: Pay stays disabled
     *  until it is ticked. (The server refuses a subscription without it too.) */
    const [consented, setConsented] = useState(false);
    const [elementReady, setElementReady] = useState(false);
    const [complete, setComplete] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [bubbleIdx, setBubbleIdx] = useState(0);
    const [focused, setFocused] = useState(false);
    const [recheckBusy, setRecheckBusy] = useState(false);
    /** The server's taxed quote, held while the customer decides to confirm. */
    const [prepared, setPrepared] = useState<SubscribeResult | null>(null);
    // PaymentIntent 'processing' — accepted but not yet settled (bank debit).
    // Nothing is wrong and there is nothing to retry, so it earns its own copy.
    const [settling, setSettling] = useState(false);
    const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (pollTimer.current) clearTimeout(pollTimer.current); }, []);

    const authHeaders = useMemo(() => (token ? { Authorization: `Bearer ${token}` } : undefined), [token]);

    /** Ask for a tax preview. Failure of any kind leaves the "plus tax" copy. */
    const lastAddress = useRef<{ country: string; postal_code?: string; state?: string } | null>(null);
    const requestPreview = useCallback(async (address?: { country: string; postal_code?: string; state?: string } | null) => {
        if (address) lastAddress.current = address;
        const addr = address ?? lastAddress.current;
        const key = JSON.stringify([addr ?? null, interval]);
        if (previewKey.current === key) return;
        previewKey.current = key;
        try {
            const res = await axios.post<CheckoutPreview>(
                `${API_BASE}/billing/checkout-preview`,
                // `interval` only for yearly: a monthly request is byte-identical to before.
                { platform: 'desktop', ...(interval === 'year' ? { interval } : {}), ...(addr ?? {}) },
                { headers: authHeaders },
            );
            if (previewKey.current !== key) return; // the customer switched interval meanwhile
            setPreview(res.data?.available === true && typeof res.data.amount_total === 'number' ? res.data : null);
        } catch {
            if (previewKey.current === key) setPreview(null); // display-only: fall back to "plus tax"
        }
    }, [authHeaders, interval]);
    // On open and on every interval change: a returning customer's address on
    // file may already price it, and a yearly total is a different number.
    useEffect(() => { void requestPreview(null); }, [requestPreview]);

    /** Monthly <-> yearly. A consent is per interval: it is cleared, the
     *  preview and any prepared quote are dropped, and Stripe's Elements are
     *  told the new amount. */
    const chooseInterval = useCallback((next: BillingInterval) => {
        if (next === interval || (next === 'year' && !yearlyAvailable) || phase === 'preparing' || phase === 'processing') return;
        setIntervalState(next);
        setConsented(false);
        setPreview(null);
        setPrepared(null);
        setPhase((p) => (p === 'confirm' || p === 'error' ? 'ready' : p));
        setErrorMsg(null);
        const q = next === 'year' ? quoteFor('year', prices) : { amount: monthlyAmount, currency: monthlyCurrency };
        elements?.update({ amount: q.amount });
    }, [interval, yearlyAvailable, phase, prices, monthlyAmount, monthlyCurrency, elements]);

    /** True once the server agrees the subscription is live. */
    const isActivated = useCallback(async (): Promise<boolean> => {
        try {
            const res = await axios.get(`${API_BASE}/billing/status`, { headers: authHeaders });
            return res.data?.subscription_status === 'active';
        } catch {
            return false; // transient — the caller decides whether to keep waiting
        }
    }, [authHeaders]);

    /**
     * Ask the server to activate NOW, then fall back to polling.
     *
     * Activation used to be webhook-only: this loop just polled and hoped one
     * arrived. When a delivery took ~42 hours, the first real payer sat on the
     * free tier having paid. `POST /billing/activate` makes the server ask
     * Stripe directly and apply the answer, so the normal case is one round
     * trip and done — the webhook becomes a confirmation rather than the only
     * route. The poll stays as the fallback for the genuinely slow cases
     * (a 'processing' payment that hasn't settled at the bank yet).
     */
    const awaitActivation = useCallback(() => {
        setPhase('activating');
        const started = Date.now();

        const poll = async () => {
            if (await isActivated()) { setPhase('success'); return; }
            if (Date.now() - started > ACTIVATION_TIMEOUT_MS) { setPhase('pending'); return; }
            pollTimer.current = setTimeout(() => { void poll(); }, ACTIVATION_POLL_MS);
        };

        void (async () => {
            try {
                const res = await axios.post(`${API_BASE}/billing/activate`, {}, { headers: authHeaders });
                if (res.data?.subscription_status === 'active') { setPhase('success'); return; }
            } catch {
                // Never fatal — the money is already taken and Stripe confirmed
                // it. Fall through to the poll exactly as before.
            }
            void poll();
        })();
    }, [isActivated, authHeaders]);

    const recheck = useCallback(async () => {
        setRecheckBusy(true);
        const ok = await isActivated();
        setRecheckBusy(false);
        if (ok) setPhase('success');
    }, [isActivated]);

    // Rotate the encouraging line every few seconds while idle on the form.
    useEffect(() => {
        if (phase !== 'ready' || reduced) return;
        const t = setInterval(() => setBubbleIdx((i) => (i + 1) % readyBubbles.length), 4200);
        return () => clearInterval(t);
    }, [phase, reduced, readyBubbles.length]);

    // On success, hand off at once: the celebration is ProWelcome, a full-screen
    // layer of its own that SubscriptionContext raises over this modal. (This
    // used to play a second, smaller confetti celebration in here first and
    // then race the context's status poll into ProWelcome as well.)
    // Exactly once: hosts pass an inline onSuccess, so a re-render hands this
    // effect a new function while the phase is still 'success'.
    const handedOff = useRef(false);
    useEffect(() => {
        if (phase !== 'success' || handedOff.current) return;
        handedOff.current = true;
        onSuccess();
    }, [phase, onSuccess]);

    /** Step 5: charge. Only ever reached with a total the customer has seen. */
    const charge = useCallback(async (quote: SubscribeResult) => {
        if (!stripe || !elements) return;
        setPhase('processing');
        setErrorMsg(null);
        const { error, paymentIntent } = await stripe.confirmPayment({
            elements,
            clientSecret: quote.client_secret,
            // CRITICAL in Electron: never top-level-redirect. Card + 3DS resolve in
            // Stripe's iframe; if_required keeps us in-app.
            redirect: 'if_required',
        });
        if (error) {
            setErrorMsg(friendlyError(error.message));
            setPhase('error');
            return;
        }
        if (paymentIntent && (paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing')) {
            // Confirmed by Stripe — but NOT yet by us. Celebrating here without
            // asking the server is what showed a paying customer a success
            // screen on an account that was still on the free tier.
            setSettling(paymentIntent.status === 'processing');
            awaitActivation();
        } else {
            setErrorMsg('Payment did not complete. Please try again.');
            setPhase('error');
        }
    }, [stripe, elements, awaitActivation]);

    /** Steps 1–4: validate, tokenise, let the server tax it, then charge or ask. */
    const submit = useCallback(async () => {
        if (!stripe || !elements || (consentRequired && !consented) || phase === 'preparing' || phase === 'processing') return;
        setPhase('preparing');
        setErrorMsg(null);
        const out = await prepareOneStepSubscription({
            submit: () => elements.submit(),
            createToken: () => stripe.createConfirmationToken({ elements }),
            subscribe: async (id) => (await axios.post<SubscribeResult>(
                `${API_BASE}/billing/subscribe`,
                {
                    confirmation_token_id: id,
                    platform: 'desktop',
                    // The terms exactly as shown above the button: the price the
                    // API quoted this account (founder price included).
                    // Only when the API advertised it; an older API 400s on it.
                    // The consent interval must match the subscribe interval (the
                    // server refuses a mismatch as renewal_consent_stale).
                    ...(interval === 'year' ? { interval } : {}),
                    ...(consentRequired ? { consent: renewalConsentPayload({ priceMinor: amount, currency, interval }) } : {}),
                },
                { headers: authHeaders },
            )).data,
        }, { amount: quoteAmount, currency: preview ? preview.currency : currency });

        if (out.kind === 'error') {
            // Inline, in the payment panel — a missing country is fixed where
            // the country field is, not on a new screen.
            // Raw message: it is either Stripe's own field validation or the
            // API's wording (e.g. "Enter your country and ZIP..."), both already
            // user-facing. friendlyError only knows card-decline strings.
            if (out.code === CONSENT_STALE_CODE) {
                // The price or wording moved while this was open. Make the
                // customer look again rather than re-sending a consent to
                // terms they can no longer see.
                setConsented(false);
                setErrorMsg('The price or terms changed. Please close and reopen checkout to review them.');
            } else {
                setErrorMsg(out.message);
            }
            setPhase('error');
            return;
        }
        setPrepared(out.result);
        if (out.needsConfirm) {
            // Tax applies: nothing is charged until the customer clicks Confirm.
            setPhase('confirm');
            return;
        }
        await charge(out.result);
    }, [stripe, elements, consented, consentRequired, phase, authHeaders, amount, currency, interval, quoteAmount, preview, charge]);

    /** Confirm click on the tax step. */
    const confirmTotal = useCallback(async () => {
        if (!prepared || !elements) return;
        // The Payment Element was locked while the total was on screen; ask it
        // to re-validate before confirming, as Stripe's deferred flow requires.
        const { error } = await elements.submit();
        if (error) {
            setErrorMsg(friendlyError(error.message));
            setPhase('error');
            return;
        }
        await charge(prepared);
    }, [prepared, elements, charge]);

    const busy = phase === 'preparing' || phase === 'processing';
    // From the moment the card is submitted until Pro is confirmed, a stray Esc
    // must not unmount the form under an in-flight charge.
    const holding = busy || phase === 'activating';
    useEffect(() => {
        onBusyChange?.(holding);
        return () => onBusyChange?.(false);
    }, [holding, onBusyChange]);

    /** Focus the card field once Stripe is ready, unless the customer has
     *  already put focus somewhere real (the dialog's own first focusable is the
     *  Close button, which is not "somewhere real"). */
    const focusWhenIdle = useCallback((el?: { focus?: () => void }) => {
        const a = document.activeElement;
        if (!a || a === document.body || (a instanceof HTMLElement && a.classList.contains('ckt-close'))) el?.focus?.();
    }, []);

    const formPhase = phase === 'ready' || phase === 'preparing' || phase === 'confirm' || phase === 'processing' || phase === 'error';
    const keysSignal: KeysSignal =
        phase === 'activating' ? 'pulse'
        : phase === 'pending' ? 'alert'
        : busy ? 'pulse' : phase === 'error' ? 'alert' : focused ? 'pulse' : 'idle';
    const bubble =
        phase === 'success' ? 'That’s it, you’re Pro!'
        : phase === 'activating' ? 'Payment received — unlocking your account…'
        : phase === 'pending' ? 'Payment received — Pro hasn’t switched on yet.'
        : phase === 'preparing' ? 'Working out your total…'
        : phase === 'processing' ? 'Charging up the encryption core…'
        : phase === 'confirm' ? 'Here’s your exact total.'
        : phase === 'error' ? (errorMsg || 'That card got shy — try another?')
        : focused ? 'Looking good. Whenever you’re ready.'
        : readyBubbles[bubbleIdx % readyBubbles.length];
    const summary = (
        <CheckoutSummary
            wide={wide}
            priceLabel={priceLabel}
            interval={interval}
            intervalPicker={yearlyAvailable ? (
                <IntervalPicker prices={prices} value={interval} onChange={chooseInterval} disabled={busy || phase === 'activating'} />
            ) : undefined}
            total={phase === 'ready' ? null : prepared}
            signal={keysSignal}
            bubble={bubble}
            // The inline alert in the footer already announces a failure.
            announceBubble={phase !== 'error'}
        />
    );

    if (!formPhase) {
        // success / activating / pending: the same shell, a status in the panel.
        return (
            <CheckoutShell
                wide={wide} inline={inline} title="Payment received" summary={summary}
                footer={phase === 'pending' ? (
                    <div className="space-y-2.5">
                        <ClButton fullWidth loading={recheckBusy} onClick={() => { void recheck(); }}>
                            Check again
                        </ClButton>
                        <ClButton variant="ghost" fullWidth onClick={onClose}>Close</ClButton>
                    </div>
                ) : undefined}
            >
                {phase === 'pending' ? (
                    <div>
                        <div className="text-sm text-cl-text mb-3">
                            {settling
                                ? 'Your bank is still clearing this payment. Pro switches on by itself once it settles — don’t pay again.'
                                : 'That’s on our side, not your card. It unlocks by itself, usually within a few minutes.'}
                        </div>
                        <div className="text-xs text-cl-muted">
                            Still locked after an hour? Email {SUPPORT_EMAIL} — your payment is safe and we’ll finish it by hand.
                        </div>
                    </div>
                ) : (
                    <div className="text-sm text-cl-text flex items-center gap-2" role="status">
                        {phase === 'activating' && <Loader2 size={16} className="animate-spin" aria-hidden />}
                        {phase === 'activating' ? 'Just a moment while we switch Pro on.' : 'You’re all set.'}
                    </div>
                )}
            </CheckoutShell>
        );
    }

    const footer = (
        <>
            {phase === 'error' && errorMsg && (
                <motion.div
                    className="text-[13px] mb-3 flex items-start gap-1.5"
                    style={{ color: 'var(--cl-flash)' }}
                    role="alert"
                    initial={{ opacity: 0, x: reduced ? 0 : -6 }} animate={{ opacity: 1, x: 0 }}
                >
                    <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0 }} /> {errorMsg}
                </motion.div>
            )}

            {/* Lume energy meter while charging */}
            {busy && (
                <div className="h-2 rounded-full overflow-hidden mb-3" style={{ background: 'var(--cl-surface)' }}>
                    <motion.div
                        className="h-full rounded-full"
                        style={{ background: 'linear-gradient(90deg, var(--cl-lume-deep), var(--cl-lume))', boxShadow: '0 0 12px rgba(37,224,200,0.6)' }}
                        initial={{ width: '8%' }}
                        animate={{ width: ['8%', '70%', '92%'] }}
                        transition={{ duration: 2.4, ease: 'easeInOut' }}
                    />
                </div>
            )}

            {/* Auto-renewal disclosure + consent, directly above the button it
                governs (body-size text, box starts unchecked). Also covers the
                Terms §7.7 immediate-performance acknowledgment, which therefore
                still sits adjacent to the pay button. Stays on screen (locked)
                through the tax-confirm step. */}
            {consentRequired ? (
                <RenewalConsent
                    amount={amount} currency={currency} interval={interval}
                    checked={consented} onChange={setConsented}
                    disabled={busy || phase === 'confirm'}
                />
            ) : null}

            {preview && phase !== 'confirm' && (
                <p className="text-[13.5px] font-bold text-cl-text text-center mb-2.5" data-testid="total-today">
                    {formatPreviewTotalLine(preview)}
                </p>
            )}

            {phase === 'confirm' && prepared ? (
                /* Only shown when the real total differs from the quote (tax). */
                <div data-testid="tax-confirm">
                    <div className="rounded-2xl px-4 py-2 mb-3 flex items-center justify-between gap-3" style={{ background: 'var(--cl-surface)' }}>
                        <div>
                            <div className="text-[11px] uppercase tracking-wide text-cl-muted">Your total</div>
                            <div className="text-[12px] text-cl-muted" data-testid="tax-confirm-breakdown">{formatTotalBreakdown(prepared)}</div>
                        </div>
                        <div className="text-2xl font-extrabold text-cl-text" data-testid="tax-confirm-total">{formatConfirmedTotal(prepared, interval)}</div>
                    </div>
                    <ClButton fullWidth size="lg" onClick={() => { void confirmTotal(); }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            <Lock size={16} /> Confirm {formatConfirmedTotal(prepared, interval)}
                        </span>
                    </ClButton>
                    <div className="mt-2">
                        <ClButton variant="ghost" size="sm" fullWidth onClick={() => { setPhase('ready'); setPrepared(null); }}>
                            Back
                        </ClButton>
                    </div>
                </div>
            ) : (
                <ClButton
                    fullWidth
                    size="lg"
                    onClick={() => { void submit(); }}
                    disabled={!stripe || !elementReady || (consentRequired && !consented) || (!complete && phase === 'ready')}
                    loading={busy}
                >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <Lock size={16} /> {phase === 'error' ? 'Try again' : `Pay ${priceLabel}`}
                    </span>
                </ClButton>
            )}

            {!consentRequired && (
                /* Older API (no consent support): the pre-consent fine print, unchanged. */
                <>
                    <p className="ckt-fine">
                        Recurring subscription — your payment method is charged {interval === 'year' ? `${formatPlanPrice(amount, currency, { period: 'year', tax: false })}` : '$2.50/month'} plus any
                        applicable tax, and renews automatically until you cancel. Cancel anytime in
                        Settings → Billing.
                    </p>
                    <p className="ckt-fine" style={{ marginTop: 4 }}>
                        By subscribing you agree to the Terms of Service and ask for access to begin
                        immediately.
                    </p>
                </>
            )}

            <div className="ckt-secured">
                <ShieldCheck size={12} aria-hidden /> Secured by Stripe · cancel anytime
            </div>

            {/* Apple Pay / Google Pay need a browser payment sheet Electron lacks
                (see checkoutPaymentMethods.ts); point wallet users at the website. */}
            <p className="ckt-wallet-hint" data-testid="wallet-hint">
                Prefer Apple Pay or Google Pay?{' '}
                <button type="button" className="ckt-wallet-link" onClick={() => { openExternalLink(WEBSITE_ACCOUNT_URL); }}>
                    Subscribe at cipherline.chat
                </button>
            </p>
        </>
    );

    return (
        <CheckoutShell wide={wide} inline={inline} title="Payment details" summary={summary} footer={footer}>
            {/* The form stays MOUNTED (and is not disabled by Stripe) through the
                tax-confirm step; it is only locked against edits, so Back returns
                to exactly what the customer typed and confirmPayment still has its
                Elements. */}
            <div style={{ opacity: busy || phase === 'confirm' ? 0.55 : 1, pointerEvents: busy || phase === 'confirm' ? 'none' : 'auto', transition: 'opacity 0.2s' }}>
                <PaymentElement
                    options={DESKTOP_PAYMENT_ELEMENT_OPTIONS}
                    onReady={(el) => { setElementReady(true); focusWhenIdle(el); }}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    onChange={(e) => {
                        setComplete(e.complete);
                        const addr = previewAddressFromChange(e.value as Parameters<typeof previewAddressFromChange>[0]);
                        if (addr) void requestPreview(addr);
                    }}
                    onEscape={onEscape}
                />
            </div>
        </CheckoutShell>
    );
};

function friendlyError(msg?: string): string {
    if (!msg) return 'That card got shy — try another?';
    if (/declin/i.test(msg)) return 'Your card was declined — try another card?';
    if (/expired/i.test(msg)) return 'That card looks expired — try another?';
    if (/insufficient/i.test(msg)) return 'Insufficient funds — try a different card?';
    return msg;
}

export default InAppCheckout;
