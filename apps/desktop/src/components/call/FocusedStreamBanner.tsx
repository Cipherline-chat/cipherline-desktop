import React from 'react';
import ReactDOM from 'react-dom';
import { useParticipants, useLocalParticipant } from '@livekit/components-react';
import { Track, RemoteTrackPublication } from 'livekit-client';
import { prewarmRemoteQuality } from '../../utils/remoteVideoQuality';
import { useCallContext } from '../../contexts/CallContext';
import { VideoTile } from './VideoTile';
import secureLocalStore from '../../utils/secureLocalStore';
import {
    PublishOrder,
    collectFocusCandidates,
    isFocusableShare,
    isStreamLive,
    pickNextFocus,
    type FocusCandidate,
    type ParticipantLike,
} from '../../utils/pickNextFocus';
import {
    MIN_BANNER_HEIGHT,
    MAX_BANNER_RATIO,
    clampBannerHeight,
    fitBannerRatio,
} from './focusBannerFit';
import { focusSwap, FOCUS_CROSSFADE_MS } from './focusCrossfade';
import { ROSTER_ONLY } from '../../utils/callRosterEvents';

// Both clamps, and the auto-fit arithmetic they bound, live in
// focusBannerFit.ts so they are unit-testable without a DOM.
// Ratio-of-window-height, persisted — same shape as Dashboard's
// leftRatio/rightRatio (see Dashboard.tsx ~2000-2060): survives resize by
// recomputing pixels from the ratio rather than storing a fixed pixel
// height, and survives relaunches via secureLocalStore.
const BANNER_RATIO_KEY = 'cipherline_call_banner_ratio';
const DEFAULT_BANNER_RATIO = 0.4;

interface FocusedStreamBannerProps {
    token: string;
    /** The active call's session id (calls.service's session, or a huddle's
     *  call_id). Used only to detect "this is a NEW call" so the banner
     *  height resets to auto-fit rather than reusing whatever height a
     *  PREVIOUS, unrelated call was last resized to — see the manualRatio
     *  reset effect below. */
    callSessionId?: string;
    isLocalDeafened: boolean;
    localMutedParticipantIds: Set<string>;
    onToggleLocalMute: (identity: string, muted: boolean) => void;
    isGroup?: boolean;
    fallbackAvatars?: Record<string, string>;
    localAvatarUrl?: string;
    remoteAvatarUrl?: string;
    hiddenVideoIds: Set<string>;
    hiddenScreenShareIds: Set<string>;
    onHideVideoChange: (identity: string, hide: boolean) => void;
    onHideScreenShareChange: (identity: string, hide: boolean) => void;
    onFocusedStreamChange?: (active: boolean) => void;
    /** Stop watching a remote screen share (red X in the tile's name pill). */
    onStopWatchingScreenshare?: (identity: string) => void;
}

export const FocusedStreamBanner = ({
    token,
    callSessionId,
    isLocalDeafened,
    localMutedParticipantIds,
    onToggleLocalMute,
    isGroup,
    fallbackAvatars,
    localAvatarUrl,
    remoteAvatarUrl,
    hiddenVideoIds,
    hiddenScreenShareIds,
    onHideVideoChange,
    onHideScreenShareChange,
    onFocusedStreamChange,
    onStopWatchingScreenshare,
}: FocusedStreamBannerProps) => {
    const callCtx = useCallContext();
    const { focusedStream } = callCtx;
    const participants = useParticipants(ROSTER_ONLY); // see utils/callRosterEvents.ts
    const { localParticipant } = useLocalParticipant();

    const portalRoot = document.getElementById('call-focus-root');

    // ── Crossfade when switching focused streams ─────────────────────────────
    // `shownFocus` tracks what's currently rendered — it lags behind `focusedStream`
    // by ~150ms so we can fade out the old tile before swapping in the new one.
    const [shownFocus, setShownFocus] = React.useState(focusedStream);
    const [crossfading, setCrossfading] = React.useState(false);

    // Pre-warm the newly focused camera's top layer NOW, not when its tile
    // mounts after the crossfade below: the SFU switch (~0.3–0.8 s measured)
    // then overlaps the fade instead of starting after it. The focus tile's
    // own claim takes over once mounted (utils/remoteVideoQuality.ts).
    React.useEffect(() => {
        if (!focusedStream) return;
        const pub = participants.find(p => p.identity === focusedStream.identity)?.getTrackPublication(focusedStream.source);
        if (!(pub instanceof RemoteTrackPublication) || !pub.track) return;
        return prewarmRemoteQuality(pub);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusedStream?.identity, focusedStream?.source]);

    // Only a SWITCH (another stream already on screen) crossfades. A fresh
    // focus shows at once — it used to crossfade too, with nothing to fade but
    // the stream being focused, which blinked it out and back in over its
    // first ~160 ms. See ./focusCrossfade.ts.
    React.useEffect(() => {
        const step = focusSwap(shownFocus, focusedStream);
        if (step !== 'crossfade') {
            setShownFocus(focusedStream);
            setCrossfading(false);
            return;
        }
        setCrossfading(true);
        const t = setTimeout(() => {
            setShownFocus(focusedStream);
            setCrossfading(false);
        }, FOCUS_CROSSFADE_MS);
        return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusedStream?.identity, focusedStream?.source]);

    // Use `shownFocus` for rendering (falls back to focusedStream on first mount)
    const displayFocus = shownFocus ?? focusedStream;

    // Find the focused participant
    const focusedParticipant = displayFocus
        ? participants.find(p => p.identity === displayFocus.identity)
        : null;

    // Auto-unfocus if participant left or track is gone (uses focusedStream, not displayFocus)
    const focusedParticipantLive = focusedStream
        ? participants.find(p => p.identity === focusedStream.identity)
        : null;

    // ── Focus auto-advance ledger ────────────────────────────────────────────
    // Kept in step with the room on every participants change, and declared
    // BEFORE the teardown effect below so that by the time teardown runs on the
    // same commit the ledger has already dropped the stream that just ended and
    // still holds the publish order of everything that survived.
    const orderRef = React.useRef(new PublishOrder());
    const candidatesRef = React.useRef<FocusCandidate[]>([]);

    // The viewer's Watch set (SidebarConference's, mirrored via CallContext):
    // a remote share is only ever on this stage while it is being watched.
    const watchedShares = callCtx.watchedScreenShareIds;

    React.useEffect(() => {
        candidatesRef.current = collectFocusCandidates(
            participants as unknown as ParticipantLike[],
            orderRef.current,
            { video: hiddenVideoIds, screenShare: hiddenScreenShareIds },
            watchedShares,
        );
    }, [participants, hiddenVideoIds, hiddenScreenShareIds, watchedShares]);

    // When the focused stream ends — camera off, share stopped, participant
    // gone — hand the pane to another live video if there is one, otherwise
    // clear focus so the layout falls back to the ordinary chat view.
    React.useEffect(() => {
        if (!focusedStream) return;

        const advance = () => {
            // A focus the user picked seconds ago is theirs; if it dies this
            // fast, close rather than bounce them onto somebody else.
            const next = callCtx.isRecentManualFocus()
                ? null
                : pickNextFocus(candidatesRef.current, focusedStream);
            callCtx.setFocusedStream(next);
        };

        if (!focusedParticipantLive) {
            advance();
            return;
        }
        if (isStreamLive(focusedParticipantLive as unknown as ParticipantLike, focusedStream.source)) return;
        // If the sharer is mid-republish (Change Source / Adjust Quality /
        // toggle audio) don't tear the focus down — the new publication will
        // arrive within the adjusting window and the focus will pick it up.
        if (focusedStream.source === Track.Source.ScreenShare && callCtx.isAdjusting(focusedStream.identity)) {
            return;
        }
        advance();
    }, [focusedStream, focusedParticipantLive, participants]);

    // Auto-unfocus if the stream is hidden via the popover menu
    React.useEffect(() => {
        if (!focusedStream) return;
        const isHidden = focusedStream.source === Track.Source.Camera
            ? hiddenVideoIds.has(focusedStream.identity)
            : hiddenScreenShareIds.has(focusedStream.identity);
        if (isHidden) callCtx.setFocusedStream(null);
    }, [focusedStream, hiddenVideoIds, hiddenScreenShareIds]);

    // Auto-unfocus a remote share this client is not watching. The stage
    // renders a live VideoTile (picture AND share audio) for whatever is
    // focused, so a focus that outlived the watch — restored after Home /
    // Friends parked it, kept across a call-panel remount that reset the
    // Watch set — would show and play a share nobody opted into. Unfocusing
    // drops it back to the context panel, where it is a Watch gate again.
    // (Stop-watching already clears its own focus; this is the backstop.)
    React.useEffect(() => {
        if (!focusedStream) return;
        const isLocalFocus = focusedStream.identity === localParticipant?.identity;
        if (!isFocusableShare({ identity: focusedStream.identity, isLocal: isLocalFocus }, focusedStream.source, watchedShares)) {
            callCtx.setFocusedStream(null);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusedStream, watchedShares, localParticipant?.identity]);

    // Notify parent whenever focus becomes active / inactive
    React.useEffect(() => {
        onFocusedStreamChange?.(!!focusedStream);
    }, [!!focusedStream]);

    // ── Banner height: ratio-based + persisted, mirroring Dashboard's sidebar
    // ratio pattern, plus an auto-fit-to-video wrinkle sidebars don't need ──
    //
    // `manualRatio` is the user's explicit choice for THIS call. Once set it
    // ALWAYS wins for the rest of THIS call — same "a persisted ratio wins
    // over any computed default" contract as leftRatio/rightRatio. It used
    // to also carry across to every FUTURE call via secureLocalStore, with
    // no reset — drag the handle once, ever, and auto-fit silently stopped
    // running for good, no matter how differently-shaped the next camera
    // was. Direct owner ask: "for the first time in the call it should
    // automatically [fit] ... then the user can adjust the view after if
    // they need more space" — i.e. auto-fit is the default for every NEW
    // call, and a manual choice should only outlive the call it was made
    // in. The reset effect right below does that: it nulls manualRatio the
    // moment callSessionId changes, so the initial load from storage here
    // (still useful for the very first render before a session id is known)
    // gets superseded before the user ever sees it apply to the wrong call.
    const [manualRatio, setManualRatio] = React.useState<number | null>(() => {
        const saved = parseFloat(secureLocalStore.getItem(BANNER_RATIO_KEY) || '');
        return Number.isFinite(saved) && saved > 0 && saved < 1 ? saved : null;
    });
    // Resets manualRatio exactly once per distinct call session (including
    // the very first one this component sees), never again for the SAME
    // ongoing call — so a mid-call drag still sticks for the rest of it.
    const resetForSessionRef = React.useRef<string | undefined>(undefined);
    React.useEffect(() => {
        if (!callSessionId || callSessionId === resetForSessionRef.current) return;
        resetForSessionRef.current = callSessionId;
        setManualRatio(null);
    }, [callSessionId]);
    // `autoRatio` is a transient (never persisted) fit computed from the
    // freshly-focused stream's own natural aspect ratio — see the effect
    // below. Cameras AND screen shares both drive it.
    //
    // Screen shares were excluded at first, on the theory that "a desktop
    // capture benefits from more room, not an exact-fit box". That was
    // wrong in practice: more room than the capture needs is just a black
    // bar, and it reads as the same defect the camera fix removed. The fit
    // has never assumed 16:9 — it is computed from
    // videoHeight / videoWidth — so a 16:10, 21:9, 4:3 or portrait-window
    // share fits exactly as well as a camera does; only the clamps below
    // (MIN_BANNER_HEIGHT, MAX_BANNER_RATIO) can leave a bar, and only for a
    // stream too tall or too wide to fit the column at all.
    const [autoRatio, setAutoRatio] = React.useState<number | null>(null);

    const [windowHeight, setWindowHeight] = React.useState(() => window.innerHeight);
    React.useEffect(() => {
        const onResize = () => setWindowHeight(window.innerHeight);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    // Persist the user's explicit choice only — never the auto-fit value,
    // which is a per-focus computation, not a preference.
    React.useEffect(() => {
        if (manualRatio === null) return;
        try { secureLocalStore.setItem(BANNER_RATIO_KEY, String(manualRatio)); } catch {}
    }, [manualRatio]);

    const videoHostRef = React.useRef<HTMLDivElement>(null);

    // Auto-fit: when a stream becomes newly focused (identity or source
    // changes) and the user has never manually resized, size the banner so
    // the video's own aspect ratio fills the available width with no crop
    // and no letterbox — the ask being "fit the picture without needing to
    // scroll". Both surfaces are object-contain in the focused view (see
    // VideoTile.tsx — the camera switched from object-cover so a mid-resize
    // aspect mismatch never crops real picture; the screen share has always
    // been contain), so this match is what keeps that letterbox at ~zero in
    // steady state rather than something cover would paper over on its own.
    //
    // A screen share's intrinsic size is not fixed the way a camera's is: the
    // sharer resizing a shared window, or switching source, changes
    // videoWidth/videoHeight on the SAME element with no remount and no
    // track republish. That is already covered — the element's own 'resize'
    // event is wired below alongside 'loadedmetadata' — and it is what makes
    // the fit follow a share that changes shape mid-call.
    // Re-fits on window resize too (the available width changes with
    // it), same as this file's ordinary windowHeight tracking above — but
    // only in auto mode; a manual choice is a fixed ratio, deliberately NOT
    // width-dependent, same as the sidebar ratios.
    //
    // The host div carries NO padding (see the render below — a previous
    // version had 16px of px-2 baked in, which meant the fitted box, and
    // therefore the video, was never actually as wide as the chat column
    // it's supposed to match).
    //
    // Finding the <video> element is NOT a one-shot querySelector at effect
    // setup: LiveKit attaches the element from inside VideoTile's own effect,
    // which on a freshly-focused stream has not necessarily run yet by the
    // time this effect's body executes on the same commit. A one-shot query
    // that comes up empty used to give up permanently, silently falling back
    // to DEFAULT_BANNER_RATIO for the rest of that focus — a real, and
    // visibly wrong, letterbox with no relation to the video's actual shape.
    // A MutationObserver on the host keeps watching until the element (or a
    // later swap of it, e.g. on a track republish) actually shows up.
    React.useEffect(() => {
        if (manualRatio !== null) return;
        if (!displayFocus) return;
        const host = videoHostRef.current;
        if (!host) return;

        let video: HTMLVideoElement | null = null;

        const fit = () => {
            if (!video || !host) return;
            const ratio = fitBannerRatio({
                availableWidth: host.clientWidth,
                videoWidth: video.videoWidth,
                videoHeight: video.videoHeight,
                windowHeight: window.innerHeight,
            });
            // null = the <video> has no metadata yet, or the host has not
            // been laid out. Leave the current height alone; 'loadedmetadata'
            // / the ResizeObserver will call back with real numbers.
            if (ratio !== null) setAutoRatio(ratio);
        };

        const attach = (el: HTMLVideoElement) => {
            if (video === el) return;
            if (video) {
                video.removeEventListener('loadedmetadata', fit);
                video.removeEventListener('resize', fit);
            }
            video = el;
            video.addEventListener('loadedmetadata', fit);
            video.addEventListener('resize', fit);
            if (video.videoWidth >= 2) fit();
        };

        const findAndAttach = () => {
            const el = host.querySelector('video');
            if (el) attach(el);
        };

        findAndAttach();
        const mutationObserver = new MutationObserver(findAndAttach);
        mutationObserver.observe(host, { childList: true, subtree: true });
        // ResizeObserver on the HOST, not a window 'resize' listener: dragging
        // the sidebar/chat-column divider, or this very banner's own resize
        // handle, changes the host's actual width/height without the OS
        // window ever resizing — a plain 'resize' listener would silently
        // miss those and leave autoRatio computed against a width that's no
        // longer current, which is what "still see black" looks like on a
        // call that was already focused before a layout change rather than a
        // fresh one. Firing on every observed size change (not just once) is
        // also what makes a live resize drag track the video continuously
        // instead of only catching up once the drag ends.
        const resizeObserver = new ResizeObserver(fit);
        resizeObserver.observe(host);
        return () => {
            mutationObserver.disconnect();
            resizeObserver.disconnect();
            if (video) {
                video.removeEventListener('loadedmetadata', fit);
                video.removeEventListener('resize', fit);
            }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [displayFocus?.identity, displayFocus?.source, manualRatio]);

    const bannerHeight = React.useMemo(() => {
        const ratio = manualRatio ?? autoRatio ?? DEFAULT_BANNER_RATIO;
        return clampBannerHeight(ratio * windowHeight, windowHeight);
    }, [manualRatio, autoRatio, windowHeight]);

    const handleDragStart = React.useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const startY = e.clientY;
        const startHeight = bannerHeight;
        const onMouseMove = (mv: MouseEvent) => {
            const winH = window.innerHeight;
            const maxHeight = Math.round(winH * MAX_BANNER_RATIO);
            const next = Math.max(MIN_BANNER_HEIGHT, Math.min(maxHeight, startHeight + mv.clientY - startY));
            setManualRatio(next / winH);
        };
        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }, [bannerHeight]);

    if (!focusedStream || !displayFocus || !focusedParticipant || !portalRoot) return null;

    return ReactDOM.createPortal(
        // bg-transparent, not bg-cl-abyss: VideoTile's own wrapper background
        // was already made transparent (see its own comment) specifically so
        // no distinct box would show behind the camera — but this banner
        // sits directly BEHIND VideoTile with the exact same footprint (no
        // padding between them, "VideoTile fills edge-to-edge" below), so
        // its own bg-cl-abyss was the very next opaque layer and showed
        // through unchanged the moment VideoTile's own background stopped
        // hiding it — reported live as "now it looks like how it did."
        // #call-focus-root (this portal's target, Dashboard.tsx) has no
        // background of its own, so transparent here reaches all the way
        // through to the panel's actual background, same as the rest of it.
        <div
            className="call-no-select w-full bg-transparent focus-banner-enter flex flex-col overflow-hidden relative"
            style={{ height: bannerHeight, maxHeight: 'none' }}
        >
            {/* Crossfade wrapper — no padding so VideoTile fills edge-to-edge.
                `flex items-center justify-center` centres the focused tile
                both vertically and horizontally inside the banner. Camera
                and screenshare are both object-contain (see VideoTile.tsx);
                the auto-fit effect above sizes the box to match the freshly-
                focused stream's own aspect ratio — camera or share alike —
                which is what keeps the letterbox at ~zero in steady state.
                This centering covers the brief window before that recompute
                lands, and the residual bar on a stream whose shape the
                MIN_BANNER_HEIGHT / MAX_BANNER_RATIO clamps cannot honour
                (a very tall portrait-window share, say). */}
            <div
                className="flex-1 min-h-0 flex items-center justify-center"
                style={{ opacity: crossfading ? 0 : 1, transition: crossfading ? 'opacity 0.14s ease-in' : 'opacity 0.0s' }}
            >
                <div ref={videoHostRef} className="w-full h-full flex items-center justify-center">
                <VideoTile
                    key={`focused-${displayFocus.identity}-${displayFocus.source}`}
                    p={focusedParticipant}
                    source={displayFocus.source}
                    localParticipant={localParticipant}
                    token={token}
                    localAvatarUrl={localAvatarUrl}
                    remoteAvatarUrl={remoteAvatarUrl}
                    isLocalDeafened={isLocalDeafened}
                    isLocalMuted={localMutedParticipantIds.has(focusedParticipant.identity)}
                    onToggleLocalMute={(v) => onToggleLocalMute(focusedParticipant.identity, v)}
                    isGroup={isGroup}
                    fallbackAvatars={fallbackAvatars}
                    isHiddenVideo={hiddenVideoIds.has(focusedParticipant.identity)}
                    isHiddenScreenShare={hiddenScreenShareIds.has(focusedParticipant.identity)}
                    onHideVideoChange={(v) => onHideVideoChange(focusedParticipant.identity, v)}
                    onHideScreenShareChange={(v) => onHideScreenShareChange(focusedParticipant.identity, v)}
                    isFocusedView={true}
                    onStopWatching={onStopWatchingScreenshare ? () => onStopWatchingScreenshare(focusedParticipant.identity) : undefined}
                    style={displayFocus.source === Track.Source.ScreenShare ? { height: '100%' } : undefined}
                />
                </div>
            </div>
            {/* Drag handle — sits below the video, centred pill */}
            <div
                className="shrink-0 h-1 cursor-row-resize flex items-center justify-center"
                onMouseDown={handleDragStart}
            >
                <div className="w-10 h-[2px] bg-white/20 hover:bg-white/40 rounded-full transition-colors" />
            </div>
        </div>,
        portalRoot
    );
};
