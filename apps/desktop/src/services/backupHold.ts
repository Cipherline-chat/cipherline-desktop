/**
 * backupHold — what a backup keeps from the previous backup when this device's
 * store loaded with records it could not read (secureLocalStore: UNREADABLE
 * RECORDS, status `partial`).
 *
 * WHY (2026-11-26): a tester's PC lost power; two records came back unreadable.
 * The store loaded without them and held their writes, which is right. But the
 * backup then refused to run at all — "restart and try again" — and a restart
 * reads the same damaged records, so it could NEVER run again: no new backups,
 * and her messages since the last one were unprotected. The refusal existed
 * because an export built without those records would be written over the
 * previous backup, and the writer drops whatever the new export lacks, so the
 * one other copy of those records would go too.
 *
 * The safe answer is not to refuse, it is to not drop. A record the export
 * lacks BECAUSE the store could not read it is carried over, byte for byte,
 * from the backup already at the destination. Everything readable is backed up
 * as usual, so a damaged record no longer stops the rest from being protected,
 * and the previous copy of the damaged part is exactly as safe as before.
 *
 * What a damaged store key means for the backup's records:
 *   cipherline_msgs_<uid>_<conv>          → every `dm:<conv>:*` record
 *   cipherline_channel_msgs_<uid>_<ch>    → every `ch:<ch>:*` record
 *   a key the registry backs up through a vault field (`vault.topics`, …)
 *                                         → that field of `meta`, from the old meta
 *   an included settings key              → that entry of `meta.kv`, from the old meta
 *   a key nothing here can place          → `meta` fields the new meta lacks, from the old
 *   anything else (caches, other accounts) → nothing: it was never in the backup
 *
 * Pure: no store, no IPC, no network. backupRecords.ts builds the plan's hold
 * from the store's unreadable keys; driveBackup.ts applies it to the files.
 */
import { classifyKvKey, toPortableKey, vaultFieldForKey } from './backupRegistry';

export interface BackupHold {
    /** Backup record-id prefixes (`dm:<conv>:`) whose previous records are kept. */
    recordPrefixes: string[];
    /** Top-level fields of the previous `meta` that replace the new ones. */
    metaFields: string[];
    /** Entries of the previous `meta.kv` that replace the new ones. */
    kvKeys: string[];
    /** A key the registry cannot place: fill what the new meta lacks from the old. */
    fillMissing: boolean;
    /** How many store records could not be read. A count, never a key. */
    count: number;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** What the unreadable `keys` mean for a backup of `userId`; undefined when none of them touch it. */
export function holdFromUnreadable(keys: readonly string[], userId: string): BackupHold | undefined {
    if (keys.length === 0 || !userId) return undefined;
    const prefixes = new Set<string>();
    const fields = new Set<string>();
    const kv = new Set<string>();
    let fillMissing = false;
    const dmBase = `cipherline_msgs_${userId}`;
    const chBase = `cipherline_channel_msgs_${userId}`;

    for (const key of keys) {
        if (key === dmBase) { prefixes.add('dm:'); continue; }
        if (key === chBase) { prefixes.add('ch:'); continue; }
        if (key.startsWith(`${dmBase}_`)) { prefixes.add(`dm:${key.slice(dmBase.length + 1)}:`); continue; }
        if (key.startsWith(`${chBase}_`)) { prefixes.add(`ch:${key.slice(chBase.length + 1)}:`); continue; }
        // Another account's record on a shared machine: not in this backup.
        if ((key.match(UUID_RE) ?? []).some(u => u.toLowerCase() !== userId.toLowerCase())) continue;
        const verdict = classifyKvKey(key, userId);
        if (verdict === 'include') { kv.add(toPortableKey(key, userId)); continue; }
        const field = vaultFieldForKey(key, userId);
        if (field) { fields.add(field); continue; }
        if (verdict === 'unknown') fillMissing = true;
        // 'exclude' with no vault field: a cache or a per-device record. Not in the backup.
    }
    if (!prefixes.size && !fields.size && !kv.size && !fillMissing) return undefined;
    return { recordPrefixes: [...prefixes].sort(), metaFields: [...fields].sort(), kvKeys: [...kv].sort(), fillMissing, count: keys.length };
}

/**
 * The ids in the previous backup that the new one must keep: those under a held
 * prefix that the new plan does not itself hold. (`meta` is merged, not carried.)
 */
export function heldRecordIds(previousIds: Iterable<string>, planIds: ReadonlySet<string>, hold: BackupHold): string[] {
    const out: string[] = [];
    for (const id of previousIds) {
        if (id === 'meta' || planIds.has(id)) continue;
        if (hold.recordPrefixes.some(p => id.startsWith(p))) out.push(id);
    }
    return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The new `meta` with the previous backup's values for what could not be read.
 * Returns the new meta untouched (same object) when there is nothing to take.
 */
export function mergeHeldMeta(next: Record<string, unknown>, previous: unknown, hold: BackupHold): Record<string, unknown> {
    if (!isRecord(previous)) return next;
    const out: Record<string, unknown> = { ...next };
    let changed = false;
    for (const f of hold.metaFields) {
        if (f in previous && previous[f] !== undefined) { out[f] = previous[f]; changed = true; }
    }
    if (hold.kvKeys.length) {
        const prevKv = isRecord(previous.kv) ? previous.kv : {};
        const kv: Record<string, unknown> = { ...(isRecord(next.kv) ? next.kv : {}) };
        for (const k of hold.kvKeys) {
            if (k in prevKv) { kv[k] = prevKv[k]; changed = true; }
        }
        out.kv = kv;
    }
    if (hold.fillMissing) {
        for (const [f, v] of Object.entries(previous)) {
            if (out[f] === undefined && v !== undefined) { out[f] = v; changed = true; }
        }
    }
    return changed ? out : next;
}
