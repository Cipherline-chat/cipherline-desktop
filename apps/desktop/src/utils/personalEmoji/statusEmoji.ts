/**
 * Personal ("My Emojis") emoji as a CUSTOM STATUS emoji - DEVICE-ONLY.
 *
 * The status carries only the reference `cl:p_<32 hex>` (the id is the first 32
 * hex of SHA-256 of the image). The server stores that reference and NEVER the
 * image (owner decision 2026-10-24). The bytes live on devices:
 *
 *   - yours: in your own My Emojis library (already synced between your devices);
 *   - your friends': delivered by YOUR client, end-to-end encrypted, as a hidden
 *     control message (`shareStatusEmoji`), verified and filed in their
 *     received-emoji cache (`takeStatusEmoji`) - the same store a message's
 *     inline emoji lands in.
 *
 * Showing one is a local lookup only (`StatusPersonalEmoji`): a viewer who does
 * not hold the bytes - a non-friend, or not delivered yet - sees the status
 * text and NO emoji. There is no network fetch and the raw ref is never shown.
 *
 * ## Why `profile_update` carries it (old clients)
 *
 * A message type an old client does not know becomes an "Unsupported message
 * variant" row in the chat (desktop <= 1.0.22). `profile_update` is already a
 * control type those clients apply and drop without a row, and they ignore
 * fields they do not know, so the bytes ride in an extra `status_emoji` field
 * of a `profile_update` that names no avatar or banner (pinned by
 * statusEmojiOldClient.test.ts against the real receive path).
 *
 * Dependencies are injected so the logic is unit-tested without Electron.
 */

import { parseStatusEmoji } from '../customStatus';
import type { EmojiBlobStore } from './store';
import {
    PERSONAL_EMOJI_MAX_BYTES, bytesToB64, isPersonalEmojiId, sniffImageMime, validateWireEmoji,
} from './token';

/** What a status emoji may be (no JPEG, no SVG) - also the receive allow-list. */
export const STATUS_EMOJI_MIMES: readonly string[] = ['image/webp', 'image/png', 'image/gif'];

export const statusEmojiRef = (id: string): string => `cl:${id}`;

/** The personal id inside a status emoji value, or null (unicode / not personal). */
export function personalIdOfStatusEmoji(value: string | null | undefined): string | null {
    const p = parseStatusEmoji(value);
    return p?.kind === 'custom' && isPersonalEmojiId(p.ref) ? p.ref : null;
}

export type StatusEmojiChoice = { emoji: string } | { issue: string } | null;

/**
 * What the dialog does with an emoji-picker selection: a unicode pick is kept
 * as is; a My Emojis pick becomes `cl:<id>` unless its type is not allowed for
 * a status; anything else (a server emoji) is ignored.
 */
export function statusEmojiFromSelection(
    sel: { native?: string; id?: string },
    metaOf: (id: string) => { m: string } | undefined,
): StatusEmojiChoice {
    if (sel.native) return { emoji: sel.native };
    if (sel.id && isPersonalEmojiId(sel.id)) {
        const m = metaOf(sel.id);
        if (m && !STATUS_EMOJI_MIMES.includes(m.m)) return { issue: 'That emoji cannot be used in a status. Pick a PNG, WebP or GIF one.' };
        return { emoji: statusEmojiRef(sel.id) };
    }
    return null;
}

// ── The wire shape ───────────────────────────────────────────────────────────

/** The `status_emoji` field of a `profile_update`. */
export interface StatusEmojiWire { id: string; mime: string; animated: boolean; bytes_b64: string }

export interface StatusEmojiShareContent {
    client_msg_id: string;
    type: 'profile_update';
    /** The sender's own id (the receiver checks it against the envelope's sender). */
    user_id: string;
    status_emoji: StatusEmojiWire;
}

// ── Ledger: which friend already has which emoji ─────────────────────────────

/** emoji id -> friend user id -> when (ms) it was delivered. Device-local. */
export type StatusEmojiLedger = Record<string, Record<string, number>>;

/** A delivery older than this is re-sent when the status is next shared, so a
 *  friend whose received cache evicted it (or who got a new device) recovers. */
export const STATUS_EMOJI_LEDGER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LEDGER_MAX_EMOJIS = 100;

export function parseStatusEmojiLedger(raw: string | null | undefined): StatusEmojiLedger {
    if (!raw) return {};
    try {
        const v = JSON.parse(raw);
        if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
        const out: StatusEmojiLedger = {};
        for (const [id, friends] of Object.entries(v as Record<string, unknown>)) {
            if (!isPersonalEmojiId(id) || !friends || typeof friends !== 'object' || Array.isArray(friends)) continue;
            const row: Record<string, number> = {};
            for (const [uid, at] of Object.entries(friends as Record<string, unknown>)) {
                if (typeof at === 'number' && Number.isFinite(at)) row[uid] = at;
            }
            out[id] = row;
        }
        return out;
    } catch { return {}; }
}

export function ledgerHas(ledger: StatusEmojiLedger, id: string, friendId: string, now: number): boolean {
    const at = ledger[id]?.[friendId];
    return typeof at === 'number' && now - at < STATUS_EMOJI_LEDGER_TTL_MS;
}

/** A NEW ledger with the delivery recorded; expired rows dropped, bounded. */
export function ledgerRecord(ledger: StatusEmojiLedger, id: string, friendId: string, now: number): StatusEmojiLedger {
    const out: StatusEmojiLedger = {};
    for (const [eid, friends] of Object.entries(ledger)) {
        const kept = Object.fromEntries(Object.entries(friends).filter(([, at]) => now - at < STATUS_EMOJI_LEDGER_TTL_MS));
        if (Object.keys(kept).length > 0) out[eid] = kept;
    }
    out[id] = { ...(out[id] ?? {}), [friendId]: now };
    const ids = Object.keys(out);
    if (ids.length > LEDGER_MAX_EMOJIS) {
        const newest = (eid: string) => Math.max(...Object.values(out[eid]));
        for (const eid of ids.sort((a, b) => newest(a) - newest(b)).slice(0, ids.length - LEDGER_MAX_EMOJIS)) delete out[eid];
    }
    return out;
}

// ── Sending (to accepted friends only) ───────────────────────────────────────

export interface ShareTarget { userId: string; conversationId: string }

/** `skipped` = nothing to deliver to (a friend with no registered device): not recorded, not retried. */
/** Accepted friends that have a DM, one target each (a non-friend is never a target). */
export function statusEmojiTargets(
    friendIds: readonly string[],
    dms: readonly { conversationId: string; otherUserId: string | null | undefined }[],
): ShareTarget[] {
    const friends = new Set(friendIds);
    const out = new Map<string, ShareTarget>();
    for (const d of dms) {
        if (d.otherUserId && friends.has(d.otherUserId) && !out.has(d.otherUserId)) {
            out.set(d.otherUserId, { userId: d.otherUserId, conversationId: d.conversationId });
        }
    }
    return [...out.values()];
}

export type ShareSendResult = 'sent' | 'skipped' | 'failed' | 'throttled';

export interface ShareDeps {
    store: Pick<EmojiBlobStore, 'read' | 'meta'>;
    load(): StatusEmojiLedger;
    save(ledger: StatusEmojiLedger): void;
    /** Encrypt `content` for the target friend's devices and post it. */
    send(target: ShareTarget, content: StatusEmojiShareContent): Promise<ShareSendResult>;
    now(): number;
    sleep(ms: number): Promise<void>;
    newId(): string;
    cancelled?(): boolean;
}

/** Gap between two sends: `messages/send` is 5 per 3 s per user and the user's own chat shares it. */
export const STATUS_EMOJI_SEND_PACE_MS = 1_000;

export interface ShareOutcome {
    sent: string[];
    failed: string[];
    /** Stopped early or some failed: worth trying again later. */
    retry: boolean;
}

/**
 * Hand the emoji behind `emoji` to every target that has not been given it
 * (see the ledger). `targets` MUST already be accepted friends with a DM; this
 * does not decide who is a friend. A no-op for unicode / empty statuses, for
 * an emoji this device does not hold, and when everyone already has it (the
 * bytes are not even read then).
 */
export async function shareStatusEmoji(
    emoji: string | null | undefined,
    myUserId: string,
    targets: readonly ShareTarget[],
    deps: ShareDeps,
): Promise<ShareOutcome> {
    const out: ShareOutcome = { sent: [], failed: [], retry: false };
    const id = personalIdOfStatusEmoji(emoji);
    if (!id) return out;
    const seen = new Set<string>();
    const pending = targets.filter(t => {
        if (t.userId === myUserId || seen.has(t.userId)) return false;
        seen.add(t.userId);
        return !ledgerHas(deps.load(), id, t.userId, deps.now());
    });
    if (pending.length === 0) return out;

    let bytes: Uint8Array | null = null;
    try { bytes = await deps.store.read(id); } catch { bytes = null; }
    // Not on this device (yet): the library sync may still be landing - try again later.
    if (!bytes) { out.retry = true; return out; }
    const mime = sniffImageMime(bytes);
    if (!mime || !STATUS_EMOJI_MIMES.includes(mime) || bytes.length > PERSONAL_EMOJI_MAX_BYTES) return out;
    const content: StatusEmojiShareContent = {
        client_msg_id: deps.newId(),
        type: 'profile_update',
        user_id: myUserId,
        status_emoji: { id, mime, animated: deps.store.meta(id)?.a === 1, bytes_b64: bytesToB64(bytes) },
    };

    for (let i = 0; i < pending.length; i++) {
        if (deps.cancelled?.()) { out.retry = true; break; }
        if (i > 0) await deps.sleep(STATUS_EMOJI_SEND_PACE_MS);
        const t = pending[i];
        let r: ShareSendResult;
        try { r = await deps.send(t, content); } catch { r = 'failed'; }
        if (r === 'sent') {
            // Saved per friend, so a crash or a rate limit midway keeps what was delivered.
            deps.save(ledgerRecord(deps.load(), id, t.userId, deps.now()));
            out.sent.push(t.userId);
        } else if (r !== 'skipped') {
            out.failed.push(t.userId);
            if (r === 'throttled') { out.retry = true; break; }
        }
    }
    if (out.failed.length > 0) out.retry = true;
    return out;
}

// ── Receiving ────────────────────────────────────────────────────────────────

export interface TakeStatusEmojiCtx {
    /** The envelope's (sealed, signed) sender. */
    senderUserId: string | null | undefined;
    myUserId: string;
    /** Accepted friends only: a stranger's bytes are never filed. */
    isFriend(userId: string): boolean;
    store: Pick<EmojiBlobStore, 'put'>;
}

type AnyContent = Record<string, unknown>;

export interface TakeStatusEmojiResult<T> {
    /** `content` minus `status_emoji` (the SAME object when it had none). */
    content: T;
    /** Resolves to the filed id, or null when rejected. Never rejects. */
    stored: Promise<string | null>;
}

/**
 * Strip and ingest. The strip is synchronous (the bytes never reach the thread,
 * the carry buffer or a backup); filing is background work and the status emoji
 * component re-resolves when the store notifies.
 *
 * The sender is untrusted: only a `profile_update` from an accepted friend
 * other than us, naming its own user id, counts; the bytes must hash to the id
 * (`validateWireEmoji`), be WebP/PNG/GIF by magic bytes (SVG, JPEG and anything
 * else refused) and fit the size cap.
 */
export function takeStatusEmoji<T>(content: T, ctx: TakeStatusEmojiCtx): TakeStatusEmojiResult<T> {
    if (!content || typeof content !== 'object' || (content as AnyContent).type !== 'profile_update' || !('status_emoji' in (content as AnyContent))) {
        return { content, stored: Promise.resolve(null) };
    }
    const { status_emoji: raw, ...rest } = content as AnyContent;
    const stored = (async (): Promise<string | null> => {
        const sender = ctx.senderUserId;
        if (!sender || sender === ctx.myUserId || !ctx.isFriend(sender)) return null;
        if (rest.user_id !== undefined && rest.user_id !== null && rest.user_id !== sender) return null;
        if (!raw || typeof raw !== 'object') return null;
        const v = await validateWireEmoji({ ...(raw as object), name: 'status' });
        if ('rejected' in v || !STATUS_EMOJI_MIMES.includes(v.mime)) return null;
        try {
            await ctx.store.put(v.id, v.bytes, { mime: v.mime, animated: v.animated, name: 'status' });
        } catch { return null; }
        return v.id;
    })().catch(() => null);
    return { content: rest as T, stored };
}
