/**
 * Push-to-talk, the parts that are plain logic.
 *
 *  - the no-key hint,
 *  - the tiny store the call UI reads to show what push-to-talk is doing, and
 *    `pttMicDisplay`, the one place that decides what the self-mic indicator shows.
 *
 * The setting itself (`pushToTalk`, `pushToTalkKey`) lives in useVoiceSettings and
 * is the single source of truth: Settings -> Voice & Video and Settings -> Keybinds
 * both edit it. This module holds no persisted state. Recording a key and
 * matching it (physical keys, mouse buttons, bare modifiers) is utils/holdKeys.ts.
 */

import { useSyncExternalStore } from 'react';

/** Shown while push-to-talk is on but no key is bound: nothing transmits until one is set. */
export const PTT_NO_KEY_HINT = 'Choose a key to use push to talk. Nothing transmits until a key is set.';

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
