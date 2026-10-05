/**
 * Turning LiveKit end-to-end encryption ON for a Room — and refusing to run a
 * call that claims to be encrypted when it is not.
 *
 * ── Why this file exists (2026-09-08)
 *
 * Passing `encryption: { keyProvider, worker }` in RoomOptions does NOT
 * encrypt anything. In livekit-client 2.18.8 it builds the E2EEManager, spawns
 * the worker and accepts the key — and then every track is still published
 * with `Encryption_Type.NONE`, because `LocalParticipant.encryptionType` is
 * only ever set to GCM inside `setE2EEEnabled(true)`, and the worker's
 * FrameCryptor passes every frame through untouched until it receives an
 * `enable` for the local identity — which the same call is the only thing
 * that sends. Nothing in this app called it, so no call had ever been
 * encrypted: not DM, not group, not the server Calls channels. The existing
 * tests asserted the key reached `setKey()`; nothing asserted an encrypted
 * frame. This module is the activation, plus the checks that would have
 * caught the gap.
 *
 * Verified against a real SFU (docs/livekit-e2ee-activation-rollout.md,
 * "Evidence"): with this activation the publisher's audio frames on the wire
 * authenticate under the room key with an independent AES-GCM decrypt and the
 * server records the publication as GCM; without it the same frames are
 * plaintext Opus and the server records NONE.
 *
 * ── Timing
 *
 * `room.setE2EEEnabled(true)` must run BEFORE the room connects. @livekit/
 * components-react starts publishing the microphone on `SignalConnected`
 * (before `Connected`), so activating from `onConnected` would let the first
 * mic track go out as NONE and force a republish. Called pre-connect, the
 * SDK sets `encryptionType = GCM` immediately (there is nothing to republish
 * yet), and its own `SignalConnected` handler then pushes the enable to the
 * worker once the join response has filled in the local identity. That
 * handler also re-arms the worker on every reconnect, and `encryptionType`
 * is never reset by the SDK, so activation persists for the Room's lifetime.
 *
 * ── The key is async; activation is not
 *
 * `ExternalE2EEKeyProvider.setKey()` is a Promise: it awaits a WebCrypto
 * `importKey` and only THEN puts the key where `getKeys()` can see it (and
 * emits it to the worker). Measured in Chromium 153 and Node 22, a raw HKDF
 * import settles before even the next microtask — but that is an
 * implementation detail of Blink, not the SDK's contract. This module
 * therefore takes the caller's `setKey()` promise (`opts.keyReady`) and makes
 * "the key is installed" an explicit precondition of becoming active, rather
 * than a synchronous snapshot of `getKeys()` that happens to be true because
 * the browser was fast. Activation itself still runs immediately (pre-connect,
 * as above); while the key is in flight the worker's cryptor is enabled but
 * keyless, and the SDK DROPS such frames (`encodeFunction` returns without
 * enqueueing on a missing key) — it never passes them through in plaintext.
 * So waiting for the key AFTER activating is frame-safe; waiting for it
 * BEFORE activating would not be, because a late activation would have to
 * republish a track that had already gone out as NONE.
 *
 * ── Fail closed
 *
 * The call is only allowed to continue once FOUR things are true, and it is
 * torn down (via `onFailure`) if any of them stops being true:
 *
 *   1. `setE2EEEnabled(true)` resolved.
 *   2. The worker acknowledged `enable` for the local identity — observed as
 *      `Room.isE2EEEnabled` flipping true (the SDK sets it only from that
 *      ack). A worker that failed to load would leave `encryptionType = GCM`
 *      on the signalling side while frames flow untransformed — this catches
 *      exactly that, within `ackTimeoutMs` of the signal connecting.
 *   3. The key provider holds a key — either already, at the moment of
 *      activation, or once `opts.keyReady` settles (rejection, or settling
 *      with still no key, is `no_key`; not settling by the ack watchdog is
 *      `no_key` too).
 *   4. Every local publication the server records carries
 *      `Encryption_Type.GCM`. This is the SDK's own publication metadata
 *      (`trackInfo` from the AddTrackResponse), i.e. what the SFU stored.
 *
 * A configured-but-inactive room is the failure mode that shipped; this
 * module's job is to make it impossible to be in that state silently.
 */
import { Encryption_Type, RoomEvent } from 'livekit-client';

export type E2EEActivationFailure =
    /** A key was expected but the Room was built without an `encryption:` block. */
    | { kind: 'not_configured' }
    /** `encryption:` is configured but the key provider holds no key — activating would encrypt to nothing peers have. */
    | { kind: 'no_key' }
    /** `setE2EEEnabled(true)` rejected. */
    | { kind: 'rejected'; error: unknown }
    /** The E2EE worker never acknowledged encryption for the local identity. */
    | { kind: 'ack_timeout'; afterMs: number }
    /** A local track was published without GCM after activation — never expected; treated as a regression. */
    | { kind: 'plaintext_publication'; trackSid: string; source: string };

/** The slice of livekit-client's Room this module needs. Structural so tests drive a fake. */
export interface ActivatableRoom {
    options: { encryption?: unknown };
    isE2EEEnabled: boolean;
    localParticipant: {
        identity: string;
        trackPublications: Map<string, ActivatablePublication>;
    };
    setE2EEEnabled(enabled: boolean): Promise<void>;
    on(event: string, listener: (...args: any[]) => void): unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
    off(event: string, listener: (...args: any[]) => void): unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface ActivatablePublication {
    trackSid: string;
    source: string;
    trackInfo?: { encryption?: number };
}

/** `BaseKeyProvider.getKeys()` — the only thing activation reads off the provider. */
export interface E2EEKeyHolder {
    getKeys(): unknown[];
}

/** What `installE2EEKey` needs: `ExternalE2EEKeyProvider` satisfies it structurally. */
export interface E2EEKeyInstaller extends E2EEKeyHolder {
    setKey(key: ArrayBuffer): Promise<void>;
}

export interface E2EEActivationHandlers {
    onFailure(failure: E2EEActivationFailure): void;
    /** Fired once, when the worker has acknowledged and publications are being checked. */
    onActive?(): void;
}

export interface E2EEActivationOptions {
    /** How long after the signal connects the worker may take to acknowledge. */
    ackTimeoutMs?: number;
    /**
     * The promise from the caller's FIRST `keyProvider.setKey(...)` (see
     * `installE2EEKey`). When given, an empty `getKeys()` at call time is
     * NOT a failure: activation proceeds and the call becomes active only
     * once this has settled with a key present. Omit it only when the key
     * is known to be installed already (tests; a re-run on a live room).
     */
    keyReady?: Promise<unknown>;
}

export const DEFAULT_ACK_TIMEOUT_MS = 10_000;

/**
 * Decode a base64 room key and install it on the provider. Resolves only
 * once `getKeys()` actually reports it — i.e. once the SDK has finished its
 * async derivation and the worker has been sent the key. Rejects on
 * malformed base64 or if the provider still holds nothing afterwards.
 *
 * This is the ONLY place a room key should enter the provider: it returns
 * the promise `activateRoomE2EE` needs as `keyReady`. Rotations go through
 * it too; only the first call's promise gates activation.
 */
export async function installE2EEKey(keyProvider: E2EEKeyInstaller, keyB64: string): Promise<void> {
    const binaryString = atob(keyB64); // throws on malformed input → rejection → no_key
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    await keyProvider.setKey(bytes.buffer as ArrayBuffer);
    if (keyProvider.getKeys().length === 0) {
        throw new Error('E2EE key provider holds no key after setKey() resolved');
    }
}

/**
 * Activate E2EE on `room`. Call as soon as the Room exists and BEFORE it
 * connects (see "Timing" above). Idempotent per Room — calling it on a room
 * that is already active just installs the checks.
 *
 * Returns a dispose function; call it when the Room is discarded. After
 * dispose no handler fires. A `Disconnected` event disposes silently — a call
 * that has ended is not a failure.
 */
export function activateRoomE2EE(
    room: ActivatableRoom,
    keyProvider: E2EEKeyHolder,
    handlers: E2EEActivationHandlers,
    opts: E2EEActivationOptions = {},
): () => void {
    const ackTimeoutMs = opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    let disposed = false;
    let activateResolved = false;
    let acked = false;
    let keyOk = false;
    let active = false;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listeners: Array<[string, (...args: any[]) => void]> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listen = (event: string, listener: (...args: any[]) => void) => {
        listeners.push([event, listener]);
        room.on(event, listener);
    };

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        if (ackTimer !== undefined) clearTimeout(ackTimer);
        for (const [event, listener] of listeners) room.off(event, listener);
        listeners.length = 0;
    };

    const fail = (failure: E2EEActivationFailure) => {
        if (disposed) return;
        dispose();
        handlers.onFailure(failure);
    };

    const isGcm = (pub: ActivatablePublication) => pub.trackInfo?.encryption === Encryption_Type.GCM;

    /** Once the promise, the worker ack AND the key are all in, start policing publications. */
    const maybeBecomeActive = () => {
        if (disposed || active || !activateResolved || !acked || !keyOk) return;
        active = true;
        if (ackTimer !== undefined) { clearTimeout(ackTimer); ackTimer = undefined; }
        // The promise resolved AFTER any republish the SDK had to do, so a
        // NONE publication still standing now is genuine, not in-flight.
        for (const pub of room.localParticipant.trackPublications.values()) {
            if (!isGcm(pub)) { fail({ kind: 'plaintext_publication', trackSid: pub.trackSid, source: pub.source }); return; }
        }
        listen(RoomEvent.LocalTrackPublished, (pub: ActivatablePublication) => {
            if (!isGcm(pub)) fail({ kind: 'plaintext_publication', trackSid: pub.trackSid, source: pub.source });
        });
        handlers.onActive?.();
    };

    const armAckWatchdog = () => {
        if (disposed || acked || ackTimer !== undefined) return;
        ackTimer = setTimeout(() => {
            ackTimer = undefined;
            if (!acked) fail({ kind: 'ack_timeout', afterMs: ackTimeoutMs });
            // The worker answered but the key never landed: the same clock
            // bounds it, so a hung derivation cannot leave the call in limbo.
            else if (!keyOk) fail({ kind: 'no_key' });
        }, ackTimeoutMs);
    };

    // ── Preconditions ──────────────────────────────────────────────────────
    if (!room.options.encryption) { fail({ kind: 'not_configured' }); return dispose; }
    if (opts.keyReady) {
        // The caller is installing the key; require it to have ACTUALLY landed
        // before the call may become active — never trust the promise alone.
        opts.keyReady.then(
            () => {
                if (disposed) return;
                if (keyProvider.getKeys().length === 0) { fail({ kind: 'no_key' }); return; }
                keyOk = true;
                maybeBecomeActive();
            },
            () => fail({ kind: 'no_key' }),
        );
    } else if (keyProvider.getKeys().length === 0) {
        fail({ kind: 'no_key' });
        return dispose;
    } else {
        keyOk = true;
    }

    // ── Listeners go in BEFORE the call so no ack can slip past us ─────────
    listen(RoomEvent.Disconnected, dispose);
    listen(RoomEvent.ParticipantEncryptionStatusChanged, (enabled: boolean, participant?: { isLocal?: boolean }) => {
        if (!participant?.isLocal) return; // remote peers' cryptors are the SDK's business
        if (enabled) { acked = true; maybeBecomeActive(); }
    });
    // The worker can only be told once the identity is known, i.e. after the
    // join response — so the clock for its ack starts at SignalConnected.
    listen(RoomEvent.SignalConnected, armAckWatchdog);
    if (room.localParticipant.identity) armAckWatchdog();
    if (room.isE2EEEnabled) acked = true; // already acknowledged (e.g. a re-run on a live room)

    // ── Activate ───────────────────────────────────────────────────────────
    room.setE2EEEnabled(true).then(
        () => { activateResolved = true; maybeBecomeActive(); },
        (error: unknown) => fail({ kind: 'rejected', error }),
    );

    return dispose;
}

/** User-facing wording for the fail-closed toast. Never blames the user; never offers a plaintext fallback. */
export function describeE2EEActivationFailure(failure: E2EEActivationFailure): string {
    switch (failure.kind) {
        case 'not_configured':
        case 'no_key':
            return "This call couldn't be end-to-end encrypted, so it wasn't connected. Try again in a moment.";
        case 'rejected':
            return "Encryption couldn't be turned on for this call, so it wasn't connected. Try again in a moment.";
        case 'ack_timeout':
            return "Encryption didn't start in time for this call, so it was ended rather than continue unencrypted. Try again.";
        case 'plaintext_publication':
            return 'This call tried to send unencrypted media and was ended. Please report this.';
    }
}
