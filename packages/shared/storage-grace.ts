/**
 * Server storage GRACE — the contract between the API and the clients.
 *
 * Policy (owner decision 2026-10-12):
 *   - A server's saved storage (server-saved/pinned messages + their files,
 *     plus custom emojis) is capped by its OWNER's plan: 25 MB for a free
 *     owner, the member-count ladder for a Pro owner (see storage-tiers.ts).
 *   - If a server uses MORE than the free 25 MB while its owner is on the free
 *     plan (they lost Pro, a trial ended, etc.), it enters a 60-day GRACE
 *     period. During grace nothing is removed and nothing new can be added.
 *   - Grace ends early, with nothing removed, when the owner gets Pro again,
 *     ownership moves to a member who has Pro, or usage drops to 25 MB or
 *     less. Moving ownership to a FREE member keeps the same clock running.
 *   - At the deadline the server is TRIMMED back to 25 MB: custom emojis go
 *     first (oldest first) until none remain, then saved messages (pinned ones
 *     included) with their files, oldest message first, stopping as soon as
 *     usage is at or below 25 MB.
 *
 * The API decides everything; clients only render what they are sent. All
 * timestamps are ISO-8601 strings.
 */

import { FREE_OWNER_STORAGE_BYTES } from './storage-tiers';

/** Length of the grace period, in days. */
export const SERVER_STORAGE_GRACE_DAYS = 60;

/**
 * Reminder milestones, in "days left" (60 = the notice that starts the grace).
 * Each is sent at most once per grace period, by email to the owner and as an
 * in-app event to the owner and server managers.
 */
export const SERVER_STORAGE_GRACE_REMINDER_DAYS = [60, 30, 14, 7, 3, 1] as const;

/** Regular members see a (neutral) notice only in the final N days. */
export const SERVER_STORAGE_MEMBER_NOTICE_DAYS = 7;

/** The size every server is trimmed back to at the deadline. */
export const SERVER_STORAGE_GRACE_TARGET_BYTES = FREE_OWNER_STORAGE_BYTES;

/**
 * WS event pushed when a server's storage status changes (grace started, a
 * reminder milestone passed, grace resolved, server trimmed). Payload is only
 * `{ server_id }` — clients refetch `GET /v1/servers/:id/storage-status`,
 * which is where the audience rules live.
 */
export const SERVER_STORAGE_STATUS_EVENT = 'server:storage_status_changed';

/**
 * - `ok`       nothing to show.
 * - `pending`  the owner still has Pro, but it is scheduled to end
 *              (`pro_ends_at`) and the server uses more than 25 MB. Heads-up only.
 * - `grace`    the 60-day clock is running (`grace_deadline`).
 * - `pruned`   the deadline passed and the server was trimmed (`prune_summary`).
 * - `resolved` a grace/heads-up ended with nothing removed (`resolved_reason`).
 */
export type ServerStorageGraceState = 'ok' | 'pending' | 'grace' | 'pruned' | 'resolved';

/**
 * Why a grace ended without removing anything:
 * - `owner_pro`     the owner has Pro again.
 * - `transfer_pro`  ownership moved to a member who has Pro.
 * - `under_limit`   usage dropped to 25 MB or less.
 */
export type ServerStorageResolvedReason = 'owner_pro' | 'transfer_pro' | 'under_limit';

/** Who is asking — decides how much of the status is returned. */
export type ServerStorageAudience = 'owner' | 'manager' | 'member';

/** What a trim removed. Counts and byte totals only — never ids or content. */
export interface ServerStoragePruneSummary {
    emojis_deleted: number;
    emoji_bytes: number;
    /** Saved messages taken off the server's storage (pinned ones included). */
    saves_removed: number;
    save_bytes: number;
    /** How many of `saves_removed` were pinned. */
    pinned_removed: number;
    /** Messages deleted outright (they were already past their normal 30-day life). */
    messages_deleted: number;
    /**
     * Messages that went back to being ordinary messages, which expire 30 days
     * after they were sent like any unsaved message (they were younger than
     * that). They no longer count against the server's storage.
     */
    messages_released: number;
    /** Files deleted immediately. Younger files are reclaimed by the normal
     *  14-day cleanup once nothing references them. */
    files_deleted: number;
    file_bytes: number;
    usage_before_bytes: number;
    usage_after_bytes: number;
    limit_bytes: number;
    started_at: string;
    completed_at: string | null;
}

/** Owner-only: who ownership could move to, to end the grace with nothing removed. */
export interface ServerStorageTransferCandidates {
    /** Active members (not the owner) who currently have Pro. */
    pro_member_count: number;
    /**
     * Their user ids (at most `SERVER_STORAGE_TRANSFER_ID_CAP`), so the
     * transfer-ownership picker can mark them. Pro is already public on every
     * profile (the Pro badge), so this reveals nothing new to the owner.
     */
    pro_member_ids: string[];
}

export const SERVER_STORAGE_TRANSFER_ID_CAP = 100;

/** Response of `GET /v1/servers/:id/storage-status`. */
export interface ServerStorageStatus {
    server_id: string;
    audience: ServerStorageAudience;
    state: ServerStorageGraceState;
    /** Current saved-storage use. null for the `member` audience. */
    usage_bytes: number | null;
    /** The quota that applies right now (owner's plan). null for `member`. */
    limit_bytes: number | null;
    /** What the server is trimmed back to: 25 MB. */
    target_bytes: number;
    /** `pending` only: when the owner's Pro ends. */
    pro_ends_at: string | null;
    grace_started_at: string | null;
    grace_deadline: string | null;
    /** Whole days until `grace_deadline` (rounded up, never negative). */
    days_left: number | null;
    /** Owner only, while `pending`/`grace`. */
    transfer: ServerStorageTransferCandidates | null;
    /** `pruned` (and a `resolved` that interrupted a trim). null for `member`. */
    prune_summary: ServerStoragePruneSummary | null;
    resolved_reason: ServerStorageResolvedReason | null;
    resolved_at: string | null;
    pruned_at: string | null;
    /**
     * Stable id for this notice. Dismissal is a per-viewer UI choice and lives
     * on the client (keyed by this id); a new grace gets a new id. null for `ok`.
     */
    notice_id: string | null;
    /** `resolved` and `pruned` notices may be dismissed; `pending`/`grace` may not. */
    dismissible: boolean;
}

/** Whole days left until `deadline` (ceil), floored at 0. */
export function storageGraceDaysLeft(deadline: Date | string, nowMs: number = Date.now()): number {
    const t = typeof deadline === 'string' ? Date.parse(deadline) : deadline.getTime();
    if (!Number.isFinite(t)) return 0;
    return Math.max(0, Math.ceil((t - nowMs) / 86_400_000));
}
