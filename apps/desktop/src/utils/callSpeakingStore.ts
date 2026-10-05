import { useCallback, useSyncExternalStore } from 'react';

/**
 * Who is speaking in the current call, per identity, for UI OUTSIDE the
 * LiveKit tree (the server panel's voice/Calls rosters, the floating huddle
 * card) — written by SidebarConference from the fast analyser signal
 * (subscribeFastSpeaking: analyser OR LiveKit isSpeaking).
 *
 * This used to ride in CallContext's telemetry snapshot (participantTrackStates
 * [id].isSpeaking). Speaking flips several times a second per talking person,
 * so every flip replaced that snapshot and re-rendered every telemetry
 * subscriber in full — ServerContextPanel (channels, Calls cards and the whole
 * member list) and every roster row — just to move one green ring. Here each
 * ring subscribes to ONE identity (useSyncExternalStore), so a flip re-renders
 * exactly the rings for that person and nothing else; the telemetry snapshot
 * now changes only on mute / camera / share / moderation changes.
 */
const speaking = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

function notify(id: string): void {
    listeners.get(id)?.forEach(l => l());
}

export function setCallParticipantSpeaking(id: string, value: boolean): void {
    if (speaking.has(id) === value) return;
    if (value) speaking.add(id); else speaking.delete(id);
    notify(id);
}

/** Everyone stops speaking (call ended / roster rebuilt). */
export function clearCallSpeaking(): void {
    const ids = [...speaking];
    speaking.clear();
    ids.forEach(notify);
}

export function isCallParticipantSpeaking(id: string): boolean {
    return speaking.has(id);
}

export function subscribeCallParticipantSpeaking(id: string, l: () => void): () => void {
    let set = listeners.get(id);
    if (!set) { set = new Set(); listeners.set(id, set); }
    set.add(l);
    return () => {
        const s = listeners.get(id);
        if (!s) return;
        s.delete(l);
        if (s.size === 0) listeners.delete(id);
    };
}

/** Re-renders the caller only when THIS identity starts/stops speaking. */
export function useIsCallParticipantSpeaking(id: string): boolean {
    const sub = useCallback((l: () => void) => subscribeCallParticipantSpeaking(id, l), [id]);
    return useSyncExternalStore(sub, () => speaking.has(id), () => false);
}

/** Test hook. */
export function __callSpeakingListenerCount(): number {
    let n = 0;
    listeners.forEach(s => { n += s.size; });
    return n;
}
