/**
 * The inline "Unlock Cipherline with a PIN" entry on the onboarding privacy
 * step, as a pure state machine (no React, no timers, no storage).
 *
 *   off ──turnOn──▶ first ──(len digits)── commitFirst ──▶ again
 *                   ▲  │ setLength(4|6)                      │ confirm
 *                   │  ▼                                     ▼
 *                   └── mismatchReset ◀── mismatch ◀── (≠) ──┤
 *                                                            │ (=)
 *                                         done ◀── saved ── saving
 *                                          │  └── saveFailed ──▶ first
 *                                          └── turnedOff ──▶ off
 *   cancel / leave: any entering stage ──▶ off (nothing was saved)
 *
 * Mirrors ScreenLockSettings' setup flow (6 digits by default, typed twice,
 * then `useScreenLock().setPin(pin, len)` makes the verifier). The PIN only
 * ever lives in this state, which the step holds in component memory: it is
 * kept after `done` solely so turning the toggle back off in the same visit
 * can call `useScreenLock().disable(pin)`, and it dies with the component.
 */

export type PinLength = 4 | 6;
export type PinStage = 'off' | 'first' | 'again' | 'saving' | 'done';

export interface PinEntryState {
    stage: PinStage;
    len: PinLength;
    /** The first entry while confirming / saving; after `done`, the PIN that
     *  was set in THIS visit ('' when the lock was already on from before). */
    first: string;
    /** What is typed in the slots right now. */
    val: string;
    /** The two entries differed: the slots show red for a moment. */
    mismatch: boolean;
    /** Replaces the headline once (e.g. after a mismatch). */
    note: string | null;
}

export type PinAction =
    | { type: 'turnOn' }
    | { type: 'cancel' }
    | { type: 'leave' }
    | { type: 'setLength'; len: PinLength }
    | { type: 'type'; raw: string }
    | { type: 'commitFirst' }
    | { type: 'confirm' }
    | { type: 'mismatchReset' }
    | { type: 'saved' }
    | { type: 'saveFailed' }
    | { type: 'turnedOff' };

export const MISMATCH_NOTE = 'Didn’t match. Pick again';
export const SAVE_FAILED_NOTE = 'Couldn’t save it. Pick again';

/** Where the step starts: the truth from useScreenLock (Back / resume). */
export function initialPinState(lock: { enabled: boolean; pinLength: PinLength }): PinEntryState {
    return {
        stage: lock.enabled ? 'done' : 'off',
        len: lock.enabled ? lock.pinLength : 6,
        first: '',
        val: '',
        mismatch: false,
        note: null,
    };
}

const fresh = (s: PinEntryState, stage: PinStage, note: string | null = null): PinEntryState =>
    ({ ...s, stage, first: '', val: '', mismatch: false, note });

export const isEntering = (s: PinEntryState): boolean => s.stage === 'first' || s.stage === 'again' || s.stage === 'saving';
export const isComplete = (s: PinEntryState): boolean => s.val.length === s.len;
/** The toggle reads on while entering, saving or set. */
export const pinToggleOn = (s: PinEntryState): boolean => s.stage !== 'off';
/** Set in an earlier visit, so the PIN is not in memory: no off switch here. */
export const pinLockedHere = (s: PinEntryState): boolean => s.stage === 'done' && s.first === '';

export function pinHeadline(s: PinEntryState): string {
    if (s.note) return s.note;
    return s.stage === 'first' ? `Pick a ${s.len}-digit PIN` : 'Once more to confirm';
}

export function pinReducer(s: PinEntryState, a: PinAction): PinEntryState {
    switch (a.type) {
        case 'turnOn':
            return s.stage === 'off' ? fresh(s, 'first') : s;
        case 'cancel':
        case 'leave':
            // Half-way through: back off, nothing saved. A saving / set PIN
            // is left alone (the hook owns it from here).
            return s.stage === 'first' || s.stage === 'again' ? fresh(s, 'off') : s;
        case 'setLength':
            if (s.stage !== 'first') return s;
            return a.len === s.len ? s : { ...fresh(s, 'first'), len: a.len };
        case 'type': {
            if (s.stage !== 'first' && s.stage !== 'again') return s;
            if (s.mismatch) return s;
            const val = a.raw.replace(/\D/g, '').slice(0, s.len);
            return val === s.val ? s : { ...s, val };
        }
        case 'commitFirst':
            if (s.stage !== 'first' || !isComplete(s)) return s;
            return { ...s, stage: 'again', first: s.val, val: '', note: null };
        case 'confirm':
            if (s.stage !== 'again' || !isComplete(s)) return s;
            // saving keeps the slots full while the verifier is derived
            return s.val === s.first ? { ...s, stage: 'saving' } : { ...s, mismatch: true };
        case 'mismatchReset':
            return s.mismatch ? fresh(s, 'first', MISMATCH_NOTE) : s;
        case 'saved':
            return s.stage === 'saving' ? { ...s, stage: 'done', val: '', note: null } : s;
        case 'saveFailed':
            return s.stage === 'saving' ? fresh(s, 'first', SAVE_FAILED_NOTE) : s;
        case 'turnedOff':
            return s.stage === 'done' ? fresh(s, 'off') : s;
        default:
            return s;
    }
}
