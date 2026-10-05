/**
 * videoRectChrome — where a video tile's corner chrome (the name pill, the
 * annotation cluster, the resolution readout) is allowed to sit.
 *
 * ── The problem
 *
 * A tile's box and its video's aspect ratio routinely disagree, and the
 * <video> is `object-fit: contain` in every view where that can happen, so the
 * picture is LETTERBOXED: it occupies a sub-rectangle of the tile with black
 * bars on two sides. Chrome pinned to the tile's own corners (`absolute top-2
 * right-2`) therefore lands in the bar, not on the picture — direct owner
 * report: "Make sure it is actually on their video not just in the far right
 * corner of the box they are in, I don't want it to be in the black bar area."
 *
 * ── The approach
 *
 * Nothing here is new geometry. `contentRect()` (utils/annotationGeometry.ts)
 * already computes exactly where an object-fit picture is painted inside its
 * box — it is what annotation strokes are mapped through, and what VideoTile's
 * rounded `fitRect` border and `fitClipPath` are already drawn against. This
 * module only turns that rect into the four CSS inset values a corner-anchored
 * overlay needs, so the badge, the border and a drawn stroke all agree on
 * where the picture is instead of being three independently-tuned
 * computations that can drift.
 *
 * ── Which tiles this covers
 *
 * All of them. A fullscreen or focused call can put four different components
 * on screen and every one of them is a "tile" with the same two corners to
 * fill:
 *
 *   VideoTile           camera / screen share, and the camera-OFF fallback
 *                       (`LocalScreenShareTile` in SidebarConference is a thin
 *                       wrapper around it and inherits everything here).
 *   ParticipantCard     avatar-only — someone with no published video at all.
 *   ScreenShareGate     a published-but-unsubscribed share's click-to-watch.
 *
 * Only VideoTile ever HAS a picture, so only VideoTile computes a rect; the
 * other two call `tileCornerInsets()` and get the same shape of answer for
 * their own corners. The shells that consume these insets live in
 * ./TileCornerChrome.tsx so the pill's look, its z-index and its width cap are
 * also one implementation rather than three.
 *
 * Insets are expressed FROM THE TILE'S OWN EDGES because that is the
 * coordinate space an `absolute` child of the tile is positioned in: the
 * caller writes `style={{ top: i.top, right: i.right }}` and the element lands
 * `gutter` px inside the picture's top-right corner, wherever that corner
 * currently is.
 *
 * ── The camera-off / pre-metadata fallback
 *
 * There is no video rect when there is no video — a camera-off tile, or a tile
 * whose track has not reported its intrinsic size yet (a <video> with no
 * metadata reports 0x0). `contentRect` returns null for both, and the sane
 * answer is the TILE's own corners: a camera-off tile renders a centred avatar
 * on a full-bleed background, so the tile's corners are the only meaningful
 * frame, and that is where the owner's screenshot circles them. Callers that
 * want to avoid a visible jump when the metadata lands a few frames later ask
 * `videoRectPending()` first — see its doc comment.
 */

import { contentRect, type Box, type ContentRect, type IntrinsicSize } from '../../utils/annotationGeometry';

/** CSS inset values, in px, measured from the tile's own four edges. */
export interface ChromeInsets {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

/**
 * The gap between the picture's (or the tile's) edge and the chrome sitting in
 * its corner. Matches the `top-2` / `right-2` (8px) these overlays used to
 * hard-code individually.
 *
 * Exported because it is the one number every tile type has to agree on:
 * VideoTile derives its insets from a measured picture rect, while
 * ParticipantCard and ScreenShareGate have no picture and use
 * `tileCornerInsets()` below — but a name pill 8px in on one tile and 12px in
 * on the tile next to it in the same strip is exactly the drift this module
 * exists to prevent.
 */
export const CHROME_GUTTER_PX = 8;

/**
 * Inset a corner-anchored overlay `gutter` px inside `rect`, expressed from
 * `box`'s edges.
 *
 * `rect === null` (no metadata, no track) or `box === null` (not laid out yet)
 * falls back to a plain `gutter` on all four sides — the tile's own corners.
 * See the module comment for why that is the right fallback and not a
 * degraded one.
 *
 * Every result is clamped at 0 so chrome can never be pushed OUTSIDE the tile:
 * an `object-fit: cover` rect is larger than its box and yields negative raw
 * insets, and a tile whose picture overflows it still wants its badges inside
 * the tile the user can actually see.
 */
export function videoRectInsets(
    box: Box | null,
    rect: ContentRect | null,
    gutter: number,
): ChromeInsets {
    const g = Math.max(0, gutter);
    if (!box || !rect) return { top: g, right: g, bottom: g, left: g };
    return {
        top: Math.max(0, rect.y + g),
        left: Math.max(0, rect.x + g),
        right: Math.max(0, box.width - rect.x - rect.width + g),
        bottom: Math.max(0, box.height - rect.y - rect.height + g),
    };
}

/**
 * The same thing computed straight from an intrinsic size, for `contain` —
 * the fit every letterboxing view uses. Exists so the whole path (fit maths +
 * inset derivation + clamping) is one pure function that can be tested end to
 * end without a DOM, a <video>, or a ResizeObserver.
 *
 * VideoTile itself does NOT call this: it already holds a `fitRect` computed
 * by the same `contentRect()` for its border and clip-path, and deriving the
 * insets from that one rect is what guarantees the badge and the border cannot
 * disagree. This is the tested spelling of what that composition does.
 */
export function containRectInsets(
    box: Box | null,
    intrinsic: IntrinsicSize | null,
    gutter: number,
): ChromeInsets {
    if (!box || !intrinsic) return videoRectInsets(null, null, gutter);
    return videoRectInsets(box, contentRect(box, intrinsic, 'contain'), gutter);
}

/**
 * The insets for a tile that has NO picture at all, ever: an avatar-only
 * participant card, a click-to-watch screen-share gate, a camera-off video
 * tile. Its own four corners are the only frame it has, so the chrome sits a
 * bare `gutter` inside them.
 *
 * Spelled as a call into `videoRectInsets` rather than an object literal so
 * there is literally one implementation of "what does a corner inset mean",
 * and so the gutter clamp (a negative gutter is zero, never inverted) applies
 * here too. Callers use this instead of re-typing `top-2 right-2` classes,
 * which is how the three tile types drifted apart in the first place.
 */
export function tileCornerInsets(gutter: number = CHROME_GUTTER_PX): ChromeInsets {
    return videoRectInsets(null, null, gutter);
}

/**
 * The widest a corner-anchored overlay may be, as a CSS length.
 *
 * Expressed RELATIVE (`calc(100% - Npx)`) rather than as a px number, and that
 * is what makes one formula correct for every tile type. The overlay is an
 * `absolute` child of the tile, so `100%` is the tile's width, and:
 *
 *   picture tile — `left + right` is `(rect.x + g) + (box.w - rect.x - rect.w + g)`
 *                  = `box.w - rect.width + 2g`, so the result is exactly
 *                  `rect.width - 2g`: the picture's own width less both
 *                  gutters, which is the cap that keeps a pill off the
 *                  letterbox bars.
 *   no-picture   — `left + right` is `2g`, so the result is the TILE's width
 *                  less both gutters. Previously this case had no cap at all
 *                  and a long display name could run off a narrow tile.
 *
 * So there is no separate "picture width" measurement to keep in step with the
 * insets — the insets already encode it, and they come from the same `fitRect`
 * as the rounded border and the annotation strokes.
 *
 * ── Why `max(0px, ...)` and not a bare `calc()`
 *
 * A picture narrower than both gutters put together makes the subtrahend
 * exceed 100%, and the raw calc then resolves NEGATIVE — which is not "a cap
 * of zero" in CSS, it is an INVALID `max-width` value, so the declaration is
 * dropped and the pill ends up with no cap at all. That is the exact bug this
 * function exists to prevent, arriving by the back door on the shapes most
 * likely to need it. Found by the "never produces a negative cap" case below
 * (a 1x4000 track in a 900x500 tile letterboxes to a 0.125px-wide picture);
 * degenerate, but "the guard rail fails open on extreme input" is not a
 * property worth shipping. `max()` clamps it to a real zero instead.
 */
export function chromeMaxWidthCss(insets: ChromeInsets): string {
    return `max(0px, 100% - ${Math.max(0, insets.left + insets.right)}px)`;
}

/**
 * "This tile is going to have a picture, but we do not know where yet."
 *
 * True only in the transient window between a contain-fit tile mounting with
 * an active track and its <video> reporting an intrinsic size. Callers hold
 * corner chrome back for exactly that window rather than painting it at the
 * tile's corners and letting it JUMP to the picture's corners a few frames
 * later — the owner asked for the badge to be on the video, and a badge that
 * starts in the black bar and slides is a worse answer than one that arrives
 * with the first frame.
 *
 * Deliberately narrow, because withholding chrome is not free:
 *  - `usesContainFit` false — the picture provably fills the box (an
 *    aspect-matched `object-cover` camera, or an auto-height screen share), so
 *    the tile's corners ARE the picture's corners and there is nothing to wait
 *    for.
 *  - `hasPicture` false — a camera-off tile has no rect coming, ever. Waiting
 *    would hide its name permanently.
 * Both of those render immediately at the tile's corners.
 */
export function videoRectPending(
    // `boolean | undefined` because the caller's flags come from optional props
    // (`isGridView` / `isFocusedView`); an absent flag means "no", and saying so
    // in the signature beats a `!!` at the call site that could be dropped.
    usesContainFit: boolean | undefined,
    hasPicture: boolean | undefined,
    rect: ContentRect | null,
): boolean {
    return !!usesContainFit && !!hasPicture && !rect;
}

// ── Which corner each piece of chrome lives in ──────────────────────────────
//
// There is no single answer: the owner asked for two different arrangements,
// one per view mode, and both are direct quotes.
//
// FULLSCREEN — the arrangement that shipped and was then approved:
//   "In a full screen video call can we have the person's name be in the top
//    right corner of their video? not the bottom right corner. ... Also move
//    the annotation button to inside the video frame too, the top left corner
//    where it is, is good."
//
// NOT FULLSCREEN — the correction that followed, on that same build:
//   "keep the name of video member in the bottom right, have the resolution in
//    the top left and the annotation in the top right."
//
// So:
//
//   corner         NOT fullscreen        fullscreen
//   top-left       resolution / fps      annotation cluster
//   top-right      annotation cluster    name pill
//   bottom-left    —                     resolution / fps
//   bottom-right   name pill             —
//
// The two modes are NOT a rotation or a mirror of each other: the name moves
// diagonally, the tools move horizontally, and the stats readout moves
// vertically. That is why this is a lookup table rather than a transform —
// there is no rule underneath it, only two stated preferences, and inventing
// a symmetry would be asserting something the owner never said.
//
// The slots are decided HERE, next to the insets, rather than inside each tile
// component, so "which corner" and "where is that corner on the picture" stay
// one decision made in one place. A tile asks for
// `tileChromeSlots(isFullscreen)` and feeds each slot to `cornerStyle` along
// with the very same `ChromeInsets` every other piece of its chrome uses —
// which is what keeps all four corners off the letterbox bars no matter which
// one a given badge lands in. Bottom-left and bottom-right were previously
// reachable only by the stats readout's hand-written `bottom: chrome.bottom`;
// now every corner goes through the same two lines.

export type TileCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** Which corner each piece of a tile's corner chrome occupies. */
export interface TileChromeSlots {
    /** The annotation toolbar / request button / requests menu. */
    tools: TileCorner;
    /** The display-name + avatar pill. */
    name: TileCorner;
    /** The resolution · fps readout. */
    stats: TileCorner;
}

/**
 * The corner assignment for a tile, by view mode. See the table above.
 *
 * `boolean | undefined` because the caller's flag is `callCtx?.isFullscreen`
 * off an OPTIONAL context — an absent context means "not fullscreen", and
 * saying that in the signature beats a `!!` at the call site that could be
 * dropped. (Same reasoning as `videoRectPending`'s flags above.)
 *
 * Note this is the app's own cinema overlay mode, NOT the OS window being
 * fullscreen — see hooks/useOsWindowFullscreen.ts for the other one. The
 * owner's two quotes are both about the cinema view.
 */
export function tileChromeSlots(fullscreen: boolean | undefined): TileChromeSlots {
    return fullscreen
        ? { tools: 'top-left', name: 'top-right', stats: 'bottom-left' }
        : { stats: 'top-left', tools: 'top-right', name: 'bottom-right' };
}

/** The two CSS offsets that pin an absolutely-positioned child to a corner. */
export interface CornerPosition {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
}

/**
 * Turn a corner plus a tile's insets into the two CSS offsets that anchor an
 * `absolute` child there.
 *
 * Exactly two of the four are ever set, and both always come out of the SAME
 * `ChromeInsets` — the one derived from the picture's `fitRect`. That is the
 * whole point: moving a badge from `top-right` to `bottom-right` changes which
 * inset it reads, never how that inset was computed, so a corner cannot
 * quietly regress to a hard-coded `top-2 left-2` sitting in the black bar.
 *
 * Leaving the other two offsets UNSET (rather than `auto`, or 0) matters for
 * the name pill in particular: an absolutely-positioned element given BOTH
 * `left` and `right` is stretched to span between them, and its `max-width`
 * then clamps a box that is still left-aligned rather than shrink-wrapped into
 * the corner it was asked for.
 */
export function cornerStyle(corner: TileCorner, insets: ChromeInsets): CornerPosition {
    const isTop = corner === 'top-left' || corner === 'top-right';
    const isLeft = corner === 'top-left' || corner === 'bottom-left';
    return {
        ...(isTop ? { top: insets.top } : { bottom: insets.bottom }),
        ...(isLeft ? { left: insets.left } : { right: insets.right }),
    };
}
