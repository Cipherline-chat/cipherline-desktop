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
 * Pure over an injected `EmojiBackupIO`, so it is unit-tested; the real binding
 * is in `realBackupIO()`.
 */

import secureLocalStore from '../secureLocalStore';
import { emptyLibrary, mergeLibraries, sanitizeLibrary, type EmojiLibState } from './library';
import { emojiFileName, emojiIndexKey, emojiKeyKey, type BlobIndex } from './store';
import { emojiLibraryKey } from './service';
import { b64ToBytes, bytesToB64, isPersonalEmojiId } from './token';

export interface EmojiVaultPart {
    emojiLibrary?: EmojiLibState;
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
    const part: EmojiVaultPart = { emojiLibrary: library, emojiIndex: index, emojiKeys: keys };
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

export async function restoreEmojiVaultPart(userId: string, vault: EmojiVaultPart, io: EmojiBackupIO): Promise<void> {
    if (!vault.emojiLibrary && !vault.emojiIndex) return;

    const index = parse<BlobIndex>(io.kvGet(emojiIndexKey(userId)), {});
    const restoredIds = new Set<string>();
    for (const [id, m] of Object.entries(vault.emojiIndex ?? {})) {
        const key = vault.emojiKeys?.[id];
        if (!isPersonalEmojiId(id) || !key || !m || typeof m !== 'object') continue;
        if (typeof m.s !== 'number' || typeof m.m !== 'string' || typeof m.n !== 'string') continue;
        io.kvSet(emojiKeyKey(userId, id), key);
        index[id] = { s: m.s, m: m.m, a: m.a === 1 ? 1 : 0, n: m.n, t: io.now() };
        restoredIds.add(id);
    }
    for (const [id, b64] of Object.entries(vault.emojiFiles ?? {})) {
        if (!restoredIds.has(id)) continue;
        try { await io.writeSealed(id, b64ToBytes(b64)); }
        catch (e) { console.warn('[restore] failed to write emoji file', id, e); }
    }
    io.kvSet(emojiIndexKey(userId), JSON.stringify(index));

    if (vault.emojiLibrary) {
        const local = sanitizeLibrary(parse(io.kvGet(emojiLibraryKey(userId)), emptyLibrary()));
        io.kvSet(emojiLibraryKey(userId), JSON.stringify(mergeLibraries(local, sanitizeLibrary(vault.emojiLibrary))));
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
