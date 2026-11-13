/**
 * Send-side backlog cap, as the sender's client sees it (apps/api
 * messages/backlog-cap.ts).
 *
 * A recipient DEVICE that already has too much undelivered ciphertext queued is
 * not given another envelope:
 *   - if every device the message was addressed to is full, POST /messages/send
 *     answers 409 `RECIPIENT_BACKLOG_FULL` and nothing is stored: the message is
 *     marked "Not delivered" and Retry works once they catch up;
 *   - if only some are full, the send succeeds for the rest and the response
 *     carries `backlog_full_device_ids` (this module words the notice).
 *
 * UX only. An older client falls through to its generic "Not delivered" (the 409
 * is not one it special-cases) and ignores the extra response field.
 */

export function isBacklogFullError(err: unknown): boolean {
    const r = (err as { response?: { status?: number; data?: { code?: unknown } } } | null)?.response;
    return r?.status === 409 && r.data?.code === 'RECIPIENT_BACKLOG_FULL';
}

/** Short reason shown beside a failed message. */
export const BACKLOG_FULL_REASON = 'Their inbox is full - they need to open Cipherline';

/**
 * Toast copy for a send that went through but skipped some full devices, or
 * null when nothing was skipped (including every response from an older API).
 */
export function backlogPartialNotice(resp: unknown): { title: string; message: string } | null {
    const ids = (resp as { backlog_full_device_ids?: unknown } | null)?.backlog_full_device_ids;
    if (!Array.isArray(ids) || ids.length === 0) return null;
    const n = ids.length;
    return {
        title: 'Sent, but not to every device',
        message:
            n === 1
                ? "Delivered, except to one device that has too many unread messages waiting. It won't receive this one; their other devices did."
                : `Delivered, except to ${n} devices that have too many unread messages waiting. They won't receive this one; the others did.`,
    };
}
