/**
 * YOUR custom entrance sound on this device. One per account.
 *
 * Never on the server (owner decision). At rest it follows the My Emojis / GIF
 * library scheme (utils/personalEmoji/store.ts): the encoded bytes are
 * AES-256-GCM sealed under their OWN random key into
 * `<userData>/cipherline-gifs/esound-<id>.enc` (the renderer's one
 * allow-listed blob directory, so no main-process change; the GIF backup and
 * enumeration paths only touch ids the GIF library owns), and the key + a
 * little metadata live in secureLocalStore under the account-scoped
 * `cipherline_entrance_sound_<uid>`, so another account on the machine cannot
 * open it. The renderer never writes plaintext anywhere.
 *
 * The record doubles as an LWW register for own-device sync and backup
 * restore: `at` is when it was last set or removed; a removal leaves a
 * tombstone `{ id: null, at }` so an older copy elsewhere cannot resurrect it.
 * Replacing the sound deletes the old file.
 *
 * All side effects go through `OwnSoundIO`, so it is unit-tested against a fake.
 */

import secureLocalStore from '../secureLocalStore';
import { openBytes, sealBytes } from '../personalEmoji/store';
import { checkSoundBytes, contentIdOf, isContentId } from './identity';

export const ownSoundKey = (uid: string) => `cipherline_entrance_sound_${uid}`;
export const ownSoundFileName = (id: string) => `esound-${id}`;

export interface OwnSoundRecord {
    v: 1;
    /** Content id, or null = removed (tombstone). */
    id: string | null;
    /** LWW stamp, ms. */
    at: number;
    /** Per-file AES key (base64); absent on a tombstone. */
    key?: string;
    size?: number;
    durationMs?: number;
}

export interface OwnSound { id: string; size: number; durationMs: number; at: number }

export interface OwnSoundIO {
    uid(): string | null;
    kvGet(uid: string): string | null;
    kvSet(uid: string, value: string): void;
    readFile(name: string): Promise<Uint8Array | null>;
    writeFile(name: string, bytes: Uint8Array): Promise<void>;
    deleteFile(name: string): Promise<void>;
    now(): number;
}

export type OwnSoundOrigin = 'local' | 'sync';

export function parseOwnSoundRecord(raw: string | null | undefined): OwnSoundRecord | null {
    if (!raw) return null;
    try {
        const o = JSON.parse(raw) as Partial<OwnSoundRecord>;
        if (!o || typeof o !== 'object' || typeof o.at !== 'number' || !Number.isFinite(o.at)) return null;
        if (o.id === null) return { v: 1, id: null, at: o.at };
        if (!isContentId(o.id) || typeof o.key !== 'string' || !o.key) return null;
        return {
            v: 1, id: o.id, at: o.at, key: o.key,
            size: typeof o.size === 'number' ? o.size : 0,
            durationMs: typeof o.durationMs === 'number' ? o.durationMs : 0,
        };
    } catch { return null; }
}

export class OwnEntranceSoundStore {
    private listeners = new Set<(origin: OwnSoundOrigin) => void>();
    /** Decrypted bytes of the current sound, for sending (cleared on change / account switch). */
    private plain: { uid: string; id: string; bytes: Uint8Array } | null = null;
    private url: { id: string; url: string } | null = null;
    private readonly io: OwnSoundIO;

    constructor(io: OwnSoundIO) { this.io = io; }

    record(): OwnSoundRecord | null {
        const uid = this.io.uid();
        return uid ? parseOwnSoundRecord(this.io.kvGet(uid)) : null;
    }

    /** The current sound (null when none / removed). */
    current(): OwnSound | null {
        const r = this.record();
        return r && r.id ? { id: r.id, size: r.size ?? 0, durationMs: r.durationMs ?? 0, at: r.at } : null;
    }

    /**
     * Store `bytes` as THE custom sound (replacing any other). Validates size
     * and container; returns the content id. `at` defaults to now (a sync or
     * restore passes the remote stamp).
     */
    async set(bytes: Uint8Array, durationMs: number, opts: { at?: number; origin?: OwnSoundOrigin } = {}): Promise<string> {
        const uid = this.io.uid();
        if (!uid) throw new Error('signed_out');
        const bad = await checkSoundBytes(bytes);
        if (bad) throw new Error(`invalid_sound:${bad}`);
        const id = await contentIdOf(bytes);
        const before = this.record();
        const { sealed, keyB64 } = await sealBytes(bytes);
        await this.io.writeFile(ownSoundFileName(id), sealed);
        const rec: OwnSoundRecord = {
            v: 1, id, at: opts.at ?? this.io.now(), key: keyB64, size: bytes.length,
            durationMs: Math.max(0, Math.round(durationMs)),
        };
        this.io.kvSet(uid, JSON.stringify(rec));
        if (before?.id && before.id !== id) await this.deleteQuietly(before.id);
        this.plain = { uid, id, bytes: bytes.slice() };
        this.dropUrl();
        this.emit(opts.origin ?? 'local');
        return id;
    }

    /** Remove it (leaves a tombstone for sync). */
    async remove(opts: { at?: number; origin?: OwnSoundOrigin } = {}): Promise<void> {
        const uid = this.io.uid();
        if (!uid) return;
        const before = this.record();
        this.io.kvSet(uid, JSON.stringify({ v: 1, id: null, at: opts.at ?? this.io.now() } satisfies OwnSoundRecord));
        if (before?.id) await this.deleteQuietly(before.id);
        this.plain = null;
        this.dropUrl();
        this.emit(opts.origin ?? 'local');
    }

    /** Decrypted bytes of the current sound, verified against its id; null if absent or unreadable. */
    async read(): Promise<Uint8Array | null> {
        const uid = this.io.uid();
        const r = this.record();
        if (!uid || !r?.id || !r.key) return null;
        if (this.plain && this.plain.uid === uid && this.plain.id === r.id) return this.plain.bytes;
        let sealed: Uint8Array | null = null;
        try { sealed = await this.io.readFile(ownSoundFileName(r.id)); } catch { sealed = null; }
        if (!sealed) return null;
        let bytes: Uint8Array;
        try { bytes = await openBytes(sealed, r.key); } catch { return null; }
        if (await checkSoundBytes(bytes, r.id)) return null;
        this.plain = { uid, id: r.id, bytes };
        return bytes;
    }

    /** A blob: URL for previewing your own sound (cached per id). */
    async previewUrl(): Promise<string | null> {
        const r = this.record();
        if (!r?.id) return null;
        if (this.url?.id === r.id) return this.url.url;
        const bytes = await this.read();
        if (!bytes || typeof URL === 'undefined') return null;
        this.dropUrl();
        this.url = { id: r.id, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/webm' })) };
        return this.url.url;
    }

    subscribe(cb: (origin: OwnSoundOrigin) => void): () => void {
        this.listeners.add(cb);
        return () => { this.listeners.delete(cb); };
    }

    /** Forget decrypted state (account switch). */
    resetSession(): void {
        this.plain = null;
        this.dropUrl();
        this.emit('sync');
    }

    private dropUrl(): void {
        if (this.url) { try { URL.revokeObjectURL(this.url.url); } catch { /* ignore */ } }
        this.url = null;
    }

    private async deleteQuietly(id: string): Promise<void> {
        try { await this.io.deleteFile(ownSoundFileName(id)); } catch { /* already gone */ }
    }

    private emit(origin: OwnSoundOrigin): void {
        for (const cb of this.listeners) { try { cb(origin); } catch { /* listener bug */ } }
    }
}

// ── The real instance ───────────────────────────────────────────────────────

/** Lazy so importing this module touches neither storage nor IPC. */
let instance: OwnEntranceSoundStore | null = null;

export function ownEntranceSound(): OwnEntranceSoundStore {
    if (instance) return instance;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- electronAPI members are optional/version-dependent and not all declared on the typed bridge
    const api = () => (window as any).electronAPI;
    const dir = async () => `${await api().getUserDataPath()}/cipherline-gifs`;
    instance = new OwnEntranceSoundStore({
        uid: () => { try { return secureLocalStore.getItem('cipherline_user_id') || null; } catch { return null; } },
        kvGet: uid => secureLocalStore.getItem(ownSoundKey(uid)),
        // Literal key head on purpose: backupRegistry.test.ts finds new keys by scanning for it.
        kvSet: (uid, v) => secureLocalStore.setItem(`cipherline_entrance_sound_${uid}`, v),
        async readFile(name) {
            try {
                const buf = await api().readGifFile(name);
                return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
            } catch { return null; }
        },
        async writeFile(name, bytes) { await api().writeGifFile(name, bytes); },
        async deleteFile(name) { await api().deleteFile(`${await dir()}/${name}.enc`); },
        now: () => Date.now(),
    });
    return instance;
}
