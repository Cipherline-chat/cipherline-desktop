import React, { createContext, useContext, useState, useCallback, useRef, useMemo, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { Track } from 'livekit-client';
import type { CallStats } from '../hooks/useCallStats';
import type { ParticipantMeta } from '../utils/participantMetadata';
import { CallTelemetrySettersContext, CallStatsContext, type CallTelemetrySetters } from './callTelemetrySlices';

/** How long the fullscreen exit-fade ghost (below) stays mounted — must be
 *  >= the `.fullscreen-overlay-exit` CSS animation duration (index.css,
 *  200ms) so the timer never yanks the ghost out mid-fade. A little slack
 *  (not exact-equal) absorbs a missed frame or two without visibly cutting
 *  the animation short. */
const FULLSCREEN_EXIT_FADE_MS = 240;

export type { CallStats };

export interface FocusedStream {
    identity: string;
    source: Track.Source.Camera | Track.Source.ScreenShare;
}

// ── High-frequency telemetry context ────────────────────────────────────────
// Kept separate so 30 Hz speaking-flag updates don't force re-renders on
// consumers that only care about low-freq state (ControlBar, FullscreenOverlay,
// FocusedStreamBanner, CallPane, etc.).

interface CallTelemetryValue {
    /** Live call quality stats — populated by SidebarConference while a call is active. */
    callStats: CallStats;
    setCallStats: (stats: CallStats) => void;
    /** Per-participant track activity — identity → { hasCamera, hasScreenShare, isMuted }.
     *  Populated by SidebarConference; readable by outside-call UI (ServerContextPanel).
     *  Speaking is NOT here: it flips several times a second, so it lives in its
     *  own per-identity store (utils/callSpeakingStore.ts, read via SpeakingRing /
     *  useIsCallParticipantSpeaking) to keep this snapshot — and its subscribers'
     *  renders — down to genuine mute / camera / share changes.
     *  isMuted is true when the participant's mic track is muted (self-mute or server-mute). */
    participantTrackStates: Record<string, { hasCamera: boolean; hasScreenShare: boolean; isMuted?: boolean }>;
    /** A useState setter: accepts an updater, so writers can keep the previous
     *  object when nothing changed (see utils/flatRecordEqual.ts). */
    setParticipantTrackStates: React.Dispatch<React.SetStateAction<Record<string, { hasCamera: boolean; hasScreenShare: boolean; isMuted?: boolean }>>>;
    /** Per-participant parsed metadata flags (self-deafen + server-moderation).
     *  Populated by SidebarConference as it observes ParticipantMetadataChanged
     *  events. Outside-call UI (ServerContextPanel) reads this to display red
     *  moderation badges on participant rows AND to pre-fill the checkbox state
     *  in the right-click moderation menu. */
    participantMetadata: Record<string, ParticipantMeta>;
    setParticipantMetadata: React.Dispatch<React.SetStateAction<Record<string, ParticipantMeta>>>;
}

const CallTelemetryContext = createContext<CallTelemetryValue | null>(null);

export const useCallTelemetry = () => {
    const ctx = useContext(CallTelemetryContext);
    if (!ctx) throw new Error('useCallTelemetry must be used within a CallProvider');
    return ctx;
};

/** Returns null when called outside a CallProvider (for components that may render without a call). */
export const useCallTelemetrySafe = () => useContext(CallTelemetryContext);

// Narrow slices (setters-only, stats-only) live in ./callTelemetrySlices.ts —
// see there for why SidebarConference / ParticipantCard must not subscribe to
// the full telemetry value.

// ── Low-frequency UI state context ──────────────────────────────────────────

interface CallContextValue {
    focusedStream: FocusedStream | null;
    setFocusedStream: (stream: FocusedStream | null) => void;
    toggleFocusedStream: (stream: FocusedStream) => void;
    isFullscreen: boolean;
    setIsFullscreen: (v: boolean) => void;
    /** Called exactly once, from the call UI's own unmount cleanup
     *  (SidebarConference), whenever a call ends — docked or fullscreen.
     *  Unconditionally docks (a stale `true` must never be observed by the
     *  NEXT call, even briefly, since CallProvider outlives any one call)
     *  and, only when fullscreen was actually up at that moment, arms the
     *  short exit-fade ghost below so the cinema view doesn't just vanish. */
    endCallFullscreen: () => void;
    soloKickDialog: boolean;
    setSoloKickDialog: (v: boolean) => void;
    /** Local-mute / hide-video / hide-screenshare state — lifted from
     *  SidebarConference so the outside-call right-click menu in ServerContextPanel
     *  can show + toggle them. Setting these from outside the call has no audio/
     *  video effect, since SidebarConference owns the actual rendering; the only
     *  way they're useful from outside is to mutate them via the toggle helpers
     *  below, which dispatch back through SidebarConference's local-state path. */
    localMutedIds: Set<string>;
    hiddenVideoIds: Set<string>;
    hiddenScreenShareIds: Set<string>;
    toggleLocalMute: (identity: string, muted: boolean) => void;
    toggleHideVideo: (identity: string, hide: boolean) => void;
    toggleHideScreenShare: (identity: string, hide: boolean) => void;
    /** SidebarConference registers its own toggle implementations here on mount.
     *  Calling toggleLocalMute / toggleHideVideo / toggleHideScreenShare from
     *  outside the call delegates to whatever the in-call SidebarConference
     *  wired up (which has access to the actual LiveKit hooks). */
    registerLocalToggles: (impls: {
        toggleLocalMute?: (identity: string, muted: boolean) => void;
        toggleHideVideo?: (identity: string, hide: boolean) => void;
        toggleHideScreenShare?: (identity: string, hide: boolean) => void;
    }) => void;
    setLocalMutedIds: (s: Set<string>) => void;
    setHiddenVideoIds: (s: Set<string>) => void;
    setHiddenScreenShareIds: (s: Set<string>) => void;
    /** Mark an identity as "mid-screenshare-adjustment" for ~2s. Consumers
     *  (sound cues, focused-stream tear-down, fullscreen) treat track
     *  transitions on this identity as transparent so a republish doesn't
     *  visibly interrupt viewers. */
    markAdjusting: (identity: string, windowMs?: number) => void;
    isAdjusting: (identity: string) => boolean;
    /** True if the user picked the current focus by hand within `withinMs`.
     *  The focused pane's auto-advance consults this so it never yanks the view
     *  onto somebody else moments after a deliberate click — if the stream they
     *  just chose dies that fast, focus simply closes instead. A later manual
     *  focus always wins outright, since it sets `focusedStream` directly. */
    isRecentManualFocus: (withinMs?: number) => boolean;
}

/** How long a hand-picked focus is protected from auto-advance. Long enough to
 *  cover a click landing on a stream that is already on its way out, short
 *  enough that a normal "they stopped sharing" never falls inside it. */
export const MANUAL_FOCUS_GRACE_MS = 1200;

const CallContext = createContext<CallContextValue | null>(null);

export const useCallContext = () => {
    const ctx = useContext(CallContext);
    if (!ctx) throw new Error('useCallContext must be used within a CallProvider');
    return ctx;
};

/** Optional hook that returns null if not inside a CallProvider (for components that may render outside call context) */
export const useCallContextSafe = () => useContext(CallContext);

export const CallProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [focusedStream, setFocusedStream] = useState<FocusedStream | null>(null);
    const [isFullscreen, setIsFullscreenState] = useState(false);
    // Mirrors `isFullscreen` for the exit-fade decision below, which needs
    // its LATEST value inside a callback that must itself stay referentially
    // stable (see endCallFullscreen's empty dep array).
    const isFullscreenRef = useRef(false);
    useEffect(() => { isFullscreenRef.current = isFullscreen; }, [isFullscreen]);

    // ── Fullscreen exit-fade ghost ──────────────────────────────────────────
    // FullscreenOverlay (and everything else about a call) unmounts the
    // INSTANT the call ends — Dashboard.tsx's callPaneActive is deliberately
    // "no grace window, no exit choreography" for the docked call section
    // (see its comment), and FullscreenOverlay lives inside that same
    // subtree. So by the time we would want to fade the cinema view out, the
    // component that renders it is already gone. CallProvider, in contrast,
    // is mounted once for the whole session — so IT owns a tiny, LiveKit-
    // independent ghost (just the cinema-black backdrop, no video) that
    // outlives the real overlay's unmount and fades on its own.
    const [fullscreenExitFading, setFullscreenExitFading] = useState(false);
    const fullscreenExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearFullscreenExitTimer = useCallback(() => {
        if (fullscreenExitTimerRef.current) {
            clearTimeout(fullscreenExitTimerRef.current);
            fullscreenExitTimerRef.current = null;
        }
    }, []);
    // Arm the ghost: mount it, and take it back down one animation later.
    // Always restarts its own timer, so two arms in a row cannot leave a
    // half-length fade behind.
    const armFullscreenExitFade = useCallback(() => {
        clearFullscreenExitTimer();
        setFullscreenExitFading(true);
        fullscreenExitTimerRef.current = setTimeout(() => {
            setFullscreenExitFading(false);
            fullscreenExitTimerRef.current = null;
        }, FULLSCREEN_EXIT_FADE_MS);
    }, [clearFullscreenExitTimer]);

    /**
     * The ONE way fullscreen is entered or left deliberately — the ControlBar
     * toggle, Escape, anything else.
     *
     * Leaving fades, exactly like leaving a call while fullscreen already did
     * ("There's also no exit full screen animation unless you leave the call.
     * I want the same fade animation for just exiting full screen"). Same
     * ghost, same 240ms, same `prefers-reduced-motion` rule — deliberately the
     * existing machinery rather than a second, parallel one.
     *
     * ENTERING is what cancels a fade, and the only thing that does. Without
     * that, a call ending and a new one going fullscreen inside the fade
     * window would let the old ghost bleed into the new cinema view. The
     * inverse — a redundant `setIsFullscreen(false)` while already docked —
     * deliberately does NOTHING rather than cancelling: this guard is what
     * makes it safe for FullscreenOverlay's Escape layer (utils/escapeStack.ts)
     * to call `setIsFullscreen(false)` unconditionally when it fires, so a
     * stray Escape right after a call ended can't cut an in-flight fade short.
     */
    const setIsFullscreen = useCallback((v: boolean) => {
        if (v) {
            clearFullscreenExitTimer();
            setFullscreenExitFading(false);
        } else if (isFullscreenRef.current) {
            armFullscreenExitFade();
        }
        setIsFullscreenState(v);
    }, [clearFullscreenExitTimer, armFullscreenExitFade]);
    const endCallFullscreen = useCallback(() => {
        if (isFullscreenRef.current) {
            armFullscreenExitFade();
        } else {
            clearFullscreenExitTimer();
            setFullscreenExitFading(false);
        }
        // Unconditional: a new call must always start docked (see the
        // interface doc above) — this fires whether or not fullscreen was
        // actually up.
        setIsFullscreenState(false);
    }, [clearFullscreenExitTimer, armFullscreenExitFade]);
    // Defensive: only matters if CallProvider itself ever unmounts (e.g.
    // full app teardown) while a fade timer is in flight.
    useEffect(() => clearFullscreenExitTimer, [clearFullscreenExitTimer]);

    const [soloKickDialog, setSoloKickDialog] = useState(false);
    const [callStats, setCallStats] = useState<CallStats>({ pingMs: null, packetLossPercent: null });
    const [participantTrackStates, setParticipantTrackStates] = useState<Record<string, { hasCamera: boolean; hasScreenShare: boolean; isMuted?: boolean }>>({});
    const [participantMetadata, setParticipantMetadata] = useState<Record<string, ParticipantMeta>>({});
    const [localMutedIds, setLocalMutedIds] = useState<Set<string>>(new Set());
    const [hiddenVideoIds, setHiddenVideoIds] = useState<Set<string>>(new Set());
    const [hiddenScreenShareIds, setHiddenScreenShareIds] = useState<Set<string>>(new Set());
    // Ref so we can swap toggle impls without re-creating the context value.
    const toggleImplsRef = useRef<{
        toggleLocalMute?: (identity: string, muted: boolean) => void;
        toggleHideVideo?: (identity: string, hide: boolean) => void;
        toggleHideScreenShare?: (identity: string, hide: boolean) => void;
    }>({});
    const registerLocalToggles = useCallback((impls: {
        toggleLocalMute?: (identity: string, muted: boolean) => void;
        toggleHideVideo?: (identity: string, hide: boolean) => void;
        toggleHideScreenShare?: (identity: string, hide: boolean) => void;
    }) => {
        toggleImplsRef.current = impls;
    }, []);
    const toggleLocalMute = useCallback((identity: string, muted: boolean) => {
        toggleImplsRef.current.toggleLocalMute?.(identity, muted);
    }, []);
    const toggleHideVideo = useCallback((identity: string, hide: boolean) => {
        toggleImplsRef.current.toggleHideVideo?.(identity, hide);
    }, []);
    const toggleHideScreenShare = useCallback((identity: string, hide: boolean) => {
        toggleImplsRef.current.toggleHideScreenShare?.(identity, hide);
    }, []);
    // identity → expiry ms. Lives in a ref so markAdjusting / isAdjusting have
    // stable identities across renders and don't cause re-renders themselves.
    const adjustingRef = useRef<Map<string, number>>(new Map());

    // When the user last changed focus by hand (the only caller of
    // toggleFocusedStream is VideoTile's click handler). A ref, not state:
    // nothing renders off it, and it must not invalidate `value`.
    const lastManualFocusAtRef = useRef(0);

    const toggleFocusedStream = useCallback((stream: FocusedStream) => {
        lastManualFocusAtRef.current = Date.now();
        setFocusedStream(prev => {
            if (prev && prev.identity === stream.identity && prev.source === stream.source) {
                return null; // unfocus
            }
            return stream;
        });
    }, []);

    const isRecentManualFocus = useCallback(
        (withinMs = MANUAL_FOCUS_GRACE_MS) => Date.now() - lastManualFocusAtRef.current < withinMs,
        [],
    );

    const markAdjusting = useCallback((identity: string, windowMs = 2000) => {
        adjustingRef.current.set(identity, Date.now() + windowMs);
    }, []);

    const isAdjusting = useCallback((identity: string): boolean => {
        const exp = adjustingRef.current.get(identity);
        if (!exp) return false;
        if (Date.now() > exp) {
            adjustingRef.current.delete(identity);
            return false;
        }
        return true;
    }, []);

    // Low-frequency UI state. Memoize so `callCtx` has a stable identity across
    // parent re-renders — without this every consumer's useEffect([callCtx]) fires
    // on every render, including CallPane's screenshare-cue effect with its short
    // initial timer that would never get to fire.
    const value = useMemo(() => ({
        focusedStream,
        setFocusedStream,
        toggleFocusedStream,
        isFullscreen,
        setIsFullscreen,
        endCallFullscreen,
        soloKickDialog,
        setSoloKickDialog,
        markAdjusting,
        isAdjusting,
        isRecentManualFocus,
        localMutedIds,
        hiddenVideoIds,
        hiddenScreenShareIds,
        toggleLocalMute,
        toggleHideVideo,
        toggleHideScreenShare,
        registerLocalToggles,
        setLocalMutedIds,
        setHiddenVideoIds,
        setHiddenScreenShareIds,
    }), [focusedStream, isFullscreen, endCallFullscreen, soloKickDialog, toggleFocusedStream, markAdjusting, isAdjusting, isRecentManualFocus, localMutedIds, hiddenVideoIds, hiddenScreenShareIds, toggleLocalMute, toggleHideVideo, toggleHideScreenShare, registerLocalToggles]);

    // High-frequency telemetry — separate memo so 30 Hz speaking-flag updates
    // only re-render CallTelemetryContext subscribers (ServerContextPanel, ParticipantCard).
    const telemetryValue = useMemo(() => ({
        callStats,
        setCallStats,
        participantTrackStates,
        setParticipantTrackStates,
        participantMetadata,
        setParticipantMetadata,
    }), [callStats, participantTrackStates, participantMetadata]);
    const telemetrySetters = useMemo<CallTelemetrySetters>(
        () => ({ setCallStats, setParticipantTrackStates, setParticipantMetadata }),
        [],
    );

    // The ghost itself: plain cinema-black backdrop, no video, no controls —
    // FullscreenOverlay's real content is already gone by the time this
    // renders (see the doc comment above endCallFullscreen). Portals into
    // the same `#call-fullscreen-root` node FullscreenOverlay uses, which
    // Dashboard.tsx renders unconditionally (a descendant of CallProvider,
    // never gated on activeCall), so it's always available here. Falls back
    // to <body> defensively — should never actually be hit.
    const fullscreenExitGhost = fullscreenExitFading && typeof document !== 'undefined'
        ? ReactDOM.createPortal(
            <div className="call-no-select fixed inset-0 z-[9999] bg-[#05070F] fullscreen-overlay-exit" />,
            document.getElementById('call-fullscreen-root') || document.body,
        )
        : null;

    return (
        <CallContext.Provider value={value}>
            <CallTelemetryContext.Provider value={telemetryValue}>
                <CallTelemetrySettersContext.Provider value={telemetrySetters}>
                    <CallStatsContext.Provider value={callStats}>
                        {children}
                        {fullscreenExitGhost}
                    </CallStatsContext.Provider>
                </CallTelemetrySettersContext.Provider>
            </CallTelemetryContext.Provider>
        </CallContext.Provider>
    );
};
