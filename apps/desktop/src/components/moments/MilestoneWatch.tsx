import React, { useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { CALL_CONNECTED_EVENT, noteCallConnected } from '../../utils/milestones';

/**
 * Counts the calls that connect (the 100th earns a moment, and a new
 * account's first earns another). CallPane announces "the media room
 * connected" on window; this is the one place that knows whose account it is.
 * Reads your user id (the counter's key) and your account's creation date —
 * nothing about the call itself. Renders nothing.
 */
export const MilestoneWatch: React.FC = () => {
    const { user } = useAuth();
    const uid = user?.user_id ?? null;
    const created = user?.created_at ?? null;
    useEffect(() => {
        const on = () => noteCallConnected(uid, created);
        window.addEventListener(CALL_CONNECTED_EVENT, on);
        return () => window.removeEventListener(CALL_CONNECTED_EVENT, on);
    }, [uid, created]);
    return null;
};

export default MilestoneWatch;
