/**
 * Toast hold: a full-screen layer that covers the toast stack (the level-up
 * celebration) asks the stack to stop counting down while it is up, so a toast
 * that arrived just before or during it (the achievement unlock that caused
 * the level-up) is still there to read afterwards instead of timing out
 * unseen underneath. ToastContext subscribes; anything may hold.
 *
 * Holds nest (a counter): the stack resumes when the last one is released.
 */

/** On release, a held toast gets at least this long on screen again. */
export const TOAST_RESUME_MIN_MS = 4000;

let holds = 0;
const listeners = new Set<(held: boolean) => void>();

const emit = (held: boolean) => { for (const l of [...listeners]) { try { l(held); } catch { /* one listener cannot break the rest */ } } };

/** Pause every toast's auto-dismiss until the returned release is called (idempotent). */
export function holdToasts(): () => void {
    holds++;
    if (holds === 1) emit(true);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        holds = Math.max(0, holds - 1);
        if (holds === 0) emit(false);
    };
}

export const toastsHeld = (): boolean => holds > 0;

/** Called with true when the first hold starts and false when the last one ends. */
export function onToastHold(fn: (held: boolean) => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

/** Tests only. */
export function __resetToastHoldForTests(): void { holds = 0; listeners.clear(); }
