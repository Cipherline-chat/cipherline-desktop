import { useEffect } from 'react';
import { formatUserTag } from '@cipherline/shared';
import { useToast } from '../../contexts/ToastContext';
import { referralRedeemedBus } from '../../utils/referralEvents';

/**
 * The inviter's side: "Sam#1234 joined with your link."
 *
 * A deliberately plain stand-in so the moment is never silent. It renders
 * nothing; it listens for `referral:redeemed` and raises a toast. The new
 * onboarding / first-week nudges replace or extend this by subscribing to
 * `referralRedeemedBus` themselves (utils/referralEvents.ts) — the event
 * carries the new person's public tag and nothing else.
 */
export const ReferralJoinedToast = (): null => {
    const { push } = useToast();
    useEffect(() => referralRedeemedBus.subscribe(ev => {
        push({
            kind: 'success',
            title: 'Your friend joined',
            message: `${formatUserTag(ev.username, ev.discriminator)} joined Cipherline with your link.`,
            durationMs: 8000,
        });
    }), [push]);
    return null;
};

export default ReferralJoinedToast;
