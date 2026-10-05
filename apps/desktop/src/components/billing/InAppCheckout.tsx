/**
 * InAppCheckout — the in-app, Keys-hosted Stripe Payment Element checkout.
 *
 * Replaces the old "open hosted Checkout in the system browser" flow so the whole
 * payment lives inside the app, wrapped in motion + the Keys mascot. Card data
 * stays inside Stripe's iframe (`js.stripe.com`); we never see a PAN.
 *
 * Flow: POST /v1/billing/subscription-intent → loadStripe(pk) → <Elements> with a
 * "glow in the deep" appearance → <PaymentElement> → confirmPayment({ redirect:
 * 'if_required' }) (mandatory in Electron — no top-level redirect). Activation is
 * then confirmed SYNCHRONOUSLY via POST /billing/activate — the server asks
 * Stripe directly rather than waiting for a webhook, which is what once left a
 * paying customer on the free tier for ~42 hours. The status poll remains as a
 * fallback for payments still settling at the bank.
 *
 * Reused from both onboarding (after finalize, account+token exist) and the
 * BillingTab / expired upgrade path.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
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
import type { Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import axios from 'axios';
import { Lock, ShieldCheck, X, Crown, Sparkles, Globe, AlertTriangle } from 'lucide-react';
import {
    FALLBACK_PLAN_PRICE_LABEL,
    TAX_LOCATION_REQUIRED_CODE,
    taxCountryOptions,
    taxPostalCodeRequired,
} from '@cipherline/shared';
import { API_BASE } from '../../constants';
import { useAuth } from '../../contexts/AuthContext';
import { ClButton } from '../ClButton';
import { Keys, type KeysSignal } from '../mascot/Keys';
import { STRIPE_APPEARANCE, STRIPE_FONTS } from './stripeAppearance';

/**
 * The plan price, as the user sees it. Tax-EXCLUSIVE: Stripe Tax adds the
 * customer's tax on top at invoice time, so we cannot render an all-in total
 * here and must not pretend to. The Payment Element's own order summary shows
 * the real total once Stripe knows the tax location.
 *
 * Resolved from the live Price via GET /billing/status where available; this
 * module-level constant is the fallback for the pre-status render.
 */
const PRICE_LABEL = FALLBACK_PLAN_PRICE_LABEL;

// Shared with the card-update modal (and available to the website) so the
// three Elements surfaces can't drift apart — see stripeAppearance.ts.
const APPEARANCE = STRIPE_APPEARANCE;
const FONTS = STRIPE_FONTS;

const COLORS = ['#25E0C8', '#5e8ee0', '#FFC94D', '#4ADE80', '#FF8FB1'];

export interface InAppCheckoutProps {
    context: 'onboarding' | 'upgrade';
    onSuccess: () => void;
    onClose: () => void;
    onFallback?: () => void;
    /** Onboarding mounts this BEFORE login() runs, so AuthContext isn't
     *  authenticated yet — pass the freshly-issued access token here. */
    authToken?: string | null;
    /** When true, renders the checkout content inline (no fixed overlay, no card
     *  chrome) — used when the wizard hosts checkout as a full-screen step. */
    inline?: boolean;
}

export const InAppCheckout: React.FC<InAppCheckoutProps> = ({ context, onSuccess, onClose, onFallback, authToken, inline }) => {
    const { token: ctxToken } = useAuth();
    const token = authToken ?? ctxToken;
    const [clientSecret, setClientSecret] = useState<string | null>(null);
    const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    /** Set when the API says it needs a tax location before it can create the
     *  subscription. Incremented (rather than cleared) to re-run the intent
     *  fetch after the step is submitted. */
    const [needTaxLocation, setNeedTaxLocation] = useState(false);
    const [intentAttempt, setIntentAttempt] = useState(0);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await axios.post(`${API_BASE}/billing/subscription-intent`, {}, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (cancelled) return;
                const { client_secret, publishable_key } = res.data || {};
                if (!client_secret || !publishable_key) throw new Error('Billing is not configured.');
                const stripeInst = await loadStripe(publishable_key);
                if (cancelled) return;
                if (!stripeInst) {
                    setLoadError('Payment system could not load. Continue in your browser instead.');
                    return;
                }
                setNeedTaxLocation(false);
                setClientSecret(client_secret);
                setStripePromise(Promise.resolve(stripeInst));
            } catch (err) {
                if (cancelled) return;
                // Stripe Tax needs a jurisdiction before the subscription (and
                // therefore its first invoice) can be created at all, so this is
                // a step in the flow rather than an error. Match on the CODE, not
                // the message — the message is user-facing copy.
                if (isTaxLocationRequired(err)) { setNeedTaxLocation(true); return; }
                setLoadError(errMsg(err) || 'Could not start checkout.');
            }
        })();
        return () => { cancelled = true; };
    }, [token, intentAttempt]);

    const options = useMemo(
        () => (clientSecret ? { clientSecret, appearance: APPEARANCE, fonts: FONTS } : null),
        [clientSecret],
    );

    const content = loadError ? (
        <IntentError message={loadError} onFallback={onFallback} onClose={onClose} />
    ) : needTaxLocation ? (
        <TaxLocationStep
            token={token}
            onDone={() => setIntentAttempt((n) => n + 1)}
            onFallback={onFallback}
        />
    ) : options && stripePromise ? (
        <Elements stripe={stripePromise} options={options}>
            <CheckoutForm context={context} onSuccess={onSuccess} onClose={onClose} onFallback={onFallback} token={token} />
        </Elements>
    ) : (
        <LoadingView />
    );

    if (inline) {
        return <div className="pt-2 w-full">{content}</div>;
    }

    return (
        <motion.div
            className="fixed inset-0 flex items-center justify-center px-6"
            style={{ zIndex: 2100, background: 'rgba(5,8,16,0.78)', backdropFilter: 'blur(6px)' }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        >
            <motion.div
                className="relative rounded-3xl px-7 py-8"
                style={{ background: 'var(--cl-deep)', border: '1px solid rgba(37,224,200,0.18)', maxWidth: 440, width: '100%', boxShadow: '0 24px 70px rgba(0,0,0,0.65)' }}
                initial={{ scale: 0.85, y: 28, opacity: 0 }}
                animate={{ scale: 1, y: 0, opacity: 1, transition: { type: 'spring', stiffness: 220, damping: 20 } }}
            >
                <button onClick={onClose} className="absolute top-3.5 right-3.5 text-cl-faint hover:text-cl-text transition-colors" aria-label="Close" style={{ zIndex: 5 }}>
                    <X size={18} />
                </button>
                {content}
            </motion.div>
        </motion.div>
    );
};

/* ── Shared header: Keys + a speech bubble ── */
/* size 80 ≈ the old 64px square mark — Keys' wider viewBox pads the sides,
   so the visible body stays the same width. Display-only: the checkout owns
   the bubble, so pokes/speech stay off. */
const KeysHeader: React.FC<{ signal: KeysSignal; bubble: string }> = ({ signal, bubble }) => (
    <div className="flex flex-col items-center text-center mb-5">
        <Keys size={80} signal={signal} interactive={false} waveOnMount={false} />
        <AnimatePresence mode="wait">
            <motion.div
                key={bubble}
                className="mt-2 px-3.5 py-1.5 rounded-2xl text-[13px] font-semibold"
                style={{ background: 'var(--cl-surface)', color: 'var(--cl-text)', maxWidth: 300 }}
                initial={{ opacity: 0, y: 6, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.96 }}
                transition={{ type: 'spring', stiffness: 320, damping: 22 }}
            >
                {bubble}
            </motion.div>
        </AnimatePresence>
    </div>
);

const LoadingView: React.FC = () => (
    <div className="pt-3">
        <KeysHeader signal="idle" bubble="Spinning up a secure line…" />
        <div className="space-y-2.5">
            {[0, 1, 2].map((i) => (
                <div key={i} className="h-11 rounded-xl" style={{ background: 'linear-gradient(90deg, var(--cl-surface) 25%, var(--cl-raise) 50%, var(--cl-surface) 75%)', backgroundSize: '200% 100%', animation: 'shimmer 1.4s linear infinite' }} />
            ))}
        </div>
    </div>
);

const IntentError: React.FC<{ message: string; onFallback?: () => void; onClose: () => void }> = ({ message, onFallback, onClose }) => (
    <div className="pt-3 text-center">
        <KeysHeader signal="alert" bubble="Hmm — couldn’t open the till." />
        <p className="text-sm text-cl-muted mb-6" style={{ maxWidth: 320, marginInline: 'auto' }}>{message}</p>
        <div className="space-y-2.5">
            {onFallback && (
                <ClButton fullWidth onClick={onFallback}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Globe size={16} /> Continue in browser</span>
                </ClButton>
            )}
            <ClButton variant="ghost" fullWidth onClick={onClose}>Not now</ClButton>
        </div>
    </div>
);

/**
 * Did the API ask for a tax location?
 *
 * Keyed on the machine-readable code the service sends inside the 400 body, so
 * rewording the user-facing message can never silently turn this step into a
 * hard error. Tolerates both `{ code }` and Nest's `{ message: { code } }`
 * envelope shapes, because a BadRequestException given an object puts it in
 * `message` on some Nest versions and spreads it on others.
 */
function isTaxLocationRequired(err: unknown): boolean {
    const body = axios.isAxiosError(err) ? err.response?.data : undefined;
    if (!body || typeof body !== 'object') return false;
    const b = body as Record<string, unknown>;
    if (b.code === TAX_LOCATION_REQUIRED_CODE) return true;
    const inner = b.message;
    return !!inner && typeof inner === 'object'
        && (inner as Record<string, unknown>).code === TAX_LOCATION_REQUIRED_CODE;
}

/**
 * Tax-location step — shown only when the server says it needs a jurisdiction
 * before it can create the subscription.
 *
 * Asks for the MINIMUM that makes a tax rate calculable: country, plus a postal
 * code where rates vary below the country level (US/CA). No street address, no
 * city, no name — we don't need them for a rate lookup and the data-minimisation
 * rule says don't ask. The server re-validates both fields; this form's checks
 * are for the user's benefit, not the server's.
 *
 * Deliberately NOT a Stripe AddressElement: that would have to mount inside an
 * <Elements> provider, which needs the clientSecret this step exists to unblock.
 */
const TaxLocationStep: React.FC<{
    token: string | null | undefined;
    onDone: () => void;
    onFallback?: () => void;
}> = ({ token, onDone, onFallback }) => {
    const [country, setCountry] = useState('');
    const [postal, setPostal] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const options = useMemo(() => taxCountryOptions(), []);
    const postalNeeded = !!country && taxPostalCodeRequired(country);
    const canSubmit = !!country && (!postalNeeded || postal.trim().length > 0);

    const submit = useCallback(async () => {
        if (!canSubmit || busy) return;
        setBusy(true);
        setError(null);
        try {
            await axios.post(
                `${API_BASE}/billing/tax-location`,
                { country, ...(postal.trim() ? { postal_code: postal.trim() } : {}) },
                { headers: { Authorization: `Bearer ${token}` } },
            );
            onDone();
        } catch (err) {
            setError(errMsg(err) || 'Could not save that. Try again?');
            setBusy(false);
        }
    }, [canSubmit, busy, country, postal, token, onDone]);

    return (
        <div className="pt-3">
            <KeysHeader signal="idle" bubble="Where are you? Tax depends on it." />
            <p className="text-sm text-cl-muted mb-5 text-center" style={{ maxWidth: 330, marginInline: 'auto' }}>
                {PRICE_LABEL} — we need your country to work out the tax that gets
                added. That’s all we store; no street address.
            </p>
            <form
                className="space-y-3"
                onSubmit={(e) => { e.preventDefault(); void submit(); }}
            >
                <label className="block">
                    <span className="block text-[12px] font-semibold mb-1.5 text-cl-muted">Country</span>
                    <select
                        value={country}
                        onChange={(e) => setCountry(e.target.value)}
                        autoFocus
                        className="w-full h-11 rounded-xl px-3 text-sm"
                        style={{ background: 'var(--cl-surface)', color: 'var(--cl-text)', border: '1px solid var(--cl-border)' }}
                    >
                        <option value="">Select your country…</option>
                        {options.map((o) => (
                            <option key={o.code} value={o.code}>{o.name}</option>
                        ))}
                    </select>
                </label>

                {postalNeeded && (
                    <label className="block">
                        <span className="block text-[12px] font-semibold mb-1.5 text-cl-muted">
                            {country === 'CA' ? 'Postal code' : 'ZIP code'}
                        </span>
                        <input
                            value={postal}
                            onChange={(e) => setPostal(e.target.value)}
                            maxLength={16}
                            inputMode="text"
                            autoComplete="postal-code"
                            placeholder={country === 'CA' ? 'A1A 1A1' : '10001'}
                            className="w-full h-11 rounded-xl px-3 text-sm"
                            style={{ background: 'var(--cl-surface)', color: 'var(--cl-text)', border: '1px solid var(--cl-border)' }}
                        />
                        <span className="block text-[11px] mt-1.5 text-cl-faint">
                            Sales tax varies by state and city, so the rate needs it.
                        </span>
                    </label>
                )}

                {error && (
                    <p className="text-[13px] flex items-start gap-1.5" style={{ color: 'var(--cl-danger)' }}>
                        <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0 }} /> {error}
                    </p>
                )}

                <ClButton type="submit" fullWidth disabled={!canSubmit} loading={busy}>
                    Continue
                </ClButton>
                {onFallback && (
                    <ClButton variant="ghost" fullWidth onClick={onFallback}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            <Globe size={16} /> Continue in browser instead
                        </span>
                    </ClButton>
                )}
            </form>
        </div>
    );
};

/* ── The actual form (inside <Elements>) ── */
type Phase = 'ready' | 'processing' | 'error' | 'activating' | 'pending' | 'success';

/** How long to wait for webhook-driven activation before saying so plainly.
 *  This form used to jump straight from a confirmed PaymentIntent to the
 *  success celebration, having never asked the server whether the account was
 *  actually upgraded — so a charge whose activation webhook never verified
 *  played confetti over a free-tier account. The API self-heals from Stripe on
 *  a status read, so the opening poll almost always settles it. */
const ACTIVATION_TIMEOUT_MS = 45_000;
const ACTIVATION_POLL_MS = 2_000;
const SUPPORT_EMAIL = 'hello@cipherline.chat';

const READY_BUBBLES = [
    `${PRICE_LABEL} — less than a mid-tier fountain drink.`,
    'Your card never touches our servers. Promise.',
    'Everything unlocks the moment this goes through.',
];

const CheckoutForm: React.FC<{
    context: 'onboarding' | 'upgrade';
    onSuccess: () => void;
    onClose: () => void;
    onFallback?: () => void;
    token: string | null;
}> = ({ onSuccess, onClose, token }) => {
    const stripe = useStripe();
    const elements = useElements();
    const reduced = useReducedMotion();
    const [phase, setPhase] = useState<Phase>('ready');
    const [elementReady, setElementReady] = useState(false);
    const [complete, setComplete] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [bubbleIdx, setBubbleIdx] = useState(0);
    const [focused, setFocused] = useState(false);
    const [recheckBusy, setRecheckBusy] = useState(false);
    // PaymentIntent 'processing' — accepted but not yet settled (bank debit).
    // Nothing is wrong and there is nothing to retry, so it earns its own copy.
    const [settling, setSettling] = useState(false);
    const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (pollTimer.current) clearTimeout(pollTimer.current); }, []);

    /** True once the server agrees the subscription is live. */
    const isActivated = useCallback(async (): Promise<boolean> => {
        try {
            const res = await axios.get(`${API_BASE}/billing/status`, {
                headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            });
            return res.data?.subscription_status === 'active';
        } catch {
            return false; // transient — the caller decides whether to keep waiting
        }
    }, [token]);

    /** Poll until the webhook (or the server's Stripe reconcile) confirms. */
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
                const res = await axios.post(`${API_BASE}/billing/activate`, {}, {
                    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
                });
                if (res.data?.subscription_status === 'active') { setPhase('success'); return; }
            } catch {
                // Never fatal — the money is already taken and Stripe confirmed
                // it. Fall through to the poll exactly as before.
            }
            void poll();
        })();
    }, [isActivated, token]);

    const recheck = useCallback(async () => {
        setRecheckBusy(true);
        const ok = await isActivated();
        setRecheckBusy(false);
        if (ok) setPhase('success');
    }, [isActivated]);

    // Rotate the encouraging line every few seconds while idle on the form.
    useEffect(() => {
        if (phase !== 'ready' || reduced) return;
        const t = setInterval(() => setBubbleIdx((i) => (i + 1) % READY_BUBBLES.length), 4200);
        return () => clearInterval(t);
    }, [phase, reduced]);

    // On success, run the celebration then hand off.
    useEffect(() => {
        if (phase !== 'success') return;
        const t = setTimeout(onSuccess, reduced ? 600 : 2300);
        return () => clearTimeout(t);
    }, [phase, reduced, onSuccess]);

    const submit = async () => {
        if (!stripe || !elements || phase === 'processing') return;
        setPhase('processing');
        setErrorMsg(null);
        const { error, paymentIntent } = await stripe.confirmPayment({
            elements,
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
    };

    if (phase === 'success') return <SuccessCelebration />;

    if (phase === 'activating') {
        return (
            <div className="pt-3 text-center">
                <KeysHeader signal="pulse" bubble="Payment received — unlocking your account…" />
                <p className="text-sm text-cl-muted mb-2" style={{ maxWidth: 320, marginInline: 'auto' }}>
                    Just a moment while we switch Pro on.
                </p>
            </div>
        );
    }

    if (phase === 'pending') {
        return (
            <div className="pt-3 text-center">
                <KeysHeader signal="alert" bubble="Payment received — Pro hasn't switched on yet." />
                <p className="text-sm text-cl-muted mb-6" style={{ maxWidth: 320, marginInline: 'auto' }}>
                    {settling
                        ? 'Your bank is still clearing this payment. Pro switches on by itself once it settles — don’t pay again.'
                        : 'That’s on our side, not your card. It unlocks by itself, usually within a few minutes.'}
                </p>
                <div className="space-y-2.5">
                    <ClButton fullWidth loading={recheckBusy} onClick={() => { void recheck(); }}>
                        Check again
                    </ClButton>
                    <ClButton variant="ghost" fullWidth onClick={onClose}>Close</ClButton>
                </div>
                <p className="text-xs text-cl-faint" style={{ maxWidth: 320, marginInline: 'auto', marginTop: 14 }}>
                    Still locked after an hour? Email {SUPPORT_EMAIL} — your payment is safe and we’ll finish it by hand.
                </p>
            </div>
        );
    }

    const keysSignal: KeysSignal = phase === 'processing' ? 'pulse' : phase === 'error' ? 'alert' : focused ? 'pulse' : 'idle';
    const bubble =
        phase === 'processing' ? 'Charging up the encryption core…'
        : phase === 'error' ? (errorMsg || 'That card got shy — try another?')
        : focused ? 'Looking good. Whenever you’re ready.'
        : READY_BUBBLES[bubbleIdx];

    return (
        <div className="pt-3">
            <KeysHeader signal={keysSignal} bubble={bubble} />

            <div className="mb-4" style={{ opacity: phase === 'processing' ? 0.55 : 1, pointerEvents: phase === 'processing' ? 'none' : 'auto', transition: 'opacity 0.2s' }}>
                <PaymentElement
                    options={{ layout: 'tabs' }}
                    onReady={() => setElementReady(true)}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    onChange={(e) => setComplete(e.complete)}
                />
            </div>

            {phase === 'error' && errorMsg && (
                <motion.p
                    className="text-[13px] mb-3 flex items-center gap-1.5"
                    style={{ color: 'var(--cl-flash)' }}
                    initial={{ opacity: 0, x: reduced ? 0 : -6 }} animate={{ opacity: 1, x: 0 }}
                >
                    <AlertTriangle size={14} /> {errorMsg}
                </motion.p>
            )}

            {/* Lume energy meter while charging */}
            {phase === 'processing' && (
                <div className="h-2 rounded-full overflow-hidden mb-4" style={{ background: 'var(--cl-surface)' }}>
                    <motion.div
                        className="h-full rounded-full"
                        style={{ background: 'linear-gradient(90deg, var(--cl-lume-deep), var(--cl-lume))', boxShadow: '0 0 12px rgba(37,224,200,0.6)' }}
                        initial={{ width: '8%' }}
                        animate={{ width: ['8%', '70%', '92%'] }}
                        transition={{ duration: 2.4, ease: 'easeInOut' }}
                    />
                </div>
            )}

            <ClButton
                fullWidth
                size="lg"
                onClick={submit}
                disabled={!stripe || !elementReady || (!complete && phase === 'ready')}
                loading={phase === 'processing'}
            >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Lock size={16} /> {phase === 'error' ? 'Try again' : `Pay ${PRICE_LABEL}`}
                </span>
            </ClButton>

            <p className="mt-2 text-[11px] leading-snug text-center" style={{ color: 'var(--cl-faint)' }}>
                Recurring subscription — your payment method is charged $2.50/month plus any
                applicable tax, and renews automatically until you cancel. Cancel anytime in
                Settings → Billing.
            </p>

            {/* Express request for immediate performance. Terms §7.7 makes the EU/UK/EEA
                withdrawal waiver rest on this acknowledgment being shown before payment,
                so it must stay adjacent to the pay button and must not be collapsed. */}
            <p className="mt-1 text-[11px] leading-snug text-center" style={{ color: 'var(--cl-faint)' }}>
                By subscribing you agree to the Terms of Service and ask for access to begin
                immediately.
            </p>

            <div className="flex items-center justify-center gap-1.5 mt-3 text-[11px]" style={{ color: 'var(--cl-faint)' }}>
                <ShieldCheck size={12} /> Secured by Stripe · cancel anytime
            </div>
        </div>
    );
};

/* ── Success: the biggest celebration ── */
const SuccessCelebration: React.FC = () => {
    const reduced = useReducedMotion();
    const confetti = useMemo(() => Array.from({ length: 42 }, (_, i) => ({
        left: (i * 2.4 + (i % 4) * 5) % 100,
        color: COLORS[i % COLORS.length],
        delay: (i % 12) * 0.13,
        dur: 2.4 + (i % 5) * 0.35,
        rot: (i * 57) % 360,
        size: 6 + (i % 3) * 3,
    })), []);
    const burst = useMemo(() => Array.from({ length: 8 }, (_, i) => {
        const a = (i / 8) * Math.PI * 2;
        return { x: Math.cos(a) * 58, y: Math.sin(a) * 58 };
    }), []);

    return (
        <div className="relative pt-4 text-center overflow-hidden" style={{ minHeight: 260 }}>
            {!reduced && (
                <div className="absolute inset-0 overflow-hidden pointer-events-none" style={{ margin: '-32px -28px' }}>
                    {confetti.map((c, i) => (
                        <motion.span
                            key={i}
                            className="absolute"
                            style={{ left: `${c.left}%`, top: -20, width: c.size, height: c.size * 1.4, background: c.color, borderRadius: 2 }}
                            initial={{ y: -20, opacity: 0, rotate: 0 }}
                            animate={{ y: 360, opacity: [0, 1, 1, 0.7], rotate: c.rot + 360 }}
                            transition={{ duration: c.dur, delay: c.delay, repeat: Infinity, repeatDelay: 0.7, ease: 'linear' }}
                        />
                    ))}
                </div>
            )}

            <div className="relative mx-auto mb-4" style={{ width: 96, height: 96 }}>
                {!reduced && burst.map((b, i) => (
                    <motion.span
                        key={i}
                        className="absolute rounded-full"
                        style={{ left: '50%', top: '50%', width: 5, height: 5, marginLeft: -2.5, marginTop: -2.5, background: 'var(--cl-glow)' }}
                        initial={{ opacity: 0, x: 0, y: 0 }}
                        animate={{ opacity: [0, 1, 0], x: b.x, y: b.y }}
                        transition={{ duration: 0.7, delay: 0.16, ease: 'easeOut' }}
                    />
                ))}
                {/* Keys does a happy spin */}
                <motion.div
                    className="w-full h-full flex items-center justify-center"
                    initial={{ scale: 0, rotate: reduced ? 0 : -180 }}
                    animate={{ scale: 1, rotate: 0, transition: { type: 'spring', stiffness: 240, damping: 12, delay: 0.05 } }}
                >
                    <Keys size={105} wave interactive={false} waveOnMount={false} />
                </motion.div>
            </div>

            <motion.h2
                className="text-[24px] font-bold leading-tight mb-2"
                style={{ fontFamily: 'var(--cl-font-display)', color: 'var(--cl-text)' }}
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.2 } }}
            >
                You’re Cipherline Pro!
            </motion.h2>

            {/* receipt unfurl */}
            <motion.div
                className="mx-auto rounded-xl px-4 py-2.5 mb-1 inline-flex items-center gap-2 text-[13px] font-semibold"
                style={{ background: 'rgba(37,224,200,0.10)', border: '1px solid rgba(37,224,200,0.25)', color: 'var(--cl-lume)', transformOrigin: 'top' }}
                initial={{ scaleY: 0, opacity: 0 }}
                animate={{ scaleY: 1, opacity: 1, transition: { type: 'spring', stiffness: 260, damping: 20, delay: 0.34 } }}
            >
                <Crown size={15} /> Cipherline Pro · {PRICE_LABEL}
            </motion.div>
            <motion.p
                className="text-cl-muted text-[13px] mt-2"
                initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: 0.5 } }}
            >
                <Sparkles size={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 4 }} />
                Every feature unlocked. Taking you in…
            </motion.p>
        </div>
    );
};

function errMsg(err: unknown): string | null {
    if (axios.isAxiosError(err)) {
        return (err.response?.data as { message?: string } | undefined)?.message || err.message;
    }
    if (err instanceof Error) return err.message;
    return null;
}

function friendlyError(msg?: string): string {
    if (!msg) return 'That card got shy — try another?';
    if (/declin/i.test(msg)) return 'Your card was declined — try another card?';
    if (/expired/i.test(msg)) return 'That card looks expired — try another?';
    if (/insufficient/i.test(msg)) return 'Insufficient funds — try a different card?';
    return msg;
}

export default InAppCheckout;
