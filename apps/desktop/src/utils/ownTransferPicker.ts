/**
 * One "Transfer from which device?" picker for the whole app. Three places open it: the sign-in history step
 * (`SignInHistoryPrompt`), Settings, Storage, "Move your history" (`MoveHistoryCard`), and "Try again" on a transfer that ended
 * without moving anything (`OwnTransferHost`). `NearTransferHost` renders the single dialog, so whichever opened it, the request
 * to the other device goes out the same way (`requestOwnTransfer`) and the same wait / outcome screens follow.
 *
 * A plain module store (no React context) because the openers live in unrelated trees (Dashboard's banner stack, the Settings
 * overlay, the host's own dialogs). Holds no key, token or device secret: only the caller's two callbacks.
 */
export interface PickerRequest {
    /** The dialog was closed without asking any device (Cancel, Esc, overlay). */
    onCancel?: () => void;
    /** A device was asked; the wait screen takes over from here. */
    onStarted?: () => void;
}

let current: PickerRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = (): void => { seq += 1; for (const l of Array.from(listeners)) l(); };

export function openOwnTransferPicker(req: PickerRequest = {}): void {
    const prev = current;
    current = req;
    emit();
    // A second opener replaces the first: the first is told it was not used, so it can put its own screen back.
    if (prev && prev !== req) prev.onCancel?.();
}

/** Close the picker. `started` = a device was asked (the opener's `onStarted`), else the opener's `onCancel`. */
export function closeOwnTransferPicker(started: boolean): void {
    const req = current;
    if (!req) return;
    current = null;
    emit();
    if (started) req.onStarted?.(); else req.onCancel?.();
}

let asked: string | null = null;
/** The name (already sanitised by `pickRows`) of the device this one last asked: the asker's wait and ending screens name it,
 *  because the host only knows it as "your other device". Display text only. */
export function rememberAskedDevice(name: string | null): void { asked = name; }
export function askedDeviceName(): string | null { return asked; }

export function ownTransferPickerOpen(): boolean { return current !== null; }
export function ownTransferPickerSeq(): number { return seq; }
export function subscribeOwnTransferPicker(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }

/** Tests only. */
export function resetOwnTransferPickerForTest(): void { current = null; seq = 0; asked = null; listeners.clear(); }
