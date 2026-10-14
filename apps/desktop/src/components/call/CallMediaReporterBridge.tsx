import React from 'react';
import type { CallMediaReport } from '@cipherline/shared';
import { useCallTelemetrySafe } from '../../contexts/CallContext';
import { useCallMediaReporter, type CallMediaTarget } from '../../hooks/useCallMediaReporter';

/**
 * Renders nothing. Mounted once inside <CallProvider> (Dashboard), it reads
 * MY live camera / screen-share / mic / deafen state from the same telemetry
 * snapshot the in-call roster rows use and reports changes to the server,
 * which is what lets people outside the call see the same icons. See
 * useCallMediaReporter (incl. the push-to-talk rule).
 */
export const CallMediaReporterBridge: React.FC<{
    userId: string | null | undefined;
    /** The Calls-channel call I'm in, if any. */
    huddleCallId: string | null;
    /** The legacy voice channel I'm in, if any (ignored when huddleCallId is set). */
    voiceChannelId: string | null;
    connCount: number;
    /** Push-to-talk mode is on (voice settings) — a closed mic is not a mute. */
    pushToTalk: boolean;
    send: (report: CallMediaReport) => boolean;
}> = ({ userId, huddleCallId, voiceChannelId, connCount, pushToTalk, send }) => {
    const telemetry = useCallTelemetrySafe();
    const mine = userId ? telemetry?.participantTrackStates?.[userId] : undefined;
    const myMeta = userId ? telemetry?.participantMetadata?.[userId] : undefined;
    const target: CallMediaTarget | null = huddleCallId
        ? { kind: 'huddle', callId: huddleCallId }
        : voiceChannelId
            ? { kind: 'voice', channelId: voiceChannelId }
            : null;
    useCallMediaReporter({
        target,
        camera: !!mine?.hasCamera,
        screenShare: !!mine?.hasScreenShare,
        micOff: !!mine?.isMuted,
        pushToTalk,
        deafened: !!myMeta?.deafened,
        connCount,
        send,
    });
    return null;
};
