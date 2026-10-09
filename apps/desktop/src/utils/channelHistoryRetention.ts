import type { StoragePolicy } from '../hooks/useRetentionPolicy';
import { sweepRetention } from './retentionSweeper';
import { isUndecryptablePlaceholder, type ChannelRow } from './channelHistoryMerge';
import { placeholderWantsKey } from './channelDecryptFailure';

/**
 * Retention applied at the DOOR of a server channel's cache.
 *
 * A channel's `channel_messages` rows outlive the local cache (the server keeps
 * them 30 days; a server-saved row for good), and `GET /channels/:id/messages`
 * hands back whatever is left — including rows OLDER than this device's "Keep
 * for" window that the cache never held, so the local retention ledger
 * (retentionTombstones.ts) has no entry for them. That is every row a
 * newly-added device, a server you just joined, or "Load older history" pulls
 * in, and with a short window it is most of what the server returns.
 *
 * Folding those in and leaving the 5-minute sweep to delete them afterwards
 * meant, for up to five minutes, that:
 *   - rows flashed into the thread and vanished again,
 *   - every row whose epoch key had aged out of the key store was a
 *     "Couldn't decrypt — waiting on this channel's key" pill, and
 *   - the pills made the catch-up fetch file a key request, and arm the
 *     retry timer, for messages the user's own policy was about to delete —
 *     which is how a retention deletion ended up putting the channel in a
 *     "waiting on channel keys" state.
 *
 * So the same decision the sweep makes is applied to the incoming page first.
 * It IS the sweep's decision — `sweepRetention` itself, same pinned / saved /
 * unsaved-grace rules — so the two can never disagree about a row.
 */

export interface IncomingRetention {
    /** The chat's effective policy (retentionResolve.sweepPolicyFor). */
    policy: StoragePolicy;
    /** Ids exempt from expiry: local pins ∪ server-saved. */
    pinned: ReadonlySet<string>;
    now: number;
}

/**
 * Split a freshly-decrypted page into rows to keep and rows already past their
 * retention window. Pure. Action rows (edit / delete / reaction) are always
 * kept — they act on other rows and are folded away, never displayed.
 *
 * Pass `retention = null` to keep everything: when this device hasn't chosen a
 * policy yet, or the pinned set isn't known, dropping would be a guess. The
 * 5-minute sweep still runs once both are known.
 */
export function splitExpiredIncoming<T extends ChannelRow>(
    rows: readonly T[],
    retention: IncomingRetention | null,
): { kept: T[]; expired: T[] } {
    if (!retention || rows.length === 0) return { kept: [...rows], expired: [] };
    const KEY = 'page';
    const { prunedState, purgedMessageIds } = sweepRetention(
        { [KEY]: [...rows] },
        retention.policy,
        retention.now,
        { [KEY]: new Set(retention.pinned) },
    );
    const droppedIds = new Set(purgedMessageIds[KEY] ?? []);
    if (droppedIds.size === 0 && prunedState[KEY].length === rows.length) {
        return { kept: [...rows], expired: [] };
    }
    const keptSet = new Set<unknown>(prunedState[KEY]);
    const kept: T[] = [];
    const expired: T[] = [];
    for (const r of rows) (keptSet.has(r) ? kept : expired).push(r);
    return { kept, expired };
}

/**
 * Does this page contain a message that SHOULD be readable but isn't — a
 * "couldn't decrypt" placeholder for a row that is neither tombstoned by the
 * local sweep nor already past retention? Only that justifies asking other
 * members for a channel key. Pass the already-filtered page (`kept`).
 */
export function pageNeedsKeyRequest(
    kept: readonly ChannelRow[],
    purgedIds: ReadonlySet<string>,
): boolean {
    // Only a placeholder that is waiting on a KEY: a row whose sender could not
    // be verified, or whose key is withheld by permission, is not helped by
    // asking other members for one (utils/channelDecryptFailure.ts).
    return kept.some(m => !purgedIds.has(m.id) && isUndecryptablePlaceholder(m) && placeholderWantsKey(m));
}
