import type { BaseKeyProvider, E2EEManagerOptions } from 'livekit-client';

/**
 * The literal the E2EE options subtree collapses to when a room-options object
 * is JSON-stringified. Value is arbitrary; only its STABILITY matters. It
 * deliberately matches the string @livekit/components-react's own replacer
 * substitutes for a legacy `e2ee:` block, so the dep string is unchanged from
 * the pre-`encryption:` era.
 */
export const E2EE_OPTIONS_JSON = 'e2ee-enabled';

/**
 * Build the `encryption:` block for a LiveKit `RoomOptions`, with a stable
 * JSON identity.
 *
 * ── Why this exists (regression 2026-09-05: "DM/group calls fail to connect")
 *
 * `@livekit/components-react`'s `useLiveKitRoom` — what `<LiveKitRoom>` runs —
 * decides when to build a NEW `Room` by stringifying the options object:
 *
 *     useEffect(() => { setRoom(passedRoom ?? new Room(options)) },
 *               [passedRoom, JSON.stringify(options, roomOptionsStringifyReplacer)])
 *
 * and its sibling cleanup disconnects the outgoing room. So the serialized
 * options are effectively the Room's cache key, and it MUST converge.
 *
 * That replacer special-cases exactly two key NAMES — `processor` and `e2ee`:
 *
 *     if (key === 'processor' && ...) return val.name;
 *     if (key === 'e2ee' && val)      return 'e2ee-enabled';
 *
 * Under the legacy `e2ee:` key the whole subtree therefore collapsed to a
 * constant. When we moved to `encryption:` (c801fe10, to turn on data-channel
 * encryption, which livekit-client gates on `!!options.encryption`) the
 * replacer stopped matching, so `JSON.stringify` began walking INTO the live
 * `ExternalE2EEKeyProvider` — an EventEmitter whose own enumerable
 * `_events` / `_eventsCount` mutate every time a Room attaches its E2EE
 * listeners (livekit-client `E2EEManager.setup()` →
 * `keyProvider.on(SetKey, ...).on(RatchetRequest, ...)`).
 *
 * Result: constructing a Room changed the very string that decides whether to
 * construct a Room. The dep never converged, so every render built a fresh
 * Room and tore down the one still negotiating — every call with an E2EE key
 * (i.e. every DM and group call) hung and then reported a connect failure.
 *
 * The fix is to give the block its own `toJSON`, so it serializes to a
 * constant no matter what replacer the wrapper happens to use — the same
 * guarantee the `e2ee:` key used to get from the library, but ours, and not
 * dependent on a key name the library special-cases. `toJSON` is defined
 * non-enumerably so it stays out of spreads, `Object.keys`, and anything else
 * that enumerates the options; `JSON.stringify` finds it regardless.
 *
 * The invariant this protects is asserted in e2eeRoomOptions.test.ts: the
 * serialization must be byte-identical before and after the key provider
 * gains listeners.
 */
export function stableE2EEOptions(keyProvider: BaseKeyProvider, worker: Worker): E2EEManagerOptions {
    const options: E2EEManagerOptions = { keyProvider, worker };
    Object.defineProperty(options, 'toJSON', {
        value: () => E2EE_OPTIONS_JSON,
        enumerable: false,
        writable: false,
        configurable: false,
    });
    return options;
}
