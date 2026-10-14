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
 * enforces it.
 *
 * What happens to a server that is ALREADY over its limit depends on the
 * owner's plan (2026-10-12, packages/shared/storage-grace.ts):
 *   - Pro/trial owner (ladder): new saves and emojis are refused until space is
 *     freed; nothing already saved is removed.
 *   - free owner (flat 25 MB): new saves and emojis are refused AND a 60-day
 *     grace starts; unless the owner resubscribes, ownership moves to a Pro
 *     member, or usage drops to 25 MB, the server is trimmed back to 25 MB at
 *     the deadline — oldest custom emojis first, then the oldest saved
 *     messages. (This used to say an over-limit server "keeps everything it
 *     has"; that stopped being true with the grace policy.)
 */
import { formatBytes, SERVER_STORAGE_GRACE_DAYS, FREE_OWNER_STORAGE_BYTES } from '@cipherline/shared';

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

/**
 * The note under the meter when usage is ABOVE the limit. Accurate per plan:
 * a free owner's server is on the 60-day grace path to a trim; a Pro owner's
 * server just can't grow until space is freed.
 */
export function overLimitMessage(plan: string | undefined | null): string {
    const free = formatBytes(FREE_OWNER_STORAGE_BYTES);
    return isFlatStoragePlan(plan)
        ? `Over the ${free} free limit. New saves and emojis are paused. Unless the owner gets Pro again, moves the server to a member with Pro, or frees space before its ${SERVER_STORAGE_GRACE_DAYS}-day grace period ends, it's trimmed back to ${free}: oldest custom emojis first, then the oldest saved messages.`
        : 'Over the storage limit. New saves and emojis are paused until space is freed; nothing already saved is removed.';
}

/** The storage line in the transfer-ownership confirmation. */
export function transferStorageNote(): string {
    const free = formatBytes(FREE_OWNER_STORAGE_BYTES);
    return `From then on their plan decides this server's saved-storage limit. If they're on the free plan and the server uses more than ${free}, it has ${SERVER_STORAGE_GRACE_DAYS} days to get back under ${free} before it's trimmed; if they have Pro, nothing changes.`;
}
