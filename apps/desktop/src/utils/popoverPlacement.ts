/**
 * Where an anchored popover goes (the profile preview, opened from a click).
 *
 * Rules, in order:
 *  - Never under the window's own titlebar strip: the top `safeTop` px hold
 *    the drag region and, on Windows, the native minimise / maximise / close
 *    overlay (electron/main.ts `titleBarOverlay`, 34px). A popover there was
 *    both cut off and partly unclickable (the strip swallows clicks).
 *  - Beside the click, not on top of it: to the right when it fits, else to
 *    the left (a member list at the window's right edge), else centred on the
 *    click and clamped. The thing you clicked stays visible.
 *  - Vertically, the card's head starts a little above the click, then is
 *    clamped so the WHOLE card fits between the safe top and the bottom edge.
 *  - Only a card taller than the space there is gets `maxHeight` (and the
 *    caller scrolls it). Measured height, not an estimate.
 */

/** Height of the app's titlebar strip (Dashboard's .drag-region, the Windows controls overlay). */
export const WINDOW_TITLEBAR_PX = 34;

export interface PlacementInput {
    /** The click point (viewport px). null = centre the popover in the usable area. */
    anchor: { x: number; y: number } | null;
    /** The popover's own size (measured). */
    size: { w: number; h: number };
    viewport: { w: number; h: number };
    /** Reserved band at the top (titlebar). Default WINDOW_TITLEBAR_PX. */
    safeTop?: number;
    /** Gap kept from every edge. Default 12. */
    margin?: number;
    /** Gap between the click and the popover's side. Default 14. */
    gap?: number;
    /** How far above the click the popover's top starts. Default 36. */
    lead?: number;
}

export interface Placement {
    left: number;
    top: number;
    /** Set only when the popover cannot fit vertically; the caller scrolls inside it. */
    maxHeight: number | null;
    /** Which side of the anchor it opened on (drives the entrance's transform-origin). */
    side: 'right' | 'left' | 'center';
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function placePopover({ anchor, size, viewport, safeTop = WINDOW_TITLEBAR_PX, margin = 12, gap = 14, lead = 36 }: PlacementInput): Placement {
    const minTop = safeTop + margin;
    const room = Math.max(0, viewport.h - minTop - margin);
    const maxHeight = size.h > room ? room : null;
    const h = Math.min(size.h, room);
    const maxLeft = Math.max(margin, viewport.w - size.w - margin);

    if (!anchor) {
        return {
            left: clamp(Math.round((viewport.w - size.w) / 2), margin, maxLeft),
            top: Math.round(minTop + Math.max(0, (room - h) / 2)),
            maxHeight, side: 'center',
        };
    }

    let left: number;
    let side: Placement['side'];
    if (anchor.x + gap + size.w <= viewport.w - margin) { left = anchor.x + gap; side = 'right'; }
    else if (anchor.x - gap - size.w >= margin) { left = anchor.x - gap - size.w; side = 'left'; }
    else { left = clamp(anchor.x - size.w / 2, margin, maxLeft); side = 'center'; }

    const top = clamp(anchor.y - lead, minTop, Math.max(minTop, viewport.h - margin - h));
    return { left: Math.round(left), top: Math.round(top), maxHeight, side };
}
