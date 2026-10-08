// @vitest-environment jsdom
/**
 * Profile-open LATENCY HARNESS — the measurement behind the profile-media
 * speed work ("when opening people's profiles, their profile picture and
 * banner take a while to load").
 *
 * Renders the REAL row `EncryptedAvatar` → click → `ProfileModal` → `Banner`
 * / `EncryptedAvatar` → `useEncryptedAvatar` → `peerIdentityCache` /
 * `profileCache` stack on a simulated clock, driven by real DOM events
 * (pointer over, pointer down, click). Only the edges are modelled:
 *
 *   - every API request costs one round trip plus that route's server time;
 *   - a presigned media GET costs a round trip plus the payload at a fixed
 *     bandwidth (prod media sits behind Cloudflare, HTTP/2);
 *   - the encrypted IndexedDB blob cache (attachmentCache) costs a read plus an
 *     unwrap proportional to size; SecureStore key reads cost one IPC hop;
 *   - decrypt runs in the attachment-crypto worker: a fixed hop plus size.
 *
 * The numbers are a MODEL (see LATENCY below), not a field measurement. What
 * they make visible is structure: how many SERIAL round trips stand between
 * the click and each image, and what is already cached when the card mounts.
 * Every scenario reports, from the CLICK, when each image was attached to the
 * card (src set) and whether it was there on the card's FIRST paint (no
 * placeholder at all).
 *
 * The harness feature-detects everything added by the speed work, so the same
 * file runs on the pre-fix tree for the baseline:
 *   CL_PROFILE_BENCH=1 CL_PROFILE_BENCH_BASELINE=1 npx vitest run src/components/profileOpenLatency.test.ts
 * Print the table:  CL_PROFILE_BENCH=1 npx vitest run src/components/profileOpenLatency.test.ts
 * Without the env vars it runs every scenario and asserts the budgets.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

// jsdom has no matchMedia; the kit's physics module reads it at import time.
vi.hoisted(() => {
    const w = globalThis as unknown as { matchMedia?: unknown };
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});

// ── Latency model ────────────────────────────────────────────────────────────
const LATENCY = {
    /** Client ↔ Cloudflare ↔ origin round trip (US client, St. Louis origin). */
    rttMs: 70,
    /** Server-side time per API route (DB + Redis work). */
    server: { profile: 35, key: 15, download: 20 } as Record<string, number>,
    /** Effective media bandwidth, bytes per ms (2.5 MB/s ≈ 20 Mbit/s). */
    mediaBytesPerMs: 2_500,
    /** IndexedDB read + AES-GCM unwrap of a cached blob. */
    idbBaseMs: 6,
    idbBytesPerMs: 50_000,
    /** SecureStore avatar-key read (one IPC hop to main). */
    keyIpcMs: 2,
    /** Worker decrypt: postMessage hop + AES-GCM. */
    decryptBaseMs: 3,
    decryptBytesPerMs: 100_000,
};
/** Payload sizes (median of 17 real 1920×1080 frames, libjpeg q0.85, 4:2:0). */
const SIZE = {
    avatar: 45 * 1024,       // 512×512 (unchanged)
    banner: Number(process.env.CL_PROFILE_BENCH_BANNER_KB ?? 131) * 1024, // 1500×600 legacy; 91 KB at 1200×480
};

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
let apiRequests = 0;
let mediaRequests = 0;

const MEDIA: Record<string, { bytes: number; mime: string }> = {};

async function apiGet(u: string): Promise<{ data: unknown }> {
    apiRequests++;
    const route = u.includes('/auth/users/') ? 'profile' : u.endsWith('/key') ? 'key' : u.endsWith('/download') ? 'download' : 'other';
    await sleep(LATENCY.rttMs + (LATENCY.server[route] ?? 20));
    if (route === 'profile') {
        const uid = u.split('/auth/users/')[1];
        const p = PROFILES[uid];
        if (!p) throw Object.assign(new Error('404'), { response: { status: 404 } });
        return { data: { ...p } };
    }
    const id = u.split('/attachments/')[1]?.split('/')[0];
    if (route === 'key') return { data: { file_key_b64: `K-${id}`, file_nonce_b64: 'n' } };
    if (route === 'download') return { data: { download_url: `https://media.test/${id}`, mime_type: MEDIA[id].mime } };
    throw new Error('unexpected ' + u);
}

async function mediaGet(u: string): Promise<{ data: Blob }> {
    mediaRequests++;
    const id = u.split('https://media.test/')[1];
    const { bytes } = MEDIA[id];
    await sleep(LATENCY.rttMs + 10 + Math.round(bytes / LATENCY.mediaBytesPerMs));
    return { data: Object.assign(new Blob(['c']), { __bytes: bytes, __id: id }) };
}

const axiosGet = vi.fn(async (u: string) => (u.startsWith('https://media.test/') ? mediaGet(u) : apiGet(u)));
vi.mock('axios', () => ({
    default: {
        get: (u: string) => axiosGet(u),
        post: vi.fn(async () => { throw new Error('no post in harness'); }),
        patch: vi.fn(async () => ({ data: {} })),
        isAxiosError: () => false,
    },
}));

/** On disk in the real app: Electron SecureStore `avatar_key:*`. */
const keyStore = new Map<string, { keyB64: string; nonceB64: string }>();
vi.mock('../utils/avatarKeyStore', () => ({
    loadAvatarKey: async (id: string) => { await sleep(LATENCY.keyIpcMs); return keyStore.get(id) ?? null; },
    saveAvatarKey: async (id: string, keyB64: string, nonceB64: string) => { keyStore.set(id, { keyB64, nonceB64 }); return true; },
    deleteAvatarKey: async (id: string) => { keyStore.delete(id); },
}));

/** On disk in the real app: IndexedDB `avatars_dec`, wrapped. */
const blobStore = new Map<string, { bytes: number; kind?: string }>();
vi.mock('../utils/attachmentCache', () => ({
    getAvatarBlob: async (id: string) => {
        const hit = blobStore.get(id);
        await sleep(LATENCY.idbBaseMs + (hit ? Math.round(hit.bytes / LATENCY.idbBytesPerMs) : 0));
        return hit ? Object.assign(new Blob(['p']), { __bytes: hit.bytes }) : null;
    },
    putAvatarBlob: async (id: string, b: Blob & { __bytes?: number }, opts?: { kind?: string }) => {
        blobStore.set(id, { bytes: b.__bytes ?? 1, kind: opts?.kind });
    },
    deleteAvatarBlob: async (id: string) => { blobStore.delete(id); },
}));

vi.mock('../utils/crypto', () => ({
    importKeyFromBase64: async (k: string) => ({ k }),
    decryptBlob: async (b: Blob & { __bytes?: number }) => {
        const bytes = b.__bytes ?? 1;
        await sleep(LATENCY.decryptBaseMs + Math.round(bytes / LATENCY.decryptBytesPerMs));
        return Object.assign(new Blob(['p']), { __bytes: bytes });
    },
}));

vi.mock('../contexts/HydrationContext', () => ({ useHydrationGeneration: () => 0 }));

const kv = new Map<string, string>();
vi.mock('../utils/secureLocalStore', () => {
    const store = {
        getItem: (k: string) => (kv.has(k) ? kv.get(k)! : null),
        setItem: (k: string, v: string) => { kv.set(k, v); },
        removeItem: (k: string) => { kv.delete(k); },
        isAccountReady: (u: string) => !!u,
        whenAccountReady: async () => {},
    };
    return { default: store, secureLocalStore: store };
});

import { ProfileModal } from './ProfileModal';
import { EncryptedAvatar } from './EncryptedAvatar';
import { FriendshipContext } from '../contexts/FriendshipContext';
import { ProfileOpenContext } from '../contexts/ProfileOpenContext';
import * as avatarMod from '../hooks/useEncryptedAvatar';
import * as identity from '../utils/peerIdentityCache';

// Optional modules/exports that only exist once the speed work has landed.
type ProfileCacheMod = { __resetProfileCache?: () => void };
let profileCacheMod: ProfileCacheMod = {};
const identityExt = identity as unknown as { rememberUserBannerId?: (u: string, b: string | null) => void };

const ME = 'u-me';
const TOKEN = 't';
const FRIEND = 'u-friend';
const MEMBER = 'u-member';
const PROFILES: Record<string, Record<string, unknown>> = {
    [FRIEND]: {
        user_id: FRIEND, username: 'alice', discriminator: 1234, avatar_url: 'att-av-f', banner_url: 'att-bn-f',
        bio: 'hi', status: 'online', custom_status_text: null, custom_status_emoji: null, last_seen_at: null, badges: [],
    },
    [MEMBER]: {
        user_id: MEMBER, username: 'bob', discriminator: 42, avatar_url: 'att-av-m', banner_url: 'att-bn-m',
        bio: null, status: 'online', custom_status_text: null, custom_status_emoji: null, last_seen_at: null, badges: [],
    },
};

interface Measurement {
    avatarAt: number | null;
    bannerAt: number | null;
    avatarAtFirstPaint: boolean;
    bannerAtFirstPaint: boolean;
    apiRequests: number;
    mediaRequests: number;
}

const container = () => document.body.querySelector('#root') as HTMLElement;
const avatarImg = () => container().querySelector('button[aria-label="View avatar"] img') as HTMLImageElement | null;
const bannerImg = () => container().querySelector('.cipherline-banner-img') as HTMLImageElement | null;
const rowAvatar = (uid: string) => container().querySelector(`[data-row="${uid}"] > *`) as HTMLElement;

let root: Root;

/** Simulate the browser finishing decode of every attached blob image. */
function fireLoads() {
    container().querySelectorAll('img').forEach(img => {
        const el = img as HTMLImageElement & { __loaded?: string };
        if (el.src && el.__loaded !== el.src) {
            el.__loaded = el.src;
            el.dispatchEvent(new Event('load'));
        }
    });
}

/**
 * A miniature Dashboard: one row avatar per person (friend-gated exactly as
 * in a member list or chat) inside the same two contexts Dashboard provides,
 * and the profile card that the row's click opens.
 */
function App({ friends }: { friends: Set<string> }) {
    const [open, setOpen] = React.useState<string | null>(null);
    const isFriend = React.useCallback((u: string | null | undefined) => !!u && (u === ME || friends.has(u)), [friends]);
    const openFn = React.useCallback((uid: string) => setOpen(uid), []);
    return React.createElement(FriendshipContext.Provider, { value: isFriend },
        React.createElement(ProfileOpenContext.Provider, { value: openFn },
            ...[FRIEND, MEMBER].map(uid => React.createElement('div', { key: uid, 'data-row': uid },
                React.createElement(EncryptedAvatar, {
                    attachmentId: identity.lookupUserAvatarId(uid), userId: uid, token: TOKEN, className: 'row',
                }))),
            open && React.createElement(ProfileModal, {
                key: `modal-${open}`, userId: open, token: TOKEN, currentUserId: ME, friendStatuses: {}, onClose: () => setOpen(null),
                anchor: { x: 200, y: 200 }, isFriend: friends.has(open),
            })));
}

async function tick(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    fireLoads();
}

/**
 * Open `userId`'s card the way a user does and time it from the CLICK.
 *   hoverMs — pointer rested on the row avatar this long first (0 = no hover)
 *   pressMs — button held this long before the click lands (a real click is
 *             ~80-120 ms press-to-release; 0 = keyboard / context-menu open)
 */
async function openProfile(
    userId: string,
    friends: Set<string>,
    { hoverMs = 0, pressMs = 100 }: { hoverMs?: number; pressMs?: number } = {},
    horizonMs = 1500,
): Promise<Measurement> {
    act(() => { root.render(React.createElement(App, { friends })); });
    await tick(600); // the list has been on screen a moment (row avatars loaded)
    const row = () => rowAvatar(userId);
    if (hoverMs) {
        act(() => { row().dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null })); });
        await tick(hoverMs);
    }
    apiRequests = 0;
    mediaRequests = 0;
    if (pressMs) {
        act(() => { row().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })); });
        await tick(pressMs);
    }
    // t = 0: the click. First paint is whatever this synchronous commit shows.
    act(() => { row().dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 200, clientY: 200 })); });
    fireLoads();
    const avatarAtFirstPaint = !!avatarImg()?.getAttribute('src');
    const bannerAtFirstPaint = !!bannerImg()?.getAttribute('src');
    let avatarAt: number | null = avatarAtFirstPaint ? 0 : null;
    let bannerAt: number | null = bannerAtFirstPaint ? 0 : null;
    for (let t = 1; t <= horizonMs && (avatarAt === null || bannerAt === null); t++) {
        await tick(1);
        if (avatarAt === null && avatarImg()?.getAttribute('src')) avatarAt = t;
        if (bannerAt === null && bannerImg()?.getAttribute('src')) bannerAt = t;
    }
    // Let trailing work (revalidation, disk persist) settle before the next scenario.
    await tick(2_000);
    const m = { avatarAt, bannerAt, avatarAtFirstPaint, bannerAtFirstPaint, apiRequests, mediaRequests };
    act(() => { root.render(React.createElement('div')); });
    return m;
}

/** What Dashboard does once the friends list lands (ids only, no network). */
function learnFriendsList() {
    for (const uid of [FRIEND]) {
        const p = PROFILES[uid];
        identity.rememberIdentities([{ user_id: uid, avatar_url: p.avatar_url as string, username: p.username as string }]);
        identityExt.rememberUserBannerId?.(uid, p.banner_url as string);
    }
}

/** Drop module memory, keep disk (blob store, key store, kv) — a restart. */
async function restart() {
    await identity.flushPeerIdentityCache();
    avatarMod.__resetAvatarCaches();
    profileCacheMod.__resetProfileCache?.();
    identity.__resetPeerIdentityCache();
    identity.hydratePeerIdentityCache(ME);
    // Boot disk warm (useAvatarWarming) of every known avatar id.
    await act(async () => {
        const p = avatarMod.warmAvatarsFromDiskCache(identity.knownAvatarIds());
        await vi.advanceTimersByTimeAsync(500);
        await p;
    });
}

/** Forget everything — a brand-new device. */
function coldStart() {
    keyStore.clear(); blobStore.clear(); kv.clear();
    avatarMod.__resetAvatarCaches();
    profileCacheMod.__resetProfileCache?.();
    identity.__resetPeerIdentityCache();
    identity.hydratePeerIdentityCache(ME);
}

function seedMedia() {
    for (const p of Object.values(PROFILES)) {
        MEDIA[p.avatar_url as string] = { bytes: SIZE.avatar, mime: 'image/jpeg' };
        MEDIA[p.banner_url as string] = { bytes: SIZE.banner, mime: 'image/jpeg' };
    }
}

const results: Array<[string, Measurement]> = [];
const fmt = (v: number | null, first: boolean) => (v === null ? 'never' : first ? '0 (first paint)' : `${v} ms`);

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
        const path = '../utils/profileCache';
        profileCacheMod = (await import(/* @vite-ignore */ path)) as ProfileCacheMod;
    } catch { profileCacheMod = {}; }
    coldStart();
    seedMedia();
    (globalThis as { URL: typeof URL }).URL.createObjectURL = vi.fn(() => `blob:${Math.random().toString(36).slice(2)}`);
    (globalThis as { URL: typeof URL }).URL.revokeObjectURL = vi.fn();
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(container());
});

afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
});

const BENCH = process.env.CL_PROFILE_BENCH === '1';
const BASELINE = process.env.CL_PROFILE_BENCH_BASELINE === '1';

describe('profile open latency (model)', () => {
    it('measures every scenario', async () => {
        const friends = new Set([FRIEND]);

        // A. Friend, first open this session: their avatar is on screen (it is
        //    what gets clicked); their banner has never been fetched here.
        learnFriendsList();
        results.push(['A. friend, first open (banner never fetched)', await openProfile(FRIEND, friends)]);

        // B. Re-open the same profile in the same session.
        results.push(['B. friend, re-open same session', await openProfile(FRIEND, friends)]);

        // C. After an app restart: blobs + keys on disk, module memory gone.
        await restart();
        learnFriendsList();
        results.push(['C. friend, first open after restart', await openProfile(FRIEND, friends)]);

        // D. Server member (not a friend), nothing cached, opened from a
        //    context menu ("View Profile") — no pointer lead at all.
        results.push(['D. non-friend, all cold, menu open', await openProfile(MEMBER, friends, { pressMs: 0 })]);

        // E. That non-friend again after a restart.
        await restart();
        learnFriendsList();
        results.push(['E. non-friend, after restart', await openProfile(MEMBER, friends)]);

        // F. Non-friend, all cold, clicked on their avatar (100 ms press).
        coldStart();
        learnFriendsList();
        results.push(['F. non-friend, all cold, avatar click', await openProfile(MEMBER, friends)]);

        // G. Friend, banner cold, pointer rested 350 ms on the avatar first.
        coldStart();
        learnFriendsList();
        results.push(['G. friend, banner cold, 350 ms hover', await openProfile(FRIEND, friends, { hoverMs: 350 })]);

        if (BENCH) {
            const rows = results.map(([name, m]) =>
                `${name.padEnd(46)} avatar ${fmt(m.avatarAt, m.avatarAtFirstPaint).padEnd(16)} banner ${fmt(m.bannerAt, m.bannerAtFirstPaint).padEnd(16)} api ${m.apiRequests}  media ${m.mediaRequests}`);
            console.log(`\nprofile-open latency model (rtt ${LATENCY.rttMs} ms, ${LATENCY.mediaBytesPerMs / 1000} MB/s, banner ${SIZE.banner >> 10} KB)\n${rows.join('\n')}\n`);
        }
        if (BASELINE) return;

        const byName = Object.fromEntries(results.map(([n, m]) => [n[0], m]));
        // A: the clicked avatar is already decrypted in memory — it must be on
        //    the card's first paint, not behind the profile fetch.
        expect(byName.A.avatarAtFirstPaint).toBe(true);
        // A: a friend's banner id is known from the friends list, so its load
        //    starts at the press: one parallel key+URL round trip and the
        //    media GET, never four serial round trips after the profile.
        expect(byName.A.bannerAt!).toBeLessThan(250);
        // B, C, E: anything this device has already seen paints with the card.
        expect(byName.B.avatarAtFirstPaint && byName.B.bannerAtFirstPaint).toBe(true);
        expect(byName.C.avatarAtFirstPaint).toBe(true);
        expect(byName.C.bannerAt!).toBeLessThan(30);
        expect(byName.E.bannerAt!).toBeLessThan(30);
        // D, F: a cold non-friend is bounded by the round trips, not a waterfall.
        expect(byName.D.bannerAt!).toBeLessThan(380);
        expect(byName.F.bannerAt!).toBeLessThan(byName.D.bannerAt!);
        // G: a hover long enough to read a name has done the work already.
        expect(byName.G.avatarAtFirstPaint && byName.G.bannerAtFirstPaint).toBe(true);
    }, 60_000);
});
