/**
 * When the "Your voice gate may be cutting you off" prompt may show, and how the user's answers are remembered.
 * The detection itself: gateCut.ts. Same rules and storage shape as the echo prompt (echoPrompt.ts):
 *   - never while the gate is off, the mic is closed (muted, or push-to-talk with the key up) or deafened;
 *   - never in the first GC_MIN_CALL_SEC seconds of a call, and at most once per call;
 *   - Dismiss silences it for the rest of that call; after two dismissals it also offers "Don't ask again".
 * Remembered per account (secureLocalStore is per account) under GATE_CUT_PROMPT_STORAGE_KEY: the dismissal count and
 * "never". Not backed up (backupRegistry.ts).
 */
import secureLocalStore from './secureLocalStore';
import {
    parseEchoPromptStore, afterDismiss, afterNever, offerDontAskAgain,
    type EchoPromptStore,
} from './echoPrompt';

/** Remembered per account (secureLocalStore is per account): dismissals and "never". Not backed up (backupRegistry). */
export const GATE_CUT_PROMPT_STORAGE_KEY = 'cipherline_gate_cut_prompt_v1';
/** No prompt in the first seconds of a call (the meter needs real talking anyway). */
export const GC_MIN_CALL_SEC = 20;

export type GateCutPromptStore = EchoPromptStore;
export const loadGateCutPromptStore = (): GateCutPromptStore => {
    try { return parseEchoPromptStore(secureLocalStore.getItem(GATE_CUT_PROMPT_STORAGE_KEY)); } catch { return parseEchoPromptStore(null); }
};
export const saveGateCutPromptStore = (s: GateCutPromptStore): void => {
    try { secureLocalStore.setItem(GATE_CUT_PROMPT_STORAGE_KEY, JSON.stringify(s)); } catch { /* best-effort preference */ }
};
export { afterDismiss, afterNever, offerDontAskAgain };

export interface GateCutPromptContext {
    /** The voice gate is on. */
    gateOn: boolean;
    /** The mic is open: not muted and, in push-to-talk, the key is held. */
    micOpen: boolean;
    deafened: boolean;
    /** Seconds since this call started. */
    callSec: number;
    /** Already shown, or dismissed, in this call. */
    shownThisCall: boolean;
    store: GateCutPromptStore;
}

/** May a detection be shown right now? Pure. */
export function mayPromptForGateCut(c: GateCutPromptContext): boolean {
    return c.gateOn && c.micOpen && !c.deafened && c.callSec >= GC_MIN_CALL_SEC && !c.shownThisCall && !c.store.never;
}

export const GATE_CUT_PROMPT_COPY = {
    title: 'Your voice gate may be cutting you off',
    body: (thr: number) => `parts of your speech are quieter than the gate threshold (${thr} dB).`,
    lower: (s: number) => `Lower to ${s} dB`,
    turnOff: 'Turn off voice gate',
    dismiss: 'Dismiss',
    never: "Don't ask again",
} as const;
