import { HeldInputs } from './holdKeys';

/**
 * The focused-window path of a hold key (push-to-talk / push-to-mute): window
 * key AND mouse-button listeners feeding a HeldInputs tracker, calling `press`
 * when the combo becomes held and `release` when it stops. Nothing is
 * intercepted (no preventDefault): the key or click still does whatever it does.
 *
 * On blur the tracker is cleared (a key-up in another window is never seen
 * here); `release` is then called only when no system-wide watcher covers the
 * key (`systemWide()`), because that watcher will report the real release.
 */
export function attachFocusedHoldKey(
    target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
    combo: string,
    handlers: { press: () => void; release: () => void; systemWide: () => boolean },
): () => void {
    const held = new HeldInputs();
    let down = false;
    const update = () => {
        const now = held.isHeld(combo);
        if (now === down) return;
        down = now;
        if (now) handlers.press(); else handlers.release();
    };
    const onKeyDown = (e: KeyboardEvent) => { held.keydown(e); update(); };
    const onKeyUp = (e: KeyboardEvent) => { held.keyup(e); update(); };
    const onMouseDown = (e: MouseEvent) => { held.mousedown(e); update(); };
    const onMouseUp = (e: MouseEvent) => { held.mouseup(e); update(); };
    const onBlur = () => {
        held.clear();
        const was = down;
        down = false;
        if (was && !handlers.systemWide()) handlers.release();
    };
    target.addEventListener('keydown', onKeyDown as EventListener);
    target.addEventListener('keyup', onKeyUp as EventListener);
    target.addEventListener('mousedown', onMouseDown as EventListener);
    target.addEventListener('mouseup', onMouseUp as EventListener);
    target.addEventListener('blur', onBlur);
    return () => {
        target.removeEventListener('keydown', onKeyDown as EventListener);
        target.removeEventListener('keyup', onKeyUp as EventListener);
        target.removeEventListener('mousedown', onMouseDown as EventListener);
        target.removeEventListener('mouseup', onMouseUp as EventListener);
        target.removeEventListener('blur', onBlur);
    };
}

/** Hints already shown, per call (the call UI can remount within one call). */
const shownPerCall = new WeakMap<object, Set<string>>();
/** True the first time `hint` is asked for during `call`, false afterwards. */
export function firstTimeThisCall(call: object | null | undefined, hint: string): boolean {
    if (!call) return false;
    let s = shownPerCall.get(call);
    if (!s) { s = new Set(); shownPerCall.set(call, s); }
    if (s.has(hint)) return false;
    s.add(hint);
    return true;
}
