/**
 * Viewport-aware vertical placement for the `ClSelect` option menu.
 *
 * Pure (no DOM/React) so the flip/clamp behaviour is unit-testable. All
 * coordinates are viewport-relative, matching `position: fixed`.
 */

export interface SelectTriggerRect {
    top: number;
    bottom: number;
}

export interface SelectPlacement {
    /** True when the menu sits above the trigger (anchored by `bottom`). */
    openUp: boolean;
    /** `top` to apply when opening down. */
    top: number;
    /** `bottom` to apply when opening up (distance from the viewport bottom). */
    bottom: number;
    /** Height cap so the menu (which scrolls) never leaves the viewport. */
    maxHeight: number;
}

export function computeSelectPlacement(
    trigger: SelectTriggerRect,
    menuHeight: number,
    viewportHeight: number,
    opts: { gap?: number; margin?: number } = {},
): SelectPlacement {
    const gap = opts.gap ?? 4;
    const margin = opts.margin ?? 8;
    const below = Math.max(0, viewportHeight - margin - (trigger.bottom + gap));
    const above = Math.max(0, trigger.top - gap - margin);
    // Prefer down; flip up only when it doesn't fit below AND up has more room.
    const openUp = menuHeight > below && above > below;
    const room = openUp ? above : below;
    return {
        openUp,
        top: trigger.bottom + gap,
        bottom: viewportHeight - trigger.top + gap,
        maxHeight: Math.floor(Math.min(menuHeight, room)),
    };
}
