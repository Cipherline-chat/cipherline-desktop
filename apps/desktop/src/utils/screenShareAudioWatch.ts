/**
 * Screen-share AUDIO follows the viewer's watch decision — and nothing else.
 *
 * A screen share is opt-in to view (ScreenShareGate's "Watch"), and the set of
 * shares this client is watching is SidebarConference's `subscribedScreenshares`
 * (also published as `watching_shares` for the viewer count — see
 * utils/stopWatchingScreenshare.ts). The share's audio has to obey that same
 * set, per sharer:
 *
 *   - RECEIVE it (LiveKit subscription) only while watching. The room joins
 *     with LiveKit's default `autoSubscribe: true`, so every ScreenShareAudio
 *     publication arrives subscribed for EVERY participant the moment it is
 *     published. The only thing that undid that used to be a render-timed
 *     effect inside ScreenShareGate — which does nothing while the gate is not
 *     mounted (share hidden, panel not showing, share on the focus stage) and
 *     misses a publication that lands after the gate's last render (toggle
 *     audio on mid-share, a republish, a reconnect).
 *   - PLAY it only while watching. Playback used to be keyed on "a screen-share
 *     VideoTile is mounted" (`screenShareSubscribed: isScreenShare`), and a
 *     share VideoTile can be mounted for a share nobody chose to watch: the
 *     focused-stream banner renders whatever `focusedStream` says, and its
 *     auto-advance (utils/pickNextFocus.ts) picks remote shares purely on
 *     "has a live track" — which autoSubscribe makes true for every share.
 *     When the stream you had focused ended, the stage jumped to a share you
 *     never opened and played its audio.
 *
 * So the subscription is reconciled here from the watch set alone (one owner,
 * event-driven, not render-timed), and the playback decision is a separate,
 * explicit predicate the tiles ask. Mic audio is never touched.
 *
 * Pure — structural types only — so the decisions are testable without LiveKit.
 */
import { Track } from 'livekit-client';

/** Structural slice of a LiveKit RemoteTrackPublication. */
export interface ShareAudioPublicationLike {
    /**
     * LiveKit's own "does the client want this track" flag
     * (`RemoteTrackPublication.isDesired` — `subscribed !== false`, so it is
     * true for an autoSubscribed publication nobody has touched yet). Compared
     * against instead of `isSubscribed`, which stays false until the SFU has
     * actually delivered the track: keying on it would re-send the same
     * request on every pass while one is in flight.
     */
    readonly isDesired: boolean;
    setSubscribed(subscribed: boolean): void;
}

/** Structural slice of a LiveKit RemoteParticipant. */
export interface ShareAudioParticipantLike {
    identity: string;
    // `unknown`: LiveKit types the result as the base TrackPublication, which
    // has neither isDesired nor setSubscribed — narrowed below.
    getTrackPublication(source: Track.Source): unknown;
}

/**
 * Whether this client wants `identity`'s share audio at all: only a REMOTE
 * sharer this client is watching. Your own share is never received back (and
 * is never in the watch set — the local participant is not in the remote
 * roster the set is built from — but this is the rule, not the accident).
 */
export function wantsShareAudio(
    identity: string,
    watched: ReadonlySet<string>,
    localIdentity?: string,
): boolean {
    return identity !== localIdentity && watched.has(identity);
}

/**
 * Whether a tile should PLAY share audio for the participant it shows.
 *
 * `useParticipantAudio`'s screen-share chain runs only when this is true. A
 * share tile existing is not enough — it has to be a remote share this client
 * is watching. Camera tiles and your own share never play share audio.
 */
export function shouldPlayShareAudio(opts: {
    isLocal: boolean;
    isScreenShareTile: boolean;
    watched: boolean;
}): boolean {
    return !opts.isLocal && opts.isScreenShareTile && opts.watched;
}

export interface ShareAudioReconcileResult {
    /** Identities whose share audio was just requested. */
    subscribed: string[];
    /** Identities whose share audio was just released. */
    unsubscribed: string[];
}

function asPublication(v: unknown): ShareAudioPublicationLike | null {
    if (!v || typeof v !== 'object') return null;
    const pub = v as Partial<ShareAudioPublicationLike>;
    if (typeof pub.setSubscribed !== 'function' || typeof pub.isDesired !== 'boolean') return null;
    return pub as ShareAudioPublicationLike;
}

/**
 * Make every remote participant's ScreenShareAudio subscription match the
 * watch set: subscribed iff watched. Idempotent — a publication already in the
 * wanted state is left alone, so running this on every relevant room event
 * sends nothing in steady state. Never touches any other source (the share's
 * VIDEO subscription is still driven by the Watch / stop-watching paths; the
 * microphone is never gated).
 */
export function reconcileShareAudioSubscriptions(
    participants: Iterable<ShareAudioParticipantLike>,
    watched: ReadonlySet<string>,
    localIdentity?: string,
): ShareAudioReconcileResult {
    const result: ShareAudioReconcileResult = { subscribed: [], unsubscribed: [] };
    for (const p of participants) {
        if (p.identity === localIdentity) continue;
        const pub = asPublication(p.getTrackPublication(Track.Source.ScreenShareAudio));
        if (!pub) continue;
        const want = wantsShareAudio(p.identity, watched, localIdentity);
        if (pub.isDesired === want) continue;
        try {
            pub.setSubscribed(want);
            (want ? result.subscribed : result.unsubscribed).push(p.identity);
        } catch (e) {
            console.warn('[ScreenShareAudio] subscription update failed', p.identity, e);
        }
    }
    return result;
}

/**
 * Room events after which a ScreenShareAudio publication can be in the wrong
 * subscription state and must be reconciled. Kept as data so the wiring test
 * can pin it.
 *
 *  - TrackPublished: a share (or "toggle audio on") lands; autoSubscribe has
 *    already asked the SFU for it.
 *  - TrackSubscribed: the track arrived — also how a FULL reconnect shows up,
 *    which rebuilds publications with autoSubscribe's `isDesired: true`.
 *  - ParticipantConnected: someone joins already sharing.
 *  - Reconnected: belt and braces after a resume.
 */
export const SHARE_AUDIO_RECONCILE_EVENTS = [
    'trackPublished',
    'trackSubscribed',
    'participantConnected',
    'reconnected',
] as const;

/** Structural slice of a LiveKit Room — just what the reconciler touches. */
export interface ShareAudioRoomLike {
    remoteParticipants: ReadonlyMap<string, ShareAudioParticipantLike>;
    localParticipant?: { identity: string } | null;
    on(event: string, fn: () => void): unknown;
    off(event: string, fn: () => void): unknown;
}

/**
 * Reconcile now, and again after every {@link SHARE_AUDIO_RECONCILE_EVENTS}
 * event, against whatever `getWatched()` returns at that moment. Returns the
 * disposer. The handler ignores the event's arguments: a full pass is a
 * handful of map lookups and is idempotent, so there is nothing to gain from
 * special-casing which publication fired.
 */
export function attachShareAudioReconciler(
    room: ShareAudioRoomLike,
    getWatched: () => ReadonlySet<string>,
): () => void {
    const run = () => {
        reconcileShareAudioSubscriptions(room.remoteParticipants.values(), getWatched(), room.localParticipant?.identity);
    };
    for (const ev of SHARE_AUDIO_RECONCILE_EVENTS) room.on(ev, run);
    run();
    return () => {
        for (const ev of SHARE_AUDIO_RECONCILE_EVENTS) room.off(ev, run);
    };
}
