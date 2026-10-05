import React from 'react';
import ReactDOM from 'react-dom';
import { Track, Participant } from 'livekit-client';
import { MicOff, Headphones, HeadphoneOff, Video, VideoOff, Monitor, MonitorOff } from 'lucide-react';
import { EncryptedAvatar } from '../EncryptedAvatar';
import { PopoverMenu, calcPopoverPos } from './PopoverMenu';
import { AnnotationGrantBadge } from './AnnotationGrantBadge';
import { SignalBars, signalQuality } from './CallStatsPill';
import { pingColor } from '../../hooks/useCallStats';
import { useCallStatsSafe } from '../../contexts/callTelemetrySlices';
import { usePersistentVolume, usePersistentNsEnabled, useParticipantMetadata, useFastIsSpeaking, useParticipantTrackState, useIsMicMuted } from './VideoTile';
import { useParticipantAudio } from '../../hooks/useParticipantAudio';
import { useDismissOnOutsideClick } from '../../hooks/useDismissOnOutsideClick';
import { useOpenProfile } from '../../contexts/ProfileOpenContext';
import { useCallServerCtx } from '../../contexts/CallServerCtx';
import { TileNamePill } from './TileCornerChrome';
import { tileCornerInsets, tileChromeSlots } from './videoRectChrome';
// Server-moderation flags are derived inline below from useParticipantMetadata
// (the LiveKit-event-subscribed source) so we don't import the string-input
// parseParticipantMetadata helper here.

export interface ParticipantCardProps {
    p: Participant;
    localParticipant: any;
    token: string;
    localAvatarUrl?: string;
    remoteAvatarUrl?: string;
    isLocalDeafened: boolean;
    compact: boolean;
    isLocalMuted: boolean;
    onToggleLocalMute: (v: boolean) => void;
    isGroup?: boolean;
    fallbackAvatars?: Record<string, string>;
    isHiddenVideo?: boolean;
    isHiddenScreenShare?: boolean;
    onHideVideoChange?: (v: boolean) => void;
    onHideScreenShareChange?: (v: boolean) => void;
    /** Size override: 'tiny' for audio-only strip, 'large' for fullscreen bottom row,
     *  'row' for voice-channel list view (horizontal avatar + name row). */
    sizeMode?: 'tiny' | 'normal' | 'large' | 'row';
    /** Hex colour from the participant's highest-priority server role, or undefined. */
    roleColor?: string;
    /** True if the local user has the MUTE_MEMBERS server permission and may
     *  server-mute this participant's call tracks. Never shown on self. */
    canServerMute?: boolean;
    /** Called when the moderator toggles a server-side moderation action from
     *  the popover. `trackType` extends to 'deafen' which is a participant-level
     *  flag (force-mutes mic + sets metadata.server_deafened for client honor). */
    onServerMuteTrack?: (targetUserId: string, trackType: 'audio' | 'video' | 'screenshare' | 'deafen', muted: boolean) => void;
    /** Show the local user's ping + signal bars to the right of their name.
     *  Only passed in server/voice-channel calls (noRinging mode). */
    showLocalPing?: boolean;
    /**
     * Render as a TILE that fills its parent cell, with the name in the
     * top-right corner instead of stacked underneath the avatar.
     *
     * Set by FullscreenOverlay for its grid / people cells, where this card IS
     * a tile — a `bg-cl-abyss border rounded-xl` box sitting in the same grid
     * as the VideoTiles beside it. The owner asked for the name in the tile's
     * top-right corner on BOTH a live video tile and a black camera-off one
     * (their screenshot circled the same two corners on each), and in
     * fullscreen the camera-off tile IS this component: FullscreenOverlay's
     * collection pass drops a participant whose camera is muted, unpublished
     * or locally hidden out of `stage` and into `audioOnly`, so they render
     * here rather than as a VideoTile.
     *
     * Deliberately opt-in, not the default. Everywhere else this card renders
     * (the sidebar's centred tile grid, the fullscreen strip) it is a
     * shrink-wrapped avatar+label column with no tile box of its own — there
     * are no corners to anchor to, and a pill at the "top-right" of a
     * ~50px-wide strip thumbnail would be narrower than the name it holds.
     * See the corner-chrome block below.
     */
    cornerChrome?: boolean;
}

export const ParticipantCard = ({
    p, localParticipant, token, localAvatarUrl, remoteAvatarUrl, isLocalDeafened, compact, isLocalMuted, onToggleLocalMute, isGroup, fallbackAvatars,
    isHiddenVideo, isHiddenScreenShare, onHideVideoChange, onHideScreenShareChange, sizeMode, roleColor,
    canServerMute, onServerMuteTrack, showLocalPing = false, cornerChrome = false,
}: ParticipantCardProps) => {
    const isSpeaking = useFastIsSpeaking(p);
    const isLocal = p.identity === localParticipant?.identity;
    // Never show the raw user_id (p.identity is the user_id). If the LiveKit
    // token wasn't issued with a display name, fall through to "Unknown" —
    // typically this only happens for unauthenticated/agent participants.
    const displayName = p.name || 'Unknown';
    const meta = useParticipantMetadata(p);
    // Drives the hidden-track badge gating below — re-renders this component
    // when the participant publishes/unpublishes/mutes/unmutes their tracks
    // so the badges stop showing the moment the underlying track goes away.
    const { hasActiveCamera, hasActiveScreenShare } = useParticipantTrackState(p);
    // Stats only — the full telemetry context also changes on every speaking
    // transition in the call, which re-rendered every card for nothing.
    const callStats = useCallStatsSafe();
    let metaAvatar = meta?.avatar_url;
    if (!metaAvatar && fallbackAvatars) metaAvatar = fallbackAvatars[p.identity];

    const avatarToUse = metaAvatar || (isLocal ? localAvatarUrl : (isGroup ? undefined : remoteAvatarUrl));

    const [showPopover, setShowPopover] = React.useState(false);
    const [popoverPos, setPopoverPos] = React.useState({ top: 0, left: 0 });
    const [volume, setVolume] = usePersistentVolume(p.identity, 'mic');
    const [nsEnabled, setNsEnabled] = usePersistentNsEnabled(p.identity);
    const popoverRef = React.useRef<HTMLDivElement>(null);
    const buttonRef = React.useRef<HTMLButtonElement>(null);

    // Audio management
    useParticipantAudio(p, localParticipant?.identity, {
        volume,
        isLocalMuted,
        isLocalDeafened,
        nsEnabled,
    });

    // Server-moderation flags derived from the reactive `meta` object above
    // (useParticipantMetadata subscribes to ParticipantMetadataChanged, so
    // toggling any server-mute flag re-renders this component automatically).
    // Local self-deafen OR server-deafen both put the user into "deafened"
    // visual state.
    const modMeta = {
        serverMutedAudio:       meta?.server_muted_audio === true,
        serverMutedVideo:       meta?.server_muted_video === true,
        serverMutedScreenShare: meta?.server_muted_screenshare === true,
        serverDeafened:         meta?.server_deafened === true,
    };
    const isDeafened = meta?.deafened === true || modMeta.serverDeafened;
    // useIsMicMuted subscribes to TrackMuted / TrackUnmuted events on p so the
    // icon updates immediately on mute toggle without waiting for a parent
    // re-render from useParticipants(). Reading p.isMicrophoneEnabled inline
    // during a forced re-render can be stale because the property is a live
    // getter on a mutable object and React batches updates.
    const isMuted = useIsMicMuted(p);

    const openProfile = useOpenProfile();
    const callServerCtx = useCallServerCtx();

    const handleToggle = (e?: React.MouseEvent) => {
        // Clicking your own tile opens your profile (consistent with every
        // other avatar in the app). Clicking someone else's toggles their
        // volume/mute popover.
        if (isLocal) {
            if (openProfile) {
                const roleCtx = callServerCtx ? {
                    roleIds: [], roles: [],
                    serverId: callServerCtx.serverId,
                    canSetNickname: callServerCtx.canChangeOwnNick,
                } : undefined;
                openProfile(p.identity, e ? { x: e.clientX, y: e.clientY } : undefined, roleCtx);
            }
            return;
        }
        if (!buttonRef.current) return;
        setPopoverPos(calcPopoverPos(buttonRef.current.getBoundingClientRect()));
        setShowPopover(v => !v);
    };

    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new Event('close-all-popovers'));
        handleToggle(e);
    };

    // Outside-click close — see VideoTile / useDismissOnOutsideClick for why
    // the click is consumed (so closing doesn't fire the participant card's
    // toggle behind it).
    useDismissOnOutsideClick(popoverRef, showPopover, () => setShowPopover(false));
    React.useEffect(() => {
        if (!showPopover) return;
        const closePopover = () => setShowPopover(false);
        window.addEventListener('close-all-popovers', closePopover);
        return () => window.removeEventListener('close-all-popovers', closePopover);
    }, [showPopover]);

    // ── Row mode (voice-channel list) ────────────────────────────────────────
    if (sizeMode === 'row') {
        const speaking = isSpeaking && !isLocalMuted && !isMuted && !isLocalDeafened && !isDeafened;
        const silenced = isMuted || isDeafened || isLocalMuted || isLocalDeafened;
        return (
            <div
                className="flex items-center gap-2.5 px-2 py-1.5 hover:bg-white/[0.04] transition-colors w-full relative cursor-pointer"
                onClick={(e) => handleToggle(e)}
                onContextMenu={handleContextMenu}
            >
                {/* Avatar — clean, no badge overlay */}
                <div
                    ref={buttonRef as any}
                    className={`w-8 h-8 rounded-full overflow-hidden bg-cl-surface shrink-0
                        ${speaking ? 'ring-2 ring-green-500 shadow-[0_0_12px_rgba(34,197,94,0.35)] scale-105' : 'ring-1 ring-white/10'}`}
                >
                    <EncryptedAvatar
                        attachmentId={avatarToUse}
                        userId={p.identity}
                        token={token}
                        className={`w-full h-full object-cover ${silenced ? 'opacity-50' : ''}`}
                        fallbackSize={13}
                        disableClickProfile
                        bypassFriendGate
                    />
                </div>

                {/* Name — dimmed when silenced, role colour otherwise */}
                <span
                    className={`flex-1 text-[13px] font-medium truncate transition-colors ${silenced ? 'text-white/40' : ''}`}
                    style={!silenced && roleColor ? { color: roleColor } : !silenced ? { color: 'rgba(255,255,255,0.8)' } : undefined}
                >
                    {displayName}
                </span>
                <AnnotationGrantBadge identity={p.identity} size={12} />

                {/* All status badges — horizontal row on the right of the name.
                    Order: [local ping] → server-moderation flags (red) → screenshare → camera → audio (deafen → mute → local-mute). */}
                <div className="flex items-center gap-1.5 shrink-0">
                    {/* Ping + signal bars — local user only, server calls only */}
                    {showLocalPing && isLocal && (() => {
                        const { pingMs, packetLossPercent } = callStats ?? { pingMs: null, packetLossPercent: null };
                        const { bars, color } = signalQuality(pingMs, packetLossPercent);
                        return (
                            <div className="flex items-center gap-1">
                                <SignalBars bars={bars} color={color} />
                                <span className={`text-[10px] font-mono tabular-nums ${pingColor(pingMs)}`}>
                                    {pingMs !== null ? `${pingMs}ms` : '—'}
                                </span>
                            </div>
                        );
                    })()}
                    {/* Server-moderation badges — saturated red so they're
                        immediately distinguishable from self-mute / local-mute
                        (white/grey) and local-deafen (also red but for the local
                        user only). Each badge has a title for hover-explain. */}
                    {modMeta.serverMutedAudio && (
                        <MicOff className="w-3.5 h-3.5 text-red-500" />
                    )}
                    {modMeta.serverDeafened && (
                        <HeadphoneOff className="w-3.5 h-3.5 text-red-500" />
                    )}
                    {modMeta.serverMutedVideo && (
                        <VideoOff className="w-3.5 h-3.5 text-red-500" />
                    )}
                    {modMeta.serverMutedScreenShare && (
                        <MonitorOff className="w-3.5 h-3.5 text-red-500" />
                    )}
                    {/* Active screenshare indicator */}
                    {hasActiveScreenShare && !modMeta.serverMutedScreenShare && (
                        isHiddenScreenShare
                            ? <MonitorOff className="w-3.5 h-3.5 text-white/30" />
                            : <Monitor className="w-3.5 h-3.5 text-white/50" />
                    )}
                    {/* Active camera indicator */}
                    {hasActiveCamera && !modMeta.serverMutedVideo && (
                        isHiddenVideo
                            ? <VideoOff className="w-3.5 h-3.5 text-white/30" />
                            : <Video className="w-3.5 h-3.5 text-white/50" />
                    )}
                    {/* Skip the regular deafen/mute icons when server-muted —
                        the red server badge above already conveys the muted state. */}
                    {isDeafened && !modMeta.serverDeafened && (
                        <Headphones className="w-3.5 h-3.5 text-red-400" />
                    )}
                    {isMuted && !modMeta.serverMutedAudio && !modMeta.serverDeafened && (
                        <MicOff className="w-3.5 h-3.5 text-red-400" />
                    )}
                    {!isMuted && !isDeafened && isLocalMuted && (
                        <MicOff className="w-3.5 h-3.5 text-white/30" />
                    )}
                    {isLocalDeafened && isLocal && !isDeafened && (
                        <Headphones className="w-3.5 h-3.5 text-white/30" />
                    )}
                </div>

                {showPopover && !isLocal && ReactDOM.createPortal(
                    <PopoverMenu
                        displayName={displayName}
                        volume={volume}
                        isLocalMuted={isLocalMuted}
                        hasVideo={p.getTrackPublication(Track.Source.Camera) !== undefined}
                        isVideoHidden={isHiddenVideo}
                        hasScreenShare={p.getTrackPublication(Track.Source.ScreenShare) !== undefined}
                        isScreenShareHidden={isHiddenScreenShare}
                        onVolumeChange={setVolume}
                        onMuteChange={onToggleLocalMute}
                        nsEnabled={nsEnabled}
                        onNsEnabledChange={setNsEnabled}
                        onHideVideoChange={onHideVideoChange}
                        onHideScreenShareChange={onHideScreenShareChange}
                        popoverRef={popoverRef}
                        onClose={() => setShowPopover(false)}
                        style={popoverPos}
                        userId={p.identity}
                        onViewProfile={() => setShowPopover(false)}
                        localIdentity={localParticipant?.identity}
                        onRevokeAnnotation={() => setShowPopover(false)}
                        canServerMute={canServerMute}
                        serverMutedAudio={modMeta.serverMutedAudio}
                        serverMutedVideo={modMeta.serverMutedVideo}
                        serverMutedScreenShare={modMeta.serverMutedScreenShare}
                        serverDeafened={modMeta.serverDeafened}
                        onServerMuteAudio={onServerMuteTrack ? (m) => { onServerMuteTrack(p.identity, 'audio', m); setShowPopover(false); } : undefined}
                        onServerMuteVideo={onServerMuteTrack ? (m) => { onServerMuteTrack(p.identity, 'video', m); setShowPopover(false); } : undefined}
                        onServerMuteScreenShare={onServerMuteTrack ? (m) => { onServerMuteTrack(p.identity, 'screenshare', m); setShowPopover(false); } : undefined}
                        onServerDeafen={onServerMuteTrack ? (d) => { onServerMuteTrack(p.identity, 'deafen', d); setShowPopover(false); } : undefined}
                    />,
                    document.body
                )}
            </div>
        );
    }

    // ── Tile mode (compact / normal / large) ─────────────────────────────────
    const effectiveCompact = sizeMode === 'tiny' || (sizeMode !== 'large' && compact);
    const effectiveLarge = sizeMode === 'large';

    const size = effectiveLarge ? 'w-20 h-20' : effectiveCompact ? 'w-9 h-9' : 'w-24 h-24';
    const nameTrunc = effectiveLarge ? 'max-w-[100px]' : effectiveCompact ? 'max-w-[60px]' : 'max-w-[100px]';
    const nameSize = effectiveLarge ? 'text-xs' : effectiveCompact ? 'text-[10px]' : 'text-xs';
    const badgeSize = effectiveLarge ? 'p-1' : effectiveCompact ? 'p-0.5' : 'p-1.5';
    const badgeIconSize = effectiveLarge ? 'w-3 h-3' : effectiveCompact ? 'w-2 h-2' : 'w-3.5 h-3.5';

    // ── Corner chrome (fullscreen grid / people cells only) ──────────────────
    //
    // This card has no picture and never will — `contentRect()` would return
    // null for it — so its insets are the tile's own corners, which is exactly
    // what `tileCornerInsets()` means and exactly the fallback
    // videoRectChrome.ts documents for "a tile that has no picture to ride".
    // It is the SAME gutter VideoTile's chrome uses (CHROME_GUTTER_PX), pulled
    // from that module rather than retyped here, so a camera-off card and the
    // live video tile next to it in the same grid line their names up.
    //
    // There is no top-LEFT cluster to render: the annotation tool exists only
    // on a surface you can draw on, and there is no video here. The one piece
    // of annotation state a card carries — AnnotationGrantBadge, "this person
    // may draw" — rides in the name pill, the same place VideoTile keeps it.
    //
    // The corner comes from `tileChromeSlots(true)` — hard TRUE, not a context
    // read, because `cornerChrome` is set in exactly one place in the app and
    // that place is FullscreenOverlay's grid/people cells (grep it). So this
    // card is only ever a fullscreen tile, and the fullscreen row of the table
    // is the only one that can apply to it. Derived from the table rather than
    // written as the literal 'top-right' so that if the fullscreen row ever
    // moves, this moves with it instead of silently disagreeing with the video
    // tile beside it in the same grid.
    const cornerInsets = tileCornerInsets();
    const nameCorner = tileChromeSlots(true).name;
    const nameRow = (
        <>
            <span className={`truncate min-w-0 ${cornerChrome ? 'max-w-full' : nameTrunc}`} style={{ color: roleColor ?? '#d1d5db' }}>
                {displayName}
            </span>
            <AnnotationGrantBadge identity={p.identity} size={effectiveCompact ? 9 : 11} />
        </>
    );

    return (
        <div className={cornerChrome
            // Fills the cell so the pill's corners ARE the tile's corners, and
            // so `chromeMaxWidthCss`'s `100%` resolves to the tile's width
            // rather than to a shrink-wrapped column's.
            ? 'relative w-full h-full flex flex-col items-center justify-center'
            : `flex flex-col items-center ${effectiveCompact ? 'gap-0.5' : 'gap-2'} relative`}>
            <div className="relative">
                {/* Plain button (not ClButton): ClButton's icon variant pins its inner
                    .cap to a fixed 46px circle, which left the avatar floating in the
                    middle of larger tiles. A bare button lets the avatar fill edge-to-edge. */}
                <button
                    type="button"
                    ref={buttonRef}
                    onClick={(e) => handleToggle(e)}
                    onContextMenu={handleContextMenu}
                    className={`${size} p-0 border-none rounded-full overflow-hidden bg-cl-surface cursor-pointer transition-[transform,box-shadow] duration-150
                        ${isSpeaking && !isLocalMuted && !isMuted && !isLocalDeafened && !isDeafened
                            ? 'ring-2 ring-green-500 shadow-[0_0_20px_rgba(34,197,94,0.3)] scale-105'
                            : 'ring-1 ring-white/10 hover:ring-white/30'}`}
                >
                    <EncryptedAvatar
                        attachmentId={avatarToUse}
                        userId={p.identity}
                        token={token}
                        className={`w-full h-full object-cover ${(isMuted || isDeafened || isLocalMuted || isLocalDeafened) ? 'opacity-50' : ''}`}
                        fallbackSize={effectiveCompact ? 14 : effectiveLarge ? 28 : 32}
                        disableClickProfile
                        bypassFriendGate
                    />
                </button>

                {/* Status badges. Hide-state badges are GATED on the underlying
                    track actually existing right now — the hide preference is
                    sticky (user's choice) but a badge claiming "video is hidden"
                    is misleading once the publisher has turned their camera off.
                    Same for screenshare. When they re-enable the source, the
                    sticky preference takes effect again and the badge returns. */}
                <div className="absolute bottom-0 right-[-4px] flex items-center justify-end z-10 pointer-events-none gap-[-2px]">
                    {isHiddenScreenShare && hasActiveScreenShare && (
                        <div className={`bg-cl-raise rounded-full ${badgeSize} border-[2px] border-[#0B0F1E] shadow-md z-[1]`}>
                            <MonitorOff className={`${badgeIconSize} text-[darkgray]`} />
                        </div>
                    )}
                    {isHiddenVideo && hasActiveCamera && (
                        <div className={`bg-cl-raise rounded-full ${badgeSize} border-[2px] border-[#0B0F1E] shadow-md z-[2] -ml-2`}>
                            <VideoOff className={`${badgeIconSize} text-[darkgray]`} />
                        </div>
                    )}
                    {isDeafened ? (
                        <div className={`bg-red-500 rounded-full ${badgeSize} border-[2px] border-[#0B0F1E] shadow-md z-[3] -ml-2`}>
                            <Headphones className={`${badgeIconSize} text-white`} />
                        </div>
                    ) : isMuted ? (
                        <div className={`bg-red-500 rounded-full ${badgeSize} border-[2px] border-[#0B0F1E] shadow-md z-[3] -ml-2`}>
                            <MicOff className={`${badgeIconSize} text-white`} />
                        </div>
                    ) : isLocalMuted ? (
                        <div className={`bg-cl-raise rounded-full ${badgeSize} border-[2px] border-[#0B0F1E] shadow-md z-[3] -ml-2`}>
                            <MicOff className={`${badgeIconSize} text-[darkgray]`} />
                        </div>
                    ) : null}
                </div>
            </div>

            {/* The name. In corner-chrome mode it moves to the tile's TOP-RIGHT
                corner (owner request, and the shared shell every other tile
                type uses); otherwise it keeps its place directly under the
                avatar, which is the only sensible spot for a card with no tile
                box around it.

                Either way the name pill and its annotation badge share one flex
                ROW — a bare sibling badge would land under the name instead of
                beside it. */}
            {cornerChrome ? (
                <TileNamePill insets={cornerInsets} corner={nameCorner} large={effectiveLarge} className={`${nameSize} font-semibold`}>
                    {nameRow}
                </TileNamePill>
            ) : (
                <div className={`flex items-center gap-1 ${nameSize} font-semibold px-2 py-0.5 rounded-full bg-white/5 max-w-full`}>
                    {nameRow}
                </div>
            )}

            {showPopover && !isLocal && ReactDOM.createPortal(
                <PopoverMenu
                    displayName={displayName}
                    volume={volume}
                    isLocalMuted={isLocalMuted}
                    hasVideo={p.getTrackPublication(Track.Source.Camera) !== undefined}
                    isVideoHidden={isHiddenVideo}
                    hasScreenShare={p.getTrackPublication(Track.Source.ScreenShare) !== undefined}
                    isScreenShareHidden={isHiddenScreenShare}
                    onVolumeChange={setVolume}
                    onMuteChange={onToggleLocalMute}
                    nsEnabled={nsEnabled}
                    onNsEnabledChange={setNsEnabled}
                    onHideVideoChange={onHideVideoChange}
                    onHideScreenShareChange={onHideScreenShareChange}
                    popoverRef={popoverRef}
                    onClose={() => setShowPopover(false)}
                    style={popoverPos}
                    userId={p.identity}
                    onViewProfile={() => setShowPopover(false)}
                    localIdentity={localParticipant?.identity}
                    onRevokeAnnotation={() => setShowPopover(false)}
                    canServerMute={canServerMute}
                    isMicActive={!isMuted}
                    isCamActive={hasActiveCamera}
                    isSsActive={hasActiveScreenShare}
                    onServerMuteAudio={onServerMuteTrack ? (m) => { onServerMuteTrack(p.identity, 'audio', m); setShowPopover(false); } : undefined}
                    onServerMuteVideo={onServerMuteTrack ? (m) => { onServerMuteTrack(p.identity, 'video', m); setShowPopover(false); } : undefined}
                    onServerMuteScreenShare={onServerMuteTrack ? (m) => { onServerMuteTrack(p.identity, 'screenshare', m); setShowPopover(false); } : undefined}
                />,
                document.body
            )}
        </div>
    );
};
