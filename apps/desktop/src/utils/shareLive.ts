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

/** The slice of a LiveKit Room localCameraLive reads. */
export interface CameraLiveRoomLike {
    localParticipant: {
        getTrackPublications?(): Iterable<{ source?: unknown; isMuted?: boolean }>;
        getTrackPublication(source: Track.Source): unknown;
    };
}

/**
 * True while this device has a published, un-muted camera. A camera switched
 * off is a MUTED publication (LiveKit keeps it and stops the device), so
 * "published" alone would keep the webcam boost on after the user turned the
 * camera off. During a make-before-break republish two camera publications
 * coexist briefly: any live one counts.
 */
export function localCameraLive(room: CameraLiveRoomLike | undefined | null): boolean {
    try {
        const lp = room?.localParticipant;
        if (!lp) return false;
        const pubs = lp.getTrackPublications?.();
        if (pubs) {
            for (const p of pubs) if (p.source === Track.Source.Camera && !p.isMuted) return true;
            return false;
        }
        const pub = lp.getTrackPublication(Track.Source.Camera) as { isMuted?: boolean } | undefined;
        return !!pub && !pub.isMuted;
    } catch {
        return false;
    }
}
