/**
 * User-facing copy for a server's storage limit — server saves AND custom
 * emojis (emojis count toward the same quota since 2026-10-05).
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
        return `Server storage limit reached (${limit}). This server's owner is on the Free plan, which includes ${limit} of saved storage. Remove old server saves or custom emojis, or the owner can upgrade to Pro for much more.`;
    }
    return `Server storage limit reached (${limit}). Remove old server saves or custom emojis, or grow the server's member count to unlock the next tier.`;
}

/**
 * Custom emojis count toward the same server storage as saves (since
 * 2026-10-05 — there is no emoji count cap any more). The API refuses an
 * emoji upload that does not fit with the same STORAGE_QUOTA_EXCEEDED code
 * (`kind: 'emoji'`); this is the toast for it.
 */
export function emojiQuotaExceededMessage(data?: StorageLimitInfo & { used_bytes?: number }): string {
    const limit = formatBytes(data?.limit_bytes ?? 0);
    const used = typeof data?.used_bytes === 'number'
        ? `${formatBytes(data.used_bytes)} of ${limit} used`
        : `${limit} limit`;
    const upgrade = isFlatStoragePlan(data?.storage_plan)
        ? ', or the server owner can upgrade to Pro for much more'
        : '';
    return `This emoji doesn't fit in the server's storage (${used}). Remove some emojis or server saves to make room${upgrade}.`;
}

/** True when an API error body is the storage-quota refusal. */
export function isStorageQuotaError(
    data: unknown,
): data is StorageLimitInfo & { code: 'STORAGE_QUOTA_EXCEEDED'; used_bytes?: number } {
    return !!data && typeof data === 'object' && (data as { code?: unknown }).code === 'STORAGE_QUOTA_EXCEEDED';
}

/**
 * The 1,000-emoji-per-server backstop (owner decision 2026-10-05). Storage is
 * the VISIBLE limit; this one is never shown as a counter — only a quiet note
 * from EMOJI_COUNT_NOTE_AT and this message once the API refuses with
 * EMOJI_COUNT_LIMIT. The API is the enforcer; `limit` comes from its payload.
 */
export const EMOJI_COUNT_LIMIT_FALLBACK = 1000;
export const EMOJI_COUNT_NOTE_AT = 950;

export function emojiCountLimitMessage(data?: { limit?: number }): string {
    const limit = (data?.limit ?? EMOJI_COUNT_LIMIT_FALLBACK).toLocaleString('en-US');
    return `This server has reached its maximum of ${limit} custom emojis. Remove one you no longer use to add another.`;
}

export function emojiCountNearMessage(count: number, limit = EMOJI_COUNT_LIMIT_FALLBACK): string {
    return `This server has ${count.toLocaleString('en-US')} custom emojis — close to the maximum of ${limit.toLocaleString('en-US')}.`;
}

export function isEmojiCountLimitError(data: unknown): data is { code: 'EMOJI_COUNT_LIMIT'; limit?: number } {
    return !!data && typeof data === 'object' && (data as { code?: unknown }).code === 'EMOJI_COUNT_LIMIT';
}

/** The warning under the meter once usage passes 90%. */
export function nearLimitMessage(plan: string | undefined | null): string {
    return isFlatStoragePlan(plan)
        ? 'Near the storage limit. Remove server saves or custom emojis, or the server owner can upgrade to Pro for a limit that grows with the server.'
        : 'Near the storage limit. Remove server saves or custom emojis, or grow your member count to unlock the next tier.';
}
