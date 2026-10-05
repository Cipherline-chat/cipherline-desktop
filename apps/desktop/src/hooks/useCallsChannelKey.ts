import { useEffect, useRef, useState } from 'react';
import { deriveVoiceChannelKeyFromB64 } from '../utils/voiceChannelKey';

/**
 * Resolves the LiveKit room key for a Calls channel (`kind` 'huddle' or the
 * deprecated 'voice') from that channel's Sender Key.
 *
 * ── Why a hook, and why it gates the connection
 *
 * Server calls used to join LiveKit with an EMPTY e2ee key — i.e. not
 * end-to-end encrypted at all, unlike DM/group calls. This hook is the client
 * half of the fix: it derives `HKDF(senderKey, info="cipherline/voice-key/v1/
 * <channelId>/<epoch>")` (see utils/voiceChannelKey.ts) and hands back a
 * base64 room key that flows into CallPane's EXISTING E2EE path — the same
 * `ExternalE2EEKeyProvider.setKey()` DM calls already use, unchanged.
 *
 * `status` is the load-bearing part. Until it is `'ready'` the caller MUST NOT
 * render CallPane / connect to the room: there is no plaintext fallback, so a
 * client that lacks the current epoch key waits (showing "Waiting for channel
 * keys…") while the ordinary Sender-Key backfill fetches it. Connecting
 * without a key would silently produce an unencrypted call that looks
 * identical to an encrypted one.
 *
 * ── Rotation on a LIVE call
 *
 * The poll keeps running after `'ready'`, so when a rotation lands (a member
 * was removed or demoted, and a remaining holder minted epoch N+1) this hook
 * observes the higher epoch, re-derives, and returns a new `keyB64`. CallPane
 * feeds that to `setKey()` on the SAME key provider, which swaps the
 * publishing key WITHOUT reconnecting — exactly what DM calls already do every
 * 10 minutes. A brief frame loss during the swap is expected and acceptable.
 *
 * Ordering note: we always publish under the HIGHEST epoch we hold, switching
 * the moment it arrives. There is NO cross-epoch key ring to fall back on —
 * CallPane's provider is `sharedKey: true` and `setKey()` overwrites index 0,
 * so frames still in flight under the previous epoch simply fail to decrypt
 * for a moment. Nothing is marked invalid and nobody is disconnected
 * (`failureTolerance: -1`, `ratchetWindowSize: 0`); it is a second or two of
 * dropped frames, not a broken call. That is precisely why a momentary key
 * gap must NOT tear the call down — see utils/callKeyGate.ts.
 */

export type CallsChannelKeyState =
    /** Not a Calls channel (or no channel id yet) — nothing to derive. */
    | { status: 'idle' }
    /** No usable epoch key held yet. DO NOT CONNECT. */
    | { status: 'waiting' }
    /**
     * Derived and ready. `keyB64` is the 32-byte room key, base64.
     *
     * `channelId` is NOT decoration — it is what the key is bound to, and the
     * consumer MUST check it. React state lags its input by one render: on the
     * pass where `channelId` changes (a moderator force-move to a different
     * Calls channel, or hopping calls between channels) this hook still returns
     * the PREVIOUS channel's `ready` state, because the reset to `'waiting'`
     * only lands on the next render. A consumer that reads `status === 'ready'`
     * alone would take channel A's room key into channel B's room for that one
     * commit — long enough for CallPane to mount and start connecting under a
     * key nobody else in the room holds.
     */
    | { status: 'ready'; keyB64: string; epoch: number; channelId: string };

/**
 * How often to re-check for a newer epoch. Cheap: one small IPC call plus one
 * HKDF. Short enough that a rotation reaches a live call promptly.
 */
export const CALLS_KEY_POLL_MS = 2000;

/** The subset of the preload bridge this resolver needs. */
export interface CallsChannelKeySource {
    getLatestChannelEpoch(channelId: string): Promise<number | null>;
    getChannelKey(channelId: string, epoch: number): Promise<string | null>;
}

/**
 * One resolution pass, extracted from the hook so the security-critical
 * decisions — "do we have a usable key?", "did the epoch advance?", "does an
 * error mean waiting?" — are unit-testable without React or Electron IPC.
 * (Same pattern as utils/channelKeyDistribution.ts.)
 *
 * `lastDerivedEpoch` is what the caller already derived for; when the epoch is
 * unchanged this returns `null`, meaning "nothing to do, keep current state".
 *
 * Fails CLOSED: every failure path returns `{ status: 'waiting' }`, never a
 * key and never an "ok, proceed unencrypted".
 */
export async function resolveCallsChannelKey(
    api: CallsChannelKeySource,
    channelId: string,
    lastDerivedEpoch: number | null,
): Promise<CallsChannelKeyState | null> {
    try {
        const epoch = await api.getLatestChannelEpoch(channelId);

        // No epoch held locally yet — the backfill (ChannelKeyRequest) is
        // responsible for fetching one. Keep waiting; never fall back to an
        // unencrypted join.
        if (epoch == null || epoch < 1) return { status: 'waiting' };
        if (lastDerivedEpoch === epoch) return null; // already derived

        const keyB64 = await api.getChannelKey(channelId, epoch);
        if (!keyB64) return { status: 'waiting' };

        const derived = await deriveVoiceChannelKeyFromB64(keyB64, channelId, epoch);
        const bytes = new Uint8Array(derived);
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        return { status: 'ready', keyB64: btoa(bin), epoch, channelId };
    } catch (err) {
        // Fail CLOSED: on any derivation/IPC error we stay in 'waiting', which
        // blocks the connection. An unencrypted call is never an acceptable
        // degraded mode.
        console.error('[CallsChannelKey] derivation failed; staying disconnected', err);
        return { status: 'waiting' };
    }
}

export function useCallsChannelKey(channelId: string | null | undefined): CallsChannelKeyState {
    const [state, setState] = useState<CallsChannelKeyState>({ status: 'idle' });

    // The epoch we last derived for, so a poll that sees no change does no
    // work and — importantly — does not hand CallPane a new string identity
    // that would re-run its setKey effect every 2s.
    const derivedEpochRef = useRef<number | null>(null);

    useEffect(() => {
        if (!channelId) {
            derivedEpochRef.current = null;
            setState({ status: 'idle' });
            return;
        }

        let cancelled = false;
        derivedEpochRef.current = null;
        setState({ status: 'waiting' });

        const check = async () => {
            const api = window.electronAPI;
            if (!api) return;
            const next = await resolveCallsChannelKey(api, channelId, derivedEpochRef.current);
            if (cancelled || next === null) return;

            derivedEpochRef.current = next.status === 'ready' ? next.epoch : null;
            setState(prev =>
                // Keep the SAME object identity while still waiting, so a poll
                // tick doesn't re-render the call tree every 2 seconds.
                prev.status === 'waiting' && next.status === 'waiting' ? prev : next,
            );
        };

        void check();
        const timer = window.setInterval(() => { void check(); }, CALLS_KEY_POLL_MS);
        return () => { cancelled = true; window.clearInterval(timer); };
    }, [channelId]);

    return state;
}
