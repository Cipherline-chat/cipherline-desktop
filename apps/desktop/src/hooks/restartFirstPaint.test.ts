// @vitest-environment jsdom
/**
 * Avatar first-paint behaviour ACROSS AN APP RESTART — the measurement behind
 * `utils/peerIdentityCache.ts`'s persisted layer and
 * `warmAvatarsFromDiskCache`.
 *
 * ── What was reported ───────────────────────────────────────────────────────
 * "I can tell that the icon caching is working, although if I let my PC sit for
 * a while or reboot I think it has to re-cache the profile pictures that we
 * fixed."
 *
 * ── What is actually happening ──────────────────────────────────────────────
 * This is the chat-switch bug one level up, and the same wrong reading is
 * available: "the blob cache must be getting wiped". It is not. `restartNet`
 * below proves the decrypted blobs sit in IndexedDB untouched across a restart
 * — the second session downloads NOTHING. What is gone is everything the app
 * kept in module memory:
 *
 *   - `peerIdentityCache`'s user/device → attachment-id maps, so every row
 *     mounts with `attachmentId === undefined` and waits on a fresh
 *     `GET /conversations/:id/devices` before it knows what to ask for;
 *   - `useEncryptedAvatar`'s `avatarMemoryCache`, so even once the id arrives
 *     the blob URL is an async IndexedDB read away and the row paints the
 *     silhouette first.
 *
 * Both are needed. Persisting the id alone moves `idKnownAtFirstPaint` and
 * leaves `pictureAtFirstPaint` at zero — the id tells the row WHICH blob to
 * ask for, not what it looks like. So the fix is two halves and this file
 * measures them separately so they can never be confused again.
 *
 * ── What this file renders ──────────────────────────────────────────────────
 * The REAL `useEncryptedAvatar` and the REAL `peerIdentityCache`, under the
 * same miniature pane `chatSwitchFirstPaint.test.ts` uses. `restart()` is the
 * whole point: it drops exactly the state a process exit drops (module memory)
 * and keeps exactly what survives on disk (the IndexedDB blob store, the
 * avatar key store, and the encrypted key/value store).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

const axiosGet = vi.fn();
vi.mock('axios', () => ({ default: { get: (...a: unknown[]) => axiosGet(...a) } }));

/** Survives a restart in the real app: Electron SecureStore (`avatar_key:`). */
const keyStore = new Map<string, { keyB64: string; nonceB64: string }>();
vi.mock('../utils/avatarKeyStore', () => ({
    loadAvatarKey: async (id: string) => keyStore.get(id) ?? null,
    saveAvatarKey: async (id: string, keyB64: string, nonceB64: string) => { keyStore.set(id, { keyB64, nonceB64 }); return true; },
    deleteAvatarKey: async (id: string) => { keyStore.delete(id); },
}));

/** Survives a restart in the real app: IndexedDB `avatars_dec`. */
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

/**
 * Survives a restart in the real app: the encrypted key/value store
 * (IndexedDB `kv_enc`). Modelled as a plain map because what is under test is
 * WHETHER the identity cache writes and re-reads it, not the store's crypto —
 * `utils/secureLocalStore.test.ts` owns that against the real KvCrypto.
 */
const kv = new Map<string, string>();
let accountReady = true;
vi.mock('../utils/secureLocalStore', () => {
    const store = {
        getItem: (k: string) => (kv.has(k) ? kv.get(k)! : null),
        setItem: (k: string, v: string) => { kv.set(k, v); },
        removeItem: (k: string) => { kv.delete(k); },
        isAccountReady: (u: string) => accountReady && !!u,
        whenAccountReady: async () => {},
    };
    return { default: store, secureLocalStore: store };
});

import { useEncryptedAvatar, __resetAvatarCaches, warmAvatarsFromDiskCache } from './useEncryptedAvatar';
import {
    rememberIdentities,
    snapshotUserAvatarIds,
    snapshotUserNames,
    knownAvatarIds,
    hydratePeerIdentityCache,
    flushPeerIdentityCache,
    __resetPeerIdentityCache,
} from '../utils/peerIdentityCache';

const TOKEN = 't';
const USER = 'me-0001';
const UNKNOWN = 'Unknown User';

interface DirectoryRow { user_id: string; avatar_url: string; username: string }
const DIRECTORY: Record<string, DirectoryRow> = {
    'u-alice': { user_id: 'u-alice', avatar_url: 'att-alice', username: 'alice' },
    'u-bob': { user_id: 'u-bob', avatar_url: 'att-bob', username: 'bob' },
    'u-carol': { user_id: 'u-carol', avatar_url: 'att-carol', username: 'carol' },
};
const CHAT_MEMBERS: Record<string, string[]> = { 'chat-A': ['u-alice', 'u-bob', 'u-carol'] };

let networkRequests = 0;
/** One entry per row MOUNT: was a blob URL there on the first render? */
let pictureAtFirstPaint: boolean[] = [];
/** One entry per row MOUNT: did the row know WHICH attachment to ask for? */
let idKnownAtFirstPaint: boolean[] = [];
let nameAtFirstPaint: string[] = [];

beforeEach(() => {
    axiosGet.mockReset();
    keyStore.clear();
    blobStore.clear();
    kv.clear();
    accountReady = true;
    __resetPeerIdentityCache();
    __resetAvatarCaches();
    networkRequests = 0;
    pictureAtFirstPaint = [];
    idKnownAtFirstPaint = [];
    nameAtFirstPaint = [];
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

function MessageRow({ attachmentId, name }: { attachmentId: string | undefined; name: string | undefined }) {
    const url = useEncryptedAvatar(attachmentId ?? null, TOKEN);
    React.useState(() => {
        pictureAtFirstPaint.push(url !== null);
        idKnownAtFirstPaint.push(attachmentId !== undefined);
        nameAtFirstPaint.push(name ?? UNKNOWN);
        return null;
    });
    return null;
}

function fetchDirectory(chatId: string): Promise<DirectoryRow[]> {
    return Promise.resolve(CHAT_MEMBERS[chatId].map(u => DIRECTORY[u]));
}

/** Mirrors ChatPane's map lifecycle: seed from the cache, merge the fetch. */
function MiniChatPane({ chatId }: { chatId: string }) {
    const [userIdToAvatar, setUserIdToAvatar] = React.useState<Record<string, string>>(snapshotUserAvatarIds);
    const [userIdToUsername, setUserIdToUsername] = React.useState<Record<string, string>>(snapshotUserNames);
    React.useEffect(() => {
        let alive = true;
        void fetchDirectory(chatId).then(rows => {
            if (!alive) return;
            rememberIdentities(rows);
            setUserIdToAvatar(prev => ({ ...prev, ...Object.fromEntries(rows.map(r => [r.user_id, r.avatar_url])) }));
            setUserIdToUsername(prev => ({ ...prev, ...Object.fromEntries(rows.map(r => [r.user_id, r.username])) }));
        });
        return () => { alive = false; };
    }, [chatId]);
    return React.createElement(
        React.Fragment,
        null,
        ...CHAT_MEMBERS[chatId].map(uid =>
            React.createElement(MessageRow, { key: uid, attachmentId: userIdToAvatar[uid], name: userIdToUsername[uid] }),
        ),
    );
}

async function openChat(root: Root, chatId: string) {
    await act(async () => {
        root.render(React.createElement('div', { key: chatId }, React.createElement(MiniChatPane, { chatId })));
    });
    for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}

/**
 * Drop exactly what an app restart drops.
 *
 * `blobStore` (IndexedDB), `keyStore` (SecureStore) and `kv` (the encrypted
 * key/value store) are deliberately left ALONE — they are on disk. Everything
 * cleared here is JavaScript module state that dies with the process.
 */
async function restart(): Promise<void> {
    await flushPeerIdentityCache();
    __resetAvatarCaches();
    __resetPeerIdentityCache();
    networkRequests = 0;
    pictureAtFirstPaint = [];
    idKnownAtFirstPaint = [];
    nameAtFirstPaint = [];
}

/** What the fixed boot sequence does: hydrate ids, then warm blobs off disk. */
async function boot(): Promise<void> {
    hydratePeerIdentityCache(USER);
    await warmAvatarsFromDiskCache(knownAvatarIds());
}

function tally() {
    return {
        networkRequests,
        mounts: pictureAtFirstPaint.length,
        pictureAtFirstPaint: pictureAtFirstPaint.filter(Boolean).length,
        idKnownAtFirstPaint: idKnownAtFirstPaint.filter(Boolean).length,
        namedAtFirstPaint: nameAtFirstPaint.filter(n => n !== UNKNOWN).length,
    };
}

describe('the blob cache is NOT what a restart loses', () => {
    it('a restarted session re-downloads nothing — the decrypted blobs are still on disk', async () => {
        const root = createRoot(document.createElement('div'));
        hydratePeerIdentityCache(USER);
        await openChat(root, 'chat-A');
        // 3 avatars x 3 requests (key, presigned URL, ciphertext).
        expect(networkRequests).toBe(9);
        expect(blobStore.size).toBe(3);

        await restart();
        const root2 = createRoot(document.createElement('div'));
        await openChat(root2, 'chat-A');

        // THE HEADLINE NUMBER. Zero. Whatever the user is seeing, it is not a
        // re-download, and no amount of blob-cache work can improve on this.
        expect(networkRequests).toBe(0);
    });
});

describe('what a restart DOES lose is the identity and the warm memory cache', () => {
    it('POSITIVE CONTROL: with no boot hydrate, nothing resolves on first paint', async () => {
        const root = createRoot(document.createElement('div'));
        hydratePeerIdentityCache(USER);
        await openChat(root, 'chat-A');

        await restart();
        const root2 = createRoot(document.createElement('div'));
        // No boot() — this is the pre-fix client: module memory is empty and
        // nothing on disk is consulted for the id.
        await openChat(root2, 'chat-A');

        const r = tally();
        expect(r.mounts).toBe(3);
        expect(r.idKnownAtFirstPaint).toBe(0);
        expect(r.pictureAtFirstPaint).toBe(0);
        expect(r.namedAtFirstPaint).toBe(0);
    });

    it('after a boot hydrate + disk warm, every row paints its picture on the FIRST render', async () => {
        const root = createRoot(document.createElement('div'));
        hydratePeerIdentityCache(USER);
        await openChat(root, 'chat-A');

        await restart();
        await boot();
        const root2 = createRoot(document.createElement('div'));
        await openChat(root2, 'chat-A');

        const r = tally();
        expect(r.mounts).toBe(3);
        expect(r.idKnownAtFirstPaint).toBe(3);
        expect(r.pictureAtFirstPaint).toBe(3);
        expect(r.namedAtFirstPaint).toBe(3);
        // And it cost nothing: the ids came off disk and so did the blobs.
        expect(r.networkRequests).toBe(0);
    });

    it('the id alone is not enough — hydrating without the disk warm still flashes', async () => {
        // Pins the two halves apart. If someone later deletes the disk warm
        // believing the persisted id does the whole job, this fails and says
        // why: the row knows WHICH blob it wants and still has to go and read
        // it, which is an async gap and therefore a fallback flash.
        const root = createRoot(document.createElement('div'));
        hydratePeerIdentityCache(USER);
        await openChat(root, 'chat-A');

        await restart();
        hydratePeerIdentityCache(USER);   // ids only, no warmAvatarsFromDiskCache
        const root2 = createRoot(document.createElement('div'));
        await openChat(root2, 'chat-A');

        const r = tally();
        expect(r.idKnownAtFirstPaint).toBe(3);
        expect(r.pictureAtFirstPaint).toBe(0);
    });
});

describe('the persisted identity cache is account-scoped and self-correcting', () => {
    it('writes under a {uid} key and never hydrates another account from it', async () => {
        const root = createRoot(document.createElement('div'));
        hydratePeerIdentityCache(USER);
        await openChat(root, 'chat-A');
        await flushPeerIdentityCache();

        expect([...kv.keys()]).toEqual([`cipherline_peer_identity_${USER}`]);

        __resetPeerIdentityCache();
        hydratePeerIdentityCache('someone-else');
        expect(snapshotUserAvatarIds()).toEqual({});
    });

    it('writes nothing while the account records are still cold', async () => {
        accountReady = false;
        rememberIdentities(Object.values(DIRECTORY));
        hydratePeerIdentityCache(USER);
        await flushPeerIdentityCache();
        expect(kv.size).toBe(0);
    });

    it('a stale persisted id is overwritten by the next directory response', async () => {
        // The peer changed their picture while the app was CLOSED, so no WS
        // event was ever seen. The restored id is wrong for exactly one
        // round-trip — the same window that existed before any of this cache.
        kv.set(`cipherline_peer_identity_${USER}`, JSON.stringify({
            v: 1, savedAt: Date.now(),
            u: [['u-alice', 'att-alice-OLD', 'alice']],
            d: [],
        }));
        hydratePeerIdentityCache(USER);
        expect(snapshotUserAvatarIds()['u-alice']).toBe('att-alice-OLD');

        const root = createRoot(document.createElement('div'));
        await openChat(root, 'chat-A');
        expect(snapshotUserAvatarIds()['u-alice']).toBe('att-alice');

        await flushPeerIdentityCache();
        const persisted = JSON.parse(kv.get(`cipherline_peer_identity_${USER}`)!);
        expect(persisted.u.find((e: string[]) => e[0] === 'u-alice')[1]).toBe('att-alice');
    });

    it('drops a record that has gone cold past the blob cache own age bound', async () => {
        const NINETY_ONE_DAYS = 91 * 24 * 60 * 60 * 1000;
        kv.set(`cipherline_peer_identity_${USER}`, JSON.stringify({
            v: 1, savedAt: Date.now() - NINETY_ONE_DAYS,
            u: [['u-alice', 'att-alice', 'alice']],
            d: [],
        }));
        hydratePeerIdentityCache(USER);
        // The blobs those ids point at were evicted by pruneAvatarCache at the
        // same 90-day mark, so keeping the ids buys a guaranteed re-download
        // with a stale-id risk attached.
        expect(snapshotUserAvatarIds()).toEqual({});
        expect(kv.has(`cipherline_peer_identity_${USER}`)).toBe(false);
    });
});
