/**
 * The latest COMPLETE published device set per contact, for the trust badge.
 * This is the contact's side of the ghost-device fix (docs/ghost-device.md §2.4).
 *
 * The contact trust badge used to be built from the pin store alone, and pins
 * are written only by received envelopes and `markVerified`. A device the
 * server adds to a verified contact AFTER verification never sends anything,
 * so it is never pinned. The shield therefore stayed green while every DM
 * and `call_key` was also being wrapped to that device. `addUnpinnedPublished`
 * (contactTrust.ts) fixes the count; this module supplies the input.
 *
 * ── Why a separate cache, and why "complete" matters ─────────────────────────
 *
 * `deviceDirectory` MERGES conversation-scoped rows into its attribution cache
 * and never drops a device from them. That is right for attribution, where a
 * false mismatch rejects key material. It would be wrong here: a revoked
 * device would keep the badge amber for the rest of the session. So only
 * listings that are complete PER USER replace a user's set:
 *
 *   • `GET /keys/identity_keys?user_id=X`: every active device of X.
 *   • `GET /conversations/:id/devices`: every approved device of every member
 *     who appears in it (the caller's own current device aside, which is not
 *     a contact).
 *
 * Channel and server-member listings only ever merge into the attribution
 * cache. They are not used here.
 *
 * ── What this must never do ──────────────────────────────────────────────────
 *
 * Pin. See the note in `directoryKeyWatch.ts`: a server response must never
 * seed the trust anchor. This only lets the badge COUNT a published device
 * as unverified. In-memory and session-scoped by design, and re-derived on
 * the next chat open or send.
 */

import type { DirectoryEntry } from './deviceDirectory';

const sets = new Map<string, Record<string, string>>();

/** Bound on tracked contacts. Overflow evicts the oldest (insertion order):
 *  the safe direction, because a missing set only means "no extra devices
 *  known", which is what the badge showed before this module existed. */
const MAX_USERS = 2048;

function isConversationDevices(path: string): boolean {
    return /\/conversations\/[^/]+\/devices$/.test(path);
}

/**
 * Fold one directory response. `url` is the request URL. `fullUserId` is the
 * `user_id` query parameter of an `/identity_keys` request, or null.
 */
export function observePublished(
    entries: DirectoryEntry[] | null | undefined,
    fullUserId: string | null,
    url: string | undefined,
    myUserId: string,
): void {
    if (!Array.isArray(entries) || !url) return;
    const path = url.split('?')[0];

    const byUser = new Map<string, Record<string, string>>();
    if (fullUserId && path.endsWith('/identity_keys')) {
        byUser.set(fullUserId, {});
    } else if (!isConversationDevices(path)) {
        return;
    }

    for (const e of entries) {
        const uid = e?.user_id ?? fullUserId ?? null;
        const deviceId = e?.device_id;
        const pub = e?.identity_pub_b64 ?? e?.identity_key_pub_b64;
        if (!uid || !deviceId || !pub) continue;
        let set = byUser.get(uid);
        if (!set) { set = {}; byUser.set(uid, set); }
        set[deviceId] = pub;
    }

    for (const [uid, set] of byUser) {
        if (uid === myUserId) continue;
        // An empty full listing (the server says the user has no keys) is not
        // "zero devices". Leave whatever we held.
        if (!Object.keys(set).length) continue;
        sets.delete(uid);
        if (sets.size >= MAX_USERS) {
            const oldest = sets.keys().next().value;
            if (oldest !== undefined) sets.delete(oldest);
        }
        sets.set(uid, set);
    }
}

/** Latest complete published set for a contact (device_id → pub), or null. */
export function publishedDevicesFor(userId: string): Record<string, string> | null {
    const s = sets.get(userId);
    return s ? { ...s } : null;
}

/** Test seam / account-switch + sign-out hygiene. */
export function _reset(): void {
    sets.clear();
}
