import secureLocalStore from './secureLocalStore';

/**
 * retentionTombstones — per-channel ledger of message IDs the LOCAL retention
 * sweeper deliberately purged.
 *
 * Why this exists:
 *   DMs and server channels store history very differently. A DM envelope is
 *   poll-then-ACK: once the client ACKs it the server deletes it, so a message
 *   the retention sweeper drops is gone for good. A SERVER CHANNEL message is
 *   a durable `channel_messages` row that stays on the server until its own
 *   `expires_at` passes — the client's local cache is just a cache of it.
 *
 *   So when retention pruned an attachment message out of a channel thread,
 *   the very next `GET /v1/channels/:id/messages` handed the same row straight
 *   back and `foldChannelHistory` re-inserted it ("id not in the local cache"
 *   was read as "new message"). The resurrected row then rendered as one of:
 *     - the attachment bubble again, now 404ing because the sweep had already
 *       DELETEd the blob, or
 *     - once the epoch's Sender Key had also been pruned (channel-keys.ts
 *       `pruneOldKeys`, 30 days), the "Couldn't decrypt — waiting on this
 *       channel's key" pill, plus a pointless key request fired at other
 *       members for a message the user had asked to be rid of.
 *
 *   Neither is what "Keep for: 1 week" means. This ledger is the missing half:
 *   the local cache remembers WHAT IT DELETED, so a server copy of a purged
 *   message is never mistaken for a new one.
 *
 * Why a ledger rather than deleting server-side:
 *   Retention is a LOCAL storage policy — it governs this user's copy. Purging
 *   the channel row would destroy every other member's copy too, which is a
 *   different (moderation) action with different permissions.
 *
 * DEVICE-LOCAL — never in a backup or history transfer (since 2026-09):
 *   Retention is a per-device setting, and this ledger is nothing more than
 *   the record of what THIS device's policy deleted. On a device that keeps
 *   things longer the same ids are messages it is supposed to have, and the
 *   ledger's whole effect is to make foldChannelHistory and the live
 *   channel-message path drop them — permanently, silently, on every fetch.
 *   So it must not travel (backupRegistry.ts classifies it `include: false`,
 *   which also makes a restore IGNORE the copy an older backup carries). The
 *   cost is bounded and self-healing: a fresh device may briefly show a
 *   server-channel message another device purged, until its own sweep runs
 *   under its own policy and writes its own ledger.
 *
 * Storage:
 *   One secureLocalStore key per (account, channel):
 *   `cipherline_retention_purged_${userId}_${channelId}` → JSON array of
 *   message ids, insertion-ordered. Bounded to MAX_PER_CHANNEL; the oldest
 *   entries roll off, exactly as removedAttachmentTracker.ts does. Rolling an
 *   id off only means the very oldest purged message could reappear if the
 *   user paginates that far back into history — the newest MAX_PER_CHANNEL
 *   purges, which is everything the 50-row live window can return, always win.
 */

/** Per-channel cap. ~1000 ids ≈ 38 KB of JSON; a user only accumulates these
 *  for channels they actually read, and the tail is the least reachable. */
const MAX_PER_CHANNEL = 1000;

function keyFor(userId: string, channelId: string): string {
    return `cipherline_retention_purged_${userId}_${channelId}`;
}

export function getPurgedMessageIds(userId: string, channelId: string): Set<string> {
    try {
        const raw = secureLocalStore.getItem(keyFor(userId, channelId));
        if (!raw) return new Set();
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? new Set<string>(arr.filter((x): x is string => typeof x === 'string')) : new Set();
    } catch {
        return new Set();
    }
}

/**
 * Record message ids the retention sweeper just dropped from `channelId`.
 * No-ops for an empty list or when every id is already recorded, so it is
 * cheap to call unconditionally from the 5-minute sweep loop.
 */
export function markMessagesPurged(userId: string, channelId: string, messageIds: string[]): void {
    if (!userId || !channelId || !messageIds.length) return;
    try {
        const set = getPurgedMessageIds(userId, channelId);
        let added = false;
        for (const id of messageIds) {
            if (typeof id === 'string' && id && !set.has(id)) { set.add(id); added = true; }
        }
        if (!added) return;
        let arr = [...set];
        if (arr.length > MAX_PER_CHANNEL) arr = arr.slice(arr.length - MAX_PER_CHANNEL);
        secureLocalStore.setItem(keyFor(userId, channelId), JSON.stringify(arr));
    } catch {
        /* quota / locked store — worst case the message resurrects once more. */
    }
}

