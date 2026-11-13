import React from 'react';
import { Participant } from 'livekit-client';
import { AnimatePresence } from 'framer-motion';
import { ParticipantCard } from './ParticipantCard';
import { PresenceMotion } from './presenceMotion';
import { presenceExitContext, CALL_EASE_ENTER, CALL_EASE_EXIT, CALL_EASE_GLIDE, CALL_GLIDE_S } from './presenceVariants';
import { currentCallPresenceTracker } from '../../utils/callPresenceLifecycle';

/** Same fade as SidebarConference's tileItemVariants; joins / leaves add the presence pop. */
const stripItemVariants = {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: 0.2, ease: CALL_EASE_ENTER } },
    exit: { opacity: 0, transition: { duration: 0.14, ease: CALL_EASE_EXIT } },
};

interface AudioOnlyStripProps {
    participants: Participant[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt
    localParticipant: any;
    token: string;
    localAvatarUrl?: string;
    remoteAvatarUrl?: string;
    isLocalDeafened: boolean;
    isGroup?: boolean;
    fallbackAvatars?: Record<string, string>;
    localMutedParticipantIds: Set<string>;
    onToggleLocalMute: (identity: string, muted: boolean) => void;
    hiddenVideoIds: Set<string>;
    hiddenScreenShareIds: Set<string>;
    onHideVideoChange: (identity: string, hide: boolean) => void;
    onHideScreenShareChange: (identity: string, hide: boolean) => void;
    /** Optional ringing placeholder */
    ringingElement?: React.ReactNode;
    canServerMute?: boolean;
    onServerMuteTrack?: (targetUserId: string, trackType: 'audio' | 'video' | 'screenshare' | 'deafen', muted: boolean) => void;
}

export const AudioOnlyStrip = ({
    participants,
    localParticipant,
    token,
    localAvatarUrl,
    remoteAvatarUrl,
    isLocalDeafened,
    isGroup,
    fallbackAvatars,
    localMutedParticipantIds,
    onToggleLocalMute,
    hiddenVideoIds,
    hiddenScreenShareIds,
    onHideVideoChange,
    onHideScreenShareChange,
    ringingElement,
    canServerMute,
    onServerMuteTrack,
}: AudioOnlyStripProps) => {
    // The call's lifecycle tracker (SidebarConference feeds it the roster
    // before this renders) — same surface key ('audio') as the rows / grid this
    // strip replaces when video takes the space, so switching to the strip
    // never replays a join.
    const tracker = currentCallPresenceTracker();
    const exitCtx = React.useMemo(() => presenceExitContext(tracker), [tracker]);
    if (participants.length === 0 && !ringingElement) return null;

    return (
        <div className="shrink-0 border-t border-white/5 px-3 py-2 max-h-[120px] overflow-y-auto custom-scrollbar">
            <div className="flex flex-row flex-wrap gap-2 justify-center items-start">
                <AnimatePresence mode="popLayout" initial={false} custom={exitCtx}>
                {participants.map(p => (
                    <PresenceMotion
                        key={p.identity}
                        pid={p.identity}
                        surface="audio"
                        tracker={tracker}
                        layout
                        variants={stripItemVariants}
                        transition={{ layout: { duration: CALL_GLIDE_S, ease: CALL_EASE_GLIDE } }}
                    >
                    <ParticipantCard
                        p={p}
                        localParticipant={localParticipant}
                        token={token}
                        localAvatarUrl={localAvatarUrl}
                        remoteAvatarUrl={remoteAvatarUrl}
                        isLocalDeafened={isLocalDeafened}
                        compact={true}
                        sizeMode="tiny"
                        isLocalMuted={localMutedParticipantIds.has(p.identity)}
                        onToggleLocalMute={(v) => onToggleLocalMute(p.identity, v)}
                        isHiddenVideo={hiddenVideoIds.has(p.identity)}
                        isHiddenScreenShare={hiddenScreenShareIds.has(p.identity)}
                        onHideVideoChange={(v) => onHideVideoChange(p.identity, v)}
                        onHideScreenShareChange={(v) => onHideScreenShareChange(p.identity, v)}
                        isGroup={isGroup}
                        fallbackAvatars={fallbackAvatars}
                        canServerMute={canServerMute}
                        onServerMuteTrack={onServerMuteTrack}
                    />
                    </PresenceMotion>
                ))}
                </AnimatePresence>
                {ringingElement}
            </div>
        </div>
    );
};
