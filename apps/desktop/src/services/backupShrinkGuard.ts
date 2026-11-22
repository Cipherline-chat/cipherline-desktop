/**
 * Second safety net under backupStoreGuard: never replace a backup with one
 * that is drastically emptier unless the user says so.
 *
 * WHY: the store guard catches the failure we know about (a store that did not
 * load). This catches the ones we don't — anything that leaves this device
 * holding far less than the backup it is about to overwrite. A backup
 * destination holds ONE file, rewritten in place, so a near-empty vault written
 * there destroys the only copy of the history it replaced (Drive's revision
 * history is the only way back, and only for Drive).
 *
 * WHAT COUNTS: conversations — distinct `dm:<conv>` / `ch:<channel>` record
 * ids, which are month-bucketed (`dm:<conv>:<YYYY-MM>`), so a conversation with
 * a year of history is still one. Counting conversations rather than bytes
 * keeps legitimate shrinkage quiet: turning attachments off, or a size cap,
 * changes the bytes, not the conversations.
 *
 * WHERE THE EXISTING COUNT COMES FROM: the existing file's own (authenticated)
 * index when the run opens it (the local folder, same passphrase); otherwise
 * the count this device recorded the last time it wrote that same target.
 * When neither is known, only the extreme case is caught: an EMPTY vault (no
 * conversations at all) over an existing file of real size.
 */

export type ShrinkDestination = 'local' | 'drive';

/** What is known about the backup already at a destination. */
export interface ExistingBackupShape {
    /** Conversations in the existing file, or null when unknown. */
    conversations: number | null;
    /** Size of the existing file in bytes, or null when unknown. */
    bytes: number | null;
}

/** Below this many existing conversations a drop is not "drastic", just small numbers. */
export const SHRINK_MIN_EXISTING_CONVERSATIONS = 3;
/** The new vault keeps at most this fraction of the existing conversations → drastic. */
export const SHRINK_KEEP_FRACTION = 0.2;
/** With no conversation count to go on, an empty vault over a file at least this big is drastic. */
export const SHRINK_UNKNOWN_MIN_BYTES = 256 * 1024;

const CONVERSATION_RECORD_RE = /^(dm|ch):([^:]+)/;

/** Distinct conversations (DMs/groups and channels) among backup record ids. */
export function countConversations(recordIds: Iterable<string>): number {
    const seen = new Set<string>();
    for (const id of recordIds) {
        const m = CONVERSATION_RECORD_RE.exec(id);
        if (m) seen.add(`${m[1]}:${m[2]}`);
    }
    return seen.size;
}

/** Would writing a vault with `nextConversations` over `existing` be a drastic loss? */
export function isDrasticShrink(existing: ExistingBackupShape, nextConversations: number): boolean {
    if (existing.conversations !== null) {
        if (existing.conversations < SHRINK_MIN_EXISTING_CONVERSATIONS) return false;
        return nextConversations <= Math.floor(existing.conversations * SHRINK_KEEP_FRACTION);
    }
    return nextConversations === 0 && existing.bytes !== null && existing.bytes >= SHRINK_UNKNOWN_MIN_BYTES;
}

export interface BackupShrinkWarning {
    destinations: Array<{ label: ShrinkDestination } & ExistingBackupShape>;
    nextConversations: number;
    title: string;
    message: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const where = (label: ShrinkDestination) => (label === 'local' ? 'your backup folder' : 'Google Drive');

export function describeShrink(
    destinations: BackupShrinkWarning['destinations'],
    nextConversations: number,
): BackupShrinkWarning {
    const known = destinations.find(d => d.conversations !== null);
    const places = [...new Set(destinations.map(d => where(d.label)))].join(' and ');
    const message = known
        ? `This device has ${plural(nextConversations, 'conversation', 'conversations')} to back up, but the backup in ${places} holds ${plural(known.conversations!, 'conversation', 'conversations')}. Replacing it would lose the rest.`
        : `This device has no conversations to back up, but there is already a backup in ${places}. Replacing it would lose what it holds.`;
    return { destinations, nextConversations, title: 'Replace your backup with a much smaller one?', message };
}

/** The per-destination error when a drastic shrink was not confirmed. */
export function shrinkRefusedMessage(existing: ExistingBackupShape, nextConversations: number): string {
    const detail = existing.conversations !== null
        ? ` (${nextConversations} conversation${nextConversations === 1 ? '' : 's'} here, ${existing.conversations} in the backup)`
        : '';
    return `Kept your existing backup: the new one would hold far fewer conversations${detail}. Use Back up now to replace it if that’s expected.`;
}
