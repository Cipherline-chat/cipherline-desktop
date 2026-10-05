import { Track } from 'livekit-client';

/**
 * fullscreenCallLayout — "what should the fullscreen call view actually show?"
 *
 * Everything in here is pure data (the `Track.Source` enum aside, exactly like
 * utils/pickNextFocus.ts) so the rules that used to be tangled into
 * FullscreenOverlay's render body can be reasoned about and tested on their
 * own. The overlay reads a layout out of this module and renders it; it does
 * not decide anything.
 *
 * ── The rule that started the rebuild
 *
 * Direct owner report: "if there's only one video, the view lets you click the
 * video and it tabs between a focused and a grid view — but there's no point
 * when you only have one video." That is exactly right: a one-cell grid and a
 * focused view of the only stream are the same picture, so the click toggled
 * between two identical states and the user was left wondering what happened.
 *
 * So the layout is chosen by COUNT first and focus second — see
 * `chooseFullscreenLayout`.
 */

export type StageSource = Track.Source.Camera | Track.Source.ScreenShare;

/**
 * Something that can occupy the big stage: a camera, a screen share you are
 * subscribed to, or an unsubscribed share's click-to-watch gate.
 */
export interface StageTileRef {
    identity: string;
    source: StageSource;
    /**
     * True for a published-but-not-subscribed screen share, which renders as
     * ScreenShareGate rather than a live picture.
     *
     * A gate still COUNTS as a stage tile — it is a video-shaped box competing
     * for the same space, and a call with one camera plus one gate genuinely
     * has two things on screen, so the focused/grid distinction is meaningful
     * there. It just can never BE the focused tile: there is no picture to
     * blow up until the viewer opts in, and clicking it subscribes rather than
     * focuses. `resolveFocus` enforces that.
     */
    gated: boolean;
}

/** A reference to the focused stream, shaped like `CallContext.focusedStream`. */
export interface FocusRef {
    identity: string;
    source: StageSource;
}

/** One entry in the bottom participant strip. */
export type StripItem =
    | { kind: 'tile'; tile: StageTileRef }
    | { kind: 'audio'; identity: string };

export interface FullscreenLayoutInput {
    /**
     * Stage-eligible tiles, already in the order they should render. The
     * overlay's own collection pass puts subscribed screen shares first, then
     * cameras, then gates — a share is what a room is usually looking at.
     */
    stage: readonly StageTileRef[];
    /** Participants with no stage tile of their own (mic only, or everything hidden). */
    audioOnly: readonly string[];
    /** `CallContext.focusedStream`. */
    focused: FocusRef | null;
}

export type FullscreenLayout =
    /**
     * No video anywhere — an audio-only call that someone put into fullscreen.
     * Everyone gets an equal cell; there is no stage/strip split to make.
     */
    | { mode: 'people'; people: readonly string[] }
    /**
     * Exactly one stage tile. It fills the screen, and clicking it does
     * NOTHING to the layout (see `focusToggleMeaningful`) — that click used to
     * cycle between two identical renderings.
     */
    | { mode: 'solo'; stage: StageTileRef; strip: readonly StripItem[] }
    /** Several stage tiles, none focused: an equal grid, plus audio-only cells. */
    | { mode: 'grid'; tiles: readonly StageTileRef[]; people: readonly string[] }
    /** Several stage tiles, one focused: big stage + everything else in the strip. */
    | { mode: 'focus'; stage: StageTileRef; strip: readonly StripItem[] };

/** Does this tile reference the same stream as `focused`? */
const matches = (t: StageTileRef, f: FocusRef): boolean =>
    t.identity === f.identity && t.source === f.source;

/**
 * The focused stage tile, or null.
 *
 * A gate is never focusable (see `StageTileRef.gated`), and a focus pointing
 * at a stream that has since ended simply resolves to null — the caller then
 * falls back to the grid rather than rendering an empty stage. Auto-advancing
 * to *another* stream when the focused one dies is FocusedStreamBanner's job,
 * not this module's: that component is mounted for the whole call (fullscreen
 * included) and already owns `focusedStream`'s lifecycle. Two owners for one
 * piece of state is how you get a fight over it.
 */
export function resolveFocus(
    stage: readonly StageTileRef[],
    focused: FocusRef | null,
): StageTileRef | null {
    if (!focused) return null;
    return stage.find(t => !t.gated && matches(t, focused)) ?? null;
}

/**
 * Choose the layout.
 *
 * Order matters, and it is count-first on purpose:
 *   0 stage tiles  → `people`  (nothing to stage; show the room)
 *   1 stage tile   → `solo`    (ALWAYS, even if that tile is "focused" —
 *                               there is no second rendering to switch to)
 *   2+ and focused → `focus`
 *   2+ otherwise   → `grid`
 */
export function chooseFullscreenLayout(input: FullscreenLayoutInput): FullscreenLayout {
    const { stage, audioOnly, focused } = input;

    if (stage.length === 0) {
        return { mode: 'people', people: audioOnly };
    }

    const audioItems: StripItem[] = audioOnly.map(identity => ({ kind: 'audio', identity }));

    if (stage.length === 1) {
        return { mode: 'solo', stage: stage[0], strip: audioItems };
    }

    const focus = resolveFocus(stage, focused);
    if (!focus) {
        return { mode: 'grid', tiles: stage, people: audioOnly };
    }

    const strip: StripItem[] = [
        ...stage.filter(t => t !== focus).map(tile => ({ kind: 'tile' as const, tile })),
        ...audioItems,
    ];
    return { mode: 'focus', stage: focus, strip };
}

/**
 * Should a click on the stage tile change the layout?
 *
 * False in `solo` (requirement 1: one video means one view) and irrelevant in
 * `people`. The overlay passes the negation into VideoTile's
 * `focusToggleDisabled` so the click is a genuine no-op rather than a state
 * change with no visible consequence.
 */
export function focusToggleMeaningful(layout: FullscreenLayout): boolean {
    return layout.mode === 'grid' || layout.mode === 'focus';
}

// ── Participant strip sizing ────────────────────────────────────────────────
//
// The bar the rebuild replaced was drag-resizable with an 80px floor. A
// ParticipantCard at `sizeMode="large"` is an 80px avatar + an 8px gap + a
// ~22px name pill = ~110px, and its mute/deafen badges hang off the avatar's
// bottom-right — so at the floor the bar clipped the badges and the name
// outright. That is the owner's "the people under it often get their icons cut
// off".
//
// Dragging is BACK (owner: "I want to be able to resize the bottom view ...
// by dragging it up and down") — the complaint was always the clipping, never
// the resizing. What is gone for good is the arbitrary floor. The drag is
// clamped by `clampStripHeight` between:
//
//   min  the taller of two provable fits: a `tiny` ParticipantCard
//        (STRIP_DENSE_CONTENT_PX + STRIP_PADDING_PX, the same floor
//        `stripMetrics` already used for a very short window) and the docked
//        fullscreen console (fullscreenConsoleBox().height + STRIP_PADDING_PX)
//        — see `STRIP_MIN_HEIGHT_PX` below for the arithmetic. Derived, not
//        invented, either way.
//   max  the same STRIP_MAX_VIEWPORT_FRACTION cap as the automatic height, so
//        the stage is never squeezed to nothing.
//
// and the CARD SIZE follows the height (`stripDensityForHeight`) rather than
// the roster, so the only thing a downward drag can do is swap a large card
// for a tiny one — never clip either, and (now that the floor covers it)
// never clip the docked console either. Tiles still never shrink to fit more
// of them in; overflow scrolls horizontally.

/** Vertical padding inside the strip (8px above + 8px below its content). */
export const STRIP_PADDING_PX = 16;
/** Content height that fits a `sizeMode="large"` ParticipantCard (~110px) with air. */
export const STRIP_ROOMY_CONTENT_PX = 124;
/** Content height that fits a `sizeMode="tiny"` ParticipantCard (~58px) with air. */
export const STRIP_DENSE_CONTENT_PX = 84;
/** Above this many strip items, switch to the dense band. */
export const STRIP_ROOMY_MAX_ITEMS = 6;
/** The strip never eats more than this share of the screen. */
export const STRIP_MAX_VIEWPORT_FRACTION = 0.26;

export type StripDensity = 'roomy' | 'dense';

export interface StripMetrics {
    /** Total reserved height including padding. 0 when there is no strip. */
    height: number;
    /** Height available to a tile / card — `height - STRIP_PADDING_PX`. */
    contentHeight: number;
    density: StripDensity;
}

/**
 * How tall the strip is, given how many things are in it and how tall the
 * window is.
 *
 * Tiles NEVER shrink to fit more of them in — overflow scrolls horizontally
 * instead. Squeezing is precisely the failure mode being replaced; a strip that
 * is too narrow for its contents is a scrollbar, not a clipped avatar.
 *
 * The viewport cap can force the dense band on a short window, but it can never
 * push the strip below `STRIP_DENSE_CONTENT_PX` — at that point the floor wins
 * and the strip keeps its height. Overflowing a very short window by a few
 * pixels is strictly better than resurrecting the clipping bug.
 */
export function stripMetrics(itemCount: number, viewportHeight: number): StripMetrics {
    if (itemCount <= 0) {
        return { height: 0, contentHeight: 0, density: 'dense' };
    }
    const { min: floor, max: cap } = stripHeightBounds(viewportHeight);

    const roomy = itemCount <= STRIP_ROOMY_MAX_ITEMS;
    const preferred = (roomy ? STRIP_ROOMY_CONTENT_PX : STRIP_DENSE_CONTENT_PX) + STRIP_PADDING_PX;
    // A window too short for the preferred band drops to the floor outright
    // rather than to some in-between height no card fits.
    const wanted = preferred > cap ? floor : preferred;
    const height = Math.max(floor, Math.min(wanted, cap));
    // Density is read back OUT of the height rather than kept from the branch
    // above, so the automatic and the dragged paths cannot disagree about
    // which card fits a given number of pixels. (The two agree by
    // construction on every input the branch above can produce — see the
    // stripMetrics tests, which are unchanged.)
    return { height, contentHeight: height - STRIP_PADDING_PX, density: stripDensityForHeight(height) };
}

/** ParticipantCard's `sizeMode` for a given strip density. */
export const stripCardSize = (density: StripDensity): 'large' | 'tiny' =>
    density === 'roomy' ? 'large' : 'tiny';

// ── The fullscreen control console ──────────────────────────────────────────
//
// Owner: "in full screen focused, I want the call controls down in the bottom
// right and try to make them in a more square format like double stacked.
// buttons so they fit like another video would."
//
// So the one real <ControlBar> (re-portalled into
// #call-fullscreen-controls-root) stops being a 560px-wide strip across the
// bottom and becomes a COLS x ROWS block parked bottom-right. The numbers live
// here rather than only in index.css because three other things have to agree
// with them: the console's own container width (`.cl-console` is
// `container-type: inline-size`, i.e. `contain: inline-size` — a shrink-to-fit
// box with that containment resolves to ZERO width, so the fullscreen root
// MUST be given an explicit one), the annotation request dock (which parks
// clear of the console and therefore needs its real height), and — below —
// the strip's own drag/auto floor, which must always be tall enough to dock
// this block without clipping it. That last dependency is why this section
// comes BEFORE "Dragging the strip": `STRIP_MIN_HEIGHT_PX` reads
// `fullscreenConsoleBox()`.
//
// The overlay publishes all of these as CSS custom properties; index.css reads
// them. One source of truth, no drift.

/** Control diameter in the stacked console. */
export const FS_CONSOLE_CONTROL_PX = 44;
/** Gap between controls in the stacked console. */
export const FS_CONSOLE_GAP_PX = 8;
/** Capsule padding in the stacked console. */
export const FS_CONSOLE_PAD_PX = 10;
/** Controls per row — mic/deafen/camera over share/fullscreen/leave. */
export const FS_CONSOLE_COLS = 3;
/** Rows of controls. "Double stacked", per the owner. */
export const FS_CONSOLE_ROWS = 2;
/** Air between the console block and the annotation request dock above it. */
export const FS_CONSOLE_DOCK_GAP_PX = 16;

/**
 * The smallest control diameter the console may be shrunk to.
 *
 * 24px is WCAG 2.2 SC 2.5.8 "Target Size (Minimum)", level AA — a published
 * floor rather than a number picked because it looked about right. Below it
 * these six controls (one of which HANGS UP THE CALL) stop being reliably
 * pressable, and a leave button you miss is worse than a console that stops
 * getting smaller.
 */
export const FS_CONSOLE_MIN_CONTROL_PX = 24;

/**
 * How far the console may be scaled down, as a fraction of its nominal size.
 *
 * Derived from the control floor above rather than stated: 24/44 ≈ 0.545. So
 * "the minimum scale" and "the minimum tap target" cannot drift apart, and
 * changing `FS_CONSOLE_CONTROL_PX` re-derives this instead of silently
 * shrinking or raising the real floor.
 */
export const FS_CONSOLE_MIN_SCALE = FS_CONSOLE_MIN_CONTROL_PX / FS_CONSOLE_CONTROL_PX;

/**
 * The stacked console's own box, at full size.
 *
 * 3x2 at 44px with 8px gaps and 10px padding is 168 x 116 — a ~1.45:1 block
 * that reads as one more tile in the grid rather than a strip, which is what
 * "fit like another video would" is asking for.
 *
 * This is the NOMINAL box. What actually gets painted is
 * `fullscreenConsoleMetrics(stripHeight)`, which may scale it down to fit the
 * strip — see that function.
 */
export function fullscreenConsoleBox(): { width: number; height: number } {
    const span = (n: number) =>
        n * FS_CONSOLE_CONTROL_PX + (n - 1) * FS_CONSOLE_GAP_PX + 2 * FS_CONSOLE_PAD_PX;
    return { width: span(FS_CONSOLE_COLS), height: span(FS_CONSOLE_ROWS) };
}

// ── Dragging the strip ──────────────────────────────────────────────────────

/** The smallest strip that a `tiny` ParticipantCard provably fits inside. */
const STRIP_CARD_FLOOR_PX = STRIP_DENSE_CONTENT_PX + STRIP_PADDING_PX;

/**
 * The smallest strip that the docked fullscreen console provably fits inside
 * without being clipped AND without shrinking past `FS_CONSOLE_MIN_SCALE`.
 *
 * Nominal height is 116 (2 rows: 2×44 control diameters + 1×8 inter-row gap +
 * 2×10 capsule padding = 88 + 8 + 20), so at the minimum scale the block is
 * ceil(116 × 24/44) = 64, and the arithmetic is 64 + 16 = **80**.
 *
 * It used to be the console's FULL 116 + 16 = 132, because the console could
 * not shrink and the only alternative to clipping it was floating it over the
 * video. Now that it scales (see `fullscreenConsoleScale`), this floor drops
 * to what the console needs at its smallest legible size — which is below the
 * card floor, so it no longer governs at all.
 */
const STRIP_CONSOLE_FLOOR_PX =
    Math.ceil(fullscreenConsoleBox().height * FS_CONSOLE_MIN_SCALE) + STRIP_PADDING_PX;

/**
 * The strip's drag/auto floor — the taller of the two provable fits above.
 *
 * **100 today** (the card floor), down from 132. That is not a relaxation of
 * the rule the 132 enforced; it is the same rule with a new way to satisfy it.
 *
 * History, because the number moved twice and both moves were owner-driven:
 * the floor was RAISED to 132 because dragging the strip to 100 left the
 * console unable to dock, so it fell back to floating over the focused video's
 * bottom-right corner. Shrinking the console was rejected then, on the grounds
 * that its 116px size was itself a direct request ("fit like another video
 * would"). The owner has now overruled that trade outright:
 *
 *   "IT SHOULD ALWAYS BE DOWN THERE, and if there's not enough room then size
 *    it down to make room."
 *
 * So the console scales instead of floating, the 132 floor is no longer
 * load-bearing, and giving those 32px back to the video is the point rather
 * than a side effect — "make room" is what the drag is FOR. At this floor the
 * console runs at 84/116 ≈ 0.72 scale (≈32px controls), comfortably above
 * `FS_CONSOLE_MIN_SCALE`, so nothing is clipped and nothing is unpressable.
 *
 * `STRIP_CONSOLE_FLOOR_PX` stays in the `Math.max` for the same reason it
 * always did: it is a derived fit, not a magic number, so a future console
 * that got taller (or a minimum scale that got stricter) would raise the floor
 * on its own rather than silently start clipping.
 */
export const STRIP_MIN_HEIGHT_PX = Math.max(STRIP_CARD_FLOOR_PX, STRIP_CONSOLE_FLOOR_PX);
/** The smallest strip that a `large` ParticipantCard provably fits inside. */
export const STRIP_ROOMY_HEIGHT_PX = STRIP_ROOMY_CONTENT_PX + STRIP_PADDING_PX;

/**
 * How far the drag handle may travel, for a given window height.
 *
 * `max` can collapse onto `min` on an absurdly short window — overflowing a
 * 300px-tall window by a few pixels is strictly better than resurrecting the
 * clipping bug, exactly as `stripMetrics` already decided.
 */
export function stripHeightBounds(viewportHeight: number): { min: number; max: number } {
    const min = STRIP_MIN_HEIGHT_PX;
    const cap = Math.round(Math.max(0, viewportHeight) * STRIP_MAX_VIEWPORT_FRACTION);
    return { min, max: Math.max(min, cap) };
}

/** A dragged height, pinned inside `stripHeightBounds`. */
export function clampStripHeight(height: number, viewportHeight: number): number {
    const { min, max } = stripHeightBounds(viewportHeight);
    // NaN is the one value Math.min/max cannot rescue — it poisons both and
    // would end up written straight into a `height` style. ±Infinity needs no
    // special case: the clamp already pins it to max/min.
    if (Number.isNaN(height)) return min;
    return Math.min(max, Math.max(min, Math.round(height)));
}

/**
 * Which card size a strip of this height can hold WITHOUT clipping.
 *
 * This is the whole guarantee behind letting the bar be dragged again: the
 * card follows the pixels, so a downward drag shrinks the avatar instead of
 * cutting its name pill and badges off.
 */
export function stripDensityForHeight(height: number): StripDensity {
    return height >= STRIP_ROOMY_HEIGHT_PX ? 'roomy' : 'dense';
}

/**
 * Strip metrics honouring a user-dragged height.
 *
 * `desired == null` means "the user has not dragged this session" and falls
 * straight through to the automatic `stripMetrics`.
 */
export function stripMetricsAt(
    itemCount: number,
    viewportHeight: number,
    desired: number | null,
): StripMetrics {
    if (itemCount <= 0) return { height: 0, contentHeight: 0, density: 'dense' };
    if (desired == null) return stripMetrics(itemCount, viewportHeight);
    const height = clampStripHeight(desired, viewportHeight);
    return { height, contentHeight: height - STRIP_PADDING_PX, density: stripDensityForHeight(height) };
}

// ── Docking the console inside the strip ────────────────────────────────────
//
// Owner, on the shipped staging build, with the emphasis his:
//
//   "When in full screen you have it so the call controls will move up into
//    the video view instead of staying in the bottom area where the other
//    video members are. IT SHOULD ALWAYS BE DOWN THERE, and if there's not
//    enough room then size it down to make room."
//
// That settles a question this section previously left open. There USED to be
// a fits/doesn't-fit branch (`consoleDocksInStrip`): dock inside the strip
// band when the strip was tall enough to hold the 116px block, otherwise float
// it just above the strip — over the stage tile's bottom-right corner. Raising
// `STRIP_MIN_HEIGHT_PX` to 132 made the strip always tall enough in practice,
// so the float branch was only reachable in grid/people mode and by raw
// heights that bypassed the clamp... but it was still THERE, and "the strip is
// currently always tall enough" is a property of a constant, not a guarantee.
//
// It is now a guarantee. There is no float-over-the-video branch for a strip
// that exists, at any height, for any console size: whenever there is a strip,
// the console docks inside it and SCALES to fit. `consoleDocksInStrip` is gone
// rather than kept and left permanently true — a predicate every caller passes
// is a predicate that stops being read.
//
// `CONSOLE_GAP_ABOVE_STRIP_PX` survives for the one case that is genuinely not
// about a strip: grid/people mode has NO strip at all (`stripItems.length ===
// 0`, so `strip.height` is 0), so there is no band to dock into and nothing
// below to stay out of. There, "down there" IS the bottom of the viewport, and
// the console sits 20px up from it exactly as it always has. Scaling it in
// that case would shrink the controls to fit a strip that does not exist.

/** Gap between the console's bottom edge and the viewport's bottom edge when
 *  there is NO strip to dock into — grid/people mode. Named for the position
 *  it used to describe (floating above the strip's top edge); with a strip
 *  present the console now always docks INSIDE the band instead, so this is
 *  the no-strip case only. */
export const CONSOLE_GAP_ABOVE_STRIP_PX = 20;

/**
 * How far to scale the console down so it fits inside a strip of
 * `stripHeight`, given its nominal (unscaled) height.
 *
 * 1 whenever it already fits, so the common roomy strip paints the console at
 * exactly the size the owner asked for earlier ("fit like another video
 * would") and nothing about it changes. It only shrinks when the strip is too
 * short — which, after the `STRIP_MIN_HEIGHT_PX` drop to 100, is every strip
 * below 132px, i.e. exactly the range the drag handle newly reaches.
 *
 * Floored at `FS_CONSOLE_MIN_SCALE` (a 24px control — WCAG 2.2 AA). Below
 * that it stops shrinking and `fullscreenConsoleBottom` bottom-aligns it
 * instead, overflowing the band's TOP edge by the shortfall. That is a
 * deliberate choice of failure: the owner's instruction is absolute about
 * where the console lives ("ALWAYS ... down there"), so the thing that gives
 * is the band's top edge, not the console's position and not its pressability.
 * With the current constants that branch is unreachable from the UI — the
 * clamped floor of 100 leaves 84px for a block whose minimum is 64 — so it is
 * a guard for raw heights that bypass `clampStripHeight`, not a shipping
 * behaviour.
 *
 * Takes the NOMINAL height, never a measured one. That is what keeps this
 * loop-free: a measured height would feed a scale that changes the rendered
 * size that changes the measurement. The overlay measures the block AFTER
 * scaling, and uses that measurement only for centring — which cannot change
 * a height.
 */
export function fullscreenConsoleScale(stripHeight: number, nominalConsoleHeight: number): number {
    // No strip (grid/people): nothing to fit into, so full size. Guarding the
    // degenerate console height too, so a 0 can never produce an Infinity.
    if (!(stripHeight > 0) || !(nominalConsoleHeight > 0)) return 1;
    const available = stripHeight - STRIP_PADDING_PX;
    if (available >= nominalConsoleHeight) return 1;
    // `available` can be <= 0 for an absurd raw height; Math.max pins that to
    // the floor rather than producing a negative or zero scale.
    return Math.max(FS_CONSOLE_MIN_SCALE, available / nominalConsoleHeight);
}

/** Control diameter, gap, padding, width and height for the console at a given
 *  strip height. The px values are published to CSS as
 *  `--cl-fs-console-cs/cg/cp/w`. */
export interface FullscreenConsoleMetrics {
    scale: number;
    control: number;
    gap: number;
    pad: number;
    width: number;
    height: number;
}

/**
 * The console's real painted geometry for a given strip height.
 *
 * Scaling the three source lengths and re-deriving the box (rather than
 * transform-scaling the rendered block) is what keeps the controls crisp and
 * their hit targets real: a `transform: scale()` would rasterize at the wrong
 * size and hand the browser a 44px button that only LOOKS 32px, which is the
 * opposite of the accessibility floor above. Every length is linear in the
 * scale, so `width`/`height` come out to exactly `nominal × scale` — the
 * property `fullscreenConsoleScale`'s fit guarantee is stated in terms of.
 */
export function fullscreenConsoleMetrics(stripHeight: number): FullscreenConsoleMetrics {
    const nominal = fullscreenConsoleBox();
    const scale = fullscreenConsoleScale(stripHeight, nominal.height);
    return {
        scale,
        control: FS_CONSOLE_CONTROL_PX * scale,
        gap: FS_CONSOLE_GAP_PX * scale,
        pad: FS_CONSOLE_PAD_PX * scale,
        width: nominal.width * scale,
        height: nominal.height * scale,
    };
}

/**
 * Where the console's BOTTOM edge should sit (px above the viewport's bottom
 * edge), given the strip's current height and the console's REAL (already
 * scaled, and in the overlay's case measured) height.
 *
 * With a strip: vertically centred inside the strip band, always — so it reads
 * as parked alongside the other strip cards rather than hovering over them,
 * and it stays centred through every frame of a drag. Clamped at 0 so a block
 * somehow taller than its band overflows the band's TOP edge rather than being
 * pushed off the bottom of the screen, which would put the leave button out of
 * reach entirely.
 *
 * Without a strip (grid/people mode, `stripHeight === 0`): 20px up from the
 * viewport's bottom edge, unchanged from every previous version of this.
 */
export function fullscreenConsoleBottom(stripHeight: number, consoleHeight: number): number {
    if (!(stripHeight > 0)) return CONSOLE_GAP_ABOVE_STRIP_PX;
    return Math.max(0, Math.round((stripHeight - consoleHeight) / 2));
}

// ── Reserving the console's LANE in the strip's own scroll container ───────
//
// Docking the console INSIDE the strip band (above) does not, on its own,
// stop a strip CARD from painting underneath it. The only thing the render
// side did to keep cards clear was add `paddingRight` to the strip's
// scrollable row — trailing space at the END of the scrollable content. That
// reserves the right amount of total `scrollWidth`, but `overflow-x-auto`
// clips at the scroll CONTAINER's own border box, which spans the strip's
// full width regardless of padding. At `scrollLeft: 0` — the default,
// unscrolled view — an EARLIER tile can still land at the exact x-range
// under the console; trailing padding does nothing for a tile nowhere near
// the end. Reproduced in a DOM harness at 1920x1080, strip height 250: with
// 8 tiles, tile index 4 painted at x:[1736,1920] over the console's own
// x:[1730,1900] — a real overlap, at rest, before any scrolling.
//
// The only reservation `overflow-x-auto` cannot defeat is one on the
// CONTAINER's own box: a container that stops short of the console's
// x-range can never paint into it, at ANY scroll offset, because the clip
// boundary itself excludes that range.

/**
 * How far the fullscreen console's fixed box sits from the viewport's right
 * edge — mirrors index.css's `#call-fullscreen-controls-root { right: 20px }`
 * by hand; unlike the width/height values above (which flow TS -> CSS via
 * custom properties), there is no way to read that CSS value back from here.
 *
 * Deliberately its OWN constant, NOT a reuse of `CONSOLE_GAP_ABOVE_STRIP_PX`
 * above — that is a VERTICAL gap for the unrelated float-above-the-strip
 * case, and the two only happen to both be 20 today. Treat that as
 * coincidence, not a shared source of truth: either can change independently
 * of the other, and conflating them would silently miscompute this lane the
 * day one of them does.
 */
export const FS_CONSOLE_RIGHT_INSET_PX = 20;

/**
 * Breathing room between the narrowed scroll container's right edge and the
 * console's left edge, once the two are computed to line up exactly.
 *
 * Not just cosmetic: `consoleWidth + FS_CONSOLE_RIGHT_INSET_PX` alone lands
 * the container's clip boundary and the console's left edge on the SAME
 * coordinate, and a DOM harness measurement at that exact boundary (1920x1080,
 * strip floor 132px, 12 tiles) showed sub-pixel layout rounding (flex row
 * items sized off a 16:9 `aspect-ratio`, which is rarely an integer) putting
 * a tile's clipped right edge a fraction of a pixel PAST the console's left
 * edge — a real, if tiny, overlap `getBoundingClientRect` still reports.
 * Matches the strip row's own `gap-3` (12px) between tiles, so a tile
 * sitting right at the lane boundary reads as "one more gap away" rather
 * than an arbitrary number.
 */
export const FS_CONSOLE_LANE_GAP_PX = 12;

/**
 * Width of the lane the docked console needs reserved out of the strip's own
 * scroll-container box, on the side the console occupies.
 *
 * Valid because the strip spans the FULL viewport width: `FullscreenOverlay`'s
 * portal is `fixed inset-0` and nothing between it and the strip adds a
 * horizontal inset (the strip's own wrapper carries no horizontal
 * padding/margin), so the strip's right edge IS the viewport's right edge —
 * the SAME reference frame the console's fixed `right: FS_CONSOLE_RIGHT_INSET_PX`
 * uses. That makes this a plain sum, not an approximation. A strip inset from
 * the viewport's right edge would need that inset folded in too; there is
 * none today.
 */
export function stripConsoleLaneWidthPx(consoleWidth: number): number {
    return consoleWidth + FS_CONSOLE_RIGHT_INSET_PX + FS_CONSOLE_LANE_GAP_PX;
}

/**
 * How much to shrink the strip's scroll-container CSS `width` by, given
 * whether the console is currently docked inside the strip.
 *
 * `undefined` when not docked, which now means exactly one thing: there is no
 * strip at all (grid/people mode). It used to ALSO mean "a strip too short to
 * hold the console", which no longer exists as a state — the console scales
 * instead. So the caller's `docked` argument is just `strip.height > 0`.
 *
 * Feed it the SCALED console width (`fullscreenConsoleMetrics().width`), not
 * the nominal one: a console shrunk to fit a short strip occupies a
 * proportionally narrower lane, and reserving the full 168 there would hand
 * back video-strip width the console is not using — which is the opposite of
 * "size it down to make room".
 *
 * The component turns a defined result into `calc(100% - Npx)`; this function
 * only decides the NUMBER, to keep the same "logic lives here, the component
 * just renders it" split as `fullscreenConsoleBottom` above.
 */
export function stripScrollLaneReservationPx(
    docked: boolean,
    consoleWidth: number,
): number | undefined {
    return docked ? stripConsoleLaneWidthPx(consoleWidth) : undefined;
}

// ── Aligning the strip's cards ──────────────────────────────────────────────
//
// Owner: "the video members in that lower area of the focused full screen
// window aren't centered, they're just placed randomly it looks like off to
// the side, have it either left align or centered in the window. Also if
// there's too many have a scroll bar."
//
// "Placed randomly" is a precise description of what `justify-content: safe
// center` actually does, and the diagnosis matters because the fix is not
// "centre it harder":
//
//   1. `safe center` is centre UNTIL the content overflows, then it silently
//      becomes `start` (that is what `safe` means — it exists so an
//      overflowing row does not push its first item past the scroll origin
//      where it can never be scrolled back to). So the same call showed the
//      row centred at four participants and hard left at ten. One rule that
//      changes behaviour by roster size reads exactly like no rule.
//   2. Even while it centred, it centred inside the SCROLL CONTAINER, which
//      is narrowed by `stripScrollLaneReservationPx` to keep cards out of the
//      docked console's lane — ~200px today. So the row's midpoint sat ~100px
//      LEFT of the window's midpoint: visibly "off to the side", and the
//      offset changed whenever the console's lane did.
//
// The owner offered both options. LEFT-ALIGN is the one taken:
//
//   - It is the only one of the two that is the same rule at every width and
//     every item count. Centring cannot be, while the console occupies a lane
//     on the right: centring in the CONTAINER is the ~100px-off-to-the-side
//     bug being reported, and centring in the WINDOW would push cards
//     underneath the console — reintroducing the overlap that the lane
//     reservation exists to prevent, and that request (3) above just finished
//     making structural.
//   - It keeps cards STILL. A centred row re-lays-out every existing card
//     whenever someone joins or leaves; in a call that is a click target
//     sliding out from under the cursor mid-call. Left-aligned, an arrival
//     appends on the right and nothing already on screen moves.
//   - It matches the scroll origin, so `scrollLeft: 0` is the first card
//     rather than an arbitrary interior position — which is what makes
//     request (5)'s keyboard Home/End meaningful.
//
// Consequence worth stating plainly: on a wide window with two participants
// the cards sit at the left rather than under the middle of the stage. That is
// the accepted cost of the row never moving, and it is one of the two layouts
// the owner explicitly sanctioned.

/**
 * `justify-content` for the strip's scrollable row. See the section comment.
 *
 * A constant rather than a literal in the component so the decision, its
 * reasoning and the test that pins it all name the same thing.
 */
export const STRIP_JUSTIFY_CONTENT = 'flex-start';

// ── Title strip (the fullscreen view's own drag bar) ────────────────────────
//
// FullscreenOverlay covers the entire window, including the app's real 34px
// drag titlebar (Dashboard.tsx, `.drag-region h-[34px] ... bg-cl-abyss`) and,
// on Windows, the OS-drawn `titleBarOverlay` buttons (main.ts: height 34,
// #0B0F1E) which paint on top of whatever is beneath them regardless. A strip
// of the SAME height restores dragging and gives those buttons a matching
// backdrop instead of floating over flat cinema black.
//
// It collapses to 0 once the OS has taken the WINDOW itself fullscreen (the
// macOS green-button / Windows F11 kind): at that point there is no titlebar
// and no window buttons left to relocate, so the strip would just be a dead
// band eating into the video. That is a different thing from
// `CallContext.isFullscreen`, which is this app's OWN cinema overlay mode and
// says nothing about the OS window — see hooks/useOsWindowFullscreen.ts.
export const CALL_TITLE_STRIP_HEIGHT_PX = 34;

/** How tall the fullscreen view's own drag strip should be. */
export function fullscreenTitleStripHeight(osWindowFullscreen: boolean): number {
    return osWindowFullscreen ? 0 : CALL_TITLE_STRIP_HEIGHT_PX;
}

// ── Grid fitting ────────────────────────────────────────────────────────────

export interface GridShape { cols: number; rows: number }

/**
 * The (cols × rows) split that makes the biggest 16:9 tile inside a `w × h`
 * box for `count` tiles.
 *
 * Brute force over every column count — `count` is a call roster, so this is a
 * handful of iterations, and an exact search beats the usual sqrt heuristic on
 * the shapes that actually matter here (ultrawide monitors, where 3×2 and 6×1
 * are wildly different answers).
 *
 * With no measured box yet (first paint, before the ResizeObserver fires) it
 * falls back to the classic 1/2/3/4-column ladder so the first frame is not a
 * single absurd row.
 */
export function bestGrid(count: number, w: number, h: number): GridShape {
    const n = Math.max(1, Math.floor(count));
    if (!(w > 0) || !(h > 0)) {
        const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
        return { cols, rows: Math.ceil(n / cols) };
    }
    let bestCols = 1;
    let bestRows = n;
    let bestArea = 0;
    for (let c = 1; c <= n; c++) {
        const r = Math.ceil(n / c);
        const tileW = Math.min(w / c, (h / r) * (16 / 9));
        const area = tileW * (tileW * 9 / 16);
        if (area > bestArea) {
            bestArea = area;
            bestCols = c;
            bestRows = r;
        }
    }
    return { cols: bestCols, rows: bestRows };
}
