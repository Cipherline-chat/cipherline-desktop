import { useCallback, useEffect, useState } from 'react';
import { readNudgeState, subscribeNudgeState, updateNudgeState } from '../utils/firstWeekNudgeStore';

/**
 * The "Getting-started tips" switch (Settings → Notifications). It is the same
 * flag as the "Don't show these" link on the nudge card — one `off` in the
 * account's nudge state — and it covers both the first-week nudges and the
 * one-time save-a-message coach mark. Reads follow changes made elsewhere.
 */
export function useNudgeOffSwitch(userId: string | null | undefined): [enabled: boolean, setEnabled: (on: boolean) => void] {
    const [enabled, setEnabledState] = useState(true);

    useEffect(() => {
        if (!userId) return;
        const read = () => setEnabledState(!readNudgeState(userId).off);
        read();
        return subscribeNudgeState(read);
    }, [userId]);

    const setEnabled = useCallback((on: boolean) => {
        if (!userId) return;
        updateNudgeState(userId, s => ({ ...s, off: !on }));
        setEnabledState(on);
    }, [userId]);

    return [enabled, setEnabled];
}
