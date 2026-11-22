/**
 * Geometry of the docked call console (ControlBar's `.cl-console-inner`,
 * index.css) as plain arithmetic, so the "every control fits at every panel
 * width" promise is testable without a browser. The CSS is the source of truth
 * for what paints; this mirrors it, and callConsoleFit.test.ts pins the two
 * together (and to Dashboard's RIGHT_PANEL_MIN_PX).
 *
 * The row is, in order: mic, deafen, | divider |, camera, share, fullscreen,
 * | leave divider |, leave — 8 flex items, 7 gaps, inside the capsule padding.
 * A live share swaps the plain share control for stop + 1px seam + a chevron
 * 0.56 of a control wide.
 */

/** The console's container query switches to the narrow tier below this width (CSS: `max-width: 251.98px`). */
export const NARROW_TIER_BELOW_PX = 252;
/** Smallest control diameter the console may render — the minimum hit target. */
export const MIN_CONTROL_PX = 28;
/** Above this console width the leave button grows a text label (`@container (min-width: 430px)`), which this model does not size. */
export const LEAVE_LABEL_FROM_PX = 430;

/** Horizontal space the panel takes before the console: the aside's 1px border, #call-controlbar-root's px-2, ControlBar's px-1. */
export const PANEL_TO_CONSOLE_PX = 1 + 16 + 8;
export const consoleWidthForPanel = (panelPx: number) => panelPx - PANEL_TO_CONSOLE_PX;

const clamp = (lo: number, v: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface ConsoleGeometry {
    tier: 'base' | 'narrow';
    /** control diameter */
    cs: number;
    /** gap between items */
    cg: number;
    /** capsule padding */
    cp: number;
    /** width the row actually needs, padding included */
    rowWidth: number;
}

/** `consoleW` is the `.cl-console` container's inline size (1cqi = consoleW / 100). */
export function consoleGeometry(consoleW: number, liveShare: boolean): ConsoleGeometry {
    const cqi = consoleW / 100;
    const units = liveShare ? 6.56 : 6;
    const base = (84 * cqi - 8) / units;
    const narrow = consoleW < NARROW_TIER_BELOW_PX;
    let cs: number, cg: number, cp: number, sepCost: number;
    if (narrow) {
        cg = 3;
        cp = 3;
        const exact = (100 * cqi - (liveShare ? 30 : 29)) / units;
        cs = clamp(MIN_CONTROL_PX, Math.min(exact, Math.max(31, base)), 46);
        sepCost = 2; // two 1px hairlines, no margins
    } else {
        cs = clamp(31, base, 46);
        cg = clamp(3, 1.2 * cqi, 7);
        cp = clamp(4, 1.4 * cqi, 8);
        sepCost = (1 + 2 * 0.75 * cg) + (1 + 1.6 * cg + 1.2 * cg);
    }
    const share = liveShare ? cs + 1 + 0.56 * cs : cs;
    const rowWidth = 2 * cp + 7 * cg + sepCost + 5 * cs + share;
    return { tier: narrow ? 'narrow' : 'base', cs, cg, cp, rowWidth };
}
