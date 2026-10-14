/**
 * SubscriptionContext — keeps the user's billing state in one place.
 *
 * The status object mirrors `GET /v1/billing/status`. Fetched on mount, after
 * every login, and at a 5-minute heartbeat so the trial countdown and the
 * "expired" state flip without a full app reload.
 *
 * A non-paying account (effective_status === 'expired') is NOT locked out — it
 * drops to a usable FREE TIER: text + audio calls + ≤100 MB uploads + joining
 * AND creating servers (25 MB of saved storage per server you own) + encrypted
 * backups. Paid/trial accounts (effective_status === 'active') add video/
 * screen-share, 2 GB uploads, and saved-storage quotas that grow with the
 * server. Components read `isPaid` / `canPublishVideo` / `maxUploadBytes` to
 * gate the premium affordances (UX only — the server enforces every limit).
 * Server creation is NOT gated for any plan (2026-10-04).
 */
import React, { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import axios from 'axios';
import { API_BASE, MAX_ATTACHMENT_BYTES, FREE_TIER_MAX_UPLOAD_BYTES } from '../constants';
import { useAuth } from './AuthContext';
import { InAppCheckout } from '../components/billing/InAppCheckout';
import { UpgradePromptModal, type UpgradeReason } from '../components/billing/UpgradePromptModal';
import { secureLocalStore } from '../utils/secureLocalStore';
import { observeProStatus, recordProPurchase } from '../utils/proCelebration';
import { cancellationOutcome } from '../components/billing/cancellationOutcome';
import type { PaymentMethodView, InvoiceView } from '@cipherline/shared';

/** How long the in-app checkout stays mounted under the Pro celebration's veil
 *  (the veil fades in over 420 ms; see styles/pro-celebration.css). */
const CHECKOUT_HANDOFF_MS = 480;

export type SubscriptionStatus ='trial' | 'active' | 'canceled_pending' | 'past_due' | 'expired';
export type EffectiveStatus = 'active' | 'expired';

interface BillingStatus {
    subscription_status: SubscriptionStatus;
    effective_status: EffectiveStatus;
    trial_ends_at: string | null;
    trial_extended: boolean;
    trial_days_left: number;
    current_period_end: string | null;
    has_subscription: boolean;
    /** Present only when the account has a Stripe customer. This — NOT
     *  subscription_status — is what decides whether the billing portal can
     *  open: a comp grant sets status 'active' with no Stripe customer at all. */
    stripe_customer_id: string | null;
    /** Admin-granted complimentary subscription. */
    is_comp?: boolean;
    /** Comp expiry; null = indefinite. NB: for an indefinite comp the server
     *  sets current_period_end to a ~100-year sentinel, so don't render that
     *  as a renewal date when is_comp is true. */
    comp_expires_at?: string | null;
    /** Legacy: the server always sends null (unlimited) since 2026-10-04 —
     *  server creation is open to every plan. Nothing reads it any more. */
    server_limit?: number | null;
    /** Days until current_period_end. Null for comps (their sentinel date would
     *  read as tens of thousands of days) and when no period end is set. */
    period_ends_in_days?: number | null;
    /** Plan price in minor units (250 = $2.50) + ISO currency, from Stripe.
     *  Null when billing isn't configured — callers keep a fallback label.
     *  Render these through `formatPlanPrice` from @cipherline/shared, which
     *  appends "+ tax": the price is tax-EXCLUSIVE, so the amount here is the
     *  base charge and never the total the card will be debited. */
    plan_amount?: number | null;
    plan_currency?: string | null;
    /** Stripe's tax_behavior on that Price — 'exclusive' is the intended value.
     *  DIAGNOSTIC ONLY. Do not branch price copy on it: every surface says
     *  "+ tax" unconditionally, because "plus tax where applicable" is true
     *  whether or not the customer's jurisdiction currently produces one. */
    plan_tax_behavior?: string | null;
    /** Whether the server sends automatic_tax to Stripe. When true, the in-app
     *  checkout may need a tax-location step before a subscription can be
     *  created — see InAppCheckout's TaxLocationStep. */
    automatic_tax?: boolean;
    /** Non-secret pk_* for initialising Stripe.js. */
    publishable_key?: string | null;
}

interface SubscriptionContextValue {
    status: BillingStatus | null;
    /** Set when the last status fetch failed, so the UI can offer a retry. */
    statusError: string | null;
    /** Paid or in-trial — gets all premium features. */
    isPaid: boolean;
    /** Non-paying (lapsed trial / never subscribed) — on the limited free tier. */
    isFreeTier: boolean;
    /** May publish camera + screen-share in calls (audio is always allowed). */
    canPublishVideo: boolean;
    /** Max single-attachment upload size in bytes for the current tier. */
    maxUploadBytes: number;
    refresh: () => Promise<void>;
    extendTrial: () => Promise<{ ok: boolean; message?: string }>;
    /**
     * Show the pro-feature explainer for `reason`, whose upgrade button then
     * opens checkout. Use this instead of openInAppCheckout() at feature gates
     * so the user gets the "here's what Pro is" pitch before any card prompt.
     */
    promptUpgrade: (reason: UpgradeReason, detail?: string) => void;
    /** Open the animated in-app Stripe Payment Element checkout (upgrade path). */
    openInAppCheckout: () => void;
    /**
     * Cancel at period end, or undo a pending cancellation. Refreshes status on
     * success so the pane reflects it immediately — the server writes through
     * from Stripe's response rather than waiting for the webhook, so there is
     * nothing to poll for.
     */
    setCancellation: (cancel: boolean) => Promise<{ ok: boolean; message?: string; settled?: boolean }>;
    /** The card that will be charged next renewal. `null` when none is on file. */
    fetchPaymentMethod: () => Promise<{ ok: boolean; paymentMethod?: PaymentMethodView | null; message?: string }>;
    /** Past charges, newest first. */
    fetchInvoices: () => Promise<{ ok: boolean; invoices?: InvoiceView[]; message?: string }>;
    /**
     * A purchase just completed and the "you're Pro" celebration should play
     * (Dashboard renders it; utils/proCelebration.ts says exactly when this
     * turns on). It is already recorded as seen by the time it is true, so a
     * reload never replays it.
     */
    proCelebration: boolean;
    dismissProCelebration: () => void;
}

const SubscriptionContext = createContext<SubscriptionContextValue | undefined>(undefined);

export const SubscriptionProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const { isAuthenticated, token, userId } = useAuth();
    const [status, setStatus] = useState<BillingStatus | null>(null);
    /** Non-null when the last status fetch failed — lets the UI show an error
     *  and a retry instead of skeletons forever. */
    const [statusError, setStatusError] = useState<string | null>(null);
    /** Mirrors `status` for pollUntilActive, which needs the freshly-fetched
     *  value inside its own loop rather than the render-time closure. */
    const statusRef = useRef<BillingStatus | null>(null);
    useEffect(() => { statusRef.current = status; }, [status]);
    const [checkoutOpen, setCheckoutOpen] = useState(false);
    const [upgradePrompt, setUpgradePrompt] = useState<{ reason: UpgradeReason; detail?: string } | null>(null);
    const [proCelebration, setProCelebration] = useState(false);
    const dismissProCelebration = useCallback(() => setProCelebration(false), []);

    const refresh = useCallback(async () => {
        if (!isAuthenticated || !token) {
            setStatus(null);
            return;
        }
        try {
            const res = await axios.get(`${API_BASE}/billing/status`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            setStatus(res.data);
            setStatusError(null);
        } catch (err) {
            console.warn('[SubscriptionContext] status fetch failed', err);
            // Record it. Previously this only warned, leaving `status` null
            // forever — which renders the whole Subscription pane as skeletons
            // with no error, no retry, and (because the refresh control lives
            // inside that pane) no way for the user to recover.
            setStatusError('Could not load your subscription status.');
            throw err;
        }
    }, [isAuthenticated, token]);

    useEffect(() => { refresh(); }, [refresh]);

    // Celebrate a purchase this device OBSERVES: a payment on the website (which
    // is also where the in-app checkout's "open your account page" fallback
    // sends people), trial → paid while the app was closed. The
    // record is per account, so wait for this account's secureLocalStore
    // namespace: read cold right after a sign-in it would look like "no record".
    useEffect(() => {
        if (!status || !userId) return;
        let cancelled = false;
        const observe = () => {
            if (cancelled || !secureLocalStore.isAccountReady(userId)) return;
            // No "browser checkout pending" signal any more: the desktop no longer
            // opens hosted Stripe Checkout, so a free -> paid edge is simply
            // observed (a first-ever status read with no record does not celebrate).
            const celebrate = observeProStatus(secureLocalStore, userId, status, false);
            if (celebrate) setProCelebration(true);
        };
        if (secureLocalStore.isAccountReady(userId)) observe();
        else void secureLocalStore.whenAccountReady().then(observe, () => { /* stays unobserved */ });
        return () => { cancelled = true; };
    }, [status, userId]);

    // Periodic refresh so the trial countdown updates and the read-only flip
    // happens promptly without a reload. Every 5 minutes.
    useEffect(() => {
        if (!isAuthenticated) return;
        const t = setInterval(() => { refresh(); }, 5 * 60_000);
        return () => clearInterval(t);
    }, [isAuthenticated, refresh]);

    // The realtime gateway emits `subscription_required` when it rejects a
    // write-like event from a lapsed account — re-fetch so the UI reflects
    // read-only without waiting for the 5-minute poll. A lapsed user typing
    // produces one such event PER keystroke, so throttle to ≤1 fetch/30s.
    useEffect(() => {
        let last = 0;
        const onRequired = () => {
            const now = Date.now();
            if (now - last < 30_000) return;
            last = now;
            refresh();
        };
        window.addEventListener('cipherline:subscription-required', onRequired);
        return () => window.removeEventListener('cipherline:subscription-required', onRequired);
    }, [refresh]);

    // Refresh when the window regains focus — the Stripe checkout completes in the
    // external browser, so this is how we notice "they just paid" when they come
    // back to the app (drives the Pro-welcome celebration). Throttled to ≤1/10s.
    useEffect(() => {
        if (!isAuthenticated) return;
        let last = 0;
        const onFocus = () => {
            const now = Date.now();
            if (now - last < 10_000) return;
            last = now;
            refresh();
        };
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [isAuthenticated, refresh]);

    const extendTrial = useCallback(async (): Promise<{ ok: boolean; message?: string }> => {
        if (!token) return { ok: false, message: 'not authenticated' };
        try {
            await axios.post(`${API_BASE}/billing/extend-trial`, {}, {
                headers: { Authorization: `Bearer ${token}` },
            });
            await refresh();
            return { ok: true };
        } catch (err: unknown) {
            const message = axios.isAxiosError(err) ? err.response?.data?.message : undefined;
            return { ok: false, message: message || 'Could not extend trial.' };
        }
    }, [token, refresh]);

    /**
     * Open the Stripe billing portal.
     *
     * Returns `{ ok: false, message }` rather than a bare null so callers can
     * TELL THE USER what happened. The previous `catch { return null }` is the
     * whole reason "Manage subscription" looked dead: a comp account has no
     * Stripe customer, the API 400s with a perfectly good explanation, and this
     * threw it on the floor — no toast, no log, no state change.
     */
    /**
     * Surface the API's own message rather than a generic one. The server has
     * the specific, useful wording — "Your subscription is complimentary, there
     * is no billing to manage", "That subscription is no longer active" — and
     * throwing it away is exactly what made the old portal button look dead.
     */
    const apiMessage = (err: unknown, fallback: string): string =>
        (axios.isAxiosError(err) ? err.response?.data?.message : undefined) || fallback;

    const setCancellation = useCallback(async (cancel: boolean): Promise<{ ok: boolean; message?: string; settled?: boolean }> => {
        if (!token) return { ok: false, message: 'You need to be signed in.' };
        try {
            const res = await axios.post(`${API_BASE}/billing/cancellation`, { cancel }, {
                headers: { Authorization: `Bearer ${token}` },
            });
            await refresh();
            // Never trust a 2xx alone: judge the response against the request
            // so the UI cannot announce "cancelled" beside a still-renewing plan.
            return cancellationOutcome(cancel, res.data);
        } catch (err: unknown) {
            console.warn('[SubscriptionContext] cancellation failed', err);
            return {
                ok: false,
                message: apiMessage(err, cancel
                    ? 'Could not cancel your subscription. Please try again.'
                    : 'Could not resume your subscription. Please try again.'),
            };
        }
    }, [token, refresh]);

    const fetchPaymentMethod = useCallback(async () => {
        if (!token) return { ok: false, message: 'You need to be signed in.' };
        try {
            const res = await axios.get(`${API_BASE}/billing/payment-method`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            return { ok: true, paymentMethod: (res.data?.payment_method ?? null) as PaymentMethodView | null };
        } catch (err: unknown) {
            return { ok: false, message: apiMessage(err, 'Could not load your payment method.') };
        }
    }, [token]);

    const fetchInvoices = useCallback(async () => {
        if (!token) return { ok: false, message: 'You need to be signed in.' };
        try {
            const res = await axios.get(`${API_BASE}/billing/invoices`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            return { ok: true, invoices: (res.data?.invoices ?? []) as InvoiceView[] };
        } catch (err: unknown) {
            return { ok: false, message: apiMessage(err, 'Could not load your payment history.') };
        }
    }, [token]);

    /**
     * Poll until the webhook has actually activated the subscription.
     *
     * Activation is entirely webhook-driven server-side (createSubscriptionIntent
     * deliberately writes no status), so the single refresh() fired ~2s after
     * confirmPayment races invoice.payment_succeeded. When it lost, the user
     * had paid and the app still said free tier — and none of the other refresh
     * triggers could rescue it: the focus listener can't fire because the
     * payment happened IN-APP so the window never lost focus, and the
     * subscription-required event only fires on rejection. The fallback was the
     * 5-minute poll.
     */
    const pollUntilActive = useCallback(async () => {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
            try {
                await refresh();
                if (statusRef.current?.effective_status === 'active') return true;
            } catch { /* transient — keep trying until the deadline */ }
            await new Promise(r => setTimeout(r, 2000));
        }
        return false;
    }, [refresh]);

    const openInAppCheckout = useCallback(() => setCheckoutOpen(true), []);
    const promptUpgrade = useCallback((reason: UpgradeReason, detail?: string) => setUpgradePrompt({ reason, detail }), []);

    // Tier derivation. Until status loads we treat the account as free tier so
    // premium affordances stay gated (they flip on once a paid status arrives);
    // messaging/audio are never gated either way.
    const isPaid = !!status && status.effective_status === 'active';
    const isFreeTier = !isPaid;
    const canPublishVideo = isPaid;
    const maxUploadBytes = isPaid ? MAX_ATTACHMENT_BYTES : FREE_TIER_MAX_UPLOAD_BYTES;

    const value = useMemo(
        () => ({ status, statusError, isPaid, isFreeTier, canPublishVideo, maxUploadBytes, refresh, extendTrial, promptUpgrade, openInAppCheckout, setCancellation, fetchPaymentMethod, fetchInvoices, proCelebration, dismissProCelebration }),
        [status, statusError, isPaid, isFreeTier, canPublishVideo, maxUploadBytes, refresh, extendTrial, promptUpgrade, openInAppCheckout, setCancellation, fetchPaymentMethod, fetchInvoices, proCelebration, dismissProCelebration],
    );

    return (
        <SubscriptionContext.Provider value={value}>
            {children}
            {/* Pro-feature explainer — shown first at every gate; its upgrade
                button opens the checkout below (handleUpgrade closes this,
                then calls openInAppCheckout, so the two never stack). */}
            <UpgradePromptModal
                open={!!upgradePrompt}
                reason={upgradePrompt?.reason ?? 'video'}
                detail={upgradePrompt?.detail}
                onClose={() => setUpgradePrompt(null)}
            />
            {checkoutOpen && (
                <InAppCheckout
                    context="upgrade"
                    onSuccess={() => {
                        // InAppCheckout reports success only once the SERVER says
                        // the subscription is active (POST /billing/activate or
                        // its status poll), so this is a confirmed purchase:
                        // record it and celebrate now. Recording first means the
                        // status refresh below sees 'pro' → 'pro' and cannot
                        // start a second celebration. The celebration layer sits
                        // above this modal (z 2200 > 2100), so the checkout stays
                        // mounted underneath until the veil has faded in fully
                        // and only then unmounts: no flash of the app between
                        // the two.
                        if (userId) recordProPurchase(secureLocalStore, userId);
                        setProCelebration(true);
                        setTimeout(() => setCheckoutOpen(false), CHECKOUT_HANDOFF_MS);
                        // Bring the shared status (isPaid etc.) up to date. Poll
                        // rather than fetch once: one fetch can lose the race
                        // with the webhook.
                        void pollUntilActive();
                    }}
                    onClose={() => setCheckoutOpen(false)}
                />
            )}
        </SubscriptionContext.Provider>
    );
};

// eslint-disable-next-line react-refresh/only-export-components -- co-located helper export; splitting the file would only affect dev Fast Refresh, not runtime behaviour
export const useSubscription = (): SubscriptionContextValue => {
    const ctx = useContext(SubscriptionContext);
    if (!ctx) throw new Error('useSubscription must be used within a SubscriptionProvider');
    return ctx;
};
