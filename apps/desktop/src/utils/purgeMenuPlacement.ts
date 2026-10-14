/**
 * Pure placement / formatting helpers for PurgeDropdown (components/PurgeControls.tsx),
 * kept out of the component file so they are unit-testable without a layout engine.
 */

/** "12 msgs" / "1 msg" — the right-hand hint on each purge row. */
export function formatPurgeCount(n: number): string {
    return `${n.toLocaleString()} ${n === 1 ? 'msg' : 'msgs'}`;
}

// ─── Menu placement ──────────────────────────────────────────────────────────

const MENU_GAP = 4;
const MENU_MARGIN = 8;
export const MENU_MIN_WIDTH = 208;

export interface PurgeMenuPlacement {
    top: number;
    left: number;
    width: number;
    side: 'below' | 'above';
    /** Set only when neither side has room for the whole panel: it then scrolls. */
    maxHeight?: number;
}

/**
 * Where the panel goes relative to its trigger: below by default, flipped
 * above when it does not fit underneath AND there is more room above (the
 * conversation cards sit near the bottom edge of the scrolling settings
 * pane). When neither side fits it takes the roomier one and is height-capped
 * (scrolls) rather than ever covering the trigger. Pure so the flip is
 * testable without a layout engine.
 */
export function computePurgeMenuPlacement(
    trigger: { top: number; bottom: number; left: number; width: number },
    menuHeight: number,
    viewport: { width: number; height: number },
): PurgeMenuPlacement {
    const width = Math.min(Math.max(trigger.width, MENU_MIN_WIDTH), Math.max(0, viewport.width - MENU_MARGIN * 2));
    const left = Math.min(Math.max(trigger.left, MENU_MARGIN), Math.max(MENU_MARGIN, viewport.width - MENU_MARGIN - width));
    const spaceBelow = Math.max(0, viewport.height - MENU_MARGIN - (trigger.bottom + MENU_GAP));
    const spaceAbove = Math.max(0, trigger.top - MENU_GAP - MENU_MARGIN);
    const flip = menuHeight > spaceBelow && spaceAbove > spaceBelow;
    const space = flip ? spaceAbove : spaceBelow;
    const height = Math.min(menuHeight, space);
    const top = flip ? trigger.top - MENU_GAP - height : trigger.bottom + MENU_GAP;
    return {
        top, left, width, side: flip ? 'above' : 'below',
        ...(menuHeight > space ? { maxHeight: space } : {}),
    };
}
