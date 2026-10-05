/**
 * Server-side storage tiers — quota for "saved" content (pinned messages and
 * their attachments) per server. The quota scales with member count so small
 * communities aren't paying for capacity they won't use, and large ones get
 * the headroom they need.
 *
 * One source of truth shared between API (quota enforcement at pin time)
 * and desktop (display in Settings → Overview).
 *
 * Ladder rationale:
 *   - 100 MB at the bottom is enough for ~50 average-sized images or a
 *     handful of recordings — meaningful for friend groups.
 *   - 500 MB at 100+ members maps to active community usage.
 *   - 1 GB at 500+ is a tenfold jump because larger communities pin much
 *     more reference material (announcements, FAQs, asset libraries).
 *   - 2 GB / 5 GB / 10 GB extend the ladder for big servers without an
 *     unbounded climb. Beyond 10k members the ladder caps; growing past
 *     that requires a manual ops decision.
 *
 * WHICH quota applies is decided by the server OWNER's plan (2026-10-04):
 *   - owner on the free plan (free/expired)  -> a flat 25 MB, whatever the
 *     member count ('flat25').
 *   - owner paid / trial / comp              -> the ladder above ('ladder').
 * The plan comes from `BillingService.getEntitlements(owner).serverStorage`
 * — the single source of truth; nothing here re-derives subscription status.
 * Ownership transfer changes the owner, so the new owner's plan applies.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

export interface StorageTier {
    /** Inclusive lower bound on member count this tier applies to. */
    minMembers: number;
    /** Inclusive upper bound on member count this tier applies to. */
    maxMembers: number;
    /** Quota in bytes. */
    bytes: number;
    /** Human-readable label, used in the Settings UI. */
    label: string;
}

export const STORAGE_TIERS: StorageTier[] = [
    { minMembers: 1,      maxMembers: 100,    bytes: 100 * MB, label: '1–100 members'    },
    { minMembers: 101,    maxMembers: 500,    bytes: 500 * MB, label: '101–500 members'  },
    { minMembers: 501,    maxMembers: 1000,   bytes: 1 * GB,   label: '501–1k members'   },
    { minMembers: 1001,   maxMembers: 5000,   bytes: 2 * GB,   label: '1k–5k members'    },
    { minMembers: 5001,   maxMembers: 10000,  bytes: 5 * GB,   label: '5k–10k members'   },
    { minMembers: 10001,  maxMembers: Infinity, bytes: 10 * GB, label: '10k+ members'    },
];

/** Flat saved-storage quota for a server whose OWNER is on the free plan. */
export const FREE_OWNER_STORAGE_BYTES = 25 * MB;

/**
 * Which saved-storage quota a server gets, decided by its owner's plan:
 * 'flat25' = free/expired owner, 'ladder' = paid/trial/comp owner. This is the
 * `serverStorage` field of the API's entitlements.
 */
export type ServerStoragePlan = 'flat25' | 'ladder';

/**
 * Quota in bytes for a server given its member count AND its owner's plan.
 * Anything that is not exactly 'ladder' resolves to the flat free quota, so a
 * missing/garbled plan fails closed (matching getEntitlements).
 */
export function storageLimitForServer(memberCount: number, plan: ServerStoragePlan): number {
    return plan === 'ladder' ? storageLimitForMembers(memberCount) : FREE_OWNER_STORAGE_BYTES;
}

/** Tier label for the Settings UI, owner-plan aware. */
export function tierLabelForServer(memberCount: number, plan: ServerStoragePlan): string {
    return plan === 'ladder' ? tierLabelForMembers(memberCount) : 'Free plan';
}

/** Returns the quota in bytes for a server with the given member count (paid-owner ladder). */
export function storageLimitForMembers(memberCount: number): number {
    const safe = Math.max(0, Math.floor(memberCount));
    const tier = STORAGE_TIERS.find(t => safe >= t.minMembers && safe <= t.maxMembers);
    return tier ? tier.bytes : STORAGE_TIERS[0].bytes;
}

/** Human-readable tier label for UI display ("101–500 members"). */
export function tierLabelForMembers(memberCount: number): string {
    const safe = Math.max(0, Math.floor(memberCount));
    const tier = STORAGE_TIERS.find(t => safe >= t.minMembers && safe <= t.maxMembers);
    return tier?.label ?? STORAGE_TIERS[0].label;
}

/** Format bytes as "47 MB" / "1.2 GB" — for the storage meter UI. */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < MB)   return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < GB)   return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
    return `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`;
}
