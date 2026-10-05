import React from 'react';
import { Participant } from 'livekit-client';
import { ParticipantCard } from './ParticipantCard';

interface AudioOnlyStripProps {
    participants: Participant[];
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
    if (participants.length === 0 && !ringingElement) return null;

    return (
        <div className="shrink-0 border-t border-white/5 px-3 py-2 max-h-[120px] overflow-y-auto custom-scrollbar">
            <div className="flex flex-row flex-wrap gap-2 justify-center items-start">
                {participants.map(p => (
                    <ParticipantCard
                        key={p.identity}
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
                ))}
                {ringingElement}
            </div>
        </div>
    );
};
