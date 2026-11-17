/**
 * Push-to-talk, the parts that are plain logic.
 *
 *  - the default key and how a key event maps onto a stored combo (a bare
 *    modifier such as "alt" is a valid push-to-talk key),
 *  - the recorder rule that lets a bare modifier be BOUND (committed when it is
 *    released, so Ctrl+K does not bind "ctrl"),
 *  - the tiny store the call UI reads to show what push-to-talk is doing, and
 *    `pttMicDisplay`, the one place that decides what the self-mic indicator shows.
 *
 * The setting itself (`pushToTalk`, `pushToTalkKey`) lives in useVoiceSettings and
 * is the single source of truth: Settings -> Voice & Video and Settings -> Keybinds
 * both edit it. This module holds no persisted state.
 */

import { useSyncExternalStore } from 'react';

/** Shown while push-to-talk is on but no key is bound: nothing transmits until one is set. */
export const PTT_NO_KEY_HINT = 'Choose a key to use push to talk. Nothing transmits until a key is set.';

const MODIFIER_KEYS = ['control', 'meta', 'alt', 'shift'];

/** Our combo token for a KeyboardEvent.key (ctrl/alt/shift/<key>) - the vocabulary of useKeybinds.eventToCombo. */
export function comboTokenOfKey(key: string): string {
    const k = key.toLowerCase();
    if (k === 'control' || k === 'meta') return 'ctrl';
    if (k === ' ') return 'space';
    return k;
}

/** The combo a KeyboardEvent currently spells (modifiers held + the key, or just the modifiers). Same rule as useKeybinds.eventToCombo. */
export function eventCombo(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string {
    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push('ctrl');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    const k = e.key.toLowerCase();
    if (MODIFIER_KEYS.includes(k)) return parts.join('+');
    parts.push(k === ' ' ? 'space' : k);
    return parts.join('+');
}

/** Key DOWN that puts the push-to-talk combo into the held state (focused-window fallback). */
export function pttPressed(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>, pttKey: string): boolean {
    return eventCombo(e) === pttKey;
}

/**
 * Key UP that ends the held state: the released key is one of the combo's keys.
 * (After a modifier is released its flag is already false, so comparing the
 * event's combo to the stored one cannot work for a bare modifier.)
 */
export function pttReleased(e: Pick<KeyboardEvent, 'key'>, pttKey: string): boolean {
    return pttKey.split('+').includes(comboTokenOfKey(e.key));
}

/**
 * Key recorder that also accepts a bare modifier. A modifier press only ARMS a
 * candidate; it is committed when a modifier is released with nothing else
 * pressed in between. Any other key commits immediately as a normal combo.
 */
export function createComboRecorder(onDone: (combo: string) => void) {
    let pending: string | null = null;
    return {
        keydown(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): void {
            const combo = eventCombo(e);
            if (MODIFIER_KEYS.includes(e.key.toLowerCase())) {
                pending = combo || null;
                return;
            }
            pending = null;
            if (combo) onDone(combo);
        },
        keyup(e: Pick<KeyboardEvent, 'key'>): void {
            if (pending && MODIFIER_KEYS.includes(e.key.toLowerCase())) {
                const c = pending;
                pending = null;
                onDone(c);
            }
        },
    };
}

// ── What the call UI shows ──────────────────────────────────────────────────

export interface PttUiState {
    /** Push-to-talk is on AND has a key: the mic is controlled by the key, not by mute. */
    active: boolean;
    /** The key combination is physically down right now. */
    keyDown: boolean;
    /** The user pressed Mute while in push-to-talk mode: the key does nothing until they unmute. */
    manualMuted: boolean;
    /** A key-recording field is open: the key must not open the mic. */
    recording: boolean;
}

const IDLE: PttUiState = { active: false, keyDown: false, manualMuted: false, recording: false };
let state: PttUiState = IDLE;
const listeners = new Set<() => void>();

export function getPttUiState(): PttUiState { return state; }

export function setPttUiState(patch: Partial<PttUiState>): void {
    const next = { ...state, ...patch };
    if (next.active === state.active && next.keyDown === state.keyDown
        && next.manualMuted === state.manualMuted && next.recording === state.recording) return;
    state = next;
    for (const l of [...listeners]) l();
}

/** Back to nothing (call left / push-to-talk off). */
export function resetPttUiState(): void { setPttUiState({ ...IDLE, recording: state.recording }); }

export function subscribePttUiState(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
}

export function usePttUiState(): PttUiState {
    return useSyncExternalStore(subscribePttUiState, getPttUiState, getPttUiState);
}

/**
 * What the SELF mic indicator shows.
 *  - 'normal': not in push-to-talk, show the real mute state;
 *  - 'muted':  push-to-talk, but the user muted on purpose (red);
 *  - 'idle':   push-to-talk, waiting for the key (neutral grey, never red);
 *  - 'held':   push-to-talk and transmitting (green).
 * `micLive` is whether the mic track is actually publishing.
 */
export type PttMicDisplay = 'normal' | 'muted' | 'idle' | 'held';
export function pttMicDisplay(s: PttUiState, micLive: boolean): PttMicDisplay {
    if (!s.active) return 'normal';
    if (s.manualMuted) return 'muted';
    return s.keyDown && micLive ? 'held' : 'idle';
}

/** Is the self mic to be drawn as muted (red)? In push-to-talk only a deliberate mute is. */
export function selfMicShownMuted(s: PttUiState, micLive: boolean): boolean {
    const d = pttMicDisplay(s, micLive);
    return d === 'normal' ? !micLive : d === 'muted';
}
