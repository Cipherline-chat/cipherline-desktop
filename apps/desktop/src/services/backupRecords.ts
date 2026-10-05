/**
 * backupRecords — what goes INTO the single-file backup, and how it comes
 * back out.
 *
 * `buildBackupPlan` gathers the vault the way `exportLocalHistory` always
 * has (messages, settings, keys) and turns it into a list of RECORD SPECS —
 * each with an id, a content hash, and a lazy loader — without reading any
 * heavy bytes yet:
 *
 *   meta                        everything not keyed by conversation/channel/blob
 *   dm:<convId>:<YYYY-MM>       one DM/group conversation, one calendar month
 *   ch:<channelId>:<YYYY-MM>    one server channel, one calendar month
 *   gif:<gifId>                 raw bytes of `userData/cipherline-gifs/<gifId>.enc`
 *   att:<id>                    raw E2EE ciphertext of a cached/downloadable attachment
 *   sound:<name>                a custom notification sound file
 *
 * Messages are bucketed by month so that an in-place update of the local
 * file only rewrites the month that actually gained/edited/lost a message —
 * a conversation's older history stays byte-for-byte where it is. Blobs are
 * immutable per id: once in the file they're never re-read.
 *
 * `writeBackupRecords` drives one pass over the specs into up to two
 * writers: an in-place UPDATE of an existing file (carry unchanged records,
 * append changed ones) and/or a FRESH full write (everything). Each spec's
 * bytes are loaded at most once, and not at all when no writer needs them.
 *
 * `applyBackupContainer` is the inverse: it reassembles the vault-shaped
 * object `importLocalHistory` expects from the JSON records (merging month
 * buckets back into one conversation), then writes GIF/attachment/sound
 * bytes straight to where they live — never through base64.
 */

import { buildLocalVault, importLocalHistory, type BackupVault } from '../utils/crypto';
import { isKlipyRefEntry } from '../utils/gifLibrarySync';
import { getEncryptedAttachment, putEncryptedAttachment } from '../utils/attachmentCache';
import { sha256Hex, IMMUTABLE_HASH, type ContainerWriter, type OpenedContainer } from '../utils/backupContainer';

/** Server fallback for attachment bytes not in the local cache. Imported
 *  lazily: attachmentDownload pulls in axios, which reads `window.location`
 *  at import time — keeping it out of this module's static graph lets the
 *  backup orchestration load (and be unit-tested) without a browser. */
async function fetchAttachmentFromServer(id: string, token: string): Promise<Blob | null> {
    const [{ downloadEncryptedAttachment }, { API_BASE }] = await Promise.all([
        import('../utils/attachmentDownload'),
        import('../constants'),
    ]);
    return downloadEncryptedAttachment(id, token, API_BASE);
}

export interface RecordSpec {
    id: string;
    kind: 'json' | 'blob';
    /** SHA-256 of the JSON plaintext, or IMMUTABLE_HASH for blobs. */
    hash: string;
    /** Bytes to write; null = unavailable (skip with a warning). */
    load(): Promise<Uint8Array | null>;
}

export interface BackupPlan {
    userId: string;
    /** SHA-256 over the canonical plaintext of everything the file will hold. */
    fingerprint: string;
    records: RecordSpec[];
    /** How many `att:` specs are subject to the size cap / server fetch. */
    attachmentIds: string[];
    attachmentSizeHints: Record<string, number>;
}

export interface WriteRecordsOpts {
    /** API token — needed to fetch attachment bytes not in the local cache. */
    token?: string;
    /** Skip attachments larger than this. Omit = no limit. */
    maxAttachmentBytes?: number;
    onAttachmentProgress?: (done: number, total: number) => void;
}

export interface WriteRecordsResult {
    attachmentsWritten: number;
    attachmentsSkipped: number;
    attachmentsMissing: number;
    /** Records appended to the in-place update (0 when nothing changed). */
    updatedRecords: number;
    /** Records carried unchanged in the in-place update. */
    carriedRecords: number;
}

const enc = new TextEncoder();

/** Split a vault into the `meta` part plus the keyed maps that become their
 *  own records. Exported for tests. */
export function splitVaultForRecords(vault: BackupVault): {
    meta: Record<string, unknown>;
    history: Record<string, unknown[]>;
    channelHistory: Record<string, unknown[]>;
} {
    const meta: Record<string, unknown> = { ...(vault as unknown as Record<string, unknown>) };
    for (const k of ['history', 'channelHistory', 'gifFiles', 'attachmentBlobs', 'transferMeta']) delete meta[k];
    return { meta, history: vault.history ?? {}, channelHistory: vault.channelHistory ?? {} };
}

/** Month bucket key for a message, from whichever timestamp field it has;
 *  `na` when it has none. Exported for tests. */
export function monthBucket(msg: unknown): string {
    const m = msg as { timestamp?: unknown; sent_at?: unknown; created_at?: unknown } | null;
    const t = m?.timestamp ?? m?.sent_at ?? m?.created_at;
    const ms = typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t) : NaN;
    if (!Number.isFinite(ms)) return 'na';
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Group one conversation's messages by month, preserving order within a month. */
export function bucketByMonth(msgs: unknown[]): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {};
    for (const m of msgs) (out[monthBucket(m)] ??= []).push(m);
    return out;
}

function collectAttachmentRefs(
    ...maps: Record<string, unknown[]>[]
): { ids: string[]; sizeHints: Record<string, number> } {
    const ids = new Set<string>();
    const sizeHints: Record<string, number> = {};
    for (const map of maps) {
        for (const msgs of Object.values(map)) {
            if (!Array.isArray(msgs)) continue;
            for (const m of msgs) {
                const content = (m as { content?: { attachment_id?: unknown; size?: unknown; file_size?: unknown } } | null)?.content;
                const aid = content?.attachment_id;
                if (typeof aid !== 'string' || !aid) continue;
                ids.add(aid);
                const sz = content?.size ?? content?.file_size ?? 0;
                if (typeof sz === 'number' && sz > 0 && !(aid in sizeHints)) sizeHints[aid] = sz;
            }
        }
    }
    return { ids: [...ids].sort(), sizeHints };
}

/**
 * Canonical fingerprint of a plan's content: SHA-256 over every record's id and
 * content hash, in id order. Each JSON record's hash is already the SHA-256 of
 * its exact plaintext, and blob records (gif/sound/attachment) are identified
 * by id, so this covers exactly what the file holds. It used to re-serialise
 * the whole history into one string just for this — the single biggest
 * synchronous UI-thread cost of a scheduled backup.
 */
export async function fingerprintFromSpecs(specs: readonly Pick<RecordSpec, 'id' | 'hash'>[]): Promise<string> {
    const lines = specs.map(r => `${r.id}\t${r.hash}`).sort();
    return sha256Hex(lines.join('\n'));
}

/** Fingerprint of in-memory vault pieces (same value buildBackupPlan computes). Exported for tests. */
export async function fingerprintPlan(p: {
    meta: Record<string, unknown>;
    history: Record<string, unknown[]>;
    channelHistory: Record<string, unknown[]>;
    gifIds: string[];
    attachmentIds: string[];
    soundNames?: string[];
}): Promise<string> {
    return fingerprintFromSpecs(await specsFromVault({
        meta: p.meta,
        history: p.history,
        channelHistory: p.channelHistory,
        gifIds: p.gifIds,
        attachmentIds: p.attachmentIds,
        sounds: (p.soundNames ?? []).map(name => ({ name, file: name })),
    }));
}

const jsonSpec = async (id: string, value: unknown): Promise<RecordSpec> => {
    const bytes = enc.encode(JSON.stringify(value));
    return { id, kind: 'json', hash: await sha256Hex(bytes), load: async () => bytes };
};
const blobSpec = (id: string, load: () => Promise<Uint8Array | null>): RecordSpec =>
    ({ id, kind: 'blob', hash: IMMUTABLE_HASH, load });

/** Build the record specs from in-memory vault pieces. Pure apart from the
 *  loaders it hands back; exported so the orchestration tests can build
 *  realistic plans without IndexedDB. */
export async function specsFromVault(parts: {
    meta: Record<string, unknown>;
    history: Record<string, unknown[]>;
    channelHistory: Record<string, unknown[]>;
    gifIds?: string[];
    attachmentIds?: string[];
    sounds?: { name: string; file: string }[];
    loaders?: {
        gif?: (id: string) => Promise<Uint8Array | null>;
        attachment?: (id: string) => Promise<Uint8Array | null>;
        sound?: (file: string) => Promise<Uint8Array | null>;
    };
}): Promise<RecordSpec[]> {
    const specs: RecordSpec[] = [await jsonSpec('meta', parts.meta)];
    for (const [convId, msgs] of Object.entries(parts.history)) {
        for (const [bucket, part] of Object.entries(bucketByMonth(msgs))) specs.push(await jsonSpec(`dm:${convId}:${bucket}`, part));
    }
    for (const [chId, msgs] of Object.entries(parts.channelHistory)) {
        for (const [bucket, part] of Object.entries(bucketByMonth(msgs))) specs.push(await jsonSpec(`ch:${chId}:${bucket}`, part));
    }
    const L = parts.loaders ?? {};
    for (const id of parts.gifIds ?? []) specs.push(blobSpec(`gif:${id}`, () => L.gif?.(id) ?? Promise.resolve(null)));
    for (const s of parts.sounds ?? []) specs.push(blobSpec(`sound:${s.name}`, () => L.sound?.(s.file) ?? Promise.resolve(null)));
    for (const id of parts.attachmentIds ?? []) specs.push(blobSpec(`att:${id}`, () => L.attachment?.(id) ?? Promise.resolve(null)));
    return specs;
}

export async function buildBackupPlan(
    userId: string,
    opts: { includeAttachments: boolean; token?: string; maxAttachmentBytes?: number },
): Promise<BackupPlan> {
    // Unfiltered export, minus the base64 GIF inlining — GIF bytes are
    // streamed as records.
    const vault: BackupVault = await buildLocalVault(userId, { includeGifFiles: false });
    const { meta, history, channelHistory } = splitVaultForRecords(vault);

    const api = window.electronAPI;
    let gifIds: string[] = [];
    if (api?.listGifFiles) {
        // `<userData>/cipherline-gifs` is shared by every account on the
        // machine, so the raw listing includes GIFs belonging to other
        // accounts — bytes this vault's keys could never decrypt. Keep only
        // the ids this account's own library references.
        //
        // KLIPY references are left out even though they ARE this account's
        // entries: a reference has no media file by design (KLIPY's terms
        // forbid storing their media, backups included), so no `gif:` record
        // may ever be produced for one — not even if a stray `<id>.enc`
        // somehow existed on disk. The reference itself rides in `meta`.
        const owned = new Set(
            (Array.isArray(vault.gifFavorites) ? vault.gifFavorites : [])
                .filter((g: unknown) => !isKlipyRefEntry(g))
                .map((g: any) => g?.id).filter(Boolean),
        );
        try {
            gifIds = [...(await api.listGifFiles())].filter(id => owned.has(id)).sort();
        } catch { gifIds = []; }
    }
    let sounds: { name: string; file: string }[] = [];
    if (api?.listCustomSounds) {
        try { sounds = (await api.listCustomSounds()).sort((a, b) => a.name.localeCompare(b.name)); } catch { sounds = []; }
    }
    const refs = opts.includeAttachments ? collectAttachmentRefs(history, channelHistory) : { ids: [], sizeHints: {} };

    const toU8 = (b: Uint8Array | ArrayBuffer) => (b instanceof Uint8Array ? b : new Uint8Array(b));
    const cap = opts.maxAttachmentBytes;
    const records = await specsFromVault({
        meta, history, channelHistory, gifIds, sounds, attachmentIds: refs.ids,
        loaders: {
            gif: async (id) => { try { return api?.readGifFile ? toU8(await api.readGifFile(id)) : null; } catch { return null; } },
            sound: async (file) => { try { return api?.readCustomSound ? toU8(await api.readCustomSound(file)) : null; } catch { return null; } },
            attachment: async (id) => {
                const hint = refs.sizeHints[id] ?? 0;
                if (cap && hint > cap) return null;
                let blob: Blob | null = null;
                try {
                    blob = await getEncryptedAttachment(id);
                    if (!blob && opts.token) blob = await fetchAttachmentFromServer(id, opts.token);
                } catch { blob = null; }
                if (!blob || (cap && blob.size > cap)) return null;
                return new Uint8Array(await blob.arrayBuffer());
            },
        },
    });

    return {
        userId,
        fingerprint: await fingerprintFromSpecs(records),
        records,
        attachmentIds: refs.ids,
        attachmentSizeHints: refs.sizeHints,
    };
}

/**
 * One pass over the plan into the given writers (does NOT call finish).
 *   update — an in-place ContainerWriter resumed on the existing local file:
 *            unchanged records are carried, changed/new ones appended.
 *   fresh  — a full write (new local file, or the Drive staging copy).
 */
export async function writeBackupRecords(
    plan: BackupPlan,
    writers: { update?: ContainerWriter; fresh?: ContainerWriter },
    opts: WriteRecordsOpts = {},
): Promise<WriteRecordsResult> {
    const result: WriteRecordsResult = {
        attachmentsWritten: 0, attachmentsSkipped: 0, attachmentsMissing: 0, updatedRecords: 0, carriedRecords: 0,
    };
    const { update, fresh } = writers;
    const totalAtt = plan.attachmentIds.length;
    let doneAtt = 0;

    for (const spec of plan.records) {
        const isAtt = spec.id.startsWith('att:');
        const unchanged = !!update && update.has(spec.id) && update.hashOf(spec.id) === spec.hash;
        const needUpdate = !!update && !unchanged;
        if (!needUpdate && !fresh) {
            update!.carry(spec.id);
            result.carriedRecords++;
            if (isAtt) opts.onAttachmentProgress?.(++doneAtt, totalAtt);
            continue;
        }

        const bytes = await spec.load();
        if (bytes === null) {
            if (isAtt) {
                // Over the cap, or gone from both cache and server. If the
                // file being updated still holds an older copy, keep it.
                const hint = plan.attachmentSizeHints[spec.id.slice(4)] ?? 0;
                if (opts.maxAttachmentBytes && hint > opts.maxAttachmentBytes) result.attachmentsSkipped++;
                else result.attachmentsMissing++;
                opts.onAttachmentProgress?.(++doneAtt, totalAtt);
            } else {
                console.warn('[backup] record unavailable, leaving it out', spec.id);
            }
            if (update?.has(spec.id)) { update.carry(spec.id); result.carriedRecords++; }
            continue;
        }

        if (needUpdate) { await update!.addBytes(spec.id, bytes, spec.hash); result.updatedRecords++; }
        else if (unchanged) { update!.carry(spec.id); result.carriedRecords++; }
        if (fresh) await fresh.addBytes(spec.id, bytes, spec.hash);
        if (isAtt) { result.attachmentsWritten++; opts.onAttachmentProgress?.(++doneAtt, totalAtt); }
    }
    return result;
}

/**
 * Apply an opened container (v3 or v4) to this device for `userId`. Account binding
 * is checked against the index BEFORE anything is read, then again by
 * `importLocalHistory` on the reassembled vault (belt and braces — the
 * index and the meta record are both authenticated under the same key).
 */
export async function applyBackupContainer(
    userId: string,
    container: OpenedContainer,
    onProgress?: (done: number, total: number) => void,
): Promise<void> {
    if (!container.index.userId) throw new Error('This backup is missing account information — refusing to restore.');
    if (container.index.userId !== userId) throw new Error('This backup belongs to a different account — refusing to restore.');

    const records = container.index.records;
    const total = records.length;
    let done = 0;
    const tick = () => onProgress?.(++done, total);

    const meta = await container.readJson<Record<string, unknown>>('meta');
    tick();
    // conv → bucket → messages; buckets are merged in chronological key
    // order ('na' first). A pre-bucketing `dm:<conv>` record lands in '' and
    // sorts first too.
    const dmBuckets: Record<string, Record<string, unknown[]>> = {};
    const chBuckets: Record<string, Record<string, unknown[]>> = {};
    const blobRecords: { id: string; kind: 'gif' | 'att' | 'sound'; key: string }[] = [];
    for (const r of records) {
        if (r.id === 'meta') continue;
        const sep = r.id.indexOf(':');
        const prefix = sep === -1 ? r.id : r.id.slice(0, sep);
        const rest = r.id.slice(sep + 1);
        switch (prefix) {
            case 'dm': case 'ch': {
                const cut = rest.lastIndexOf(':');
                const [key, bucket] = cut === -1 ? [rest, ''] : [rest.slice(0, cut), rest.slice(cut + 1)];
                const target = prefix === 'dm' ? dmBuckets : chBuckets;
                (target[key] ??= {})[bucket] = await container.readJson(r.id);
                tick();
                break;
            }
            case 'gif': blobRecords.push({ id: r.id, kind: 'gif', key: rest }); break;
            case 'att': blobRecords.push({ id: r.id, kind: 'att', key: rest }); break;
            case 'sound': blobRecords.push({ id: r.id, kind: 'sound', key: rest }); break;
            default: throw new Error(`Unknown backup record "${r.id}"`);
        }
    }
    const merge = (buckets: Record<string, Record<string, unknown[]>>): Record<string, unknown[]> => {
        const out: Record<string, unknown[]> = {};
        for (const [key, byBucket] of Object.entries(buckets)) {
            const order = Object.keys(byBucket).sort((a, b) => (a === 'na' ? -1 : b === 'na' ? 1 : a < b ? -1 : a > b ? 1 : 0));
            out[key] = order.flatMap(b => byBucket[b]);
        }
        return out;
    };
    const history = merge(dmBuckets);
    const channelHistory = merge(chBuckets);

    const api = window.electronAPI;
    // Custom sounds go first: importLocalHistory re-points the notification
    // prefs at whatever custom-sound files exist on this machine.
    const applyBlob = async (b: { id: string; kind: 'gif' | 'att' | 'sound'; key: string }) => {
        try {
            const bytes = await container.readBytes(b.id);
            if (b.kind === 'gif') {
                if (api?.writeGifFile) await api.writeGifFile(b.key, bytes);
            } else if (b.kind === 'sound') {
                if (api?.uploadCustomSound) await api.uploadCustomSound(b.key, bytes);
            } else {
                await putEncryptedAttachment(b.key, new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
            }
        } catch (e) {
            console.warn('[restore] failed to apply record', b.id, e);
        }
        tick();
    };
    for (const b of blobRecords) if (b.kind === 'sound') await applyBlob(b);

    const vault = {
        ...meta,
        history,
        ...(Object.keys(channelHistory).length ? { channelHistory } : {}),
    };
    await importLocalHistory(userId, new Blob([JSON.stringify(vault)], { type: 'application/json' }));

    for (const b of blobRecords) if (b.kind !== 'sound') await applyBlob(b);
}
