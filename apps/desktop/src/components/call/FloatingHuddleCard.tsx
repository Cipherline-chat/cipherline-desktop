/**
 * FloatingHuddleCard — the full merged teal call card (channel header + call
 * summary + participant rows) shown when the local user has navigated away
 * from their active Huddle call's own server. Mounted inside Dashboard's
 * pane4El, which stays rendered across every tab while a call is active — so
 * this component (and the "your call is still going" reminder it gives) truly
 * follows the user around the app rather than only existing on the server's
 * own ServerContextPanel.
 *
 * Reuses HuddleButton + HuddleCallCard verbatim (same merged-teal-card visual
 * treatment as ServerContextPanel's own rendering — see HuddleButton.tsx's
 * `mergedTeal`) rather than duplicating that styling here.
 *
 * A real component (not an inline IIFE in Dashboard's render) specifically so
 * it can call useCallTelemetrySafe(): <CallProvider> is a CHILD of Dashboard
 * in the tree (see the comment on Dashboard's notifCtxRef effect), so
 * Dashboard's own function body can never read call telemetry directly — only
 * a genuine descendant component mounted inside CallProvider's children can.
 *
 * Participant rows are INTERACTIVE and deliberately mirror ServerContextPanel's
 * own huddle participant rows one-for-one (left-click → profile, right-click →
 * the shared PopoverMenu with volume / local mute / noise suppression / hide
 * video / hide screen share / view profile / server-moderation block, plus the
 * same status-badge cluster). Before this, these rows were purely decorative
 * divs — navigating away from the call's server silently took away every
 * per-participant control, including simply turning someone's volume down.
 * The real interactive rows that SidebarConference portals into
 * #call-sidebar-root are force-hidden (display:none) for huddles by Dashboard
 * — this card's list is the ONLY participant UI on screen while you're away,
 * so it has to carry the interactions itself.
 *
 * The LOCAL user's own row gets a real right-click menu too, not a direct
 * jump into the profile card: "View Profile" plus, when the call's server
 * grants CHANGE_NICKNAME (the @everyone default — see
 * DEFAULT_EVERYONE_PERMISSIONS), a "Change Nickname" shortcut that opens the
 * profile straight into its nickname editor (`autoEditNickname`, see
 * ProfileOpenContext). This mirrors ServerContextPanel's own huddle-roster
 * self row, which falls through to `buildMemberMenu`'s self branch — same
 * two items in the common case. `buildMemberMenu` also offers a Roles
 * submenu to whoever holds MANAGE_ROLES/ADMINISTRATOR, letting them assign
 * roles to themselves; that's intentionally NOT reproduced here — it needs
 * the server's role list, which Dashboard doesn't fetch for a server the
 * user has navigated away from, and self-role-management mid-call is a rare
 * enough edge case that it isn't worth the extra fetch plumbing. (Role
 * membership is still visible read-only on the profile card itself, via
 * ProfileModal's own lazy fetch — see profileRoleCtx below.)
 */

import React from 'react';
import ReactDOM from 'react-dom';
import { MicOff, Headphones, HeadphoneOff, Video, VideoOff, Monitor, MonitorOff } from 'lucide-react';
import { HuddleButton } from '../server/HuddleButton';
import { HuddleCallCard } from '../server/HuddleCallCard';
import { EncryptedAvatar } from '../EncryptedAvatar';
import { AnnotationGrantBadge } from './AnnotationGrantBadge';
import { useCallTelemetrySafe, useCallContextSafe } from '../../contexts/CallContext';
import { useIsCallParticipantSpeaking } from '../../utils/callSpeakingStore';
import { useOpenProfile } from '../../contexts/ProfileOpenContext';
import { useCallServerCtx } from '../../contexts/CallServerCtx';
import { useDismissOnOutsideClick } from '../../hooks/useDismissOnOutsideClick';
import { useContextMenu } from '../../hooks/useContextMenu';
import { buildSelfParticipantMenuItems } from './selfParticipantMenu';
import { usePersistentVolume, usePersistentNsEnabled } from './VideoTile';
import { PopoverMenu, calcPopoverPos } from './PopoverMenu';
import { SignalBars, signalQuality } from './CallStatsPill';
import { pingColor } from '../../hooks/useCallStats';

/** Server-moderation action forwarded up to Dashboard, which owns the token +
 *  server id needed to PATCH /servers/:sid/members/:uid/call-mute. Same shape
 *  as ParticipantCard's `onServerMuteTrack` so both call surfaces speak the
 *  same vocabulary. */
export type ServerMuteTrackFn = (
    targetUserId: string,
    trackType: 'audio' | 'video' | 'screenshare' | 'deafen',
    muted: boolean,
) => void;

interface RowProps {
    uid: string;
    isMe: boolean;
    /** The LOCAL user's identity. Needed alongside `uid` to offer the
     *  popover's "Stop Annotating" row, which is only valid for grants the
     *  local user themselves issued. `isMe` can't stand in for it: the popover
     *  only ever renders on OTHER people's rows. */
    localIdentity: string;
    displayName: string;
    avatarId: string | null;
    token: string | null;
    /** True when the local user may server-mute in this call's server. */
    canServerMute: boolean;
    onServerMuteTrack?: ServerMuteTrackFn;
}

/**
 * One participant row. A real component (not inline JSX in the map below)
 * because it owns per-participant hooks — usePersistentVolume /
 * usePersistentNsEnabled are keyed by identity, so they can only be called
 * once per row, which React's rules of hooks forbid inside a .map() callback.
 *
 * Note these two hooks take a bare identity STRING, not a LiveKit Participant
 * object — which is exactly why this card can reuse them even though it has
 * no access to the LiveKit room (it renders from plain `participantIds`).
 */
const FloatingParticipantRow: React.FC<RowProps> = ({
    uid, isMe, localIdentity, displayName, avatarId, token, canServerMute, onServerMuteTrack,
}) => {
    const telemetry = useCallTelemetrySafe();
    const callCtx = useCallContextSafe();
    const openProfile = useOpenProfile();
    const callServerCtx = useCallServerCtx();

    const [volume, setVolume] = usePersistentVolume(uid, 'mic');
    const [nsEnabled, setNsEnabled] = usePersistentNsEnabled(uid);
    const [popoverPos, setPopoverPos] = React.useState<{ top: number; left: number } | null>(null);
    const popoverRef = React.useRef<HTMLDivElement>(null);
    // Self row's right-click menu — see the docblock above for exactly what
    // it does and doesn't reproduce from ServerContextPanel's self menu.
    const selfMenu = useContextMenu();

    // Same dismissal contract as ParticipantCard / VideoTile: outside-click
    // closes AND is swallowed (so it can't fall through to the row's own
    // onClick and open a profile the user never asked for), and any other
    // popover opening anywhere in the app closes this one.
    useDismissOnOutsideClick(popoverRef, !!popoverPos, () => setPopoverPos(null));
    React.useEffect(() => {
        if (!popoverPos) return;
        const close = () => setPopoverPos(null);
        window.addEventListener('close-all-popovers', close);
        return () => window.removeEventListener('close-all-popovers', close);
    }, [popoverPos]);

    const ts = telemetry?.participantTrackStates?.[uid];
    const pmeta = telemetry?.participantMetadata?.[uid];
    // Per-identity subscription — see utils/callSpeakingStore.ts.
    const isSpeaking = useIsCallParticipantSpeaking(uid);
    const isLocalMutedByMe = callCtx?.localMutedIds.has(uid) ?? false;
    const isVideoHiddenByMe = callCtx?.hiddenVideoIds.has(uid) ?? false;
    const isScreenHiddenByMe = callCtx?.hiddenScreenShareIds.has(uid) ?? false;

    const profileRoleCtx = callServerCtx
        ? { roleIds: [], roles: [], serverId: callServerCtx.serverId, canSetNickname: callServerCtx.canChangeOwnNick }
        : undefined;
    // Same roleCtx, but flagged to open the profile straight into its
    // nickname editor — for the self-menu's "Change Nickname" shortcut
    // below. Only ever read when callServerCtx (hence profileRoleCtx) is
    // defined, but computed unconditionally so it's a plain value rather
    // than a spread-of-possibly-undefined at the call site.
    const nicknameRoleCtx = profileRoleCtx ? { ...profileRoleCtx, autoEditNickname: true } : undefined;

    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        // MUST stop propagation — this row is a descendant of HuddleButton's
        // DOM, which accepts its own onContextMenu. Letting the event bubble
        // would let a parent handler dispatch 'close-all-popovers' and
        // immediately shut the popover we are opening here. Same reasoning as
        // ServerContextPanel's huddle participant rows.
        e.stopPropagation();
        // Your own row has nothing local to adjust (you can't turn your own
        // volume down for yourself) — but unlike a plain left-click, this
        // still opens a real menu rather than jumping straight into the
        // profile, matching what right-clicking yourself in
        // ServerContextPanel's huddle roster offers (its self row falls
        // through to buildMemberMenu's self branch: "View Profile" plus,
        // when CHANGE_NICKNAME is granted, "Change Nickname"). See the
        // docblock above for what's deliberately NOT reproduced (Roles).
        if (isMe) {
            selfMenu.open(e, buildSelfParticipantMenuItems({
                canChangeOwnNick: !!callServerCtx?.canChangeOwnNick,
                // Centered, not at the click point — same convention as
                // every other context-menu-triggered "View Profile" in the
                // app (buildMemberMenu, buildCallParticipantMenu,
                // HuddleParticipantPopover): a ContextMenuItem's onSelect
                // carries no event to anchor on.
                onViewProfile: () => openProfile?.(uid, { x: window.innerWidth / 2, y: window.innerHeight / 2 }, profileRoleCtx),
                onChangeNickname: () => openProfile?.(uid, { x: window.innerWidth / 2, y: window.innerHeight / 2 }, nicknameRoleCtx),
            }), displayName);
            return;
        }
        window.dispatchEvent(new Event('close-all-popovers'));
        setPopoverPos(calcPopoverPos((e.currentTarget as HTMLElement).getBoundingClientRect()));
    };

    return (
        <div
            className="flex items-center gap-2.5 px-2 py-1.5 w-full hover:bg-white/[0.04] transition-colors cursor-pointer"
            onClick={(e) => openProfile?.(uid, { x: e.clientX, y: e.clientY }, profileRoleCtx)}
            onContextMenu={handleContextMenu}
        >
            <div
                className={`w-8 h-8 rounded-full overflow-hidden bg-cl-surface flex items-center justify-center shrink-0 transition-[box-shadow] duration-150 ${isSpeaking ? 'ring-2 ring-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]' : 'ring-1 ring-white/10'}`}
            >
                <EncryptedAvatar
                    attachmentId={avatarId}
                    userId={uid}
                    token={token}
                    fallbackSize={13}
                    bypassFriendGate
                    className="w-full h-full object-cover"
                    disableClickProfile
                />
            </div>
            <span className="flex-1 text-[13px] truncate text-white/80">
                {displayName}{isMe ? ' (you)' : ''}
            </span>
            {/* uid IS the LiveKit identity (identity === user_id
                throughout this app), so the roster can show the
                same annotation badge as the video tiles without
                a Room of its own. */}
            <AnnotationGrantBadge identity={uid} size={12} />

            {isMe && <LocalPing />}

            {/* Status badges — same set, order and colour vocabulary as
                ServerContextPanel's huddle rows. Without these, local-muting
                someone from the popover above would produce no visible
                feedback anywhere on screen while you're away from the server. */}
            {(ts || pmeta || isLocalMutedByMe || isVideoHiddenByMe || isScreenHiddenByMe) && (
                <div className="flex items-center gap-1 shrink-0">
                    {pmeta?.serverMutedAudio && <MicOff className="w-3.5 h-3.5 text-red-500" />}
                    {pmeta?.serverDeafened && <HeadphoneOff className="w-3.5 h-3.5 text-red-500" />}
                    {pmeta?.serverMutedVideo && <VideoOff className="w-3.5 h-3.5 text-red-500" />}
                    {pmeta?.serverMutedScreenShare && <MonitorOff className="w-3.5 h-3.5 text-red-500" />}
                    {pmeta?.deafened && !pmeta?.serverDeafened && (
                        <Headphones className="w-3.5 h-3.5 text-red-400" />
                    )}
                    {ts?.isMuted && !pmeta?.serverMutedAudio && !pmeta?.serverDeafened && !pmeta?.deafened && (
                        <MicOff className="w-3.5 h-3.5 text-red-400" />
                    )}
                    {!ts?.isMuted && !pmeta?.serverDeafened && !pmeta?.deafened && isLocalMutedByMe && (
                        <MicOff className="w-3.5 h-3.5 text-cl-faint" />
                    )}
                    {ts?.hasScreenShare && !pmeta?.serverMutedScreenShare && (
                        isScreenHiddenByMe
                            ? <MonitorOff className="w-3.5 h-3.5 text-cl-faint" />
                            : <Monitor className="w-3.5 h-3.5 text-cl-muted" />
                    )}
                    {ts?.hasCamera && !pmeta?.serverMutedVideo && (
                        isVideoHiddenByMe
                            ? <VideoOff className="w-3.5 h-3.5 text-cl-faint" />
                            : <Video className="w-3.5 h-3.5 text-cl-muted" />
                    )}
                </div>
            )}

            {popoverPos && !isMe && ReactDOM.createPortal(
                <PopoverMenu
                    displayName={displayName}
                    volume={volume}
                    onVolumeChange={setVolume}
                    isLocalMuted={isLocalMutedByMe}
                    onMuteChange={(m) => callCtx?.toggleLocalMute(uid, m)}
                    nsEnabled={nsEnabled}
                    onNsEnabledChange={setNsEnabled}
                    hasVideo={ts?.hasCamera}
                    isVideoHidden={isVideoHiddenByMe}
                    onHideVideoChange={(h) => callCtx?.toggleHideVideo(uid, h)}
                    hasScreenShare={ts?.hasScreenShare}
                    isScreenShareHidden={isScreenHiddenByMe}
                    onHideScreenShareChange={(h) => callCtx?.toggleHideScreenShare(uid, h)}
                    popoverRef={popoverRef}
                    onClose={() => setPopoverPos(null)}
                    style={popoverPos}
                    userId={uid}
                    onViewProfile={() => setPopoverPos(null)}
                    localIdentity={localIdentity}
                    onRevokeAnnotation={() => setPopoverPos(null)}
                    canServerMute={canServerMute}
                    serverMutedAudio={pmeta?.serverMutedAudio}
                    serverMutedVideo={pmeta?.serverMutedVideo}
                    serverMutedScreenShare={pmeta?.serverMutedScreenShare}
                    serverDeafened={pmeta?.serverDeafened}
                    onServerMuteAudio={onServerMuteTrack ? (m) => { onServerMuteTrack(uid, 'audio', m); setPopoverPos(null); } : undefined}
                    onServerDeafen={onServerMuteTrack ? (d) => { onServerMuteTrack(uid, 'deafen', d); setPopoverPos(null); } : undefined}
                    onServerMuteVideo={onServerMuteTrack ? (m) => { onServerMuteTrack(uid, 'video', m); setPopoverPos(null); } : undefined}
                    onServerMuteScreenShare={onServerMuteTrack ? (m) => { onServerMuteTrack(uid, 'screenshare', m); setPopoverPos(null); } : undefined}
                />,
                document.body,
            )}

            {/* Self row's menu — ContextMenu (unlike PopoverMenu above) already
                self-portals to document.body, so no createPortal wrapper needed. */}
            {selfMenu.menu}
        </div>
    );
};

/** Local user's ping + signal bars. Split out so the 3 s stats cadence
 *  re-renders only this leaf rather than the whole participant row. */
const LocalPing: React.FC = () => {
    const telemetry = useCallTelemetrySafe();
    const { pingMs, packetLossPercent } = telemetry?.callStats ?? { pingMs: null, packetLossPercent: null };
    const { bars, color } = signalQuality(pingMs, packetLossPercent);
    return (
        <div className="flex items-center gap-1 shrink-0">
            <SignalBars bars={bars} color={color} />
            <span className={`text-[10px] font-mono tabular-nums ${pingColor(pingMs)}`}>
                {pingMs !== null ? `${pingMs}ms` : '—'}
            </span>
        </div>
    );
};

interface Props {
    channelName: string;
    iconName: string | null;
    iconEmoji: string | null;
    maxCalls: number | null;
    callId: string;
    callName: string;
    spawnedAt?: string;
    participantIds: string[];
    /** True when the local user spawned this call — drives "· you started this". */
    canRename: boolean;
    token: string | null;
    userId: string;
    myUsername: string;
    myAvatarUrl: string | null;
    /** Best-effort user_id → {username, avatar_url} for participants who
     *  aren't the local user (Dashboard only knows accepted friends here —
     *  there's no per-server member list for a server navigated away from). */
    friendNameMap: Record<string, { username: string; avatar_url: string | null }>;
    expanded: boolean;
    onToggleExpanded: () => void;
    /**
     * Real, derived encryption state of THIS call (the local user's own —
     * this card only ever renders for a call the user is actively in), same
     * derivation as ServerContextPanel's row — see HuddleButton's Props
     * comment on encryptionState. Never hardcoded.
     */
    encryptionState?: 'connecting' | 'connected' | 'mixed' | null;
    /** True when the local user holds DEAFEN_MEMBERS / ADMINISTRATOR on the
     *  call's server — surfaces the moderation block in the row popover.
     *  UX-only: the server re-checks the permission on every call-mute. */
    canServerMute?: boolean;
    onServerMuteTrack?: ServerMuteTrackFn;
}

export const FloatingHuddleCard: React.FC<Props> = ({
    channelName, iconName, iconEmoji, maxCalls, callId, callName, spawnedAt,
    participantIds, canRename, token, userId, myUsername, myAvatarUrl, friendNameMap,
    expanded, onToggleExpanded, encryptionState, canServerMute = false, onServerMuteTrack,
}) => {
    return (
        <HuddleButton
            name={channelName}
            iconName={iconName}
            iconEmoji={iconEmoji}
            activeParticipantCount={participantIds.length}
            activeCallCount={1}
            maxCalls={maxCalls}
            // NOT false: HuddleButton shows a "no permission" Lock icon next to
            // the name whenever canConnect is false. isActiveForMe already hides
            // the "+" spawn button and makes the row body's onClick a no-op via
            // HuddleButton's own isActiveForMe gate, so canConnect=true here is
            // safe and avoids that misleading icon while you're plainly already
            // in the call.
            canConnect
            isActiveForMe
            encryptionState={encryptionState}
            expanded={expanded}
            onToggleExpanded={onToggleExpanded}
            onSpawn={() => { /* no-op — spawning a new call doesn't apply away from the server */ }}
        >
            <HuddleCallCard
                callId={callId}
                name={callName}
                // HuddleCallCard's "X in call" subtitle text reads
                // participants.length UNCONDITIONALLY (only the avatar-stack vs.
                // duration display is gated by isMine) — passing [] here was
                // showing "0 in call" under a header that correctly said "1 in
                // voice". user_id is all HuddleCallCard needs; it never renders
                // per-participant names/avatars when isMine.
                participants={participantIds.map(id => ({ user_id: id }))}
                isMine
                canRename={canRename}
                canConnect={false}
                token={token}
                spawnedAt={spawnedAt}
                memberLimit={maxCalls}
                onJoin={() => {}}
                onLeave={() => {}}
            />
            <div className="flex flex-col w-full">
                {participantIds.map(uid => {
                    const isMe = uid === userId;
                    const friend = friendNameMap[uid];
                    return (
                        <FloatingParticipantRow
                            key={uid}
                            uid={uid}
                            isMe={isMe}
                            localIdentity={userId}
                            displayName={isMe ? myUsername : (friend?.username ?? 'Member')}
                            avatarId={isMe ? myAvatarUrl : (friend?.avatar_url ?? null)}
                            token={token}
                            canServerMute={canServerMute && !isMe}
                            onServerMuteTrack={onServerMuteTrack}
                        />
                    );
                })}
            </div>
        </HuddleButton>
    );
};

export default FloatingHuddleCard;
