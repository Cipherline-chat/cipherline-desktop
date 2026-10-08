/**
 * Public-profile session cache + hover-intent prefetch for the profile card.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * "When opening people's profiles, their profile picture and banner take a
 * while to load." Measured in `components/profileOpenLatency.test.ts`, the
 * time was not in the image pipeline's caches (those are keyed by attachment
 * id and hit fine) but in WHEN the card was allowed to ask them:
 *
 *   - `ProfileModal` refetched `GET /auth/users/:id` on EVERY open and showed a
 *     skeleton in the avatar slot until it answered — even for an avatar that
 *     was already decrypted in memory because it was the thing just clicked.
 *     ~105 ms of skeleton per open, every open, in the latency model.
 *   - The banner's attachment id is only in that response, so its load could
 *     not start until the round trip finished — then paid two more serial API
 *     round trips (key, then download URL) and the media GET: ~430 ms cold.
 *   - Nothing ran before the click.
 *
 * This module removes the first and third, and gives the second a head start:
 *
 *   1. **Session cache** of the last response per user. A re-open renders the
 *      card from it immediately (stale-while-revalidate: it still refetches
 *      unless the copy is younger than FRESH_MS, and the fresh answer replaces
 *      it). Memory only, never persisted — bios and presence have no business
 *      on disk; the attachment IDS alone persist, in `peerIdentityCache`.
 *   2. **Ids everywhere they are already known.** Every response recorded here
 *      writes the avatar and banner ids into `peerIdentityCache`, and the
 *      friends list does the same at boot, so the card can start (or paint
 *      from cache) both images on the click instead of after the fetch.
 *   3. **Hover-intent prefetch** (`scheduleProfilePrefetch`): resting the
 *      pointer on a clickable avatar for HOVER_DWELL_MS fetches the profile
 *      and warms both images; pressing the button starts it with no dwell at
 *      all (the click lands ~100 ms later and joins the request in flight).
 *
 * ── Cost discipline ─────────────────────────────────────────────────────────
 * Every API request comes out of the account's shared `default` throttle
 * budget (300 / 60 s FIXED window — overspending it 429s the whole app, not
 * just profiles; see `useEncryptedAvatar`'s WARM_NETWORK_* notes). Hover
 * prefetch is a BET, so it is bounded three ways:
 *   - the dwell filters a pointer that is just passing over a list;
 *   - at most MAX_CONCURRENT_PREFETCH run at once, and an excess hover is
 *     DROPPED rather than queued (a queued bet fires late, when it is wrong);
 *   - a token bucket (PREFETCH_BURST, then one per PREFETCH_REFILL_MS) caps
 *     the sustained rate at ~24 profiles/min → ≤ ~72 req/min worst case (all
 *     cold: profile + key + URL), under a quarter of the budget.
 * A prefetch whose every answer is already in memory costs nothing and takes
 * no token. A press (`immediate`) is demand, not a bet: the card is about to
 * make exactly these requests anyway, so it skips the bucket and the cap.
 *
 * ── Privacy ─────────────────────────────────────────────────────────────────
 * Nothing new crosses a trust boundary. The requests are the ones opening the
 * card already makes; the server authorises each one (`getPublicProfile`'s
 * presence gate, the attachment friend/co-member gate) exactly as before, and
 * the images still decrypt client-side. The cache is per VIEWER — responses
 * depend on who asks (the presence gate) — and is dropped on an account
 * switch (`bindProfileCacheViewer`).
 */
import axios from 'axios';
import { API_BASE } from '../constants';
import { TokenBucket } from './avatarWarmQueue';
import { preloadAvatar, peekAvatarUrl } from '../hooks/useEncryptedAvatar';
import {
    rememberUserAvatarId,
    rememberUserBannerId,
    rememberUserName,
    lookupUserAvatarId,
    lookupUserBannerId,
} from './peerIdentityCache';
import type { ProfileBadge } from './profileBadges';
import type { UserStatus } from '../hooks/useUserStatus';

/** `GET /v1/auth/users/:id` — the public profile the card renders. */
export interface PublicProfile {
    user_id: string;
    username: string;
    discriminator: number | null;
    avatar_url: string | null;
    banner_url: string | null;
    bio: string | null;
    status: UserStatus;
    custom_status_text: string | null;
    custom_status_emoji: string | null;
    last_seen_at: string | null;
    /** Present on phones only (newer servers; same gate as `status`). */
    on_mobile?: boolean;
    /** Paying (or comped) account. Server-derived; absent on older servers. */
    is_pro?: boolean;
    /** Admin-granted custom profile badges. Absent on an older server. */
    badges?: ProfileBadge[];
}

/** A cached response younger than this satisfies an open with no refetch. */
const FRESH_MS = 30_000;
/** Users held in memory. A profile is a few hundred bytes. */
const MAX_ENTRIES = 300;
/** Pointer rest before a hover counts as intent. */
const HOVER_DWELL_MS = 120;
const MAX_CONCURRENT_PREFETCH = 2;
const PREFETCH_BURST = 6;
const PREFETCH_REFILL_MS = 2_500;

/** Exported for tests — the numbers are the contract. */
export const __profilePrefetchTuning = {
    FRESH_MS, MAX_ENTRIES, HOVER_DWELL_MS, MAX_CONCURRENT_PREFETCH, PREFETCH_BURST, PREFETCH_REFILL_MS,
} as const;

interface Entry { profile: PublicProfile; fetchedAt: number }

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<PublicProfile>>();
let viewer: string | null = null;
/** Bumped on every viewer change; a response from an older generation is dropped. */
let generation = 0;
let activePrefetches = 0;
let prefetchBudget = new TokenBucket(PREFETCH_BURST, PREFETCH_REFILL_MS);

/**
 * Scope the cache to the signed-in account. A different viewer (or none)
 * drops everything — the response to "who is this?" depends on who asks.
 */
export function bindProfileCacheViewer(userId: string | null | undefined): void {
    const next = userId ?? null;
    if (next === viewer) return;
    viewer = next;
    generation++;
    cache.clear();
    inflight.clear();
}

/** The cached profile (any age), or null. Synchronous — for first paint. */
export function peekProfile(userId: string | null | undefined): PublicProfile | null {
    return userId ? (cache.get(userId)?.profile ?? null) : null;
}

/** Whether the cached copy is young enough to skip a revalidation. */
export function isProfileFresh(userId: string, maxAgeMs = FRESH_MS): boolean {
    const e = cache.get(userId);
    return !!e && Date.now() - e.fetchedAt < maxAgeMs;
}

/** Drop one user's cached profile (e.g. your own, right after editing it). */
export function invalidateProfile(userId: string | null | undefined): void {
    if (userId) cache.delete(userId);
}

/**
 * Your own profile was just edited: drop the cached copy and point the id
 * cache at the new images, so viewing your own card next shows the new
 * picture/banner rather than the old one for a round trip. `patch` is the
 * PATCH /auth/profile body — a key that is absent was not changed.
 */
export function noteProfileEdited(
    userId: string | null | undefined,
    patch: { avatar_url?: string | null; banner_url?: string | null; [k: string]: unknown },
): void {
    if (!userId) return;
    invalidateProfile(userId);
    if ('avatar_url' in patch) rememberUserAvatarId(userId, patch.avatar_url ?? null);
    if ('banner_url' in patch) rememberUserBannerId(userId, patch.banner_url ?? null);
}

/**
 * Record a profile response obtained elsewhere (the DM partner panel fetches
 * the same route) so the card opens from it. Also feeds the id cache.
 */
export function primeProfile(profile: Partial<PublicProfile> & { user_id: string }): void {
    if (!profile?.user_id) return;
    const full: PublicProfile = {
        username: '', discriminator: null, avatar_url: null, banner_url: null, bio: null,
        status: 'offline', custom_status_text: null, custom_status_emoji: null, last_seen_at: null,
        ...profile,
    };
    store(full);
}

function store(profile: PublicProfile): void {
    const uid = profile.user_id;
    cache.delete(uid);
    cache.set(uid, { profile, fetchedAt: Date.now() });
    if (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
    }
    // The ids are what make the NEXT open (and the next boot) start both images
    // on the click. `undefined` (an older server that omits the field) is
    // "learned nothing"; null is "they have none".
    rememberUserAvatarId(uid, profile.avatar_url);
    rememberUserBannerId(uid, profile.banner_url);
    rememberUserName(uid, profile.username);
}

/**
 * Fetch (or reuse) a user's public profile. Concurrent callers share ONE
 * request — the hover prefetch, the press and the card itself all join it.
 * Rejects on failure; the cache keeps whatever it had.
 */
export function fetchProfile(
    userId: string,
    token: string,
    opts?: { maxAgeMs?: number },
): Promise<PublicProfile> {
    const maxAgeMs = opts?.maxAgeMs ?? 0;
    const cached = cache.get(userId);
    if (cached && maxAgeMs > 0 && Date.now() - cached.fetchedAt < maxAgeMs) return Promise.resolve(cached.profile);
    const pending = inflight.get(userId);
    if (pending) return pending;
    const gen = generation;
    const p = axios
        .get(`${API_BASE}/auth/users/${userId}`, { headers: { Authorization: `Bearer ${token}` } })
        .then(res => {
            const profile = res.data as PublicProfile;
            if (!profile || typeof profile !== 'object' || profile.user_id !== userId) {
                throw new Error('unexpected profile response');
            }
            if (gen === generation) store(profile);
            return profile;
        })
        .finally(() => { if (inflight.get(userId) === p) inflight.delete(userId); });
    inflight.set(userId, p);
    return p;
}

/** Start (or join) the image loads for a profile. Foreground lane: someone is pointing at it. */
function warmImages(avatarId: string | null | undefined, bannerId: string | null | undefined, token: string): Promise<unknown> {
    const jobs: Promise<void>[] = [];
    if (avatarId) jobs.push(preloadAvatar(avatarId, token));
    if (bannerId) jobs.push(preloadAvatar(bannerId, token, { kind: 'banner' }));
    return Promise.allSettled(jobs);
}

/** True when opening this profile right now would need nothing from the network. */
function fullyWarm(userId: string): boolean {
    if (!isProfileFresh(userId)) return false;
    const p = cache.get(userId)!.profile;
    return (!p.avatar_url || !!peekAvatarUrl(p.avatar_url)) && (!p.banner_url || !!peekAvatarUrl(p.banner_url));
}

/**
 * Profile + both images, ready for the card. `demand` = a press is about to
 * open it (no budget, no cap); otherwise a hover bet (bounded, may be dropped).
 * Resolves when done or dropped; never rejects.
 */
export async function prefetchProfileMedia(userId: string, token: string, demand = false): Promise<void> {
    if (!userId || !token) return;
    if (fullyWarm(userId)) return;
    if (!demand) {
        if (activePrefetches >= MAX_CONCURRENT_PREFETCH) return;
        if (!prefetchBudget.tryTake()) return;
    }
    activePrefetches += demand ? 0 : 1;
    try {
        // Ids already known (friends list, earlier fetches, last session) start
        // their images NOW, alongside the profile request rather than after it.
        const knownAvatar = lookupUserAvatarId(userId);
        const knownBanner = lookupUserBannerId(userId);
        const early = warmImages(knownAvatar, knownBanner, token);
        let profile: PublicProfile | null = null;
        try {
            profile = await fetchProfile(userId, token, { maxAgeMs: FRESH_MS });
        } catch {
            profile = null;
        }
        const late = profile
            ? warmImages(
                profile.avatar_url !== knownAvatar ? profile.avatar_url : null,
                profile.banner_url !== knownBanner ? profile.banner_url : null,
                token,
            )
            : Promise.resolve();
        await Promise.allSettled([early, late]);
    } finally {
        activePrefetches -= demand ? 0 : 1;
    }
}

/**
 * Hover intent: prefetch after HOVER_DWELL_MS unless cancelled first (pointer
 * left). `immediate` = a press: start now, as demand. Returns the cancel.
 */
export function scheduleProfilePrefetch(
    userId: string | null | undefined,
    token: string | null | undefined,
    opts?: { immediate?: boolean },
): () => void {
    if (!userId || !token) return () => {};
    if (opts?.immediate) {
        void prefetchProfileMedia(userId, token, true);
        return () => {};
    }
    const timer = setTimeout(() => { void prefetchProfileMedia(userId, token, false); }, HOVER_DWELL_MS);
    return () => clearTimeout(timer);
}

/** Tests only — module state is shared by every suite in a file. */
export function __resetProfileCache(): void {
    cache.clear();
    inflight.clear();
    viewer = null;
    generation++;
    activePrefetches = 0;
    prefetchBudget = new TokenBucket(PREFETCH_BURST, PREFETCH_REFILL_MS);
}

/** Tests only. */
export function __activePrefetchCount(): number { return activePrefetches; }
