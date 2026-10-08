/**
 * stopWatchingScreenshare — the inverse of ScreenShareGate's "Watch" click.
 *
 * Screen shares are opt-in to view: `ScreenShareGate.handleWatch` calls
 * `setSubscribed(true)` on the share's video (+ share-audio) publications and
 * adds the publisher to SidebarConference's `subscribedScreenshares` set. That
 * set is the ONE source of truth for three things at once:
 *
 *   1. which tiles render a live VideoTile vs. the Watch gate,
 *   2. the auto-resubscribe effect (it only re-takes subscriptions for ids in
 *      the set), and
 *   3. the viewer list — SidebarConference publishes the set into the local
 *      participant's LiveKit metadata (`watching_shares`, see
 *      utils/screenShareViewers.ts) and every other client folds the roster to
 *      get the per-publisher count.
 *
 * So "stop watching" is: drop the id from the set (which removes this client
 * from the sharer's viewer list via the existing metadata effect and returns
 * the tile to the Watch gate), unsubscribe the LiveKit tracks (which stops the
 * bytes), and close any focus/fullscreen stage that was showing that share.
 * The pieces below are the pure parts of that, kept out of the 5k-line
 * SidebarConference so they can be tested directly.
 */
import { Track } from 'livekit-client';

/** Structural slice of a LiveKit RemoteParticipant — lets tests pass plain objects. */
export interface ShareParticipantLike {
    // `unknown`: LiveKit types this as the base TrackPublication, which has no
    // setSubscribed (only RemoteTrackPublication does) — narrowed at the call.
    getTrackPublication(source: Track.Source): unknown;
}

export interface FocusedStreamLike {
    identity: string;
    source: Track.Source;
}

/**
 * Whether a tile gets the stop-watching control: a REMOTE screen-share tile,
 * with a handler wired (i.e. one this client can actually be watching — the
 * live VideoTile only exists for subscribed shares). Never on cameras, never
 * on your own share.
 */
export function canStopWatching(opts: {
    source: Track.Source;
    isLocal: boolean;
    onStopWatching?: (() => void) | undefined;
}): boolean {
    return opts.source === Track.Source.ScreenShare && !opts.isLocal && typeof opts.onStopWatching === 'function';
}

export function stopWatchingAriaLabel(name: string): string {
    return `Stop watching ${name}'s screen`;
}

/** New subscribed-set with `identity` removed; returns the SAME set when absent (no re-render). */
export function withoutIdentity(prev: ReadonlySet<string>, identity: string): Set<string> {
    if (!prev.has(identity)) return prev as Set<string>;
    const next = new Set(prev);
    next.delete(identity);
    return next;
}

/** Focus after stopping `identity`'s share: closes it iff that share was the focused stream. */
export function focusAfterStopWatching<T extends FocusedStreamLike>(focused: T | null, identity: string): T | null {
    if (focused && focused.identity === identity && focused.source === Track.Source.ScreenShare) return null;
    return focused;
}

/**
 * Unsubscribe the share's video AND its share-audio track. Failures are
 * swallowed per-track: the subscribed-set (the UI + viewer-list truth) is
 * already updated by the caller, and a track that is mid-republish simply has
 * nothing left to unsubscribe from.
 */
export async function unsubscribeShareTracks(p: ShareParticipantLike): Promise<void> {
    for (const source of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
        try {
            const pub = p.getTrackPublication(source) as { setSubscribed?: (v: boolean) => unknown } | undefined;
            await pub?.setSubscribed?.(false);
        } catch (e) {
            console.warn('[ScreenShare] unsubscribe failed', source, e);
        }
    }
}
