import React, { useEffect } from 'react';
import ReactDOM from 'react-dom';
import { useParticipants, useLocalParticipant } from '@livekit/components-react';
import { Track, RemoteParticipant, VideoQuality, Participant } from 'livekit-client';
import { useCallContext } from '../../contexts/CallContext';
import { useOsWindowFullscreen } from '../../hooks/useOsWindowFullscreen';
import { useEscape } from '../../hooks/useEscape';
import { VideoTile } from './VideoTile';
import { ParticipantCard } from './ParticipantCard';
import { ScreenShareGate } from './ScreenShareGate';
import {
    bestGrid,
    chooseFullscreenLayout,
    clampStripHeight,
    focusToggleMeaningful,
    fullscreenConsoleBottom,
    fullscreenConsoleMetrics,
    fullscreenTitleStripHeight,
    stripCardSize,
    stripHeightBounds,
    stripMetricsAt,
    stripScrollLaneReservationPx,
    FS_CONSOLE_COLS,
    FS_CONSOLE_DOCK_GAP_PX,
    STRIP_JUSTIFY_CONTENT,
    type StageTileRef,
} from '../../utils/fullscreenCallLayout';
import { ROSTER_ONLY } from '../../utils/callRosterEvents';

/**
 * FullscreenOverlay — the cinema view for a call.
 *
 * ── What this is, structurally
 *
 * A portal at `#call-fullscreen-root` holding four things:
 *
 *   TITLEBAR a 34px `bg-cl-abyss` drag strip pinned to the top — see
 *           "Reclaiming the titlebar" below. The one piece here that is
 *           ALWAYS draggable and never fades.
 *   STAGE   the one thing you are looking at (solo / focus), or an equal grid
 *           of everything (grid / people). Always `flex-1`.
 *   STRIP   a row of everyone who is not on the stage. Reserved space in
 *           normal flow, DRAG-RESIZABLE between a floor and a cap that the
 *           cards provably fit inside, never squeezed — see `stripMetricsAt`
 *           / `clampStripHeight` in utils/fullscreenCallLayout.ts. The row is
 *           LEFT-ALIGNED at every width and item count
 *           (`STRIP_JUSTIFY_CONTENT`) and scrolls horizontally on wheel,
 *           trackpad and keyboard with the native scrollbar hidden so it
 *           cannot eat card height (`.cl-fs-strip-row`).
 *   CHROME  the app's ONE real <ControlBar>, which SidebarConference
 *           re-portals into `#call-fullscreen-controls-root` while this is
 *           up. index.css parks it bottom-RIGHT as a 3x2 block (see
 *           `fullscreenConsoleBox`) rather than a strip across the bottom —
 *           ALWAYS DOCKED inside the STRIP whenever there is one, at every
 *           strip height, SCALING DOWN to fit rather than floating over the
 *           stage tile (`fullscreenConsoleMetrics`). Only grid/people mode,
 *           which has no strip at all, puts it over the viewport's bottom
 *           edge. There is no top-right cluster: the latency pill and the
 *           "Back to grid" button both used to live there and are gone —
 *           see "What was removed" below.
 *
 * Which of stage/strip you get is decided entirely by `chooseFullscreenLayout`,
 * a pure function with its own test file. This component renders the answer.
 *
 * ── The four owner complaints this rebuild is answering
 *
 * 1. "If there's only one video ... there's no point [toggling]." Handled by
 *    `mode: 'solo'`, which renders one stage tile with the focus click
 *    disabled outright (`focusToggleDisabled`) rather than letting a click
 *    swap between two identical pictures. The counting rule lives with the
 *    layout function; in short, a "video" is any tile that competes for stage
 *    space — your own camera included, an unsubscribed share's gate included,
 *    an audio-only participant not.
 *
 * 2. "It needs the zoom features we have on the non-fullscreen focused video."
 *    The stage tile is rendered with `isFocusedView`, which is what arms
 *    VideoTile's `useVideoZoomPan` (and its fit-clip). That was previously only
 *    reachable by clicking into focus mode — impossible to discover in the
 *    single-video case, since the click appeared to do nothing. Grid and strip
 *    thumbnails deliberately do NOT zoom: clamping a pan inside a 170px cell is
 *    not a feature.
 *
 * 3. "It needs the annotation features." Same mechanism — the stage tile is a
 *    focused view, so the toolbar / request button / grant menu all arm there,
 *    and the request→grant dock (AnnotationRequestsDock, portaled to <body> by
 *    CallPane at a higher z-index than this overlay) already reaches over the
 *    top. What changed is the opposite direction: strip thumbnails now pass
 *    `annotationSurface={false}`, because the old blanket "anything in
 *    fullscreen is drawable" armed a pen toolbar on a 100px-tall thumbnail.
 *
 * 4. "I'm not a fan of the lower bar ... it's resizable, and the people under
 *    it often get their icons cut off." — and then, later, "I want to be able
 *    to resize the bottom view when focused in full screen by dragging it up
 *    and down." Both are satisfied, because the complaint was never the
 *    dragging: it was the ARBITRARY FLOOR. The old one was 80px while a
 *    ParticipantCard at `sizeMode="large"` needs ~110px for its avatar, name
 *    pill and the mute/deafen badges hanging off the avatar's corner.
 *
 *    So the handle is back, clamped by `clampStripHeight` to
 *    [STRIP_MIN_HEIGHT_PX, 26% of the window] — the floor being the height a
 *    `tiny` card provably fits inside, derived from the same constants
 *    `stripMetrics` already used, not a fresh number. And the card SIZE now
 *    follows the height (`stripDensityForHeight`), so dragging down swaps a
 *    large card for a tiny one instead of cutting either in half. Tiles still
 *    never shrink to fit more in; overflow scrolls horizontally.
 *
 *    The chosen height is remembered for the app session in a module-scope
 *    ref below — deliberately NOT persisted to disk, which would mean a new
 *    `secureLocalStore` key and a `backupRegistry` classification for a purely
 *    ephemeral view preference.
 *
 * ── What was removed
 *
 * The top-right floating cluster is gone entirely, on two direct requests:
 *
 *   · The latency pill ("the ping is kinda in a weird spot. I want this gone
 *     entirely from the full screen view"). `CallStatsPill` itself is NOT
 *     deleted — SidebarConference still renders the docked call's own stats,
 *     and ParticipantCard / FloatingHuddleCard / ServerContextPanel all reuse
 *     its `SignalBars` + `signalQuality` exports. Only this instance is gone.
 *   · "Back to grid". The stage tile's own click already unfocuses (that is
 *     `focusToggleMeaningful`, true in `focus` mode), and Escape leaves
 *     fullscreen outright — so removing the button strands nobody.
 *
 * ── Reclaiming the titlebar
 *
 * This portal is `fixed inset-0`, so it also covers Dashboard.tsx's own 34px
 * drag titlebar — the window could not be moved at all while a call was
 * fullscreen, and on Windows the OS-drawn `titleBarOverlay` caption buttons
 * (main.ts, also 34px, `#0B0F1E`) painted on top of the portal regardless,
 * floating over flat cinema black with nothing behind them.
 *
 * The fix is a real titlebar of our own: `bg-cl-abyss`, exactly 34px so it
 * lines up with both the app titlebar and the Windows overlay with no seam,
 * carrying `-webkit-app-region: drag`. It renders NO content of its own on
 * any platform — matching Dashboard.tsx's real titlebar exactly, which is
 * empty for the same reason on macOS/Windows (native chrome draws over it)
 * and only Linux ever puts a `no-drag`-wrapped `<WindowControls>` there. That
 * makes "reserve space for the OS buttons" moot by construction: there is
 * nothing of ours in that band, on either side, for any platform's button
 * placement to land on — a stronger guarantee than measuring an exact button
 * width, which is an OS/theme-version detail liable to drift.
 *
 * STAGE, STRIP, and the floating CHROME all move into a `relative flex-1`
 * wrapper that starts right after this strip, so the CHROME's
 * `absolute top-4 right-4` resolves against that wrapper's own top edge —
 * i.e. 34px lower than before — with no arithmetic needed in the JSX. The
 * previous version faked this gap with `paddingTop: 'max(32px, ...)'` on the
 * OUTER portal div, which pushed STAGE/STRIP (in-flow) down but did nothing
 * for the absolutely-positioned CHROME, whose containing block is that same
 * div's padding edge — padding does not move it. That is exactly why the
 * chrome (and, transitively, VideoTile's own top-left resolution/fps readout,
 * which is positioned relative to the STAGE tile) used to collide with the
 * window buttons: `top-4` measured from the box's true top, ignoring the
 * padding entirely.
 *
 * It disappears (0px, nothing rendered) once the OS window is ACTUALLY
 * fullscreen — no titlebar, no window buttons, nothing to give back — see
 * `useOsWindowFullscreen`. That is a different thing from `isFullscreen`
 * above, which is this component's own cinema mode and says nothing about
 * the OS window.
 *
 * Deliberately NOT part of the idle fade (`data-cl-fs-idle`, which now reaches
 * the control console and nothing else): it is the window's only drag handle
 * while this portal is up, and a strip that faded out with the console would
 * take that with it. The STRIP's own resize handle is exempt for the same
 * reason — a control you cannot see is a control you cannot reach.
 *
 * ── Glass
 *
 * The floating console echoes `.cl-console-inner` (index.css): a flat 5% white
 * wash, `blur(16px) saturate(160%)`, a hairline inset rim. Stacked, its radius
 * steps down from a 999px capsule to a tile-shaped 22px so it sits in the same
 * radius family as the video tiles it now parks beside (`rounded-xl` = 20px in
 * this project's Tailwind scale). The STRIP deliberately gets none of the
 * glass — it sits in flow on the flat cinema black with nothing textured
 * behind it, and a wash there reads as a rendered plate rather than glass.
 * Glass only where something is floating over video.
 */

interface FullscreenOverlayProps {
    token: string;
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
    /** Which screenshares the user has subscribed to (passed from SidebarConference) */
    subscribedScreenshares: Set<string>;
    onSubscribeScreenshare: (identity: string) => void;
    canServerMute?: boolean;
    onServerMuteTrack?: (targetUserId: string, trackType: 'audio' | 'video' | 'screenshare' | 'deafen', muted: boolean) => void;
}

/** How long the pointer must sit still before the floating chrome fades out. */
const CHROME_IDLE_MS = 3500;
/** The DOM id of the portal root the real <ControlBar> is re-parented into
 *  while fullscreen is up (Dashboard.tsx). Named once because both the CSS that
 *  positions it and the measurement below have to agree on it. */
const CONSOLE_ROOT_ID = 'call-fullscreen-controls-root';

/**
 * The strip height the user last dragged to, remembered for the app session.
 *
 * Module scope on purpose: FullscreenOverlay unmounts every time the call ends
 * or fullscreen is left, so component state would forget it between calls,
 * while a `secureLocalStore` key would be real at-rest persistence for an
 * ephemeral view preference (and would need a `backupRegistry` classification
 * to satisfy that module's source-scanning test). `null` = never dragged; the
 * automatic roster-driven height applies.
 */
let sessionStripHeight: number | null = null;

export const FullscreenOverlay = ({
    token,
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
    subscribedScreenshares,
    onSubscribeScreenshare,
    canServerMute,
    onServerMuteTrack,
}: FullscreenOverlayProps) => {
    const callCtx = useCallContext();
    const { focusedStream, isFullscreen } = callCtx;
    const participants = useParticipants(ROSTER_ONLY); // see utils/callRosterEvents.ts
    const { localParticipant } = useLocalParticipant();
    // The OS window's OWN fullscreen state — NOT `isFullscreen` above, which
    // is this component's cinema overlay and says nothing about the window.
    // See useOsWindowFullscreen's doc comment and "Reclaiming the titlebar"
    // above.
    const osWindowFullscreen = useOsWindowFullscreen();
    const titleStripHeight = fullscreenTitleStripHeight(osWindowFullscreen);

    // Escape exits fullscreen through the shared stack. This layer is only
    // pushed while actually fullscreen, so a kit modal (screen-share picker),
    // context menu, or the profile popover opened on top registers its OWN
    // layer afterward and is what a press closes first — this one is reached
    // only once every surface above it has closed. Never ends/leaves the call.
    useEscape(() => callCtx.setIsFullscreen(false), isFullscreen);

    // Always open fullscreen showing everything — clear any prior focused
    // stream on entry. With several streams that means the grid; with one it
    // means solo, which ignores focus anyway. Kept from the previous version:
    // landing on a focus carried over from the docked sidebar view was
    // disorienting, and there is no "restore it on exit" here because a focus
    // you did not pick is not worth restoring.
    useEffect(() => {
        if (isFullscreen) callCtx.setFocusedStream(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isFullscreen]);

    // ── Collect what can go on the stage ─────────────────────────────────────
    // MUST happen above every hook below and above the `!isFullscreen` early
    // return: hooks have to run in the same order on every render (React error
    // #310), and the strip/grid hooks below depend on these counts.
    const remoteParticipants = participants.filter(p => p.identity !== localParticipant?.identity) as RemoteParticipant[];

    const byIdentity = new Map<string, Participant>();
    for (const p of participants) byIdentity.set(p.identity, p);

    const cameras: Participant[] = [];
    const subscribedShares: RemoteParticipant[] = [];
    const gatedShares: RemoteParticipant[] = [];

    // The local camera is a stage tile like any other. It is NOT excluded from
    // the "how many videos are there" count: if your self-view is the only
    // picture on screen, a grid of one and a focused view of it are the same
    // image, which is precisely the case this rebuild exists to fix.
    if (localParticipant?.isCameraEnabled) cameras.push(localParticipant);

    for (const p of remoteParticipants) {
        const camPub = p.getTrackPublication(Track.Source.Camera);
        if (camPub?.isSubscribed && !camPub.isMuted && !hiddenVideoIds.has(p.identity)) {
            cameras.push(p);
        }
        const ssPub = p.getTrackPublication(Track.Source.ScreenShare);
        if (ssPub && !hiddenScreenShareIds.has(p.identity)) {
            if (subscribedScreenshares.has(p.identity)) subscribedShares.push(p);
            else gatedShares.push(p);
        }
    }

    // Order: shares first (a room looking at a share is looking at the share),
    // then cameras, then the click-to-watch gates.
    const stage: StageTileRef[] = [
        ...subscribedShares.map(p => ({ identity: p.identity, source: Track.Source.ScreenShare as const, gated: false })),
        ...cameras.map(p => ({ identity: p.identity, source: Track.Source.Camera as const, gated: false })),
        ...gatedShares.map(p => ({ identity: p.identity, source: Track.Source.ScreenShare as const, gated: true })),
    ];

    const staged = new Set(stage.map(t => t.identity));
    const audioOnly = participants.filter(p => !staged.has(p.identity)).map(p => p.identity);

    const layout = chooseFullscreenLayout({ stage, audioOnly, focused: focusedStream });
    const canToggleFocus = focusToggleMeaningful(layout);

    // ── Strip sizing ─────────────────────────────────────────────────────────
    const [windowHeight, setWindowHeight] = React.useState(() =>
        typeof window === 'undefined' ? 1080 : window.innerHeight);
    React.useEffect(() => {
        const onResize = () => setWindowHeight(window.innerHeight);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    const stripItems = layout.mode === 'solo' || layout.mode === 'focus' ? layout.strip : [];
    // Size the participant strip against the height actually left to the
    // STAGE/STRIP column, not the raw window — the title strip above it
    // (0 or 34px) is real space taken out of flow now, not padding, so
    // STRIP_MAX_VIEWPORT_FRACTION would otherwise creep past its intended
    // share of the screen by exactly that much.
    const stripViewport = Math.max(0, windowHeight - titleStripHeight);

    // ── Strip drag ───────────────────────────────────────────────────────────
    // `null` until the user drags, at which point the dragged height wins over
    // the automatic one for the rest of the app session (sessionStripHeight).
    // State mirrors the module ref only so React re-renders on a drag; the ref
    // is what survives this component's unmount between calls.
    const [dragHeight, setDragHeight] = React.useState<number | null>(sessionStripHeight);
    const [dragging, setDragging] = React.useState(false);
    const dragOrigin = React.useRef<{ y: number; height: number } | null>(null);
    const strip = stripMetricsAt(stripItems.length, stripViewport, dragHeight);

    // The console's REAL painted geometry for this strip height — full size
    // when the strip can hold it, scaled down when it cannot.
    //
    // Owner: "IT SHOULD ALWAYS BE DOWN THERE, and if there's not enough room
    // then size it down to make room." So there is no longer a
    // does-it-fit branch anywhere in this component: whenever there is a
    // strip, the console is inside it, and the only variable is how big.
    //
    // Derived from the NOMINAL box, never from `measuredConsoleH` below — that
    // would be a feedback loop (scale -> rendered size -> measurement ->
    // scale). The measurement is used ONLY for centring, which cannot change a
    // height. Not memoized, same reasoning as bestGrid below: the React
    // Compiler memoizes this render for free and a hand useMemo would bail it
    // out.
    const consoleMetrics = fullscreenConsoleMetrics(strip.height);

    // ── The console's REAL height, measured ─────────────────────────────────
    //
    // Owner: "The call controls are in the right spot now, but they need to be
    // vertically centred inside that lower area on a focused stream where the
    // other video members are. It needs to stay centred too when it is
    // resized."
    //
    // `fullscreenConsoleBottom` centres by arithmetic — `(stripHeight -
    // consoleHeight) / 2` — so the centring is exactly as correct as the
    // `consoleHeight` it is handed, and nothing else in the chain can be wrong:
    // the strip's own band is set from `strip.height` verbatim, and the
    // console is `position: fixed` against the viewport, whose bottom edge IS
    // the strip's bottom edge. `fullscreenConsoleBox()` is a NOMINAL figure
    // derived from the control/gap/padding constants (3x2 at 44/8/10 = 168x116)
    // — a claim about what CSS will paint, never an observation of it. If the
    // rendered block is ever a different height (a live-share segment that
    // reflows, a seventh control, an OS text-scale setting, a stray padding
    // that outranks the `> * { padding: 0 }` reset, a platform rendering
    // difference), the offset is off by exactly half the difference, silently,
    // with no test able to catch it — the constant and the CSS only ever
    // *claim* to agree.
    //
    // So measure instead. A ResizeObserver on the portal root is also what
    // makes "stays centred when it is resized" structural rather than a
    // property of the current numbers: the height is re-read whenever the
    // block actually changes, and the strip-height dependency below re-centres
    // on every drag frame.
    //
    // No feedback loop: this effect only ever writes `bottom`, which cannot
    // change the observed element's height. Zero heights are ignored — the
    // root is `display: none` until <html data-cl-fullscreen> is set, and the
    // ControlBar is re-parented in a tick later, so the first observation can
    // legitimately be 0 and the nominal box is the right thing to use until a
    // real one lands.
    const [measuredConsoleH, setMeasuredConsoleH] = React.useState<number | null>(null);
    React.useEffect(() => {
        if (!isFullscreen) return;
        const el = document.getElementById(CONSOLE_ROOT_ID);
        if (!el || typeof ResizeObserver === 'undefined') return;
        // No eager synchronous read: ResizeObserver delivers an observation for
        // the element right after `observe()`, so the measurement lands a frame
        // later on its own — and a setState in the effect BODY is a cascading
        // render (react-hooks/set-state-in-effect) for a value the nominal box
        // already covers for that one frame.
        const ro = new ResizeObserver(() => {
            const h = el.getBoundingClientRect().height;
            if (h > 0) setMeasuredConsoleH(prev => (prev === h ? prev : h));
        });
        ro.observe(el);
        // Deliberately NOT reset to null on the way out: it is the same element
        // every time fullscreen opens, so last session's measurement is a
        // better first guess than the nominal box, and the observer corrects it
        // within a frame regardless.
        return () => ro.disconnect();
    }, [isFullscreen]);
    /** What the CENTRING is computed against: the measured block, or the
     *  scaled box until the first real measurement lands. Only the centring —
     *  the scale itself is derived from the nominal box, so this can never
     *  feed back into the size. */
    const consoleHeight = measuredConsoleH ?? consoleMetrics.height;

    // Is there a strip for the console to live in at all?
    //
    // This used to be `consoleDocksInStrip(strip.height, consoleHeight)` — a
    // real fits/doesn't-fit test whose false branch floated the console over
    // the video. That branch is gone (see the docking section in
    // fullscreenCallLayout.ts): with a strip the console ALWAYS docks and
    // scales to fit, so the only remaining question is whether a strip exists,
    // which is a `grid`/`people` vs `solo`/`focus` question and nothing to do
    // with heights.
    const dockControlsInStrip = strip.height > 0;
    // How much narrower the strip's scroll container must be so its own
    // `overflow-x-auto` clip boundary stops short of the docked console's
    // x-range at EVERY scroll offset — see `stripScrollLaneReservationPx`'s
    // doc comment for why trailing padding alone cannot do this. Fed the
    // SCALED width, so a console shrunk to fit a short strip gives the cards
    // back the width it is no longer using.
    const stripLaneReservationPx = stripScrollLaneReservationPx(dockControlsInStrip, consoleMetrics.width);

    // Deliberately NOT useCallback — same reason bestGrid below is not
    // useMemo'd: hand-memoization whose inputs come from values computed during
    // this render makes the React Compiler bail out of optimizing the WHOLE
    // component (`preserve-manual-memoization`), which costs far more than four
    // closures on one 7px div. Let the compiler do it.
    const applyHeight = (next: number) => {
        const clamped = clampStripHeight(next, stripViewport);
        sessionStripHeight = clamped;
        setDragHeight(clamped);
    };
    // Pointer capture on the handle itself, so the drag survives the pointer
    // leaving the 7px hit strip — the classic "grab it, move fast, lose it".
    // Height grows as the pointer moves UP, hence the inverted delta.
    const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        dragOrigin.current = { y: e.clientY, height: strip.height };
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
    };
    const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const origin = dragOrigin.current;
        if (!origin) return;
        applyHeight(origin.height + (origin.y - e.clientY));
    };
    const onDragEnd = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragOrigin.current) return;
        dragOrigin.current = null;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        setDragging(false);
    };
    // Keyboard parity: the handle is a real separator control, so arrows resize
    // it. Without this the strip height would be mouse-only, which is the kind
    // of thing that quietly fails an accessibility pass.
    const onDragKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const step = e.shiftKey ? 24 : 8;
        const bounds = stripHeightBounds(stripViewport);
        let next: number | null = null;
        if (e.key === 'ArrowUp') next = strip.height + step;
        else if (e.key === 'ArrowDown') next = strip.height - step;
        else if (e.key === 'Home') next = bounds.min;
        else if (e.key === 'End') next = bounds.max;
        if (next === null) return;
        e.preventDefault();
        applyHeight(next);
    };

    // ── Scrolling the strip ──────────────────────────────────────────────────
    //
    // Owner: "Also if there's too many have a scroll bar." The row has always
    // been `overflow-x-auto`, so it HAS scrolled; what it lacked was two of the
    // three ways a user would actually try to do it.
    //
    // The native scrollbar itself is hidden (`.cl-fs-strip-row` in index.css):
    // a horizontal scrollbar is laid out INSIDE the scroll container, so it
    // eats ~11px off `height: 100%` children — and it only appears once the row
    // overflows, i.e. the cards would visibly shrink the moment a seventh
    // person joins. With request (3) parking the console in this same band and
    // the floor now at 100px, that is height the cards cannot spare. A
    // scroll-shadow vignette in index.css carries the affordance instead, and
    // costs no layout at all.
    //
    // Hiding it makes these two handlers load-bearing rather than polish:
    const stripRowRef = React.useRef<HTMLDivElement>(null);
    // WHEEL. Chromium does map a vertical wheel onto horizontal scroll for a
    // container that only scrolls horizontally — but that is an implementation
    // detail of one engine, and it is the single most likely gesture here. Map
    // it explicitly, taking whichever delta is larger so a horizontal trackpad
    // swipe (deltaX) and a mouse wheel (deltaY) both work. Only preventDefault
    // when there is actually somewhere to scroll, so a non-overflowing strip
    // does not swallow the event from whatever is behind it.
    const onStripWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        const el = e.currentTarget;
        if (el.scrollWidth <= el.clientWidth) return;
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (delta === 0) return;
        e.preventDefault();
        el.scrollLeft += delta;
    };
    // KEYBOARD. Arrows step by roughly one card, Home/End jump to the ends —
    // which is only meaningful because the row is left-aligned (request 4), so
    // `scrollLeft: 0` really is the first card.
    //
    // `e.target === e.currentTarget` is the important guard: the cards inside
    // contain their own focusable controls, and stealing ArrowLeft from a
    // focused control inside a card would break that control instead of
    // scrolling.
    const onStripKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget) return;
        const el = e.currentTarget;
        const step = Math.max(80, Math.round(el.clientWidth * 0.5));
        let next: number | null = null;
        if (e.key === 'ArrowRight') next = el.scrollLeft + step;
        else if (e.key === 'ArrowLeft') next = el.scrollLeft - step;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = el.scrollWidth;
        if (next === null) return;
        e.preventDefault();
        el.scrollLeft = next;
    };

    // ── Grid measurement ─────────────────────────────────────────────────────
    const gridRef = React.useRef<HTMLDivElement>(null);
    const [gridSize, setGridSize] = React.useState<{ w: number; h: number }>({ w: 0, h: 0 });
    React.useEffect(() => {
        const el = gridRef.current;
        if (!el) return;
        const ro = new ResizeObserver(entries => {
            const cr = entries[0]?.contentRect;
            if (cr) setGridSize({ w: cr.width, h: cr.height });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, [layout.mode]); // re-measure when the grid element mounts after a mode change

    const gridCount = layout.mode === 'grid'
        ? layout.tiles.length + layout.people.length
        : layout.mode === 'people'
            ? layout.people.length
            : 0;
    // Not memoized: bestGrid is a loop over a call roster (a handful of
    // iterations), so a useMemo here buys nothing and costs the React Compiler
    // a bail-out on this whole component (`preserve-manual-memoization`, since
    // its inputs come from arrays built during render).
    const { cols: gridCols, rows: gridRows } = bestGrid(gridCount, gridSize.w, gridSize.h);

    // ── Floating-chrome idle fade ────────────────────────────────────────────
    // Standard cinema behaviour: the console and the top cluster fade out once
    // the pointer sits still, and ANY input brings them straight back. This is
    // what lets the console float over the bottom of a screen share without
    // permanently covering it. Driven by a data attribute on <html> rather than
    // local state because the console is not in this component's tree — it is
    // the app's real <ControlBar>, portaled in by SidebarConference.
    //
    // Deliberately NOT React state: nothing this component renders depends on
    // it, and routing a pointer-rate signal through setState would re-render
    // the whole overlay (every tile with it) on each wake/sleep edge. The flag
    // is written straight to <html> and read only by CSS.
    React.useEffect(() => {
        if (!isFullscreen) return;
        const root = document.documentElement;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let asleep = false;
        const sleep = () => { asleep = true; root.dataset.clFsIdle = 'on'; };
        const wake = () => {
            // `wheel` and `pointermove` arrive at pointer rate during a zoom or
            // pan, so the DOM write is guarded — only the transition touches it.
            if (asleep) { asleep = false; delete root.dataset.clFsIdle; }
            if (timer) clearTimeout(timer);
            timer = setTimeout(sleep, CHROME_IDLE_MS);
        };
        wake();
        // Capture phase, on window: the gesture may be consumed by a tile's own
        // zoom/pan handlers (which stopPropagation), and a wake that only fires
        // for un-consumed events would leave the chrome hidden exactly while
        // the user is actively working the picture.
        const evs: (keyof WindowEventMap)[] = ['pointermove', 'pointerdown', 'keydown', 'wheel'];
        for (const ev of evs) window.addEventListener(ev, wake, true);
        return () => {
            for (const ev of evs) window.removeEventListener(ev, wake, true);
            if (timer) clearTimeout(timer);
            delete root.dataset.clFsIdle;
        };
    }, [isFullscreen]);

    // ── Publish the chrome geometry to the surfaces we do not own ────────────
    // `#call-fullscreen-controls-root` (Dashboard.tsx) and AnnotationRequestsDock
    // both live outside this portal. Rather than threading props through two
    // unrelated trees, the overlay publishes its own geometry as CSS custom
    // properties on <html> for the lifetime of the fullscreen session, and
    // clears them on the way out so the dock falls back to its docked-call
    // position.
    React.useEffect(() => {
        const root = document.documentElement;
        if (!isFullscreen) return;
        root.dataset.clFullscreen = 'on';
        root.style.setProperty('--cl-fs-console-cols', `${FS_CONSOLE_COLS}`);
        return () => {
            delete root.dataset.clFullscreen;
            delete root.dataset.clFsIdle;
            for (const prop of [
                '--cl-fs-console-bottom', '--cl-call-dock-bottom',
                '--cl-fs-console-cs', '--cl-fs-console-cg', '--cl-fs-console-cp',
                '--cl-fs-console-cols', '--cl-fs-console-w',
            ]) root.style.removeProperty(prop);
        };
    }, [isFullscreen]);

    // The console's SIZE, republished whenever the strip height changes it.
    //
    // index.css cannot compute any of this: the console's container is
    // `contain: inline-size`, so it MUST be handed an explicit width or it
    // resolves to zero (see fullscreenConsoleBox). Split out of the effect
    // above — which now only owns the `data-cl-fullscreen` flag and the fixed
    // column count — because these four now depend on `strip.height` and would
    // otherwise re-run the whole session setup on every drag frame.
    //
    // The three source lengths are scaled and the width is re-derived from
    // them, rather than the block being `transform: scale()`d: real layout
    // keeps the glyphs crisp and, more importantly, keeps the hit targets
    // honestly the size they look (see FS_CONSOLE_MIN_CONTROL_PX).
    React.useEffect(() => {
        if (!isFullscreen) return;
        const root = document.documentElement;
        root.style.setProperty('--cl-fs-console-cs', `${consoleMetrics.control}px`);
        root.style.setProperty('--cl-fs-console-cg', `${consoleMetrics.gap}px`);
        root.style.setProperty('--cl-fs-console-cp', `${consoleMetrics.pad}px`);
        root.style.setProperty('--cl-fs-console-w', `${consoleMetrics.width}px`);
    }, [isFullscreen, consoleMetrics.control, consoleMetrics.gap, consoleMetrics.pad, consoleMetrics.width]);

    React.useEffect(() => {
        if (!isFullscreen) return;
        const root = document.documentElement;
        // Always docked inside the strip when there IS one — vertically centred
        // in the band, at every height, with the console scaled to fit rather
        // than allowed to float over the video (owner: "IT SHOULD ALWAYS BE
        // DOWN THERE"). `strip.height` is 0 in grid/people mode, where there is
        // no band and the console sits above the viewport's bottom edge as it
        // always has.
        const consoleBottom = fullscreenConsoleBottom(strip.height, consoleHeight);
        root.style.setProperty('--cl-fs-console-bottom', `${consoleBottom}px`);
        // How far the annotation request dock parks above the console's BOTTOM
        // edge. Derived from the console's real box rather than guessed, so
        // making the console taller can never quietly bury the dock behind it —
        // which is why this follows the measured height too.
        root.style.setProperty(
            '--cl-call-dock-bottom',
            `${consoleBottom + consoleHeight + FS_CONSOLE_DOCK_GAP_PX}px`,
        );
    }, [isFullscreen, strip.height, consoleHeight]);

    // ── All hooks are registered above this line. Safe to early-return now. ──
    if (!isFullscreen) return null;

    const portalRoot = document.getElementById('call-fullscreen-root') || document.body;

    const tileProps = (identity: string, source: Track.Source.Camera | Track.Source.ScreenShare) => {
        const p = byIdentity.get(identity)!;
        return {
            p,
            source,
            localParticipant,
            token,
            localAvatarUrl,
            remoteAvatarUrl,
            isLocalDeafened,
            isLocalMuted: localMutedParticipantIds.has(identity),
            onToggleLocalMute: (v: boolean) => onToggleLocalMute(identity, v),
            isGroup,
            fallbackAvatars,
            isHiddenVideo: hiddenVideoIds.has(identity),
            isHiddenScreenShare: hiddenScreenShareIds.has(identity),
            onHideVideoChange: (v: boolean) => onHideVideoChange(identity, v),
            onHideScreenShareChange: (v: boolean) => onHideScreenShareChange(identity, v),
            canServerMute,
            onServerMuteTrack,
        };
    };

    const cardProps = (identity: string) => {
        const p = byIdentity.get(identity)!;
        return {
            p,
            localParticipant,
            token,
            localAvatarUrl,
            remoteAvatarUrl,
            isLocalDeafened,
            compact: false,
            isLocalMuted: localMutedParticipantIds.has(identity),
            onToggleLocalMute: (v: boolean) => onToggleLocalMute(identity, v),
            isHiddenVideo: hiddenVideoIds.has(identity),
            isHiddenScreenShare: hiddenScreenShareIds.has(identity),
            onHideVideoChange: (v: boolean) => onHideVideoChange(identity, v),
            onHideScreenShareChange: (v: boolean) => onHideScreenShareChange(identity, v),
            isGroup,
            fallbackAvatars,
            canServerMute,
            onServerMuteTrack,
        };
    };

    const gateProps = (identity: string) => ({
        p: byIdentity.get(identity) as RemoteParticipant,
        localParticipant,
        token,
        // Per-identity, NOT the single `remoteAvatarUrl` — that is the
        // CONVERSATION's avatar, which happens to be the other person's in a
        // 1:1 DM and is therefore wrong for everyone the moment a third
        // participant exists ("I don't see the person's profile picture in the
        // 'watch' screen share button"). `fallbackAvatars` is SidebarConference's
        // identity-keyed map, pre-seeded from the server member list and from
        // each participant's own LiveKit token metadata for exactly this.
        avatarAttachmentId: fallbackAvatars?.[identity] ?? remoteAvatarUrl,
        isLocalDeafened,
        isLocalMuted: localMutedParticipantIds.has(identity),
        onToggleLocalMute: (v: boolean) => onToggleLocalMute(identity, v),
        onSubscribed: onSubscribeScreenshare,
        onHideScreenShare: () => onHideScreenShareChange(identity, true),
        fillContainer: true,
        // Every tile in this overlay puts the participant's name in its
        // top-right corner — the stage tile, the grid cells, the strip
        // thumbnails. A gate sitting among them is a tile too, so it labels
        // itself the same way instead of only inline in its centred CTA.
        cornerChrome: true,
    });

    /** A stage tile: the ONE thing the whole screen is for. */
    const renderStage = (tile: StageTileRef) => (
        <div
            // Keyed on the stream so switching focus remounts (and therefore
            // re-runs the enter animation and resets zoom/pan), rather than
            // mutating one tile's props under a live zoom transform.
            key={`stage-${tile.identity}-${tile.source}-${tile.gated}`}
            className="w-full h-full fs-stage-enter"
        >
            {/* A stage tile can be GATED. `resolveFocus` refuses to focus a
                gate, but `chooseFullscreenLayout` takes `stage[0]` verbatim in
                SOLO mode — and one unsubscribed share with no cameras anywhere
                is exactly a one-element stage. Rendering a VideoTile for that
                put an unsubscribed ScreenShare source on the whole screen:
                `hasActiveScreenShare` is false, so it painted the camera-off
                avatar fallback with no picture and, crucially, no "Watch"
                button — the share was unreachable from fullscreen. The gate is
                what that state is FOR. */}
            {tile.gated ? (
                <ScreenShareGate {...gateProps(tile.identity)} />
            ) : (
                <VideoTile
                    {...tileProps(tile.identity, tile.source)}
                    isFocusedView={true}
                    quality={VideoQuality.HIGH}
                    // Solo mode: the click that used to cycle between two identical
                    // renderings is disabled at the source, not merely ignored.
                    focusToggleDisabled={!canToggleFocus}
                />
            )}
        </div>
    );

    /** A fixed-size strip thumbnail. Never shrinks — see stripMetrics. */
    const stripBox = (key: string, children: React.ReactNode) => (
        <div key={key} className="shrink-0 h-full aspect-video rounded-xl overflow-hidden relative">
            {children}
        </div>
    );

    const gridStyle: React.CSSProperties = {
        gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${gridRows}, minmax(0, 1fr))`,
        alignContent: 'stretch',
        justifyContent: 'stretch',
    };
    /* Each cell is `minmax(0, 1fr)` so it can shrink below content size; tiles
       fill via width/height 100% and letterbox through their own object-fit.
       No `aspect-video` on the wrapper — that is what used to force tiles
       larger than their cell on ultrawide and overlap the floating chrome. */
    const cellClass = 'rounded-xl overflow-hidden';
    const cellStyle: React.CSSProperties = { width: '100%', height: '100%', minWidth: 0, minHeight: 0 };
    // Bandwidth: MEDIUM up to six cells, LOW above that.
    const gridQuality = gridCount > 6 ? VideoQuality.LOW : VideoQuality.MEDIUM;

    return ReactDOM.createPortal(
        // #05070F is the deepest stop of the Descent's sea gradient — the call's
        // "cinema black" stays on the brand's blue-black axis instead of a
        // neutral gray-black.
        <div className="call-no-select fixed inset-0 z-[9999] bg-[#05070F] flex flex-col fullscreen-overlay-enter">
            {/* ── TITLEBAR ────────────────────────────────────────────────────
                Renders nothing on any platform — see "Reclaiming the
                titlebar" above for why that's deliberate, not a stub. Absent
                entirely once the OS window is genuinely fullscreen (no
                titlebar, no window buttons left to give a home to). */}
            {titleStripHeight > 0 && (
                <div
                    className="cl-fs-titlestrip drag-region shrink-0 w-full bg-cl-abyss"
                    style={{ height: titleStripHeight }}
                />
            )}

            {/* STAGE, STRIP and the floating CHROME share this wrapper so the
                CHROME's `absolute top-4 right-4` resolves against ITS top
                edge — i.e. already below the titlebar — with no arithmetic
                needed here. */}
            <div className="relative flex-1 min-h-0 flex flex-col">
                {/* ── STAGE ───────────────────────────────────────────────────── */}
                <div className="flex-1 min-h-0 overflow-hidden p-2">
                    {(layout.mode === 'solo' || layout.mode === 'focus') && renderStage(layout.stage)}

                    {layout.mode === 'grid' && (
                        <div ref={gridRef} className="w-full h-full grid gap-2" style={gridStyle}>
                            {layout.tiles.map(tile => (
                                <div key={`${tile.identity}-${tile.source}-${tile.gated}`} className={cellClass} style={cellStyle}>
                                    {tile.gated
                                        ? <ScreenShareGate {...gateProps(tile.identity)} />
                                        : <VideoTile {...tileProps(tile.identity, tile.source)} isGridView={true} quality={gridQuality} />}
                                </div>
                            ))}
                            {layout.people.map(identity => (
                                <div
                                    key={`audio-${identity}`}
                                    className={`${cellClass} flex items-center justify-center bg-cl-abyss border border-cl-border/30`}
                                    style={cellStyle}
                                >
                                    {/* `cornerChrome`: this cell is a TILE — the same
                                        rounded box as the VideoTiles beside it — so its
                                        name belongs in the same top-right corner as
                                        theirs. It is also the component that renders a
                                        camera-off participant in fullscreen (the
                                        collection pass above drops a muted/hidden camera
                                        out of `stage` and into `audioOnly`), which is the
                                        black tile the owner circled. */}
                                    <ParticipantCard {...cardProps(identity)} sizeMode="large" cornerChrome />
                                </div>
                            ))}
                        </div>
                    )}

                    {layout.mode === 'people' && (
                        // An audio-only call someone put into fullscreen. No stage /
                        // strip split to make: everyone gets an equal cell.
                        <div ref={gridRef} className="w-full h-full grid gap-2" style={gridStyle}>
                            {layout.people.map(identity => (
                                <div
                                    key={`audio-${identity}`}
                                    className={`${cellClass} flex items-center justify-center bg-cl-abyss border border-cl-border/30`}
                                    style={cellStyle}
                                >
                                    <ParticipantCard {...cardProps(identity)} sizeMode="large" cornerChrome />
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* ── STRIP ───────────────────────────────────────────────────────
                    Drag-resizable between a floor and a cap the cards provably fit
                    inside (clampStripHeight), tiles never squeezed. The row is
                    LEFT-ALIGNED — one rule at every width and item count; see
                    `STRIP_JUSTIFY_CONTENT` for why that beats the `safe center`
                    it replaced, which silently switched to `start` the moment the
                    row overflowed.

                    Flat, not glass: this sits in normal flow against the cinema
                    black with nothing textured behind it, so a wash here would read
                    as a rendered plate. Glass is for the floating console only. */}
                {stripItems.length > 0 && (
                    <div
                        className="shrink-0 w-full overflow-hidden relative"
                        style={{ height: strip.height }}
                    >
                        {/* The handle IS the strip's top border — a 7px grab band
                            drawing the same hairline the strip used to draw with
                            `border-t`, so there is no second line to explain. The
                            grip pips only appear on hover/focus/drag; at rest this
                            looks exactly like the border it replaced.

                            Deliberately outside the `data-cl-fs-idle` fade (see
                            index.css): the idle timer must never take away the only
                            way to resize this. */}
                        <div
                            role="separator"
                            aria-orientation="horizontal"
                            aria-label="Resize the participant strip"
                            aria-valuenow={strip.height}
                            aria-valuemin={stripHeightBounds(stripViewport).min}
                            aria-valuemax={stripHeightBounds(stripViewport).max}
                            tabIndex={0}
                            onPointerDown={onDragStart}
                            onPointerMove={onDragMove}
                            onPointerUp={onDragEnd}
                            onPointerCancel={onDragEnd}
                            onKeyDown={onDragKey}
                            className={`cl-fs-strip-handle absolute inset-x-0 top-0 h-[7px] z-30 ${dragging ? 'is-dragging' : ''}`}
                        >
                            <span className="cl-fs-strip-grip" aria-hidden="true" />
                        </div>
                        <div
                            ref={stripRowRef}
                            // Focusable and keyboard-scrollable. A horizontal
                            // scroll container is reachable by trackpad swipe
                            // and (in Chromium, for a container with no
                            // vertical overflow) by a vertical wheel, but by
                            // NOTHING from the keyboard unless it can hold
                            // focus — and the repo's own UI bar is "every
                            // feature is a complete flow ... keyboard nav".
                            // `role="group"` + a label so the affordance is
                            // announced rather than being a mystery tab stop.
                            tabIndex={0}
                            role="group"
                            aria-label="Call participants"
                            onKeyDown={onStripKey}
                            onWheel={onStripWheel}
                            className="cl-fs-strip-row h-full flex items-center gap-3 px-4 py-2 overflow-x-auto overflow-y-hidden"
                            style={{
                                // LEFT-ALIGNED, at every width and every item
                                // count — see STRIP_JUSTIFY_CONTENT's section
                                // comment in fullscreenCallLayout.ts for the
                                // owner quote and why centring cannot be the
                                // stable option while the console holds a lane
                                // on the right. This replaced `safe center`,
                                // which was centre below the overflow point and
                                // start above it: two layouts under one name,
                                // which is what read as "placed randomly".
                                justifyContent: STRIP_JUSTIFY_CONTENT,
                                // When the console docks INSIDE this strip (see
                                // `dockControlsInStrip` above), narrow THIS
                                // CONTAINER's own box — not just its trailing
                                // padding — by `stripLaneReservationPx`.
                                // `overflow-x-auto` clips at the container's
                                // border box, so a container that stops short
                                // of the console's x-range can never paint a
                                // card into it at ANY scroll offset. Trailing
                                // padding alone only reserved space at the END
                                // of the scrollable content, which did nothing
                                // for an EARLIER card sitting at `scrollLeft: 0`
                                // — see `stripScrollLaneReservationPx`'s doc
                                // comment for the measured overlap that
                                // motivated this. No paddingRight here any
                                // more: narrowing the box already reserves the
                                // whole lane, so adding padding on top would
                                // double-reserve it and leave a dead gap at the
                                // end of a long roster.
                                width: stripLaneReservationPx != null
                                    ? `calc(100% - ${stripLaneReservationPx}px)`
                                    : undefined,
                            }}
                        >
                            {stripItems.map(item => {
                                if (item.kind === 'audio') {
                                    // NO `cornerChrome` here, deliberately — the one
                                    // tile slot in this overlay that keeps its name
                                    // under the avatar. Unlike a grid cell, a strip
                                    // audio card has no tile BOX: it is a bare
                                    // shrink-wrapped avatar+label column, so there are
                                    // no corners to anchor to, and its width is the
                                    // avatar's (`stripCardSize` -> `w-20` roomy, `w-9`
                                    // dense). A top-right pill there would be capped at
                                    // roughly the avatar's own width and, at the dense
                                    // size, narrower than any name it could hold. The
                                    // video thumbnails beside it DO have a box
                                    // (`stripBox`'s `aspect-video rounded-xl`) and do
                                    // carry the corner pill.
                                    return (
                                        <div key={`audio-${item.identity}`} className="shrink-0 h-full flex items-center justify-center px-2">
                                            <ParticipantCard {...cardProps(item.identity)} sizeMode={stripCardSize(strip.density)} />
                                        </div>
                                    );
                                }
                                const { tile } = item;
                                const key = `${tile.identity}-${tile.source}-${tile.gated}`;
                                return stripBox(key, tile.gated
                                    ? <ScreenShareGate {...gateProps(tile.identity)} />
                                    : (
                                        <VideoTile
                                            {...tileProps(tile.identity, tile.source)}
                                            // Sized exactly like a grid cell (fixed box,
                                            // object-contain) — NOT the sidebar's
                                            // auto-height flow layout, which would let a
                                            // screenshare's own aspect drive the height
                                            // and break the fixed strip.
                                            isGridView={true}
                                            quality={VideoQuality.LOW}
                                            // A ~100px thumbnail is not a drawing surface.
                                            // Strokes still RENDER here (AnnotationOverlay
                                            // always paints); only the pen toolbar / request
                                            // button and pointer capture are withheld.
                                            annotationSurface={false}
                                        />
                                    ));
                            })}
                        </div>
                    </div>
                )}

                {/* ── FLOATING CHROME ─────────────────────────────────────────────
                    Nothing renders here any more. The ONE piece of floating chrome
                    left in fullscreen is the app's real <ControlBar>, which
                    SidebarConference re-portals into
                    #call-fullscreen-controls-root while this overlay is up — so
                    fullscreen gets the exact same capsule (same right-click device
                    menus, same screen-share options, same entitlement gating)
                    instead of a second, thinner copy that drifted from it. It is
                    parked bottom-right and stacked 3x2 by index.css; see
                    `fullscreenConsoleBox`.

                    Its vertical position (`--cl-fs-console-bottom`, computed above
                    via `fullscreenConsoleBottom`) DOCKS it inside the strip
                    whenever there IS a strip — always, at every height, centred in
                    the band. There is no longer a "too short to hold it" branch:
                    `fullscreenConsoleMetrics` scales the block down instead, which
                    is the owner's own instruction ("if there's not enough room then
                    size it down to make room") replacing the earlier behaviour he
                    reported, where a short strip put the console back over the
                    bottom-right corner of the video. Only grid/people mode, which
                    has no strip at all, positions it against the viewport's own
                    bottom edge.

                    The top-right cluster that used to sit here — the latency pill
                    and "Back to grid" — was removed on direct request; see "What
                    was removed" in the header comment for why neither leaves a
                    hole. */}
            </div>
        </div>,
        portalRoot
    );
};
