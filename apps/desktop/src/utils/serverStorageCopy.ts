/**
 * User-facing copy for a server's saved-storage limit.
 *
 * Since 2026-10-04 the limit follows the server OWNER's plan: a flat 25 MB when
 * the owner is on the free plan (`storage_plan: 'flat25'`), or the member-count
 * ladder (100 MB to 10 GB) when the owner has Pro or a trial (`'ladder'`). The
 * API sends `storage_plan` on both the storage endpoint and the
 * STORAGE_QUOTA_EXCEEDED error; an older API omits it, which reads as the
 * ladder (the old behaviour). The client only explains the limit — the server
 * enforces it, and a server already over its limit keeps everything it has.
 */
import { formatBytes } from '@cipherline/shared';

export type ServerStoragePlan = 'flat25' | 'ladder';

export interface StorageLimitInfo {
    limit_bytes?: number;
    storage_plan?: ServerStoragePlan | string;
}

/** True only for the flat free-owner quota; unknown/missing = the ladder. */
export const isFlatStoragePlan = (plan: string | undefined | null): boolean => plan === 'flat25';

/** Toast shown when a save/pin is refused for lack of space. */
export function quotaExceededMessage(data?: StorageLimitInfo): string {
    const limit = formatBytes(data?.limit_bytes ?? 0);
    if (isFlatStoragePlan(data?.storage_plan)) {
        return `Server storage limit reached (${limit}). This server's owner is on the Free plan, which includes ${limit} of saved storage. Remove old server saves, or the owner can upgrade to Pro for much more.`;
    }
    return `Server storage limit reached (${limit}). Remove old server saves or grow the server's member count to unlock the next tier.`;
}

/** The warning under the meter once usage passes 90%. */
export function nearLimitMessage(plan: string | undefined | null): string {
    return isFlatStoragePlan(plan)
        ? 'Near the storage limit. Remove server saves, or the server owner can upgrade to Pro for a limit that grows with the server.'
        : 'Near the storage limit. Remove server saves or grow your member count to unlock the next tier.';
}
