// @vitest-environment jsdom
/**
 * The receiving end of a history transfer, drawn: a brand-new device imports the
 * vault another device of yours sent (what HistorySyncBanner applies) and an OLD
 * sticker message from that history renders its picture - for a sticker a
 * friend sent you (its bytes only ever lived in the received cache) and for one
 * of your own My stickers. The real StickerMessage -> StickerImage ->
 * PersonalEmojiImage -> usePersonalEmojiUrl -> blob store path; secureLocalStore
 * and the Electron file bridge are in-memory fakes.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.setConfig({ testTimeout: 60_000 });

const mem = new Map<string, string>();
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    keysWithPrefix: (p: string) => [...mem.keys()].filter(k => k.startsWith(p)),
    get length() { return mem.size; },
    key: (i: number) => [...mem.keys()][i] ?? null,
    hydrateMessages: async () => {},
    whenAccountReady: async () => {},
    isAccountReady: (u: string) => u === USER,
    flushNow: async () => {},
};
vi.mock('../../utils/secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));
vi.mock('../../utils/attachmentDownload', () => ({ downloadEncryptedAttachment: async () => null }));
vi.mock('../../hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => false }));

const gifFiles = new Map<string, Uint8Array>();
const electronAPI = {
    getUserDataPath: async () => '/ud',
    listGifFiles: async () => [...gifFiles.keys()],
    readGifFile: async (name: string) => { const f = gifFiles.get(name); if (!f) throw new Error('ENOENT'); return f; },
    writeGifFile: async (name: string, data: Uint8Array) => { gifFiles.set(name, data.slice()); },
    deleteFile: async (path: string) => { gifFiles.delete(path.replace('/ud/cipherline-gifs/', '').replace(/\.enc$/, '')); return { ok: true }; },
    listCustomSounds: async () => [],
};

// jsdom has no matchMedia; a module in the component tree reads it at load.
Object.assign(window, {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
});

const { buildLocalVault, importLocalHistory } = await import('../../utils/crypto');
const { personalEmojis, personalStickers } = await import('../../utils/personalEmoji/service');
const { personalEmojiIdFromBytes, bytesToB64 } = await import('../../utils/personalEmoji/token');
const { takeSticker, stickerRefOf, buildStickerContent } = await import('../../utils/stickers/wire');
const messageStore = await import('../../utils/messageStore');
const { StickerMessage } = await import('./StickerMessage');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USER = 'sticker-render-user';

function png(n: number, seed: number): Uint8Array {
    const b = new Uint8Array(n);
    for (let i = 8; i < n; i++) b[i] = (i * 17 + seed) & 0x7f;
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    b[8] = seed;
    return b;
}

/** importLocalHistory reads only `.text()`; jsdom's Blob may not have it. */
const jsonBlob = (v: unknown) => ({ text: async () => JSON.stringify(v) }) as unknown as Blob;

/** jsdom has no object URLs; record what each one was made from. */
const urlBytes = new Map<string, number>();
let urlSeq = 0;

let root: Root;
let host: HTMLDivElement;

beforeAll(() => {
    Object.assign(URL, {
        createObjectURL: (b: Blob) => { const u = `blob:sticker-${++urlSeq}`; urlBytes.set(u, b.size); return u; },
        revokeObjectURL: () => {},
    });
});

function freshDevice() {
    mem.clear();
    gifFiles.clear();
    messageStore._resetForTest();
    personalEmojis().store.resetSession();
    mem.set('cipherline_user_id', USER);
}

beforeEach(() => {
    freshDevice();
    Object.assign(window, { electronAPI });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

/** Old device: a sticker from Bob and one of your own, in a DM; then the transfer vault. */
async function oldDeviceVault(opts: { dropImages?: boolean } = {}) {
    const bobBytes = png(5000, 4);
    const bobId = await personalEmojiIdFromBytes(bobBytes);
    const got = takeSticker({
        type: 'text', text: '[Sticker: bob_wave]',
        sticker: { source: 'personal', id: bobId, name: 'bob_wave', mime: 'image/png', animated: false, bytes_b64: bytesToB64(bobBytes) },
    }, personalEmojis().store);
    expect(await got.stored).toBe(true);
    const mine = await personalStickers().add(png(3000, 6), 'party');
    if (!mine.ok) throw new Error('add failed');
    messageStore.saveAll('dm', USER, {
        'conv-bob': [
            { id: 'm1', sender_id: 'bob', timestamp: 1, content: got.content },
            { id: 'm2', sender_id: USER, timestamp: 2, content: buildStickerContent({ source: 'personal', id: mine.entry.id, name: 'party', mime: 'image/png' }) },
        ],
    });
    // exportLocalHistory is JSON.stringify(buildLocalVault(...)) in a Blob.
    const vault = JSON.parse(JSON.stringify(await buildLocalVault(USER, { rangeDays: null })));
    if (opts.dropImages) vault.emojiFiles = {};
    return { vault, sizes: { m1: bobBytes.length, m2: 3000 } };
}

async function renderTransferred(id: 'm1' | 'm2') {
    const msg = (await messageStore.loadAll('dm', USER))['conv-bob'].find(m => m.id === id)!;
    const ref = stickerRefOf(msg.content);
    expect(ref).not.toBeNull();
    await act(async () => { root.render(React.createElement(StickerMessage, { sticker: ref!, token: null })); });
    // Let the store decrypt and hand back the URL.
    for (let i = 0; i < 20 && !host.querySelector('img'); i++) {
        await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    }
}

describe('a sticker message in transferred history, on the new device', () => {
    it('draws the picture: a sticker a friend sent you, and one of your own My stickers', async () => {
        const { vault, sizes } = await oldDeviceVault();
        freshDevice();
        // Same import HistorySyncBanner runs on the decrypted transfer.
        await importLocalHistory(USER, jsonBlob(vault));

        for (const id of ['m1', 'm2'] as const) {
            await renderTransferred(id);
            const img = host.querySelector('img');
            expect(img, `sticker image for ${id}`).not.toBeNull();
            expect(img!.getAttribute('src')).toMatch(/^blob:sticker-/);
            expect(urlBytes.get(img!.getAttribute('src')!)).toBe(sizes[id]);
            expect(host.querySelector('[data-sticker-source="personal"]')).not.toBeNull();
        }
    });

    it('POSITIVE CONTROL: without the images in the transfer it shows the unavailable placeholder, not a picture', async () => {
        const { vault } = await oldDeviceVault({ dropImages: true });
        freshDevice();
        await importLocalHistory(USER, jsonBlob(vault));
        await renderTransferred('m1');
        await act(async () => { await new Promise(r => setTimeout(r, 50)); });
        expect(host.querySelector('img')).toBeNull();
        expect(host.textContent ?? '').not.toContain('[Sticker:');
    });
});
