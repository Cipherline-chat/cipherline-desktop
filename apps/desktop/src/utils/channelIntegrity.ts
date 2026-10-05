/**
 * G4 — renderer half of the channel-message integrity checks.
 *
 * The main-process engine (`electron/e2ee-engine.ts` → `decryptChannelMessage`)
 * refuses a channel row the SERVER served wrongly:
 *
 *   [E2EE:CHANNEL_REPLAY]    — this exact ciphertext was already accepted under
 *                              a different server message id (a re-post).
 *   [E2EE:CHANNEL_BINDING]   — the sender-signed binding says the message
 *                              belongs to a different channel / epoch / sender
 *                              than the row it arrived in.
 *   [E2EE:CHANNEL_MALFORMED] — a nonce or ciphertext no client ever writes.
 *
 * None of these is "we lack the key", so they must NOT take the undecryptable
 * path: that path renders a "waiting on this channel's key" placeholder and
 * files a key request with every other member, which would turn a hostile
 * server's re-post into a permanent pill plus a key-request loop. Such rows are
 * dropped instead. (Deliberately not imported from electron/ — see the
 * rootDir note in CLAUDE.md; only the error TEXT crosses the bridge.)
 */

const SERVE_REJECTION_TAGS = [
    '[E2EE:CHANNEL_REPLAY]',
    '[E2EE:CHANNEL_BINDING]',
    '[E2EE:CHANNEL_MALFORMED]',
] as const;

/** True when a decrypt error means "drop this row", not "we lack the key".
 *  Matches on the tag anywhere in the message because `ipcRenderer.invoke`
 *  wraps it: "Error invoking remote method '…': Error: [E2EE:…] …". */
export function isChannelServeRejection(err: unknown): boolean {
    const msg = typeof err === 'string'
        ? err
        : (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string')
            ? (err as { message: string }).message
            : '';
    return SERVE_REJECTION_TAGS.some(tag => msg.includes(tag));
}

/**
 * Order channel rows oldest-first before decrypting them.
 *
 * `GET /v1/channels/:id/messages` returns newest-first, and the engine admits
 * the FIRST copy of a ciphertext it sees and refuses later ones. On a device
 * that has never seen a message, decrypting newest-first would let a re-post
 * (newer `created_at`) claim the ledger slot and push the genuine original out
 * as the "replay". Oldest-first keeps the original. Non-mutating and stable;
 * rows with an unparseable timestamp keep their relative order at the end.
 */
export function oldestFirst<T extends { created_at: string }>(rows: readonly T[]): T[] {
    const t = (r: T) => {
        const ms = new Date(r.created_at).getTime();
        return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
    };
    return rows
        .map((r, i) => ({ r, i, ms: t(r) }))
        .sort((a, b) => (a.ms === b.ms ? a.i - b.i : a.ms < b.ms ? -1 : 1))
        .map(x => x.r);
}
