import { useEffect, useRef } from 'react';
import { OS_WINDOW_FULLSCREEN_QUERY } from './useOsWindowFullscreen';

/**
 * Hold the OS window fullscreen for as long as `active` is true, through the HTML
 * fullscreen API. There is no IPC for this and none is needed: main already grants
 * the `fullscreen` permission (main.ts, for a video attachment's native controls),
 * and the root element keeps every portal, menu and the call console on screen.
 *
 * Best effort by design. If the request is refused the caller's own view still
 * works, inside the window. A window that is already fullscreen (F11, the macOS
 * green button) is left exactly as it was, on the way in and on the way out.
 *
 * `onLeft` fires when the window leaves fullscreen by some route other than this
 * hook, which in practice is Escape. Measured on Electron 43.2 with a raw key-down
 * (what a real key press is): while the HTML API holds the window, the browser
 * consumes Escape itself. The page gets no keydown at all, so the app's escape
 * stack never hears about it and `fullscreenchange` is the only signal. One press
 * is still one step, since nothing else runs. The cost is that the press cannot
 * reach a layer above the caller first, like an open menu or an armed pen.
 */
export function useHtmlFullscreenWhile(active: boolean, onLeft: () => void): void {
    const onLeftRef = useRef(onLeft);
    useEffect(() => { onLeftRef.current = onLeft; });

    useEffect(() => {
        if (!active || document.fullscreenElement) return;
        if (window.matchMedia?.(OS_WINDOW_FULLSCREEN_QUERY).matches) return;
        const root = document.documentElement;
        let disposed = false;
        let entered = false;
        const onChange = () => {
            if (!entered || document.fullscreenElement) return;
            entered = false;
            onLeftRef.current();
        };
        document.addEventListener('fullscreenchange', onChange);
        root.requestFullscreen?.().then(() => {
            // Ended before the window got there: the cleanup below had nothing to undo yet.
            if (disposed) void document.exitFullscreen().catch(() => {});
            else entered = true;
        }).catch(() => { /* refused: the in-window view is the fallback */ });
        return () => {
            disposed = true;
            document.removeEventListener('fullscreenchange', onChange);
            if (document.fullscreenElement === root) void document.exitFullscreen().catch(() => {});
        };
    }, [active]);
}
