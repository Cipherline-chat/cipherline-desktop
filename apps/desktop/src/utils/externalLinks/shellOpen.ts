/**
 * The two primitives under openExternalLink and the leaving-Cipherline gate.
 * Nothing else in the renderer should call `window.electronAPI.openExternal`;
 * go through utils/openExternalLink.ts.
 */

/** Input events a person makes on a link or a button. */
const GESTURE_EVENTS = new Set(['click', 'auxclick', 'keydown', 'keyup', 'pointerup', 'mouseup', 'touchend']);

let probeForTests: (() => boolean) | null = null;

/**
 * Tests only: jsdom has neither `navigator.userActivation` nor trusted events.
 * Pass null to restore the real check.
 */
export function setUserGestureProbeForTests(probe: (() => boolean) | null): void {
    probeForTests = probe;
}

/**
 * Is this call happening INSIDE a person's click or key press, right now?
 * Both must hold:
 *   - the event being dispatched (`window.event`) is a trusted input event —
 *     the browser sets isTrusted only for real input, never for
 *     `el.click()` / `dispatchEvent` from script, and `window.event` is unset
 *     in a timer, a promise callback or a WebSocket message handler;
 *   - Chromium's `navigator.userActivation.isActive` agrees.
 * `isActive` alone is not enough: it stays true for a few seconds after ANY
 * key press (typing in the composer), so a message arriving meanwhile could
 * ride on it. FAILS CLOSED when either API is missing.
 */
export function hasUserGesture(): boolean {
    if (probeForTests) return probeForTests();
    try {
        if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
        const ev = (window as unknown as { event?: Event }).event;
        if (!ev || ev.isTrusted !== true || !GESTURE_EVENTS.has(ev.type)) return false;
        return navigator.userActivation?.isActive === true;
    } catch {
        return false;
    }
}

/** Hand an ALREADY-VALIDATED href to the OS (main re-checks https/mailto). */
export function sendToShell(href: string): void {
    if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
        void window.electronAPI.openExternal(href).catch(() => { /* main process already logs failures */ });
    } else if (typeof window !== 'undefined' && typeof window.open === 'function') {
        // Realistically dead in this app (no Electron bridge) — kept as a
        // validated safety net rather than assuming the bridge always exists.
        window.open(href, '_blank', 'noopener,noreferrer');
    }
}
