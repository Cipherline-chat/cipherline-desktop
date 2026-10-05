import React from 'react';
import { ParticipantEvent, Track, type Participant } from 'livekit-client';

/**
 * Live camera / screen-share state for one participant.
 *
 * Extracted out of VideoTile.tsx so it can be unit-tested directly: importing
 * VideoTile pulls in the whole call-UI graph, including an rnnoise `?raw`
 * asset import that Vite refuses to serve to a test. The hook itself depends
 * on nothing but React and livekit-client.
 *
 * VideoTile still re-exports this, so existing importers are unchanged.
 */
export function useParticipantTrackState(p: Participant): { hasActiveCamera: boolean; hasActiveScreenShare: boolean } {
    const [, force] = React.useState(0);
    React.useEffect(() => {
        const bump = () => force(n => n + 1);
        p.on(ParticipantEvent.TrackPublished,   bump);
        p.on(ParticipantEvent.TrackUnpublished, bump);
        p.on(ParticipantEvent.TrackMuted,       bump);
        p.on(ParticipantEvent.TrackUnmuted,     bump);
        p.on(ParticipantEvent.TrackSubscribed as any,   bump);
        p.on(ParticipantEvent.TrackUnsubscribed as any, bump);
        // LOCAL publishes are a DIFFERENT event. LiveKit emits TrackPublished /
        // TrackUnpublished only on a RemoteParticipant; the local participant
        // emits localTrackPublished / localTrackUnpublished instead (they are
        // genuinely distinct strings, not aliases). Without these two, starting
        // or stopping your OWN camera or screen share never re-rendered this
        // hook, so your own "hidden video" / "hidden screenshare" badge stayed
        // stale until some unrelated re-render happened to refresh it.
        //
        // Exactly the bug already fixed in useIsMicMuted above — same file,
        // same omission, different badge. Unlike the mic case this needs no
        // connecting-state helper: a camera that is off is the ordinary
        // default, so there is no "no track yet" window to mistake for intent.
        p.on(ParticipantEvent.LocalTrackPublished as any,   bump);
        p.on(ParticipantEvent.LocalTrackUnpublished as any, bump);
        return () => {
            p.off(ParticipantEvent.TrackPublished,   bump);
            p.off(ParticipantEvent.TrackUnpublished, bump);
            p.off(ParticipantEvent.TrackMuted,       bump);
            p.off(ParticipantEvent.TrackUnmuted,     bump);
            p.off(ParticipantEvent.TrackSubscribed as any,   bump);
            p.off(ParticipantEvent.TrackUnsubscribed as any, bump);
            p.off(ParticipantEvent.LocalTrackPublished as any,   bump);
            p.off(ParticipantEvent.LocalTrackUnpublished as any, bump);
        };
    }, [p]);

    const camPub = p.getTrackPublication(Track.Source.Camera);
    const ssPub  = p.getTrackPublication(Track.Source.ScreenShare);
    return {
        // For local: track present + not muted. For remote: also need subscribed,
        // but we treat unsubscribed-but-published as "still has it" — the user's
        // hide-state badge should remain meaningful even pre-subscribe.
        hasActiveCamera:      !!(camPub && !camPub.isMuted && (camPub as any).track),
        hasActiveScreenShare: !!(ssPub  && !ssPub.isMuted  && (ssPub  as any).track),
    };
}

export default useParticipantTrackState;
