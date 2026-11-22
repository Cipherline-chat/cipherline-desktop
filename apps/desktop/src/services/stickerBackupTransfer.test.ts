import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Every backup round trip derives a real PBKDF2 key.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Stickers in the encrypted backup and the device-to-device history transfer
 * (owner 2026-11-22: "make sure stickers are setup with backups and device data
 * transfer"). Everything a fresh device needs to show your stickers again:
 *
 *   - My stickers: the library (names, order) AND every image, including one
 *     over the 256 KiB My Emojis cap (stickers may be 512 KiB);
 *   - the images of stickers OTHER people sent you (the received cache), so an
 *     old sticker message in restored history still draws its picture;
 *   - the sticker messages themselves (personal: id + name, bytes stripped;
 *     server: a reference fetched from the server as usual);
 *   - the picker's Recent row.
 *
 * Through BOTH paths:
 *   backup:   buildBackupPlan -> writeBackupRecords -> openContainer -> applyBackupContainer
 *             (+ the in-place incremental update of the local file)
 *   transfer: exportLocalHistory (what HistoryRequestModal sends) -> importLocalHistory
 *             (what HistorySyncBanner applies)
 *
 * secureLocalStore and the Electron file bridge are in-memory fakes; the crypto,
 * container, vault builder, importers, blob store and sticker wire are real.
 */
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
vi.mock('../utils/secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));
vi.mock('../utils/attachmentDownload', () => ({ downloadEncryptedAttachment: async () => null }));

/** `userData/cipherline-gifs/<name>.enc` */
const gifFiles = new Map<string, Uint8Array>();
/** Runs before an emoji file is written (lets a test interleave a UI read). */
let beforeEmojiWrite: (() => Promise<void>) | null = null;
const electronAPI = {
    getUserDataPath: async () => '/ud',
    listGifFiles: async () => [...gifFiles.keys()],
    readGifFile: async (name: string) => { const f = gifFiles.get(name); if (!f) throw new Error('ENOENT'); return f; },
    writeGifFile: async (name: string, data: Uint8Array) => {
        if (name.startsWith('emoji-') && beforeEmojiWrite) await beforeEmojiWrite();
        gifFiles.set(name, data.slice());
    },
    deleteFile: async (path: string) => { gifFiles.delete(path.replace('/ud/cipherline-gifs/', '').replace(/\.enc$/, '')); return { ok: true }; },
    listCustomSounds: async () => [],
};

const { exportLocalHistory, importLocalHistory } = await import('../utils/crypto');
const { buildBackupPlan, writeBackupRecords, applyBackupContainer } = await import('./backupRecords');
const { ContainerWriter, openContainer, MemoryContainer, memorySource } = await import('../utils/backupContainer');
const { personalEmojis, personalStickers } = await import('../utils/personalEmoji/service');
const { personalEmojiIdFromBytes, bytesToB64, PERSONAL_EMOJI_MAX_BYTES } = await import('../utils/personalEmoji/token');
const { takeSticker, stickerRefOf, buildStickerContent } = await import('../utils/stickers/wire');
const { rememberRecentSticker, loadRecentStickers } = await import('../utils/stickers/recent');
const { classifyKvKey, collectIncludedKv, BACKUP_RESTORED_EVENT } = await import('./backupRegistry');
const messageStore = await import('../utils/messageStore');

const USER = 'sticker-user';
const PW = 'pw-for-test';
const SERVER = '11111111-2222-4333-8444-555555555555';
const SERVER_STICKER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** A PNG-magic image of `n` bytes (the store sniffs the magic, nothing more). */
function png(n: number, seed: number): Uint8Array {
    const b = new Uint8Array(n);
    for (let i = 8; i < n; i++) b[i] = (i * 31 + seed * 7) & 0x7f;
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    b[8] = seed;
    return b;
}
const BIG = 300 * 1024; // over My Emojis' 256 KiB, inside a sticker's 512 KiB

beforeAll(() => {
    Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob });
});

function freshDevice(): void {
    mem.clear();
    gifFiles.clear();
    messageStore._resetForTest();
    personalEmojis().store.resetSession(); // one store for both libraries
    mem.set('cipherline_user_id', USER);
}

beforeEach(() => {
    beforeEmojiWrite = null;
    freshDevice();
    Object.assign(window, { electronAPI, dispatchEvent: () => true });
});

/** Device A: My stickers + a My Emoji + a sticker a friend sent + history + Recent. */
async function populateDeviceA() {
    const stickers = personalStickers();
    const a = await stickers.add(png(2000, 1), 'wave');
    const b = await stickers.add(png(BIG, 2), 'big_hug');
    const c = await stickers.add(png(3000, 3), 'party');
    if (!a.ok || !b.ok || !c.ok) throw new Error('sticker add failed');
    stickers.move(c.entry.id, 0);          // a non-default order must survive
    stickers.rename(a.entry.id, 'wave_hi'); // and a rename
    const order = stickers.load().entries.slice().sort((x, y) => x.order - y.order).map(e => e.name);

    const emoji = await personalEmojis().add(png(500, 9), 'blob');
    if (!emoji.ok) throw new Error('emoji add failed');

    // Bob sends a personal sticker: the real receive path strips the bytes from
    // the message and files them in the shared store.
    const bobBytes = png(4000, 5);
    const bobId = await personalEmojiIdFromBytes(bobBytes);
    const received = takeSticker({
        type: 'text', text: '[Sticker: bob_wave]',
        sticker: { source: 'personal', id: bobId, name: 'bob_wave', mime: 'image/png', animated: false, bytes_b64: bytesToB64(bobBytes) },
    }, personalEmojis().store);
    expect(await received.stored).toBe(true);

    messageStore.saveAll('dm', USER, {
        'conv-bob': [
            { id: 'm1', sender_id: 'bob', timestamp: 1_700_000_000_000, content: received.content },
            { id: 'm2', sender_id: USER, timestamp: 1_700_000_100_000, content: buildStickerContent({ source: 'personal', id: c.entry.id, name: 'party', mime: 'image/png' }) },
        ],
    });
    messageStore.saveAll('channel', USER, {
        'chan-1': [{ id: 'm3', sender_id: 'carol', timestamp: 1_700_000_200_000, content: buildStickerContent({ source: 'server', id: SERVER_STICKER, name: 'srv_cat', server_id: SERVER }) }],
    });

    rememberRecentSticker({ source: 'server', id: SERVER_STICKER, name: 'srv_cat', server_id: SERVER });
    rememberRecentSticker({ source: 'personal', id: b.entry.id, name: 'big_hug' });
    const recent = loadRecentStickers();

    return {
        order,
        stickers: [[a.entry.id, png(2000, 1)], [b.entry.id, png(BIG, 2)], [c.entry.id, png(3000, 3)]] as [string, Uint8Array][],
        emojiId: emoji.entry.id,
        bobId, bobBytes,
        recent,
    };
}

type Want = Awaited<ReturnType<typeof populateDeviceA>>;

async function assertStickersArrived(want: Want) {
    const lib = personalStickers();
    // My stickers: names and order...
    expect(lib.load().entries.slice().sort((x, y) => x.order - y.order).map(e => e.name)).toEqual(want.order);
    // ...every image readable on the new device (incl. the 300 KiB one)...
    for (const [id, bytes] of want.stickers) expect(await lib.store.read(id)).toEqual(bytes);
    // ...and still a separate library from My Emojis.
    expect(personalEmojis().load().entries.map(e => e.name)).toEqual(['blob']);
    expect(lib.load().entries.some(e => e.id === want.emojiId)).toBe(false);

    // Old sticker messages: the content survived, and each one's picture resolves.
    const dm = (await messageStore.loadAll('dm', USER))['conv-bob'];
    const fromBob = stickerRefOf(dm.find(m => m.id === 'm1')!.content)!;
    expect(fromBob).toMatchObject({ source: 'personal', id: want.bobId, name: 'bob_wave' });
    expect((dm.find(m => m.id === 'm1')!.content as { sticker: Record<string, unknown> }).sticker.bytes_b64).toBeUndefined();
    expect(await personalEmojis().store.read(fromBob.id)).toEqual(want.bobBytes);
    const mine = stickerRefOf(dm.find(m => m.id === 'm2')!.content)!;
    expect(await personalEmojis().store.read(mine.id)).toEqual(want.stickers[2][1]);
    const ch = (await messageStore.loadAll('channel', USER))['chan-1'];
    expect(stickerRefOf(ch[0].content)).toEqual({ source: 'server', id: SERVER_STICKER, name: 'srv_cat', server_id: SERVER });

    // The picker's Recent row.
    expect(loadRecentStickers()).toEqual(want.recent);
}

async function writeBackup(container = new MemoryContainer()) {
    const plan = await buildBackupPlan(USER, { includeAttachments: false });
    const writer = await ContainerWriter.create(PW, container);
    await writeBackupRecords(plan, { fresh: writer });
    await writer.finish({ userId: USER, fingerprint: plan.fingerprint });
    return { container, plan };
}

async function restoreOnFreshDevice(container: InstanceType<typeof MemoryContainer>, edit?: (ids: string[]) => void) {
    const opened = await openContainer(memorySource(container.bytes()), PW);
    const ids = opened.index.records.map(r => r.id);
    edit?.(ids);
    freshDevice();
    await applyBackupContainer(USER, opened);
    return ids;
}

describe('encrypted backup -> restore on a fresh device', () => {
    it('My stickers (library + images), received sticker images, sticker messages and Recent all come back', async () => {
        const want = await populateDeviceA();
        const { container } = await writeBackup();
        const ids = await restoreOnFreshDevice(container);
        // One `emoji:<id>` record per stored image: 3 stickers, 1 emoji, Bob's sticker.
        const expected = [...want.stickers.map(([id]) => id), want.emojiId, want.bobId].map(id => `emoji:${id}`).sort();
        expect(ids.filter(i => i.startsWith('emoji:')).sort()).toEqual(expected);
        await assertStickersArrived(want);
    });

    it('an image shown on screen during the restore cannot make the restored sticker vanish', async () => {
        // importLocalHistory fires BACKUP_RESTORED_EVENT; the sticker hooks answer
        // it by resetting the store, which makes every image on screen look its
        // file up again. Simulate exactly that read, and let it finish before
        // the first image file is written.
        const want = await populateDeviceA();
        const { container } = await writeBackup();
        let uiReads: Promise<unknown>[] = [];
        Object.assign(window, {
            dispatchEvent: (e: Event) => {
                if (e.type === BACKUP_RESTORED_EVENT) {
                    uiReads = [want.bobId, ...want.stickers.map(([id]) => id)].map(id => personalEmojis().store.read(id));
                }
                return true;
            },
        });
        beforeEmojiWrite = async () => { await Promise.all(uiReads); };
        await restoreOnFreshDevice(container);
        await Promise.all(uiReads);
        beforeEmojiWrite = null;
        await assertStickersArrived(want);
    });

    it('POSITIVE CONTROL: without the sticker images in the backup, the library comes back but nothing draws', async () => {
        const want = await populateDeviceA();
        const { container } = await writeBackup();
        const opened = await openContainer(memorySource(container.bytes()), PW);
        const stickerRecords = new Set([...want.stickers.map(([id]) => `emoji:${id}`), `emoji:${want.bobId}`]);
        opened.index.records = opened.index.records.filter(r => !stickerRecords.has(r.id));
        freshDevice();
        await applyBackupContainer(USER, opened);
        expect(personalStickers().load().entries.map(e => e.name).sort()).toEqual([...want.order].sort());
        for (const [id] of want.stickers) expect(await personalStickers().store.read(id)).toBeNull();
        expect(await personalEmojis().store.read(want.bobId)).toBeNull();
        // The My Emoji record was left alone, so it still restores.
        expect(await personalEmojis().store.read(want.emojiId)).toEqual(png(500, 9));
    });

    it('POSITIVE CONTROL: without vault.stickerLibrary the images come back but My stickers is empty', async () => {
        const want = await populateDeviceA();
        const vault = JSON.parse(await (await exportLocalHistory(USER, { rangeDays: null })).text());
        delete vault.stickerLibrary;
        freshDevice();
        await importLocalHistory(USER, new Blob([JSON.stringify(vault)], { type: 'application/json' }));
        expect(personalStickers().load().entries).toEqual([]);
        expect(await personalStickers().store.read(want.stickers[0][0])).toEqual(want.stickers[0][1]);
    });

    it('POSITIVE CONTROL: an empty device backs up and restores no stickers', async () => {
        const { container } = await writeBackup();
        const ids = await restoreOnFreshDevice(container);
        expect(ids.some(i => i.startsWith('emoji:'))).toBe(false);
        expect(personalStickers().load().entries).toEqual([]);
        expect(loadRecentStickers()).toEqual([]);
    });

    it('restoring onto a device that already has My stickers MERGES (nothing local is dropped)', async () => {
        const want = await populateDeviceA();
        const { container } = await writeBackup();
        const opened = await openContainer(memorySource(container.bytes()), PW);
        freshDevice();
        const local = await personalStickers().add(png(1500, 7), 'local_only');
        if (!local.ok) throw new Error('add failed');
        await applyBackupContainer(USER, opened);
        const names = personalStickers().load().entries.map(e => e.name).sort();
        expect(names).toEqual([...want.order, 'local_only'].sort());
        expect(await personalStickers().store.read(local.entry.id)).toEqual(png(1500, 7));
        for (const [id, bytes] of want.stickers) expect(await personalStickers().store.read(id)).toEqual(bytes);
    });
});

describe('incremental local backup (in-place update)', () => {
    async function update(container: InstanceType<typeof MemoryContainer>) {
        const plan = await buildBackupPlan(USER, { includeAttachments: false });
        const w = ContainerWriter.resume(await openContainer(container, PW), container);
        const appended: string[] = [];
        const add = w.addBytes.bind(w);
        w.addBytes = async (id, bytes, hash) => { appended.push(id); return add(id, bytes, hash); };
        const res = await writeBackupRecords(plan, { update: w });
        await w.finish({ userId: USER, fingerprint: plan.fingerprint });
        return { appended, res };
    }

    it('a new sticker appends ONE image record (+ meta); a rename or reorder rewrites only meta', async () => {
        const want = await populateDeviceA();
        const { container } = await writeBackup();

        const added = await personalStickers().add(png(2500, 4), 'thumbs_up');
        if (!added.ok) throw new Error('add failed');
        const first = await update(container);
        expect(first.appended.filter(i => i.startsWith('emoji:'))).toEqual([`emoji:${added.entry.id}`]);
        expect(first.appended).toContain('meta');
        expect(first.appended.some(i => i.startsWith('dm:') || i.startsWith('ch:'))).toBe(false);

        personalStickers().rename(added.entry.id, 'thumbs_up_2');
        personalStickers().move(added.entry.id, 0);
        const second = await update(container);
        expect(second.appended).toEqual(['meta']);

        // Nothing changed at all: nothing appended.
        const third = await update(container);
        expect(third.appended).toEqual([]);

        // And the updated file restores everything, the new sticker included.
        await restoreOnFreshDevice(container);
        expect(personalStickers().load().entries.slice().sort((a, b) => a.order - b.order)[0].name).toBe('thumbs_up_2');
        expect(await personalStickers().store.read(added.entry.id)).toEqual(png(2500, 4));
        for (const [id, bytes] of want.stickers) expect(await personalStickers().store.read(id)).toEqual(bytes);
    });
});

describe('device-to-device history transfer -> a newly linked device', () => {
    it('carries My stickers, the received sticker images, sticker messages and Recent inline', async () => {
        const want = await populateDeviceA();
        const vault = JSON.parse(await (await exportLocalHistory(USER, { rangeDays: null })).text());
        expect(vault.stickerLibrary.entries).toHaveLength(3);
        for (const [id] of want.stickers) expect(typeof vault.emojiFiles[id]).toBe('string');
        expect(typeof vault.emojiFiles[want.bobId]).toBe('string');
        expect(vault.kv['cipherline_recent_stickers_{uid}']).toBeDefined();

        freshDevice();
        await importLocalHistory(USER, new Blob([JSON.stringify(vault)], { type: 'application/json' }));
        await assertStickersArrived(want);
    });

    it('a narrowed transfer (last 7 days, DMs only) still carries My stickers and every sticker image', async () => {
        const want = await populateDeviceA();
        const vault = JSON.parse(await (await exportLocalHistory(USER, {
            rangeDays: 7, includeDmMessages: true, includeGroupMessages: false, includeServerMessages: false,
        })).text());
        freshDevice();
        await importLocalHistory(USER, new Blob([JSON.stringify(vault)], { type: 'application/json' }));
        expect(personalStickers().load().entries).toHaveLength(3);
        for (const [id, bytes] of want.stickers) expect(await personalStickers().store.read(id)).toEqual(bytes);
    });

    it('POSITIVE CONTROL: a transfer without the inline images brings the library but no pictures', async () => {
        const want = await populateDeviceA();
        const vault = JSON.parse(await (await exportLocalHistory(USER, { rangeDays: null })).text());
        vault.emojiFiles = {};
        freshDevice();
        await importLocalHistory(USER, new Blob([JSON.stringify(vault)], { type: 'application/json' }));
        expect(personalStickers().load().entries).toHaveLength(3);
        for (const [id] of want.stickers) expect(await personalStickers().store.read(id)).toBeNull();
    });
});

describe('backupRegistry classification of the sticker keys', () => {
    it('Recent travels in the generic kv map; the library rides vault.stickerLibrary; sync bookkeeping never travels', () => {
        expect(classifyKvKey(`cipherline_recent_stickers_${USER}`, USER)).toBe('include');
        expect(classifyKvKey(`cipherline_sticker_library_${USER}`, USER)).toBe('exclude');
        expect(classifyKvKey(`cipherline_sticker_sync_view_${USER}`, USER)).toBe('exclude');
        mem.set(`cipherline_recent_stickers_${USER}`, '[]');
        mem.set(`cipherline_sticker_library_${USER}`, '{}');
        mem.set(`cipherline_sticker_sync_view_${USER}`, '{}');
        const kv = collectIncludedKv(fakeStore, USER);
        expect(Object.keys(kv).filter(k => k.includes('sticker'))).toEqual(['cipherline_recent_stickers_{uid}']);
    });

    it('the 300 KiB sticker really is over the My Emojis cap (so the test above exercises the sticker profile)', () => {
        expect(BIG).toBeGreaterThan(PERSONAL_EMOJI_MAX_BYTES);
    });
});
