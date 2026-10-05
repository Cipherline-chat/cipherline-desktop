/**
 * callTrackCues — pure decision logic for the camera_on / camera_off in-call
 * sound cues. Deliberately LiveKit-free (no `Track`/`Room` imports) so it can
 * be unit tested without a Room fixture; the call site in CallPane.tsx does
 * the LiveKit-specific plumbing (event registration, `Track.Source` checks,
 * the readiness gate) and hands this function only the plain facts.
 *
 * ── Why camera has no "unpublished" case, unlike screenshare ────────────────
 *
 * Screenshare start/stop is a genuine publish/unpublish cycle (LiveKit's
 * `setTrackEnabled` unpublishes a screenshare on stop — "screenshare cannot be
 * muted, unpublish instead"). Camera is different: `setCameraEnabled(false)`
 * calls `track.mute()`, never `unpublishTrack()` — the publication survives
 * for the life of the call, and only its mute state flips. The one time a
 * camera publication genuinely gets unpublished is participant departure
 * teardown (`Room.handleParticipantDisconnected` unpublishes every remaining
 * track before emitting `ParticipantDisconnected`), which already earns its
 * own `leave` cue via the participant-count effect. Treating that unpublish
 * as a second `camera_off` cue would double up on every departure while
 * someone's camera happened to be on — so `'unpublished'` is deliberately not
 * a case this function maps to anything. Contrast with screenshare's
 * onTrackUnpublished handler, which needs (and has) a short delay + cancel-on-
 * disconnect dance for exactly this reason; camera avoids needing that
 * mechanism by not reacting to unpublish at all.
 */
export type CameraTrackEvent = 'published' | 'muted' | 'unmuted';

/**
 * Decide which cue (if any) a camera track-state event should play.
 *
 * `ready` is the caller's gate against two storms this function does not
 * itself have the information to detect:
 *  - join storm: LiveKit reports every already-published remote track as part
 *    of initial room sync, which looks identical to a live "just published"
 *    event from here. The caller suppresses the first ~500ms after mount.
 *  - reconnect replay: a full LiveKit reconnect tears down and re-adds remote
 *    participants, which can re-fire "published" for tracks that were already
 *    on before the disconnect. The caller re-arms the same gate around
 *    Reconnecting/Reconnected.
 */
export function cameraCueForEvent(event: CameraTrackEvent, ready: boolean): 'camera_on' | 'camera_off' | null {
    if (!ready) return null;
    switch (event) {
        case 'published':
        case 'unmuted':
            return 'camera_on';
        case 'muted':
            return 'camera_off';
        default:
            return null;
    }
}
