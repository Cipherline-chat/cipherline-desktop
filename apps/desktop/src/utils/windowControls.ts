/**
 * Should the page draw its OWN minimise / maximise / close buttons?
 *
 * Normally never: macOS has its traffic lights, and on Windows and Linux
 * Electron paints native caption buttons over the page (the Window Controls
 * Overlay, electron/window-chrome.ts). The HTML buttons (Dashboard.tsx
 * <WindowControls>, ClientBlockScreen) are only a fallback for a Linux window
 * that ends up without the overlay, so a frameless window is never left with
 * no way to close it.
 *
 * `overlayVisible` (`navigator.windowControlsOverlay?.visible`) is the ground
 * truth for "native buttons are already on screen"; checking it, not just the
 * platform, is what stops two sets of buttons being drawn on top of each other.
 */
export interface WindowControlsEnv {
    /** `!!window.electronAPI`: outside Electron there is no window to control. */
    inElectron: boolean;
    userAgent: string;
    overlayVisible: boolean | undefined;
}

export function drawsOwnWindowControls(env: WindowControlsEnv): boolean {
    if (!env.inElectron) return false;
    const ua = env.userAgent.toLowerCase();
    if (ua.includes('macintosh') || ua.includes('windows')) return false;
    return env.overlayVisible !== true;
}

/** The live environment (renderer only). */
export function currentWindowControlsEnv(): WindowControlsEnv {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    return {
        inElectron: typeof window !== 'undefined' && !!window.electronAPI,
        userAgent: nav?.userAgent ?? '',
        overlayVisible: nav?.windowControlsOverlay?.visible,
    };
}
