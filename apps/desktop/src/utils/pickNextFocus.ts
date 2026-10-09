import { Track } from 'livekit-client';

/**
 * Auto-advance for the in-call focused view.
 *
 * When the stream you have focused ends — the sharer stops sharing, a camera
 * is switched off, the participant leaves — the focused pane used to sit there
 * showing that person's avatar. This module decides what should happen instead:
 * hand the focus to another live video, or give up so the caller can drop the
 * focused pane and return the user to the plain chat layout.
 *
 * Everything here is deliberately data-only (no LiveKit objects beyond the
 * `Track.Source` enum, no React) so the selection rule is testable in isolation.
 */

/** The only two sources that can ever be focused. */
export type FocusSource = Track.Source.Camera | Track.Source.ScreenShare;

/** A stream identified the way `CallContext.focusedStream` identifies it. */
export interface FocusRef {
    identity: string;
    source: FocusSource;
}

export interface FocusCandidate extends FocusRef {
    /**
     * Publish order, as tracked by {@link PublishOrder}. Higher = published
     * more recently. Not a wall-clock timestamp — LiveKit does not expose one
     * we can trust, so this is a monotonic sequence assigned the first time we
     * see a publication go live.
     */
    publishedAt: number;
    /** True for the local user's own camera / screen share. */
    isLocal: boolean;
}

/** Structural stand-in for a LiveKit `TrackPublication`. */
export interface PublicationLike {
    isMuted: boolean;
    track?: unknown;
}

/** Structural stand-in for a LiveKit `Participant`. */
export interface ParticipantLike {
    identity: string;
    isLocal: boolean;
    isCameraEnabled?: boolean;
    getTrackPublication(source: FocusSource): PublicationLike | undefined;
}

/** Both focusable sources, screen share first — the order matters to `pickNextFocus`. */
export const FOCUSABLE_SOURCES: readonly FocusSource[] = [
    Track.Source.ScreenShare,
    Track.Source.Camera,
];

/** Ledger key. A NUL separator can't occur in an identity, so this can't collide. */
export const focusKey = (identity: string, source: FocusSource): string =>
    `${identity}\u0000${source}`;

/**
 * Is this participant's `source` actually showing live video right now?
 *
 * Mirrors — and slightly widens — the liveness test the focused pane used
 * before this module existed:
 *  - no publication at all, or a muted one, is not live. A *muted camera* is
 *    the "they turned their video off" case that used to leave the focused
 *    pane showing an avatar, so it counts as gone;
 *  - a publication with no `track` yet is not live either, EXCEPT for a local
 *    camera the participant still reports as enabled — that gap is the
 *    momentary hole during a camera device switch, and tearing focus down
 *    there would be a visible flicker for no reason.
 */
export function isStreamLive(p: ParticipantLike, source: FocusSource): boolean {
    const pub = p.getTrackPublication(source);
    if (!pub) return false;
    if (pub.isMuted) return false;
    if (pub.track) return true;
    return source === Track.Source.Camera && p.isCameraEnabled === true;
}

/**
 * Remembers the order in which streams went live.
 *
 * A key is assigned an increasing sequence the first time it is seen live, and
 * *forgotten* once it stops being live — so a re-publish (Change Source, camera
 * swap) reads as freshly published rather than keeping its original position.
 */
export class PublishOrder {
    private seq = 0;
    private seen = new Map<string, number>();

    /** Reconcile the ledger against the set of currently-live keys. */
    observe(liveKeys: readonly string[]): void {
        const live = new Set(liveKeys);
        for (const key of liveKeys) {
            if (!this.seen.has(key)) this.seen.set(key, ++this.seq);
        }
        for (const key of Array.from(this.seen.keys())) {
            if (!live.has(key)) this.seen.delete(key);
        }
    }

    /** Sequence for a key, or 0 if it has never been seen live. */
    get(key: string): number {
        return this.seen.get(key) ?? 0;
    }
}

export interface HiddenStreams {
    /** Identities whose camera the local viewer has hidden via the popover. */
    video: ReadonlySet<string>;
    /** Identities whose screen share the local viewer has hidden. */
    screenShare: ReadonlySet<string>;
}

const NOTHING_HIDDEN: HiddenStreams = { video: new Set(), screenShare: new Set() };

/**
 * Walk the room and return every stream that could be focused right now,
 * updating `order` as a side effect so publish order stays accurate.
 *
 * Hidden streams are excluded from the returned candidates but still tracked in
 * the ledger — un-hiding one should not make it look brand new.
 *
 * `watchedShares`, when given, is the viewer's Watch set: a REMOTE screen share
 * outside it is not a candidate either (also still tracked in the ledger).
 * Without this, "has a live track" was the whole test — and the room's
 * autoSubscribe gives every share a track — so when the focused stream ended
 * the stage could jump to a share the viewer never opened and play its audio
 * (utils/screenShareAudioWatch.ts). Your own share is not gated by it.
 */
export function collectFocusCandidates(
    participants: readonly ParticipantLike[],
    order: PublishOrder,
    hidden: HiddenStreams = NOTHING_HIDDEN,
    watchedShares?: ReadonlySet<string>,
): FocusCandidate[] {
    const liveKeys: string[] = [];
    const candidates: FocusCandidate[] = [];

    for (const p of participants) {
        for (const source of FOCUSABLE_SOURCES) {
            if (!isStreamLive(p, source)) continue;
            const key = focusKey(p.identity, source);
            liveKeys.push(key);
            const isHidden = source === Track.Source.Camera
                ? hidden.video.has(p.identity)
                : hidden.screenShare.has(p.identity);
            if (isHidden) continue;
            if (!isFocusableShare(p, source, watchedShares)) continue;
            candidates.push({
                identity: p.identity,
                source,
                publishedAt: 0, // filled in below, once the ledger is current
                isLocal: p.isLocal,
            });
        }
    }

    order.observe(liveKeys);
    for (const c of candidates) {
        c.publishedAt = order.get(focusKey(c.identity, c.source));
    }
    return candidates;
}

/**
 * May `source` of `p` be focused, given the viewer's Watch set? Cameras and
 * your own share always; a remote share only while watched. With no set (the
 * caller has no notion of watching) everything passes, as before.
 */
export function isFocusableShare(
    p: Pick<ParticipantLike, 'identity' | 'isLocal'>,
    source: FocusSource,
    watchedShares?: ReadonlySet<string>,
): boolean {
    if (source !== Track.Source.ScreenShare || p.isLocal || !watchedShares) return true;
    return watchedShares.has(p.identity);
}

/**
 * Choose what to focus once `losing` has ended, or `null` to drop focus and
 * return the user to the ordinary chat layout.
 *
 * The rule, in order:
 *   1. Never re-pick the stream that just ended.
 *   2. Never pick the local user's own camera or screen share. The ask was
 *      "if there is another video member in the call, focus that one" — your
 *      own preview is not another member, and blowing it up full-size when
 *      someone else's share stops is not what anyone means. If your stream is
 *      all that is left, focus closes.
 *   3. A screen share beats a camera. Someone sharing their screen is almost
 *      always the thing worth the big pane.
 *   4. Within a tier, the most recently published stream wins — the newest
 *      thing on screen is the one the room's attention just moved to.
 *   5. Ties break on identity ascending, purely so the choice is deterministic
 *      and reproducible in tests rather than dependent on room iteration order.
 */
export function pickNextFocus(
    candidates: readonly FocusCandidate[],
    losing: FocusRef | null,
): FocusCandidate | null {
    const eligible = candidates.filter(c =>
        !c.isLocal
        && !(losing && c.identity === losing.identity && c.source === losing.source),
    );
    if (eligible.length === 0) return null;

    const rank = (c: FocusCandidate) => (c.source === Track.Source.ScreenShare ? 0 : 1);

    return eligible.reduce((best, c) => {
        const byTier = rank(c) - rank(best);
        if (byTier !== 0) return byTier < 0 ? c : best;
        if (c.publishedAt !== best.publishedAt) {
            return c.publishedAt > best.publishedAt ? c : best;
        }
        return c.identity < best.identity ? c : best;
    });
}
