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
import type { PaymentMethodView, InvoiceView } from '@cipherline/shared';

export type SubscriptionStatus = 'trial' | 'active' | 'canceled_pending' | 'past_due' | 'expired';
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
    /** Resolves `{ ok:false, message }` on failure so callers can surface it. */
    openCheckout: () => Promise<{ ok: boolean; url?: string; message?: string }>;
    /**
     * Cancel at period end, or undo a pending cancellation. Refreshes status on
     * success so the pane reflects it immediately — the server writes through
     * from Stripe's response rather than waiting for the webhook, so there is
     * nothing to poll for.
     */
    setCancellation: (cancel: boolean) => Promise<{ ok: boolean; message?: string }>;
    /** The card that will be charged next renewal. `null` when none is on file. */
    fetchPaymentMethod: () => Promise<{ ok: boolean; paymentMethod?: PaymentMethodView | null; message?: string }>;
    /** Past charges, newest first. */
    fetchInvoices: () => Promise<{ ok: boolean; invoices?: InvoiceView[]; message?: string }>;
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
     * Open the external-browser Stripe Checkout flow — the fallback when the
     * in-app Payment Element can't be used (InAppCheckout's "Continue in
     * browser" / IntentError path).
     *
     * Returns `{ok, message}` rather than a bare null, for the same reason
     * openPortal does below — but here it matters MORE: this is called from
     * onFallback AFTER the checkout modal has already been closed
     * (setCheckoutOpen(false) fires first), so a silently-swallowed failure
     * left the user looking at nothing at all, no modal, no error, no
     * explanation. See the fallbackError banner rendered below for where this
     * result actually goes.
     */
    const openCheckout = useCallback(async (): Promise<{ ok: boolean; url?: string; message?: string }> => {
        if (!token) return { ok: false, message: 'You need to be signed in.' };
        try {
            const res = await axios.post(`${API_BASE}/billing/checkout`, {}, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const url = res.data?.checkout_url;
            // Same scheme check as openPortal — defence in depth against a
            // compromised/misconfigured backend, since the main process's own
            // allowlist fails silently.
            if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
                return { ok: false, message: 'Received an unexpected checkout URL.' };
            }
            if (!window.electronAPI?.openExternal) {
                return { ok: false, message: 'Could not open your browser.' };
            }
            await window.electronAPI.openExternal(url);
            return { ok: true, url };
        } catch (err: unknown) {
            const message = axios.isAxiosError(err) ? err.response?.data?.message : undefined;
            console.warn('[SubscriptionContext] checkout failed', err);
            return { ok: false, message: message || 'Could not start checkout. Please try again.' };
        }
    }, [token]);

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

    const setCancellation = useCallback(async (cancel: boolean): Promise<{ ok: boolean; message?: string }> => {
        if (!token) return { ok: false, message: 'You need to be signed in.' };
        try {
            await axios.post(`${API_BASE}/billing/cancellation`, { cancel }, {
                headers: { Authorization: `Bearer ${token}` },
            });
            await refresh();
            return { ok: true };
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
    const [checkoutFallbackError, setCheckoutFallbackError] = useState<string | null>(null);
    const promptUpgrade = useCallback((reason: UpgradeReason, detail?: string) => setUpgradePrompt({ reason, detail }), []);

    // Tier derivation. Until status loads we treat the account as free tier so
    // premium affordances stay gated (they flip on once a paid status arrives);
    // messaging/audio are never gated either way.
    const isPaid = !!status && status.effective_status === 'active';
    const isFreeTier = !isPaid;
    const canPublishVideo = isPaid;
    const maxUploadBytes = isPaid ? MAX_ATTACHMENT_BYTES : FREE_TIER_MAX_UPLOAD_BYTES;

    const value = useMemo(
        () => ({ status, statusError, isPaid, isFreeTier, canPublishVideo, maxUploadBytes, refresh, extendTrial, promptUpgrade, openInAppCheckout, openCheckout, setCancellation, fetchPaymentMethod, fetchInvoices }),
        [status, statusError, isPaid, isFreeTier, canPublishVideo, maxUploadBytes, refresh, extendTrial, promptUpgrade, openInAppCheckout, openCheckout, setCancellation, fetchPaymentMethod, fetchInvoices],
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
                        setCheckoutOpen(false);
                        // Poll until the webhook lands rather than firing one
                        // refresh that races it. Only suppress ProWelcome once
                        // we've actually SEEN the account go active — marking it
                        // unconditionally meant a user whose activation lagged
                        // lost the celebration entirely.
                        void pollUntilActive().then(active => {
                            if (active && userId) {
                                try { secureLocalStore.setItem(`cipherline_pro_welcomed_${userId}`, '1'); } catch { /* noop */ }
                            }
                        });
                    }}
                    onClose={() => setCheckoutOpen(false)}
                    onFallback={() => {
                        setCheckoutOpen(false);
                        void openCheckout().then(r => {
                            if (!r.ok) setCheckoutFallbackError(r.message ?? 'Could not start checkout.');
                        });
                    }}
                />
            )}
            {/* Only reachable from the external-browser checkout fallback
                above — everything else in this file has a real toast/modal to
                report into. Fixed + dismissible since it can appear over any
                view in the app. */}
            {checkoutFallbackError && (
                <div
                    className="fixed top-3 left-1/2 -translate-x-1/2 z-[10000] flex items-center gap-3 px-4 py-2.5 rounded-xl border text-sm shadow-lg"
                    style={{ background: 'rgba(20,8,10,0.95)', borderColor: 'rgba(255,92,122,0.35)', color: '#ff9fb2' }}
                >
                    <span>{checkoutFallbackError}</span>
                    <button
                        type="button"
                        onClick={() => setCheckoutFallbackError(null)}
                        style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 13, opacity: 0.8 }}
                    >
                        Dismiss
                    </button>
                </div>
            )}
        </SubscriptionContext.Provider>
    );
};

export const useSubscription = (): SubscriptionContextValue => {
    const ctx = useContext(SubscriptionContext);
    if (!ctx) throw new Error('useSubscription must be used within a SubscriptionProvider');
    return ctx;
};
