/**
 * Session cache for peer IDENTITY — "who is this person, and which attachment
 * is their picture".
 *
 * ── The bug this exists to fix ──────────────────────────────────────────────
 * `useEncryptedAvatar` caches the decrypted BLOB (memory → IndexedDB → network)
 * and does it well: switching between two chats four times downloads each
 * avatar exactly once. What was never cached is the other half of the lookup —
 * the *attachment id* that tells a message row which blob to ask for, and the
 * *username* that tells it whose row this is.
 *
 * Dashboard keys ChatPane's wrapper on `activeChat.id`, so ChatPane fully
 * unmounts and remounts on every conversation switch. Its `deviceToAvatar` /
 * `userIdToAvatar` / `deviceToUsername` / `userIdToUsername` maps are plain
 * `useState({})`, so every switch reset all four to empty and re-derived them
 * from a fresh `GET /conversations/:id/devices`. For the ~100-300 ms that
 * round-trip takes, every message row rendered the deterministic-colour
 * silhouette and the literal words "Unknown User" — for people the client had
 * fully resolved seconds earlier.
 *
 * Measured over a chat-A → B → A → B walk: 0 of 10 avatar mounts and 0 of 10
 * name mounts resolved on first paint, despite 0 redundant avatar downloads.
 * That is the "it loads everyone's profile pictures every time" the owner sees
 * — a paint-timing bug caused by an uncached IDENTITY, not by a cold blob
 * cache — and the name flash is the same bug wearing a different symptom.
 *
 * Seeding the maps from this module makes both facts available synchronously
 * at mount, which makes `useEncryptedAvatar`'s `useState` initialiser hit the
 * warm memory cache on the first render and the name render correctly on the
 * first render.
 *
 * ── One record per identity, deliberately ───────────────────────────────────
 * The avatar id and the display name live in ONE entry keyed by user (and one
 * keyed by device), rather than in four independent maps. Two reasons:
 *
 *   - The bound then counts PEOPLE. Four separately-capped maps would let the
 *     cache hold 4x the cap in entries, and the number would stop meaning
 *     anything a reader can reason about.
 *   - Eviction drops a person whole. Half-evicting someone — a name with no
 *     avatar, or the reverse — produces a row that is partly warm and partly
 *     cold, which is a worse and much stranger flash than being uniformly
 *     cold.
 *
 * ── It persists now, and that reversed an earlier decision ──────────────────
 * This block used to read "**In memory only.** Never persisted." — on the
 * grounds that the mapping is social-graph-adjacent metadata and costs nothing
 * to rebuild. The first half is still true and shapes everything below; the
 * second half was measured false one level up from the chat-switch bug.
 *
 * A restart drops these maps, so every row starts idless again and the owner
 * watches the same silhouette-then-fade he was told had been fixed. Rebuilding
 * "costs nothing" only in REQUESTS — it costs a round-trip of wrong-looking UI
 * on the first screen after every boot, which is the whole complaint.
 * `restartFirstPaint.test.ts` measures it: the blobs are still on disk (a
 * restarted session downloads NOTHING), and 0 of 3 rows paint a picture.
 *
 * So the maps are written to `secureLocalStore` under
 * `cipherline_peer_identity_{uid}` — AES-256-GCM at rest, keyed per account by
 * HKDF(master, userId), exactly like every other on-device record. The
 * metadata never leaves the device: it is deliberately EXCLUDED from the
 * encrypted backup (`backupRegistry.ts`), because a backup file travels — to
 * Drive, to a folder the user copies — and a social-graph map has no business
 * travelling to buy back something one directory fetch reproduces. The blob
 * cache it pairs with is not backed up either, so restoring these ids onto a
 * fresh device would restore the metadata and none of the experience.
 *
 * ── Deliberate properties ───────────────────────────────────────────────────
 * - **Account-scoped, and cleared on a switch.** `hydratePeerIdentityCache`
 *   drops the in-memory maps synchronously before loading the next account, so
 *   account A's peers are never seeded into B's panes and never written into
 *   B's record. Nothing is written at all until the store reports
 *   `isAccountReady(userId)` — per-account records are cold right after an
 *   explicit sign-in, and writing through that window is the documented shape
 *   that wiped pins and ignored-games.
 * - **Hydration never dirties.** Loading from disk writes straight into the
 *   maps rather than going through the setters, so a boot can never re-persist
 *   what it just read (and can never rewrite `savedAt` for a record it is about
 *   to expire).
 * - **Ids and usernames only — never blobs, keys, or nicknames.** Nothing here
 *   is secret and nothing here bypasses a gate: `EncryptedAvatar`'s friend gate
 *   still decides whether an avatar id is resolved at all, the server still
 *   authorises every key/download, and a username is already visible to anyone
 *   who can see the message it labels. Server NICKNAMES are deliberately out of
 *   scope — see the precedence note below.
 * - **Self-healing, not authoritative — and that is what bounds staleness.**
 *   Every caller that seeds from here also merges the fresh server response
 *   over the top, and the `avatar:updated` / `user:username_updated` WS events
 *   patch it live (and now write through to disk), so a peer who changed their
 *   picture or handle while the pane was unmounted corrects within the same one
 *   round-trip it took before this cache existed. A change made while the app
 *   was CLOSED misses the WS event entirely, and that case is covered by the
 *   same merge: the next `/conversations/:id/devices`, `/servers/:id/members`
 *   or `/auth/users/:id` response overwrites the id and the new value is
 *   persisted. A stale id therefore survives exactly one round-trip, never
 *   indefinitely, and a deleted avatar clears the facet outright.
 * - **No new server contract.** Every field cached here comes from a response
 *   shape the API has always returned (`username` and `avatar_url` on
 *   `/conversations/:id/devices`, `/servers/:id/members`, `/auth/users/:id`).
 *   Nothing here assumes a field a deployed server might not send yet, and
 *   every setter treats a missing value as "learned nothing".
 * - **Bounded twice, with different numbers and different reasons.** In memory:
 *   insertion-ordered eviction at MAX_ENTRIES per map. On disk:
 *   MAX_PERSISTED_ENTRIES per map (the youngest, since a touch re-inserts) plus
 *   a PERSIST_TTL_MS age bound on the record as a whole. Both disk numbers are
 *   deliberately copied from `pruneAvatarCache`'s 500 entries / 90 days: an id
 *   whose blob that pruner has already evicted is worth nothing on the next
 *   boot except a stale-id risk, so there is no reason for the two stores to
 *   disagree about how much history to keep.
 *
 * ── Precedence: this cache NEVER outranks a nickname ────────────────────────
 * ChatPane resolves an author's label as
 *   server nickname → device username → account username → "Unknown User".
 * The nickname comes from `serverMemberNicknames`, a PROP owned by Dashboard,
 * so it survives ChatPane's remount and is consulted before either map this
 * cache seeds. This cache therefore feeds only the second and third slots —
 * exactly the ones the network fetch used to fill — and cannot promote an
 * account username over a nickname that should win. Nicknames are also never
 * WRITTEN here: every source that feeds this cache supplies the account
 * username, so there is no path by which a server-scoped nickname could leak
 * into a cross-server cache and mislabel someone in another server.
 */

import secureLocalStore from './secureLocalStore';

/** Per map, counted in identities. Two short strings each. */
const MAX_ENTRIES = 4_000;

/** Per map, on disk. Matches `pruneAvatarCache`'s 500-blob cap — see above. */
const MAX_PERSISTED_ENTRIES = 500;
/** Record age bound. Matches `pruneAvatarCache`'s 90 days — see above. */
const PERSIST_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Longest id / username we will store. A hostile handle cannot bloat the record. */
const MAX_FIELD = 128;
/**
 * Coalescing window for the write. `rememberIdentities` touches up to four
 * facets per row, so a 50-member directory response would otherwise re-serialise
 * and re-encrypt the whole record two hundred times. The cost of losing the last
 * window on a hard kill is one round-trip on the next boot.
 */
const PERSIST_DEBOUNCE_MS = 1_500;

const STORE_PREFIX = 'cipherline_peer_identity_';
const RECORD_VERSION = 1;

/** Compact on-disk shape: `[key, avatarId, name]`, '' meaning "not known". */
type PersistedEntry = [string, string, string];
interface PersistedRecord {
    v: number;
    savedAt: number;
    u: PersistedEntry[];
    d: PersistedEntry[];
}

interface PeerIdentity {
    /** Attachment id of the profile picture, absent when they have none. */
    avatarId?: string;
    /** ACCOUNT username — never a server nickname. See the precedence note. */
    name?: string;
}

const byUser = new Map<string, PeerIdentity>();
const byDevice = new Map<string, PeerIdentity>();

// ── Persistence ────────────────────────────────────────────────────────────
// `persistUserId` is BOTH the key scope and the permission to write: it is null
// until hydration has bound the cache to a ready account, so nothing that
// happens before or during a sign-in can reach the store.
let persistUserId: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistPending: Promise<void> = Promise.resolve();

function clip(s: string): string {
    return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) : s;
}

/** Youngest `MAX_PERSISTED_ENTRIES`, in insertion order (a touch re-inserts). */
function toPersistedEntries(map: Map<string, PeerIdentity>): PersistedEntry[] {
    const all = [...map.entries()];
    const keep = all.length > MAX_PERSISTED_ENTRIES ? all.slice(all.length - MAX_PERSISTED_ENTRIES) : all;
    return keep.map(([key, e]) => [clip(key), clip(e.avatarId ?? ''), clip(e.name ?? '')] as PersistedEntry);
}

function writeNow(): void {
    const uid = persistUserId;
    if (!uid) return;
    // Re-checked at WRITE time, not only at hydrate time: the account can go
    // away (sign-out, switch) inside the debounce window.
    if (!secureLocalStore.isAccountReady(uid)) return;
    const record: PersistedRecord = {
        v: RECORD_VERSION,
        savedAt: Date.now(),
        u: toPersistedEntries(byUser),
        d: toPersistedEntries(byDevice),
    };
    try {
        if (!record.u.length && !record.d.length) secureLocalStore.removeItem(STORE_PREFIX + uid);
        else secureLocalStore.setItem(STORE_PREFIX + uid, JSON.stringify(record));
    } catch (e) {
        // A cache that cannot persist is still a working session cache.
        console.warn('[peerIdentityCache] persist failed', e);
    }
}

function schedulePersist(): void {
    if (!persistUserId) return;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        persistPending = persistPending.then(() => { writeNow(); });
    }, PERSIST_DEBOUNCE_MS);
}

/**
 * Bind the cache to an account and load that account's saved identities.
 *
 * Call AFTER `secureLocalStore.whenAccountReady()` resolves — per-account
 * records are cold until then and an early read returns "this account knows
 * nobody", which is indistinguishable from a genuinely empty cache and would be
 * written straight back over the real one.
 *
 * Synchronously clears the maps first: they are module state shared across an
 * in-session account switch, so seeding B's panes from A's peers (or persisting
 * A's peers into B's record) is the failure this ordering prevents.
 */
export function hydratePeerIdentityCache(userId: string | null | undefined): void {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    persistUserId = null;
    byUser.clear();
    byDevice.clear();
    if (!userId || !secureLocalStore.isAccountReady(userId)) return;

    const key = STORE_PREFIX + userId;
    let record: PersistedRecord | null = null;
    try {
        const raw = secureLocalStore.getItem(key);
        if (raw) record = JSON.parse(raw) as PersistedRecord;
    } catch {
        record = null;
    }

    // Bind BEFORE the expiry branch so the removeItem below is permitted, and
    // so an unreadable record simply starts a fresh one rather than disabling
    // persistence for the session.
    persistUserId = userId;

    if (!record || record.v !== RECORD_VERSION || !Array.isArray(record.u) || !Array.isArray(record.d)) {
        if (record) { try { secureLocalStore.removeItem(key); } catch { /* best effort */ } }
        return;
    }
    if (!(typeof record.savedAt === 'number') || Date.now() - record.savedAt > PERSIST_TTL_MS) {
        try { secureLocalStore.removeItem(key); } catch { /* best effort */ }
        return;
    }

    // Written straight into the maps rather than through the setters: going
    // through `update()` would mark the cache dirty and re-persist on the next
    // tick, refreshing `savedAt` for data the TTL is meant to be aging out.
    load(byUser, record.u);
    load(byDevice, record.d);
}

function load(map: Map<string, PeerIdentity>, entries: PersistedEntry[]): void {
    for (const entry of entries) {
        if (!Array.isArray(entry)) continue;
        const [key, avatarId, name] = entry;
        if (typeof key !== 'string' || !key) continue;
        const rec: PeerIdentity = {};
        if (typeof avatarId === 'string' && avatarId) rec.avatarId = clip(avatarId);
        if (typeof name === 'string' && name) rec.name = clip(name);
        if (rec.avatarId === undefined && rec.name === undefined) continue;
        map.set(key, rec);
        if (map.size > MAX_ENTRIES) {
            const oldest = map.keys().next();
            if (!oldest.done) map.delete(oldest.value);
        }
    }
}

/**
 * Force any coalesced write out now and wait for it. Used by tests and by
 * anything that wants the record on disk before it stops caring (an account
 * teardown, say) rather than up to PERSIST_DEBOUNCE_MS later.
 */
export async function flushPeerIdentityCache(): Promise<void> {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; writeNow(); }
    await persistPending;
}

/**
 * Apply one facet to an identity record, keeping the map recency-ordered and
 * bounded. `patch` returns the updated record, or the same one it was given.
 */
function update(
    map: Map<string, PeerIdentity>,
    key: string | null | undefined,
    patch: (entry: PeerIdentity) => void,
): void {
    if (!key) return;
    const before = map.get(key);
    const entry: PeerIdentity = { ...(before ?? {}) };
    patch(entry);
    const changed = !before || before.avatarId !== entry.avatarId || before.name !== entry.name;

    // Re-insert so the most recently seen identity is the youngest for
    // eviction, whichever facet was touched.
    map.delete(key);
    if (entry.avatarId === undefined && entry.name === undefined) {
        if (changed) schedulePersist();   // a cleared avatar must not come back on the next boot
        return;                            // nothing left to remember
    }
    map.set(key, entry);
    if (map.size > MAX_ENTRIES) {
        const oldest = map.keys().next();
        if (!oldest.done) map.delete(oldest.value);
    }
    // Re-persist only on a real change. A directory response that re-states
    // what we already knew — the common case — costs nothing.
    if (changed) schedulePersist();
}

/**
 * Record — or CLEAR — an avatar attachment id.
 *
 * A falsy `avatarId` deletes the facet, because on every source that feeds
 * this cache a missing `avatar_url` means "this person has no picture". Keeping
 * a stale id would re-paint an avatar the user deleted on the next remount,
 * which is worse than one round-trip of fallback.
 */
export function rememberUserAvatarId(userId: string | null | undefined, avatarId: string | null | undefined): void {
    update(byUser, userId, e => { if (avatarId) e.avatarId = avatarId; else delete e.avatarId; });
}

/** Record (or clear) one device's avatar attachment id. */
export function rememberDeviceAvatarId(deviceId: string | null | undefined, avatarId: string | null | undefined): void {
    update(byDevice, deviceId, e => { if (avatarId) e.avatarId = avatarId; else delete e.avatarId; });
}

/**
 * Record an account username.
 *
 * Note the asymmetry with the avatar setters: a falsy name is a NO-OP, not a
 * clear. Every account has a username, so an absent one means the response did
 * not carry it (an older endpoint, a partial payload), never "this person has
 * no name". Clearing on that would throw away a good name and put "Unknown
 * User" back on the row, which is the exact flash this cache exists to delete.
 */
export function rememberUserName(userId: string | null | undefined, name: string | null | undefined): void {
    if (!name) return;
    update(byUser, userId, e => { e.name = name; });
}

/** Record one device's account username. Falsy is a no-op — see rememberUserName. */
export function rememberDeviceName(deviceId: string | null | undefined, name: string | null | undefined): void {
    if (!name) return;
    update(byDevice, deviceId, e => { e.name = name; });
}

/**
 * Bulk-record a directory response. Accepts the raw row shape returned by
 * `GET /conversations/:id/devices` and `GET /servers/:id/members` alike — each
 * row may carry a `user_id`, a `device_id`, or both.
 */
export function rememberIdentities(
    rows: Iterable<{
        user_id?: string | null;
        device_id?: string | null;
        avatar_url?: string | null;
        username?: string | null;
    }>,
): void {
    for (const row of rows) {
        if (row.device_id) {
            rememberDeviceAvatarId(row.device_id, row.avatar_url);
            rememberDeviceName(row.device_id, row.username);
        }
        if (row.user_id) {
            rememberUserAvatarId(row.user_id, row.avatar_url);
            rememberUserName(row.user_id, row.username);
        }
    }
}

function snapshot(map: Map<string, PeerIdentity>, facet: keyof PeerIdentity): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, entry] of map) {
        const value = entry[facet];
        if (value) out[key] = value;
    }
    return out;
}

/** Snapshot for seeding a freshly mounted pane's `userId → avatarId` state. */
export function snapshotUserAvatarIds(): Record<string, string> {
    return snapshot(byUser, 'avatarId');
}

/** Snapshot for seeding a freshly mounted pane's `deviceId → avatarId` state. */
export function snapshotDeviceAvatarIds(): Record<string, string> {
    return snapshot(byDevice, 'avatarId');
}

/** Snapshot for seeding a freshly mounted pane's `userId → username` state. */
export function snapshotUserNames(): Record<string, string> {
    return snapshot(byUser, 'name');
}

/** Snapshot for seeding a freshly mounted pane's `deviceId → username` state. */
export function snapshotDeviceNames(): Record<string, string> {
    return snapshot(byDevice, 'name');
}

/** Every avatar attachment id known this session — the warm set worth preloading. */
export function knownAvatarIds(): string[] {
    const ids = new Set<string>();
    for (const e of byUser.values()) if (e.avatarId) ids.add(e.avatarId);
    for (const e of byDevice.values()) if (e.avatarId) ids.add(e.avatarId);
    return [...ids];
}

/** Look up one user's avatar attachment id, or null. */
export function lookupUserAvatarId(userId: string | null | undefined): string | null {
    if (!userId) return null;
    return (userId && byUser.get(userId)?.avatarId) || null;
}

/** Look up one user's account username, or null. */
export function lookupUserName(userId: string | null | undefined): string | null {
    if (!userId) return null;
    return byUser.get(userId)?.name ?? null;
}

/** Tests only — the cache is module-level state shared by every suite in a file. */
export function __resetPeerIdentityCache(): void {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    persistUserId = null;
    byUser.clear();
    byDevice.clear();
}

/** Tests only — the caps are part of the contract. */
export const __peerIdentityTuning = {
    MAX_ENTRIES,
    MAX_PERSISTED_ENTRIES,
    PERSIST_TTL_MS,
    PERSIST_DEBOUNCE_MS,
    STORE_PREFIX,
} as const;
