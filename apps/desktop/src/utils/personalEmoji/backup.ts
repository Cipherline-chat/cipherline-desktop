/**
 * My Emojis in the encrypted backup / history-transfer vault.
 *
 * What travels (all under the vault's outer encryption, like the GIF library):
 *   emojiLibrary  the library state (entries + LWW tombstones)
 *   emojiIndex    id -> { s: size, m: mime, a: animated, n: name } for every
 *                 stored image (library AND received cache). The last-used
 *                 time is left out on purpose: it changes whenever an emoji is
 *                 merely viewed and would rewrite the backup's meta record.
 *   emojiKeys     id -> per-item AES key
 *   emojiFiles    id -> base64 of the sealed `.enc` file; ONLY on the legacy
 *                 all-in-one vault. The record-based backup streams each file
 *                 as an `emoji:<id>` record instead and leaves this out.
 *
 * Restore MERGES the library (so restoring onto a device that already has
 * emojis cannot drop them), and overwrites key + file together for each id in
 * the vault so the two never disagree.
 *
 * Restore writes every image file BEFORE the index that lists it is saved.
 * The record-based backup used to restore the index first (inside
 * importLocalHistory) and write the `emoji:<id>` files only afterwards, and
 * importLocalHistory's BACKUP_RESTORED_EVENT wakes every image on screen in
 * between: a restored id was then "listed, file not there", which the store
 * treats as gone for good and deletes (index entry AND key) - so restored My
 * Emojis / My stickers and the images of old sticker messages could vanish
 * on the very restore that brought them back. `restoreEmojiVaultPart` now
 * pulls those files through `opts.sealedFile` itself (2026-11-22).
 *
 * Pure over an injected `EmojiBackupIO`, so it is unit-tested; the real binding
 * is in `realBackupIO()`.
 */

import secureLocalStore from '../secureLocalStore';
import { emptyLibrary, mergeLibraries, sanitizeLibrary, type EmojiLibState } from './library';
import { emojiFileName, emojiIndexKey, emojiKeyKey, type BlobIndex } from './store';
import { emojiLibraryKey, stickerLibraryKey } from './service';
import { PERSONAL_BLOB_MAX_BYTES, b64ToBytes, bytesToB64, isPersonalEmojiId } from './token';

export interface EmojiVaultPart {
    emojiLibrary?: EmojiLibState;
    /** My stickers (2026-11-22): the library state only - its images are ordinary
     *  entries of the one shared store, so they travel in emojiIndex / emojiKeys /
     *  `emoji:<id>` records with everything else. An older build ignores it. */
    stickerLibrary?: EmojiLibState;
    emojiIndex?: Record<string, { s: number; m: string; a: 0 | 1; n: string }>;
    emojiKeys?: Record<string, string>;
    emojiFiles?: Record<string, string>;
}

export interface EmojiBackupIO {
    kvGet(key: string): string | null;
    kvSet(key: string, value: string): void;
    readSealed(id: string): Promise<Uint8Array | null>;
    writeSealed(id: string, bytes: Uint8Array): Promise<void>;
    now(): number;
}

function parse<T>(raw: string | null, fallback: T): T {
    if (!raw) return fallback;
    try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** Ids this account has stored images for (and keys to open them). */
export function emojiBackupIds(index: EmojiVaultPart['emojiIndex'], keys: EmojiVaultPart['emojiKeys']): string[] {
    return Object.keys(index ?? {}).filter(id => isPersonalEmojiId(id) && !!keys?.[id]).sort();
}

export async function buildEmojiVaultPart(
    userId: string,
    io: EmojiBackupIO,
    opts: { inlineFiles: boolean },
): Promise<EmojiVaultPart> {
    const library = sanitizeLibrary(parse(io.kvGet(emojiLibraryKey(userId)), emptyLibrary()));
    const rawIndex = parse<BlobIndex>(io.kvGet(emojiIndexKey(userId)), {});
    const index: NonNullable<EmojiVaultPart['emojiIndex']> = {};
    const keys: Record<string, string> = {};
    for (const [id, m] of Object.entries(rawIndex)) {
        const key = isPersonalEmojiId(id) ? io.kvGet(emojiKeyKey(userId, id)) : null;
        if (!key || !m || typeof m !== 'object') continue;
        index[id] = { s: m.s, m: m.m, a: m.a, n: m.n };
        keys[id] = key;
    }
    const stickerLibrary = sanitizeLibrary(parse(io.kvGet(stickerLibraryKey(userId)), emptyLibrary()), PERSONAL_BLOB_MAX_BYTES);
    const part: EmojiVaultPart = { emojiLibrary: library, stickerLibrary, emojiIndex: index, emojiKeys: keys };
    if (opts.inlineFiles) {
        const files: Record<string, string> = {};
        for (const id of Object.keys(index)) {
            try {
                const sealed = await io.readSealed(id);
                if (sealed) files[id] = bytesToB64(sealed);
            } catch { /* unreadable: left out, entry is dropped below */ }
        }
        // Only ids whose file made it in: a restored index must not point at nothing.
        for (const id of Object.keys(index)) if (!files[id]) { delete index[id]; delete keys[id]; }
        part.emojiFiles = files;
    }
    return part;
}

export interface RestoreEmojiOpts {
    /** The sealed `.enc` file of `id` when it is not inline in the vault (the
     *  record-based backup: an `emoji:<id>` record). Null = not in the backup. */
    sealedFile?: (id: string) => Promise<Uint8Array | null>;
}

export async function restoreEmojiVaultPart(
    userId: string, vault: EmojiVaultPart, io: EmojiBackupIO, opts: RestoreEmojiOpts = {},
): Promise<void> {
    if (!vault.emojiLibrary && !vault.stickerLibrary && !vault.emojiIndex) return;

    // With a file source, an id is restored only together with its file: a key
    // without its file would make this device's own copy (if it has one)
    // unreadable, and an index entry without its file is deleted on first read.
    // A vault with neither (no `emojiFiles`, no source) keeps the old
    // key + index restore.
    const hasFileSource = !!vault.emojiFiles || !!opts.sealedFile;
    const index = parse<BlobIndex>(io.kvGet(emojiIndexKey(userId)), {});
    for (const [id, m] of Object.entries(vault.emojiIndex ?? {})) {
        const key = vault.emojiKeys?.[id];
        if (!isPersonalEmojiId(id) || !key || !m || typeof m !== 'object') continue;
        if (typeof m.s !== 'number' || typeof m.m !== 'string' || typeof m.n !== 'string') continue;
        if (hasFileSource) {
            let sealed: Uint8Array | null = null;
            try {
                const b64 = vault.emojiFiles?.[id];
                sealed = typeof b64 === 'string' ? b64ToBytes(b64) : (await opts.sealedFile?.(id)) ?? null;
            } catch (e) { console.warn('[restore] could not read emoji file', id, e); }
            if (!sealed || sealed.length === 0) continue;
            try { await io.writeSealed(id, sealed); }
            catch (e) { console.warn('[restore] failed to write emoji file', id, e); continue; }
        }
        io.kvSet(emojiKeyKey(userId, id), key);
        index[id] = { s: m.s, m: m.m, a: m.a === 1 ? 1 : 0, n: m.n, t: io.now() };
    }
    // Saved last: nothing lists an image before its file and key are in place.
    io.kvSet(emojiIndexKey(userId), JSON.stringify(index));

    if (vault.emojiLibrary) {
        const local = sanitizeLibrary(parse(io.kvGet(emojiLibraryKey(userId)), emptyLibrary()));
        io.kvSet(emojiLibraryKey(userId), JSON.stringify(mergeLibraries(local, sanitizeLibrary(vault.emojiLibrary))));
    }
    if (vault.stickerLibrary) {
        const max = PERSONAL_BLOB_MAX_BYTES;
        const local = sanitizeLibrary(parse(io.kvGet(stickerLibraryKey(userId)), emptyLibrary()), max);
        io.kvSet(stickerLibraryKey(userId), JSON.stringify(mergeLibraries(local, sanitizeLibrary(vault.stickerLibrary, max), max)));
    }
}

/** The real binding (renderer: secureLocalStore + Electron IPC). */
export function realBackupIO(): EmojiBackupIO {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- electronAPI members are optional/version-dependent
    const api = () => (window as any).electronAPI;
    return {
        kvGet: k => secureLocalStore.getItem(k),
        kvSet: (k, v) => secureLocalStore.setItem(k, v),
        async readSealed(id) {
            const buf = await api()?.readGifFile?.(emojiFileName(id));
            return buf ? (buf instanceof Uint8Array ? buf : new Uint8Array(buf)) : null;
        },
        async writeSealed(id, bytes) { await api()?.writeGifFile?.(emojiFileName(id), bytes); },
        now: () => Date.now(),
    };
}
