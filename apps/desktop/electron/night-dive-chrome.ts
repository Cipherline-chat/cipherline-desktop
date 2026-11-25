/**
 * Night dive and the native caption buttons (Windows / Linux `titleBarOverlay`).
 *
 * From 00:00 to 05:00 local time the renderer's "night dive"
 * (src/utils/nightDive.ts, src/hooks/useNightDive.ts) sets
 * `<html data-depth="night">`, and src/styles/night-dive.css darkens the app's
 * own 34px title bar (`--nd-bar`: Dark's abyss -> a near-black navy). The minimise / maximise /
 * close buttons next to it are NOT page pixels: the OS draws them from the
 * colour main hands to `setTitleBarOverlay`, so without this they kept the
 * daytime navy and sat on a visibly lighter box beside the darker bar (owner
 * report 2026-11-23).
 *
 * The renderer tells main ONE boolean: "the night dive is on screen" (its
 * verdict, read from the attribute the CSS keys on). Main keeps it in memory
 * only and picks the colour here. Why a flag and not the colour itself: a
 * colour from the renderer is only right for the theme it was computed under,
 * and theme changes reach main on their own path (theme:set is invoked AFTER
 * the renderer has already applied the new theme and re-run the night check;
 * `system` flips come from nativeTheme in main). A stale renderer colour would
 * paint a dark box on Light for a moment. With the flag, the colour is a
 * property of the palette main is painting, so every repaint is
 * self-consistent whatever order the messages arrive in.
 *
 * The night dive only deepens the built-in Dark theme (useNightDive.ts
 * nightDiveAppliesTo: not Light, Midnight, the high-contrast themes, custom
 * themes or a live preview), so the override applies only while main is
 * painting exactly the built-in Dark boot palette (`BOOT_PALETTES.dark`, by
 * reference: a custom theme's or a preview's palette is always a separate,
 * parsed object, even when its colours happen to equal Dark's).
 *
 * The symbol colour stays Dark's text colour, which reads even better
 * on the darker box. The window's backgroundColor is unchanged (it shows only
 * before the page paints, and the boot backdrop is the day navy).
 *
 * No `electron` import and no import from ../src (rootDir trap): unit-testable
 * under vitest; electron/night-dive-chrome.test.ts pins the colour to
 * night-dive.css and src/utils/nightDive.ts.
 */
import { BOOT_PALETTES, NIGHT_DIVE_TITLE_BAR, type BootPalette } from './theme-boot';
import type { TitleBarColours } from './window-chrome';

/** The night title-bar colour (theme-boot.ts holds main's colour mirror; night-dive.css `--nd-bar` at night). */
export const NIGHT_DIVE_TITLE_BAR_COLOR = NIGHT_DIVE_TITLE_BAR;

/** IPC channel: renderer -> main, payload exactly `true` or `false`. */
export const NIGHT_DIVE_CHANNEL = 'window:night-dive';

/** The IPC payload -> a boolean, or null for anything else (rejected, never coerced). */
export function parseNightDivePayload(v: unknown): boolean | null {
    return typeof v === 'boolean' ? v : null;
}

/** Does the night dive darken the title bar main is painting with `colors`? (The built-in Dark palette only.) */
export function nightDiveAppliesToPalette(colors: BootPalette): boolean {
    return colors === BOOT_PALETTES.dark;
}

/** The caption-overlay colours for `colors`, with the night dive on or off. */
export function titleBarColoursFor(colors: BootPalette, nightDive: boolean): TitleBarColours {
    if (nightDive && nightDiveAppliesToPalette(colors)) {
        return { color: NIGHT_DIVE_TITLE_BAR_COLOR, symbolColor: colors.titleBar.symbolColor };
    }
    return colors.titleBar;
}

/**
 * Main's in-memory night-dive flag. `set` returns true when the stored value
 * changed (the caller repaints then); `reset` is for a page (re)load, whose
 * boot backdrop is the day navy until the new page announces its own state.
 */
export interface NightDiveState {
    active(): boolean;
    set(payload: unknown): boolean;
    reset(): boolean;
}

export function createNightDiveState(): NightDiveState {
    let on = false;
    return {
        active: () => on,
        set(payload) {
            const next = parseNightDivePayload(payload);
            if (next === null || next === on) return false;
            on = next;
            return true;
        },
        reset() {
            if (!on) return false;
            on = false;
            return true;
        },
    };
}
