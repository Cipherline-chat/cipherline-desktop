import { useEffect, useRef } from 'react';
import { useRoomContext } from '@livekit/components-react';
import type { ExternalE2EEKeyProvider } from 'livekit-client';
import { activateRoomE2EE, installE2EEKey, type E2EEActivationFailure } from '../utils/e2eeActivation';

/**
 * Installs the room key on the provider and turns the Room's configured E2EE
 * ON. Must live inside <LiveKitRoom> for useRoomContext, and must be the
 * FIRST thing that runs against a new Room.
 *
 * Why a child and not `onConnected`: @livekit/components-react creates the
 * Room in an effect and only then renders its children, so this effect runs
 * in the commit where the Room first exists — and React runs children's
 * effects before the parent's, i.e. BEFORE useLiveKitRoom's own effect calls
 * `room.connect()`. That ordering is what makes the very first mic track go
 * out as GCM: the wrapper starts publishing on `SignalConnected`, which is
 * before `Connected`, so an `onConnected` hook would be too late and the SDK
 * would have to unpublish/republish (a brief plaintext window plus a
 * renegotiation). See utils/e2eeActivation.ts for the whole story, and
 * docs/livekit-e2ee-activation-rollout.md for the proof it works.
 *
 * Why this component owns `setKey()` too (2026-09-08): the provider's
 * `setKey()` is async (it awaits a WebCrypto import before `getKeys()` can
 * see the key), and activation's "is there a key?" precondition used to be a
 * synchronous snapshot taken by a DIFFERENT effect in a different component.
 * That worked only because Blink settles a raw-key import within a microtask
 * — faster than React's own two-task pipeline for the commit that mounts
 * this component — and would have failed closed (`no_key`, call ended) the
 * moment it did not. Keeping both steps here, with the install effect
 * declared before the activation effect (React runs a component's effects in
 * declaration order within a commit) and the install PROMISE handed to
 * activation as `keyReady`, makes the ordering a contract instead of a
 * timing coincidence — without moving activation past `connect()`.
 *
 * Key rotation (a new `keyB64` on a live call) re-runs ONLY the install
 * effect: the provider gets the new key, the worker is told, and activation
 * — keyed on the Room alone — is untouched.
 *
 * A keyless mount (`keyB64 === ''`) is a knowingly-unencrypted call (today:
 * a DM/group join that raced its `call_key`; Calls channels are gated
 * upstream and never mount keyless) — it is logged, not failed, because
 * failing it would be a behaviour change this activation has no mandate for.
 * The rollout doc tracks closing that gap.
 */
export const E2EEActivator = ({ keyProvider, keyB64, onFailure, onActive }: {
    keyProvider: ExternalE2EEKeyProvider;
    /** The room key, base64; '' for a keyless (unencrypted) mount. Mirrors the gate that built the `encryption:` block. */
    keyB64: string;
    onFailure: (failure: E2EEActivationFailure) => void;
    /** Test/observability hook; CallPane leaves it unset and relies on the console line. */
    onActive?: () => void;
}) => {
    const room = useRoomContext();
    const expectEncrypted = !!keyB64;
    // Latest-value refs so a re-render of CallPane (which recreates the inline
    // callbacks) never re-runs the activation effect — that is keyed on the
    // Room alone, exactly once per Room.
    const onFailureRef = useRef(onFailure);
    const onActiveRef = useRef(onActive);
    useEffect(() => { onFailureRef.current = onFailure; onActiveRef.current = onActive; });

    // ── 1. Key install — the first key and every rotation ─────────────────
    // Declared BEFORE the activation effect on purpose: within one commit
    // React runs a component's effects in declaration order, so by the time
    // activation reads `firstKeyRef` the install has been started.
    const firstKeyRef = useRef<Promise<void> | null>(null);
    useEffect(() => {
        if (!keyB64) return;
        const install = installE2EEKey(keyProvider, keyB64);
        if (firstKeyRef.current === null) {
            // Its outcome is reported through activation (`no_key`); this
            // handler only stops it surfacing as an unhandled rejection.
            firstKeyRef.current = install;
            install.catch(() => {});
        } else {
            install.catch((err) => console.error('[CallPane] E2EE key rotation failed to install — the previous key stays in force:', err));
        }
    }, [keyB64, keyProvider]);

    // ── 2. Activation — once per Room ─────────────────────────────────────
    useEffect(() => {
        if (!expectEncrypted) {
            console.warn('[CallPane] this call has no room key — media is NOT end-to-end encrypted');
            return;
        }
        const keyReady = firstKeyRef.current;
        if (!keyReady) {
            // Unreachable by construction (effect 1 ran first) — but if it ever
            // were, the honest answer is the same as a missing key.
            onFailureRef.current({ kind: 'no_key' });
            return;
        }
        return activateRoomE2EE(room, keyProvider, {
            onFailure: (failure) => onFailureRef.current(failure),
            onActive: () => {
                console.log('[CallPane] E2EE active: worker acknowledged; every local publication is checked for GCM');
                onActiveRef.current?.();
            },
        }, { keyReady });
    }, [room, keyProvider, expectEncrypted]);
    return null;
};
