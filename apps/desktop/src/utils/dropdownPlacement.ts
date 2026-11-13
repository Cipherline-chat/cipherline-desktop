/**
 * Which way a dropdown list opens. The screen-share picker's lists always
 * opened upward; with the settings row near the top of the dialog body the top
 * options were cut off (owner screenshot 2026-11-04).
 */
/** Rough list height: one ClButton sm row per option plus the list's padding. */
const DROPDOWN_ROW_PX = 32;
const DROPDOWN_PAD_PX = 12;

/**
 * Open upward unless the room above (inside the nearest ancestor that clips or
 * scrolls, else the window) is too small and there is more room below. Pure.
 */
export function chooseDropUp(spaceAbove: number, spaceBelow: number, optionCount: number): boolean {
    const need = optionCount * DROPDOWN_ROW_PX + DROPDOWN_PAD_PX + 6;
    if (spaceAbove >= need) return true;
    return spaceAbove >= spaceBelow;
}

