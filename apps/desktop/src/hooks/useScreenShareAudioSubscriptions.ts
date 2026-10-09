/**
 * The ONE owner of ScreenShareAudio subscriptions: subscribed iff this client
 * is watching that sharer. See utils/screenShareAudioWatch.ts for why this is
 * event-driven here rather than an effect inside ScreenShareGate.
 */
import { useEffect, useRef } from 'react';
import type { Room } from 'livekit-client';
import {
    attachShareAudioReconciler,
    reconcileShareAudioSubscriptions,
    type ShareAudioRoomLike,
} from '../utils/screenShareAudioWatch';

export function useScreenShareAudioSubscriptions(
    room: Room | undefined | null,
    watched: ReadonlySet<string>,
): void {
    // Latest watch set for the room-event handler, which is registered once
    // per room. Written in an effect (not during render); the same effect also
    // reconciles, so a watch-set change is applied the moment it commits.
    const watchedRef = useRef(watched);
    useEffect(() => {
        watchedRef.current = watched;
        if (!room) return;
        reconcileShareAudioSubscriptions(room.remoteParticipants.values(), watched, room.localParticipant?.identity);
    }, [room, watched]);

    useEffect(() => {
        if (!room) return;
        // Cast: Room's typed `on` overloads don't take an event name from a
        // const array; the reconciler only needs the structural slice.
        return attachShareAudioReconciler(room as unknown as ShareAudioRoomLike, () => watchedRef.current);
    }, [room]);
}
