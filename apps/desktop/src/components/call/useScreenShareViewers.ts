import React from 'react';
import { useMaybeRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import {
    viewersOf, describeViewers,
    type ViewerRosterEntry, type NamedRosterEntry, type ViewerPerson,
} from '../../utils/screenShareViewers';

/**
 * useScreenShareViewers — who is watching `publisher`'s screenshare, live.
 *
 * Reads the room roster directly rather than taking a prop, so a tile can
 * label itself without SidebarConference and FullscreenOverlay each growing a
 * parallel `viewerCounts` prop chain through every layout branch (grid, strip,
 * stage, focused, sidebar). The count is a fold over current metadata — see
 * `utils/screenShareViewers.ts` for why it is derived rather than accumulated.
 *
 * Subscribes to the Room's OWN events instead of leaning on
 * `useParticipants()`. LiveKit mutates `participant.metadata` in place without
 * changing the participants array reference, so a hook keyed on that array can
 * miss a metadata-only change — the exact trap SidebarConference documents at
 * its `metadataKey` and works around the same way.
 *
 * `useMaybeRoomContext` (not `useRoomContext`) so a tile rendered outside a
 * room — or in a unit test that never mounts one — reports zero viewers
 * instead of throwing.
 */
export function useScreenShareViewers(publisher: string | undefined): string[] {
    const room = useMaybeRoomContext();
    const [viewers, setViewers] = React.useState<string[]>([]);

    React.useEffect(() => {
        if (!room || !publisher) {
            setViewers(prev => (prev.length === 0 ? prev : []));
            return;
        }

        const recompute = () => {
            const roster: ViewerRosterEntry[] = [
                room.localParticipant,
                ...room.remoteParticipants.values(),
            ].filter(Boolean) as ViewerRosterEntry[];
            const next = viewersOf(roster, publisher);
            // Keep the previous array identity when nothing moved, so a tile
            // doesn't re-render on every unrelated metadata write in the room
            // (avatar sync, deafen, moderation flags all share the blob).
            setViewers(prev =>
                prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next,
            );
        };

        recompute();
        // ParticipantMetadataChanged is the signal; the rest are the roster
        // changing underneath it. Disconnected is what makes "a viewer left the
        // call entirely" decrement without anyone publishing a retraction.
        room.on(RoomEvent.ParticipantMetadataChanged, recompute);
        room.on(RoomEvent.ParticipantConnected, recompute);
        room.on(RoomEvent.ParticipantDisconnected, recompute);
        room.on(RoomEvent.ConnectionStateChanged, recompute);
        room.on(RoomEvent.Reconnected, recompute);
        return () => {
            room.off(RoomEvent.ParticipantMetadataChanged, recompute);
            room.off(RoomEvent.ParticipantConnected, recompute);
            room.off(RoomEvent.ParticipantDisconnected, recompute);
            room.off(RoomEvent.ConnectionStateChanged, recompute);
            room.off(RoomEvent.Reconnected, recompute);
        };
    }, [room, publisher]);

    return viewers;
}

/** Convenience wrapper — the count is all any tile chrome actually renders. */
export function useScreenShareViewerCount(publisher: string | undefined): number {
    return useScreenShareViewers(publisher).length;
}

const NO_PEOPLE: ViewerPerson[] = [];

const samePeople = (a: readonly ViewerPerson[], b: readonly ViewerPerson[]) =>
    a.length === b.length && a.every((v, i) =>
        v.identity === b[i].identity && v.name === b[i].name && v.avatar === b[i].avatar && v.isSelf === b[i].isSelf);

/**
 * useScreenShareViewerList — the same viewers as `useScreenShareViewers`, each
 * with the display name (`participant.name`, the field every call tile
 * prints), avatar id and "is this me". Read from the room roster the count is
 * already read from, so it adds no data: the roster, the names and the watch
 * metadata are in every participant's LiveKit view of the room.
 *
 * Also listens for `ParticipantNameChanged`, which a count does not need but a
 * name does.
 */
export function useScreenShareViewerList(publisher: string | undefined): ViewerPerson[] {
    const room = useMaybeRoomContext();
    const [people, setPeople] = React.useState<ViewerPerson[]>(NO_PEOPLE);

    React.useEffect(() => {
        if (!room || !publisher) {
            setPeople(prev => (prev.length === 0 ? prev : NO_PEOPLE));
            return;
        }
        const recompute = () => {
            const roster = [room.localParticipant, ...room.remoteParticipants.values()].filter(Boolean) as NamedRosterEntry[];
            const next = describeViewers(roster, publisher, room.localParticipant?.identity);
            setPeople(prev => (samePeople(prev, next) ? prev : next));
        };
        recompute();
        const events = [
            RoomEvent.ParticipantMetadataChanged,
            RoomEvent.ParticipantNameChanged,
            RoomEvent.ParticipantConnected,
            RoomEvent.ParticipantDisconnected,
            RoomEvent.ConnectionStateChanged,
            RoomEvent.Reconnected,
        ];
        for (const ev of events) room.on(ev, recompute);
        return () => { for (const ev of events) room.off(ev, recompute); };
    }, [room, publisher]);

    return people;
}
