/**
 * Is OUR screen share live? Read by ShareBoostGuard (components/call), which
 * tells the main process so it can raise priority and hold a power request
 * while a share runs ("Prioritize calls and screen share while gaming" -
 * utils/gamingVideoMode.ts). Kept out of the component file so that file only
 * exports a component (fast refresh).
 */
import { Track } from 'livekit-client';

/** The slice of a LiveKit Room this reads. */
export interface ShareLiveRoomLike {
    localParticipant: { getTrackPublication(source: Track.Source): unknown };
}

/** True while this device has a published screen-share video. */
export function localShareLive(room: ShareLiveRoomLike | undefined | null): boolean {
    try {
        return !!room?.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    } catch {
        return false;
    }
}
