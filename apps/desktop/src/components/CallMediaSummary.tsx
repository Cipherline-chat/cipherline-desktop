import React from 'react';
import { Monitor, Video } from 'lucide-react';
import { describeCallMedia, summarizeCallMedia, useCallMediaVersion } from '../utils/callMediaPresence';

/**
 * Compact "someone is sharing / has camera on" marker for a call tile that
 * shows the call as a whole rather than one row per person (Home's
 * "Happening now"). Same source as the sidebar's per-person icons — server
 * presence via utils/callMediaPresence — and the same lucide glyphs.
 * Renders nothing when nobody in `participantIds` has anything on.
 */
export const CallMediaSummary: React.FC<{
    mediaKey: string;
    participantIds: readonly string[];
    names?: Record<string, string>;
}> = ({ mediaKey, participantIds, names }) => {
    useCallMediaVersion(); // re-render on any presence change
    const { screen_share, camera } = summarizeCallMedia(mediaKey, participantIds);
    if (screen_share.length === 0 && camera.length === 0) return null;
    const label = describeCallMedia(screen_share, camera, names);
    return (
        <span
            className="inline-flex items-center gap-1.5 align-middle ml-1.5"
            title={label}
            aria-label={label}
            role="img"
            data-testid="call-media-summary"
        >
            {screen_share.length > 0 && (
                <span className="inline-flex items-center gap-0.5">
                    <Monitor className="w-3 h-3" aria-hidden="true" />
                    {screen_share.length > 1 && <span className="tabular-nums">{screen_share.length}</span>}
                </span>
            )}
            {camera.length > 0 && (
                <span className="inline-flex items-center gap-0.5">
                    <Video className="w-3 h-3" aria-hidden="true" />
                    {camera.length > 1 && <span className="tabular-nums">{camera.length}</span>}
                </span>
            )}
        </span>
    );
};

export default CallMediaSummary;
