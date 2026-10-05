import React from 'react';
import { chromeMaxWidthCss, cornerStyle, type ChromeInsets, type TileCorner } from './videoRectChrome';

/**
 * TileCornerChrome — the corner slots every call tile has, in one place.
 *
 * ── The contract the owner set
 *
 *   "In a full screen video call can we have the person's name be in the top
 *    right corner of their video? not the bottom right corner. And make sure
 *    it is actually on their video not just in the far right corner of the box
 *    they are in, I don't want it to be in the black bar area. Also move the
 *    annotation button to inside the video frame too, the top left corner
 *    where it is, is good."
 *
 * ...and then, on the build that shipped that:
 *
 *   "keep the name of video member in the bottom right, have the resolution in
 *    the top left and the annotation in the top right" — when NOT fullscreen.
 *
 * So WHICH corner is mode-dependent and is decided by
 * `videoRectChrome.tileChromeSlots()`; these components take the answer as the
 * `corner` prop. It used to be hard-coded here (name top-right, tools
 * top-left), which was correct for exactly one of the two modes. The
 * requirement that did NOT change is that every corner rides the picture where
 * there is one — the owner's screenshot circled the same corners on a live
 * video tile AND on a black camera-off tile.
 *
 * ── Why these are components rather than four copies of a className
 *
 * Three different components render a tile that can appear in a fullscreen or
 * focused call (VideoTile, ParticipantCard, ScreenShareGate — see
 * ./videoRectChrome.ts's module comment). Before this file, VideoTile owned the
 * only correct implementation and the other two had either a differently-tuned
 * corner or no corner chrome at all. Copying VideoTile's `absolute z-20 flex
 * items-center gap-1.5 bg-black/35 backdrop-blur-sm ...` into each of them
 * would have made them agree exactly once — on the day it was pasted.
 *
 * WHERE the corner is still comes from `videoRectChrome`; this file owns only
 * what the corner LOOKS like and how wide it may get. Neither component
 * measures anything: the caller hands in insets, which for a picture-bearing
 * tile are derived from the very same `fitRect` that draws its rounded border
 * and maps its annotation strokes, and for a picture-less tile are
 * `tileCornerInsets()`.
 */

export interface TileCornerChromeProps {
    /**
     * Where the corner is, in px from the TILE's own four edges. From
     * `videoRectInsets(box, rect, CHROME_GUTTER_PX)` on a tile with a picture,
     * or `tileCornerInsets()` on one without.
     */
    insets: ChromeInsets;
    /**
     * Which corner to sit in — from `tileChromeSlots(isFullscreen)`, whose
     * table is the owner's two quotes. Required rather than defaulted: a
     * default would silently be right in one mode and wrong in the other,
     * which is exactly the bug this prop exists to make impossible.
     */
    corner: TileCorner;
    children: React.ReactNode;
    className?: string;
}

/**
 * The name pill — top-right in fullscreen, bottom-right otherwise.
 *
 * `maxWidth` is not a prop: it is always `chromeMaxWidthCss(insets)`, which
 * resolves to the picture's width on a letterboxed tile and the tile's width
 * on one with no picture — see that function's doc comment for why one
 * relative formula covers both. Handing callers a knob here is how a pill ends
 * up spilling back into the bars it was just moved off.
 *
 * `pointer-events-none` on the wrapper is load-bearing on VideoTile: the tile
 * underneath owns click-to-focus and right-click-for-menu over its whole area,
 * and a pill that swallowed those would make the top-right corner of every
 * video dead. Children that genuinely need input re-enable it on themselves.
 */
export const TileNamePill = ({ insets, corner, children, className = '', large = false }: TileCornerChromeProps & {
    /** Focused/stage sizing — a roomier pill for the one tile filling the screen. */
    large?: boolean;
}) => (
    <div
        className={`absolute z-20 flex items-center gap-1.5 bg-black/35 backdrop-blur-sm rounded-lg pointer-events-none ${
            large ? 'px-3 py-1.5' : 'px-2 py-1'
        } ${className}`}
        style={{
            ...cornerStyle(corner, insets),
            maxWidth: chromeMaxWidthCss(insets),
        }}
    >
        {children}
    </div>
);

/**
 * The tool cluster — today the annotation toolbar / request button / requests
 * menu, on the tiles that have one. Top-left in fullscreen, top-right
 * otherwise.
 *
 * Deliberately NO width cap, unlike the pill: these are interactive controls
 * with fixed hit targets, and squeezing them to fit a narrow picture makes the
 * tool harder to press rather than tidier. Text is the only thing worth
 * clamping.
 *
 * Same `pointer-events-none`-with-opt-in-children rule as the pill, and for the
 * same reason.
 */
export const TileToolCluster = ({ insets, corner, children, className = '' }: TileCornerChromeProps) => (
    <div
        className={`absolute z-20 flex items-center gap-1.5 pointer-events-none ${className}`}
        style={cornerStyle(corner, insets)}
    >
        {children}
    </div>
);

/**
 * The resolution · fps readout — bottom-left in fullscreen, top-left
 * otherwise.
 *
 * Previously inline in VideoTile with a hand-written `{ bottom: chrome.bottom,
 * left: chrome.left }`, which is the one corner-anchored overlay that never
 * went through this file. It is here now for the same reason the other two
 * are: its corner is mode-dependent, and a fourth hand-written spelling of
 * "which two insets do I read" is how the corners drift apart again.
 *
 * Same `pointer-events-none` rule as the pill — it is pure readout, and the
 * tile underneath owns click-to-focus over its whole area.
 */
export const TileStatsReadout = ({ insets, corner, children, className = '' }: TileCornerChromeProps) => (
    <div
        className={`absolute z-20 flex items-center gap-1.5 bg-black/35 backdrop-blur-sm px-2.5 py-1 rounded-lg pointer-events-none ${className}`}
        style={{
            ...cornerStyle(corner, insets),
            maxWidth: chromeMaxWidthCss(insets),
        }}
    >
        {children}
    </div>
);
