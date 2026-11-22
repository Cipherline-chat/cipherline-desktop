/**
 * "Copy messages from Discord" into an EXISTING server (owner 2026-11-22: his import left #general_chat and
 * #files_pictures empty; he must fill them without deleting the server). Pure: which Discord channel goes
 * into which existing channel, and which ones must be skipped so nothing is ever copied twice.
 *
 * AUTO-MATCH, in order:
 *   1. the previous import's mapping: the API recorded which Discord channel (a keyed hash of its source
 *      key) filled which channel, and answers by index (POST .../imports/channel-map); imports made before
 *      that was recorded have no mapping, so
 *   2. the channel NAME (case, spaces / dashes / underscores and a leading "#" or emoji ignored), only when
 *      exactly one existing text channel has it;
 *   otherwise no target (the admin can pick one, or leave the channel out).
 *
 * THE NO-DUPLICATES RULE (simplest rule that is always correct, enforced by the API too):
 *   a Discord channel is SKIPPED when imported messages from it are already in this server (anywhere), or
 *   when its target channel holds imported messages whose Discord channel is unknown (an import made
 *   before sources were recorded: they may well be this very channel). Everything else is copied whole.
 *   Why not "only the newer / older messages": the server cannot see message times (they are inside the
 *   encrypted content) and a partly-copied channel's boundary is not reliably known, so a time cut could
 *   duplicate or drop messages. The owner's case (channels that came over EMPTY) is exactly what this
 *   allows; a channel with any imported messages is never touched.
 */
import type { ImportChannelMap } from './history/host';

export interface CopySourceChannel { num: number; name: string; sourceKey?: string }
export interface CopyTargetChannel { channel_id: string; name: string }

export type CopyRowStatus =
    | { kind: 'ready' }
    | { kind: 'no-target' }
    /** Messages from this Discord channel are already in the server: never copied again. */
    | { kind: 'copied'; rows: number }
    /** The target holds imported messages of unknown origin (an older import): skipped to never duplicate. */
    | { kind: 'unknown'; rows: number };

export interface CopyRow {
    source: CopySourceChannel;
    /** The existing channel it goes into (null: not copied). */
    target: string | null;
    /** How the target was chosen. */
    matchedBy: 'previous' | 'name' | 'manual' | null;
    status: CopyRowStatus;
}

/** A channel name as people mean it: case, separators and a leading "#" / emoji do not matter. */
export function normalizeChannelName(name: string): string {
    return name
        .normalize('NFKC')
        .toLowerCase()
        .replace(/^[^\p{L}\p{N}]+/u, '')          // leading "#", emoji, punctuation
        .replace(/[\s_\-.·・|]+/gu, '-')
        .replace(/[^\p{L}\p{N}-]/gu, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

/** Index of each source key in the order the channel map was asked with. */
export function sourceKeysOf(sources: CopySourceChannel[]): string[] {
    return sources.map(s => s.sourceKey).filter((k): k is string => typeof k === 'string');
}

/** Rows (messages) from the source at `keyIndex` already in the server, anywhere. */
function copiedRows(map: ImportChannelMap | null, keyIndex: number | undefined): number {
    if (!map || keyIndex === undefined) return 0;
    let n = 0;
    for (const c of map.channels) for (const f of c.from) if (f.source === keyIndex) n += f.rows;
    return n;
}

/** The status of one (source, target) choice under the no-duplicates rule. */
export function rowStatus(source: CopySourceChannel, target: string | null, map: ImportChannelMap | null, keys: string[]): CopyRowStatus {
    const idx = source.sourceKey ? keys.indexOf(source.sourceKey) : -1;
    const copied = copiedRows(map, idx >= 0 ? idx : undefined);
    if (copied > 0) return { kind: 'copied', rows: copied };
    if (!target) return { kind: 'no-target' };
    const unknown = map?.channels.find(c => c.channel_id === target)?.unknown_source_rows ?? 0;
    if (unknown > 0) return { kind: 'unknown', rows: unknown };
    return { kind: 'ready' };
}

/** The first mapping: previous import first, then a unique name match. Each existing channel is used once. */
export function autoMatch(sources: CopySourceChannel[], targets: CopyTargetChannel[], map: ImportChannelMap | null): CopyRow[] {
    const keys = sourceKeysOf(sources);
    const targetIds = new Set(targets.map(t => t.channel_id));
    const taken = new Set<string>();
    const chosen = new Map<number, { target: string; by: 'previous' | 'name' }>();

    // 1. The previous import's mapping (the channel it went into, even when nothing came over).
    for (const s of sources) {
        const idx = s.sourceKey ? keys.indexOf(s.sourceKey) : -1;
        if (idx < 0 || !map) continue;
        const hit = map.channels.find(c => targetIds.has(c.channel_id) && !taken.has(c.channel_id) && c.from.some(f => f.source === idx));
        if (hit) { chosen.set(s.num, { target: hit.channel_id, by: 'previous' }); taken.add(hit.channel_id); }
    }
    // 2. A unique name match among the channels still free.
    const byName = new Map<string, string[]>();
    for (const t of targets) {
        const n = normalizeChannelName(t.name);
        if (!n) continue;
        byName.set(n, [...(byName.get(n) ?? []), t.channel_id]);
    }
    for (const s of sources) {
        if (chosen.has(s.num)) continue;
        const ids = (byName.get(normalizeChannelName(s.name)) ?? []).filter(id => !taken.has(id));
        if (ids.length === 1) { chosen.set(s.num, { target: ids[0], by: 'name' }); taken.add(ids[0]); }
    }
    return sources.map(s => {
        const c = chosen.get(s.num) ?? null;
        return { source: s, target: c?.target ?? null, matchedBy: c?.by ?? null, status: rowStatus(s, c?.target ?? null, map, keys) };
    });
}

/** The admin picked another target (or none) for one row. */
export function retarget(rows: CopyRow[], num: number, target: string | null, map: ImportChannelMap | null): CopyRow[] {
    const keys = sourceKeysOf(rows.map(r => r.source));
    return rows.map(r => r.source.num !== num ? r : { ...r, target, matchedBy: target ? 'manual' : null, status: rowStatus(r.source, target, map, keys) });
}

/** May this row be ticked? Only a ready one. */
export const copyable = (r: CopyRow): boolean => r.status.kind === 'ready' && !!r.target;

/**
 * What a start is allowed to contain: ticked, copyable rows, and never two Discord channels into the same
 * existing channel (the second would interleave with the first; the admin must choose).
 */
export function copyPlan(rows: CopyRow[], picked: ReadonlySet<number>): { channels: Array<{ num: number; name: string; channelId: string; sourceKey?: string }>; clash: string[] } {
    const out: Array<{ num: number; name: string; channelId: string; sourceKey?: string }> = [];
    const used = new Map<string, number>();
    for (const r of rows) {
        if (!picked.has(r.source.num) || !copyable(r)) continue;
        used.set(r.target!, (used.get(r.target!) ?? 0) + 1);
        out.push({ num: r.source.num, name: r.source.name, channelId: r.target!, ...(r.source.sourceKey ? { sourceKey: r.source.sourceKey } : {}) });
    }
    const clash = [...used.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    return { channels: out, clash };
}

/** `c:<num>` -> existing channel id for every Discord channel with a target (so #mentions link to them). */
export function mentionRefs(rows: CopyRow[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of rows) if (r.target) out[`c:${r.source.num}`] = r.target;
    return out;
}
