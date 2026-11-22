/**
 * The share-audio helper participant of `ownerIdentity` (a phone's second connection), or undefined.
 * Re-renders when the helper connects, disconnects, or its track is (un)subscribed: its events are
 * never the sharer's own, so the sharer's tile would not otherwise notice.
 */
import { useEffect, useState } from 'react';
import { RoomEvent, type Room, type RemoteParticipant } from 'livekit-client';
import { useMaybeRoomContext } from '@livekit/components-react';
import { isShareAudioHelperIdentity, shareAudioHelperIdentity } from '../utils/shareAudioHelper';

const EVENTS = [
    RoomEvent.ParticipantConnected,
    RoomEvent.ParticipantDisconnected,
    RoomEvent.TrackPublished,
    RoomEvent.TrackUnpublished,
    RoomEvent.TrackSubscribed,
    RoomEvent.TrackUnsubscribed,
] as const;

export function useShareAudioHelper(ownerIdentity: string): RemoteParticipant | undefined {
    const room = useMaybeRoomContext() as Room | undefined;
    const [, bump] = useState(0);
    useEffect(() => {
        if (!room) return;
        const on = (...args: unknown[]) => {
            const p = args.find(a => a && typeof a === 'object' && 'identity' in (a as object)) as { identity: string } | undefined;
            if (p && isShareAudioHelperIdentity(p.identity)) bump(n => n + 1);
        };
        for (const ev of EVENTS) (room as unknown as { on(e: string, f: (...a: unknown[]) => void): void }).on(ev, on);
        return () => { for (const ev of EVENTS) (room as unknown as { off(e: string, f: (...a: unknown[]) => void): void }).off(ev, on); };
    }, [room]);
    return room?.remoteParticipants.get(shareAudioHelperIdentity(ownerIdentity));
}
