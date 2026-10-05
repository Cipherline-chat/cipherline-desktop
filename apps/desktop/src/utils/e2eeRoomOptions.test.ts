import { describe, it, expect } from 'vitest';
import { ExternalE2EEKeyProvider, KeyProviderEvent } from 'livekit-client';
import type { RoomOptions } from 'livekit-client';
import { stableE2EEOptions, E2EE_OPTIONS_JSON } from './e2eeRoomOptions';

/**
 * These tests pin the invariant that keeps `<LiveKitRoom>` from rebuilding the
 * Room forever — the 2026-09-05 "DM/group calls fail to connect" regression.
 *
 * `useLiveKitRoom` builds a new Room whenever
 * `JSON.stringify(options, roomOptionsStringifyReplacer)` changes, and
 * disconnects the previous one. So a room-options object that does not
 * serialize to a STABLE string is a permanent connect/teardown loop.
 */

/**
 * A verbatim copy of @livekit/components-react's own replacer
 * (dist/room-*.mjs, `roomOptionsStringifyReplacer`) as of 2.9.x. It is not
 * exported from the package, so it is reproduced here.
 *
 * Note what it does NOT do: it special-cases the key NAMES `processor` and
 * `e2ee` only. Nothing about `encryption`. That omission is the whole bug —
 * which is why the important assertions below also run with NO replacer at
 * all: our options must be self-stabilising rather than relying on the
 * library recognising a key name.
 */
function roomOptionsStringifyReplacer(key: string, val: unknown): unknown {
    if (key === 'processor' && val && typeof val === 'object' && 'name' in val) {
        return (val as { name: unknown }).name;
    }
    if (key === 'e2ee' && val) return 'e2ee-enabled';
    return val;
}

/**
 * Stands in for livekit-client's real worker. `new Worker()` needs a browser
 * worker environment jsdom does not provide, and the worker's identity is
 * irrelevant here — only whether the options serialize stably.
 */
class FakeWorker {
    addEventListener() { /* no-op */ }
    postMessage() { /* no-op */ }
    terminate() { /* no-op */ }
}

/**
 * Reproduces what constructing a `Room` with E2EE does to the key provider:
 * livekit-client's `E2EEManager.setup()` registers two listeners on it
 * (`keyProvider.on(SetKey, ...).on(RatchetRequest, ...)`). That is what
 * mutates the provider's own enumerable `_events` / `_eventsCount` — the
 * bookkeeping `JSON.stringify` was picking up.
 *
 * Calling this directly rather than `new Room(...)` because Room construction
 * needs real browser E2EE support (insertable streams) and throws under jsdom.
 */
function simulateRoomConstruction(keyProvider: ExternalE2EEKeyProvider): void {
    keyProvider.on(KeyProviderEvent.SetKey, () => { /* no-op */ });
    keyProvider.on(KeyProviderEvent.RatchetRequest, () => { /* no-op */ });
}

function buildRoomOptions(keyProvider: ExternalE2EEKeyProvider): RoomOptions {
    return {
        adaptiveStream: true,
        dynacast: true,
        encryption: stableE2EEOptions(keyProvider, new FakeWorker() as unknown as Worker),
    };
}

describe('stableE2EEOptions', () => {
    it('keeps room options byte-identical as the key provider gains listeners', () => {
        const keyProvider = new ExternalE2EEKeyProvider();
        const options = buildRoomOptions(keyProvider);

        const initial = JSON.stringify(options);
        // Three rounds: the regression needed two to show BOTH failure shapes
        // (_eventsCount incrementing, then _events growing arrays of listeners).
        for (let i = 0; i < 3; i++) {
            simulateRoomConstruction(keyProvider);
            expect(JSON.stringify(options)).toBe(initial);
        }
    });

    it("is stable under the wrapper's own options replacer", () => {
        const keyProvider = new ExternalE2EEKeyProvider();
        const options = buildRoomOptions(keyProvider);

        const initial = JSON.stringify(options, roomOptionsStringifyReplacer);
        for (let i = 0; i < 3; i++) {
            simulateRoomConstruction(keyProvider);
            expect(JSON.stringify(options, roomOptionsStringifyReplacer)).toBe(initial);
        }
    });

    it('does not leak the live key provider into the serialized options', () => {
        const keyProvider = new ExternalE2EEKeyProvider();
        const json = JSON.stringify(buildRoomOptions(keyProvider));

        expect(json).toContain(E2EE_OPTIONS_JSON);
        // The provider's EventEmitter bookkeeping is exactly what used to make
        // the string move; none of it may appear.
        expect(json).not.toContain('_events');
        expect(json).not.toContain('keyInfoMap');
    });

    it('still hands livekit-client the key provider and worker it needs', () => {
        const keyProvider = new ExternalE2EEKeyProvider();
        const worker = new FakeWorker() as unknown as Worker;
        const options = stableE2EEOptions(keyProvider, worker);

        expect(options.keyProvider).toBe(keyProvider);
        expect(options.worker).toBe(worker);
        // Nothing above this line may be dropped by the stabiliser.
        // The stabiliser must be invisible to anything that enumerates the
        // options — spreads, Object.keys, structuredClone-style copies.
        expect(Object.keys(options).sort()).toEqual(['keyProvider', 'worker']);
    });

    it('serializes identically across separately built options objects', () => {
        // Two mounts of CallPane build two providers and two workers; the
        // options they produce must still hash the same, or remounting would
        // itself churn the Room.
        const a = JSON.stringify(buildRoomOptions(new ExternalE2EEKeyProvider()));
        const b = JSON.stringify(buildRoomOptions(new ExternalE2EEKeyProvider()));
        expect(a).toBe(b);
    });
});
