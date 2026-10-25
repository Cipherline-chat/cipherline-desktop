/**
 * The My Emojis library on this device: persisted state + the blob store +
 * the operations the UI calls. One instance per app (`personalEmojis`), built
 * lazily over the real secureLocalStore / Electron IPC; tests build their own
 * over a fake `StoreIO`.
 *
 * State lives in `cipherline_emoji_library_<uid>` (account-scoped, so
 * secureLocalStore files it per account). Mutations go through library.ts so
 * the same LWW stamps a remote snapshot is merged with are written locally.
 */

import secureLocalStore from '../secureLocalStore';
import {
    addEntry, diffLibraries, emptyLibrary, mergeLibraries, moveEntry, pruneTombstones, removeEntry,
    renameEntry, restoreEntry, sanitizeLibrary, type EmojiEntry, type EmojiLibState, type LibraryError,
} from './library';
import { EmojiBlobStore, emojiFileName, type StoreIO } from './store';
import {
    PERSONAL_EMOJI_MAX_BYTES, isAnimatedImage, personalEmojiIdFromBytes, sniffImageMime,
} from './token';

export const emojiLibraryKey = (uid: string) => `cipherline_emoji_library_${uid}`;

export type LibraryChangeOrigin = 'local' | 'sync';

export type AddResult =
    | { ok: true; entry: EmojiEntry; alreadyHad: boolean }
    | { ok: false; error: LibraryError | 'too_large' | 'not_an_image' | 'signed_out' };

export class PersonalEmojis {
    readonly store: EmojiBlobStore;
    private listeners = new Set<(origin: LibraryChangeOrigin) => void>();

    private readonly io: StoreIO;

    constructor(io: StoreIO) {
        this.io = io;
        this.store = new EmojiBlobStore(io, () => new Set(this.load().entries.map(e => e.id)));
    }

    // ── state ───────────────────────────────────────────────────────────────
    load(): EmojiLibState {
        const uid = this.io.uid();
        if (!uid) return emptyLibrary();
        try {
            const raw = this.io.kvGet(emojiLibraryKey(uid));
            return raw ? sanitizeLibrary(JSON.parse(raw)) : emptyLibrary();
        } catch { return emptyLibrary(); }
    }

    save(state: EmojiLibState, origin: LibraryChangeOrigin = 'local'): void {
        const uid = this.io.uid();
        if (!uid) return;
        this.io.kvSet(emojiLibraryKey(uid), JSON.stringify(pruneTombstones(state, this.io.now())));
        this.emit(origin);
    }

    subscribe(cb: (origin: LibraryChangeOrigin) => void): () => void {
        this.listeners.add(cb);
        return () => { this.listeners.delete(cb); };
    }
    /** The library was rewritten behind our back (a backup restore): redraw, and
     *  count it as a local change so it is published to the other devices. */
    notifyExternalChange(): void {
        this.store.resetSession();
        this.emit('local');
    }

    private emit(origin: LibraryChangeOrigin): void {
        for (const cb of this.listeners) { try { cb(origin); } catch { /* listener bug */ } }
    }

    // ── operations ──────────────────────────────────────────────────────────
    /**
     * Add finished emoji bytes (already 128 px and under the size cap, from the
     * processor or from a received message) to the library under `name`.
     */
    async add(bytes: Uint8Array, name: string): Promise<AddResult> {
        if (!this.io.uid()) return { ok: false, error: 'signed_out' };
        if (bytes.length === 0 || bytes.length > PERSONAL_EMOJI_MAX_BYTES) return { ok: false, error: 'too_large' };
        const mime = sniffImageMime(bytes);
        if (!mime) return { ok: false, error: 'not_an_image' };
        const id = await personalEmojiIdFromBytes(bytes);
        const state = this.load();
        const had = state.entries.find(e => e.id === id);
        if (had) return { ok: true, entry: had, alreadyHad: true };
        const animated = isAnimatedImage(bytes, mime);
        // Reject BEFORE writing the file when the library would refuse it.
        const res = addEntry(state, { id, name, mime, animated, size: bytes.length }, this.io.now());
        if (!res.ok) return res;
        await this.store.put(id, bytes, { mime, animated, name });
        if (!this.store.has(id)) return { ok: false, error: 'signed_out' };
        this.save(res.state);
        return { ok: true, entry: res.entry, alreadyHad: false };
    }

    /** Save an emoji already on this device (e.g. received in a message) to the library. */
    async addFromStore(id: string, name: string): Promise<AddResult> {
        const bytes = await this.store.read(id);
        if (!bytes) return { ok: false, error: 'not_an_image' };
        return this.add(bytes, name);
    }

    rename(id: string, name: string) {
        const res = renameEntry(this.load(), id, name, this.io.now());
        if (res.ok) this.save(res.state);
        return res;
    }

    move(id: string, toIndex: number) {
        const res = moveEntry(this.load(), id, toIndex, this.io.now());
        if (res.ok) this.save(res.state);
        return res;
    }

    /** Remove from the library. The image stays in the cache (evictable) so
     *  messages already showing it keep rendering. */
    remove(id: string): void {
        const before = this.load();
        const next = removeEntry(before, id, this.io.now());
        if (next !== before) this.save(next);
    }

    /** Undo a `remove`: re-insert `entry` at its old position. Needs the image
     *  still cached on this device (remove leaves it, evictable). */
    async restore(entry: EmojiEntry): Promise<{ ok: true } | { ok: false; error: LibraryError | 'not_an_image' | 'signed_out' }> {
        if (!this.io.uid()) return { ok: false, error: 'signed_out' };
        if (!(await this.store.read(entry.id))) return { ok: false, error: 'not_an_image' };
        const res = restoreEntry(this.load(), entry, this.io.now());
        if (!res.ok) return res;
        this.save(res.state);
        return { ok: true };
    }

    // ── sync support ────────────────────────────────────────────────────────
    /** Merge a remote snapshot and persist; returns what to materialise. */
    applyRemote(remote: EmojiLibState): { changed: boolean; added: EmojiEntry[]; removed: string[] } {
        const local = this.load();
        const merged = mergeLibraries(local, remote);
        if (merged === local) return { changed: false, added: [], removed: [] };
        const diff = diffLibraries(local, merged);
        this.save(merged, 'sync');
        return { changed: true, ...diff };
    }
}

// ── The real instance ───────────────────────────────────────────────────────

function realIO(): StoreIO {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- electronAPI members are optional/version-dependent and not all declared on the typed bridge
    const api = () => (window as any).electronAPI;
    const dir = async () => `${await api().getUserDataPath()}/cipherline-gifs`;
    return {
        uid: () => { try { return secureLocalStore.getItem('cipherline_user_id') || null; } catch { return null; } },
        kvGet: k => secureLocalStore.getItem(k),
        kvSet: (k, v) => secureLocalStore.setItem(k, v),
        kvRemove: k => secureLocalStore.removeItem(k),
        async readFile(name) {
            try {
                const buf = await api().readGifFile(name);
                return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
            } catch { return null; }
        },
        async writeFile(name, bytes) { await api().writeGifFile(name, bytes); },
        async deleteFile(name) { await api().deleteFile(`${await dir()}/${name}.enc`); },
        now: () => Date.now(),
    };
}

let instance: PersonalEmojis | null = null;
/** The app-wide library. Lazy so importing this module touches nothing. */
export function personalEmojis(): PersonalEmojis {
    return (instance ??= new PersonalEmojis(realIO()));
}

export { emojiFileName };
