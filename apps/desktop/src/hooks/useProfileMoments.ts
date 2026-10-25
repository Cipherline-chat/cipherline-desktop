import { useEffect, useRef } from 'react';
import secureLocalStore from '../utils/secureLocalStore';
import { invalidateProfile } from '../utils/profileCache';
import { shouldCelebrateHighFive } from '../utils/profileExtras';
import {
    HIGH_FIVE_EVENT, HIGH_FIVE_PLAY_EVENT, anniversariesKey, anniversaryToastText, dueAnniversaries, parseLedger,
    registerFriendsSince, type FriendRow, type HighFiveEventDetail,
} from '../utils/profileMoments';

interface Options {
    userId: string | null | undefined;
    /** Accepted friends from GET /v1/friends (null until loaded). */
    accepted: readonly FriendRow[] | null;
    /** Do Not Disturb right now (manual, schedule or auto triggers). */
    isDnd: () => boolean;
    pushToast: (t: { kind?: 'info' | 'success'; title?: string; message: string }) => void;
}

/**
 * Friend-anniversary toast (once per friend per year, when the app opens on
 * the day) and the incoming high-five. A high-five always updates the count;
 * under Do Not Disturb that is ALL it does (no toast, no animation).
 */
export function useProfileMoments({ userId, accepted, isDnd, pushToast }: Options): void {
    const dndRef = useRef(isDnd);
    const toastRef = useRef(pushToast);
    useEffect(() => { dndRef.current = isDnd; toastRef.current = pushToast; });

    useEffect(() => { if (accepted) registerFriendsSince(accepted); }, [accepted]);

    // Anniversary: once per session, as soon as the friends list is in.
    const doneFor = useRef<string | null>(null);
    useEffect(() => {
        if (!userId || !accepted || accepted.length === 0 || doneFor.current === userId) return;
        let cancelled = false;
        void secureLocalStore.whenAccountReady().catch(() => undefined).then(() => {
            if (cancelled) return;
            const now = new Date();
            const ledger = parseLedger(secureLocalStore.getItem(anniversariesKey(userId)));
            const due = dueAnniversaries(accepted, now, ledger);
            const text = anniversaryToastText(due);
            // Under DND stay silent and leave the ledger alone: the toast
            // comes the next time the app opens today.
            if (text && dndRef.current()) return;
            doneFor.current = userId;
            if (!text) return;
            toastRef.current({ kind: 'success', title: 'Friendiversary', message: text });
            for (const d of due) ledger[d.user_id] = now.getFullYear();
            try { secureLocalStore.setItem(anniversariesKey(userId), JSON.stringify(ledger)); } catch { /* non-fatal */ }
        });
        return () => { cancelled = true; };
    }, [userId, accepted]);

    useEffect(() => {
        if (!userId) return;
        const onFive = (e: Event) => {
            const d = (e as CustomEvent<HighFiveEventDetail>).detail;
            if (!d) return;
            invalidateProfile(userId); // the count moved
            if (!shouldCelebrateHighFive(dndRef.current(), null)) return;
            window.dispatchEvent(new CustomEvent(HIGH_FIVE_PLAY_EVENT, { detail: d }));
            toastRef.current({ kind: 'info', message: `${d.from_username || 'Someone'} high-fived you` });
        };
        window.addEventListener(HIGH_FIVE_EVENT, onFive);
        return () => window.removeEventListener(HIGH_FIVE_EVENT, onFive);
    }, [userId]);
}
