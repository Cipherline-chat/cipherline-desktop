/**
 * Three-state rule for whether a participant's red "muted" badge should be
 * shown.
 *
 * LiveKit's `Participant.isMicrophoneEnabled` getter is defined as:
 *
 *   get isMicrophoneEnabled() {
 *     const track = this.getTrackPublication(Track.Source.Microphone);
 *     return !(track?.isMuted ?? true);
 *   }
 *
 * i.e. it defaults to "muted" the instant a mic track publication doesn't
 * exist yet — which is exactly the state of every participant for the
 * (however brief) window between joining a call and the mic track actually
 * finishing publish (getUserMedia + encoder init + LiveKit negotiation).
 * Rendering a badge straight off `!isMicrophoneEnabled` shows a false
 * "muted" badge during that window even though nobody touched their mic.
 *
 * This helper distinguishes "no track because we haven't finished
 * connecting yet" from "no track because this participant has fully joined
 * and genuinely has no live mic" — only the latter should read as muted, and
 * a track that DOES exist is always authoritative regardless of connection
 * phase (a participant can genuinely mute themselves mid-ring or
 * mid-reconnect, and that must still show).
 */
export type CallConnectionState =
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'signalReconnecting'
    | 'disconnected';

export function shouldShowMuteBadge(
    hasTrack: boolean,
    isEnabled: boolean,
    connectionState: CallConnectionState,
): boolean {
    if (!hasTrack) {
        // No mic publication exists. During any non-"connected" phase this is
        // ordinary startup/reconnect latency, not a mute — showing a badge
        // here would flash on and then vanish the instant the track
        // publishes, which is exactly the bug this guards against.
        //
        // Once the room is fully connected, an absent mic track really does
        // mean no audio is being sent (no device, permission denied, etc.),
        // so treat it the same as muted — this preserves the pre-fix
        // behaviour for that case instead of silently hiding it forever.
        return connectionState === 'connected';
    }
    // A track publication exists: its own muted/enabled flag is
    // authoritative regardless of connection phase.
    return !isEnabled;
}
