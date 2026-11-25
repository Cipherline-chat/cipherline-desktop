/**
 * Split attachment records of a container.
 *
 * The desktop writes an attachment as ONE record, `att:<id>`. The phone core also writes a transfer container in which an attachment
 * bigger than one transfer part (16 MiB) is cut into `att:<id>:<n>:<m>` (1-based part n of m, so no single AEAD frame has to hold
 * a multi-GiB buffer); an attachment that fits one part is still `att:<id>`. (Phone BACKUPS write `att:<id>` only, so restoring a phone
 * backup never met the split form; a phone-to-desktop TRANSFER does.)
 *
 * This module groups a container's `att:` records and decides, strictly, which attachments are COMPLETE. Anything else is reported
 * as incomplete and is never assembled: a truncated attachment must not be imported as if it were whole.
 */
import type { ContainerRecordRef } from './backupContainer';

/** One transfer part (the phone's `part_bytes`); a part of any other size than the first's, bar the last, is refused. */
export const MAX_ATT_PART_BYTES = 64 * 1024 * 1024;
/** 2 GiB is the largest upload the product allows; the parts of one attachment may not add up to more. */
export const MAX_ATT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_ATT_PARTS = 2048;

export interface SplitAttachment {
    /** The attachment id (what `att:<id>` would have carried). */
    key: string;
    /** The part records, ascending by n, all present. */
    parts: ContainerRecordRef[];
    totalBytes: number;
}

export type IncompleteReason = 'bad_id' | 'bad_part_number' | 'missing_parts' | 'out_of_order' | 'parts_disagree' | 'bad_sizes' | 'too_large' | 'conflicts_with_whole';

export interface AttachmentRecordPlan {
    /** `att:<id>` records (one record each). */
    whole: { id: string; key: string }[];
    /** Complete split attachments, ready to reassemble. */
    split: SplitAttachment[];
    /** Attachments (or malformed `att:` records) that cannot be imported, with the reason; the records are left alone. */
    incomplete: { key: string; reason: IncompleteReason; records: string[] }[];
}

const SPLIT = /^([^:]+):(0|[1-9]\d{0,5}):(0|[1-9]\d{0,5})$/;

export function planAttachmentRecords(records: readonly ContainerRecordRef[]): AttachmentRecordPlan {
    const plan: AttachmentRecordPlan = { whole: [], split: [], incomplete: [] };
    const groups = new Map<string, { m: number[]; parts: { n: number; ref: ContainerRecordRef; pos: number }[]; bad: boolean }>();
    const wholeKeys = new Set<string>();
    let pos = 0;
    for (const r of records) {
        pos++;
        if (!r.id.startsWith('att:')) continue;
        const rest = r.id.slice(4);
        if (rest.length === 0) { plan.incomplete.push({ key: '', reason: 'bad_id', records: [r.id] }); continue; }
        if (!rest.includes(':')) { plan.whole.push({ id: r.id, key: rest }); wholeKeys.add(rest); continue; }
        const m = SPLIT.exec(rest);
        if (!m) { plan.incomplete.push({ key: rest, reason: 'bad_id', records: [r.id] }); continue; }
        const [, key, ns, ms] = m;
        const n = Number(ns);
        const total = Number(ms);
        const g = groups.get(key) ?? { m: [], parts: [], bad: false };
        groups.set(key, g);
        if (!g.m.includes(total)) g.m.push(total);
        g.parts.push({ n, ref: r, pos });
    }
    for (const [key, g] of groups) {
        const ids = g.parts.map(p => p.ref.id);
        const fail = (reason: IncompleteReason) => plan.incomplete.push({ key, reason, records: ids });
        if (wholeKeys.has(key)) { fail('conflicts_with_whole'); continue; }
        if (g.m.length !== 1) { fail('parts_disagree'); continue; }
        const m = g.m[0];
        // a transfer writes `att:<id>` for anything that fits one part, so a "1 of 1" split (or 0 of anything) is not a form it produces
        if (m < 2 || m > MAX_ATT_PARTS || g.parts.some(p => p.n < 1 || p.n > m)) { fail('bad_part_number'); continue; }
        if (new Set(g.parts.map(p => p.n)).size !== m || g.parts.length !== m) { fail('missing_parts'); continue; }
        // in order: part n sits before part n+1 in the container's index
        if (g.parts.some((p, i) => p.n !== i + 1)) { fail('out_of_order'); continue; }
        const sizes = g.parts.map(p => p.ref.size);
        const first = sizes[0];
        const sane = Number.isSafeInteger(first) && first > 0 && first <= MAX_ATT_PART_BYTES
            && sizes.slice(0, -1).every(s => s === first)
            && sizes[m - 1] > 0 && sizes[m - 1] <= first;
        if (!sane) { fail('bad_sizes'); continue; }
        const totalBytes = sizes.reduce((a, b) => a + b, 0);
        if (totalBytes > MAX_ATT_TOTAL_BYTES) { fail('too_large'); continue; }
        plan.split.push({ key, parts: g.parts.map(p => p.ref), totalBytes });
    }
    return plan;
}
