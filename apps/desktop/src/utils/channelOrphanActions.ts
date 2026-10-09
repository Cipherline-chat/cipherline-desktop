/**
 * Edits, deletes and reactions whose target message is not loaded yet.
 *
 * Channel edits/deletes/reactions are their own encrypted rows that point at a
 * target id (utils/channelHistoryMerge.ts applies them and drops the
 * envelope). They are always NEWER than their target, so with paged history
 * the action routinely arrives first: it sits in the newest page (or comes in
 * live) while the message it edits is still several pages up. The fold used to
 * find no target and silently drop it — so when the target page was loaded a
 * minute later the message showed its ORIGINAL text, a deleted message came
 * back, and a reaction was missing.
 *
 * This keeps such actions per channel, in arrival order, and replays them the
 * moment their target is ingested (an older page, the page around a jumped-to
 * message, or a server-saved message loaded by id).
 *
 * Session memory only. The server keeps no "edits for message X" index (it
 * validates `action_target_id` and discards it — metadata the project
 * deliberately does not retain), so the only source of an orphan is a page
 * this client has read; a page re-read in a later session re-collects them.
 *
 * Pure: no argument is mutated.
 */
import { foldChannelHistory, type ChannelRow } from './channelHistoryMerge';

/** Per-channel ceiling — oldest dropped first. An action this far behind
 *  whose target never loads is not worth unbounded memory. */
export const MAX_ORPHANS_PER_CHANNEL = 500;

const ACTION_TYPES = new Set(['edit', 'delete', 'reaction']);

export function actionTargetId(m: ChannelRow): string | null {
    const c = m.content as { type?: string; target_id?: unknown } | undefined;
    return c && ACTION_TYPES.has(c.type ?? '') && typeof c.target_id === 'string' ? c.target_id : null;
}

/** Every id a target_id can match — the row id, or its client_msg_id (an
 *  instantly-sent row of this device, see utils/pendingSend.ts) — the same
 *  matching foldChannelHistory uses. One pass, so lookups are O(1). */
function targetIndex(...lists: ReadonlyArray<ReadonlyArray<ChannelRow>>): Set<string> {
    const ids = new Set<string>();
    for (const rows of lists) {
        for (const t of rows) {
            if (actionTargetId(t) !== null) continue; // an action is never a target
            ids.add(t.id);
            const cm = (t.content as { client_msg_id?: unknown } | undefined)?.client_msg_id;
            if (typeof cm === 'string') ids.add(cm);
        }
    }
    return ids;
}

/**
 * The action rows of `incoming` whose target is neither already cached
 * (`existing`) nor arriving as a plain row in the same batch.
 */
export function findOrphanActions(existing: ReadonlyArray<ChannelRow>, incoming: ReadonlyArray<ChannelRow>): ChannelRow[] {
    const targets = targetIndex(existing, incoming);
    return incoming.filter(m => {
        const t = actionTargetId(m);
        return t !== null && !targets.has(t);
    });
}

/** Append (deduped by action id, chronological), keeping the newest `cap`. */
export function addOrphans(pending: ReadonlyArray<ChannelRow>, orphans: ReadonlyArray<ChannelRow>, cap = MAX_ORPHANS_PER_CHANNEL): ChannelRow[] {
    if (orphans.length === 0) return [...pending];
    const byId = new Map<string, ChannelRow>();
    for (const m of [...pending, ...orphans]) byId.set(m.id, m);
    const all = [...byId.values()].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return all.length > cap ? all.slice(all.length - cap) : all;
}

/**
 * Split `pending` into the actions whose target is now present in `rows`
 * (ready to apply) and the ones still waiting.
 */
export function readyOrphans(pending: ReadonlyArray<ChannelRow>, rows: ReadonlyArray<ChannelRow>): { ready: ChannelRow[]; waiting: ChannelRow[] } {
    const ready: ChannelRow[] = [];
    const waiting: ChannelRow[] = [];
    if (pending.length === 0) return { ready, waiting };
    const targets = targetIndex(rows);
    for (const m of pending) {
        const t = actionTargetId(m);
        (t !== null && targets.has(t) ? ready : waiting).push(m);
    }
    return { ready, waiting };
}

/** Apply ready actions to a thread (same reducer as every other fold). */
export function applyOrphans<T extends ChannelRow>(rows: T[], ready: ReadonlyArray<ChannelRow>): T[] {
    if (ready.length === 0) return rows;
    return foldChannelHistory(rows, [...ready]) as T[];
}
