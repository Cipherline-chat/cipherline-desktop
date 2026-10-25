/**
 * The real NotesSyncEnv: the shared own-slot transport (ownSlotEnv.ts) bound to
 * the `profile_notes` slot, plus the per-device "what I last saw" view. Kept
 * apart from the service so that stays unit-testable (no axios).
 */
import secureLocalStore from '../utils/secureLocalStore';
import type { SlotView } from '../utils/ownSlotSync';
import { notesViewKey, type NotesState } from '../utils/profileNotes';
import { createOwnSlotEnv, type OwnSlotAuth } from './ownSlotEnv';
import type { NotesSyncEnv } from './profileNotesSync';

/** The `/v1/history` slot. Must match apps/api/src/history/backup-slots.ts. */
export const NOTES_SLOT = 'profile_notes';

export function getNotesView(uid: string): SlotView<NotesState> | null {
    try {
        const raw = secureLocalStore.getItem(notesViewKey(uid));
        const v = raw ? JSON.parse(raw) : null;
        return v && typeof v.updatedAt === 'string' ? v : null;
    } catch { return null; }
}
export function setNotesView(uid: string, view: SlotView<NotesState> | null): void {
    try {
        if (view) secureLocalStore.setItem(notesViewKey(uid), JSON.stringify(view));
        else secureLocalStore.removeItem(notesViewKey(uid));
    } catch { /* non-fatal */ }
}

export function createNotesSyncEnv(
    auth: OwnSlotAuth, local: { load(): NotesState; merge(remote: NotesState): boolean },
): NotesSyncEnv {
    return { ...createOwnSlotEnv(auth, NOTES_SLOT), loadLocalState: local.load, mergeRemote: local.merge };
}
