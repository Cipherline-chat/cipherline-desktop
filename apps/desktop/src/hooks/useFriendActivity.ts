import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { friendActivityRecorder } from '../utils/friendActivityStore';
import { observation, type FriendActivityEntry, type ListeningObservation, type PresenceSnapshot } from '../utils/friendActivity';
import { resolveActiveStatus } from '../utils/activeNow';
import { activeCustom } from '../utils/customStatus';
import { listeningStore, type Listening } from '../utils/integrations/listening';
import { HIGH_FIVE_EVENT, type HighFiveEventDetail } from '../utils/profileMoments';
import type { FriendStatusEntry } from '../utils/userStatusModel';

/**
 * Feeds the Friends activity panel's in-memory "Recent" timeline
 * (utils/friendActivityStore.ts) from data this device ALREADY receives —
 * nothing here asks the server for anything. Mounted once in Dashboard so the
 * timeline fills whichever page is open.
 */
export interface FriendActivityRecorderInput {
    userId: string | null;
    /** Accepted friends (GET /friends `accepted`). */
    friendIds: ReadonlySet<string>;
    blockedIds: ReadonlySet<string>;
    /** The friends list has loaded at least once (not the empty initial state). */
    friendsLoaded: boolean;
    friendStatuses: Record<string, FriendStatusEntry | undefined>;
    presence: Record<string, boolean | undefined>;
    /** Bumps on every WS (re)connect: the seeds that follow are a baseline. */
    wsConnectCount: number;
    avatarUpdatedEvent?: { user_id: string } | null;
    usernameUpdatedEvent?: { user_id: string; username: string } | null;
}

/** Friends' current presence picture, resolved: offline friends carry nothing. */
export function buildPresenceSnapshot(
    friendIds: ReadonlySet<string>,
    statuses: Record<string, FriendStatusEntry | undefined>,
    presence: Record<string, boolean | undefined>,
    now: number,
): PresenceSnapshot {
    const out: PresenceSnapshot = {};
    for (const id of friendIds) {
        const e = statuses[id];
        const present = resolveActiveStatus(id, statuses, presence) !== 'offline';
        const custom = e ? activeCustom(e.custom_status_text, e.custom_status_emoji, e.custom_status_expires_at, now) : null;
        out[id] = observation(present, e?.on_mobile ? null : e?.current_game, custom?.text, custom?.emoji);
    }
    return out;
}

/** What present friends are listening to / watching (never yourself, never an expired record). */
export function buildListeningSnapshot(
    all: ReadonlyMap<string, Listening>,
    friendIds: ReadonlySet<string>,
    isPresent: (id: string) => boolean,
    now: number,
): Map<string, ListeningObservation> {
    const out = new Map<string, ListeningObservation>();
    for (const [id, l] of all) {
        if (!friendIds.has(id) || l.endsAt <= now || !isPresent(id)) continue;
        out.set(id, { kind: l.kind, track: l.track, artist: l.artist });
    }
    return out;
}

export function useFriendActivityRecorder(input: FriendActivityRecorderInput): void {
    const { userId, friendIds, blockedIds, friendsLoaded, friendStatuses, presence, wsConnectCount, avatarUpdatedEvent, usernameUpdatedEvent } = input;
    const rec = friendActivityRecorder;

    // A different account (or sign-out) starts from nothing.
    useEffect(() => {
        rec.clear();
        rec.beginSettle(Date.now());
        return () => rec.clear();
    }, [rec, userId]);

    useEffect(() => { rec.beginSettle(Date.now()); }, [rec, wsConnectCount]);

    // userId: after an account switch's clear(), re-apply the (possibly identical) list.
    useEffect(() => { rec.setFriends(friendIds, blockedIds, Date.now(), friendsLoaded); }, [rec, userId, friendIds, blockedIds, friendsLoaded]);

    const presentRef = useRef<(id: string) => boolean>(() => false);
    const friendIdsRef = useRef(friendIds);
    useEffect(() => {
        presentRef.current = (id: string) => resolveActiveStatus(id, friendStatuses, presence) !== 'offline';
        friendIdsRef.current = friendIds;
    }, [friendIds, friendStatuses, presence]);

    useEffect(() => {
        rec.observePresence(buildPresenceSnapshot(friendIds, friendStatuses, presence, Date.now()), Date.now());
    }, [rec, userId, friendIds, friendStatuses, presence]);

    // Listening / watching: the store changes on its own (WS events, expiry).
    useEffect(() => {
        const look = () => {
            const now = Date.now();
            rec.observeListening(buildListeningSnapshot(listeningStore.all(), friendIdsRef.current, presentRef.current, now), now);
        };
        look();
        return listeningStore.subscribe(look);
    // Presence changes re-run it so a friend who comes online mid-song is a baseline, not a missed change.
    }, [rec, friendIds, friendStatuses, presence]);

    // High fives are pushed, never stored server-side (useRealtime -> window event).
    useEffect(() => {
        const onFive = (ev: Event) => {
            const d = (ev as CustomEvent<HighFiveEventDetail>).detail;
            if (!d || typeof d.from_user_id !== 'string') return;
            rec.record({ userId: d.from_user_id, kind: 'high_five', at: Date.now(), count: 1 }, Date.now());
        };
        window.addEventListener(HIGH_FIVE_EVENT, onFive);
        return () => window.removeEventListener(HIGH_FIVE_EVENT, onFive);
    }, [rec]);

    useEffect(() => {
        if (!avatarUpdatedEvent?.user_id) return;
        rec.record({ userId: avatarUpdatedEvent.user_id, kind: 'avatar', at: Date.now() }, Date.now());
    }, [rec, avatarUpdatedEvent]);

    useEffect(() => {
        if (!usernameUpdatedEvent?.user_id || !usernameUpdatedEvent.username) return;
        rec.record({ userId: usernameUpdatedEvent.user_id, kind: 'renamed', at: Date.now(), title: usernameUpdatedEvent.username.slice(0, 64) }, Date.now());
    }, [rec, usernameUpdatedEvent]);
}

/** The raw timeline (filter it with selectFeed before drawing). */
export function useFriendActivityFeed(): readonly FriendActivityEntry[] {
    return useSyncExternalStore(friendActivityRecorder.subscribe, friendActivityRecorder.getSnapshot, friendActivityRecorder.getSnapshot);
}

/** Ticks every `ms` while mounted: relative times ("4m") stay honest. */
export function useNowTick(ms = 30_000): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = window.setInterval(() => setNow(Date.now()), ms);
        return () => window.clearInterval(t);
    }, [ms]);
    return now;
}
