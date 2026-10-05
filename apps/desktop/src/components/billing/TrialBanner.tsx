/**
 * TrialBanner — the two dismissible status banners across the top of the
 * Dashboard. Deliberately narrow: this is a nudge, never a nag.
 *
 *   1. Trial ending — appears only in the last 3 days of a trial. Dismissible;
 *      returns once per day after that. Once the trial has actually ended it
 *      never appears again (the free tier is a legitimate place to sit, and a
 *      permanent upsell banner is the thing people mute the app over).
 *
 *   2. Payment failed (past_due) — its own banner, because this one is not a
 *      nudge: their card failed and access lapses when dunning gives up.
 *      Dismissible, but it comes back at most twice more (3 appearances total)
 *      so it can't be permanently silenced by accident, and can't nag forever.
 *
 * Dismissal state is per-user and lives in secureLocalStore (never raw
 * localStorage — see CLAUDE.md).
 */
import React, { useState } from 'react';
import { useSubscription } from '../../contexts/SubscriptionContext';
import { UpdateCardModal } from './UpdateCardModal';
import { useAuth } from '../../contexts/AuthContext';
import { Clock, AlertTriangle, X } from 'lucide-react';
import { ClButton } from '../cl';
import secureLocalStore from '../../utils/secureLocalStore';
import { formatPlanPrice } from '@cipherline/shared';

/** Local calendar day, as YYYY-MM-DD. Local (not UTC) so "comes back the next
 *  day" matches the user's own sense of a day rolling over. */
function today(): string {
    const d = new Date();
    const m = `${d.getMonth() + 1}`.padStart(2, '0');
    const day = `${d.getDate()}`.padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
}

/** Max times the payment-failed banner may reappear after being dismissed. */
const PAST_DUE_MAX_SHOWS = 3;

const trialKey = (uid: string) => `cipherline_trial_banner_dismissed_${uid}`;
const pastDueKey = (uid: string) => `cipherline_pastdue_banner_shows_${uid}`;

function read(key: string): string | null {
    try { return secureLocalStore.getItem(key); } catch { return null; }
}
function write(key: string, value: string): void {
    try { secureLocalStore.setItem(key, value); } catch { /* non-fatal */ }
}

export const TrialBanner: React.FC = () => {
    const { status, extendTrial, openInAppCheckout, refresh } = useSubscription();
    // Fixing the card is the whole point of this banner, so it opens right here
    // rather than sending the user off to hunt through settings.
    const [cardOpen, setCardOpen] = useState(false);
    const { userId } = useAuth();
    const [extending, setExtending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Bumped on dismiss so the component re-reads the persisted state.
    const [dismissTick, setDismissTick] = useState(0);

    if (!status || !userId) return null;

    // ── Payment failed ────────────────────────────────────────────────────
    // Checked before the trial banner: a failed payment is the more urgent of
    // the two, and they can't both apply anyway.
    if (status.subscription_status === 'past_due') {
        const shown = parseInt(read(pastDueKey(userId)) ?? '0', 10) || 0;
        if (shown >= PAST_DUE_MAX_SHOWS) return null;
        return (
            <>
            <div className="w-full px-4 py-2.5 bg-orange-500/15 border-b border-orange-500/30 text-orange-300 text-sm flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                    <AlertTriangle size={15} className="shrink-0" />
                    <span className="truncate">Your last payment failed. Update your card to keep your subscription active.</span>
                    {error && <span className="text-red-400 ml-2 shrink-0">{error}</span>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <ClButton
                        type="button"
                        variant="danger"
                        size="sm"
                        onClick={() => { setError(''); setCardOpen(true); }}
                    >
                        Update payment
                    </ClButton>
                    <ClButton
                        type="button"
                        icon
                        variant="ghost"
                        size="sm"
                        tooltip="Dismiss"
                        onClick={() => {
                            // Count the dismissal, not the render — otherwise a
                            // relaunch would burn a "show" the user never acted on.
                            write(pastDueKey(userId), String(shown + 1));
                            setDismissTick(t => t + 1);
                        }}
                    >
                        <X size={13} />
                    </ClButton>
                </div>
            </div>
            <UpdateCardModal
                open={cardOpen}
                onClose={() => setCardOpen(false)}
                onUpdated={() => { setCardOpen(false); void refresh(); }}
            />
            </>
        );
    }

    // ── Trial ending ──────────────────────────────────────────────────────
    // Only the last 3 days, and only while the trial is genuinely still live.
    // effective_status is the authority on "still live" — subscription_status
    // stays 'trial' forever after a trial lapses.
    if (status.subscription_status !== 'trial' || status.effective_status !== 'active') return null;

    const daysLeft = status.trial_days_left;
    if (daysLeft > 3) return null;

    // Dismissed today already? Come back tomorrow.
    if (read(trialKey(userId)) === today()) return null;

    const tone = daysLeft <= 1
        ? 'bg-orange-500/15 border-orange-500/30 text-orange-300'
        : 'bg-yellow-500/15 border-yellow-500/30 text-yellow-300';

    return (
        <div className={`w-full px-4 py-2.5 border-b ${tone} text-sm flex items-center justify-between gap-3`} data-dismiss-tick={dismissTick}>
            <div className="flex items-center gap-2 min-w-0">
                <Clock size={15} className="shrink-0" />
                <span className="truncate">
                    {daysLeft <= 0
                        ? 'Your free trial ends today.'
                        : daysLeft === 1
                        ? 'Your free trial ends tomorrow.'
                        : `${daysLeft} days left in your free trial.`}
                </span>
                {error && <span className="text-red-400 ml-2 shrink-0">{error}</span>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
                {!status.trial_extended && (
                    <ClButton
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                            setExtending(true); setError(null);
                            const r = await extendTrial();
                            setExtending(false);
                            if (!r.ok) setError(r.message || 'Could not extend.');
                        }}
                        disabled={extending}
                        loading={extending}
                    >
                        Need more time? +3 days
                    </ClButton>
                )}
                <ClButton type="button" variant="primary" size="sm" onClick={() => openInAppCheckout()}>
                    Upgrade — {formatPlanPrice(status?.plan_amount, status?.plan_currency)}
                </ClButton>
                <ClButton
                    type="button"
                    icon
                    variant="ghost"
                    size="sm"
                    tooltip="Dismiss until tomorrow"
                    onClick={() => {
                        write(trialKey(userId), today());
                        setDismissTick(t => t + 1);
                    }}
                >
                    <X size={13} />
                </ClButton>
            </div>
        </div>
    );
};

export default TrialBanner;
