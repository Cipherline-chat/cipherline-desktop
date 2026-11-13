/**
 * The ACTIVITY KEY behind friends' end-to-end encrypted Spotify covers
 * (activityCover.ts): who holds which key, how it reaches them, and when it
 * rotates.
 *
 * ## The model
 *
 * Each sharing DEVICE has one random AES-256 key (`kid` = its 8-byte id). It
 * hands that key to each ACCEPTED FRIEND once, as a hidden control message -
 * a `profile_update` with an extra `activity_key` field - sealed in the
 * ordinary per-device E2EE envelope over the DM they share (friendControlSend
 * .ts). The server relays ciphertext and never sees the key. Every cover the
 * device uploads afterwards is encrypted under that key, so a track change
 * costs ONE small upload, not one message per friend per device.
 *
 * Rotation (a fresh key, delivered again to every current friend):
 *  - when anyone the key was delivered to is no longer an accepted friend
 *    (unfriended or blocked) - they keep the OLD key, which opens only covers
 *    made before the rotation, and those are gone from the server within one
 *    record lifetime (~150 s) and were never served to non-friends anyway;
 *  - every ACTIVITY_KEY_MAX_AGE_MS (7 days), which also re-delivers to a
 *    friend's newly added device.
 *
 * Why `profile_update` (old clients): a brand-new content type would render
 * as "Unsupported message variant" on desktop <= 1.0.22; `profile_update` is
 * applied and dropped without a chat row there, and the unknown field is
 * ignored (activityKeyOldClient.test.ts pins this against the real receive
 * path, as statusEmojiOldClient.test.ts does for `status_emoji`). The field is
 * not part of packages/shared's ClientContent: the API never parses message
 * content, and the desktop strips it (takeActivityKey) before anything else
 * sees the message.
 *
 * Receiving: only from an accepted friend, only naming the sender's own id,
 * only a well-formed 32-byte key; filed per sharer (newest few, so a sharer
 * with several devices is covered), in secureLocalStore (encrypted at rest).
 * Never backed up (backupRegistry.ts): keys rotate, and arrive again.
 */
import secureLocalStore from '../secureLocalStore';
import { isActivityKey, newActivityKey } from './activityCover';

export const ACTIVITY_KEY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Keys kept per sharer (one per sharing device, plus a rotation's overlap). */
export const FRIEND_KEYS_PER_SHARER = 6;
const MAX_SHARERS = 1000;
/** Gap between two key deliveries: messages/send is 5 per 3 s per user and chat shares it. */
export const ACTIVITY_KEY_SEND_PACE_MS = 1_000;

export const ownActivityKeyStoreKey = (userId: string) => `cipherline_activity_key_${userId}`;
export const friendActivityKeysStoreKey = (userId: string) => `cipherline_friend_activity_keys_${userId}`;

// ── The sharer's own key ─────────────────────────────────────────────────────

export interface OwnActivityKey {
    kid: string;
    keyB64: string;
    createdAt: number;
    /** friend user id -> when (ms) this key was delivered to them. */
    ledger: Record<string, number>;
}

export function parseOwnActivityKey(raw: string | null | undefined): OwnActivityKey | null {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw) as Record<string, unknown>;
        if (!v || typeof v !== 'object' || !isActivityKey(v.kid, v.keyB64) || typeof v.createdAt !== 'number') return null;
        const ledger: Record<string, number> = {};
        if (v.ledger && typeof v.ledger === 'object' && !Array.isArray(v.ledger)) {
            for (const [id, at] of Object.entries(v.ledger as Record<string, unknown>)) {
                if (typeof at === 'number' && Number.isFinite(at)) ledger[id] = at;
            }
        }
        return { kid: v.kid as string, keyB64: v.keyB64 as string, createdAt: v.createdAt, ledger };
    } catch { return null; }
}

/**
 * Whether this account's encrypted records are bound yet (secureLocalStore
 * re-binds per account right after a sign-in): before that a read is empty and
 * would look like "no key", so nothing here creates, rotates or files a key.
 */
export function keyStoreReady(userId: string): boolean {
    const s = secureLocalStore as unknown as { isAccountReady?: (id: string) => boolean };
    return typeof s.isAccountReady !== 'function' || s.isAccountReady(userId);
}

const loadOwn = (userId: string) => parseOwnActivityKey(secureLocalStore.getItem(ownActivityKeyStoreKey(userId)));
// Literal keys at the call sites: services/backupRegistry.test.ts scans for them.
const saveOwn = (userId: string, k: OwnActivityKey) => secureLocalStore.setItem(`cipherline_activity_key_${userId}`, JSON.stringify(k));

/** Whether `k` must be replaced: none yet, too old, or held by someone who is no longer a friend. */
export function needsRotation(k: OwnActivityKey | null, friendIds: ReadonlySet<string>, now: number): boolean {
    if (!k) return true;
    if (now - k.createdAt >= ACTIVITY_KEY_MAX_AGE_MS || now < k.createdAt) return true;
    return Object.keys(k.ledger).some(id => !friendIds.has(id));
}

/**
 * The key to encrypt with NOW, for an audience of `friendIds` (accepted
 * friends, as currently known). Rotates - and persists the new key - when
 * needsRotation says so. The caller must not pass an unknown (still loading)
 * friends list: see activityAudience().
 */
export function currentActivityKey(
    userId: string, friendIds: readonly string[], now: number, gen: () => { kid: string; keyB64: string } = newActivityKey,
): OwnActivityKey {
    const k = loadOwn(userId);
    if (k && !needsRotation(k, new Set(friendIds), now)) return k;
    const fresh: OwnActivityKey = { ...gen(), createdAt: now, ledger: {} };
    saveOwn(userId, fresh);
    notify();
    return fresh;
}

function markDelivered(userId: string, kid: string, friendId: string, now: number): void {
    const k = loadOwn(userId);
    // A rotation in between: the delivery was of a key no longer in use - not recorded.
    if (!k || k.kid !== kid) return;
    saveOwn(userId, { ...k, ledger: { ...k.ledger, [friendId]: now } });
}

// ── The audience the cover publisher may encrypt for ─────────────────────────

let audience: readonly string[] | null = null;

/**
 * Set by useActivityKeyShare from the accepted-friends list (null while it is
 * not known, or while sharing is off). The cover publisher uploads nothing
 * while it is null or empty: there is nobody the cover is for, and a key
 * check against an unknown list could miss an unfriend.
 */
export function setActivityAudience(ids: readonly string[] | null): void { audience = ids ? [...ids] : null; }
export const activityAudience = (): readonly string[] | null => audience;

// ── Delivering the key to friends ────────────────────────────────────────────

export interface ActivityKeyWire { kid: string; key_b64: string }

export interface ActivityKeyShareContent {
    client_msg_id: string;
    type: 'profile_update';
    /** The sender's own id (the receiver checks it against the envelope's sender). */
    user_id: string;
    activity_key: ActivityKeyWire;
}

export interface KeyShareTarget { userId: string; conversationId: string }
export type KeySendResult = 'sent' | 'skipped' | 'failed' | 'throttled';

export interface KeyShareDeps {
    send(target: KeyShareTarget, content: ActivityKeyShareContent): Promise<KeySendResult>;
    now(): number;
    sleep(ms: number): Promise<void>;
    newId(): string;
    cancelled?(): boolean;
}

export interface KeyShareOutcome { kid: string; sent: string[]; failed: string[]; retry: boolean }

/**
 * Make sure every target (accepted friends with a DM; `friendIds` is the
 * whole accepted list) holds this device's CURRENT key, rotating first when
 * needed. Friends already holding it are skipped without any network call.
 */
export async function shareActivityKey(
    myUserId: string, friendIds: readonly string[], targets: readonly KeyShareTarget[], deps: KeyShareDeps,
): Promise<KeyShareOutcome> {
    if (!keyStoreReady(myUserId)) return { kid: '', sent: [], failed: [], retry: true };
    const key = currentActivityKey(myUserId, friendIds, deps.now());
    const out: KeyShareOutcome = { kid: key.kid, sent: [], failed: [], retry: false };
    const friends = new Set(friendIds);
    const seen = new Set<string>();
    const pending = targets.filter(t => {
        if (t.userId === myUserId || seen.has(t.userId) || !friends.has(t.userId)) return false;
        seen.add(t.userId);
        return !(t.userId in key.ledger);
    });
    const content: ActivityKeyShareContent = {
        client_msg_id: deps.newId(), type: 'profile_update', user_id: myUserId,
        activity_key: { kid: key.kid, key_b64: key.keyB64 },
    };
    for (let i = 0; i < pending.length; i++) {
        if (deps.cancelled?.()) { out.retry = true; break; }
        if (i > 0) await deps.sleep(ACTIVITY_KEY_SEND_PACE_MS);
        const t = pending[i];
        let r: KeySendResult;
        try { r = await deps.send(t, { ...content, client_msg_id: i === 0 ? content.client_msg_id : deps.newId() }); } catch { r = 'failed'; }
        if (r === 'sent') {
            markDelivered(myUserId, key.kid, t.userId, deps.now());
            out.sent.push(t.userId);
        } else if (r !== 'skipped') {
            out.failed.push(t.userId);
            if (r === 'throttled') { out.retry = true; break; }
        }
    }
    if (out.failed.length > 0) out.retry = true;
    return out;
}

// ── Friends' keys, on this device ────────────────────────────────────────────

interface FiledKey { kid: string; key: string; at: number }
type FriendKeys = Record<string, FiledKey[]>;

function loadFriendKeys(myUserId: string): FriendKeys {
    try {
        const v = JSON.parse(secureLocalStore.getItem(friendActivityKeysStoreKey(myUserId)) ?? '{}') as unknown;
        if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
        const out: FriendKeys = {};
        for (const [id, list] of Object.entries(v as Record<string, unknown>)) {
            if (!Array.isArray(list)) continue;
            const ok = list.filter((k): k is FiledKey => !!k && typeof k === 'object' && isActivityKey(k.kid, k.key) && typeof k.at === 'number');
            if (ok.length > 0) out[id] = ok;
        }
        return out;
    } catch { return {}; }
}

/** The key `sharerUserId` delivered to this device under `kid`, or null. */
export function friendActivityKey(myUserId: string, sharerUserId: string, kid: string): string | null {
    return loadFriendKeys(myUserId)[sharerUserId]?.find(k => k.kid === kid)?.key ?? null;
}

/** File a friend's key: newest first, a few per sharer, a bounded number of sharers. */
export function fileFriendActivityKey(myUserId: string, sharerUserId: string, kid: string, keyB64: string, now: number): boolean {
    if (!isActivityKey(kid, keyB64)) return false;
    const all = loadFriendKeys(myUserId);
    const list = [{ kid, key: keyB64, at: now }, ...(all[sharerUserId] ?? []).filter(k => k.kid !== kid)].slice(0, FRIEND_KEYS_PER_SHARER);
    all[sharerUserId] = list;
    const ids = Object.keys(all);
    if (ids.length > MAX_SHARERS) {
        const newest = (id: string) => all[id][0]?.at ?? 0;
        for (const id of ids.sort((a, b) => newest(a) - newest(b)).slice(0, ids.length - MAX_SHARERS)) delete all[id];
    }
    secureLocalStore.setItem(`cipherline_friend_activity_keys_${myUserId}`, JSON.stringify(all));
    notify();
    return true;
}

export interface TakeActivityKeyCtx {
    /** The envelope's (sealed, signed) sender. */
    senderUserId: string | null | undefined;
    myUserId: string;
    /** Accepted friends only: a stranger's key is never filed. */
    isFriend(userId: string): boolean;
    /**
     * Whether the accepted-friends list has loaded. A device that was closed
     * when the key was sent pulls it at start-up, usually BEFORE /friends has
     * answered: `isFriend` is then false for everyone, and the key (already
     * acked, so never re-sent: the sender's ledger says delivered) would be
     * thrown away - no key, no cover, until the 7-day rotation. While this
     * says false the key is PARKED (in memory) instead and filed by
     * releaseParkedActivityKeys once the list is known. Omitted = known.
     */
    friendsLoaded?(): boolean;
    now?(): number;
}

interface Parked { myUserId: string; sender: string; kid: string; keyB64: string; at: number }
const MAX_PARKED = 64;
let parked: Parked[] = [];

/**
 * Keys that arrived before the friends list (or the account's encrypted store)
 * was ready: file those from accepted friends, drop the rest. Call whenever
 * the friends list changes. Returns how many were filed.
 */
export function releaseParkedActivityKeys(myUserId: string, isFriend: (id: string) => boolean): number {
    if (parked.length === 0) return 0;
    if (!keyStoreReady(myUserId)) return 0;
    const mine = parked.filter(k => k.myUserId === myUserId);
    parked = [];
    let filed = 0;
    for (const k of mine) {
        try { if (isFriend(k.sender) && fileFriendActivityKey(myUserId, k.sender, k.kid, k.keyB64, k.at)) filed += 1; } catch { /* a bad key never blocks the rest */ }
    }
    return filed;
}

/** Sign-out / account switch. */
export function clearParkedActivityKeys(): void { parked = []; }

/**
 * Strip and file. Synchronous: the key never reaches the thread, the carry
 * buffer or a backup (the content is returned WITHOUT `activity_key`, the
 * SAME object when it had none). Only a `profile_update` from an accepted
 * friend other than us, naming its own id, with a well-formed key is filed.
 */
export function takeActivityKey<T>(content: T, ctx: TakeActivityKeyCtx): T {
    if (!content || typeof content !== 'object' || (content as Record<string, unknown>).type !== 'profile_update' || !('activity_key' in (content as object))) {
        return content;
    }
    const { activity_key: raw, ...rest } = content as Record<string, unknown>;
    try {
        const sender = ctx.senderUserId;
        const known = ctx.friendsLoaded ? ctx.friendsLoaded() : true;
        const wellFormed = !!sender && sender !== ctx.myUserId
            && (rest.user_id === undefined || rest.user_id === null || rest.user_id === sender)
            && !!raw && typeof raw === 'object';
        const w = raw as Record<string, unknown>;
        const at = ctx.now?.() ?? Date.now();
        if (wellFormed && !known) {
            // Not yet knowable whether the sender is a friend: hold the key (validated again on release).
            if (isActivityKey(w.kid, w.key_b64)) {
                parked = [...parked.filter(k => !(k.myUserId === ctx.myUserId && k.sender === sender && k.kid === w.kid)), { myUserId: ctx.myUserId, sender: sender!, kid: w.kid as string, keyB64: w.key_b64 as string, at }].slice(-MAX_PARKED);
            }
        } else if (wellFormed && ctx.isFriend(sender!)) {
            if (keyStoreReady(ctx.myUserId)) fileFriendActivityKey(ctx.myUserId, sender!, w.kid as string, w.key_b64 as string, at);
            else if (isActivityKey(w.kid, w.key_b64)) parked = [...parked, { myUserId: ctx.myUserId, sender: sender!, kid: w.kid as string, keyB64: w.key_b64 as string, at }].slice(-MAX_PARKED);
        }
    } catch { /* never let a bad key break the pull loop */ }
    return rest as T;
}

// ── Change notifications (a friend's cover retries once their key lands) ─────

let version = 0;
const subs = new Set<() => void>();
function notify() { version += 1; for (const s of subs) s(); }
export const activityKeysVersion = (): number => version;
export function subscribeActivityKeys(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }
