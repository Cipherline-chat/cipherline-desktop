/**
 * In-memory stale-while-revalidate cache for a server's member roster
 * (`GET /servers/:id/members` + `GET /servers/:id/roles`).
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * "The right side panel for servers sits and loads the member list every time
 * and it feels slow." ServerContextPanel held the roster in component state
 * and gated the WHOLE list behind a spinner while it refetched — on every
 * server switch, every roster-changed event and every role toggle. The data
 * was thrown away each time even though the answer is almost always the one
 * we already had. Measured costs and the before/after numbers are in the
 * commit message; the short version is that the time to first member row was
 * ~1 network round trip (members+roles, in parallel, queued behind whatever
 * else the server open is requesting) and the render itself was a few ms.
 *
 * Now: a re-open paints the cached rows in the same frame and revalidates in
 * the background; the answer replaces the cached copy, and replaces it
 * STRUCTURALLY — rows whose content is unchanged keep their object identity,
 * and an unchanged roster keeps the entry itself, so an unchanged answer
 * re-renders nothing.
 *
 * ── Memory discipline ───────────────────────────────────────────────────────
 *   - LRU over servers (MAX_SERVERS), plus a total-row budget (MAX_TOTAL_ROWS):
 *     the least recently VIEWED server's list is dropped first.
 *   - The server being viewed is always kept (a truncated roster would be
 *     wrong), so a single server bigger than the whole budget sits alone —
 *     what the old component state held — and is the first evicted next.
 *   - Memory only. Member lists are never written to disk, here or anywhere
 *     this module reaches. Decrypted avatars are NOT held here — rows carry
 *     the attachment id and `useEncryptedAvatar`'s own bounded cache resolves
 *     it synchronously on remount, so nothing is decrypted twice.
 *
 * ── Privacy ─────────────────────────────────────────────────────────────────
 * The roster is exactly what the server already returned to this account for
 * this panel; nothing new crosses a trust boundary. The cache is per VIEWER
 * (the endpoint is membership-gated) and is dropped on sign-out / account
 * switch (`bindRosterViewer`), the same rule `profileCache` follows.
 *
 * ── Freshness ───────────────────────────────────────────────────────────────
 * Presence is NOT cached state: the panel resolves it live from the presence
 * map and uses a row's `status` only as a pre-snapshot fallback. Everything
 * else is kept current by: a background revalidation on every open (skipped
 * when the copy is younger than FRESH_MS), `invalidateRoster` /
 * `invalidateAllRosters` on the WS events that mean "the roster changed" or
 * "we may have missed events", and `patchRosterUser` for avatar / username
 * events, which are applied in place across every cached server.
 */
import axios from 'axios';
import { API_BASE } from '../constants';
import { beginActivity } from './freezeLog';
import { clearChannelViewerCache } from './channelViewerCache';

export interface RosterMember {
    user_id: string;
    username: string;
    discriminator: number | null;
    nickname: string | null;
    avatar_url: string | null;
    status: string;
    /** From the roster fetch — present on phones only. Newer servers only. */
    on_mobile?: boolean;
    joined_at: string;
    muted_until: string | null;
    /** Role IDs assigned to this member (excludes @everyone — that's implicit). */
    role_ids: string[];
}

export interface RosterRole {
    role_id: string;
    name: string;
    color: number;    // 24-bit packed int; -1 = no color
    position: number;
    hoisted: boolean;
    is_everyone: boolean;
    /** Present on the wire; ChatPane's @mention picker reads it. */
    mentionable?: boolean;
}

/**
 * Entry identity IS content identity: a new object exists only when `members`
 * or `roles` actually changed, so it is directly usable as a
 * useSyncExternalStore snapshot. The freshness timestamp lives beside it.
 */
export interface Roster {
    readonly members: ReadonlyArray<RosterMember>;
    readonly roles: ReadonlyArray<RosterRole>;
}

/** Servers kept at once. A handful covers "flip between my few servers". */
export const MAX_SERVERS = 6;
/**
 * Row budget across ALL cached servers (~0.25 KB/row, measured → ~0.7 MB). The server
 * being viewed is always kept, so one server larger than the budget sits
 * alone (exactly what the old component state held) and is the first to go
 * when the next server is cached.
 */
export const MAX_TOTAL_ROWS = 3000;
/** A copy younger than this is not revalidated on open (rapid A→B→A flips). */
export const FRESH_MS = 10_000;

const cache = new Map<string, Roster>();          // insertion order = LRU order
/** Date.now() of each server's last successful fetch; 0 / absent = stale. */
const fetchedAt = new Map<string, number>();
const listeners = new Set<() => void>();
interface Inflight {
    promise: Promise<Roster | null>;
    trailing: Promise<Roster | null> | null;
    /** Cleared when a real viewer joins the request: its result must then be stored normally. */
    ctl: { prefetch: boolean };
}
const inflight = new Map<string, Inflight>();
let viewer: string | null = null;
/** Bumped on every viewer change / clear; a response from an older generation is dropped. */
let generation = 0;

function emit(): void {
    for (const l of Array.from(listeners)) l();
}

export function subscribeRoster(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/**
 * Scope the cache to the signed-in account. A different viewer (or none)
 * drops everything — the roster is membership-gated, so it is per account.
 */
export function bindRosterViewer(userId: string | null | undefined): void {
    const next = userId ?? null;
    if (next === viewer) return;
    const previous = viewer;
    viewer = next;
    // null -> account is the first bind of a session: anything already cached or
    // in flight was fetched with this session's token (and sign-out has its own
    // clear), so dropping it would only discard a boot prefetch mid-flight.
    if (previous === null) return;
    clearRosterCache();
}

/** Drop everything (sign-out, account switch). Pending responses are discarded. */
export function clearRosterCache(): void {
    // The per-channel viewer sets narrow these rosters and are just as
    // per-account: one rule clears both, so they can never disagree.
    clearChannelViewerCache();
    generation++;
    const had = cache.size > 0;
    cache.clear();
    fetchedAt.clear();
    inflight.clear();
    if (had) emit();
}

/** The cached roster (any age) or null. Marks the server most-recently-used. */
export function getRoster(serverId: string | null | undefined): Roster | null {
    if (!serverId) return null;
    const hit = cache.get(serverId);
    if (!hit) return null;
    // Re-insert = move to the MRU end. No emit: the entry object is unchanged,
    // so useSyncExternalStore subscribers see an identical snapshot.
    cache.delete(serverId);
    cache.set(serverId, hit);
    return hit;
}

/** Like getRoster but leaves LRU order alone. */
export function peekRoster(serverId: string | null | undefined): Roster | null {
    return serverId ? (cache.get(serverId) ?? null) : null;
}

export function isRosterFresh(serverId: string, maxAgeMs = FRESH_MS): boolean {
    return cache.has(serverId) && Date.now() - (fetchedAt.get(serverId) ?? 0) < maxAgeMs;
}

/** Cached server ids, least → most recently used. Diagnostics / tests. */
export function cachedRosterServerIds(): string[] {
    return Array.from(cache.keys());
}

/** Total rows currently held. Diagnostics / tests. */
export function cachedRosterRowCount(): number {
    let n = 0;
    cache.forEach(r => { n += r.members.length; });
    return n;
}

function put(serverId: string, roster: Roster): void {
    cache.delete(serverId);
    cache.set(serverId, roster);
    // LRU evict: server count, then row budget. Never evict the entry just
    // written (it is the MRU, and `cache.size > 1` guards the loop).
    let rows = cachedRosterRowCount();
    for (const id of Array.from(cache.keys())) {
        if (cache.size <= 1) break;
        if (cache.size <= MAX_SERVERS && rows <= MAX_TOTAL_ROWS) break;
        const victim = cache.get(id);
        cache.delete(id);
        fetchedAt.delete(id);
        rows -= victim ? victim.members.length : 0;
    }
}

/** Insert at the LRU (oldest) end if there is free room; false when there is none. */
function putCold(serverId: string, roster: Roster): boolean {
    if (cache.size >= MAX_SERVERS || cachedRosterRowCount() + roster.members.length > MAX_TOTAL_ROWS) return false;
    const rest = Array.from(cache.entries());
    cache.clear();
    cache.set(serverId, roster);
    for (const [k, v] of rest) cache.set(k, v);
    return true;
}

// ── Structural sharing ──────────────────────────────────────────────────────

// Whole-object signatures: a field the server adds later is compared too, so a
// reused row can never hide a changed value. Key order is stable (one SELECT /
// one serializer on the server), and the rosters are small.
function memberSig(m: RosterMember): string {
    return JSON.stringify(m);
}

function roleSig(r: RosterRole): string {
    return JSON.stringify(r);
}

/** Reuse `prev` rows whose content is identical; return `prev` itself when nothing differs. */
function reconcile<T>(
    prev: ReadonlyArray<T>,
    next: ReadonlyArray<T>,
    key: (x: T) => string,
    sig: (x: T) => string,
): ReadonlyArray<T> {
    const prevByKey = new Map<string, { row: T; sig: string }>();
    for (const p of prev) prevByKey.set(key(p), { row: p, sig: sig(p) });
    let allSame = prev.length === next.length;
    const out = next.map((n, i) => {
        const old = prevByKey.get(key(n));
        if (old && old.sig === sig(n)) {
            if (allSame && prev[i] !== old.row) allSame = false;
            return old.row;
        }
        allSame = false;
        return n;
    });
    return allSame ? prev : out;
}

/** `prev` itself when nothing differs, so identity tracks content. */
function reconcileRoster(prev: Roster | undefined, members: RosterMember[], roles: RosterRole[]): Roster {
    if (!prev) return { members, roles };
    const m = reconcile(prev.members, members, x => x.user_id, memberSig);
    const r = reconcile(prev.roles, roles, x => x.role_id, roleSig);
    if (m === prev.members && r === prev.roles) return prev;
    return { members: m, roles: r };
}

// ── Fetch ───────────────────────────────────────────────────────────────────

async function fetchOnce(serverId: string, token: string, ctl: { prefetch: boolean }): Promise<Roster | null> {
    const gen = generation;
    const end = beginActivity('server:roster-fetch');
    try {
        const headers = { Authorization: `Bearer ${token}` };
        const prev = cache.get(serverId);
        const [membersRes, rolesRes] = await Promise.all([
            axios.get(`${API_BASE}/servers/${serverId}/members`, { headers }),
            // Roles are best-effort, as before: a failure keeps the last known
            // roles rather than blanking every name colour and role group.
            axios.get(`${API_BASE}/servers/${serverId}/roles`, { headers }).catch(() => null),
        ]);
        if (gen !== generation) return null;   // account changed mid-flight
        const members: RosterMember[] = Array.isArray(membersRes.data) ? membersRes.data : [];
        const roles: RosterRole[] = rolesRes && Array.isArray(rolesRes.data)
            ? rolesRes.data
            : (prev ? [...prev.roles] : []);
        const before = cache.get(serverId);
        const next = reconcileRoster(before, members, roles);
        if (ctl.prefetch && !before) {
            // A bet, not a view: only take free room, and sit at the LRU end so
            // it can never push out a server the user has actually looked at.
            if (!putCold(serverId, next)) return next;
        } else if (before) {
            cache.set(serverId, next);   // in place: keeps its LRU position
        } else {
            put(serverId, next);
        }
        fetchedAt.set(serverId, Date.now());
        // Notify only on a real change; a pure timestamp bump is invisible.
        if (next !== before) emit();
        return next;
    } finally {
        end();
    }
}

/**
 * Fetch (or revalidate) a server's roster.
 *
 *  - Concurrent callers share ONE request pair per server.
 *  - Without `force`, a copy younger than FRESH_MS is returned as is.
 *  - `prefetch` is for fetches nobody is looking at yet (boot): the result is
 *    cached only into free room, at the LRU end, and is handed back either way.
 *    A viewer who joins the request mid-flight turns it into a normal fetch.
 *  - `force` (a roster-changed event, a role toggle, a kick) never reuses a
 *    request that started BEFORE the caller's change: it waits for the one in
 *    flight and then runs a single trailing fetch that any number of forced
 *    callers share.
 *
 * Resolves to the roster, or null when the account changed mid-flight.
 * Rejects when the members request fails; a previously cached copy is left
 * untouched in that case.
 */
export function refreshRoster(
    serverId: string,
    token: string | null,
    opts: { force?: boolean; prefetch?: boolean } = {},
): Promise<Roster | null> {
    if (!token || !serverId) return Promise.resolve(peekRoster(serverId));
    if (!opts.force && isRosterFresh(serverId)) return Promise.resolve(peekRoster(serverId));

    const running = inflight.get(serverId);
    if (running && !opts.force) {
        if (!opts.prefetch) running.ctl.prefetch = false;
        return running.promise;
    }

    const gen = generation;
    const start = (): Promise<Roster | null> => {
        const ctl = { prefetch: !!opts.prefetch && !opts.force };
        const p = fetchOnce(serverId, token, ctl);
        const entry: Inflight = { promise: p, trailing: null, ctl };
        inflight.set(serverId, entry);
        const clear = () => { if (inflight.get(serverId) === entry && gen === generation) inflight.delete(serverId); };
        p.then(clear, clear);
        return p;
    };

    if (!running) return start();

    // force while something is in flight → one shared trailing fetch.
    if (!running.trailing) {
        const swallow = () => undefined;
        running.trailing = running.promise.then(swallow, swallow).then(() => start());
    }
    return running.trailing;
}

// ── Live-event hooks ────────────────────────────────────────────────────────

/** Mark a server's copy stale (kept for instant paint, revalidated on next open). */
export function invalidateRoster(serverId: string | null | undefined): void {
    if (!serverId) return;
    if (cache.has(serverId)) fetchedAt.set(serverId, 0);
}

/** After a WS reconnect we may have missed anything. */
export function invalidateAllRosters(): void {
    for (const id of Array.from(cache.keys())) invalidateRoster(id);
}

/** The account left (or was removed from) this server. */
export function dropRoster(serverId: string | null | undefined): void {
    if (!serverId) return;
    inflight.delete(serverId);
    fetchedAt.delete(serverId);
    if (cache.delete(serverId)) emit();
}

/**
 * Apply a profile change (avatar attachment id / username / discriminator) to
 * the user's row in EVERY cached server. Servers that don't contain the user
 * are left untouched (no new object, no notification).
 */
export function patchRosterUser(
    userId: string,
    patch: Partial<Pick<RosterMember, 'avatar_url' | 'username' | 'discriminator'>>,
): void {
    let changed = false;
    cache.forEach((roster, serverId) => {
        const idx = roster.members.findIndex(m => m.user_id === userId);
        if (idx < 0) return;
        const old = roster.members[idx];
        const merged = { ...old, ...patch };
        if (memberSig(merged) === memberSig(old)) return;
        const members = roster.members.slice();
        members[idx] = merged;
        cache.set(serverId, { members, roles: roster.roles });
        changed = true;
    });
    if (changed) emit();
}

/** Tests only. */
export function __resetRosterCache(): void {
    viewer = null;
    clearRosterCache();
    listeners.clear();
}
