import type { StoragePolicy } from '../hooks/useRetentionPolicy';

/**
 * Per-ROW save / pin / retention state for ChatPane's message rows.
 *
 * A row is a MemoRow that re-renders when any of its deps change. The saved,
 * pinned and personal-save id lists used to be pane-wide deps, so saving,
 * unsaving, pinning or unpinning ONE message re-rendered EVERY row on screen:
 * every formatted body re-parsed, every embed and image re-rendered, and any
 * row whose render was not perfectly idempotent moved (an image link whose box
 * changed on its next render pushed everything below it down: the chat
 * "jumped" on save, 0.1.2-staging.245). Each row now depends on its OWN flags
 * only, so a save re-renders just the message that was saved.
 *
 * The policy's per-id fields are split off (`retentionShared`) so the rest of
 * the policy (durations, per-type defaults) stays a pane-wide dep: changing a
 * retention period still re-renders every row's countdown.
 */
const PER_ID_FIELDS = [
    'savedMessageIds', 'unsavedMessageIds', 'savedAttachmentIds', 'unsavedAttachmentIds',
    'unsavedMessageTimestamps', 'unsavedAttachmentTimestamps',
] as const;

/** The policy without its per-message / per-attachment lists. */
export function retentionShared(policy: StoragePolicy): Omit<StoragePolicy, typeof PER_ID_FIELDS[number]> {
    const out: Record<string, unknown> = { ...policy };
    for (const f of PER_ID_FIELDS) delete out[f];
    return out as Omit<StoragePolicy, typeof PER_ID_FIELDS[number]>;
}

export interface RowSaveIndex {
    serverSaved: ReadonlySet<string>;
    pinned: ReadonlySet<string>;
    savedMsg: ReadonlySet<string>;
    unsavedMsg: ReadonlySet<string>;
    savedAtt: ReadonlySet<string>;
    unsavedAtt: ReadonlySet<string>;
    unsavedMsgAt: Readonly<Record<string, number>>;
    unsavedAttAt: Readonly<Record<string, number>>;
}

export function buildRowSaveIndex(serverSavedIds: readonly string[], pinnedIds: readonly string[], policy: StoragePolicy): RowSaveIndex {
    return {
        serverSaved: new Set(serverSavedIds),
        pinned: new Set(pinnedIds),
        savedMsg: new Set(policy.savedMessageIds),
        unsavedMsg: new Set(policy.unsavedMessageIds),
        savedAtt: new Set(policy.savedAttachmentIds),
        unsavedAtt: new Set(policy.unsavedAttachmentIds),
        unsavedMsgAt: policy.unsavedMessageTimestamps ?? {},
        unsavedAttAt: policy.unsavedAttachmentTimestamps ?? {},
    };
}

/**
 * One primitive per row that changes exactly when THIS message's save / pin /
 * personal-save state does (a string, so MemoRow's shallow compare sees it).
 */
export function rowSaveKey(ix: RowSaveIndex, msgId: string | undefined, attId?: string): string {
    if (!msgId) return '';
    const m = `${ix.serverSaved.has(msgId) ? 'S' : '-'}${ix.pinned.has(msgId) ? 'P' : '-'}${ix.savedMsg.has(msgId) ? 'm' : '-'}${ix.unsavedMsg.has(msgId) ? `u${ix.unsavedMsgAt[msgId] ?? ''}` : '-'}`;
    if (!attId) return m;
    return `${m}|${ix.savedAtt.has(attId) ? 'a' : '-'}${ix.unsavedAtt.has(attId) ? `u${ix.unsavedAttAt[attId] ?? ''}` : '-'}`;
}

/**
 * The retention WINDOWS (global + per-type defaults) as one string: it changes
 * exactly when a period does, never on a save, unsave or policy reload.
 * Effects that care about windows only key on this instead of the policy
 * object, which every personal save rebuilds.
 */
export function retentionWindowsKey(policy: StoragePolicy): string {
    const shared = retentionShared(policy) as Record<string, unknown>;
    return Object.keys(shared).sort().map(k => `${k}=${String(shared[k] ?? '')}`).join('|');
}
