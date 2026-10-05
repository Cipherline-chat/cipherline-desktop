import React from 'react';
import { Track, RemoteParticipant, RemoteTrackPublication, ParticipantEvent } from 'livekit-client';
import { MicOff, Headphones, Monitor, X } from 'lucide-react';
import { ClButton } from '../cl';
import { EncryptedAvatar } from '../EncryptedAvatar';
import { useDismissOnOutsideClick } from '../../hooks/useDismissOnOutsideClick';
import { PopoverMenu } from './PopoverMenu';
import { AnnotationGrantBadge } from './AnnotationGrantBadge';
import { ViewerCountBadge } from './ViewerCountBadge';
import { usePersistentVolume, useFastIsSpeaking, useIsMicMuted } from './VideoTile';
import { useParticipantAudio } from '../../hooks/useParticipantAudio';
import { TileNamePill } from './TileCornerChrome';
import { tileCornerInsets, tileChromeSlots } from './videoRectChrome';

export interface ScreenShareGateProps {
    p: RemoteParticipant;
    localParticipant: any;
    token: string;
    avatarAttachmentId?: string;
    isLocalDeafened: boolean;
    isLocalMuted: boolean;
    onToggleLocalMute: (v: boolean) => void;
    onSubscribed: (identity: string) => void;
    onHideScreenShare?: () => void;
    /**
     * When true, the gate fills its parent (width 100% height 100%) instead of
     * forcing its own 16:9 aspect ratio. Set this from grid layouts where the
     * cell shape is already determined; without it the aspect-video gate can
     * push its content (identity row + Watch button) past the bottom edge
     * of the cell, where it's clipped by the parent's overflow-hidden.
     */
    fillContainer?: boolean;
    /**
     * Render the participant's name in the tile's TOP-RIGHT corner, the way
     * every other tile in a fullscreen or focused call does, instead of only
     * inline in the centred "X is sharing" line.
     *
     * Set by FullscreenOverlay, where this gate is a tile in a grid / strip /
     * stage next to VideoTiles and ParticipantCards and has to label itself the
     * same way they do. There is no picture here — an unsubscribed share has
     * nothing decoded to letterbox — so the corner is the TILE's own corner,
     * which is `videoRectChrome`'s documented no-picture fallback and the same
     * gutter every other tile uses.
     *
     * The centred block drops the duplicate name when this is on (it becomes
     * "is sharing their screen") rather than printing it twice on one tile.
     *
     * Off in the sidebar, where the gate is a full-width card in a vertical
     * stack rather than a cell in a grid, and the centred identity line is the
     * whole point of the card.
     */
    cornerChrome?: boolean;
}

export const ScreenShareGate = ({
    p,
    localParticipant,
    token,
    avatarAttachmentId,
    isLocalDeafened,
    isLocalMuted,
    onToggleLocalMute,
    onSubscribed,
    onHideScreenShare,
    fillContainer,
    cornerChrome = false,
}: ScreenShareGateProps) => {
    // Never show the raw user_id — fall through to "Unknown" if the LiveKit
    // token didn't include a display name.
    const displayName = p.name || 'Unknown';
    const isSpeaking = useFastIsSpeaking(p);
    // Reactive (TrackMuted/Unmuted/Published/Unpublished) — this gate's own
    // forceRender effect below only listens for metadata/attribute changes,
    // so a raw p.isMicrophoneEnabled read never picked up a plain mute
    // toggle: the badge stayed frozen until something else (e.g. the
    // deafen flag) happened to force a re-render, which read as "have to
    // reload to see someone mute" for anyone sitting on this gate.
    const isMuted = useIsMicMuted(p);
    const [subscribing, setSubscribing] = React.useState(false);

    const [volume, setVolume] = usePersistentVolume(p.identity, 'mic');
    const [showPopover, setShowPopover] = React.useState(false);
    const [popoverPos, setPopoverPos] = React.useState({ top: 0, left: 0 });
    const popoverRef = React.useRef<HTMLDivElement>(null);
    const [, forceRender] = React.useState(0);

    React.useEffect(() => {
        const onMeta = () => forceRender(n => n + 1);
        p.on(ParticipantEvent.ParticipantMetadataChanged, onMeta);
        try { p.on(ParticipantEvent.AttributesChanged as any, onMeta); } catch {}
        return () => {
            p.off(ParticipantEvent.ParticipantMetadataChanged, onMeta);
            try { p.off(ParticipantEvent.AttributesChanged as any, onMeta); } catch {}
        };
    }, [p]);

    // Audio management. isScreenShare: true so useParticipantAudio's mic-chain
    // dedupe kicks in — if the participant has a camera tile showing somewhere
    // else, that tile handles mic playback and we skip setting up a duplicate.
    // screenShareSubscribed: false because the gate is by definition the
    // unsubscribed state. Without this flag the hook would attach to the
    // ScreenShareAudio track and play it — which is exactly the "audio
    // comes through before I click watch" bug. The hook also defensively
    // calls setSubscribed(false) on the audio pub when the flag is false,
    // undoing LiveKit's default autoSubscribe behaviour.
    useParticipantAudio(p, localParticipant?.identity, {
        volume,
        isLocalMuted,
        isLocalDeafened,
        isScreenShare: true,
        screenShareSubscribed: false,
    });

    const handleContextMenu = (e: React.MouseEvent | React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new Event('close-all-popovers'));
        const popoverWidth = 172;
        const left = Math.max(16, Math.min(e.clientX, window.innerWidth - popoverWidth - 16));
        const top = Math.max(16, Math.min(e.clientY, window.innerHeight - 300));
        setPopoverPos({ top, left });
        setShowPopover(true);
    };

    useDismissOnOutsideClick(popoverRef, showPopover, () => setShowPopover(false));
    React.useEffect(() => {
        if (!showPopover) return;
        const closePopover = () => setShowPopover(false);
        window.addEventListener('close-all-popovers', closePopover);
        return () => window.removeEventListener('close-all-popovers', closePopover);
    }, [showPopover]);

    const handleWatch = async () => {
        setSubscribing(true);
        try {
            const ssPub = p.getTrackPublication(Track.Source.ScreenShare) as RemoteTrackPublication | undefined;
            const ssAudioPub = p.getTrackPublication(Track.Source.ScreenShareAudio) as RemoteTrackPublication | undefined;
            if (ssPub) await ssPub.setSubscribed(true);
            if (ssAudioPub) await ssAudioPub.setSubscribed(true);
            onSubscribed(p.identity);
        } catch (e) {
            console.error('Failed to subscribe to screenshare', e);
            setSubscribing(false);
        }
    };

    return (
        <div
            className={`relative @container ${
                fillContainer
                    ? 'w-full h-full'
                    : 'w-full aspect-video shrink-0 min-h-[64px]'
            } rounded-xl overflow-hidden bg-cl-abyss flex flex-col items-center justify-center px-2 py-1.5 transition-all group ss-gate-enter
                ${isSpeaking && !isLocalMuted && !isLocalDeafened ? 'border-2 border-green-500 shadow-[0_0_20px_rgba(34,197,94,0.2)]' : 'border border-cl-lume/20'}`}
        >
            {/* Hit surface — right click for the context menu; left click is a
                shorthand for "Click to Watch" so the whole card (not just the
                slimmed-down button) is a comfortable target. */}
            <div
                className="absolute inset-0 z-10 bg-transparent cursor-pointer pointer-events-auto"
                onClick={() => { if (!subscribing) handleWatch(); }}
                onContextMenu={handleContextMenu}
                onPointerDown={e => { if (e.button === 2) handleContextMenu(e); }}
            />

            <div className="absolute inset-0 bg-gradient-to-t from-cl-lume/15 via-transparent to-transparent opacity-60 pointer-events-none" />
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-32 h-32 bg-cl-lume/20 blur-3xl rounded-full pointer-events-none group-hover:bg-cl-lume/30 transition-all duration-700" />

            {/* Standard Mode — identity + action collapsed to two tight rows.
                A small inline avatar (not the old 40px hero circle) is plenty
                to place who's sharing; the name alone already does most of
                that work. */}
            <div className="hidden @[220px]:flex flex-col items-center justify-center gap-1.5 relative z-10 w-full px-2 pointer-events-none">
                <div className="flex items-center justify-center gap-1.5 max-w-full pointer-events-auto">
                    <div className="w-5 h-5 rounded-full overflow-hidden ring-1 ring-white/10 shrink-0">
                        <EncryptedAvatar
                            attachmentId={avatarAttachmentId}
                            userId={p.identity}
                            token={token}
                            className="w-full h-full object-cover"
                            fallbackSize={11}
                            disableClickProfile
                            bypassFriendGate
                        />
                    </div>
                    {/* The name lives in the top-right pill in corner-chrome
                        mode (see `cornerChrome`), so printing it here too would
                        put it on the tile twice. The avatar beside this line
                        stays either way — it is the thing that makes "is
                        sharing" read as a person rather than a status. */}
                    <p className="text-white text-xs font-semibold flex items-center gap-1 min-w-0 max-w-full">
                        {!cornerChrome && <span className="truncate min-w-0">{displayName}</span>}
                        {!cornerChrome && <AnnotationGrantBadge identity={p.identity} size={11} />}
                        <span className="text-gray-500 font-normal shrink-0">
                            {cornerChrome ? 'is sharing their screen' : 'is sharing'}
                        </span>
                        {/* Social proof on the gate itself: "two people are
                            already watching this" is exactly the thing that
                            makes the Watch button worth pressing. Hidden at
                            zero (see ViewerCountBadge) so an unwatched share
                            isn't advertised as one. */}
                        <ViewerCountBadge publisher={p.identity} size={11} />
                    </p>
                </div>
                <div className="flex items-center justify-center gap-1 pointer-events-auto">
                    <ClButton
                        variant="ghost"
                        size="sm"
                        onClick={handleWatch}
                        disabled={subscribing}
                        loading={subscribing}
                    >
                        <Monitor className="w-3 h-3 shrink-0" />
                        <span className="truncate">{subscribing ? 'Loading...' : 'Watch'}</span>
                    </ClButton>
                    {onHideScreenShare && (
                        <button
                            type="button"
                            onClick={onHideScreenShare}
                            aria-label="Hide screenshare prompt"
                            title="Hide screenshare prompt"
                            className="shrink-0 grid place-items-center w-6 h-6 rounded-md text-white/50 hover:text-white hover:bg-white/10 transition-colors"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
            </div>

            {/* Compact Mode — same collapse, sized down further for narrow
                strip tiles. */}
            <div className="flex @[220px]:hidden flex-col items-center justify-center gap-1 w-full relative z-10 pointer-events-none">
                {!cornerChrome && (
                    <p className="text-white text-xs font-semibold px-1 w-full flex items-center justify-center gap-1">
                        <span className="truncate min-w-0">{displayName}</span>
                        <AnnotationGrantBadge identity={p.identity} size={10} />
                    </p>
                )}
                <div className="flex items-center justify-center gap-1 pointer-events-auto">
                    <ClButton
                        variant="ghost"
                        size="sm"
                        onClick={handleWatch}
                        disabled={subscribing}
                        loading={subscribing}
                    >
                        <Monitor className="w-3 h-3 shrink-0" />
                        {subscribing ? 'Wait' : 'Watch'}
                    </ClButton>
                    {onHideScreenShare && (
                        <button
                            type="button"
                            onClick={onHideScreenShare}
                            aria-label="Hide screenshare prompt"
                            title="Hide screenshare prompt"
                            className="shrink-0 grid place-items-center w-5 h-5 rounded-md text-white/50 hover:text-white hover:bg-white/10 transition-colors"
                        >
                            <X className="w-3 h-3" />
                        </button>
                    )}
                </div>
            </div>

            {/* Name pill — the same shell, the same gutter and the same width
                cap as every other tile in a fullscreen call. No picture exists
                here (an unsubscribed share has nothing decoded), so the anchor
                is the TILE's own corner via `tileCornerInsets()` —
                videoRectChrome.ts's documented no-picture fallback, not a
                degraded one.

                The CORNER comes from `tileChromeSlots(true)` — hard TRUE,
                because `cornerChrome` is only ever set by FullscreenOverlay
                (grep it), so this tile is fullscreen by construction and the
                fullscreen row of the table is the only one that can apply.
                Taken from the table rather than written as 'top-right' so it
                cannot drift from the VideoTile sitting next to it in the same
                grid.

                No tool cluster in the opposite corner: you cannot draw on a
                share you have not subscribed to, so there is no annotation tool
                for this tile to place. The grant badge rides in the pill, as it
                does on a VideoTile. */}
            {cornerChrome && (
                <TileNamePill insets={tileCornerInsets()} corner={tileChromeSlots(true).name}>
                    <span className="text-white text-[11px] font-semibold truncate min-w-0">{displayName}</span>
                    <AnnotationGrantBadge identity={p.identity} size={10} />
                    <Monitor className="w-3 h-3 text-cl-lume shrink-0" />
                    <ViewerCountBadge publisher={p.identity} size={10} />
                </TileNamePill>
            )}

            {/* Status badges */}
            {(() => {
                let ssIsDeafened = false;
                try { if (p.metadata) ssIsDeafened = JSON.parse(p.metadata).deafened === true; } catch {}
                const ssIsMuted = isMuted;
                return ssIsDeafened ? (
                    <div className="absolute bottom-2 right-2 bg-red-500 rounded-full p-1 border-[2px] border-[#0B0F1E] shadow-md z-30 pointer-events-none">
                        <Headphones className="w-2.5 h-2.5 text-white" />
                    </div>
                ) : ssIsMuted ? (
                    <div className="absolute bottom-2 right-2 bg-red-500 rounded-full p-1 border-[2px] border-[#0B0F1E] shadow-md z-30 pointer-events-none">
                        <MicOff className="w-2.5 h-2.5 text-white" />
                    </div>
                ) : isLocalMuted ? (
                    <div className="absolute bottom-2 right-2 bg-cl-raise rounded-full p-1 border-[2px] border-[#0B0F1E] shadow-md z-30 pointer-events-none">
                        <MicOff className="w-2.5 h-2.5 text-[darkgray]" />
                    </div>
                ) : null;
            })()}

            {showPopover && p.identity !== localParticipant?.identity && (
                <PopoverMenu
                    displayName={displayName}
                    volume={volume}
                    isLocalMuted={isLocalMuted}
                    onVolumeChange={setVolume}
                    onMuteChange={onToggleLocalMute}
                    hasScreenShare={true}
                    onHideScreenShareChange={onHideScreenShare ? () => onHideScreenShare() : undefined}
                    popoverRef={popoverRef}
                    onClose={() => setShowPopover(false)}
                    style={popoverPos}
                    userId={p.identity}
                    onViewProfile={() => setShowPopover(false)}
                    localIdentity={localParticipant?.identity}
                    onRevokeAnnotation={() => setShowPopover(false)}
                />
            )}
        </div>
    );
};
