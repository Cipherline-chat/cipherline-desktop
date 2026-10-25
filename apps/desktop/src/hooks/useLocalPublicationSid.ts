/**
 * The trackSid of the local participant's publication for one source, as
 * React STATE that follows LocalTrackPublished / LocalTrackUnpublished.
 *
 * Why not derive it during render (`localParticipant.getTrackPublication(src)
 * ?.trackSid`): the participant is a mutable object whose identity never
 * changes, so a render-time read is only as fresh as the next re-render — and
 * a republish of our OWN track (the H.265 codec switch's make-before-break,
 * republishAllTracks on reconnect) does not cause one. Effects keyed on the
 * sid then stay bound to the old, unpublished RTCRtpSender. Prod report
 * dfda9c13 (1.0.22): after `h265_switch` the share_fps sampler kept reading
 * the dead H.264 sender (OpenH264, enc_fps 0, no source fps) for 3.5 minutes
 * while the new H.265 sender was sending normally — and the sender-param
 * re-apply, lighter-copy control and background probe were bound to it too.
 */
import { useEffect, useState } from 'react';
import { ParticipantEvent, type Track } from 'livekit-client';

type LocalPublicationEvent = ParticipantEvent.LocalTrackPublished | ParticipantEvent.LocalTrackUnpublished;

export interface PublicationSidSource {
    getTrackPublication(source: Track.Source): { trackSid?: string } | undefined;
    on(event: LocalPublicationEvent, fn: () => void): unknown;
    off(event: LocalPublicationEvent, fn: () => void): unknown;
}

const sidOf = (p: PublicationSidSource, source: Track.Source): string | null =>
    p.getTrackPublication(source)?.trackSid ?? null;

/**
 * Call `onChange(sid)` now and whenever the local publication for `source`
 * is published / unpublished. Returns the unsubscribe function.
 */
export function watchLocalPublicationSid(
    p: PublicationSidSource,
    source: Track.Source,
    onChange: (sid: string | null) => void,
): () => void {
    const sync = () => onChange(sidOf(p, source));
    p.on(ParticipantEvent.LocalTrackPublished, sync);
    p.on(ParticipantEvent.LocalTrackUnpublished, sync);
    sync();
    return () => {
        p.off(ParticipantEvent.LocalTrackPublished, sync);
        p.off(ParticipantEvent.LocalTrackUnpublished, sync);
    };
}

export function useLocalPublicationSid(p: PublicationSidSource | null | undefined, source: Track.Source): string | null {
    const [sid, setSid] = useState<string | null>(() => (p ? sidOf(p, source) : null));
    useEffect(() => {
        if (!p) { setSid(null); return; }
        return watchLocalPublicationSid(p, source, setSid);
    }, [p, source]);
    return sid;
}
