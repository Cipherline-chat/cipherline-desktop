/**
 * Classify a decrypt failure as retryable or not.
 *
 * Before this, EVERY decrypt failure — permanent or not — was treated the
 * same way: never acked, so the server kept the envelope and the client
 * re-fetched and re-failed on it every poll cycle (5s for DMs, on every
 * pullChannelKeys trigger for channel keys) forever, until the 30-day
 * server-side sweep. A message that will NEVER decrypt (no recipient entry
 * for this device, a replay, a broken signature) needs to be acked away
 * immediately — retrying changes nothing. A message that MIGHT decrypt next
 * time (a transient IPC/network hiccup, the secure store still unlocking)
 * should be retried a bounded number of times before giving up.
 *
 * Classification is driven by the `[E2EE:CODE]` prefix electron/e2ee-engine.ts
 * attaches to every throw (see that file for the authoritative list) — must
 * handle the prefix surviving Electron's IPC error-wrapping, which prepends
 * something like `Error invoking remote method 'crypto:decrypt-message':`.
 */

export type DecryptFailureClass = 'permanent' | 'transient';

const PERMANENT_CODES = new Set([
    'NO_RECIPIENT_ENTRY',  // envelope was never wrapped for this device (RC-2, fixed at the source in Phase 2 — but old/foreign envelopes can still exist)
    'REPLAY',              // duplicate ephemeral key — a genuine retry can never resolve this
    'WRAP_AUTH_FAILED',    // exhausted every retained SPK (decryptEnvelope already tried them all — see e2ee-engine.ts) — no key we hold will ever unwrap this
    'CONTENT_AUTH_FAILED', // GCM auth failure on the content itself — corruption or tampering, not timing
    'SIG_INVALID',         // missing/invalid Ed25519 signature — never resolves by waiting
]);

/** `decryptEnvelope` throws the bare string 'LEGACY' (not an [E2EE:...]-prefixed
 *  Error) for pre-v3 envelopes — callers already special-case this exact
 *  string, so it's classified separately rather than folded into the code set. */
export function isLegacyEnvelope(message: string): boolean {
    return message === 'LEGACY' || message.endsWith(': LEGACY');
}

export function extractE2eeCode(message: string): string | null {
    const m = /\[E2EE:([A-Z_]+)\]/.exec(message);
    return m ? m[1] : null;
}

export function classifyDecryptFailure(error: unknown): DecryptFailureClass {
    const message = error instanceof Error ? error.message : String(error);
    if (isLegacyEnvelope(message)) return 'permanent';
    const code = extractE2eeCode(message);
    if (code && PERMANENT_CODES.has(code)) return 'permanent';
    // NO_SPK (secure store still unlocking / mid-rotation) and anything
    // without a recognized code (network error, IPC unavailable, a bug we
    // haven't named yet) are treated as transient — bounded retry, not an
    // immediate ack, so we don't silently destroy a message over a blip.
    return 'transient';
}
