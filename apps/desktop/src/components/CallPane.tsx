import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import '@livekit/components-styles';
import {
    LiveKitRoom,
    useParticipants,
    useLocalParticipant,
    useRoomContext,
} from '@livekit/components-react';
import { ExternalE2EEKeyProvider, VideoPresets, Track, RoomEvent, DisconnectReason, LocalAudioTrack, type TrackPublication, type RemoteTrackPublication } from 'livekit-client';
import { annotationStore } from '../utils/annotationStore';
import { useAnnotationTransport } from '../hooks/useAnnotationTransport';
import { AnnotationRequestsDock } from './call/AnnotationRequestsDock';
import type { RoomOptions, RoomConnectOptions, LocalTrackPublication } from 'livekit-client';
import e2eeWorkerUrl from 'livekit-client/e2ee-worker?worker&url';
import ReactDOM from 'react-dom';
import { SidebarConference } from './SidebarConference';
import { RemoteE2EEWatcher } from './RemoteE2EEWatcher';
import { EMPTY_REMOTE_ENCRYPTION, type RemoteEncryptionSnapshot } from '../utils/remoteE2EEWatch';
import type { CallEncryptionIndicatorMode } from './server/CallEncryptionIndicator';
import { useCallContextSafe } from '../contexts/CallContext';
import { useNotificationPrefs } from '../contexts/NotificationContext';
import { useToast } from '../contexts/ToastContext';
import { playSound, playLoopingSound } from '../utils/notificationSounds';
import { MIC_CAPTURE_CONSTRAINTS, resolveMicDeviceId } from '../utils/audioInput';
import type { VoiceSettingsHook } from '../hooks/useVoiceSettings';
import * as voiceProcessorManager from '../utils/voiceProcessorManager';
import * as audioHealth from '../utils/audioHealth';
import { setCurrentPipelineDbfs, resetPipelineDbfs } from '../utils/micLevelRegistry';
import { mapDisconnectReasonToUserMessage } from '../utils/callDisconnectReasons';
import { beginActivity, trackActivity } from '../utils/freezeLog';
import { stableE2EEOptions } from '../utils/e2eeRoomOptions';
import { describeE2EEActivationFailure, type E2EEActivationFailure } from '../utils/e2eeActivation';
import { E2EEActivator } from './E2EEActivator';
import { cameraCueForEvent } from '../utils/callTrackCues';
import { ROSTER_ONLY } from '../utils/callRosterEvents';
import { noteRemoteVideoSubscribed } from '../utils/remoteVideoDemand';

/**
 * Bridge: attaches the CipherlineVoiceProcessor to the mic track as soon as
 * its publication exists. Must live inside <LiveKitRoom> for useRoomContext.
 *
 * Why an event bridge and not `audioCaptureDefaults.processor`: livekit's
 * module-level createLocalTracks() calls track.setProcessor() before the track
 * has any audioContext, and LocalAudioTrack.setProcessor() hard-throws without
 * one — failing the whole join (the 1.0.12-staging.92 "Call connection failed
 * / Audio context needs to be set on LocalAudioTrack" bug; unchanged through
 * livekit-client 2.22.1). Here the publication already exists, and we pre-seed
 * the guard context ourselves so the throw is impossible regardless of whether
 * the room's own acquireAudioContext() has run yet.
 *
 * Attach is idempotent: getProcessor() short-circuits repeat events (mute
 * cycles restart the same track and keep its processor; a genuinely new track
 * publication arrives processor-less and gets one here).
 */
const MicProcessorBridge = ({ token, voice }: { token: string; voice?: VoiceSettingsHook }) => {
    const room = useRoomContext();
    // Latest-value ref: settings only matter for the one-time constructor
    // (live updates flow through voiceProcessorManager.updateSettings()), so
    // the attach effect must not re-run on every settings render.
    const voiceRef = useRef(voice);
    useEffect(() => { voiceRef.current = voice; });
    const hasVoice = !!voice;

    useEffect(() => {
        if (!hasVoice) return;
        let cancelled = false;

        const attachTo = async (track: LocalAudioTrack) => {
            if (cancelled || track.getProcessor()) return;
            const v = voiceRef.current;
            if (!v) return;
            // audioContext is `protected` upstream; the public setter is the
            // supported way in, we only need to read whether it's been set.
            if (!(track as unknown as { audioContext?: AudioContext }).audioContext) {
                track.setAudioContext(voiceProcessorManager.getGuardAudioContext());
            }
            const proc = voiceProcessorManager.getOrCreate(token, v.settings);
            try {
                // Cast: CipherlineVoiceProcessor's opts typing is looser than
                // TrackProcessor's (same cast as the camera call site).
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await trackActivity('call:mic-processor', () => track.setProcessor(proc as any));
                console.log('[CallPane] Voice processor attached to mic track');
            } catch (err) {
                // Degrade to raw mic rather than failing the call — the same
                // philosophy as voiceProcessor.init()'s internal hardening.
                console.error('[CallPane] Voice processor attach failed — continuing with raw mic:', err);
            }
        };

        const onPublished = (pub: LocalTrackPublication) => {
            if (pub.source === Track.Source.Microphone && pub.track instanceof LocalAudioTrack) {
                void attachTo(pub.track);
            }
        };

        // The mic usually publishes after this effect subscribes (connect +
        // getUserMedia are slow), but scan existing publications so a faster
        // publish can never slip through unattached.
        room.localParticipant.audioTrackPublications.forEach(pub => onPublished(pub));
        room.on(RoomEvent.LocalTrackPublished, onPublished);
        return () => {
            cancelled = true;
            room.off(RoomEvent.LocalTrackPublished, onPublished);
        };
    }, [room, token, hasVoice]);

    return null;
};

/** Bridge: must live inside <LiveKitRoom> to access LiveKit hooks */
const CallSpeakingReporter = ({
    onChange,
    onParticipantCount,
}: {
    onChange: (map: Record<string, boolean>) => void;
    onParticipantCount: (count: number) => void;
}) => {
    const participants = useParticipants();
    const { localParticipant } = useLocalParticipant();

    // Stable dependency string avoids excessive re-renders
    const speakingKey = participants.map(p => `${p.identity}:${p.isSpeaking}`).join(',');

    useEffect(() => {
        const map: Record<string, boolean> = {};
        participants.forEach(p => { map[p.identity] = p.isSpeaking; });
        // Include local participant (isSpeaking reflects mic activity)
        if (localParticipant) map[localParticipant.identity] = localParticipant.isSpeaking;
        onChange(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [speakingKey]);

    useEffect(() => {
        onParticipantCount(participants.length);
    }, [participants.length, onParticipantCount]);

    return null;
};


interface CallPaneProps {
    livekitUrl: string;
    token: string;
    apiToken: string;
    e2eeKeyB64: string;
    onDisconnect: () => void;
    /** Forwarded to SidebarConference's onInactivityWarning — see its doc
     *  comment for why Dashboard needs this to avoid a duplicate SoloKickDialog. */
    onInactivityWarning?: (active: boolean) => void;
    onVideoActive?: (active: boolean) => void;
    videoByDefault?: boolean;
    isCallInitiator?: boolean;
    onSpeakingChange?: (map: Record<string, boolean>) => void;
    onParticipantCount?: (count: number) => void;
    localAvatarUrl?: string;
    activeChatAvatarUrl?: string;
    activeChatUserId?: string;
    activeChatTitle?: string;
    sessionId?: string;
    isGroup?: boolean;
    /** Passed through to SidebarConference to skip the ringing state. */
    noRinging?: boolean;
    /** True for a Huddle call — see SidebarConference's isHuddle doc comment
     *  for why this must be forwarded (a huddle's sessionId has no matching
     *  call_sessions row; POSTing it to /calls/:id/end 404s). */
    isHuddle?: boolean;
    onFocusedStreamChange?: (active: boolean) => void;
    /** True while the call is still the active call (activeCall !== null).
     *  Becomes false during the callPaneActive grace window after leaving.
     *  Used to distinguish "root moved because of a view switch" (isActive=true,
     *  safe to re-find) from "root gone because the call ended" (isActive=false,
     *  apply the ghost-prevent guard). */
    isActive?: boolean;
    voice?: VoiceSettingsHook;
    /** userId → hex role colour, forwarded to SidebarConference → ParticipantCard. */
    memberRoleColors?: Record<string, string | null>;
    /** userId → avatar attachment ID for all server members. Pre-seeds fallbackAvatars in SidebarConference. */
    memberAvatarMap?: Record<string, string | null>;
    /** True when the local user has MUTE_MEMBERS in the active server call.
     *  Forwarded all the way to PopoverMenu to show server-mute controls. */
    canServerMute?: boolean;
    /** Forwarded to SidebarConference → ParticipantCard → PopoverMenu. */
    onServerMuteTrack?: (targetUserId: string, trackType: 'audio' | 'video' | 'screenshare' | 'deafen', muted: boolean) => void;
    /** Resolved channel-level permissions for the call's voice/huddle channel.
     *  Forwarded to SidebarConference → ControlBar so SPEAK / VIDEO / SCREEN_SHARE
     *  controls are pre-disabled when denied. Undefined for DM/group calls. */
    channelPermissions?: bigint;
    /** Small in-call encryption indicator, forwarded to SidebarConference.
     *  CallPane only ever mounts once a real key is in hand (Dashboard's mount
     *  gate refuses an empty one), so this is always 'connected' or 'degraded'
     *  — never a loading state, which renders separately, pre-mount, in
     *  Dashboard itself. See CallEncryptionIndicator.tsx. */
    encryptionIndicatorMode: Extract<CallEncryptionIndicatorMode, 'connected' | 'degraded'>;
    /** Fired whenever the set of REMOTE participants publishing unencrypted
     *  media changes. Lets Dashboard downgrade the channel-row padlock, which
     *  otherwise reports only this device's own key state and would stay green
     *  through a partly-plaintext call. See utils/remoteE2EEWatch.ts. */
    onRemoteEncryptionChange?: (snapshot: RemoteEncryptionSnapshot) => void;
}

const CallAudioEffects = ({ isInitiator, noRinging }: { isInitiator?: boolean; noRinging?: boolean }) => {
    const participants = useParticipants(ROSTER_ONLY); // only .length is read — see utils/callRosterEvents.ts
    const prevCountRef = useRef(participants.length);
    const [hasConnectedOnce, setHasConnectedOnce] = useState(false);

    // P2-REND-5: route all cues through playSound so notification prefs are respected.
    const notifPrefs = useNotificationPrefs();
    const notifPrefsRef = useRef(notifPrefs);
    notifPrefsRef.current = notifPrefs;
    // useNotificationPrefs() returns { prefs, updatePrefs, resetPrefs } — the
    // sound settings are nested under .prefs, not flattened onto the hook
    // result. Reading them off the top level yielded undefined for all three,
    // and playSound's `if (prefs && !prefs.sounds_enabled) return` reads that
    // as "sounds are off" — so every call cue in this file was silently
    // no-op'ing. Identical mistake to the one fixed in SidebarConference;
    // TypeScript had been flagging both as TS2339 all along.
    //
    // Hands over the WHOLE prefs object rather than picking out the three
    // fields playSound needed at the time: NotificationPrefs is a superset of
    // SoundsPrefs, and the field-picking version silently dropped
    // `sound_groups` when sound groups were added — which un-gates every cue in
    // this file, all of which live in the collapsed "App sounds" group.
    const soundsPrefs = () => notifPrefsRef.current.prefs;

    useEffect(() => {
        if (participants.length > 1) {
            setHasConnectedOnce(true);
        }
    }, [participants.length]);

    // Play join sound on first mount — this is the "you just joined" cue for
    // DM and group calls (noRinging=false). Those calls start fast enough that
    // the component mounts while the browser still has a user-gesture context.
    //
    // Voice channels and huddles (noRinging=true) mount AFTER an async API
    // round-trip, which resets the autoplay gate. Dashboard.tsx plays the
    // sound immediately on click for those paths instead.
    useEffect(() => {
        if (noRinging) return;
        playSound('join', soundsPrefs());
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Gate participant-count join sounds for 2s after mount. When we join a
    // call that already has people in it, LiveKit discovers those participants
    // sequentially — each discovery increments the count and would otherwise
    // trigger a join sound for every existing member. The 2s window covers the
    // initial participant sync burst; genuine "someone joined after I settled"
    // events happen later and play correctly.
    const soundReadyRef = useRef(false);
    useEffect(() => {
        const t = setTimeout(() => { soundReadyRef.current = true; }, 2000);
        return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (participants.length > prevCountRef.current && participants.length > 1) {
            // Someone else joined while we are already in the call.
            if (soundReadyRef.current) {
                playSound('join', soundsPrefs());
            }
        } else if (participants.length < prevCountRef.current) {
            playSound('leave', soundsPrefs());
        }
        prevCountRef.current = participants.length;
    }, [participants.length]);

    // ── Screenshare + camera start/stop cues ────────────────────────────────
    // Bilateral by construction: every listener below is registered so the
    // SAME handler fires once for whoever performed the action AND once for
    // every other participant's own CallAudioEffects instance — nobody
    // double-hears their own cue, and nobody is left out. Two different
    // wirings make that true, because LiveKit's local/remote event split is
    // not consistent across event types:
    //  - TrackPublished/TrackUnpublished fire for REMOTE participants only —
    //    the Local* variants (LocalTrackPublished/LocalTrackUnpublished) are
    //    the local-only counterpart, so both are registered below.
    //  - TrackMuted/TrackUnmuted fire for BOTH local and remote through the
    //    same RoomEvent — there is no separate Local* variant to also
    //    register (registering one would double-fire the local user).
    // This is why toggleCamera in SidebarConference no longer calls
    // playSound directly (see its comment) — doing so here AND there would
    // double-fire for the actor.
    //
    // Play cue sounds IMMEDIATELY on real start/stop, and suppress them when
    // someone is just republishing (Change Source / Adjust Quality / toggle
    // audio). The sharer broadcasts a small `ss-adjust` data packet right
    // before republishing — we hold an `isAdjusting` flag per identity for a
    // short window after that, which both the TrackUnpublished and the
    // follow-up TrackPublished land inside. No debounce, no lag for genuine
    // events. (Camera has no republish-adjust concept — device switches use
    // restartTrack(), which never unpublishes — so isAdjusting is only ever
    // consulted for ScreenShare below.)
    const room = useRoomContext();
    // In-call annotations: strokes, grants, snapshots over LiveKit data
    // messages (docs/video-annotation-design.md). The hook owns the sockets;
    // nothing is published unless someone draws or asks.
    useAnnotationTransport(room);
    const callCtx = useCallContextSafe();
    // A remote video nobody puts on screen (other view, hidden video, the
    // panel scrolled) gets paused at the SFU instead of decrypted + decoded
    // for nothing; on-screen tiles resume it. See utils/remoteVideoDemand.ts.
    useEffect(() => {
        if (!room) return;
        const onSubscribed = (track: { kind: Track.Kind }, pub: RemoteTrackPublication) => {
            if (track.kind === Track.Kind.Video) noteRemoteVideoSubscribed(pub);
        };
        room.remoteParticipants.forEach(p => p.videoTrackPublications.forEach(pub => {
            if (pub.isSubscribed) noteRemoteVideoSubscribed(pub);
        }));
        room.on(RoomEvent.TrackSubscribed, onSubscribed);
        return () => { room.off(RoomEvent.TrackSubscribed, onSubscribed); };
    }, [room]);
    // Capture the adjusting helpers in a ref so the effect below only depends
    // on `room` — NOT on callCtx's object identity (which changes whenever
    // focus/fullscreen/etc. mutate). Without this, the effect would re-run
    // and reset its 500 ms ready timer every focus toggle, and legitimate
    // start/stop cues that happen to land inside those windows get eaten.
    const ctxRef = useRef(callCtx);
    ctxRef.current = callCtx;
    const readyRef = useRef(false);
    useEffect(() => {
        if (!room) return;

        const onData = (payload: Uint8Array, participant?: { identity: string }) => {
            try {
                const msg = JSON.parse(new TextDecoder().decode(payload));
                if (msg?.type === 'ss-adjust' && participant?.identity) {
                    // Grace window longer than the worst-case republish gap in
                    // handleScreenShareSelect (50 ms sleep + stop + start +
                    // native-audio restart ≈ a few hundred ms). 2s is generous
                    // without being long enough to mask genuine stop cues.
                    ctxRef.current?.markAdjusting(participant.identity, 2000);
                }
            } catch { /* ignore malformed packets */ }
        };

        // Mirror for the sharer themselves — LiveKit doesn't deliver a
        // participant's own data packets back, so SidebarConference fires
        // this window event alongside the data broadcast.
        const onLocalAdjust = (e: Event) => {
            const identity = (e as CustomEvent).detail?.identity;
            if (identity) ctxRef.current?.markAdjusting(identity, 2000);
        };

        const onTrackPublished = (pub: any, participant: { identity: string }) => {
            if (!readyRef.current) return;
            if (pub?.source === Track.Source.ScreenShare) {
                if (ctxRef.current?.isAdjusting(participant.identity)) return;
                playSound('screenshare_on', soundsPrefs());
            } else if (pub?.source === Track.Source.Camera) {
                // A track publish only happens the FIRST time someone turns
                // their camera on in a call — every toggle after that is a
                // mute/unmute of the same publication (see onTrackMuted /
                // onTrackUnmuted below, and callTrackCues.ts's header for why).
                const cue = cameraCueForEvent('published', readyRef.current);
                if (cue) playSound(cue, soundsPrefs());
            }
        };

        // Pending screenshare-end cues, keyed by participant identity. LiveKit
        // fires TrackUnpublished BEFORE ParticipantDisconnected when someone
        // leaves while screensharing — so at the moment we'd play the cue we
        // don't yet know a leave is coming. We schedule the cue with a short
        // delay, and if a ParticipantDisconnected arrives for that same
        // identity in the meantime, we cancel it. Result: a clean solo
        // leave_call.wav when someone sharing leaves, and an un-delayed
        // screenshare_ended.wav when someone just stops sharing.
        //
        // Camera does NOT need this dance and TrackUnpublished is deliberately
        // ignored for it below: a camera publication is only ever unpublished
        // as part of the SAME participant-departure teardown that screenshare
        // guards against (setCameraEnabled(false) only ever mutes, never
        // unpublishes — see callTrackCues.ts), so there is no "someone stopped
        // their camera but is still here" case to disambiguate from a leave.
        // Reacting to it would just double up camera_off with every leave cue
        // for a participant whose camera happened to be on.
        const pendingSsEndTimers = new Map<string, ReturnType<typeof setTimeout>>();

        const onTrackUnpublished = (pub: any, participant: { identity: string }) => {
            if (!readyRef.current) return;
            if (pub?.source !== Track.Source.ScreenShare) return;
            if (ctxRef.current?.isAdjusting(participant.identity)) return;
            // Clear any earlier pending cue for this identity (extremely rare
            // but harmless) and schedule a new one.
            const prev = pendingSsEndTimers.get(participant.identity);
            if (prev) clearTimeout(prev);
            const timer = setTimeout(() => {
                pendingSsEndTimers.delete(participant.identity);
                playSound('screenshare_off', soundsPrefs());
            }, 200); // 200 ms: imperceptible for a notification cue, long enough
                     //         to catch a ParticipantDisconnected that follows.
            pendingSsEndTimers.set(participant.identity, timer);
        };

        // Camera on/off AFTER the first publish is a mute/unmute of the
        // existing publication, not a publish/unpublish cycle — see
        // callTrackCues.ts. `RoomEvent.TrackMuted`/`TrackUnmuted` (unlike
        // TrackPublished) already fire for BOTH local and remote participants
        // through the same registration, so — unlike the Published/Unpublished
        // pair above — there is no separate Local* variant to also register.
        // Filtering to Camera here is also what keeps this from firing on a
        // microphone mute/unmute, which must stay local-only (see
        // SidebarConference's toggleMic).
        const onTrackMuted = (pub: TrackPublication) => {
            if (pub?.source !== Track.Source.Camera) return;
            const cue = cameraCueForEvent('muted', readyRef.current);
            if (cue) playSound(cue, soundsPrefs());
        };
        const onTrackUnmuted = (pub: TrackPublication) => {
            if (pub?.source !== Track.Source.Camera) return;
            const cue = cameraCueForEvent('unmuted', readyRef.current);
            if (cue) playSound(cue, soundsPrefs());
        };

        const onParticipantDisconnected = (participant: { identity: string }) => {
            // Cancel any pending screenshare-end cue — the participant-count
            // change in the other effect will play leave_call.wav instead.
            const timer = pendingSsEndTimers.get(participant.identity);
            if (timer) {
                clearTimeout(timer);
                pendingSsEndTimers.delete(participant.identity);
            }
        };

        // Re-arm the ready gate around a full LiveKit reconnect. On a full
        // reconnect (as opposed to the common fast-resume path) the Room tears
        // down and re-adds every remote participant internally, which can
        // re-fire TrackPublished for tracks that were already on before the
        // blip — identical in shape to the join-storm this gate already
        // exists for. Closing the gate the instant reconnection starts, and
        // reopening it 500ms after the Room says it's back (same settle
        // window as the initial mount below), keeps a network hiccup from
        // replaying camera_on/screenshare_on cues for people who were already
        // there.
        let reconnectReadyTimer: ReturnType<typeof setTimeout> | undefined;
        const onReconnecting = () => {
            readyRef.current = false;
            if (reconnectReadyTimer) clearTimeout(reconnectReadyTimer);
        };
        const onReconnected = () => {
            reconnectReadyTimer = setTimeout(() => { readyRef.current = true; }, 500);
        };

        // `RoomEvent.*Published` fires for BOTH local and remote participants.
        // The LocalTrack* variants also exist — register those separately so
        // the sharer hears their own start/stop cues too.
        room.on(RoomEvent.DataReceived, onData);
        room.on(RoomEvent.TrackPublished,   onTrackPublished);
        room.on(RoomEvent.TrackUnpublished, onTrackUnpublished);
        room.on(RoomEvent.LocalTrackPublished,   onTrackPublished);
        room.on(RoomEvent.LocalTrackUnpublished, onTrackUnpublished);
        room.on(RoomEvent.TrackMuted,   onTrackMuted);
        room.on(RoomEvent.TrackUnmuted, onTrackUnmuted);
        room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
        room.on(RoomEvent.Reconnecting, onReconnecting);
        room.on(RoomEvent.Reconnected,  onReconnected);
        window.addEventListener('cipherline:ss-adjust', onLocalAdjust);

        // Defer enabling the cues past the first microtask so publications
        // already in progress at mount time don't play a spurious "started".
        const readyTimer = setTimeout(() => { readyRef.current = true; }, 500);

        return () => {
            clearTimeout(readyTimer);
            if (reconnectReadyTimer) clearTimeout(reconnectReadyTimer);
            readyRef.current = false;
            // Flush any still-pending screenshare-end cues so we don't leak them.
            for (const t of pendingSsEndTimers.values()) clearTimeout(t);
            pendingSsEndTimers.clear();
            room.off(RoomEvent.DataReceived, onData);
            room.off(RoomEvent.TrackPublished,   onTrackPublished);
            room.off(RoomEvent.TrackUnpublished, onTrackUnpublished);
            room.off(RoomEvent.LocalTrackPublished,   onTrackPublished);
            room.off(RoomEvent.LocalTrackUnpublished, onTrackUnpublished);
            room.off(RoomEvent.TrackMuted,   onTrackMuted);
            room.off(RoomEvent.TrackUnmuted, onTrackUnmuted);
            room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
            room.off(RoomEvent.Reconnecting, onReconnecting);
            room.off(RoomEvent.Reconnected,  onReconnected);
            window.removeEventListener('cipherline:ss-adjust', onLocalAdjust);
        };
    }, [room]);

    useEffect(() => {
        if (isInitiator && !noRinging && participants.length <= 1 && !hasConnectedOnce) {
            // Was a bare `new Audio(...)` with no pref check at all, so a user
            // who had turned every sound off still got 15 seconds of looping
            // ringback. playLoopingSound returns a no-op stopper when the
            // category is muted, so the cleanup path stays identical.
            const stop = playLoopingSound('ringing', soundsPrefs());
            const timeout = setTimeout(stop, 15000);

            return () => {
                clearTimeout(timeout);
                stop();
            };
        }
    }, [isInitiator, noRinging, participants.length, hasConnectedOnce]);

    // The streamer's Allow / Decline, visible in every view (the per-tile
    // menu only exists on their own focused tile). Empty until someone asks.
    return <AnnotationRequestsDock me={room.localParticipant.identity} />;
};

export const CallPane = ({
    livekitUrl,
    token,
    apiToken,
    e2eeKeyB64,
    onDisconnect,
    onInactivityWarning,
    videoByDefault = false,
    isCallInitiator,
    onSpeakingChange,
    onParticipantCount,
    localAvatarUrl,
    activeChatAvatarUrl,
    activeChatUserId,
    activeChatTitle,
    sessionId,
    isGroup,
    noRinging,
    isHuddle,
    onFocusedStreamChange,
    voice,
    memberRoleColors,
    memberAvatarMap,
    canServerMute,
    onServerMuteTrack,
    isActive = true,
    channelPermissions,
    encryptionIndicatorMode,
    onRemoteEncryptionChange,
}: CallPaneProps) => {
    const [keyProvider] = useState(() => new ExternalE2EEKeyProvider());

    // ── Render isolation from Dashboard ─────────────────────────────────────
    // Dashboard (the app-wide monolith) renders this component inline, so it
    // re-renders on EVERY Dashboard state change — a message arriving, a
    // typing indicator, a presence update, every navigation click. Each of
    // those used to cascade through <LiveKitRoom> into the whole call UI
    // (SidebarConference: every tile, card, control bar, focused banner),
    // because three of the props it forwards were fresh closures / fresh `{}`
    // on every Dashboard render. The call UI is memoized below; these make its
    // props actually stable: callbacks go through a latest-value ref (always
    // calls the newest Dashboard handler, identity never changes), and an
    // empty member map collapses to one shared constant.
    const latestCallbacksRef = useRef({ onDisconnect, onInactivityWarning, onServerMuteTrack });
    useLayoutEffect(() => {
        latestCallbacksRef.current = { onDisconnect, onInactivityWarning, onServerMuteTrack };
    });
    const stableOnLeave = useCallback((wasLastPerson?: boolean) => {
        (latestCallbacksRef.current.onDisconnect as (wasLastPerson?: boolean) => void)(wasLastPerson);
    }, []);
    const stableOnInactivityWarning = useCallback((active: boolean) => {
        latestCallbacksRef.current.onInactivityWarning?.(active);
    }, []);
    const stableOnServerMuteTrack = useCallback((targetUserId: string, trackType: 'audio' | 'video' | 'screenshare' | 'deafen', muted: boolean) => {
        latestCallbacksRef.current.onServerMuteTrack?.(targetUserId, trackType, muted);
    }, []);
    const stableRoleColors = memberRoleColors && Object.keys(memberRoleColors).length > 0 ? memberRoleColors : EMPTY_MEMBER_MAP;
    const stableAvatarMap = memberAvatarMap && Object.keys(memberAvatarMap).length > 0 ? memberAvatarMap : EMPTY_MEMBER_MAP;

    // Which remote participants are sending in the clear (older build, no
    // call-E2EE support). Observed, never enforced — see RemoteE2EEWatcher.
    const [remoteEncryption, setRemoteEncryption] = useState<RemoteEncryptionSnapshot>(EMPTY_REMOTE_ENCRYPTION);
    // Annotations are call-scoped and never persisted: everything drawn on
    // any tile dies with the call. CallPane mounts/unmounts in lockstep with
    // activeCall (see Dashboard), so its unmount is "the call ended".
    useEffect(() => () => { annotationStore.reset(); }, []);
    // Performance log (Settings → Advanced): label UI stalls that happen
    // while this call is joining / live, so a capture from a user's machine
    // says "during call join" or "in a call" instead of nothing.
    const endJoinActivityRef = useRef<(() => void) | null>(null);
    useEffect(() => {
        const endInCall = beginActivity('call:in-call');
        const endJoin = beginActivity('call:join');
        endJoinActivityRef.current = endJoin;
        const joinCap = window.setTimeout(endJoin, 20_000); // never label a whole call as "joining"
        return () => { window.clearTimeout(joinCap); endJoin(); endInCall(); };
    }, []);
    const toast = useToast();

    // ── Capture device ids, ONCE, at mount ────────────────────────────────────
    // These are deliberately NOT reactive and deliberately NOT in roomOptions'
    // dependency array. @livekit/components-react's useLiveKitRoom recreates the
    // whole Room whenever JSON.stringify(options) changes:
    //
    //     useEffect(() => { setRoom(passedRoom ?? new Room(options)) },
    //               [passedRoom, JSON.stringify(options, replacer)])
    //
    // and its sibling cleanup disconnects the outgoing room. So while
    // audioCaptureDefaults.deviceId tracked the live setting, picking a
    // different mic mid-call silently tore down the entire call — new
    // PeerConnection, full renegotiation, everyone saw you leave and rejoin —
    // rather than swapping the input.
    //
    // Live device changes are applied in place instead, by SidebarConference's
    // switchActiveDevice sync (which also handles unplugged devices and OS
    // default changes). Only the INITIAL capture device belongs here.
    // Lazy useState rather than a ref: same capture-once semantics, but reading
    // a ref during render is (correctly) flagged by react-hooks/refs.
    const [initialMicDeviceId] = useState(() => resolveMicDeviceId(voice?.settings.micDeviceId));
    const [initialCameraDeviceId] = useState(() => voice?.settings.cameraDeviceId || undefined);

    // ── Connection-failure / timeout guard ────────────────────────────────
    // LiveKitRoom's `connect={true}` starts negotiating the instant this
    // component mounts. Two ways that can silently go nowhere: an explicit
    // WebRTC/signaling error (onError fires), or the connection just hangs
    // (bad NAT/firewall traversal, dead SFU) with neither onConnected nor
    // onError ever firing — the user would be stuck on "Connecting…"
    // forever with no feedback. Guard both: a hard timeout as a backstop,
    // plus onError for the cases that do report themselves.
    //
    // Refs (not state) so nothing here re-triggers a render or restarts the
    // timer on unrelated prop changes — this must fire exactly once per
    // mount. Dashboard gives CallPane a fresh `key={call.id}` per join, so
    // a new attempt is always a fresh mount or a fresh timer.
    const hasConnectedRef = useRef(false);
    const hasFailedRef = useRef(false);
    const failConnection = (message: string) => {
        if (hasFailedRef.current || hasConnectedRef.current) return;
        hasFailedRef.current = true;
        toast.push({ kind: 'error', title: 'Call connection failed', message });
        onDisconnect();
    };
    // Fail CLOSED on any E2EE activation failure — before OR after connect
    // (unlike failConnection, this is not gated on hasConnectedRef: a worker
    // that never acknowledges, or a track that the server records as
    // plaintext, can only be observed once we are connected). Leaving the
    // call is the only honest option: the UI presents every keyed call as
    // end-to-end encrypted, and a call that continues unencrypted under that
    // badge is strictly worse than a dropped one the user can retry. There is
    // no plaintext fallback and there must never be one.
    const failEncryption = (failure: E2EEActivationFailure) => {
        if (hasFailedRef.current) return;
        hasFailedRef.current = true;
        console.error('[CallPane] E2EE activation failed — leaving the call rather than continuing unencrypted:', failure);
        toast.push({ kind: 'error', title: 'Call not encrypted', message: describeE2EEActivationFailure(failure) });
        onDisconnect();
    };
    useEffect(() => {
        const CONNECT_TIMEOUT_MS = 15000;
        const timer = window.setTimeout(() => {
            // Reliability audit (Phase L): a hard timeout this early is the
            // signature of ICE never completing at all, not a slow-but-
            // working connection — the most common real cause is a firewall
            // (corporate/campus/hotel) blocking LiveKit's media ports
            // outright, which no amount of retrying fixes client-side (see
            // livekit.prod.yaml's `turn:` block for the server-side TURN
            // fallback this hints at, when the server has it configured).
            failConnection("Couldn't connect — check your network and try again. If you're on a restrictive network (corporate/hotel Wi-Fi, some VPNs), it may be blocking the call's connection.");
        }, CONNECT_TIMEOUT_MS);
        return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The room key is installed on `keyProvider` by <E2EEActivator> below —
    // the SAME component that activates encryption — so "key installed" is a
    // promise activation awaits, not a separate effect it races. Nothing else
    // may put a key on the provider (pinned by e2eeActivationWiring.test.ts).

    // ── Voice processor callbacks ─────────────────────────────────────────
    // Cheap to re-point on every render — see voiceProcessorManager's
    // stableCallbacks indirection for why this doesn't need to be memoized
    // against the processor's own lifecycle.
    useEffect(() => {
        voiceProcessorManager.updateCallbacks({
            onVadProbability: voice?.setVadProbability,
            onInputLevel: (dbfs) => {
                voice?.setCurrentInputLevel(dbfs);
                setCurrentPipelineDbfs(dbfs);
            },
            onNsAutoBypass: (active) => {
                audioHealth.recordNsAutoBypass(active);
                toast.push(active ? {
                    kind: 'warning',
                    title: 'Noise suppression paused',
                    message: 'Your device is under heavy load — background noise may come through until it recovers.',
                    durationMs: 0, // sticky while active
                } : {
                    kind: 'success',
                    title: 'Noise suppression resumed',
                    message: 'Back to normal.',
                });
            },
            onNsUnavailable: () => {
                audioHealth.recordNsUnavailable();
                toast.push({
                    kind: 'warning',
                    title: 'Noise suppression unavailable',
                    message: "Couldn't start noise suppression for this call — your voice is still being sent, just unprocessed.",
                });
            },
            onNsStats: (stats) => audioHealth.recordNsStats(stats),
            onAgcStats: (stats) => audioHealth.recordAgcStats(stats),
        });
    }, [voice, toast]);

    // ── Audio health diagnostics ────────────────────────────────────────────
    // Reset counters at the start of every call so a previous call's underrun/
    // bypass counts don't bleed into this one's — and log a one-line summary
    // on disconnect, so a regression in the fixes from this pass (repeated
    // underruns, auto-bypass trips, an unavailable pipeline) shows up in logs
    // even when nobody happened to notice it live.
    useEffect(() => {
        audioHealth.resetForCall();
        resetPipelineDbfs();
    }, []);

    // ── Voice processor teardown ──────────────────────────────────────────
    // Backstop for onDisconnected below — covers paths where the room
    // disconnects without that callback firing (e.g. an error before
    // connection) or the component unmounts directly.
    useEffect(() => {
        return () => { void voiceProcessorManager.destroyForCall(token); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ICE config: livekit-client's defaults probe Google + Twilio public
    // STUN servers (stun.l.google.com, global.stun.twilio.com). On a LAN
    // dev box where DNS for those is filtered/blocked we get a flood of
    // `Failed to resolve address ... errorcode: -105` errors in the
    // Electron console — and they're useless to us anyway: peers reach
    // the LiveKit SFU directly via 7881/TCP + 7882/UDP on the dev box's
    // LAN IP (livekit.yaml: use_external_ip:false, node_ip:LAN).
    //
    // Empty iceServers ⇒ rely solely on the SFU-delivered list. For
    // self-hosted dev that list is empty (turn.enabled:false in
    // livekit.yaml), which is fine for LAN. When TURN is enabled in
    // prod, the SFU will inject TURN creds at JoinResponse time and
    // they take effect on top of this baseline.
    //
    // NOTE: rtcConfig lives on RoomConnectOptions (passed to Room.connect()),
    // not RoomOptions (passed to `new Room()`) — see connectOptions below.
    const connectOptions = useMemo((): RoomConnectOptions => ({
        rtcConfig: { iceServers: [] },
    }), []);

    const roomOptions = useMemo((): RoomOptions => ({
        // adaptiveStream: LiveKit observes every <video> element attached via track.attach(),
        // takes the MAX across all visible tiles, multiplies by the real devicePixelRatio
        // ('screen'), and sends UpdateTrackSettings to the SFU so only the simulcast layer
        // each subscriber actually needs is forwarded. pixelDensity:'screen' replaces the
        // default cap of 1× (which under-reports on Retina/4K displays and requests
        // lower quality than the tile actually renders at).
        adaptiveStream: false,   // explicit setVideoQuality per tile replaces dimension-based adaptation
        // dynacast: false — keep all simulcast layers always publishing.
        // With dynacast: true, the SFU tells the publisher to DROP unused layers when sidebar
        // tiles request LOW. When a tile is then focused and requests HIGH, the publisher has to
        // cold-start the HIGH VP8 encoder and wait for a keyframe — this can take 2–5 s and
        // often never fully ramps up before the user unfocuses. With dynacast: false, all three
        // simulcast layers are always live; the SFU just routes a different one instantly.
        // The publisher pays ~2 Mbps extra upload for the unused layers, which is acceptable
        // for small group calls on modern connections.
        dynacast: false,
        videoCaptureDefaults: {
            resolution: VideoPresets.h720.resolution,
            deviceId: initialCameraDeviceId,
        },
        publishDefaults: {
            // simulcast: true is the gate that makes computeVideoEncodings() actually build
            // multiple RTCRtpEncodingParameters entries. Without it the function hits the
            // `if (!useSimulcast) return [videoEncoding]` early-exit and publishes a single
            // stream regardless of what videoSimulcastLayers / screenShareSimulcastLayers say.
            simulcast: true,
            videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360, VideoPresets.h720],
            // Screen share simulcast is not used — browsers rarely honour simulcast on
            // getDisplayMedia tracks. Screen share quality is always requested at HIGH on the
            // subscriber side (see VideoTile.tsx isScreenShare branch). Screen shares carry
            // their OWN publish options (codec, screenShareEncoding, degradationPreference —
            // utils/screenShare.ts buildScreenSharePublishOptions), so nothing screen-share
            // specific belongs here; note that leaving screenShareEncoding unset at BOTH
            // levels makes LiveKit publish a share at its default of 2.5 Mbps / 15 fps.
            // We intentionally do NOT set videoCodec here globally, because camera simulcast
            // relies on VP8/H.264's independent-layer model (VP9 uses SVC which behaves differently).
            // RED (RFC 2198 redundant audio) adds latency and bandwidth in
            // exchange for surviving BURST packet loss — a real tradeoff, not
            // an obviously-wrong one: production voice apps split roughly
            // along "prioritize latency + rely on Opus's built-in in-band FEC
            // for scattered loss" (this app's choice, and Discord's) vs.
            // "prioritize burst-loss resilience on genuinely lossy links" at
            // the cost of latency/bandwidth (RED). The setting that actually
            // matters most for the common case is Opus's in-band FEC
            // (`useinbandfec=1`), NOT RED — neither LiveKit nor this codebase
            // munges that fmtp parameter anywhere (verified: no SDP/codec
            // option touches it), so it rides on Chromium's own Opus default,
            // which has shipped `useinbandfec=1` since WebRTC's earliest
            // Opus support and has not changed across any Chromium version
            // since. Net effect: scattered loss (the common case on real
            // wifi/LTE) is already covered by FEC; RED stays off for the
            // burst-loss-on-a-genuinely-bad-link case, matching this app's
            // existing latency-over-redundancy stance elsewhere (see DTX
            // below). Confirm with a live SDP dump (chrome://webrtc-internals
            // equivalent, or console.log(pc.localDescription.sdp) once) if
            // this is ever in question — not verifiable from a static read.
            red: false,                       // RED redundancy adds latency, disable for gaming
            // DTX (discontinuous transmission) OFF for the mic. LiveKit defaults this
            // to true, but we already have our own silence suppressor — the voice-gate
            // worklet in voiceProcessor.ts — running upstream, so DTX on top of that
            // just stacks two independent decisions about when audio is "silence".
            // In practice that combination clipped the first syllable coming out of a
            // gate-open transition (DTX's own onset detection lagging the gate's) and
            // caused audible comfort-noise level jumps at the gate boundary — exactly
            // the kind of "inconsistent quality between speakers" this pass is fixing.
            // 7 participants × 64 kbps mono Opus with DTX off is a trivial bandwidth
            // cost either way.
            dtx: false,
            // Mic audio preset. LiveKit's default is ~32 kbps Opus which GCC will happily
            // starve down to ~16 kbps the moment a screenshare publishes its 6 Mbps video +
            // 192 kbps stereo audio — that's the "tin-can voice when screensharing" bug.
            // 64 kbps mono Opus is HD voice quality with enough headroom that GCC leaves it
            // alone. Screenshare audio publishes at 192 kbps stereo via its own explicit
            // audioPreset in SidebarConference — this default applies only to the mic.
            audioPreset: { maxBitrate: 64_000 },
        },
        audioCaptureDefaults: {
            // AGC disabled — voiceProcessor handles volume via MicVolumeGain + DynamicsCompressor.
            // NS disabled — RNNoise AudioWorklet inside voiceProcessor handles it.
            // AEC disabled — Chromium's AEC3 runs a heavy adaptive filter that
            // falls behind under the extra CPU load of screenshare video
            // encoding, and under-suppressed echo is often what listeners
            // perceive as "playing audio twice" when the sharer is on speakers.
            // Most users here are on headphones; for those using speakers,
            // the tradeoff (cleaner voice vs possible self-echo) still favors
            // off, and they can mute or wear headphones to resolve anything.
            // sampleRate: ideal 48 kHz — Chromium resamples any mic internally so the track
            // delivered to voiceProcessor is always 48 kHz (matching AudioContext rate → no pitch shift).
            //
            // These now live in audioInput.ts so the settings-page level meter
            // opens the mic exactly the same way the call does (it used to run
            // with AEC ON, so the level you set your gate against wasn't the
            // level you transmitted).
            ...MIC_CAPTURE_CONSTRAINTS,
            // Resolved to the literal 'default' device rather than left
            // undefined — see DEFAULT_AUDIO_INPUT_ID for why those differ.
            deviceId: initialMicDeviceId,
            // NO `processor` here, deliberately. Passing it through
            // audioCaptureDefaults fails EVERY join: livekit-client's
            // createLocalTracks() calls track.setProcessor() before anything
            // has set an audioContext on the track, and LocalAudioTrack.
            // setProcessor() hard-throws without one ("Audio context needs to
            // be set on LocalAudioTrack in order to enable processors") —
            // verified unchanged through livekit-client 2.22.1, and shipped
            // broken in 1.0.12-staging.92. The processor is attached instead
            // by MicProcessorBridge below, on LocalTrackPublished.
        },
        ...(e2eeKeyB64 ? {
            // `encryption`, not the deprecated `e2ee`: same E2EEOptions, same
            // frame encryption for media — but only this key also turns on
            // data-channel encryption (livekit-client sets
            // isDataChannelEncryptionEnabled from `!!options.encryption`).
            // Until now every publishData() payload in a call left the client
            // in plaintext; today that is only the content-free `ss-adjust`
            // marker, but in-call annotations (docs/video-annotation-design.md)
            // carry content and depend on this being on first. Packets are
            // stamped Encryption_Type.GCM; a client still on `e2ee:` cannot
            // read them (media unaffected), so this ships ahead of any feature
            // that relies on it.
            //
            // This block only CONFIGURES encryption — it builds the manager,
            // spawns the worker and accepts the key, and then every track is
            // still published as Encryption_Type.NONE until something calls
            // `room.setE2EEEnabled(true)`. Nothing did, for the whole life of
            // this app, so no call was ever actually encrypted (2026-09-08).
            // <E2EEActivator> below is what turns it on, and what refuses to
            // run the call if turning it on fails. See utils/e2eeActivation.ts.
            //
            // Built by stableE2EEOptions, NOT as an object literal: under
            // `encryption:` the wrapper's options-stringifier walks into the
            // live key provider, whose listener bookkeeping mutates the moment
            // a Room is built — which made <LiveKitRoom> rebuild the Room
            // forever and killed every E2EE call mid-connect. See that file.
            encryption: stableE2EEOptions(
                keyProvider,
                new Worker(e2eeWorkerUrl, { type: 'module' }),
            ),
        } : {}),
    // Device ids intentionally absent from these deps — see initialMicDeviceId.
    // `voice` no longer feeds this memo at all — the processor moved to
    // MicProcessorBridge (see audioCaptureDefaults comment above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [e2eeKeyB64, keyProvider, token]);


    if (!token || !livekitUrl) {
        return (
            <div className="w-full h-full bg-cl-abyss flex items-center justify-center text-slate-500 font-medium text-sm animate-pulse">
                Initializing Call Session...
            </div>
        );
    }

    return (
        <div className="hidden">
            <LiveKitRoom
                video={videoByDefault}
                audio={true}
                token={token}
                serverUrl={livekitUrl}
                options={roomOptions}
                connectOptions={connectOptions}
                connect={true}
                data-lk-theme="default"
                onConnected={() => { hasConnectedRef.current = true; endJoinActivityRef.current?.(); console.log('LiveKit Room Connected successfully'); }}
                onDisconnected={(reason) => {
                    console.log('LiveKit Room Disconnected, reason:', reason !== undefined ? DisconnectReason[reason] : 'unknown', '— audio health:', audioHealth.summarize());
                    void voiceProcessorManager.destroyForCall(token);
                    // CLIENT_INITIATED is a normal "you left" — no toast, that's
                    // just the call ending the way the user asked. Every other
                    // reason used to fall through to this same silent teardown
                    // with no explanation; now the user finds out whether they
                    // were kicked, the connection gave up, or a sibling device
                    // answered instead (DUPLICATE_IDENTITY — the fallback path
                    // for the multi-device answer race; the primary path is a
                    // dedicated call:answered_elsewhere event, see useRealtime.ts).
                    if (reason !== undefined && reason !== DisconnectReason.CLIENT_INITIATED) {
                        const { title, message, kind } = mapDisconnectReasonToUserMessage(reason);
                        toast.push({ kind, title, message });
                    }
                    onDisconnect();
                }}
                onError={(err) => {
                    console.error('[CallPane] LiveKit connection error:', err);
                    failConnection(err.message || "Couldn't connect to the call.");
                }}
                // Observability, not policy: the SDK raises these for a peer we
                // can't decrypt (wrong key / mid-rotation window), a missing
                // local key, and — on a client with NO encryption block — an
                // encrypted track arriving. Before this they went nowhere.
                // Throttled upstream (one per second per cryptor), so a log is
                // safe; a toast would false-alarm on every key rotation.
                onEncryptionError={(err) => {
                    console.error('[CallPane] LiveKit encryption error:', err.message);
                }}
            >
                    <E2EEActivator
                        keyProvider={keyProvider}
                        keyB64={e2eeKeyB64}
                        onFailure={failEncryption}
                    />

                    {/* Observer, not a gate: reports peers publishing in the
                        clear. Mounted even on a keyless call — see the
                        component docstring. */}
                    <RemoteE2EEWatcher
                        onChange={(snapshot) => {
                            setRemoteEncryption(snapshot);
                            onRemoteEncryptionChange?.(snapshot);
                        }}
                    />

                    {/* Both voice channels and DM/group calls use the same
                        SidebarConference panel.  Voice channels pass noRinging=true
                        to skip the ringing state and jump straight to the live view;
                        isGroup=true gives multi-participant tile layout. */}
                    <CallSidebarPortal
                        apiToken={apiToken}
                        onLeave={stableOnLeave}
                        onInactivityWarning={onInactivityWarning ? stableOnInactivityWarning : undefined}
                        localAvatarUrl={localAvatarUrl}
                        activeChatAvatarUrl={activeChatAvatarUrl}
                        activeChatUserId={activeChatUserId}
                        activeChatTitle={activeChatTitle}
                        sessionId={sessionId}
                        isGroup={isGroup}
                        noRinging={noRinging}
                        isHuddle={isHuddle}
                        onFocusedStreamChange={onFocusedStreamChange}
                        voice={voice}
                        memberRoleColors={stableRoleColors}
                        memberAvatarMap={stableAvatarMap}
                        canServerMute={canServerMute}
                        onServerMuteTrack={onServerMuteTrack ? stableOnServerMuteTrack : undefined}
                        isActive={isActive}
                        channelPermissions={channelPermissions}
                        encryptionIndicatorMode={encryptionIndicatorMode}
                        unencryptedIdentities={remoteEncryption.unencryptedIdentities}
                    />

                    <MicProcessorBridge token={token} voice={voice} />

                    <CallSpeakingReporter
                        onChange={onSpeakingChange ?? (() => {})}
                        onParticipantCount={onParticipantCount ?? (() => {})}
                    />
                    <CallAudioEffects isInitiator={isCallInitiator} noRinging={noRinging} />
            </LiveKitRoom>
        </div>
    );
};

const EMPTY_MEMBER_MAP: Record<string, string | null> = Object.freeze({}) as Record<string, string | null>;

/** The whole in-call UI, skipped unless its own props change — see "Render
 *  isolation from Dashboard" in CallPane. LiveKit-driven updates still reach
 *  it through its own hooks (useParticipants, contexts), unaffected. */
const MemoSidebarConference = React.memo(SidebarConference);

const CallSidebarPortal = ({ apiToken, onLeave, onInactivityWarning, localAvatarUrl, activeChatAvatarUrl, activeChatUserId, activeChatTitle, sessionId, isGroup, noRinging, isHuddle, onFocusedStreamChange, voice, memberRoleColors, memberAvatarMap, canServerMute, onServerMuteTrack, isActive, channelPermissions, encryptionIndicatorMode, unencryptedIdentities }: { apiToken: string, onLeave: () => void, onInactivityWarning?: (active: boolean) => void, localAvatarUrl?: string, activeChatAvatarUrl?: string, activeChatUserId?: string, activeChatTitle?: string, sessionId?: string, isGroup?: boolean, noRinging?: boolean, isHuddle?: boolean, onFocusedStreamChange?: (active: boolean) => void, voice?: VoiceSettingsHook, memberRoleColors?: Record<string, string | null>, memberAvatarMap?: Record<string, string | null>, canServerMute?: boolean, onServerMuteTrack?: (targetUserId: string, trackType: 'audio' | 'video' | 'screenshare' | 'deafen', muted: boolean) => void, isActive?: boolean, channelPermissions?: bigint, encryptionIndicatorMode: Extract<CallEncryptionIndicatorMode, 'connected' | 'degraded'>, unencryptedIdentities?: string[] }) => {
    // Track the portal target via state so we re-render when it appears in
    // the DOM. We poll briefly with rAF until the target appears, then watch
    // for its removal via a MutationObserver on document.body.
    //
    // Ghost-prevent guard: when the root is removed while isActive=false
    // (the call ended and we're in the callPaneActive grace window), we set
    // callEndedRef so the re-find effect skips searching. This prevents
    // SidebarConference from re-portaling into the brief #call-sidebar-root
    // that appears in Dashboard's own pane during the 220 ms grace window.
    //
    // When isActive=true the root moved because of a view switch (e.g.
    // navigating away from the call's server). In that case we clear root
    // and immediately allow re-finding the new element.
    const callEndedRef = useRef(false);
    const isActiveRef = useRef(isActive ?? true);
    useEffect(() => { isActiveRef.current = isActive ?? true; }, [isActive]);

    const [root, setRoot] = useState<HTMLElement | null>(() => {
        return document.getElementById('call-sidebar-root');
    });
    useEffect(() => {
        if (root) return;
        // Guard: call ended — don't re-find to prevent ghost animation.
        if (callEndedRef.current) return;
        let cancelled = false;
        const tryFind = () => {
            if (cancelled) return;
            const el = document.getElementById('call-sidebar-root');
            if (el) { setRoot(el); return; }
            requestAnimationFrame(tryFind);
        };
        tryFind();
        return () => { cancelled = true; };
    }, [root]);
    useEffect(() => {
        if (!root) return;
        const observer = new MutationObserver(() => {
            if (document.body.contains(root)) return; // still alive, nothing to do
            if (!isActiveRef.current) {
                // Call ended — apply guard so the re-find effect is blocked.
                // This prevents SidebarConference from ghost-portaling into the
                // brief #call-sidebar-root that appears during the 220 ms
                // callPaneActive grace window after leaving.
                callEndedRef.current = true;
                setRoot(null);
                return;
            }
            // Call still active — root moved because of a view switch (e.g.
            // navigating away from the call's server shifts #call-sidebar-root
            // from ServerContextPanel to pane4El's call section).
            // React commits ALL DOM mutations before observers fire, so the
            // replacement is already in the DOM right now — grab it immediately
            // for a zero-flicker transition.
            const replacement = document.getElementById('call-sidebar-root');
            if (replacement && replacement !== root) {
                setRoot(replacement);
            } else {
                setRoot(null); // rAF poll in the re-find effect will catch it
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        return () => observer.disconnect();
    }, [root]);
    if (!root) return null;
    return ReactDOM.createPortal(
        <MemoSidebarConference
            token={apiToken}
            onLeave={onLeave}
            onInactivityWarning={onInactivityWarning}
            localAvatarUrl={localAvatarUrl}
            activeChatAvatarUrl={activeChatAvatarUrl}
            activeChatUserId={activeChatUserId}
            activeChatTitle={activeChatTitle}
            sessionId={sessionId}
            isGroup={isGroup}
            noRinging={noRinging}
            isHuddle={isHuddle}
            onFocusedStreamChange={onFocusedStreamChange}
            voice={voice}
            memberRoleColors={memberRoleColors}
            memberAvatarMap={memberAvatarMap}
            canServerMute={canServerMute}
            onServerMuteTrack={onServerMuteTrack}
            channelPermissions={channelPermissions}
            encryptionIndicatorMode={encryptionIndicatorMode}
            unencryptedIdentities={unencryptedIdentities}
        />,
        root
    );
};
