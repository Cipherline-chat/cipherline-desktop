/**
 * incrementalBackup — LEGACY chunked backup layout (dated manifest +
 * `chunk-<hash>.enc` files). No longer written: backups are now ONE
 * self-contained file per destination (backupContainer.ts / driveBackup.ts).
 * Kept so every backup written in this layout stays restorable — the read
 * side (recoverBackupKey / decryptChunk / reassembleVault /
 * isIncrementalManifest) is what driveBackup.ts's legacy path uses; the
 * write side (buildBackupPlan & co.) now only serves its own tests, which
 * fabricate fixtures in this layout. driveBackup.ts deletes these files at a
 * destination once a new single-file backup has been written and verified.
 *
 * Original design notes follow.
 *
 * Every backup run used to re-serialize, re-encrypt, and re-write/re-upload
 * the ENTIRE vault from scratch (messages, keys, settings, GIFs,
 * attachments) — a full-vault write every time, even when almost nothing
 * had actually changed since the last run.
 *
 * This module splits a `BackupVault` into a small `meta` part (identity
 * keys, settings, pins — everything NOT keyed by conversation/attachment)
 * plus one chunk per DM/group conversation, per channel, per favorited GIF
 * file, and per bundled attachment. Each chunk is hashed (SHA-256 over its
 * PLAINTEXT JSON, computed BEFORE encryption — hashing ciphertext would
 * defeat dedup outright, since AES-GCM's random IV makes byte-identical
 * plaintext produce different ciphertext on every encryption). The content
 * hash becomes the chunk's filename (`chunk-<hash>.enc`), so unchanged data
 * — the common case for most conversations/attachments on most runs —
 * produces a file that already exists at the destination and is skipped
 * entirely: no re-encryption, no re-write, no re-upload.
 *
 * A small manifest (also written every run, but cheap — it's just a list of
 * {id, hash, file} references) is the only thing that changes on every
 * backup; it's what a restore reads first to know which chunk files to
 * fetch and how to reassemble them.
 *
 * This module is pure/orchestration-only — it has no knowledge of "local
 * folder" vs "Google Drive". driveBackup.ts is the destination-aware layer
 * that decides, per chunk, whether a file with that name already exists
 * (skip) or needs writing/uploading (do it), and prunes chunks no longer
 * referenced by any retained manifest.
 */

import type { BackupVault } from './crypto';
import { deriveBackupKey, encryptWithKey, decryptWithKey, parseBackupHeader } from './crypto';

export const MANIFEST_VERSION = 1;

export interface ChunkRef {
    /** Logical id: 'meta', `dm:<conversationId>`, `ch:<channelId>`,
     *  `gif:<gifId>`, or `att:<attachmentId>`. Used only for reassembly
     *  routing — never persisted anywhere but the manifest itself. */
    id: string;
    /** SHA-256 hex digest of the chunk's PLAINTEXT JSON — the content
     *  address. Two backup runs whose data for this id is byte-identical
     *  produce the same hash, and therefore the same filename. */
    hash: string;
    /** `chunk-<hash>.enc` — the filename this chunk is/should be stored
     *  under at the destination. Deterministic from `hash` alone; kept as
     *  its own field so callers never have to reconstruct it. */
    file: string;
}

export interface IncrementalManifest {
    v: number;
    userId: string;
    createdAt: string;
    chunks: ChunkRef[];
}

interface PlannedChunk extends ChunkRef {
    /** Plaintext JSON for this chunk — present only in the in-memory plan,
     *  never persisted unencrypted. */
    json: string;
}

export interface BackupPlan {
    manifest: IncrementalManifest;
    chunks: PlannedChunk[];
}

function chunkFileName(hash: string): string {
    return `chunk-${hash}.enc`;
}

/** SHA-256 hex digest of a UTF-8 string. */
export async function sha256Hex(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Split a vault into a `meta` object (everything not keyed by conversation/
 * channel/GIF/attachment) plus the four keyed maps pulled out separately.
 * Pure and synchronous — no hashing here, just partitioning.
 */
export function splitVault(vault: BackupVault): {
    meta: Record<string, unknown>;
    history: Record<string, unknown[]>;
    channelHistory: Record<string, unknown[]>;
    gifFiles: Record<string, string>;
    attachmentBlobs: Record<string, string>;
} {
    const {
        history, channelHistory, gifFiles, attachmentBlobs,
        ...meta
    } = vault as unknown as Record<string, unknown> & {
        history: Record<string, unknown[]>;
        channelHistory?: Record<string, unknown[]>;
        gifFiles?: Record<string, string>;
        attachmentBlobs?: Record<string, string>;
    };
    return {
        meta,
        history: history ?? {},
        channelHistory: channelHistory ?? {},
        gifFiles: gifFiles ?? {},
        attachmentBlobs: attachmentBlobs ?? {},
    };
}

/**
 * Build the full chunk plan (manifest + plaintext chunk JSON, unencrypted)
 * for a vault. Does not touch any destination — purely computes what
 * WOULD be written; the caller (driveBackup.ts) diffs this against what
 * already exists at the destination to decide what actually needs writing.
 */
export async function buildBackupPlan(vault: BackupVault): Promise<BackupPlan> {
    const { meta, history, channelHistory, gifFiles, attachmentBlobs } = splitVault(vault);

    const entries: { id: string; json: string }[] = [
        { id: 'meta', json: JSON.stringify(meta) },
        ...Object.entries(history).map(([convId, msgs]) => ({ id: `dm:${convId}`, json: JSON.stringify(msgs) })),
        ...Object.entries(channelHistory).map(([chId, msgs]) => ({ id: `ch:${chId}`, json: JSON.stringify(msgs) })),
        ...Object.entries(gifFiles).map(([gifId, b64]) => ({ id: `gif:${gifId}`, json: JSON.stringify(b64) })),
        ...Object.entries(attachmentBlobs).map(([attId, b64]) => ({ id: `att:${attId}`, json: JSON.stringify(b64) })),
    ];

    const chunks: PlannedChunk[] = await Promise.all(entries.map(async ({ id, json }) => {
        const hash = await sha256Hex(json);
        return { id, hash, file: chunkFileName(hash), json };
    }));

    const manifest: IncrementalManifest = {
        v: MANIFEST_VERSION,
        userId: (meta.userId as string) ?? '',
        createdAt: new Date().toISOString(),
        chunks: chunks.map(({ id, hash, file }) => ({ id, hash, file })),
    };

    return { manifest, chunks };
}

/**
 * Reassemble a full vault-shaped object from a manifest + a map of
 * chunk id → decrypted plaintext JSON (every id in `manifest.chunks` MUST
 * have an entry — the caller is responsible for having fetched/decrypted
 * them all first).
 */
export function reassembleVault(manifest: IncrementalManifest, chunkJsonById: Record<string, string>): BackupVault {
    const metaJson = chunkJsonById['meta'];
    if (metaJson === undefined) throw new Error('Manifest is missing its meta chunk');
    const vault = JSON.parse(metaJson) as BackupVault;

    const history: Record<string, unknown[]> = {};
    const channelHistory: Record<string, unknown[]> = {};
    const gifFiles: Record<string, string> = {};
    const attachmentBlobs: Record<string, string> = {};

    for (const ref of manifest.chunks) {
        if (ref.id === 'meta') continue;
        const json = chunkJsonById[ref.id];
        if (json === undefined) throw new Error(`Manifest references chunk "${ref.id}" but it wasn't provided`);
        const [prefix, ...rest] = ref.id.split(':');
        const key = rest.join(':');
        switch (prefix) {
            case 'dm': history[key] = JSON.parse(json); break;
            case 'ch': channelHistory[key] = JSON.parse(json); break;
            case 'gif': gifFiles[key] = JSON.parse(json); break;
            case 'att': attachmentBlobs[key] = JSON.parse(json); break;
            default: throw new Error(`Unknown chunk id prefix "${prefix}" in manifest`);
        }
    }

    vault.history = history;
    if (Object.keys(channelHistory).length) vault.channelHistory = channelHistory;
    if (Object.keys(gifFiles).length) vault.gifFiles = gifFiles;
    if (Object.keys(attachmentBlobs).length) vault.attachmentBlobs = attachmentBlobs;

    return vault;
}

// ── Encryption helpers built on crypto.ts's shared-key primitives ──────────
// The manifest is a self-contained v2 backup blob (encryptBackup/
// decryptBackup's exact format: magic+salt+IV+ciphertext) — its header IS
// the salt this whole backup generation's chunks are keyed against. Chunk
// files are the leaner `encryptWithKey` format ([12B IV][ciphertext], no
// salt/magic) since they all share the manifest's key; re-deriving via
// PBKDF2 (600k iterations) for every chunk would make a many-conversation
// backup take seconds to minutes longer than necessary.

export interface BackupKeyMaterial {
    key: CryptoKey;
    salt: Uint8Array;
}

/** Derive a fresh key + salt for a brand-new backup generation (first-ever
 *  run at a destination, or a rekey after a password change). */
export async function deriveNewBackupKey(password: string): Promise<BackupKeyMaterial> {
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveBackupKey(password, salt, 600_000, 'SHA-512');
    return { key, salt };
}

/**
 * Try to recover the key/salt an EXISTING manifest at the destination was
 * encrypted with, and confirm `password` still matches it (a real AES-GCM
 * decrypt, not just header parsing — the salt/KDF params are readable
 * without the password, but only a successful decrypt proves the password
 * is actually right). Returns null if `existingManifestBytes` is absent,
 * too small to parse, or the password doesn't match (auth failure) — all
 * three cases mean "start a fresh generation", handled identically by the
 * caller.
 */
export async function recoverBackupKey(
    existingManifestBytes: ArrayBuffer | null,
    password: string,
): Promise<{ key: CryptoKey; salt: Uint8Array; manifest: IncrementalManifest } | null> {
    if (!existingManifestBytes) return null;
    const header = parseBackupHeader(existingManifestBytes);
    if (!header) return null;
    try {
        const key = await deriveBackupKey(password, header.salt, header.iterations, header.hash);
        const pt = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: header.iv as any }, key, header.ct);
        const manifest = JSON.parse(new TextDecoder().decode(pt)) as IncrementalManifest;
        if (manifest?.v !== MANIFEST_VERSION || !Array.isArray(manifest.chunks)) return null;
        return { key, salt: header.salt, manifest };
    } catch {
        return null; // wrong password, or the file at this name isn't actually a manifest
    }
}

/** Encrypt the manifest as a self-contained v2 backup blob (reuses
 *  encryptBackup's exact on-disk format via the same primitives, but with
 *  an ALREADY-DERIVED key/salt so this doesn't re-run PBKDF2). */
export async function encryptManifest(manifest: IncrementalManifest, keyMaterial: BackupKeyMaterial): Promise<Uint8Array> {
    const BACKUP_MAGIC = new Uint8Array([0x43, 0x4c, 0x02]);
    const ivAndCt = await encryptWithKey(JSON.stringify(manifest), keyMaterial.key);
    const out = new Uint8Array(3 + 16 + ivAndCt.length);
    out.set(BACKUP_MAGIC, 0);
    out.set(keyMaterial.salt, 3);
    out.set(ivAndCt, 19);
    return out;
}

/** Encrypt one chunk's plaintext JSON with the shared backup key. */
export async function encryptChunk(json: string, key: CryptoKey): Promise<Uint8Array> {
    return encryptWithKey(json, key);
}

/** Decrypt one chunk's bytes with the shared backup key. */
export async function decryptChunk(bytes: Uint8Array, key: CryptoKey): Promise<string> {
    return decryptWithKey(bytes, key);
}

/** True iff a decrypted-and-JSON.parsed backup payload is the new
 *  chunked-manifest format rather than a legacy self-contained full vault.
 *  Used by the restore path to pick which reassembly strategy applies —
 *  every backup written before this format shipped, and everything the
 *  cross-device history-sync feature (HistoryRequestModal.tsx) still
 *  writes, is a full vault, not a manifest. */
export function isIncrementalManifest(parsed: unknown): parsed is IncrementalManifest {
    return !!parsed
        && typeof parsed === 'object'
        && (parsed as IncrementalManifest).v === MANIFEST_VERSION
        && Array.isArray((parsed as IncrementalManifest).chunks);
}

/**
 * Given the manifests being RETAINED after pruning (already decrypted and
 * parsed — `null` entries represent a retained backup that turned out to be
 * a legacy full-vault format, which has no chunk dependencies of its own),
 * compute the exact set of chunk filenames that must survive: the union of
 * every retained incremental manifest's chunk references.
 *
 * This is what makes pruning safe under content-addressed chunk reuse — a
 * chunk unchanged since 3 backups ago is still referenced by (and needed
 * to fully restore) every one of those 3 retained manifests, even though
 * the CURRENT run's manifest is the only one that actually got re-checked
 * for it. Deleting anything outside this set can never break a retained
 * backup's restorability; deleting anything INSIDE it would.
 */
export function chunkFilesToKeep(retainedManifests: (IncrementalManifest | null)[]): Set<string> {
    const keep = new Set<string>();
    for (const m of retainedManifests) {
        if (!m) continue;
        for (const c of m.chunks) keep.add(c.file);
    }
    return keep;
}
