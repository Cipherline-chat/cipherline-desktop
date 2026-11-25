/**
 * The page's side of a local history transfer: what to send, and how to apply what arrived. Everything goes
 * through the EXISTING backup machinery (`buildBackupPlan`, `ContainerWriter`, `openContainer`,
 * `applyBackupContainer`) and `utils/nearHistoryTransfer.ts` (which spools through the existing `backup*` bridge).
 * Injectable so the screens and tests do not need a vault.
 *
 * KEY (contract 11.15): the container is sealed under the transfer's raw 32-byte key `K_xfer` (the host derives it from the
 * session's key schedule and releases it to the page only after this device is approved: `nearTransferKey`), with the key
 * derivation skipped. The page holds the key for one write or one import and zeroes its copy after; nothing about it is stored
 * or logged here. A port with no key source (`transferKey` missing) refuses to write or import (`pending_key`), never sends
 * something the other side cannot open.
 */
import type { ByteSink, ByteSource } from './backupContainer';

export interface HistoryEstimate {
    /** Everything the container will hold, in bytes (attachments by their size hints). */
    totalBytes: number;
    messages: number;
    attachments: number;
    /** The attachment part of `totalBytes` (what the switch takes out). */
    attachmentBytes: number;
}

export interface HistoryCounts {
    messages: number;
    /** Attachments actually written (a split attachment counts once, and only when every part arrived). */
    attachments: number;
    /** Attachments in the container that were NOT imported (a part missing / out of order / insane, or a failed write). Not shown yet: the spec has no string for it. */
    attachmentsIncomplete?: number;
}

export interface NearHistoryPort {
    /** `null` = nothing to size (no vault on this device). */
    estimate(): Promise<HistoryEstimate | null>;
    writeContainer(sink: ByteSink, opts: { includeAttachments: boolean }): Promise<void>;
    importContainer(source: ByteSource, size: number): Promise<HistoryCounts>;
    /** "Keep what arrived" (contract 11.10): apply only the records whose bytes all lie inside `ranges` (`[offset, length]`, the
     *  verified parts of a stopped transfer). The container's header and index are in the first and last parts, which the
     *  sender sends first; a stopped transfer that does not hold them has nothing to apply and gets zero counts. */
    importPartial?(source: ByteSource, size: number, ranges: readonly (readonly [number, number])[]): Promise<HistoryCounts>;
}

/** True iff a record's whole frame `[offset, offset+len)` lies inside one of the held ranges. */
export function recordIsHeld(ref: { offset: number; len: number }, ranges: readonly (readonly [number, number])[]): boolean {
    return ranges.some(([o, l]) => ref.offset >= o && ref.offset + ref.len <= o + l);
}

/** How far the sender reads ahead of the writer (B6): the attachment loaders (IndexedDB + unwrap, or two server round trips on a
 *  cache miss) are the slow part of building the container, and are independent of each other. Memory stays bounded by `byteBudget`. */
export const NEAR_SEND_PREFETCH = { concurrency: 6, byteBudget: 96 * 1024 * 1024 } as const;

export class HistoryPortPending extends Error {
    readonly code = 'pending_key';
    constructor() { super('There is no transfer key for this local history transfer.'); this.name = 'HistoryPortPending'; }
}

interface PlanLike {
    records: { id: string; kind: 'json' | 'blob'; load(): Promise<Uint8Array | null> }[];
    attachmentIds: string[];
    attachmentSizeHints: Record<string, number>;
}

/** Sizes a backup plan without writing it: JSON records are loaded once to count; attachments use their hints. */
export async function estimateFromPlan(plan: PlanLike): Promise<HistoryEstimate> {
    let total = 0; let messages = 0; let attachmentBytes = 0;
    const dec = new TextDecoder();
    for (const r of plan.records) {
        if (r.id.startsWith('att:')) continue;
        const bytes = await r.load();
        if (!bytes) continue;
        total += bytes.length;
        if (r.id.startsWith('dm:') || r.id.startsWith('ch:')) {
            try { const v = JSON.parse(dec.decode(bytes)) as unknown; if (Array.isArray(v)) messages += v.length; } catch { /* not a message list */ }
        }
    }
    for (const id of plan.attachmentIds) attachmentBytes += plan.attachmentSizeHints[id] ?? 0;
    return { totalBytes: total + attachmentBytes, messages, attachments: plan.attachmentIds.length, attachmentBytes };
}

export interface VaultPortOptions {
    userId: string;
    token?: string;
    /** Where `K_xfer` comes from (the host, after approval). `null` / absent: refuse to write or import. The port zeroes the bytes
     *  it was given as soon as it has used them. */
    transferKey?: (() => Promise<Uint8Array | null>) | null;
}

/** The real port, over the user's vault. Imports are account-bound (`applyBackupContainer` checks the user id). */
export function createVaultHistoryPort(o: VaultPortOptions): NearHistoryPort {
    const withKey = async <T,>(use: (key: Uint8Array) => Promise<T>): Promise<T> => {
        const key = o.transferKey ? await o.transferKey() : null;
        if (!key || key.length !== 32) throw new HistoryPortPending();
        try { return await use(key); } finally { key.fill(0); }
    };
    return {
        async estimate() {
            const { buildBackupPlan } = await import('../services/backupRecords');
            return estimateFromPlan(await buildBackupPlan(o.userId, { includeAttachments: true, token: o.token }));
        },
        writeContainer(sink, opts) {
            return withKey(async key => {
                const [{ buildBackupPlan, writeBackupRecords }, { ContainerWriter }] = await Promise.all([import('../services/backupRecords'), import('./backupContainer')]);
                const plan = await buildBackupPlan(o.userId, { includeAttachments: opts.includeAttachments, token: o.token });
                const writer = await ContainerWriter.createRaw(key, sink);
                await writeBackupRecords(plan, { fresh: writer }, { token: o.token, prefetch: NEAR_SEND_PREFETCH });
                await writer.finish({ userId: o.userId, fingerprint: plan.fingerprint });
            });
        },
        importContainer(source) {
            return withKey(async key => {
                const [{ applyBackupContainer }, { openContainer }] = await Promise.all([import('../services/backupRecords'), import('./backupContainer')]);
                const container = await openContainer(source, { rawKey: key });
                const r = await applyBackupContainer(o.userId, container, undefined, { merge: true });
                return { messages: 0, attachments: r.attachmentsApplied, attachmentsIncomplete: r.attachmentsIncomplete };
            });
        },
        importPartial(source, _size, ranges) {
            return withKey(async key => {
                const [{ applyBackupContainer }, { openContainer }] = await Promise.all([import('../services/backupRecords'), import('./backupContainer')]);
                const container = await openContainer(source, { rawKey: key });
                const held = container.index.records.filter(r => recordIsHeld(r, ranges));
                // `meta` is read first by the importer: without it nothing can be applied.
                if (!held.some(r => r.id === 'meta')) return { messages: 0, attachments: 0 };
                // Only the records that arrived; the rest of the index is not offered to the importer, so a record that did not
                // arrive is never read (it would be zeros) and is never counted as applied.
                const partial = { ...container, index: { ...container.index, records: held } };
                const r = await applyBackupContainer(o.userId, partial, undefined, { merge: true });
                return { messages: 0, attachments: r.attachmentsApplied, attachmentsIncomplete: r.attachmentsIncomplete };
            });
        },
    };
}
