import { describe, it, expect } from 'vitest';
import { RoomEvent } from 'livekit-client';
import { allRemoteParticipantRoomEvents } from '@livekit/components-core';
import { ROSTER_EVENTS_WITHOUT_SPEAKING, ROSTER_ONLY } from './callRosterEvents';

describe('ROSTER_EVENTS_WITHOUT_SPEAKING', () => {
    it("is the library's default roster event list minus exactly the speaking and quality events", () => {
        const expected = allRemoteParticipantRoomEvents.filter(
            e => e !== RoomEvent.ActiveSpeakersChanged && e !== RoomEvent.ConnectionQualityChanged,
        );
        expect([...ROSTER_EVENTS_WITHOUT_SPEAKING].sort()).toEqual([...expected].sort());
        // ...and the library still HAS both, so dropping them is meaningful.
        expect(allRemoteParticipantRoomEvents).toContain(RoomEvent.ActiveSpeakersChanged);
        expect(allRemoteParticipantRoomEvents).toContain(RoomEvent.ConnectionQualityChanged);
    });

    it('never drops the events a roster/track UI depends on', () => {
        for (const e of [RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.TrackPublished,
            RoomEvent.TrackUnpublished, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.ParticipantMetadataChanged]) {
            expect(ROSTER_ONLY.updateOnlyOn).toContain(e);
        }
    });
});
