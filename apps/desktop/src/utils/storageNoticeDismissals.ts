/**
 * Per-account dismissals of server storage-grace notices, keyed by the API's
 * `notice_id` (packages/shared/storage-grace.ts). Client-side only — the server
 * never learns who dismissed what. Persisted in secureLocalStore (never raw
 * localStorage); classified (excluded from backups) in services/backupRegistry.ts.
 */
import secureLocalStore from './secureLocalStore';
import { parseDismissedNoticeIds, recordNoticeDismissal, storageNoticeDismissedKey } from './serverStorageGrace';

export function readDismissedStorageNotices(userId: string): string[] {
    try { return parseDismissedNoticeIds(secureLocalStore.getItem(storageNoticeDismissedKey(userId))); } catch { return []; }
}

/** Persist a dismissal. The literal key is inlined so backupRegistry's source scan sees it. */
export function persistStorageNoticeDismissal(userId: string, noticeId: string): void {
    try {
        const next = recordNoticeDismissal(readDismissedStorageNotices(userId), noticeId);
        secureLocalStore.setItem(`cipherline_storage_notice_dismissed_${userId}`, JSON.stringify(next));
    } catch {
        // Non-fatal: worst case the notice shows once more.
    }
}
