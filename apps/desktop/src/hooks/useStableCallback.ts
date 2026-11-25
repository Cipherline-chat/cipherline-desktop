import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * A function whose identity never changes but which always runs the LATEST `fn` passed in.
 *
 * For callbacks handed to a library effect that lists them as dependencies, where a new identity means the effect
 * re-runs. The case that made this necessary: `<LiveKitRoom>` (@livekit/components-react 2.9) keeps `onError` in the
 * deps of the effect that calls `room.connect()`, and livekit-client 2.18's `Room.connect()` only short-circuits when
 * the room is `Connected` — not while it is `Reconnecting`. An inline `onError` therefore made every re-render during
 * a LiveKit reconnect start a brand-new connect; when the SFU itself was down (prod LiveKit OOM-killed, 2026-11-24),
 * that connect failed at once with JOIN_FAILURE and tore the call down instead of letting the SDK's own ~40 s
 * reconnect bring it back. See CallPane.tsx.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    const latest = useRef(fn);
    useLayoutEffect(() => { latest.current = fn; });
    return useCallback((...args: A) => latest.current(...args), []);
}
