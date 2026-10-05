import type { AttachmentRetention, ConvType, MessageRetention, StoragePolicy } from '../hooks/useRetentionPolicy';
import { getEffectiveAttachmentRetention, getEffectiveMessageRetention } from '../hooks/useRetentionPolicy';

/**
 * retentionResolve — the ONE place a chat's effective retention is resolved for
 * the purpose of DELETING things.
 *
 *   per-chat override (per-server for a channel, per-conversation for a DM or
 *   group)  >  per-type default (DM / group / server)  >  global
 *
 * Before this module the chain was re-implemented inline at six Dashboard sites
 * (the 5-minute sweep ×2, "Purge now" ×4), each with its own copy of the
 * override JSON parse and an unchecked `as any` cast. Two of those copies
 * quietly diverged from the sweep in what they PROTECT: the purge-now flows
 * never passed the pinned / server-saved set, so "Remove N now" deleted a
 * pinned message (and, for a channel, tombstoned it so it could never come
 * back). Everything that decides what to delete now goes through here.
 *
 * Pure: no storage, no React.
 */

const MESSAGE_VALUES: readonly string[]    = ['never', '1y', '6mo', '3mo', '1mo', '1wk'];
const ATTACHMENT_VALUES: readonly string[] = ['never', '1y', '6mo', '3mo', '1mo', '1wk', '24h'];

/** A per-server / per-conversation override as stored (either half may be absent). */
export interface RetentionOverride {
    messageRetention?: MessageRetention;
    attachmentRetention?: AttachmentRetention;
}

/**
 * Parse a stored per-chat override. Anything this build can't read — corrupt
 * JSON, a window it doesn't know (a restore from a newer build, a hand edit) —
 * is IGNORED, i.e. the chat falls back to the type default. The old inline
 * parsers cast the raw string straight into the policy, and an unknown window
 * made every message look expired.
 */
export function parseRetentionOverride(raw: string | null | undefined): RetentionOverride | null {
    if (!raw) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const p = parsed as Record<string, unknown>;
    const out: RetentionOverride = {};
    if (typeof p.messageRetention === 'string' && MESSAGE_VALUES.includes(p.messageRetention)) {
        out.messageRetention = p.messageRetention as MessageRetention;
    }
    if (typeof p.attachmentRetention === 'string' && ATTACHMENT_VALUES.includes(p.attachmentRetention)) {
        out.attachmentRetention = p.attachmentRetention as AttachmentRetention;
    }
    return out.messageRetention || out.attachmentRetention ? out : null;
}

/** Storage key of a per-server override (written by ServerMemberOptionsModal). */
export function serverRetentionKey(userId: string, serverId: string): string {
    return `cipherline_server_retention_${userId}_${serverId}`;
}

/**
 * The policy to hand to `sweepRetention` for one chat: the saved / unsaved id
 * lists and timestamps are the account's, the two windows are the chat's.
 *
 * `convType` is what the chat IS ('server' for any channel). Pass `override`
 * from `parseRetentionOverride`.
 */
export function sweepPolicyFor(
    policy: StoragePolicy,
    convType: ConvType,
    override?: RetentionOverride | null,
): StoragePolicy {
    return {
        ...policy,
        messageRetention:    override?.messageRetention    ?? getEffectiveMessageRetention(policy, convType),
        attachmentRetention: override?.attachmentRetention ?? getEffectiveAttachmentRetention(policy, convType),
    };
}

/**
 * Message ids a SERVER CHANNEL sweep must never drop: the account's own "Save
 * for me" pins plus the server-saved / pinned set. Either kind exempts the
 * message locally (the server-saved row has `expires_at NULL` — the server
 * keeps it, so the client must too).
 */
export function pinnedIdsForChannel(
    localPins: readonly string[] | undefined,
    serverSaved: readonly string[] | undefined,
): Set<string> {
    return new Set<string>([...(localPins ?? []), ...(serverSaved ?? [])]);
}
