/**
 * Per-participant call-scoped state, shared across all tiles that render the
 * same participant.
 *
 * Why this exists: VideoTile, ScreenShareGate, and ParticipantCard each
 * call hooks like useState for things like isScreenShareMuted. When the
 * same participant appears in TWO tiles simultaneously (e.g. focused +
 * sidebar thumbnail in fullscreen view), each tile maintains its own copy
 * of the state. Toggling "Mute Stream" on one tile updates that tile's
 * local state but the audio chain (set up in useParticipantAudio, which
 * is deduped to one tile per participant via a module-level claim Set)
 * may have been instantiated by the OTHER tile and continues reading
 * from ITS state — which never changed. Net effect: the user clicks
 * Mute and nothing happens. This shared store gives every tile the same
 * source of truth.
 *
 * Lifetime: in-memory only, intentionally NOT persisted. These flags
 * (mute, NS toggle, hide-video, screenShareSubscribed) make sense
 * per-call; they're reset when the call ends and the renderer reloads.
 *
 * Pattern is intentionally minimal: a Map of subscribers per (identity, key)
 * pair, a useSyncExternalStore-driven hook to read+set values. No context
 * needed, no provider wrapping required.
 */
import { useCallback, useSyncExternalStore } from 'react';

type ListenerSet = Set<() => void>;
const stateMap = new Map<string, unknown>();
const listenerMap = new Map<string, ListenerSet>();

function key(identity: string, name: string): string {
    return `${identity}::${name}`;
}

function subscribe(k: string, listener: () => void): () => void {
    let set = listenerMap.get(k);
    if (!set) { set = new Set(); listenerMap.set(k, set); }
    set.add(listener);
    return () => {
        const s = listenerMap.get(k);
        if (s) {
            s.delete(listener);
            if (s.size === 0) listenerMap.delete(k);
        }
    };
}

function notify(k: string): void {
    const set = listenerMap.get(k);
    if (!set) return;
    for (const fn of set) fn();
}

/**
 * useParticipantSharedState — like useState, but the value is keyed on
 * (participant identity, name) and shared across every component that
 * uses the same key. Setting from any caller updates every reader.
 */
export function useParticipantSharedState<T>(
    identity: string,
    name: string,
    initial: T,
): [T, (next: T | ((prev: T) => T)) => void] {
    const k = key(identity, name);
    const value = useSyncExternalStore(
        useCallback((cb) => subscribe(k, cb), [k]),
        () => (stateMap.has(k) ? (stateMap.get(k) as T) : initial),
        () => initial, // SSR fallback (not used in Electron renderer)
    );
    const setValue = useCallback((next: T | ((prev: T) => T)) => {
        const prev = stateMap.has(k) ? (stateMap.get(k) as T) : initial;
        const computed = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        if (computed === prev) return;
        stateMap.set(k, computed);
        notify(k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [k]);
    return [value, setValue];
}

/**
 * Wipe all state for a given identity. Call when the participant fully
 * leaves the call so we don't carry stale flags into a future re-join.
 */
export function clearParticipantSharedState(identity: string): void {
    const prefix = `${identity}::`;
    const toDelete: string[] = [];
    for (const k of stateMap.keys()) {
        if (k.startsWith(prefix)) toDelete.push(k);
    }
    for (const k of toDelete) {
        stateMap.delete(k);
        notify(k);
    }
}
