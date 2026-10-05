// @vitest-environment jsdom
/**
 * Chat-switch first-paint behaviour — the measurement behind
 * `utils/peerIdentityCache.ts`.
 *
 * ── What was actually wrong ─────────────────────────────────────────────────
 * The owner reported "when I switch chats it loads everyone's profile pictures
 * every time". The obvious reading — the blob cache is cold — is measurably
 * FALSE, and this suite pins both halves of that so nobody re-derives it:
 *
 *   - `networkRequests` proves the blob cache already worked: a chat-A → B → A
 *     → B walk downloads each distinct avatar exactly once (3 requests: key,
 *     presigned URL, ciphertext), and every later mount is free.
 *   - `avatarFirstPaint` proves what the user was actually seeing: before the
 *     identity cache, ZERO of those mounts had a URL on their first render, so
 *     every row painted the silhouette fallback and then cross-faded the image
 *     in ~180 ms later (EncryptedAvatar captures `instant` on first render).
 *
 * The missing cache was the ATTACHMENT ID, not the blob. Dashboard keys the
 * ChatPane wrapper on `activeChat.id`, so the pane remounts on every switch and
 * its `useState({})` maps restarted empty, waiting on a fresh
 * `GET /conversations/:id/devices` before any row knew which attachment to ask
 * for.
 *
 * `nameFirstPaint` is the same bug wearing a different symptom, and is tracked
 * here rather than in its own file precisely so the two cannot drift apart:
 * `deviceToUsername` / `userIdToUsername` reset on the identical remount for
 * the identical reason, so every row also rendered the literal words "Unknown
 * User" for people the client had fully resolved seconds earlier.
 *
 * ── What this file renders ──────────────────────────────────────────────────
 * The REAL `useEncryptedAvatar` and the REAL `peerIdentityCache`, under a
 * miniature pane that mirrors ChatPane's map lifecycle exactly: remounted via a
 * changing React key, maps seeded from the identity cache, merged (not
 * replaced) when the async directory response lands. ChatPane itself is a
 * ~6.7k-line component with no render harness — `components/avatarWarmingWiring
 * .test.ts` covers "the real pane is actually wired this way" by source scan,
 * the same split this repo already uses for Dashboard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

const axiosGet = vi.fn();
vi.mock('axios', () => ({ default: { get: (...a: unknown[]) => axiosGet(...a) } }));

const keyStore = new Map<string, { keyB64: string; nonceB64: string }>();
vi.mock('../utils/avatarKeyStore', () => ({
    loadAvatarKey: async (id: string) => keyStore.get(id) ?? null,
    saveAvatarKey: async (id: string, keyB64: string, nonceB64: string) => { keyStore.set(id, { keyB64, nonceB64 }); return true; },
    deleteAvatarKey: async (id: string) => { keyStore.delete(id); },
}));

const blobStore = new Map<string, Blob>();
vi.mock('../utils/attachmentCache', () => ({
    getAvatarBlob: async (id: string) => blobStore.get(id) ?? null,
    putAvatarBlob: async (id: string, b: Blob) => { blobStore.set(id, b); },
    deleteAvatarBlob: async (id: string) => { blobStore.delete(id); },
}));

vi.mock('../utils/crypto', () => ({
    importKeyFromBase64: async (k: string) => ({ k }),
    decryptBlob: async () => new Blob(['plain']),
}));

vi.mock('../contexts/HydrationContext', () => ({ useHydrationGeneration: () => 0 }));

import { useEncryptedAvatar, __resetAvatarCaches } from './useEncryptedAvatar';
import {
    rememberIdentities,
    snapshotUserAvatarIds,
    snapshotUserNames,
    __resetPeerIdentityCache,
} from '../utils/peerIdentityCache';

const TOKEN = 't';
/** ChatPane's own last-resort label when no map can name the sender. */
const UNKNOWN = 'Unknown User';

interface DirectoryRow { user_id: string; avatar_url: string; username: string }
/** What the server would answer for each member of a conversation. */
const DIRECTORY: Record<string, DirectoryRow> = {
    'u-alice': { user_id: 'u-alice', avatar_url: 'att-alice', username: 'alice' },
    'u-bob': { user_id: 'u-bob', avatar_url: 'att-bob', username: 'bob' },
    'u-carol': { user_id: 'u-carol', avatar_url: 'att-carol', username: 'carol' },
    'u-dave': { user_id: 'u-dave', avatar_url: 'att-dave', username: 'dave' },
    'u-erin': { user_id: 'u-erin', avatar_url: 'att-erin', username: 'erin' },
};
const CHAT_MEMBERS: Record<string, string[]> = {
    'chat-A': ['u-alice', 'u-bob', 'u-carol'],
    'chat-B': ['u-dave', 'u-erin'],
};

let networkRequests = 0;
let directoryFetches = 0;
/** One entry per row MOUNT: was the blob URL there on the first render? */
let avatarFirstPaint: boolean[] = [];
/** One entry per row MOUNT: the label the row rendered on its first render. */
let nameFirstPaint: string[] = [];

beforeEach(() => {
    axiosGet.mockReset();
    keyStore.clear();
    blobStore.clear();
    __resetPeerIdentityCache();
    // Both session caches are MODULE state. Without this the second scenario in
    // a file inherits the first one's warm memory cache and "0 requests" passes
    // for entirely the wrong reason.
    __resetAvatarCaches();
    networkRequests = 0;
    directoryFetches = 0;
    avatarFirstPaint = [];
    nameFirstPaint = [];
    (globalThis as { URL: typeof URL }).URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`);
    (globalThis as { URL: typeof URL }).URL.revokeObjectURL = vi.fn();
    axiosGet.mockImplementation(async (u: string) => {
        networkRequests++;
        if (u.includes('/key')) return { data: { file_key_b64: 'K', file_nonce_b64: 'n' } };
        if (u.includes('/download')) return { data: { download_url: 'https://media/x', mime_type: 'image/png' } };
        if (u.startsWith('https://media')) return { data: new Blob(['cipher']) };
        throw new Error('unexpected ' + u);
    });
});

/**
 * Mirrors one message row. The avatar half mirrors EncryptedAvatar, whose
 * `instant` flag is captured on the component's FIRST render and decides
 * whether the image paints solid or starts at opacity 0 and cross-fades; the
 * name half mirrors ChatPane's `resolvedName` fallback chain.
 *
 * Recording both IS the measurement, so it happens in the render body — a
 * `useState` initialiser, which React runs exactly once per mount, during that
 * first render, and never on a re-render.
 */
function MessageRow({ attachmentId, name }: { attachmentId: string | undefined; name: string | undefined }) {
    const url = useEncryptedAvatar(attachmentId ?? null, TOKEN);
    React.useState(() => {
        avatarFirstPaint.push(url !== null);
        nameFirstPaint.push(name ?? UNKNOWN);
        return null;
    });
    return null;
}

/** Stands in for GET /conversations/:id/devices. */
function fetchDirectory(chatId: string): Promise<DirectoryRow[]> {
    directoryFetches++;
    return Promise.resolve(CHAT_MEMBERS[chatId].map(u => DIRECTORY[u]));
}

/** `seed: false` reproduces the pre-fix pane, whose maps started at {}. */
function MiniChatPane({ chatId, seed }: { chatId: string; seed: boolean }) {
    const [userIdToAvatar, setUserIdToAvatar] = React.useState<Record<string, string>>(
        seed ? snapshotUserAvatarIds : () => ({}),
    );
    const [userIdToUsername, setUserIdToUsername] = React.useState<Record<string, string>>(
        seed ? snapshotUserNames : () => ({}),
    );
    React.useEffect(() => {
        let alive = true;
        void fetchDirectory(chatId).then(rows => {
            if (!alive) return;
            if (seed) rememberIdentities(rows);
            const avatars = Object.fromEntries(rows.map(r => [r.user_id, r.avatar_url]));
            const names = Object.fromEntries(rows.map(r => [r.user_id, r.username]));
            setUserIdToAvatar(prev => (seed ? { ...prev, ...avatars } : avatars));
            setUserIdToUsername(prev => (seed ? { ...prev, ...names } : names));
        });
        return () => { alive = false; };
    }, [chatId, seed]);
    return React.createElement(
        React.Fragment,
        null,
        ...CHAT_MEMBERS[chatId].map(uid =>
            React.createElement(MessageRow, {
                key: uid,
                attachmentId: userIdToAvatar[uid],
                name: userIdToUsername[uid],
            }),
        ),
    );
}

async function switchTo(root: Root, chatId: string, seed: boolean) {
    // The changing key is what forces the full remount, exactly as Dashboard's
    // `key={activeChat?.id ?? activeChannel?.channel_id}` wrapper does.
    await act(async () => {
        root.render(React.createElement(
            'div',
            { key: chatId },
            React.createElement(MiniChatPane, { chatId, seed }),
        ));
    });
    // Let the directory fetch and the avatar pipeline settle.
    for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}

async function walk(seed: boolean) {
    const root = createRoot(document.createElement('div'));
    await switchTo(root, 'chat-A', seed);
    const coldA = { net: networkRequests, mounts: avatarFirstPaint.length };
    await switchTo(root, 'chat-B', seed);
    await switchTo(root, 'chat-A', seed);
    await switchTo(root, 'chat-B', seed);
    return {
        coldA,
        networkRequests,
        directoryFetches,
        mounts: avatarFirstPaint.length,
        avatarsResolvedOnFirstPaint: avatarFirstPaint.filter(Boolean).length,
        namesResolvedOnFirstPaint: nameFirstPaint.filter(n => n !== UNKNOWN).length,
        // Mounts after the very first visit to each chat — the ones the owner
        // watches reload.
        revisitAvatars: avatarFirstPaint.slice(5),
        revisitNames: nameFirstPaint.slice(5),
    };
}

describe('the blob cache was never the problem', () => {
    it('downloads each distinct avatar exactly once across four chat switches, seeded or not', async () => {
        const seeded = await walk(true);
        __resetPeerIdentityCache();
        __resetAvatarCaches();
        blobStore.clear(); keyStore.clear();
        networkRequests = 0; avatarFirstPaint = []; nameFirstPaint = []; directoryFetches = 0;
        const unseeded = await walk(false);

        // 5 distinct avatars x 3 requests (key, presigned URL, ciphertext).
        expect(unseeded.networkRequests).toBe(15);
        expect(seeded.networkRequests).toBe(15);
        // 10 row mounts, 15 requests — i.e. every revisit was already warm.
        expect(unseeded.mounts).toBe(10);
        expect(seeded.mounts).toBe(10);
    });
});

describe('the avatar IDENTITY is what was not cached', () => {
    it('POSITIVE CONTROL: without the identity cache, no avatar resolves on first paint', async () => {
        const r = await walk(false);
        // This is the pre-fix behaviour and the reason the owner sees a reload:
        // every single mount paints the fallback, then cross-fades the image in.
        expect(r.avatarsResolvedOnFirstPaint).toBe(0);
        expect(r.revisitAvatars).toEqual([false, false, false, false, false]);
    });

    it('with the identity cache, every REVISITED avatar resolves on its first render', async () => {
        const r = await walk(true);
        // The 5 cold mounts (first visit to each chat) still resolve
        // asynchronously — there is nothing to serve them yet, and a cross-fade
        // is the right answer there.
        expect(r.coldA.mounts).toBe(3);
        // Every mount after that paints solid: the id is seeded synchronously
        // and useEncryptedAvatar's useState initialiser hits the warm memory
        // cache before the first render commits.
        expect(r.revisitAvatars).toEqual([true, true, true, true, true]);
        expect(r.avatarsResolvedOnFirstPaint).toBe(5);
        // And it bought that with no extra requests at all.
        expect(r.networkRequests).toBe(15);
    });
});

describe('the NAME is the same bug wearing a different symptom', () => {
    it('POSITIVE CONTROL: without the identity cache, every row opens on "Unknown User"', async () => {
        const r = await walk(false);
        expect(r.namesResolvedOnFirstPaint).toBe(0);
        expect(r.revisitNames).toEqual([UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN]);
    });

    it('with the identity cache, a previously-seen peer is NAMED on the first render', async () => {
        const r = await walk(true);
        // Same shape as the avatar assertion above, deliberately: the first
        // visit to each chat is genuinely cold (nothing to serve), and every
        // revisit renders the real handle with no round-trip and no flash.
        // Mounts 5-9 are the SECOND visit to chat-A (alice, bob, carol) and the
        // second visit to chat-B (dave, erin), in render order.
        expect(r.revisitNames).toEqual(['u-alice', 'u-bob', 'u-carol', 'u-dave', 'u-erin']
            .map(uid => DIRECTORY[uid].username));
        expect(r.namesResolvedOnFirstPaint).toBe(5);
        // Names ride responses the client already fetched — no extra requests,
        // and no new server field is assumed anywhere in this path.
        expect(r.directoryFetches).toBe(4);
        expect(r.networkRequests).toBe(15);
    });
});
