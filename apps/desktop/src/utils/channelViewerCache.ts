/**
 * Who can SEE each restricted channel — the per-channel filter for the server
 * member sidebar. Lives next to `serverRosterCache` and follows its rules.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * "If I am in a server with 100 members and I go into a restricted channel
 * that only 2 people can see, it should only show those two people in the
 * right sidebar." (Discord behaviour.) Only the server can answer it: a
 * member's effective VIEW_CHANNEL depends on every role, the @everyone base,
 * category AND channel overrides, and the owner / ADMINISTRATOR bypass, and
 * this client is never sent other members' overrides unless it can manage
 * the channel. So the answer is fetched, never derived here — and nothing in
 * this module is load-bearing for privacy: it only ever NARROWS a roster the
 * server already handed this account.
 *
 * ── Cost shape ──────────────────────────────────────────────────────────────
 * `GET /servers/:sid/channels` marks each channel `view_scope: 'all' |
 * 'restricted'`. An 'all' channel (the ordinary case) is never asked about —
 * the full roster IS its member list. Only a 'restricted' channel costs a
 * `GET /servers/:sid/channels/:cid/viewers`, whose answer is cached here.
 *
 * ── Freshness (stale-while-revalidate, like the roster) ─────────────────────
 *   - A cached answer paints instantly on every revisit; it is revalidated in
 *     the background when older than FRESH_MS or marked stale.
 *   - `invalidateServerChannelViewers` marks every cached channel of a server
 *     stale: Dashboard calls it on `server:permissions_changed` (roles,
 *     assignments, channel/category overrides), `server:channels_changed`
 *     (a channel moved category = new inherited overrides), and member
 *     join / leave / kick / ban. `invalidateAllChannelViewers` on reconnect.
 *     A stale flag gives the entry a NEW identity, so the open channel's
 *     sidebar revalidates at once; other channels revalidate on their next open.
 *   - A response that started before an invalidation is stored but stays
 *     stale, so a change made mid-flight is never lost.
 *
 * ── Memory / privacy ────────────────────────────────────────────────────────
 * Memory only, never persisted. LRU over channels (MAX_CHANNELS) plus a total
 * id budget (MAX_TOTAL_IDS). Per account: `clearRosterCache` (sign-out,
 * account switch) clears this too, so the two can never disagree about whose
 * data they hold.
 */
import axios from 'axios';
import { API_BASE } from '../constants';

export type ChannelViewers =
    | { readonly all: true }
    | { readonly all: false; readonly ids: ReadonlySet<string> };

/**
 * One channel's cached state. Identity changes only when `viewers` changes
 * or the stale flag flips, so it is directly a useSyncExternalStore snapshot.
 * `viewers === null` = the first fetch failed and nothing is known: the
 * sidebar degrades to the unfiltered roster instead of spinning forever.
 */
export interface ChannelViewerEntry {
    readonly serverId: string;
    readonly viewers: ChannelViewers | null;
    readonly stale: boolean;
}

export const MAX_CHANNELS = 64;
/** Ids across ALL cached channels (~40 B each → well under 1 MB). */
export const MAX_TOTAL_IDS = 20_000;
/** An answer younger than this is not revalidated on open (rapid A→B→A). */
export const FRESH_MS = 30_000;

const ALL_VIEWERS: ChannelViewers = Object.freeze({ all: true as const });

const cache = new Map<string, ChannelViewerEntry>();   // insertion order = LRU order
const fetchedAt = new Map<string, number>();
/** Bumped per channel by every invalidation; a fetch compares start vs end. */
const invalidationCount = new Map<string, number>();
const inflight = new Map<string, { promise: Promise<ChannelViewers | null>; trailing: Promise<ChannelViewers | null> | null }>();
const listeners = new Set<() => void>();
let generation = 0;

function emit(): void {
    for (const l of Array.from(listeners)) l();
}

export function subscribeChannelViewers(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** The cached entry (any age) or null. Pure: safe as a render snapshot. */
export function peekChannelViewers(channelId: string | null | undefined): ChannelViewerEntry | null {
    return channelId ? (cache.get(channelId) ?? null) : null;
}

/** Mark a channel most-recently-used (the sidebar is showing it). No emit. */
export function touchChannelViewers(channelId: string): void {
    const hit = cache.get(channelId);
    if (!hit) return;
    cache.delete(channelId);
    cache.set(channelId, hit);
}

export function isChannelViewersFresh(channelId: string, maxAgeMs = FRESH_MS): boolean {
    const e = cache.get(channelId);
    return !!e && !e.stale && e.viewers !== null && Date.now() - (fetchedAt.get(channelId) ?? 0) < maxAgeMs;
}

function idCount(e: ChannelViewerEntry): number {
    return e.viewers && !e.viewers.all ? e.viewers.ids.size : 0;
}

/** Cached channel ids, least → most recently used. Diagnostics / tests. */
export function cachedViewerChannelIds(): string[] {
    return Array.from(cache.keys());
}

export function cachedViewerIdCount(): number {
    let n = 0;
    cache.forEach(e => { n += idCount(e); });
    return n;
}

function put(channelId: string, entry: ChannelViewerEntry): void {
    cache.delete(channelId);
    cache.set(channelId, entry);
    let ids = cachedViewerIdCount();
    for (const id of Array.from(cache.keys())) {
        if (cache.size <= 1) break;
        if (cache.size <= MAX_CHANNELS && ids <= MAX_TOTAL_IDS) break;
        if (id === channelId) continue;
        const victim = cache.get(id)!;
        cache.delete(id);
        fetchedAt.delete(id);
        invalidationCount.delete(id);
        ids -= idCount(victim);
    }
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
}

/** Reuse `prev` when the content is identical, so identity tracks content. */
function reconcile(prev: ChannelViewers | null | undefined, next: ChannelViewers): ChannelViewers {
    if (!prev) return next;
    if (prev.all && next.all) return prev;
    if (!prev.all && !next.all && sameIds(prev.ids, next.ids)) return prev;
    return next;
}

/** Parse the wire shape strictly; anything else is treated as a failure. */
export function parseViewersResponse(data: unknown): ChannelViewers {
    const d = data as { all?: unknown; user_ids?: unknown } | null;
    if (d && d.all === true) return ALL_VIEWERS;
    if (d && d.all === false && Array.isArray(d.user_ids) && d.user_ids.every(x => typeof x === 'string')) {
        return { all: false, ids: new Set(d.user_ids as string[]) };
    }
    throw new Error('[channelViewers] malformed response');
}

async function fetchOnce(serverId: string, channelId: string, token: string): Promise<ChannelViewers | null> {
    const gen = generation;
    const invAtStart = invalidationCount.get(channelId) ?? 0;
    try {
        const res = await axios.get(
            `${API_BASE}/servers/${serverId}/channels/${channelId}/viewers`,
            { headers: { Authorization: `Bearer ${token}` } },
        );
        if (gen !== generation) return null;   // account changed mid-flight
        const parsed = parseViewersResponse(res.data);
        const before = cache.get(channelId);
        const viewers = reconcile(before?.viewers, parsed);
        // Invalidated while we were asking → the answer may predate the
        // change. Keep it for display, but leave it stale so it is re-asked.
        const stale = (invalidationCount.get(channelId) ?? 0) !== invAtStart;
        const next: ChannelViewerEntry =
            before && before.viewers === viewers && before.stale === stale && before.serverId === serverId
                ? before
                : { serverId, viewers, stale };
        if (before) cache.set(channelId, next); else put(channelId, next);
        if (!stale) fetchedAt.set(channelId, Date.now());
        if (next !== before) emit();
        return viewers;
    } catch (err) {
        if (gen !== generation) return null;
        // Keep whatever was cached (SWR). With nothing cached, record the
        // failure so the sidebar falls back to the unfiltered roster.
        if (!cache.has(channelId)) {
            put(channelId, { serverId, viewers: null, stale: false });
            emit();
        }
        throw err;
    }
}

/**
 * Fetch (or revalidate) one channel's viewer set.
 *  - Concurrent callers share one request per channel.
 *  - Without `force`, a fresh, non-stale answer is returned as is.
 *  - `force` while a request is in flight runs ONE trailing request after it.
 * Resolves to the viewers, or null when the account changed mid-flight.
 * Rejects when the request fails (a cached answer is kept).
 */
export function refreshChannelViewers(
    serverId: string,
    channelId: string,
    token: string | null,
    opts: { force?: boolean } = {},
): Promise<ChannelViewers | null> {
    const cached = () => cache.get(channelId)?.viewers ?? null;
    if (!token || !serverId || !channelId) return Promise.resolve(cached());
    if (!opts.force && isChannelViewersFresh(channelId)) return Promise.resolve(cached());

    const running = inflight.get(channelId);
    if (running && !opts.force) return running.promise;

    const gen = generation;
    const start = (): Promise<ChannelViewers | null> => {
        const p = fetchOnce(serverId, channelId, token);
        const entry = { promise: p, trailing: null as Promise<ChannelViewers | null> | null };
        inflight.set(channelId, entry);
        const clear = () => { if (inflight.get(channelId) === entry && gen === generation) inflight.delete(channelId); };
        p.then(clear, clear);
        return p;
    };
    if (!running) return start();
    if (!running.trailing) {
        const swallow = () => undefined;
        running.trailing = running.promise.then(swallow, swallow).then(() => start());
    }
    return running.trailing;
}

// ── Hover prefetch ──────────────────────────────────────────────────────────

/** Dwell before a hovered channel row prefetches (filters out a mouse sweep). */
export const HOVER_INTENT_MS = 120;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The channel list calls this on pointer-enter of a row: if the pointer rests
 * there for HOVER_INTENT_MS, a restricted channel's viewer set is fetched so
 * the click that usually follows paints the filtered list with no spinner.
 * Public channels, fresh answers and a mouse merely passing over cost nothing.
 */
export function hoverPrefetchChannelViewers(
    channel: { channel_id: string; server_id: string; view_scope?: 'all' | 'restricted' },
    token: string | null,
): void {
    cancelHoverPrefetch();
    if (!token || channel.view_scope !== 'restricted' || isChannelViewersFresh(channel.channel_id)) return;
    hoverTimer = setTimeout(() => {
        hoverTimer = null;
        refreshChannelViewers(channel.server_id, channel.channel_id, token).catch(() => undefined);
    }, HOVER_INTENT_MS);
}

export function cancelHoverPrefetch(): void {
    if (hoverTimer !== null) { clearTimeout(hoverTimer); hoverTimer = null; }
}

// ── Live-event hooks ────────────────────────────────────────────────────────

function markStale(channelId: string): boolean {
    invalidationCount.set(channelId, (invalidationCount.get(channelId) ?? 0) + 1);
    fetchedAt.delete(channelId);
    const e = cache.get(channelId);
    if (!e) return false;
    if (e.viewers === null) {
        // A recorded failure carries no data; just forget it.
        cache.delete(channelId);
        return true;
    }
    if (e.stale) return false;
    cache.set(channelId, { ...e, stale: true });   // in place: keeps LRU slot
    return true;
}

/** Permissions / overrides / channels / membership changed in this server. */
export function invalidateServerChannelViewers(serverId: string | null | undefined): void {
    if (!serverId) return;
    let changed = false;
    // In-flight requests for this server must also learn about it.
    const ids = new Set<string>(inflight.keys());
    cache.forEach((e, id) => { if (e.serverId === serverId) ids.add(id); });
    for (const id of ids) {
        const e = cache.get(id);
        if (e && e.serverId !== serverId) continue;
        if (markStale(id)) changed = true;
    }
    if (changed) emit();
}

/** After a WS reconnect we may have missed anything. */
export function invalidateAllChannelViewers(): void {
    let changed = false;
    const ids = new Set<string>([...cache.keys(), ...inflight.keys()]);
    for (const id of ids) if (markStale(id)) changed = true;
    if (changed) emit();
}

/** The account left (or was removed from) this server. */
export function dropServerChannelViewers(serverId: string | null | undefined): void {
    if (!serverId) return;
    let changed = false;
    cache.forEach((e, id) => {
        if (e.serverId !== serverId) return;
        cache.delete(id);
        fetchedAt.delete(id);
        invalidationCount.set(id, (invalidationCount.get(id) ?? 0) + 1);
        inflight.delete(id);
        changed = true;
    });
    if (changed) emit();
}

/** Drop everything (sign-out, account switch). Pending responses are discarded. */
export function clearChannelViewerCache(): void {
    generation++;
    const had = cache.size > 0;
    cache.clear();
    fetchedAt.clear();
    invalidationCount.clear();
    inflight.clear();
    if (had) emit();
}

// ── Deriving the sidebar's member filter ────────────────────────────────────

export type MemberFilter =
    | { readonly kind: 'all' }
    | { readonly kind: 'loading' }
    | { readonly kind: 'subset'; readonly ids: ReadonlySet<string> };

export const FILTER_ALL: MemberFilter = Object.freeze({ kind: 'all' as const });
export const FILTER_LOADING: MemberFilter = Object.freeze({ kind: 'loading' as const });
const subsetFilters = new WeakMap<ReadonlySet<string>, MemberFilter>();

/**
 * The member filter for the channel being viewed. Pure, so it is unit-tested
 * directly; identity is stable per viewer set, so memoised lists downstream
 * recompute only when the answer actually changed.
 *
 *  - No channel, another server's channel, or no `view_scope` on it (an API
 *    that predates this feature, which also has no viewers route): everyone.
 *  - `view_scope: 'all'`: everyone — never asked, never filtered.
 *  - `'restricted'` with a cached answer (any age): that answer, instantly.
 *  - `'restricted'`, never seen: LOADING — the sidebar must not paint the
 *    full roster and then shrink it.
 *  - `'restricted'`, first fetch failed: everyone (degrade, don't spin).
 */
export function memberFilterFor(
    serverId: string,
    channel: { server_id: string; view_scope?: 'all' | 'restricted' } | null | undefined,
    entry: ChannelViewerEntry | null,
): MemberFilter {
    if (!channel || channel.server_id !== serverId || channel.view_scope !== 'restricted') return FILTER_ALL;
    if (!entry) return FILTER_LOADING;
    if (!entry.viewers || entry.viewers.all) return FILTER_ALL;
    const ids = entry.viewers.ids;
    let f = subsetFilters.get(ids);
    if (!f) { f = Object.freeze({ kind: 'subset' as const, ids }); subsetFilters.set(ids, f); }
    return f;
}

const NO_MEMBERS: never[] = [];

/** Apply a filter to a roster. 'all' returns the SAME array (no re-render). */
export function filterMembers<T extends { user_id: string }>(
    members: ReadonlyArray<T>,
    filter: MemberFilter,
): ReadonlyArray<T> {
    if (filter.kind === 'all') return members;
    if (filter.kind === 'loading') return NO_MEMBERS;
    return members.filter(m => filter.ids.has(m.user_id));
}

/** Tests only. */
export function __resetChannelViewerCache(): void {
    clearChannelViewerCache();
    listeners.clear();
}
