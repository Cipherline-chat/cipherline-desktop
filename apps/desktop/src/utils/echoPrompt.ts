/**
 * When the in-call "Echo detected" prompt may appear, and how the user's
 * answers are remembered.
 *
 * The rules (owner decision, 2026-11-16):
 *   - never when echo cancellation is already on;
 *   - never while the mic is closed (muted, or push-to-talk with the key up) or
 *     while deafened - the user is not transmitting, or cannot hear, so there is
 *     nothing to fix right now;
 *   - Dismiss silences it for the rest of THAT call;
 *   - after two dismissals (across calls) the prompt also offers "Don't ask
 *     again", which switches it off for good;
 *   - [Turn on] is an explicit choice of echo cancellation (stops the Auto
 *     default, see useVoiceSettings.setEchoCancellation).
 *
 * The remembered part (`cipherline_echo_prompt_v1`) is two small scalars in the
 * encrypted store: how many times the prompt was dismissed and whether the user
 * said never. Per device, not backed up (backupRegistry.ts classifies the key).
 */
import secureLocalStore from './secureLocalStore';

export const ECHO_PROMPT_STORAGE_KEY = 'cipherline_echo_prompt_v1';
/** Dismissals after which "Don't ask again" is offered. */
export const DONT_ASK_AFTER = 2;

export interface EchoPromptStore { dismissals: number; never: boolean }

export const EMPTY_ECHO_PROMPT_STORE: Readonly<EchoPromptStore> = { dismissals: 0, never: false };

export function parseEchoPromptStore(raw: string | null | undefined): EchoPromptStore {
    if (!raw) return { ...EMPTY_ECHO_PROMPT_STORE };
    try {
        const v = JSON.parse(raw) as { dismissals?: unknown; never?: unknown };
        const d = typeof v?.dismissals === 'number' && Number.isFinite(v.dismissals) ? Math.max(0, Math.min(1000, Math.floor(v.dismissals))) : 0;
        return { dismissals: d, never: v?.never === true };
    } catch {
        return { ...EMPTY_ECHO_PROMPT_STORE };
    }
}

export function loadEchoPromptStore(): EchoPromptStore {
    try { return parseEchoPromptStore(secureLocalStore.getItem(ECHO_PROMPT_STORAGE_KEY)); } catch { return { ...EMPTY_ECHO_PROMPT_STORE }; }
}

export function saveEchoPromptStore(s: EchoPromptStore): void {
    try { secureLocalStore.setItem(ECHO_PROMPT_STORAGE_KEY, JSON.stringify(s)); } catch { /* best-effort preference */ }
}

export const afterDismiss = (s: EchoPromptStore): EchoPromptStore => ({ ...s, dismissals: s.dismissals + 1 });
export const afterNever = (s: EchoPromptStore): EchoPromptStore => ({ ...s, never: true });
export const offerDontAskAgain = (s: EchoPromptStore): boolean => s.dismissals >= DONT_ASK_AFTER;

export interface PromptContext {
    /** Effective echo cancellation right now. */
    aecOn: boolean;
    /** The mic is open: not muted and, in push-to-talk, the key is held. */
    micOpen: boolean;
    deafened: boolean;
    /** Dismissed already in this call. */
    dismissedThisCall: boolean;
    store: EchoPromptStore;
}

/** May the detector run at all (and may a detection be shown)? */
export function mayPromptForEcho(c: PromptContext): boolean {
    return !c.aecOn && c.micOpen && !c.deafened && !c.dismissedThisCall && !c.store.never;
}

export const ECHO_PROMPT_COPY = {
    title: 'Echo detected',
    body: 'people may hear themselves. Turn on echo cancellation?',
    turnOn: 'Turn on',
    dismiss: 'Dismiss',
    never: "Don't ask again",
} as const;
