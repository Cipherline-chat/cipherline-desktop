import { useSyncExternalStore } from 'react';

/**
 * Is the OS window itself fullscreen — the macOS green-button / Windows F11
 * kind — rather than `CallContext.isFullscreen`, which is this app's OWN
 * cinema call overlay and says nothing about the underlying window?
 *
 * Conflating the two is the easy bug here: `CallContext.isFullscreen` is true
 * for the overlay far more often than the OS window is actually fullscreen
 * (a maximised, or even just a normal, window can show it), and in that
 * common case the app's real titlebar and — on Windows — the OS-drawn
 * `titleBarOverlay` window buttons are both still there, just hidden behind
 * FullscreenOverlay's full-viewport portal. That is exactly the case the
 * drag strip exists to patch. Only when the OS itself owns the fullscreen
 * transition does the titlebar (and the Windows button row) actually stop
 * existing, at which point a rendered strip would be a dead band eating into
 * the video.
 *
 * Detected with no main-process / preload changes: neither is wired to tell
 * the renderer about `BrowserWindow` fullscreen transitions today (only
 * `isMaximized/onMaximizeChange`, a different state). Electron mirrors a
 * `BrowserWindow`'s native fullscreen state into the renderer's `display-mode`
 * media feature (the same mechanism a PWA uses to detect its own display
 * mode), so `(display-mode: fullscreen)` is true exactly while the OS window
 * is fullscreen — on both the macOS and Windows transitions this app can
 * reach — without any IPC round trip.
 */
export const OS_WINDOW_FULLSCREEN_QUERY = '(display-mode: fullscreen)';

export function useOsWindowFullscreen(): boolean {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const hasMatchMedia = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function';

function subscribe(onChange: () => void): () => void {
    if (!hasMatchMedia()) return () => { /* nothing to unsubscribe from */ };
    const mql = window.matchMedia(OS_WINDOW_FULLSCREEN_QUERY);
    // Safari < 14 only has the deprecated addListener form.
    if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
}

function getSnapshot(): boolean {
    if (!hasMatchMedia()) return false;
    return window.matchMedia(OS_WINDOW_FULLSCREEN_QUERY).matches;
}

/** No window during SSR / the vitest node environment — assume windowed. */
function getServerSnapshot(): boolean {
    return false;
}
