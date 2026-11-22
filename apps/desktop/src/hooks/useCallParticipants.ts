/**
 * `useParticipants` without share-audio helper connections (utils/shareAudioHelper.ts).
 * Every roster / tile / count in the call UI reads through this so a phone's second
 * (audio-only) connection is never shown or counted as a person.
 */
import { useMemo } from 'react';
import { useParticipants } from '@livekit/components-react';
import { withoutShareAudioHelpers } from '../utils/shareAudioHelper';

export function useCallParticipants(options?: Parameters<typeof useParticipants>[0]) {
    const all = useParticipants(options);
    return useMemo(() => withoutShareAudioHelpers(all), [all]);
}
