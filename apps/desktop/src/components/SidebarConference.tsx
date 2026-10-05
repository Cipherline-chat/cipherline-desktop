import React from 'react';
import ReactDOM from 'react-dom';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { useParticipants, useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { Track, RoomEvent, ParticipantEvent, TrackEvent, RemoteParticipant, RemoteTrackPublication, VideoQuality, LocalAudioTrack, LocalVideoTrack } from 'livekit-client';
import { Mic, WifiOff, VideoOff } from 'lucide-react';
import { ClButton } from './cl';
import * as voiceProcessorManager from '../utils/voiceProcessorManager';
import { CipherlineCameraProcessor, isCameraProcessingNeeded } from '../utils/cameraProcessor';
import type { VoiceSettingsHook } from '../hooks/useVoiceSettings';

import type { ScreenShareOptions } from './ScreenSharePickerModal';
import {
    resolveSSResolution,
    computeSSBitrate,
    applyScreenShareSenderParams,
    asScreenShareCodec,
    buildScreenSharePublishOptions,
    decideScreenShareCodec,
    probeHardwareEncoders,
    retuneScreenShareInPlace,
    captureFrameRateFor,
    installH264HighPreference,
    watchH264HighStart,
    markH264HighFailed,
    hasH264HighFailed,
    type SenderCreatedSource,
} from '../utils/screenShare';
import { getScreenShareCodecPref } from '../utils/streamDiagnosticsPrefs';
import { parseMainDiagnostics, setScreenShareSession, updateScreenShareSession } from '../utils/screenShareDiagnostics';

/** The subset of RTCOutboundRtpStreamStats used for screenshare frame-rate
 *  diagnostics. All optional — several are non-standard-but-widely-implemented
 *  and none are guaranteed to be populated on a given sample. */
interface ScreenShareSendStats {
    type?: string;
    kind?: string;
    framesPerSecond?: number;
    frameWidth?: number;
    frameHeight?: number;
    qualityLimitationReason?: string;
    encoderImplementation?: string;
}
import { ScreenShare } from 'lucide-react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { EncryptedAvatar } from './EncryptedAvatar';
import { CallEncryptionIndicator, type CallEncryptionIndicatorMode } from './server/CallEncryptionIndicator';
import { ScreenSharePickerModal } from './ScreenSharePickerModal';
import { VideoTile, subscribeFastSpeaking } from './call/VideoTile';
import { ParticipantCard } from './call/ParticipantCard';
import { ScreenShareGate } from './call/ScreenShareGate';
import { AudioOnlyStrip } from './call/AudioOnlyStrip';
import { ControlBar } from './call/ControlBar';
import { FocusedStreamBanner } from './call/FocusedStreamBanner';
import { FullscreenOverlay } from './call/FullscreenOverlay';
import { useCallContextSafe } from '../contexts/CallContext';
import { useCallTelemetrySettersSafe } from '../contexts/callTelemetrySlices';
import { useCallStats } from '../hooks/useCallStats';
import { Permissions } from '@cipherline/shared';
import { annotationStore } from '../utils/annotationStore';
import { useDesktopAnnotationOverlay } from '../hooks/useDesktopAnnotationOverlay';
import { parseParticipantMetadata, type ParticipantMeta } from '../utils/participantMetadata';
import {
    writeWatchedShares,
    reduceViewerCues,
    initialViewerCueState,
} from '../utils/screenShareViewers';
import { useScreenShareViewers } from './call/useScreenShareViewers';
import {
    DEFAULT_AUDIO_INPUT_ID,
    MIC_CAPTURE_CONSTRAINTS,
    hasRealDeviceInfo,
    pickMicDeviceId,
    resolveMicDeviceId,
} from '../utils/audioInput';
import { DEFAULT_CAMERA_ID, pickCameraDeviceId, resolveCameraDeviceId } from '../utils/cameraInput';
import {
    shouldUseExactConstraint,
    buildSwitchOutcome,
    formatDeviceSwitchLog,
    describeSwitchFailure,
    readCaptureDeviceId,
    needsDeviceSwitch,
    type DeviceSwitchOutcome,
} from '../utils/deviceSwitch';
import { useNotificationPrefs } from '../contexts/NotificationContext';
import { playSound } from '../utils/notificationSounds';
import { useWindowFocus } from '../hooks/useWindowFocus';
import { useToast } from '../contexts/ToastContext';
import { onOutputDeviceChange, setOutputDeviceFailureHandler, shouldAdoptOutputReroute } from '../utils/audioOutput';
import { SilenceWatchdog } from '../utils/audioSilenceWatchdog';
import { getCurrentPipelineDbfs } from '../utils/micLevelRegistry';
import { flatRecordEqual } from '../utils/flatRecordEqual';
import { ROSTER_ONLY } from '../utils/callRosterEvents';
import { setCallParticipantSpeaking, clearCallSpeaking } from '../utils/callSpeakingStore';

interface SidebarConferenceProps {
    token: string;
    sessionId?: string;
    activeChatTitle?: string;
    activeChatAvatarUrl?: string;
    /** User ID of the remote participant — used to render the colour-derived
     *  avatar fallback in the ringing tile when no custom avatar is set. */
    activeChatUserId?: string;
    localAvatarUrl?: string;
    isGroup?: boolean;
    /** Skip the ringing/connecting animation and treat the room as live immediately.
     *  Use for always-on voice channels where there is no "call initiator" concept. */
    noRinging?: boolean;
    /** True for a Huddle call. `sessionId` for a huddle is a huddle_calls.call_id,
     *  not a call_sessions row — POSTing it to /calls/:id/end 404s (that table has
     *  no matching row). Huddle teardown-when-empty already happens correctly and
     *  separately via HuddlesService.leaveCall (see Dashboard's handleDisconnectCall
     *  → handleLeaveHuddleCall, triggered through this component's own onLeave
     *  callback) — this flag just stops handleLeave from ALSO firing the
     *  regular-call end-of-call POST that doesn't apply here. */
    isHuddle?: boolean;
    onLeave: (wasLastPerson: boolean) => void;
    /** Fired when the local solo-inactivity countdown starts/stops (see the
     *  "Solo inactivity kick" effect below). Lets Dashboard know a matching
     *  server-side `call:solo_kick` for THIS session is redundant — the client
     *  is already handling (or about to handle) its own removal — so it can
     *  suppress the duplicate SoloKickDialog. No design doc covers this
     *  overlap (checked docs/server-feature-design-notes.md — silent on solo-
     *  kick); see the effect below and Dashboard.tsx's soloKickEvent effect
     *  for the reasoning. */
    onInactivityWarning?: (active: boolean) => void;
    onFocusedStreamChange?: (active: boolean) => void;
    voice?: VoiceSettingsHook;
    /** userId → hex role colour forwarded to each ParticipantCard. */
    memberRoleColors?: Record<string, string | null>;
    /** userId → avatar attachment ID for all server members in this voice/huddle call's
     *  server. Pre-seeds fallbackAvatars so VideoTile always has the avatar even when
     *  LiveKit participant metadata hasn't propagated yet. */
    memberAvatarMap?: Record<string, string | null>;
    /** True when the local user has MUTE_MEMBERS in the active server. Only applies
     *  to server voice/huddle calls — DM and group calls pass undefined/false. */
    canServerMute?: boolean;
    /** Forwarded to ParticipantCard → PopoverMenu for server-side track muting. */
    onServerMuteTrack?: (targetUserId: string, trackType: 'audio' | 'video' | 'screenshare' | 'deafen', muted: boolean) => void;
    /** Resolved channel permissions for the call's voice/huddle channel. When
     *  provided, controls (mic / camera / screen-share) are pre-disabled when
     *  the user lacks SPEAK / VIDEO / SCREEN_SHARE. LiveKit also enforces these
     *  at the room level — this is purely UX so the user sees a clear "no
     *  permission" cue instead of a control that silently fails to unmute.
     *  Undefined for DM/group calls (no per-channel permission concept). */
    channelPermissions?: bigint;
    /** Small in-call encryption indicator (amber warning only — the steady-
     *  state "Encrypted" pill was removed 2026-09-08, see the render site
     *  below; the Huddle channel row now carries that). CallPane only ever
     *  mounts once a real key is confirmed — for a Calls-channel call via
     *  callsChannelGate reaching 'connect', for DM/group/huddle calls
     *  because call_key is installed before activeCall is ever set — so
     *  this is always 'connected' or 'degraded', never a loading state, but
     *  only 'degraded' is still rendered — and only when no participant is
     *  publishing in the clear, since `unencryptedIdentities` below takes
     *  precedence over it. See CallEncryptionIndicator.tsx. */
    encryptionIndicatorMode: Extract<CallEncryptionIndicatorMode, 'connected' | 'degraded'>;
    /** Identities of REMOTE participants publishing unencrypted media — peers
     *  on a build older than 1.0.13, which cannot encrypt call media. Resolved
     *  to display names here (the identity is a user id and means nothing to a
     *  human). Empty/undefined is the normal case. See utils/remoteE2EEWatch.ts. */
    unencryptedIdentities?: string[];
}

// Tile entry/exit: fade + slight upward drift for a grounded, spatial feel.
// New participants drift up from slightly below their final position; departing
// ones fade out with a small upward nudge (not downward — they're "leaving",
// not "falling"). Layout animation (framer-motion `layout` prop) handles the
// sibling reflow when a participant joins or leaves; these variants only own
// the opacity/transform of the tile itself, not its position in the list.
// Opacity-only — tiles fade in/out at their natural position.  The huddle card
// wrapper (motion.div one level up) owns the spawn-timing delay so that the
// height spring makes room first; these variants handle in-call arrivals/exits.
const tileItemVariants = {
    initial: { opacity: 0 },
    animate: {
        opacity: 1,
        transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] as const },
    },
    exit: {
        opacity: 0,
        transition: { duration: 0.14, ease: [0.4, 0, 1, 1] as const },
    },
};
// Pure fade for the ping pill, mic device-change banner, screenshare notice,
// audio-only strip, ringing tile — pop in at their position, no slide, no
// delay. Same reasoning as tiles.
const sidebarPillVariants = {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] as const } },
    exit:    { opacity: 0, transition: { duration: 0.16, ease: [0.4, 0, 1, 1] as const } },
};

// Self-view of your own screenshare — unlike everyone else's screenshare tile,
// which other participants need decoded to actually watch, nothing in the call
// depends on this one being rendered. It exists purely so you can confirm
// what's going out. Swapping in a static placeholder while Cipherline isn't
// the focused app unmounts the VideoTile underneath, which detaches the track
// from its <video> element and stops the local decode/composite work — free
// savings with no effect on what's actually being sent to the room.
const LocalScreenShareTile = ({ shareSourceId, ...props }: React.ComponentProps<typeof VideoTile> & {
    /** Capture source id of the running share — drives the desktop overlay
     *  (docs/video-annotation-design.md, Phase 5) for whole-screen shares. */
    shareSourceId?: string | null;
}) => {
    const appFocused = useWindowFocus();
    // Lives here, not in SidebarConference's body: this tile exists exactly
    // while the local share does, so mount/unmount IS show/hide. Refcounted
    // inside, since the tile can render in two layouts at once.
    useDesktopAnnotationOverlay(props.p.identity, shareSourceId ?? null);
    if (!appFocused) {
        return (
            <div className="relative rounded-xl overflow-hidden bg-cl-abyss w-full shrink-0 min-h-[80px] aspect-video ring-inset ring-1 ring-white/5 flex items-center justify-center">
                <span className="text-[11px] font-semibold text-cl-text/35 text-center px-4 leading-snug">
                    Preview paused — Cipherline isn&apos;t focused
                </span>
            </div>
        );
    }
    return <VideoTile {...props} />;
};

export const SidebarConference = ({
    token, onLeave, onInactivityWarning, localAvatarUrl, activeChatAvatarUrl, activeChatUserId, activeChatTitle, sessionId, isGroup, noRinging, isHuddle, onFocusedStreamChange, voice, memberRoleColors,
    memberAvatarMap, canServerMute, onServerMuteTrack, channelPermissions, encryptionIndicatorMode, unencryptedIdentities,
}: SidebarConferenceProps) => {
    // ── In-call permission flags (P13) ──────────────────────────────────────
    // SPEAK/VIDEO/SCREEN_SHARE control whether the user can publish their own
    // tracks. LiveKit enforces these at the room level (publish requests are
    // rejected) but the UI should disable the buttons up-front. Default is
    // permissive (true) when channelPermissions is undefined — either we're in
    // a DM/group call or per-channel perms haven't loaded yet; LiveKit is the
    // safety net.
    const canSpeak       = channelPermissions === undefined
                           || !!(channelPermissions & Permissions.SPEAK);
    const canVideo       = channelPermissions === undefined
                           || !!(channelPermissions & Permissions.VIDEO);
    const canScreenShare = channelPermissions === undefined
                           || !!(channelPermissions & Permissions.SCREEN_SHARE);
    // ANNOTATE gates asking to draw on someone's stream (the streamer's grant
    // is still required). Same permissive default as the others: DM/group
    // calls have no roles. Pushed to the annotation store so every remote
    // tile's "Ask to draw" reads one flag instead of threading a prop
    // through three render sites.
    const canAnnotate    = channelPermissions === undefined
                           || !!(channelPermissions & Permissions.ANNOTATE);
    React.useEffect(() => { annotationStore.setCanRequest(canAnnotate); }, [canAnnotate]);
    // ────────────────────────────────────────────────────────────────────────
    // Roster/track events only — see utils/callRosterEvents.ts (the default
    // re-rendered this whole tree on every active-speaker update).
    const participants = useParticipants(ROSTER_ONLY);
    const { localParticipant } = useLocalParticipant();
    const room = useRoomContext();
    const callCtx = useCallContextSafe();
    // Setters only — see useCallTelemetrySettersSafe: subscribing to the
    // telemetry VALUE re-rendered this whole tree after each of its own pushes.
    const telemetryCtx = useCallTelemetrySettersSafe();
    const callStats = useCallStats();
    const toast = useToast();
    const notifPrefs = useNotificationPrefs();
    // useNotificationPrefs() returns { prefs, updatePrefs, resetPrefs } — the
    // sound settings are nested under .prefs, not flattened onto the hook
    // result. A stale `{ sounds_enabled: notifPrefs.sounds_enabled, ... }`
    // call site below had been reading undefined for all three fields, which
    // playSound's `if (prefs && !prefs.sounds_enabled) return` treats as
    // "sounds off" — the existing leave-call sound has been silently
    // no-op'ing. Every playSound call in this file should build its prefs
    // arg from soundsPrefs(), not notifPrefs directly.
    //
    // It hands over the WHOLE prefs object rather than picking out the three
    // fields playSound happened to need at the time. NotificationPrefs is a
    // superset of SoundsPrefs, so this is the same value with one fewer way to
    // go wrong: the field-picking version silently dropped `sound_groups` when
    // sound groups were added, and every cue in this file (join/leave/mute/
    // deafen/camera) belongs to the group those prefs gate.
    const soundsPrefs = () => notifPrefs.prefs;

    // Extract stable setter references — useState setters never change identity,
    // so these are safe deps that won't cause loops when the context value re-creates.
    // Telemetry setters come from CallTelemetryContext to avoid 30 Hz re-renders
    // on low-freq consumers (ControlBar, FullscreenOverlay, etc.).
    const setCallStatsCtx           = telemetryCtx?.setCallStats;
    const setParticipantTracksCtx   = telemetryCtx?.setParticipantTrackStates;
    const setParticipantMetadataCtx = telemetryCtx?.setParticipantMetadata;
    const setLocalMutedIdsCtx       = callCtx?.setLocalMutedIds;
    const setHiddenVideoIdsCtx      = callCtx?.setHiddenVideoIds;
    const setHiddenScreenShareIdsCtx = callCtx?.setHiddenScreenShareIds;
    const registerLocalToggles      = callCtx?.registerLocalToggles;

    // Push live stats into CallContext so HuddleButton (outside LiveKit tree) can read them.
    React.useEffect(() => {
        setCallStatsCtx?.(callStats);
    }, [setCallStatsCtx, callStats]);

    // Stable dependency string keyed on every participant's metadata. LiveKit's
    // ParticipantMetadataChanged event mutates participant.metadata in place
    // without changing the participants[] reference, so an effect deps array
    // of just [participants] doesn't re-fire on metadata-only changes. This
    // string changes whenever any participant's metadata mutates.
    const metadataKey = participants
        .map(p => `${p.identity}:${p.metadata ?? ''}`)
        .join('|');

    // Push per-participant track states + parsed metadata into CallContext so
    // the outside-call participant list (ServerContextPanel huddle/voice rows)
    // can show camera/screenshare badges AND red server-moderation badges, plus
    // pre-fill the checkbox state in the right-click moderation menu.
    //
    // This is the ONLY place that data reaches ServerContextPanel from — for
    // huddles specifically, SidebarConference's own reliable per-participant-
    // event rows are display:none (Dashboard.tsx hides #call-sidebar-root for
    // isHuddle) and ServerContextPanel's roster is what's actually on screen.
    // It used to re-derive solely off `participants`/`metadataKey` (both from
    // useParticipants()), which itself only refreshes on a subset of LiveKit
    // room events — a reconnect can buffer one of those and drop it without
    // replay, silently freezing this snapshot with no self-heal until
    // something UNRELATED happens to change the participants array reference
    // again. That's the "I don't see someone mute/deafen until I reload" bug.
    // Attaching direct per-participant listeners below (the same TrackMuted/
    // Unmuted/Published/Unpublished/MetadataChanged events ParticipantCard's
    // useIsMicMuted / useParticipantMetadata already subscribe to reliably)
    // makes this self-healing regardless of what useParticipants() does.
    // The roster itself, stable across every room event that leaves it alone.
    // useParticipants() hands back a NEW array on ActiveSpeakersChanged,
    // ConnectionQualityChanged and a dozen other room events, and the effect
    // below used to key on that array — so in a talking call it tore down and
    // rebuilt every participant listener (and every fast-speaking analyser
    // subscription) several times a second, and pushed a fresh snapshot each
    // time. Everything the snapshot shows is delivered by the per-participant
    // listeners it attaches, so re-attaching only when someone joins/leaves
    // (or a participant object is replaced on reconnect — hence the sid) loses
    // nothing.
    const rosterKey = participants.map(p => `${p.identity}#${p.sid}`).join('|');
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const rosterParticipants = React.useMemo(() => participants, [rosterKey]);
    React.useEffect(() => {
        if (!setParticipantTracksCtx && !setParticipantMetadataCtx) return;
        const participants = rosterParticipants;

        // Fast (analyser-based) speaking state per identity. LiveKit's
        // isSpeaking/isSpeakingChanged lags — server Active Speaker Detection
        // updates for REMOTE participants arrive ~1s apart — which made the
        // avatar-ring "voice activity" indicator outside the call tree
        // (ServerContextPanel's voice/Calls rosters, FloatingHuddleCard) feel
        // sluggish next to VideoTile's ring, which uses the same fast path via
        // useFastIsSpeaking. subscribeFastSpeaking is the non-hook twin of that
        // hook — needed here because this effect subscribes a variable number of
        // participants in a loop — and shares VideoTile's ref-counted analyser.
        //
        // Speaking goes to its own per-identity store (utils/callSpeakingStore.ts),
        // NOT into the telemetry snapshot below: it flips several times a second
        // per talker, and every snapshot change re-rendered every subscriber in
        // full (the whole server panel + member list) to move one ring.
        const push = () => {
            const tracks: Record<string, { hasCamera: boolean; hasScreenShare: boolean; isMuted: boolean }> = {};
            const metas: Record<string, ParticipantMeta> = {};
            for (const p of participants) {
                const camPub = p.getTrackPublication(Track.Source.Camera);
                const ssPub  = p.getTrackPublication(Track.Source.ScreenShare);
                tracks[p.identity] = {
                    hasCamera:      !!(camPub && !camPub.isMuted && (camPub as any).track),
                    hasScreenShare: !!(ssPub  && !ssPub.isMuted  && (ssPub  as any).track),
                    // Mirror the mic mute state so ServerContextPanel participant rows
                    // can show a red MicOff badge for self-muted participants without
                    // needing to be inside the LiveKit room themselves.
                    isMuted:        !p.isMicrophoneEnabled,
                };
                metas[p.identity] = parseParticipantMetadata(p.metadata);
            }
            // Keep the previous object when nothing a reader can see changed:
            // this runs on every participant event, and an unconditional set
            // re-rendered every roster subscriber each time.
            setParticipantTracksCtx?.(prev => (flatRecordEqual<object>(prev, tracks) ? prev : tracks));
            setParticipantMetadataCtx?.(prev => (flatRecordEqual(prev, metas) ? prev : metas));
        };

        push();
        const unsubscribeFastSpeaking: Array<() => void> = [];
        for (const p of participants) {
            p.on(ParticipantEvent.TrackMuted,                push);
            p.on(ParticipantEvent.TrackUnmuted,               push);
            p.on(ParticipantEvent.TrackPublished,             push);
            p.on(ParticipantEvent.TrackUnpublished,           push);
            // useParticipants() returns local AND remote participants (the
            // library's own docs say so), and TrackPublished/TrackUnpublished
            // fire only on a RemoteParticipant — the local participant emits
            // localTrackPublished/localTrackUnpublished instead. Without these
            // two, YOUR OWN camera or screen share starting never refreshed
            // this shared snapshot, so anything reading participantTracksCtx
            // saw stale state for you until an unrelated push() happened to
            // run. Same omission as the two hooks in call/VideoTile.tsx.
            p.on(ParticipantEvent.LocalTrackPublished as any,   push);
            p.on(ParticipantEvent.LocalTrackUnpublished as any, push);
            p.on(ParticipantEvent.ParticipantMetadataChanged, push);
            setCallParticipantSpeaking(p.identity, p.isSpeaking);
            unsubscribeFastSpeaking.push(subscribeFastSpeaking(p, (speaking) => {
                setCallParticipantSpeaking(p.identity, speaking);
            }));
        }
        return () => {
            for (const p of participants) {
                p.off(ParticipantEvent.TrackMuted,                push);
                p.off(ParticipantEvent.TrackUnmuted,               push);
                p.off(ParticipantEvent.TrackPublished,             push);
                p.off(ParticipantEvent.TrackUnpublished,           push);
                p.off(ParticipantEvent.LocalTrackPublished as any,   push);
                p.off(ParticipantEvent.LocalTrackUnpublished as any, push);
                p.off(ParticipantEvent.ParticipantMetadataChanged, push);
            }
            unsubscribeFastSpeaking.forEach(unsub => unsub());
            // Re-seeded by the next run (subscribeFastSpeaking reports the
            // current state on subscribe); a participant who left stays off.
            for (const p of participants) setCallParticipantSpeaking(p.identity, false);
        };
    // rosterParticipants/metadataKey are the deps — the roster itself changes
    // (join/leave) needs to re-attach listeners, and metadataKey still covers
    // the common-path re-render for free without waiting on that reattach.
    }, [setParticipantTracksCtx, setParticipantMetadataCtx, rosterParticipants, metadataKey]);

    // Clear the shared snapshot on unmount (call ends). CallProvider is
    // mounted once for the whole session (Dashboard.tsx), so without this,
    // ServerContextPanel would keep showing a PREVIOUS call's frozen
    // mute/deafen/camera/speaking badges until the app is reloaded.
    React.useEffect(() => {
        return () => {
            setParticipantTracksCtx?.({});
            setParticipantMetadataCtx?.({});
            clearCallSpeaking();
        };
    }, [setParticipantTracksCtx, setParticipantMetadataCtx]);

    // Dock (and, if fullscreen was up, exit-fade) `CallContext.isFullscreen`
    // the instant this call ends. Same "CallProvider outlives any one call"
    // reasoning as the snapshot cleanup above: without this, isFullscreen
    // simply carries over as a stale `true` into whatever call is joined
    // next, and FullscreenOverlay drops the user straight into cinema mode
    // on rejoin instead of starting docked.
    //
    // useLayoutEffect, not useEffect: this runs as part of the SAME commit
    // that unmounts this component (Dashboard.tsx's callPaneActive has "no
    // grace window" for the call section — see its comment — so this whole
    // subtree, FullscreenOverlay included, is removed synchronously with
    // activeCall going null). A plain useEffect cleanup fires AFTER the
    // browser paints, which would let one frame render with the call gone
    // and no ghost yet — a visible flash before the fade even starts.
    // useLayoutEffect's cleanup runs before paint, so CallProvider's ghost
    // (contexts/CallContext.tsx) is already armed by the first frame the
    // user sees post-call.
    React.useLayoutEffect(() => {
        return () => {
            callCtx?.endCallFullscreen();
        };
    }, [callCtx?.endCallFullscreen]);

    // ── Tray voice-activity + mute/deafen indicator ───────────────────────────
    // Tracks four call dimensions and pushes them to the main process on every
    // change so the tray icon always reflects the current mic/audio state:
    //   speaking  → bright teal dot    muted     → amber dot
    //   silent    → dim teal dot       deafened  → purple dot  (highest priority)
    const localIdentity = localParticipant?.identity;
    const localIsMuted     = !localParticipant?.isMicrophoneEnabled;

    // Lift speaking state into React so a unified push effect can combine it
    // with mute/deafen without needing a ref.
    const [localIsSpeaking, setLocalIsSpeaking] = React.useState(false);

    // Subscribe to LiveKit ActiveSpeakersChanged — fires whenever the speaking
    // roster changes; useParticipants() doesn't give us a clean dep for this.
    React.useEffect(() => {
        if (!room || !localIdentity) return;
        const onActiveSpeakers = (speakers: import('livekit-client').Participant[]) => {
            setLocalIsSpeaking(speakers.some(s => s.identity === localIdentity));
        };
        room.on(RoomEvent.ActiveSpeakersChanged, onActiveSpeakers);
        return () => {
            room.off(RoomEvent.ActiveSpeakersChanged, onActiveSpeakers);
            setLocalIsSpeaking(false);
        };
    }, [room, localIdentity]);

    // ── Reconnect-state indicator ───────────────────────────────────────────
    // Before this, LiveKit's Reconnecting/Reconnected events were never
    // subscribed to anywhere in the app — during a LiveKit-internal reconnect
    // attempt (up to ~10 retries / ~38s, including an ICE restart), the user
    // got literally no signal: just frozen audio/video, with nothing telling
    // them the app was actively trying to recover rather than being stuck.
    // Now that no OfflineScreen reload races and kills the call during
    // exactly this window (see OfflineScreen.tsx), that recovery
    // window actually gets a chance to run — so it's worth being visible.
    const [isReconnecting, setIsReconnecting] = React.useState(false);
    React.useEffect(() => {
        if (!room) return;
        const onReconnecting = () => setIsReconnecting(true);
        const onReconnected = () => setIsReconnecting(false);
        room.on(RoomEvent.Reconnecting, onReconnecting);
        room.on(RoomEvent.Reconnected, onReconnected);
        return () => {
            room.off(RoomEvent.Reconnecting, onReconnecting);
            room.off(RoomEvent.Reconnected, onReconnected);
        };
    }, [room]);

    // ── Output-device auto-reroute reconciliation ───────────────────────────
    // If the active OUTPUT device disappears mid-call (headphones unplugged,
    // etc.), LiveKit's own internal Room.handleDeviceChange/selectDefaultDevices
    // already reroutes every EXISTING <audio> element to a fallback device —
    // that part just works, no code needed. What it doesn't do is tell US, so
    // our own persisted speakerDeviceId setting (audioOutput.ts / useVoiceSettings)
    // stayed pointed at the now-dead device. Any NEW <audio> element created
    // afterward (NS toggle, fullscreen flip, new participant, track replace —
    // all rebuild the chain) read that stale id via applyOutputDevice() and
    // failed silently (setSinkId rejecting on a nonexistent device), landing on
    // the true system default instead — split-brain between old and new
    // elements, and the Settings dropdown kept showing a device that no longer
    // existed as "selected." Adopting LiveKit's own choice as our new source of
    // truth the moment it reroutes closes both gaps.
    //
    // ── …but ONLY when the pick is actually gone ────────────────────────────
    //
    // This handler used to adopt every ActiveDeviceChanged unconditionally, and
    // LiveKit emits that event far more often than "your device vanished":
    // selectDefaultDevices() fires it on any devicechange where it believes the
    // user is following the OS default — which, for us, is always (see
    // shouldAdoptOutputReroute's comment for why activeDeviceMap is permanently
    // 'default' here). So plugging in a headset could silently overwrite an
    // explicit speaker choice, at exactly the moment a user is most likely to
    // be making one. shouldAdoptOutputReroute is the gate; it deliberately
    // mirrors syncMicDevice's `defaultMoved`, which likewise only auto-follows
    // the OS default while the user hasn't pinned a specific device.
    //
    // ── Why not room.switchActiveDevice('audiooutput', …)? ──────────────────
    //
    // It looks like the "proper" fix — it is the only thing that writes
    // livekit-client's activeDeviceMap, and a correct entry there would stop
    // selectDefaultDevices() misreading us as default-following in the first
    // place. We deliberately don't, for four reasons:
    //
    //   1. It does not route our audio. This app plays every remote participant
    //      through Web Audio (useParticipantAudio mutes the attached element and
    //      routes source → gain → limiter → AudioContext.destination), so the
    //      audible sink is AudioContext.setSinkId. livekit-client only calls
    //      that under `webAudioMix`, which this app does not enable — its
    //      audiooutput branch otherwise just sets sinkId on remote participants'
    //      elements, i.e. on the muted ones. audioOutput.ts would still have to
    //      do the real work, so this would be pure addition, not replacement.
    //   2. It wouldn't actually close the hole. Of selectDefaultDevices()'s
    //      three override paths, a correct activeDeviceMap only silences the
    //      one gated on === 'default'. The "active device was first in the
    //      previous enumeration" heuristic can still switch an explicitly-picked
    //      device out from under us — so this guard is needed regardless, and
    //      once it exists it covers all three paths, present and future.
    //   3. It emits ActiveDeviceChanged synchronously as part of the call —
    //      feeding our own listener here — and it throws outright on browsers
    //      where supportsSetSinkId() is false. Neither is worth inviting for a
    //      call whose useful effect we've already ruled out.
    //   4. Device-id conventions differ: ours is '' for "system default",
    //      LiveKit's is the literal 'default'. Handing our value straight over
    //      would need a translation layer with its own failure modes.
    //
    // Guarding on our side instead keeps the behaviour independent of
    // livekit-client's internal heuristics, which are three ad-hoc branches with
    // browser-specific carve-outs.
    React.useEffect(() => {
        if (!room) return;
        const onActiveDeviceChanged = (kind: MediaDeviceKind, deviceId: string) => {
            if (kind !== 'audiooutput' || !voice) return;
            const currentSetting = voice.settings.speakerDeviceId;
            // Cheap rejections first, so the common no-op case never touches
            // enumerateDevices(). The full predicate re-checks these.
            if (deviceId === currentSetting || currentSetting === '') return;
            navigator.mediaDevices.enumerateDevices().then(devices => {
                const outputs = devices.filter(d => d.kind === 'audiooutput');
                // Re-read rather than trusting the value captured before the
                // await: the whole point of this guard is not to clobber a
                // deliberate choice, and the user picking a device DURING the
                // enumeration is exactly that choice, just a few ms later.
                const settingNow = voice.settings.speakerDeviceId;
                if (!shouldAdoptOutputReroute(settingNow, deviceId, outputs)) return;
                voice.setSpeakerDeviceId(deviceId);
                // Don't wait for the Settings panel to be mounted to reroute live
                // elements — it usually isn't, during a call.
                onOutputDeviceChange(deviceId);
            }).catch(() => {
                // Enumeration failed, so we can't tell whether the pick is gone.
                // Leaving the explicit choice alone is the safe default: a stale
                // id degrades to the system default, whereas a wrong overwrite
                // is silent and sticky.
            });
        };
        room.on(RoomEvent.ActiveDeviceChanged, onActiveDeviceChanged);
        return () => { room.off(RoomEvent.ActiveDeviceChanged, onActiveDeviceChanged); };
    }, [room, voice]);

    // Surface setSinkId failures (a device disappearing between LiveKit's
    // reroute and our own applyOutputDevice() call on a freshly-built chain)
    // as a toast instead of a console-only warning, while a call is live.
    React.useEffect(() => {
        setOutputDeviceFailureHandler(() => {
            toast.push({
                kind: 'warning',
                title: 'Speaker switch failed',
                message: "Couldn't route audio to your selected output device — falling back to the system default.",
            });
        });
        return () => setOutputDeviceFailureHandler(null);
    }, [toast]);

    // ── "Connected but silent" watchdog ─────────────────────────────────────
    // The one failure mode LiveKit's own connection-state machinery
    // structurally can't see (see audioSilenceWatchdog.ts's header comment):
    // ICE/DTLS can be perfectly healthy while the actual capture/encode path
    // is dead. Polls at ~1s — deliberately decoupled from voiceProcessor's
    // own 20Hz level-poll timer (see micLevelRegistry.ts for why) and from
    // LiveKit's own audioLevel updates, which is why this is a plain
    // interval rather than an event subscription.
    const silenceWatchdogRef = React.useRef(new SilenceWatchdog());
    const [isPipelineSilent, setIsPipelineSilent] = React.useState(false);
    React.useEffect(() => {
        const interval = setInterval(() => {
            const tripped = silenceWatchdogRef.current.update(
                {
                    pipelineDbfs: getCurrentPipelineDbfs(),
                    outboundLevel: localParticipant?.audioLevel ?? 0,
                    micEnabled: !!localParticipant?.isMicrophoneEnabled,
                },
                Date.now(),
            );
            setIsPipelineSilent(tripped);
        }, 1000);
        return () => clearInterval(interval);
    }, [localParticipant]);

    // Clear on unmount (call ended) — restores unread dot or clean icon.
    React.useEffect(() => {
        return () => { window.electronAPI?.traySetCallSpeaking?.(false, false, false, false); };
    }, []);

    // ── Mic device reliability ────────────────────────────────────────────────
    // One job: whatever the user picked (or "follow the system default") is what
    // is actually live, and if the OS pulls the rug out we recover in place
    // instead of needing an app reload.
    //
    // The hazard this is written around: LiveKit's LocalTrack.restart() stops
    // the existing MediaStreamTrack BEFORE calling getUserMedia for its
    // replacement, and has no rollback if that call throws:
    //
    //     this._mediaStreamTrack.stop();                       // old mic dead
    //     const stream = await navigator.mediaDevices.getUserMedia(...)  // throws?
    //
    // so ANY failed device switch leaves the mic permanently silent — published,
    // apparently unmuted, transmitting nothing. Two things made that likely on
    // the follow-the-default path specifically:
    //
    //   1. room.switchActiveDevice()'s third parameter, `exact`, DEFAULTS TO
    //      TRUE in livekit-client. The old code called it positionally, so it
    //      requested {exact:'default'} — unsatisfiable on setups where Chromium
    //      exposes no 'default' audioinput, and transiently unsatisfiable during
    //      the device-change storm that fires while the OS re-enumerates.
    //   2. it was only ever reached when following the system default; an
    //      explicitly-picked device hit an early `return` and never restarted.
    //
    // Which is exactly the reported shape: "default doesn't work, picking the
    // device does". Everything below passes exact:false and treats a dead track
    // as a recoverable state rather than a terminal one.
    /** micError below is the "your mic is dead and we couldn't fix it" case,
     *  which the user genuinely needs to see — otherwise they carry on talking
     *  into a track that is published, apparently unmuted, and transmitting
     *  nothing. There used to be a sibling `deviceBanner` "Switched to X"
     *  success notice too (also forwarded to FullscreenOverlay) — removed
     *  outright on direct owner feedback ("I don't wanna see any banners
     *  there... at the top"), same call as the device-switch toast a few
     *  commits back. `showDeviceBanner` below is now a no-op kept for its
     *  call sites' sake: it used to be the mic-switch reliability fix's own
     *  confirmation (three rounds of "worked" switches that had silently
     *  failed), but that failure mode is caught by `micError`/`cameraError`
     *  independently now — the banner was an extra confirmation, not the
     *  only signal, so dropping it doesn't reopen the silent-failure gap. */
    const [micError, setMicError] = React.useState<string | null>(null);
    /** Camera counterpart to micError — see syncCameraDevice below for why
     *  camera hot-swap needed the same reliability pass the mic path already
     *  had: LiveKit's own recovery excludes video from its fallback-device
     *  logic, so an unplugged/permission-revoked/exclusively-grabbed camera
     *  used to converge on a silent mute with only a console.warn, no banner
     *  at all — every mic failure mode had one, camera had none. */
    const [cameraError, setCameraError] = React.useState<string | null>(null);
    const lastDefaultLabelRef = React.useRef<string>('');
    /** Device id our last successful switch targeted — what we believe is live. */
    const appliedMicDeviceRef = React.useRef<string | null>(null);
    /** Serialises syncs; devicechange fires in bursts and restarts race badly. */
    const micSyncBusyRef = React.useRef(false);
    /** A devicechange that arrived mid-sync, to be serviced once it finishes. */
    const micSyncPendingRef = React.useRef(false);
    /** Latest syncMicDevice, so the tail of a sync can re-enter the newest one. */
    const syncMicDeviceRef = React.useRef<((force?: boolean) => Promise<void>) | null>(null);

    // Camera equivalents of the mic-sync refs directly above — same shapes,
    // same reasoning, kept as separate refs (not a generalized "device sync"
    // abstraction) so this stays a small, reviewable diff against the
    // existing, already-battle-tested mic implementation rather than a
    // risky refactor of it.
    const lastDefaultCameraLabelRef = React.useRef<string>('');
    const appliedCameraDeviceRef = React.useRef<string | null>(null);
    const cameraSyncBusyRef = React.useRef(false);
    const cameraSyncPendingRef = React.useRef(false);
    const syncCameraDeviceRef = React.useRef<((force?: boolean) => Promise<void>) | null>(null);

    // No-op now (see the comment above micError) — kept so its call sites,
    // which still carry the real "what device actually ended up live" logic
    // that surrounding code depends on, don't need touching.
    const showDeviceBanner = React.useCallback((_name: string) => {}, []);

    /**
     * Device-switch diagnostics.
     *
     * The user cannot see any of the internal state that decides whether a
     * device switch worked, which is why three rounds of this bug were reported
     * as "it still doesn't switch" with nothing to go on. One structured line
     * per attempt — always, in every build — reporting the device that is
     * ACTUALLY live (read from `getSettings()`), never the one requested. In dev
     * builds it is also raised as a toast so it can be read without opening
     * DevTools on the test machine.
     */
    // This used to also raise a toast in dev builds — added specifically to
    // debug this session's device-switching bugs on a test machine without
    // opening DevTools. Removed outright on direct owner feedback ("I don't
    // need that"), not merely narrowed to skip deferred outcomes as the
    // previous pass did: even a REAL switch reported here is diagnostic
    // noise now that the underlying bug is fixed and verified. The console
    // line stays — it costs nothing, and it's still where a future
    // regression in this area would actually get debugged from.
    const reportDeviceSwitch = React.useCallback((outcome: DeviceSwitchOutcome) => {
        const line = formatDeviceSwitchLog(outcome);
        if (outcome.ok) console.info(line); else console.warn(line);
    }, []);

    /**
     * Bring the live mic track in line with what the user asked for.
     * `force` skips the "nothing changed" early-out (used when the setting
     * itself changed rather than the hardware).
     */
    // Seed the default-device label at mount so the FIRST genuine default
    // change is detected rather than swallowed by the "no previous label to
    // compare against" guard in syncMicDevice.
    //
    // Guarded on hasRealDeviceInfo, which is the part the old implementation got
    // wrong: it seeded unconditionally, so when it ran before mic permission
    // resolved it recorded a BLANK label, and the first post-permission
    // enumeration then looked like a device change and restarted the mic for
    // nothing. By the time this component mounts LiveKit has normally already
    // acquired the mic, so the list is real; if it isn't, the first devicechange
    // records the baseline instead and we simply miss nothing.
    React.useEffect(() => {
        let cancelled = false;
        navigator.mediaDevices.enumerateDevices().then(devices => {
            if (cancelled) return;
            const inputs = devices.filter(d => d.kind === 'audioinput');
            if (!hasRealDeviceInfo(inputs)) return;
            const def = inputs.find(d => d.deviceId === DEFAULT_AUDIO_INPUT_ID);
            if (def?.label) lastDefaultLabelRef.current = def.label;
        }).catch(() => {});
        return () => { cancelled = true; };
    }, []);

    // Read once into a plain string so both the callback body and its dep array
    // reference the same simple value — an optional-chained expression in deps
    // defeats the React Compiler's memoization check.
    const micDeviceSetting = voice?.settings.micDeviceId ?? '';

    const syncMicDevice = React.useCallback(async (force = false) => {
        if (!room) return;
        if (micSyncBusyRef.current) {
            // Coalesce rather than drop. A devicechange landing inside the
            // ~getUserMedia-long window of an in-flight sync would otherwise be
            // lost, stranding us on the wrong input until some later, unrelated
            // device event happened to come along.
            micSyncPendingRef.current = true;
            return;
        }
        micSyncBusyRef.current = true;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const inputs = devices.filter(d => d.kind === 'audioinput');
            // Pre-permission Chromium returns blank placeholders. Acting on that
            // list would mean concluding the user's device vanished and switching
            // them off it for no reason.
            if (!hasRealDeviceInfo(inputs)) return;

            const desired = pickMicDeviceId(micDeviceSetting, inputs);

            const micPub = room.localParticipant?.getTrackPublication(Track.Source.Microphone);
            const micTrack = micPub?.track;
            // A track whose underlying MediaStreamTrack isn't 'live' is the dead
            // state described above — always worth a re-acquire.
            const trackAlive = !!micTrack && micTrack.mediaStreamTrack?.readyState === 'live';

            // Did the OS default itself move? Only meaningful while we're
            // following it, and only once we have a real label to compare
            // against — seeding from a blank pre-permission label would make the
            // first real enumeration look like a change and restart the mic for
            // nothing.
            const defaultEntry = inputs.find(d => d.deviceId === DEFAULT_AUDIO_INPUT_ID);
            const defaultLabel = defaultEntry?.label ?? '';
            const defaultMoved =
                desired === DEFAULT_AUDIO_INPUT_ID &&
                !!defaultLabel &&
                !!lastDefaultLabelRef.current &&
                defaultLabel !== lastDefaultLabelRef.current;
            if (defaultLabel) lastDefaultLabelRef.current = defaultLabel;

            // What the mic is capturing from RIGHT NOW, read past any attached
            // processor (see readCaptureDeviceId). Needed before the decision,
            // not just after it: on a fresh join `appliedMicDeviceRef` is null
            // while the Room has already opened `desired` for us, and switching
            // anyway restarts a perfectly good track — see needsDeviceSwitch.
            const liveBefore = readCaptureDeviceId(micTrack);
            if (!needsDeviceSwitch({
                force, defaultMoved, trackAlive,
                appliedId: appliedMicDeviceRef.current,
                desiredId: desired,
                activeId: liveBefore,
                devices: inputs,
            })) {
                // Already on the requested device — record it so later passes
                // short-circuit on the cheap `appliedId === desiredId` test.
                appliedMicDeviceRef.current = desired;
                return;
            }

            // `exact` is decided PER TARGET, not globally — see deviceSwitch.ts.
            // A concrete device we just enumerated is satisfiable and is the only
            // form Chromium actually honours; 'default' stays non-exact because
            // {exact:'default'} is the unsatisfiable case that throws after
            // LiveKit has already stopped the old track.
            const useExact = shouldUseExactConstraint(desired, inputs);
            const wasMuted = !!micTrack?.isMuted;
            await room.switchActiveDevice('audioinput', desired, useExact);

            // Read what is ACTUALLY live rather than trusting the request. The
            // library's own success boolean is discarded on purpose: it is
            // vacuously true when there are no publications and optimistically
            // true for a muted track, so getSettings() is the stronger oracle.
            const liveTrack = room.localParticipant
                ?.getTrackPublication(Track.Source.Microphone)?.track;
            // NOT `liveTrack.mediaStreamTrack.getSettings()`: that getter returns
            // `processor?.processedTrack ?? _mediaStreamTrack`, so once the
            // rnnoise processor is attached it reports the WebAudio graph's
            // OUTPUT track — an id no enumerated device can ever match, which is
            // what produced "still using Device WebAudio" on a switch that had
            // in fact worked.
            const activeId = readCaptureDeviceId(liveTrack);
            const outcome = buildSwitchOutcome({
                kind: 'mic',
                requestedId: desired,
                activeId,
                devices: inputs,
                usedExact: useExact,
                muted: wasMuted,
                noPublication: !liveTrack,
                unverifiable: !!liveTrack && activeId === null,
            });
            reportDeviceSwitch(outcome);

            if (!outcome.ok) {
                // Do NOT record `desired` as applied — that is what made this
                // failure sticky, since every later passive sync then concluded
                // there was nothing to do and re-picking the same device from
                // the menu is a React no-op.
                appliedMicDeviceRef.current = outcome.activeId;
                setMicError(describeSwitchFailure(outcome));
                return;
            }
            appliedMicDeviceRef.current = desired;
            setMicError(null);

            if (defaultMoved) {
                // Chromium labels the default entry "Default - <Device>"; the
                // real entry (same groupId) carries the clean name.
                const actualEntry = inputs.find(
                    d => d.groupId === defaultEntry?.groupId && d.deviceId !== DEFAULT_AUDIO_INPUT_ID,
                );
                showDeviceBanner(
                    actualEntry?.label ||
                    defaultLabel.replace(/^Default\s*[-–]\s*/i, '') ||
                    'New microphone',
                );
            } else if (force) {
                // The user just picked this device from a menu — switchActiveDevice
                // above is silent on success, and with no live change to look at
                // (a mic swap has no visual cue the way camera/screen-share do) a
                // switch that genuinely worked and one that silently didn't were
                // indistinguishable. Confirm it — with the device that is
                // ACTUALLY live, not the one that was requested. Announcing the
                // request is what let a completely failed switch present itself
                // as a success for three reported rounds.
                showDeviceBanner(
                    outcome.deferred
                        ? `${outcome.requestedLabel} — applies when you unmute`
                        : outcome.activeLabel ?? outcome.requestedLabel,
                );
            }
        } catch (err) {
            console.warn('[Mic] device switch failed — attempting recovery:', err);
            // Widest possible re-acquire. Reached when both the explicit id and
            // 'default' were momentarily unsatisfiable, which is precisely when
            // the old track has already been stopped and doing nothing would
            // leave the user silently un-transmitting.
            try {
                const micTrack = room.localParticipant
                    ?.getTrackPublication(Track.Source.Microphone)?.track;
                if (micTrack instanceof LocalAudioTrack) {
                    await micTrack.restartTrack({
                        ...MIC_CAPTURE_CONSTRAINTS,
                        deviceId: { ideal: DEFAULT_AUDIO_INPUT_ID },
                    });
                    appliedMicDeviceRef.current = DEFAULT_AUDIO_INPUT_ID;
                    setMicError(null);
                    console.log('[Mic] recovered onto the default device');
                }
            } catch (recoveryErr) {
                console.error('[Mic] recovery failed — mic will stay silent until rejoin:', recoveryErr);
                setMicError('Microphone unavailable — rejoin the call to retry.');
            }
        } finally {
            micSyncBusyRef.current = false;
            if (micSyncPendingRef.current) {
                micSyncPendingRef.current = false;
                // force:false — the queued pass re-evaluates from scratch, and
                // if nothing actually changed its needsSwitch check returns
                // immediately, so this can't spin.
                setTimeout(() => { void syncMicDeviceRef.current?.(false); }, 0);
            }
        }
    }, [room, micDeviceSetting, showDeviceBanner, reportDeviceSwitch]);

    React.useEffect(() => { syncMicDeviceRef.current = syncMicDevice; }, [syncMicDevice]);

    // Hardware changed. Debounced: plugging in one headset emits several
    // devicechange events as the OS registers each endpoint, and each one would
    // otherwise start its own stop-then-reacquire.
    React.useEffect(() => {
        let debounce: ReturnType<typeof setTimeout> | null = null;
        const onDeviceChange = () => {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => { void syncMicDevice(); }, 300);
        };
        navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
        return () => {
            navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
            if (debounce) clearTimeout(debounce);
        };
    }, [syncMicDevice]);

    // Setting changed. This is what makes picking a mic mid-call take effect at
    // all — CallPane deliberately freezes audioCaptureDefaults.deviceId so that
    // changing it can't recreate the Room, which means the swap has to happen
    // here. Skipped on mount: the track was just created with this device.
    const micSettingMountedRef = React.useRef(false);
    React.useEffect(() => {
        if (!micSettingMountedRef.current) {
            micSettingMountedRef.current = true;
            appliedMicDeviceRef.current = resolveMicDeviceId(micDeviceSetting);
            return;
        }
        void syncMicDevice(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [micDeviceSetting]);

    // ── Camera device sync — mirrors syncMicDevice above ────────────────────
    // Same story for the camera — frozen in CallPane's options for the same
    // Room-recreation reason, so mid-call camera changes are applied here.
    const cameraDeviceSetting = voice?.settings.cameraDeviceId ?? '';

    // Seed the default-camera label at mount, same reasoning as the mic
    // equivalent above (avoids the first post-permission enumeration looking
    // like a spurious default change).
    React.useEffect(() => {
        let cancelled = false;
        navigator.mediaDevices.enumerateDevices().then(devices => {
            if (cancelled) return;
            const inputs = devices.filter(d => d.kind === 'videoinput');
            if (!hasRealDeviceInfo(inputs)) return;
            const def = inputs.find(d => d.deviceId === DEFAULT_CAMERA_ID);
            if (def?.label) lastDefaultCameraLabelRef.current = def.label;
        }).catch(() => {});
        return () => { cancelled = true; };
    }, []);

    const syncCameraDevice = React.useCallback(async (force = false) => {
        if (!room) return;
        if (cameraSyncBusyRef.current) {
            cameraSyncPendingRef.current = true;
            return;
        }
        cameraSyncBusyRef.current = true;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const inputs = devices.filter(d => d.kind === 'videoinput');
            if (!hasRealDeviceInfo(inputs)) return;

            const desired = pickCameraDeviceId(cameraDeviceSetting, inputs);

            const camPub = room.localParticipant?.getTrackPublication(Track.Source.Camera);
            const camTrack = camPub?.track;
            // A passive hardware event (devicechange) with the camera off has
            // nothing to recover, so it's skipped — but a DELIBERATE setting
            // change (force) must still go through even with the camera off.
            // room.switchActiveDevice only touches EXISTING video publications
            // (verified against livekit-client's Room.switchActiveDevice: with
            // none, it creates nothing and turns nothing on), but it ALSO
            // updates the Room's own videoCaptureDefaults.deviceId — which is
            // exactly what the NEXT setCameraEnabled(true) captures from,
            // since CallPane freezes that default at Room creation and nothing
            // else keeps it current. Returning here unconditionally meant
            // picking a camera while off never stuck: turning the camera on
            // afterward still opened the original device. This was the one
            // real gap in an otherwise correct trio (mic has no such guard).
            //
            // One extra case beyond `force`: if the camera is off AND the device
            // we last pointed the Room's capture default at has since been
            // unplugged, this pass must still run. Since that default is now
            // written as an {exact:…} constraint (see below), leaving it aimed at
            // a device that no longer exists would make the NEXT camera-on throw
            // OverconstrainedError instead of quietly opening something else.
            // Re-pointing it at 'default' here keeps that self-healing.
            const appliedCam = appliedCameraDeviceRef.current;
            const appliedCamGone =
                !!appliedCam
                && appliedCam !== DEFAULT_CAMERA_ID
                && !inputs.some(d => d.deviceId === appliedCam);
            if (!camTrack && !force && !appliedCamGone) return;
            const trackAlive = !!camTrack && camTrack.mediaStreamTrack?.readyState === 'live';

            const defaultEntry = inputs.find(d => d.deviceId === DEFAULT_CAMERA_ID);
            const defaultLabel = defaultEntry?.label ?? '';
            const defaultMoved =
                desired === DEFAULT_CAMERA_ID &&
                !!defaultLabel &&
                !!lastDefaultCameraLabelRef.current &&
                defaultLabel !== lastDefaultCameraLabelRef.current;
            if (defaultLabel) lastDefaultCameraLabelRef.current = defaultLabel;

            const needsSwitch =
                force || defaultMoved || !trackAlive || appliedCameraDeviceRef.current !== desired;
            if (!needsSwitch) return;

            // Same per-target `exact` decision as the mic switch — and it matters
            // twice as much here. With the camera OFF there is no publication to
            // restart, so switchActiveDevice's only effect is to write the Room's
            // `videoCaptureDefaults.deviceId`, which is what the next
            // setCameraEnabled(true) captures from. Written non-exact, that
            // default is an advisory hint Chromium ignores — which is why picking
            // a camera while it was off still opened the original one even after
            // the guard that let this branch run at all was fixed.
            const useExact = shouldUseExactConstraint(desired, inputs);
            const wasMuted = !!camTrack?.isMuted;
            await room.switchActiveDevice('videoinput', desired, useExact);

            const liveCam = room.localParticipant
                ?.getTrackPublication(Track.Source.Camera)?.track;
            // Same processor-aware read as the mic path. The camera's equivalent
            // of the WebAudio track is cameraProcessor's `canvas.captureStream()`
            // track, which carries no deviceId at all — so with a camera
            // processor attached this reported `null` and failed the switch.
            const activeCamId = readCaptureDeviceId(liveCam);
            const outcome = buildSwitchOutcome({
                kind: 'camera',
                requestedId: desired,
                activeId: activeCamId,
                devices: inputs,
                usedExact: useExact,
                muted: wasMuted,
                noPublication: !liveCam,
                unverifiable: !!liveCam && activeCamId === null,
            });
            reportDeviceSwitch(outcome);

            if (!outcome.ok) {
                appliedCameraDeviceRef.current = outcome.activeId;
                setCameraError(describeSwitchFailure(outcome));
                return;
            }
            appliedCameraDeviceRef.current = desired;
            setCameraError(null);

            if (defaultMoved) {
                const actualEntry = inputs.find(
                    d => d.groupId === defaultEntry?.groupId && d.deviceId !== DEFAULT_CAMERA_ID,
                );
                showDeviceBanner(
                    actualEntry?.label ||
                    defaultLabel.replace(/^Default\s*[-–]\s*/i, '') ||
                    'New camera',
                );
            } else if (force && trackAlive) {
                // Same confirmation as the mic path — and gated on trackAlive
                // specifically: with the camera off there is nothing on
                // screen to show the pick took, so a banner would just be
                // announcing a device nobody's currently capturing from.
                // Reports the ACTUAL live device, not the requested one.
                showDeviceBanner(outcome.activeLabel ?? outcome.requestedLabel);
            }
        } catch (err) {
            console.warn('[Camera] device switch failed — attempting recovery:', err);
            try {
                const camTrack = room.localParticipant
                    ?.getTrackPublication(Track.Source.Camera)?.track;
                if (camTrack instanceof LocalVideoTrack) {
                    await camTrack.restartTrack({ deviceId: { ideal: DEFAULT_CAMERA_ID } });
                    appliedCameraDeviceRef.current = DEFAULT_CAMERA_ID;
                    setCameraError(null);
                    console.log('[Camera] recovered onto the default device');
                }
            } catch (recoveryErr) {
                console.error('[Camera] recovery failed:', recoveryErr);
                setCameraError('Camera unavailable — check that no other app has it open, then try turning your camera off and on.');
            }
        } finally {
            cameraSyncBusyRef.current = false;
            if (cameraSyncPendingRef.current) {
                cameraSyncPendingRef.current = false;
                setTimeout(() => { void syncCameraDeviceRef.current?.(false); }, 0);
            }
        }
    }, [room, cameraDeviceSetting, showDeviceBanner, reportDeviceSwitch]);

    React.useEffect(() => { syncCameraDeviceRef.current = syncCameraDevice; }, [syncCameraDevice]);

    // Hardware changed — same debounce reasoning as the mic listener. This is
    // the piece that was entirely missing before: LiveKit's own devicechange
    // handling explicitly skips the "fall back to another device" branch for
    // video (true in every browser, a library-level choice — see the header
    // comment on cameraInput.ts), so without this a camera hot-unplug just
    // left the track dead with no recovery attempt at all.
    React.useEffect(() => {
        let debounce: ReturnType<typeof setTimeout> | null = null;
        const onDeviceChange = () => {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => { void syncCameraDevice(); }, 300);
        };
        navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
        return () => {
            navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
            if (debounce) clearTimeout(debounce);
        };
    }, [syncCameraDevice]);

    // Setting changed — same "CallPane freezes the initial device" reasoning
    // as the mic path. Skipped on mount: the track was just created with
    // this device.
    const cameraSettingMountedRef = React.useRef(false);
    React.useEffect(() => {
        if (!cameraSettingMountedRef.current) {
            cameraSettingMountedRef.current = true;
            appliedCameraDeviceRef.current = resolveCameraDeviceId(cameraDeviceSetting);
            return;
        }
        void syncCameraDevice(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cameraDeviceSetting]);

    // Output device (speakers/headphones). Was previously bridged ONLY by an
    // effect inside VoiceVideoSettings.tsx — which is unmounted unless the
    // voice settings pane happens to be open, so changing the device from
    // anywhere else (e.g. the control-bar right-click menu) persisted the
    // choice but changed nothing audible until the settings pane was next
    // opened. Hoisted here since SidebarConference is mounted for the whole
    // call, so every source of a speaker-device change gets live switching
    // through one path, and audioOutput.ts's own storage key can't drift
    // from voice.settings.speakerDeviceId — this is the only writer now.
    const speakerDeviceSetting = voice?.settings.speakerDeviceId ?? '';
    // Skip the confirmation banner for the value already active when the call
    // started — only a change made DURING the call should announce itself.
    const speakerSettingMountedRef = React.useRef(false);
    React.useEffect(() => {
        onOutputDeviceChange(speakerDeviceSetting);
        if (!speakerSettingMountedRef.current) {
            speakerSettingMountedRef.current = true;
            return;
        }
        // Same reasoning as the mic/camera banners: setSinkId succeeding is
        // invisible (audio just keeps playing, from wherever it now comes
        // out), so a switch that worked and one that silently didn't looked
        // identical from the UI. Confirm it.
        navigator.mediaDevices.enumerateDevices().then(devices => {
            const outputs = devices.filter(d => d.kind === 'audiooutput');
            showDeviceBanner(
                speakerDeviceSetting === ''
                    ? 'System default'
                    : outputs.find(d => d.deviceId === speakerDeviceSetting)?.label || 'Speaker',
            );
        }).catch(() => {});
    }, [speakerDeviceSetting, showDeviceBanner]);

    // Active talker tracking — counts stored in a ref so the interval always
    // sees and mutates the latest value. Using setState with a functional updater
    // that returned `prev` on no-promotion ticks discarded increments entirely,
    // pinning counts at 0 and making the promotion branch unreachable (P2-REND-2).
    const speakerTicksRef = React.useRef<Record<string, number>>({});
    const participantsRef = React.useRef(participants);
    React.useEffect(() => { participantsRef.current = participants; }, [participants]);

    // Stable promotion list for active-speaker ordering. Each entry is a participant
    // identity string; the array is ordered most-recently-promoted first.
    //
    // Promotion rule: speak continuously for ≥2 ticks (2 s) → move to front.
    // Demotion rule:  stop speaking → wait 5 s, then remove from list.
    //
    // This means the list only changes when someone starts talking (at most once per
    // person per speaking burst) or after they've been silent for 5 s — never on
    // every 1 s tick. Participants who aren't promoted stay in their original join order.
    const [promotedIds, setPromotedIds] = React.useState<string[]>([]);
    const silenceTimerMapRef = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

    React.useEffect(() => {
        const interval = setInterval(() => {
            const ticks = speakerTicksRef.current;
            participantsRef.current.forEach(p => {
                const id = p.identity;
                if (p.isSpeaking) {
                    const oldVal = ticks[id] || 0;
                    ticks[id] = oldVal + 1;
                    if (oldVal < 2 && ticks[id] >= 2) {
                        // Just crossed the active threshold → promote to front.
                        // Cancel any pending demotion timer first so a speaker who
                        // pauses briefly and resumes doesn't get demoted mid-burst.
                        const timers = silenceTimerMapRef.current;
                        if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
                        setPromotedIds(prev => [id, ...prev.filter(x => x !== id)]);
                    }
                } else {
                    const oldVal = ticks[id] || 0;
                    if (oldVal > 0) {
                        ticks[id] = Math.max(0, oldVal - 1);
                        if (oldVal >= 2 && ticks[id] < 2) {
                            // Just fell below active threshold → schedule demotion.
                            // The 5 s delay keeps them at the top through brief pauses.
                            const timers = silenceTimerMapRef.current;
                            if (!timers.has(id)) {
                                timers.set(id, setTimeout(() => {
                                    setPromotedIds(prev => prev.filter(x => x !== id));
                                    silenceTimerMapRef.current.delete(id);
                                }, 5000));
                            }
                        }
                    }
                }
            });
        }, 1000);
        return () => {
            clearInterval(interval);
            silenceTimerMapRef.current.forEach(t => clearTimeout(t));
            silenceTimerMapRef.current.clear();
        };
    }, []);

    // Clean up promoted state and tick counts when a participant leaves the call.
    React.useEffect(() => {
        const ids = new Set(participants.map(p => p.identity));
        setPromotedIds(prev => {
            const filtered = prev.filter(id => ids.has(id));
            return filtered.length === prev.length ? prev : filtered;
        });
        const ticks = speakerTicksRef.current;
        Object.keys(ticks).forEach(id => { if (!ids.has(id)) delete ticks[id]; });
        silenceTimerMapRef.current.forEach((timer, id) => {
            if (!ids.has(id)) { clearTimeout(timer); silenceTimerMapRef.current.delete(id); }
        });
    }, [participants]);

    const [hasConnectedOnce, setHasConnectedOnce] = React.useState(false);
    const [forceActive, setForceActive] = React.useState(false);

    React.useEffect(() => {
        if (participants.length > 1) {
            setHasConnectedOnce(true);
            setForceActive(false);
        }
    }, [participants.length]);

    React.useEffect(() => {
        const timeout = setTimeout(() => setForceActive(true), 15000);
        return () => clearTimeout(timeout);
    }, []);

    const isRinging = !noRinging && participants.length <= 1 && !forceActive && !hasConnectedOnce;

    // Deafen + server-moderation state derived from the local participant's own
    // LiveKit metadata. The server writes these flags when a moderator fires the
    // call-mute API.
    //
    // These are plain render-time derivations off a MUTABLE object
    // (localParticipant.metadata is mutated in place by LiveKit), so they are
    // only as fresh as the next re-render. useLocalParticipant() does NOT
    // provide one: it subscribes via observeParticipantMedia(), whose event
    // list is TrackMuted/TrackUnmuted/Track{,Un}Published/LocalTrack{,Un}Published/
    // ParticipantPermissionsChanged/MediaDevicesError/TrackSubscriptionStatusChanged
    // — no ParticipantMetadataChanged. (Its `localParticipant` state is also the
    // same object identity every time, so that setState always bails out.)
    // useParticipants() does re-render on metadata changes today (Room forwards
    // the local participant's ParticipantMetadataChanged as a RoomEvent, and
    // useRemoteParticipants() emits a fresh array for it), but that's a
    // room-level subscription with the same reconnect-drops-an-event fragility
    // called out on the telemetry-push effect above — and it's incidental to a
    // hook we call for an unrelated reason. Subscribe directly instead, the same
    // way call/VideoTile.tsx's useParticipantMetadata does.
    //
    // The flags this actually protects are the SERVER-pushed ones
    // (server_deafened / server_muted_*): a moderator action arrives as nothing
    // but a metadata update, with no local state change and no track event of
    // our own to piggy-back a render on. Self-deafen is not the repro case —
    // toggleDeafen() calls setLocalDeafened() alongside setMetadata(), so it
    // re-renders on its own React state regardless of this listener.
    //
    // baseLocalDeafened        — user toggled self-deafen (persists in metadata).
    // baseServerDeafened       — moderator deafened via 'deafen' track_type. Drives
    //                            isLocalDeafened → gain 0 in useParticipantAudio.
    //                            Also grays out the mic and deafen buttons.
    // localServerMuted{Audio,Video,ScreenShare} — moderator muted the matching
    //                            track. Grays out the respective ControlBar button
    //                            so the user can't re-enable it client-side (the
    //                            SFU blocks it anyway via canPublishSources, but the
    //                            UI feedback makes the restriction immediately clear).
    // All flags default strict-false so an absent/corrupt metadata blob never
    // accidentally locks the user's controls.
    const [, forceLocalMetaRender] = React.useState(0);
    React.useEffect(() => {
        if (!localParticipant) return;
        const bump = () => forceLocalMetaRender(n => n + 1);
        localParticipant.on(ParticipantEvent.ParticipantMetadataChanged, bump);
        return () => { localParticipant.off(ParticipantEvent.ParticipantMetadataChanged, bump); };
    }, [localParticipant]);

    let baseLocalDeafened           = false;
    let baseServerDeafened          = false;
    let localServerMutedAudio       = false;
    let localServerMutedVideo       = false;
    let localServerMutedScreenShare = false;
    try {
        if (localParticipant?.metadata) {
            const _localMeta = JSON.parse(localParticipant.metadata);
            baseLocalDeafened           = _localMeta.deafened             === true;
            baseServerDeafened          = _localMeta.server_deafened      === true;
            localServerMutedAudio       = _localMeta.server_muted_audio   === true;
            localServerMutedVideo       = _localMeta.server_muted_video   === true;
            localServerMutedScreenShare = _localMeta.server_muted_screenshare === true;
        }
    } catch {}
    const [localDeafened, setLocalDeafened] = React.useState(false);
    const wasMutedBeforeDeafenRef = React.useRef(false);
    // Tracks whether the user had manually muted themselves BEFORE a server-mute
    // landed. When the server-mute is lifted, we only restore the mic to enabled
    // if they were NOT already muted — matching the self-deafen pattern above.
    const wasMutedBeforeServerMuteRef = React.useRef(false);
    const [localMutedParticipantIds, setLocalMutedParticipantIds] = React.useState<Set<string>>(new Set());
    const isLocalDeafened = localDeafened || baseLocalDeafened || baseServerDeafened;

    // Push combined tray state whenever any of the four dimensions change.
    // (Declared here, after isLocalDeafened, so the dep array doesn't hit a TDZ.)
    React.useEffect(() => {
        if (!room || !localIdentity) return;
        window.electronAPI?.traySetCallSpeaking?.(true, localIsSpeaking, localIsMuted, isLocalDeafened);
    }, [room, localIdentity, localIsSpeaking, localIsMuted, isLocalDeafened]);

    // Sync local avatar to LiveKit metadata
    React.useEffect(() => {
        if (!localParticipant || !localAvatarUrl) return;
        let meta: Record<string, any> = {};
        try { if (localParticipant.metadata) meta = JSON.parse(localParticipant.metadata); } catch {}
        if (meta.avatar_url !== localAvatarUrl) {
            meta.avatar_url = localAvatarUrl;
            // setMetadata awaits a signaling ack from the LiveKit server and rejects
            // with SignalRequestError on timeout (network hiccup, server under load,
            // or multiple rapid updates queued). Avatar sync is cosmetic — silently
            // drop the error; the next state change will re-send a fresh metadata blob.
            localParticipant.setMetadata(JSON.stringify(meta)).catch(() => { /* cosmetic */ });
        }
    }, [localParticipant, localAvatarUrl]);

    // Auto-restore mic when a server-mute is lifted. When the moderator server-
    // mutes the local user, we record whether they were already manually muted
    // so that lifting the server-mute only re-enables the mic if the user hadn't
    // muted themselves before. This mirrors the self-deafen restore pattern.
    //
    // Reliability-audit fix: this used to unconditionally re-enable the mic on
    // every server-unmute, overriding any self-mute regardless of WHEN it
    // happened — including a self-mute click that landed the SAME INSTANT an
    // unrelated moderator action lifted an existing server-mute, which would
    // silently turn the mic back on right after the user had just muted it,
    // with zero explanation for why. Matches Discord's model now instead:
    // lifting a server-mute only removes the SERVER-SIDE block — it restores
    // the mic ONLY if the user's own choice (captured in
    // wasMutedBeforeServerMuteRef the moment the server-mute was first
    // applied) was "on." A self-mute always wins over a moderator's unmute;
    // the moderator can only ever ADD a mute, never force one off.
    const prevServerMutedAudioRef = React.useRef(false);
    React.useEffect(() => {
        if (!localParticipant) return;
        if (localServerMutedAudio) {
            // Moderator just muted us — snapshot manual mute state before we
            // enforce the server mute. The SFU has already dropped the track,
            // but we also disable client-side so the mic button icon updates.
            wasMutedBeforeServerMuteRef.current = !localParticipant.isMicrophoneEnabled;
            if (localParticipant.isMicrophoneEnabled) {
                localParticipant.setMicrophoneEnabled(false).catch(() => {});
            }
        } else if (prevServerMutedAudioRef.current) {
            // Moderator lifted an server-mute that was actually active — restore
            // the mic only if the user hadn't ALSO muted themselves. Skip
            // entirely on mount (prevServerMutedAudioRef starts false, so a
            // call that simply never had a server-mute doesn't fire this at
            // all) and skip when this effect's own true→false transition
            // wasn't a real lift (covered by the same guard).
            if (!wasMutedBeforeServerMuteRef.current) {
                localParticipant.setMicrophoneEnabled(true).catch(() => {});
            }
            toast.push({
                kind: 'info',
                title: 'Server mute removed',
                message: wasMutedBeforeServerMuteRef.current
                    ? 'A moderator removed your server mute. You muted yourself, so your mic stays off until you unmute.'
                    : 'A moderator removed your server mute.',
            });
        }
        prevServerMutedAudioRef.current = localServerMutedAudio;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [localServerMutedAudio]); // intentionally not including localParticipant — identity never changes mid-call

    const toggleParticipantLocalMute = (identity: string, muted: boolean) => {
        setLocalMutedParticipantIds(prev => {
            const next = new Set(prev);
            if (muted) next.add(identity); else next.delete(identity);
            return next;
        });
    };

    const [fallbackAvatars, setFallbackAvatars] = React.useState<Record<string, string>>({});
    React.useEffect(() => {
        if (!sessionId || !token) return;

        // Pre-seed from the authoritative server member list (Dashboard → ServerContextPanel).
        // This covers voice/huddle calls where isGroup=true and remoteAvatarUrl isn't used
        // as a fallback in VideoTile — the server member list is available before LiveKit
        // participant metadata propagates.
        if (memberAvatarMap && Object.keys(memberAvatarMap).length > 0) {
            const mapSeed: Record<string, string> = {};
            for (const [uid, url] of Object.entries(memberAvatarMap)) {
                if (url) mapSeed[uid] = url;
            }
            if (Object.keys(mapSeed).length > 0) {
                setFallbackAvatars(prev => ({ ...prev, ...mapSeed }));
            }
        }

        // Seed immediately from each participant's LiveKit token metadata.
        // This covers voice-channel calls where isGroup=true prevents remoteAvatarUrl
        // from being the fallback in VideoTile — the metadata avatar_url embedded
        // in the participant's token is the primary per-participant source.
        const metaSeed: Record<string, string> = {};
        for (const p of participants) {
            try {
                const m = p.metadata ? JSON.parse(p.metadata) : null;
                if (typeof m?.avatar_url === 'string' && m.avatar_url) {
                    metaSeed[p.identity] = m.avatar_url;
                }
            } catch {}
        }
        if (Object.keys(metaSeed).length > 0) {
            setFallbackAvatars(prev => ({ ...prev, ...metaSeed }));
        }

        let active = true;
        const fetchAvatars = async () => {
            try {
                const res = await axios.get(`${API_BASE}/calls/${sessionId}/status`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (active && res.data.participant_users) {
                    const map: Record<string, string> = {};
                    for (const u of res.data.participant_users) {
                        if (u.avatar_url) map[u.user_id] = u.avatar_url;
                    }
                    setFallbackAvatars(prev => ({...prev, ...map}));
                }
            } catch (e) {}
        };
        fetchAvatars();
        return () => { active = false; };
    // metadataKey re-fires this when any participant's metadata changes so
    // the seed stays current (e.g. a participant who joined before the effect
    // last ran now has their metadata available).
    }, [sessionId, token, participants.length, metadataKey, memberAvatarMap]);

    const [subscribedScreenshares, setSubscribedScreenshares] = React.useState<Set<string>>(new Set());
    const handleSubscribeScreenshare = (identity: string) => {
        setSubscribedScreenshares(prev => new Set([...prev, identity]));
    };

    // ── Screenshare viewer count + streamer cues ────────────────────────────
    //
    // "Viewer" is the Watch click (ScreenShareGate.handleWatch → this set),
    // not mere presence in the call — which is exactly what the owner asked
    // for. We publish that set into our OWN LiveKit metadata and every other
    // client folds the roster to get a per-publisher count. No API endpoint,
    // no WS event: see utils/screenShareViewers.ts for why the server has no
    // business holding a live who-is-watching-whom graph.
    //
    // `metadataKey` is in the deps on purpose. THREE effects in this file
    // read-modify-write the one metadata blob (this, the avatar sync, the
    // deafen toggle) and `setMetadata` replaces it wholesale, so a write can
    // land on a read that a concurrent write has already invalidated.
    // Re-running whenever the blob changes makes that self-healing:
    // writeWatchedShares re-derives from whatever actually won and returns
    // null once the key is already right, so the steady state is one silent
    // no-op rather than a write loop.
    React.useEffect(() => {
        if (!localParticipant) return;
        const next = writeWatchedShares(localParticipant.metadata, [...subscribedScreenshares]);
        if (next === null) return;
        // Same as the avatar sync below — swallow SignalRequestError timeouts;
        // the next change re-sends a fresh blob.
        localParticipant.setMetadata(next).catch(() => { /* cosmetic */ });
    }, [localParticipant, subscribedScreenshares, metadataKey]);

    // Who is watching OUR share right now, derived from the live roster. A
    // watcher who drops off the call is simply absent from the next fold —
    // there is no counter to leak and no "viewer left" event to miss.
    const localShareViewers = useScreenShareViewers(localIdentity);
    const localShareViewersKey = localShareViewers.join(',');

    // The cue epoch. ANY change re-arms a silent grace window (see
    // reduceViewerCues), which is what keeps these cues from storming on:
    //   - starting a share into a room that immediately piles in,
    //   - a reconnect, where every watcher's metadata re-arrives at once and
    //     reads as N people who all "just" started watching,
    //   - Change Source / Adjust Quality, which republishes the track under a
    //     new sid while watchers transparently re-subscribe (see the
    //     auto-resubscribe effect below).
    const localSharePub = localParticipant?.getTrackPublication(Track.Source.ScreenShare);
    const viewerCueEpoch = localParticipant?.isScreenShareEnabled
        ? `${localSharePub?.trackSid ?? 'pending'}:${isReconnecting ? 'recon' : 'live'}`
        : '';
    const viewerCueRef = React.useRef(initialViewerCueState());
    React.useEffect(() => {
        const { state, cues } = reduceViewerCues(viewerCueRef.current, {
            epoch: viewerCueEpoch,
            viewers: localShareViewersKey ? localShareViewersKey.split(',') : [],
            now: Date.now(),
        });
        viewerCueRef.current = state;
        // Streamer-only by construction, no identity check needed: this effect
        // belongs to the local participant and the set it folds is "people
        // watching ME". A viewer's own Watch click mutates THEIR metadata, and
        // `viewersOf` excludes the publisher from its own count — so neither
        // the viewer nor the other watchers can reach this branch.
        for (const cue of cues) {
            playSound(cue === 'start' ? 'stream_viewer_join' : 'stream_viewer_leave', soundsPrefs());
        }
    // soundsPrefs is a live closure over notifPrefs, read at fire time on
    // purpose (same as every other playSound site in this file) — listing it
    // would re-run this effect on unrelated prefs edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewerCueEpoch, localShareViewersKey]);

    const [isCameraEnabling, setIsCameraEnabling] = React.useState(false);

    React.useEffect(() => {
        if (localParticipant?.isCameraEnabled) setIsCameraEnabling(false);
        if (isCameraEnabling) {
            const t = setTimeout(() => setIsCameraEnabling(false), 5000);
            return () => clearTimeout(t);
        }
    }, [isCameraEnabling, localParticipant?.isCameraEnabled]);

    const localCam = (localParticipant?.isCameraEnabled || isCameraEnabling) ? localParticipant : null;

    // Mirrors localCam: your own screen share never had a tile anywhere in
    // this file — screenShareParticipants below is built from remoteParticipants
    // only, and camera is the only source with a special-cased local branch.
    // So starting a share made your icon go live in the controls with nothing
    // to actually confirm what's on the wire, unlike every other call app.
    const localScreenShare = localParticipant?.isScreenShareEnabled ? localParticipant : null;

    const remoteParticipants = participants.filter(p => p.identity !== localParticipant?.identity) as RemoteParticipant[];

    // Identities -> display names for the unencrypted-participant warning.
    // `p.name || 'Unknown'` is the same fallback ParticipantCard uses (the
    // LiveKit token may carry no display name). An identity with no matching
    // participant is dropped rather than shown raw: by the time we'd render a
    // bare user id they have almost certainly left, and a stale id in a
    // security warning is worse than a slightly shorter list.
    const unencryptedKey = (unencryptedIdentities ?? []).join(',');
    const unencryptedNames = React.useMemo(() => {
        const ids = new Set(unencryptedIdentities ?? []);
        if (ids.size === 0) return [] as string[];
        return participants
            .filter(p => ids.has(p.identity))
            .map(p => p.name || 'Unknown')
            .sort();
        // `unencryptedKey` stands in for the array identity so a new array with
        // the same contents doesn't churn this; `participants` is the roster.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [unencryptedKey, participants]);

    const remoteCamParticipants = remoteParticipants.filter(p => {
        const pub = p.getTrackPublication(Track.Source.Camera);
        return pub?.isSubscribed && !pub.isMuted;
    });
    const screenShareParticipants = remoteParticipants.filter(p =>
        p.getTrackPublication(Track.Source.ScreenShare)
    );

    const activeScreenShareIds = screenShareParticipants.map(sp => sp.identity).sort().join(',');

    // Prune `subscribedScreenshares` only AFTER a grace period. When someone
    // adjusts their share (change source / toggle audio / change quality), the
    // old publication is torn down and a new one is published within a few
    // hundred ms. Without this grace window, every watcher's subscription gets
    // immediately dropped, the "Click to Watch" gate reappears, and they have
    // to click again — painful mid-call. 1500 ms covers the longest observed
    // republish gap while still pruning fast enough for genuine stops.
    React.useEffect(() => {
        const activeSet = new Set(activeScreenShareIds ? activeScreenShareIds.split(',') : []);
        // Anyone still in subscribedScreenshares but no longer actively sharing
        // is a candidate for pruning. Delay the actual prune — if the pub
        // reappears within the window, the auto-resubscribe effect below
        // re-takes the subscription seamlessly.
        const timer = setTimeout(() => {
            setSubscribedScreenshares(prev => {
                const next = new Set<string>();
                prev.forEach(id => { if (activeSet.has(id)) next.add(id); });
                if (next.size !== prev.size) return next;
                return prev;
            });
        }, 1500);
        return () => clearTimeout(timer);
    }, [activeScreenShareIds]);

    // Auto-resubscribe effect: when a screenshare publication (re)appears for
    // someone we were already watching, transparently re-take the subscription
    // on the new track. This is what makes "change source / adjust quality /
    // toggle audio" feel like an in-place update instead of a stop+restart.
    // NOTE: setSubscribed returns void in some LiveKit versions — wrap in an
    // async IIFE rather than chaining `.catch` directly on the return value.
    React.useEffect(() => {
        screenShareParticipants.forEach(p => {
            if (!subscribedScreenshares.has(p.identity)) return;
            const ssPub = p.getTrackPublication(Track.Source.ScreenShare) as RemoteTrackPublication | undefined;
            const ssAudioPub = p.getTrackPublication(Track.Source.ScreenShareAudio) as RemoteTrackPublication | undefined;
            (async () => {
                try {
                    if (ssPub && !ssPub.isSubscribed) await ssPub.setSubscribed(true);
                    if (ssAudioPub && !ssAudioPub.isSubscribed) await ssAudioPub.setSubscribed(true);
                } catch (e) {
                    console.warn('[ScreenShare] auto-resubscribe failed', e);
                }
            })();
        });
    }, [activeScreenShareIds, subscribedScreenshares, screenShareParticipants]);

    // Clear the "hidden screenshare" flag when the participant stops sharing.
    // hiddenScreenShareIds tracks participants whose screenshare prompt the
    // user dismissed via "Hide Screen Share" in the popover. The flag drives
    // a small MonitorOff badge on their participant card. When the publisher
    // ends their share, the badge has nothing to refer to anymore — but the
    // Set entry would persist until the next time they share, at which point
    // the user would expect a fresh prompt and instead see a stale badge with
    // no gate. Same 1500 ms grace as subscribedScreenshares so a quick
    // adjust-source republish doesn't reset the user's hide preference.
    React.useEffect(() => {
        const activeSet = new Set(activeScreenShareIds ? activeScreenShareIds.split(',') : []);
        const timer = setTimeout(() => {
            setHiddenScreenShareIds(prev => {
                const next = new Set<string>();
                prev.forEach(id => { if (activeSet.has(id)) next.add(id); });
                if (next.size !== prev.size) return next;
                return prev;
            });
        }, 1500);
        return () => clearTimeout(timer);
    }, [activeScreenShareIds]);

    const [isScreenSharePickerOpen, setIsScreenSharePickerOpen] = React.useState(false);
    // Pending options during the getDisplayMedia handshake. This ref is cleared as
    // soon as Electron's setDisplayMediaRequestHandler resolves (see line ~620).
    const pendingScreenShareRef = React.useRef<ScreenShareOptions | null>(null);
    // Long-lived record of the currently-running share — set after a successful
    // publish, cleared when the share stops. Used by "Change Source" and "Adjust
    // Quality" so they can reference the active sourceId/quality even after the
    // pending handshake ref has been nulled. Mirrored into state so ControlBar's
    // quality panel can render the current values instead of stale hardcoded defaults.
    const currentShareRef = React.useRef<ScreenShareOptions | null>(null);
    const [currentShare, setCurrentShare] = React.useState<ScreenShareOptions | null>(null);

    // H.264 High for the screen share when that is this GPU's hardware H.264
    // (decideScreenShareCodec — the NVIDIA case). Set per publish; read by the
    // localSenderCreated hook below on the first publish AND on every
    // LiveKit republish (reconnect), which builds a fresh transceiver.
    const wantH264HighRef = React.useRef(false);
    // The H.264 High start watchdog republishes through this (a direct
    // self-call from inside handleScreenShareSelect makes the React compiler
    // treat the whole handler as render-reachable). Set in an effect below.
    const republishShareRef = React.useRef<((o: ScreenShareOptions) => void) | null>(null);
    React.useEffect(() => {
        if (!localParticipant) return;
        return installH264HighPreference(
            localParticipant as unknown as SenderCreatedSource,
            () => wantH264HighRef.current,
        );
    }, [localParticipant]);

    // Transient notice shown above the call UI when a screenshare audio choice
    // hits a platform limit (e.g. per-window audio requires Windows). Auto-
    // dismisses after ~6s; manually dismissable via the close button.
    const [screenShareNotice, setScreenShareNotice] = React.useState<{
        tone: 'info' | 'warn';
        text: string;
    } | null>(null);
    React.useEffect(() => {
        if (!screenShareNotice) return;
        const id = setTimeout(() => setScreenShareNotice(null), 6000);
        return () => clearTimeout(id);
    }, [screenShareNotice]);

    // Whether the native WASAPI audio_capture.node addon is actually loaded in the
    // main process. The preload *always* exposes startWindowAudioCapture, so we
    // cannot infer capability from its mere existence — on Linux/macOS the IPC
    // returns false and we'd silently publish no audio track at all. Probing once
    // at mount lets us route non-Windows builds through LiveKit's getDisplayMedia
    // audio path (Chromium loopback) instead.
    const [nativeAudioSupported, setNativeAudioSupported] = React.useState(false);
    React.useEffect(() => {
        window.electronAPI?.isAudioCaptureSupported?.()
            .then(v => {
                console.log('[ScreenShare] Native audio capture supported:', v,
                    v ? '— WASAPI per-process loopback active' : '— falling back to Chromium getDisplayMedia');
                setNativeAudioSupported(!!v);
            })
            .catch(() => setNativeAudioSupported(false));
    }, []);
    // Native window-audio capture state (WASAPI ApplicationLoopback, Windows only).
    // The native addon streams float32 PCM at 48 kHz / stereo / ~10 ms chunks.
    // We feed those chunks into an AudioWorkletNode ring buffer; the worklet pulls
    // at the AudioContext's own clock, so there's no absolute-time scheduling, no
    // per-chunk BufferSource churn, and drift handles itself (underruns silence,
    // overflows drop oldest frames).
    const nativeAudioCtxRef     = React.useRef<AudioContext | null>(null);
    const nativeDestinationRef  = React.useRef<MediaStreamAudioDestinationNode | null>(null);
    const nativeWorkletNodeRef  = React.useRef<AudioWorkletNode | null>(null);
    const nativeAudioPubRef     = React.useRef<any>(null); // LiveKit LocalTrackPublication
    // Watchdog timer ref so stopNativeWindowAudio can cancel it before it fires
    // on a subsequent share (e.g. swap-source within 3 s).
    const nativeChunkWatchdogRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const stopNativeWindowAudio = React.useCallback(async () => {
        // Cancel any pending "no chunks" watchdog from the previous capture session.
        if (nativeChunkWatchdogRef.current !== null) {
            clearTimeout(nativeChunkWatchdogRef.current);
            nativeChunkWatchdogRef.current = null;
        }
        window.electronAPI?.removeWindowAudioChunkListener?.();
        window.electronAPI?.removeWindowAudioProcessExitedListener?.();
        window.electronAPI?.stopWindowAudioCapture?.();

        if (nativeWorkletNodeRef.current) {
            try { nativeWorkletNodeRef.current.disconnect(); } catch (_) {}
            try { nativeWorkletNodeRef.current.port.close(); } catch (_) {}
            nativeWorkletNodeRef.current = null;
        }
        if (nativeDestinationRef.current) {
            try { nativeDestinationRef.current.disconnect(); } catch (_) {}
            nativeDestinationRef.current = null;
        }
        if (nativeAudioCtxRef.current) {
            await nativeAudioCtxRef.current.close().catch(() => {});
            nativeAudioCtxRef.current = null;
        }
        if (nativeAudioPubRef.current && localParticipant) {
            try {
                await localParticipant.unpublishTrack(nativeAudioPubRef.current.track);
            } catch (_) {}
            nativeAudioPubRef.current = null;
        }
    }, [localParticipant]);

    // When the OS ends the share externally (e.g. user hits "Stop" in the platform
    // overlay/notification instead of Cipherline's own controls), LiveKit flips
    // isScreenShareEnabled to false without us intervening — that only stops the
    // VIDEO track, though. Native window-audio capture (WASAPI, a SEPARATE
    // ScreenShareAudio publication, started/stopped independently — see
    // startNativeWindowAudio/stopNativeWindowAudio above) used to be torn down
    // ONLY from Cipherline's own in-app stop-sharing paths (the button, the
    // keybind, a source swap), all of which flip isScreenShareEnabled themselves.
    // The OS-native stop path bypasses every one of those, which meant stopping a
    // share via the platform's own "Stop sharing" bar left the WASAPI loopback
    // capture, its AudioContext/AudioWorkletNode, and the ScreenShareAudio
    // publication all running and still transmitting into the call — invisible to
    // the UI (which correctly showed "not sharing") until the user happened to
    // trigger an in-app stop path again or left the call. Routing the teardown
    // through THIS single effect, keyed on the one signal that's true regardless
    // of which path ended the share, closes that gap; stopNativeWindowAudio()
    // itself is fully idempotent (every step is null-guarded) so calling it here
    // in addition to the explicit in-app call sites is safe, not a double-teardown
    // bug.
    React.useEffect(() => {
        if (!localParticipant?.isScreenShareEnabled) {
            if (currentShareRef.current) {
                currentShareRef.current = null;
                setCurrentShare(null);
            }
            if (nativeAudioPubRef.current || nativeAudioCtxRef.current) {
                void stopNativeWindowAudio();
            }
        }
    }, [localParticipant?.isScreenShareEnabled, stopNativeWindowAudio]);

    // Unified native capture entry point. Two modes:
    //   - 'window':  AC_LOOPBACK_INCLUDE on the shared app's root process tree.
    //                Captures only that app's audio. Used for single-window shares.
    //   - 'screen':  AC_LOOPBACK_EXCLUDE on Cipherline's own main PID tree.
    //                Captures all system audio EXCEPT Cipherline itself, which
    //                prevents the call's own audio from being fed back into the
    //                share. Used for full-screen shares.
    const startNativeWindowAudio = React.useCallback(async (
        mode: 'window' | 'screen',
        sourceId: string,
    ) => {
        if (!window.electronAPI?.startWindowAudioCapture) {
            console.warn('[NativeAudio] Electron API not available');
            return;
        }

        // Defensive: tear down any in-flight capture from a previous share attempt
        // so we can't stack publications ("publishing a second track with the same source").
        await stopNativeWindowAudio();

        // Resolve the PID and WASAPI mode based on share type.
        let targetPid: number | null = null;
        let wasapiMode: 'include' | 'exclude' = 'include';

        if (mode === 'window') {
            if (!window.electronAPI?.getPidFromSourceId) {
                console.warn('[NativeAudio] getPidFromSourceId unavailable');
                return;
            }
            // For window sources, walk up from the renderer to the app's root process
            // so INCLUDE captures the Audio Service utility child as a descendant.
            targetPid = await window.electronAPI.getPidFromSourceId(sourceId);
            wasapiMode = 'include';
            if (!targetPid) {
                console.warn('[NativeAudio] Could not resolve root PID for source', sourceId,
                    '— video share continues without audio.');
                setScreenShareNotice({
                    tone: 'warn',
                    text: 'Could not identify the window\'s process for audio capture. Sharing without audio.',
                });
                return;
            }
            console.log('[NativeAudio] window mode — root PID for INCLUDE capture:', targetPid);
        } else {
            if (!window.electronAPI?.getOwnPid) {
                console.warn('[NativeAudio] getOwnPid unavailable');
                return;
            }
            // For screen sources, exclude Cipherline's own process tree from
            // system-wide loopback so the call audio is NOT captured back.
            targetPid = await window.electronAPI.getOwnPid();
            wasapiMode = 'exclude';
            console.log('[NativeAudio] screen mode — Cipherline PID for EXCLUDE capture:', targetPid);
        }
        const rootPid = targetPid;

        // Create the AudioContext at 48 kHz to match the native capture format exactly.
        // This eliminates resampling (48000 -> hardware default) which was a source of
        // static in the previous BufferSource scheduler approach. If the OS refuses
        // (rare — most hardware supports 48 kHz), fall back to the default rate and
        // let the worklet's own logic handle any rate mismatch.
        let ctx: AudioContext;
        try {
            ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
        } catch (_) {
            ctx = new AudioContext({ latencyHint: 'playback' });
        }
        nativeAudioCtxRef.current = ctx;

        // Chromium autoplay policy suspends AudioContext when created after an await
        // boundary (the user-gesture token is consumed by setScreenShareEnabled above).
        if (ctx.state !== 'running') {
            await ctx.resume();
        }
        console.log('[NativeAudio] AudioContext state:', ctx.state, 'sr:', ctx.sampleRate);

        // Inline AudioWorklet processor — a ring-buffer pull node. Chunks arrive via
        // port.postMessage from the main thread; process() pulls frames at the audio
        // graph's own clock. Underruns output silence (no click), overflows drop the
        // oldest frames (bounded latency). Inlined as a Blob URL so packaged builds
        // don't have to resolve a file path.
        const workletSource = `
            class PCMRingProcessor extends AudioWorkletProcessor {
                constructor() {
                    super();
                    this.channels = 2;
                    // 2 seconds of headroom at 48 kHz — absorbs IPC jitter comfortably.
                    this.ringSize = 48000 * 2;
                    this.ring = [new Float32Array(this.ringSize), new Float32Array(this.ringSize)];
                    this.writeIdx = 0;
                    this.readIdx = 0;
                    this.available = 0;
                    this.started = false;
                    // Keep ~40 ms prebuffered before we start pulling so small bursts of
                    // IPC jitter don't cause immediate underruns at the very start.
                    this.prebufferFrames = Math.floor(sampleRate * 0.04);

                    this.port.onmessage = (e) => {
                        const d = e.data;
                        if (!d || d.type !== 'pcm') return;
                        const interleaved = d.pcm;
                        const ch = d.channels || 2;
                        const frames = (interleaved.length / ch) | 0;
                        if (frames <= 0) return;

                        // If we would overflow, drop the oldest frames — bound latency.
                        if (this.available + frames > this.ringSize) {
                            const toDrop = (this.available + frames) - this.ringSize;
                            this.readIdx = (this.readIdx + toDrop) % this.ringSize;
                            this.available -= toDrop;
                        }

                        // De-interleave into per-channel ring slots.
                        let w = this.writeIdx;
                        for (let f = 0; f < frames; f++) {
                            this.ring[0][w] = interleaved[f * ch];
                            this.ring[1][w] = ch > 1 ? interleaved[f * ch + 1] : interleaved[f * ch];
                            w = (w + 1) % this.ringSize;
                        }
                        this.writeIdx = w;
                        this.available += frames;
                    };
                }

                process(_inputs, outputs) {
                    const out = outputs[0];
                    const outFrames = out[0].length;
                    const outChannels = out.length;

                    // Gate on prebuffer — silence until we have enough cushion.
                    if (!this.started) {
                        if (this.available < this.prebufferFrames) {
                            for (let c = 0; c < outChannels; c++) out[c].fill(0);
                            return true;
                        }
                        this.started = true;
                    }

                    if (this.available < outFrames) {
                        // Underrun: emit silence for this block, re-arm prebuffer so we
                        // rebuild cushion before resuming playback (prevents stutter loops).
                        for (let c = 0; c < outChannels; c++) out[c].fill(0);
                        this.started = false;
                        return true;
                    }

                    let r = this.readIdx;
                    for (let f = 0; f < outFrames; f++) {
                        out[0][f] = this.ring[0][r];
                        if (outChannels > 1) out[1][f] = this.ring[1][r];
                        r = (r + 1) % this.ringSize;
                    }
                    this.readIdx = r;
                    this.available -= outFrames;
                    return true;
                }
            }
            registerProcessor('pcm-ring', PCMRingProcessor);
        `;

        const workletBlobUrl = URL.createObjectURL(
            new Blob([workletSource], { type: 'application/javascript' })
        );
        try {
            await ctx.audioWorklet.addModule(workletBlobUrl);
        } finally {
            URL.revokeObjectURL(workletBlobUrl);
        }

        const workletNode = new AudioWorkletNode(ctx, 'pcm-ring', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
        });
        nativeWorkletNodeRef.current = workletNode;

        const destination = ctx.createMediaStreamDestination();
        nativeDestinationRef.current = destination;
        workletNode.connect(destination);

        // Register chunk handler BEFORE starting capture to avoid dropped packets.
        // chunkWatchdog is declared as `let` here (before the handler) so the
        // closure can reference it safely once the timer is assigned post-start.
        // It's also stored in nativeChunkWatchdogRef so stopNativeWindowAudio can
        // cancel it if the user swaps source before the 3-second window elapses.
        let chunkCount = 0;
        let chunkWatchdog: ReturnType<typeof setTimeout> | null = null;
        nativeChunkWatchdogRef.current = null; // clear any stale ref from prior capture
        window.electronAPI!.onWindowAudioChunk((chunk) => {
            const node = nativeWorkletNodeRef.current;
            if (!node) return;

            chunkCount++;
            // `chunk.data` is an ArrayBuffer owned by this callback — safe to view
            // and transfer ownership into the worklet (no copy across threads).
            const pcm = new Float32Array(chunk.data);
            node.port.postMessage(
                { type: 'pcm', pcm, channels: chunk.channels },
                [pcm.buffer]
            );

            if (chunkCount === 1) {
                if (chunkWatchdog !== null) {
                    clearTimeout(chunkWatchdog);
                    chunkWatchdog = null;
                    nativeChunkWatchdogRef.current = null;
                }
                console.log(`[NativeAudio] FIRST CHUNK forwarded: frames=${pcm.length / chunk.channels} sr=${chunk.sampleRate} ch=${chunk.channels}`);
            } else if (chunkCount % 500 === 0) {
                console.log(`[NativeAudio] chunks forwarded=${chunkCount}`);
            }
        });

        // Reliability audit (Phase K): the native addon distinguishes "target
        // process exited" from ordinary silence (WASAPI keeps delivering
        // silent packets on a dead process's now-orphaned loopback session,
        // which the 3s "no chunks" watchdog below can't tell apart from a
        // quiet-but-alive app). Tear the native capture all the way down —
        // there is nothing left to capture — and say so, instead of the call
        // silently carrying a permanently-silent ScreenShareAudio track.
        window.electronAPI?.onWindowAudioProcessExited?.(() => {
            console.warn('[NativeAudio] Capture target process exited — stopping native audio capture.');
            setScreenShareNotice({
                tone: 'warn',
                text: mode === 'window'
                    ? 'The app you were sharing audio from has closed.'
                    : 'The process behind this audio capture has closed.',
            });
            void stopNativeWindowAudio();
        });

        // Hand off to the native addon. For window shares this is INCLUDE on the
        // app's root tree (captures that app only); for full-screen shares this is
        // EXCLUDE on Cipherline's own tree (captures everything else, no feedback).
        console.log(`[NativeAudio] Calling startWindowAudioCapture: pid=${rootPid} mode=${wasapiMode}`);
        const started = await window.electronAPI!.startWindowAudioCapture(rootPid, wasapiMode);
        if (!started) {
            console.warn('[NativeAudio] startWindowAudioCapture returned false — WASAPI failed to init');
            setScreenShareNotice({
                tone: 'warn',
                text: 'Audio capture initialisation failed (WASAPI error). Sharing video without audio.',
            });
            return;
        }
        console.log('[NativeAudio] startWindowAudioCapture returned true — waiting for first chunk...');

        // 3-second watchdog: if no PCM chunks arrive, WASAPI started silently but
        // isn't delivering audio. Surface a warning so users don't wonder why
        // their share is silent. Clear the timer on the first chunk.
        chunkWatchdog = setTimeout(() => {
            nativeChunkWatchdogRef.current = null;
            if (chunkCount === 0) {
                console.warn('[NativeAudio] No chunks received in 3s after capture start.',
                    `pid=${rootPid} mode=${wasapiMode}`,
                    '— WASAPI capture is silent. Possible causes: target app has no audio,',
                    'WASAPI EXCLUDE mode may not capture audio routed through audiodg.exe,',
                    'or the audio service sandbox blocks per-process capture for this app.');
                setScreenShareNotice({
                    tone: 'warn',
                    text: mode === 'window'
                        ? 'No audio detected from this window. The app may not be producing sound.'
                        : 'No system audio captured. Audio may be routed through a process Cipherline cannot intercept.',
                });
            }
        }, 3000);
        nativeChunkWatchdogRef.current = chunkWatchdog;

        // Publish the MediaStream audio track to LiveKit as ScreenShareAudio
        if (!localParticipant) return;
        const mediaTrack = destination.stream.getAudioTracks()[0];
        if (!mediaTrack) {
            console.warn('[NativeAudio] No audio track on destination');
            return;
        }

        // Surgical override: LiveKit's LocalAudioTrack reads getSettings() on the underlying
        // MediaStreamTrack and advertises AudioTrackFeature flags (TF_NOISE_SUPPRESSION,
        // TF_ECHO_CANCELLATION, TF_AUTO_GAIN_CONTROL) to the SFU based on those values.
        // Chrome bakes all three to `true` on MediaStreamAudioDestinationNode tracks and
        // refuses applyConstraints() on WebAudio-sourced tracks. Patching getSettings on
        // this single track instance is the only way to stop the processing flags from
        // being announced without forking livekit-client. Scoped to this track only.
        const origGetSettings = mediaTrack.getSettings.bind(mediaTrack);
        mediaTrack.getSettings = () => ({
            ...origGetSettings(),
            noiseSuppression: false,
            echoCancellation: false,
            autoGainControl:  false,
        });

        try {
            // Wrap in LocalAudioTrack ourselves. Third arg `userProvidedTrack=true` stops
            // LiveKit from invoking applyConstraints() on our WebAudio track (which would
            // throw OverconstrainedError) and from re-sampling the getSettings() output.
            const localAudioTrack = new LocalAudioTrack(mediaTrack, undefined, true);

            // Music-grade publish options: disable DTX (no "silence" in music/game audio),
            // disable RED (latency over redundancy for live shares), force stereo Opus at
            // 192 kbps to match Discord's "high-quality streamer mode" audio.
            const publication = await localParticipant.publishTrack(localAudioTrack, {
                source: Track.Source.ScreenShareAudio,
                name:   'screen-audio',
                dtx:    false,
                red:    false,
                forceStereo: true,
                audioPreset: { maxBitrate: 192_000 },
            } as any);
            nativeAudioPubRef.current = publication;
            console.log('[NativeAudio] Published to LiveKit (music-grade, NS/EC/AGC disabled)');
        } catch (err) {
            console.error('[NativeAudio] Failed to publish native audio track:', err);
        }
    }, [localParticipant, stopNativeWindowAudio]);

    // Electron IPC: fires when getDisplayMedia is intercepted by setDisplayMediaRequestHandler.
    React.useEffect(() => {
        if (!window.electronAPI?.onShowScreensharePicker) return;
        const unsub = window.electronAPI.onShowScreensharePicker(() => {
            const pending = pendingScreenShareRef.current;
            if (pending) {
                window.electronAPI!.resolveDesktopSource(pending.sourceId, pending.audio);
                pendingScreenShareRef.current = null;
            }
        });
        return unsub;
    }, []);

    const [hiddenVideoIds, setHiddenVideoIds] = React.useState<Set<string>>(new Set());
    const [hiddenScreenShareIds, setHiddenScreenShareIds] = React.useState<Set<string>>(new Set());

    const toggleHideVideo = (id: string, hide: boolean) => {
        setHiddenVideoIds(prev => {
            const next = new Set(prev);
            if (hide) next.add(id); else next.delete(id);
            return next;
        });
    };

    // Mirror local-mute / hidden-video / hidden-screenshare sets into CallContext so
    // ServerContextPanel's huddle right-click menu (outside this component) can
    // render the same Mute / Hide Video / Hide Screen Share checkboxes from
    // PopoverMenu with the correct current state.
    React.useEffect(() => { setLocalMutedIdsCtx?.(localMutedParticipantIds); }, [setLocalMutedIdsCtx, localMutedParticipantIds]);
    React.useEffect(() => { setHiddenVideoIdsCtx?.(hiddenVideoIds); }, [setHiddenVideoIdsCtx, hiddenVideoIds]);
    React.useEffect(() => { setHiddenScreenShareIdsCtx?.(hiddenScreenShareIds); }, [setHiddenScreenShareIdsCtx, hiddenScreenShareIds]);

    // P2-REND-3: toggleHideScreenShare references participants/subscribedScreenshares
    // which change over the call lifetime. Register a stable wrapper through a ref
    // so outside-call callers (ServerContextPanel) always get the live closure.
    const toggleHideScreenShareRef = React.useRef<((id: string, hide: boolean) => Promise<void>) | null>(null);

    React.useEffect(() => {
        if (!registerLocalToggles) return;
        registerLocalToggles({
            toggleLocalMute: toggleParticipantLocalMute,
            toggleHideVideo,
            toggleHideScreenShare: (id, h) => { toggleHideScreenShareRef.current?.(id, h); },
        });
        return () => registerLocalToggles({});
    }, [registerLocalToggles]);

    const toggleHideScreenShare = async (id: string, hide: boolean) => {
        setHiddenScreenShareIds(prev => {
            const next = new Set(prev);
            if (hide) next.add(id); else next.delete(id);
            return next;
        });

        if (!hide) {
            const p = participants.find(part => part.identity === id);
            if (p && !subscribedScreenshares.has(id)) {
                try {
                    const ssPub = p.getTrackPublication(Track.Source.ScreenShare) as RemoteTrackPublication | undefined;
                    const ssAudioPub = p.getTrackPublication(Track.Source.ScreenShareAudio) as RemoteTrackPublication | undefined;
                    if (ssPub && !ssPub.isSubscribed) await ssPub.setSubscribed(true);
                    if (ssAudioPub && !ssAudioPub.isSubscribed) await ssAudioPub.setSubscribed(true);
                    setSubscribedScreenshares(prev => {
                        const next = new Set(prev);
                        next.add(id);
                        return next;
                    });
                } catch (e) {
                    console.error('Failed to subscribe to screenshare automatically', e);
                }
            }
        }
    };
    // Keep ref current so the stable wrapper registered above always calls the
    // latest closure (with fresh participants / subscribedScreenshares).
    toggleHideScreenShareRef.current = toggleHideScreenShare;

    const visibleRemoteCamParticipants = remoteCamParticipants.filter(p => !hiddenVideoIds.has(p.identity));

    // Scroll-safe active speaker sorting
    const scrollContainerRef = React.useRef<HTMLDivElement>(null);
    const videoTilesRef = React.useRef<HTMLDivElement>(null); // wraps ONLY video tiles
    const audioOnlyStripRef = React.useRef<HTMLDivElement>(null);
    const audioOnlyNormalRef = React.useRef<HTMLDivElement>(null);
    const audioOnlyNormalHeight = React.useRef(0); // cached height of normal section
    const audioOnlyCountRef = React.useRef(0); // always-fresh participant count for interval
    const anyVideoRef = React.useRef(false);
    const controlBarRef = React.useRef<HTMLDivElement>(null);
    const [isScrollable, setIsScrollable] = React.useState(false);

    // ── Video-overflow detection ─────────────────────────────────────────────
    // When there are more video tiles than fit in the visible panel, we enable
    // active-speaker promotion so the person talking automatically floats to the
    // top of the list. A 1-px sentinel div placed after the last video tile is
    // watched with IntersectionObserver: as soon as it leaves the viewport the
    // promotion mode turns on. It only turns OFF when the participant count
    // drops back down and the sentinel is visible again — preventing oscillation
    // where promotion moves tiles up, brings the sentinel into view, clears the
    // flag, tiles shuffle back, sentinel leaves view again.
    const videoBottomSentinelRef = React.useRef<HTMLDivElement>(null);
    const [isVideoOverflowing, setIsVideoOverflowing] = React.useState(false);
    const isVideoOverflowingRef = React.useRef(false);
    React.useEffect(() => { isVideoOverflowingRef.current = isVideoOverflowing; }, [isVideoOverflowing]);
    const prevCamCountRef = React.useRef(0);

    // The control bar is rendered via portal to `#call-controlbar-root` (lives at
    // the bottom of the chat panel) so it pins to the bottom of the panel rather
    // than the bottom of the call section. We track the target node in state +
    // a useLayoutEffect so the FIRST render after mount finds it and avoids the
    // single-frame flicker of inline rendering. Falls back to inline render when
    // no target exists (e.g. embedded in a non-Dashboard host).
    // The control bar is portaled to #call-controlbar-root (at the bottom of the
    // right panel) so it stays pinned regardless of scroll position. We use a
    // polling + MutationObserver pattern so the target is reliably found even
    // when the portal targets move between DOM positions (e.g. tab switches,
    // context-aware repositioning when the user navigates away from a server).
    const [controlsRoot, setControlsRoot] = React.useState<HTMLElement | null>(
        () => (typeof document !== 'undefined' ? document.getElementById('call-controlbar-root') : null)
    );
    // Poll until the target appears (or reappears after being removed).
    React.useEffect(() => {
        if (controlsRoot && document.body.contains(controlsRoot)) return;
        let cancelled = false;
        const tryFind = () => {
            if (cancelled) return;
            const el = document.getElementById('call-controlbar-root');
            if (el) { setControlsRoot(el); return; }
            requestAnimationFrame(tryFind);
        };
        tryFind();
        return () => { cancelled = true; };
    }, [controlsRoot]);
    // Watch for the target being removed so we restart the poll.
    React.useEffect(() => {
        if (!controlsRoot) return;
        const obs = new MutationObserver(() => {
            if (!document.body.contains(controlsRoot)) setControlsRoot(null);
        });
        obs.observe(document.body, { childList: true, subtree: true });
        return () => obs.disconnect();
    }, [controlsRoot]);

    // ── Fullscreen borrows the SAME control bar ──────────────────────────────
    // FullscreenOverlay used to hand-roll its own row of six ClButtons, which
    // meant fullscreen quietly missed everything ControlBar had grown since:
    // the right-click device pickers, the live-share stop+options segment, the
    // Pro upgrade prompt on a gated camera, the server-mute disabled states,
    // and the glass capsule itself. Rather than copy any of that, the one real
    // <ControlBar> simply changes address while fullscreen is up — it re-mounts
    // into #call-fullscreen-controls-root (Dashboard.tsx), which index.css
    // positions above the overlay off <html data-cl-fullscreen>.
    //
    // Same polling shape as controlsRoot above, and for the same reason: the
    // target is a plain div that always exists, but this component can render
    // before Dashboard's tree has committed on a cold mount.
    const [fsControlsRoot, setFsControlsRoot] = React.useState<HTMLElement | null>(
        () => (typeof document !== 'undefined' ? document.getElementById('call-fullscreen-controls-root') : null)
    );
    React.useEffect(() => {
        if (fsControlsRoot && document.body.contains(fsControlsRoot)) return;
        let cancelled = false;
        const tryFind = () => {
            if (cancelled) return;
            const el = document.getElementById('call-fullscreen-controls-root');
            if (el) { setFsControlsRoot(el); return; }
            requestAnimationFrame(tryFind);
        };
        tryFind();
        return () => { cancelled = true; };
    }, [fsControlsRoot]);
    // Falls back to the docked slot if the fullscreen target is somehow absent,
    // so the controls can never end up rendered nowhere.
    const activeControlsRoot = callCtx?.isFullscreen ? (fsControlsRoot ?? controlsRoot) : controlsRoot;

    // When rendering inside a voice channel (noRinging=true) the video tiles are
    // portaled to #call-video-root so they appear at the very top of the right panel
    // above the voice channel list, without SidebarConference needing to own full
    // panel height. Same polling + observer pattern as controlsRoot.
    const [videoRoot, setVideoRoot] = React.useState<HTMLElement | null>(
        () => (typeof document !== 'undefined' ? document.getElementById('call-video-root') : null)
    );
    React.useEffect(() => {
        if (videoRoot && document.body.contains(videoRoot)) return;
        let cancelled = false;
        const tryFind = () => {
            if (cancelled) return;
            const el = document.getElementById('call-video-root');
            if (el) { setVideoRoot(el); return; }
            requestAnimationFrame(tryFind);
        };
        tryFind();
        return () => { cancelled = true; };
    }, [videoRoot]);
    React.useEffect(() => {
        if (!videoRoot) return;
        const obs = new MutationObserver(() => {
            if (!document.body.contains(videoRoot)) setVideoRoot(null);
        });
        obs.observe(document.body, { childList: true, subtree: true });
        return () => obs.disconnect();
    }, [videoRoot]);



    // Apply active-speaker promotion only when the list is long enough to scroll.
    // When everything fits on screen, preserve join order so nobody jumps around.
    // Promoted participants appear first in promotion-recency order; everyone else
    // keeps their original position in the list.
    const applyPromotion = <T extends { identity: string }>(list: T[]): T[] => {
        const promotedSet = new Set(promotedIds);
        const front = promotedIds
            .map(id => list.find(p => p.identity === id))
            .filter((p): p is T => p != null);
        const rest = list.filter(p => !promotedSet.has(p.identity));
        return [...front, ...rest];
    };

    // Promote active speakers to the top when tiles overflow the visible area.
    // isVideoOverflowing is set by the IntersectionObserver sentinel below the
    // tile list — it enables here so the speaking participant floats to the top.
    const sortedVisibleRemoteCamParticipants = isVideoOverflowing
        ? applyPromotion(visibleRemoteCamParticipants)
        : visibleRemoteCamParticipants;

    // Camera quality: MEDIUM for ≤4 visible camera tiles (good quality without excess bandwidth),
    // LOW for >4 tiles (bandwidth saving on crowded calls).
    const totalCamTiles = (localCam ? 1 : 0) + visibleRemoteCamParticipants.length;
    const sidebarCamQuality = totalCamTiles > 4 ? VideoQuality.LOW : VideoQuality.MEDIUM;

    const visibleScreenShareParticipants = screenShareParticipants.filter(p => !hiddenScreenShareIds.has(p.identity));

    const videoParticipantIds = new Set([
        ...(localCam ? [localParticipant!.identity] : []),
        ...(localScreenShare ? [localParticipant!.identity] : []),
        ...visibleRemoteCamParticipants.map(p => p.identity),
        ...visibleScreenShareParticipants.map(p => p.identity),
    ]);

    // Stable base list: ALL participants (local first, then join order).
    // Video/screenshare participants are intentionally kept in this list so
    // they remain clickable and manageable in the sidebar row view even when
    // their tiles are visible above (voice-channel / huddle mode).
    const audioOnlyParticipantsBase = participants
        .sort((a, b) => {
            if (a.identity === localParticipant?.identity) return -1;
            if (b.identity === localParticipant?.identity) return 1;
            return 0;
        });

    // For DM / group calls (noRinging=false) video tiles are rendered inline,
    // so participants who have video should NOT also appear as avatar bubbles
    // in the participant grid — filter them out.
    const audioOnlyParticipantsBaseFiltered = noRinging
        ? audioOnlyParticipantsBase
        : audioOnlyParticipantsBase.filter(p => !videoParticipantIds.has(p.identity));

    // Promote active speakers in the audio-only / participant-row list when video
    // tiles are overflowing — if the video section is crowded, the audio rows
    // below it are certainly off-screen too, so speakers should float up there.
    const audioOnlyParticipants = isVideoOverflowing
        ? (() => {
            const local = audioOnlyParticipantsBaseFiltered.filter(p => p.identity === localParticipant?.identity);
            const remote = audioOnlyParticipantsBaseFiltered.filter(p => p.identity !== localParticipant?.identity);
            return [...local, ...applyPromotion(remote)];
        })()
        : audioOnlyParticipantsBaseFiltered;

    const anyVideo = videoParticipantIds.size > 0;

    // Keep refs current so the polling interval never has stale values.
    // Invalidate the cached normal-height when the participant count changes
    // so we don't use a height measured for a different number of cards.
    if (audioOnlyCountRef.current !== audioOnlyParticipants.length) {
        audioOnlyNormalHeight.current = 0;
    }
    audioOnlyCountRef.current = audioOnlyParticipants.length;
    anyVideoRef.current = anyVideo;

    // Audio-only is always rendered OUTSIDE the scroll container (in both compact and
    // normal modes). This means el.scrollHeight = video tiles only, and
    // el.parentElement.clientHeight = the outer div height, which never changes when
    // we switch between compact/normal. No feedback loop is possible.
    //
    // Formula:   compact = V + normalH > parentH - controlBarH
    // where V = el.scrollHeight (video content), parentH is constant for a given
    // window size, and normalH is the cached/estimated audio-only normal section height.
    // Keep noRinging accessible inside the interval without adding it to deps.
    // noRinging is constant for the lifetime of a call (huddle vs DM/group call
    // never switches mid-call), so a ref is the right tool here.
    const noRingingRef = React.useRef(noRinging);
    noRingingRef.current = noRinging;

    React.useEffect(() => {
        const check = () => {
            const el = scrollContainerRef.current;
            if (!el) return;

            // No audio-only participants → always show normal (nothing to strip)
            if (!anyVideoRef.current || audioOnlyCountRef.current === 0) {
                setIsScrollable(false);
                return;
            }

            // In noRinging (huddle / voice-channel) mode the SidebarConference lives
            // inside a portal with no intrinsic height, so parentH = 0 and the
            // overflow test always fires false-positively, locking isScrollable=true
            // and hiding the participant row list. The compact audio strip is also
            // meaningless here — video tiles are portaled to #call-video-root so
            // there's nothing in the scroll area to overflow. Always keep rows visible.
            //
            // In DM / group call mode (noRinging=false) the same false-positive occurs:
            // #call-sidebar-root has overflow-y:auto so el.parentElement.clientHeight
            // equals the full content height, making V + normalH > parentH - controlBarH
            // always true (i.e. 0 > -96). The container already scrolls to handle
            // overflow — the compact strip is not needed and should not be shown.
            if (noRingingRef.current || !noRingingRef.current) {
                setIsScrollable(false);
                return;
            }

            // Cache normal section height while it's in the DOM
            const nm = audioOnlyNormalRef.current?.offsetHeight;
            if (nm) audioOnlyNormalHeight.current = nm;

            // Estimate height from participant count when not yet measured
            const normalH = audioOnlyNormalHeight.current > 0
                ? audioOnlyNormalHeight.current
                : Math.ceil(audioOnlyCountRef.current /
                    Math.max(1, Math.floor(el.clientWidth / 112))) * 112 + 16;

            // parentH never changes due to mode switches — it's the outer flex-1 div
            const parentH = el.parentElement?.clientHeight ?? 0;
            if (!parentH) return;

            const controlBarH = controlBarRef.current?.offsetHeight ?? 96;
            // Measure video tiles only — independent of whether audio-only is inside scroll container
            const V = videoTilesRef.current?.scrollHeight ?? el.scrollHeight;
            const BUFFER = 40;

            setIsScrollable(prev => {
                const wouldOverflow = V + normalH > parentH - controlBarH;
                const hasRoom = V + normalH <= parentH - controlBarH - BUFFER;
                return prev ? !hasRoom : wouldOverflow;
            });
        };

        // Was setInterval(check, 200) — five wakeups a second for the entire
        // life of every call. It could never change anything: `isScrollable`
        // starts false and EVERY branch above sets it false (the noRinging
        // test is `x || !x`, always true), so the measuring code below it is
        // unreachable and the compact strip never shows. Keeping the timer
        // only scheduled a no-op React state dispatch 5x/s while the call
        // pane was mounted. One call on mount preserves the exact behaviour
        // (and the resize listener stays, so a real relayout still re-runs it)
        // without the standing wakeup competing with the join transition.
        check();
        window.addEventListener('resize', check);
        return () => {
            window.removeEventListener('resize', check);
        };
    }, []); // stable — reads only from refs and DOM

    // Sentinel-based overflow detection (speaker promotion gate).
    // Re-runs whenever anyVideo flips (sentinel mounts/unmounts).
    React.useEffect(() => {
        const sentinel = videoBottomSentinelRef.current;
        if (!sentinel) {
            setIsVideoOverflowing(false);
            return;
        }
        // Only enable overflow — never auto-clear it to avoid oscillation
        // (promotion moves tiles up → sentinel comes into view → would clear
        // overflow → tiles shuffle back → sentinel leaves → repeat).
        const obs = new IntersectionObserver(
            ([entry]) => { if (!entry.isIntersecting) setIsVideoOverflowing(true); },
            { threshold: 0 }
        );
        obs.observe(sentinel);
        return () => obs.disconnect();
    }, [anyVideo]); // eslint-disable-line react-hooks/exhaustive-deps

    // Clear overflow only when the video participant count drops and the sentinel
    // is actually back in view — safe to do without risking oscillation because
    // the sentinel moves up when a tile is removed, not when promotion reshuffles.
    React.useEffect(() => {
        const curr = visibleRemoteCamParticipants.length;
        if (curr < prevCamCountRef.current && isVideoOverflowingRef.current) {
            const sentinel = videoBottomSentinelRef.current;
            if (!sentinel) { setIsVideoOverflowing(false); prevCamCountRef.current = curr; return; }
            requestAnimationFrame(() => {
                const rect = sentinel.getBoundingClientRect();
                // 24px buffer — don't re-enable the feature on the very next frame
                if (rect.bottom <= window.innerHeight + 24) setIsVideoOverflowing(false);
            });
        }
        prevCamCountRef.current = curr;
    }, [visibleRemoteCamParticipants.length]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Solo inactivity kick ──────────────────────────────────────────────────
    // If the local user is alone in the call for 15 minutes, show a countdown
    // dialog and then leave automatically.
    //
    // This is DELIBERATELY redundant with the server's own solo-kick timer
    // (CallsService's reaper, apps/api/src/calls/calls.service.ts): the server
    // round-trips through a 60s poll + LiveKit calls, so it lags this local
    // timer by anywhere from a few seconds to ~2 minutes, AND it depends on
    // Redis (CallsService.soloGet/soloSet) — if Redis is unreachable the
    // server-side solo tracker resets every poll and never fires at all. So
    // this local timer stays the primary, always-available trigger. The rare
    // case where the server's poll happens to land first (soloSince stamped
    // right at the true solo instant + reap cycle crosses 900s just ahead of
    // this timer's own +10s countdown) is handled via onInactivityWarning:
    // it tells Dashboard a same-session `call:solo_kick` is the server
    // catching up on a kick the client already owns, not a second real one,
    // so Dashboard skips the duplicate SoloKickDialog (see its soloKickEvent
    // effect).
    const [inactivityCountdown, setInactivityCountdown] = React.useState<number | null>(null);

    const remoteParticipantCount = participants.filter(
        p => p.identity !== localParticipant?.identity
    ).length;

    // Start / reset the 15-min timer whenever the remote count changes
    React.useEffect(() => {
        if (remoteParticipantCount > 0) {
            // Someone is in the call — cancel any active countdown too
            setInactivityCountdown(null);
            onInactivityWarning?.(false);
            return;
        }
        const timer = setTimeout(() => {
            setInactivityCountdown(10);
            onInactivityWarning?.(true);
        }, 15 * 60 * 1000);
        return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [remoteParticipantCount]);

    // Tick the countdown down every second; leave at 0
    React.useEffect(() => {
        if (inactivityCountdown === null) return;
        if (inactivityCountdown <= 0) { handleLeave(); return; }
        const tick = setTimeout(() => setInactivityCountdown(c => (c ?? 1) - 1), 1000);
        return () => clearTimeout(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inactivityCountdown]);

    const handleLeave = () => {
        const wasLastPerson = participants.length <= 1;
        // P2-REND-5: route through playSound so notification prefs are respected.
        // Remaining participants hear it via CallAudioEffects' participant-count
        // decreased path; this ensures the leaver hears it too.
        playSound('leave', soundsPrefs());
        // The actual teardown must FEEL instant: no awaited round-trips here.
        // The end-call notification is fire-and-forget — the server tolerates
        // it arriving after our LiveKit disconnect.
        //
        // NOT for huddle calls: sessionId there is a huddle_calls.call_id, which
        // has no row in call_sessions — this POST unconditionally 404'd for every
        // huddle call ended this way. Huddle teardown-when-empty already happens
        // correctly via HuddlesService.leaveCall, triggered separately through
        // onLeave below (Dashboard's handleDisconnectCall → handleLeaveHuddleCall).
        if (wasLastPerson && sessionId && !isHuddle) {
            axios.post(`${API_BASE}/calls/${sessionId}/end`, {}, {
                headers: { Authorization: `Bearer ${token}` }
            }).catch(e => console.error('Failed to end call', e));
        }
        onLeave(wasLastPerson);
    };

    const toggleMic = () => {
        if (!localParticipant) return;
        // P13: SPEAK gate — block UN-mute when the user lacks SPEAK on this
        // channel. Mute is always allowed (you can always go quiet). LiveKit
        // also enforces, but the UI should never even attempt the publish.
        if (!localParticipant.isMicrophoneEnabled && !canSpeak) return;
        const willEnable = !localParticipant.isMicrophoneEnabled;
        // Unhandled-rejection fix: setMicrophoneEnabled is a promise (device
        // busy/permission revoked can reject it) and the button's on/off state
        // reads straight off localParticipant.isMicrophoneEnabled, so a
        // rejected call left the button looking like the click did nothing —
        // no visible error, no state change, prompting a re-click. Matches
        // the .catch already on setCameraEnabled below.
        localParticipant.setMicrophoneEnabled(willEnable).catch(() => {});
        playSound(willEnable ? 'unmute' : 'mute', soundsPrefs());
    };
    const toggleCamera = () => {
        if (!localParticipant) return;
        const willEnable = !localParticipant.isCameraEnabled;
        // P13: VIDEO gate — block enable when denied; allow disable.
        if (willEnable && !canVideo) return;
        if (willEnable) setIsCameraEnabling(true);
        localParticipant.setCameraEnabled(willEnable).catch(() => {});
        // NOT playSound here, unlike toggleMic above: camera_on/camera_off is
        // bilateral (the whole call should hear it, not just the person who
        // toggled), and CallPane's CallAudioEffects already plays it for
        // EVERY participant — including this one, via LiveKit's Local*
        // event variants — by listening on the Room itself rather than the
        // click handler. Calling playSound here too would double-fire it for
        // the local user. Mute/unmute stays a direct call above because it is
        // deliberately local-only — see CallAudioEffects' onTrackMuted.
    };

    const toggleScreenshare = () => {
        if (!localParticipant) return;
        if (localParticipant.isScreenShareEnabled) {
            stopNativeWindowAudio();
            localParticipant.setScreenShareEnabled(false);
            currentShareRef.current = null;
            setCurrentShare(null);
        } else {
            // P13: SCREEN_SHARE gate — don't even open the picker if the user
            // can't ultimately publish.
            if (!canScreenShare) return;
            setIsScreenSharePickerOpen(true);
        }
    };

    // Open the picker while the current share is still running (change source / quality mid-share).
    // handleScreenShareSelect will call setScreenShareEnabled(true, ...) which replaces the live track.
    const openScreenSharePicker = () => {
        setIsScreenSharePickerOpen(true);
    };

    // Apply new quality settings to the running share without re-picking a source.
    // Read source/audio from currentShareRef (pendingScreenShareRef gets nulled after
    // the getDisplayMedia handshake, so it's not usable for mid-share operations).
    // We must FULLY stop the existing share before re-enabling — setScreenShareEnabled
    // (true) no-ops when already enabled, so it'd silently ignore the new options.
    // Toggle share audio on/off without re-picking a source. Republishes the same
    // sourceId with the opposite audio flag.
    const toggleScreenShareAudio = async () => {
        if (!localParticipant || !currentShareRef.current) return;
        const cur = currentShareRef.current;
        await handleScreenShareSelect({
            sourceId:   cur.sourceId,
            resolution: cur.resolution,
            frameRate:  cur.frameRate,
            audio:      !cur.audio,
        });
    };

    const adjustScreenShareQuality = async (
        resolution: ScreenShareOptions['resolution'],
        frameRate: ScreenShareOptions['frameRate'],
    ) => {
        if (!localParticipant || !currentShareRef.current) {
            console.warn('[ScreenShare] adjustScreenShareQuality: no active share to adjust');
            return;
        }
        const current = currentShareRef.current;
        // No-op guard: LiveKit will silently skip a re-publish if constraints look
        // identical. Logging lets us confirm chip clicks reach here with new values.
        if (current.resolution === resolution && current.frameRate === frameRate) {
            console.info('[ScreenShare] adjustScreenShareQuality: no change', { resolution, frameRate });
            return;
        }
        console.info('[ScreenShare] adjusting quality', {
            from: { resolution: current.resolution, frameRate: current.frameRate },
            to:   { resolution, frameRate },
        });

        // ── In-place retune: no unpublish, no re-acquire, no renegotiation ──
        // A quality change keeps the SAME capture source, so there is nothing to
        // re-acquire. The old path funnelled into handleScreenShareSelect, which
        // tore the share down (stopNativeWindowAudio → unpublish video →
        // unpublish share-audio → setScreenShareEnabled(false) → 50ms settle) and
        // then re-ran the whole getDisplayMedia + publish handshake — four
        // sequential SFU renegotiations and a fresh OS capture, which is exactly
        // the "share stops and stays stopped for a while" the user reported.
        //
        // Both knobs can be retargeted on the LIVE track instead:
        //   • capture side — applyConstraints() on the MediaStreamTrack retargets
        //     the display capturer's scale/rate with no new handshake.
        //   • encoder side — applyScreenShareSenderParams() is already idempotent
        //     and re-appliable by design (see its doc comment), and is what
        //     actually governs maxFramerate/maxBitrate.
        // Neither touches the RTCRtpSender's track identity, so subscribers keep
        // the same publication and never see a drop.
        //
        // Audio is untouched here by construction, so none of the native-WASAPI
        // teardown ordering that the republish path has to worry about applies.
        const ssPub = localParticipant.getTrackPublication(Track.Source.ScreenShare);
        if (await retuneScreenShareInPlace(ssPub?.track, resolution, frameRate)) {
            const retuned: ScreenShareOptions = {
                sourceId:   current.sourceId,
                resolution,
                frameRate,
                audio:      current.audio,
            };
            currentShareRef.current = retuned;
            setCurrentShare(retuned);
            return;
        }

        await handleScreenShareSelect({
            sourceId:   current.sourceId,
            resolution,
            frameRate,
            audio:      current.audio,
        });
    };

    /**
     * Swap a live screen share onto a new capture source WITHOUT republishing.
     *
     * Acquire-then-replace: the new capture is obtained while the old one is
     * still publishing, then swapped onto the existing RTCRtpSender with
     * LiveKit's replaceTrack(). No unpublish, no SDP renegotiation, no change of
     * publication SID — subscribers keep decoding the same stream, so the share
     * never visibly drops.
     *
     * Returns true if the swap completed and the caller should stop. Returns
     * false (having changed nothing observable) if the fast path doesn't apply,
     * so the caller can fall back to the original stop-then-republish sequence.
     */
    const tryHotSwapScreenShare = async (
        options: ScreenShareOptions,
        useNativeAudio: boolean,
        nativeMode: 'window' | 'screen',
        tStart: number,
    ): Promise<boolean> => {
        if (!localParticipant) return false;
        const ssPub = localParticipant.getTrackPublication(Track.Source.ScreenShare);
        const lkTrack = ssPub?.track as (LocalVideoTrack & { sender?: RTCRtpSender }) | undefined;
        const oldMs = lkTrack?.mediaStreamTrack;
        if (!lkTrack || !oldMs || oldMs.readyState !== 'live') return false;
        if (typeof lkTrack.replaceTrack !== 'function' || !lkTrack.sender) return false;

        const dims = resolveSSResolution(options.resolution);
        let newMs: MediaStreamTrack | undefined;
        // Held outside the try so the catch can still reach the underlying
        // request after Promise.race has abandoned it (see the timeout note).
        let mediaPromise: Promise<MediaStream> | undefined;
        // Flips once the new capture is actually on the sender. Past that point
        // the share is LIVE on the new source, so a later failure must not stop
        // the track or report failure — the fallback would tear down a working
        // share to rebuild the same thing.
        let swapped = false;
        try {
            // Drive Electron's setDisplayMediaRequestHandler exactly the way
            // LiveKit does internally: park the choice on the pending ref, then
            // request. onShowScreensharePicker reads it and resolves the source.
            // audio:false unconditionally — this path is only entered when audio
            // is either off or handled out-of-band by the native addon.
            pendingScreenShareRef.current = { ...options, audio: false };
            mediaPromise = navigator.mediaDevices.getDisplayMedia({
                video: {
                    width:     { max: dims.width },
                    height:    { max: dims.height },
                    frameRate: { max: options.frameRate },
                },
                audio: false,
            });
            const stream = await Promise.race([
                mediaPromise,
                // The handshake needs main-process cooperation; if the handler
                // never fires we must not hang the UI holding a live share.
                // Losing the race does NOT cancel the request, so the catch
                // stops whatever it eventually yields — otherwise a late
                // resolve leaves an unowned capture running, which keeps the
                // OS "you are sharing" indicator lit with nothing behind it.
                new Promise<never>((_, rej) =>
                    setTimeout(() => rej(new Error('getDisplayMedia handshake timed out')), 10_000)),
            ]);
            newMs = stream.getVideoTracks()[0];
            if (!newMs) throw new Error('getDisplayMedia returned no video track');
            // Set at CAPTURE time, not after the swap: WebRTC reads contentHint
            // when it configures the encoder, so applying it later leaves the
            // opening seconds on the still-image profile.
            newMs.contentHint = 'motion';
            const tAcquired = performance.now();

            // replaceTrack() awaits onSenderTrackSwapped() internally (verified
            // against livekit-client 2.18.8), so once this resolves LiveKit has
            // already recomputed the sender encodings — which is why the
            // override below has to come after it, not before.
            await lkTrack.replaceTrack(newMs, { userProvidedTrack: true });
            const tSwapped = performance.now();
            swapped = true;

            // replaceTrack() only detaches and unhooks the old track — it does
            // NOT stop it. Left running it keeps the OS "you are sharing"
            // indicator lit and keeps burning capture CPU on a source nobody
            // receives any more.
            try { oldMs.stop(); } catch { /* already gone */ }

            // Re-assert our encoder overrides: LocalVideoTrack.onSenderTrackSwapped
            // recomputes sender encodings as part of replaceTrack, which would
            // otherwise revert maxFramerate/maxBitrate to LiveKit's defaults.
            try {
                await applyScreenShareSenderParams(
                    lkTrack.sender, options.frameRate,
                    computeSSBitrate(options.resolution, options.frameRate, asScreenShareCodec(lkTrack.codec)),
                );
            } catch (err) {
                console.warn('[ScreenShare] hot-swap: setParameters override failed:', err);
            }

            // Audio last — it is a separate publication, so it can catch up
            // without ever holding up the video swap. The old capture was bound
            // to the previous source's process, so it always has to be restarted.
            await stopNativeWindowAudio();
            if (useNativeAudio) {
                try {
                    await startNativeWindowAudio(nativeMode, options.sourceId);
                } catch (err) {
                    console.error('[ScreenShare] hot-swap: startNativeWindowAudio threw:', err);
                    setScreenShareNotice({
                        tone: 'warn',
                        text: 'Screen share is active but audio capture failed. Video is still being shared.',
                    });
                }
            }

            const recorded: ScreenShareOptions = {
                sourceId:   options.sourceId,
                resolution: options.resolution,
                frameRate:  options.frameRate,
                audio:      options.audio,
            };
            currentShareRef.current = recorded;
            setCurrentShare(recorded);

            console.info(
                `[ScreenShare] hot-swapped source in ${(performance.now() - tStart).toFixed(0)}ms ` +
                `(acquire ${(tAcquired - tStart).toFixed(0)}ms, ` +
                `replaceTrack ${(tSwapped - tAcquired).toFixed(0)}ms, ` +
                `audio ${(performance.now() - tSwapped).toFixed(0)}ms) — no republish`
            );
            return true;
        } catch (err) {
            if (swapped) {
                // Past the point of no return: video IS live on the new source
                // and only the tail (audio restart / bookkeeping) failed.
                // Falling back would stop a working share to republish the same
                // source, so report success and let the state effects settle.
                console.warn('[ScreenShare] hot-swap completed but its tail failed:', err);
                return true;
            }
            console.warn('[ScreenShare] hot-swap failed, falling back to republish:', err);
            // Don't leak a capture we acquired but never swapped in — including
            // one from a getDisplayMedia that resolves AFTER we stopped waiting.
            try { newMs?.stop(); } catch { /* nothing to clean up */ }
            void mediaPromise
                ?.then(s => s.getTracks().forEach(t => { try { t.stop(); } catch { /* gone */ } }))
                .catch(() => { /* the request itself failed; nothing to release */ });
            pendingScreenShareRef.current = null;
            return false;
        }
    };

    const handleScreenShareSelect = async (options: ScreenShareOptions | null) => {
        setIsScreenSharePickerOpen(false);
        if (!options || !localParticipant) {
            window.electronAPI?.resolveDesktopSource(null);
            return;
        }

        const tStart = performance.now();
        const since = (t: number) => (performance.now() - t).toFixed(0);

        // ALL share types with audio route through the native WASAPI addon so we
        // can exclude Cipherline's own process tree from capture — otherwise the
        // call's outgoing audio is fed back into the share and every participant
        // hears themselves. Two modes:
        //   window:  INCLUDE on the shared app's root process tree (per-app audio)
        //   screen:  EXCLUDE on Cipherline's own tree (all system audio minus us)
        //
        // Resolved BEFORE any teardown because the hot-swap path below needs to
        // know whether audio will be handled out-of-band (native) or has to come
        // from the same getDisplayMedia stream as the video (Chromium loopback).
        const isWindowSource = options.sourceId.startsWith('window:');
        const nativeMode: 'window' | 'screen' = isWindowSource ? 'window' : 'screen';
        // Re-probe the native-audio capability inline rather than trusting the
        // mount-time state alone. The mount probe can resolve false transiently
        // if the IPC handler wasn't registered yet (e.g. main.ts hot-reload
        // ordering in dev), and we'd then be stuck on the fallback path for the
        // rest of the session. One tiny IPC round-trip per share fixes that.
        let nativeReady = nativeAudioSupported;
        if (options.audio && !nativeReady && window.electronAPI?.isAudioCaptureSupported) {
            try { nativeReady = await window.electronAPI.isAudioCaptureSupported(); } catch { nativeReady = false; }
            if (nativeReady) setNativeAudioSupported(true);  // cache for next time
        }
        const useNativeAudio = options.audio && nativeReady;

        // ── Fast path: hot-swap the capture instead of republishing ───────────
        // Changing SOURCE mid-share used to stop the share outright and rebuild
        // it (unpublish → setScreenShareEnabled(false) → 50ms settle → fresh
        // getDisplayMedia → publish), which is several SFU renegotiations plus a
        // cold OS capture — the visible multi-second gap in the report.
        //
        // acquire-then-replace inverts that: get the NEW capture first, then
        // swap it onto the EXISTING RTCRtpSender via LiveKit's replaceTrack().
        // That is a sender-level track swap with no renegotiation and no change
        // of publication SID, so subscribers keep decoding the same stream and
        // never see it drop.
        //
        // Deliberately NOT attempted when Chromium loopback audio is in play
        // (options.audio && !nativeReady): that audio track is produced by the
        // same getDisplayMedia call as the video, so it cannot be re-established
        // by a video-only acquire. Native audio is a separate publication and is
        // restarted around the swap, exactly as the republish path does it.
        //
        // The same applies to a loopback publication that is ALREADY live, which
        // the options-based test above cannot see: it asks whether the NEW share
        // wants Chromium audio, never whether the CURRENT one still has a live
        // loopback track. stopNativeWindowAudio() inside the hot swap unpublishes
        // only the native WASAPI publication it owns via nativeAudioPubRef, so a
        // loopback track would survive the swap. That made "Disable Audio"
        // (options.audio === false, hence the old guard always true) silently do
        // nothing, and changing source with audio off keep transmitting system
        // audio from a source no longer being shared. Identified by ownership
        // rather than by platform: anything under ScreenShareAudio that is not
        // the native publication came from getDisplayMedia and only the
        // republish path below can tear it down.
        const liveSsAudioPub = localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
        const hasLoopbackAudioPublished =
            !!liveSsAudioPub?.track && liveSsAudioPub.track !== nativeAudioPubRef.current?.track;
        if (
            localParticipant.isScreenShareEnabled
            && !(options.audio && !nativeReady)
            && !hasLoopbackAudioPublished
        ) {
            const swapped = await tryHotSwapScreenShare(options, useNativeAudio, nativeMode, tStart);
            if (swapped) return;
        }

        // If we're republishing an existing share (Change Source / Adjust
        // Quality / toggle audio), broadcast an "adjusting" marker so remote
        // clients suppress the start/stop sound cues around the brief gap.
        // The marker is a short-lived flag (auto-expires on the receiver side)
        // — no explicit "adjustment done" message needed.
        //
        // LiveKit does NOT echo a participant's own data packets back to
        // themselves, so a plain DataReceived listener would miss the sharer's
        // own marker. A window event mirrors the signal for the local page too.
        const isAdjustment = localParticipant.isScreenShareEnabled;
        if (isAdjustment) {
            window.dispatchEvent(new CustomEvent('cipherline:ss-adjust', {
                detail: { identity: localParticipant.identity },
            }));
            if (room) {
                try {
                    const payload = new TextEncoder().encode(JSON.stringify({ type: 'ss-adjust' }));
                    await room.localParticipant.publishData(payload, { reliable: true, topic: 'ss-adjust' });
                } catch (err) {
                    console.warn('[ScreenShare] failed to broadcast adjust marker', err);
                }
            }
        }

        // If a share is already running (Change Source, Adjust Quality, toggle
        // audio), stop it first. setScreenShareEnabled(true, ...) is a no-op when
        // already enabled, so without this the picker would silently have no effect.
        //
        // Order matters: native audio owns the ScreenShareAudio publication (it's
        // the same Track.Source that LiveKit's own audio would claim), so we must
        // AWAIT stopNativeWindowAudio() fully before touching publications or
        // calling setScreenShareEnabled(false) — otherwise the native teardown
        // races with LiveKit's unpublish and leaves the native addon in a bad
        // state that the next startNativeWindowAudio() can't recover from.
        if (localParticipant.isScreenShareEnabled) {
            const tTeardown = performance.now();
            await stopNativeWindowAudio();
            const tAudioStopped = performance.now();
            try {
                // Explicitly unpublish the VIDEO screenshare track —
                // setScreenShareEnabled(false) alone can leave LiveKit's internal
                // "enabled" state lagging and the follow-up setScreenShareEnabled(true)
                // would then no-op.
                const ssPub = localParticipant.getTrackPublication(Track.Source.ScreenShare);
                if (ssPub?.track) await localParticipant.unpublishTrack(ssPub.track, true);
                // Also unpublish any leftover ScreenShareAudio — this is the
                // Chromium-getDisplayMedia loopback-audio track, published by
                // LiveKit's createScreenTracks() alongside the video when the
                // DisplayMedia callback includes audio. isScreenShareEnabled is
                // keyed off the VIDEO publication only (Participant.d.ts:81), so
                // after we unpublished the video above the subsequent
                // setScreenShareEnabled(false) would short-circuit and leave this
                // audio track orphaned — so "Disable Audio" would never stop sound.
                // stopNativeWindowAudio() was already awaited, so on the native
                // path this returns undefined (no-op). No race.
                const ssAudioPub = localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
                if (ssAudioPub?.track) await localParticipant.unpublishTrack(ssAudioPub.track, true);
                await localParticipant.setScreenShareEnabled(false);
            } catch (err) {
                console.warn('[ScreenShare] stop-before-swap failed:', err);
            }
            currentShareRef.current = null;
            setCurrentShare(null);
            // Yield a tick so LiveKit's internal publication state settles before we
            // call setScreenShareEnabled(true) again — otherwise it can see the old
            // track still "enabled" and silently skip the new publish.
            await new Promise(r => setTimeout(r, 50));
            // This teardown is the visible gap: from here until the new track is
            // publishing, remote participants see nothing. Logged per-stage so a
            // future "screen share is slow" report can be attributed instead of
            // re-derived — native-audio stop and the unpublish/renegotiate round
            // trips are separately visible.
            console.info(
                `[ScreenShare] republish teardown took ${since(tTeardown)}ms ` +
                `(native audio stop ${(tAudioStopped - tTeardown).toFixed(0)}ms, ` +
                `unpublish+settle ${since(tAudioStopped)}ms)`
            );
        }

        const dims = resolveSSResolution(options.resolution);
        // Codec: the user's Settings → Advanced override, else whatever this
        // machine can encode in HARDWARE (see decideScreenShareCodec). The
        // probe is a local capability query (a few ms, no network).
        //
        // Probed even when a codec is forced: it is a few local queries, and
        // the stream-stats overlay shows the answer, which is what makes an
        // A/B against a forced codec readable. The main-process diagnostics
        // (GPU vendors — needed for the NVIDIA rule in decideScreenShareCodec —
        // plus captured display Hz and capturer) are time-boxed so a slow IPC
        // can never hold up the share; without them the decision just loses
        // the NVIDIA refinement.
        const codecPref = getScreenShareCodecPref();
        // Not raced away: if main answers after the 750 ms cut-off, the
        // overlay still gets it (patched in below) — only the codec decision
        // goes without it.
        const mainDiagPromise: Promise<ReturnType<typeof parseMainDiagnostics>> =
            window.electronAPI?.getScreenShareDiagnostics?.(options.sourceId)
                .then(parseMainDiagnostics)
                .catch(() => null) ?? Promise.resolve(null);
        const [hwEncoders, mainDiag] = await Promise.all([
            probeHardwareEncoders(dims.width, dims.height, options.frameRate),
            Promise.race([
                mainDiagPromise,
                new Promise<null>(res => setTimeout(() => res(null), 750)),
            ]),
        ]);
        const decision = decideScreenShareCodec(codecPref, hwEncoders, mainDiag?.gpus, { h264HighFailed: hasH264HighFailed() });
        const codec = decision.codec;
        const h264High = codec === 'h264' && decision.h264Profile === 'high';
        wantH264HighRef.current = h264High;
        // Ask the capturer for headroom above the send rate (see
        // captureFrameRateFor); the encoder's maxFramerate stays at the target.
        const captureFps = captureFrameRateFor(options.frameRate);
        setScreenShareSession({
            sourceId: options.sourceId,
            requestedFps: options.frameRate,
            captureFps,
            codecPref,
            codec,
            h264Profile: codec === 'h264' ? (decision.h264Profile ?? 'cb') : undefined,
            codecReason: decision.reason,
            hw: hwEncoders,
            main: mainDiag,
        });
        if (!mainDiag) {
            void mainDiagPromise.then(late => {
                if (late) updateScreenShareSession(options.sourceId, { main: late });
            });
        }
        const publishOptions = buildScreenSharePublishOptions(options.resolution, options.frameRate, codec);
        const maxBitrate = publishOptions.screenShareEncoding.maxBitrate;
        console.info(
            `[ScreenShare] codec=${codec}${h264High ? ' (High)' : ''} (pref=${codecPref}, ${decision.reason}, hw=${hwEncoders ? JSON.stringify(hwEncoders) : 'n/a'}) ` +
            `maxBitrate=${Math.round(maxBitrate / 1e6)}Mbps maxFramerate=${options.frameRate} captureFps=${captureFps}` +
            (mainDiag
                ? ` source=${mainDiag.sourceKind} displayHz=${mainDiag.displayHz ?? '?'} capturer=${mainDiag.capturer.backend} (${mainDiag.capturer.why})` +
                  ` gpus=${mainDiag.gpus.map(g => g.vendor).join('+') || '?'} videoEncode=${mainDiag.videoEncode ?? '?'}`
                : ' (no main diagnostics)')
        );

        console.log(
            `[ScreenShare] handleScreenShareSelect: sourceId=${options.sourceId.slice(0, 30)}` +
            ` audio=${options.audio} nativeAudioSupported=${nativeAudioSupported}` +
            ` nativeReady=${nativeReady} useNativeAudio=${useNativeAudio}` +
            ` pendingAudio=${useNativeAudio ? false : options.audio}`
        );

        // Non-Windows / no-addon path trade-offs. These are enforced on the
        // Electron main side too (desktop-capturer-resolve chooses
        // loopbackWithMute vs undefined) — we mirror the decision here for
        // clarity and to drive the user-facing notice.
        const fallbackWindowAudioUnsupported =
            options.audio && !nativeReady && isWindowSource;
        const fallbackFullScreenAudioMuted =
            options.audio && !nativeReady && !isWindowSource;

        if (options.audio && !nativeReady) {
            console.warn('[ScreenShare] Native audio capture addon not available — falling back to Chromium getDisplayMedia loopback.',
                isWindowSource
                    ? 'Per-window audio is NOT supported on this path; share will be silent.'
                    : 'Full-screen audio will use loopbackWithMute (Cipherline output will be muted locally while sharing).');
        }
        if (fallbackWindowAudioUnsupported) {
            setScreenShareNotice({
                tone: 'warn',
                text: 'Per-window audio sharing requires Windows. Sharing this window without audio.',
            });
        } else if (fallbackFullScreenAudioMuted) {
            setScreenShareNotice({
                tone: 'info',
                text: 'Sharing all system audio. Cipherline\'s own output will be muted locally while sharing to prevent echo.',
            });
        }

        // Always tell Electron's displayMedia handler to use video-only when we're
        // handling audio natively, so we don't stack Electron's 'loopback' stream
        // on top of the native capture.
        pendingScreenShareRef.current = {
            ...options,
            audio: useNativeAudio ? false : options.audio,
        };

        const tPublish = performance.now();
        try {
            await localParticipant.setScreenShareEnabled(true, {
                resolution: {
                    width: dims.width,
                    height: dims.height,
                    frameRate: captureFps,
                },
                audio: useNativeAudio ? false : options.audio,
                // Set at CAPTURE time, not after publishing. WebRTC reads
                // contentHint when it first configures the encoder, so applying
                // it post-publish (which we also still do defensively below)
                // leaves the opening seconds encoded as 'detail' — the
                // still-image profile that trades frame rate for sharpness,
                // exactly backwards for the motion content 90 fps exists for.
                contentHint: 'motion',
            },
                // Everything the SENDER needs, handed to LiveKit up front so its own
                // stored encoding is ours (see buildScreenSharePublishOptions):
                // one full-res layer, the chosen codec, maxFramerate = the
                // requested rate, a generous bitrate ceiling, maintain-framerate.
                //
                // Codec history: this was hard-wired VP9 for "best quality per
                // bit". VP9 is also the codec with no hardware encoder on NVIDIA
                // or AMD, and LiveKit forces it to L1T3 for screen shares — so on
                // most gaming PCs every share was libvpx VP9 in software, the
                // single largest reason 90 fps never materialised. The old note
                // that "H.264 HW encoders fall back to SW at 4K90" may well still
                // hold on some GPUs; that is why the codec is now chosen per
                // machine, overridable, and visible (encoder + HW/SW) in the
                // stream-stats overlay rather than assumed.
                publishOptions,
            );
        } catch (err) {
            console.warn('Screen share failed or cancelled:', err);
            pendingScreenShareRef.current = null;
            return;
        }
        // acquire (OS capture + the Electron resolve handshake) and the publish
        // renegotiation are the two costs here; they are reported together
        // because setScreenShareEnabled owns both internally.
        console.info(
            `[ScreenShare] acquire+publish took ${since(tPublish)}ms; ` +
            `total ${since(tStart)}ms from selection`
        );
        updateScreenShareSession(options.sourceId, { startedAt: performance.now() });

        // H.264 High has no software encoder in Chromium: if the hardware one
        // does not start, the share would sit at 0 fps. Watch the first
        // seconds and, if nothing was encoded, republish the same source as
        // VP8 (never unencrypted — it is an ordinary E2EE republish).
        if (h264High) {
            const ssSender = (localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track as
                { sender?: RTCRtpSender } | undefined)?.sender;
            if (ssSender) {
                void watchH264HighStart(() => ssSender.getStats()).then(result => {
                    console.info(`[ScreenShare] H.264 High start check: ${result}`);
                    if (result !== 'failed') return;
                    const cur = currentShareRef.current;
                    if (!cur || cur.sourceId !== options.sourceId) return; // share changed meanwhile
                    markH264HighFailed();
                    console.warn('[ScreenShare] H.264 High hardware encoder produced no frames — republishing without it');
                    setScreenShareNotice({
                        tone: 'warn',
                        text: 'The GPU’s H.264 encoder did not start. Restarting the share with the software encoder.',
                    });
                    republishShareRef.current?.({ ...cur });
                });
            }
        }

        // Post-publish RTP override: setScreenShareEnabled's resolution option only
        // threads frameRate through getDisplayMedia constraints — it does NOT set the
        // sender's maxFramerate / maxBitrate encoding params. Without this block, the
        // "high" (60fps) preset would renegotiate down to ~15fps at the default bitrate.
        // This mirrors the working pattern from CustomConference.tsx lines 111–146.
        try {
            const ssPub = localParticipant.getTrackPublication(Track.Source.ScreenShare);
            // Screenshares are always tuned for motion (games, video, animated UIs).
            // contentHint='motion' enables VP9 inter-frame prediction and
            // degradationPreference='maintain-framerate' tells the sender to drop
            // RESOLUTION (not framerate) under congestion. The old 'detail' +
            // 'maintain-resolution' combo caused games to render at 6 fps while
            // maintaining a crisp 1080p — exactly backwards for any moving content.
            const ssMsTrack = ssPub?.track?.mediaStreamTrack;
            if (ssMsTrack) {
                (ssMsTrack as any).contentHint = 'motion';
            }
            const sender = (ssPub?.track as { sender?: RTCRtpSender } | undefined)?.sender;
            if (sender) {
                await applyScreenShareSenderParams(sender, options.frameRate, maxBitrate);
            } else {
                console.warn('[ScreenShare] RTP sender not available — framerate override skipped');
            }
        } catch (err) {
            console.warn('[ScreenShare] setParameters override failed:', err);
        }

        // ── Frame-rate diagnostics ────────────────────────────────────────────
        // "90 fps doesn't actually give 90" has four possible causes and they
        // need completely different fixes, so measure instead of guessing:
        //
        //   capture-bound   actual ≈ display refresh, limitation 'none'
        //                   → the monitor can't produce more frames. Nothing
        //                     downstream can fix it.
        //   cpu-bound       limitation 'cpu' → the encoder can't keep up
        //                     (VP9 software encode at high resolution).
        //   bandwidth-bound limitation 'bandwidth' → GCC is starving it; with
        //                     maintain-framerate this should shrink resolution
        //                     rather than frame rate, so seeing fps drop here
        //                     means the bitrate cap is too low.
        //   throttled       capture below the request with limitation 'none' →
        //                     Chromium's capture CPU cap: next grab no sooner
        //                     than 2 × the last grab's duration, hard-coded
        //                     in Chromium 150 (no switch lifts it — see
        //                     electron/capture-flags.ts). The stream-stats
        //                     overlay's "limited" row names it, and with
        //                     the capture timing log on, measures it.
        //
        // Sampled twice: 4s in (past the initial ramp) and 12s in (steady state).
        try {
            const ssPub = localParticipant.getTrackPublication(Track.Source.ScreenShare);
            const sender = (ssPub?.track as { sender?: RTCRtpSender } | undefined)?.sender;
            if (sender?.getStats) {
                const sample = async (label: string) => {
                    try {
                        const report = await sender.getStats();
                        report.forEach(raw => {
                            const s = raw as ScreenShareSendStats;
                            if (s.type !== 'outbound-rtp' || s.kind !== 'video') return;
                            console.log(
                                `[ScreenShare] ${label}: requested=${options.frameRate}fps ` +
                                `actual=${s.framesPerSecond ?? '?'}fps ` +
                                `${s.frameWidth ?? '?'}x${s.frameHeight ?? '?'} ` +
                                `limitedBy=${s.qualityLimitationReason ?? '?'} ` +
                                `encoder=${s.encoderImplementation ?? '?'} ` +
                                `bitrateCap=${Math.round(maxBitrate / 1000)}kbps`
                            );
                        });
                    } catch { /* track may have ended — diagnostics only */ }
                };
                setTimeout(() => void sample('4s'), 4000);
                setTimeout(() => void sample('12s'), 12000);
            }
        } catch { /* diagnostics must never break publishing */ }

        if (useNativeAudio) {
            try {
                await startNativeWindowAudio(nativeMode, options.sourceId);
            } catch (err) {
                console.error('[ScreenShare] startNativeWindowAudio threw unexpectedly:', err);
                setScreenShareNotice({
                    tone: 'warn',
                    text: 'Screen share is active but audio capture failed. Video is still being shared.',
                });
            }
        }

        // Record the active share so Change Source / Adjust Quality have the
        // sourceId + current quality long after the Electron handshake ref is nulled.
        const recorded: ScreenShareOptions = {
            sourceId:   options.sourceId,
            resolution: options.resolution,
            frameRate:  options.frameRate,
            audio:      options.audio,
        };
        currentShareRef.current = recorded;
        setCurrentShare(recorded);
    };
    React.useEffect(() => {
        republishShareRef.current = (o: ScreenShareOptions) => { void handleScreenShareSelect(o); };
    });

    const toggleDeafen = () => {
        if (!localParticipant) return;
        const newState = !isLocalDeafened;
        if (newState) {
            wasMutedBeforeDeafenRef.current = !localParticipant.isMicrophoneEnabled;
        }
        setLocalDeafened(newState);
        let meta: any = {};
        try { if (localParticipant.metadata) meta = JSON.parse(localParticipant.metadata); } catch {}
        meta.deafened = newState;
        // Same as the avatar sync above — swallow SignalRequestError timeouts.
        // Remote-participant deafened icon may be out of date for a few seconds
        // until the next toggle, but that's preferable to a console error spam.
        localParticipant.setMetadata(JSON.stringify(meta)).catch(() => { /* cosmetic */ });
        playSound(newState ? 'deafen' : 'undeafen', soundsPrefs());
    };

    React.useEffect(() => {
        if (!localParticipant) return;
        if (isLocalDeafened) {
            if (localParticipant.isMicrophoneEnabled) localParticipant.setMicrophoneEnabled(false);
        } else {
            if (!wasMutedBeforeDeafenRef.current && !localParticipant.isMicrophoneEnabled) {
                localParticipant.setMicrophoneEnabled(true);
            }
        }
    }, [isLocalDeafened, localParticipant]);

    // ── Voice processor (noise suppression, volume normalization, voice gate) ──
    // The processor itself is no longer owned here — it's created and attached
    // by CallPane's MicProcessorBridge the moment the mic publication exists
    // (see voiceProcessorManager.ts's doc comment for why: this component gets
    // unmounted and remounted mid-call whenever the call portal target moves,
    // e.g. navigating between servers, and destroying/rebuilding the processor
    // on every one of those remounts was a second source of "no NS" windows on
    // top of the join-time one). This effect's only remaining job is to push
    // live settings changes into whatever processor already exists.
    React.useEffect(() => {
        if (!voice) return;
        voiceProcessorManager.updateSettings(voice.settings);
    }, [
        voice?.settings.noiseSuppression,
        voice?.settings.volumeNormalization,
        voice?.settings.voiceGate,
        voice?.settings.voiceGateThreshold,
        voice?.settings.micVolume,
        voice?.settings.eqEnabled,
        // Stringify the bands array so React detects element-level changes
        JSON.stringify(voice?.settings.eqBands),
    ]);

    // Derive the mic track SID — still needed below by the mic-health watchdog
    // and RTP-priority-pin effects, which operate on the published track
    // itself rather than the voice processor.
    const micTrackSid = localParticipant
        ?.getTrackPublication(Track.Source.Microphone)?.trackSid ?? null;

    // ── Mic health watchdog ───────────────────────────────────────────────────
    // Covers the restart paths we don't initiate. LiveKit restarts the local mic
    // by itself on reconnect-republish, on device-ended, and on permission
    // regrant, and those paths rebuild getUserMedia constraints from a narrower
    // set than the one we published with:
    //
    //     streamConstraints.audio = deviceId ? { deviceId, ...otherConstraints } : true
    //
    // where `otherConstraints` comes from whatever that particular call site
    // passed. LiveKit's own device-ended recovery passes only {deviceId:'default'},
    // so our echoCancellation/noiseSuppression/autoGainControl:false silently
    // revert to Chromium's defaults — browser AEC+NS+AGC stacked on top of
    // RNNoise and the gate, which is how a working mic turns quiet-then-gated
    // after an unplug rather than simply carrying on.
    //
    // Re-asserting on TrackEvent.Restarted catches every one of those paths
    // without having to enumerate them.
    React.useEffect(() => {
        if (!localParticipant || !micTrackSid) return;
        const micTrack = localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
        if (!(micTrack instanceof LocalAudioTrack)) return;

        const onRestarted = () => {
            micTrack.mediaStreamTrack
                ?.applyConstraints(MIC_CAPTURE_CONSTRAINTS)
                .catch(err => console.warn('[Mic] could not re-apply capture constraints:', err));
        };

        // LiveKit probes for digital silence right after a track is created or
        // restarted and emits this when it finds it — i.e. the device opened
        // successfully but is producing nothing, the exact failure that used to
        // require an app reload. One re-acquire attempt per track; if that
        // doesn't fix it we say so rather than looping.
        let recovered = false;
        const onSilence = () => {
            if (recovered) return;
            recovered = true;
            console.warn('[Mic] captured track is silent — re-acquiring');
            void syncMicDevice(true);
        };

        micTrack.on(TrackEvent.Restarted, onRestarted);
        micTrack.on(TrackEvent.AudioSilenceDetected, onSilence);
        return () => {
            micTrack.off(TrackEvent.Restarted, onRestarted);
            micTrack.off(TrackEvent.AudioSilenceDetected, onSilence);
        };
    }, [localParticipant, micTrackSid, syncMicDevice]);

    // ── Keep the screen-share encoder overrides attached ──────────────────────
    // They live on the RTCRtpSender, and LiveKit builds a new one every time it
    // republishes — which republishAllTracks() does for the screen share on
    // every reconnect. Re-applying whenever the publication's sid changes means
    // a network blip can't silently demote a 90 fps share back to WebRTC's
    // defaults. No-ops when the parameters already match.
    const ssTrackSid = localParticipant
        ?.getTrackPublication(Track.Source.ScreenShare)?.trackSid ?? null;
    React.useEffect(() => {
        if (!localParticipant || !ssTrackSid) return;
        const share = currentShareRef.current;
        if (!share) return;
        const ssPub = localParticipant.getTrackPublication(Track.Source.ScreenShare);
        const sender = (ssPub?.track as { sender?: RTCRtpSender } | undefined)?.sender;
        if (!sender) return;
        const msTrack = ssPub?.track?.mediaStreamTrack;
        if (msTrack) msTrack.contentHint = 'motion';
        void applyScreenShareSenderParams(
            sender,
            share.frameRate,
            computeSSBitrate(share.resolution, share.frameRate, asScreenShareCodec(ssPub?.track?.codec)),
        ).catch(err => console.warn('[ScreenShare] re-applying sender params failed:', err));
    }, [localParticipant, ssTrackSid]);

    // Pin mic sender RTP priority HIGH — explicitly tells WebRTC's congestion
    // controller not to steal the mic's bitrate to feed screenshare video.
    // Without this, GCC's default allocation can still trim voice below the
    // audioPreset when outbound bandwidth is tight, reintroducing tin-can
    // artifacts. Runs whenever the mic track is (re)published.
    React.useEffect(() => {
        if (!localParticipant || !micTrackSid) return;
        const micPub = localParticipant.getTrackPublication(Track.Source.Microphone);
        const sender = (micPub?.track as any)?.sender as RTCRtpSender | undefined;
        if (!sender) return;
        try {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
                params.encodings = [{}];
            }
            for (const enc of params.encodings) {
                enc.maxBitrate = 64_000; // match publishDefaults.audioPreset
                (enc as any).priority = 'high';
                (enc as any).networkPriority = 'high';
            }
            sender.setParameters(params).then(() => {
                // Log the final state after LiveKit / Chromium's own normalization
                // so we can confirm the values actually stuck. If they didn't,
                // that's the next thing to investigate.
                const finalParams = sender.getParameters();
                console.log('[Mic] RTP parameters applied:', {
                    encodings: finalParams.encodings?.map(e => ({
                        maxBitrate: e.maxBitrate,
                        priority: (e as any).priority,
                        networkPriority: (e as any).networkPriority,
                    })),
                    degradationPreference: (finalParams as any).degradationPreference,
                });
            }).catch(err => {
                console.warn('[Mic] setParameters override failed:', err);
            });
        } catch (err) {
            console.warn('[Mic] priority pin failed:', err);
        }
    }, [localParticipant, micTrackSid]);

    // No processor cleanup effect here anymore — voiceProcessorManager's
    // lifetime is tied to CallPane (destroyForCall on room disconnect / unmount),
    // not to this component, precisely so this component's OWN unmount/remount
    // (portal target moving) doesn't tear the processor down. See the comment
    // on the settings-push effect above.

    // ── Push to Talk ──────────────────────────────────────────────────────────
    // When PTT is enabled: mic stays muted unless the configured key is held.
    React.useEffect(() => {
        if (!voice?.settings.pushToTalk || !localParticipant) {
            // PTT turned off — restore mic unless deafened or the user was
            // manually muted before they deafened (wasMutedBeforeDeafenRef).
            if (!voice?.settings.pushToTalk && localParticipant && !isLocalDeafened) {
                if (!localParticipant.isMicrophoneEnabled && !wasMutedBeforeDeafenRef.current) {
                    localParticipant.setMicrophoneEnabled(true);
                }
            }
            return;
        }

        // PTT enabled — mute mic to start
        if (localParticipant.isMicrophoneEnabled) {
            localParticipant.setMicrophoneEnabled(false);
        }

        const pttKey = voice.settings.pushToTalkKey;
        if (!pttKey) return;

        const matchesKey = (e: KeyboardEvent): boolean => {
            // Build a comparable combo from the event
            const parts: string[] = [];
            if (e.ctrlKey || e.metaKey) parts.push('ctrl');
            if (e.altKey) parts.push('alt');
            if (e.shiftKey) parts.push('shift');
            let key = e.key.toLowerCase();
            if (['control', 'meta', 'alt', 'shift'].includes(key)) return false;
            if (key === ' ') key = 'space';
            parts.push(key);
            return parts.join('+') === pttKey;
        };

        const onDown = (e: KeyboardEvent) => {
            if (matchesKey(e) && !localParticipant.isMicrophoneEnabled) {
                localParticipant.setMicrophoneEnabled(true);
            }
        };
        const onUp = (e: KeyboardEvent) => {
            if (matchesKey(e) && localParticipant.isMicrophoneEnabled) {
                localParticipant.setMicrophoneEnabled(false);
            }
        };

        window.addEventListener('keydown', onDown);
        window.addEventListener('keyup', onUp);
        return () => {
            window.removeEventListener('keydown', onDown);
            window.removeEventListener('keyup', onUp);
        };
    }, [voice?.settings.pushToTalk, voice?.settings.pushToTalkKey, localParticipant, isLocalDeafened]);

    // No speaker-volume effect here — removed as part of the call-audio
    // reliability pass. This used to run a MutationObserver on the whole
    // document body, on every DOM mutation anywhere in the app for the
    // entire call, forcing `el.volume` on every <audio> element it found.
    // That directly fought useParticipantAudio.ts's design: remote tracks
    // are deliberately attached at `volume = 0` (see buildMicInternals) —
    // actual playback goes entirely through the WebAudio master gain
    // (getMasterGain/setMasterVolume), not HTMLAudioElement.volume. Two
    // independent, uncoordinated implementations of the same "speaker
    // volume" slider is itself a bug (one clamps at 1.0 = no real boost
    // past 100%, the other applies a ^1.5 perceptual curve up to ~3×) — and
    // had LiveKit's playback-unlock path ever appended one of its dummy
    // `<audio>` elements to the DOM (it does, transiently, in some browsers)
    // while this observer was live, this would have forced that element's
    // volume up off of 0, doubling that participant's audio at full element
    // volume on top of the WebAudio chain. The Settings speaker slider
    // already routes correctly through setMasterVolume in
    // VoiceVideoSettings.tsx.

    // ── Camera processor (picture settings: brightness / contrast / saturation) ──
    const cameraProcessorRef = React.useRef<CipherlineCameraProcessor | null>(null);

    React.useEffect(() => {
        if (!localParticipant || !voice) return;

        const camPub   = localParticipant.getTrackPublication(Track.Source.Camera);
        const camTrack = camPub?.track;
        const shouldProcess = camTrack instanceof LocalVideoTrack &&
            localParticipant.isCameraEnabled &&
            isCameraProcessingNeeded(voice.settings);

        if (shouldProcess && camTrack instanceof LocalVideoTrack) {
            if (!cameraProcessorRef.current) {
                const processor = new CipherlineCameraProcessor(voice.settings, setCameraError);
                cameraProcessorRef.current = processor;
                camTrack.setProcessor(processor as any).catch(err => {
                    console.warn('[CameraProcessor] Failed to attach:', err);
                    cameraProcessorRef.current = null;
                });
            } else {
                cameraProcessorRef.current.updateSettings(voice.settings);
            }
        } else if (!shouldProcess && cameraProcessorRef.current) {
            const track = camPub?.track;
            if (track instanceof LocalVideoTrack) track.stopProcessor().catch(() => {});
            cameraProcessorRef.current = null;
        } else if (cameraProcessorRef.current) {
            cameraProcessorRef.current.updateSettings(voice.settings);
        }
    }, [
        localParticipant,
        localParticipant?.isCameraEnabled,
        voice?.settings.cameraBrightness,
        voice?.settings.cameraContrast,
        voice?.settings.cameraSaturation,
    ]);

    // Clean up camera processor on unmount
    React.useEffect(() => {
        return () => {
            if (cameraProcessorRef.current) {
                cameraProcessorRef.current.destroy().catch(() => {});
                cameraProcessorRef.current = null;
            }
        };
    }, []);

    // ── Global keybind event listeners ──────────────────────────────────────
    // Dashboard dispatches custom DOM events when a keybind fires for a call
    // action. We listen here because this component owns the LiveKit participant.
    React.useEffect(() => {
        const handlers: Record<string, () => void> = {
            'keybind:toggle-mute':        toggleMic,
            'keybind:toggle-deafen':      toggleDeafen,
            'keybind:toggle-camera':      () => toggleCamera(),
            'keybind:toggle-screenshare': toggleScreenshare,
            'keybind:leave-call':         handleLeave,
            'keybind:quick-screenshare':  () => {
                // Quick share: toggle on/off. When starting fresh, resolve the
                // best source without the picker — prefer a detected game
                // window, fall back to the primary display. Always default
                // preset (1080p/30fps) with audio.
                if (!localParticipant) return;
                if (localParticipant.isScreenShareEnabled) {
                    stopNativeWindowAudio();
                    localParticipant.setScreenShareEnabled(false);
                    currentShareRef.current = null;
                    setCurrentShare(null);
                    return;
                }
                void (async () => {
                    const api = window.electronAPI;
                    if (!api?.getDesktopSources) {
                        // No IPC available — fall back to the picker.
                        setIsScreenSharePickerOpen(true);
                        return;
                    }
                    try {
                        // Enumeration is the whole cost of "quick" share, and it is
                        // NOT uniform. Measured on Electron 43.2.0 / Linux x64 under
                        // Xvfb: getSources({types:['screen']}) returns in ~16ms,
                        // while ANY request including 'window' takes a flat ~3.0s —
                        // even when it returns zero sources, so it is a fixed wait
                        // inside the window capturer, not per-window work. Thumbnails
                        // cost another ~110-200ms for a single source on top, and
                        // this path discards every one of them.
                        //
                        // The old code called api.getDesktopSources() with no args,
                        // which the main handler defaults to ['window','screen'] WITH
                        // thumbnails — i.e. the most expensive enumeration available,
                        // awaited before anything else could happen, with every
                        // thumbnail thrown away. That is the bulk of "quick share
                        // takes much longer than it used to".
                        //
                        // Caveat for whoever reads this next: the ~3s is a Linux
                        // measurement and the shipping client is Windows. The shape
                        // of the fix (don't ask for windows unless a window is
                        // actually wanted; never ask for thumbnails you discard)
                        // holds on every platform; the constant may not.
                        //
                        // So: resolve the game FIRST (a cheap local probe), and only
                        // pay for the window list when there is actually a game name
                        // to match against. With no game detected — the common case —
                        // we go straight to the screen-only enumeration that the old
                        // code reached anyway, having already paid for windows.
                        const currentGame = api.getCurrentGame
                            ? await api.getCurrentGame().catch(() => null)
                            : null;

                        const norm = (s: string) => s.toLowerCase();
                        type Src = { id: string; name: string; thumbnailDataUrl: string };
                        let picked: Src | null = null;
                        let sources: Src[] = [];

                        // Match priority:
                        //   1. Window source whose name matches the detected game (case-insensitive substring both ways).
                        //   2. First `screen:` source (primary display).
                        //   3. First source of any kind.
                        if (currentGame) {
                            sources = await api.getDesktopSources(['window', 'screen'], { thumbnails: false }) ?? [];
                            const needle = norm(currentGame.name);
                            picked = sources.find(s =>
                                s.id.startsWith('window:') &&
                                (norm(s.name).includes(needle) || needle.includes(norm(s.name)))
                            ) ?? null;
                        }
                        if (!picked) {
                            // No game, or the game window wasn't in the list: all we
                            // need now is a display, so ask for displays only.
                            if (sources.length === 0) {
                                sources = await api.getDesktopSources(['screen'], { thumbnails: false }) ?? [];
                            }
                            picked = sources.find(s => s.id.startsWith('screen:')) ?? sources[0] ?? null;
                        }
                        if (!picked) {
                            setIsScreenSharePickerOpen(true);
                            return;
                        }

                        await handleScreenShareSelect({
                            sourceId:    picked.id,
                            resolution:  '1080p',
                            frameRate:   30,
                            audio:       true,
                            // Motion tuning is applied globally in handleScreenShareSelect —
                            // the sender gets contentHint='motion' and
                            // degradationPreference='maintain-framerate' regardless of
                            // entry point, so keybind-triggered shares benefit too.
                        });
                    } catch (err) {
                        console.warn('[quick-screenshare] resolve-source failed, falling back to picker:', err);
                        setIsScreenSharePickerOpen(true);
                    }
                })();
            },
        };
        const listener = (e: Event) => {
            const handler = handlers[e.type];
            if (handler) handler();
        };
        for (const event of Object.keys(handlers)) {
            window.addEventListener(event, listener);
        }
        return () => {
            for (const event of Object.keys(handlers)) {
                window.removeEventListener(event, listener);
            }
        };
    });

    // Filter out the focused stream from sidebar (it renders in the FocusedStreamBanner instead)
    const focusedStream = callCtx?.focusedStream;
    const isFocusedInSidebar = (identity: string, source: Track.Source) =>
        focusedStream?.identity === identity && focusedStream?.source === source;

    const DummyRingingTile = ({ compact }: { compact: boolean }) => {
        const size = compact ? 'w-9 h-9' : 'w-24 h-24';
        const nameTrunc = compact ? 'max-w-[60px]' : 'max-w-[100px]';

        return (
            <div className={`flex flex-col items-center ${compact ? 'gap-0.5' : 'gap-2'} relative`}>
                <div className="relative isolate">
                    <div className={`${size} relative z-10 rounded-full overflow-hidden flex items-center justify-center transition-all p-0 border-none ring-1 ring-white/10`}>
                        <EncryptedAvatar
                            attachmentId={activeChatAvatarUrl ?? null}
                            userId={activeChatUserId ?? null}
                            isGroup={isGroup && !activeChatUserId}
                            token={token}
                            className="w-full h-full object-cover"
                            fallbackSize={compact ? 14 : 32}
                            bypassFriendGate
                        />
                    </div>
                    <div className="absolute inset-0 z-0 bg-cl-lume/20 rounded-full animate-ping pointer-events-none" style={{ animationDuration: '2s' }}></div>
                    <div className="absolute inset-[-10px] z-[0] border border-cl-lume/20 rounded-full animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite] pointer-events-none" style={{ animationDelay: '0.5s' }}></div>
                </div>
                <span className={`flex items-center gap-1.5 text-[10px] font-semibold text-cl-muted px-2 py-0.5 rounded-full bg-white/5 truncate max-w-[150px]`}>
                    <span className={`truncate ${nameTrunc}`}>{activeChatTitle || 'User'}</span>
                    <span className="text-cl-lume tracking-widest uppercase animate-pulse" style={{ fontSize: '9px' }}>Calling...</span>
                </span>
            </div>
        );
    };

    return (
        // Auto-sizes to the height of its tile content. The chat panel hosts this
        // inside a single scroll container, so SidebarConference itself does NOT
        // own a flex-1 / overflow-hidden frame — it just stacks tiles vertically
        // and lets the parent scroll. This is what makes the call section grow
        // with the number of participants instead of staying a fixed slot.
        <motion.div
            className="call-no-select w-full flex flex-col relative"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        >
            {/* Ping / packet-loss pill — server/voice-channel calls only.
                Portals into `#call-stats-root` when a stream is focused so
                it stays visible inside the focused banner. DM and group calls
                show no pill here; ping is shown next to the local user's name
                in their ParticipantCard row instead. */}
            {/* Focused stream banner (portalled to #call-focus-root) */}
            <FocusedStreamBanner
                token={token}
                callSessionId={sessionId}
                isLocalDeafened={isLocalDeafened}
                localMutedParticipantIds={localMutedParticipantIds}
                onToggleLocalMute={toggleParticipantLocalMute}
                isGroup={isGroup}
                fallbackAvatars={fallbackAvatars}
                localAvatarUrl={localAvatarUrl}
                remoteAvatarUrl={activeChatAvatarUrl}
                hiddenVideoIds={hiddenVideoIds}
                hiddenScreenShareIds={hiddenScreenShareIds}
                onHideVideoChange={toggleHideVideo}
                onHideScreenShareChange={toggleHideScreenShare}
                onFocusedStreamChange={onFocusedStreamChange}
            />

            {/* Fullscreen overlay (portalled to body) */}
            <FullscreenOverlay
                token={token}
                isLocalDeafened={isLocalDeafened}
                localMutedParticipantIds={localMutedParticipantIds}
                onToggleLocalMute={toggleParticipantLocalMute}
                isGroup={isGroup}
                fallbackAvatars={fallbackAvatars}
                localAvatarUrl={localAvatarUrl}
                remoteAvatarUrl={activeChatAvatarUrl}
                hiddenVideoIds={hiddenVideoIds}
                hiddenScreenShareIds={hiddenScreenShareIds}
                onHideVideoChange={toggleHideVideo}
                onHideScreenShareChange={toggleHideScreenShare}
                subscribedScreenshares={subscribedScreenshares}
                onSubscribeScreenshare={handleSubscribeScreenshare}
                canServerMute={canServerMute}
                onServerMuteTrack={onServerMuteTrack}
            />

            {/* Reconnecting indicator — LiveKit is actively retrying (ICE
                restart, resumed session) after a network blip. No dismiss
                button: it clears itself the moment RoomEvent.Reconnected
                fires, and there's nothing useful for the user to act on
                while it's up other than wait. */}
            {isReconnecting && (
                <motion.div
                    variants={sidebarPillVariants}
                    initial="initial"
                    animate="animate"
                    className="mx-3 mb-1 flex items-center gap-2 px-3 py-2 bg-cl-deep border border-cl-flash/40 rounded-xl text-[11px] text-cl-muted"
                >
                    <WifiOff className="w-3 h-3 text-cl-flash shrink-0" />
                    <span className="text-cl-text">Reconnecting…</span>
                </motion.div>
            )}

            {/* "Connected but silent" watchdog banner — sustained mismatch
                between what our own pipeline thinks it's producing and what's
                actually reaching the wire (see audioSilenceWatchdog.ts). Not
                dismissable: it clears itself the moment outbound audio
                actually recovers, same as the reconnecting pill above. */}
            {isPipelineSilent && (
                <motion.div
                    variants={sidebarPillVariants}
                    initial="initial"
                    animate="animate"
                    className="mx-3 mb-1 flex items-center gap-2 px-3 py-2 bg-cl-deep border border-cl-flash/40 rounded-xl text-[11px] text-cl-muted"
                >
                    <Mic className="w-3 h-3 text-cl-flash shrink-0" />
                    <span className="text-cl-text">You appear to be talking, but nothing is being sent — try toggling your mic off and on.</span>
                </motion.div>
            )}

            {/* Mic failure banner — the recovery paths in syncMicDevice all
                fell through, so the mic really is dead. Not auto-dismissed:
                unlike the "Switched to X" notice this is a state the user has
                to act on. */}
            {micError && (
                <motion.div
                    variants={sidebarPillVariants}
                    initial="initial"
                    animate="animate"
                    className="mx-3 mb-1 flex items-center gap-2 px-3 py-2 bg-cl-deep border border-cl-flash/40 rounded-xl text-[11px] text-cl-muted"
                >
                    <Mic className="w-3 h-3 text-cl-flash shrink-0" />
                    <span className="text-cl-text">{micError}</span>
                    <ClButton
                        icon
                        variant="ghost"
                        size="sm"
                        onClick={() => setMicError(null)}
                        className="ml-auto"
                    >✕</ClButton>
                </motion.div>
            )}

            {/* Camera failure banner — the recovery paths in syncCameraDevice
                all fell through. Same pattern as the mic banner above; the
                camera path had none of this before (LiveKit's own recovery
                excludes video from its fallback-device logic, so an
                unplugged/revoked/exclusively-grabbed camera used to converge
                on a silent mute with only a console.warn). */}
            {cameraError && (
                <motion.div
                    variants={sidebarPillVariants}
                    initial="initial"
                    animate="animate"
                    className="mx-3 mb-1 flex items-center gap-2 px-3 py-2 bg-cl-deep border border-cl-flash/40 rounded-xl text-[11px] text-cl-muted"
                >
                    <VideoOff className="w-3 h-3 text-cl-flash shrink-0" />
                    <span className="text-cl-text">{cameraError}</span>
                    <ClButton
                        icon
                        variant="ghost"
                        size="sm"
                        onClick={() => setCameraError(null)}
                        className="ml-auto"
                    >✕</ClButton>
                </motion.div>
            )}

            {/* Screenshare-audio platform-limit notice (per-window audio is
                Windows-only; full-screen fallback uses loopbackWithMute). */}
            {screenShareNotice && (
                <motion.div
                    variants={sidebarPillVariants}
                    initial="initial"
                    animate="animate"
                    className="mx-3 mb-1 flex items-start gap-2 px-3 py-2 rounded-xl text-[11px] border"
                    style={{
                        background:  screenShareNotice.tone === 'warn' ? 'rgba(234,179,8,0.08)' : 'rgba(14,165,233,0.08)',
                        borderColor: screenShareNotice.tone === 'warn' ? 'rgba(234,179,8,0.35)' : 'rgba(14,165,233,0.35)',
                        color:       screenShareNotice.tone === 'warn' ? 'rgb(252,211,77)'      : 'rgb(125,211,252)',
                    }}
                >
                    <ScreenShare className="w-3 h-3 shrink-0 mt-[1px]" />
                    <span className="leading-snug">{screenShareNotice.text}</span>
                    <ClButton
                        icon
                        variant="ghost"
                        size="sm"
                        onClick={() => setScreenShareNotice(null)}
                        className="ml-auto"
                    >✕</ClButton>
                </motion.div>
            )}


            {/* ── Video tiles ────────────────────────────────────────────────────
                In voice-channel mode (noRinging=true) with active video, the tiles
                are portaled to #call-video-root which lives at the very top of the
                ServerContextPanel — above the channel header. This lets the panel's
                own scroll area keep showing the voice-channel list + members while
                the video floats above everything.

                In normal DM/group call mode the tiles render inline in the scroll
                container below (videoTilesRef div), where they're measured for
                the isScrollable → compact-strip decision.

                Visual gap in normal mode:
                  LEFT  = divider2El (4 px) + pl-1 (4 px) = 8 px
                  RIGHT = pr-2 (8 px)                     = 8 px
                In voice-channel mode we use px-2 (8 px each side) to match the
                ServerContextPanel's panel-wide gutter (which mirrors the DM panel),
                keeping the tiles centered. */}

            {/* Portal: video tiles to panel top when camera/screenshare is on in
                voice-channel mode.  The portal is always mounted (when noRinging
                + videoRoot), so AnimatePresence inside can run the exit spring
                when anyVideo flips false — slides the panel content back up too. */}
            {noRinging && videoRoot && ReactDOM.createPortal(
                <AnimatePresence>
                {anyVideo && (
                <motion.div
                    key="video-tiles"
                    className="flex flex-col gap-2 px-2 pt-2 pb-2"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                    style={{ overflow: 'hidden' }}
                >
                    <LayoutGroup id="portal-video-tiles">
                    <AnimatePresence mode="popLayout" initial={true}>
                    {/* Your own share — pinned first, same self-view treatment local
                        camera already gets. Confirms what's actually being sent, the
                        way every other call app shows your own share back to you. */}
                    {localScreenShare && !isFocusedInSidebar(localParticipant!.identity, Track.Source.ScreenShare) && (
                        <motion.div key="local-screenshare" layout
                            variants={tileItemVariants} initial="initial" animate="animate" exit="exit"
                            transition={{ layout: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } }}>
                            <LocalScreenShareTile
                                shareSourceId={currentShare?.sourceId ?? null}
                                p={localParticipant!}
                                source={Track.Source.ScreenShare}
                                localParticipant={localParticipant}
                                token={token}
                                localAvatarUrl={localAvatarUrl}
                                remoteAvatarUrl={localAvatarUrl}
                                isLocalDeafened={isLocalDeafened}
                                isLocalMuted={localMutedParticipantIds.has(localParticipant.identity)}
                                onToggleLocalMute={(v) => toggleParticipantLocalMute(localParticipant.identity, v)}
                                isGroup={isGroup}
                                fallbackAvatars={fallbackAvatars}
                                quality={VideoQuality.LOW}
                                canServerMute={canServerMute}
                                onServerMuteTrack={onServerMuteTrack}
                            />
                        </motion.div>
                    )}
                    {/* Screenshares — full-width stacked (best for presentations) */}
                    {visibleScreenShareParticipants.map(p => (
                        !isFocusedInSidebar(p.identity, Track.Source.ScreenShare) && (
                            subscribedScreenshares.has(p.identity) ? (
                                <motion.div key={`ss-${p.identity}`} layout
                                    variants={tileItemVariants} initial="initial" animate="animate" exit="exit"
                                    transition={{ layout: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } }}>
                                    <VideoTile
                                        p={p}
                                        source={Track.Source.ScreenShare}
                                        localParticipant={localParticipant}
                                        token={token}
                                        localAvatarUrl={localAvatarUrl}
                                        remoteAvatarUrl={activeChatAvatarUrl}
                                        isLocalDeafened={isLocalDeafened}
                                        isLocalMuted={localMutedParticipantIds.has(p.identity)}
                                        onToggleLocalMute={(v) => toggleParticipantLocalMute(p.identity, v)}
                                        isHiddenVideo={hiddenVideoIds.has(p.identity)}
                                        isHiddenScreenShare={hiddenScreenShareIds.has(p.identity)}
                                        onHideVideoChange={(v) => toggleHideVideo(p.identity, v)}
                                        onHideScreenShareChange={(v) => toggleHideScreenShare(p.identity, v)}
                                        isGroup={isGroup}
                                        fallbackAvatars={fallbackAvatars}
                                        quality={VideoQuality.LOW}
                                        canServerMute={canServerMute}
                                        onServerMuteTrack={onServerMuteTrack}
                                    />
                                </motion.div>
                            ) : (
                                <motion.div key={`ssgate-${p.identity}`} layout
                                    variants={tileItemVariants} initial="initial" animate="animate" exit="exit"
                                    transition={{ layout: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } }}>
                                    <ScreenShareGate
                                        p={p}
                                        localParticipant={localParticipant}
                                        token={token}
                                        // Per-identity, NOT activeChatAvatarUrl — that is the
                                        // CONVERSATION's avatar. In a 1:1 DM it coincides with the
                                        // other person's, which is why "I don't see the person's
                                        // profile picture in the 'watch' screen share button" only
                                        // showed up in groups and servers. fallbackAvatars is keyed
                                        // by identity and pre-seeded from the server member list
                                        // and each participant's own token metadata.
                                        avatarAttachmentId={fallbackAvatars[p.identity] ?? activeChatAvatarUrl}
                                        isLocalDeafened={isLocalDeafened}
                                        isLocalMuted={localMutedParticipantIds.has(p.identity)}
                                        onToggleLocalMute={(v) => toggleParticipantLocalMute(p.identity, v)}
                                        onSubscribed={handleSubscribeScreenshare}
                                        onHideScreenShare={() => toggleHideScreenShare(p.identity, true)}
                                    />
                                </motion.div>
                            )
                        )
                    ))}
                    {/* Camera tiles — vertical stack, one tile per row at full panel
                        width. Matches DM-call layout for visual consistency. Active
                        speaker stays top-most when tiles overflow the visible panel
                        (sortedVisibleRemoteCamParticipants applies the speaker-promotion
                        order). */}
                    {(localCam || sortedVisibleRemoteCamParticipants.length > 0) && (
                        <motion.div
                            key="cam-strip"
                            layout
                            variants={tileItemVariants}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            className="flex flex-col gap-1.5"
                            transition={{ layout: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } }}
                        >
                            {localCam && !isFocusedInSidebar(localParticipant!.identity, Track.Source.Camera) && (
                                <motion.div layout key="local-cam-portal" className="w-full"
                                    transition={{ layout: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } }}>
                                    <VideoTile
                                        p={localParticipant!}
                                        source={Track.Source.Camera}
                                        localParticipant={localParticipant}
                                        token={token}
                                        localAvatarUrl={localAvatarUrl}
                                        remoteAvatarUrl={localAvatarUrl}
                                        isLocalDeafened={isLocalDeafened}
                                        isLocalMuted={localMutedParticipantIds.has(localParticipant.identity)}
                                        onToggleLocalMute={(v) => toggleParticipantLocalMute(localParticipant.identity, v)}
                                        isGroup={isGroup}
                                        fallbackAvatars={fallbackAvatars}
                                        quality={sidebarCamQuality}
                                        canServerMute={canServerMute}
                                        onServerMuteTrack={onServerMuteTrack}
                                    />
                                </motion.div>
                            )}
                            {sortedVisibleRemoteCamParticipants.map((p) => (
                                !isFocusedInSidebar(p.identity, Track.Source.Camera) && (
                                    <motion.div key={`cam-${p.identity}`} layout className="w-full"
                                        transition={{ layout: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } }}>
                                        <VideoTile
                                            p={p}
                                            source={Track.Source.Camera}
                                            localParticipant={localParticipant}
                                            token={token}
                                            remoteAvatarUrl={activeChatAvatarUrl}
                                            isLocalDeafened={isLocalDeafened}
                                            isLocalMuted={localMutedParticipantIds.has(p.identity)}
                                            onToggleLocalMute={(v) => toggleParticipantLocalMute(p.identity, v)}
                                            isHiddenVideo={hiddenVideoIds.has(p.identity)}
                                            isHiddenScreenShare={hiddenScreenShareIds.has(p.identity)}
                                            onHideVideoChange={(v) => toggleHideVideo(p.identity, v)}
                                            onHideScreenShareChange={(v) => toggleHideScreenShare(p.identity, v)}
                                            isGroup={isGroup}
                                            fallbackAvatars={fallbackAvatars}
                                            quality={sidebarCamQuality}
                                            canServerMute={canServerMute}
                                            onServerMuteTrack={onServerMuteTrack}
                                        />
                                    </motion.div>
                                )
                            ))}
                        </motion.div>
                    )}
                    </AnimatePresence>
                    </LayoutGroup>
                    {/* Overflow sentinel for server/voice calls — 1 px div watched by
                        IntersectionObserver to detect when the tile strip has scrolled
                        below the visible panel and enable speaker promotion. */}
                    {noRinging && <div ref={videoBottomSentinelRef} style={{ height: 1, flexShrink: 0, pointerEvents: 'none', visibility: 'hidden' }} aria-hidden />}
                </motion.div>
                )}
                </AnimatePresence>,
                videoRoot
            )}

            {/* Scrollable area: video tiles (non-portal mode) + audio-only cards.
                In voice-channel mode with video the scroll area still shows the
                audio-only participant rows; video tiles are portaled out above. */}
            {/* Horizontal insets, DM / group-DM branch: `px-0` + a scrollbar
                gutter reserved on BOTH edges, NOT the `pl-1 pr-2` this used to
                carry. `overflow-x-hidden` makes `overflow-y` compute to `auto`,
                and the app-wide `scrollbar-width: thin` (index.css) is a
                CLASSIC, space-consuming scrollbar — so once the panel scrolled,
                the content box lost 4px on the left and 8+10=18px on the right.
                That put every full-width video tile 7px left of the panel centre
                with its right edge stopping well short, while everything
                rendered outside this container (the composer, the search field)
                stayed centred — exactly the reported misalignment. Measured in
                Chromium at 280/320/420/560/760px, scrolling and not: before
                L=4/R=18 (off -7) and L=4/R=8 (off -2); after L=R=10, offset 0 in
                every case. `stable` also reserves the gutter when no scrollbar
                is showing, so the tiles do not shift as content grows past the
                fold. The huddle branch keeps its own insets: it portals its
                video tiles out to #call-video-root entirely, so nothing
                width-sensitive lives in here for it.

                Vertical, DM / group-DM branch: `pt-3` fixed the box's OWN
                top/bottom symmetry (it used to be unconditional `pt-0`
                regardless of branch, so this container had 0px above its
                content and 12px below, independent of and in addition to
                whatever #call-sidebar-root (Dashboard.tsx) contributed
                above it). But this box's own symmetry isn't what the user
                actually sees — the very next thing in the DOM after it is
                the search bar's `shrink-0 px-2 py-2` wrapper (Dashboard.tsx),
                which has its OWN 8px top inset stacking visually below the
                video with nothing analogous above it (nothing precedes the
                first tile the same way). `pb-1` (4px, not `pb-3`'s 12px)
                is that 8px deliberately subtracted back out: 4px here +
                8px from the search bar's own py-2 = 12px total below,
                matching pt-3's 12px above exactly. Live-measured down to
                the pixel across several rounds — this box being internally
                symmetric was never the actual goal; matching what renders
                immediately after it is. */}
            <div
                ref={scrollContainerRef}
                className={`overflow-x-hidden flex flex-col ${noRinging ? 'pt-0 pb-0 px-0 gap-0' : 'pt-3 pb-1 px-0 gap-3'}`}
                style={{
                    display: callCtx?.isFullscreen ? 'none' : undefined,
                    ...(noRinging ? null : { scrollbarGutter: 'stable both-edges' }),
                }}
            >

                {/* Video tiles wrapper — only rendered in normal (non-portal) mode.
                    Measured by videoTilesRef for the isScrollable → compact-strip calc.
                    LayoutGroup scopes the `layout` animations so Framer Motion can
                    smoothly reposition tiles when the speaker-promotion sort fires. */}
                <div ref={videoTilesRef} className="flex flex-col gap-3">
                {!(noRinging && anyVideo) && (
                    <LayoutGroup id="inline-video-tiles">
                    <AnimatePresence mode="popLayout" initial={true}>
                    {/* Your own share — see the portal branch above for why. */}
                    {localScreenShare && !isFocusedInSidebar(localParticipant!.identity, Track.Source.ScreenShare) && (
                        <motion.div key="local-screenshare" layout
                            variants={tileItemVariants} initial="initial" animate="animate" exit="exit"
                            transition={{ layout: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } }}>
                            <LocalScreenShareTile
                                shareSourceId={currentShare?.sourceId ?? null}
                                p={localParticipant!}
                                source={Track.Source.ScreenShare}
                                localParticipant={localParticipant}
                                token={token}
                                localAvatarUrl={localAvatarUrl}
                                remoteAvatarUrl={localAvatarUrl}
                                isLocalDeafened={isLocalDeafened}
                                isLocalMuted={localMutedParticipantIds.has(localParticipant.identity)}
                                onToggleLocalMute={(v) => toggleParticipantLocalMute(localParticipant.identity, v)}
                                isGroup={isGroup}
                                fallbackAvatars={fallbackAvatars}
                                quality={VideoQuality.LOW}
                                canServerMute={canServerMute}
                                onServerMuteTrack={onServerMuteTrack}
                            />
                        </motion.div>
                    )}
                    {/* Screenshares — always at top, never reorder */}
                    {visibleScreenShareParticipants.map(p => (
                        !isFocusedInSidebar(p.identity, Track.Source.ScreenShare) && (
                            subscribedScreenshares.has(p.identity) ? (
                                <motion.div key={`ss-${p.identity}`} layout
                                    variants={tileItemVariants} initial="initial" animate="animate" exit="exit"
                                    transition={{ layout: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } }}>
                                    <VideoTile
                                        p={p}
                                        source={Track.Source.ScreenShare}
                                        localParticipant={localParticipant}
                                        token={token}
                                        localAvatarUrl={localAvatarUrl}
                                        remoteAvatarUrl={activeChatAvatarUrl}
                                        isLocalDeafened={isLocalDeafened}
                                        isLocalMuted={localMutedParticipantIds.has(p.identity)}
                                        onToggleLocalMute={(v) => toggleParticipantLocalMute(p.identity, v)}
                                        isHiddenVideo={hiddenVideoIds.has(p.identity)}
                                        isHiddenScreenShare={hiddenScreenShareIds.has(p.identity)}
                                        onHideVideoChange={(v) => toggleHideVideo(p.identity, v)}
                                        onHideScreenShareChange={(v) => toggleHideScreenShare(p.identity, v)}
                                        isGroup={isGroup}
                                        fallbackAvatars={fallbackAvatars}
                                        quality={VideoQuality.LOW}
                                        canServerMute={canServerMute}
                                        onServerMuteTrack={onServerMuteTrack}
                                    />
                                </motion.div>
                            ) : (
                                <motion.div key={`ssgate-${p.identity}`} layout
                                    variants={tileItemVariants} initial="initial" animate="animate" exit="exit"
                                    transition={{ layout: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } }}>
                                    <ScreenShareGate
                                        p={p}
                                        localParticipant={localParticipant}
                                        token={token}
                                        // Per-identity, NOT activeChatAvatarUrl — that is the
                                        // CONVERSATION's avatar. In a 1:1 DM it coincides with the
                                        // other person's, which is why "I don't see the person's
                                        // profile picture in the 'watch' screen share button" only
                                        // showed up in groups and servers. fallbackAvatars is keyed
                                        // by identity and pre-seeded from the server member list
                                        // and each participant's own token metadata.
                                        avatarAttachmentId={fallbackAvatars[p.identity] ?? activeChatAvatarUrl}
                                        isLocalDeafened={isLocalDeafened}
                                        isLocalMuted={localMutedParticipantIds.has(p.identity)}
                                        onToggleLocalMute={(v) => toggleParticipantLocalMute(p.identity, v)}
                                        onSubscribed={handleSubscribeScreenshare}
                                        onHideScreenShare={() => toggleHideScreenShare(p.identity, true)}
                                    />
                                </motion.div>
                            )
                        )
                    ))}

                    {/* Local camera — pinned above remotes, never promoted */}
                    {localCam && !isFocusedInSidebar(localParticipant!.identity, Track.Source.Camera) && (
                        <motion.div key="local-cam" layout
                            variants={tileItemVariants} initial="initial" animate="animate" exit="exit"
                            transition={{ layout: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } }}>
                            <VideoTile
                                p={localParticipant!}
                                source={Track.Source.Camera}
                                localParticipant={localParticipant}
                                token={token}
                                localAvatarUrl={localAvatarUrl}
                                remoteAvatarUrl={localAvatarUrl}
                                isLocalDeafened={isLocalDeafened}
                                isLocalMuted={localMutedParticipantIds.has(localParticipant.identity)}
                                onToggleLocalMute={(v) => toggleParticipantLocalMute(localParticipant.identity, v)}
                                isGroup={isGroup}
                                fallbackAvatars={fallbackAvatars}
                                quality={sidebarCamQuality}
                                canServerMute={canServerMute}
                                onServerMuteTrack={onServerMuteTrack}
                            />
                        </motion.div>
                    )}

                    {/* Remote cameras — sorted by active speaker when tiles overflow */}
                    {sortedVisibleRemoteCamParticipants.map((p) => (
                        !isFocusedInSidebar(p.identity, Track.Source.Camera) && (
                            <motion.div key={`cam-${p.identity}`} layout
                                variants={tileItemVariants} initial="initial" animate="animate" exit="exit"
                                transition={{ layout: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } }}>
                                <VideoTile
                                    p={p}
                                    source={Track.Source.Camera}
                                    localParticipant={localParticipant}
                                    token={token}
                                    remoteAvatarUrl={activeChatAvatarUrl}
                                    isLocalDeafened={isLocalDeafened}
                                    isLocalMuted={localMutedParticipantIds.has(p.identity)}
                                    onToggleLocalMute={(v) => toggleParticipantLocalMute(p.identity, v)}
                                    isHiddenVideo={hiddenVideoIds.has(p.identity)}
                                    isHiddenScreenShare={hiddenScreenShareIds.has(p.identity)}
                                    onHideVideoChange={(v) => toggleHideVideo(p.identity, v)}
                                    onHideScreenShareChange={(v) => toggleHideScreenShare(p.identity, v)}
                                    isGroup={isGroup}
                                    fallbackAvatars={fallbackAvatars}
                                    quality={sidebarCamQuality}
                                    canServerMute={canServerMute}
                                    onServerMuteTrack={onServerMuteTrack}
                                />
                            </motion.div>
                        )
                    ))}
                    </AnimatePresence>
                    </LayoutGroup>
                )}
                {/* Overflow sentinel — 1 px invisible div at the bottom of video tiles.
                    IntersectionObserver watches this to detect when tiles scroll
                    out of view and enable active-speaker promotion.

                    marginTop: -13, not -12 — cancels BOTH this flex column's
                    own `gap-3` (12px, inserted before the sentinel same as
                    before any other tile) AND the sentinel's own 1px height,
                    pulling its box fully back onto the last real tile's own
                    bottom edge so it contributes zero net height to the flex
                    column's content box. -12 alone (first pass) canceled the
                    gap but left that last 1px measurably standing — live-
                    measured as an exact 1px remainder against the video's
                    own top gap. The sentinel still renders, still sits last
                    in the DOM, still 1px and hidden — IntersectionObserver
                    tracks its own box regardless of margin, so its function
                    is untouched; it now visually claims exactly zero space,
                    matching there being nothing analogous above the first
                    tile at all. */}
                {!noRinging && <div ref={videoBottomSentinelRef} style={{ height: 1, marginTop: -13, flexShrink: 0, pointerEvents: 'none', visibility: 'hidden' }} aria-hidden />}
                </div>

                {/* Audio-only cards — inside scroll area, naturally below video tiles.
                    Voice-channel mode (noRinging) uses compact row layout matching
                    the audio-only section; DM/group calls use the centred tile wrap. */}
                {anyVideo && !isScrollable && audioOnlyParticipants.length > 0 && (
                    noRinging ? (
                        /* Voice-channel / huddle mode: participant rows inside a MUI-style card */
                        <div className="rounded-b-xl overflow-hidden bg-white/[0.04] border-x border-b border-white/[0.07]">
                        <div ref={audioOnlyNormalRef} className="flex flex-col w-full">
                            <AnimatePresence mode="popLayout" initial={true}>
                            {audioOnlyParticipants.map(p => (
                                <motion.div key={p.identity} layout
                                    variants={tileItemVariants} initial="initial" animate="animate" exit="exit" className="w-full"
                                    transition={{ layout: { duration: 0.38, ease: [0.22, 1, 0.36, 1] } }}>
                                    <ParticipantCard
                                        p={p}
                                        localParticipant={localParticipant}
                                        token={token}
                                        localAvatarUrl={localAvatarUrl}
                                        remoteAvatarUrl={activeChatAvatarUrl}
                                        isLocalDeafened={isLocalDeafened}
                                        compact={false}
                                        sizeMode="row"
                                        isLocalMuted={localMutedParticipantIds.has(p.identity)}
                                        onToggleLocalMute={(v) => toggleParticipantLocalMute(p.identity, v)}
                                        isHiddenVideo={hiddenVideoIds.has(p.identity)}
                                        isHiddenScreenShare={hiddenScreenShareIds.has(p.identity)}
                                        onHideVideoChange={(v) => toggleHideVideo(p.identity, v)}
                                        onHideScreenShareChange={(v) => toggleHideScreenShare(p.identity, v)}
                                        isGroup={isGroup}
                                        fallbackAvatars={fallbackAvatars}
                                        roleColor={memberRoleColors?.[p.identity] ?? undefined}
                                        canServerMute={canServerMute}
                                        onServerMuteTrack={onServerMuteTrack}
                                        showLocalPing
                                    />
                                </motion.div>
                            ))}
                            </AnimatePresence>
                        </div>
                        </div>
                    ) : (
                    <div
                        ref={audioOnlyNormalRef}
                        className="flex flex-row flex-wrap justify-center gap-4 pt-1 pb-1"
                    >
                        <AnimatePresence mode="popLayout" initial={true}>
                        {audioOnlyParticipants.map(p => (
                            <motion.div key={p.identity} layout
                                variants={tileItemVariants} initial="initial" animate="animate" exit="exit"
                                transition={{ layout: { duration: 0.38, ease: [0.22, 1, 0.36, 1] } }}>
                                <ParticipantCard
                                    p={p}
                                    localParticipant={localParticipant}
                                    token={token}
                                    localAvatarUrl={localAvatarUrl}
                                    remoteAvatarUrl={activeChatAvatarUrl}
                                    isLocalDeafened={isLocalDeafened}
                                    compact={false}
                                    sizeMode="normal"
                                    isLocalMuted={localMutedParticipantIds.has(p.identity)}
                                    onToggleLocalMute={(v) => toggleParticipantLocalMute(p.identity, v)}
                                    isHiddenVideo={hiddenVideoIds.has(p.identity)}
                                    isHiddenScreenShare={hiddenScreenShareIds.has(p.identity)}
                                    onHideVideoChange={(v) => toggleHideVideo(p.identity, v)}
                                    onHideScreenShareChange={(v) => toggleHideScreenShare(p.identity, v)}
                                    isGroup={isGroup}
                                    fallbackAvatars={fallbackAvatars}
                                />
                            </motion.div>
                        ))}
                        </AnimatePresence>
                    </div>
                    )
                )}

                {/* Audio-only area for when there are NO video participants.
                    Voice channels (noRinging) use a Discord-style compact list
                    (avatar row + name).  DM/group calls use the centered tile grid. */}
                {!anyVideo && (audioOnlyParticipants.length > 0 || isRinging) && (
                    noRinging ? (
                        /* ── Voice-channel / huddle list mode ───────────────── */
                        /* Participant rows share a single MUI-style card so they
                           "mesh together" with a unified rounded background. */
                        /* The card wrapper fades in after the outer height spring has
                           made room, so the user sees: dark blank space → participant
                           fades in.  initial={false} on the inner AnimatePresence lets
                           participants render at full opacity immediately (they are
                           hidden by the card's opacity:0), which means their height is
                           committed instantly — the spring measures the correct target
                           height on the first frame and the push-down is one motion. */
                        <motion.div
                            className="rounded-b-xl overflow-hidden bg-white/[0.04] border-x border-b border-white/[0.07]"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ duration: 0.3, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
                        >
                        <div className="flex flex-col w-full">
                            <AnimatePresence mode="popLayout" initial={false}>
                            {audioOnlyParticipants.map(p => (
                                <motion.div key={p.identity} variants={tileItemVariants} initial="initial" animate="animate" exit="exit" className="w-full">
                                    <ParticipantCard
                                        p={p}
                                        localParticipant={localParticipant}
                                        token={token}
                                        localAvatarUrl={localAvatarUrl}
                                        remoteAvatarUrl={activeChatAvatarUrl}
                                        isLocalDeafened={isLocalDeafened}
                                        compact={false}
                                        sizeMode="row"
                                        isLocalMuted={localMutedParticipantIds.has(p.identity)}
                                        onToggleLocalMute={(v) => toggleParticipantLocalMute(p.identity, v)}
                                        isHiddenVideo={hiddenVideoIds.has(p.identity)}
                                        isHiddenScreenShare={hiddenScreenShareIds.has(p.identity)}
                                        onHideVideoChange={(v) => toggleHideVideo(p.identity, v)}
                                        onHideScreenShareChange={(v) => toggleHideScreenShare(p.identity, v)}
                                        isGroup={isGroup}
                                        fallbackAvatars={fallbackAvatars}
                                        roleColor={memberRoleColors?.[p.identity] ?? undefined}
                                        canServerMute={canServerMute}
                                        onServerMuteTrack={onServerMuteTrack}
                                        showLocalPing
                                    />
                                </motion.div>
                            ))}
                            </AnimatePresence>
                        </div>
                        </motion.div>
                    ) : (
                        /* ── DM / group call tile grid ───────────────────────── */
                        <div className="flex-1 flex flex-row flex-wrap justify-center items-center content-center gap-x-8 gap-y-6">
                            <AnimatePresence mode="popLayout" initial={true}>
                            {audioOnlyParticipants.map(p => (
                                <motion.div key={p.identity} variants={tileItemVariants} initial="initial" animate="animate" exit="exit">
                                    <ParticipantCard
                                        p={p}
                                        localParticipant={localParticipant}
                                        token={token}
                                        localAvatarUrl={localAvatarUrl}
                                        remoteAvatarUrl={activeChatAvatarUrl}
                                        isLocalDeafened={isLocalDeafened}
                                        compact={false}
                                        sizeMode="normal"
                                        isLocalMuted={localMutedParticipantIds.has(p.identity)}
                                        onToggleLocalMute={(v) => toggleParticipantLocalMute(p.identity, v)}
                                        isHiddenVideo={hiddenVideoIds.has(p.identity)}
                                        isHiddenScreenShare={hiddenScreenShareIds.has(p.identity)}
                                        onHideVideoChange={(v) => toggleHideVideo(p.identity, v)}
                                        onHideScreenShareChange={(v) => toggleHideScreenShare(p.identity, v)}
                                        isGroup={isGroup}
                                        fallbackAvatars={fallbackAvatars}
                                        roleColor={memberRoleColors?.[p.identity] ?? undefined}
                                        canServerMute={canServerMute}
                                        onServerMuteTrack={onServerMuteTrack}
                                    />
                                </motion.div>
                            ))}
                            {isRinging && (
                                <motion.div
                                    key="ringing-tile"
                                    variants={tileItemVariants}
                                    initial="initial"
                                    animate="animate"
                                    exit="exit"
                                >
                                    <DummyRingingTile compact={false} />
                                </motion.div>
                            )}
                            </AnimatePresence>
                        </div>
                    )
                )}
            </div>

            {/* Compact strip — pinned below scroll area when video tiles need the space */}
            {anyVideo && isScrollable && (
                <motion.div
                    ref={audioOnlyStripRef}
                    variants={sidebarPillVariants}
                    initial="initial"
                    animate="animate"
                >
                    <AudioOnlyStrip
                        participants={audioOnlyParticipants}
                        localParticipant={localParticipant}
                        token={token}
                        localAvatarUrl={localAvatarUrl}
                        remoteAvatarUrl={activeChatAvatarUrl}
                        isLocalDeafened={isLocalDeafened}
                        isGroup={isGroup}
                        fallbackAvatars={fallbackAvatars}
                        localMutedParticipantIds={localMutedParticipantIds}
                        onToggleLocalMute={toggleParticipantLocalMute}
                        hiddenVideoIds={hiddenVideoIds}
                        hiddenScreenShareIds={hiddenScreenShareIds}
                        onHideVideoChange={toggleHideVideo}
                        onHideScreenShareChange={toggleHideScreenShare}
                        ringingElement={isRinging ? <DummyRingingTile compact={true} /> : undefined}
                        canServerMute={canServerMute}
                        onServerMuteTrack={onServerMuteTrack}
                    />
                </motion.div>
            )}

            {/* Pinned control bar — rendered via portal to the chat panel's
                bottom slot. The stats pill lives here too (right-aligned,
                above the controls) unless a focused stream has claimed the
                `#call-stats-root` slot.

                The encryption indicator lives in this SAME portal, right
                above the controls, rather than up with the other pills near
                the top of the call section: for a huddle call, the whole
                rest of this component's tree (`#call-sidebar-root`) is
                CSS-hidden — a dedicated participant list covers that case
                instead (ServerContextPanel / FloatingHuddleCard) — but
                `#call-controlbar-root` is its own separate portal target and
                stays visible regardless.

                Only 'degraded' actually renders here (2026-09-08, per owner
                feedback: the steady-state "Encrypted" pill was a duplicate —
                the Huddle channel row now carries that padlock, derived from
                this same gate, so a live call doesn't say it twice). The
                'connected' case renders nothing: it needs no action and no
                explanation, unlike 'degraded', which is the one state down
                here that still requires telling the user something (this
                device can't currently verify this room's key stayed
                current). See CallEncryptionIndicator.tsx. */}
            {(() => {
                const controlsEl = (
                    <div ref={controlBarRef}>
                        {/* Ordering is deliberate: 'mixed' outranks 'degraded'.
                            'degraded' means this device can't confirm the key
                            stayed current while the call IS encrypted; 'mixed'
                            means part of the call is genuinely in the clear.
                            Showing the milder one over the worse one would be
                            the exact overstatement this indicator exists to
                            stop. Both at once would be noise. */}
                        {unencryptedNames.length > 0 ? (
                            <CallEncryptionIndicator mode="mixed" unencryptedNames={unencryptedNames} />
                        ) : encryptionIndicatorMode === 'degraded' ? (
                            <CallEncryptionIndicator mode="degraded" />
                        ) : null}
                        <ControlBar
                            localParticipant={localParticipant}
                            isLocalDeafened={isLocalDeafened}
                            onToggleMic={toggleMic}
                            onToggleDeafen={toggleDeafen}
                            onToggleCamera={toggleCamera}
                            onToggleScreenshare={toggleScreenshare}
                            onOpenScreenSharePicker={openScreenSharePicker}
                            onAdjustScreenShareQuality={adjustScreenShareQuality}
                            onToggleScreenShareAudio={toggleScreenShareAudio}
                            currentShareResolution={currentShare?.resolution}
                            currentShareFrameRate={currentShare?.frameRate}
                            currentShareAudio={currentShare?.audio}
                            onLeave={handleLeave}
                            showFullscreenButton={anyVideo}
                            canSpeak={canSpeak}
                            canVideo={canVideo}
                            canScreenShare={canScreenShare}
                            serverMutedAudio={localServerMutedAudio}
                            serverMutedVideo={localServerMutedVideo}
                            serverMutedScreenShare={localServerMutedScreenShare}
                            isServerDeafened={baseServerDeafened}
                            voice={voice}
                        />
                    </div>
                );
                return activeControlsRoot ? ReactDOM.createPortal(controlsEl, activeControlsRoot) : controlsEl;
            })()}

            {/* Screen share picker */}
            {isScreenSharePickerOpen && (
                <ScreenSharePickerModal onSelect={handleScreenShareSelect} />
            )}

            {/* Solo inactivity kick dialog — a LIVE countdown with a "Leave Now"
                escape hatch, distinct from SoloKickDialog.tsx (the static
                after-the-fact "you were removed" notice Dashboard.tsx shows on
                the server-authoritative soloKickEvent WS path). This one is the
                PRIMARY trigger (see the "Solo inactivity kick" effect above for
                why); onInactivityWarning tells Dashboard this is happening so
                it can suppress SoloKickDialog if the server's own kick for the
                same session arrives while this is showing/has already fired —
                otherwise the two could show back-to-back for one kick. Kept as
                its own hand-rolled overlay rather than ClModal — it's
                portal-rendered over the call chrome specifically, same shape
                as the other in-call overlays here — just the colors were
                still raw Tailwind. */}
            {inactivityCountdown !== null && ReactDOM.createPortal(
                <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-cl-abyss/60 backdrop-blur-sm">
                    <div className="bg-cl-deep border border-cl-border rounded-2xl shadow-2xl p-6 flex flex-col items-center gap-4 max-w-xs w-full mx-4">
                        <div className="w-12 h-12 rounded-full bg-cl-glow/15 flex items-center justify-center">
                            <svg className="w-6 h-6 text-cl-glow" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3m0 3h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                            </svg>
                        </div>
                        <div className="text-center">
                            <p className="text-cl-text font-semibold text-sm">Removed due to inactivity</p>
                            <p className="text-cl-faint text-xs mt-1 leading-relaxed">
                                You've been alone in this call for 15 minutes.
                            </p>
                        </div>
                        <p className="text-cl-faint text-xs">Leaving in <span className="text-cl-text font-semibold tabular-nums">{inactivityCountdown}s</span></p>
                        <ClButton
                            variant="danger"
                            fullWidth
                            onClick={() => { setInactivityCountdown(null); handleLeave(); }}
                        >
                            Leave Now
                        </ClButton>
                    </div>
                </div>,
                document.body
            )}
        </motion.div>
    );
};
