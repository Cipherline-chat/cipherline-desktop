import secureLocalStore from './secureLocalStore';
/**
 * removedAttachmentTracker — persistent per-user list of attachment IDs that
 * the server no longer holds.
 *
 * Why this exists:
 *   When an attachment is deleted by the retention sweeper (local or
 *   server-side), the user's message bubble used to fall back to the red
 *   "Couldn't decrypt" error card with a Retry button — which is alarming
 *   and pointless because the bytes are gone for good. Once an attachment_id
 *   is known to be gone, future renders skip the fetch entirely and show a
 *   subtle gray "Attachment no longer available" placeholder instead.
 *
 * Storage:
 *   localStorage key `cipherline_removed_attachments_${userId}` holds a JSON
 *   array of attachment_ids. Bounded to MAX_TRACKED to avoid unbounded growth
 *   over a long-lived account — once we exceed the cap, the oldest entries
 *   roll off (no fairness issue: the worst case is one extra 404 round-trip,
 *   which immediately re-marks the id).
 */

const MAX_TRACKED = 4096;

function keyFor(userId: string): string {
    return `cipherline_removed_attachments_${userId}`;
}

export function getRemovedAttachmentIds(userId: string): Set<string> {
    try {
        const raw = secureLocalStore.getItem(keyFor(userId));
        if (!raw) return new Set();
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? new Set<string>(arr) : new Set();
    } catch {
        return new Set();
    }
}

export function isAttachmentRemoved(userId: string, attachmentId: string): boolean {
    return getRemovedAttachmentIds(userId).has(attachmentId);
}

export function markAttachmentRemoved(userId: string, attachmentId: string): void {
    try {
        const set = getRemovedAttachmentIds(userId);
        if (set.has(attachmentId)) return;
        set.add(attachmentId);
        // Trim the oldest if we blow the cap. Set iteration order is insertion order.
        let arr = [...set];
        if (arr.length > MAX_TRACKED) {
            arr = arr.slice(arr.length - MAX_TRACKED);
        }
        secureLocalStore.setItem(keyFor(userId), JSON.stringify(arr));
    } catch {
        /* ignore quota errors — worst case is one extra 404 next time. */
    }
}

/** Batch insert — used by the retention sweeper after it evicts attachments. */
export function markAttachmentsRemoved(userId: string, attachmentIds: string[]): void {
    if (!attachmentIds.length) return;
    try {
        const set = getRemovedAttachmentIds(userId);
        let added = false;
        for (const id of attachmentIds) {
            if (!set.has(id)) { set.add(id); added = true; }
        }
        if (!added) return;
        let arr = [...set];
        if (arr.length > MAX_TRACKED) arr = arr.slice(arr.length - MAX_TRACKED);
        secureLocalStore.setItem(keyFor(userId), JSON.stringify(arr));
    } catch { /* ignore */ }
}
