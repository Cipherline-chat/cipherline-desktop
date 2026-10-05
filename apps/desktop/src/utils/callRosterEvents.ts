import { RoomEvent } from 'livekit-client';

/**
 * Room events after which `useParticipants()` should hand back a new roster
 * array, for call surfaces that render the roster and its tracks but NOT
 * speaking state or connection quality.
 *
 * `useParticipants()` with no options refreshes on @livekit/components-core's
 * `allRemoteParticipantRoomEvents`, which includes ActiveSpeakersChanged and
 * ConnectionQualityChanged. In a call where people talk, the SFU sends a
 * speaker update several times a second, so every surface using the default
 * re-rendered at that rate — SidebarConference (the whole in-call UI, whose
 * framer-motion `layout` tiles each measure themselves on every render),
 * FocusedStreamBanner and FullscreenOverlay included — for output that does
 * not depend on either event. Speaking rings are driven per participant
 * (useFastIsSpeaking / subscribeFastSpeaking) and the speaker-promotion order
 * by its own 1 s tick, so neither needs the roster to churn.
 *
 * This is the library's list minus exactly those two events; the test pins
 * that against the installed library so a new upstream event can't be lost.
 * ParticipantConnected / ParticipantDisconnected / ConnectionStateChanged are
 * always added by the library itself.
 */
export const ROSTER_EVENTS_WITHOUT_SPEAKING: RoomEvent[] = [
    RoomEvent.ConnectionStateChanged,
    RoomEvent.RoomMetadataChanged,
    RoomEvent.ParticipantConnected,
    RoomEvent.ParticipantDisconnected,
    RoomEvent.ParticipantPermissionsChanged,
    RoomEvent.ParticipantMetadataChanged,
    RoomEvent.ParticipantNameChanged,
    RoomEvent.ParticipantAttributesChanged,
    RoomEvent.TrackMuted,
    RoomEvent.TrackUnmuted,
    RoomEvent.TrackPublished,
    RoomEvent.TrackUnpublished,
    RoomEvent.TrackStreamStateChanged,
    RoomEvent.TrackSubscriptionFailed,
    RoomEvent.TrackSubscriptionPermissionChanged,
    RoomEvent.TrackSubscriptionStatusChanged,
];

/** Stable options object for `useParticipants(...)` (the hook keys its
 *  subscription on JSON.stringify(updateOnlyOn), so identity is irrelevant,
 *  but a module constant avoids re-stringifying a fresh literal per render). */
export const ROSTER_ONLY = { updateOnlyOn: ROSTER_EVENTS_WITHOUT_SPEAKING };
