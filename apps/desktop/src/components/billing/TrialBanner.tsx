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
 * Both render through the shared ClBanner primitive. Dismissal state is
 * per-user and lives in secureLocalStore (never raw localStorage — see
 * CLAUDE.md).
 */
import React, { useState } from 'react';
import { useSubscription } from '../../contexts/SubscriptionContext';
import { UpdateCardModal } from './UpdateCardModal';
import { useAuth } from '../../contexts/AuthContext';
import { Clock, AlertTriangle } from 'lucide-react';
import { ClBanner } from '../ClBanner';
import secureLocalStore from '../../utils/secureLocalStore';
import { formatPlanPrice } from '@cipherline/shared';
import { isTrialBannerEligible } from './trialBannerRule';

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
            <ClBanner
                id="billing-past-due"
                tone="danger"
                priority={90}
                icon={<AlertTriangle size={15} />}
                title="Your last payment failed"
                description={<>
                    Update your card to keep your subscription active.
                    {error && <span className="ml-2" style={{ color: 'var(--cl-flash)' }}>{error}</span>}
                </>}
                actions={[{
                    key: 'update-payment',
                    label: 'Update payment',
                    variant: 'danger',
                    onClick: () => { setError(''); setCardOpen(true); },
                }]}
                dismissLabel="Dismiss"
                onDismiss={() => {
                    // Count the dismissal, not the render — otherwise a
                    // relaunch would burn a "show" the user never acted on.
                    write(pastDueKey(userId), String(shown + 1));
                    setDismissTick(t => t + 1);
                }}
            />
            <UpdateCardModal
                open={cardOpen}
                onClose={() => setCardOpen(false)}
                onUpdated={() => { setCardOpen(false); refresh().catch(() => { /* statusError is recorded by the context */ }); }}
            />
            </>
        );
    }

    // ── Trial ending ──────────────────────────────────────────────────────
    // Only the last 3 days, and only while the trial is genuinely still live.
    // effective_status is the authority on "still live" — subscription_status
    // stays 'trial' forever after a trial lapses.
    if (!isTrialBannerEligible(status)) return null;

    const daysLeft = status.trial_days_left;
    if (daysLeft > 3) return null;

    // Dismissed today already? Come back tomorrow.
    if (read(trialKey(userId)) === today()) return null;

    // The last day is amber and ranks higher; before that it is a calm teal nudge.
    const urgent = daysLeft <= 1;

    return (
        <ClBanner
            id="billing-trial"
            tone={urgent ? 'warning' : 'info'}
            priority={urgent ? 64 : 50}
            icon={<Clock size={15} />}
            data={{ 'dismiss-tick': String(dismissTick) }}
            title={daysLeft <= 0
                ? 'Your trial ends today'
                : daysLeft === 1
                ? 'Your trial ends tomorrow'
                : `${daysLeft} days left in your trial`}
            description={<>
                Keep video, screen share and 2 GB uploads with Pro.
                {error && <span className="ml-2" style={{ color: 'var(--cl-flash)' }}>{error}</span>}
            </>}
            actions={[
                ...(!status.trial_extended ? [{
                    key: 'extend',
                    label: '+3 days',
                    variant: 'ghost' as const,
                    tooltip: 'Need more time? Extend your trial by 3 days',
                    loading: extending,
                    disabled: extending,
                    onClick: async () => {
                        setExtending(true); setError(null);
                        const r = await extendTrial();
                        setExtending(false);
                        if (!r.ok) setError(r.message || 'Could not extend.');
                    },
                }] : []),
                {
                    key: 'price',
                    node: <span className="cl-banner__meta">{formatPlanPrice(status?.plan_amount, status?.plan_currency)}</span>,
                },
                {
                    key: 'upgrade',
                    label: 'Upgrade',
                    variant: 'primary',
                    onClick: () => openInAppCheckout(),
                },
            ]}
            dismissLabel="Dismiss until tomorrow"
            onDismiss={() => {
                write(trialKey(userId), today());
                setDismissTick(t => t + 1);
            }}
        />
    );
};

export default TrialBanner;
