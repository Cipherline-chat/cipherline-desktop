/**
 * Who draws the main window's minimise / maximise / close buttons.
 *
 *   - macOS: the native traffic lights (titleBarStyle 'hiddenInset').
 *   - Windows AND Linux: Electron's native Window Controls Overlay
 *     (`titleBarOverlay`), tinted with the theme's title-bar colours.
 *
 * Linux used to draw its own HTML buttons (Dashboard.tsx <WindowControls>)
 * inside the frameless window's `-webkit-app-region: drag` title bar. Those
 * only work while nothing draggable is ever stacked over them: in 1.0.23
 * App.tsx's full-width fixed drag strip (z-index 9999) sat on top of them, so
 * every click hit the strip and none of the three buttons did anything (on
 * X11 and Wayland alike; reproduced on Arch KDE Plasma 6.8 Wayland with the
 * user's Electron 43.7.9). 0.1.0 raised the buttons above the strip, but they
 * still existed only in the Dashboard title bar: the sign-in screen and every
 * full-window surface that covers that bar (the full-screen call, Settings,
 * the server dock) had no window buttons at all on Linux.
 *
 * The native overlay is hit-tested by the browser process, above the page and
 * independent of the page's drag regions, so no page markup can swallow it,
 * and it is on screen on every surface, exactly as on Windows (every surface
 * already leaves the top-right corner free for the Windows overlay, which is
 * wider than Linux's). Verified on KDE Plasma 6.8 Wayland: all three buttons
 * work and the title bar still drags.
 *
 * Dashboard's HTML <WindowControls> stays as a fallback: it draws only while
 * `navigator.windowControlsOverlay.visible` is false.
 *
 * No `electron` import: unit-testable under vitest.
 */

/** Height of the app's own title bar (Dashboard.tsx's 34px .drag-region); the overlay matches it. */
export const TITLE_BAR_HEIGHT_PX = 34;

/** Does Electron paint the caption buttons (Window Controls Overlay) on this platform? */
export function usesNativeCaptionOverlay(platform: string): boolean {
    return platform === 'win32' || platform === 'linux';
}

export interface TitleBarColours { color: string; symbolColor: string }

/** The `titleBarOverlay` BrowserWindow option / `setTitleBarOverlay` argument, or undefined where there is none. */
export function titleBarOverlayFor(
    platform: string,
    colours: TitleBarColours,
): { color: string; symbolColor: string; height: number } | undefined {
    if (!usesNativeCaptionOverlay(platform)) return undefined;
    return { color: colours.color, symbolColor: colours.symbolColor, height: TITLE_BAR_HEIGHT_PX };
}
