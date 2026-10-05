import type { StoragePolicy } from '../hooks/useRetentionPolicy';
import { attachmentRetentionMs, messageRetentionMs, UNSAVE_EXPIRY_MS } from '../hooks/useRetentionPolicy';

export interface SweepResult {
    prunedState: Record<string, any[]>;
    attachmentsToDelete: string[];
    /**
     * Per-conversation/channel list of the message ids this sweep dropped.
     *
     * DM callers can ignore it — a delivered DM envelope is deleted server-side
     * on ACK, so nothing can hand a purged DM message back. SERVER CHANNEL
     * callers must NOT: the `channel_messages` row outlives the local cache, so
     * without recording what was purged the next history fetch re-inserts it
     * (utils/retentionTombstones.ts + foldChannelHistory's `purgedIds`).
     *
     * Only contains conversations that actually changed, and only ids the
     * sweeper could see (a message with no `id` is dropped but unrecordable —
     * it also cannot be re-identified on a later fetch, so there is nothing to
     * record).
     */
    purgedMessageIds: Record<string, string[]>;
}

/**
 * Content types that are never a chat row of their own: they act on another
 * row (edit / delete / reaction), on a pin ledger or profile, or carry channel
 * key material through a different pipeline. They are not user-visible
 * messages, so retention has nothing to say about them, and — importantly —
 * deleting one that a thread happens to hold could un-apply the change it made
 * (an old build stored delete markers as rows). Keep them untouched.
 */
const CONTROL_TYPES: ReadonlySet<string> = new Set([
    'edit', 'delete', 'reaction', 'pin',
    'profile_update', 'group_update',
    'channel_key', 'channel_message',
]);

/**
 * Which retention rule a stored row falls under.
 *   - 'attachment' → the attachment window (+ blob cleanup)
 *   - 'message'    → the message window: EVERY other visible row — text,
 *                    server_invite, safety_number, system, call_event and
 *                    the DM call bar (`call_key`, which also carries the call's
 *                    media key and so must not outlive its window), and any
 *                    variant a newer build adds. An allow-list here is how
 *                    `server_invite` / `safety_number` / `call_key` rows ended
 *                    up shown with a "Deletes in …" countdown and never deleted.
 *   - 'keep'       → control rows (above) and rows with no readable type.
 */
export function retentionRuleFor(type: unknown): 'attachment' | 'message' | 'keep' {
    if (typeof type !== 'string' || !type) return 'keep';
    if (type === 'attachment') return 'attachment';
    if (CONTROL_TYPES.has(type)) return 'keep';
    return 'message';
}

export function msgTimestamp(m: any): number {
    // Messages arrive with various timestamp field names throughout the codebase.
    // Fall back through the likely candidates and finally Date.now() so we never
    // accidentally treat an undated message as "infinitely old".
    const t = m?.timestamp ?? m?.sent_at ?? m?.created_at ?? m?.received_at ?? null;
    if (!t) return Date.now();
    if (typeof t === 'number') return t;
    const parsed = Date.parse(t);
    return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * A DM / group message's timestamp is the SENDER'S clock (`sent_at_client`). The
 * retention window is measured from it, so a timestamp in the future - a skewed
 * clock, or a sender who simply wants the message to outlive the recipient's
 * "Keep for" setting - would keep it until that date plus the whole window.
 * Clamp anything more than `skewMs` ahead of the moment of receipt back to the
 * moment of receipt. (A timestamp in the PAST is left alone: that message
 * really is that old, and a message queued while this device was offline should
 * expire on schedule, not get a fresh window for having been delivered late.)
 */
export function clampFutureTimestamp(
    ts: string | number | null | undefined,
    now: number = Date.now(),
    skewMs: number = 5 * 60_000,
): string {
    const parsed = typeof ts === 'number' ? ts : (ts ? Date.parse(ts) : NaN);
    if (!Number.isFinite(parsed) || parsed > now + skewMs) return new Date(now).toISOString();
    return typeof ts === 'string' ? ts : new Date(parsed).toISOString();
}

/**
 * Pure retention sweeper — returns a new messagesState with expired entries
 * removed plus a list of remote attachment IDs that should be deleted server-side.
 *
 * Rules:
 *   - Pending optimistic messages (msg._pending === true) are never swept.
 *   - Pinned messages (msgId in pinnedIds) are never swept — pin = save forever.
 *   - Text messages older than getMessageExpiryMs() are dropped.
 *   - Attachment messages:
 *       - In savedAttachmentIds → always kept.
 *       - Policy 'never' AND not in unsavedAttachmentIds → kept.
 *       - Otherwise compared against getAttachmentExpiryMs(); expired → dropped
 *         and the attachment_id is pushed to attachmentsToDelete.
 *   - If nothing changes, the original state reference is returned so callers
 *     can bail out of setState calls cheaply via identity comparison.
 */
export function sweepRetention(
    state: Record<string, any[]>,
    policy: StoragePolicy,
    now: number = Date.now(),
    /** Per-conversation set of message IDs that are pinned. Pinned = save-forever:
     *  the sweeper will never drop these regardless of retention rules. Caller
     *  passes the union of (DM/group pin map) ∪ (channel local pins) ∪ (server
     *  saved pin IDs) for the conversation/channel being swept. Optional —
     *  defaults to no pins for backwards compatibility. */
    pinnedIdsByConv: Record<string, Set<string>> = {},
): SweepResult {
    const attachmentExpiry = attachmentRetentionMs(policy.attachmentRetention);
    const messageExpiry    = messageRetentionMs(policy.messageRetention);
    const attachmentsToDelete: string[] = [];

    let changed = false;
    const out: Record<string, any[]> = {};
    const purgedMessageIds: Record<string, string[]> = {};

    for (const [convId, msgs] of Object.entries(state)) {
        if (!Array.isArray(msgs)) {
            out[convId] = msgs as any;
            continue;
        }

        let convChanged = false;
        const kept: any[] = [];
        const purged: string[] = [];
        const pinnedForConv = pinnedIdsByConv[convId];

        /** Record a drop. Every "this message expired" branch goes through
         *  here so a new rule can't add a silent, un-tombstoned deletion. */
        const drop = (id: string | undefined) => {
            convChanged = true;
            if (id) purged.push(id);
        };

        for (const msg of msgs) {
            if (msg?._pending) {
                // Defensive: a message marked _pending should never block deletion
                // forever. No code currently writes _pending, but if a future
                // code path sets it and forgets to clear, we don't want stuck
                // un-sweepable messages.  Skip the sweep only for the first 24h
                // of pending; after that, fall through to normal retention rules.
                const pendingMs = now - msgTimestamp(msg);
                if (pendingMs < 24 * 60 * 60_000) {
                    kept.push(msg);
                    continue;
                }
                // else fall through — almost certainly orphaned state.
            }

            const type  = msg?.content?.type;
            const msgId: string | undefined = msg?.id;

            // Pin = save forever. Pinned messages bypass all retention rules,
            // including time-based expiry and policy='1wk'/'1mo'/etc.
            if (msgId && pinnedForConv?.has(msgId)) {
                kept.push(msg);
                continue;
            }

            const rule = retentionRuleFor(type);

            // Apply the text-message retention rules to every visible non-file
            // row: text, GIFs, invites, safety numbers, transient system
            // events ("call ended", "member joined / left"), the DM call bar.
            // They render as chat lines, count toward purge counts, and expire
            // on the same cadence as normal text — otherwise a month-old
            // conversation keeps dozens of dead stubs (and, for `call_key`,
            // a call media key) forever.
            if (rule === 'message') {
                // A KLIPY GIF is media: it follows the ATTACHMENT window (owner's
                // call - a chat's GIFs should age with its files, not its text).
                // It has no attachment id and no blob, so its saved / unsaved
                // state is still tracked by MESSAGE id; only the window differs.
                const windowMs = type === 'klipy_gif' ? attachmentExpiry : messageExpiry;
                // Explicitly unsaved: honour the 24-hour grace period measured from
                // the moment unsave was clicked (not from sentAt).
                // Effective expiry = max(natural window end, unsavedAt + 24h) so that
                // messages still inside their natural window expire at the natural time.
                if (msgId && policy.unsavedMessageIds.includes(msgId)) {
                    const sentMs      = msgTimestamp(msg);
                    const unsavedAt   = policy.unsavedMessageTimestamps?.[msgId] ?? sentMs;
                    const graceExpiry = unsavedAt + UNSAVE_EXPIRY_MS;
                    const effectiveExpiry = windowMs === Number.POSITIVE_INFINITY
                        ? graceExpiry
                        : Math.max(sentMs + windowMs, graceExpiry);
                    if (now < effectiveExpiry) {
                        kept.push(msg);
                    } else {
                        drop(msgId);
                    }
                    continue;
                }
                // Explicit save-forever.
                if (msgId && policy.savedMessageIds.includes(msgId)) {
                    kept.push(msg);
                    continue;
                }
                // Fall back to global message retention.
                const age = now - msgTimestamp(msg);
                if (windowMs === Number.POSITIVE_INFINITY || age < windowMs) {
                    kept.push(msg);
                } else {
                    drop(msgId);
                }
                continue;
            }

            if (rule === 'attachment') {
                const attId: string | undefined = msg?.content?.attachment_id;

                // Explicitly unsaved: same grace-period logic as text messages.
                if (attId && policy.unsavedAttachmentIds.includes(attId)) {
                    const sentMs      = msgTimestamp(msg);
                    const unsavedAt   = policy.unsavedAttachmentTimestamps?.[attId] ?? sentMs;
                    const graceExpiry = unsavedAt + UNSAVE_EXPIRY_MS;
                    const effectiveExpiry = attachmentExpiry === Number.POSITIVE_INFINITY
                        ? graceExpiry
                        : Math.max(sentMs + attachmentExpiry, graceExpiry);
                    if (now < effectiveExpiry) {
                        kept.push(msg);
                    } else {
                        attachmentsToDelete.push(attId);
                        drop(msgId);
                    }
                    continue;
                }

                // Saved-for-life list.
                if (attId && policy.savedAttachmentIds.includes(attId)) {
                    kept.push(msg);
                    continue;
                }

                // Under "never" with no explicit unsave → keep.
                if (policy.attachmentRetention === 'never') {
                    kept.push(msg);
                    continue;
                }

                // Timed retention
                const age = now - msgTimestamp(msg);
                if (attachmentExpiry === Number.POSITIVE_INFINITY || age < attachmentExpiry) {
                    kept.push(msg);
                } else {
                    if (attId) attachmentsToDelete.push(attId);
                    drop(msgId);
                }
                continue;
            }

            // Control rows (edit, delete, reaction, pin, profile_update …) and
            // rows with no readable type are kept untouched — see CONTROL_TYPES.
            kept.push(msg);
        }

        if (convChanged) {
            out[convId] = kept;
            changed = true;
            if (purged.length) purgedMessageIds[convId] = purged;
        } else {
            out[convId] = msgs;
        }
    }

    return {
        prunedState: changed ? out : state,
        attachmentsToDelete,
        purgedMessageIds,
    };
}
