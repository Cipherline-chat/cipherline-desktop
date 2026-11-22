/**
 * How a row's author is SHOWN when the row is imported history (Discord import
 * phase 2; plan B6.2, the anti-impersonation rules). There is no "imported"
 * label, so these rules are the control:
 *
 *  1. Only a row the SERVER marked (`import_mark`: it was inserted by an import
 *     session's batch endpoint) may show an alternate author.
 *  2. The decrypted `imported_from.author_ref` must equal the mark; the
 *     signature is the importer's device (the row's real sender) by the normal
 *     decrypt path.
 *  3. Anything else that claims an alternate author renders as its REAL sender.
 *  4. A claimed author (phase 3: a Discord-verified claim) renders as that
 *     Cipherline user. The server never sets a claim in phase 2.
 *  5. An unclaimed author shows the imported name (cleaned) and avatar; it is
 *     never a link to a real profile, cannot be mentioned, DMed, friended or
 *     blocked; clicking it opens the "Not on Cipherline yet" card.
 *  6. Name collision: when the folded name equals a CURRENT member's display
 *     name or username (on this device, now), add "· @handle" in muted text
 *     (D18), and never use the member's avatar.
 *
 * Pure: ChatPane, the pinned panel, reply quotes and senderDisplayName all
 * read the author through here, so they cannot disagree.
 */
import {
    importedAuthorLabel, importedNameCollides, verifiedImportedFrom,
    type ImportMark, type ImportedAvatar, type ImportedFrom,
} from '@cipherline/shared';

export interface ImportedRowLike {
    content?: unknown;
    import_mark?: ImportMark | null;
}

export type ImportedAuthorView =
    | {
        kind: 'unclaimed';
        authorRef: string;
        name: string;
        /** "@handle" on a name collision only (D18), else null. */
        suffix: string | null;
        username: string | null;
        avatar: ImportedAvatar | null;
        /** Original time on the source app (D17): what the row DISPLAYS. */
        originalTs: string;
        edited: boolean;
        authorKind: ImportedFrom['kind'];
    }
    | { kind: 'claimed'; authorRef: string; userId: string; originalTs: string; edited: boolean };

/** The verified block of a row, or null (rules 1–3). */
export function verifiedBlockOf(row: ImportedRowLike | null | undefined): ImportedFrom | null {
    if (!row) return null;
    return verifiedImportedFrom(row.content, row.import_mark ?? null);
}

export function importedAuthorView(row: ImportedRowLike | null | undefined, memberNames: Iterable<string | null | undefined> = []): ImportedAuthorView | null {
    const block = verifiedBlockOf(row);
    if (!block) return null;
    const claimed = row?.import_mark?.claimed_user_id;
    if (claimed) {
        return { kind: 'claimed', authorRef: block.author_ref, userId: claimed, originalTs: block.original_ts, edited: block.edited === true };
    }
    const label = importedAuthorLabel(block, importedNameCollides(block.name, memberNames));
    return {
        kind: 'unclaimed', authorRef: block.author_ref, name: label.name, suffix: label.suffix,
        username: block.username ?? null, avatar: block.avatar ?? null,
        originalTs: block.original_ts, edited: block.edited === true, authorKind: block.kind,
    };
}

/** The name text for a row whose author is imported, or null when it is not (or not verifiably) imported. */
export function importedNameOf(row: ImportedRowLike | null | undefined): string | null {
    const b = verifiedBlockOf(row);
    return b && !row?.import_mark?.claimed_user_id ? b.name : null;
}

/** The time a row DISPLAYS (ms): the original time for a verified imported row, else its own. */
export function displayTimeMs(row: (ImportedRowLike & { timestamp?: unknown }) | null | undefined): number {
    const b = verifiedBlockOf(row);
    if (b) {
        const t = Date.parse(b.original_ts);
        if (Number.isFinite(t)) return t;
    }
    const ts = row?.timestamp;
    return typeof ts === 'number' ? ts : Date.parse(typeof ts === 'string' ? ts : '');
}

/**
 * The key consecutive rows are grouped by: two imported authors from the same
 * importer device are different people, and an imported row never groups with
 * the importer's own live message.
 */
export function authorGroupKey(row: (ImportedRowLike & { sender_device_id?: string | null; sender_user_id?: string | null }) | null | undefined): string {
    const b = verifiedBlockOf(row);
    if (b) return `import:${b.author_ref}`;
    return `device:${row?.sender_device_id ?? ''}`;
}

/** Initials for the fallback avatar of an imported author. */
export function importedInitials(name: string): string {
    const parts = Array.from(name.trim()).filter(ch => /[\p{L}\p{N}]/u.test(ch));
    return (parts[0] ?? '?').toUpperCase();
}

/** A stable hue for the fallback avatar, from the opaque author ref (never the name: no collision tricks). */
export function importedHue(authorRef: string): number {
    let h = 0;
    for (let i = 0; i < authorRef.length; i++) h = (h * 31 + authorRef.charCodeAt(i)) >>> 0;
    return h % 360;
}
