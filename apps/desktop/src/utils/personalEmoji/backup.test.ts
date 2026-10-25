import { describe, it, expect } from 'vitest';
import { buildEmojiVaultPart, restoreEmojiVaultPart, emojiBackupIds, type EmojiBackupIO } from './backup';
import { PersonalEmojis } from './service';
import { emojiFileName, emojiIndexKey, emojiKeyKey, type StoreIO } from './store';
import { personalEmojiIdFromBytes } from './token';
import { splitVaultForRecords, specsFromVault } from '../../services/backupRecords';
import { classifyKvKey } from '../../services/backupRegistry';
import type { BackupVault } from '../crypto';

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, 7, 7]);
const UID = 'u1';

function device(now = 1000) {
    const kv = new Map<string, string>(), files = new Map<string, Uint8Array>();
    const storeIO: StoreIO = {
        uid: () => UID, kvGet: k => kv.get(k) ?? null, kvSet: (k, v) => { kv.set(k, v); }, kvRemove: k => { kv.delete(k); },
        readFile: async n => files.get(n) ?? null, writeFile: async (n, b) => { files.set(n, b); }, deleteFile: async n => { files.delete(n); }, now: () => now,
    };
    const backupIO: EmojiBackupIO = {
        kvGet: k => kv.get(k) ?? null, kvSet: (k, v) => { kv.set(k, v); },
        readSealed: async id => files.get(emojiFileName(id)) ?? null,
        writeSealed: async (id, b) => { files.set(emojiFileName(id), b); },
        now: () => now,
    };
    return { lib: new PersonalEmojis(storeIO), kv, files, backupIO };
}

describe('My Emojis in the backup vault', () => {
    it('round trip: library, cache entry, keys and (inline) files all come back readable on a new device', async () => {
        const a = device();
        await a.lib.add(png(1), 'mine');
        const cachedBytes = png(2), cachedId = await personalEmojiIdFromBytes(cachedBytes);
        await a.lib.store.put(cachedId, cachedBytes, { mime: 'image/png', animated: false, name: 'theirs' });

        const part = await buildEmojiVaultPart(UID, a.backupIO, { inlineFiles: true });
        expect(Object.keys(part.emojiFiles!).sort()).toEqual(Object.keys(part.emojiIndex!).sort());
        const wire = JSON.parse(JSON.stringify(part)); // through the vault JSON

        const b = device(5000);
        await restoreEmojiVaultPart(UID, wire, b.backupIO);
        expect(b.lib.load().entries.map(e => e.name)).toEqual(['mine']);
        expect(await b.lib.store.read(cachedId)).toEqual(cachedBytes);
        expect(await b.lib.store.read(await personalEmojiIdFromBytes(png(1)))).toEqual(png(1));
    });

    it('the record-based path leaves files out of meta and names them emoji:<id> records', async () => {
        const a = device();
        const r = await a.lib.add(png(1), 'mine');
        if (!r.ok) throw new Error();
        const part = await buildEmojiVaultPart(UID, a.backupIO, { inlineFiles: false });
        expect(part.emojiFiles).toBeUndefined();

        const vault = { ...part, history: {}, channelHistory: {} } as unknown as BackupVault;
        const { meta } = splitVaultForRecords(vault);
        expect(meta.emojiKeys).toEqual(part.emojiKeys);
        const ids = emojiBackupIds(part.emojiIndex, part.emojiKeys);
        expect(ids).toEqual([r.entry.id]);
        const specs = await specsFromVault({
            meta, history: {}, channelHistory: {}, emojiIds: ids,
            loaders: { emoji: async id => a.files.get(emojiFileName(id)) ?? null },
        });
        expect(specs.map(s => s.id)).toEqual(['meta', `emoji:${r.entry.id}`]);
        expect(await specs[1].load()).toEqual(a.files.get(emojiFileName(r.entry.id)));
    });

    it('the index carries no last-used time (viewing an emoji must not change the backup)', async () => {
        const a = device(1000);
        const r = await a.lib.add(png(1), 'mine');
        if (!r.ok) throw new Error();
        const json = JSON.stringify(await buildEmojiVaultPart(UID, a.backupIO, { inlineFiles: false }));
        expect(json).not.toContain('"t":');
    });

    it('restore MERGES with what the device already has (never drops local emojis) and is idempotent', async () => {
        const a = device();
        await a.lib.add(png(1), 'fromvault');
        const part = JSON.parse(JSON.stringify(await buildEmojiVaultPart(UID, a.backupIO, { inlineFiles: true })));

        const b = device();
        await b.lib.add(png(2), 'local');
        await restoreEmojiVaultPart(UID, part, b.backupIO);
        await restoreEmojiVaultPart(UID, part, b.backupIO);
        expect(b.lib.load().entries.map(e => e.name).sort()).toEqual(['fromvault', 'local']);
        expect(await b.lib.store.read(await personalEmojiIdFromBytes(png(2)))).toEqual(png(2));
    });

    it('an index entry without a key, a file that cannot be read, and junk are not carried', async () => {
        const a = device();
        const r = await a.lib.add(png(1), 'mine');
        if (!r.ok) throw new Error();
        a.files.delete(emojiFileName(r.entry.id));
        const inline = await buildEmojiVaultPart(UID, a.backupIO, { inlineFiles: true });
        expect(inline.emojiIndex).toEqual({});
        a.kv.delete(emojiKeyKey(UID, r.entry.id));
        expect(emojiBackupIds(JSON.parse(a.kv.get(emojiIndexKey(UID))!), {})).toEqual([]);

        const b = device();
        await restoreEmojiVaultPart(UID, { emojiIndex: { '../../x': { s: 1, m: 'image/png', a: 0, n: 'x' } }, emojiKeys: { '../../x': 'k' }, emojiFiles: { '../../x': 'AAAA' } }, b.backupIO);
        expect(b.files.size).toBe(0);
    });

    it('a vault from before My Emojis restores as a no-op', async () => {
        const b = device();
        await restoreEmojiVaultPart(UID, {}, b.backupIO);
        expect(b.kv.size).toBe(0);
    });
});

describe('backup registry classification for My Emojis keys', () => {
    it('library, index and keys are vault-carried (excluded from the raw-key backup); sync view is device-only', () => {
        for (const k of [`cipherline_emoji_library_${UID}`, `cipherline_emoji_index_${UID}`, `cipherline_emoji_key_${UID}_p_${'a'.repeat(32)}`, `cipherline_emoji_sync_view_${UID}`]) {
            expect(classifyKvKey(k, UID), k).toBe('exclude');
        }
    });
});
