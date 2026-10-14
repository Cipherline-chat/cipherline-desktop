/**
 * Server storage GRACE — what the desktop shows for it.
 *
 * Policy (owner decision 2026-10-12, contract in packages/shared/storage-grace.ts):
 * a server over the free 25 MB whose owner is on the free plan gets 60 days to
 * move to a Pro owner, have its owner resubscribe, or free space; otherwise it
 * is trimmed back to 25 MB — oldest custom emojis first, then the oldest saved
 * messages. The API decides EVERYTHING (state, audience, whether a member sees
 * a notice at all); this file only turns a `ServerStorageStatus` into words and
 * buttons. There is deliberately no client-side re-derivation of the policy:
 * if the API returns `ok`, nothing renders.
 *
 * Pure (no React, no axios) so the whole state x audience x urgency matrix is
 * unit-tested directly — see serverStorageGrace.test.ts.
 */
import {
    formatBytes,
    formatBillingDate,
    storageGraceDaysLeft,
    SERVER_STORAGE_GRACE_DAYS,
    SERVER_STORAGE_GRACE_TARGET_BYTES,
    type ServerStorageStatus,
    type ServerStorageResolvedReason,
} from '@cipherline/shared';
import { parseDismissedIds, recordDismissal } from './announcements';

/** `calm` > 14 days left, `amber` 4–14, `red` <= 3. */
export type StorageGraceUrgency = 'calm' | 'amber' | 'red';

/** Visual tone of a banner. The three urgencies plus a neutral and a success tone. */
export type StorageBannerTone = StorageGraceUrgency | 'neutral' | 'ok';

/** The buttons a banner (or the Storage settings panel) can offer. */
export type StorageBannerAction =
    | 'keep_pro'        // pending: undo the cancellation / subscribe again
    | 'resubscribe'     // grace: subscribe again
    | 'transfer'        // grace: open Members, Pro members first
    | 'manage_storage'  // open Server Settings -> Storage
    | 'learn_more';     // the in-app explainer

export interface StorageBannerModel {
    noticeId: string;
    tone: StorageBannerTone;
    /** Short bold lead, e.g. "12 days left". May be empty. */
    lead: string;
    /** The sentence after the lead. */
    text: string;
    actions: StorageBannerAction[];
    dismissible: boolean;
    /**
     * Owner, grace: nobody in the server has Pro, so "Transfer ownership"
     * cannot end the grace. The banner shows "No members have Pro yet" in its
     * place rather than a button that leads nowhere useful.
     */
    noProMembers: boolean;
}

export const STORAGE_NOTICE_DISMISSED_KEY_PREFIX = 'cipherline_storage_notice_dismissed_';

/** The 25 MB everything is trimmed back to, formatted. */
export const FREE_STORAGE_LABEL = formatBytes(SERVER_STORAGE_GRACE_TARGET_BYTES);

/** Urgency from whole days left. Boundaries are inclusive on the urgent side. */
export function graceUrgency(daysLeft: number): StorageGraceUrgency {
    if (daysLeft <= 3) return 'red';
    if (daysLeft <= 14) return 'amber';
    return 'calm';
}

/** Days left for a status: the API's `days_left`, else derived from the deadline. */
export function statusDaysLeft(status: ServerStorageStatus, nowMs: number = Date.now()): number | null {
    if (typeof status.days_left === 'number') return Math.max(0, status.days_left);
    if (status.grace_deadline) return storageGraceDaysLeft(status.grace_deadline, nowMs);
    return null;
}

/** "12 days left" / "1 day left" / "Trimming soon" (0: the deadline has passed and the trim is running). */
export function daysLeftLabel(daysLeft: number): string {
    if (daysLeft <= 0) return 'Trimming soon';
    return `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** "on Oct 12, 2026", or "soon" when the API sent no usable date. */
function onDate(iso: string | null | undefined, locale?: string): string {
    const d = formatBillingDate(iso, locale);
    return d ? `on ${d}` : 'soon';
}

const capitalise = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** The part after "You're all set: ". */
export function resolvedReasonText(
    reason: ServerStorageResolvedReason | null,
    serverName: string,
    audience: ServerStorageStatus['audience'],
): string {
    switch (reason) {
        case 'owner_pro':
            return audience === 'owner'
                ? `you have Pro again, so nothing in ${serverName} will be removed.`
                : `the owner of ${serverName} has Pro again, so nothing will be removed.`;
        case 'transfer_pro':
            return `${serverName} now belongs to a member with Pro, so nothing will be removed.`;
        case 'under_limit':
            return `${serverName} is back under ${FREE_STORAGE_LABEL}, so nothing will be removed.`;
        default:
            return `nothing in ${serverName} will be removed.`;
    }
}

/** "removed 3 emojis and 12 saved messages" — or null when the summary has nothing to say. */
export function pruneSummaryText(status: ServerStorageStatus): string | null {
    const s = status.prune_summary;
    if (!s) return null;
    const parts: string[] = [];
    if (s.emojis_deleted > 0) parts.push(plural(s.emojis_deleted, 'emoji', 'emojis'));
    if (s.saves_removed > 0) parts.push(plural(s.saves_removed, 'saved message', 'saved messages'));
    if (parts.length === 0) return null;
    return `removed ${parts.join(' and ')}`;
}

export interface BuildBannerOptions {
    /** Notice ids this viewer has dismissed (only `dismissible` notices honour it). */
    dismissedIds?: readonly string[];
    nowMs?: number;
    /** Date locale; undefined = the user's. Tests pin 'en-US'. */
    locale?: string;
}

/**
 * The banner for one server, or null for "show nothing".
 *
 * Audience rules (the API already scoped the payload; this only words it):
 *  - owner:   pending (heads-up), grace (urgency-scaled), pruned, resolved.
 *  - manager: grace (informational, no billing buttons), pruned, resolved.
 *             A manager gets NO pending heads-up: whether the owner renews is
 *             the owner's billing decision, and there is nothing to act on yet.
 *  - member:  grace / pruned, only when the API returned it (last 7 days of a
 *             grace and 7 days after a trim) — neutral, "Learn more" only.
 */
export function buildStorageBannerModel(
    status: ServerStorageStatus | null | undefined,
    serverName: string,
    opts: BuildBannerOptions = {},
): StorageBannerModel | null {
    if (!status || status.state === 'ok' || !status.notice_id) return null;
    if (status.dismissible && opts.dismissedIds?.includes(status.notice_id)) return null;
    const { audience } = status;
    const noticeId = status.notice_id;
    const base = { noticeId, dismissible: status.dismissible, noProMembers: false };

    switch (status.state) {
        case 'pending': {
            if (audience !== 'owner') return null;
            const ends = formatBillingDate(status.pro_ends_at, opts.locale);
            const usage = status.usage_bytes != null ? formatBytes(status.usage_bytes) : null;
            return {
                ...base,
                tone: 'calm',
                lead: ends ? `Your Pro plan ends ${ends}.` : 'Your Pro plan is ending.',
                text: (usage
                    ? `${serverName} uses ${usage} of storage, more than the free ${FREE_STORAGE_LABEL}. `
                    : `${serverName} uses more than the free ${FREE_STORAGE_LABEL} of storage. `)
                    + `After Pro ends you'll have ${SERVER_STORAGE_GRACE_DAYS} days to transfer ownership to a Pro member, or it'll be trimmed to ${FREE_STORAGE_LABEL}.`,
                actions: ['keep_pro', 'learn_more'],
            };
        }
        case 'grace': {
            const days = statusDaysLeft(status, opts.nowMs) ?? 0;
            const when = onDate(status.grace_deadline, opts.locale);
            if (audience === 'owner') {
                const noPro = !!status.transfer && status.transfer.pro_member_count === 0;
                return {
                    ...base,
                    noProMembers: noPro,
                    tone: graceUrgency(days),
                    lead: `${daysLeftLabel(days)}:`,
                    text: `${serverName} will be trimmed to ${FREE_STORAGE_LABEL} ${when}. Oldest emojis are removed first, then the oldest saved messages.`,
                    actions: ['transfer', 'resubscribe', 'manage_storage'],
                };
            }
            if (audience === 'manager') {
                return {
                    ...base,
                    tone: graceUrgency(days),
                    lead: `${daysLeftLabel(days)}:`,
                    text: `${serverName} is over its ${FREE_STORAGE_LABEL} storage limit and will be trimmed ${when}, unless the owner moves it to a Pro member, resubscribes, or space is freed. Oldest emojis go first, then the oldest saved messages.`,
                    actions: ['manage_storage', 'learn_more'],
                };
            }
            return {
                ...base,
                tone: 'neutral',
                lead: '',
                text: `${serverName} is over its storage limit. ${capitalise(when)}, its oldest custom emojis and saved messages will be removed to bring it back to ${FREE_STORAGE_LABEL}.`,
                actions: ['learn_more'],
            };
        }
        case 'pruned': {
            const when = onDate(status.pruned_at, opts.locale);
            if (audience === 'member') {
                return {
                    ...base,
                    tone: 'neutral',
                    lead: '',
                    text: `${serverName} was trimmed to ${FREE_STORAGE_LABEL} ${when}. Some of its oldest custom emojis and saved messages were removed.`,
                    actions: ['learn_more'],
                };
            }
            const summary = pruneSummaryText(status);
            return {
                ...base,
                tone: 'neutral',
                lead: '',
                text: `We trimmed ${serverName} to ${FREE_STORAGE_LABEL} ${when}${summary ? `: ${summary}` : ''}.`,
                actions: ['learn_more'],
            };
        }
        case 'resolved': {
            if (audience === 'member') return null;
            return {
                ...base,
                tone: 'ok',
                lead: 'You\'re all set:',
                text: resolvedReasonText(status.resolved_reason, serverName, audience),
                actions: [],
            };
        }
        default:
            return null;
    }
}

// ── Dismissal (client-side, keyed by notice_id) ────────────────────────────

export const storageNoticeDismissedKey = (userId: string) => `${STORAGE_NOTICE_DISMISSED_KEY_PREFIX}${userId}`;

/** Parse the persisted JSON array; anything malformed is an empty list. */
export const parseDismissedNoticeIds = parseDismissedIds;

/** Add `noticeId`, most recent last, capped so the list cannot grow forever. */
export function recordNoticeDismissal(ids: readonly string[], noticeId: string): string[] {
    return recordDismissal(ids, noticeId, 50);
}

// ── Billing cancel confirmation ─────────────────────────────────────────────

/** True when a status says the server uses more than the free 25 MB (owner view only carries usage). */
export function isOverFreeStorage(status: ServerStorageStatus | null | undefined): boolean {
    return !!status
        && typeof status.usage_bytes === 'number'
        && status.usage_bytes > (status.target_bytes || SERVER_STORAGE_GRACE_TARGET_BYTES);
}

/**
 * The extra line in the cancel confirmation, or null when no owned server is
 * over 25 MB.
 */
export function cancelServerStorageNotice(overCount: number): string | null {
    if (!Number.isFinite(overCount) || overCount <= 0) return null;
    return overCount === 1
        ? `1 of your servers uses more than ${FREE_STORAGE_LABEL}. After Pro ends you'll have ${SERVER_STORAGE_GRACE_DAYS} days to transfer it to a Pro member before it's trimmed.`
        : `${overCount.toLocaleString('en-US')} of your servers use more than ${FREE_STORAGE_LABEL}. After Pro ends you'll have ${SERVER_STORAGE_GRACE_DAYS} days to transfer them to a Pro member before they're trimmed.`;
}

/**
 * Collect the storage status of every server the user OWNS, and count the ones
 * over 25 MB. Only owned servers are fetched (the status endpoint is
 * rate-limited at 10 per 10 s, and only an owner's servers can be trimmed on
 * their account). `getStatus` is expected to be the shared, paced store, so
 * this never bursts past the limit; `onProgress` lets the UI show the count as
 * results arrive instead of waiting for a long tail.
 */
export async function countOwnedServersOverFreeStorage(args: {
    servers: ReadonlyArray<{ server_id: string; owner_user_id: string }>;
    userId: string;
    getStatus: (serverId: string) => Promise<ServerStorageStatus | null>;
    onProgress?: (overCount: number) => void;
    isCancelled?: () => boolean;
}): Promise<number> {
    const owned = args.servers.filter(s => s.owner_user_id === args.userId);
    let over = 0;
    for (const s of owned) {
        if (args.isCancelled?.()) break;
        let st: ServerStorageStatus | null = null;
        try { st = await args.getStatus(s.server_id); } catch { st = null; }
        if (isOverFreeStorage(st)) {
            over += 1;
            args.onProgress?.(over);
        }
    }
    return over;
}
