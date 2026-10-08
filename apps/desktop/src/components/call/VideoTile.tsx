import secureLocalStore from '../../utils/secureLocalStore';
import React from 'react';
import ReactDOM from 'react-dom';
import { useIsSpeaking, useConnectionState } from '@livekit/components-react';
import { Track, RemoteTrackPublication, VideoQuality, Participant, ParticipantEvent } from 'livekit-client';
import { shouldShowMuteBadge, type CallConnectionState } from '../../utils/muteBadge';
import { useParticipantTrackState } from './useParticipantTrackState';
import { MicOff, Headphones, Monitor, MonitorOff, VideoOff } from 'lucide-react';
import { EncryptedAvatar } from '../EncryptedAvatar';
import { PopoverMenu } from './PopoverMenu';
import { useParticipantAudio } from '../../hooks/useParticipantAudio';
import { useDismissOnOutsideClick } from '../../hooks/useDismissOnOutsideClick';
import { useParticipantSharedState } from '../../utils/perParticipantState';
import { useCallContextSafe } from '../../contexts/CallContext';
import { AnnotationOverlay } from './AnnotationOverlay';
import { AnnotationToolbar } from './AnnotationToolbar';
import { AnnotationRequestButton } from './AnnotationRequestButton';
import { AnnotationRequestsMenu } from './AnnotationRequestsMenu';
import { AnnotationGrantBadge } from './AnnotationGrantBadge';
import { ViewerCountBadge } from './ViewerCountBadge';
import { StopWatchingButton } from './StopWatchingButton';
import { canStopWatching } from '../../utils/stopWatchingScreenshare';
import { useOverlayCaptured, strokeAuthorFilter, type AttributeSource } from '../../utils/annotationOverlayCapture';
import { useAnnotationStore, trackKey as annotationTrackKey, isGranted as annotationIsGranted } from '../../utils/annotationStore';
import { contentRect, type FitMode, type ContentRect } from '../../utils/annotationGeometry';
import { videoRectInsets, videoRectPending, tileChromeSlots, CHROME_GUTTER_PX } from './videoRectChrome';
import { TileNamePill, TileToolCluster, TileStatsReadout } from './TileCornerChrome';
import { StreamStatsHud } from './StreamStatsHud';
import { useStreamStatsHudEnabled } from '../../utils/streamDiagnosticsPrefs';
import { useVideoZoomPan } from '../../hooks/useVideoZoomPan';
import { acquireSpeakingAnalyser, releaseSpeakingAnalyser } from '../../utils/speakingAnalyser';
import { retainRemoteVideo } from '../../utils/remoteVideoDemand';
import {
    claimRemoteQuality, prewarmRemoteQuality, pickTileLayer, pickShareLayer, displayedPixels, normaliseLayers, msSinceUpgrade,
    DATASAVER_SHARE_FPS, type QualityClaim, type TileRole,
} from '../../utils/remoteVideoQuality';
import { useIncomingVideoMode } from '../../utils/cameraQualityPrefs';
import { logCallEvent, trackPlaceholder } from '../../utils/callEventLog';
// vtMeta is derived inline from useParticipantMetadata (the reactive source)
// so we don't need the string-input parser here.

function usePersistentVolume(identity: string, type: 'mic' | 'screen' = 'mic'): [number, (v: number | ((prev: number) => number)) => void] {
    const key = `cipherline_vol_${type}_${identity}`;
    const [vol, setVol] = React.useState<number>(() => {
        try {
            const saved = secureLocalStore.getItem(key);
            if (saved !== null) {
                const parsed = parseFloat(saved);
                return isNaN(parsed) ? 1.0 : parsed;
            }
            return 1.0;
        } catch { return 1.0; }
    });

    const setVolumeAndSave = React.useCallback((newVol: number | ((prev: number) => number)) => {
        setVol(prev => {
            const nextVol = typeof newVol === 'function' ? newVol(prev) : newVol;
            if (isNaN(nextVol)) return prev;
            try { secureLocalStore.setItem(key, nextVol.toString()); } catch {}
            window.dispatchEvent(new CustomEvent('cipherline-volume-change', { detail: { identity, type, volume: nextVol }}));
            return nextVol;
        });
    }, [key, identity, type]);

    React.useEffect(() => {
        const handler = (e: any) => {
            if (e.detail.identity === identity && e.detail.type === type && e.detail.volume !== vol && !isNaN(e.detail.volume)) {
                setVol(e.detail.volume);
            }
        };
        window.addEventListener('cipherline-volume-change', handler);
        return () => window.removeEventListener('cipherline-volume-change', handler);
    }, [identity, type, vol]);

    return [vol, setVolumeAndSave];
}

function parseMetaSafe(raw: string | undefined): any {
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
}

function useParticipantMetadata(p: Participant) {
    // Initialise synchronously from p.metadata so the first render already
    // has avatar_url for participants who were in the room before we joined
    // (LiveKit includes full metadata in the initial participant list).
    // Without this, state starts as {} and the effect fires after the first
    // paint, causing a visible flash where the avatar is missing.
    const [meta, setMeta] = React.useState<any>(() => parseMetaSafe(p.metadata));
    React.useEffect(() => {
        // Sync in case p.metadata changed between the lazy-init read and mount
        setMeta(parseMetaSafe(p.metadata));
        const update = () => setMeta(parseMetaSafe(p.metadata));
        p.on(ParticipantEvent.ParticipantMetadataChanged, update);
        return () => { p.off(ParticipantEvent.ParticipantMetadataChanged, update); };
    }, [p]);
    return meta;
}

// ── Shared speaking analyser ─────────────────────────────────────────────────
// One analysis AudioContext + one 30 ms poll for the whole call, ref-counted
// per identity — see utils/speakingAnalyser.ts (it used to be one context and
// one timer PER participant, living here).

/** Non-hook version of the fast speaking subscription below — attaches a
 *  shared analyser subscription (falling back to LiveKit's own isSpeakingChanged
 *  event) to a participant and invokes onChange with the combined "fast OR lk"
 *  state on every update. Returns an unsubscribe function.
 *
 *  Exists so call surfaces that snapshot MANY participants inside a single
 *  effect (e.g. SidebarConference's per-participant push into CallContext,
 *  which feeds the avatar-ring indicators in ServerContextPanel /
 *  FloatingHuddleCard) can get the same instant response as useFastIsSpeaking
 *  without violating the rules of hooks by calling a hook a variable number
 *  of times. useFastIsSpeaking (below) is a thin React-hook wrapper around
 *  this same logic for single-participant, tile-shaped components. */
export function subscribeFastSpeaking(p: Participant, onChange: (speaking: boolean) => void): () => void {
    let tokenCur: symbol | null = null;
    let lkSpeaking = p.isSpeaking;
    let fastSpeaking = false;

    const emit = () => onChange(lkSpeaking || fastSpeaking);

    const tryAcquire = () => {
        // Release any current subscription before re-acquiring (track may have changed)
        if (tokenCur !== null) {
            releaseSpeakingAnalyser(p.identity, tokenCur);
            tokenCur = null;
        }
        const pub = p.getTrackPublication(Track.Source.Microphone);
        const mst: MediaStreamTrack | undefined = (pub?.track as any)?.mediaStreamTrack;
        if (!mst || mst.readyState !== 'live') return;
        tokenCur = acquireSpeakingAnalyser(p.identity, mst, (speaking) => {
            fastSpeaking = speaking;
            emit();
        });
    };

    tryAcquire();

    const onTrackSubscribed = (_track: any, pub: any) => {
        if (pub?.source === Track.Source.Microphone) tryAcquire();
    };
    const onTrackUnmuted = (pub: any) => {
        if (pub?.source === Track.Source.Microphone) tryAcquire();
    };
    const onIsSpeakingChanged = (speaking: boolean) => {
        lkSpeaking = speaking;
        emit();
    };
    p.on(ParticipantEvent.TrackSubscribed, onTrackSubscribed);
    p.on(ParticipantEvent.TrackUnmuted, onTrackUnmuted);
    p.on(ParticipantEvent.IsSpeakingChanged, onIsSpeakingChanged);

    return () => {
        p.off(ParticipantEvent.TrackSubscribed, onTrackSubscribed);
        p.off(ParticipantEvent.TrackUnmuted, onTrackUnmuted);
        p.off(ParticipantEvent.IsSpeakingChanged, onIsSpeakingChanged);
        if (tokenCur !== null) {
            releaseSpeakingAnalyser(p.identity, tokenCur);
            tokenCur = null;
        }
    };
}

/** Faster speaking indicator using the Web Audio API.
 *
 *  LiveKit's built-in isSpeaking lags because:
 *   - Remote participants: server Active Speaker Detection updates arrive ~1s apart
 *   - Local participant: LiveKit's internal monitor runs every 100ms
 *
 *  One AnalyserNode + one 30ms interval is shared per participant identity across
 *  all tiles — tiles subscribe/unsubscribe via ref-counted tokens. */
export function useFastIsSpeaking(p: Participant): boolean {
    const lkSpeaking = useIsSpeaking(p);
    const [fastSpeaking, setFastSpeaking] = React.useState(false);
    const tokenRef = React.useRef<symbol | null>(null);

    React.useEffect(() => {
        setFastSpeaking(false);

        const tryAcquire = () => {
            // Release any current subscription before re-acquiring (track may have changed)
            if (tokenRef.current !== null) {
                releaseSpeakingAnalyser(p.identity, tokenRef.current);
                tokenRef.current = null;
            }
            const pub = p.getTrackPublication(Track.Source.Microphone);
            const mst: MediaStreamTrack | undefined = (pub?.track as any)?.mediaStreamTrack;
            if (!mst || mst.readyState !== 'live') return;
            const token = acquireSpeakingAnalyser(p.identity, mst, (speaking) => setFastSpeaking(speaking));
            tokenRef.current = token;
        };

        tryAcquire();

        const onTrackSubscribed = (_track: any, pub: any) => {
            if (pub?.source === Track.Source.Microphone) tryAcquire();
        };
        const onTrackUnmuted = (pub: any) => {
            if (pub?.source === Track.Source.Microphone) tryAcquire();
        };
        p.on(ParticipantEvent.TrackSubscribed, onTrackSubscribed);
        p.on(ParticipantEvent.TrackUnmuted, onTrackUnmuted);

        return () => {
            p.off(ParticipantEvent.TrackSubscribed, onTrackSubscribed);
            p.off(ParticipantEvent.TrackUnmuted, onTrackUnmuted);
            if (tokenRef.current !== null) {
                releaseSpeakingAnalyser(p.identity, tokenRef.current);
                tokenRef.current = null;
            }
        };
    }, [p]);

    return lkSpeaking || fastSpeaking;
}

function usePersistentNsEnabled(identity: string): [boolean, (v: boolean) => void] {
    const key = `cipherline_ns_enabled_${identity}`;
    const [enabled, setEnabled] = React.useState<boolean>(() => {
        try { return secureLocalStore.getItem(key) === 'true'; } catch { return false; }
    });

    const setAndSave = React.useCallback((v: boolean) => {
        setEnabled(v);
        try { secureLocalStore.setItem(key, String(v)); } catch {}
        window.dispatchEvent(new CustomEvent('cipherline-ns-change', { detail: { identity, enabled: v } }));
    }, [key, identity]);

    React.useEffect(() => {
        const handler = (e: Event) => {
            const d = (e as CustomEvent).detail;
            if (d.identity === identity) setEnabled(d.enabled);
        };
        window.addEventListener('cipherline-ns-change', handler);
        return () => window.removeEventListener('cipherline-ns-change', handler);
    }, [identity]);

    return [enabled, setAndSave];
}

/**
 * Re-render the calling component whenever the participant's track lineup
 * changes — track published, unpublished, muted, or unmuted. Returns a
 * cheap snapshot of "does this participant currently have an active
 * (subscribed, non-muted) Camera / ScreenShare track right now?"
 *
 * Used to gate UI that only makes sense when the underlying track exists:
 *  - "video hidden" badge — pointless to show if they aren't sharing video
 *  - "screenshare hidden" badge — pointless to show if they aren't sharing
 *
 * Without this hook the badges would persist after the publisher stopped
 * sharing because hiddenVideoIds / hiddenScreenShareIds (a user preference)
 * is sticky by design — we want the hide preference to survive a stop+start
 * cycle, but we don't want the badge to misleadingly imply something is
 * being hidden when there's nothing TO hide right now.
 */
/** Reactive hook that returns true when the participant's microphone is
 *  GENUINELY muted — not merely "no track published yet".
 *
 *  Two bugs used to live here, both traced to LiveKit's
 *  `Participant.isMicrophoneEnabled` getter defaulting to "muted" whenever no
 *  mic track publication exists at all:
 *
 *   1. False "muted" badge for the WHOLE connecting/ringing window on a
 *      participant nobody muted — fixed below via shouldShowMuteBadge(),
 *      which only trusts "no track" as "muted" once the room has actually
 *      reached ConnectionState.Connected.
 *   2. For the LOCAL participant specifically, that false badge never
 *      self-corrected once the mic track DID publish: LiveKit emits
 *      `ParticipantEvent.LocalTrackPublished` (not `TrackPublished`, which
 *      only ever fires on a RemoteParticipant) when the local mic comes
 *      online, and this hook's listener list didn't include it — so the
 *      local participant's badge got stuck showing muted until the user
 *      manually toggled mute at least once (which does fire
 *      TrackMuted/TrackUnmuted and "accidentally" fixes it). Remote
 *      participants were never affected by this half, since their track
 *      really does arrive via TrackPublished. Now subscribed below. */
export function useIsMicMuted(p: Participant): boolean {
    const connectionState = useConnectionState();
    const compute = React.useCallback((): boolean => {
        const micPub = p.getTrackPublication(Track.Source.Microphone);
        // livekit-client's ConnectionState is a nominal string enum whose
        // members share their literal values with CallConnectionState —
        // safe to narrow via `unknown` rather than pull livekit-client into
        // the pure helper module.
        return shouldShowMuteBadge(!!micPub, !!micPub && !micPub.isMuted, connectionState as unknown as CallConnectionState);
    }, [p, connectionState]);
    const [muted, setMuted] = React.useState(compute);
    React.useEffect(() => {
        const refresh = () => setMuted(compute());
        refresh();
        p.on(ParticipantEvent.TrackMuted,            refresh);
        p.on(ParticipantEvent.TrackUnmuted,          refresh);
        p.on(ParticipantEvent.TrackPublished,        refresh);
        p.on(ParticipantEvent.TrackUnpublished,      refresh);
        p.on(ParticipantEvent.LocalTrackPublished,   refresh);
        p.on(ParticipantEvent.LocalTrackUnpublished, refresh);
        return () => {
            p.off(ParticipantEvent.TrackMuted,            refresh);
            p.off(ParticipantEvent.TrackUnmuted,          refresh);
            p.off(ParticipantEvent.TrackPublished,        refresh);
            p.off(ParticipantEvent.TrackUnpublished,      refresh);
            p.off(ParticipantEvent.LocalTrackPublished,   refresh);
            p.off(ParticipantEvent.LocalTrackUnpublished, refresh);
        };
    }, [p, compute]);
    return muted;
}

export { usePersistentVolume, usePersistentNsEnabled, useParticipantMetadata, useParticipantTrackState };

export interface VideoTileProps {
    p: Participant;
    source: Track.Source.Camera | Track.Source.ScreenShare;
    localParticipant: any;
    token: string;
    remoteAvatarUrl?: string;
    isLocalDeafened: boolean;
    isLocalMuted: boolean;
    onToggleLocalMute: (v: boolean) => void;
    isGroup?: boolean;
    fallbackAvatars?: Record<string, string>;
    /**
     * Avatar attachment id for the local user, used as a fallback when the
     * LiveKit participant.metadata hasn't propagated yet. The metadata sync
     * is async (WS signaling round-trip) and races with the camera being
     * enabled — without this prop, the bottom-right name badge on the
     * local user's own tile briefly shows the initials placeholder until
     * the metadata sync completes. Pass `user.avatar_url` from AuthContext.
     */
    localAvatarUrl?: string;
    isHiddenVideo?: boolean;
    isHiddenScreenShare?: boolean;
    onHideVideoChange?: (v: boolean) => void;
    onHideScreenShareChange?: (v: boolean) => void;
    /** CSS order for scroll-safe speaker sorting */
    style?: React.CSSProperties;
    /** If true, render in a larger focused layout */
    isFocusedView?: boolean;
    /** If true, screenshare fills a 16:9 container provided by the parent (fullscreen grid) */
    isGridView?: boolean;
    /**
     * Override for "is this tile a place where drawing makes sense?".
     *
     * The default (see `annotSurface` below) is focused-view OR anywhere in
     * fullscreen — which was a blunt instrument: FullscreenOverlay's bottom
     * participant strip is "in fullscreen", so a ~100px-tall thumbnail got a
     * pen toolbar and pointer capture it has no room for. The strip passes
     * `false`. Existing strokes still RENDER regardless — AnnotationOverlay
     * always paints; this only gates the toolbar and the pointer handling.
     */
    annotationSurface?: boolean;
    /**
     * Suppress click-to-focus on this tile.
     *
     * Set by FullscreenOverlay in `solo` mode, where there is exactly one video
     * and therefore no second layout to switch to. Without it the click still
     * flipped `focusedStream` and re-rendered into a picture identical to the
     * one already on screen — the owner's "there's no point when you only have
     * one video". A disabled no-op is honest; a no-op that mutates state is not.
     */
    focusToggleDisabled?: boolean;
    /**
     * Hard override of the simulcast layer this tile asks for. Normally
     * omitted: the tile picks its own layer from its rendered size × DPR,
     * its role (focused / grid / sidebar) and `videoCount`
     * (utils/remoteVideoQuality.ts).
     */
    quality?: VideoQuality;
    /** How many video tiles share this view — caps the layer (≤4 / 5–9 / 10+). */
    videoCount?: number;
    /** True when the local user has MUTE_MEMBERS — shows server-mute options in popover. */
    canServerMute?: boolean;
    /** Forwarded to PopoverMenu for server-side track muting. */
    onServerMuteTrack?: (targetUserId: string, trackType: 'audio' | 'video' | 'screenshare' | 'deafen', muted: boolean) => void;
    /**
     * Stop watching this (remote) screen share — unsubscribe, leave the sharer's
     * viewer list, return to the Watch gate. When set on a remote screen-share
     * tile, a red X renders next to the name in the name pill. Ignored on
     * cameras and on your own share (see `canStopWatching`).
     */
    onStopWatching?: () => void;
}

/** Resting the pointer this long on a focusable tile pre-warms its top layer. */
const HOVER_PREWARM_DWELL_MS = 150;

export const VideoTile = ({
    p,
    source,
    localParticipant,
    token,
    remoteAvatarUrl,
    isLocalDeafened,
    isLocalMuted,
    onToggleLocalMute,
    isGroup,
    fallbackAvatars,
    localAvatarUrl,
    isHiddenVideo,
    isHiddenScreenShare,
    onHideVideoChange,
    onHideScreenShareChange,
    style,
    isFocusedView,
    isGridView,
    annotationSurface,
    focusToggleDisabled,
    quality,
    videoCount,
    canServerMute,
    onServerMuteTrack,
    onStopWatching,
}: VideoTileProps) => {
    const isLocal = p.identity === localParticipant?.identity;
    const isScreenShare = source === Track.Source.ScreenShare;
    // Annotation overlay (docs/video-annotation-design.md). Phase 1: only the
    // local user's own tiles are drawable; every tile renders its strokes.
    const annotEnabled = useAnnotationStore(st => st.enabled);
    // Must mirror the object-fit class on the <video> below: a share is
    // always contain; a camera is contain when focused, cover in the grid.
    const annotFit: FitMode = isScreenShare || isFocusedView ? 'contain' : 'cover';
    // Never show the raw user_id (p.identity). Same fallback policy as ParticipantCard.
    const displayName = p.name || 'Unknown';
    // Reactive metadata subscription — fires re-renders when a moderator
    // toggles server-mute / deafen / video / screenshare, OR when the user
    // self-deafens. Used both for the moderation flags below AND for the
    // avatar fallback further down (was: separate hook call below; lifted
    // here so vtMeta can derive from the same source instead of doing a
    // non-reactive read of p.metadata).
    const meta = useParticipantMetadata(p);
    const vtMeta = {
        deafened:               meta?.deafened === true,
        serverMutedAudio:       meta?.server_muted_audio === true,
        serverMutedVideo:       meta?.server_muted_video === true,
        serverMutedScreenShare: meta?.server_muted_screenshare === true,
        serverDeafened:         meta?.server_deafened === true,
    };
    const isSpeaking = useFastIsSpeaking(p);
    // Reactively tracks whether the participant currently has live Camera /
    // ScreenShare tracks — used to suppress the hidden-track badges below
    // when the underlying track has gone away (publisher turned it off).
    const { hasActiveCamera, hasActiveScreenShare } = useParticipantTrackState(p);

    const callCtx = useCallContextSafe();
    // Drawing exists only where it makes sense: on a FOCUSED tile or in
    // fullscreen - never on a grid thumbnail or the sidebar strip. The tool
    // lives on the video itself (top-right, with the stream label), not in
    // the call controls.
    // `annotationSurface` (when the caller passes one) wins outright — see its
    // prop docstring. FullscreenOverlay's participant strip is the case that
    // forced it: those thumbnails are "in fullscreen" but are not a canvas.
    //
    // ALSO gated on the SHARER (this tile's own participant, `p`) being able to render
    // strokes back to themselves — `meta.can_render_annotations`, stamped `false` only by a
    // mobile client (it has no self-view of its own outgoing screen share to draw onto). Not
    // wired through `vtMeta` above because that shape is duplicated ad hoc rather than routed
    // through the shared `participantMetadata.ts` parser (see that file's own comment); read
    // directly off the raw parsed `meta` here instead of adding a third copy of the field.
    // Before this, a desktop viewer could draw on a phone's shared screen and the phone user
    // never saw a single stroke — a feature that looked live and did nothing.
    const annotSurface =
        (annotationSurface ?? (!!isFocusedView || !!callCtx?.isFullscreen)) && meta?.can_render_annotations !== false;
    // Reverting the previous round's `usesZoomPanWrapper` restriction (this
    // used to read `!!isFocusedView && !!callCtx?.isFullscreen`, disabling
    // the clip-path + zoom/pan wrapper entirely for FocusedStreamBanner's
    // docked preview). That change's diagnosis didn't hold up: the video's
    // OWN box was already proven symmetric before it landed (see that
    // commit's own message), and the real off-center cause turned out to be
    // padding one and two layers up in Dashboard.tsx / SidebarConference.tsx
    // — fixed separately, with zero dependency on this wrapper's existence.
    // What the restriction DID do, as an unintended side effect: the clip-
    // path is what clips the video's own square corners to match the
    // rounded fitRect border overlay (see fitClipPath below); removing the
    // wrapper for the docked preview removed that clipping too, so any real
    // letterbox gap there went back to showing square corners poking past
    // the rounded border — reported live as "the camera is still square, it
    // needs to follow the border." Scoped back to plain `isFocusedView`,
    // matching FullscreenOverlay again. The wheel-hijack this was ALSO
    // meant to guard against is a separate, already-fixed, still-active
    // concern — `requireModifierForWheelZoom` below (unaffected by this)
    // keeps a plain scroll from being read as zoom outside true fullscreen.
    //
    // NOTE the rename: this flag governs the ZOOM/PAN wrapper, which is
    // focused-view-only by design (clamping a pan inside a 170px grid cell is
    // not a feature). Corner CLIPPING is a separate question and is NOT scoped
    // to it any more — see `fitClipPath` below.
    const usesZoomPan = !!isFocusedView;
    // A viewer may draw on someone else's tile once its owner has granted
    // them (mirrored from the owner's published list). The owner of a tile
    // may NEVER draw on their own — that was Phase 1's original scope
    // (self-only, before requests/grants existed) and stuck around after
    // Phase 3 added granting for others; removed by request. isGranted() at
    // the store level still treats a track's owner as implicitly allowed —
    // that's the correct WIRE-level invariant (a receiver must still accept
    // a stroke authored by the legitimate owner) — this is purely the local
    // UI choosing never to let the owner exercise it.
    const annotKey = annotationTrackKey(p.identity, source);
    const annotMe: string = localParticipant?.identity ?? '';
    // A Linux sharer's desktop overlay is captured into this very video: draw
    // only our own strokes on it (the video already shows everyone else's).
    // utils/annotationOverlayCapture.ts.
    const overlayCaptured = useOverlayCaptured(p as unknown as AttributeSource, isScreenShare);
    const annotOnlyBy = strokeAuthorFilter({ isScreenShare, captured: overlayCaptured, me: annotMe || p.identity });
    const annotGranted = useAnnotationStore(st => !isLocal && !!annotMe && annotationIsGranted(st, annotKey, annotMe));
    const annotCanDraw = annotSurface && annotEnabled && annotGranted;
    /**
     * The z-index the <video>+canvas group must take when this tile is a live
     * drawing surface. Mirrors AnnotationOverlay's own `canDraw ? z-[11] :
     * z-[2]` — 11 is above the z-10 context-menu hit surface below, 2 is under
     * it. Named once because the focused view applies it to a wrapper rather
     * than to the canvas (see the clip window in the render), and the two
     * spellings must not be able to drift apart.
     */
    const annotLayerZ = annotCanDraw ? 11 : 2;

    const videoRef = React.useRef<HTMLVideoElement>(null);
    const wrapperRef = React.useRef<HTMLDivElement>(null);
    const popoverRef = React.useRef<HTMLDivElement>(null);
    // Wheel-zoom / drag-pan, focused view only. The layer this transforms
    // wraps BOTH the <video> and the annotation canvas (see the render), so
    // strokes stay welded to the content with no annotation-side maths.
    const zoomLayerRef = React.useRef<HTMLDivElement>(null);
    useVideoZoomPan({
        rootRef: wrapperRef,
        layerRef: zoomLayerRef,
        videoRef,
        fit: annotFit,
        enabled: usesZoomPan,
        // Annotation gets the plain left-drag only where a left-drag would
        // actually DRAW (drawing must not get harder); panning then falls
        // back to middle-drag or space+drag.
        //
        // The test is `annotCanDraw`, NOT "the tool is armed". Arming is
        // global, but permission is per-tile — and the owner of a tile may
        // never draw on their own (see annotGranted above). Surrendering the
        // left button on armed alone meant that on your OWN focused share,
        // with the tool switched on, a left-drag drew nothing (no permission)
        // AND panned nothing (button surrendered) — so the gesture fell
        // through to the wrapper's onClick and un-focused the stream out from
        // under you. The annotation canvas's own click-swallow does not cover
        // this: it sits at z-2 under the tile's z-10 context-menu surface
        // whenever canDraw is false, so it never sees the click.
        allowLeftDrag: !annotCanDraw,
        resetKey: annotKey,
        // "Any wheel zooms" is only safe where there is truly nothing else to
        // scroll (FullscreenOverlay). FocusedStreamBanner's docked preview
        // sits inside the chat pane's own scrollable column, so there it
        // requires ctrl+wheel like any other embedded page element — see the
        // option's own docstring in useVideoZoomPan.ts.
        requireModifierForWheelZoom: !callCtx?.isFullscreen,
    });

    const [showPopover, setShowPopover] = React.useState(false);
    const [popoverPos, setPopoverPos] = React.useState({ top: 0, left: 0 });
    const [volume, setVolume] = usePersistentVolume(p.identity, 'mic');
    const [screenShareVolume, setScreenShareVolume] = usePersistentVolume(p.identity, 'screen');
    const [nsEnabled, setNsEnabled] = usePersistentNsEnabled(p.identity);
    // Screenshare-mute state lives in a per-participant SHARED store, not
    // local component state. Same participant can render in two tiles at once
    // (focused tile + sidebar thumbnail in fullscreen), and the audio chain
    // is owned by exactly ONE of them via dedupe in useParticipantAudio.
    // If the mute toggle were local state, clicking it on a tile that
    // doesn't own the chain would update that tile's state but the chain's
    // gain node — read from the OWNING tile's state — would never change.
    // That's "Mute Stream button doesn't work in fullscreen". Sharing the
    // state across tiles makes every read+write hit the same value.
    const [isScreenShareMuted, setIsScreenShareMuted] =
        useParticipantSharedState<boolean>(p.identity, 'ssMuted', false);
    const hudEnabled = useStreamStatsHudEnabled();
    const hudPub = p.getTrackPublication(source);
    const hudTrack = hudPub?.videoTrack;
    // The audio that should line up with this video (A/V-sync row).
    const hudAudioTrack = isLocal ? undefined
        : p.getTrackPublication(isScreenShare ? Track.Source.ScreenShareAudio : Track.Source.Microphone)?.audioTrack;
    const [videoRes, setVideoRes] = React.useState<string | null>(null);
    const [videoFps, setVideoFps] = React.useState<number>(0);
    const lastFrameRef = React.useRef<{ count: number; time: number }>({ count: 0, time: performance.now() });

    // Muted/Deafened status — derived from the reactive vtMeta declared at
    // the top of the component. Self-deafen + server-deafen both render the
    // headphones-off badge.
    const isDeafened = vtMeta.deafened || vtMeta.serverDeafened;
    // Reactive (TrackMuted/Unmuted/Published/Unpublished) — a raw
    // `p.isMicrophoneEnabled === false` read here only updates when
    // something ELSE forces a re-render, which video tiles don't get
    // reliably (unlike ParticipantCard, which already used useIsMicMuted for
    // exactly this reason — see its comment). Was the cause of a remote
    // mute badge staying frozen on camera/screenshare tiles until reload.
    const isMuted = useIsMicMuted(p);

    // Audio management via shared hook.
    // For ScreenShare tiles: VideoTile only renders the SUBSCRIBED variant
    // (the unsubscribed case uses ScreenShareGate). So if isScreenShare is
    // true here, the user has explicitly chosen to watch — pass
    // screenShareSubscribed=true to let the hook attach to the audio track.
    useParticipantAudio(p, localParticipant?.identity, {
        volume,
        isLocalMuted,
        isLocalDeafened,
        isScreenShare,
        screenShareVolume,
        isScreenShareMuted,
        nsEnabled,
        screenShareSubscribed: isScreenShare,
    });

    // Determine if this tile's stream is currently focused — must be before the quality effect.
    const isFocused = callCtx?.focusedStream?.identity === p.identity && callCtx?.focusedStream?.source === source;

    // Pause the stream at the SFU while no ON-SCREEN tile shows it (scrolled out
    // of the side panel, inside a hidden container, unmounted) — the decrypt +
    // decode a visible tile needs, and nothing else. See utils/remoteVideoDemand.ts.
    const [onScreen, setOnScreen] = React.useState(true);
    React.useEffect(() => {
        const el = wrapperRef.current;
        if (!el || typeof IntersectionObserver === 'undefined') return;
        // 200px margin: a tile about to scroll into view is already resumed.
        const io = new IntersectionObserver(entries => setOnScreen(entries[entries.length - 1].isIntersecting), { rootMargin: '200px' });
        io.observe(el);
        return () => io.disconnect();
    }, []);
    const demandPub = p.getTrackPublication(source);
    React.useEffect(() => {
        if (!onScreen || !(demandPub instanceof RemoteTrackPublication)) return;
        return retainRemoteVideo(demandPub);
    }, [onScreen, demandPub]);

    // Attach video track — capture element before cleanup so detach targets only this element.
    // Without capturing, videoRef.current is null when the effect cleans up (React nullifies
    // refs before cleanup runs), and track.detach(null) falls through to the no-argument form
    // which detaches from ALL elements, blanking every other tile showing the same track.
    React.useEffect(() => {
        const trackPub = p.getTrackPublication(source);
        const track = trackPub?.track;
        const el = videoRef.current;
        if (!track || !el) return;
        track.attach(el);
        return () => { track.detach(el); };
    }, [p, source, p.getTrackPublication(source)?.track]);

    // Simulcast layer for this tile (utils/remoteVideoQuality.ts). Every tile
    // showing a stream holds a CLAIM; the publication gets the MAX of them,
    // upgrades at once and downgrades only after a short delay — so the
    // sidebar copy of a focused stream no longer has to stand aside, and
    // unfocus → refocus never dips. The tile picks from its rendered size ×
    // devicePixelRatio against the publisher's real layers, capped by how
    // many tiles share the view.
    const [tileBox, setTileBox] = React.useState<{ w: number; h: number }>({ w: 0, h: 0 });
    React.useEffect(() => {
        const el = wrapperRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        // 16 px buckets: a drag-resize must not re-render the tile per pixel.
        const q = (n: number) => Math.round(n / 16) * 16;
        const ro = new ResizeObserver(entries => {
            const r = entries[entries.length - 1].contentRect;
            const next = { w: q(r.width), h: q(r.height) };
            setTileBox(prev => (prev.w === next.w && prev.h === next.h ? prev : next));
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const layerPubRaw = p.getTrackPublication(source);
    // Cameras AND screen shares go through the arbiter (a share has a 720p
    // lower layer since the screen-share simulcast change; pickShareLayer).
    const layerPub = layerPubRaw instanceof RemoteTrackPublication ? layerPubRaw : null;
    const layerTrack = layerPubRaw?.track;
    const claimRef = React.useRef<QualityClaim | null>(null);
    const lastPickRef = React.useRef<VideoQuality | undefined>(undefined);
    React.useEffect(() => {
        if (!layerPub || !layerTrack) return;
        const c = claimRemoteQuality(layerPub);
        claimRef.current = c;
        lastPickRef.current = undefined;
        return () => { c.release(); if (claimRef.current === c) claimRef.current = null; };
    }, [layerPub, layerTrack]);
    const tileRole: TileRole = isFocusedView ? 'focus' : isGridView ? 'grid' : 'tile';
    const incomingMode = useIncomingVideoMode();
    const pubDims = layerPub?.dimensions;
    const layersKey = (layerPub?.trackInfo?.layers ?? []).map(l => `${l.quality}:${l.width}x${l.height}`).join(',');
    React.useEffect(() => {
        const c = claimRef.current;
        if (!c || !layerPub) return;
        let q: VideoQuality;
        if (quality !== undefined) {
            q = quality;
        } else if (isScreenShare) {
            const aspect = pubDims && pubDims.height > 0 ? pubDims.width / pubDims.height : 16 / 9;
            const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
            q = pickShareLayer({
                layers: normaliseLayers(layerPub.trackInfo?.layers),
                role: tileRole,
                need: displayedPixels(tileBox.w, tileBox.h, dpr, aspect, 'contain'),
                mode: incomingMode,
                current: lastPickRef.current,
            });
        } else {
            const aspect = pubDims && pubDims.height > 0 ? pubDims.width / pubDims.height : 16 / 9;
            const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
            q = pickTileLayer({
                need: displayedPixels(tileBox.w, tileBox.h, dpr, aspect, isFocusedView || isGridView ? 'contain' : 'cover'),
                layers: normaliseLayers(layerPub.trackInfo?.layers),
                role: tileRole,
                count: videoCount ?? 1,
                speaking: isSpeaking,
                current: lastPickRef.current,
                mode: incomingMode,
            });
        }
        if (tileRole === 'focus' && lastPickRef.current !== q) {
            logCallEvent('focus_upgrade', { track: trackPlaceholder(layerPub.trackSid, isScreenShare ? 'remote-screen' : 'remote-video'), quality: q });
        }
        lastPickRef.current = q;
        c.set(q);
    // layersKey stands in for trackInfo.layers (a fresh array on every update).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [layerPub, layerTrack, tileBox, tileRole, videoCount, isSpeaking, quality, layersKey, pubDims?.width, pubDims?.height, incomingMode]);

    // Diagnostics: when the decoded picture changes size shortly after an
    // upgrade request, log how long the switch took — the focus-switch time,
    // readable in DevTools on a real call. Console only; nothing is stored.
    React.useEffect(() => {
        const el = videoRef.current;
        if (!el || !layerPub) return;
        const onResize = () => {
            const ms = msSinceUpgrade(layerPub);
            if (ms !== null && el.videoWidth > 0) {
                console.info(`[VideoQuality] ${tileRole} tile now ${el.videoWidth}×${el.videoHeight}, ${ms} ms after the upgrade request`);
                logCallEvent('focus_switched', {
                    track: trackPlaceholder(layerPub.trackSid, isScreenShare ? 'remote-screen' : 'remote-video'),
                    role: tileRole, size: `${el.videoWidth}x${el.videoHeight}`, ms,
                });
            }
        };
        el.addEventListener('resize', onResize);
        return () => el.removeEventListener('resize', onResize);
    }, [layerPub, layerTrack, tileRole, isScreenShare]);

    // Data saver also caps a share's received frame rate (0 = no cap). With
    // the lower layer that is already ≤ 30 fps; on a VP9 share (L1T3, one
    // spatial layer) this is what drops the temporal layers.
    React.useEffect(() => {
        if (!isScreenShare || !(layerPubRaw instanceof RemoteTrackPublication)) return;
        layerPubRaw.setVideoFPS(incomingMode === 'datasaver' ? DATASAVER_SHARE_FPS : 0);
    }, [isScreenShare, layerPubRaw, layerTrack, incomingMode]);

    // Pre-warm: ask for the top layer the moment the user presses (or rests
    // the pointer on) a tile that would focus on click — the focus view then
    // mounts onto a layer that is already flowing. Refs only: a pointer pass
    // must not re-render a live video tile (see cl-tile-hover below).
    const prewarmable = !!layerPub && !isFocusedView && !focusToggleDisabled;
    const hoverTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const hoverClaimRef = React.useRef<QualityClaim | null>(null);
    const endHover = React.useCallback(() => {
        if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
        hoverClaimRef.current?.release();
        hoverClaimRef.current = null;
    }, []);
    React.useEffect(() => endHover, [endHover, layerPub]);
    const handlePointerEnter = () => {
        if (!prewarmable || hoverTimerRef.current || hoverClaimRef.current) return;
        hoverTimerRef.current = setTimeout(() => {
            hoverTimerRef.current = null;
            if (!layerPub) return;
            const c = claimRemoteQuality(layerPub);
            c.set(VideoQuality.HIGH);
            hoverClaimRef.current = c;
        }, HOVER_PREWARM_DWELL_MS);
    };
    const handlePointerDown = (e: React.PointerEvent) => {
        if (e.button !== 0 || !prewarmable || !layerPub) return;
        prewarmRemoteQuality(layerPub);
    };

    // Poll video resolution and FPS (used by focused overlay and right-click context).
    // Only while one of those two readouts is actually on screen: the fps
    // number changes nearly every second, so polling unconditionally
    // re-rendered EVERY tile (sidebar thumbnails and grid cells included) once
    // a second for a value none of them displays.
    const needsResFpsReadout = (!hudEnabled && !!isFocusedView) || showPopover;
    React.useEffect(() => {
        if (!needsResFpsReadout) return;
        const poll = () => {
            const el = videoRef.current;
            if (!el || el.videoWidth === 0) return;
            const res = `${el.videoWidth}×${el.videoHeight}`;
            setVideoRes(prev => prev !== res ? res : prev);

            // FPS via getVideoPlaybackQuality (Chromium/Electron supports this)
            const q = (el as any).getVideoPlaybackQuality?.() as { totalVideoFrames?: number } | undefined;
            if (q?.totalVideoFrames !== undefined) {
                const now = performance.now();
                const dt = (now - lastFrameRef.current.time) / 1000;
                if (dt >= 0.8) {
                    const df = q.totalVideoFrames - lastFrameRef.current.count;
                    setVideoFps(Math.max(0, Math.round(df / dt)));
                    lastFrameRef.current = { count: q.totalVideoFrames, time: now };
                }
            }
        };
        // Re-seed the fps baseline: the last sample may be from a readout that
        // closed minutes ago, and averaging over that gap would show a wrong
        // number for the first second.
        const q0 = (videoRef.current as any)?.getVideoPlaybackQuality?.() as { totalVideoFrames?: number } | undefined;
        lastFrameRef.current = { count: q0?.totalVideoFrames ?? 0, time: performance.now() };
        const first = setTimeout(poll, 0); // a readout that just appeared shows the resolution at once
        const iv = setInterval(poll, 1000);
        return () => { clearTimeout(first); clearInterval(iv); };
    }, [needsResFpsReadout]);

    // Extract metadata avatar.
    // For LOCAL users: LiveKit participant metadata doesn't always have the
    // avatar — it gets synced via setMetadata in SidebarConference, but the
    // sync is async and races with first camera-on. Falls back to localAvatarUrl
    // (passed from AuthContext.user.avatar_url) so the small avatar in the
    // name badge always renders. For REMOTE users: prefer the metadata's
    // avatar_url (publisher's authoritative state) → fallbackAvatars (the
    // sender-resolved DM partner avatar) → remoteAvatarUrl (DM-specific prop).
    // `meta` was hoisted to the top of the component (see vtMeta block) so
    // that the server-moderation flags can derive from the same reactive
    // subscription. Avatar fallback continues to read from it here.
    let metaAvatar = meta?.avatar_url;
    if (!metaAvatar && fallbackAvatars) metaAvatar = fallbackAvatars[p.identity];
    const actualAvatarAttachmentId = metaAvatar
        || (isLocal ? localAvatarUrl : (isGroup ? undefined : remoteAvatarUrl));

    const handleContextMenu = (e: React.MouseEvent | React.PointerEvent) => {
        e.preventDefault();
        if (isLocal) return;
        e.stopPropagation();
        window.dispatchEvent(new Event('close-all-popovers'));
        const popoverWidth = 200; // matches PopoverMenu.tsx's .ctxm width
        const left = Math.max(16, Math.min(e.clientX, window.innerWidth - popoverWidth - 16));
        const top = Math.max(16, Math.min(e.clientY, window.innerHeight - 300));
        setPopoverPos({ top, left });
        setShowPopover(true);
    };

    const handleClick = (e: React.MouseEvent) => {
        // Don't focus on right-click
        if (e.button !== 0) return;
        // Nothing to toggle: this tile IS the whole view (FullscreenOverlay's
        // solo mode). Returning here — rather than letting the click flip
        // `focusedStream` into a visually identical render — is what makes the
        // single-video case have exactly one view.
        if (focusToggleDisabled) return;
        // Toggle focus via CallContext — for everyone, including the local
        // participant. If you have a camera or screenshare on, clicking your
        // own tile zooms it; audio-only tiles (ParticipantCard) keep the
        // click-to-open-profile behavior since there's nothing to focus there.
        if (callCtx) {
            callCtx.toggleFocusedStream({ identity: p.identity, source });
        }
    };

    // Outside click closes the popover AND consumes the click — without
    // consumption, clicking outside in the call grid would fire whatever
    // handler lives on the tile underneath (focus-toggle, etc.).
    useDismissOnOutsideClick(popoverRef, showPopover, () => setShowPopover(false));
    // Cross-tile coordination: any tile dispatching `close-all-popovers`
    // (e.g. when a different tile's context menu opens) closes ours too.
    React.useEffect(() => {
        if (!showPopover) return;
        const closePopover = () => setShowPopover(false);
        window.addEventListener('close-all-popovers', closePopover);
        return () => window.removeEventListener('close-all-popovers', closePopover);
    }, [showPopover]);

    // In focused view, the speaking indicator is on the avatar only, not the border
    const showBorderSpeaking = isSpeaking && !isLocalMuted && !isLocalDeafened && !isFocusedView;
    const showAvatarSpeaking = isSpeaking && !isLocalMuted && !isLocalDeafened && isFocusedView;

    // Where the picture actually renders inside the wrapper's box.
    //
    // Grid and focused views both use object-contain (see the <video>
    // className below): the wrapper's box and the video's own aspect ratio
    // can genuinely disagree, and contain never crops to compensate, so the
    // picture can end up smaller than its box on one axis — a letterbox.
    // The wrapper's own `ring-1 ring-white/5` (and its idle-state
    // `bg-cl-abyss`) are drawn on that FULL box regardless, which is exactly
    // what made the border look wrong: it traced empty letterboxed space
    // instead of framing the picture. Reuses the SAME contentRect() math the
    // annotation layer already depends on for stroke alignment, so the
    // border and a drawn stroke agree on where the picture is — not a
    // second, independently-tuned computation that could drift from it.
    const usesContainFit = isGridView || isFocusedView;
    // Extracted rather than inlined into the dep array below: a member
    // expression there trips `react-hooks/exhaustive-deps`' "complex
    // expression in the dependency array".
    const liveTrack = p.getTrackPublication(source)?.track;
    const [fitRect, setFitRect] = React.useState<ContentRect | null>(null);
    // The box the LAST fitRect was computed against — needed alongside
    // fitRect to derive clip-path insets (top/right/bottom/left from the
    // box's own edges), not just the rect's own x/y/width/height.
    const [fitBox, setFitBox] = React.useState<{ width: number; height: number } | null>(null);
    React.useEffect(() => {
        if (!usesContainFit) { setFitRect(null); setFitBox(null); return; }
        const wrapper = wrapperRef.current;
        const video = videoRef.current;
        if (!wrapper || !video) return;

        const recompute = () => {
            const box = { width: wrapper.clientWidth, height: wrapper.clientHeight };
            setFitRect(contentRect(box, { width: video.videoWidth, height: video.videoHeight }, 'contain'));
            setFitBox(box);
        };

        recompute();
        // `loadedmetadata` is the event that normally delivers the dimensions,
        // but it is the one event an already-decoding element can have fired
        // BEFORE these listeners were attached — and a null fitRect is not a
        // harmless "not yet": with no precise rect, the rounding falls back to
        // the wrapper's full box, which for an object-contain picture means a
        // rounded BOX around a square PICTURE. On a camera that is invisible
        // (there is barely any letterbox to see it in); on a screen share,
        // whose aspect rarely matches the stage's, it is the whole complaint —
        // "in the focused view of full screen only screenshares don't have the
        // rounded corners". `canplay`/`playing` are the belt to that braces:
        // one of them always lands once there is a decodable frame, and
        // recompute is idempotent.
        const EVENTS = ['loadedmetadata', 'resize', 'canplay', 'playing'] as const;
        for (const ev of EVENTS) video.addEventListener(ev, recompute);
        const observer = new ResizeObserver(recompute);
        observer.observe(wrapper);
        return () => {
            for (const ev of EVENTS) video.removeEventListener(ev, recompute);
            observer.disconnect();
        };
    // p/source identify which stream this tile shows — a fresh computation is
    // correct on either changing even though this component instance is also
    // remounted (fresh key) on most such changes upstream. `liveTrack` is in
    // here too: a screen share republished at a new quality swaps the track
    // under a tile that does NOT remount, and the new stream can be a
    // different shape — re-arming beats hoping the old listeners see it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [usesContainFit, p, source, liveTrack]);
    // Only suppress the wrapper's own ring once we have a REAL rect to frame
    // instead — a null rect (video not loaded yet, or a 0×0 box mid-layout)
    // must fall back to the full-box ring rather than show no border at all.
    const hasPreciseFitBorder = usesContainFit && !!fitRect;
    // A rounded BORDER drawn around fitRect (below) decorates that area but
    // does not CLIP anything — the video's own square corners still render
    // underneath it, poking out past the border's curve at any real
    // letterbox gap (visible as a rendering glitch, not a rounded frame).
    // clip-path: inset(...round) clips an element down to an inner rect with
    // rounded corners in one property, rather than resizing the <video>
    // element itself, which would also require re-deriving AnnotationOverlay's
    // own contentRect math against a now-smaller box.
    //
    // This used to be scoped to the focused view, leaving "grid view keeps the
    // border-only approximation from above" — i.e. a rounded border drawn
    // around a square picture, which is the same rendering glitch the focused
    // view was fixed for. Reported straight back: "Screen shares and videos in
    // the grid view of full screen don't have the rounded corners." The grid
    // cell's own `rounded-xl overflow-hidden` (FullscreenOverlay) is no help:
    // it rounds the CELL, and an object-contain picture letterboxed inside that
    // cell never reaches the cell's corners — its own square ones sit in the
    // middle of it.
    //
    // So the clip now covers every contain-fit tile (`usesContainFit`: focused
    // AND grid, camera AND screen share). WHERE it is applied still differs,
    // and must:
    //   focused — on a separate ancestor ABOVE zoomLayerRef, never on
    //             zoomLayerRef itself: clip-path resolves in the same
    //             coordinate space as that element's zoom/pan transform, so it
    //             would zoom and pan along with the content and eat the
    //             picture instead of framing it.
    //   grid    — straight onto the <video>, which has no transform to fight
    //             and, crucially, no wrapper: a clip-path'd wrapper would open
    //             a stacking context around the annotation canvas and change
    //             which layer wins the tile's pointer hit-test. The canvas
    //             itself is left unclipped, which is invisible in practice —
    //             strokes are mapped into the same contentRect, so the only
    //             thing outside the rounded curve is the corner slivers.
    //
    // The radius MUST match the border overlay's `rounded-xl` class exactly,
    // or the two visibly disagree at the corners — reported live as "the
    // rounded corners don't line up with the outline." This project
    // overrides Tailwind's default radius scale (tailwind.config.js
    // `borderRadius.xl`); a bare "12px" here was Tailwind's STOCK xl value,
    // not this design system's (20px) — a plausible-looking number that was
    // simply wrong for this codebase. Named here rather than left as an
    // unexplained magic number so a future change to that config value has
    // somewhere obvious to also update.
    const FIT_BORDER_RADIUS_PX = 20; // tailwind.config.js: theme.extend.borderRadius.xl
    const fitClipPath = usesContainFit && fitRect && fitBox
        ? `inset(${fitRect.y}px ${Math.max(0, fitBox.width - fitRect.x - fitRect.width)}px ${Math.max(0, fitBox.height - fitRect.y - fitRect.height)}px ${fitRect.x}px round ${FIT_BORDER_RADIUS_PX}px)`
        : undefined;

    // ── Corner chrome rides the PICTURE, not the tile ───────────────────────
    //
    // Owner, on the name badge: "Make sure it is actually on their video not
    // just in the far right corner of the box they are in, I don't want it to
    // be in the black bar area." And on the annotation cluster: "Move the
    // annotation button to inside the video frame too."
    //
    // Both used to be pinned to the WRAPPER (`absolute top-2 right-2`), which
    // is the letterboxed box, not the picture. Everything corner-anchored below
    // is now positioned off `chrome`, derived from the SAME `fitRect` the
    // rounded border and `fitClipPath` above already use — see
    // ./videoRectChrome.ts. One rect, so the badge, the border and an
    // annotation stroke cannot disagree about where the picture is.
    //
    // `hasActiveSource` is what makes a camera-OFF tile fall back to the tile's
    // own corners: that tile renders a centred avatar on a full-bleed
    // background, so there is no picture to ride and the tile's corners are the
    // only meaningful frame (the owner's screenshot circles them there too).
    // Note this is deliberately a RENDER-time gate rather than a dependency of
    // the fitRect effect above: muting a camera leaves the <video> element and
    // its intrinsic size intact, so the effect would not re-run, and the stale
    // rect would keep the badges parked over a picture that is no longer drawn.
    const hasActiveSource = isScreenShare ? hasActiveScreenShare : hasActiveCamera;
    const chrome = videoRectInsets(fitBox, hasActiveSource ? fitRect : null, CHROME_GUTTER_PX);
    // A tall picture inside a wide tile can be narrower than the name pill, so
    // the pill is capped to whatever it is riding. That cap is no longer
    // computed here: `TileNamePill` derives it from these same insets via
    // `chromeMaxWidthCss`, which resolves to the picture's width on a
    // letterboxed tile AND to the tile's width on a camera-off one — the
    // latter previously had no cap at all, so a long display name could run
    // off a narrow tile.
    // The no-flicker window: a contain-fit tile with a live track whose
    // intrinsic size has not arrived yet. Painting chrome at the tile's corners
    // for those few frames and then letting it JUMP onto the picture is exactly
    // the sliding badge the owner asked us to get rid of, so it waits instead —
    // and only ever for a tile that has no decoded frame to label yet. See
    // videoRectPending's doc comment for why this can never withhold a
    // camera-off tile's name.
    const chromeHidden = videoRectPending(usesContainFit, hasActiveSource, fitRect);
    // WHICH corner each of the three overlays sits in — mode-dependent, and
    // both arrangements are direct owner quotes. See `tileChromeSlots`'s table
    // in ./videoRectChrome.ts. The insets above are unchanged by this: the
    // slot picks which two of the four to read, never how they were computed,
    // so every corner still rides the picture rather than the tile's box.
    const slots = tileChromeSlots(callCtx?.isFullscreen);

    return (
        <>
        {/* bg-transparent — was bg-cl-abyss (#0B0F1E), then bg-[#05070F]
            (still visibly "a background," just a darker one — direct owner
            feedback: "this needs to be 100% transparent. I don't wanna see
            it"). Wherever this box shows through (a letterbox gap, or the
            corner slivers the rounded fitClipPath below always leaves
            outside its curve on a rectangular video), the actual complaint
            was never about which specific color was wrong — it was that
            THIS box drew a visible, hard-edged rectangle of ANY distinct
            color at all, nested inside the ambient panel background around
            it. Transparent removes the box, not just recolors it: the
            video now floats directly on whatever's actually behind it
            (FocusedStreamBanner's or FullscreenOverlay's own background,
            already the same colour as the rest of that panel/screen), so
            there is nothing here to read as "a frame" in the first place. */}
        <div
            ref={wrapperRef}
            // cl-tile-hover: the hover scope the "Ask to draw" button reveals
            // itself inside (index.css, .cl-annot-reveal). A class rather than
            // React state — nothing this component renders depends on hover,
            // and running a pointerenter/leave through setState would re-render
            // a live video tile on every pass of the cursor.
            className={`cl-tile-hover relative overflow-hidden bg-transparent ${focusToggleDisabled ? 'cursor-default' : 'cursor-pointer'} select-none transition-shadow duration-300
                ${/* Rounding lives on the wrapper's full box UNLESS we know the precise
                      rect the picture actually occupies (hasPreciseFitBorder) — in that
                      case it moves to the <video> element and the fitRect border overlay
                      instead, both below, so the rounded corners trace the visible picture
                      rather than a box that can be a different shape from it. */ ''}
                ${hasPreciseFitBorder ? '' : 'rounded-xl'}
                ${/* Sizing:
                      - Focused view (camera OR screenshare): fill 100% of the available
                        portal/container edge-to-edge. Camera used to be constrained to a
                        hardcoded-16:9 sub-box computed from the container size (this used
                        to be a `focusedSize` ResizeObserver, now removed) — whenever the actual
                        container wasn't 16:9-shaped (routine: the DM/group call banner's
                        width comes from the chat column, its height from a user-resizable
                        drag handle, so 16:9 was the exception, not the rule), that box
                        was SMALLER than the container along one axis, and the container's
                        own bg-cl-abyss showed through as a visible dark margin around the
                        camera — reported as "a dark background behind my camera". object-
                        cover on the <video> below already crops to fill its box with no
                        internal gaps, so the fix is simply to make that box the FULL
                        container, matching how screenshare already behaved.
                      - Grid view (camera OR screenshare): fill 100% of the cell. Previously
                        only screenshares got this; cameras fell through to sidebar's
                        aspect-video wrapper, which forces 16:9 and overflowed non-16:9 grid
                        cells → the outer overflow-hidden cropped the video at top/bottom.
                      - Sidebar: aspect-video for cameras, auto-height for screenshares */ ''}
                ${isFocusedView
                    ? 'w-full h-full'
                    : isGridView
                        ? 'w-full h-full'
                        : `w-full shrink-0 min-h-[80px] ${isScreenShare ? '' : 'aspect-video'}`
                }
                ${/* Keep a subtle idle border via ring-inset — fine because it's a 1px soft
                      line that stays visible even partially covered. The speaking/focus
                      borders below use a dedicated border div ABOVE the video so they can't
                      be hidden by the opaque video element.
                      Suppressed once hasPreciseFitBorder is true: that overlay (rendered
                      below, sized to fitRect) draws the SAME ring but around the actual
                      picture rather than the full box, so this one would otherwise double up
                      — or worse, visibly disagree with it whenever contain leaves a gap. */ ''}
                ${hasPreciseFitBorder ? '' : 'ring-inset ring-1 ring-white/5'}`}
            style={style}
            onClick={handleClick}
            onPointerEnter={handlePointerEnter}
            onPointerLeave={endHover}
            onPointerDown={handlePointerDown}
        >
            {/* The wrapper's own ring is suppressed (see hasPreciseFitBorder above)
                once we know exactly where the picture renders — this draws the SAME
                ring, but sized and positioned to fitRect instead of the full box, so
                it frames the actual visible image rather than the letterboxed space
                around it. z-[5], same layer as the speaking/focus overlays below, for
                the same reason: it must sit above the opaque <video> to be visible at
                all, and below interactive overlays. */}
            {hasPreciseFitBorder && fitRect && (
                <div
                    className="absolute rounded-xl pointer-events-none z-[5]"
                    style={{
                        left: fitRect.x,
                        top: fitRect.y,
                        width: fitRect.width,
                        height: fitRect.height,
                        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.05)',
                    }}
                />
            )}
            {/* Speaking / focus border overlay.
                Must be an explicit absolute-positioned div above the video (z-0), not a
                ring-inset / ring utility on the wrapper. Inset box-shadow is painted as
                part of the element's background and renders BEHIND positioned children —
                and our <video> is `absolute inset-0 z-0` with opaque content, which
                covered the ring entirely (user saw it "only at the corners of the screen"
                for outer rings, and not at all for inset rings). This layer is a dedicated
                drawing surface above the video but below interactive overlays. */}
            {showBorderSpeaking && (
                <div
                    className="absolute inset-0 rounded-xl pointer-events-none z-[5]"
                    style={{
                        boxShadow: 'inset 0 0 0 2px rgb(34, 197, 94), 0 0 18px rgba(34,197,94,0.35)',
                    }}
                />
            )}
            {isFocused && !isFocusedView && !showBorderSpeaking && (
                <div
                    className="absolute inset-0 rounded-xl pointer-events-none z-[5]"
                    style={{
                        boxShadow: 'inset 0 0 0 2px rgba(37, 224, 200, 0.6)',
                    }}
                />
            )}

            {/* Context menu hit surface */}
            <div
                className={`absolute inset-0 z-10 bg-transparent ${focusToggleDisabled ? 'cursor-default' : 'cursor-pointer'}`}
                onContextMenu={handleContextMenu}
                onPointerDown={e => { if (e.button === 2) handleContextMenu(e); }}
            />

            {/* The click-to-focus hint (a `Maximize2` glyph in the tile's
                top-left, revealed on hover) used to live here. REMOVED on
                direct owner instruction — "you added a little button to focus
                the video in the top right, remove that" — not deprecated, not
                hidden behind a flag. Its `.cl-tile-focus-hint` rules are gone
                from index.css and its test file is deleted with it, so there is
                no orphaned CSS class or dead spec left behind.

                Nothing is lost functionally: click-to-focus is a property of
                the TILE (see the onClick on the wrapper above), and the glyph
                only ever advertised it. Note the wrapper keeps `cl-tile-hover`
                — that scope is still load-bearing for `.cl-annot-reveal`. */}

            {/* Centered profile-picture fallback — shown when there's no active
                video track for this tile's source (camera off, or screenshare
                stopped while still focused). Otherwise the user just sees a
                black tile, which looks broken in focused view especially. The
                speaking ring lights up here when isFocusedView so the user
                still has a visual cue that the participant is talking. */}
            {(() => {
                if (hasActiveSource) return null;
                return (
                    <div className="absolute inset-0 z-[3] flex items-center justify-center pointer-events-none">
                        <div
                            className={`rounded-full overflow-hidden ring-2 transition-all ${
                                isFocusedView ? 'w-28 h-28 sm:w-32 sm:h-32' : 'w-14 h-14'
                            } ${
                                showAvatarSpeaking
                                    ? 'ring-green-500 shadow-[0_0_24px_rgba(34,197,94,0.5)]'
                                    : 'ring-white/10 shadow-2xl'
                            }`}
                        >
                            <EncryptedAvatar
                                attachmentId={actualAvatarAttachmentId}
                                userId={p.identity}
                                token={token}
                                className="w-full h-full object-cover"
                                fallbackSize={isFocusedView ? 48 : 24}
                                disableClickProfile
                                bypassFriendGate
                            />
                        </div>
                    </div>
                );
            })()}

            {/* ── Zoom/pan transform layer (focused view only) ──────────────
                The <video> and the annotation canvas MUST share one
                transformed ancestor. Annotation strokes are stored in
                normalised (0-1) track coordinates and mapped through the
                canvas's own box, so scaling the two together leaves that
                mapping exactly as valid as it was at 1x — zoom the video
                alone and every stroke would point somewhere else.

                z-index mirrors the canvas's own rule inside AnnotationOverlay
                (`canDraw ? z-[11] : z-[2]`), as `annotLayerZ`. Transform
                creates a stacking context, so the GROUP's z-index — not the
                canvas's — is what competes with the tile's z-10 context-menu
                hit surface. MERGE POINT: if that rule changes in
                AnnotationOverlay, this must change with it or drawing
                silently stops receiving pointer events.

                WHICH ELEMENT carries `annotLayerZ` is load-bearing and is the
                whole of the "clicking a focused tile to draw un-focuses it
                instead" bug — see the clip window below. */}
            {(() => {
                const frame = (
                    <>
            <video
                ref={videoRef}
                autoPlay
                muted={isLocal}
                playsInline
                className={
                    isScreenShare
                        ? (isFocusedView || isGridView)
                            // Focused or grid screenshare: wrapper has explicit h-full; fill it with object-contain letterboxing.
                            ? 'absolute inset-0 z-0 w-full h-full object-contain pointer-events-none'
                            // Sidebar screenshare: wrapper height is auto (driven by video); stay in flow.
                            : 'relative z-0 block w-full object-contain pointer-events-none'
                        // Camera. Sidebar wrapper is aspect-video (matches the 16:9 track) so
                        // object-cover perfectly fills with no crop there.
                        //
                        // Focused view USED to also be object-cover, on the theory that
                        // FocusedStreamBanner's auto-fit effect keeps the container's aspect
                        // exactly matched to the track's, so cover would have nothing left to
                        // crop. In steady state that's true — but mid-resize (dragging the
                        // window or a panel), or in the moment right after a fresh focus
                        // before that effect's first recompute lands, the container and the
                        // track's aspect genuinely disagree for a beat, and object-cover crops
                        // real picture content during exactly that window — reported live as
                        // "the camera gets cut off" while resizing. object-contain never crops;
                        // any mismatch shows as letterbox bars instead, which the auto-fit
                        // effect still collapses to ~zero once it catches up. Same reasoning as
                        // GRID view below, just for a different source of aspect mismatch.
                        : (isGridView || isFocusedView)
                            ? 'absolute inset-0 z-0 w-full h-full object-contain pointer-events-none'
                            : 'absolute inset-0 z-0 w-full h-full object-cover pointer-events-none'
                }
                // Grid/strip tiles round their own corners here; the focused
                // view does it on the clip window below instead, because THIS
                // element rides inside the zoom/pan transform. See fitClipPath.
                style={!usesZoomPan && fitClipPath ? { clipPath: fitClipPath } : undefined}
            />
            <AnnotationOverlay
                videoRef={videoRef}
                trackKey={annotKey}
                fit={annotFit}
                canDraw={annotCanDraw}
                armed={annotSurface && annotEnabled}
                by={annotMe || p.identity}
                onlyBy={annotOnlyBy}
                onContextMenu={handleContextMenu}
            />
                    </>
                );
                if (!usesZoomPan) return frame;
                return (
                    // Outer clip window — untransformed, sized to the FULL box like
                    // zoomLayerRef always was; clip-path restricts what's actually
                    // visible to fitRect with rounded corners. Deliberately a
                    // SEPARATE ancestor from zoomLayerRef rather than clip-path on
                    // zoomLayerRef itself: that element is what useVideoZoomPan
                    // transforms (scale/translate) for the zoom/drag-pan gesture, and
                    // clip-path lives in the SAME coordinate space as the transform —
                    // put on the transformed element, the clip window would zoom and
                    // pan right along with the content, shrinking the visible area
                    // further with every zoom-in instead of revealing more of the
                    // picture. Here, the clip stays fixed to the tile's true box and
                    // the zoomable layer moves freely inside it, same as a photo
                    // zoomed within a fixed frame.
                    //
                    // THIS ELEMENT CARRIES `annotLayerZ`, and that is not cosmetic.
                    // It used to have no z-index, on the stated theory that "an
                    // absolutely positioned element without one does not open a new
                    // stacking context, so zoomLayerRef's z-index (11/2) still
                    // compares directly against the wrapper's other overlays." The
                    // first half is true of `position` alone and FALSE here: a
                    // computed `clip-path` other than `none` creates a stacking
                    // context all by itself (CSS Masking L1). So this div became a
                    // z-index:auto stacking context, zoomLayerRef's 11 was sealed
                    // INSIDE it and compared against nothing outside, and the whole
                    // group painted — and hit-tested — below the z-10 context-menu
                    // surface above. Every pointerdown aimed at the annotation canvas
                    // landed on that surface instead and bubbled to the wrapper's
                    // onClick, i.e. toggleFocusedStream: "when I try to annotate on a
                    // focused video it just un-focuses it." No stroke was ever created
                    // locally, so nothing was published and no peer saw anything
                    // either — one bug, both symptoms.
                    //
                    // Verified in Chromium (elementFromPoint over this exact nesting):
                    //   clip-path on this div, z-index on the inner one -> the z-10
                    //     catcher wins the hit test;
                    //   clip-path AND z-index on this div              -> the canvas wins;
                    //   no clip-path, z-index on the inner one         -> the canvas wins.
                    // The third case is why grid tiles (which clip the <video> itself
                    // and have no wrapper) were never affected.
                    //
                    // Keep the z-index on the OUTERMOST element of this group. The
                    // inner layer deliberately has none: it is the transformed one,
                    // so it opens its own stacking context regardless, and a second
                    // z-index there is inert at best and misleading at worst.
                    <div
                        className="absolute inset-0"
                        style={{ zIndex: annotLayerZ, ...(fitClipPath ? { clipPath: fitClipPath } : null) }}
                    >
                        <div
                            ref={zoomLayerRef}
                            className="absolute inset-0"
                            style={{ transformOrigin: '0 0' }}
                        >
                            {frame}
                        </div>
                    </div>
                );
            })()}

            {/* Resolution · fps — `slots.stats`.
                TOP-left when not fullscreen ("have the resolution in the top
                left"), BOTTOM-left in fullscreen, where top-left is the
                annotation cluster's approved corner and this is the readout
                with nowhere else to be. Rides the picture like everything
                else; the slot only chooses which two insets it reads. */}
            {/* Stream-stats overlay (Settings → Advanced). Takes the stats slot
                over from the resolution · fps readout below while on — it shows
                both of those and the rest of the pipeline. Focused and grid
                tiles only: a sidebar thumbnail has no room for six rows. */}
            {hudEnabled && hudTrack && (isFocusedView || isGridView) && !chromeHidden && (
                <TileStatsReadout insets={chrome} corner={slots.stats}>
                    <StreamStatsHud
                        track={hudTrack} isLocal={isLocal} publication={hudPub}
                        audioTrack={hudAudioTrack} identity={p.identity}
                    />
                </TileStatsReadout>
            )}
            {!hudEnabled && isFocusedView && videoRes && !chromeHidden && (
                <TileStatsReadout insets={chrome} corner={slots.stats}>
                    <span className="text-white text-[10px] font-mono font-medium">{videoRes}</span>
                    {videoFps > 0 && (
                        <>
                            <span className="text-white/30 text-[10px]">·</span>
                            <span className="text-cl-lume/90 text-[10px] font-mono">{videoFps} fps</span>
                        </>
                    )}
                </TileStatsReadout>
            )}

            {/* The annotation tool cluster — `slots.tools`. Translucent. The
                owner's own tile only ever gets the requests menu (approve /
                decline / revoke who else may draw) — never a drawing
                toolbar of their own; see the annotCanDraw comment above.

                TOP-LEFT in fullscreen ("the top left corner where it is, is
                good"), TOP-RIGHT otherwise ("have ... the annotation in the top
                right"). Whichever it is, it is the opposite top corner from
                whatever the name pill has — the two would collide sharing one.
                The COORDINATE SPACE is settled and unchanged in both modes: it
                rides the picture via `chrome` (see videoRectChrome.ts) rather
                than the tile's box, which is what kept it out of the black bar.

                This wrapper stays `pointer-events-none` with each child
                re-enabling itself — do not make it interactive, or it swallows
                clicks meant for the video underneath. The hover-reveal below
                is done the same way, on the child, for exactly that reason. */}
            {/* No `maxWidth` on this cluster, unlike the name pill: these are
                interactive controls with fixed hit targets, and squeezing them
                to fit a narrow picture would make the tool harder to press
                rather than tidier. Text is the only thing worth clamping. */}
            {annotSurface && !chromeHidden && (
                <TileToolCluster insets={chrome} corner={slots.tools}>
                    {annotSurface && isLocal && (
                        <AnnotationRequestsMenu trackKey={annotKey} />
                    )}
                    {annotSurface && !isLocal && annotGranted && (
                        <AnnotationToolbar />
                    )}
                    {/* Hover/focus only — owner request. Just the ASK button:
                        the toolbar above is an armed tool and the requests menu
                        is somebody waiting on an answer, and hiding either of
                        those hides state rather than chrome. */}
                    {annotSurface && !isLocal && !annotGranted && (
                        <span className="cl-annot-reveal inline-flex">
                            <AnnotationRequestButton trackKey={annotKey} />
                        </span>
                    )}
                </TileToolCluster>
            )}

            {/* Name + avatar overlay — `slots.name`.
                FULLSCREEN, owner: "In a full screen video call can we have the
                person's name be in the top right corner of their video? not
                the bottom right corner" — and, on the follow-up, that "their
                video" means the picture, not the tile.
                NOT FULLSCREEN, same owner on the build that shipped that:
                "keep the name of video member in the bottom right."
                The corner is therefore mode-dependent; the ANCHOR is not — it
                is `chrome` (the picture's rect) in both, never the tile's own
                edges, which is the half of the original request that the
                letterboxing work settled for good. */}
            {!chromeHidden && (
            <TileNamePill insets={chrome} corner={slots.name} large={!!isFocusedView}>
                <div className={`relative ${isFocusedView ? 'w-7 h-7' : 'w-5 h-5'} rounded-full overflow-hidden shrink-0 ${showAvatarSpeaking ? 'ring-2 ring-green-500 shadow-[0_0_12px_rgba(34,197,94,0.5)]' : ''}`}>
                    <EncryptedAvatar
                        attachmentId={actualAvatarAttachmentId}
                        userId={p.identity}
                        token={token}
                        className="w-full h-full object-cover"
                        fallbackSize={isFocusedView ? 14 : 10}
                        disableClickProfile
                        bypassFriendGate
                    />
                    {/* Status badges */}
                    {isDeafened ? (
                        <div className="absolute inset-x-0 bottom-0 top-0 bg-red-500/80 flex items-center justify-center pointer-events-none">
                            <Headphones className="w-3 h-3 text-white" />
                        </div>
                    ) : isMuted ? (
                        <div className="absolute inset-x-0 bottom-0 top-0 bg-red-500/80 flex items-center justify-center pointer-events-none">
                            <MicOff className="w-3 h-3 text-white" />
                        </div>
                    ) : isLocalMuted ? (
                        <div className="absolute inset-x-0 bottom-0 top-0 bg-cl-raise/80 flex items-center justify-center pointer-events-none">
                            <MicOff className="w-3 h-3 text-[darkgray]" />
                        </div>
                    ) : null}
                </div>
                {/* `min-w-0` is what lets the pill's own maxWidth (the
                    picture's width) actually bite: a flex item defaults to
                    `min-width: auto`, so without this the name refuses to
                    shrink below its content and the pill overflows a narrow
                    picture back into the bar it was moved off. */}
                <span className={`text-white ${isFocusedView ? 'text-xs' : 'text-[10px]'} font-semibold truncate min-w-0 max-w-[80px]`}>{displayName}</span>
                <AnnotationGrantBadge identity={p.identity} size={isFocusedView ? 12 : 10} />
                {isScreenShare && <Monitor className="w-3 h-3 text-cl-lume shrink-0" />}
                {/* Watcher count. `showZero` only on your own share: on your
                    tile the number is feedback about something you started, so
                    "0" is information; on someone else's it would just be a
                    live tally of how few people are looking at them. */}
                {isScreenShare && (
                    <ViewerCountBadge
                        publisher={p.identity}
                        size={isFocusedView ? 12 : 10}
                        showZero={isLocal}
                    />
                )}
                {canStopWatching({ source, isLocal, onStopWatching }) && (
                    <StopWatchingButton name={displayName} onStop={onStopWatching!} size={isFocusedView ? 14 : 12} />
                )}
                {/* Hidden-stream indicator badges — gated on the OTHER source
                    actually existing right now. A camera tile only shows the
                    "hidden screenshare" badge if there really is a screenshare
                    being hidden; a screenshare tile only shows "hidden video"
                    when there's an active camera. The hide preference itself
                    is sticky in hiddenVideoIds/hiddenScreenShareIds — when the
                    publisher re-enables the source, the badge returns. */}
                {!isScreenShare && isHiddenScreenShare && hasActiveScreenShare && (
                    <div className="shrink-0 w-3.5 h-3.5 bg-cl-raise/90 rounded-full flex items-center justify-center">
                        <MonitorOff className="w-2 h-2 text-gray-400" />
                    </div>
                )}
                {isScreenShare && isHiddenVideo && hasActiveCamera && (
                    <div className="shrink-0 w-3.5 h-3.5 bg-cl-raise/90 rounded-full flex items-center justify-center">
                        <VideoOff className="w-2 h-2 text-gray-400" />
                    </div>
                )}
            </TileNamePill>
            )}
        </div>

        {showPopover && ReactDOM.createPortal(
            <PopoverMenu
                displayName={displayName}
                volume={volume}
                screenShareVolume={isScreenShare ? screenShareVolume : undefined}
                isLocalMuted={isLocalMuted}
                hasVideo={p.getTrackPublication(Track.Source.Camera) !== undefined}
                isVideoHidden={isHiddenVideo}
                hasScreenShare={p.getTrackPublication(Track.Source.ScreenShare) !== undefined}
                isScreenShareHidden={isHiddenScreenShare}
                isScreenShare={isScreenShare}
                onVolumeChange={setVolume}
                onScreenShareVolumeChange={isScreenShare ? setScreenShareVolume : undefined}
                isScreenShareMuted={isScreenShareMuted}
                onScreenShareMuteChange={isScreenShare ? setIsScreenShareMuted : undefined}
                onMuteChange={onToggleLocalMute}
                nsEnabled={nsEnabled}
                onNsEnabledChange={setNsEnabled}
                onHideVideoChange={onHideVideoChange}
                onHideScreenShareChange={onHideScreenShareChange}
                streamRes={videoRes ?? undefined}
                popoverRef={popoverRef}
                onClose={() => setShowPopover(false)}
                style={popoverPos}
                userId={p.identity}
                onViewProfile={() => setShowPopover(false)}
                localIdentity={annotMe}
                onRevokeAnnotation={() => setShowPopover(false)}
                canServerMute={canServerMute && !isLocal}
                serverMutedAudio={vtMeta.serverMutedAudio}
                serverMutedVideo={vtMeta.serverMutedVideo}
                serverMutedScreenShare={vtMeta.serverMutedScreenShare}
                serverDeafened={vtMeta.serverDeafened}
                onServerMuteAudio={onServerMuteTrack && !isLocal ? (m) => { onServerMuteTrack(p.identity, 'audio', m); setShowPopover(false); } : undefined}
                onServerMuteVideo={onServerMuteTrack && !isLocal ? (m) => { onServerMuteTrack(p.identity, 'video', m); setShowPopover(false); } : undefined}
                onServerMuteScreenShare={onServerMuteTrack && !isLocal ? (m) => { onServerMuteTrack(p.identity, 'screenshare', m); setShowPopover(false); } : undefined}
                onServerDeafen={onServerMuteTrack && !isLocal ? (d) => { onServerMuteTrack(p.identity, 'deafen', d); setShowPopover(false); } : undefined}
            />,
            document.body
        )}
        </>
    );
};
