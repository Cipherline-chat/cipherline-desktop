/**
 * Why a server-channel row could not be shown — and what the UI may honestly
 * say about it.
 *
 * Every channel decrypt failure used to become the same placeholder, "Couldn't
 * decrypt — waiting on this channel's key", and every one of them filed a key
 * request. Most failures are not a missing key, and for those the pill was
 * both wrong and permanent (owner report, 2026-10-09: a "waiting on channel
 * keys" row in the middle of history everyone else reads fine). The causes,
 * with what each now does:
 *
 *  - `key_missing`  — this device holds no key for the row's epoch. The only
 *                     case a key request can fix, so the only one that files
 *                     one. "Waiting on this channel's key".
 *  - `key_mismatch` — it holds a key for that epoch, but not the one the row
 *                     was encrypted with (AES-GCM authentication failed): two
 *                     devices minted different keys for the same epoch. A
 *                     request would fetch the epoch it already has.
 *  - `unverified`   — the sender's signature could not be checked: the sender
 *                     key served is missing (a revoked device) or does not
 *                     match the one pinned for that device. Not a key problem
 *                     at all — and must never be presented as one.
 *  - `history_restricted` — the row is under an OLDER epoch and this member
 *                     lacks Read Message History in the channel: the server
 *                     withholds historical epoch keys from them by design
 *                     (ChannelKeyHandshakesService.requireEpochEntitlement),
 *                     so no key is coming. Say so instead of "waiting".
 *
 * The placeholder shape stays `{ type: 'system', kind: 'encrypted', data }` so
 * every existing heal path (a later successful decrypt of the same id upgrades
 * it in place) keeps working; only `data.reason` is new.
 */

export type ChannelPlaceholderReason = 'key_missing' | 'key_mismatch' | 'unverified' | 'history_restricted';

export interface FailureContext {
    /** The row's epoch. */
    epoch?: number;
    /** The channel's latest epoch as far as this client knows (channel list). */
    latestKnownEpoch?: number;
    /** Whether this member holds READ_MESSAGE_HISTORY in the channel. */
    canReadHistory?: boolean;
}

const msgOf = (err: unknown): string =>
    typeof err === 'string' ? err : (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string')
        ? (err as { message: string }).message : '';

export function classifyChannelDecryptFailure(err: unknown, ctx: FailureContext = {}): ChannelPlaceholderReason {
    const msg = msgOf(err);
    const code = (err && typeof err === 'object') ? (err as { code?: unknown }).code : undefined;
    if (/signature verification failed|sender key mismatch|Invalid JWK|ERR_CRYPTO_INVALID_JWK/i.test(msg) || code === 'ERR_CRYPTO_INVALID_JWK') {
        return 'unverified';
    }
    if (/unable to authenticate data/i.test(msg)) return 'key_mismatch';
    // Everything else — chiefly "[E2EE] Channel key for channel … epoch N not
    // in local store" — is treated as a key we do not hold yet (the
    // historical behaviour, so an unexpected error still self-heals).
    if (ctx.canReadHistory === false
        && typeof ctx.epoch === 'number' && typeof ctx.latestKnownEpoch === 'number'
        && ctx.epoch < ctx.latestKnownEpoch) {
        return 'history_restricted';
    }
    return 'key_missing';
}

export function channelPlaceholderContent(reason: ChannelPlaceholderReason, epoch?: number) {
    return { type: 'system', kind: 'encrypted', data: typeof epoch === 'number' ? { reason, epoch } : { reason } };
}

/** The reason on a cached placeholder; a legacy one (no reason) was always a key wait. */
export function placeholderReason(m: { content?: unknown } | null | undefined): ChannelPlaceholderReason | null {
    const c = m?.content as { type?: string; kind?: string; data?: { reason?: unknown } } | undefined;
    if (c?.type !== 'system' || c?.kind !== 'encrypted') return null;
    const r = c.data?.reason;
    return r === 'key_mismatch' || r === 'unverified' || r === 'history_restricted' ? r : 'key_missing';
}

/** Only a genuinely missing key justifies asking other members for one. */
export const placeholderWantsKey = (m: { content?: unknown } | null | undefined): boolean =>
    placeholderReason(m) === 'key_missing';

/** Re-trying by id can help every reason except a withheld-by-permission key. */
export const placeholderRetryable = (m: { content?: unknown } | null | undefined): boolean => {
    const r = placeholderReason(m);
    return r !== null && r !== 'history_restricted';
};

export function placeholderLabel(reason: ChannelPlaceholderReason | null): string {
    switch (reason) {
        case 'key_mismatch': return 'Couldn’t decrypt — sent with a different key for this channel';
        case 'unverified': return 'Couldn’t verify who sent this message';
        case 'history_restricted': return 'Sent with an earlier channel key — you can’t read this channel’s history';
        default: return 'Couldn’t decrypt — waiting on this channel’s key';
    }
}

/**
 * A deleted message as the API serves it: ciphertext cleared, `deleted: true`
 * (apps/api ChannelMessagesService.postMessage, the delete tombstone). It is
 * removed from the thread without any decrypt — no key needed, ever.
 */
export function isChannelTombstone(raw: { deleted?: unknown; nonce_b64?: unknown; ciphertext_b64?: unknown }): boolean {
    return raw.deleted === true || (raw.nonce_b64 === '' && raw.ciphertext_b64 === '');
}
