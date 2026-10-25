import React, { useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { getHasActiveCall } from '../../utils/activeCallRegistry';
import { clockMoments, msUntilNewYear, nyeCallDue, requestMoment } from '../../utils/moments';

/** When this renderer started — "the app has been open for 12 hours". */
const OPEN_SINCE = Date.now();
const CHECK_MS = 60_000;

/**
 * The clock-driven moments: New Year's Day, your account's anniversary, Feb 29,
 * Pi Day, and the coffee after 12 hours open — plus New Year's midnight while
 * you are in a call. Checks once a minute (and once at start); the host makes
 * the ambient ones wait for a quiet moment and the ledger keeps each to once a
 * day / once a week. Midnight itself is too exact for a minute tick that may be
 * throttled, so in the last two minutes of December 31st a timer is armed for
 * the second itself (the minute tick is the backstop). Reads the clock, whether
 * a call is live (a flag) and your own account's creation date — nothing else.
 * Renders nothing.
 */
export const MomentClock: React.FC<{ openSince?: number }> = ({ openSince = OPEN_SINCE }) => {
    const { user } = useAuth();
    const created = user?.created_at ?? null;
    useEffect(() => {
        let midnight: number | null = null;
        const check = () => {
            const now = new Date();
            for (const id of clockMoments(now, openSince, created)) requestMoment(id);
            if (nyeCallDue(now, getHasActiveCall())) requestMoment('nye-call');
            const ms = msUntilNewYear(now);
            if (midnight === null && ms > 0 && ms <= 2 * CHECK_MS) {
                midnight = window.setTimeout(() => {
                    midnight = null;
                    if (nyeCallDue(new Date(), getHasActiveCall())) requestMoment('nye-call');
                }, ms + 50);
            }
        };
        check();
        const t = window.setInterval(check, CHECK_MS);
        return () => { window.clearInterval(t); if (midnight !== null) window.clearTimeout(midnight); };
    }, [openSince, created]);
    return null;
};

export default MomentClock;
