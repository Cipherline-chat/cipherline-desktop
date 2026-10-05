import React from 'react';
import { MicOff, Monitor, Eye, EyeOff, Users, AudioLines, VideoOff, MonitorOff, HeadphoneOff, Check, PencilOff, PenLine, Flag } from 'lucide-react';
import { ResetSlider } from '../ResetSlider';
import { useOpenProfile } from '../../contexts/ProfileOpenContext';
import { useCallServerCtx } from '../../contexts/CallServerCtx';
import { useReportOpen } from '../../contexts/ReportOpenContext';
import { useEscape } from '../../hooks/useEscape';
import {
    annotationStore, useAnnotationStore, selectCanRevoke, selectCanGrantAnnotation,
    selectGrantTarget, isScreenShareTrack,
} from '../../utils/annotationStore';

/**
 * PopoverMenu — the right-click / click menu on a call participant. Shared
 * by every call surface in the app: server voice channels, DM calls, group
 * calls — one component, all three contexts, opened from ParticipantCard.tsx
 * (audio-only strip / row / tile modes) and VideoTile.tsx (video grid).
 *
 * Rides the app's canonical right-click menu vocabulary (.ctxm in
 * cl-kit-ext.css — the same spring entrance, lume hover, mono eyebrow title
 * used by every other context menu in the app, see ContextMenu.tsx) instead
 * of its old bespoke bg-cl-raise box. Not built ON TOP OF ContextMenu.tsx
 * itself — this menu mixes real menu rows with a volume slider and
 * checkbox-style toggles, which doesn't fit ContextMenu's ContextMenuItem
 * union — but every row and the shell borrow its exact classes so the two
 * read as the same design system.
 *
 * Server-moderator rows use an orange variant (.ctxm-row--mod, defined
 * alongside .ctxm-row in cl-kit-ext.css) rather than the red .danger
 * variant — these are toggleable moderation controls, not destructive
 * one-shot actions, and orange was already this menu's established
 * "moderator action" tint before this redo.
 */

export interface PopoverMenuProps {
    displayName: string;
    volume: number;
    screenShareVolume?: number;
    isLocalMuted: boolean;
    hasVideo?: boolean;
    isVideoHidden?: boolean;
    hasScreenShare?: boolean;
    isScreenShareHidden?: boolean;
    isScreenShare?: boolean;
    onVolumeChange: (v: number) => void;
    onScreenShareVolumeChange?: (v: number) => void;
    onMuteChange: (v: boolean) => void;
    isScreenShareMuted?: boolean;
    onScreenShareMuteChange?: (v: boolean) => void;
    nsEnabled?: boolean;
    onNsEnabledChange?: (v: boolean) => void;
    onHideVideoChange?: (v: boolean) => void;
    onHideScreenShareChange?: (v: boolean) => void;
    streamRes?: string;
    popoverRef: React.Ref<HTMLDivElement>;
    style: React.CSSProperties;
    /** LiveKit participant identity, used as user_id for the "View Profile" action. */
    userId?: string;
    /** Called when the user picks "View Profile" — typically closes the popover. */
    onViewProfile?: () => void;
    /**
     * The LOCAL user's LiveKit identity. Supplying it (alongside `userId`)
     * enables the annotation row — the right-click way to hand out or take
     * back an annotation grant, asked for because the only other route was
     * the grant list buried in the streamer's own focused tile.
     *
     * Exactly one of two rows appears, and only when it would actually do
     * something: "Stop Annotating" when `userId` holds a grant on a surface
     * the local user owns, "Allow Annotating" when they hold none and the
     * local user is publishing a surface to grant on. Neither can act on a
     * stranger's share — a grant list is authoritative from its owner alone
     * (annotationTransport's `grant.list` owner check), so every other client
     * would ignore it.
     */
    localIdentity?: string;
    /** Called after an annotation grant is revoked — typically closes the popover. */
    onRevokeAnnotation?: () => void;
    /** Current track-active state, tile-mode callers only — not currently
     *  read by this menu, kept so callers can pass their already-derived
     *  state without a type error. */
    isMicActive?: boolean;
    isCamActive?: boolean;
    isSsActive?: boolean;
    /** Server-mute controls — only rendered for moderators (DEAFEN_MEMBERS) on non-self popovers. */
    canServerMute?: boolean;
    /** Server-moderation state, read from participant metadata. Each item is the
     *  current "moderated" state — checkbox checked when true. Toggling fires
     *  the matching onServerMuteX(!current) callback. */
    serverMutedAudio?: boolean;
    serverMutedVideo?: boolean;
    serverMutedScreenShare?: boolean;
    serverDeafened?: boolean;
    onServerMuteAudio?: (muted: boolean) => void;
    onServerMuteVideo?: (muted: boolean) => void;
    onServerMuteScreenShare?: (muted: boolean) => void;
    onServerDeafen?: (deafened: boolean) => void;
    /**
     * TASK 2: dismiss the popover. Optional only so a caller that somehow
     * cannot offer one degrades to "no Escape handling" rather than a type
     * error — every current caller passes it (mounting = open for this
     * component, same as ContextMenu/SubMenu, so the layer is unconditional).
     */
    onClose?: () => void;
}

/** Plain action row — matches ContextMenu.tsx's MenuRow markup exactly
 *  (.ctxm-row, .ci icon slot, .clabel) so hover/focus styling is identical. */
const ActionRow: React.FC<{
    icon: React.ReactNode;
    label: string;
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
    /** Red `.danger` variant (cl-kit-ext.css) — for rows that take something
     *  away rather than toggle it. */
    danger?: boolean;
}> = ({ icon, label, onClick, danger }) => (
    <button type="button" role="menuitem" className={`ctxm-row${danger ? ' danger' : ''}`} onClick={onClick}>
        <span className="ci" aria-hidden="true">{icon}</span>
        <span className="clabel">{label}</span>
    </button>
);

/** Checkbox row — the menuitemcheckbox pattern from ContextMenu.tsx's
 *  MenuRow, reused here for local toggles (Mute, Noise Suppression,
 *  Mute Stream). `mod` tints it orange for the server-moderator block. */
const CheckRow: React.FC<{
    icon: React.ReactNode;
    label: string;
    checked: boolean;
    onChange: (v: boolean) => void;
    mod?: boolean;
}> = ({ icon, label, checked, onChange, mod }) => (
    <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={checked}
        className={`ctxm-row${mod ? ' ctxm-row--mod' : ''}`}
        onClick={() => onChange(!checked)}
    >
        <span className="ci" aria-hidden="true">{icon}</span>
        <span className="clabel">{label}</span>
        <span className={`ctxm-chk${checked ? ' on' : ''}`} aria-hidden="true">
            {checked && <Check size={11} strokeWidth={3} />}
        </span>
    </button>
);

export const PopoverMenu = ({
    displayName, volume, screenShareVolume,
    isLocalMuted, isScreenShare, hasVideo, isVideoHidden, hasScreenShare, isScreenShareHidden,
    onVolumeChange, onScreenShareVolumeChange, onMuteChange, isScreenShareMuted, onScreenShareMuteChange,
    nsEnabled, onNsEnabledChange, onHideVideoChange, onHideScreenShareChange,
    streamRes,
    popoverRef, style, userId, onViewProfile,
    localIdentity, onRevokeAnnotation,
    canServerMute,
    serverMutedAudio = false, serverMutedVideo = false, serverMutedScreenShare = false, serverDeafened = false,
    onServerMuteAudio, onServerMuteVideo, onServerMuteScreenShare, onServerDeafen,
    onClose,
}: PopoverMenuProps) => {
    useEscape(() => onClose?.(), !!onClose);
    const openProfile = useOpenProfile();
    const callServerCtx = useCallServerCtx();
    const openReport = useReportOpen();
    const canViewProfile = !!userId && !!openProfile;
    // No isSelf check needed: every caller of this menu (ParticipantCard,
    // VideoTile, ScreenShareGate, FloatingHuddleCard,
    // ServerContextPanel's HuddleParticipantPopover) already gates it to
    // remote participants only before ever rendering it.
    const canReport = !!userId && !!openReport;
    // Live: if the streamer revokes from somewhere else (or the peer leaves,
    // dropping their tracks) while this menu is open, the row disappears.
    const canRevokeAnnotation = useAnnotationStore(selectCanRevoke(localIdentity ?? '', userId ?? ''));
    // The inverse: offer access to someone who never asked. Needs a LIVE
    // surface of ours to grant on, which is why it reads ownedSurfaces rather
    // than inferring one from the grant map.
    const canGrantAnnotation = useAnnotationStore(selectCanGrantAnnotation(localIdentity ?? '', userId ?? ''));
    const grantTarget = useAnnotationStore(selectGrantTarget(localIdentity ?? ''));
    return (
        <div className="cl-kit">
            <div
                ref={popoverRef}
                role="menu"
                aria-orientation="vertical"
                className="ctxm"
                style={{ ...style, position: 'fixed', width: 200, maxWidth: '90vw', zIndex: 9999 }}
                onContextMenu={e => e.preventDefault()}
            >
                <div className="ctxm-title" aria-hidden="true">{displayName}</div>

                {streamRes && (
                    <div className="flex items-center justify-between px-[11px] py-1 mb-1 text-[10px]">
                        <span className="text-cl-faint">Resolution</span>
                        <span className="ctxm-acc">{streamRes}</span>
                    </div>
                )}

                {/* Mic volume — range widened from 0..2 to 0..4 (max 400%). The
                    perceptual gain curve in useParticipantAudio.ts converts slider
                    value → linear gain via x^1.5, so 200% lands at ≈+9 dB and 400%
                    at ≈+18 dB — enough headroom to recover a genuinely quiet peer. */}
                <div className="flex flex-col gap-1 px-[11px] mb-2.5">
                    <div className="flex justify-between items-center text-[10px]">
                        <span className="text-cl-faint">Volume</span>
                        <span className="text-cl-lume font-semibold">{Math.round(volume * 100)}%</span>
                    </div>
                    <ResetSlider min={0} max={4} step={0.05} value={volume} resetValue={1} onChangeValue={onVolumeChange} />
                </div>

                {/* Screenshare audio volume — same widened range. */}
                {isScreenShare && onScreenShareVolumeChange && (
                    <div className="flex flex-col gap-1 px-[11px] mb-2.5 pt-2 border-t border-white/5">
                        <div className="flex justify-between items-center text-[10px]">
                            <span className="text-cl-faint">Screen Audio</span>
                            <span className="text-cl-lume font-semibold">{Math.round((screenShareVolume ?? 1) * 100)}%</span>
                        </div>
                        <ResetSlider min={0} max={4} step={0.05} value={screenShareVolume ?? 1} resetValue={1} onChangeValue={onScreenShareVolumeChange} />
                    </div>
                )}

                <div className="ctxm-sep" />

                <CheckRow icon={<MicOff size={15} />} label="Mute" checked={isLocalMuted} onChange={onMuteChange} />

                {onNsEnabledChange !== undefined && (
                    <CheckRow icon={<AudioLines size={15} />} label="Noise Suppression" checked={nsEnabled ?? false} onChange={onNsEnabledChange} />
                )}

                {isScreenShare && onScreenShareMuteChange !== undefined && (
                    <CheckRow icon={<Monitor size={15} />} label="Mute Stream" checked={isScreenShareMuted ?? false} onChange={onScreenShareMuteChange} />
                )}

                {hasVideo && onHideVideoChange && (
                    <ActionRow
                        icon={isVideoHidden ? <Eye size={15} /> : <EyeOff size={15} />}
                        label={isVideoHidden ? 'Show Video' : 'Hide Video'}
                        onClick={() => onHideVideoChange(!isVideoHidden)}
                    />
                )}

                {hasScreenShare && onHideScreenShareChange && (
                    <ActionRow
                        icon={isScreenShareHidden ? <Monitor size={15} /> : <EyeOff size={15} />}
                        label={isScreenShareHidden ? 'Show Screen Share' : 'Hide Screen Share'}
                        onClick={() => onHideScreenShareChange(!isScreenShareHidden)}
                    />
                )}

                {canViewProfile && (
                    <ActionRow
                        icon={<Users size={15} />}
                        label="View Profile"
                        onClick={(e) => {
                            // Anchor the popover at the View-Profile button's own click point —
                            // it's inside the participant popover, which was itself positioned
                            // near the original click, so this feels contiguous.
                            const roleCtx = callServerCtx ? {
                                roleIds: [], roles: [],
                                serverId: callServerCtx.serverId,
                                canSetNickname: callServerCtx.canManageNick,
                            } : undefined;
                            openProfile!(userId!, { x: e.clientX, y: e.clientY }, roleCtx);
                            onViewProfile?.();
                        }}
                    />
                )}

                {/* Annotation access, both directions. Exactly one of these
                    two rows can ever be showing: "Stop" needs them to hold a
                    grant on a surface we own, "Allow" needs them to hold none
                    AND us to be publishing something to grant on. Two one-shot
                    actions rather than one checkbox, because they are not
                    symmetric — a revoke clears every surface we own (a name is
                    not scoped to a surface), while a grant lands on ONE.

                    Granting from here is the streamer offering access to
                    someone who never asked — the "just let them draw" case.
                    It is still per-owner-per-surface: there is deliberately no
                    room-wide "anyone may draw" anywhere in this feature. */}
                {canRevokeAnnotation && (
                    <ActionRow
                        danger
                        icon={<PencilOff size={15} />}
                        label="Stop Annotating"
                        onClick={() => {
                            annotationStore.revokeAllFrom(localIdentity!, userId!);
                            onRevokeAnnotation?.();
                        }}
                    />
                )}
                {canGrantAnnotation && (
                    <ActionRow
                        icon={<PenLine size={15} />}
                        label={grantTarget && isScreenShareTrack(grantTarget) ? 'Allow Annotating on Screen' : 'Allow Annotating'}
                        onClick={() => {
                            annotationStore.grantOnOwnedSurface(localIdentity!, userId!);
                            onRevokeAnnotation?.();
                        }}
                    />
                )}

                {/* ── Server moderator controls ──────────────────────────────────
                    Single-checkbox model: each row is a toggle that reflects the
                    current server-moderation state from the participant metadata.
                    Label stays constant ("Server Mute", "Disable Video", etc.) —
                    the box being filled is what tells the moderator the action
                    is currently applied. Orange (.ctxm-row--mod), not red
                    (.danger) — these toggle on/off, they don't destroy anything. */}
                {canServerMute && (
                    <>
                        <div className="ctxm-sep" />
                        {onServerMuteAudio && (
                            <CheckRow mod icon={<MicOff size={15} />} label="Server Mute" checked={serverMutedAudio} onChange={onServerMuteAudio} />
                        )}
                        {onServerDeafen && (
                            <CheckRow mod icon={<HeadphoneOff size={15} />} label="Server Deafen" checked={serverDeafened} onChange={onServerDeafen} />
                        )}
                        {onServerMuteVideo && (
                            <CheckRow mod icon={<VideoOff size={15} />} label="Disable Video" checked={serverMutedVideo} onChange={onServerMuteVideo} />
                        )}
                        {onServerMuteScreenShare && (
                            <CheckRow mod icon={<MonitorOff size={15} />} label="Disable Screen Share" checked={serverMutedScreenShare} onChange={onServerMuteScreenShare} />
                        )}
                    </>
                )}

                {/* Report — last and danger-styled, matching every other
                    report entry point in the app (buildMemberMenu, the
                    friends-list rows, ProfileModal's 3-dot menu). This is
                    the one place a call PARTICIPANT (as opposed to a member
                    list row or a message) can be reported, so it needs to
                    live here rather than assuming the reporter can back out
                    to a member list that may not even apply (DM/group calls
                    have none). */}
                {canReport && (
                    <>
                        <div className="ctxm-sep" />
                        <ActionRow
                            danger
                            icon={<Flag size={15} />}
                            label="Report User"
                            onClick={() => {
                                // Every popover/tile in the call tree already
                                // listens for this to self-close (cross-tile
                                // coordination — see VideoTile.tsx) — reuse it
                                // here instead of adding a dedicated onReport
                                // prop just to dismiss this one.
                                window.dispatchEvent(new Event('close-all-popovers'));
                                openReport!(userId!, displayName);
                            }}
                        />
                    </>
                )}
            </div>
        </div>
    );
};

export function calcPopoverPos(rect: DOMRect): { top: number; left: number } {
    const popoverWidth = 200;
    // Conservative max-height matching the modal's content (volume slider +
    // up to ~6 menu rows = ~300 px on the densest popovers). If the actual
    // popover is shorter we just leave a bit of bottom margin — fine.
    const popoverMaxHeight = 320;
    const VIEWPORT_MARGIN = 16;

    const maxLeft = window.innerWidth - popoverWidth - VIEWPORT_MARGIN;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left - (popoverWidth / 2) + (rect.width / 2), maxLeft));

    // Vertical: prefer placing BELOW the avatar (rect.bottom + 8). If that
    // would push off the bottom edge of the window — common in narrow/short
    // windows where avatars live near the bottom of the call panel — flip
    // ABOVE instead. As a last resort (popover taller than the entire
    // viewport) clamp to the top of the screen.
    let top = rect.bottom + 8;
    if (top + popoverMaxHeight > window.innerHeight - VIEWPORT_MARGIN) {
        // Try flipping above
        const flipped = rect.top - popoverMaxHeight - 8;
        top = flipped >= VIEWPORT_MARGIN
            ? flipped
            : Math.max(VIEWPORT_MARGIN, window.innerHeight - popoverMaxHeight - VIEWPORT_MARGIN);
    }
    return { top, left };
}
