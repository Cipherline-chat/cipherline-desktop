/**
 * Keeps this device's listening-cover ACTIVITY KEY with every accepted friend
 * (utils/integrations/activityKeys.ts), end to end encrypted, once each - so
 * the covers it uploads (utils/integrations/coverPublisher.ts) can be opened
 * by friends and nobody else.
 *
 * Runs only while "Share what I'm listening to" is on. It also tells the
 * cover publisher who the audience is (setActivityAudience): null while the
 * friends list has not loaded, so no cover is ever encrypted against an
 * unknown list. A change of friends re-runs it; removing / blocking someone
 * who held the key rotates it first (currentActivityKey), and the new key goes
 * to everyone still a friend. Friends without a DM cannot be reached (same as
 * the status-emoji delivery) and keep seeing the catalogue cover.
 *
 * It also hands the session to utils/integrations/friendCover.ts so profile
 * views can fetch and decrypt FRIENDS' covers (no opt-in needed to view).
 */
import { useEffect, useMemo } from 'react';
import { sendFriendControl } from '../utils/friendControlSend';
import { statusEmojiTargets } from '../utils/personalEmoji/statusEmoji';
import { useListeningPrefs } from '../utils/integrations/listeningPrefs';
import { setActivityAudience, shareActivityKey, type KeyShareDeps } from '../utils/integrations/activityKeys';
import { setFriendCoverSession } from '../utils/integrations/friendCover';

const RETRY_MS = 30_000;
const MAX_ATTEMPTS = 5;
/** A slow re-check: a no-op without network unless a delivery is owed (or the key aged out). */
const RECHECK_MS = 10 * 60_000;

interface Args {
    token: string | null | undefined;
    deviceId: string | null | undefined;
    userId: string | null | undefined;
    /** Accepted friends; null while not loaded. */
    friendIds: readonly string[] | null;
    /** DM conversations: the friend each one is with. */
    dms: readonly { conversationId: string; otherUserId: string | null | undefined }[];
}

export function useActivityKeyShare({ token, deviceId, userId, friendIds, dms }: Args): void {
    const prefs = useListeningPrefs(userId);
    const friendsKey = friendIds ? [...friendIds].sort().join('|') : null;
    const targets = useMemo(() => statusEmojiTargets(friendIds ?? [], dms), [friendIds, dms]);
    const targetsKey = useMemo(() => targets.map(t => `${t.userId}:${t.conversationId}`).sort().join('|'), [targets]);

    // Viewing friends' covers needs no opt-in: the session lets profile views fetch them.
    useEffect(() => {
        setFriendCoverSession(token && userId ? { token, userId } : null);
        return () => setFriendCoverSession(null);
    }, [token, userId]);

    // The publisher's audience: only while sharing, and only a KNOWN friends list.
    useEffect(() => {
        setActivityAudience(prefs.share && userId && friendIds ? friendIds : null);
        return () => setActivityAudience(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [prefs.share, userId, friendsKey]);

    useEffect(() => {
        if (!prefs.share || !token || !deviceId || !userId || !friendIds) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const deps: KeyShareDeps = {
            now: () => Date.now(),
            sleep: ms => new Promise(r => setTimeout(r, ms)),
            newId: () => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `ak-${Date.now()}`),
            cancelled: () => cancelled,
            send: (target, content) => sendFriendControl(target, content, { token, deviceId, userId }),
        };
        const run = async (attempt: number) => {
            const outcome = await shareActivityKey(userId, friendIds, targets, deps).catch(() => ({ retry: false }));
            if (cancelled) return;
            const again = outcome.retry && attempt < MAX_ATTEMPTS;
            timer = setTimeout(() => { void run(again ? attempt + 1 : 1); }, again ? RETRY_MS : RECHECK_MS);
        };
        void run(1);
        return () => { cancelled = true; if (timer) clearTimeout(timer); };
        // Lists are represented by their keys: a refetch with the same people must not restart a run.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [prefs.share, token, deviceId, userId, friendsKey, targetsKey]);
}
