/**
 * Midnight · Subscription — Descent redesign (phase 3).
 * Plan reads as a proper plan card (Fredoka plan name + perk checklist);
 * the upgrade button is THE ceremony button (kit hero: idle shine sweep +
 * confetti on press — the one place it's allowed). Referral panel keeps its
 * logic, restyled. Status copy unchanged.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { useSubscription } from '../../contexts/SubscriptionContext';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { RefreshCw, CheckCircle2, AlertTriangle, Clock, Sparkles, Gift, Copy, Check, Link2 } from 'lucide-react';
import { ClButton, ClSkeleton } from '../cl';
import { UpdateCardModal } from './UpdateCardModal';
import { openExternalLink } from '../../utils/openExternalLink';
import { formatMoney, type PaymentMethodView, type InvoiceView } from '@cipherline/shared';
import { API_BASE } from '../../constants';
import { writeToClipboard } from '../../utils/clipboard';
import { motion } from 'framer-motion';
import { formatBillingDateOr, cancellationKeepProSentence, formatPlanPrice } from '@cipherline/shared';
import { nudges } from '../../utils/firstWeekNudgeStore';

/**
 * Standalone-field date. Returns the em-dash placeholder ONLY where that reads
 * correctly on its own ("Renews on —"). Sentences that embed a date use
 * `cancellationKeepProSentence` instead: interpolating this placeholder
 * mid-sentence is what produced "You'll keep Pro until — — the period you've
 * already paid for". See packages/shared/billing.ts.
 */
function formatDate(iso: string | null): string {
    return formatBillingDateOr(iso, '—');
}

/** 'visa' -> 'Visa'. Stripe returns lowercase ids; 'amex' is the one that
 *  doesn't simply capitalise. */
function cardBrandLabel(brand: string | null): string {
    if (!brand) return 'Card';
    if (brand === 'amex') return 'American Express';
    return brand.charAt(0).toUpperCase() + brand.slice(1);
}

/** Receipts are Stripe-hosted pages; open them in the real browser rather than
 *  re-rendering a PDF ourselves. Goes through the validated helper, which
 *  enforces the scheme before handing anything to the main process. */
function openReceipt(url: string): void {
    openExternalLink(url);
}

/** Confetti for the one ceremony button. Escalates nowhere — upgrading is the payoff. */
function celebrate(host: HTMLElement) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const cols = ['#25E0C8', '#FF6B5E', '#FFC94D', '#F4F7FF', '#3BEAD6'];
    const r = host.getBoundingClientRect();
    for (let i = 0; i < 12; i++) {
        const c = document.createElement('i');
        c.className = 'sd-conf';
        c.style.background = cols[i % cols.length];
        c.style.left = (r.width / 2 + (Math.random() * 40 - 20)) + 'px';
        c.style.top = '6px';
        c.style.setProperty('--dx', (Math.random() * 160 - 80) + 'px');
        c.style.setProperty('--dy', (-(30 + Math.random() * 70)) + 'px');
        c.style.setProperty('--rot', (Math.random() * 360 - 180) + 'deg');
        host.appendChild(c);
        setTimeout(() => c.remove(), 850);
    }
}

interface ReferralStatus {
    referral_code: string | null;
    referrals_count: number;
    rewards_claimed: number;
    max_referrals: number;
    days_per_referral: number;
}

const PRO_PERKS = [
    ['HD video calls + screen sharing', 'free: audio calls'],
    ['2 GB file uploads', 'free: 100 MB'],
    ['Bigger saved storage that grows with your server (100 MB to 10 GB)', 'free: 25 MB per server'],
] as const;

export const BillingTab: React.FC = () => {
    const {
        status, statusError, refresh, openInAppCheckout, extendTrial,
        setCancellation, fetchPaymentMethod, fetchInvoices,
    } = useSubscription();
    const { token } = useAuth();
    const { push: pushToast } = useToast();

    const [referral, setReferral] = useState<ReferralStatus | null>(null);
    const [referralError, setReferralError] = useState<string | null>(null);
    const [copied, setCopied] = useState<'code' | 'link' | null>(null);
    const heroHostRef = useRef<HTMLSpanElement>(null);
    // In-flight guards. Without these every one of these buttons was silently
    // spammable — and because they gave no feedback at all, users who couldn't
    // tell whether the click registered would hammer them, firing N portal
    // sessions and N browser tabs.
    const [cancelBusy, setCancelBusy] = useState(false);
    /** Two-step cancel: the button arms a confirmation rather than acting. */
    const [confirmCancel, setConfirmCancel] = useState(false);
    const [cardOpen, setCardOpen] = useState(false);
    const [paymentMethod, setPaymentMethod] = useState<PaymentMethodView | null>(null);
    const [invoices, setInvoices] = useState<InvoiceView[]>([]);
    // Starts true: for an account with billing, the effect below fetches on
    // mount, and starting false would flash "No card on file" first.
    const [detailsBusy, setDetailsBusy] = useState(true);
    const [extendBusy, setExtendBusy] = useState(false);
    const [refreshBusy, setRefreshBusy] = useState(false);

    /** Arm the two-step cancel. (It used to also load the user's owned servers to
     *  warn about a 60-day deletion; that policy is gone — since 2026-10-04 every
     *  plan may own servers, and nothing is deleted when Pro ends.) */
    const armCancel = useCallback(() => setConfirmCancel(true), []);

    /**
     * Cancel or resume. The server writes through from Stripe's own response
     * rather than waiting for the webhook, so `setCancellation` refreshes
     * status itself and the pane is correct the moment this resolves — no
     * optimistic guess, no polling.
     */
    const handleSetCancellation = useCallback(async (cancel: boolean) => {
        if (cancelBusy) return;
        setCancelBusy(true);
        try {
            const res = await setCancellation(cancel);
            if (res.ok) {
                pushToast({
                    kind: 'success',
                    message: cancel
                        ? 'Cancelled. You keep Pro until the end of the period you already paid for.'
                        : 'Welcome back — your subscription will renew as normal.',
                });
                setConfirmCancel(false);
            } else {
                pushToast({ kind: 'error', title: 'Subscription', message: res.message ?? 'That didn’t work. Please try again.' });
            }
        } finally {
            setCancelBusy(false);
        }
    }, [setCancellation, cancelBusy, pushToast]);

    /** Card on file + payment history, fetched together. Used by the explicit
     *  refresh button; the mount-time load lives in the effect below so it can
     *  cancel cleanly if the pane closes mid-flight. */
    const loadBillingDetails = useCallback(async () => {
        setDetailsBusy(true);
        try {
            const [pmRes, invRes] = await Promise.all([fetchPaymentMethod(), fetchInvoices()]);
            if (pmRes.ok) setPaymentMethod(pmRes.paymentMethod ?? null);
            if (invRes.ok) setInvoices(invRes.invoices ?? []);
        } finally {
            setDetailsBusy(false);
        }
    }, [fetchPaymentMethod, fetchInvoices]);

    // Load the card and receipts once the pane knows the account has a Stripe
    // customer. Deliberately not part of the 5-minute status heartbeat: these
    // are live Stripe reads, and nobody needs their invoice list re-fetched in
    // the background while they sit on another settings tab.
    const billingAccountReady = !!status?.stripe_customer_id;
    useEffect(() => {
        if (!billingAccountReady) return;
        let cancelled = false;
        void (async () => {
            const [pmRes, invRes] = await Promise.all([fetchPaymentMethod(), fetchInvoices()]);
            if (cancelled) return;
            if (pmRes.ok) setPaymentMethod(pmRes.paymentMethod ?? null);
            if (invRes.ok) setInvoices(invRes.invoices ?? []);
            setDetailsBusy(false);
        })();
        return () => { cancelled = true; };
    }, [billingAccountReady, fetchPaymentMethod, fetchInvoices]);

    /** Refresh status and SAY something either way — a refresh button that
     *  produces no visible change is indistinguishable from a broken one. */
    const handleRefresh = useCallback(async () => {
        if (refreshBusy) return;
        setRefreshBusy(true);
        try {
            await refresh();
            pushToast({ kind: 'success', message: 'Subscription status up to date.' });
        } catch {
            pushToast({ kind: 'error', message: 'Could not refresh subscription status.' });
        } finally {
            setRefreshBusy(false);
        }
    }, [refresh, refreshBusy, pushToast]);

    /** extendTrial already returns {ok, message}; it was being discarded. */
    const handleExtendTrial = useCallback(async () => {
        if (extendBusy) return;
        setExtendBusy(true);
        try {
            const r = await extendTrial();
            pushToast(
                r.ok
                    ? { kind: 'success', title: 'Trial extended', message: r.message ?? 'Added 3 more days.' }
                    : { kind: 'error', title: 'Could not extend trial', message: r.message ?? 'Please try again.' },
            );
        } finally {
            setExtendBusy(false);
        }
    }, [extendTrial, extendBusy, pushToast]);

    useEffect(() => {
        if (!token) return;
        axios.get<ReferralStatus>(`${API_BASE}/billing/referral`, { headers: { Authorization: `Bearer ${token}` } })
            .then(r => { setReferral(r.data); setReferralError(null); })
            // Was `.catch(() => {})`, which left the referral panel on skeletons
            // forever with nothing explaining why.
            .catch(() => setReferralError('Could not load your referral status.'));
    }, [token]);

    const handleCopyCode = useCallback(() => {
        const code = referral?.referral_code;
        if (!code) return;
        writeToClipboard(code).then(() => {
            setCopied('code');
            pushToast({ kind: 'success', message: 'Referral code copied!' });
            setTimeout(() => setCopied(null), 2000);
        }).catch(() => pushToast({ kind: 'error', message: 'Could not copy — try selecting and copying manually.' }));
    }, [referral?.referral_code, pushToast]);

    const handleCopyLink = useCallback(() => {
        const code = referral?.referral_code;
        if (!code) return;
        writeToClipboard(`https://cipherline.chat/ref/${code}`).then(() => {
            setCopied('link');
            pushToast({ kind: 'success', message: 'Referral link copied!' });
            nudges.notify({ kind: 'invite_sent' });
            setTimeout(() => setCopied(null), 2000);
        }).catch(() => pushToast({ kind: 'error', message: 'Could not copy — try selecting and copying manually.' }));
    }, [referral?.referral_code, pushToast]);

    // Load FAILED (as opposed to still loading). Without this branch the pane
    // sat on skeletons forever with no error and no way out: the only refresh
    // control lives further down, inside the markup this early-returns past.
    if (!status && statusError) {
        return (
            <div className="sd-card">
                <div className="flex items-start gap-3">
                    <AlertTriangle size={16} className="text-cl-flash shrink-0 mt-0.5" />
                    <div className="flex-1">
                        <p className="text-[13.5px] text-cl-text m-0">{statusError}</p>
                        <p className="text-[12px] text-cl-faint mt-1 mb-3">
                            Your subscription itself isn’t affected — this is just the status readout.
                        </p>
                        <ClButton type="button" variant="primary" onClick={handleRefresh} loading={refreshBusy}>
                            Try again
                        </ClButton>
                    </div>
                </div>
            </div>
        );
    }

    if (!status) {
        return (
            <div className="sd-card">
                <div className="flex flex-col gap-3">
                    <ClSkeleton style={{ width: 140, height: 22 }} />
                    <ClSkeleton style={{ width: 280, height: 12 }} />
                    <ClSkeleton style={{ width: '100%', height: 44, borderRadius: 14 }} />
                </div>
            </div>
        );
    }

    // The raw enum is NOT the truth about expiry: a lapsed trial keeps
    // subscription_status === 'trial' forever — only the server-computed
    // effective_status flips to 'expired'. Key every "expired" visual off
    // effective_status or a trial that ran out never reads as expired.
    const isPastDue = status.subscription_status === 'past_due';
    const isExpired = status.effective_status === 'expired' && !isPastDue;
    const trialLive = status.subscription_status === 'trial' && !isExpired;
    // extendTrial revives a lapsed trial server-side (GREATEST(ends, NOW())+3d),
    // so the extend offer stays visible after expiry too.
    const showExtend = status.subscription_status === 'trial' && !status.trial_extended;
    // past_due is deliberately NOT an upgrade state — a new checkout would
    // stack a second subscription; the fix is updating the card (portal).
    const canUpgrade = trialLive || isExpired;
    // Complimentary (admin-granted) account: status reads 'active' but there is
    // no Stripe subscription and usually no Stripe customer at all.
    const isComp = status.is_comp === true;
    // Does this account have a Stripe customer at all? Gate the card/history
    // sections on the CUSTOMER, not on subscription_status — a comp grant sets
    // status 'active' with no customer (every control would be dead), while a
    // lapsed ex-payer keeps theirs and can still see receipts and fix a card.
    const hasBillingAccount = !!status.stripe_customer_id;
    // Did a paid subscription lapse, or did a trial just run out?
    const hadPro = status.has_subscription || !!status.current_period_end;
    const refCount = referral?.referrals_count ?? 0;
    const maxRef = referral?.max_referrals ?? 5;
    const daysEarned = refCount * (referral?.days_per_referral ?? 7);

    const planName =
        isComp ? 'Cipherline Pro — complimentary'
        : status.subscription_status === 'active' ? 'Cipherline Pro'
        : trialLive ? 'Free trial'
        : status.subscription_status === 'canceled_pending' && !isExpired ? 'Pro — cancelled'
        : isPastDue ? 'Cipherline Pro'
        : 'Free';

    return (
        <>
            {/* ── Payment problem — front and center, plain and complete ── */}
            {isPastDue && (
                <div className="sd-card sd-card--danger">
                    <div className="flex items-center gap-3">
                        <span className="sd-tile sd-tile--flash"><AlertTriangle size={16} /></span>
                        <div>
                            <h3 style={{ margin: 0 }}>Your payment didn’t go through</h3>
                            <p className="sd-sub" style={{ margin: 0, color: 'var(--cl-muted)' }}>
                                Your card was declined for the last renewal.
                            </p>
                        </div>
                    </div>
                    <p className="text-[13px] leading-relaxed mt-3 mb-4" style={{ color: 'var(--cl-muted)' }}>
                        Pro stays active while the charge is retried automatically over the next few
                        days. If every retry fails, your account drops to the free tier — your messages,
                        keys, and encrypted backups are not affected either way. The usual causes are an
                        expired card, insufficient funds, or a bank block on online payments.
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                        <ClButton type="button" variant="primary" onClick={() => setCardOpen(true)}>
                            Update payment method
                        </ClButton>
                        <ClButton type="button" variant="ghost" onClick={handleRefresh} loading={refreshBusy}>
                            I’ve fixed it — recheck
                        </ClButton>
                    </div>
                </div>
            )}

            {/* ── Your plan ────────────────────────────────────────────── */}
            <div className="sd-card">
                <div className="flex items-center justify-between">
                    <h3>Your plan</h3>
                    <ClButton type="button" variant="ghost" icon size="sm" onClick={handleRefresh} loading={refreshBusy} tooltip="Refresh">
                        <RefreshCw size={14} />
                    </ClButton>
                </div>

                {/* Status */}
                <div className="flex items-center gap-4 mt-2 mb-1">
                    <span className={`sd-tile${
                        (isPastDue || isExpired) ? ' sd-tile--flash'
                        : status.subscription_status === 'canceled_pending' ? ' sd-tile--warm' : ''}`}>
                        {(isPastDue || isExpired) ? <AlertTriangle size={17} />
                        : status.subscription_status === 'active' ? <CheckCircle2 size={17} />
                        : trialLive ? <Clock size={17} />
                        : status.subscription_status === 'canceled_pending' ? <Clock size={17} />
                        : <Sparkles size={17} />}
                    </span>
                    <div>
                        <div className="flex items-center gap-2.5" style={{ fontFamily: 'var(--cl-font-display)', fontWeight: 600, fontSize: 22, color: 'var(--cl-text)', lineHeight: 1.2 }}>
                            {planName}
                            {isExpired && <span className="sd-chip sd-chip--flash">{hadPro ? 'Pro expired' : 'Trial expired'}</span>}
                            {isPastDue && <span className="sd-chip sd-chip--flash">Payment failed</span>}
                        </div>
                        <div className="text-[12.5px]" style={{ color: 'var(--cl-muted)' }}>
                            {status.subscription_status === 'active' && !isComp && <>Renews on {formatDate(status.current_period_end)}</>}
                            {isComp && (
                                status.comp_expires_at
                                    ? <>Complimentary access until {formatDate(status.comp_expires_at)}. Nothing to pay, and no card on file.</>
                                    : <>Complimentary access, with no expiry. Nothing to pay, and no card on file.</>
                            )}
                            {trialLive && <>Ends {formatDate(status.trial_ends_at)} — {status.trial_days_left} day{status.trial_days_left === 1 ? '' : 's'} left</>}
                            {status.subscription_status === 'canceled_pending' && !isExpired && <>Active until {formatDate(status.current_period_end)} — resubscribe anytime before then to keep access uninterrupted.</>}
                            {isPastDue && <>Retrying your card — see above to fix it now.</>}
                            {isExpired && (hadPro
                                ? <>Your Pro subscription ended {status.current_period_end ? <>on {formatDate(status.current_period_end)}</> : null} — you’re on the free tier now. Text, audio calls, and encrypted backups keep working; video, screen share and big uploads are paused until you resubscribe, and servers you own keep a flat 25 MB of saved storage.</>
                                : <>Your trial ended {status.trial_ends_at ? <>on {formatDate(status.trial_ends_at)}</> : null} — you’re on the free tier now. Text, audio calls, and encrypted backups keep working.</>)}
                            {(status.subscription_status !== 'active' && !trialLive && status.subscription_status !== 'canceled_pending' && !isPastDue && !isExpired) && <>Messaging &amp; audio calls are free. Pro adds video, 2 GB uploads &amp; bigger server storage.</>}
                        </div>
                    </div>
                </div>

                {/* Perks */}
                <div className="mt-3 mb-1">
                    {PRO_PERKS.map(([perk, freeNote]) => (
                        <div key={perk} className="flex items-center gap-2.5 py-1 text-[13px] font-semibold" style={{ color: 'var(--cl-muted)' }}>
                            <Check size={14} style={{ color: 'var(--cl-lume)', flexShrink: 0 }} />
                            <span>{perk} {freeNote && <span style={{ color: 'var(--cl-faint)', fontWeight: 600 }}>({freeNote})</span>}</span>
                        </div>
                    ))}
                    <div className="flex items-center gap-2.5 py-1 text-[13px] font-semibold" style={{ color: 'var(--cl-muted)' }}>
                        <Check size={14} style={{ color: 'var(--cl-lume)', flexShrink: 0 }} />
                        <span>Always: unlimited E2EE messages and no ads — encryption was never the paid part</span>
                    </div>
                </div>

                {/* Actions */}
                <div className="flex flex-wrap items-center gap-3 mt-3">
                    {canUpgrade && (
                        <span ref={heroHostRef} style={{ position: 'relative', display: 'inline-block' }}>
                            <ClButton
                                type="button"
                                variant="primary"
                                className="clb--hero"
                                onClick={() => {
                                    if (heroHostRef.current) celebrate(heroHostRef.current);
                                    openInAppCheckout();
                                }}
                            >
                                {isExpired && hadPro
                                    ? `Resubscribe — ${formatPlanPrice(status.plan_amount, status.plan_currency)}`
                                    : `Go Pro — ${formatPlanPrice(status.plan_amount, status.plan_currency)}`}
                            </ClButton>
                        </span>
                    )}
                    {showExtend && (
                        <ClButton type="button" variant="ghost" onClick={handleExtendTrial} loading={extendBusy}>
                            Extend trial +3 days
                        </ClButton>
                    )}
                    {/* Resume is the prominent action while a cancellation is
                        pending — it's the one thing that undoes it, and only
                        until the paid period runs out. */}
                    {status.subscription_status === 'canceled_pending' && !isExpired && (
                        <ClButton type="button" variant="primary" onClick={() => handleSetCancellation(false)} loading={cancelBusy}>
                            Resume subscription
                        </ClButton>
                    )}
                    {/* Cancel only where there is genuinely a paid subscription
                        to cancel. Not for comps (nothing to cancel), not while
                        past_due (the fix there is the card, and cancelling
                        writes nothing server-side anyway). */}
                    {status.subscription_status === 'active' && !isComp && !confirmCancel && (
                        <ClButton type="button" variant="ghost" onClick={armCancel}>
                            Cancel subscription
                        </ClButton>
                    )}
                </div>

                {/* Confirmation, inline rather than a modal — it's a reversible
                    action with a clear end date, so the copy does the work.

                    Surface: a panel nested inside a .sd-card uses --cl-surface,
                    the design system's inset token. It previously combined
                    `.sd-card--bare` (which strips padding AND border) with an
                    inline --cl-abyss, the PAGE token — darker than the card it
                    sits in, so it read as a black hole punched through the
                    surface with the text flush against its edges. */}
                {confirmCancel && (
                    <div
                        className="rounded-xl p-4"
                        style={{
                            marginTop: 12,
                            background: 'var(--cl-surface)',
                            border: '1px solid var(--cl-border)',
                        }}
                    >
                        <b style={{ fontSize: 14 }}>Cancel your subscription?</b>
                        <p className="text-[13px] leading-relaxed" style={{ color: 'var(--cl-muted)', margin: '6px 0 12px' }}>
                            {cancellationKeepProSentence(status.current_period_end)}
                        </p>

                        <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--cl-faint)', margin: '0 0 12px' }}>
                            Servers you own stay yours on the free tier; they just keep 25 MB of saved
                            storage (anything already saved is kept).
                        </p>

                        <div className="flex flex-wrap items-center gap-2">
                            <ClButton
                                type="button"
                                variant="danger"
                                onClick={() => handleSetCancellation(true)}
                                loading={cancelBusy}
                            >
                                Yes, cancel at period end
                            </ClButton>
                            <ClButton type="button" variant="ghost" onClick={() => setConfirmCancel(false)} disabled={cancelBusy}>
                                Keep my subscription
                            </ClButton>
                        </div>
                    </div>
                )}
                {canUpgrade && (
                    <p className="sd-sub" style={{ margin: '12px 0 0' }}>
                        Renews monthly until cancelled. Cancelling takes two clicks, not a phone call.
                    </p>
                )}
            </div>

            {/* ── Payment method & history ─────────────────────────────────
                Only for accounts that actually have a Stripe customer. A comp
                has none (nothing to show, and every control would be dead), and
                a trial user who has never paid has nothing to list. A LAPSED
                ex-payer keeps their customer, so they still get their receipts. */}
            {hasBillingAccount && (
                <div className="sd-card">
                    <div className="flex items-center justify-between">
                        <h3>Payment method</h3>
                        <ClButton
                            type="button" variant="ghost" icon size="sm"
                            onClick={loadBillingDetails} loading={detailsBusy} tooltip="Refresh"
                        >
                            <RefreshCw size={14} />
                        </ClButton>
                    </div>

                    <div className="sd-row">
                        <div className="sd-rl">
                            <b>{paymentMethod
                                ? `${cardBrandLabel(paymentMethod.brand)} ending ${paymentMethod.last4 ?? '••••'}`
                                : detailsBusy ? 'Checking…' : 'No card on file'}</b>
                            <span>
                                {paymentMethod?.exp_month && paymentMethod?.exp_year
                                    ? `Expires ${String(paymentMethod.exp_month).padStart(2, '0')}/${String(paymentMethod.exp_year).slice(-2)}`
                                    : 'This is the card your renewals are charged to.'}
                            </span>
                        </div>
                        <div className="sd-rc">
                            <ClButton type="button" variant="ghost" size="sm" onClick={() => setCardOpen(true)}>
                                {paymentMethod ? 'Update card' : 'Add card'}
                            </ClButton>
                        </div>
                    </div>

                    <h3 style={{ marginTop: 22 }}>Payment history</h3>
                    {invoices.length === 0 && (
                        <p className="sd-sub" style={{ margin: 0 }}>
                            {detailsBusy ? 'Loading…' : 'No payments yet.'}
                        </p>
                    )}
                    {invoices.map(inv => (
                        <div className="sd-row" key={inv.id}>
                            <div className="sd-rl">
                                <b>{formatMoney(inv.amount_paid || inv.amount_due, inv.currency)}</b>
                                <span>
                                    {formatDate(inv.created)}
                                    {inv.status !== 'paid' && ` · ${inv.status}`}
                                    {inv.number && ` · ${inv.number}`}
                                </span>
                            </div>
                            <div className="sd-rc">
                                {inv.hosted_invoice_url && (
                                    <ClButton
                                        type="button" variant="ghost" size="sm"
                                        onClick={() => openReceipt(inv.hosted_invoice_url!)}
                                    >
                                        Receipt
                                    </ClButton>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* ── Refer a friend ───────────────────────────────────────── */}
            <div className="sd-card">
                <div className="flex items-center gap-3">
                    <span className="sd-tile"><Gift size={16} /></span>
                    <div>
                        <h3 style={{ margin: 0 }}>Refer a friend</h3>
                        <p className="sd-sub" style={{ margin: 0 }}>
                            You both get +7 trial days when they sign up with your code. Up to {maxRef} friends.
                        </p>
                    </div>
                </div>

                {referral === null && referralError ? (
                    <p className="text-[12.5px] text-cl-faint mt-4 mb-0">{referralError}</p>
                ) : referral === null ? (
                    <div className="flex flex-col gap-2 mt-4">
                        <ClSkeleton style={{ width: '100%', height: 40, borderRadius: 10 }} />
                        <ClSkeleton style={{ width: '100%', height: 36, borderRadius: 10 }} />
                    </div>
                ) : (
                    <div className="mt-4">
                        {/* Code row */}
                        <div
                            className="flex items-center gap-2 rounded-lg px-3 py-2 mb-2"
                            style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--cl-border)' }}
                        >
                            <span
                                className="flex-1 font-mono font-bold text-cl-lume text-[15px] select-all"
                                style={{ letterSpacing: '0.2em' }}
                            >
                                {referral.referral_code ?? '—'}
                            </span>
                            <button
                                onClick={handleCopyCode}
                                disabled={!referral.referral_code}
                                className="shrink-0 flex items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors disabled:opacity-40"
                                style={{ color: copied === 'code' ? '#4ade80' : 'var(--cl-lume)', height: 28, background: 'none', border: 'none', cursor: 'pointer' }}
                            >
                                {copied === 'code' ? <><Check size={12} />Copied!</> : <><Copy size={12} />Copy</>}
                            </button>
                        </div>

                        {/* Link row */}
                        <button
                            onClick={handleCopyLink}
                            disabled={!referral.referral_code}
                            className="w-full flex items-center gap-2 rounded-lg px-3 py-2 mb-3 text-left transition-colors hover:bg-white/[0.04] disabled:opacity-40 disabled:pointer-events-none"
                            style={{ border: '1px solid var(--cl-border)', background: 'transparent', cursor: 'pointer' }}
                        >
                            <Link2 size={13} className="shrink-0" style={{ color: 'var(--cl-faint)' }} />
                            <span className="flex-1 text-[12px] truncate" style={{ color: 'var(--cl-muted)' }}>
                                cipherline.chat/ref/{referral.referral_code ?? '…'}
                            </span>
                            <span
                                className="shrink-0 text-[11px] font-medium"
                                style={{ color: copied === 'link' ? '#4ade80' : 'var(--cl-lume)' }}
                            >
                                {copied === 'link' ? 'Copied!' : 'Copy link'}
                            </span>
                        </button>

                        {/* Progress */}
                        <div className="flex flex-col gap-1.5">
                            <div className="flex justify-between items-center">
                                <span className="text-[12px]" style={{ color: 'var(--cl-muted)' }}>{refCount} of {maxRef} friends referred</span>
                                {daysEarned > 0 && (
                                    <span className="text-[12px] font-medium" style={{ color: 'var(--cl-ok)' }}>+{daysEarned} free trial days earned</span>
                                )}
                            </div>
                            <div className="rounded-full overflow-hidden" style={{ height: 5, background: '#0A1120', boxShadow: 'inset 0 1px 2px rgba(0,0,0,.6)' }}>
                                <motion.div
                                    className="h-full rounded-full"
                                    style={{ background: 'linear-gradient(90deg,var(--cl-lume-deep),var(--cl-lume))' }}
                                    initial={{ width: 0 }}
                                    animate={{ width: `${Math.min(100, (refCount / maxRef) * 100)}%` }}
                                    transition={{ duration: 0.6, ease: 'easeOut' }}
                                />
                            </div>
                        </div>
                    </div>
                )}
            </div>

            <UpdateCardModal
                open={cardOpen}
                onClose={() => setCardOpen(false)}
                onUpdated={() => {
                    setCardOpen(false);
                    pushToast({ kind: 'success', message: 'Card updated — your next renewal will use it.' });
                    void loadBillingDetails();
                    // A past-due account becomes payable again the moment the
                    // card is good, and Stripe retries on its own schedule —
                    // re-read status so the banner clears as soon as it does.
                    void refresh();
                }}
            />
        </>
    );
};
